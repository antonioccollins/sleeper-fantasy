'use strict';
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const icons = {
  brand: '<path d="M5 2h7l-3 8h6L5 22H1l4-10H1Zm11 0h7l-5 20h-7l4-10h-5Z" fill="currentColor" stroke="none"/>',
  home: '<path d="m3 10 9-8 9 8v11h-6v-7H9v7H3Z"/>',
  settings: '<path d="M3 7h8m4 0h6M3 17h12m4 0h2"/><circle cx="13" cy="7" r="2"/><circle cx="17" cy="17" r="2"/>',
  trophy: '<path d="M7 3h10v7a5 5 0 0 1-10 0ZM7 5H3v3a4 4 0 0 0 4 4M17 5h4v3a4 4 0 0 1-4 4M12 15v5M8 21h8"/>',
  person: '<circle cx="12" cy="7" r="4"/><path d="M4 22v-3a8 8 0 0 1 16 0v3Z"/>',
  heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  cards: '<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M4 6H3v14a2 2 0 0 0 2 2h12M11 8h5M11 12h5"/>',
  matches: '<path d="M10 13a5 5 0 0 0 7 .5l3-3a5 5 0 0 0-7-7l-2 2M14 11a5 5 0 0 0-7-.5l-3 3a5 5 0 0 0 7 7l2-2"/>',
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
function dataNotice(data) {
  if (data.recommendations?.status === 'unavailable') return 'FantasyPros rankings are unavailable. Trades are paused.';
  return data.stale ? 'Trade data is out of date. Voting is paused.' : '';
}
function updateMethod(data) {
  const ready = data.recommendations?.source === 'FantasyPros';
  $('#suggestion-method').textContent = ready ? 'Based on FantasyPros rest-of-season rankings and roster fit. Trade values are our estimates. Submit matches in Sleeper.' : 'Suggestions need current FantasyPros rest-of-season rankings.';
}
function empty(title, message='', symbol='cards') {
  return `<div class="empty-state"><span class="empty-symbol">${icon(symbol)}</span><h2>${escape(title)}</h2>${message ? `<p>${escape(message)}</p>` : ''}</div>`;
}
function playerRow(p) {
  // Ratings retain Sleeper player IDs. Never substitute a rank/provider ID.
  const photo = /^\d+$/.test(String(p.id)) ? `https://sleepercdn.com/content/nfl/players/${p.id}.jpg` : null;
  const nflTeams = new Set(['ARI','ATL','BAL','BUF','CAR','CHI','CIN','CLE','DAL','DEN','DET','GB','HOU','IND','JAX','KC','LAC','LAR','LV','MIA','MIN','NE','NO','NYG','NYJ','PHI','PIT','SEA','SF','TB','TEN','WAS']);
  const team = {JAC:'JAX',WSH:'WAS',LA:'LAR'}[p.nfl_team] || p.nfl_team;
  const logo = nflTeams.has(team) ? `https://sleepercdn.com/images/team_logos/nfl/${team.toLowerCase()}.png` : null;
  return `<div class="player" data-player-id="${escape(p.id)}"><div class="player-headshot"><span aria-hidden="true">${escape(initials(p.name))}</span>${photo ? `<img src="${photo}" alt="" width="96" height="96" decoding="async" draggable="false" referrerpolicy="no-referrer">` : ''}</div><div class="player-info"><strong>${escape(p.name)}</strong><small><span>${escape(p.position)} · ${escape(p.nfl_team)}</span>${p.injury ? `<span class="injury-tag">${escape(p.injury)}</span>` : ''}</small></div><div class="nfl-logo" aria-hidden="true">${logo ? `<img src="${logo}" alt="" width="48" height="48" decoding="async" draggable="false" referrerpolicy="no-referrer">` : ''}</div></div>`;
}
function teamAvatar(team) {
  const fallback = `<span class="avatar-initials">${escape(initials(team.name))}</span>`;
  const avatar = typeof team.avatar === 'string' && team.avatar.startsWith('https://sleepercdn.com/') ? team.avatar : null;
  return fallback + (avatar ? `<img class="team-avatar-image" src="${escape(avatar)}" alt="" width="48" height="48" decoding="async" draggable="false" referrerpolicy="no-referrer">` : '');
}
// A missing portrait leaves initials; a missing logo leaves the team abbreviation.
document.addEventListener('error', event => {
  if (event.target.matches?.('.player-headshot img, .nfl-logo img')) event.target.hidden = true;
  if (event.target.matches?.('.team-avatar-image')) {
    event.target.hidden = true;
    event.target.previousElementSibling.hidden = false;
  }
}, true);
document.addEventListener('load', event => {
  if (event.target.matches?.('.player-headshot img')) event.target.parentElement.classList.add('photo-loaded');
  if (event.target.matches?.('.team-avatar-image')) event.target.previousElementSibling.hidden = true;
}, true);
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
  if (p && state.team) card.setAttribute('aria-labelledby', 'partner-name');
  else card.removeAttribute('aria-labelledby');
  card.parentElement.classList.toggle('has-trades', Boolean(p && state.team));
  const disabled = state.busy || !p || !state.team || state.boot?.stale;
  $('#pass-button').disabled = disabled;
  $('#like-button').disabled = disabled;
  $('#undo-button').disabled = state.busy || !state.lastVote;
  if (!state.team) {
    card.innerHTML = empty('Choose your team', '', 'swap');
    return;
  }
  if (!p) {
    card.innerHTML = state.boot?.stale ? empty('Trades paused') : empty('No more trades', 'Try another filter or check your likes.');
    return;
  }
  const drops = p.drops.length ? `<p class="drop-note">Extra roster spot needed. Suggested drop: ${p.drops.map(v=>escape(v.name)).join(', ')}.</p>` : '';
  const partnerDrops = p.partner_drops.length ? '<p class="drop-note">Your partner needs an extra roster spot.</p>' : '';
  const partner = state.boot.teams.find(t => t.id === p.partner.id);
  const record = partner ? `${partner.wins} – ${partner.losses}${partner.ties ? ` – ${partner.ties}` : ''}` : '';
  card.innerHTML = `<header class="trade-partner" id="trade-partner"><span class="partner-avatar" id="partner-avatar">${teamAvatar(partner || p.partner)}</span><div class="partner-info"><h2 id="partner-name">${escape(p.partner.name)}</h2>${record ? `<span class="partner-record">${escape(record)}</span>` : ''}</div><span class="trade-type">${p.give.length} for ${p.receive.length}</span></header><div class="trade-content"><div class="give-group"><div class="side-label">You give</div>${p.give.map(playerRow).join('')}</div><div class="trade-divider">${icon('swap')}</div><div class="receive-group"><div class="side-label receive">You get</div>${p.receive.map(playerRow).join('')}</div></div>
    ${drops || partnerDrops ? `<div class="card-bottom">${drops}${partnerDrops}</div>` : ''}`;
}
function renderTeam() {
  if (!state.team) return;
  $('#my-avatar').innerHTML = teamAvatar(state.team);
  $('#my-team-name').textContent = state.team.name;
  $('#my-manager').textContent = `${state.team.manager} · ${state.team.wins}–${state.team.losses}`;
  $('#team-switch').title = state.team.name;
}
async function loadDeck() {
  const generation = state.generation;
  const kind = state.kind;
  const data = await api(`/api/deck?kind=${encodeURIComponent(kind)}`);
  if (generation !== state.generation || kind !== state.kind) return;
  state.deck = data.proposals;
  state.boot.stale = data.stale;
  state.boot.recommendations = data.recommendations;
  updateMethod(data);
  notice(dataNotice(data));
  renderCard();
}
function teamChoices() {
  $('#team-picker-title').textContent = state.team ? 'Switch team' : 'Choose your team';
  $('#team-picker-league-name').textContent = state.boot.league.name;
  $('#team-grid').innerHTML = state.boot.teams.filter(t=>t.owner_id).map((t,i) => `<button class="team-choice ${state.team?.id === t.id ? 'selected' : ''}" data-team="${t.id}" aria-pressed="${state.team?.id === t.id}"><span class="team-avatar team-tone-${i%5}" aria-hidden="true">${teamAvatar(t)}</span><span class="team-choice-name"><strong>${escape(t.name)}</strong><small>${escape(t.manager)}</small></span><span class="team-choice-indicator" aria-hidden="true">${icon(state.team?.id === t.id ? 'check' : 'chevron')}</span></button>`).join('');
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
    $('#likes-count').hidden = true;
    $('#matches-count').hidden = true;
    $('#team-dialog').close();
    renderTeam();
    setView('discover');
    await loadDeck();
    await refreshLists(true);
    notice(dataNotice(state.boot));
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
  const animation = new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180));
  try {
    const [result]=await Promise.all([api('/api/votes',{method:'POST',body:JSON.stringify({proposal_id:proposal.id,decision})}),animation]);
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
  $('#likes-count').hidden=state.likes.length===0;
  const unread=state.matches.filter(m=>m.unread).length;
  $('#matches-count').textContent=unread||state.matches.length;
  $('#matches-count').hidden=state.matches.length===0;
  $('#matches-count').classList.toggle('unread',unread>0);
  $('#likes-list').innerHTML=state.likes.length ? state.likes.map(p=>savedItem(p,false)).join('') : empty('No likes yet', '', 'heart');
  $('#matches-list').innerHTML=state.matches.length ? state.matches.map(p=>savedItem(p,true)).join('') : empty('No matches yet', '', 'matches');
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
  const recommendationsChanged=state.boot.stale!==data.stale || state.boot.recommendations?.fetched_at!==data.recommendations?.fetched_at;
  state.boot=data;
  state.team=data.team;
  lastLeagueCheck=Date.now();
  if(!state.team){notice('Choose your team again to reconnect.');renderCard();return;}
  renderTeam();
  updateMethod(data);
  notice(dataNotice(data));
  if(changed || recommendationsChanged){state.lastVote=null;await loadDeck();}
  else renderCard();
}
async function showMatch(match) {
  state.announced.add(match.id);
  $('#match-partner').textContent=match.partner.name;
  const partner=state.boot.teams.find(t=>t.id===match.partner.id) || match.partner;
  for(const [id,team] of [['match-your-avatar',state.team],['match-their-avatar',partner]]) {
    const avatar=document.getElementById(id);
    avatar.innerHTML=teamAvatar(team);
    avatar.setAttribute('aria-label',team.name);
  }
  $('#match-terms').innerHTML=`<div class="match-deal"><section class="match-side match-give"><h3>You give</h3>${match.give.map(playerRow).join('')}</section><section class="match-side match-get"><h3>You get</h3>${match.receive.map(playerRow).join('')}</section></div>`;
  if(!$('#match-dialog').open) $('#match-dialog').showModal();
  try {await api(`/api/matches/${match.id}`,{method:'POST',body:'{}'});}
  catch(error){toast('Your match is saved. The alert will stay unread until you reconnect.');}
}
function setView(view) {
  state.view=view;
  $$('.view').forEach(el=>{el.hidden=el.id!==`${view}-view`;});
  $$('.nav-item').forEach(el=>{
    const active=el.dataset.view===view || (view==='matches' && el.dataset.view==='likes');
    el.classList.toggle('active',active);
    if(active)el.setAttribute('aria-current','page');else el.removeAttribute('aria-current');
  });
  document.body.classList.toggle('discover-mode', view==='discover');
  $('#page-title').textContent={discover:'Discover',likes:'Likes',matches:'Matches'}[view];
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
    $('#settings-league-name').textContent=data.league.name;
    $('#league-info').textContent=`${data.league.total_rosters} teams · ${data.scoring}`;
    teamChoices();renderTeam();renderCard();
    updateMethod(data);notice(dataNotice(data));
    if(state.team){await loadDeck();await refreshLists(true);}
    else $('#team-dialog').showModal();
  } catch(error){notice(error.message);$('#trade-card').innerHTML=empty('Couldn’t load your league','Refresh to try again.');$('#pass-button').disabled=true;$('#like-button').disabled=true;}
}

