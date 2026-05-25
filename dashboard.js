const COLUMNS = [
  {
    id:      'workflow',
    title:   'Workflow',
    types:   new Set(['created', 'status_change', 'closed', 'self_assigned']),
    filters: [
      { type: 'all',           label: 'All' },
      { type: 'created',       label: 'Created' },
      { type: 'status_change', label: 'Status' },
      { type: 'closed',        label: 'Closed' },
      { type: 'self_assigned', label: 'Assigned' },
    ],
  },
  {
    id:      'comments',
    title:   'Comments',
    types:   new Set(['comment', 'mention']),
    filters: [
      { type: 'all',     label: 'All' },
      { type: 'comment', label: 'Comments' },
      { type: 'mention', label: 'Mentioned' },
    ],
  },
];

const AVATAR_COLORS = [
  ['#6E56CF','#9E8CFC'], ['#0CA678','#37D3A5'], ['#E8590C','#F59F4D'], ['#1971C2','#4DABF7'],
  ['#9C36B5','#C77DD8'], ['#C2255C','#E64980'], ['#2F9E44','#69DB7C'], ['#1098AD','#3BC9DB'],
];

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const BADGE_CSS = { status_change: 'status', self_assigned: 'assigned' };
const BADGE_LABELS = {
  created: 'Created', status_change: 'Status', closed: 'Closed',
  self_assigned: 'Assigned', comment: 'Comment', mention: 'Mention',
};

const api = new JiraAPI();
let settings = null;
let currentPeriod = 3;
let lastUpdateTime = null;
const columnFilters = {};
const dataCache = {};

// ── Theme ──────────────────────────────────────────────────────────────────

function initTheme() {
  const btn = document.getElementById('themeBtn');

  const ICONS = {
    auto:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" stroke="none"/></svg>`,
    light: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/></svg>`,
    dark:  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/></svg>`,
  };
  const TITLES = {
    auto:  'Theme: Auto (following system)',
    light: 'Theme: Light',
    dark:  'Theme: Dark',
  };
  const CYCLE = { auto: 'light', light: 'dark', dark: 'auto' };

  function getState() {
    return document.documentElement.getAttribute('data-theme') || 'auto';
  }
  function updateIcon() {
    const state = getState();
    btn.innerHTML = ICONS[state];
    btn.title = TITLES[state];
    btn.setAttribute('aria-label', TITLES[state]);
  }

  updateIcon();

  btn.addEventListener('click', () => {
    const next = CYCLE[getState()];
    if (next === 'auto') {
      document.documentElement.removeAttribute('data-theme');
      localStorage.removeItem('ta-theme');
    } else {
      document.documentElement.setAttribute('data-theme', next);
      localStorage.setItem('ta-theme', next);
    }
    updateIcon();
  });

  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', updateIcon);
}

// ── Init ───────────────────────────────────────────────────────────────────

async function loadSettings() {
  const res = await fetch('/api/settings');
  return res.json();
}

async function init() {
  settings = await loadSettings();

  if (!settings.jiraUrl || !settings.email || !settings.token) {
    showMessage('error', 'Not configured. <a href="settings.html">Open settings</a>');
    return;
  }
  if (!settings.teamMembers || settings.teamMembers.length === 0) {
    showMessage('error', 'No team members configured. <a href="settings.html">Add team members</a>');
    return;
  }

  const mc = document.getElementById('memberCount');
  if (mc) mc.textContent = settings.teamMembers.length;

  initTheme();

  document.querySelectorAll('.segmented button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.segmented button').forEach(b => b.setAttribute('aria-pressed', 'false'));
      btn.setAttribute('aria-pressed', 'true');
      currentPeriod = parseInt(btn.dataset.days);
      loadDashboard(false);
    });
  });

