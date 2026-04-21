import { emit, on } from './bus.js';

// State
const _tabs = [];
let _activeIdx = 0;
let _container = null;

// ── INIT ─────────────────────────────────────────────────

export function init() {
  _container = createTabBar();
  setupEvents();

  on('file:opened', ({ path, content, sha }) => {
    // Appelé après un file:open — met à jour le contenu de l'onglet actif
    const tab = _tabs[_activeIdx];
    if (tab && tab.path === path) {
      tab.content = content;
      tab.sha = sha;
      tab.isDirty = false;
      render();
    }
  });

  on('editor:changed', ({ path, content }) => {
    const tab = _tabs.find(t => t.path === path);
    if (tab) {
      tab.content = content;
      tab.isDirty = true;
      render();
    }
  });

  on('file:saved-silent', ({ path, content, sha }) => {
    const tab = _tabs.find(t => t.path === path);
    if (tab) {
      tab.content = content;
      if (sha) tab.sha = sha;
      tab.isDirty = false;
      render();
    }
  });

  on('file:deleted', ({ path }) => {
    const idx = _tabs.findIndex(t => t.path === path);
    if (idx !== -1) closeTab(idx);
  });
}

// ── TAB BAR ──────────────────────────────────────────────

function createTabBar() {
  const bar = document.createElement('div');
  bar.className = 'tab-bar';
  bar.id = 'tab-bar';

  // Insère entre le topbar et l'editor-area
  const editorArea = document.getElementById('editor-area');
  editorArea.parentNode.insertBefore(bar, editorArea);

  return bar;
}

// ── OPEN ─────────────────────────────────────────────────

export function openTab(path, content, sha, inNewTab = false) {
  // Vérifie si la note est déjà ouverte dans un onglet
  const existing = _tabs.findIndex(t => t.path === path);
  if (existing !== -1) {
    setActive(existing);
    return;
  }

  const tab = { path, content, sha, isDirty: false };

  if (inNewTab || _tabs.length === 0) {
    _tabs.push(tab);
    setActive(_tabs.length - 1);
  } else {
    // Remplace l'onglet actif si pas dirty, sinon ouvre à côté
    if (_tabs[_activeIdx] && _tabs[_activeIdx].isDirty) {
      _tabs.push(tab);
      setActive(_tabs.length - 1);
    } else {
      _tabs[_activeIdx] = tab;
      render();
      emitActive();
    }
  }
}

// ── CLOSE ────────────────────────────────────────────────

export function closeTab(idx) {
  if (_tabs.length === 0) return;

  _tabs.splice(idx, 1);

  if (_tabs.length === 0) {
    _activeIdx = 0;
    emit('tabs:empty');
    render();
    return;
  }

  // Recalcule l'index actif
  if (_activeIdx >= _tabs.length) {
    _activeIdx = _tabs.length - 1;
  } else if (idx < _activeIdx) {
    _activeIdx--;
  }

  render();
  emitActive();
}

// ── ACTIVE ───────────────────────────────────────────────

function setActive(idx) {
  _activeIdx = idx;
  render();
  emitActive();
}

function emitActive() {
  const tab = _tabs[_activeIdx];
  if (!tab) return;
  emit('tab:activate', { path: tab.path, content: tab.content, sha: tab.sha });
}

// ── RENDER ───────────────────────────────────────────────

export function render() {
  if (!_container) return;

  if (_tabs.length === 0) {
    _container.innerHTML = '';
    _container.style.display = 'none';
    return;
  }

  _container.style.display = 'flex';
  _container.innerHTML = _tabs.map((tab, i) => {
    const name = tab.path.split('/').pop().replace(/\.md$/, '');
    const isActive = i === _activeIdx;
    return `
      <div class="tab-item ${isActive ? 'active' : ''}" data-idx="${i}">
        <span class="tab-name">${name}${tab.isDirty ? ' \u25CF' : ''}</span>
        <button class="tab-close" data-idx="${i}" title="Close">&#x2715;</button>
      </div>
    `;
  }).join('');

  // Clicks sur les onglets
  _container.querySelectorAll('.tab-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.classList.contains('tab-close')) return;
      setActive(parseInt(el.dataset.idx));
    });

    // Clic molette → ferme l'onglet
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(parseInt(el.dataset.idx));
      }
    });
  });

  _container.querySelectorAll('.tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(parseInt(btn.dataset.idx));
    });
  });
}

// ── EVENTS ───────────────────────────────────────────────

function setupEvents() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+W — ferme l'onglet actif
    if (e.ctrlKey && e.key === 'w') {
      e.preventDefault();
      if (_tabs.length > 0) closeTab(_activeIdx);
    }

    // Ctrl+Tab — onglet suivant
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (_tabs.length > 1) {
        setActive((_activeIdx + 1) % _tabs.length);
      }
    }
  });
}

// ── GETTERS ──────────────────────────────────────────────

export function getActiveTab() {
  return _tabs[_activeIdx] || null;
}

export function getAllTabs() {
  return _tabs;
}

export function updateTabSha(path, sha) {
  const tab = _tabs.find(t => t.path === path);
  if (tab) tab.sha = sha;
}

export function getDirtyTabs() {
  return _tabs.filter(t => t.isDirty);
}