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

const { avatarHtml, commentHtml, escHtml, makeExpandableIfClamped } = UI;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const COLUMN_INITIAL_LIMIT = 8;

const ACTIVITY_LABELS = {
  created:       { label: 'Created',  cls: 'tc-spill--created' },
  self_assigned: { label: 'Assigned', cls: 'tc-spill--assigned' },
  status_change: { label: 'Moved',    cls: 'tc-spill--progress' },
  closed:        { label: 'Closed',   cls: 'tc-spill--default' },
};

const api = new JiraAPI();
let settings = null;
let currentPeriod = 3;
let currentView = 'team';
let lastUpdateTime = null;
const activeLane = { main: 'needs', eng: 'sec-dep' };
let supportTickets = [];
let supportTotal = 0;
let supportInternalFieldId = null;
let supportFolded = false;
let supportCache = null;
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

  const initialView = location.pathname === '/support' ? 'support' : 'team';
  currentView = initialView;
  applyView(initialView);

  window.addEventListener('popstate', e => {
    const v = e.state?.view || (location.pathname === '/support' ? 'support' : 'team');
    currentView = v;
    applyView(v);
    if (v === 'support') loadSupportBoard(); else loadDashboard();
  });

  document.querySelectorAll('.view-tabs button').forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  const foldBtn = document.getElementById('foldBtn');
  const FOLD_ICONS = {
    fold:   `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/></svg>`,
    unfold: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="4" rx="1"/><rect x="3" y="11" width="18" height="4" rx="1"/><rect x="3" y="17" width="18" height="4" rx="1"/></svg>`,
  };
  foldBtn.addEventListener('click', () => {
    supportFolded = !supportFolded;
    foldBtn.title = supportFolded ? 'Unfold all cards' : 'Fold all cards';
    foldBtn.setAttribute('aria-label', foldBtn.title);
    foldBtn.innerHTML = supportFolded ? FOLD_ICONS.unfold : FOLD_ICONS.fold;
    document.querySelectorAll('#support-board .tc').forEach(tc => {
      tc.dataset.open = supportFolded ? 'false' : 'true';
    });
  });

  document.getElementById('refreshBtn').addEventListener('click', () => {
    const btn = document.getElementById('refreshBtn');
    btn.classList.add('spin');
    if (currentView === 'support') {
      loadSupportBoard(true).finally(() => btn.classList.remove('spin'));
    } else {
      loadDashboard(true).finally(() => btn.classList.remove('spin'));
    }
  });

  setInterval(() => {
    if (!lastUpdateTime) return;
    const lu = document.getElementById('lastUpdated');
    if (lu) lu.textContent = timeRel(lastUpdateTime);
  }, 30000);

  if (initialView === 'support') loadSupportBoard(); else loadDashboard();
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

  const newCache = { activities: {}, currentAssignments: {}, staleByUser: {}, githubPRs: {} };
  for (const [idx, member] of settings.teamMembers.entries()) {
    try {
      const [data, ghData] = await Promise.all([
        fetchUserData(member, currentPeriod),
        fetchGithubPRs(member, currentPeriod),
      ]);
      if (currentView !== 'team') return;
      newCache.activities[member.accountId]         = data.activities;
      newCache.currentAssignments[member.accountId] = data.currentAssignment;
      newCache.staleByUser[member.accountId]        = data.stale;
      newCache.githubPRs[member.accountId]          = ghData;
      const card = renderUserCard(member, data.activities, data.currentAssignment, data.stale, ghData, idx);
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
        } else if (item.field === 'assignee' && item.to && teamIds.includes(item.to)) {
          const assignedBy = history.author?.displayName || null;
          byUser[item.to].push({ type: 'self_assigned', timestamp: ts, issue: info,
            detail: { by: assignedBy } });
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
        byUser[authorId].push({ type: 'comment', timestamp: ts, issue: info, detail: {
          body:         comment.body,
          text,
          authorName:   comment.author?.displayName || '',
          authorAvatar: comment.author?.avatarUrls?.['16x16'] || null,
        }});
      }
      for (const mentionedId of adfMentions(comment.body)) {
        if (mentionedId !== authorId && teamIds.includes(mentionedId)) {
          byUser[mentionedId].push({
            type: 'mention', timestamp: ts, issue: info,
            detail: {
              by:           comment.author?.displayName || 'Someone',
              body:         comment.body,
              text,
              authorAvatar: comment.author?.avatarUrls?.['16x16'] || null,
            },
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

async function refreshColumn(member, _colDef, colEl, card) {
  const rowsEl = colEl.querySelector('.rows');
  const btn    = colEl.querySelector('.col-actions button');
  btn.disabled = true;
  btn.classList.add('spin');
  if (rowsEl) rowsEl.innerHTML = '<div class="empty">Refreshing…</div>';

  try {
    const [userData, ghData] = await Promise.all([
      fetchUserData(member, currentPeriod),
      fetchGithubPRs(member, currentPeriod),
    ]);
    if (dataCache[currentPeriod]) {
      dataCache[currentPeriod].activities[member.accountId]         = userData.activities;
      dataCache[currentPeriod].currentAssignments[member.accountId] = userData.currentAssignment;
      dataCache[currentPeriod].staleByUser[member.accountId]        = userData.stale;
      dataCache[currentPeriod].githubPRs = dataCache[currentPeriod].githubPRs || {};
      dataCache[currentPeriod].githubPRs[member.accountId]          = ghData;
    }
    const memberIdx = settings.teamMembers.indexOf(member);
    const newCard = renderUserCard(member, userData.activities, userData.currentAssignment, userData.stale, ghData, memberIdx);
    card.replaceWith(newCard);
  } catch (err) {
    btn.disabled = false;
    btn.classList.remove('spin');
    if (rowsEl) rowsEl.innerHTML = `<div class="empty" style="color:var(--b-mention-fg)">Error: ${escHtml(err.message)}</div>`;
  }
}

async function refreshCodeColumn(member, colEl) {
  const rowsEl = colEl.querySelector('.rows');
  const btn    = colEl.querySelector('.col-actions button');
  btn.disabled = true;
  btn.classList.add('spin');
  if (rowsEl) rowsEl.innerHTML = '<div class="empty">Refreshing…</div>';

  try {
    const ghData = await fetchGithubPRs(member, currentPeriod);
    if (dataCache[currentPeriod]) {
      dataCache[currentPeriod].githubPRs = dataCache[currentPeriod].githubPRs || {};
      dataCache[currentPeriod].githubPRs[member.accountId] = ghData;
    }
    const newCol = renderCodeColumn(member, ghData);
    colEl.replaceWith(newCol);
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
  if (node.type === 'mention') return node.attrs?.text || '';
  if (node.content) return node.content.map(adfToText).join('');
  return '';
}

function adfToHtml(node) {
  if (!node) return '';
  const inner = () => (node.content || []).map(adfToHtml).join('');
  switch (node.type) {
    case 'doc':         return inner();
    case 'paragraph':   return `<p>${inner()}</p>`;
    case 'hardBreak':   return '<br>';
    case 'mention':     return `<span class="tc-mention">${escHtml(node.attrs?.text || '')}</span>`;
    case 'bulletList':  return `<ul>${inner()}</ul>`;
    case 'orderedList': return `<ol>${inner()}</ol>`;
    case 'listItem':    return `<li>${inner()}</li>`;
    case 'codeBlock':   return `<pre><code>${inner()}</code></pre>`;
    case 'blockquote':  return `<blockquote>${inner()}</blockquote>`;
    case 'heading':     return `<strong>${inner()}</strong>`;
    case 'inlineCard':  return `<a class="tc-mention" href="${escHtml(node.attrs?.url || '')}" target="_blank" rel="noopener">${escHtml(node.attrs?.url || '')}</a>`;
    case 'text': {
      let t = escHtml(node.text || '');
      for (const m of (node.marks || [])) {
        if (m.type === 'strong')      t = `<strong>${t}</strong>`;
        else if (m.type === 'em')     t = `<em>${t}</em>`;
        else if (m.type === 'code')   t = `<code>${t}</code>`;
        else if (m.type === 'link')   t = `<a href="${escHtml(m.attrs?.href || '')}" target="_blank" rel="noopener">${t}</a>`;
      }
      return t;
    }
    default: return inner();
  }
}

function adfMentions(node) {
  if (!node) return [];
  if (node.type === 'mention') return [node.attrs?.id].filter(Boolean);
  if (node.content) return node.content.flatMap(adfMentions);
  return [];
}

// ── Render ─────────────────────────────────────────────────────────────────

function renderDashboard({ activities, currentAssignments, staleByUser, githubPRs = {} }) {
  const container = document.getElementById('dashboard');
  container.innerHTML = '';
  for (const [idx, member] of settings.teamMembers.entries()) {
    container.appendChild(renderUserCard(
      member,
      activities[member.accountId] || [],
      currentAssignments[member.accountId],
      staleByUser[member.accountId] || [],
      githubPRs[member.accountId] || { prs: [], orphanCommits: [] },
      idx
    ));
  }
}

function renderUserCard(member, activities, assignment, stale, ghData = { prs: [], orphanCommits: [] }, memberIdx = 0) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.memberId = member.accountId;

  // Avatar
  const memberAvatarHtml = avatarHtml({
    name: member.displayName,
    avatarUrl: member.avatarUrl,
    className: 'avatar',
    colorIndex: memberIdx,
    alt: member.displayName,
  });

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
  const subHtml = member.label ? `<div class="who-sub">${escHtml(member.label)}</div>` : '';
  header.innerHTML = `
    <div class="who">
      ${memberAvatarHtml}
      <div><div class="who-name">${escHtml(member.displayName)}</div>${subHtml}</div>
    </div>
    <div class="inprogress">
      <div class="ip-label">In Progress <span class="count">${inProgress.length}</span></div>
      <div class="ip-list">${ipListHtml}</div>
    </div>`;
  card.appendChild(header);

  // Activity columns
  const columnsEl = document.createElement('div');
  columnsEl.className = settings.githubToken ? 'columns has-code' : 'columns';
  for (const col of COLUMNS) {
    columnsEl.appendChild(renderColumn(col, member, activities.filter(a => col.types.has(a.type)), card));
  }
  if (settings.githubToken) {
    columnsEl.appendChild(renderCodeColumn(member, ghData));
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
      return `<div class="stale-row ${issueRowClass(iss.fields.issuetype?.name)}">
        <div>
          <div class="row-title">
            <a class="key" href="${url}" target="_blank" rel="noopener">${escHtml(iss.key)}</a>
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
      rowsEl.appendChild(item);
    }
    if (activities.length > COLUMN_INITIAL_LIMIT) {
      const showBtn = document.createElement('button');
      showBtn.className = 'show-more-btn';
      showBtn.addEventListener('click', () => {
        const currentTab = col.querySelector('.tabs button[aria-pressed="true"]')?.dataset.tab || 'all';
        applyColumnFilterRows(col, currentTab, true);
      });
      rowsEl.appendChild(showBtn);
    }
    applyColumnFilterRows(col, activeTab);
  }

  return col;
}

