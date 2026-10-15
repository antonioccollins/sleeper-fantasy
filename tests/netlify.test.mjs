import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BlobsServer } from '@netlify/blobs/server';
import { getStore, setEnvironmentContext } from '@netlify/blobs';
import { createHandler } from '../netlify/lib/api.mjs';
import { generate } from '../netlify/lib/engine.mjs';
import { readVersioned } from '../netlify/lib/store.mjs';

class MemoryStore {
  entries = new Map();
  revision = 0;
  async get(key) { return structuredClone(this.entries.get(key)?.data ?? null); }
  async getWithMetadata(key) { return structuredClone(this.entries.get(key) || null); }
  async setJSON(key, data, options = {}) {
    const current = this.entries.get(key);
    if ((options.onlyIfNew && current) || (options.onlyIfMatch && current?.etag !== options.onlyIfMatch)) return {modified: false};
    const etag = String(++this.revision);
    this.entries.set(key, {data: structuredClone(data), etag});
    return {modified: true, etag};
  }
}
function fixture() {
  const players = Object.fromEntries(['a1','a2','b1','b2','c1','c2'].map(id => [id, {id, name:id, position:'RB', nfl_team:'BUF', injury:null, value:20, estimate:10, average:10, sample_weeks:5}]));
  const proposal = (id, receive) => ({id, a:1, b:2, give_a:['a1'], give_b:[receive], value_a:20, value_b:20, gap:0, kind:'1-for-1', score:8, drops:{1:[],2:[]}, starter_gain:{1:1,2:1}, fit_gain:{1:1,2:1}});
  return {league:{league_id:'1314338659381575680', name:'Fixture League', season:'2026', total_rosters:3}, scoring:'Half PPR', epoch:'initial', updated_at:new Date().toISOString(), completed_weeks:5, players,
    teams: ['a','b','c'].map((letter,i)=>({id:i+1, name:`Team ${i+1}`, manager:`Manager ${i+1}`, owner_id:String(i+1), players:[letter+'1',letter+'2'], reserve:[], wins:3, losses:2, ties:0})),
    proposals:[proposal('1'.repeat(24),'b1'),proposal('2'.repeat(24),'b2')]};
}
class Client {
  constructor(handler) {this.handler=handler;this.cookie='';}
  async request(path, method='GET', body, extra={}) {
    const res=await this.handler(new Request('https://trade-match.test'+path, {method,headers:{'content-type':'application/json',cookie:this.cookie,...extra},...(body?{body:JSON.stringify(body)}:{})}));
    if(res.headers.has('set-cookie'))this.cookie=res.headers.get('set-cookie').split(';')[0];
    return {status:res.status,data:await res.json()};
  }
  async choose(id) {assert.equal((await this.request('/api/session','POST',{team_id:id})).status,200);}
  async vote(id='1'.repeat(24),decision='like') {return this.request('/api/votes','POST',{proposal_id:id,decision});}
}
async function setup(storage=new MemoryStore()) {
  let model=fixture();
  const handler=createHandler({storage:()=>storage,loadModel:async()=>model});
  const clients=[new Client(handler),new Client(handler),new Client(handler)];
  for(let i=0;i<clients.length;i++)await clients[i].choose(i+1);
  return {storage,handler,clients,get model(){return model;},set model(value){model=value;}};
}

