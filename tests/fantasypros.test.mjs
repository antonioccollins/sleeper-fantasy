import test from 'node:test';
import assert from 'node:assert/strict';
import { getRankings, mapRankings, parseRankings, parsePublishedRankings, rankingFormat, RANK_MAX_AGE_MS, RANK_CACHE_MS } from '../netlify/lib/fantasypros.mjs';
import { generate, tradeValue } from '../netlify/lib/engine.mjs';
import { createHandler } from '../netlify/lib/api.mjs';
import { refreshLeague } from '../netlify/lib/league.mjs';
const now = Date.now();
const league = {league_id:'1314338659381575680',season:'2026',name:'Test',total_rosters:2,roster_positions:['QB','RB','RB','WR','WR','WR','TE','FLEX','BN'],scoring_settings:{rec:.5}};
const responseData = () => ({sport:'NFL',year:'2026',ranking_type_name:'ROS',scoring:'HALF',position_id:'ALL',week:'0',filters:null,count:160,total_experts:25,last_updated_ts:Math.floor(now/1000),players:Array.from({length:160},(_,i)=>({player_id:i+1,player_name:`Player ${i+1}`,player_position_id:['RB','WR','TE','QB'][i%4],player_team_id:'BUF',player_yahoo_id:String(1000+i),rank_ecr:i+1,pos_rank:`${['RB','WR','TE','QB'][i%4]}${Math.floor(i/4)+1}`}))});
function inputs() {
  const players=Object.fromEntries(responseData().players.map(p=>[String(p.player_id),{player_id:String(p.player_id),full_name:p.player_name,position:p.player_position_id,team:'BUF',yahoo_id:p.player_yahoo_id}]));
  const rosters=[{roster_id:1,owner_id:'1',players:['1','5','9','46','50','54','3','4','13','58'],reserve:[]}, {roster_id:2,owner_id:'2',players:['2','6','10','41','69','61','7','8','14','18','65'],reserve:[]}];
  // Unique ownership; a free agent can never be offered.
  rosters[1].players=rosters[1].players.map(id=>id==='45'?'69':id);
  return {players,rosters,users:[{user_id:'1',display_name:'A'},{user_id:'2',display_name:'B'}]};
}
class Store {
  data=new Map();
  versions=new Map();
  revision=0;
  async get(key) {return structuredClone(this.data.get(key)??null);}
  async getWithMetadata(key) {return this.data.has(key) ? {data:await this.get(key),etag:this.versions.get(key)} : null;}
  async setJSON(key,value,options={}) {
    if ((options.onlyIfNew && this.data.has(key)) || (options.onlyIfMatch && options.onlyIfMatch!==this.versions.get(key))) return {modified:false};
    const etag=String(++this.revision);this.data.set(key,structuredClone(value));this.versions.set(key,etag);return {modified:true,etag};
  }
}
const ok = data => new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});

