'use strict';
// Drafts are local until Save. Only saved, explicit pairwise preferences can alert.
window.rankingFeature = (() => {
  let data=null, drafts={}, position='WR', pane='editor', loading=false, saving=false;
  let opportunities=null, polling=false, marking=false, announced=new Set(), opportunitySignature='';
  const player=id=>data.players.find(p=>p.id===id) || {id,name:'Unavailable player',position,nfl_team:'—'};
  const saved=()=>data?.lists[position]?.ids || [];
  const draft=()=>drafts[position] ||= [...saved()];
  const dirty=()=>JSON.stringify(draft())!==JSON.stringify(saved());
  const status=(message='')=>{ $('#ranking-status').textContent=message;$('#ranking-status').hidden=!message; };
  function reset() {
    data=null;drafts={};loading=false;saving=false;opportunities=null;polling=false;marking=false;announced=new Set();opportunitySignature='';
    $('#ranking-picker').close();status();badges();
    $('#ranking-list').replaceChildren();$('#ranking-opportunities').replaceChildren();
  }
  function badges() {
    const items=opportunities?.items || [], unread=items.filter(item=>item.unread).length;
    $('#rankings-count').textContent=unread;$('#rankings-count').hidden=!unread;
    $('#opportunity-total').textContent=items.length;$('#opportunity-total').hidden=!items.length;
    $('#ranking-alert').hidden=!unread || state.view==='rankings';
    $('#ranking-alert').textContent=`${unread} trade opportunit${unread===1?'y':'ies'} from your rankings ${'→'}`;
  }
  function renderEditor() {
    if(!data)return;
    const ids=draft();
    $('.ranking-positions').innerHTML=data.positions.map(pos=>`<button data-ranking-position="${pos}" class="${pos===position?'selected':''}" aria-pressed="${pos===position}">${pos}</button>`).join('');
    $('#ranking-position-title').textContent=`Your top 25 ${position==='DEF'?'defenses':position+'s'}`;
    $('#ranking-save-state').textContent=saving?'Saving…':dirty()?'Unsaved changes':data.lists[position]?'Saved rankings':'Not ranked yet';
    $('#ranking-save').disabled=saving || !dirty();
    $('#ranking-add').disabled=saving || ids.length>=25;
    $('#ranking-slots').textContent=`${ids.length} / 25`;
    $('#ranking-list').innerHTML=ids.length ? ids.map((id,i)=>`<li class="ranking-row" data-ranking-player="${escape(id)}"><select class="ranking-order" data-ranking-move="${i}" aria-label="Rank ${escape(player(id).name)}" ${saving?'disabled':''}>${ids.map((_,j)=>`<option value="${j}" ${i===j?'selected':''}>${j+1}</option>`).join('')}</select>${playerRow(player(id))}<button class="ranking-remove" data-ranking-remove="${i}" aria-label="Remove ${escape(player(id).name)}" ${saving?'disabled':''}>${icon('x')}</button></li>`).join('') : `<li class="ranking-empty">${icon('list')}<h3>Who’s in your top 25?</h3><p>Add players in your order, or edit a starting list.</p><button id="ranking-start" class="text-button" ${saving?'disabled':''}>Use a starting list</button></li>`;
    $$('[data-ranking-position]').forEach(button=>button.addEventListener('click',()=>{position=button.dataset.rankingPosition;status();$('#ranking-reload').hidden=true;renderEditor();}));
    $$('[data-ranking-move]').forEach(select=>select.addEventListener('change',()=>{
      const from=Number(select.dataset.rankingMove),to=Number(select.value),ids=draft();
      ids.splice(to,0,ids.splice(from,1)[0]);renderEditor();
      $(`[data-ranking-move="${to}"]`).focus({preventScroll:true});
    }));
    $$('[data-ranking-remove]').forEach(button=>button.addEventListener('click',()=>{draft().splice(Number(button.dataset.rankingRemove),1);renderEditor();}));
    $('#ranking-start')?.addEventListener('click',()=>{drafts[position]=data.players.filter(p=>p.position===position).slice(0,25).map(p=>p.id);renderEditor();status('Starting list only. Adjust it, then save your rankings.');});
  }
  function renderPicker() {
    const query=$('#ranking-search').value.trim().toLocaleLowerCase();
    const available=data.players.filter(p=>p.position===position && `${p.name} ${p.nfl_team}`.toLocaleLowerCase().includes(query));
    $('#ranking-search-results').innerHTML=available.slice(0,80).map(p=>`<button class="ranking-search-row" data-ranking-add="${escape(p.id)}" ${draft().includes(p.id)||draft().length>=25?'disabled':''}>${playerRow(p)}<span>${draft().includes(p.id)?'Added':'+'}</span></button>`).join('') || '<p class="ranking-hint">No players found.</p>';
    $$('[data-ranking-add]').forEach(button=>button.addEventListener('click',()=>{
      if(draft().length>=25 || draft().includes(button.dataset.rankingAdd))return;
      draft().push(button.dataset.rankingAdd);renderEditor();renderPicker();
      if(draft().length===25)$('#ranking-picker').close();
    }));
  }
  function renderOpportunities() {
    const element=$('#ranking-opportunities');
    if(!opportunities){element.innerHTML=empty('Loading opportunities…','','swap');return;}
    if(opportunities.unavailable || opportunities.stale){element.innerHTML=empty('Opportunities paused','Waiting for current league data. Your rankings are saved.','swap');return;}
    const items=opportunities.items;
    element.innerHTML=items.length ? `<p class="ranking-hint">You each prefer the player you’d receive. Discuss these trades in Sleeper.</p>${items.map(item=>`<article class="ranking-opportunity"><header><span class="team-avatar">${teamAvatar(item.partner)}</span><div><h3>${escape(item.partner.name)}</h3><span>${item.position} · Trade opportunity</span></div></header><div class="match-deal"><section class="match-side match-give"><h3>You give</h3>${playerRow(item.give)}</section><section class="match-side match-get"><h3>You get</h3>${playerRow(item.receive)}</section></div><div class="ranking-preferences"><p><span>Your rankings</span><strong>#${item.your_ranks.receive} ${escape(item.receive.name)} <span>over</span> #${item.your_ranks.give} ${escape(item.give.name)}</strong></p><p><span>Their rankings</span><strong>#${item.partner_ranks.give} ${escape(item.give.name)} <span>over</span> #${item.partner_ranks.receive} ${escape(item.receive.name)}</strong></p></div></article>`).join('')}` : empty('No opportunities yet','Save your rankings. We’ll flag trades when both managers rank each other’s player higher.','swap');
  }
  async function markSeen() {
    if(marking || state.view!=='rankings' || pane!=='opportunities' || document.hidden)return;
    const ids=(opportunities?.items || []).filter(item=>item.unread).map(item=>item.id);
    if(!ids.length)return;
    const generation=state.generation;marking=true;
    try {
      for(let i=0;i<ids.length;i+=100){if(generation!==state.generation)return;await api('/api/rankings/opportunities/seen',{method:'POST',body:JSON.stringify({ids:ids.slice(i,i+100)})});}
      if(generation!==state.generation)return;
      for(const item of opportunities?.items || [])if(ids.includes(item.id))item.unread=false;
      badges();
    } catch { /* Keep the unread badge so the alert survives a failed save. */ }
    finally {if(generation===state.generation)marking=false;}
  }
  function receive(result,announce=true) {
    opportunities=result || {items:[],unavailable:true};
    const fresh=opportunities.items.filter(item=>item.unread && !announced.has(item.id));
    if(announce && fresh.length && !document.hidden && !$('dialog[open]') && !(state.view==='rankings' && pane==='opportunities')) {
      toast(`Your rankings found ${fresh.length} trade opportunit${fresh.length===1?'y':'ies'}.`);
      fresh.forEach(item=>announced.add(item.id));
    }
    badges();
    const signature=JSON.stringify(opportunities);
    if(signature!==opportunitySignature){opportunitySignature=signature;renderOpportunities();}
    markSeen();
  }
  async function poll(announce=true) {
    if(!state.team || polling)return;
    const generation=state.generation;polling=true;
    try {const result=await api('/api/rankings/opportunities');if(generation===state.generation)receive(result,announce);}
    catch {if(generation===state.generation)receive(null,false);}
    finally {if(generation===state.generation)polling=false;}
  }
  function showPane(next) {
    pane=next;
    $$('[data-ranking-pane]').forEach(button=>{const selected=button.dataset.rankingPane===pane;button.classList.toggle('selected',selected);button.setAttribute('aria-pressed',String(selected));});
    $('#ranking-editor').hidden=pane!=='editor';$('#ranking-opportunities').hidden=pane!=='opportunities';
    badges();
    if(pane==='opportunities'){renderOpportunities();poll(false);markSeen();}
  }
  async function load(force=false) {
    badges();
    if(data && !force){renderEditor();showPane(pane);return;}
    if(loading || !state.team)return;
    const generation=state.generation;loading=true;status('Loading rankings…');
    $('#ranking-save').disabled=true;$('#ranking-add').disabled=true;
    try {
      const result=await api('/api/rankings');
      if(generation!==state.generation)return;
      data=result;if(force)drafts={};status();$('#ranking-reload').hidden=true;renderEditor();showPane(pane);poll(false);
    } catch(error){if(generation===state.generation){status(error.message);$('#ranking-reload').hidden=false;}}
    finally{if(generation===state.generation)loading=false;}
  }
  $('#ranking-save').addEventListener('click',async()=>{
    if(!data || saving || !dirty())return;
    const generation=state.generation,selected=position,ids=[...draft()];
    saving=true;renderEditor();status();
    try {
      const result=await api('/api/rankings',{method:'POST',body:JSON.stringify({position:selected,ids,revision:data.lists[selected]?.revision || null})});
      if(generation!==state.generation)return;
      data.lists[selected]=result.list;drafts[selected]=[...result.list.ids];
      await poll(true);
    } catch(error){if(generation===state.generation){status(error.message);if(error.status===409)$('#ranking-reload').hidden=false;}}
    finally{if(generation===state.generation){saving=false;renderEditor();}}
  });
  $('#ranking-add').addEventListener('click',()=>{if(!data || saving)return;$('#ranking-picker-title').textContent=`Add ${position==='DEF'?'a defense':'a '+position}`;$('#ranking-search').value='';renderPicker();$('#ranking-picker').showModal();$('#ranking-search').focus();});
  $('#ranking-search').addEventListener('input',renderPicker);
  $('#ranking-reload').addEventListener('click',()=>load(true));
  $$('[data-ranking-pane]').forEach(button=>button.addEventListener('click',()=>showPane(button.dataset.rankingPane)));
  $('#ranking-alert').addEventListener('click',()=>{setView('rankings');showPane('opportunities');});
  return {reset,load,receive,poll,viewChanged:badges};
})();
