/* ============================================================
   Catchup — daily org activity visualizer
   Vanilla ES module. Data: index.json + daily/<date>.json.
   ============================================================ */

const LS = {
  repos: 'catchup.filters.repos',
  users: 'catchup.filters.users',
  grouping: 'catchup.grouping',
};
const DATE_RE = /(\d{4}-\d{2}-\d{2})/;

/* ---------- State ---------- */
const state = {
  index: null,
  dates: [],          // sorted ascending list of available YYYY-MM-DD
  pathByDate: {},      // date -> "daily/<date>.json"
  repos: [],           // vocab: ["Lascade-Co/foo", ...]
  users: [],           // vocab: [{ login, name, key }]
  selectedDate: null,
  dayData: null,       // loaded daily JSON
  filters: { repos: new Set(), users: new Set() },
  grouping: 'repo',    // 'repo' | 'dev'
  calendar: null,
  suppressHash: false, // guard against re-entrant hashchange
};

/* ---------- DOM refs ---------- */
const $ = (sel) => document.querySelector(sel);
const el = {
  dayLabel: $('#day-label'),
  feed: $('#feed'),
  feedState: $('#feed-state'),
  repoDropdown: $('#repo-dropdown'),
  repoToggle: $('#repo-toggle'),
  repoToggleLabel: $('#repo-toggle-label'),
  repoPanel: $('#repo-panel'),
  repoList: $('#repo-list'),
  repoSearch: $('#repo-search'),
  repoClear: $('#repo-clear'),
  userDropdown: $('#user-dropdown'),
  userToggle: $('#user-toggle'),
  userToggleLabel: $('#user-toggle-label'),
  userPanel: $('#user-panel'),
  userList: $('#user-list'),
  userSearch: $('#user-search'),
  userClear: $('#user-clear'),
  userChips: $('#user-chips'),
  groupRepo: $('#group-repo'),
  groupDev: $('#group-dev'),
  dateBtn: $('#date-btn'),
  dateBtnLabel: $('#date-btn-label'),
  sidebar: $('#sidebar'),
  scrim: $('#scrim'),
};

/* ---------- Helpers ---------- */
const devKey = (d) => (d.login ? d.login : 'name:' + d.name);
const userKey = (u) => (u.login ? u.login : 'name:' + u.name);

function splitRepo(full) {
  const i = full.indexOf('/');
  return i === -1 ? { org: '', name: full } : { org: full.slice(0, i), name: full.slice(i + 1) };
}

function formatDateLong(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
  });
}

function loadSet(lsKey) {
  try {
    const raw = JSON.parse(localStorage.getItem(lsKey) || '[]');
    return new Set(Array.isArray(raw) ? raw : []);
  } catch { return new Set(); }
}
function saveSet(lsKey, set) {
  localStorage.setItem(lsKey, JSON.stringify([...set]));
}