test('requests exact ROS half-PPR endpoint with key only in header; caches for six hours',async()=>{
  const store=new Store(),{players,rosters}=inputs();let calls=0;
  const fetcher=async(url,options)=>{
    calls++;assert.equal(String(url),'https://api.fantasypros.com/public/v2/json/nfl/2026/consensus-rankings?type=ROS&scoring=HALF&position=ALL');
    assert.equal(options.headers['x-api-key'],'test-secret');assert.equal(options.redirect,'error');
    return ok(responseData());
  };
  const ranks=await getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher,now});
  assert.equal(ranks.coverage,100);assert.equal(ranks.bySleeper['1'].rank,1);
  await getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher,now:now+1000});
  assert.equal(calls,1);assert.ok(!JSON.stringify([...store.data]).includes('test-secret'));assert.ok(!JSON.stringify(ranks).includes('test-secret'));
});
test('validates season, scoring, ROS type, position, publication age and complete payload',()=>{
  for(const patch of [{year:'2025'},{ranking_type_name:'DRAFT'},{scoring:'PPR'},{position_id:'RB'},{last_updated_ts:Math.floor(now/1000)-8*86400},{players:[]},{players:{}}]) {
    assert.throws(()=>parseRankings({...responseData(),...patch},'2026','HALF','ALL',now));
  }
  const data=responseData();data.players[1].player_id=data.players[0].player_id;
  assert.throws(()=>parseRankings(data,'2026','HALF','ALL',now));
  assert.equal(rankingFormat({...league,scoring_settings:{rec:1}}),'PPR');
  assert.equal(rankingFormat({...league,scoring_settings:{rec:0}}),'STD');
  assert.throws(()=>rankingFormat({...league,roster_positions:['QB','SUPER_FLEX']}));
});
test('accepts the official ranking_type_name response without a type field and validates its semantics',()=>{
  const documented=responseData();
  assert.equal(documented.type,undefined);
  assert.equal(parseRankings(documented,'2026','HALF','ALL',now).rows.length,160);
  assert.equal(parseRankings({...documented,ranking_type_name:'Rest of Season'},'2026','HALF','ALL',now).rows.length,160);
  for(const name of ['DRAFT','WEEKLY','DYNASTY',''])assert.throws(()=>parseRankings({...documented,ranking_type_name:name,type:'ROS'},'2026','HALF','ALL',now),error=>error.reason==='incompatible_response'&&error.fields.includes('ranking_type_name'));
  const legacy={...documented,type:'ROS'};delete legacy.ranking_type_name;
  assert.equal(parseRankings(legacy,'2026','HALF','ALL',now).rows.length,160);
  const malformed={...documented,sport:3,scoring:3};
  assert.throws(()=>parseRankings(malformed,'2026','HALF','ALL',now),error=>error.reason==='incompatible_response'&&error.fields.join() === 'sport,scoring');
});
test('parser upgrades ignore the old unavailable snapshot and provider cooldown immediately',async()=>{
  const store=new Store(),{players,rosters}=inputs();let calls=0;
  await store.setJSON('fantasypros/v1/nfl/2026/ROS/HALF/retry',{until:now+15*60000,reason:'incompatible_response'});
  const ranks=await getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher:async()=>{calls++;return ok(responseData());},now});
  assert.equal(calls,1);assert.equal(ranks.type,'ROS');
});
test('public ROS page supplies a full validated list when the API returns only a sample',async()=>{
  const store=new Store(),{players,rosters}=inputs();const calls=[];
  const full=responseData();full.players[0].player_name='Brace } and \"quoted\" text';
  const sample={...responseData(),players:responseData().players.slice(0,10)};
  const fetcher=async(url,options)=>{
    calls.push(String(url));
    if(String(url).startsWith('https://api.fantasypros.com/'))return ok(sample);
    assert.equal(String(url),'https://www.fantasypros.com/nfl/rankings/ros-half-point-ppr-overall.php');
    assert.equal(options.headers['x-api-key'],undefined);
    return new Response('<html><script>var ecrData = '+JSON.stringify(full)+'; throw new Error("must not execute");</script></html>');
  };
  const ranks=await getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher,now});
  assert.equal(ranks.via,'public_page');assert.equal(ranks.coverage,100);assert.equal(calls.length,2);
  assert.ok(!JSON.stringify([...store.data]).includes('test-secret'));
  await getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher,now:now+1000});
  assert.equal(calls.length,2);
});
test('public page parser rejects wrong ranking sets, stale dates, login pages and executable expressions',()=>{
  const embed=d=>'<script>var ecrData = '+JSON.stringify(d)+';</script>';
  for(const patch of [{year:'2025'},{scoring:'STD'},{ranking_type_name:'DRAFT'},{last_updated_ts:now/1000-8*86400},{players:responseData().players.slice(0,10)}])assert.throws(()=>parsePublishedRankings(embed({...responseData(),...patch}),'2026','HALF','ALL',now));
  for(const html of ['<html>Please sign in</html>','var ecrData = (() => { return {}; })();','var ecrData = {bad: code()};'])assert.throws(()=>parsePublishedRankings(html,'2026','HALF','ALL',now),e=>e.reason==='public_page_format');
});
test('joins independent provider IDs using Yahoo identity or unambiguous normalized name and position',()=>{
  const rows=[{id:'999',yahoo_id:'17',name:'Different spelling',position:'WR',rank:2},{id:'888',name:'D.J. Moore Jr.',position:'WR',rank:4},{id:'777',name:'Duplicate',position:'RB',rank:5},{id:'776',name:'Duplicate',position:'RB',rank:6}];
  const players={a:{full_name:'Name',position:'WR',yahoo_id:17},b:{full_name:'DJ Moore',position:'WR'},c:{full_name:'Duplicate',position:'RB'},d:{full_name:'D.J. Moore Jr.',position:'TE'}};
  // With just the correctly mapped players, coverage succeeds.
  const result=mapRankings(rows,players,[{players:['a','b']}]);
  assert.equal(result.bySleeper.a.id,'999');assert.equal(result.bySleeper.b.id,'888');
  assert.throws(()=>mapRankings(rows,players,[{players:['a','b','c','d']}]));
  assert.throws(()=>mapRankings(rows,{a:players.a,b:{...players.a}},[{players:['a','b']}]),/unavailable/);
});
test('denied or rate-limited credentials have sanitized reasons and a persistent retry cooldown',async()=>{
  for(const [status,reason] of [[401,'invalid_key'],[403,'access_denied'],[429,'rate_limited'],[500,'provider_unavailable']]) {
    const store=new Store(),{players,rosters}=inputs();let calls=0;
    const fetcher=async()=>{calls++;return new Response('sensitive upstream error',{status});};
    for(let attempt=0;attempt<2;attempt++)await assert.rejects(getRankings(store,league,players,rosters,{apiKey:'test-secret',fetcher,now}),error=>error.reason===reason&&!error.message.includes('sensitive'));
    assert.equal(calls,1);
  }
});
test('temporary outage uses valid cached ROS data without pretending it is freshly fetched',async()=>{
  const store=new Store(),{players,rosters}=inputs();
  const first=await getRankings(store,league,players,rosters,{apiKey:'test',fetcher:async()=>ok(responseData()),now});
  const later=await getRankings(store,league,players,rosters,{apiKey:'test',fetcher:async()=>{throw new Error('network');},now:now+RANK_CACHE_MS+1});
  assert.equal(later.fetched_at,first.fetched_at);
  await assert.rejects(getRankings(store,league,players,rosters,{apiKey:'test',fetcher:async()=>new Response('',{status:500}),now:now+RANK_MAX_AGE_MS+1}));
});
test('missing credentials do not fetch or fall back to Sleeper search ranks',async()=>{
  const {players,rosters,users}=inputs();let calls=0;
  await assert.rejects(getRankings(new Store(),league,players,rosters,{apiKey:'',fetcher:()=>{calls++;}}),e=>e.reason==='missing_key');
  assert.equal(calls,0);
  const model=generate(league,rosters,users,players,[]);
  assert.equal(model.proposals.length,0);assert.equal(model.recommendations.status,'unavailable');
});
test('ROS values ignore recent results, protect stars and require mutual fit for position-changing trades',()=>{
  const {players,rosters,users}=inputs();
  const ranks={...mapRankings(parseRankings(responseData(),'2026','HALF','ALL',now).rows,players,rosters),source:'FantasyPros',type:'ROS',scoring:'HALF',fetched_at:new Date(now).toISOString(),published_at:new Date(now).toISOString()};
  const model=generate(league,rosters,users,players,[],ranks);
  assert.ok(model.proposals.length>0);
  const inflated=generate(league,rosters,users,Object.fromEntries(Object.entries(players).map(([id,p])=>[id,{...p,search_rank:Math.random()*100}])),[{players_points:{'69':100,'1':0}}].map(p=>[p]),ranks);
  assert.deepEqual(model.proposals,inflated.proposals);
  assert.equal(model.players['1'].value,100);assert.ok(tradeValue(100)*2/1.12<tradeValue(1)*.88);
  const weakPackages=structuredClone(ranks);
  for(const [id,row] of Object.entries(weakPackages.bySleeper))row.rank=id==='1'?1:120;
  const protectedStar=generate(league,rosters,users,players,[],weakPackages);
  assert.ok(protectedStar.proposals.every(p=>![...p.give_a,...p.give_b].includes('1')));
  for(const p of model.proposals) {
    const samePositions=p.give_a.map(id=>players[id].position).sort().join()===p.give_b.map(id=>players[id].position).sort().join();
    if(!samePositions) {
      assert.ok(Math.min(...Object.values(p.fit_gain))>=.1);assert.ok(Math.min(...Object.values(p.starter_gain))>=0);
    }
    assert.ok(p.gap<=12);
    assert.ok([...p.give_a,...p.give_b].every(id=>model.players[id].ros_rank));
  }
  const changed=structuredClone(rosters);changed[0].reserve=['1'];
  const reserved=generate(league,changed,users,players,[],ranks);
  assert.notEqual(reserved.epoch,model.epoch);assert.ok(reserved.proposals.every(p=>!p.give_a.includes('1')));
});
test('similar-value QB, RB, WR and TE swaps are included even with neutral or one-sided lineup changes',()=>{
  const positions=['QB','RB','WR','TE'],players={},bySleeper={};
  for(const [i,pos] of positions.entries())for(const team of ['a','b']) {
    const id=team+pos;players[id]={player_id:id,full_name:id,position:pos,team:'BUF'};
    bySleeper[id]={rank:[80,20,40,90][i]+(team==='b'?2:0),position_rank:pos==='WR'?5:team==='a'?3:4};
  }
  const rosters=['a','b'].map((team,i)=>({roster_id:i+1,owner_id:String(i+1),players:positions.map(pos=>team+pos),reserve:[]}));
  const users=[{user_id:'1',display_name:'A'},{user_id:'2',display_name:'B'}];
  const ranks={bySleeper,source:'FantasyPros',type:'ROS',scoring:'HALF'};
  const settings={...league,roster_positions:positions};
  const model=generate(settings,rosters,users,players,[],ranks);
  for(const pos of positions) {
    const proposal=model.proposals.find(p=>p.kind==='1-for-1'&&p.give_a[0]==='a'+pos&&p.give_b[0]==='b'+pos);
    assert.ok(proposal,`${pos} swap must be available`);assert.ok(proposal.gap<=12);
    assert.ok(Math.min(...Object.values(proposal.fit_gain))<=0);
  }
  const expensive=structuredClone(ranks);expensive.bySleeper.bQB.rank=160;
  const changed=generate(settings,rosters,users,players,[],expensive);
  assert.ok(!changed.proposals.some(p=>p.kind==='1-for-1'&&p.give_a[0]==='aQB'&&p.give_b[0]==='bQB'));
});
test('expanded swap eligibility preserves the previous roster epoch and existing canonical terms',()=>{
  const {players,rosters,users}=inputs();
  const ranks=mapRankings(parseRankings(responseData(),'2026','HALF','ALL',now).rows,players,rosters);
  const model=generate(league,rosters,users,players,[],ranks);
  // Recorded from the v1 engine before widening eligibility.
  assert.equal(model.epoch,'c99de9ced208c2ab');
  const oldIDs=['33b2f65f6dac3463619a40b6','3fa4f807c89dad0953f357b5','4e9cbf2b5350930d2cac0cf1','c9fe39bb0b44da8148d41843','9757775b94dd4d8f3823f702','da3c28b4ff86504de924642e','81837b2cab37161ca9c603a2','2d618b7057909243bc98c59c'];
  for(const id of oldIDs)assert.ok(model.proposals.some(p=>p.id===id),`Existing deal ${id} must remain available`);
});
test('unavailable and expired rankings pause API decks and votes even with fresh Sleeper rosters',async()=>{
  const {players,rosters,users}=inputs();
  const model=generate(league,rosters,users,players,[]);
  const store=new Store();
  const handler=createHandler({storage:()=>store,loadModel:async()=>model});
  const health=await (await handler(new Request('https://test/health'))).json();
  assert.equal(health.stale,true);assert.equal(health.recommendations.status,'unavailable');
  const chosen=await handler(new Request('https://test/api/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({team_id:1})}));
  const cookie=chosen.headers.get('set-cookie').split(';')[0];
  const deck=await (await handler(new Request('https://test/api/deck',{headers:{cookie}}))).json();
  assert.deepEqual(deck.proposals,[]);
  const vote=await handler(new Request('https://test/api/votes',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({proposal_id:'a'.repeat(24),decision:'like'})}));
  assert.equal(vote.status,503);
  model.recommendations={status:'ready',source:'FantasyPros',fetched_at:new Date(now-RANK_MAX_AGE_MS-1000).toISOString(),published_at:new Date(now).toISOString()};
  assert.equal((await (await handler(new Request('https://test/health'))).json()).stale,true);
});

test('league refresh connects provider to engine, migrates old snapshots and publishes safe source metadata',async()=>{
  const store=new Store(),{players,rosters,users}=inputs();
  const originalFetch=globalThis.fetch,originalKey=process.env.FANTASYPROS_API_KEY;
  let providerCalls=0;
  process.env.FANTASYPROS_API_KEY='integration-test-secret';
  globalThis.fetch=async(url,options)=>{
    const path=String(url);
    if(path.includes('api.fantasypros.com')) {providerCalls++;assert.equal(options.headers['x-api-key'],'integration-test-secret');return ok(responseData());}
    if(path.endsWith('/players/nfl'))return ok(players);
    if(path.endsWith('/rosters'))return ok(rosters);
    if(path.endsWith('/users'))return ok(users);
    return ok({...league,sport:'nfl',settings:{type:0,last_scored_leg:5}});
  };
  try {
    // The old parser may have a fresh unavailable snapshot; parser version must still migrate.
    await store.setJSON('league/1314338659381575680/model',{engine_version:'fantasypros-ros-v1',rankings_configured:true,updated_at:new Date().toISOString(),recommendations:{status:'unavailable',reason:'incompatible_response'}});
    const model=await refreshLeague(store);
    assert.equal(model.recommendations.status,'ready');assert.equal(model.recommendations.source,'FantasyPros');
    assert.equal(model.recommendations.scoring,'HALF');assert.ok(model.proposals.length>0);
    assert.equal(model.completed_weeks,5);assert.ok(!JSON.stringify(model).includes('integration-test-secret'));
    const again=await refreshLeague(store);assert.equal(again.epoch,model.epoch);assert.equal(providerCalls,1);
    const handler=createHandler({storage:()=>store,loadModel:async()=>model});
    const boot=await (await handler(new Request('https://test/api/bootstrap'))).json();
    assert.equal(boot.stale,false);assert.equal(boot.recommendations.type,'ROS');assert.ok(!JSON.stringify(boot).includes('integration-test-secret'));
  } finally {
    globalThis.fetch=originalFetch;
    if(originalKey===undefined)delete process.env.FANTASYPROS_API_KEY;else process.env.FANTASYPROS_API_KEY=originalKey;
  }
});