document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spin');
    loadDashboard(true).finally(() => btn.classList.remove('spin'));
  });

  document.getElementById('searchInput').addEventListener('input', e => {
    const q = e.target.value.trim().toLowerCase();
    document.querySelectorAll('#dashboard .card').forEach(card => {
      if (!q) { card.style.display = ''; return; }
      const name = card.querySelector('.who-name')?.textContent.toLowerCase() || '';
      if (name.includes(q)) { card.style.display = ''; return; }
      const hasRow = [...card.querySelectorAll('.row')].some(r => {
        const key     = r.querySelector('.key')?.textContent.toLowerCase() || '';
        const summary = r.querySelector('.summary')?.textContent.toLowerCase() || '';
        return key.includes(q) || summary.includes(q);
      });
      card.style.display = hasRow ? '' : 'none';
    });
  });

  document.addEventListener('keydown', e => {
    if (e.key === '/' && !/input|textarea/i.test(e.target.tagName)) {
      e.preventDefault();
      document.getElementById('searchInput')?.focus();
    }
  });

  setInterval(() => {
    if (!lastUpdateTime) return;
    const lu = document.getElementById('lastUpdated');
    if (lu) lu.textContent = timeRel(lastUpdateTime);
  }, 30000);

  loadDashboard();
}

// ── Loading ────────────────────────────────────────────────────────────────

async function loadDashboard(forceRefresh = false) {
  if (!forceRefresh && dataCache[currentPeriod]) {
    renderDashboard(dataCache[currentPeriod]);
    return;
  }

  const container = document.getElementById('dashboard');
  container.innerHTML = '';
  const skeletons = new Map();
  for (const member of settings.teamMembers) {
    const sk = createSkeleton();
    container.appendChild(sk);
    skeletons.set(member.accountId, sk);
  }

  const newCache = { activities: {}, currentAssignments: {}, staleByUser: {} };
  for (const [idx, member] of settings.teamMembers.entries()) {
    try {
      const data = await fetchUserData(member, currentPeriod);
      newCache.activities[member.accountId]         = data.activities;
      newCache.currentAssignments[member.accountId] = data.currentAssignment;
      newCache.staleByUser[member.accountId]        = data.stale;
      const card = renderUserCard(member, data.activities, data.currentAssignment, data.stale, idx);
      card.style.cssText = 'opacity:0;transform:translateY(4px);transition:opacity .22s ease,transform .22s ease';
      skeletons.get(member.accountId).replaceWith(card);
      requestAnimationFrame(() => { card.style.opacity = '1'; card.style.transform = 'none'; });
    } catch (err) {
      const sk = skeletons.get(member.accountId);
      sk.innerHTML = `<div class="empty" style="color:var(--b-mention-fg)">Failed: ${escHtml(err.message)}</div>`;
    }
  }

  lastUpdateTime = new Date();
  const lu = document.getElementById('lastUpdated');
  if (lu) lu.textContent = 'just now';
  dataCache[currentPeriod] = newCache;
}

function createSkeleton() {
  const el = document.createElement('article');
  el.className = 'card';
  el.innerHTML = `
    <div class="sk-card">
      <div>
        <div class="sk-head">
          <div class="skeleton" style="width:36px;height:36px;border-radius:50%;flex-shrink:0"></div>
          <div class="sk-head-text">
            <div class="skeleton sk-line" style="width:60%"></div>
            <div class="skeleton sk-line" style="width:40%;margin-top:6px;height:9px"></div>
          </div>
        </div>
      </div>
      <div>
        <div class="skeleton sk-line" style="width:30%;height:9px"></div>
        <div class="skeleton sk-line" style="margin-top:6px"></div>
        <div class="skeleton sk-line" style="width:80%;margin-top:4px"></div>
        <div class="skeleton sk-line" style="width:60%;margin-top:4px"></div>
      </div>
    </div>`;
  return el;
}

// ── Data fetching ──────────────────────────────────────────────────────────

