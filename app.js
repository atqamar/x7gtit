//
// MODE is set by the build process. 'local' reads from /api/data (Python server);
// 'hosted' reads from ./data.enc.json (decrypted client-side in the static build).
const MODE = 'hosted';

// ============================================================
// HOSTED MODE banner — injected once on first saveData() call
// ============================================================
function _showHostedBanner() {
  if (document.getElementById('hosted-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'hosted-banner';
  banner.style.cssText = [
    'position:fixed','bottom:0','left:0','right:0',
    'background:#fff3cd','color:#856404','padding:8px 16px',
    'font-size:0.85rem','text-align:center','z-index:1000',
    'border-top:1px solid #ffc107',
  ].join(';');
  banner.textContent = 'Viewing hosted snapshot — edits are local to this browser only and will not sync.';
  document.body.appendChild(banner);
}



// ============================================================
// State
// ============================================================

const state = {
  projects: [],         // Array of project objects from projects.json
  version: 1,
  rubric_version: '',
  updated_at: '',
  sortColumn: 'composite',
  sortDir: 'desc',      // 'asc' | 'desc'
  categoryFilter: '',   // '' = all
  openProjectId: null,  // Currently open in the sidebar
};

// Per-project cache for the deep-dive tab so switching away and back doesn't re-fetch.
const deepDiveCache = {};

// ============================================================
// Composite formula
// (from PLAN.md Section A — matches the rubric exactly)
//
// composite = (api_feasibility × 0.20)
//           + ((5 − ((topic_complexity + project_complexity) / 2)) × 0.25)
//           + (min(((domain_learning + agentic_ai_learning) / 2) + reusability_bonus, 5) × 0.35)
//           + (fun × 0.20)
// ============================================================

function computeComposite(project) {
  const s = project.scores;
  if (!s) return null;

  const required = [
    s.api_feasibility,
    s.topic_complexity,
    s.project_complexity,
    s.domain_learning,
    s.agentic_ai_learning,
    s.reusability_bonus,
    s.fun,
  ];

  // Return null if any required field is null or undefined.
  if (required.some(v => v === null || v === undefined)) return null;

  const api = s.api_feasibility;
  const diff_avg = (s.topic_complexity + s.project_complexity) / 2;
  const ease = 5 - diff_avg;
  const learn_avg = (s.domain_learning + s.agentic_ai_learning) / 2;
  const learn_with_bonus = Math.min(learn_avg + s.reusability_bonus, 5);
  const fun = s.fun;

  const composite = (api * 0.20)
                  + (ease * 0.25)
                  + (learn_with_bonus * 0.35)
                  + (fun * 0.20);

  return Math.round(composite * 100) / 100;
}

function computeEase(project) {
  const s = project.scores;
  if (!s || s.topic_complexity === null || s.topic_complexity === undefined ||
         s.project_complexity === null || s.project_complexity === undefined) {
    return null;
  }
  const ease = 5 - (s.topic_complexity + s.project_complexity) / 2;
  return Math.round(ease * 100) / 100;
}

// ============================================================
// Data fetch / save
// ============================================================

async function fetchData() {
  if (MODE === 'hosted') {
    // In hosted mode, data comes from window.__DECRYPTED_DATA__ (set after
    // the password overlay successfully decrypts data.enc.json).
    // If decryption hasn't finished yet, return silently — the overlay's
    // submit handler calls fetchData() again once data is ready.
    if (!window.__DECRYPTED_DATA__) return;
    let base = window.__DECRYPTED_DATA__;
    // Merge any local-storage overlay on top.
    try {
      const overlayRaw = localStorage.getItem(window.__HOSTED_OVERLAY_KEY__);
      if (overlayRaw) {
        const overlay = JSON.parse(overlayRaw);
        // Merge: overlay projects replace base projects by id.
        const baseMap = Object.fromEntries(base.projects.map(p => [p.id, p]));
        const overlayMap = Object.fromEntries((overlay.projects || []).map(p => [p.id, p]));
        const merged = base.projects.map(p => overlayMap[p.id] || baseMap[p.id]);
        base = Object.assign({}, base, { projects: merged,
          updated_at: overlay.updated_at || base.updated_at });
      }
    } catch (_) {}
    state.projects = base.projects || [];
    state.version = base.version || 1;
    state.rubric_version = base.rubric_version || '';
    state.updated_at = base.updated_at || '';
    populateCategoryFilter();
    renderTable();
    updateStatusBar();
    return;
  }
  // local mode
  try {
    const res = await fetch('/api/data');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    state.projects = json.projects || [];
    state.version = json.version || 1;
    state.rubric_version = json.rubric_version || '';
    state.updated_at = json.updated_at || '';
    populateCategoryFilter();
    renderTable();
    updateStatusBar();
  } catch (err) {
    document.getElementById('status-count').textContent = 'Error loading data: ' + err.message;
    console.error('fetchData error:', err);
  }
}

async function saveData() {
  const payload = {
    version: state.version,
    rubric_version: state.rubric_version,
    updated_at: new Date().toISOString(),
    projects: state.projects,
  };
  if (MODE === 'hosted') {
    // In hosted mode: persist to localStorage only. Never touches the server.
    try {
      localStorage.setItem(window.__HOSTED_OVERLAY_KEY__, JSON.stringify(payload));
      state.updated_at = payload.updated_at;
      _showHostedBanner();
      updateStatusBar();
      return true;
    } catch (err) {
      console.error('saveData (hosted) localStorage error:', err);
      return false;
    }
  }
  // local mode
  try {
    const res = await fetch('/api/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload, null, 2),
    });
    if (!res.ok) {
      const err = await res.json();
      console.error('saveData error:', err);
      return false;
    }
    state.updated_at = payload.updated_at;
    updateStatusBar();
    return true;
  } catch (err) {
    console.error('saveData fetch error:', err);
    return false;
  }
}

// ============================================================
// Table rendering
// ============================================================

function getSortedProjects() {
  const filtered = state.categoryFilter
    ? state.projects.filter(p => p.category === state.categoryFilter)
    : state.projects.slice();

  // Separate projects with a manual override from those without.
  const overridden = filtered.filter(p => p.manual_override_position !== null);
  const auto = filtered.filter(p => p.manual_override_position === null);

  // Sort the auto-positioned projects by the selected column.
  auto.sort((a, b) => {
    let av = getSortValue(a, state.sortColumn);
    let bv = getSortValue(b, state.sortColumn);
    // Nulls go to the bottom regardless of sort direction.
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (state.sortDir === 'desc') return bv - av;
    return av - bv;
  });

  // Sort overridden projects by their manual_override_position.
  overridden.sort((a, b) => a.manual_override_position - b.manual_override_position);

  // Interleave: override positions insert into the auto list.
  // Simple approach: build one unified list sorted by final position.
  // If override position is 1-based index into the final sorted list, insert there.
  const merged = [];
  const autoQueue = auto.slice();
  overridden.sort((a, b) => a.manual_override_position - b.manual_override_position);

  for (const p of overridden) {
    // Fill auto entries up to this override's target position.
    const targetIndex = p.manual_override_position - 1; // 0-based
    while (merged.length < targetIndex && autoQueue.length) {
      merged.push(autoQueue.shift());
    }
    merged.push(p);
  }
  // Append remaining auto entries.
  while (autoQueue.length) {
    merged.push(autoQueue.shift());
  }

  return merged;
}

function getSortValue(project, col) {
  switch (col) {
    case 'composite':        return computeComposite(project);
    case 'api_feasibility':  return project.scores?.api_feasibility ?? null;
    case 'ease':             return computeEase(project);
    case 'domain_learning':  return project.scores?.domain_learning ?? null;
    case 'agentic_ai_learning': return project.scores?.agentic_ai_learning ?? null;
    case 'fun':              return project.scores?.fun ?? null;
    case 'slide_page':       return project.slide_page ?? null;
    default:                 return null;
  }
}

function renderTable() {
  const tbody = document.getElementById('projects-tbody');
  const sorted = getSortedProjects();
  const rows = [];

  sorted.forEach((project, index) => {
    const pos = index + 1;
    const composite = computeComposite(project);
    const ease = computeEase(project);
    const s = project.scores || {};

    const tr = document.createElement('tr');
    tr.dataset.id = project.id;

    // Helper to build a score cell.
    function scoreCell(value, fieldName) {
      const td = document.createElement('td');
      td.className = 'col-score' + (value === null || value === undefined ? ' null-score' : '') + ' editable';
      td.textContent = (value === null || value === undefined) ? '—' : value;
      td.dataset.field = fieldName;
      td.dataset.projectId = project.id;
      td.title = 'Double-click to edit';
      return td;
    }

    // # position
    const tdPos = document.createElement('td');
    tdPos.className = 'col-pos';
    tdPos.textContent = pos;
    tr.appendChild(tdPos);

    // Title
    const tdTitle = document.createElement('td');
    tdTitle.className = 'col-title';
    tdTitle.dataset.projectId = project.id;
    const titleSpan = document.createElement('span');
    titleSpan.className = 'project-title-text';
    titleSpan.textContent = project.title;
    const catBadge = document.createElement('span');
    catBadge.className = `category-badge cat-${project.category}`;
    catBadge.textContent = project.category;
    tdTitle.appendChild(titleSpan);
    tdTitle.appendChild(catBadge);
    tdTitle.addEventListener('click', () => openDetail(project.id));
    tr.appendChild(tdTitle);

    tr.appendChild(scoreCell(s.api_feasibility, 'api_feasibility'));

    // Ease (display only — not directly editable; edit topic/project complexity instead)
    const tdEase = document.createElement('td');
    tdEase.className = 'col-score' + (ease === null ? ' null-score' : '');
    tdEase.textContent = ease !== null ? ease : '—';
    tdEase.title = 'Ease = 5 − avg(topic_complexity, project_complexity). Edit those scores to change this.';
    tr.appendChild(tdEase);

    tr.appendChild(scoreCell(s.domain_learning, 'domain_learning'));

    // Fun
    tr.appendChild(scoreCell(s.fun, 'fun'));

    // Composite
    const tdComposite = document.createElement('td');
    tdComposite.className = 'col-composite' + (composite === null ? ' null-composite' : '');
    tdComposite.textContent = composite !== null ? composite : '—';
    tdComposite.title = 'Composite = API(20%) + Ease(25%) + Learning(35%) + Fun(20%)';
    tr.appendChild(tdComposite);

    // Drag handle
    const tdDrag = document.createElement('td');
    tdDrag.className = 'col-drag';
    tdDrag.innerHTML = '&#8597;'; // up-down arrow
    tdDrag.title = 'Drag to reorder';
    tr.appendChild(tdDrag);

    rows.push(tr);
  });

  tbody.replaceChildren(...rows);

  // Update column sort indicators.
  document.querySelectorAll('#projects-table thead th[data-col]').forEach(th => {
    th.classList.remove('sort-active');
    const arrow = th.querySelector('.sort-arrow');
    if (arrow) arrow.remove();
  });
  const activeTh = document.querySelector(`#projects-table thead th[data-col="${state.sortColumn}"]`);
  if (activeTh) {
    activeTh.classList.add('sort-active');
    const arrow = document.createElement('span');
    arrow.className = 'sort-arrow';
    arrow.textContent = state.sortDir === 'desc' ? '▼' : '▲';
    activeTh.appendChild(arrow);
  }

  initDrag();
  initInlineEdit();
}

// ============================================================
// Sort
// ============================================================

function sortByColumn(col) {
  if (state.sortColumn === col) {
    state.sortDir = state.sortDir === 'desc' ? 'asc' : 'desc';
  } else {
    state.sortColumn = col;
    state.sortDir = 'desc';
  }
  // Sync the dropdown.
  const sel = document.getElementById('sort-select');
  if (sel) sel.value = col;
  renderTable();
}

// ============================================================
// Drag-and-drop (SortableJS)
// ============================================================

let sortableInstance = null;

function initDrag() {
  const tbody = document.getElementById('projects-tbody');
  if (sortableInstance) {
    sortableInstance.destroy();
  }
  if (typeof Sortable === 'undefined') {
    console.warn('SortableJS not loaded — drag-and-drop disabled.');
    return;
  }
  sortableInstance = Sortable.create(tbody, {
    animation: 150,
    handle: '.col-drag',
    ghostClass: 'dragging',
    onEnd(evt) {
      // Assign sequential manual_override_position to all rows based on new DOM order.
      const rows = tbody.querySelectorAll('tr[data-id]');
      rows.forEach((row, index) => {
        const id = row.dataset.id;
        const project = state.projects.find(p => p.id === id);
        if (project) {
          project.manual_override_position = index + 1;
          appendEditHistory(project, 'manual_override_position', null, index + 1);
        }
      });
      saveData().then(() => renderTable());
    },
  });
}

// ============================================================
// Inline editing
// ============================================================

function initInlineEdit() {
  const tbody = document.getElementById('projects-tbody');
  tbody.querySelectorAll('td.editable').forEach(td => {
    td.addEventListener('dblclick', startInlineEdit);
  });
}

function startInlineEdit(evt) {
  const td = evt.currentTarget;
  const field = td.dataset.field;
  const projectId = td.dataset.projectId;
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  const currentValue = project.scores?.[field];
  const currentDisplay = (currentValue === null || currentValue === undefined) ? '' : String(currentValue);

  // Replace cell content with an input.
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'score-input';
  input.value = currentDisplay;
  input.pattern = '^[0-5](\\.[0-9])?$';
  input.placeholder = '0–5';
  input.title = 'Enter a score from 0 to 5 (one decimal place allowed). Enter to confirm, Esc to cancel.';

  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();

  function commit() {
    const raw = input.value.trim();
    if (raw === '') {
      // Allow clearing a score back to null.
      applyScoreEdit(project, field, currentValue, null);
      return;
    }
    // Validate: pattern ^[0-5](\.[0-9])?$
    if (!/^[0-5](\.[0-9])?$/.test(raw)) {
      input.classList.add('error-text');
      input.focus();
      return;
    }
    const newValue = parseFloat(raw);
    applyScoreEdit(project, field, currentValue, newValue);
  }

  function cancel() {
    td.textContent = (currentValue === null || currentValue === undefined) ? '—' : currentValue;
    td.classList.toggle('null-score', currentValue === null || currentValue === undefined);
    td.addEventListener('dblclick', startInlineEdit);
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      cancel();
    }
  });

  input.addEventListener('blur', () => {
    // Small timeout so Enter keydown can fire first.
    setTimeout(() => {
      if (document.activeElement !== input) commit();
    }, 80);
  });
}

