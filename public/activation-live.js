// Каждый сотрудник активации видит владельца талона и может взять свободный талон.
// SSE обновляет общий список у всех подключённых сотрудников.
(() => {
  const page = document.getElementById('activation-page');
  const tbody = document.getElementById('activation-ticket-rows');
  const count = document.getElementById('activation-count');
  const search = document.getElementById('activation-search');
  const empty = document.getElementById('activation-empty');
  const searchEmpty = document.getElementById('activation-search-empty');
  const notice = document.getElementById('activation-notice');
  const currentUserId = Number(page.dataset.userId);
  const role = page.dataset.role;
  const csrf = page.dataset.csrf;
  const canAct = role === 'activation' || role === 'admin';

  function makeElement(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content !== undefined) element.textContent = content;
    return element;
  }

  function createRow() {
    const row = document.createElement('tr');
    row.dataset.activationId = '';
    const number = makeElement('td', 'ticket-number');
    number.dataset.activationNumber = '';
    row.append(number);
    const client = makeElement('td', 'client-cell');
    const name = makeElement('div', 'client-name');
    name.dataset.activationName = '';
    const phone = makeElement('div', 'client-phone');
    phone.dataset.activationPhone = '';
    client.append(name, phone);
    row.append(client);
    for (const field of ['telegram', 'my_tax', 'yandex_pro']) {
      const cell = makeElement('td', 'center-cell');
      const mark = makeElement('span', 'feature-mark');
      mark.dataset.activationService = field;
      cell.append(mark);
      row.append(cell);
    }
    const reasonCell = makeElement('td', 'reason-cell');
    const reason = makeElement('span', 'reason-readonly');
    reason.dataset.activationReason = '';
    reasonCell.append(reason);
    row.append(reasonCell);
    const ownerCell = makeElement('td');
    const owner = makeElement('span', 'activation-owner-chip');
    owner.dataset.activationOwnerName = '';
    ownerCell.append(owner);
    row.append(ownerCell);
    if (canAct) {
      const actionCell = makeElement('td', 'activation-actions');
      const button = makeElement('button', 'activation-action');
      button.type = 'button';
      button.dataset.activationAction = '';
      button.hidden = true;
      const completeButton = makeElement('button', 'activation-action complete', 'Завершить');
      completeButton.type = 'button';
      completeButton.dataset.activationComplete = '';
      completeButton.hidden = true;
      actionCell.append(button, completeButton);
      row.append(actionCell);
    }
    return row;
  }

  function setMark(row, name, enabled) {
    const mark = row.querySelector(`[data-activation-service="${name}"]`);
    mark.textContent = enabled ? '✓' : '—';
    mark.classList.toggle('yes', Boolean(enabled));
    mark.classList.toggle('no', !enabled);
  }

  function updateRow(ticket) {
    if (!ticket || !Number.isSafeInteger(Number(ticket.id))) return;
    const id = String(ticket.id);
    let row = [...tbody.children].find(item => item.dataset.activationId === id);
    if (!row) {
      row = createRow();
      row.dataset.activationId = id;
      tbody.prepend(row);
    }
    row.querySelector('[data-activation-number]').textContent = ticket.queue_number || '—';
    row.querySelector('[data-activation-name]').textContent = ticket.full_name || '';
    row.querySelector('[data-activation-phone]').textContent = ticket.phone || '';
    row.querySelector('[data-activation-reason]').textContent = ticket.reason || '—';
    for (const [name, field] of [['telegram', 'has_telegram'], ['my_tax', 'has_my_tax'], ['yandex_pro', 'has_yandex_pro']]) {
      setMark(row, name, ticket[field]);
    }
    row.dataset.activationOwner = ticket.activation_owner_id ? String(ticket.activation_owner_id) : '';
    setOwnerState(row, ticket.activation_owner_name);
    refresh();
  }

  function setOwnerState(row, ownerName) {
    const ownerId = Number(row.dataset.activationOwner) || 0;
    const owner = row.querySelector('[data-activation-owner-name]');
    owner.textContent = ownerId ? `У ${ownerName || 'сотрудника'}` : 'Свободен';
    owner.classList.toggle('busy', Boolean(ownerId));
    owner.classList.toggle('free', !ownerId);
    const button = row.querySelector('[data-activation-action]');
    if (!button) return;
    const completeButton = row.querySelector('[data-activation-complete]');
    if (completeButton) completeButton.hidden = !(role === 'activation' && ownerId === currentUserId);
    if (ownerId === 0 && role === 'activation') {
      button.hidden = false;
      button.textContent = 'Взять в работу';
      button.dataset.action = 'claim';
      button.classList.remove('secondary');
    } else if (ownerId && (ownerId === currentUserId || role === 'admin')) {
      button.hidden = false;
      button.textContent = 'Освободить';
      button.dataset.action = 'release';
      button.classList.add('secondary');
    } else {
      button.hidden = true;
      button.dataset.action = '';
    }
  }

  function refresh() {
    const query = search.value.trim().toLocaleLowerCase('ru-RU');
    let visible = 0;
    const rows = [...tbody.querySelectorAll('[data-activation-id]')];
    rows.forEach(row => {
      const number = row.querySelector('[data-activation-number]').textContent;
      const name = row.querySelector('[data-activation-name]').textContent;
      const phone = row.querySelector('[data-activation-phone]').textContent;
      const owner = row.querySelector('[data-activation-owner-name]').textContent;
      const matches = `${number} ${name} ${phone} ${owner}`.toLocaleLowerCase('ru-RU').includes(query);
      row.hidden = !matches;
      if (matches) visible++;
    });
    count.textContent = rows.length;
    empty.hidden = rows.length !== 0;
    searchEmpty.hidden = !rows.length || visible > 0;
  }

  function showNotice(message, isError) {
    notice.hidden = false;
    notice.textContent = message;
    notice.classList.toggle('error', Boolean(isError));
  }

  tbody.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-activation-action], [data-activation-complete]');
    if (!button || button.disabled || button.hidden) return;
    const row = button.closest('[data-activation-id]');
    const action = button.hasAttribute('data-activation-complete') ? 'complete' : button.dataset.action;
    if (!row || !['claim', 'release', 'complete'].includes(action)) return;
    if (action === 'complete' && !confirm('Завершить активацию кандидата? Талон перейдёт в «Обработанные талоны».')) return;
    row.querySelectorAll('button').forEach(b => b.disabled = true);
    notice.hidden = true;
    try {
      const response = await fetch(`/activation/${row.dataset.activationId}/${action}`, {
        method: 'POST',
        headers: { 'Accept': 'application/json', 'X-CSRF-Token': csrf },
        credentials: 'same-origin'
      });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.error || 'Не удалось сохранить изменение');
      if (action === 'complete') {
        row.remove();
        refresh();
        showNotice('Талон завершён и перемещён в «Обработанные талоны»', false);
      } else {
        updateRow(result.ticket);
      }
    } catch (error) {
      showNotice(error.message, true);
    } finally {
      row.querySelectorAll('button').forEach(b => b.disabled = false);
    }
  });

  search.addEventListener('input', refresh);
  // При загрузке страницы уже отрисованные строки получают доступные действия.
  [...tbody.querySelectorAll('[data-activation-id]')].forEach(row => {
    const text = row.querySelector('[data-activation-owner-name]').textContent;
    setOwnerState(row, text.startsWith('У ') ? text.slice(2) : null);
  });
  refresh();

  const events = new EventSource('/activation/events');
  events.onmessage = event => {
    let data;
    try { data = JSON.parse(event.data); } catch (_) { return; }
    if (data.type === 'activation-snapshot' && Array.isArray(data.tickets)) {
      // Снимок на каждом (пере)подключении устраняет рассинхронизацию после сбоя сети.
      tbody.replaceChildren();
      data.tickets.forEach(updateRow);
      refresh();
    } else if (data.type === 'activation-ticket-updated' && data.ticket) {
      updateRow(data.ticket);
    } else if (data.type === 'activation-ticket-removed') {
      const row = [...tbody.children].find(item => item.dataset.activationId === String(data.ticketId));
      row?.remove();
      refresh();
    } else if (data.type === 'activation-owner-renamed') {
      for (const row of tbody.querySelectorAll('[data-activation-id]')) {
        if (Number(row.dataset.activationOwner) === Number(data.ownerId)) {
          setOwnerState(row, data.displayName);
        }
      }
      if (Number(data.ownerId) === currentUserId) {
        const userChip = document.querySelector('.heading-actions .user-chip');
        if (userChip) {
          const dot = userChip.querySelector('.status-dot');
          userChip.textContent = '';
          if (dot) userChip.append(dot);
          userChip.append(document.createTextNode(data.displayName));
        }
      }
      refresh();
    } else if (data.type === 'tickets-cleared') {
      tbody.replaceChildren();
      refresh();
    }
  };
})();