test('both managers receive mirrored terms; another trade does not match',async()=>{
  const {clients:[a,b,c]}=await setup();
  const pa=(await a.request('/api/deck')).data.proposals[0],pb=(await b.request('/api/deck')).data.proposals[0];
  assert.equal(pa.id,pb.id);assert.deepEqual(pa.give,pb.receive);assert.deepEqual(pa.receive,pb.give);
  assert.equal((await a.vote()).data.matched,false);
  assert.deepEqual((await b.request('/api/likes')).data.items,[]);
  assert.equal((await b.vote('2'.repeat(24))).data.matched,false);
  assert.equal((await b.vote()).data.matched,true);
  for(const client of [a,b])assert.equal((await client.request('/api/matches')).data.items.length,1);
  assert.deepEqual((await c.request('/api/matches')).data.items,[]);
});
test('concurrent cold instances retain both votes and create exactly one match',async()=>{
  const env=await setup();
  const [a,b]=env.clients;
  b.handler=createHandler({storage:()=>env.storage,loadModel:async()=>env.model});
  const results=await Promise.all([a.vote(),b.vote()]);
  assert.deepEqual(results.map(r=>r.status),[200,200]);
  assert.equal(results.filter(r=>r.data.matched).length,1);
  const restarted=createHandler({storage:()=>env.storage,loadModel:async()=>env.model});
  a.handler=restarted;
  const matches=(await a.request('/api/matches')).data.items;
  assert.equal(matches.length,1);assert.equal(matches[0].unread,true);
  assert.equal((await a.request('/api/votes/'+matches[0].id,'DELETE')).status,409);
});
test('undo and withdraw do not leave a hidden like',async()=>{
  const {clients:[a,b]}=await setup();
  const id='1'.repeat(24);
  await a.vote(id,'pass');
  assert.equal((await a.request('/api/deck')).data.proposals.length,1);
  assert.equal((await a.request('/api/votes/'+id,'DELETE')).status,200);
  assert.equal((await a.request('/api/deck')).data.proposals.length,2);
  await a.vote();await a.request('/api/votes/'+id,'DELETE');
  assert.equal((await b.vote()).data.matched,false);
});
test('roster changes expire old votes while historical match terms persist',async()=>{
  const env=await setup();const [a,b]=env.clients;
  await a.vote();await b.vote();
  env.model.proposals=[];env.model.epoch='changed';delete env.model.players.a1;
  assert.equal((await a.vote()).status,409);
  const match=(await a.request('/api/matches')).data.items[0];
  assert.equal(match.available,false);assert.equal(match.give[0].name,'a1');
});
test('alerts are per manager, sessions cannot be tampered, and cross-origin writes fail',async()=>{
  const {handler,clients:[a,b,c]}=await setup();
  assert.equal((await new Client(handler).vote()).status,401);
  const tampered=new Client(handler);tampered.cookie=a.cookie+'tamper';
  assert.equal((await tampered.request('/api/deck')).status,401);
  assert.equal((await c.vote()).status,409);
  assert.equal((await a.request('/api/votes','POST',{proposal_id:'1'.repeat(24),decision:'like'},{origin:'https://other.test'})).status,403);
  await a.vote();await b.vote();
  assert.equal((await c.request('/api/matches/'+'1'.repeat(24),'POST',{})).status,404);
  await a.request('/api/matches/'+'1'.repeat(24),'POST',{});
  assert.equal((await a.request('/api/matches')).data.items[0].unread,false);
  assert.equal((await b.request('/api/matches')).data.items[0].unread,true);
});
test('stale snapshots allow reading but pause new votes',async()=>{
  const env=await setup();env.model.updated_at=new Date(Date.now()-7200000).toISOString();
  assert.equal((await env.clients[0].request('/api/deck')).data.stale,true);
  assert.equal((await env.clients[0].vote()).status,503);
});
test('an older function snapshot cannot reset votes from a newer roster generation',async()=>{
  const env=await setup();
  const old=structuredClone(env.model);
  const oldClient=new Client(createHandler({storage:()=>env.storage,loadModel:async()=>old}));
  await oldClient.choose(1);
  env.model.epoch='new-generation';
  env.model.updated_at=new Date(Date.parse(old.updated_at)+1000).toISOString();
  await env.clients[1].vote();
  assert.equal((await oldClient.vote()).status,409);
  assert.equal((await env.clients[0].vote()).data.matched,true);
});
test('Netlify SDK conditional writes reject stale ETags; site storage survives a new handler',async()=>{
  const directory=await mkdtemp(join(tmpdir(),'trade-netlify-sdk-'));
  const server=new BlobsServer({directory,token:'local-test-token',logger:()=>{}});
  try {
    const {port}=await server.start();
    setEnvironmentContext({edgeURL:`http://127.0.0.1:${port}`,uncachedEdgeURL:`http://127.0.0.1:${port}`,siteID:'local-test-site',token:'local-test-token'});
    const storage=getStore({name:'sdk-integration',consistency:'strong'});
    assert.equal((await storage.setJSON('cas',{version:1},{onlyIfNew:true})).modified,true);
    const first=await readVersioned(storage,'cas');
    // The official local emulator derives ETags from millisecond file mtimes.
    // Separate these writes so the updated object has a distinct emulator ETag.
    await new Promise(resolve=>setTimeout(resolve,25));
    assert.equal((await storage.setJSON('cas',{version:2},{onlyIfMatch:first.etag})).modified,true);
    assert.notEqual((await readVersioned(storage,'cas')).etag,first.etag);
    assert.equal((await storage.setJSON('cas',{version:3},{onlyIfMatch:first.etag})).modified,false);
    assert.equal((await storage.get('cas',{type:'json'})).version,2);
    const env=await setup(storage);const [a,b]=env.clients;
    await a.vote();assert.equal((await b.vote()).data.matched,true);
    a.handler=createHandler({storage:()=>storage,loadModel:async()=>env.model});
    assert.equal((await a.request('/api/matches')).data.items.length,1);
  } finally {setEnvironmentContext({});await server.stop();await rm(directory,{recursive:true,force:true});}
});
test('trade engine generates stable, unique, owned, balanced proposals across shapes',()=>{
  const players={},rosters=[];
  for(let team=1;team<=3;team++) {
    const ids=[];
    ['QB','RB','RB','WR','WR','TE','WR','RB','WR','RB'].forEach((pos,i)=>{const id=`${team}-${i}`;ids.push(id);players[id]={player_id:id,full_name:id,position:pos,team:'BUF',search_rank:i*3+team};});
    rosters.push({roster_id:team,owner_id:String(team),players:ids,reserve:[ids.at(-1)],settings:{}});
  }
  const weeks=Array.from({length:5},()=>[{players_points:Object.fromEntries(Object.keys(players).map(id=>[id,10+(Number(id[0])+Number(id.at(-1)))%5]))}]);
  const league={league_id:'fixture',season:'2026',name:'Fixture',total_rosters:3,roster_positions:['QB','RB','RB','WR','WR','TE','FLEX','BN'],scoring_settings:{rec:.5}};
  const users=[1,2,3].map(i=>({user_id:String(i),display_name:String(i)}));
  const ranks = {};
  for (const roster of rosters) for (const id of roster.players) {
    const i = Number(id.at(-1)), team = roster.roster_id, position = players[id].position;
    const rank = position === 'RB' ? (team === 1 ? 2 + i : 20 + i) : position === 'WR' ? (team === 2 ? 2 + i : 20 + i) : 5 + team;
    ranks[id] = {rank: rank * 2, position_rank: rank};
  }
  const rankingData = {bySleeper: ranks, source: 'FantasyPros', type:'ROS', scoring:'HALF', fetched_at:new Date().toISOString(), published_at:new Date().toISOString(), coverage:100};
  const m=generate(league,rosters,users,players,weeks,rankingData);
  assert.ok(m.proposals.length>0);
  assert.deepEqual(m.proposals,generate(league,rosters,users,players,weeks,rankingData).proposals);
  assert.equal(new Set(m.proposals.map(p=>p.id)).size,m.proposals.length);
  for(const p of m.proposals) {
    assert.ok(Math.abs(p.value_a-p.value_b)/Math.max(p.value_a,p.value_b)<=.125);
    for(const [id,key] of [[p.a,'give_a'],[p.b,'give_b']])assert.ok(p[key].every(pid=>rosters[id-1].players.includes(pid)&&!rosters[id-1].reserve.includes(pid)));
  }
  rosters[0].players.pop();const changed=generate(league,rosters,users,players,weeks,rankingData);
  assert.notEqual(m.epoch,changed.epoch);
  assert.ok(!changed.proposals.some(p=>m.proposals.some(old=>old.id===p.id)));
});