function applyScoreEdit(project, field, fromValue, toValue) {
  project.scores[field] = toValue;
  appendEditHistory(project, field, fromValue, toValue);
  saveData().then(ok => {
    renderTable();
    if (state.openProjectId === project.id) {
      renderSidebarScores(project);
      renderSidebarHistory(project);
    }
  });
}

function appendEditHistory(project, field, fromValue, toValue) {
  if (fromValue === toValue) return; // skip no-op edits
  if (!project.edit_history) project.edit_history = [];
  project.edit_history.push({
    ts: new Date().toISOString(),
    project_id: project.id,
    field,
    from: fromValue,
    to: toValue,
  });
}

// ============================================================
// Category filter
// ============================================================

function populateCategoryFilter() {
  const select = document.getElementById('category-filter');
  const existing = new Set(['']);
  Array.from(select.options).forEach(o => existing.add(o.value));

  const categories = [...new Set(state.projects.map(p => p.category).filter(Boolean))].sort();
  categories.forEach(cat => {
    if (!existing.has(cat)) {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      select.appendChild(opt);
    }
  });
}

// ============================================================
// Reset overrides
// ============================================================

function resetOverrides() {
  state.projects.forEach(p => {
    if (p.manual_override_position !== null) {
      appendEditHistory(p, 'manual_override_position', p.manual_override_position, null);
      p.manual_override_position = null;
    }
  });
  saveData().then(() => renderTable());
}

