const UI = (() => {
  const AVATAR_COLORS = [
    ['#6E56CF','#9E8CFC'], ['#0CA678','#37D3A5'], ['#E8590C','#F59F4D'], ['#1971C2','#4DABF7'],
    ['#9C36B5','#C77DD8'], ['#C2255C','#E64980'], ['#2F9E44','#69DB7C'], ['#1098AD','#3BC9DB'],
  ];

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function initials(name) {
    const value = (name || '?')
      .split(/\s+/)
      .filter(Boolean)
      .map(s => s[0])
      .slice(0, 2)
      .join('')
      .toUpperCase();
    return value || '?';
  }

  function colorFromIndex(idx) {
    const [a, b] = AVATAR_COLORS[idx % AVATAR_COLORS.length];
    return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
  }

  function colorFromName(name) {
    const idx = (name || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length;
    const [bg] = AVATAR_COLORS[idx];
    return bg;
  }

  function avatarHtml({ name, avatarUrl, className, placeholderClass = '', colorIndex = null, alt = '' }) {
    if (avatarUrl) return `<img class="${escHtml(className)}" src="${escHtml(avatarUrl)}" alt="${escHtml(alt)}">`;
    const bg = colorIndex === null ? colorFromName(name) : colorFromIndex(colorIndex);
    const classes = [className, placeholderClass].filter(Boolean).map(escHtml).join(' ');
    return `<span class="${classes}" style="background:${bg}">${escHtml(initials(name))}</span>`;
  }

  function commentHtml({ author, avatarUrl, dateLabel, bodyHtml, avatarClass = 'tc-act-av', metaHtml = '' }) {
    const dateHtml = dateLabel ? `<span class="tc-comment-time">${escHtml(dateLabel)}</span>` : '';
    return `
      <div class="tc-comment-header">
        ${avatarHtml({ name: author, avatarUrl, className: avatarClass, placeholderClass: 'tc-av--init' })}
        <span class="tc-comment-name">${escHtml(author)}</span>
        ${metaHtml}
        ${dateHtml}
      </div>
      <div class="tc-comment-text">${bodyHtml}</div>`;
  }

  function makeExpandableByLength(el, text, limit = 200) {
    if ((text || '').length <= limit) return;
    el.style.cursor = 'pointer';
    el.addEventListener('click', e => {
      if (e.target.closest('a')) return;
      el.dataset.expanded = el.dataset.expanded === 'true' ? 'false' : 'true';
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  return {
    avatarHtml,
    colorFromIndex,
    commentHtml,
    debounce,
    escHtml,
    initials,
    makeExpandableByLength,
  };
})();