test('incoming likes lead the deck, preserve exact terms, and withdrawn likes lose priority',async()=>{
  const env=await setup();const [a,b,c]=env.clients;
  const first='1'.repeat(24), liked='2'.repeat(24), third='3'.repeat(24);
  env.model.proposals.push({...structuredClone(env.model.proposals[0]),id:third,a:2,b:3,give_a:['b1'],give_b:['c1'],drops:{2:[],3:[]},starter_gain:{2:1,3:1}});
  const ids=async()=> (await b.request('/api/deck')).data.proposals.map(p=>p.id);
  assert.deepEqual(await ids(),[first,third,liked]);
  await a.vote(liked);
  const received=(await b.request('/api/deck')).data.proposals;
  assert.equal(received[0].id,liked);
  const sent=(await a.request('/api/likes')).data.items[0];
  assert.deepEqual(received[0].give,sent.receive);assert.deepEqual(received[0].receive,sent.give);
  assert.deepEqual((await b.request('/api/likes')).data.items,[]);
  assert.equal(new Set(received.map(p=>p.id)).size,received.length);
  await c.vote(third);
  assert.deepEqual(new Set((await ids()).slice(0,2)),new Set([liked,third]));
  await a.request('/api/votes/'+liked,'DELETE');
  assert.deepEqual(await ids(),[third,first,liked]);
  await c.request('/api/votes/'+third,'DELETE');
  assert.deepEqual(await ids(),[first,third,liked]);
});