// ============================================================
// Rebuild
// ============================================================

async function rebuild() {
  const btn = document.getElementById('btn-rebuild');
  btn.textContent = '[rebuilding…]';
  btn.disabled = true;
  try {
    const res = await fetch('/api/rebuild', { method: 'POST' });
    const json = await res.json();
    if (!res.ok) {
      alert('Rebuild failed: ' + (json.error || 'Unknown error'));
      return;
    }
    state.projects = json.projects || [];
    state.version = json.version || 1;
    state.rubric_version = json.rubric_version || '';
    state.updated_at = json.updated_at || '';
    populateCategoryFilter();
    renderTable();
    updateStatusBar();
  } catch (err) {
    alert('Rebuild error: ' + err.message);
    console.error('rebuild error:', err);
  } finally {
    btn.textContent = '[rebuild]';
    btn.disabled = false;
  }
}

// ============================================================
// Detail sidebar
// ============================================================

async function openDetail(projectId) {
  const project = state.projects.find(p => p.id === projectId);
  if (!project) return;

  state.openProjectId = projectId;

  // Populate header.
  document.getElementById('sidebar-title').textContent = project.title;
  document.getElementById('sidebar-meta').innerHTML =
    `Slide page ${project.slide_page}&nbsp;&nbsp;|&nbsp;&nbsp;<span class="category-badge cat-${project.category}">${project.category}</span>`;

  // Open the sidebar.
  document.getElementById('sidebar').classList.add('open');

  // Reset to the deep-dive tab (position 1 — the action tab).
  setActiveTab('deep-dive');

  // Populate scores panel.
  renderSidebarScores(project);

  // Populate history panel.
  renderSidebarHistory(project);

  // Fetch markdown content.
  fetchWebsiteMd(projectId);
  fetchSourceMd(projectId);
  // Pre-fetch deep-dive so it's ready when the user clicks the tab.
  fetchDeepDiveMd(projectId);
}