function buildActivities(issues, teamIds, cutoff, baseUrl) {
  const byUser = {};
  for (const id of teamIds) byUser[id] = [];

  const seenIssueKeys  = new Set();
  const seenHistoryIds = new Set();
  const seenCommentIds = new Set();

  for (const issue of issues) {
    const info = {
      key:     issue.key,
      summary: issue.fields.summary || '',
      type:    issue.fields.issuetype?.name || '',
      url:     `${baseUrl}/browse/${issue.key}`,
      status:  issue.fields.status?.name || '',
    };

    if (!seenIssueKeys.has(issue.key)) {
      seenIssueKeys.add(issue.key);
      const reporterId = issue.fields.reporter?.accountId;
      if (reporterId && teamIds.includes(reporterId)) {
        const ts = new Date(issue.fields.created);
        if (ts >= cutoff) byUser[reporterId].push({ type: 'created', timestamp: ts, issue: info });
      }
    }

    for (const history of (issue.changelog?.histories || [])) {
      if (seenHistoryIds.has(history.id)) continue;
      seenHistoryIds.add(history.id);
      const ts = new Date(history.created);
      if (ts < cutoff) continue;
      const authorId = history.author?.accountId;
      const authorIsTeam = authorId && teamIds.includes(authorId);
      for (const item of history.items) {
        if (item.field === 'status') {
          const isDone = item.toString === 'Done' || item.toString === 'Closed';
          if (authorIsTeam) {
            byUser[authorId].push({
              type: isDone ? 'closed' : 'status_change',
              timestamp: ts, issue: info,
              detail: { from: item.fromString, to: item.toString },
            });
          } else {
            // Transition made by someone outside the team — attribute to the current assignee
            const assigneeId = issue.fields.assignee?.accountId;
            if (assigneeId && teamIds.includes(assigneeId)) {
              byUser[assigneeId].push({
                type: isDone ? 'closed' : 'status_change',
                timestamp: ts, issue: info,
                detail: { from: item.fromString, to: item.toString, movedBy: history.author?.displayName || 'Someone' },
              });
            }
          }
        } else if (item.field === 'assignee' && authorIsTeam && item.to === authorId) {
          byUser[authorId].push({ type: 'self_assigned', timestamp: ts, issue: info });
        }
      }
    }

    for (const comment of (issue.fields.comment?.comments || [])) {
      if (seenCommentIds.has(comment.id)) continue;
      seenCommentIds.add(comment.id);
      const ts = new Date(comment.created);
      if (ts < cutoff) continue;
      const text = adfToText(comment.body);
      const authorId = comment.author?.accountId;
      if (authorId && teamIds.includes(authorId)) {
        byUser[authorId].push({ type: 'comment', timestamp: ts, issue: info, detail: { preview: text.substring(0, 160) } });
      }
      for (const mentionedId of adfMentions(comment.body)) {
        if (mentionedId !== authorId && teamIds.includes(mentionedId)) {
          byUser[mentionedId].push({
            type: 'mention', timestamp: ts, issue: info,
            detail: { by: comment.author?.displayName || 'Someone', preview: text.substring(0, 160) },
          });
        }
      }
    }
  }

  for (const id in byUser) {
    byUser[id].sort((a, b) => b.timestamp - a.timestamp);
    if (byUser[id].length > 60) byUser[id] = byUser[id].slice(0, 60);
  }
  return byUser;
}

async function fetchUserData(member, days) {
  const id = `"${member.accountId}"`;
  const keys = (settings.projectKeys || 'SCALRCORE').split(',').map(k => k.trim()).filter(Boolean);
  const projectJql = keys.length === 1 ? `project = ${keys[0]}` : `project in (${keys.join(', ')})`;
  const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'reporter', 'issuetype', 'comment', 'created', 'updated'];

  const cutoff = workingDaysCutoff(days);
  const [activityIssues, assignmentIssues, staleIssues] = await Promise.all([
    api.getAllIssues(
      `${projectJql} AND updated >= ${toJiraDate(cutoff)} AND (assignee = ${id} OR reporter = ${id}) ORDER BY updated DESC`,
      ISSUE_FIELDS, ['changelog'], 50
    ),
    api.getAllIssues(
      `assignee = ${id} AND statusCategory = "In Progress" ORDER BY updated DESC`,
      ['summary', 'status', 'issuetype', 'assignee', 'parent'], [], 10
    ),
    api.getAllIssues(
      `assignee = ${id} AND statusCategory != Done AND updated <= "-7d" ORDER BY updated ASC`,
      ['summary', 'status', 'issuetype', 'assignee', 'updated', 'comment', 'parent'], ['changelog'], 20
    ),
  ]);

  const byUser = buildActivities(activityIssues, [member.accountId], cutoff, settings.jiraUrl);

  const seen1 = new Set();
  const currentAssignment = assignmentIssues.filter(i => seen1.has(i.key) ? false : (seen1.add(i.key), true));
  const seen2 = new Set();
  const stale = staleIssues.filter(i => seen2.has(i.key) ? false : (seen2.add(i.key), true));

  return { activities: byUser[member.accountId] || [], currentAssignment, stale };
}

