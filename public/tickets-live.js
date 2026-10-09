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

function getDisplayStatus(ticket) {
  if (ticket.status === 'active') return 'active';
  return ticket.helper_ready ? 'ready' : 'not_ready';
}

function getStatusText(status) {
  if (status === 'active') return 'Переведен на актив';
  if (status === 'ready') return 'Готов';
  return 'Не готов';
}

function styleStatusBadge(badge, status) {
  if (!badge) return;
  badge.classList.toggle('active-badge', status === 'active');
  badge.classList.toggle('ready-badge', status === 'ready');
  badge.classList.toggle('not-ready-badge', status === 'not_ready');
  const text = badge.querySelector('[data-status-text]');
  if (text) text.textContent = getStatusText(status);
}

function updateReadySelect(select, ready) {
  if (!select) return;
  select.value = ready ? '1' : '0';
  select.classList.toggle('status-select-ready', Boolean(ready));
  select.classList.toggle('status-select-not-ready', !ready);
}

// Причина обращения сохраняется только при выборе варианта из подсказок.
// Один всплывающий список вынесен из таблицы, чтобы его не обрезала прокрутка.
const reasonPopover = document.getElementById('reason-options-popover');
const reasonOptions = reasonPopover ? [...reasonPopover.querySelectorAll('[data-reason-option]')] : [];
let activeReasonInput = null;
let visibleReasonOptions = [];
let highlightedReasonIndex = -1;

function normalizeReason(text) {
  return String(text || '').toLocaleLowerCase('ru-RU').trim().replace(/\s+/g, ' ');
}

function filterReasonOptions(query) {
  if (!reasonPopover) return;
  const words = normalizeReason(query).split(' ').filter(Boolean);
  visibleReasonOptions = [];

  reasonOptions.forEach((option) => {
    const name = normalizeReason(option.dataset.reasonValue);
    const visible = words.every((word) => name.includes(word));
    option.hidden = !visible;
    if (visible) visibleReasonOptions.push(option);
  });

  reasonPopover.querySelectorAll('[data-reason-group]').forEach((group) => {
    group.hidden = !group.querySelector('[data-reason-option]:not([hidden])');
  });
  const empty = reasonPopover.querySelector('[data-reason-empty]');
  if (empty) empty.hidden = visibleReasonOptions.length !== 0;
  setHighlightedReason(-1);
}

function setHighlightedReason(index) {
  highlightedReasonIndex = index;
  reasonOptions.forEach((option) => option.classList.remove('is-highlighted'));
  if (!activeReasonInput) return;

  const option = visibleReasonOptions[index];
  if (option) {
    option.classList.add('is-highlighted');
    option.scrollIntoView({ block: 'nearest' });
    activeReasonInput.setAttribute('aria-activedescendant', option.id);
  } else {
    activeReasonInput.removeAttribute('aria-activedescendant');
  }
}

function positionReasonPopover() {
  if (!reasonPopover || !activeReasonInput || reasonPopover.hidden) return;
  const bounds = activeReasonInput.getBoundingClientRect();
  const width = Math.min(325, window.innerWidth - 20);
  const left = Math.max(10, Math.min(bounds.left, window.innerWidth - width - 10));
  const roomBelow = window.innerHeight - bounds.bottom - 12;
  const roomAbove = bounds.top - 12;
  const placeAbove = roomBelow < 210 && roomAbove > roomBelow;
  const available = placeAbove ? roomAbove : roomBelow;
  const height = Math.max(80, Math.min(315, available));

  reasonPopover.style.left = `${left}px`;
  reasonPopover.style.width = `${width}px`;
  reasonPopover.style.maxHeight = `${height}px`;
  reasonPopover.style.top = placeAbove ? `${Math.max(8, bounds.top - height - 5)}px` : `${bounds.bottom + 5}px`;
}

function closeReasonPopover(restoreDraft = false) {
  if (!reasonPopover) return;
  if (activeReasonInput) {
    if (restoreDraft) activeReasonInput.value = activeReasonInput.dataset.reasonSaved || '';
    activeReasonInput.setAttribute('aria-expanded', 'false');
    activeReasonInput.removeAttribute('aria-activedescendant');
  }
  reasonPopover.hidden = true;
  activeReasonInput = null;
  highlightedReasonIndex = -1;
}

function openReasonPopover(input, showAll = false) {
  if (!reasonPopover) return;
  if (activeReasonInput && activeReasonInput !== input) closeReasonPopover(true);
  activeReasonInput = input;
  input.setAttribute('aria-expanded', 'true');
  const feedback = input.closest('[data-reason-picker]')?.querySelector('[data-reason-feedback]');
  if (feedback) feedback.hidden = true;
  filterReasonOptions(showAll ? '' : input.value);
  reasonPopover.hidden = false;
  positionReasonPopover();
}

async function saveTicketReason(value) {
  const input = activeReasonInput;
  const row = input?.closest('[data-ticket-id]');
  if (!input || !row) return;

  const previous = input.dataset.reasonSaved || '';
  input.value = value;
  closeReasonPopover();
  if (value === previous) return;

  const feedback = input.closest('[data-reason-picker]')?.querySelector('[data-reason-feedback]');
  input.disabled = true;
  row.dataset.reasonSaving = '1';
  updateActivationAvailability(row);
  try {
    const response = await fetch(`/tickets/${row.dataset.ticketId}/reason`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: value })
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) {
      throw new Error(result.error || 'Не удалось сохранить причину');
    }
    input.dataset.reasonSaved = result.ticket.reason || '';
    input.value = input.dataset.reasonSaved;
    if (feedback) feedback.hidden = true;
  } catch (error) {
    input.value = previous;
    if (feedback) {
      feedback.textContent = error.message || 'Не удалось сохранить причину';
      feedback.hidden = false;
    }
  } finally {
    delete row.dataset.reasonSaving;
    input.disabled = false;
    updateActivationAvailability(row);
  }
}