function renderCodeColumn(member, { prs, orphanCommits }) {
  if (!columnFilters[member.accountId]) columnFilters[member.accountId] = {};
  if (!columnFilters[member.accountId]['code']) columnFilters[member.accountId]['code'] = 'all';
  const activeTab = columnFilters[member.accountId]['code'];

  const canSplit = prs.some(p => p.isAuthor !== null);
  const myPRs    = canSplit ? prs.filter(p => p.isAuthor)  : prs;
  const contrib  = canSplit ? prs.filter(p => !p.isAuthor) : [];
  const total    = prs.length + orphanCommits.reduce((n, g) => n + g.commits.length, 0);

  const filters = [
    { type: 'all',         label: 'All' },
    { type: 'pr',          label: 'PRs',            n: myPRs.length },
    { type: 'contributed', label: 'Contributed to', n: contrib.length },
    { type: 'branch',      label: 'Branches',       n: orphanCommits.length },
  ];

  const tabsHtml = filters.map(f => {
    const badge = f.n != null ? `<span class="n">${f.n}</span>` : '';
    return `<button data-tab="${f.type}" aria-pressed="${activeTab === f.type}">${escHtml(f.label)}${badge}</button>`;
  }).join('');

  const ghHref = member.githubUsername
    ? `https://github.com/${member.githubUsername}`
    : 'https://github.com/scalr';

  const col = document.createElement('section');
  col.className = 'col';
  col.dataset.col = 'code';

  col.innerHTML = `
    <div class="col-head">
      <span class="col-title">Code</span>
      <span class="col-count">${total}</span>
      <div class="col-actions">
        <a href="${escHtml(ghHref)}" target="_blank" rel="noopener" class="icon-btn" title="Open GitHub" aria-label="Open GitHub">
          <svg viewBox="0 0 24 24" fill="currentColor" stroke="none" width="14" height="14"><path d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.531 1.032 1.531 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0 1 12 6.844a9.59 9.59 0 0 1 2.504.337c1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.02 10.02 0 0 0 22 12.017C22 6.484 17.522 2 12 2Z"/></svg>
        </a>
        <button class="icon-btn" title="Refresh Code" aria-label="Refresh Code">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 3v6h-6"/></svg>
        </button>
      </div>
    </div>
    <div class="tabs">${tabsHtml}</div>
    <div class="rows"></div>`;

  col.querySelectorAll('.tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      columnFilters[member.accountId]['code'] = btn.dataset.tab;
      applyCodeColumnFilter(col, btn.dataset.tab);
    });
  });

  col.querySelector('.col-actions button').addEventListener('click', () => refreshCodeColumn(member, col));

  const rowsEl = col.querySelector('.rows');

  if (total === 0) {
    const hint = member.githubUsername ? '' : ' — set a GitHub username in Settings';
    rowsEl.innerHTML = `<div class="empty">
      <div class="empty-ico">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/></svg>
      </div>
      No activity in this window${escHtml(hint)}
    </div>`;
    return col;
  }

  for (const pr of myPRs) {
    const item = renderPRItem(pr);
    item.dataset.type = 'pr';
    rowsEl.appendChild(item);
  }

  for (const pr of contrib) {
    const item = renderPRItem(pr);
    item.dataset.type = 'contributed';
    rowsEl.appendChild(item);
  }

  for (const group of orphanCommits) {
    const item = renderOrphanGroup(group);
    item.dataset.type = 'branch';
    rowsEl.appendChild(item);
  }

  const showBtn = document.createElement('button');
  showBtn.className = 'show-more-btn';
  showBtn.addEventListener('click', () => applyCodeColumnFilter(col, columnFilters[member.accountId]['code'], true));
  rowsEl.appendChild(showBtn);

  applyCodeColumnFilter(col, activeTab);
  return col;
}

