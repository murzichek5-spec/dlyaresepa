// Архив: только просмотр, обновление по SSE без F5.
(() => {
  const tbody = document.getElementById('processed-ticket-rows');
  const search = document.getElementById('processed-search');
  const count = document.getElementById('processed-count');
  const empty = document.getElementById('processed-empty');
  const searchEmpty = document.getElementById('processed-search-empty');
  if (!tbody) return;

  function element(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }
  function createRow() {
    const tr = element('tr');
    tr.dataset.processedId = '';
    const number = element('td','ticket-number'); number.dataset.processedNumber = ''; tr.append(number);
    const client = element('td','client-cell');
    const name = element('div','client-name'); name.dataset.processedName = '';
    const phone = element('div','client-phone'); phone.dataset.processedPhone = '';
    client.append(name, phone); tr.append(client);
    for (const field of ['telegram','my_tax','yandex_pro']) {
      const td = element('td','center-cell');
      const mark = element('span','feature-mark'); mark.dataset.processedService = field;
      td.append(mark); tr.append(td);
    }
    const reasonCell = element('td','reason-cell');
    const reason = element('span','reason-readonly'); reason.dataset.processedReason = '';
    reasonCell.append(reason); tr.append(reasonCell);
    tr.append(window.QmikComments.makeCell());
    const state = element('td');
    const badge = element('span','badge ready-badge');
    badge.append(element('span','badge-dot'),element('span','', 'Обработан'));
    state.append(badge); tr.append(state);
    const owner = element('td'); owner.dataset.processedOwner = ''; tr.append(owner);
    const date = element('td','processed-date'); date.dataset.processedDate = ''; tr.append(date);
    return tr;
  }
  function upsert(ticket) {
    if (!ticket || !Number.isSafeInteger(Number(ticket.id))) return;
    const id = String(ticket.id);
    let row = [...tbody.querySelectorAll('[data-processed-id]')].find(r => r.dataset.processedId === id);
    if (!row) { row=createRow(); row.dataset.processedId=id; tbody.prepend(row); }
    row.querySelector('[data-processed-number]').textContent = ticket.queue_number || '—';
    row.querySelector('[data-processed-name]').textContent = ticket.full_name || '';
    row.querySelector('[data-processed-phone]').textContent = ticket.phone || '';
    row.querySelector('[data-processed-reason]').textContent = ticket.reason || '—';
    window.QmikComments.apply(row, ticket.comment, ticket.comment_version);
    row.querySelector('[data-processed-owner]').textContent = ticket.completed_by_name || '—';
    row.querySelector('[data-processed-date]').textContent = ticket.completed_local || '—';
    for (const [field,col] of [['telegram','has_telegram'],['my_tax','has_my_tax'],['yandex_pro','has_yandex_pro']]) {
      const mark=row.querySelector(`[data-processed-service="${field}"]`);
      mark.textContent=ticket[col] ? '✓' : '—';
      mark.classList.toggle('yes',!!ticket[col]);
      mark.classList.toggle('no',!ticket[col]);
    }
    refresh();
  }
  function refresh() {
    const needle = search.value.trim().toLocaleLowerCase('ru-RU');
    const rows=[...tbody.querySelectorAll('[data-processed-id]')];
    let visible=0;
    rows.forEach(row => {
      const content=[...row.querySelectorAll('td')].map(td=>td.textContent).join(' ').toLocaleLowerCase('ru-RU');
      const match=content.includes(needle);
      row.hidden=!match;
      if (match) visible++;
    });
    count.textContent=rows.length;
    empty.hidden=rows.length!==0;
    searchEmpty.hidden=rows.length===0 || visible!==0;
  }
  search.addEventListener('input',refresh);
  refresh();
  const source=new EventSource('/processed/events');
  source.onmessage=event=>{
    let data;
    try { data=JSON.parse(event.data); } catch (_) { return; }
    if (data.type==='processed-snapshot' && Array.isArray(data.tickets)) {
      tbody.replaceChildren(); data.tickets.forEach(upsert); refresh();
    } else if (data.type==='processed-ticket-updated' && data.ticket) {
      upsert(data.ticket);
    } else if (data.type==='tickets-cleared') {
      tbody.replaceChildren(); refresh();
    }
  };
})();
