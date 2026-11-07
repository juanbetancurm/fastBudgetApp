(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => `${value < 0 ? '-$' : '$'}${new Intl.NumberFormat('es-CO', {maximumFractionDigits: 0}).format(Math.abs(value))}`;
  const dateLabel = (iso, options = {day:'2-digit',month:'short',year:'numeric'}) => new Intl.DateTimeFormat('es-CO', options).format(new Date(`${iso}T12:00:00`));
  let expenses = [], categories = [], settings = {}, categoryChart, dailyChart, toastTimer;

  async function api(path, options = {}) {
    const response = await fetch(path, {credentials:'same-origin', ...options, headers:{'Content-Type':'application/json','X-CSRF-Token':csrf,...(options.headers||{})}});
    let data = {};
    try { data = await response.json(); } catch (_) {}
    if (response.status === 401) { location.href = '/login'; throw new Error('Inicia sesión de nuevo.'); }
    if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud.');
    return data;
  }
  function toast(message) { const el=$('#toast'); el.textContent=message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer=setTimeout(()=>el.classList.remove('show'),2400); }
  function feedback(el, message, isError=false) { el.textContent=message; el.classList.toggle('error',isError); }
  async function loadAll() {
    const [s,c,e] = await Promise.all([api('/api/settings'),api('/api/categories'),api('/api/expenses')]);
    settings=s; categories=c.categories; expenses=e.expenses;
    renderCategories(); renderExpenses(); renderFinancials(); renderSettings();
  }
  function renderCategories() {
    const selected=$('#expense-category').value;
    $('#expense-category').innerHTML=categories.map(c=>`<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
    if (categories.some(c=>String(c.id)===selected)) $('#expense-category').value=selected;
  }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function renderExpenses() {
    const root=$('#expense-list');
    if (!expenses.length) { root.innerHTML='<div class="empty-state"><strong>Aún no hay gastos</strong>Registra el primero en el formulario de arriba.</div>'; return; }
    const ascending=$('#sort-order').value==='asc';
    const sorted=[...expenses].sort((a,b)=>ascending ? a.date.localeCompare(b.date)||a.id-b.id : b.date.localeCompare(a.date)||b.id-a.id);
    const groups=new Map(); sorted.forEach(e=>{ if(!groups.has(e.date))groups.set(e.date,[]);groups.get(e.date).push(e); });
    root.innerHTML=[...groups.entries()].map(([d,items])=>`<div class="expense-day"><div class="day-heading"><span>${dateLabel(d,{weekday:'long',day:'2-digit',month:'long'})}</span><strong>Total del día · ${money(items.reduce((sum,e)=>sum+e.amount,0))}</strong></div>${items.map(e=>`<div class="expense-row"><span class="expense-date">${dateLabel(e.date)}</span><span class="expense-description">${escapeHtml(e.description||'Gasto')}</span><span class="expense-category">${escapeHtml(e.category)}</span><span class="expense-amount">${money(e.amount)}</span><span class="row-actions"><button class="text-action" data-edit="${e.id}" type="button">Editar</button><button class="text-action delete" data-delete="${e.id}" type="button">Borrar</button></span></div>`).join('')}</div>`).join('');
  }
  function renderFinancials() {
    const total=expenses.reduce((sum,e)=>sum+e.amount,0), remaining=settings.initial_budget-total;
    $('#budget-value').textContent=money(settings.initial_budget); $('#spent-value').textContent=money(total); $('#remaining-value').textContent=money(remaining);
    $('#remaining-value').parentElement.classList.toggle('negative',remaining<0);
    $('#trip-length').textContent=`${tripDays()} ${tripDays()===1?'día':'días'} de viaje`;
    $('#spent-note').textContent=`${expenses.length} ${expenses.length===1?'gasto registrado':'gastos registrados'}`;
    $('#remaining-note').textContent=remaining<0?'Has superado el presupuesto':'Presupuesto menos gastos';
    $('#trip-dates').textContent=`${dateLabel(settings.trip_start,{day:'numeric',month:'short',year:'numeric'}).toUpperCase()} — ${dateLabel(settings.trip_end,{day:'numeric',month:'short',year:'numeric'}).toUpperCase()}`;
    renderCharts();
  }
  function tripDays(){return Math.round((new Date(settings.trip_end+'T12:00:00')-new Date(settings.trip_start+'T12:00:00'))/86400000)+1;}
  function renderCharts() {
    if (!window.Chart) return;
    api('/api/summary').then(data=>{
      $('#percent-value').textContent=`${new Intl.NumberFormat('es-CO',{maximumFractionDigits:1}).format(data.percent_used)} %`;
      $('#recommendation').textContent=data.remaining_days ? `Recomendado para ${data.remaining_days} ${data.remaining_days===1?'día':'días'} restantes: ${money(data.recommended_daily)} al día` : 'El viaje terminó; ya no quedan días.';
      $('#original-daily').textContent=`Presupuesto original por día: ${money(data.original_daily)}`;
      const pct=Math.min(100,Math.max(0,data.percent_used)); $('#progress-fill').style.width=`${pct}%`; $('#progress-fill').classList.toggle('over',data.remaining<0);
      $('.progress-track').setAttribute('aria-valuenow',String(Math.min(100,Math.max(0,data.percent_used))));
      $('#legend-spent').textContent=money(data.total_spent); $('#legend-remaining').textContent=money(data.remaining);
      $('#budget-warning').classList.toggle('hidden',!data.warning); $('#budget-warning').textContent=data.warning||'';
      $('#top-category').textContent=data.top_category ? `Mayor gasto: ${data.top_category}` : '';
      $('#category-empty').classList.toggle('hidden',!!data.categories.length); $('#daily-empty').classList.toggle('hidden',!data.total_spent);
      const catCtx=$('#category-chart').getContext('2d'), dailyCtx=$('#daily-chart').getContext('2d');
      if(categoryChart)categoryChart.destroy(); if(dailyChart)dailyChart.destroy();
      categoryChart=new Chart(catCtx,{type:'bar',data:{labels:data.categories.map(x=>x.name),datasets:[{data:data.categories.map(x=>x.amount),backgroundColor:'#3f9270',borderRadius:6,maxBarThickness:30}]},options:{indexAxis:'y',responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>money(c.raw)}}},scales:{x:{beginAtZero:true,grid:{color:'#edf1ee'},ticks:{callback:v=>money(v),font:{size:10},maxTicksLimit:5}},y:{grid:{display:false},ticks:{font:{size:11}}}}}});
      dailyChart=new Chart(dailyCtx,{type:'bar',data:{labels:data.daily.map(x=>dateLabel(x.date,{day:'2-digit',month:'short'})),datasets:[{data:data.daily.map(x=>x.amount),backgroundColor:'#6bad8d',borderRadius:5,maxBarThickness:28}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:c=>money(c.raw)}}},scales:{x:{grid:{display:false},ticks:{font:{size:9},maxRotation:0,autoSkip:true,maxTicksLimit:10}},y:{beginAtZero:true,grid:{color:'#edf1ee'},ticks:{callback:v=>money(v),font:{size:10},maxTicksLimit:5}}}}});
    }).catch(()=>{});
  }
  function renderSettings() {
    $('#setting-budget').value=settings.initial_budget; $('#setting-start').value=settings.trip_start; $('#setting-end').value=settings.trip_end;
    $('#category-settings-list').innerHTML=categories.map(c=>`<li><span>${escapeHtml(c.name)}</span><button type="button" data-rename="${c.id}" data-name="${escapeHtml(c.name)}">Cambiar nombre</button></li>`).join('');
  }
  function resetExpenseForm() { $('#expense-form').reset(); $('#expense-id').value=''; $('#expense-date').value=defaultDate(); $('#entry-title').textContent='Agregar un gasto'; $('#save-expense').textContent='Guardar gasto'; $('#cancel-edit').classList.add('hidden'); }
  function defaultDate() { const now=new Intl.DateTimeFormat('en-CA',{timeZone:settings.timezone||'America/Bogota',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()); return now>=settings.trip_start&&now<=settings.trip_end ? now : settings.trip_start; }
  $('#expense-form').addEventListener('submit',async event=>{
    event.preventDefault(); const id=$('#expense-id').value, payload={date:$('#expense-date').value,description:$('#expense-description').value,category_id:Number($('#expense-category').value),amount:$('#expense-amount').value};
    try { if(id) await api(`/api/expenses/${id}`,{method:'PUT',body:JSON.stringify(payload)}); else await api('/api/expenses',{method:'POST',body:JSON.stringify(payload)}); await loadAll(); resetExpenseForm(); feedback($('#expense-feedback'),id?'Gasto actualizado.':'Gasto guardado.'); toast(id?'Gasto actualizado':'Gasto guardado'); }
    catch(err){feedback($('#expense-feedback'),err.message,true);}
  });
  $('#cancel-edit').addEventListener('click',resetExpenseForm);
  $('#expense-list').addEventListener('click',async event=>{
    const edit=event.target.closest('[data-edit]'), del=event.target.closest('[data-delete]');
    if(edit){const item=expenses.find(x=>x.id===Number(edit.dataset.edit));if(!item)return;$('#expense-id').value=item.id;$('#expense-date').value=item.date;$('#expense-description').value=item.description;$('#expense-category').value=item.category_id;$('#expense-amount').value=item.amount;$('#entry-title').textContent='Editar gasto';$('#save-expense').textContent='Guardar cambios';$('#cancel-edit').classList.remove('hidden');$('#expense-date').focus();window.scrollTo({top:0,behavior:'smooth'});}
    if(del&&confirm('¿Quieres borrar este gasto? Esta acción no se puede deshacer.')){try{await api(`/api/expenses/${del.dataset.delete}`,{method:'DELETE'});await loadAll();toast('Gasto eliminado');}catch(err){toast(err.message);}}
  });
  $('#sort-order').addEventListener('change',renderExpenses);
  document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>{
    const summary=button.dataset.view==='summary';$('#expenses-view').classList.toggle('hidden',summary);$('#summary-view').classList.toggle('hidden',!summary);$('#view-title').textContent=summary?'Resumen del viaje':'Gastos del viaje';document.querySelectorAll('[data-view]').forEach(b=>b.classList.toggle('selected',b===button));
  }));
  document.querySelectorAll('.settings-open').forEach(button=>button.addEventListener('click',()=>$('#settings-dialog').showModal()));
  $('#settings-form').addEventListener('submit',async event=>{event.preventDefault();try{settings=await api('/api/settings',{method:'PUT',body:JSON.stringify({initial_budget:$('#setting-budget').value,trip_start:$('#setting-start').value,trip_end:$('#setting-end').value})});await loadAll();feedback($('#settings-feedback'),'Configuración guardada.');toast('Configuración guardada');}catch(err){feedback($('#settings-feedback'),err.message,true);}});
  $('#category-form').addEventListener('submit',async event=>{event.preventDefault();try{await api('/api/categories',{method:'POST',body:JSON.stringify({name:$('#new-category').value})});$('#new-category').value='';await loadAll();feedback($('#settings-feedback'),'Categoría agregada.');}catch(err){feedback($('#settings-feedback'),err.message,true);}});
  $('#category-settings-list').addEventListener('click',async event=>{const button=event.target.closest('[data-rename]');if(!button)return;const name=prompt('Nuevo nombre para la categoría:',button.dataset.name);if(name===null)return;try{await api(`/api/categories/${button.dataset.rename}`,{method:'PUT',body:JSON.stringify({name})});await loadAll();feedback($('#settings-feedback'),'Categoría actualizada.');}catch(err){feedback($('#settings-feedback'),err.message,true);}});
  loadAll().then(()=>{resetExpenseForm();}).catch(err=>toast(err.message));
})();