function applyCodeColumnFilter(colEl, type, revealAll = false) {
  colEl.querySelectorAll('.tabs button').forEach(btn =>
    btn.setAttribute('aria-pressed', btn.dataset.tab === type ? 'true' : 'false')
  );

  const rows     = [...colEl.querySelectorAll('.row')];
  const matching = rows.filter(r => type === 'all' || r.dataset.type === type);

  rows.forEach(r => {
    r.classList.remove('row-extra');
    r.style.display = (type === 'all' || r.dataset.type === type) ? '' : 'none';
  });

  const hidden = revealAll ? [] : matching.slice(COLUMN_INITIAL_LIMIT);
  hidden.forEach(r => r.classList.add('row-extra'));

  const showBtn = colEl.querySelector('.show-more-btn');
  if (showBtn) {
    showBtn.style.display = hidden.length === 0 ? 'none' : '';
    if (hidden.length > 0) showBtn.textContent = `Show ${hidden.length} more`;
  }
}

function renderPRItem(pr) {
  const item = document.createElement('div');
  const authorshipCls = pr.isAuthor === true ? 'pr-row--authored' : pr.isAuthor === false ? 'pr-row--contrib' : '';
  item.className = ['row', 'pr-row', authorshipCls].filter(Boolean).join(' ');
  item.dataset.state = pr.state;

  const stateClass = pr.state === 'merged' ? 'mpill--merged' : pr.state === 'open' ? 'mpill--to' : 'mpill--from';
  const stateLabel = pr.state === 'merged' ? 'Merged' : pr.state === 'open' ? 'Open' : 'Closed';

  const branchHtml = pr.branch
    ? `<span class="pr-branch"><svg viewBox="0 0 16 16" fill="currentColor" width="10" height="10" aria-hidden="true"><path d="M9.5 3.25a2.25 2.25 0 1 1 3 2.122V6A2.5 2.5 0 0 1 10 8.5H6a1 1 0 0 0-1 1v1.128a2.251 2.251 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.5 0v1.836A2.493 2.493 0 0 1 6 7h4a1 1 0 0 0 1-1v-.628A2.25 2.25 0 0 1 9.5 3.25Zm-6 0a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Zm8.25-.75a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5ZM4.25 12a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Z"/></svg>${escHtml(pr.branch)}</span>`
    : '';

  const authorshipHtml = pr.isAuthor === true
    ? `<span class="mpill mpill--authored">Authored</span>`
    : pr.isAuthor === false
      ? `<span class="mpill mpill--contrib">Contributed</span>`
      : '';

  item.innerHTML = `
    <div class="row-top">
      <a class="row-sum" href="${escHtml(pr.url)}" target="_blank" rel="noopener">${escHtml(trunc(pr.title, 100))}</a>
      <span class="row-time" title="${escHtml(timeAbs(pr.createdAt))}">${timeRel(pr.createdAt)}</span>
    </div>
    <div class="row-meta">
      <span class="pr-repo">${escHtml(pr.repo)}</span>
      ${branchHtml}
      <span class="mpill ${stateClass}">${stateLabel}</span>
      ${authorshipHtml}
    </div>`;

  return item;
}

function renderOrphanGroup(group) {
  const el = document.createElement('div');
  el.className = 'row orphan-group';

  const commitsHtml = group.commits.map(c => `
    <div class="orphan-commit">
      <a class="orphan-sha" href="${escHtml(c.url)}" target="_blank" rel="noopener">${escHtml(c.sha)}</a>
      <a class="orphan-msg" href="${escHtml(c.url)}" target="_blank" rel="noopener">${escHtml(trunc(c.message, 80))}</a>
      <span class="row-time">${timeRel(c.date)}</span>
    </div>`).join('');

  el.innerHTML = `
    <div class="row-meta" style="margin-bottom:6px">
      <span class="pr-repo">${escHtml(group.repo)}</span>
      <span class="mpill mpill--from">No PR</span>
      <span class="orphan-count">${group.commits.length} commit${group.commits.length !== 1 ? 's' : ''}</span>
    </div>
    <div class="orphan-commits">${commitsHtml}</div>`;

  return el;
}

function toggleColumnFilter(userId, colId, type, colEl) {
  columnFilters[userId][colId] = type;
  colEl.querySelectorAll('.tabs button').forEach(btn => {
    btn.setAttribute('aria-pressed', btn.dataset.tab === type ? 'true' : 'false');
  });
  applyColumnFilterRows(colEl, type);
}

function applyColumnFilterRows(colEl, type, revealAll = false) {
  const rows = [...colEl.querySelectorAll('.row')];
  const matchingRows = rows.filter(item => type === 'all' || item.dataset.type === type);

  rows.forEach(item => {
    const matches = type === 'all' || item.dataset.type === type;
    item.classList.remove('row-extra');
    item.style.display = matches ? '' : 'none';
  });

  const hiddenRows = revealAll ? [] : matchingRows.slice(COLUMN_INITIAL_LIMIT);
  hiddenRows.forEach(item => item.classList.add('row-extra'));

  const showBtn = colEl.querySelector('.show-more-btn');
  if (showBtn) {
    if (hiddenRows.length === 0) {
      showBtn.style.display = 'none';
    } else {
      showBtn.style.display = '';
      showBtn.textContent = `Show ${hiddenRows.length} more`;
    }
  }
}

function renderFeedItem(act) {
  const item = document.createElement('div');
  item.className = `row ${issueRowClass(act.issue.type)}`;
  item.dataset.type = act.type;

  const url     = act.issue.url;
  const keyHtml = `<a class="key" href="${url}" target="_blank" rel="noopener">${escHtml(act.issue.key)}</a>`;

  const d = act.detail;
  const titleLine = `
    <div class="row-top">
      ${keyHtml}
      <a class="row-sum" href="${url}" target="_blank" rel="noopener">${escHtml(trunc(act.issue.summary, 100))}</a>
      <span class="row-time" title="${escHtml(timeAbs(act.timestamp))}">${timeRel(act.timestamp)}</span>
    </div>`;

  // Comments and mentions → styled block like support board
  if (act.type === 'comment' || act.type === 'mention') {
    const authorName   = d?.authorName || d?.by || '';
    const authorAvatar = d?.authorAvatar || null;
    const text         = d?.text || '';
    const bodyHtml     = (d?.body ? adfToHtml(d.body) : null) || escHtml(text);

    item.innerHTML = titleLine;
    const block = document.createElement('div');
    block.className = 'tc-comment';
    block.innerHTML = commentHtml({
      author: authorName,
      avatarUrl: authorAvatar,
      bodyHtml,
    });
    makeExpandableIfClamped(block);
    item.appendChild(block);
    return item;
  }

  // Status / created / assigned → meta line with pills
  let metaDetail = '';
  if (d) {
    if (act.type === 'status_change') {
      const byHtml = d.movedBy ? ` <span class="row-by">by ${escHtml(d.movedBy)}</span>` : '';
      metaDetail = `<span class="mpill mpill--from">${escHtml(d.from)}</span><span class="arr">→</span><span class="mpill mpill--to">${escHtml(d.to)}</span>${byHtml}`;
    } else if (act.type === 'closed') {
      const byHtml = d.movedBy ? ` <span class="row-by">by ${escHtml(d.movedBy)}</span>` : '';
      metaDetail = `<span class="mpill mpill--from">${escHtml(d.from)}</span><span class="arr">→</span><span class="mpill mpill--closed">${escHtml(d.to)}</span>${byHtml}`;
    } else if (act.type === 'self_assigned' && d.by) {
      metaDetail = `<span class="row-by">by ${escHtml(d.by)}</span>`;
    }
  }

  const labelHtml = activityBadgeHtml(act.type);
  const metaLine  = labelHtml || metaDetail ? `\n    <div class="row-meta">${labelHtml}${metaDetail}</div>` : '';
  item.innerHTML = titleLine + metaLine;

  return item;
}

