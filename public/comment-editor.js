// Один общий комментарий на всех этапах. Общая реализация редактора для трёх страниц.
(() => {
  const page = document.querySelector('[data-comment-csrf], [data-csrf]');
  const csrf = page?.dataset.commentCsrf || page?.dataset.csrf || '';

  function make(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined) item.textContent = text;
    return item;
  }

  function createCell() {
    const cell = make('td', 'comment-cell');
    const widget = make('div', 'ticket-comment');
    widget.dataset.commentWidget = '';
    widget.dataset.commentVersion = '0';
    const preview = make('div', 'comment-preview', '—');
    preview.dataset.commentPreview = '';
    const edit = make('button', 'comment-edit-button', 'Изменить');
    edit.dataset.commentEdit = '';
    edit.type = 'button';
    edit.setAttribute('aria-label', 'Редактировать комментарий');

    const editor = make('div', 'comment-editor');
    editor.dataset.commentEditor = '';
    editor.hidden = true;
    const input = make('textarea');
    input.dataset.commentInput = '';
    input.rows = 3;
    input.maxLength = 1000;
    input.placeholder = 'Комментарий к кандидату';
    input.setAttribute('aria-label', 'Комментарий к талону');
    const actions = make('div', 'comment-editor-actions');
    const save = make('button', 'comment-save', 'Сохранить');
    save.dataset.commentSave = '';
    save.type = 'button';
    const cancel = make('button', 'comment-cancel', 'Отмена');
    cancel.dataset.commentCancel = '';
    cancel.type = 'button';
    actions.append(save, cancel);
    const feedback = make('span', 'comment-feedback');
    feedback.dataset.commentFeedback = '';
    feedback.setAttribute('role', 'status');
    feedback.hidden = true;
    editor.append(input, actions, feedback);
    widget.append(preview, edit, editor);
    cell.append(widget);
    return cell;
  }

  function apply(row, text, version) {
    const widget = row?.querySelector('[data-comment-widget]');
    if (!widget) return;
    const currentVersion = Number(widget.dataset.commentVersion) || 0;
    const nextVersion = Number(version);
    if (!Number.isSafeInteger(nextVersion) || nextVersion < currentVersion) return;
    const content = typeof text === 'string' ? text : '';
    const preview = widget.querySelector('[data-comment-preview]');
    if (preview) {
      preview.textContent = content || '—';
      preview.title = content;
    }
    widget.dataset.commentVersion = String(nextVersion);
    widget.dataset.commentValue = content;
    const editor = widget.querySelector('[data-comment-editor]');
    if (editor?.hidden) return;
    // Если коллега сохранил комментарий в момент редактирования, не затираем черновик.
    if (nextVersion > Number(widget.dataset.editVersion || 0)) {
      const feedback = widget.querySelector('[data-comment-feedback]');
      if (feedback) {
        feedback.hidden = false;
        feedback.textContent = 'Комментарий изменён коллегой. Отмени редактирование, чтобы открыть свежую версию.';
      }
    }
  }

  function open(widget) {
    const editor = widget.querySelector('[data-comment-editor]');
    const input = widget.querySelector('[data-comment-input]');
    widget.dataset.editVersion = widget.dataset.commentVersion || '0';
    editor.hidden = false;
    input.value = widget.dataset.commentValue ?? widget.querySelector('[data-comment-preview]')?.title ?? '';
    widget.querySelector('[data-comment-feedback]').hidden = true;
    widget.querySelector('[data-comment-edit]').hidden = true;
    input.focus();
  }

  function close(widget) {
    widget.querySelector('[data-comment-editor]').hidden = true;
    widget.querySelector('[data-comment-edit]').hidden = false;
    widget.querySelector('[data-comment-feedback]').hidden = true;
    widget.dataset.editVersion = '';
  }

  async function save(widget, row) {
    const id = row.dataset.ticketId || row.dataset.activationId || row.dataset.processedId;
    const input = widget.querySelector('[data-comment-input]');
    const text = input.value.trim();
    const feedback = widget.querySelector('[data-comment-feedback]');
    const saveButton = widget.querySelector('[data-comment-save]');
    const cancelButton = widget.querySelector('[data-comment-cancel]');
    if ([...text].length > 1000) {
      feedback.textContent = 'Не больше 1000 символов';
      feedback.hidden = false;
      return;
    }
    saveButton.disabled = true;
    cancelButton.disabled = true;
    try {
      const response = await fetch(`/tickets/${id}/comment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf },
        credentials: 'same-origin',
        body: JSON.stringify({ comment: text, version: Number(widget.dataset.editVersion) })
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || !payload.ok) throw new Error(payload.error || 'Не удалось сохранить комментарий');
      close(widget);
      apply(row, payload.comment, payload.comment_version);
    } catch (error) {
      feedback.textContent = error.message || 'Ошибка сохранения';
      feedback.hidden = false;
    } finally {
      saveButton.disabled = false;
      cancelButton.disabled = false;
    }
  }

  // Делегирование помогает и строкам, которые SSE создаёт после загрузки страницы.
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-comment-edit], [data-comment-cancel], [data-comment-save]');
    if (!button || button.disabled) return;
    const widget = button.closest('[data-comment-widget]');
    const row = button.closest('[data-ticket-id], [data-activation-id], [data-processed-id]');
    if (!widget || !row) return;
    if (button.hasAttribute('data-comment-edit')) open(widget);
    if (button.hasAttribute('data-comment-cancel')) close(widget);
    if (button.hasAttribute('data-comment-save')) save(widget, row);
  });

  // Значения загруженных HTML-строк считаются исходными, а новые строки создаются JS.
  document.querySelectorAll('[data-comment-widget]').forEach((widget) => {
    widget.dataset.commentValue = widget.querySelector('[data-comment-preview]')?.title || '';
  });

  window.QmikComments = { makeCell: createCell, apply };
})();