function closeSidebar() {
  document.getElementById('sidebar').classList.remove('open');
  state.openProjectId = null;
}

function setActiveTab(tabName) {
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    const active = btn.dataset.tab === tabName;
    btn.classList.toggle('active', active);
    btn.setAttribute('aria-selected', String(active));
  });
  document.querySelectorAll('.sidebar-panel').forEach(panel => {
    panel.classList.toggle('active', panel.id === `panel-${tabName}`);
  });
}

async function fetchWebsiteMd(projectId) {
  const container = document.getElementById('website-md-content');
  container.innerHTML = '<p class="loading-text">Loading&hellip;</p>';
  if (MODE === 'hosted' && window.__DECRYPTED_DATA__) {
    const text = window.__DECRYPTED_DATA__.website_md[projectId]
      || '_Website summary not available._';
    container.innerHTML = marked.parse(text);
    return;
  }
  try {
    const res = await fetch(`/api/website-md/${encodeURIComponent(projectId)}`);
    const text = await res.text();
    container.innerHTML = marked.parse(text);
  } catch (err) {
    container.innerHTML = `<p class="error-text">Failed to load website summary: ${err.message}</p>`;
  }
}

async function fetchSourceMd(projectId) {
  const container = document.getElementById('source-md-content');
  container.innerHTML = '<p class="loading-text">Loading&hellip;</p>';
  if (MODE === 'hosted' && window.__DECRYPTED_DATA__) {
    const text = window.__DECRYPTED_DATA__.source_md[projectId]
      || '_Not available._';
    container.innerHTML = marked.parse(text);
    return;
  }
  try {
    const res = await fetch(`/api/source-md/${encodeURIComponent(projectId)}`);
    const text = await res.text();
    container.innerHTML = marked.parse(text);
  } catch (err) {
    container.innerHTML = `<p class="error-text">Failed to load: ${err.message}</p>`;
  }
}