function activityBadgeHtml(type, extraClass = '') {
  const badge = ACTIVITY_LABELS[type];
  if (!badge) return '';
  const cls = ['tc-spill', badge.cls, extraClass].filter(Boolean).join(' ');
  return `<span class="${cls}">${escHtml(badge.label)}</span>`;
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

function issueTypeClass(typeName) {
  const n = (typeName || '').toLowerCase();
  if (n.includes('bug'))    return 'bug';
  if (n.includes('epic'))   return 'epic';
  if (n.includes('story'))  return 'story';
  if (n.includes('sub'))    return 'subtask';
  if (n.includes('improv')) return 'improve';
  return 'task';
}

function itClass(typeName) {
  return `it-${issueTypeClass(typeName)}`;
}

function issueRowClass(typeName) {
  return `issue-${issueTypeClass(typeName)}`;
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

function isoDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function fetchGithubPRs(member, days) {
  const empty = { prs: [], orphanCommits: [] };
  if (!settings.githubToken) return empty;

  const cutoff  = workingDaysCutoff(days);
  const dateStr = isoDate(cutoff);
  const ghUser  = (member.githubUsername || '').toLowerCase();
  const authorQ = member.githubUsername
    ? `author:${member.githubUsername}`
    : `author-email:${member.email}`;

  // Run both searches in parallel:
  // - GraphQL for authored PRs: two aliased searches in one request —
  //   "open" catches all open PRs regardless of activity date,
  //   "recent" catches closed/merged PRs updated within the window.
  // - REST commit search for contributed (non-authored) PRs
  const GQL_PR_FIELDS = `number title url state mergedAt createdAt headRefName repository{name} author{login}`;
  const GQL_AUTHORED  = `query($open:String!,$recent:String!){
    open:   search(query:$open,   type:ISSUE, first:20){nodes{...on PullRequest{${GQL_PR_FIELDS}}}}
    recent: search(query:$recent, type:ISSUE, first:20){nodes{...on PullRequest{${GQL_PR_FIELDS}}}}
  }`;

  const [commitsRes, authoredRes] = await Promise.all([
    fetch(`/api/github/search/commits?q=${encodeURIComponent(`${authorQ} org:scalr committer-date:>=${dateStr}`)}&per_page=30&sort=committer-date&order=desc`),
    member.githubUsername
      ? fetch('/api/github/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            query: GQL_AUTHORED,
            variables: {
              open:   `is:open   type:pr org:scalr author:${member.githubUsername}`,
              recent: `is:closed type:pr org:scalr author:${member.githubUsername} updated:>=${dateStr}`,
            },
          }),
        })
      : Promise.resolve(null),
  ]);

  const commitsData  = commitsRes.ok ? await commitsRes.json() : { items: [] };
  const authoredData = authoredRes?.ok ? await authoredRes.json() : null;

  const commits = (commitsData.items || []).slice(0, 25);
  const authoredNodes = [
    ...(authoredData?.data?.open?.nodes   || []),
    ...(authoredData?.data?.recent?.nodes || []),
  ];

  const prMap       = new Map();
  const claimedShas = new Set();

  // Authored PRs from GraphQL — branch name already included, no extra calls needed
  for (const pr of authoredNodes) {
    prMap.set(pr.url, {
      number:    pr.number,
      title:     pr.title,
      url:       pr.url,
      repo:      pr.repository.name,
      branch:    pr.headRefName || '',
      state:     pr.mergedAt ? 'merged' : pr.state.toLowerCase(),
      author:    pr.author?.login || '',
      isAuthor:  true,
      createdAt: new Date(pr.createdAt),
    });
  }

  // Commit-based lookup for contributed (non-authored) PRs
  // Note: GitHub only returns merged PRs via this endpoint — open contributed PRs are not detectable
  await Promise.all(commits.map(async commit => {
    const repoFull = commit.repository.full_name;
    const sha      = commit.sha;
    try {
      const res = await fetch(`/api/github/repos/${repoFull}/commits/${sha}/pulls`);
      if (!res.ok) return;
      const prs = await res.json();
      if (prs.length > 0) claimedShas.add(sha);
      for (const pr of prs) {
        if (prMap.has(pr.html_url)) continue;
        const prAuthor = (pr.user?.login || '').toLowerCase();
        prMap.set(pr.html_url, {
          number:    pr.number,
          title:     pr.title,
          url:       pr.html_url,
          repo:      repoFull.split('/').pop(),
          branch:    pr.head?.ref || '',
          state:     pr.merged_at ? 'merged' : pr.state,
          author:    pr.user?.login || '',
          isAuthor:  ghUser ? ghUser === prAuthor : null,
          createdAt: new Date(pr.created_at),
        });
      }
    } catch {}
  }));

  // Orphan commits: unclaimed by any merged PR
  // Skip repos where the user already has an open PR (commits are likely part of it)
  const openAuthoredRepos = new Set(
    [...prMap.values()].filter(p => p.isAuthor && p.state === 'open').map(p => p.repo)
  );

  const orphanByRepo = new Map();
  for (const commit of commits) {
    if (claimedShas.has(commit.sha)) continue;
    const full     = commit.repository.full_name;
    const repoName = full.split('/').pop();
    if (openAuthoredRepos.has(repoName)) continue;
    if (!orphanByRepo.has(full)) orphanByRepo.set(full, { repo: repoName, commits: [] });
    orphanByRepo.get(full).commits.push({
      sha:     commit.sha.slice(0, 7),
      message: commit.commit.message.split('\n')[0],
      url:     commit.html_url,
      date:    new Date(commit.commit.author.date),
    });
  }

  return {
    prs:           [...prMap.values()].sort((a, b) => b.createdAt - a.createdAt),
    orphanCommits: [...orphanByRepo.values()],
  };
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

function showMessage(type, html) {
  document.getElementById('dashboard').innerHTML =
    `<div class="empty" style="padding:48px${type === 'error' ? ';color:oklch(0.46 0.18 25)' : ''}">${html}</div>`;
}