test('incoming priority respects passes, filters, matches, and roster epochs',async()=>{
  const env=await setup();const [a,b]=env.clients;
  const first='1'.repeat(24),liked='2'.repeat(24);
  await a.vote(liked);
  assert.equal((await b.request('/api/deck')).data.proposals[0].id,liked);
  assert.deepEqual((await b.request('/api/deck?kind=2-for-2')).data.proposals,[]);
  await b.vote(liked,'pass');
  assert.deepEqual((await b.request('/api/deck')).data.proposals.map(p=>p.id),[first]);
  await b.request('/api/votes/'+liked,'DELETE');
  assert.equal((await b.vote(liked)).data.matched,true);
  assert.deepEqual((await b.request('/api/deck')).data.proposals.map(p=>p.id),[first]);
  const next=await setup();
  await next.clients[0].vote(liked);
  next.model.epoch='new-rosters';
  assert.equal((await next.clients[1].request('/api/deck')).data.proposals[0].id,first);
});

test('personal rankings persist per team and season, include unrostered players, and require explicit saves',async()=>{
  const env=await setup();const [a,b]=env.clients;
  await env.storage.setJSON('league/1314338659381575680/players',{players:{free:{full_name:'Free Agent',position:'WR',team:'BUF',active:true},old:{full_name:'Retired',position:'WR',team:'BUF',active:false}}});
  const initial=await a.request('/api/rankings');
  assert.deepEqual(initial.data.lists,{});
  assert.ok(initial.data.players.some(p=>p.id==='free'));
  assert.ok(!initial.data.players.some(p=>p.id==='old'));
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  const saved=await a.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:null});
  assert.equal(saved.status,200);
  a.handler=createHandler({storage:()=>env.storage,loadModel:async()=>env.model});
  assert.deepEqual((await a.request('/api/rankings')).data.lists.RB.ids,['b1','a1']);
  assert.deepEqual((await b.request('/api/rankings')).data.lists,{});
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  env.model.league.season='2027';
  assert.deepEqual((await a.request('/api/rankings')).data.lists,{});
});

test('reciprocal rankings alert both managers with mirrored terms and per-manager read state, never auto-matching',async()=>{
  const {clients:[a,b,c]}=await setup();
  await a.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:null});
  await b.request('/api/rankings','POST',{position:'RB',ids:['a1','b1'],revision:null});
  const one=(await a.request('/api/rankings/opportunities')).data.items;
  const two=(await b.request('/api/rankings/opportunities')).data.items;
  assert.equal(one.length,1);assert.equal(two.length,1);
  assert.equal(one[0].id,two[0].id);assert.deepEqual(one[0].give,two[0].receive);
  assert.deepEqual(one[0].your_ranks,{give:2,receive:1});assert.deepEqual(one[0].partner_ranks,{give:1,receive:2});
  assert.equal(one[0].unread,true);assert.equal(two[0].unread,true);
  assert.deepEqual((await c.request('/api/rankings/opportunities')).data.items,[]);
  await a.request('/api/rankings/opportunities/seen','POST',{ids:[one[0].id]});
  assert.equal((await a.request('/api/rankings/opportunities')).data.items[0].unread,false);
  assert.equal((await b.request('/api/rankings/opportunities')).data.items[0].unread,true);
  for(const client of [a,b]) {
    assert.deepEqual((await client.request('/api/matches')).data.items,[]);
    assert.deepEqual((await client.request('/api/likes')).data.items,[]);
  }
});