async function refreshColumn(member, colDef, colEl, card) {
  const rowsEl = colEl.querySelector('.rows');
  const btn    = colEl.querySelector('.col-actions button');
  btn.disabled = true;
  btn.classList.add('spin');
  if (rowsEl) rowsEl.innerHTML = '<div class="empty">Refreshing…</div>';

  try {
    const userData = await fetchUserData(member, currentPeriod);
    if (dataCache[currentPeriod]) {
      dataCache[currentPeriod].activities[member.accountId]         = userData.activities;
      dataCache[currentPeriod].currentAssignments[member.accountId] = userData.currentAssignment;
      dataCache[currentPeriod].staleByUser[member.accountId]        = userData.stale;
    }
    const memberIdx = settings.teamMembers.indexOf(member);
    const newCard = renderUserCard(member, userData.activities, userData.currentAssignment, userData.stale, memberIdx);
    card.replaceWith(newCard);
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('spin');
    if (rowsEl) rowsEl.innerHTML = `<div class="empty" style="color:var(--b-mention-fg)">Error: ${escHtml(err.message)}</div>`;
  }
}

// ── ADF ────────────────────────────────────────────────────────────────────

function adfToText(node) {
  if (!node) return '';
  if (node.type === 'text') return node.text || '';
  if (node.type === 'hardBreak') return '\n';
  if (node.content) return node.content.map(adfToText).join('');
  return '';
}

function adfMentions(node) {
  if (!node) return [];
  if (node.type === 'mention') return [node.attrs?.id].filter(Boolean);
  if (node.content) return node.content.flatMap(adfMentions);
  return [];
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderDashboard({ activities, currentAssignments, staleByUser }) {
  const container = document.getElementById('dashboard');
  container.innerHTML = '';
  for (const [idx, member] of settings.teamMembers.entries()) {
    container.appendChild(renderUserCard(
      member,
      activities[member.accountId] || [],
      currentAssignments[member.accountId],
      staleByUser[member.accountId] || [],
      idx
    ));
  }
}

function renderUserCard(member, activities, assignment, stale, memberIdx = 0) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.memberId = member.accountId;

  // Avatar
  const avatarHtml = member.avatarUrl
    ? `<img class="avatar" src="${member.avatarUrl}" alt="${escHtml(member.displayName)}" />`
    : `<div class="avatar" style="background:${avatarBg(memberIdx)}">${escHtml(initials(member.displayName))}</div>`;

  // In Progress (grouped)
  const inProgress = Array.isArray(assignment) ? assignment : [];
  let ipListHtml;
  if (inProgress.length === 0) {
    ipListHtml = `<div class="ip-empty">Nothing in progress.</div>`;
  } else {
    const ipRow = issue => {
      const url = `${settings.jiraUrl}/browse/${issue.key}`;
      return `<div class="ip-row">
        <a class="key" href="${url}" target="_blank" rel="noopener">
          <span class="it-icon ${itClass(issue.fields.issuetype?.name)}" aria-hidden="true"></span>${escHtml(issue.key)}</a>
        <a class="summary" href="${url}" target="_blank" rel="noopener">${escHtml(issue.fields.summary || '')}</a>
        <span class="pill ${pillClass(issue.fields.status?.name)}">${escHtml(issue.fields.status?.name || '')}</span>
      </div>`;
    };
    ipListHtml = groupByParent(inProgress).map(({ issue, parentInfo, children }) => {
      let html = '';
      if (issue) {
        html += ipRow(issue);
      } else if (parentInfo) {
        html += `<div class="ip-parent-ref">
          <span class="key" style="color:var(--text-3)">${escHtml(parentInfo.key)}</span>
          <span style="color:var(--text-3)">${escHtml(trunc(parentInfo.fields?.summary || '', 70))}</span>
        </div>`;
      }
      if (children.length > 0) html += `<div class="ip-children">${children.map(ipRow).join('')}</div>`;
      return html;
    }).join('');
  }

  // Header
  const header = document.createElement('header');
  header.className = 'card-head';
  header.innerHTML = `
    <div class="who">
      ${avatarHtml}
      <div><div class="who-name">${escHtml(member.displayName)}</div></div>
    </div>
    <div class="inprogress">
      <div class="ip-label">In Progress <span class="count">${inProgress.length}</span></div>
      <div class="ip-list">${ipListHtml}</div>
    </div>`;
  card.appendChild(header);

  // Activity columns
  const columnsEl = document.createElement('div');
  columnsEl.className = 'columns';
  for (const col of COLUMNS) {
    columnsEl.appendChild(renderColumn(col, member, activities.filter(a => col.types.has(a.type)), card));
  }
  card.appendChild(columnsEl);

  // Stale (grouped)
  if (stale.length > 0) {
    const details = document.createElement('details');
    details.className = 'stale';
    const summary = document.createElement('summary');
    summary.innerHTML = `
      <svg class="chev" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      <span><b>Stale (${stale.length})</b> — assigned tickets not touched in 7+ days</span>`;
    details.appendChild(summary);

    const staleList = document.createElement('div');
    staleList.className = 'stale-list';

    const staleRow = iss => {
      const url = `${settings.jiraUrl}/browse/${iss.key}`;
      const lastChange = getLastStaleChange(iss);
      return `<div class="stale-row">
        <div>
          <div class="row-title">
            <a class="key" href="${url}" target="_blank" rel="noopener"><span class="it-icon ${itClass(iss.fields.issuetype?.name)}" aria-hidden="true"></span>${escHtml(iss.key)}</a>
            <a class="summary" href="${url}" target="_blank" rel="noopener">${escHtml(trunc(iss.fields.summary, 90))}</a>
          </div>
          ${lastChange ? `<div class="meta-line">${escHtml(trunc(lastChange, 140))}</div>` : ''}
        </div>
        <div class="time">${daysSince(new Date(iss.fields.updated))}d ago</div>
      </div>`;
    };

    for (const { issue, parentInfo, children } of groupByParent(stale)) {
      const group = document.createElement('div');
      let html = '';
      if (issue) {
        html += staleRow(issue);
      } else if (parentInfo) {
        html += `<div class="stale-row" style="opacity:.6">
          <div><div class="row-title">
            <span class="key" style="color:var(--text-3)">${escHtml(parentInfo.key)}</span>
            <span class="summary" style="color:var(--text-3)">${escHtml(trunc(parentInfo.fields?.summary || '', 90))}</span>
          </div></div>
        </div>`;
      }
      if (children.length > 0) html += `<div class="stale-children">${children.map(staleRow).join('')}</div>`;
      group.innerHTML = html;
      staleList.appendChild(group);
    }

    details.appendChild(staleList);
    card.appendChild(details);
  }

  return card;
}