// ── Support board ──────────────────────────────────────────────────────────

function applyView(view) {
  const titles = { team: 'Team Activity', support: 'Support Board' };
  document.title = titles[view] || 'Team Activity';
  document.getElementById('brandTitle').textContent = titles[view] || 'Team Activity';
  document.querySelectorAll('.view-tabs button').forEach(b =>
    b.setAttribute('aria-pressed', b.dataset.view === view ? 'true' : 'false'));
  document.getElementById('dashboard').hidden         = view === 'support';
  document.getElementById('support-board').hidden     = view === 'team';
  document.getElementById('timeRange').hidden = view === 'support';
  document.getElementById('foldBtn').hidden   = view === 'team';
}

function switchView(view) {
  if (view === currentView) return;
  currentView = view;
  history.pushState({ view }, '', view === 'support' ? '/support' : '/team');
  applyView(view);
  if (view === 'support') loadSupportBoard(); else loadDashboard();
}

function syncSupportCache() {
  supportCache = {
    tickets: supportTickets,
    total: supportTotal,
    internalFieldId: supportInternalFieldId,
  };
}

function restoreSupportFromCache() {
  supportTickets = supportCache.tickets;
  supportTotal = supportCache.total;
  supportInternalFieldId = supportCache.internalFieldId;
}

async function loadSupportBoard(forceRefresh = false) {
  const board = document.getElementById('support-board');

  if (!forceRefresh && supportCache) {
    restoreSupportFromCache();
    if (supportTickets.length === 0 && supportTotal === 0) {
      board.innerHTML = '<div class="sb-empty">No open support items.</div>';
      return;
    }
    renderSupportBoardUI(board);
    return;
  }

  supportTickets = [];
  supportTotal = 0;
  supportInternalFieldId = null;
  board.innerHTML = '<div class="sb-empty">Loading…</div>';
  try {
    const data = await fetchSupportData(0);
    if (currentView !== 'support') return;
    supportInternalFieldId = data.internalFieldId;
    supportTotal = data.total;
    supportTickets = data.issues.map(i => normalizeTicket(i, data.internalFieldId));
    syncSupportCache();
    if (supportTickets.length === 0 && supportTotal === 0) {
      board.innerHTML = '<div class="sb-empty">No open support items.</div>';
      return;
    }
    renderSupportBoardUI(board);
  } catch (err) {
    board.innerHTML = `<div class="sb-empty" style="color:var(--b-mention-fg)">Failed: ${escHtml(err.message)}</div>`;
  }
}

const SUPPORT_PAGE_SIZE = 100;

async function fetchSupportData(startAt) {
  const fields = await api.getFields();
  const internalField = Array.isArray(fields)
    ? fields.find(f => f.name.toLowerCase().startsWith('internal status'))
    : null;
  const internalFieldId = internalField?.id || null;

  const issueFields = ['summary', 'status', 'assignee', 'issuetype', 'labels', 'updated', 'created', 'project', 'comment', 'priority', 'duedate', 'issuelinks'];
  if (internalFieldId) issueFields.push(internalFieldId);

  const jql = '('
    + '(project = CLOUD AND issuetype not in (Epic) AND statusCategory != Done)'
    + ' OR (project = SCALRCORE AND labels in (EST, Dependabot) AND statusCategory != Done)'
    + ' OR (project = SCALRCORE AND issuetype in (Security, "Security Issue") AND statusCategory != Done)'
    + ') ORDER BY updated DESC';

  const result = await api._get('/search/jql', {
    jql,
    fields: issueFields.join(','),
    expand: 'changelog',
    startAt,
    maxResults: SUPPORT_PAGE_SIZE,
  });
  const existingKeys = new Set(supportTickets.map(t => t.key));
  const issues = (result.issues || []).filter(i => !existingKeys.has(i.key));
  return { issues, total: result.total || 0, internalFieldId };
}

function getSupportCategory(issue) {
  const type   = (issue.fields.issuetype?.name || '').toLowerCase();
  const labels = (issue.fields.labels || []).map(l => l.toLowerCase());
  if (type === 'security' || type === 'security issue' || labels.includes('security') || labels.includes('dependabot')) return 'security';
  if (labels.includes('est')) return 'est';
  return 'cloud';
}