$('#pass-button').addEventListener('click',()=>vote('pass'));
$('#like-button').addEventListener('click',()=>vote('like'));
$('#undo-button').addEventListener('click',undo);
function closeMenus() { $$('#settings-dialog[open], #profile-dialog[open], #league-dialog[open]').forEach(d=>d.close()); }
function openLeague() {
  if (!state.boot) return;
  closeMenus();
  $('#league-teams').innerHTML = state.boot.teams.map(t=>`<div class="roster-row"><span class="team-avatar">${teamAvatar(t)}</span><div><strong>${escape(t.name)}</strong><small>${escape(t.manager)}</small></div><span class="league-record">${t.wins}–${t.losses}${t.ties ? `–${t.ties}` : ''}</span></div>`).join('');
  $('#league-dialog').showModal();
}
$('#settings-button').addEventListener('click',()=>$('#settings-dialog').showModal());
$('#profile-button').addEventListener('click',()=>$('#profile-dialog').showModal());
$('#league-button').addEventListener('click',openLeague);
$('#settings-league').addEventListener('click',openLeague);
$('#how-button').addEventListener('click',()=>{closeMenus();$('#how-dialog').showModal();});
['roster-button','profile-roster'].forEach(id=>document.getElementById(id).addEventListener('click',()=>{closeMenus();openRoster();}));
['settings-matches','profile-matches'].forEach(id=>document.getElementById(id).addEventListener('click',()=>{closeMenus();setView('matches');refreshLists(false).catch(e=>toast(e.message));}));
$('#team-switch').addEventListener('click',()=>{if(state.boot&&!state.busy){closeMenus();teamChoices();$('#team-dialog').showModal();}});
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
  $('#filter-active').hidden=state.kind==='all';
  $$('[data-kind]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});
  $('#settings-dialog').close();
  try{await loadDeck();}catch(e){toast(e.message);}
}));
document.addEventListener('keydown',event=>{
  if(state.view!=='discover'||$('dialog[open]')||event.target.closest('input,textarea,select,button,summary'))return;
  if(event.key==='ArrowLeft'){event.preventDefault();vote('pass');}
  if(event.key==='ArrowRight'){event.preventDefault();vote('like');}
});
let pointer=null;
const card=$('#trade-card');
const SWIPE_DISTANCE=42;
function resetSwipe() {
  pointer=null;
  card.style.transform='';
  card.classList.remove('dragging','drag-left','drag-right');
}
card.addEventListener('pointerdown',event=>{
  if(pointer||state.busy||state.boot?.stale||!state.deck.length||event.target.closest('details,button,a')||event.button!==0||!event.isPrimary)return;
  pointer={id:event.pointerId,x:event.clientX,y:event.clientY,dx:0,dragging:false};
});
card.addEventListener('pointermove',event=>{
  if(!pointer||event.pointerId!==pointer.id)return;
  const dx=event.clientX-pointer.x,dy=event.clientY-pointer.y;
  if(!pointer.dragging) {
    if(Math.max(Math.abs(dx),Math.abs(dy))<6)return;
    if(Math.abs(dy)>=Math.abs(dx)){resetSwipe();return;}
    pointer.dragging=true;
    card.setPointerCapture(event.pointerId);
    card.classList.add('dragging');
  }
  pointer.dx=dx;
  card.style.transform=`translateX(${dx*.95}px) rotate(${Math.max(-10,Math.min(10,dx*.025))}deg)`;
  card.classList.toggle('drag-right',dx>=SWIPE_DISTANCE);
  card.classList.toggle('drag-left',dx<=-SWIPE_DISTANCE);
});
function endSwipe(event) {
  if(!pointer||event.pointerId!==pointer.id)return;
  const {dx,dragging}=pointer;
  resetSwipe();
  if(card.hasPointerCapture(event.pointerId))card.releasePointerCapture(event.pointerId);
  if(dragging&&Math.abs(dx)>=SWIPE_DISTANCE)vote(dx>0?'like':'pass');
}
card.addEventListener('pointerup',endSwipe);
card.addEventListener('pointercancel',resetSwipe);
card.addEventListener('lostpointercapture',event=>{
  // Touch starts with implicit capture on the player row/image. Its loss when
  // capture transfers to the card must not cancel the card's active gesture.
  if(event.target===card)resetSwipe();
});
setInterval(async()=>{
  if(document.hidden||!state.team||state.busy)return;
  try {if(Date.now()-lastLeagueCheck>60000)await refreshLeague();await refreshLists(true);}catch(error){if(error.status===401)notice('Choose your team again to reconnect.');}
},12000);
document.addEventListener('visibilitychange',()=>{if(!document.hidden&&state.team)refreshLists(true).catch(()=>{});});
boot();
