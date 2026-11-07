(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const $ = (selector) => document.querySelector(selector);
  const nf0 = new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 });
  const nf2 = new Intl.NumberFormat('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const money = (value) => `${value < 0 ? '-$' : '$'}${nf0.format(Math.abs(Math.round(value)))}`;
  // Cifras cortas para ejes: $500 mil · $1,2 M
  const short = (value) => {
    const abs = Math.abs(value), sign = value < 0 ? '-' : '';
    if (abs >= 1e6) return `${sign}$${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(abs / 1e6)} M`;
    if (abs >= 1e3) return `${sign}$${nf0.format(abs / 1e3)} mil`;
    return `${sign}$${nf0.format(abs)}`;
  };
  const dateLabel = (iso, options = { day: '2-digit', month: 'short', year: 'numeric' }) =>
    new Intl.DateTimeFormat('es-CO', options).format(new Date(`${iso}T12:00:00`));
  const displayDate = (iso) => /^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}` : '';
  function parseDisplayDate(value) {
    const match = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(value.trim());
    if (!match) return null;
    const [, dayText, monthText, yearText] = match;
    const day = Number(dayText), month = Number(monthText), year = Number(yearText);
    const parsed = new Date(Date.UTC(year, month - 1, day));
    if (parsed.getUTCFullYear() !== year || parsed.getUTCMonth() !== month - 1 || parsed.getUTCDate() !== day) return null;
    return `${yearText}-${monthText}-${dayText}`;
  }
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const store = {
    get(key) { try { return JSON.parse(localStorage.getItem(key)); } catch (_) { return null; } },
    set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (_) { /* sin almacenamiento */ } },
    del(key) { try { localStorage.removeItem(key); } catch (_) { /* sin almacenamiento */ } },
  };

  let expenses = [], categories = [], settings = {}, summary = null;
  let categoryChart, dailyChart, toastTimer, saving = false, freshId = null, shownRemaining = null;
  let currentView = 'expenses';
  let entryCurrency = 'COP';

  async function api(path, options = {}) {
    const response = await fetch(path, {
      credentials: 'same-origin', ...options,
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...(options.headers || {}) },
    });
    let data = {};
    try { data = await response.json(); } catch (_) { /* La respuesta puede no ser JSON. */ }
    if (response.status === 401) {
      location.href = '/login';
      throw new Error('Inicia sesión de nuevo.');
    }
    if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud.');
    return data;
  }

  function toast(message, isError = false) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.toggle('error', isError);
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }

  function feedback(element, message, isError = false) {
    element.textContent = message;
    element.classList.toggle('error', isError);
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[character]));
  }

  async function loadAll() {
    const [settingsResponse, categoryResponse, expenseResponse, summaryResponse] = await Promise.all([
      api('/api/settings'), api('/api/categories'), api('/api/expenses'), api('/api/summary'),
    ]);
    settings = settingsResponse;
    categories = categoryResponse.categories;
    expenses = expenseResponse.expenses;
    summary = summaryResponse;
    renderCategories();
    renderExpenses();
    renderFinancials();
    renderSettings();
    refreshFx();
    if (currentView === 'summary') drawCharts();
  }

  function renderCategories() {
    const selected = $('#expense-category').value;
    $('#expense-category').innerHTML = '<option value="" selected>Elige…</option>' + categories
      .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
    if (categories.some((category) => String(category.id) === selected)) {
      $('#expense-category').value = selected;
    }
  }

  /* ---------- Historial ---------- */
  const iconEdit = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.1 2.1 0 0 0-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></svg>';
  const iconTrash = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 7h15M10 7V4.5h4V7M6.5 7l.8 12.5h9.4L17.5 7M10 11v5M14 11v5"/></svg>';

  function renderExpenses() {
    const root = $('#expense-list');
    const filterText = $('#expense-filter-text').value.trim();
    const chosenDate = parseDisplayDate(filterText);
    const ascending = $('#sort-order').value === 'asc';
    const filtered = expenses.filter((expense) => !chosenDate || expense.date === chosenDate);
    const sorted = [...filtered].sort((a, b) => ascending
      ? a.date.localeCompare(b.date) || a.id - b.id
      : b.date.localeCompare(a.date) || b.id - a.id);
    const count = expenses.length;
    $('#history-count').textContent = `${count} ${count === 1 ? 'movimiento' : 'movimientos'}`;
    $('#clear-date-filter').hidden = !filterText;

    if (filterText && !chosenDate) {
      $('#filter-status').textContent = 'Escribe una fecha válida: DD/MM/AAAA.';
    } else if (chosenDate) {
      const dayTotal = filtered.reduce((sum, item) => sum + item.amount, 0);
      const visibleText = filtered.length === 1 ? '1 gasto' : `${filtered.length} gastos`;
      $('#filter-status').textContent = `${visibleText} el ${dateLabel(chosenDate, { day: 'numeric', month: 'long' })} · total del día ${money(dayTotal)}. Tu presupuesto sigue contando todo el viaje.`;
    } else {
      $('#filter-status').textContent = count ? '' : 'Aquí aparecerán tus gastos cuando registres el primero.';
    }

    if (!sorted.length) {
      const message = chosenDate
        ? `No hay gastos para el ${dateLabel(chosenDate)}.`
        : 'Registra el primero en el formulario.';
      root.innerHTML = `<div class="empty-state"><strong>${chosenDate ? 'Sin gastos ese día' : 'Aún no hay gastos'}</strong>${message}</div>`;
      return;
    }

    root.innerHTML = sorted.map((expense) => {
      const note = expense.description.trim();
      const name = escapeHtml(note || expense.category);
      return `
        <article class="expense-row${expense.id === freshId ? ' fresh' : ''}">
          <span class="expense-date">${dateLabel(expense.date, { day: '2-digit', month: 'short' })}</span>
          <span class="expense-description${note ? '' : ' empty'}" title="${name}">${note ? name : 'Sin observación'}</span>
          <span class="expense-category">${escapeHtml(expense.category)}</span>
          <strong class="expense-amount">${money(expense.amount)}</strong>
          <span class="row-actions">
            <button class="icon-action" data-edit="${expense.id}" type="button" aria-label="Editar ${name}" title="Editar">${iconEdit}</button>
            <button class="icon-action delete" data-delete="${expense.id}" type="button" aria-label="Borrar ${name}" title="Borrar">${iconTrash}</button>
          </span>
        </article>`;
    }).join('');
    freshId = null;
  }

  /* ---------- Cifras principales ---------- */
  function animateNumber(element, from, to) {
    if (reducedMotion || from === null || from === to) { element.textContent = money(to); return; }
    const start = performance.now(), duration = 650;
    const tick = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      element.textContent = money(from + (to - from) * eased);
      if (t < 1) requestAnimationFrame(tick); else element.textContent = money(to);
    };
    requestAnimationFrame(tick);
  }

  const percentText = (value) => `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(value)} %`;

  function tripDays() {
    return Math.round((new Date(`${settings.trip_end}T12:00:00`) - new Date(`${settings.trip_start}T12:00:00`)) / 86400000) + 1;
  }

  function todayIso() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone || 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  function renderFinancials() {
    const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const remaining = settings.initial_budget - total;
    const over = remaining < 0;
    animateNumber($('#remaining-value'), shownRemaining, remaining);
    if (shownRemaining !== null && shownRemaining !== remaining && !reducedMotion) {
      const amount = $('#remaining-value');
      amount.classList.remove('bump'); void amount.offsetWidth; amount.classList.add('bump');
    }
    shownRemaining = remaining;
    $('#budget-value').textContent = money(settings.initial_budget);
    $('#spent-value').textContent = money(total);
    $('#balance-card').classList.toggle('over-budget', over);
    $('#remaining-note').textContent = over ? 'Presupuesto superado' : 'Disponible para el resto del viaje';
    const pct = settings.initial_budget ? (total / settings.initial_budget) * 100 : 0;
    $('#percent-hero').textContent = `${percentText(Math.round(pct * 10) / 10)} usado`;
    const bounded = Math.min(100, Math.max(0, pct));
    $('#hero-meter-fill').style.width = `${bounded}%`;
    $('#hero-meter-fill').classList.toggle('over', over);
    $('#hero-meter').setAttribute('aria-valuenow', String(Math.round(bounded)));

    // Saludo y fechas
    $('#greeting-sub').textContent = over ? 'Ya superaste tu presupuesto.' : total === 0 ? 'Aún no registras gastos.' : 'Así va tu presupuesto.';
    const today = todayIso();
    const dayIndex = today >= settings.trip_start && today <= settings.trip_end
      ? Math.round((new Date(`${today}T12:00:00`) - new Date(`${settings.trip_start}T12:00:00`)) / 86400000) + 1 : null;
    const range = `${dateLabel(settings.trip_start, { day: 'numeric', month: 'short' })} – ${dateLabel(settings.trip_end, { day: 'numeric', month: 'short', year: 'numeric' })}`;
    $('#trip-dates-text').textContent = range;
    $('#trip-day').textContent = dayIndex ? ` · día ${dayIndex} de ${tripDays()}` : '';

    if (summary) {
      $('#today-daily').textContent = money(summary.recommended_daily);
      $('#today-daily-note').textContent = summary.remaining_days ? `al día · ${summary.remaining_days} ${summary.remaining_days === 1 ? 'día' : 'días'}` : 'el viaje terminó';
      $('#days-left').textContent = String(summary.remaining_days);
      $('#days-left-note').textContent = `hasta el ${dateLabel(settings.trip_end, { day: 'numeric', month: 'short' })}`;
      renderMiniCategories();
      renderSummaryPanel();
    }
    renderRemainingEur();
  }

  // Agrupa categorías: máximo `max` barras; lo que sobra (y "Otros") se suma en "Otros".
  function groupCategories(list, max = 6) {
    const isOtros = (item) => item.name.trim().toLowerCase() === 'otros';
    const main = list.filter((item) => !isOtros(item)).sort((a, b) => b.amount - a.amount);
    const otros = list.filter(isOtros);
    if (main.length + (otros.length ? 1 : 0) <= max) return [...main, ...otros.map((item) => ({ ...item, name: 'Otros' }))];
    const keep = main.slice(0, max - 1), rest = [...main.slice(max - 1), ...otros];
    return [...keep, { name: 'Otros', amount: rest.reduce((sum, item) => sum + item.amount, 0), includes: rest.filter((item) => !isOtros(item)).map((item) => item.name) }];
  }

  function renderMiniCategories() {
    const root = $('#mini-cats');
    const list = groupCategories(summary.categories, 6);
    if (!list.length) { root.innerHTML = '<p class="mini-empty">Cuando registres gastos, aquí verás las categorías con más gasto.</p>'; return; }
    const max = Math.max(...list.map((item) => item.amount));
    root.innerHTML = list.map((item) => `
      <div class="mini-cat"><span class="mini-cat-name">${escapeHtml(item.name)}</span><span class="mini-cat-amount">${money(item.amount)}</span>
      <span class="mini-cat-bar" aria-hidden="true"><span style="width:${Math.max(3, (item.amount / max) * 100)}%"></span></span></div>`).join('');
  }

  function renderSummaryPanel() {
    const data = summary;
    $('#kpi-remaining').textContent = money(data.remaining);
    $('#kpi-remaining').closest('.kpi').classList.toggle('negative', data.remaining < 0);
    $('#kpi-spent').textContent = money(data.total_spent);
    $('#kpi-daily').textContent = data.warning ? '$0' : money(data.recommended_daily);
    $('#recommendation').textContent = data.warning
      ? 'Presupuesto agotado.'
      : data.remaining_days ? `durante ${data.remaining_days} ${data.remaining_days === 1 ? 'día' : 'días'} restantes` : 'El viaje ya terminó.';
    const top = data.categories[0];
    $('#kpi-top').textContent = top ? top.name : 'Sin gastos';
    $('#kpi-top-amount').textContent = top ? `${money(top.amount)} · ${percentText(Math.round(top.amount / data.total_spent * 1000) / 10)}` : 'Aún sin gastos';
    $('#percent-value').textContent = percentText(data.percent_used);
    const progress = Math.min(100, Math.max(0, data.percent_used));
    $('#progress-fill').style.width = `${progress}%`;
    $('#progress-fill').classList.toggle('over', data.remaining < 0);
    $('#summary-meter').setAttribute('aria-valuenow', String(Math.round(progress)));
    $('#legend-spent').textContent = money(data.total_spent);
    $('#legend-remaining').textContent = money(data.remaining);
    $('#plan-daily').textContent = money(data.original_daily);
    $('#budget-warning').classList.toggle('hidden', !data.warning);
    $('#budget-warning').textContent = data.warning || '';
  }

  /* ---------- Gráficos ---------- */
  const tooltipStyle = {
    backgroundColor: '#2a2060', titleColor: '#ffffff', bodyColor: '#e9e6ff', padding: 11, cornerRadius: 10,
    titleFont: { weight: '700', size: 13 }, bodyFont: { size: 13 }, boxPadding: 4, caretSize: 6, displayColors: false,
  };

  const amountLabels = {
    id: 'amountLabels',
    afterDatasetsDraw(chart, _args, opts) {
      const meta = chart.getDatasetMeta(0);
      const dataset = chart.data.datasets[0];
      if (!dataset || meta.hidden) return;
      const ctx = chart.ctx;
      ctx.save();
      ctx.textBaseline = 'middle';
      meta.data.forEach((bar, index) => {
        const value = dataset.data[index];
        const pct = opts.total ? Math.round((value / opts.total) * 100) : 0;
        const amountText = money(value), pctText = `  ${pct}%`;
        ctx.font = '700 12px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
        const w1 = ctx.measureText(amountText).width;
        ctx.font = '600 12px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
        const w2 = ctx.measureText(pctText).width;
        const inside = bar.x - bar.base > w1 + w2 + 22;
        const x = inside ? bar.x - 10 - (w1 + w2) : bar.x + 8;
        ctx.textAlign = 'left';
        ctx.fillStyle = inside ? '#ffffff' : '#281d73';
        ctx.font = '700 12px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
        ctx.fillText(amountText, x, bar.y);
        ctx.fillStyle = inside ? 'rgba(255,255,255,.85)' : '#5f5a80';
        ctx.font = '600 12px "Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
        ctx.fillText(pctText, x + w1, bar.y);
      });
      ctx.restore();
    },
  };

  function drawCharts() {
    if (!window.Chart || !summary) return;
    const data = summary;
    Chart.defaults.font.family = '"Segoe UI Variable Text","Segoe UI",system-ui,sans-serif';
    Chart.defaults.color = '#5f5a80';
    if (categoryChart) categoryChart.destroy();
    if (dailyChart) dailyChart.destroy();
    categoryChart = dailyChart = null;
    const categoryCanvas = $('#category-chart'), dailyCanvas = $('#daily-chart');
    const hasData = data.total_spent > 0 && data.categories.length > 0;
    $('#category-empty').classList.toggle('hidden', hasData);
    $('#daily-empty').classList.toggle('hidden', hasData);
    categoryCanvas.hidden = dailyCanvas.hidden = !hasData;
    if (!hasData) return;

    const animation = reducedMotion ? false : { duration: 700, easing: 'easeOutCubic' };
    const total = data.total_spent;
    const cats = groupCategories(data.categories, 6);
    const topIndex = cats.reduce((best, item, index) => item.amount > cats[best].amount ? index : best, 0);
    categoryChart = new Chart(categoryCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: cats.map((item) => item.name),
        datasets: [{
          data: cats.map((item) => item.amount),
          backgroundColor: cats.map((_, index) => index === topIndex ? '#c0572d' : '#ebae8c'),
          hoverBackgroundColor: cats.map((_, index) => index === topIndex ? '#a24520' : '#e0976f'),
          borderRadius: 7, borderSkipped: false, maxBarThickness: 30, categoryPercentage: .82, barPercentage: .92,
        }],
      },
      plugins: [amountLabels],
      options: {
        indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation,
        layout: { padding: { right: 8 } },
        plugins: {
          legend: { display: false }, amountLabels: { total },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => items[0].label,
              label: (item) => `${money(item.raw)} · ${Math.round(item.raw / total * 100)} % del gasto`,
              afterLabel: (item) => cats[item.dataIndex].includes && cats[item.dataIndex].includes.length ? `Incluye: ${cats[item.dataIndex].includes.join(', ')}` : '',
            },
          },
        },
        scales: {
          x: { beginAtZero: true, grace: '4%', grid: { color: 'rgba(95, 90, 128, .12)' }, border: { display: false }, ticks: { callback: (value) => short(value), maxTicksLimit: 4, font: { size: 12 } } },
          y: { grid: { display: false }, border: { display: false }, ticks: { color: '#281d73', font: { size: 13, weight: '600' } } },
        },
      },
    });

    const plan = data.original_daily;
    const planLine = {
      id: 'planLine',
      afterDatasetsDraw(chart) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea || plan > scales.y.max) return;
        const y = scales.y.getPixelForValue(plan);
        ctx.save();
        ctx.beginPath(); ctx.setLineDash([6, 5]); ctx.lineWidth = 2; ctx.strokeStyle = '#a8731f';
        ctx.moveTo(chartArea.left, y); ctx.lineTo(chartArea.right, y); ctx.stroke();
        ctx.restore();
      },
    };
    dailyChart = new Chart(dailyCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: data.daily.map((item) => dateLabel(item.date, { day: 'numeric', month: 'short' })),
        datasets: [{
          label: 'Gasto del día', data: data.daily.map((item) => item.amount),
          backgroundColor: data.daily.map((item) => item.amount > plan ? '#c0572d' : '#9381ff'),
          hoverBackgroundColor: data.daily.map((item) => item.amount > plan ? '#a24520' : '#6f5cf0'),
          borderRadius: 7, borderSkipped: false, maxBarThickness: 40, categoryPercentage: .78, barPercentage: .9,
        }],
      },
      plugins: [planLine],
      options: {
        responsive: true, maintainAspectRatio: false, animation,
        plugins: {
          legend: { display: false },
          tooltip: {
            ...tooltipStyle,
            callbacks: {
              title: (items) => dateLabel(data.daily[items[0].dataIndex].date, { weekday: 'long', day: 'numeric', month: 'long' }),
              label: (item) => `Gastado: ${money(item.raw)}`,
              afterLabel: (item) => {
                const diff = item.raw - plan;
                return [`Plan diario: ${money(plan)}`, diff > 0 ? `${money(diff)} por encima del plan` : diff < 0 ? `${money(-diff)} por debajo del plan` : 'Justo en el plan'];
              },
            },
          },
        },
        scales: {
          x: { grid: { display: false }, border: { display: false }, ticks: { color: '#5f5a80', font: { size: 12 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
          y: { beginAtZero: true, suggestedMax: plan * 1.15, grid: { color: 'rgba(95, 90, 128, .12)' }, border: { display: false }, ticks: { callback: (value) => short(value), maxTicksLimit: 5, font: { size: 12 } } },
        },
      },
    });
  }

  /* ---------- Configuración ---------- */
  function renderSettings() {
    $('#setting-budget').value = settings.initial_budget;
    $('#setting-start').value = settings.trip_start;
    $('#setting-end').value = settings.trip_end;
    $('#category-settings-list').innerHTML = categories.map((category) => `
      <li><span>${escapeHtml(category.name)}</span></li>`).join('');
  }

  /* ---------- Formulario ---------- */
  function defaultDate() {
    const today = todayIso();
    return today >= settings.trip_start && today <= settings.trip_end ? today : settings.trip_start;
  }

  function clearInvalid() {
    document.querySelectorAll('#expense-form .field.invalid').forEach((field) => field.classList.remove('invalid'));
    document.querySelectorAll('#expense-form [aria-invalid]').forEach((input) => input.removeAttribute('aria-invalid'));
  }

  function markInvalid(input, message) {
    clearInvalid();
    input.closest('.field').classList.add('invalid');
    input.setAttribute('aria-invalid', 'true');
    feedback($('#expense-feedback'), message, true);
    input.focus();
  }

  function setSaveLabel(text, symbol) {
    $('#save-expense .save-label').textContent = text;
    if (symbol) $('#save-expense .save-symbol').textContent = symbol;
  }

  function resetExpenseForm() {
    $('#expense-form').reset();
    $('#expense-id').value = '';
    clearInvalid();
    setExpenseDate(defaultDate());
    $('#entry-title').textContent = 'Agregar un gasto';
    setSaveLabel('Guardar gasto', '＋');
    $('#cancel-edit').classList.add('hidden');
    updateAmountHint();
  }

  function setExpenseDate(iso) {
    $('#expense-date-picker').value = iso;
    $('#expense-date-text').value = displayDate(iso);
    $('#expense-date-text').setCustomValidity('');
  }

  function openDatePicker(selector) {
    const picker = $(selector);
    if (typeof picker.showPicker === 'function') picker.showPicker();
    else { picker.focus(); picker.click(); }
  }

  function setEntryCurrency(currency) {
    entryCurrency = currency;
    const euros = currency === 'EUR';
    const toggle = $('#currency-switch');
    toggle.dataset.currency = currency;
    toggle.setAttribute('aria-label', euros
      ? 'Moneda del valor: euros. Toca para cambiar a pesos colombianos.'
      : 'Moneda del valor: pesos colombianos. Toca para cambiar a euros.');
    $('#currency-code').textContent = currency;
    $('.amount-field').classList.toggle('eur', euros);
    $('#amount-label').textContent = euros ? 'Valor en euros' : 'Valor en pesos';
    const input = $('#expense-amount');
    input.type = euros ? 'text' : 'number';
    input.setAttribute('inputmode', euros ? 'decimal' : 'numeric');
    input.placeholder = euros ? '12,50' : '125000';
    clearInvalid();
    updateAmountHint();
  }

  // Valor del campo en pesos enteros; null si está vacío o es inválido, o si falta la tasa.
  function enteredPesos() {
    const raw = $('#expense-amount').value.trim();
    if (entryCurrency === 'COP') return /^[0-9]{1,12}$/.test(raw) && Number(raw) >= 1 ? Number(raw) : null;
    const euros = parseNumber(raw);
    if (!Number.isFinite(euros) || euros <= 0 || !fx.active) return null;
    const pesos = Math.round(euros * fx.active.rate);
    return pesos >= 1 && pesos <= 999999999999 ? pesos : null;
  }

  function updateAmountHint() {
    const hint = $('#amount-hint');
    const raw = $('#expense-amount').value.trim();
    if (entryCurrency === 'EUR') {
      if (!fx.active) { hint.textContent = 'No hay tasa de cambio. Escríbela en el conversor o elige COP.'; return; }
      const pesos = enteredPesos();
      hint.textContent = pesos
        ? `${nf2.format(parseNumber(raw))} EUR ≈ ${money(pesos)} COP · tasa ${nf2.format(fx.active.rate)}`
        : 'Escribe el valor en euros. Se guardará en pesos con la tasa del conversor.';
      return;
    }
    const value = Number(raw);
    if (!value || value < 1) { hint.textContent = 'Elige la categoría y el valor. La observación es opcional (ej. desayuno).'; return; }
    const eur = fx.active ? ` · ≈ ${nf2.format(value / fx.active.rate)} EUR` : '';
    hint.textContent = `${money(value)} COP${eur}`;
  }

  $('#expense-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const id = $('#expense-id').value;
    const saveButton = $('#save-expense');
    clearInvalid();
    feedback($('#expense-feedback'), '');
    const expenseDate = parseDisplayDate($('#expense-date-text').value);
    if (!expenseDate) return markInvalid($('#expense-date-text'), 'Escribe una fecha real, con el formato DD/MM/AAAA.');
    if (!$('#expense-category').value) return markInvalid($('#expense-category'), 'Elige una categoría para el gasto.');
    const euros = entryCurrency === 'EUR';
    if (euros && !fx.active) {
      return markInvalid($('#expense-amount'), 'No hay tasa de cambio. Escríbela en el conversor o elige COP.');
    }
    const pesos = enteredPesos();
    if (!pesos) {
      return markInvalid($('#expense-amount'), euros
        ? 'Escribe el valor en euros, por ejemplo 12,50.'
        : 'Escribe el valor en pesos: un número entero mayor que cero, sin puntos ni comas.');
    }
    const amountText = String(pesos);
    const enteredEuros = euros ? parseNumber($('#expense-amount').value) : null;
    const formData = {
      date: expenseDate,
      description: $('#expense-description').value,
      category_id: Number($('#expense-category').value),
      amount: amountText,
    };
    saving = true;
    saveButton.disabled = true;
    setSaveLabel('Guardando…');
    try {
      let result;
      if (id) result = await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(formData) });
      else result = await api('/api/expenses', { method: 'POST', body: JSON.stringify(formData) });
      freshId = id ? Number(id) : result.id;
      await loadAll();
      resetExpenseForm();
      feedback($('#expense-feedback'), id ? 'Gasto actualizado.' : 'Gasto guardado.');
      const base = id ? 'Gasto actualizado' : 'Gasto guardado';
      toast(euros ? `${base}: ${nf2.format(enteredEuros)} EUR = ${money(pesos)}` : base);
      saveButton.classList.add('saved');
      setSaveLabel('¡Guardado!', '✓');
      setTimeout(() => {
        saveButton.classList.remove('saved');
        if (!$('#expense-id').value) setSaveLabel('Guardar gasto', '＋');
      }, 1400);
      $('#expense-description').focus({ preventScroll: true });
    } catch (error) {
      feedback($('#expense-feedback'), error.message, true);
      setSaveLabel(id ? 'Guardar cambios' : 'Guardar gasto');
    } finally {
      saving = false;
      saveButton.disabled = false;
    }
  });

  $('#expense-amount').addEventListener('input', () => { clearInvalid(); updateAmountHint(); });
  $('#currency-switch').addEventListener('click', () => { setEntryCurrency(entryCurrency === 'COP' ? 'EUR' : 'COP'); $('#expense-amount').focus(); });
  ['#expense-description', '#expense-category', '#expense-date-text'].forEach((selector) => $(selector).addEventListener('input', clearInvalid));
  $('#cancel-edit').addEventListener('click', () => { resetExpenseForm(); feedback($('#expense-feedback'), ''); });
  $('#expense-list').addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit]');
    const deleteButton = event.target.closest('[data-delete]');
    if (editButton) {
      const expense = expenses.find((item) => item.id === Number(editButton.dataset.edit));
      if (!expense) return;
      clearInvalid();
      $('#expense-id').value = expense.id;
      setExpenseDate(expense.date);
      $('#expense-description').value = expense.description;
      $('#expense-category').value = expense.category_id;
      setEntryCurrency('COP');
      $('#expense-amount').value = expense.amount;
      $('#entry-title').textContent = 'Editar gasto';
      setSaveLabel('Guardar cambios', '✓');
      $('#cancel-edit').classList.remove('hidden');
      updateAmountHint();
      feedback($('#expense-feedback'), '');
      $('#expense-form').scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
      $('#expense-amount').focus({ preventScroll: true });
    }
    if (deleteButton && confirm('¿Quieres borrar este gasto? Esta acción no se puede deshacer.')) {
      try {
        await api(`/api/expenses/${deleteButton.dataset.delete}`, { method: 'DELETE' });
        if ($('#expense-id').value === deleteButton.dataset.delete) resetExpenseForm();
        await loadAll();
        toast('Gasto eliminado');
      } catch (error) {
        toast(error.message, true);
      }
    }
  });

  $('#expense-date-text').addEventListener('input', () => $('#expense-date-text').setCustomValidity(''));
  $('#open-expense-date').addEventListener('click', () => openDatePicker('#expense-date-picker'));
  $('#expense-date-picker').addEventListener('change', () => { if ($('#expense-date-picker').value) setExpenseDate($('#expense-date-picker').value); });
  $('#expense-filter-text').addEventListener('input', renderExpenses);
  $('#open-filter-date').addEventListener('click', () => openDatePicker('#expense-filter-picker'));
  $('#expense-filter-picker').addEventListener('change', () => {
    $('#expense-filter-text').value = displayDate($('#expense-filter-picker').value);
    renderExpenses();
  });
  $('#clear-date-filter').addEventListener('click', () => {
    $('#expense-filter-text').value = '';
    $('#expense-filter-picker').value = '';
    renderExpenses();
  });
  $('#sort-order').addEventListener('change', renderExpenses);
  $('#history-details').addEventListener('toggle', () => {
    const open = $('#history-details').open;
    $('#history-toggle-label').textContent = open ? 'Ocultar' : 'Ver gastos';
    if (open) setTimeout(() => $('#history-details').scrollIntoView({ block: 'end', behavior: reducedMotion ? 'auto' : 'smooth' }), 60);
  });

  /* ---------- Vistas ---------- */
  function showView(name) {
    const isSummary = name === 'summary';
    currentView = name;
    $('#expenses-view').classList.toggle('hidden', isSummary);
    $('#summary-view').classList.toggle('hidden', !isSummary);
    document.querySelectorAll('.nav-link').forEach((item) => {
      const selected = item.dataset.view === name;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    if (isSummary) requestAnimationFrame(drawCharts);
  }
  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => showView(button.dataset.view)));

  document.querySelectorAll('.settings-open').forEach((button) => button.addEventListener('click', () => $('#settings-dialog').showModal()));
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      settings = await api('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({ initial_budget: $('#setting-budget').value, trip_start: $('#setting-start').value, trip_end: $('#setting-end').value }),
      });
      await loadAll();
      feedback($('#settings-feedback'), 'Configuración guardada.');
      toast('Configuración guardada');
    } catch (error) {
      feedback($('#settings-feedback'), error.message, true);
    }
  });

  /* ============================================================
     Conversor EUR ⇄ COP — informativo. Vive solo en el navegador:
     no toca la base de datos ni los cálculos del presupuesto.
     ============================================================ */
  const FX_KEY = 'fx-eurcop-v1';
  const fx = { live: null, manual: null, active: null, direction: 'eur-cop', liveFailed: false };
  const saved = store.get(FX_KEY) || {};
  if (saved.live && saved.live.rate > 0 && saved.live.ts) fx.live = { ...saved.live, fromCache: true };
  if (saved.manual && saved.manual.rate > 0 && saved.manual.ts) fx.manual = saved.manual;
  if (saved.direction === 'cop-eur') fx.direction = 'cop-eur';

  // Acepta "3638,91", "3.638,91", "3638.91", "1.250" (miles) y "50".
  function parseNumber(text) {
    let value = String(text).replace(/[\s$€]/g, '');
    if (!value || !/^[0-9.,]+$/.test(value)) return NaN;
    const commas = (value.match(/,/g) || []).length, dots = (value.match(/\./g) || []).length;
    if (commas && dots) {
      const decimalSeparator = value.lastIndexOf(',') > value.lastIndexOf('.') ? ',' : '.';
      const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
      value = value.split(thousandsSeparator).join('').replace(decimalSeparator, '.');
    } else if (commas) {
      if (commas > 1) return NaN;
      value = value.replace(',', '.');
    } else if (dots) {
      const after = value.split('.').pop();
      if (dots > 1 || after.length === 3) value = value.replace(/\./g, '');
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : NaN;
  }

  const fxStamp = (iso) => new Intl.DateTimeFormat('es-CO', {
    day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit',
    timeZone: settings.timezone || 'America/Bogota',
  }).format(new Date(iso));

  function setBadge(text, kind) {
    const badge = $('#fx-badge');
    badge.textContent = text;
    badge.className = `fx-badge ${kind}`;
  }

  function refreshFx() {
    fx.active = fx.manual ? { rate: fx.manual.rate, kind: 'manual' } : fx.live ? { rate: fx.live.rate, kind: fx.live.fromCache ? 'cached' : 'live' } : null;
    const meta = $('#fx-meta');
    meta.classList.remove('warn');
    $('#fx-live').hidden = !(fx.manual && fx.live);
    if (document.activeElement !== $('#fx-rate')) $('#fx-rate').value = fx.active ? nf2.format(fx.active.rate) : '';
    $('#fx-rate').setAttribute('placeholder', 'Ej. 3.600');
    if (!fx.active) {
      setBadge('Sin tasa', 'none');
      meta.textContent = 'No pudimos obtener la tasa. Escribe una tasa de cambio para poder convertir.';
      meta.classList.add('warn');
    } else if (fx.active.kind === 'manual') {
      setBadge('Tasa manual', 'manual');
      meta.textContent = `Tasa escrita por ti el ${fxStamp(fx.manual.ts).replace(/\.$/, '')}.${fx.live ? ` En vivo: 1 EUR ≈ ${nf2.format(fx.live.rate)} COP.` : ''}`;
    } else if (fx.active.kind === 'cached') {
      setBadge('Guardada · puede estar desactualizada', 'stale');
      meta.textContent = `No hay conexión con la fuente. Última tasa guardada: ${fxStamp(fx.live.ts).replace(/\.$/, '')} (${fx.live.source}).`;
      meta.classList.add('warn');
    } else {
      setBadge('En vivo', 'live');
      meta.textContent = `Fuente: ${fx.live.source} · actualizada ${fxStamp(fx.live.ts).replace(/\.$/, '')}.`;
    }
    renderConverter();
    renderRemainingEur();
    updateAmountHint();
  }

  function renderConverter() {
    const eurToCop = fx.direction === 'eur-cop';
    $('#fx-in-code').textContent = eurToCop ? 'EUR' : 'COP';
    $('#fx-out-code').textContent = eurToCop ? 'COP' : 'EUR';
    $('#fx-in-label').textContent = eurToCop ? 'Cantidad en euros' : 'Cantidad en pesos colombianos';
    const amount = parseNumber($('#fx-amount').value);
    const out = $('#fx-result');
    if (!fx.active || !Number.isFinite(amount) || amount < 0 || amount > 1e12) { out.textContent = '—'; out.dataset.value = ''; return; }
    const result = eurToCop ? amount * fx.active.rate : amount / fx.active.rate;
    out.dataset.value = String(result);
    out.textContent = eurToCop ? nf0.format(Math.round(result)) : nf2.format(result);
  }

  function renderRemainingEur() {
    const element = $('#remaining-eur');
    if (!fx.active || shownRemaining === null) { element.hidden = true; return; }
    element.hidden = false;
    element.textContent = `≈ ${nf0.format(Math.round(shownRemaining / fx.active.rate))} EUR`;
  }

  async function fetchLiveRate() {
    try {
      const data = await api('/api/fx');
      if (!(data.rate > 0) || !data.updated) throw new Error('Tasa inválida');
      fx.live = { rate: data.rate, ts: data.updated, source: data.source };
      store.set(FX_KEY, { ...(store.get(FX_KEY) || {}), live: fx.live });
    } catch (_) {
      fx.liveFailed = true;
    }
    refreshFx();
  }

  $('#fx-amount').addEventListener('input', renderConverter);
  $('#fx-amount').addEventListener('focus', (event) => event.target.select());
  $('#fx-swap').addEventListener('click', () => {
    const previous = Number($('#fx-result').dataset.value);
    fx.direction = fx.direction === 'eur-cop' ? 'cop-eur' : 'eur-cop';
    store.set(FX_KEY, { ...(store.get(FX_KEY) || {}), direction: fx.direction });
    if (Number.isFinite(previous) && previous > 0) {
      $('#fx-amount').value = fx.direction === 'cop-eur' ? String(Math.round(previous)) : String(Math.round(previous * 100) / 100).replace('.', ',');
    }
    const button = $('#fx-swap');
    button.classList.toggle('turn');
    renderConverter();
  });
  $('#fx-rate').addEventListener('input', () => {
    const rate = parseNumber($('#fx-rate').value);
    const valid = Number.isFinite(rate) && rate >= 1 && rate <= 1e6;
    $('#fx-rate').setAttribute('aria-invalid', valid ? 'false' : 'true');
    if (!valid) { $('#fx-meta').textContent = 'Escribe una tasa válida: cuántos pesos vale 1 euro.'; $('#fx-meta').classList.add('warn'); return; }
    fx.manual = { rate, ts: new Date().toISOString() };
    store.set(FX_KEY, { ...(store.get(FX_KEY) || {}), manual: fx.manual });
    refreshFx();
  });
  $('#fx-rate').addEventListener('blur', refreshFx);
  $('#fx-live').addEventListener('click', () => {
    fx.manual = null;
    const current = store.get(FX_KEY) || {};
    delete current.manual;
    store.set(FX_KEY, current);
    refreshFx();
    toast('Usando la tasa en vivo');
  });

  loadAll().then(() => {
    resetExpenseForm(); fetchLiveRate();
    // En pantallas amplias y altas sobra espacio: el historial arranca abierto.
    if (innerWidth >= 1280 && innerHeight >= 800) $('#history-details').open = true;
  }).catch((error) => toast(error.message, true));
})();