function normalizeTicket(issue, internalFieldId) {
  const cat    = getSupportCategory(issue);
  const status = issue.fields.status?.name || '';

  let internalText = '';
  if (internalFieldId) {
    const val = issue.fields[internalFieldId];
    if (typeof val === 'string') internalText = val;
    else if (val?.value) internalText = val.value;
    else if (val?.type === 'doc') internalText = adfToText(val);
  }

  const comments = issue.fields.comment?.comments || [];
  const lastCommentRaw = comments.length ? comments[comments.length - 1] : null;
  const lastComment = lastCommentRaw ? {
    text:      adfToText(lastCommentRaw.body).trim(),
    html:      adfToHtml(lastCommentRaw.body).trim(),
    author:    lastCommentRaw.author?.displayName || '',
    avatarUrl: lastCommentRaw.author?.avatarUrls?.['16x16'] || null,
    date:      new Date(lastCommentRaw.created),
  } : null;

  const histories = issue.changelog?.histories || [];

  const lastTransition = histories
    .flatMap(h => h.items
      .filter(i => i.field === 'status')
      .map(i => ({ from: i.fromString, to: i.toString, author: h.author?.displayName || '', created: h.created }))
    )
    .sort((a, b) => new Date(b.created) - new Date(a.created))[0] || null;

  // Always include the most recent changelog entry (any type), then fill up to 3
  // with status/link events — ensures the "updated Xd ago" timestamp is always explained
  const recentActivities = [];
  const sortedH = [...histories].sort((a, b) => new Date(b.created) - new Date(a.created));

  if (sortedH.length > 0) {
    const h = sortedH[0];
    const item = h.items[0];
    if (item) {
      const av = h.author?.avatarUrls?.['16x16'] || null;
      if (item.field === 'status') {
        recentActivities.push({ type: 'transition', actor: h.author?.displayName || '', actorAvatar: av, from: item.fromString, to: item.toString, created: h.created });
      } else if (item.field === 'Link' || item.fieldId === 'issuelinks') {
        const m = (item.toString || item.fromString || '').match(/([A-Z]+-\d+)/);
        recentActivities.push({ type: 'link', actor: h.author?.displayName || '', actorAvatar: av, key: m ? m[1] : (item.toString || ''), created: h.created });
      } else {
        recentActivities.push({ type: 'change', actor: h.author?.displayName || '', actorAvatar: av, field: item.field || 'updated', created: h.created });
      }
    }
  }

  for (const h of sortedH.slice(1)) {
    if (recentActivities.length >= 3) break;
    const av = h.author?.avatarUrls?.['16x16'] || null;
    for (const item of h.items) {
      let act = null;
      if (item.field === 'status') {
        act = { type: 'transition', actor: h.author?.displayName || '', actorAvatar: av, from: item.fromString, to: item.toString, created: h.created };
      } else if (item.field === 'Link' || item.fieldId === 'issuelinks') {
        const m = (item.toString || item.fromString || '').match(/([A-Z]+-\d+)/);
        act = { type: 'link', actor: h.author?.displayName || '', actorAvatar: av, key: m ? m[1] : (item.toString || ''), created: h.created };
      }
      if (act) { recentActivities.push(act); break; }
    }
  }

  // Last activity by a support team member (comment or any changelog entry)
  const teamIds = new Set((settings.teamMembers || []).map(m => m.accountId));
  const supportDomain = (settings.supportDomain || 'scalr.com').toLowerCase();

  function isSupportAuthor(author) {
    if (!author) return false;
    if (author.emailAddress?.toLowerCase().endsWith('@' + supportDomain)) return true;
    return teamIds.has(author.accountId);
  }

  const supportEvents = [];
  for (const c of comments) {
    if (isSupportAuthor(c.author)) {
      supportEvents.push({ label: 'commented', author: c.author.displayName || '', date: new Date(c.created) });
    }
  }
  for (const h of histories) {
    if (!isSupportAuthor(h.author)) continue;
    const item = h.items[0];
    let label = 'made a change';
    if (item) {
      if (item.fieldId === 'status' || item.field === 'status') label = `moved → ${item.toString}`;
      else if (internalFieldId && item.fieldId === internalFieldId) label = 'updated internal status';
      else if (item.field?.toLowerCase().includes('link')) label = 'linked a ticket';
      else label = item.field || 'made a change';
    }
    supportEvents.push({ label, author: h.author.displayName || '', date: new Date(h.created) });
  }
  supportEvents.sort((a, b) => b.date - a.date);
  const lastSupportActivity = supportEvents[0] || null;

  // TODO: extract Scalr account name (customer) from the appropriate custom field once
  // the field ID is known. Add the field ID to issueFields in fetchSupportData, then:
  //   const scalrAccount = issue.fields[SCALR_ACCOUNT_FIELD_ID]?.value || issue.fields[SCALR_ACCOUNT_FIELD_ID] || null;
  // and include it in the returned object as `scalrAccount`.

  const updatedDate = new Date(issue.fields.updated);
  const createdDate = new Date(issue.fields.created);

  return {
    key:           issue.key,
    summary:       issue.fields.summary || '',
    status,
    cat,
    issuetype:     issue.fields.issuetype?.name || '',
    project:       issue.fields.project?.key || '',
    priority:      issue.fields.priority?.name || '',
    dependabotRepo: (issue.fields.labels || []).some(l => l.toLowerCase() === 'dependabot')
      ? ((issue.fields.summary || '').match(/\bScalr\/([^\s/,)]+)/i) || [])[1] || null
      : null,
    dueDate: issue.fields.duedate ? new Date(issue.fields.duedate) : null,
    linkedScalrcore: cat === 'cloud'
      ? (issue.fields.issuelinks || [])
          .map(lnk => lnk.outwardIssue || lnk.inwardIssue)
          .filter(li => li && /^SCALRCORE-/i.test(li.key))
          .map(li => ({
            key:     li.key,
            summary: li.fields?.summary || '',
            status:  li.fields?.status?.name || '',
            url:     `${settings.jiraUrl}/browse/${li.key}`,
          }))
      : [],
    assignee:      issue.fields.assignee?.displayName || null,
    assigneeAvatar: issue.fields.assignee?.avatarUrls?.['24x24'] || null,
    updatedDate,
    days:          daysSince(updatedDate),
    createdDate,
    createdDays:   daysSince(createdDate),
    internalText,
    lastComment,
    lastTransition,
    lastSupportActivity,
    scalrAccount:      null, // TODO: populate from custom field (see note above)
    recentActivities,
    url:           `${settings.jiraUrl}/browse/${issue.key}`,
  };
}

function laneOf(ticket) {
  if (/waiting for support/i.test(ticket.status))  return 'needs';
  if (/waiting for customer/i.test(ticket.status)) return 'waiting';
  if (ticket.days >= 60) return 'stale';
  if (ticket.days >= 14) return 'aging';
  return 'inprog';
}

function urgencyScore(ticket) {
  let score = ticket.days;
  if (ticket.cat === 'security')          score += 50;
  const p = ticket.priority.toLowerCase();
  if (p.includes('highest'))              score += 40;
  else if (p.includes('high'))            score += 20;
  return score;
}

function timeBadgeClass(days) {
  if (days === 0) return 'tc-time--today';
  if (days < 7)   return 'tc-time--fresh';
  if (days < 14)  return 'tc-time--ok';
  if (days < 30)  return 'tc-time--aging';
  return 'tc-time--stale';
}


function priorityIconHtml(priority) {
  const p = (priority || '').toLowerCase();
  let label, cls;
  if (p.includes('highest'))     { label = 'P0'; cls = 'tc-prio--p0'; }
  else if (p.includes('high'))   { label = 'P1'; cls = 'tc-prio--p1'; }
  else if (p.includes('lowest')) { label = 'P4'; cls = 'tc-prio--p4'; }
  else if (p.includes('low'))    { label = 'P3'; cls = 'tc-prio--p3'; }
  else                           { label = 'P2'; cls = 'tc-prio--p2'; }
  return `<span class="tc-prio-badge ${cls}">${label}</span>`;
}

function shortenStatus(s) {
  return (s || '').replace(/waiting for support/i, 'Support').replace(/waiting for customer/i, 'Customer');
}

function statusToPillClass(status) {
  if (/waiting for support/i.test(status))   return 'tc-spill--waiting';
  if (/waiting for customer/i.test(status))  return 'tc-spill--customer';
  if (/in progress|in review|cr\b/i.test(status)) return 'tc-spill--progress';
  return 'tc-spill--default';
}

const LANES_CONFIG = [
  { id: 'needs',   title: 'Support',              open: true  },
  { id: 'aging',   title: 'Aging (14 – 59 days)', open: true  },
  { id: 'inprog',  title: 'In Progress',          open: true  },
  { id: 'waiting', title: 'Customer',             open: false },
  { id: 'stale',   title: 'Stale (60+ days)',     open: false },
];

function renderSupportBoardUI(board) {
  const cloudTickets = supportTickets.filter(t => t.cat === 'cloud');
  const engTickets   = supportTickets.filter(t => t.cat !== 'cloud');

  board.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'sb-grid';

  const makeCol = (label, { tabs, content }) => {
    const col = document.createElement('div');
    col.className = 'sb-col';
    const header = document.createElement('div');
    header.className = 'sb-col-header';
    const titleEl = document.createElement('span');
    titleEl.className = 'sb-col-title';
    titleEl.textContent = label;
    header.appendChild(titleEl);
    header.appendChild(tabs);
    col.appendChild(header);
    col.appendChild(content);
    return col;
  };

  grid.appendChild(makeCol('Cloud', renderLaneTabsEl(cloudTickets, 'main', ['needs', 'aging', 'inprog', 'waiting'])));
  grid.appendChild(makeCol('Engineering', renderEngColumn(engTickets)));
  board.appendChild(grid);

  if (supportTickets.length < supportTotal) {
    const remaining = supportTotal - supportTickets.length;
    const btn = document.createElement('button');
    btn.className = 'sb-load-more';
    btn.textContent = `Load ${remaining} more ticket${remaining !== 1 ? 's' : ''}`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      btn.textContent = 'Loading…';
      try {
        const data = await fetchSupportData(supportTickets.length);
        const newTickets = data.issues.map(i => normalizeTicket(i, supportInternalFieldId));
        supportTickets = [...supportTickets, ...newTickets];
        supportTotal = data.total;
        syncSupportCache();
        renderSupportBoardUI(board);
      } catch (err) {
        btn.disabled = false;
        btn.textContent = `Failed — retry`;
      }
    });
    board.appendChild(btn);
  }
}