// renderDeepDiveHtml — splits the deep-dive markdown into three parts:
//   1. Everything before "## The prompt" heading  → rendered markdown
//   2. The prompt body between the two --- markers → <pre><code> block with a copy button
//   3. Everything after the second ---             → rendered markdown
//
// Heuristic: find the first --- AFTER the "## The prompt" heading line,
// then the next --- after that is the end of the prompt body.
function renderDeepDiveHtml(text) {
  const lines = text.split('\n');

  // Find the index of the "## The prompt" heading (case-insensitive contains check).
  const headingIdx = lines.findIndex(l => /^##\s.*prompt/i.test(l));

  if (headingIdx === -1) {
    // No prompt section found — fall back to plain markdown.
    return marked.parse(text);
  }

  // Find the first --- AFTER the heading (this is the opening delimiter).
  let firstHrIdx = -1;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    if (/^---\s*$/.test(lines[i])) { firstHrIdx = i; break; }
  }

  if (firstHrIdx === -1) {
    return marked.parse(text);
  }

  // Find the "## Why this prompt" section (or any ## heading after the prompt heading).
  // The closing --- for the prompt body is the LAST --- before this heading.
  // This handles files like project 17 where the prompt body contains multiple ---
  // separators internally — we must not stop at the first one.
  let whyIdx = -1;
  for (let i = firstHrIdx + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i]) && i > headingIdx) { whyIdx = i; break; }
  }

  // Find the closing --- delimiter:
  // - If a "## Why" section exists, walk BACKWARDS from it to find the last --- before it.
  // - Otherwise, fall back to the first --- after the opening (original two-marker logic).
  let secondHrIdx = -1;
  if (whyIdx !== -1) {
    // Walk backwards from whyIdx to find the last --- that closes the prompt body.
    for (let i = whyIdx - 1; i > firstHrIdx; i--) {
      if (/^---\s*$/.test(lines[i])) { secondHrIdx = i; break; }
    }
  }
  if (secondHrIdx === -1) {
    // Fallback: use the first --- after the opening delimiter.
    for (let i = firstHrIdx + 1; i < lines.length; i++) {
      if (/^---\s*$/.test(lines[i])) { secondHrIdx = i; break; }
    }
  }

  // Everything before (and including) the heading, up to but not including the opening ---
  // → rendered as markdown preamble.
  const preamble = lines.slice(0, firstHrIdx).join('\n');
  // Prompt body: between the two --- markers (verbatim, no markdown processing).
  const promptLines = secondHrIdx === -1
    ? lines.slice(firstHrIdx + 1)
    : lines.slice(firstHrIdx + 1, secondHrIdx);
  const promptBody = promptLines.join('\n').trim();
  // Epilogue: everything after the closing --- (the "Why" section etc.) → rendered markdown.
  const epilogue = secondHrIdx !== -1
    ? lines.slice(secondHrIdx + 1).join('\n').trim()
    : '';

  // Escape HTML entities for safe insertion into <pre><code>.
  const escaped = promptBody
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // Embed the raw prompt body as a data attribute for the copy button.
  // Escape for HTML attribute context (&, ", < >).
  const escapedForAttr = promptBody
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const copyBtn = `<button class="btn btn-primary deep-dive-copy-btn" data-prompt="${escapedForAttr}" title="Copy the prompt text to clipboard">Copy prompt</button>`;

  let html = marked.parse(preamble);
  html += copyBtn;
  html += `<pre class="deep-dive-prompt"><code>${escaped}</code></pre>`;
  if (epilogue) html += marked.parse(epilogue);

  return html;
}