function renderColumn(colDef, member, activities, card) {
  if (!columnFilters[member.accountId]) columnFilters[member.accountId] = {};
  if (!columnFilters[member.accountId][colDef.id]) columnFilters[member.accountId][colDef.id] = 'all';
  const activeTab = columnFilters[member.accountId][colDef.id];

  const counts = {};
  for (const a of activities) counts[a.type] = (counts[a.type] || 0) + 1;

  const col = document.createElement('section');
  col.className = 'col';
  col.dataset.col = colDef.id;

  const tabsHtml = colDef.filters.map(f => {
    const n = f.type === 'all' ? null : (counts[f.type] || 0);
    return `<button data-tab="${f.type}" aria-pressed="${activeTab === f.type}">${escHtml(f.label)}${n !== null ? `<span class="n">${n}</span>` : ''}</button>`;
  }).join('');

  col.innerHTML = `
    <div class="col-head">
      <span class="col-title">${escHtml(colDef.title)}</span>
      <span class="col-count">${activities.length}</span>
      <div class="col-actions">
        <button class="icon-btn" title="Refresh ${escHtml(colDef.title)}" aria-label="Refresh ${escHtml(colDef.title)}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        </button>
      </div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    <div class="rows"></div>`;

  col.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => toggleColumnFilter(member.accountId, colDef.id, btn.dataset.tab, col));
  });
  col.querySelector('.col-actions button').addEventListener('click', () => refreshColumn(member, colDef, col, card));

  const INITIAL_LIMIT = 8;
  const rowsEl = col.querySelector('.rows');
  if (activities.length === 0) {
    rowsEl.innerHTML = `<div class="empty">
      <div class="empty-ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M22 12h-6l-2 3h-4l-2-3H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11Z"/></svg>
      </div>
      No activity in this window
    </div>`;
  } else {
    for (const act of activities) {
      const item = renderFeedItem(act);
      if (activeTab !== 'all' && act.type !== activeTab) item.style.display = 'none';
      rowsEl.appendChild(item);
    }
    const allRows = [...rowsEl.querySelectorAll('.row')];
    if (allRows.length > INITIAL_LIMIT) {
      allRows.slice(INITIAL_LIMIT).forEach(r => r.classList.add('row-extra'));
      const showBtn = document.createElement('button');
      showBtn.className = 'show-more-btn';
      showBtn.textContent = `Show ${allRows.length - INITIAL_LIMIT} more`;
      showBtn.addEventListener('click', () => {
        rowsEl.querySelectorAll('.row-extra').forEach(r => r.classList.remove('row-extra'));
        showBtn.remove();
      });
      rowsEl.appendChild(showBtn);
    }
  }

  return col;
}