const ENG_SECTIONS = [
  { id: 'sec-dep',   title: 'Security & Dependabot', filter: t => t.cat === 'security' },
  { id: 'pickup',    title: 'To Pick Up',             filter: t => t.cat === 'est' && /to do|backlog|ready|new|open/i.test(t.status) },
  { id: 'inprog',    title: 'In Progress',            filter: t => t.cat !== 'cloud' && /in progress|in review|cr\b|wip|review/i.test(t.status) },
];

function renderEngColumn(tickets) {
  if (!ENG_SECTIONS.some(s => s.id === activeLane.eng)) activeLane.eng = ENG_SECTIONS[0].id;

  const tabBar = document.createElement('div');
  tabBar.className = 'sb-lane-tabs';
  for (const sec of ENG_SECTIONS) {
    const count = tickets.filter(sec.filter).length;
    const isActive = sec.id === activeLane.eng;
    const btn = document.createElement('button');
    btn.className = 'sb-lane-tab lane--' + sec.id + (isActive ? ' sb-lane-tab--active' : '');
    btn.innerHTML = `<span class="lane-dot"></span>${escHtml(sec.title)}<span class="n">${count}</span>`;
    btn.addEventListener('click', () => {
      activeLane.eng = sec.id;
      renderSupportBoardUI(document.getElementById('support-board'));
    });
    tabBar.appendChild(btn);
  }
  const activeSec = ENG_SECTIONS.find(s => s.id === activeLane.eng);
  const secTickets = tickets.filter(activeSec.filter).sort((a, b) => a.days - b.days);

  const content = document.createElement('div');
  content.className = 'sb-lane-content';

  if (secTickets.length === 0) {
    content.innerHTML = '<div class="sb-lane-empty">No tickets in this section</div>';
  } else if (activeSec.id === 'sec-dep') {
    const addSubcat = label => {
      const el = document.createElement('div');
      el.className = 'sb-subcat';
      el.textContent = label;
      content.appendChild(el);
    };
    const securityTickets   = secTickets.filter(t => t.dependabotRepo === null);
    const dependabotTickets = secTickets.filter(t => t.dependabotRepo !== null);
    const repoGroups = {};
    for (const t of dependabotTickets) {
      const key = t.dependabotRepo || 'Other';
      (repoGroups[key] = repoGroups[key] || []).push(t);
    }
    if (securityTickets.length > 0) {
      addSubcat('Security');
      for (const t of securityTickets) content.appendChild(renderTicketRow(t));
    }
    for (const [repo, repoTickets] of Object.entries(repoGroups).sort()) {
      addSubcat(repo);
      for (const t of repoTickets) content.appendChild(renderTicketRow(t));
    }
  } else {
    const INITIAL = 10;
    for (const ticket of secTickets.slice(0, INITIAL)) content.appendChild(renderTicketRow(ticket));
    if (secTickets.length > INITIAL) {
      const btn = document.createElement('button');
      btn.className = 'lane-show-more';
      btn.textContent = `Show ${secTickets.length - INITIAL} more`;
      btn.addEventListener('click', () => {
        for (const ticket of secTickets.slice(INITIAL)) btn.before(renderTicketRow(ticket));
        btn.remove();
      });
      content.appendChild(btn);
    }
  }
  return { tabs: tabBar, content };
}

const LANE_SHORT = { needs: 'Support', aging: 'Aging', inprog: 'In Progress', waiting: 'Customer', stale: 'Stale' };

function renderLaneTabsEl(tickets, colId, laneIds = null) {
  const lanesCfg = laneIds ? LANES_CONFIG.filter(c => laneIds.includes(c.id)) : LANES_CONFIG;
  if (!lanesCfg.some(c => c.id === activeLane[colId])) activeLane[colId] = lanesCfg[0].id;

  const counts = {};
  for (const cfg of lanesCfg) {
    counts[cfg.id] = tickets.filter(t => laneOf(t) === cfg.id).length;
  }

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'sb-lane-tabs';
  for (const cfg of lanesCfg) {
    const isActive = cfg.id === activeLane[colId];
    const btn = document.createElement('button');
    btn.className = 'sb-lane-tab lane--' + cfg.id + (isActive ? ' sb-lane-tab--active' : '');
    btn.dataset.lane = cfg.id;
    btn.innerHTML = `<span class="lane-dot"></span>${escHtml(LANE_SHORT[cfg.id])}<span class="n">${counts[cfg.id]}</span>`;
    btn.addEventListener('click', () => {
      activeLane[colId] = cfg.id;
      renderSupportBoardUI(document.getElementById('support-board'));
    });
    tabBar.appendChild(btn);
  }
  // Active lane content
  const laneTickets = tickets
    .filter(t => laneOf(t) === activeLane[colId])
    .sort((a, b) => a.days - b.days);

  const content = document.createElement('div');
  content.className = 'sb-lane-content';
  if (laneTickets.length === 0) {
    content.innerHTML = '<div class="sb-lane-empty">No tickets in this lane</div>';
  } else {
    const INITIAL = 10;
    for (const ticket of laneTickets.slice(0, INITIAL)) content.appendChild(renderTicketRow(ticket));
    if (laneTickets.length > INITIAL) {
      const btn = document.createElement('button');
      btn.className = 'lane-show-more';
      btn.textContent = `Show ${laneTickets.length - INITIAL} more`;
      btn.addEventListener('click', () => {
        for (const ticket of laneTickets.slice(INITIAL)) content.insertBefore(renderTicketRow(ticket), btn);
        btn.remove();
      });
      content.appendChild(btn);
    }
  }
  return { tabs: tabBar, content };
}

