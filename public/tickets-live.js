function updateMark(element, enabled) {
  if (!element) return;
  element.textContent = enabled ? '✓' : '—';
  element.classList.toggle('yes', Boolean(enabled));
  element.classList.toggle('no', !enabled);
  element.classList.remove('live-flash');
  void element.offsetWidth;
  element.classList.add('live-flash');
}

function updateEditableCheck(row, field, enabled) {
  const checkbox = row.querySelector(`[data-service-toggle][data-field="${field}"]`);
  if (!checkbox) return false;
  checkbox.checked = Boolean(enabled);
  const mark = checkbox.closest('.table-service-toggle')?.querySelector('.table-check');
  if (mark) mark.textContent = enabled ? '✓' : '—';
  return true;
}

function updateService(row, field, enabled) {
  if (updateEditableCheck(row, field, enabled)) return;
  updateMark(row.querySelector(`[data-live-field="${field}"]`), enabled);
}

function updateNumber(row, queueNumber) {
  const plainNumber = row.querySelector('[data-live-number]');
  if (plainNumber) {
    plainNumber.textContent = queueNumber || '—';
    plainNumber.classList.remove('live-flash');
    void plainNumber.offsetWidth;
    plainNumber.classList.add('live-flash');
  }

  const input = row.querySelector('.number-form input[name="queue_number"]');
  if (input && document.activeElement !== input) {
    input.value = queueNumber || '';
  }
}

function updateStatus(row, status) {
  const select = row.querySelector('.status-select');
  if (select) {
    select.value = status;
    select.classList.toggle('status-select-active', status === 'active');
    select.classList.toggle('status-select-waiting', status !== 'active');
  }

  const badge = row.querySelector('[data-live-status]');
  if (badge) {
    badge.classList.toggle('active-badge', status === 'active');
    badge.classList.toggle('waiting-badge', status !== 'active');
    const text = badge.querySelector('[data-status-text]');
    if (text) text.textContent = status === 'active' ? 'Переведен на актив' : 'Ожидает';
  }
}

// Сервисы меняются хелпером прямо в общей таблице.
document.querySelectorAll('[data-service-toggle]').forEach((checkbox) => {
  checkbox.addEventListener('change', async () => {
    const row = checkbox.closest('[data-ticket-id]');
    const ticketId = row?.dataset.ticketId;
    const previousValue = !checkbox.checked;
    const mark = checkbox.closest('.table-service-toggle')?.querySelector('.table-check');

    if (mark) mark.textContent = checkbox.checked ? '✓' : '—';
    checkbox.disabled = true;

    try {
      const response = await fetch(`/tickets/${ticketId}/services`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          field: checkbox.dataset.field,
          value: checkbox.checked
        })
      });

      if (!response.ok) throw new Error('Не удалось сохранить');
    } catch (_) {
      checkbox.checked = previousValue;
      if (mark) mark.textContent = previousValue ? '✓' : '—';
      alert('Не удалось сохранить изменение');
    } finally {
      checkbox.disabled = false;
    }
  });
});

// Удаление требует подтверждения, чтобы не снести талон случайно.
document.querySelectorAll('[data-delete-form]').forEach((form) => {
  form.addEventListener('submit', (event) => {
    if (!confirm('Удалить этот талон? Отменить это действие будет нельзя.')) {
      event.preventDefault();
    }
  });
});

const events = new EventSource('/events');

events.onmessage = (event) => {
  let data;

  try {
    data = JSON.parse(event.data);
  } catch (_) {
    return;
  }

  if (data.type === 'services-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (!row) return;

    updateService(row, 'telegram', data.ticket.has_telegram);
    updateService(row, 'my_tax', data.ticket.has_my_tax);
    updateService(row, 'yandex_pro', data.ticket.has_yandex_pro);
    return;
  }

  if (data.type === 'ticket-number-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (row) updateNumber(row, data.ticket.queue_number);
    return;
  }

  if (data.type === 'ticket-status-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (!row) return;

    const statusFilter = new URLSearchParams(window.location.search).get('status') || 'all';
    if ((statusFilter === 'waiting' || statusFilter === 'active') && statusFilter !== data.ticket.status) {
      row.remove();
    } else {
      updateStatus(row, data.ticket.status);
    }
    return;
  }

  if (data.type === 'ticket-deleted') {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticketId}"]`);
    if (row) row.remove();
    return;
  }

  // Новый талон и ночная очистка меняют состав таблицы.
  if (data.type === 'ticket-created' || data.type === 'tickets-cleared') {
    window.location.reload();
  }
};
