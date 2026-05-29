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

/* Deterministic avatar color from a key. Earthy saturation/lightness to sit
   against the warm-cream surface without shouting. */
function avatarColor(key) {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 38% 42%)`;
}
function initials(name) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* A colored circle with the developer's initials — fallback identity. */
function initialsAvatar(name, key) {
  const span = document.createElement('span');
  span.className = 'avatar';
  span.style.background = avatarColor(key);
  span.textContent = initials(name);
  return span;
}

/* The developer's GitHub profile picture; falls back to initials when there's
   no login or the image fails to load. */
function avatarEl(name, login, key) {
  if (!login) return initialsAvatar(name, key);
  const img = document.createElement('img');
  img.className = 'avatar avatar--img';
  img.src = `https://github.com/${login}.png?size=64`;
  img.alt = name;
  img.loading = 'lazy';
  img.addEventListener('error', () => img.replaceWith(initialsAvatar(name, key)));
  return img;
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
    if (devs.length) {
      out.push({
        repo: r.repo,
        developers: devs,
        prs: r.prs || [],
        version: r.version || null,
      });
    }
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
      map.get(k).repos.push({
        repo: r.repo,
        commit_count: d.commit_count,
        bullets: d.bullets,
        prs: r.prs || [],
      });
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

/* ---------- GitHub links ---------- */
const GH = 'https://github.com/';
const ghRepoUrl = (repo) => GH + repo;
const ghUserUrl = (login) => (login ? GH + login : null);
const ghPrUrl = (repo, number) => `${GH}${repo}/pull/${number}`;