/* Deterministic avatar color from a key. */
function avatarColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 48%)`;
}
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ============================================================
   Data loading
   ============================================================ */
async function fetchJSON(path) {
  const res = await fetch(path, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function loadIndex() {
  state.index = await fetchJSON('index.json');

  const daily = Array.isArray(state.index.daily) ? state.index.daily : [];
  for (const p of daily) {
    const m = p.match(DATE_RE);
    if (m) { state.pathByDate[m[1]] = p; }
  }
  state.dates = Object.keys(state.pathByDate).sort(); // ascending

  // Filter vocab straight from index.json (new shape).
  state.repos = Array.isArray(state.index.repos) ? [...state.index.repos].sort() : [];
  state.users = Array.isArray(state.index.users)
    ? state.index.users.map((u) => ({ login: u.login ?? null, name: u.name ?? u.login ?? '?', key: userKey(u) }))
    : [];
}

/* If index.json lacks repos/users (old shape), derive vocab from the loaded day. */
function ensureVocabFromDay() {
  if (state.repos.length === 0 && state.dayData) {
    state.repos = [...new Set(state.dayData.repos.map((r) => r.repo))].sort();
  }
  if (state.users.length === 0 && state.dayData) {
    const seen = new Map();
    for (const r of state.dayData.repos) {
      for (const d of r.developers) {
        const k = devKey(d);
        if (!seen.has(k)) seen.set(k, { login: d.login ?? null, name: d.name, key: k });
      }
    }
    state.users = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name));
  }
}

async function loadDay(date) {
  state.selectedDate = date;
  el.feed.setAttribute('aria-busy', 'true');
  renderState('Loading…');
  el.dayLabel.textContent = formatDateLong(date);
  el.dateBtnLabel.textContent = date;

  try {
    state.dayData = await fetchJSON(state.pathByDate[date]);
  } catch (err) {
    state.dayData = null;
    renderState('Could not load this day.', '⚠️', String(err.message || err));
    el.feed.setAttribute('aria-busy', 'false');
    return;
  }

  ensureVocabFromDay();
  // Build filter UI lazily once vocab is known.
  if (!el.repoList.children.length) buildRepoList();
  if (!el.userList.children.length) buildUserList();

  renderFeed();
  el.feed.setAttribute('aria-busy', 'false');
}

/* ============================================================
   Filtering
   ============================================================ */
function isRowVisible(repo, dev) {
  const fr = state.filters.repos;
  const fu = state.filters.users;
  const repoOk = fr.size === 0 || fr.has(repo);
  const userOk = fu.size === 0 || fu.has(devKey(dev));
  return repoOk && userOk; // repo AND user, OR within each group
}

/* Returns [{ repo, developers:[...] }] filtered, preserving order. */
function visibleByRepo() {
  if (!state.dayData) return [];
  const out = [];
  for (const r of state.dayData.repos) {
    const devs = r.developers.filter((d) => isRowVisible(r.repo, d));
    if (devs.length) out.push({ repo: r.repo, developers: devs });
  }
  return out;
}

/* Returns [{ key, name, login, repos:[{ repo, commit_count, bullets }] }] */
function visibleByDev() {
  if (!state.dayData) return [];
  const map = new Map();
  for (const r of state.dayData.repos) {
    for (const d of r.developers) {
      if (!isRowVisible(r.repo, d)) continue;
      const k = devKey(d);
      if (!map.has(k)) map.set(k, { key: k, name: d.name, login: d.login, repos: [] });
      map.get(k).repos.push({ repo: r.repo, commit_count: d.commit_count, bullets: d.bullets });
    }
  }
  return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/* ============================================================
   Rendering
   ============================================================ */
function renderState(msg, icon, sub) {
  el.feed.innerHTML = '';
  const div = document.createElement('div');
  div.className = 'state';
  div.innerHTML =
    (icon ? `<span class="state__icon">${icon}</span>` : '') +
    `<div>${msg}</div>` +
    (sub ? `<div class="state__sub">${sub}</div>` : '');
  el.feed.appendChild(div);
}

function bulletsList(bullets) {
  const ul = document.createElement('ul');
  ul.className = 'bullets';
  for (const b of bullets) {
    const li = document.createElement('li');
    // Split a leading emoji (non-word, non-space run) from the text.
    const m = b.match(/^(\s*\S+?)\s+(.*)$/s);
    const emoji = m ? m[1].trim() : '';
    const text = m ? m[2] : b;
    li.innerHTML = `<span class="b-emoji">${emoji}</span><span class="b-text"></span>`;
    li.querySelector('.b-text').textContent = text;
    ul.appendChild(li);
  }
  return ul;
}

function devBlock({ name, login, commit_count, bullets }) {
  const block = document.createElement('div');
  block.className = 'dev-block';
  const key = login || 'name:' + name;

  const head = document.createElement('div');
  head.className = 'dev-block__head';
  const av = document.createElement('span');
  av.className = 'avatar';
  av.style.background = avatarColor(key);
  av.textContent = initials(name);
  head.appendChild(av);

  const nameWrap = document.createElement('div');
  const nm = document.createElement('span');
  nm.className = 'dev-block__name';
  nm.textContent = name;
  nameWrap.appendChild(nm);
  if (login && login.toLowerCase() !== name.toLowerCase()) {
    const lg = document.createElement('span');
    lg.className = 'dev-block__login';
    lg.textContent = ' @' + login;
    nameWrap.appendChild(lg);
  }
  head.appendChild(nameWrap);

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = `${commit_count} commit${commit_count === 1 ? '' : 's'}`;
  head.appendChild(badge);

  block.appendChild(head);
  block.appendChild(bulletsList(bullets));
  return block;
}

function repoHeader(repo, metaText) {
  const { org, name } = splitRepo(repo);
  const head = document.createElement('div');
  head.className = 'repo-section__head';
  head.innerHTML =
    `<span class="repo-section__name">` +
    (org ? `<span class="repo-section__org">${org}/</span>` : '') +
    `${name}</span>` +
    (metaText ? `<span class="repo-section__meta">${metaText}</span>` : '');
  return head;
}

function renderFeed() {
  if (!state.dayData) return;
  el.feed.innerHTML = '';

  const totalRepos = state.dayData.repos.length;
  if (totalRepos === 0) {
    renderState('No activity recorded for this day.', '🌙');
    return;
  }

  if (state.grouping === 'repo') {
    const groups = visibleByRepo();
    if (!groups.length) return renderNoMatch();
    for (const g of groups) {
      const section = document.createElement('section');
      section.className = 'repo-section';
      const commits = g.developers.reduce((s, d) => s + (d.commit_count || 0), 0);
      section.appendChild(repoHeader(g.repo, `${g.developers.length} dev · ${commits} commits`));
      for (const d of g.developers) section.appendChild(devBlock(d));
      el.feed.appendChild(section);
    }
  } else {
    const devs = visibleByDev();
    if (!devs.length) return renderNoMatch();
    for (const dev of devs) {
      const section = document.createElement('section');
      section.className = 'repo-section';
      const commits = dev.repos.reduce((s, r) => s + (r.commit_count || 0), 0);
      // Reuse repo header markup styling for the developer name.
      const head = document.createElement('div');
      head.className = 'repo-section__head';
      const av = document.createElement('span');
      av.className = 'avatar';
      av.style.background = avatarColor(dev.key);
      av.textContent = initials(dev.name);
      head.appendChild(av);
      const nm = document.createElement('span');
      nm.className = 'repo-section__name';
      nm.textContent = dev.name;
      head.appendChild(nm);
      const meta = document.createElement('span');
      meta.className = 'repo-section__meta';
      meta.textContent = `${dev.repos.length} repo · ${commits} commits`;
      head.appendChild(meta);
      section.appendChild(head);

      for (const r of dev.repos) {
        const block = document.createElement('div');
        block.className = 'dev-block';
        const { org, name } = splitRepo(r.repo);
        const bhead = document.createElement('div');
        bhead.className = 'dev-block__head';
        bhead.innerHTML =
          `<span class="dev-block__name">` +
          (org ? `<span class="repo-section__org">${org}/</span>` : '') +
          `${name}</span>`;
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `${r.commit_count} commit${r.commit_count === 1 ? '' : 's'}`;
        bhead.appendChild(badge);
        block.appendChild(bhead);
        block.appendChild(bulletsList(r.bullets));
        section.appendChild(block);
      }
      el.feed.appendChild(section);
    }
  }
}

function renderNoMatch() {
  renderState(
    `No activity matches your filters for ${state.selectedDate}.`,
    '🔍',
    'Try clearing some repo or developer filters.'
  );
}

/* ============================================================
   Filter UI
   ============================================================ */
function buildRepoList() {
  el.repoList.innerHTML = '';
  for (const repo of state.repos) {
    const { org, name } = splitRepo(repo);
    const li = document.createElement('li');
    li.className = 'dropdown__item';
    li.dataset.repo = repo.toLowerCase();
    const id = 'repo-' + repo.replace(/[^a-z0-9]/gi, '-');
    li.innerHTML =
      `<input type="checkbox" id="${id}" ${state.filters.repos.has(repo) ? 'checked' : ''}/>` +
      `<label for="${id}">` +
      (org ? `<span class="repo-org">${org}/</span>` : '') +
      `${name}</label>`;
    const cb = li.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) state.filters.repos.add(repo);
      else state.filters.repos.delete(repo);
      saveSet(LS.repos, state.filters.repos);
      updateRepoToggleLabel();
      renderFeed();
    });
    el.repoList.appendChild(li);
  }
  updateRepoToggleLabel();
}

function updateRepoToggleLabel() {
  const n = state.filters.repos.size;
  el.repoToggleLabel.textContent = n ? `Repos · ${n}` : 'Repos';
  el.repoToggle.classList.toggle('has-selection', n > 0);
}

/* GitHub-label-style: a searchable dropdown checklist; selected developers
   also surface as removable chips below the top bar. */
function buildUserList() {
  el.userList.innerHTML = '';
  for (const u of state.users) {
    const li = document.createElement('li');
    li.className = 'dropdown__item';
    li.dataset.user = (u.name + ' ' + (u.login || '')).toLowerCase();
    const id = 'user-' + u.key.replace(/[^a-z0-9]/gi, '-');
    li.innerHTML =
      `<input type="checkbox" id="${id}" ${state.filters.users.has(u.key) ? 'checked' : ''}/>` +
      `<label for="${id}"></label>`;
    const label = li.querySelector('label');
    label.textContent = u.name;
    if (u.login && u.login.toLowerCase() !== u.name.toLowerCase()) {
      const span = document.createElement('span');
      span.className = 'repo-org';
      span.textContent = ' @' + u.login;
      label.appendChild(span);
    }
    li.querySelector('input').addEventListener('change', (e) => {
      toggleUser(u.key, e.target.checked);
    });
    el.userList.appendChild(li);
  }
  renderSelectedUserChips();
  updateUserToggleLabel();
}

function toggleUser(key, on) {
  if (on) state.filters.users.add(key);
  else state.filters.users.delete(key);
  saveSet(LS.users, state.filters.users);
  // Keep the checkbox in the dropdown in sync (e.g. when removed via a chip).
  const cb = el.userList.querySelector('#user-' + key.replace(/[^a-z0-9]/gi, '-'));
  if (cb) cb.checked = on;
  renderSelectedUserChips();
  updateUserToggleLabel();
  renderFeed();
}

function updateUserToggleLabel() {
  const n = state.filters.users.size;
  el.userToggleLabel.textContent = n ? `Developers · ${n}` : 'Developers';
}

function renderSelectedUserChips() {
  el.userChips.innerHTML = '';
  for (const u of state.users) {
    if (!state.filters.users.has(u.key)) continue;
    const chip = document.createElement('span');
    chip.className = 'chip is-active';
    if (u.login) chip.title = '@' + u.login;
    const name = document.createElement('span');
    name.textContent = u.name;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'chip__remove';
    remove.setAttribute('aria-label', `Remove ${u.name}`);
    remove.innerHTML =
      '<svg viewBox="0 0 12 12" width="9" height="9" aria-hidden="true">' +
      '<path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>';
    remove.addEventListener('click', () => toggleUser(u.key, false));
    chip.appendChild(name);
    chip.appendChild(remove);
    el.userChips.appendChild(chip);
  }
}

/* ============================================================
   Calendar (flatpickr inline)
   ============================================================ */
function initCalendar() {
  state.calendar = flatpickr('#calendar', {
    inline: true,
    enable: state.dates,
    defaultDate: state.selectedDate,
    dateFormat: 'Y-m-d',
    onChange: (sel, dateStr) => {
      if (dateStr && dateStr !== state.selectedDate) {
        navigateTo(dateStr);
        closeMobileCalendar();
      }
    },
  });
}

/* ============================================================
   Routing & navigation
   ============================================================ */
function dateFromHash() {
  const m = (location.hash || '').match(DATE_RE);
  return m && state.pathByDate[m[1]] ? m[1] : null;
}

function navigateTo(date) {
  if (!state.pathByDate[date]) return;
  state.suppressHash = true;
  location.hash = date;          // triggers hashchange (suppressed below)
  setTimeout(() => { state.suppressHash = false; }, 0);
  if (state.calendar) state.calendar.setDate(date, false);
  loadDay(date);
}

function onHashChange() {
  if (state.suppressHash) return;
  const date = dateFromHash();
  if (date && date !== state.selectedDate) {
    if (state.calendar) state.calendar.setDate(date, false);
    loadDay(date);
  }
}

/* ============================================================
   Mobile calendar popover
   ============================================================ */
function openMobileCalendar() {
  if (window.matchMedia('(min-width: 901px)').matches) return;
  el.sidebar.classList.add('is-open');
  el.scrim.removeAttribute('hidden');
  el.dateBtn.setAttribute('aria-expanded', 'true');
}
function closeMobileCalendar() {
  el.sidebar.classList.remove('is-open');
  el.scrim.setAttribute('hidden', '');
  el.dateBtn.setAttribute('aria-expanded', 'false');
}

/* ============================================================
   Wiring
   ============================================================ */
function setGrouping(g) {
  state.grouping = g;
  localStorage.setItem(LS.grouping, g);
  el.groupRepo.classList.toggle('is-active', g === 'repo');
  el.groupDev.classList.toggle('is-active', g === 'dev');
  el.groupRepo.setAttribute('aria-pressed', String(g === 'repo'));
  el.groupDev.setAttribute('aria-pressed', String(g === 'dev'));
  renderFeed();
}

/* Open/close + outside-click + search wiring shared by both dropdowns. */
function wireDropdown({ root, toggle, panel, search, list, searchKey }) {
  toggle.addEventListener('click', () => {
    const open = panel.hidden;
    closeAllDropdowns(panel);
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open && search) search.focus();
  });
  document.addEventListener('click', (e) => {
    if (!root.contains(e.target) && !panel.hidden) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  });
  if (search) {
    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      for (const li of list.children) {
        li.classList.toggle('is-hidden', q && !li.dataset[searchKey].includes(q));
      }
    });
  }
}

function closeAllDropdowns(except) {
  for (const [panel, toggle] of [[el.repoPanel, el.repoToggle], [el.userPanel, el.userToggle]]) {
    if (panel !== except) {
      panel.hidden = true;
      toggle.setAttribute('aria-expanded', 'false');
    }
  }
}

function wireEvents() {
  wireDropdown({
    root: el.repoDropdown, toggle: el.repoToggle, panel: el.repoPanel,
    search: el.repoSearch, list: el.repoList, searchKey: 'repo',
  });
  wireDropdown({
    root: el.userDropdown, toggle: el.userToggle, panel: el.userPanel,
    search: el.userSearch, list: el.userList, searchKey: 'user',
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllDropdowns(null);
      closeMobileCalendar();
    }
  });

  // Clear repos
  el.repoClear.addEventListener('click', () => {
    state.filters.repos.clear();
    saveSet(LS.repos, state.filters.repos);
    for (const cb of el.repoList.querySelectorAll('input')) cb.checked = false;
    updateRepoToggleLabel();
    renderFeed();
  });

  // Clear developers
  el.userClear.addEventListener('click', () => {
    state.filters.users.clear();
    saveSet(LS.users, state.filters.users);
    for (const cb of el.userList.querySelectorAll('input')) cb.checked = false;
    renderSelectedUserChips();
    updateUserToggleLabel();
    renderFeed();
  });

  // Grouping toggle
  el.groupRepo.addEventListener('click', () => setGrouping('repo'));
  el.groupDev.addEventListener('click', () => setGrouping('dev'));

  // Mobile calendar
  el.dateBtn.addEventListener('click', openMobileCalendar);
  el.scrim.addEventListener('click', closeMobileCalendar);

  window.addEventListener('hashchange', onHashChange);
}

/* ============================================================
   Boot
   ============================================================ */
async function main() {
  // Restore persisted filters + grouping
  state.filters.repos = loadSet(LS.repos);
  state.filters.users = loadSet(LS.users);
  state.grouping = localStorage.getItem(LS.grouping) === 'dev' ? 'dev' : 'repo';

  wireEvents();
  setGrouping(state.grouping); // sync toggle UI (no day yet, render is a no-op)

  try {
    await loadIndex();
  } catch (err) {
    renderState('Could not load index.json.', '⚠️', String(err.message || err));
    return;
  }

  if (state.dates.length === 0) {
    renderState('No days available yet.', '📭');
    return;
  }

  // Build filter UI now if vocab is available from index.json.
  if (state.repos.length) buildRepoList();
  if (state.users.length) buildUserList();

  const initial = dateFromHash() || state.dates[state.dates.length - 1]; // latest
  initCalendar();
  state.calendar.setDate(initial, false);

  state.suppressHash = true;
  location.hash = initial;
  setTimeout(() => { state.suppressHash = false; }, 0);

  await loadDay(initial);
}

// flatpickr is loaded with `defer`; wait for window load so it's defined.
if (typeof flatpickr !== 'undefined') main();
else window.addEventListener('load', main);
