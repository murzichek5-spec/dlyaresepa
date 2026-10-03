function updateMark(element, enabled) {
  if (!element) return;
  element.textContent = enabled ? '✓' : '—';
  element.classList.toggle('yes', Boolean(enabled));
  element.classList.toggle('no', !enabled);

  element.classList.remove('live-flash');
  void element.offsetWidth;
  element.classList.add('live-flash');
}

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

    updateMark(row.querySelector('[data-live-field="telegram"]'), data.ticket.has_telegram);
    updateMark(row.querySelector('[data-live-field="my_tax"]'), data.ticket.has_my_tax);
    updateMark(row.querySelector('[data-live-field="yandex_pro"]'), data.ticket.has_yandex_pro);
    return;
  }

  // Новый талон, перевод на актив или ночная очистка меняют состав/статус таблицы.
  // Здесь безопаснее полностью перечитать страницу с сохранением текущих фильтров в URL.
  if (data.type === 'ticket-created' || data.type === 'ticket-activated' || data.type === 'tickets-cleared') {
    window.location.reload();
  }
};
