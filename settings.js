let teamMembers = [];

async function init() {
  const config = await fetch('/api/settings').then(r => r.json());

  if (config.jiraUrl)    document.getElementById('jiraUrl').value    = config.jiraUrl;
  if (config.email)      document.getElementById('email').value      = config.email;
  if (config.token)      document.getElementById('token').value      = config.token;
  if (config.projectKeys) document.getElementById('projectKeys').value = config.projectKeys;

  teamMembers = config.teamMembers || [];
  renderTeamList();

  document.getElementById('testBtn').addEventListener('click', testConnection);
  document.getElementById('saveBtn').addEventListener('click', saveSettings);
  document.getElementById('userSearch').addEventListener('input', debounce(searchUsers, 300));

  document.addEventListener('click', e => {
    if (!e.target.closest('.search-wrap')) {
      document.getElementById('searchResults').classList.add('hidden');
    }
  });
}

async function testConnection() {
  const url   = document.getElementById('jiraUrl').value.trim();
  const email = document.getElementById('email').value.trim();
  const token = document.getElementById('token').value.trim();
  const result = document.getElementById('testResult');

  if (!url || !email || !token) {
    setResult(result, 'error', 'Fill in all connection fields first');
    return;
  }

  setResult(result, '', 'Testing…');

  // Temporarily save to test (server uses config.json for auth)
  await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jiraUrl: url, email, token, projectKeys: document.getElementById('projectKeys').value.trim() || 'SCALRCORE, CLOUD', teamMembers }),
  });

  try {
    const api = new JiraAPI();
    const me = await api.testAuth();
    setResult(result, 'success', `Connected as ${me.displayName}`);
  } catch (err) {
    setResult(result, 'error', `Failed: ${err.message}`);
  }
}

async function searchUsers() {
  const query = document.getElementById('userSearch').value.trim();
  const resultsEl = document.getElementById('searchResults');

  if (query.length < 2) { resultsEl.classList.add('hidden'); return; }

  try {
    const api = new JiraAPI();
    const users = await api.searchUsers(query);
    resultsEl.innerHTML = '';

    const filtered = users.filter(u => u.accountType === 'atlassian');
    if (filtered.length === 0) {
      resultsEl.innerHTML = '<div class="search-result-item muted">No users found</div>';
    } else {
      for (const user of filtered) {
        const item = document.createElement('div');
        item.className = 'search-result-item';
        const avatarSrc = user.avatarUrls?.['24x24'] || '';
        item.innerHTML = `
          ${avatarSrc ? `<img class="result-avatar" src="${avatarSrc}" />` : ''}
          <span>${escHtml(user.displayName)}</span>
          <span class="result-email">${escHtml(user.emailAddress || '')}</span>
        `;
        item.addEventListener('click', () => addMember(user));
        resultsEl.appendChild(item);
      }
    }
    resultsEl.classList.remove('hidden');
  } catch (err) {
    resultsEl.innerHTML = `<div class="search-result-item muted">Error — save connection settings first</div>`;
    resultsEl.classList.remove('hidden');
  }
}

function addMember(user) {
  if (teamMembers.find(m => m.accountId === user.accountId)) return;
  teamMembers.push({
    accountId:   user.accountId,
    displayName: user.displayName,
    avatarUrl:   user.avatarUrls?.['32x32'] || user.avatarUrls?.['24x24'] || '',
    email:       user.emailAddress || '',
    label:       '',
  });
  renderTeamList();
  document.getElementById('searchResults').classList.add('hidden');
  document.getElementById('userSearch').value = '';
}

function removeMember(accountId) {
  teamMembers = teamMembers.filter(m => m.accountId !== accountId);
  renderTeamList();
}

function renderTeamList() {
  const list = document.getElementById('teamList');
  list.innerHTML = '';
  if (teamMembers.length === 0) {
    list.innerHTML = '<div class="team-empty">No team members added yet. Search above to add.</div>';
    return;
  }
  for (const [idx, m] of teamMembers.entries()) {
    const item = document.createElement('div');
    item.className = 'team-member';
    const avatarHtml = m.avatarUrl
      ? `<img class="member-avatar" src="${m.avatarUrl}" alt="${escHtml(m.displayName)}" />`
      : `<div class="member-avatar placeholder">${escHtml(m.displayName[0])}</div>`;
    item.innerHTML = `
      ${avatarHtml}
      <div class="member-info">
        <span class="member-name">${escHtml(m.displayName)}</span>
        <span class="member-email">${escHtml(m.email)}</span>
      </div>
      <input class="member-label-input" type="text" value="${escHtml(m.label || '')}" placeholder="Role · Location" />
      <button class="remove-btn">Remove</button>
    `;
    item.querySelector('.member-label-input').addEventListener('input', e => {
      teamMembers[idx].label = e.target.value;
    });
    item.querySelector('.remove-btn').addEventListener('click', () => removeMember(m.accountId));
    list.appendChild(item);
  }
}

async function saveSettings() {
  const jiraUrl    = document.getElementById('jiraUrl').value.trim();
  const email      = document.getElementById('email').value.trim();
  const token      = document.getElementById('token').value.trim();
  const projectKeys = document.getElementById('projectKeys').value.trim() || 'SCALRCORE, CLOUD';
  const result     = document.getElementById('saveResult');

  if (!jiraUrl || !email) {
    setResult(result, 'error', 'Jira URL and email are required');
    return;
  }

  const res = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jiraUrl, email, token, projectKeys, teamMembers }),
  });

  if (res.ok) {
    setResult(result, 'success', 'Saved!');
    setTimeout(() => { result.textContent = ''; result.className = 'inline-result'; }, 2000);
  } else {
    setResult(result, 'error', 'Save failed');
  }
}

function setResult(el, type, text) {
  el.textContent = text;
  el.className = 'inline-result' + (type ? ` ${type}` : '');
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

document.addEventListener('DOMContentLoaded', init);
