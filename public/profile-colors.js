// Предпросмотр имени и цветов — без отправки данных на сервер до сохранения.
(() => {
  const name = document.getElementById('display-name');
  const bg = document.getElementById('owner-bg-color');
  const fg = document.getElementById('owner-text-color');
  const preview = document.getElementById('owner-preview');
  const advice = document.getElementById('contrast-advice');
  if (!name || !bg || !fg || !preview) return;

  const luminance = hex => {
    const channels = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    return channels.map(c => c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  };
  function update() {
    preview.textContent = `У ${name.value.trim() || 'специалиста'}`;
    preview.style.setProperty('--owner-bg', bg.value);
    preview.style.setProperty('--owner-text', fg.value);
    document.getElementById('owner-bg-hex').textContent = bg.value.toUpperCase();
    document.getElementById('owner-text-hex').textContent = fg.value.toUpperCase();
    const a = luminance(bg.value), b = luminance(fg.value);
    const contrast = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    advice.hidden = contrast >= 4.5;
  }
  [name, bg, fg].forEach(input => input.addEventListener('input', update));
  update();
})();