/* An <a> when url is truthy, otherwise a plain <span> (e.g. a null-login dev). */
function linkEl(text, url, className) {
  const node = document.createElement(url ? 'a' : 'span');
  if (url) { node.href = url; node.target = '_blank'; node.rel = 'noopener'; }
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

/* ---------- Bullet statuses ---------- */
const STATUS_ORDER = ['Published', 'Testing', 'Work in Progress'];

/* Split a leading emoji (non-word, non-space run) from the bullet text. */
function splitEmoji(line) {
  const m = line.match(/^(\s*\S+?)\s+(.*)$/s);
  return m ? { emoji: m[1].trim(), text: m[2] } : { emoji: '', text: line };
}

/* [status, lines[]] — STATUS_ORDER first, then any unknown status in encounter order. */
function orderedStatuses(bullets) {
  const present = (s) => Array.isArray(bullets?.[s]) && bullets[s].length;
  const known = STATUS_ORDER.filter(present);
  const rest = Object.keys(bullets || {}).filter((k) => !STATUS_ORDER.includes(k) && present(k));
  return [...known, ...rest].map((s) => [s, bullets[s]]);
}

/* A small uppercase sub-label used for statuses, PRs, branches, and commits. */
function sublabel(text) {
  const d = document.createElement('div');
  d.className = 'status-label';
  d.textContent = text;
  return d;
}

/* Developer chip: avatar + name, with an optional "commits - N" second line.
   Links to the developer's GitHub profile when a login is known. */
function devChip(name, login, key, count) {
  const url = ghUserUrl(login);
  const chip = document.createElement(url ? 'a' : 'span');
  chip.className = 'dev-chip';
  if (url) { chip.href = url; chip.target = '_blank'; chip.rel = 'noopener'; }
  chip.appendChild(avatarEl(name, login, key));

  const text = document.createElement('span');
  text.className = 'dev-chip__text';
  const nm = document.createElement('span');
  nm.className = 'dev-chip__name';
  nm.textContent = name;
  text.appendChild(nm);
  if (count != null) {
    const ct = document.createElement('span');
    ct.className = 'dev-chip__count';
    ct.textContent = `commits - ${count}`;
    text.appendChild(ct);
  }
  chip.appendChild(text);
  return chip;
}

/* One bullet <li>: emoji + text, with a trailing dev chip when attributed. */
function bulletLi({ emoji, text, dev }) {
  const li = document.createElement('li');
  const em = document.createElement('span');
  em.className = 'b-emoji';
  em.textContent = emoji;
  const tx = document.createElement('span');
  tx.className = 'b-text';
  tx.textContent = text;
  li.appendChild(em);
  li.appendChild(tx);
  if (dev) {
    const chip = devChip(dev.name, dev.login, dev.login || 'name:' + dev.name);
    chip.classList.add('b-dev-chip');
    li.appendChild(chip);
  }
  return li;
}

/* Render [status, lines[]] groups as sub-label + bullet list. */
function statusGroups(groups) {
  const frag = document.createDocumentFragment();
  for (const [status, lines] of groups) {
    frag.appendChild(sublabel(status));
    const ul = document.createElement('ul');
    ul.className = 'bullets';
    for (const ln of lines) ul.appendChild(bulletLi(ln));
    frag.appendChild(ul);
  }
  return frag;
}

/* Repo view: merge every developer's bullets by status, attributing each line. */
function repoStatusGroups(developers) {
  const byStatus = new Map();
  for (const d of developers) {
    const dev = { name: d.name, login: d.login };
    for (const [status, lines] of orderedStatuses(d.bullets)) {
      if (!byStatus.has(status)) byStatus.set(status, []);
      for (const line of lines) byStatus.get(status).push({ ...splitEmoji(line), dev });
    }
  }
  const known = STATUS_ORDER.filter((s) => byStatus.has(s));
  const rest = [...byStatus.keys()].filter((s) => !STATUS_ORDER.includes(s));
  return [...known, ...rest].map((s) => [s, byStatus.get(s)]);
}

/* Dev view: one developer's own bullets by status, no attribution suffix. */
function devStatusGroups(bullets) {
  return orderedStatuses(bullets).map(([status, lines]) => [status, lines.map(splitEmoji)]);
}

/* PRs as linked titles; author shown (linked) only in the repo view. */
function prList(repo, prs, withAuthor) {
  const ul = document.createElement('ul');
  ul.className = 'pr-list';
  for (const pr of prs) {
    const li = document.createElement('li');
    li.className = 'pr-item';
    const icon = document.createElement('span');
    icon.className = 'pr-icon';
    icon.textContent = '🔀';
    const body = document.createElement('span');
    body.className = 'pr-body';
    body.appendChild(linkEl(pr.title, ghPrUrl(repo, pr.number), 'feed-link'));
    if (withAuthor && pr.author) {
      const au = document.createElement('span');
      au.className = 'pr-author';
      au.appendChild(document.createTextNode(' '));
      au.appendChild(linkEl('@' + pr.author, ghUserUrl(pr.author), 'feed-link'));
      body.appendChild(au);
    }
    li.appendChild(icon);
    li.appendChild(body);
    ul.appendChild(li);
  }
  return ul;
}

/* Compact commit chips — avatar + name + "commits - N" — busiest developer first. */
function commitBreakdown(developers) {
  const wrap = document.createElement('div');
  wrap.className = 'commit-chips';
  const sorted = [...developers].sort(
    (a, b) => (b.commit_count || 0) - (a.commit_count || 0) || a.name.localeCompare(b.name)
  );
  for (const d of sorted) {
    wrap.appendChild(devChip(d.name, d.login, devKey(d), d.commit_count));
  }
  return wrap;
}

/* Repo section header: linked org/name, optional version badge, meta line. */
function repoHeader(repo, metaText, version) {
  const { org, name } = splitRepo(repo);
  const head = document.createElement('div');
  head.className = 'repo-section__head';

  const link = document.createElement('a');
  link.className = 'repo-section__name feed-link';
  link.href = ghRepoUrl(repo);
  link.target = '_blank';
  link.rel = 'noopener';
  if (org) {
    const o = document.createElement('span');
    o.className = 'repo-section__org';
    o.textContent = org + '/';
    link.appendChild(o);
  }
  link.appendChild(document.createTextNode(name));
  head.appendChild(link);

  if (version) {
    const v = document.createElement('span');
    v.className = 'ver-badge';
    v.textContent = version;
    head.appendChild(v);
  }
  if (metaText) {
    const m = document.createElement('span');
    m.className = 'repo-section__meta';
    m.textContent = metaText;
    head.appendChild(m);
  }
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
      const devWord = g.developers.length === 1 ? 'dev' : 'devs';
      section.appendChild(
        repoHeader(g.repo, `${g.developers.length} ${devWord} · ${commits} commits`, g.version)
      );

      const card = document.createElement('div');
      card.className = 'dev-block';
      card.appendChild(statusGroups(repoStatusGroups(g.developers)));

      if (g.prs.length) {
        card.appendChild(sublabel('Pull requests'));
        card.appendChild(prList(g.repo, g.prs, true));
      }
      card.appendChild(commitBreakdown(g.developers));

      section.appendChild(card);
      el.feed.appendChild(section);
    }
  } else {
    const devs = visibleByDev();
    if (!devs.length) return renderNoMatch();
    for (const dev of devs) {
      const section = document.createElement('section');
      section.className = 'repo-section';
      const commits = dev.repos.reduce((s, r) => s + (r.commit_count || 0), 0);
      const repoWord = dev.repos.length === 1 ? 'repo' : 'repos';

      const head = document.createElement('div');
      head.className = 'repo-section__head';
      head.appendChild(avatarEl(dev.name, dev.login, dev.key));
      head.appendChild(linkEl(dev.name, ghUserUrl(dev.login), 'repo-section__name feed-link'));
      const meta = document.createElement('span');
      meta.className = 'repo-section__meta';
      meta.textContent = `${dev.repos.length} ${repoWord} · ${commits} commits`;
      head.appendChild(meta);
      section.appendChild(head);

      for (const r of dev.repos) {
        const card = document.createElement('div');
        card.className = 'dev-block';

        const bhead = document.createElement('div');
        bhead.className = 'dev-block__head';
        const { name } = splitRepo(r.repo);
        bhead.appendChild(linkEl(name, ghRepoUrl(r.repo), 'dev-block__name feed-link'));
        const badge = document.createElement('span');
        badge.className = 'badge';
        badge.textContent = `${r.commit_count} commit${r.commit_count === 1 ? '' : 's'}`;
        bhead.appendChild(badge);
        card.appendChild(bhead);

        card.appendChild(statusGroups(devStatusGroups(r.bullets)));

        const myPrs = r.prs.filter((p) => dev.login && p.author === dev.login);
        if (myPrs.length) {
          card.appendChild(sublabel('Pull requests'));
          card.appendChild(prList(r.repo, myPrs, false));
        }
        section.appendChild(card);
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
