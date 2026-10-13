'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icons = {
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  cards: '<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M4 6H3v14a2 2 0 0 0 2 2h12M11 8h5M11 12h5"/>',
  spark: '<path d="m12 2 2.5 7.5L22 12l-7.5 2.5L12 22l-2.5-7.5L2 12l7.5-2.5Z"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  undo: '<path d="M4 9h10a6 6 0 0 1 0 12M4 9l5-5M4 9l5 5"/>',
  shield: '<path d="m12 2 8 3v6c0 5-8 11-8 11S4 16 4 11V5Z"/><path d="m8 11 3 3 5-6"/>',
  swap: '<path d="M3 7h17m-4-4 4 4-4 4M21 17H4m4-4-4 4 4 4"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  arrow: '<path d="M5 19 19 5M5 5h14v14"/>',
};
const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.spark}</svg>`;
$$('[data-icon]').forEach((el) => { el.innerHTML = icon(el.dataset.icon); });
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const initials = (name) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]).join('').toUpperCase();
const state = {boot:null,team:null,deck:[],kind:'all',view:'discover',busy:false,lastVote:null,likes:[],matches:[],announced:new Set(),generation:0};
let toastTimer;
let lastLeagueCheck = 0;

async function api(path, options = {}) {
  const response = await fetch(path, {credentials:'same-origin',...options,headers:{'Content-Type':'application/json',...options.headers}});
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error || 'Could not connect. Try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}
function notice(message) {
  $('#global-message').textContent = message || '';
  $('#global-message').hidden = !message;
}
function empty(title, message='', symbol='✦') {
  return `<div class="empty-state"><span class="empty-symbol">${symbol}</span><h2>${escape(title)}</h2>${message ? `<p>${escape(message)}</p>` : ''}</div>`;
}
function playerRow(p) {
  return `<div class="player"><div class="player-avatar">${escape(initials(p.name))}</div><div class="player-info"><strong>${escape(p.name)}</strong><small>${escape(p.position)} <span>·</span> ${escape(p.nfl_team)}${p.injury ? `<span class="injury-tag">${escape(p.injury)}</span>` : ''}</small></div></div>`;
}
function names(players) { return players.map((p) => escape(p.name)).join('<br>'); }
function terms(proposal) {
  return `<div class="match-terms"><div><strong>You give</strong><p>${names(proposal.give) || 'Roster has changed'}</p></div><div><strong>You get</strong><p>${names(proposal.receive) || 'Roster has changed'}</p></div></div>`;
}
function renderCard() {
  const card = $('#trade-card');
  card.className = 'trade-card';
  card.style.transform = '';
  const p = state.deck[0];
  card.dataset.proposalId = p?.id || '';
  const disabled = state.busy || !p || !state.team || state.boot?.stale;
  $('#pass-button').disabled = disabled;
  $('#like-button').disabled = disabled;
  $('#undo-button').disabled = state.busy || !state.lastVote;
  if (!state.team) {
    card.innerHTML = empty('Choose your team', '', '↔');
    return;
  }
  if (!p) {
    card.innerHTML = empty('No more trades', 'Try another filter or check your likes.');
    return;
  }
  const drops = p.drops.length ? `<p class="drop-note">Extra roster spot needed. Suggested drop: ${p.drops.map(v=>escape(v.name)).join(', ')}.</p>` : '';
  const partnerDrops = p.partner_drops.length ? '<p class="drop-note">Your partner needs an extra roster spot.</p>' : '';
  card.innerHTML = `<header class="card-header"><div class="card-teams"><div class="partner-avatar">${escape(initials(p.partner.name))}</div><h2>${escape(p.partner.name)}</h2></div></header>
    <div class="trade-content"><div class="give-group"><div class="side-label">You give</div>${p.give.map(playerRow).join('')}</div><div class="trade-divider">${icon('swap')}</div><div class="receive-group"><div class="side-label receive">You get</div>${p.receive.map(playerRow).join('')}</div></div>
    ${drops || partnerDrops ? `<div class="card-bottom">${drops}${partnerDrops}</div>` : ''}`;
}
function renderTeam() {
  if (!state.team) return;
  $('#my-avatar').textContent = initials(state.team.name);
  $('#my-team-name').textContent = state.team.name;
  $('#my-manager').textContent = `${state.team.manager} · ${state.team.wins}–${state.team.losses}`;
}
async function loadDeck() {
  const generation = state.generation;
  const kind = state.kind;
  const data = await api(`/api/deck?kind=${encodeURIComponent(kind)}`);
  if (generation !== state.generation || kind !== state.kind) return;
  state.deck = data.proposals;
  state.boot.stale = data.stale;
  notice(data.stale ? 'Roster data is out of date. Voting is paused.' : '');
  renderCard();
}
function teamChoices() {
  $('#team-grid').innerHTML = state.boot.teams.filter(t=>t.owner_id).map((t) => `<button class="team-choice ${state.team?.id === t.id ? 'selected' : ''}" data-team="${t.id}"><span class="team-avatar">${escape(initials(t.name))}</span><span><strong>${escape(t.name)}</strong><small>${escape(t.manager)} · ${t.wins}–${t.losses}</small></span></button>`).join('');
  $('#team-dialog-close').hidden = !state.team;
  $('#team-grid').querySelectorAll('[data-team]').forEach(button => button.addEventListener('click', () => chooseTeam(Number(button.dataset.team))));
}
async function chooseTeam(id) {
  if (state.busy) return;
  state.busy = true;
  $$('#team-grid button').forEach(b=>{b.disabled=true;});
  try {
    const data = await api('/api/session', {method:'POST',body:JSON.stringify({team_id:id})});
    state.team = data.team;
    state.generation++;
    state.announced.clear();
    state.lastVote = null;
    state.likes = [];
    state.matches = [];
    $('#likes-count').textContent = '0';
    $('#matches-count').textContent = '0';
    $('#team-dialog').close();
    renderTeam();
    setView('discover');
    await loadDeck();
    await refreshLists(true);
    notice(state.boot.stale ? 'Voting is paused until roster data refreshes.' : '');
  } catch (error) { toast(error.message); }
  finally { state.busy=false;teamChoices();renderCard(); }
}
async function vote(decision) {
  if (state.busy || !state.deck[0] || !state.team || state.boot.stale) return;
  state.busy=true;
  const proposal=state.deck[0];
  const generation=state.generation;
  $('#pass-button').disabled=true;
  $('#like-button').disabled=true;
  $('#undo-button').disabled=true;
  $('#trade-card').classList.add(decision==='like'?'exit-right':'exit-left');
  try {
    const result=await api('/api/votes',{method:'POST',body:JSON.stringify({proposal_id:proposal.id,decision})});
    if (generation!==state.generation) return;
    state.deck.shift();
    state.lastVote=result.matched?null:proposal.id;
    if(result.matched) await showMatch(result.match);
    await refreshLists(false);
  } catch (error) {
    toast(error.message);
    if(error.status===409) await loadDeck();
    if(error.status===503) {state.boot.stale=true;notice(error.message);}
  } finally { state.busy=false;renderCard(); }
}
async function undo() {
  if(state.busy || !state.lastVote) return;
  state.busy=true;
  renderCard();
  try {
    await api(`/api/votes/${state.lastVote}`,{method:'DELETE'});
    state.lastVote=null;
    await loadDeck();
    await refreshLists(false);
  } catch(error) {toast(error.message);}
  finally {state.busy=false;renderCard();}
}
function savedItem(p,matched) {
  const status = matched ? (p.available ? '' : 'Rosters changed. Trade unavailable.') : 'Pending';
  return `<article class="saved-trade"><div class="saved-trade-header"><h3>${escape(p.partner.name)}</h3>${matched?'<span class="match-label">MATCH</span>':icon('heart')}</div>${terms(p)}${status ? `<div class="saved-trade-footer"><span>${status}</span>${!matched?`<button data-withdraw="${p.id}">Withdraw</button>`:''}</div>` : ''}</article>`;
}
function renderLists() {
  $('#likes-count').textContent=state.likes.length;
  const unread=state.matches.filter(m=>m.unread).length;
  $('#matches-count').textContent=unread||state.matches.length;
  $('#matches-count').classList.toggle('unread',unread>0);
  $('#likes-list').innerHTML=state.likes.length ? state.likes.map(p=>savedItem(p,false)).join('') : empty('No likes yet', '', '♡');
  $('#matches-list').innerHTML=state.matches.length ? state.matches.map(p=>savedItem(p,true)).join('') : empty('No matches yet');
  $$('[data-withdraw]').forEach(button=>button.addEventListener('click',async()=>{
    if(state.busy) return;
    state.busy=true;
    button.disabled=true;
    try {await api(`/api/votes/${button.dataset.withdraw}`,{method:'DELETE'});await refreshLists(false);await loadDeck();}
    catch(error){toast(error.message);button.disabled=false;}
    finally{state.busy=false;renderCard();}
  }));
}
async function refreshLists(announce=true) {
  if(!state.team) return;
  const generation=state.generation;
  const [likes,matches]=await Promise.all([api('/api/likes'),api('/api/matches')]);
  if(generation!==state.generation) return;
  state.likes=likes.items;
  state.matches=matches.items;
  renderLists();
  if(announce&&!$('dialog[open]')) {
    const match=state.matches.find(m=>m.unread&&m.available&&!state.announced.has(m.id));
    if(match) await showMatch(match);
  }
}
async function refreshLeague() {
  const generation=state.generation;
  const data=await api('/api/bootstrap');
  if(generation!==state.generation)return;
  const changed=state.boot.epoch!==data.epoch;
  state.boot=data;
  state.team=data.team;
  lastLeagueCheck=Date.now();
  if(!state.team){notice('Choose your team again to reconnect.');renderCard();return;}
  renderTeam();
  notice(data.stale ? 'Roster data is out of date. Voting is paused.' : '');
  if(changed){state.lastVote=null;await loadDeck();}
  else renderCard();
}
async function showMatch(match) {
  state.announced.add(match.id);
  $('#match-partner').textContent=match.partner.name;
  $('#match-terms').innerHTML=terms(match);
  if(!$('#match-dialog').open) $('#match-dialog').showModal();
  try {await api(`/api/matches/${match.id}`,{method:'POST',body:'{}'});}
  catch(error){toast('Your match is saved. The alert will stay unread until you reconnect.');}
}
function setView(view) {
  state.view=view;
  $$('.view').forEach(el=>{el.hidden=el.id!==`${view}-view`;});
  $$('.nav-item').forEach(el=>el.classList.toggle('active',el.dataset.view===view));
  $('#page-title').textContent={discover:'Trades',likes:'Likes',matches:'Matches'}[view];
}
function openRoster() {
  if(!state.team)return;
  $('#roster-title').textContent=state.team.name;
  $('#roster-list').innerHTML=state.team.players.map(id=>state.boot.players[id]).filter(Boolean).sort((a,b)=>b.value-a.value).map(p=>`<div class="roster-row"><div class="player-avatar">${escape(p.position)}</div><div><strong>${escape(p.name)}</strong><small>${escape(p.nfl_team)} ${p.injury?'· '+escape(p.injury):''}${state.team.reserve.includes(p.id)?' · Reserve':''}</small></div></div>`).join('');
  $('#roster-dialog').showModal();
}
async function boot() {
  try {
    const data=await api('/api/bootstrap');
    state.boot=data;state.team=data.team;
    lastLeagueCheck=Date.now();
    $('#league-name').textContent=data.league.name;
    $('#league-info').textContent=`${data.league.total_rosters} teams · ${data.scoring}`;
    teamChoices();renderTeam();renderCard();
    if(data.stale)notice('Roster data is out of date. Voting is paused.');
    if(state.team){await loadDeck();await refreshLists(true);}
    else $('#team-dialog').showModal();
  } catch(error){notice(error.message);$('#trade-card').innerHTML=empty('Couldn’t load your league','Refresh to try again.');$('#pass-button').disabled=true;$('#like-button').disabled=true;}
}

$('#pass-button').addEventListener('click',()=>vote('pass'));
$('#like-button').addEventListener('click',()=>vote('like'));
$('#undo-button').addEventListener('click',undo);
$('#how-button').addEventListener('click',()=>$('#how-dialog').showModal());
$('#roster-button').addEventListener('click',openRoster);
$('#team-switch').addEventListener('click',()=>{if(state.boot&&!state.busy){teamChoices();$('#team-dialog').showModal();}});
$('#team-dialog-close').addEventListener('click',()=>$('#team-dialog').close());
$('#team-dialog').addEventListener('cancel',event=>{if(!state.team)event.preventDefault();});
$$('[data-close]').forEach(button=>button.addEventListener('click',()=>document.getElementById(button.dataset.close).close()));
$('#match-open-button').addEventListener('click',()=>{$('#match-dialog').close();setView('matches');refreshLists(false).catch(e=>toast(e.message));});
$$('[data-view]').forEach(button=>button.addEventListener('click',()=>{
  if(!state.team){if(state.boot)$('#team-dialog').showModal();return;}
  setView(button.dataset.view);
  refreshLists(false).catch(e=>toast(e.message));
}));
$$('[data-kind]').forEach(button=>button.addEventListener('click',async()=>{
  if(state.busy||!state.team)return;
  state.kind=button.dataset.kind;
  $$('[data-kind]').forEach(b=>b.classList.toggle('selected',b===button));
  try{await loadDeck();}catch(e){toast(e.message);}
}));
document.addEventListener('keydown',event=>{
  if(state.view!=='discover'||$('dialog[open]')||event.target.closest('input,textarea,select,button,summary'))return;
  if(event.key==='ArrowLeft'){event.preventDefault();vote('pass');}
  if(event.key==='ArrowRight'){event.preventDefault();vote('like');}
});
let pointer=null;
const card=$('#trade-card');
card.addEventListener('pointerdown',event=>{
  if(state.busy||!state.deck.length||event.target.closest('details,button,a')||event.button!==0)return;
  pointer={id:event.pointerId,x:event.clientX,y:event.clientY,dx:0};
});
card.addEventListener('pointermove',event=>{
  if(!pointer||event.pointerId!==pointer.id)return;
  const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
  if(Math.abs(dy)>Math.abs(dx)+12){pointer=null;card.style.transform='';return;}
  pointer.dx=dx;
  if(Math.abs(dx)>12){card.setPointerCapture(event.pointerId);card.style.transform=`translateX(${dx*.55}px) rotate(${dx*.025}deg)`;card.classList.toggle('drag-right',dx>50);card.classList.toggle('drag-left',dx< -50);}
});
function endSwipe(event) {
  if(!pointer||event.pointerId!==pointer.id)return;
  const dx=pointer.dx;pointer=null;card.style.transform='';card.classList.remove('drag-left','drag-right');
  if(card.hasPointerCapture(event.pointerId))card.releasePointerCapture(event.pointerId);
  if(Math.abs(dx)>85)vote(dx>0?'like':'pass');
}
card.addEventListener('pointerup',endSwipe);
card.addEventListener('pointercancel',()=>{pointer=null;card.style.transform='';card.classList.remove('drag-left','drag-right');});
setInterval(async()=>{
  if(document.hidden||!state.team||state.busy)return;
  try {if(Date.now()-lastLeagueCheck>60000)await refreshLeague();await refreshLists(true);}catch(error){if(error.status===401)notice('Choose your team again to reconnect.');}
},12000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.team)refreshLists(true).catch(()=>{});});
boot();