function toggleColumnFilter(userId, colId, type, colEl) {
  columnFilters[userId][colId] = type;
  colEl.querySelectorAll('.tabs button').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.tab === type ? 'true' : 'false');
  });
  colEl.querySelectorAll('.row').forEach(item => {
    item.style.display = (type === 'all' || item.dataset.type === type) ? '' : 'none';
  });
  const showBtn = colEl.querySelector('.show-more-btn');
  if (showBtn) {
    const hidden = [...colEl.querySelectorAll('.row.row-extra')].filter(r =>
      type === 'all' || r.dataset.type === type
    ).length;
    if (hidden === 0) {
      showBtn.style.display = 'none';
    } else {
      showBtn.style.display = '';
      showBtn.textContent = `Show ${hidden} more`;
    }
  }
}

function renderFeedItem(act) {
  const item = document.createElement('div');
  item.className = 'row';
  item.dataset.type = act.type;

  const badgeCls   = BADGE_CSS[act.type] || act.type;
  const badgeLabel = BADGE_LABELS[act.type] || act.type;
  const url        = act.issue.url;
  const keyHtml    = `<a class="key" href="${url}" target="_blank" rel="noopener"><span class="it-icon ${itClass(act.issue.type)}" aria-hidden="true"></span>${escHtml(act.issue.key)}</a>`;
  const sumHtml    = `<a class="summary" href="${url}" target="_blank" rel="noopener">${escHtml(trunc(act.issue.summary, 100))}</a>`;

  const d = act.detail;
  let detailHtml = '';
  const arrow = `<svg class="arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 5l7 7-7 7"/></svg>`;
  if (d) {
    if (act.type === 'status_change') {
      const byHtml = d.movedBy ? ` <span style="opacity:.65;font-size:.8em">by ${escHtml(d.movedBy)}</span>` : '';
      detailHtml = `<div class="row-detail"><span class="from">${escHtml(d.from)}</span>${arrow}<span class="to">${escHtml(d.to)}</span>${byHtml}</div>`;
    } else if (act.type === 'closed') {
      const byHtml = d.movedBy ? ` <span style="opacity:.65;font-size:.8em">by ${escHtml(d.movedBy)}</span>` : '';
      detailHtml = `<div class="row-detail"><span class="from">${escHtml(d.from)}</span>${arrow}<span class="to" style="background:var(--b-closed-bg);color:var(--b-closed-fg)">${escHtml(d.to)}</span>${byHtml}</div>`;
    } else if (act.type === 'comment') {
      detailHtml = `<div class="row-detail"><span class="quote">“${escHtml(d.preview || '')}”</span></div>`;
    } else if (act.type === 'mention') {
      detailHtml = `<div class="row-detail">Mentioned by <span class="mentioner">${escHtml(d.by)}</span> — <span class="quote">“${escHtml(d.preview || '')}”</span></div>`;
    }
  }

  item.innerHTML = `
    <span class="badge badge--${badgeCls}">${badgeLabel}</span>
    <div class="row-body">
      <div class="row-title">${keyHtml} ${sumHtml}</div>
      ${detailHtml}
    </div>
    <div class="time">${timeAbs(act.timestamp)}<span class="rel">${timeRel(act.timestamp)}</span></div>`;

  return item;
}

// ── Grouping ───────────────────────────────────────────────────────────────