function renderTicketRow(ticket) {
  const statusLabel = shortenStatus(ticket.status);

  const tc = document.createElement('div');
  tc.className = 'tc';
  tc.dataset.cat = ticket.cat;
  tc.dataset.open = supportFolded ? 'false' : 'true';

  // ── Head ────────────────────────────────────────────────────────────────
  const headEl = document.createElement('div');
  headEl.className = 'tc-head';
  const updatedLabel = ticket.days === 0 ? 'updated today' : `updated ${ticket.days}d ago`;
  const createdLabel = ticket.createdDays === 0 ? 'opened today' : `opened ${ticket.createdDays}d ago`;
  const timeLbl = ticket.days === 0 ? 'today' : `${ticket.days}d`;
  headEl.innerHTML = `
    <div class="tc-head-top">
      ${priorityIconHtml(ticket.priority)}
      <a class="tc-key" href="${ticket.url}" target="_blank" rel="noopener">${escHtml(ticket.key)}</a>
      <span class="tc-head-spacer"></span>
      <span class="tc-time-badge ${timeBadgeClass(ticket.days)}" title="${updatedLabel}">${timeLbl}</span>
      <span class="tc-head-sep">·</span>
      <span class="tc-age-old" title="${createdLabel}">${ticket.createdDays}d old</span>
      <svg class="tc-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>
    </div>
    <div class="tc-head-title">${escHtml(ticket.summary)}</div>`;

  // ── Meta ────────────────────────────────────────────────────────────────
  const metaEl = document.createElement('div');
  metaEl.className = 'tc-meta';
  const showMetaStatus = statusLabel !== 'Support' && statusLabel !== 'Customer';
  const showAssignee = ticket.cat !== 'cloud';
  const showDue = ticket.cat === 'security' && ticket.dueDate;
  if (showMetaStatus || ticket.scalrAccount || showAssignee || showDue) {
    const parts = [];
    if (showMetaStatus) parts.push(`<span class="tc-spill tc-spill--meta ${statusToPillClass(ticket.status)}"><span class="tc-spill-dot"></span>${escHtml(shortenStatus(trunc(ticket.status, 28)))}</span>`);
    if (ticket.scalrAccount) parts.push(`<span class="tc-account">${escHtml(ticket.scalrAccount)}</span>`);
    if (showAssignee) {
      const name = ticket.assignee || 'Unassigned';
      const avHtml = avatarHtml({ name, avatarUrl: ticket.assigneeAvatar, className: 'tc-assignee-av', placeholderClass: 'tc-av--init' });
      parts.push(`${avHtml}<span class="tc-assignee">${escHtml(name)}</span>`);
    }
    if (showDue) {
      const today = new Date(); today.setHours(0, 0, 0, 0);
      const isOverdue = ticket.dueDate < today;
      const daysUntil = Math.ceil((ticket.dueDate - today) / 86400000);
      const isSoon = !isOverdue && daysUntil <= 7;
      const yr = ticket.dueDate.getFullYear() !== today.getFullYear() ? ` ${ticket.dueDate.getFullYear()}` : '';
      const dueLbl = `Due ${MONTHS[ticket.dueDate.getMonth()]} ${ticket.dueDate.getDate()}${yr}`;
      const dueCls = isOverdue ? 'tc-due--overdue' : (isSoon ? 'tc-due--soon' : '');
      parts.push(`<span class="tc-due ${dueCls}">${escHtml(dueLbl)}</span>`);
    }
    metaEl.innerHTML = parts.join('<span class="tc-meta-dot"> · </span>');
  }

  // ── Body ────────────────────────────────────────────────────────────────
  const bodyEl = document.createElement('div');
  bodyEl.className = 'tc-body';

  // Internal status note (if present)
  if (ticket.internalText) {
    const noteEl = document.createElement('div');
    noteEl.className = 'tc-internal';
    noteEl.textContent = ticket.internalText;
    bodyEl.appendChild(noteEl);
  }

  // Activity timeline
  if (ticket.recentActivities.length > 0) {
    const actsEl = document.createElement('div');
    actsEl.className = 'tc-activities';
    for (const act of ticket.recentActivities) {
      const actEl = document.createElement('div');
      actEl.className = 'tc-act';
      const avHtml = avatarHtml({ name: act.actor, avatarUrl: act.actorAvatar, className: 'tc-act-av', placeholderClass: 'tc-av--init' });
      if (act.type === 'transition') {
        actEl.innerHTML = `
          ${avHtml}
          <span class="tc-act-main">
            <span class="tc-act-actor">${escHtml(act.actor)}</span>
            <span class="tc-act-verb"> moved </span>
            <span class="tc-spill tc-spill--sm">${escHtml(shortenStatus(act.from))}</span>
            <span class="tc-act-arrow">→</span>
            <span class="tc-spill tc-spill--sm">${escHtml(shortenStatus(act.to))}</span>
          </span>
          <span class="tc-act-time">${timeRel(new Date(act.created))}</span>`;
      } else if (act.type === 'link') {
        const isKey = /^[A-Z]+-\d+$/.test(act.key);
        const keyHtml = isKey
          ? `<a class="tc-spill tc-spill--sm tc-spill--key" href="${settings.jiraUrl}/browse/${act.key}" target="_blank" rel="noopener">${escHtml(act.key)}</a>`
          : `<span class="tc-spill tc-spill--sm tc-spill--key">${escHtml(act.key)}</span>`;
        actEl.innerHTML = `
          ${avHtml}
          <span class="tc-act-main">
            <span class="tc-act-actor">${escHtml(act.actor)}</span>
            <span class="tc-act-verb"> linked </span>
            ${keyHtml}
          </span>
          <span class="tc-act-time">${timeRel(new Date(act.created))}</span>`;
      } else {
        actEl.innerHTML = `
          ${avHtml}
          <span class="tc-act-main">
            <span class="tc-act-actor">${escHtml(act.actor)}</span>
            <span class="tc-act-verb"> updated </span>
            <span class="tc-act-field">${escHtml(act.field)}</span>
          </span>
          <span class="tc-act-time">${timeRel(new Date(act.created))}</span>`;
      }
      actsEl.appendChild(actEl);
    }
    bodyEl.appendChild(actsEl);
  }

  // Last comment
  if (ticket.lastComment) {
    const commentEl = document.createElement('div');
    commentEl.className = 'tc-comment';
    const bodyHtml = ticket.lastComment.html || escHtml(ticket.lastComment.text);
    commentEl.innerHTML = commentHtml({
      author: ticket.lastComment.author,
      avatarUrl: ticket.lastComment.avatarUrl,
      dateLabel: timeRel(ticket.lastComment.date),
      bodyHtml,
    });
    makeExpandableIfClamped(commentEl);
    bodyEl.appendChild(commentEl);
  }

  const tcTopEl = document.createElement('div');
  tcTopEl.className = 'tc-top';
  tcTopEl.appendChild(headEl);
  if (showMetaStatus || ticket.scalrAccount || showAssignee || showDue) tcTopEl.appendChild(metaEl);
  tc.appendChild(tcTopEl);
  tc.appendChild(bodyEl);

  // Linked SCALRCORE tickets — always-visible footer (outside body so survives fold)
  if (ticket.linkedScalrcore && ticket.linkedScalrcore.length > 0) {
    const linksEl = document.createElement('div');
    linksEl.className = 'tc-links';
    for (const li of ticket.linkedScalrcore) {
      const row = document.createElement('div');
      row.className = 'tc-link-row';
      row.innerHTML = `<a class="tc-key" href="${escHtml(li.url)}" target="_blank" rel="noopener">${escHtml(li.key)}</a><span class="tc-link-sum">${escHtml(trunc(li.summary, 80))}</span>${li.status ? `<span class="tc-spill tc-spill--sm">${escHtml(li.status)}</span>` : ''}`;
      linksEl.appendChild(row);
    }
    tc.appendChild(linksEl);
  }

  tcTopEl.addEventListener('click', e => {
    if (e.target.closest('a')) return;
    tc.dataset.open = tc.dataset.open === 'true' ? 'false' : 'true';
  });

  return tc;
}

document.addEventListener('DOMContentLoaded', init);
