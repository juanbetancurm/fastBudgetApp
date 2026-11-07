(() => {
  const csrf = document.querySelector('meta[name="csrf-token"]').content;
  const $ = (selector) => document.querySelector(selector);
  const money = (value) => `${value < 0 ? '-$' : '$'}${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 0 }).format(Math.abs(value))}`;
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
  let expenses = [], categories = [], settings = {}, categoryChart, dailyChart, toastTimer, saving = false;

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

  function toast(message) {
    const element = $('#toast');
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2400);
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
    const [summary, categoryResponse, expenseResponse] = await Promise.all([
      api('/api/settings'), api('/api/categories'), api('/api/expenses'),
    ]);
    settings = summary;
    categories = categoryResponse.categories;
    expenses = expenseResponse.expenses;
    renderCategories();
    renderExpenses();
    renderFinancials();
    renderSettings();
  }

  function renderCategories() {
    const selected = $('#expense-category').value;
    $('#expense-category').innerHTML = categories
      .map((category) => `<option value="${category.id}">${escapeHtml(category.name)}</option>`).join('');
    if (categories.some((category) => String(category.id) === selected)) {
      $('#expense-category').value = selected;
    }
  }

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
    $('#history-count').textContent = `${count} ${count === 1 ? 'registro' : 'registros'}`;
    $('#clear-date-filter').hidden = !filterText;

    if (filterText && !chosenDate) {
      $('#filter-status').textContent = 'Escribe una fecha válida en formato DD/MM/AAAA.';
    } else if (chosenDate) {
      const visibleCount = filtered.length;
      const visibleText = visibleCount === 1 ? '1 gasto' : `${visibleCount} gastos`;
      $('#filter-status').textContent = `${visibleText} del ${dateLabel(chosenDate)} · los totales de arriba incluyen todo el viaje.`;
    } else {
      $('#filter-status').textContent = count
        ? 'Tus totales siempre incluyen todos los gastos.'
        : 'Aquí aparecerán tus gastos cuando registres el primero.';
    }

    if (!sorted.length) {
      const message = chosenDate
        ? `No hay gastos para el ${dateLabel(chosenDate)}.`
        : 'Registra el primero en el formulario de arriba.';
      root.innerHTML = `<div class="empty-state"><strong>${chosenDate ? 'Sin gastos ese día' : 'Aún no hay gastos'}</strong>${message}</div>`;
      return;
    }

    const groups = new Map();
    sorted.forEach((expense) => {
      if (!groups.has(expense.date)) groups.set(expense.date, []);
      groups.get(expense.date).push(expense);
    });
    root.innerHTML = [...groups.entries()].map(([day, items]) => `
      <section class="expense-day" aria-label="Gastos del ${dateLabel(day)}">
        <div class="day-heading"><span>${dateLabel(day, { weekday: 'short', day: '2-digit', month: 'long' })}</span><strong>Total del día · ${money(items.reduce((sum, item) => sum + item.amount, 0))}</strong></div>
        ${items.map((expense) => `
          <article class="expense-row">
            <span class="expense-date">${dateLabel(expense.date)}</span>
            <span class="expense-description">${escapeHtml(expense.description || 'Gasto')}</span>
            <span class="expense-category">${escapeHtml(expense.category)}</span>
            <strong class="expense-amount">${money(expense.amount)}</strong>
            <span class="row-actions">
              <button class="text-action" data-edit="${expense.id}" type="button" aria-label="Editar ${escapeHtml(expense.description || 'gasto')}">Editar</button>
              <button class="text-action delete" data-delete="${expense.id}" type="button" aria-label="Borrar ${escapeHtml(expense.description || 'gasto')}">Borrar</button>
            </span>
          </article>`).join('')}
      </section>`).join('');
  }

  function renderFinancials() {
    const total = expenses.reduce((sum, expense) => sum + expense.amount, 0);
    const remaining = settings.initial_budget - total;
    $('#budget-value').textContent = money(settings.initial_budget);
    $('#spent-value').textContent = money(total);
    $('#remaining-value').textContent = money(remaining);
    $('.budget-strip').classList.toggle('over-budget', remaining < 0);
    $('#trip-length').textContent = `${tripDays()} ${tripDays() === 1 ? 'día' : 'días'} de viaje`;
    $('#spent-note').textContent = `${expenses.length} ${expenses.length === 1 ? 'gasto registrado' : 'gastos registrados'}`;
    $('#remaining-note').textContent = remaining < 0 ? 'Presupuesto superado' : 'Disponible para el resto del viaje';
    $('#trip-dates').textContent = `${dateLabel(settings.trip_start, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()} — ${dateLabel(settings.trip_end, { day: 'numeric', month: 'short', year: 'numeric' }).toUpperCase()}`;
    renderCharts();
  }

  function tripDays() {
    return Math.round((new Date(`${settings.trip_end}T12:00:00`) - new Date(`${settings.trip_start}T12:00:00`)) / 86400000) + 1;
  }

  const amountLabels = {
    id: 'amountLabels',
    afterDatasetsDraw(chart) {
      const dataset = chart.data.datasets[0];
      if (!dataset || chart.getDatasetMeta(0).hidden) return;
      const context = chart.ctx;
      const points = chart.getDatasetMeta(0).data;
      context.save();
      context.font = '600 11px system-ui, sans-serif';
      context.textBaseline = 'middle';
      points.forEach((point, index) => {
        const label = money(dataset.data[index]);
        const width = context.measureText(label).width;
        const right = chart.chartArea.right + 58;
        const fitsOutside = point.x + width + 9 <= right;
        context.textAlign = fitsOutside ? 'left' : 'right';
        context.fillStyle = '#51665d';
        context.fillText(label, fitsOutside ? point.x + 8 : point.x - 8, point.y);
      });
      context.restore();
    },
  };

  function renderCharts() {
    if (!window.Chart) return;
    api('/api/summary').then((data) => {
      $('#percent-value').textContent = `${new Intl.NumberFormat('es-CO', { maximumFractionDigits: 1 }).format(data.percent_used)} %`;
      $('#recommendation').textContent = data.warning
        ? 'Presupuesto agotado: no hay más gasto recomendado.'
        : data.remaining_days
          ? `Puedes gastar ${money(data.recommended_daily)} al día durante ${data.remaining_days} ${data.remaining_days === 1 ? 'día' : 'días'}.`
          : 'El viaje terminó; ya no quedan días.';
      $('#original-daily').textContent = `Referencia inicial: ${money(data.original_daily)} al día`;
      const progress = Math.min(100, Math.max(0, data.percent_used));
      $('#progress-fill').style.width = `${progress}%`;
      $('#progress-fill').classList.toggle('over', data.remaining < 0);
      $('.progress-track').setAttribute('aria-valuenow', String(progress));
      $('#legend-spent').textContent = money(data.total_spent);
      $('#legend-remaining').textContent = money(data.remaining);
      $('#budget-warning').classList.toggle('hidden', !data.warning);
      $('#budget-warning').textContent = data.warning || '';
      const top = data.categories[0];
      $('#top-category').hidden = !top;
      $('#top-category').textContent = top ? `Mayor gasto · ${top.name} · ${money(top.amount)}` : '';
      $('#category-empty').classList.toggle('hidden', data.categories.length > 0);
      $('#daily-empty').classList.toggle('hidden', data.total_spent > 0);

      if (categoryChart) categoryChart.destroy();
      if (dailyChart) dailyChart.destroy();
      const categoryCanvas = $('#category-chart');
      const dailyCanvas = $('#daily-chart');
      categoryCanvas.hidden = data.categories.length === 0;
      dailyCanvas.hidden = data.total_spent === 0;
      if (!data.categories.length || data.total_spent === 0) return;

      const animation = reducedMotion ? false : { duration: 180 };
      categoryChart = new Chart(categoryCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: data.categories.map((item) => item.name),
          datasets: [{
            data: data.categories.map((item) => item.amount),
            backgroundColor: data.categories.map((_, index) => index === 0 ? '#246c54' : '#a9c4b5'),
            borderRadius: 5, borderSkipped: false, maxBarThickness: 27,
          }],
        },
        plugins: [amountLabels],
        options: {
          indexAxis: 'y', responsive: true, maintainAspectRatio: false, animation,
          layout: { padding: { right: 62 } },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (item) => ` ${money(item.raw)}` } },
          },
          scales: {
            x: { beginAtZero: true, grace: '18%', grid: { color: '#e9eee9' }, border: { display: false }, ticks: { callback: (value) => money(value), maxTicksLimit: 4, font: { size: 10 } } },
            y: { grid: { display: false }, border: { display: false }, ticks: { color: '#43564d', font: { size: 11, weight: '500' } } },
          },
        },
      });

      const reference = Array(data.daily.length).fill(data.original_daily);
      dailyChart = new Chart(dailyCanvas.getContext('2d'), {
        type: 'bar',
        data: {
          labels: data.daily.map((item) => dateLabel(item.date, { day: '2-digit', month: 'short' })),
          datasets: [
            { label: 'Gasto del día', data: data.daily.map((item) => item.amount), backgroundColor: '#6caa8b', hoverBackgroundColor: '#246c54', borderRadius: 4, borderSkipped: false, maxBarThickness: 26, order: 2 },
            { type: 'line', label: 'Presupuesto diario', data: reference, borderColor: '#bd8652', borderDash: [5, 4], borderWidth: 2, pointRadius: 0, pointHitRadius: 8, tension: 0, order: 1 },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation,
          interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { callbacks: { label: (item) => ` ${item.dataset.label}: ${money(item.raw)}` } },
          },
          scales: {
            x: { grid: { display: false }, border: { display: false }, ticks: { color: '#718078', font: { size: 10 }, maxRotation: 0, autoSkip: true, maxTicksLimit: 10 } },
            y: { beginAtZero: true, grid: { color: '#e9eee9' }, border: { display: false }, ticks: { callback: (value) => money(value), maxTicksLimit: 4, font: { size: 10 } } },
          },
        },
      });
    }).catch((error) => {
      $('#category-empty').classList.remove('hidden');
      $('#category-empty').textContent = 'No pudimos cargar los gráficos. Actualiza la página para intentarlo de nuevo.';
      console.error(error);
    });
  }

  function renderSettings() {
    $('#setting-budget').value = settings.initial_budget;
    $('#setting-start').value = settings.trip_start;
    $('#setting-end').value = settings.trip_end;
    $('#category-settings-list').innerHTML = categories.map((category) => `
      <li><span>${escapeHtml(category.name)}</span><button type="button" data-rename="${category.id}" data-name="${escapeHtml(category.name)}">Cambiar nombre</button></li>`).join('');
  }

  function defaultDate() {
    const today = new Intl.DateTimeFormat('en-CA', {
      timeZone: settings.timezone || 'America/Bogota', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    return today >= settings.trip_start && today <= settings.trip_end ? today : settings.trip_start;
  }

  function resetExpenseForm() {
    $('#expense-form').reset();
    $('#expense-id').value = '';
    setExpenseDate(defaultDate());
    $('#entry-title').textContent = 'Agregar un gasto';
    $('#save-expense').querySelector('span:last-child').textContent = 'Guardar gasto';
    $('#save-expense').querySelector('.save-symbol').textContent = '＋';
    $('#cancel-edit').classList.add('hidden');
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

  $('#expense-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (saving) return;
    const id = $('#expense-id').value;
    const saveButton = $('#save-expense');
    const expenseDate = parseDisplayDate($('#expense-date-text').value);
    if (!expenseDate) {
      $('#expense-date-text').setCustomValidity('Escribe una fecha real en formato DD/MM/AAAA.');
      $('#expense-date-text').reportValidity();
      return;
    }
    $('#expense-date-text').setCustomValidity('');
    const formData = {
      date: expenseDate,
      description: $('#expense-description').value,
      category_id: Number($('#expense-category').value),
      amount: $('#expense-amount').value,
    };
    saving = true;
    saveButton.disabled = true;
    saveButton.querySelector('span:last-child').textContent = id ? 'Guardando…' : 'Guardando…';
    feedback($('#expense-feedback'), '');
    try {
      if (id) await api(`/api/expenses/${id}`, { method: 'PUT', body: JSON.stringify(formData) });
      else await api('/api/expenses', { method: 'POST', body: JSON.stringify(formData) });
      await loadAll();
      resetExpenseForm();
      feedback($('#expense-feedback'), id ? 'Gasto actualizado.' : 'Gasto guardado.');
      toast(id ? 'Gasto actualizado' : 'Gasto guardado');
    } catch (error) {
      feedback($('#expense-feedback'), error.message, true);
    } finally {
      saving = false;
      saveButton.disabled = false;
      if (!$('#expense-id').value) saveButton.querySelector('span:last-child').textContent = 'Guardar gasto';
    }
  });

  $('#cancel-edit').addEventListener('click', resetExpenseForm);
  $('#expense-list').addEventListener('click', async (event) => {
    const editButton = event.target.closest('[data-edit]');
    const deleteButton = event.target.closest('[data-delete]');
    if (editButton) {
      const expense = expenses.find((item) => item.id === Number(editButton.dataset.edit));
      if (!expense) return;
      $('#expense-id').value = expense.id;
      setExpenseDate(expense.date);
      $('#expense-description').value = expense.description;
      $('#expense-category').value = expense.category_id;
      $('#expense-amount').value = expense.amount;
      $('#entry-title').textContent = 'Editar gasto';
      $('#save-expense').querySelector('span:last-child').textContent = 'Guardar cambios';
      $('#save-expense').querySelector('.save-symbol').textContent = '✓';
      $('#cancel-edit').classList.remove('hidden');
      $('#history-details').open = true;
      $('#expense-date-text').focus();
      window.scrollTo({ top: 0, behavior: reducedMotion ? 'auto' : 'smooth' });
    }
    if (deleteButton && confirm('¿Quieres borrar este gasto? Esta acción no se puede deshacer.')) {
      try {
        await api(`/api/expenses/${deleteButton.dataset.delete}`, { method: 'DELETE' });
        await loadAll();
        toast('Gasto eliminado');
      } catch (error) {
        toast(error.message);
      }
    }
  });

  $('#expense-date-text').addEventListener('input', () => $('#expense-date-text').setCustomValidity(''));
  $('#expense-date-text').addEventListener('blur', () => {
    const text = $('#expense-date-text').value.trim();
    $('#expense-date-text').setCustomValidity(text && !parseDisplayDate(text) ? 'Usa una fecha real en formato DD/MM/AAAA.' : '');
  });
  $('#open-expense-date').addEventListener('click', () => openDatePicker('#expense-date-picker'));
  $('#expense-date-picker').addEventListener('change', () => setExpenseDate($('#expense-date-picker').value));
  $('#expense-filter-text').addEventListener('input', renderExpenses);
  $('#expense-filter-text').addEventListener('change', renderExpenses);
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
    $('#history-toggle-label').textContent = $('#history-details').open ? 'Ocultar gastos' : 'Ver gastos';
  });

  document.querySelectorAll('[data-view]').forEach((button) => button.addEventListener('click', () => {
    const summary = button.dataset.view === 'summary';
    $('#expenses-view').classList.toggle('hidden', summary);
    $('#summary-view').classList.toggle('hidden', !summary);
    $('#view-title').textContent = summary ? 'Resumen del viaje' : 'Gastos del viaje';
    document.querySelectorAll('[data-view]').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('selected', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    if (summary) {
      categoryChart?.resize();
      dailyChart?.resize();
    }
  }));

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

  $('#category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await api('/api/categories', { method: 'POST', body: JSON.stringify({ name: $('#new-category').value }) });
      $('#new-category').value = '';
      await loadAll();
      feedback($('#settings-feedback'), 'Categoría agregada.');
    } catch (error) {
      feedback($('#settings-feedback'), error.message, true);
    }
  });

  $('#category-settings-list').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-rename]');
    if (!button) return;
    const name = prompt('Nuevo nombre para la categoría:', button.dataset.name);
    if (name === null) return;
    try {
      await api(`/api/categories/${button.dataset.rename}`, { method: 'PUT', body: JSON.stringify({ name }) });
      await loadAll();
      feedback($('#settings-feedback'), 'Categoría actualizada.');
    } catch (error) {
      feedback($('#settings-feedback'), error.message, true);
    }
  });

  loadAll().then(resetExpenseForm).catch((error) => toast(error.message));
})();
