'use strict';
// Drafts are local until Save. Only saved, explicit pairwise preferences can alert.
window.rankingFeature = (() => {
  let data=null, drafts={}, position='WR', pane='editor', loading=false, saving=false;
  let opportunities=null, polling=false, marking=false, announced=new Set(), opportunitySignature='';
  let drag=null;
  const player=id=>data.players.find(p=>p.id===id) || {id,name:'Unavailable player',position,nfl_team:'—'};
  const saved=()=>data?.lists[position]?.ids || [];
  const draft=()=>drafts[position] ||= [...saved()];
  const dirty=()=>JSON.stringify(draft())!==JSON.stringify(saved());
  const status=(message='')=>{ $('#ranking-status').textContent=message;$('#ranking-status').hidden=!message; };
  function reset() {
    finishDrag(false,false);
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
    finishDrag(false,false);
    if(!data)return;
    const ids=draft();
    $('.ranking-positions').innerHTML=data.positions.map(pos=>`<button data-ranking-position="${pos}" class="${pos===position?'selected':''}" aria-pressed="${pos===position}">${pos}</button>`).join('');
    $('#ranking-position-title').textContent=`Your top ${data.limit} ${position==='DEF'?'defenses':position+'s'}`;
    $('#ranking-save-state').textContent=saving?'Saving…':dirty()?'Unsaved changes':data.lists[position]?'Saved rankings':'Not ranked yet';
    $('#ranking-save').disabled=saving || !dirty();
    $('#ranking-add').disabled=saving || ids.length>=data.limit;
    $('#ranking-slots').textContent=`${ids.length} / ${data.limit}`;
    $('#ranking-list').innerHTML=ids.length ? ids.map((id,i)=>`<li class="ranking-row" data-ranking-player="${escape(id)}"><select class="ranking-order" data-ranking-move="${i}" aria-label="Rank ${escape(player(id).name)}" ${saving?'disabled':''}>${ids.map((_,j)=>`<option value="${j}" ${i===j?'selected':''}>${j+1}</option>`).join('')}</select>${playerRow(player(id))}<span class="ranking-grip" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M8 5h.01M16 5h.01M8 12h.01M16 12h.01M8 19h.01M16 19h.01" stroke-width="3"/></svg></span><button class="ranking-remove" data-ranking-remove="${i}" aria-label="Remove ${escape(player(id).name)}" ${saving?'disabled':''}>${icon('x')}</button></li>`).join('') : `<li class="ranking-empty">${icon('list')}<h3>Who’s in your top ${data.limit}?</h3><p>Add players in your order, or edit a starting list.</p><button id="ranking-start" class="text-button" ${saving?'disabled':''}>Use a starting list</button></li>`;
    $$('[data-ranking-position]').forEach(button=>button.addEventListener('click',()=>{position=button.dataset.rankingPosition;status();$('#ranking-reload').hidden=true;renderEditor();}));
    $$('[data-ranking-move]').forEach(select=>select.addEventListener('change',()=>{
      const from=Number(select.dataset.rankingMove),to=Number(select.value),ids=draft();
      ids.splice(to,0,ids.splice(from,1)[0]);renderEditor();
      $(`[data-ranking-move="${to}"]`).focus({preventScroll:true});
    }));
    $$('[data-ranking-remove]').forEach(button=>button.addEventListener('click',()=>{draft().splice(Number(button.dataset.rankingRemove),1);renderEditor();}));
    $('#ranking-start')?.addEventListener('click',()=>{drafts[position]=data.players.filter(p=>p.position===position).slice(0,data.limit).map(p=>p.id);renderEditor();status('Starting list only. Adjust it, then save your rankings.');});
  }
  function renderPicker() {
    const query=$('#ranking-search').value.trim().toLocaleLowerCase();
    const selected=new Set(draft());
    // The catalogue is already ordered by suggested rank. Keep that order while
    // excluding players in this draft, including players added before saving.
    const available=data.players.filter(p=>p.position===position && !selected.has(p.id) && `${p.name} ${p.nfl_team}`.toLocaleLowerCase().includes(query));
    $('#ranking-search-results').innerHTML=available.slice(0,80).map(p=>`<button class="ranking-search-row" data-ranking-add="${escape(p.id)}" ${draft().length>=data.limit?'disabled':''}>${playerRow(p)}<span aria-hidden="true">+</span></button>`).join('') || '<p class="ranking-hint">No players found.</p>';
    $$('[data-ranking-add]').forEach(button=>button.addEventListener('click',()=>{
      if(draft().length>=data.limit || draft().includes(button.dataset.rankingAdd))return;
      draft().push(button.dataset.rankingAdd);renderEditor();renderPicker();
      if(draft().length===data.limit)$('#ranking-picker').close();
    }));
  }
  function finishDrag(commit,render=true) {
    if(commit && drag?.active)dragFrame(performance.now());
    const current=drag;
    if(!current)return;
    drag=null;
    clearTimeout(current.timer);cancelAnimationFrame(current.frame);
    if(current.active && commit && current.generation===state.generation && current.position===position) {
      drafts[position]=current.order.map(row=>row.dataset.rankingPlayer);
    }
    current.ghost?.remove();current.row.classList.remove('ranking-drag-placeholder');
    current.rows?.forEach(row=>row.style.removeProperty('transform'));
    document.body.classList.remove('ranking-dragging');
    if(current.pointerID!==undefined && $('#ranking-list').hasPointerCapture(current.pointerID))$('#ranking-list').releasePointerCapture(current.pointerID);
    if(current.active && render)renderEditor();
  }
  function dragFrame(time) {
    if(!drag?.active)return;
    const current=drag, elapsed=Math.min(40,time-(current.lastFrame||time));
    current.lastFrame=time;
    const bottom=Math.min(innerHeight,$('.bottom-nav').getBoundingClientRect().top)-12;
    const speed=current.y<70 ? -Math.min(14,(70-current.y)*.22) : current.y>bottom-65 ? Math.min(14,(current.y-bottom+65)*.22) : 0;
    if(speed)window.scrollBy(0,speed*elapsed/16.67);
    current.ghost.style.transform=`translate3d(0,${current.y-current.offset}px,0)`;
    // Keep the touched DOM node mounted until release. Reparenting it during
    // a gesture can make Safari cancel touch events, even when scrolling is blocked.
    const others=current.rows.filter(row=>row!==current.row);
    const center=current.y-current.offset+current.height/2+scrollY;
    const index=others.filter(row=>{const box=current.boxes.get(row);return center>box.top+box.height/2;}).length;
    current.order=[...others.slice(0,index),current.row,...others.slice(index)];
    let top=current.top;
    current.order.forEach((row,i)=>{
      const box=current.boxes.get(row);
      row.style.transform=`translateY(${top-box.top}px)`;
      row.querySelector('select').value=String(i);
      top+=box.height;
    });
    current.ghost.querySelector('select').value=String(index);
    current.frame=requestAnimationFrame(dragFrame);
  }
  function activateDrag() {
    if(!drag || saving || state.view!=='rankings' || pane!=='editor')return finishDrag(false);
    const box=drag.row.getBoundingClientRect();
    drag.active=true;drag.offset=drag.y-box.top;drag.height=box.height;
    drag.rows=[...$('#ranking-list').querySelectorAll('.ranking-row')];
    drag.order=[...drag.rows];
    drag.boxes=new Map(drag.rows.map(row=>{const rect=row.getBoundingClientRect();return [row,{top:rect.top+scrollY,height:rect.height}];}));
    drag.top=drag.boxes.get(drag.rows[0]).top;
    const ghost=drag.row.cloneNode(true);
    ghost.removeAttribute('data-ranking-player');
    ghost.querySelectorAll('[data-ranking-move],[data-ranking-remove]').forEach(el=>{el.removeAttribute('data-ranking-move');el.removeAttribute('data-ranking-remove');});
    ghost.classList.add('ranking-drag-ghost');ghost.setAttribute('aria-hidden','true');ghost.inert=true;
    ghost.style.left=`${box.left}px`;ghost.style.width=`${box.width}px`;
    ghost.style.transform=`translate3d(0,${box.top}px,0)`;
    document.body.append(ghost);drag.ghost=ghost;
    drag.row.classList.add('ranking-drag-placeholder');document.body.classList.add('ranking-dragging');
    if(drag.pointerID!==undefined)$('#ranking-list').setPointerCapture(drag.pointerID);
    drag.frame=requestAnimationFrame(dragFrame);
  }
  function prepareDrag(target,x,y,ids) {
    if(drag || saving || !data || pane!=='editor' || state.view!=='rankings' || target.closest('button,select,option'))return;
    const row=target.closest('#ranking-list .ranking-row');
    if(!row)return;
    drag={row,x,y,startX:x,startY:y,position,generation:state.generation,...ids};
    drag.timer=setTimeout(activateDrag,ids.touchID!==undefined?240:180);
  }
  // A quick touch movement keeps native scrolling. Only a held row claims the
  // gesture, via a non-passive touchmove listener (including on iOS Safari).
  $('#ranking-list').addEventListener('touchstart',event=>{
    if(event.touches.length!==1)return finishDrag(false);
    const touch=event.touches[0];prepareDrag(event.target,touch.clientX,touch.clientY,{touchID:touch.identifier});
  },{passive:false});
  document.addEventListener('touchstart',event=>{if(drag && event.touches.length!==1)finishDrag(false);},{passive:true});
  document.addEventListener('touchmove',event=>{
    if(!drag || drag.touchID===undefined)return;
    const touch=[...event.touches].find(t=>t.identifier===drag.touchID);
    if(!touch || event.touches.length!==1)return finishDrag(false);
    if(!drag.active && Math.hypot(touch.clientX-drag.startX,touch.clientY-drag.startY)>12)return finishDrag(false);
    if(drag.active){if(!event.cancelable)return finishDrag(false);event.preventDefault();}
    drag.x=touch.clientX;drag.y=touch.clientY;
  },{passive:false});
  document.addEventListener('touchend',event=>{
    if(!drag || ![...event.changedTouches].some(t=>t.identifier===drag.touchID))return;
    if(drag.active && event.cancelable)event.preventDefault();
    finishDrag(true);
  },{passive:false});
  document.addEventListener('touchcancel',()=>finishDrag(false),{passive:true});
  $('#ranking-list').addEventListener('pointerdown',event=>{
    const handle=event.target.closest('.ranking-grip');
    if((event.pointerType==='touch' && !handle) || !event.isPrimary || event.button!==0)return;
    prepareDrag(event.target,event.clientX,event.clientY,{pointerID:event.pointerId});
    if(handle && drag){event.preventDefault();clearTimeout(drag.timer);activateDrag();}
  });
  document.addEventListener('pointermove',event=>{
    if(!drag || event.pointerId!==drag.pointerID)return;
    if(!drag.active && Math.hypot(event.clientX-drag.startX,event.clientY-drag.startY)>6){clearTimeout(drag.timer);activateDrag();}
    if(drag){drag.x=event.clientX;drag.y=event.clientY;}
  });
  document.addEventListener('pointerup',event=>{if(drag && event.pointerId===drag.pointerID)finishDrag(true);});
  document.addEventListener('pointercancel',event=>{if(drag && event.pointerId===drag.pointerID)finishDrag(false);});
  $('#ranking-list').addEventListener('lostpointercapture',event=>{if(drag && event.target===$('#ranking-list') && event.pointerId===drag.pointerID)finishDrag(false);});
  $('#ranking-list').addEventListener('contextmenu',event=>{if(event.target.closest('.ranking-row'))event.preventDefault();});
  document.addEventListener('keydown',event=>{if(drag && event.key==='Escape'){event.preventDefault();finishDrag(false);}});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)finishDrag(false);});
  window.addEventListener('blur',()=>finishDrag(false));
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
    finishDrag(false);
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
  $('#ranking-add').addEventListener('click',()=>{if(!data || saving)return;$('#ranking-picker-title').textContent=`Add ${position==='DEF'?'a defense':'a '+position}`;$('#ranking-search').value='';renderPicker();$('#ranking-picker').showModal();$('#ranking-search-results').scrollTop=0;});
  $('#ranking-search').addEventListener('input',()=>{renderPicker();$('#ranking-search-results').scrollTop=0;});
  $('#ranking-reload').addEventListener('click',()=>load(true));
  $$('[data-ranking-pane]').forEach(button=>button.addEventListener('click',()=>showPane(button.dataset.rankingPane)));
  $('#ranking-alert').addEventListener('click',()=>{setView('rankings');showPane('opportunities');});
  return {reset,load,receive,poll,viewChanged:()=>{if(state.view!=='rankings')finishDrag(false);badges();}};
})();