test('omitted players and identical preferences do not imply trades; saved changes remove old opportunities',async()=>{
  const {clients:[a,b]}=await setup();
  await a.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:null});
  let saved=await b.request('/api/rankings','POST',{position:'RB',ids:['a1'],revision:null});
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  saved=await b.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:saved.data.list.revision});
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  saved=await b.request('/api/rankings','POST',{position:'RB',ids:['a1','b1'],revision:saved.data.list.revision});
  assert.equal((await a.request('/api/rankings/opportunities')).data.items.length,1);
  await b.request('/api/rankings','POST',{position:'RB',ids:[],revision:saved.data.list.revision});
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
});

test('opportunities require current unique ownership and current owners but not FantasyPros availability',async()=>{
  const env=await setup();const [a,b]=env.clients;
  await a.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:null});
  await b.request('/api/rankings','POST',{position:'RB',ids:['a1','b1'],revision:null});
  env.model.recommendations={status:'unavailable'};
  assert.equal((await a.request('/api/rankings/opportunities')).data.items.length,1);
  env.model.teams[1].players=env.model.teams[1].players.filter(id=>id!=='b1');
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  env.model.teams[1].players.push('b1');env.model.teams[2].players.push('b1');
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  env.model.teams[2].players.pop();
  env.model.updated_at=new Date(Date.now()-7200000).toISOString();
  const old=(await a.request('/api/rankings/opportunities')).data;
  assert.equal(old.stale,true);assert.deepEqual(old.items,[]);
  env.model.updated_at=new Date().toISOString();env.model.teams[1].owner_id='new-owner';
  assert.deepEqual((await a.request('/api/rankings/opportunities')).data.items,[]);
  assert.deepEqual((await b.request('/api/rankings')).data.lists,{});
});

test('rankings reject invalid entries and prevent concurrent overwrite without losing other positions or teams',async()=>{
  const env=await setup();const [a,b]=env.clients;
  const stranger=new Client(env.handler);
  assert.equal((await stranger.request('/api/rankings')).status,401);
  for(const input of [
    {position:'RB',ids:['a1','a1'],revision:null},
    {position:'WR',ids:['a1'],revision:null},
    {position:'RB',ids:['unknown'],revision:null},
    {position:'ALL',ids:[],revision:null},
    {position:'RB',ids:Array.from({length:26},(_,i)=>String(i)),revision:null},
    {position:'RB',ids:['a1']},
  ])assert.equal((await a.request('/api/rankings','POST',input)).status,400);
  env.model.players.q={id:'q',name:'QB',position:'QB',nfl_team:'BUF'};
  const results=await Promise.all([
    a.request('/api/rankings','POST',{position:'RB',ids:['b1','a1'],revision:null}),
    a.request('/api/rankings','POST',{position:'QB',ids:['q'],revision:null}),
    b.request('/api/rankings','POST',{position:'RB',ids:['a1','b1'],revision:null}),
  ]);
  assert.ok(results.every(r=>r.status===200));
  const stored=(await a.request('/api/rankings')).data.lists;
  assert.deepEqual(stored.QB.ids,['q']);assert.deepEqual(stored.RB.ids,['b1','a1']);
  assert.deepEqual((await b.request('/api/rankings')).data.lists.RB.ids,['a1','b1']);
  assert.equal((await a.request('/api/rankings','POST',{position:'RB',ids:['a1'],revision:null})).status,409);
  assert.deepEqual((await a.request('/api/rankings')).data.lists.RB.ids,['b1','a1']);
  assert.equal((await a.request('/api/rankings','POST',{position:'RB',ids:['a1'],revision:stored.RB.revision},{origin:'https://other.test'})).status,403);
});