// Активировать можно только после успешного сохранения причины в базе.
function updateActivationAvailability(row) {
  const button = row.querySelector('.activate-status-button');
  if (!button) return; // Для активных талонов остаётся обычная кнопка возврата.
  const reason = row.querySelector('[data-reason-input]')?.dataset.reasonSaved || '';
  const canActivate = Boolean(reason) && row.dataset.reasonSaving !== '1';
  button.disabled = !canActivate;
  const hint = row.querySelector('[data-activation-reason-hint]');
  if (hint) {
    hint.hidden = Boolean(reason) || row.dataset.reasonSaving === '1';
  }
}

function updateReason(row, value) {
  const text = value || '';
  const readonly = row.querySelector('[data-live-reason]');
  if (readonly) readonly.textContent = text || '—';

  const input = row.querySelector('[data-reason-input]');
  if (input) {
    input.dataset.reasonSaved = text;
    // Не перебиваем набираемый сотрудником поисковый запрос.
    if (input !== activeReasonInput) input.value = text;
  }
  updateActivationAvailability(row);
}

if (reasonPopover) {
  reasonOptions.forEach((option, index) => {
    option.id = `reason-option-${index}`;
    option.addEventListener('pointerdown', (event) => event.preventDefault());
    option.addEventListener('click', () => saveTicketReason(option.dataset.reasonValue));
  });

  reasonPopover.querySelector('[data-reason-clear]')?.addEventListener('click', () => {
    saveTicketReason('');
  });

  document.querySelectorAll('[data-reason-input]').forEach((input) => {
    input.dataset.reasonSaved = input.value;
    updateActivationAvailability(input.closest('[data-ticket-id]'));

    input.addEventListener('focus', () => {
      input.select(); // Можно сразу начать вводить новое название вместо старого.
      openReasonPopover(input, true);
    });
    input.addEventListener('click', () => openReasonPopover(input, true));
    input.addEventListener('input', () => openReasonPopover(input));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeReasonPopover(true);
        input.blur();
      } else if (event.key === 'Tab') {
        closeReasonPopover(true);
      } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        if (reasonPopover.hidden) openReasonPopover(input, true);
        if (!visibleReasonOptions.length) return;
        const direction = event.key === 'ArrowDown' ? 1 : -1;
        const next = (highlightedReasonIndex + direction + visibleReasonOptions.length) % visibleReasonOptions.length;
        setHighlightedReason(next);
      } else if (event.key === 'Enter' && !reasonPopover.hidden) {
        event.preventDefault();
        const choice = visibleReasonOptions[highlightedReasonIndex] || visibleReasonOptions[0];
        if (choice) saveTicketReason(choice.dataset.reasonValue);
      }
    });
  });

  document.addEventListener('pointerdown', (event) => {
    if (!activeReasonInput) return;
    if (reasonPopover.contains(event.target) || activeReasonInput.closest('[data-reason-picker]').contains(event.target)) return;
    closeReasonPopover(true);
  });
  document.addEventListener('scroll', (event) => {
    if (activeReasonInput && !reasonPopover.contains(event.target)) closeReasonPopover(true);
  }, true);
  window.addEventListener('resize', () => {
    if (activeReasonInput) positionReasonPopover();
  });
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

// Хелпер меняет Готов / Не готов без перезагрузки страницы.
document.querySelectorAll('[data-ready-select]').forEach((select) => {
  select.addEventListener('change', async () => {
    const row = select.closest('[data-ticket-id]');
    const ticketId = row?.dataset.ticketId;
    const previousValue = select.value === '1' ? '0' : '1';
    const ready = select.value === '1';

    updateReadySelect(select, ready);
    select.disabled = true;

    try {
      const response = await fetch(`/tickets/${ticketId}/ready`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ready })
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Не удалось сохранить статус');
      }
    } catch (error) {
      select.value = previousValue;
      updateReadySelect(select, previousValue === '1');
      alert(error.message || 'Не удалось сохранить статус');
    } finally {
      select.disabled = false;
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

  if (data.type === 'ticket-reason-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (row) updateReason(row, data.ticket.reason);
    return;
  }

  if (data.type === 'ticket-ready-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (!row) return;

    const status = getDisplayStatus(data.ticket);
    row.dataset.ticketStatus = status;
    updateReadySelect(row.querySelector('[data-ready-select]'), Boolean(data.ticket.helper_ready));
    styleStatusBadge(row.querySelector('[data-live-status]'), status);
    return;
  }

  if (data.type === 'ticket-status-updated' && data.ticket) {
    const row = document.querySelector(`tr[data-ticket-id="${data.ticket.id}"]`);
    if (!row) return;

    // Роль-зависимые элементы статуса меняются по структуре (select ↔ badge/button),
    // поэтому для корректного интерфейса обновляем страницу только при переводе/возврате из актива.
    window.location.reload();
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
