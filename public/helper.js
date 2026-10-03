const serviceToggles = document.querySelectorAll('[data-service-toggle]');

serviceToggles.forEach((checkbox) => {
  checkbox.addEventListener('change', async () => {
    const card = checkbox.closest('[data-ticket-id]');
    const ticketId = card.dataset.ticketId;
    const saveState = card.querySelector('.save-state');
    const previousValue = !checkbox.checked;

    checkbox.disabled = true;
    saveState.textContent = 'Сохраняю…';
    saveState.className = 'save-state saving';

    try {
      const response = await fetch(`/tickets/${ticketId}/services`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          field: checkbox.dataset.field,
          value: checkbox.checked
        })
      });

      if (!response.ok) throw new Error('Не удалось сохранить');

      saveState.textContent = 'Сохранено';
      saveState.className = 'save-state saved';

      setTimeout(() => {
        if (saveState.textContent === 'Сохранено') saveState.textContent = '';
      }, 1200);
    } catch (error) {
      checkbox.checked = previousValue;
      saveState.textContent = 'Ошибка сохранения';
      saveState.className = 'save-state save-error';
    } finally {
      checkbox.disabled = false;
    }
  });
});