async function fetchDeepDiveMd(projectId) {
  const container = document.getElementById('deep-dive-md-content');
  // Return cached content without re-fetching.
  if (deepDiveCache[projectId] !== undefined) {
    container.innerHTML = deepDiveCache[projectId];
    return;
  }
  container.innerHTML = '<p class="loading-text">Loading&hellip;</p>';
  if (MODE === 'hosted' && window.__DECRYPTED_DATA__) {
    const text = window.__DECRYPTED_DATA__.deep_dive_md[projectId]
      || '_Not available._';
    const html = renderDeepDiveHtml(text);
    deepDiveCache[projectId] = html;
    container.innerHTML = html;
    return;
  }
  try {
    const res = await fetch(`/api/deep-dive/${encodeURIComponent(projectId)}`);
    const text = await res.text();
    const html = renderDeepDiveHtml(text);
    deepDiveCache[projectId] = html;
    container.innerHTML = html;
  } catch (err) {
    container.innerHTML = `<p class="error-text">Failed to load: ${err.message}</p>`;
  }
}

function renderSidebarScores(project) {
  const grid = document.getElementById('scores-grid');
  const s = project.scores || {};
  const composite = computeComposite(project);
  const ease = computeEase(project);

  const labelMap = (window.__DECRYPTED_DATA__ && window.__DECRYPTED_DATA__.labels && window.__DECRYPTED_DATA__.labels.score_rows) || {};
  const L = (k, fallback) => labelMap[k] || fallback || k || '';
  const rows = [
    { label: L('api_feasibility', 'api_feasibility'),    key: 'api_feasibility',    value: s.api_feasibility },
    { label: L('topic_complexity', 'topic_complexity'),  key: 'topic_complexity',   value: s.topic_complexity },
    { label: L('project_complexity', 'project_complexity'), key: 'project_complexity', value: s.project_complexity },
    { label: L('ease', 'ease'),                          key: null,                 value: ease, computed: true },
    { label: L('domain_learning', 'domain_learning'),    key: 'domain_learning',    value: s.domain_learning },
    { label: L('agentic_ai_learning', 'agentic_ai_learning'), key: 'agentic_ai_learning', value: s.agentic_ai_learning },
    { label: L('reusability_bonus', 'reusability_bonus'), key: 'reusability_bonus', value: s.reusability_bonus },
    { label: L('fun', 'fun'),                            key: 'fun',                value: s.fun },
  ];

  const items = rows.map(row => {
    const isNull = row.value === null || row.value === undefined;
    return `
      <span class="score-label">${row.label}${row.computed ? '' : ''}</span>
      <span class="score-value${isNull ? ' null-score' : ''}">${isNull ? '—' : row.value}</span>
    `;
  }).join('');

  const compositeNull = composite === null;
  grid.innerHTML = items + `
    <div class="score-composite-row">
      <span>Composite &#9733;</span>
      <span class="${compositeNull ? 'null-score' : ''}">${compositeNull ? '—' : composite}</span>
    </div>
  `;
}