function groupByParent(issues) {
  const inListKeys = new Set(issues.map(i => i.key));
  const placed = new Set();
  const result = [];

  for (const issue of issues) {
    if (placed.has(issue.key)) continue;
    const parentKey = issue.fields.parent?.key;
    if (parentKey && inListKeys.has(parentKey)) continue;
    placed.add(issue.key);
    const children = issues.filter(i => i.fields.parent?.key === issue.key);
    children.forEach(c => placed.add(c.key));
    result.push({ issue, parentInfo: null, children });
  }

  const orphanGroups = new Map();
  for (const issue of issues) {
    if (placed.has(issue.key)) continue;
    const pk = issue.fields.parent?.key;
    if (!orphanGroups.has(pk)) orphanGroups.set(pk, { parentInfo: issue.fields.parent, children: [] });
    orphanGroups.get(pk).children.push(issue);
  }
  for (const [, g] of orphanGroups) result.push({ issue: null, parentInfo: g.parentInfo, children: g.children });

  return result;
}

function getLastStaleChange(issue) {
  let latest = null;
  let desc = null;

  for (const history of (issue.changelog?.histories || [])) {
    const ts = new Date(history.created);
    if (!latest || ts > latest) {
      latest = ts;
      const item = history.items?.[0];
      if (item) {
        if (item.field === 'status') desc = `Status: ${item.fromString} → ${item.toString}`;
        else if (item.field === 'assignee') desc = `Assigned to ${item.toString || 'nobody'}`;
        else desc = `${item.field} changed`;
        if (history.author?.displayName) desc += ` by ${history.author.displayName}`;
      }
    }
  }

  for (const comment of (issue.fields.comment?.comments || [])) {
    const ts = new Date(comment.created);
    if (!latest || ts > latest) {
      latest = ts;
      const text = adfToText(comment.body);
      desc = `Comment by ${comment.author?.displayName || 'someone'}: ${text.substring(0, 100)}`;
    }
  }

  return desc;
}

// ── Utils ──────────────────────────────────────────────────────────────────

function avatarBg(idx) {
  const [a, b] = AVATAR_COLORS[idx % AVATAR_COLORS.length];
  return `linear-gradient(135deg, ${a} 0%, ${b} 100%)`;
}

function initials(name) {
  return (name || '').split(/\s+/).filter(Boolean).map(s => s[0]).slice(0, 2).join('').toUpperCase();
}

function itClass(typeName) {
  const n = (typeName || '').toLowerCase();
  if (n.includes('bug'))    return 'it-bug';
  if (n.includes('epic'))   return 'it-epic';
  if (n.includes('story'))  return 'it-story';
  if (n.includes('sub'))    return 'it-subtask';
  if (n.includes('improv')) return 'it-improve';
  return 'it-task';
}

function pillClass(status) {
  const s = (status || '').toLowerCase();
  if (/in progress|in review|cr/.test(s))       return 'pill--blue';
  if (/pending|to do|backlog|staging|qa/.test(s)) return 'pill--amber';
  if (/done|closed|resolved/.test(s))            return 'pill--green';
  return '';
}

function workingDaysCutoff(n) {
  const date = new Date();
  let counted = 0;
  while (counted < n) {
    date.setDate(date.getDate() - 1);
    const day = date.getDay();
    if (day !== 0 && day !== 6) counted++;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

function toJiraDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `"${y}-${m}-${d}"`;
}

function timeAbs(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function timeRel(date) {
  const m = (Date.now() - date.getTime()) / 60000;
  if (m < 1)    return 'just now';
  if (m < 60)   return `${Math.floor(m)}m ago`;
  if (m < 1440) return `${Math.floor(m / 60)}h ago`;
  return `${Math.floor(m / 1440)}d ago`;
}

function daysSince(date) {
  return Math.floor((Date.now() - date.getTime()) / 86400000);
}

function trunc(str, len) {
  if (!str) return '';
  return str.length > len ? str.substring(0, len) + '…' : str;
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showMessage(type, html) {
  document.getElementById('dashboard').innerHTML =
    `<div class="empty" style="padding:48px${type === 'error' ? ';color:oklch(0.46 0.18 25)' : ''}">${html}</div>`;
}

document.addEventListener('DOMContentLoaded', init);