function renderSidebarHistory(project) {
  const list = document.getElementById('history-list');
  const history = (project.edit_history || []).slice().reverse(); // newest first

  if (history.length === 0) {
    list.innerHTML = '<li><span class="history-empty">No edits recorded yet.</span></li>';
    return;
  }

  list.innerHTML = history.map(entry => {
    const ts = new Date(entry.ts).toLocaleString('en-GB', {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
    const fromDisplay = entry.from === null || entry.from === undefined ? '(empty)' : entry.from;
    const toDisplay = entry.to === null || entry.to === undefined ? '(cleared)' : entry.to;
    return `
      <li class="history-item">
        <div class="history-ts">${ts}</div>
        <div class="history-change">
          <span class="field-name">${entry.field}</span>:
          ${fromDisplay} &rarr; ${toDisplay}
        </div>
      </li>
    `;
  }).join('');
}

// ============================================================
// Status bar
// ============================================================

function updateStatusBar() {
  const countEl = document.getElementById('status-count');
  const updatedEl = document.getElementById('status-last-updated');
  const n = state.projects.length;
  countEl.textContent = `${n} project${n !== 1 ? 's' : ''}`;
  if (state.updated_at) {
    const d = new Date(state.updated_at);
    updatedEl.textContent = `Last updated: ${d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`;
  }
}

// ============================================================
// Event listeners (wired once on DOMContentLoaded)
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // Column header sort clicks.
  // 'pos' and 'title' are not sortable columns; skip them.
  const UNSORTABLE_COLS = new Set(['pos', 'title']);
  document.querySelectorAll('#projects-table thead th[data-col]').forEach(th => {
    th.addEventListener('click', () => {
      const col = th.dataset.col;
      if (UNSORTABLE_COLS.has(col)) return;
      sortByColumn(col);
    });
  });

  // Sort dropdown.
  // Use 'input' in addition to 'change' to catch browser edge-cases where the
  // value is set programmatically (e.g. after a column-header click syncs the
  // dropdown) and the user then tries to re-select the same option.
  const sortSel = document.getElementById('sort-select');
  sortSel.addEventListener('change', e => {
    sortByColumn(e.target.value);
  });

  // Category filter.
  document.getElementById('category-filter').addEventListener('change', e => {
    state.categoryFilter = e.target.value;
    renderTable();
  });

  // Rebuild button.
  document.getElementById('btn-rebuild').addEventListener('click', rebuild);

  // Sidebar close.
  document.getElementById('sidebar-close').addEventListener('click', closeSidebar);

  // Sidebar tabs.
  document.querySelectorAll('.sidebar-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      setActiveTab(btn.dataset.tab);
      // Ensure deep-dive content is loaded when the tab is activated.
      if (btn.dataset.tab === 'deep-dive' && state.openProjectId) {
        fetchDeepDiveMd(state.openProjectId);
      }
    });
  });

  // Delegated click for the "Copy prompt" button in the deep-dive panel.
  // Uses event delegation so it works after innerHTML replacement (cache hits too).
  document.getElementById('panel-deep-dive').addEventListener('click', e => {
    const btn = e.target.closest('.deep-dive-copy-btn');
    if (!btn) return;
    const promptText = btn.dataset.prompt || '';
    navigator.clipboard.writeText(promptText).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'Copied!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    }).catch(err => console.error('Copy failed:', err));
  });

  // Close sidebar on Escape.
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && state.openProjectId) closeSidebar();
  });

  // Initial data load.
  fetchData();
});
// Hosted mode: re-trigger fetchData when decrypt.js finishes decryption.
document.addEventListener('data-decrypted', () => fetchData());

