import { emit, on } from './bus.js';

// Un layout est un arbre de noeuds :
// { type: 'pane', id, tabs: [{path,content,sha,isDirty}], activeIdx }
// { type: 'split', id, direction: 'h'|'v', ratio: 0-1, children: [node, node] }

let _root = null;
let _activePaneId = null;
let _container = null;
let _idCounter = 0;
let _dragState = null;

function uid() { return ++_idCounter; }

// ── INIT ─────────────────────────────────────────────────

export function init(container) {
  _container = container;

  // Pane initial vide
  _root = makePane();
  _activePaneId = _root.id;

  on('file:open', async ({ path, content, sha, newTab, paneId }) => {
    if (content !== undefined) {
      // Contenu déjà chargé
      openInPane(paneId || _activePaneId, path, content, sha, newTab);
    }
    // Sinon app.js charge et re-émet avec content
  });

  on('file:loaded', ({ path, content, sha, newTab, paneId }) => {
    openInPane(paneId || _activePaneId, path, content, sha, newTab);
  });

  on('tab:close', ({ paneId, tabIdx }) => {
    closeTab(paneId, tabIdx);
  });

  on('tab:activate', ({ paneId, tabIdx }) => {
    setActiveTab(paneId, tabIdx);
  });

  on('editor:changed', ({ path, content, paneId }) => {
    const pane = findPane(paneId || _activePaneId);
    if (!pane) return;
    const tab = pane.tabs.find(t => t.path === path);
    if (tab) { tab.content = content; tab.isDirty = true; }
    renderPane(paneId || _activePaneId);
  });

  on('file:saved-silent', ({ path }) => {
    // Marque tous les onglets avec ce path comme clean
    allPanes().forEach(pane => {
      const tab = pane.tabs.find(t => t.path === path);
      if (tab) tab.isDirty = false;
      renderPane(pane.id);
    });
  });

  on('split:pane', ({ paneId, direction }) => {
    splitPane(paneId || _activePaneId, direction);
  });

  render();
}

// ── FACTORIES ────────────────────────────────────────────

function makePane(tabs = []) {
  return { type: 'pane', id: uid(), tabs, activeIdx: 0 };
}

function makeSplit(direction, ratio, a, b) {
  return { type: 'split', id: uid(), direction, ratio, children: [a, b] };
}

// ── OPEN IN PANE ─────────────────────────────────────────

export function openInPane(paneId, path, content, sha, inNewTab = false) {
  const pane = findPane(paneId);
  if (!pane) return;

  // Déjà ouvert dans ce pane ?
  const existing = pane.tabs.findIndex(t => t.path === path);
  if (existing !== -1) {
    pane.activeIdx = existing;
    _activePaneId = pane.id;
    renderPane(pane.id);
    emitActivate(pane);
    return;
  }

  const tab = { path, content, sha, isDirty: false };

  if (inNewTab || pane.tabs.length === 0) {
    pane.tabs.push(tab);
    pane.activeIdx = pane.tabs.length - 1;
  } else {
    // Remplace l'onglet actif si pas dirty
    if (pane.tabs[pane.activeIdx]?.isDirty) {
      pane.tabs.push(tab);
      pane.activeIdx = pane.tabs.length - 1;
    } else {
      pane.tabs[pane.activeIdx] = tab;
    }
  }

  _activePaneId = pane.id;
  renderPane(pane.id);
  emitActivate(pane);
}

// ── CLOSE TAB ────────────────────────────────────────────

function closeTab(paneId, tabIdx) {
  const pane = findPane(paneId);
  if (!pane) return;

  pane.tabs.splice(tabIdx, 1);

  if (pane.tabs.length === 0) {
    // Supprime le pane si plus d'onglets (sauf si c'est le seul)
    if (allPanes().length > 1) {
      removePane(paneId);
      return;
    }
    // Sinon affiche empty state
    renderPane(pane.id);
    emit('pane:empty', { paneId });
    return;
  }

  pane.activeIdx = Math.min(pane.activeIdx, pane.tabs.length - 1);
  renderPane(pane.id);
  emitActivate(pane);
}

// ── ACTIVE TAB ───────────────────────────────────────────

function setActiveTab(paneId, tabIdx) {
  const pane = findPane(paneId);
  if (!pane) return;
  pane.activeIdx = tabIdx;
  _activePaneId = pane.id;
  renderPane(pane.id);
  emitActivate(pane);
}

function emitActivate(pane) {
  const tab = pane.tabs[pane.activeIdx];
  if (!tab) return;
  emit('pane:tab-activated', {
    paneId: pane.id,
    path: tab.path,
    content: tab.content,
    sha: tab.sha,
  });
}

// ── SPLIT ────────────────────────────────────────────────

export function splitPane(paneId, direction) {
  const newPane = makePane();
  const parent = findParent(paneId);

  if (!parent) {
    // C'est le root
    _root = makeSplit(direction, 0.5, _root, newPane);
  } else {
    const idx = parent.children.findIndex(c => c.id === paneId);
    const oldChild = parent.children[idx];
    parent.children[idx] = makeSplit(direction, 0.5, oldChild, newPane);
  }

  _activePaneId = newPane.id;
  render();
}

// ── REMOVE PANE ──────────────────────────────────────────

function removePane(paneId) {
  const parent = findParent(paneId);
  if (!parent) return; // root, on peut pas supprimer

  const idx = parent.children.findIndex(c => c.id === paneId);
  const sibling = parent.children[1 - idx];

  // Remplace le split par le sibling dans le grand-parent
  const grandParent = findParent(parent.id);
  if (!grandParent) {
    _root = sibling;
  } else {
    const parentIdx = grandParent.children.findIndex(c => c.id === parent.id);
    grandParent.children[parentIdx] = sibling;
  }

  // Active le pane sibling
  const firstPane = firstPaneIn(sibling);
  if (firstPane) {
    _activePaneId = firstPane.id;
    emitActivate(firstPane);
  }

  render();
}

// ── RENDER ───────────────────────────────────────────────

export function render() {
  if (!_container) return;
  _container.innerHTML = '';
  _container.appendChild(renderNode(_root));
}

function renderNode(node) {
  if (node.type === 'pane') return renderPaneEl(node);
  return renderSplitEl(node);
}

function renderPaneEl(pane) {
  const el = document.createElement('div');
  el.className = `layout-pane ${pane.id === _activePaneId ? 'active' : ''}`;
  el.dataset.paneId = pane.id;

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'layout-tab-bar';
  tabBar.dataset.paneId = pane.id;

  if (pane.tabs.length === 0) {
    tabBar.innerHTML = `<span class="layout-tab-empty">Empty pane</span>`;
  } else {
    tabBar.innerHTML = pane.tabs.map((tab, i) => {
      const name = tab.path === '__graph__'
        ? 'Graph'
        : tab.path.split('/').pop().replace(/\.md$/, '');
      const isActive = i === pane.activeIdx;
      return `
        <div class="layout-tab ${isActive ? 'active' : ''}" data-pane="${pane.id}" data-idx="${i}" draggable="true">
          <span class="layout-tab-name">${name}${tab.isDirty ? ' \u25CF' : ''}</span>
          <button class="layout-tab-close" data-pane="${pane.id}" data-idx="${i}">\u2715</button>
        </div>
      `;
    }).join('');
  }

  // Actions pane (split buttons)
  const actions = document.createElement('div');
  actions.className = 'layout-pane-actions';
  actions.innerHTML = `
    <button class="layout-split-btn" data-pane="${pane.id}" data-dir="v" title="Split vertical">&#x2502;</button>
    <button class="layout-split-btn" data-pane="${pane.id}" data-dir="h" title="Split horizontal">&#x2500;</button>
  `;
  tabBar.appendChild(actions);

  // Content
  const content = document.createElement('div');
  content.className = 'layout-pane-content';
  content.dataset.paneId = pane.id;

  if (pane.tabs.length === 0) {
    content.innerHTML = `<div class="layout-empty-state">Drop a file here or open one</div>`;
  } else {
    const activeTab = pane.tabs[pane.activeIdx];
    if (activeTab?.path === '__graph__') {
      content.innerHTML = `<canvas class="layout-graph-canvas" data-pane="${pane.id}"></canvas>`;
    } else {
      content.innerHTML = `
        <textarea class="layout-editor" data-pane="${pane.id}" spellcheck="false">${escHtml(activeTab?.content || '')}</textarea>
        <div class="layout-preview hidden" data-pane="${pane.id}"></div>
      `;
    }
  }

  el.appendChild(tabBar);
  el.appendChild(content);

  setupPaneEvents(el, pane);
  return el;
}

function renderSplitEl(node) {
  const el = document.createElement('div');
  el.className = `layout-split layout-split-${node.direction === 'h' ? 'horizontal' : 'vertical'}`;
  el.dataset.splitId = node.id;

  const a = document.createElement('div');
  a.className = 'layout-split-child';
  a.style.flexBasis = `${node.ratio * 100}%`;
  a.appendChild(renderNode(node.children[0]));

  const handle = document.createElement('div');
  handle.className = `layout-resize-handle layout-resize-${node.direction}`;
  handle.dataset.splitId = node.id;
  setupResizeHandle(handle, node, a);

  const b = document.createElement('div');
  b.className = 'layout-split-child';
  b.style.flex = '1';
  b.appendChild(renderNode(node.children[1]));

  el.appendChild(a);
  el.appendChild(handle);
  el.appendChild(b);

  return el;
}

function renderPane(paneId) {
  const el = _container.querySelector(`[data-pane-id="${paneId}"]`);
  if (!el) { render(); return; }
  const pane = findPane(paneId);
  if (!pane) return;
  const newEl = renderPaneEl(pane);
  el.replaceWith(newEl);
}

// ── PANE EVENTS ──────────────────────────────────────────

function setupPaneEvents(el, pane) {
  // Focus pane au clic
  el.addEventListener('mousedown', () => {
    if (_activePaneId !== pane.id) {
      _activePaneId = pane.id;
      _container.querySelectorAll('.layout-pane').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      emitActivate(pane);
    }
  });

  // Tabs — clic
  el.querySelectorAll('.layout-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('layout-tab-close')) return;
      setActiveTab(tab.dataset.pane, parseInt(tab.dataset.idx));
    });

    // Clic molette → ferme
    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        closeTab(tab.dataset.pane, parseInt(tab.dataset.idx));
      }
    });

    // Drag tab
    tab.addEventListener('dragstart', (e) => {
      _dragState = { fromPane: tab.dataset.pane, tabIdx: parseInt(tab.dataset.idx) };
      e.dataTransfer.effectAllowed = 'move';
    });
  });

  // Tabs — fermeture
  el.querySelectorAll('.layout-tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(btn.dataset.pane, parseInt(btn.dataset.idx));
    });
  });

  // Split buttons
  el.querySelectorAll('.layout-split-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      splitPane(btn.dataset.pane, btn.dataset.dir);
    });
  });

  // Drop zones
  setupDropZones(el, pane);

  // Editor input
  const editor = el.querySelector('.layout-editor');
  if (editor) {
    editor.addEventListener('input', () => {
      const tab = pane.tabs[pane.activeIdx];
      if (!tab) return;
      tab.content = editor.value;
      tab.isDirty = true;

      // Met à jour le titre de l'onglet
      const tabEl = el.querySelector(`.layout-tab[data-idx="${pane.activeIdx}"]`);
      if (tabEl) {
        const nameEl = tabEl.querySelector('.layout-tab-name');
        if (nameEl) {
          const name = tab.path.split('/').pop().replace(/\.md$/, '');
          nameEl.textContent = `${name} \u25CF`;
        }
      }

      emit('editor:changed', { path: tab.path, content: editor.value, paneId: pane.id });
    });

    editor.addEventListener('keydown', (e) => {
      if (e.key === 'Tab') {
        e.preventDefault();
        const s = editor.selectionStart;
        editor.value = editor.value.slice(0, s) + '  ' + editor.value.slice(editor.selectionEnd);
        editor.selectionStart = editor.selectionEnd = s + 2;
      }
      if (e.ctrlKey && e.key === 'e') {
        e.preventDefault();
        togglePreviewInPane(pane, el);
      }
      if (e.ctrlKey && e.key === 's') {
        e.preventDefault();
        const tab = pane.tabs[pane.activeIdx];
        if (tab) emit('file:save', { path: tab.path, content: editor.value, paneId: pane.id });
      }
      if (e.ctrlKey && e.key === 'w') {
        e.preventDefault();
        closeTab(pane.id, pane.activeIdx);
      }
    });
  }

  // Keyboard shortcuts globaux pour le pane actif
  el.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (pane.tabs.length > 1) {
        setActiveTab(pane.id, (pane.activeIdx + 1) % pane.tabs.length);
      }
    }
  });
}

// ── PREVIEW IN PANE ──────────────────────────────────────

function togglePreviewInPane(pane, el) {
  const editor = el.querySelector('.layout-editor');
  const preview = el.querySelector('.layout-preview');
  if (!editor || !preview) return;

  const isPreview = !preview.classList.contains('hidden');
  if (isPreview) {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
  } else {
    const tab = pane.tabs[pane.activeIdx];
    if (!tab) return;
    preview.innerHTML = renderMarkdownInPane(tab.content || '');
    preview.classList.remove('hidden');
    editor.classList.add('hidden');

    // Liens internes
    preview.querySelectorAll('.ob-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        emit('file:open-by-name', { name: a.dataset.target, paneId: pane.id });
      });
    });
  }
}

function renderMarkdownInPane(content) {
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return typeof marked !== 'undefined' ? marked.parse(withoutFrontmatter) : withoutFrontmatter;
}

// ── DROP ZONES ───────────────────────────────────────────

function setupDropZones(el, pane) {
  const zones = ['top', 'bottom', 'left', 'right', 'center'];

  const overlay = document.createElement('div');
  overlay.className = 'layout-drop-overlay hidden';
  overlay.innerHTML = zones.map(z =>
    `<div class="layout-drop-zone layout-drop-${z}" data-zone="${z}" data-pane="${pane.id}"></div>`
  ).join('');
  el.appendChild(overlay);

  el.addEventListener('dragover', (e) => {
    if (!_dragState) return;
    e.preventDefault();
    overlay.classList.remove('hidden');
  });

  el.addEventListener('dragleave', (e) => {
    if (!el.contains(e.relatedTarget)) overlay.classList.add('hidden');
  });

  overlay.querySelectorAll('.layout-drop-zone').forEach(zone => {
    zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('hover'); });
    zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      overlay.classList.add('hidden');
      zone.classList.remove('hover');

      if (!_dragState) return;
      const { fromPane, tabIdx } = _dragState;
      _dragState = null;

      handleTabDrop(fromPane, tabIdx, pane.id, zone.dataset.zone);
    });
  });
}

function handleTabDrop(fromPaneId, tabIdx, toPaneId, zone) {
  const fromPane = findPane(fromPaneId);
  if (!fromPane) return;

  const tab = fromPane.tabs[tabIdx];
  if (!tab) return;

  // Retire le tab du pane source
  fromPane.tabs.splice(tabIdx, 1);
  if (fromPane.tabs.length === 0 && allPanes().length > 1) {
    removePane(fromPaneId);
  } else {
    fromPane.activeIdx = Math.min(fromPane.activeIdx, Math.max(0, fromPane.tabs.length - 1));
  }

  if (zone === 'center') {
    // Dépose dans le pane cible
    const toPane = findPane(toPaneId);
    if (toPane) {
      toPane.tabs.push(tab);
      toPane.activeIdx = toPane.tabs.length - 1;
      _activePaneId = toPane.id;
    }
    render();
  } else {
    // Split le pane cible
    const direction = (zone === 'left' || zone === 'right') ? 'v' : 'h';
    const newPane = makePane([tab]);
    const target = findPane(toPaneId);
    if (!target) { render(); return; }

    const first = (zone === 'top' || zone === 'left') ? newPane : target;
    const second = (zone === 'top' || zone === 'left') ? target : newPane;
    const split = makeSplit(direction, 0.5, first, second);

    const parent = findParent(toPaneId);
    if (!parent) {
      _root = split;
    } else {
      const idx = parent.children.findIndex(c => c.id === toPaneId);
      parent.children[idx] = split;
    }

    _activePaneId = newPane.id;
    render();
  }
}

// ── RESIZE ───────────────────────────────────────────────

function setupResizeHandle(handle, splitNode, firstChild) {
  let startX, startY, startRatio;

  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startX = e.clientX;
    startY = e.clientY;
    startRatio = splitNode.ratio;
    document.body.style.cursor = splitNode.direction === 'v' ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';

    const onMove = (e) => {
      const rect = _container.getBoundingClientRect();
      if (splitNode.direction === 'v') {
        const total = rect.width;
        const delta = (e.clientX - startX) / total;
        splitNode.ratio = Math.min(0.85, Math.max(0.15, startRatio + delta));
      } else {
        const total = rect.height;
        const delta = (e.clientY - startY) / total;
        splitNode.ratio = Math.min(0.85, Math.max(0.15, startRatio + delta));
      }
      firstChild.style.flexBasis = `${splitNode.ratio * 100}%`;
    };

    const onUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── TREE UTILS ───────────────────────────────────────────

function findPane(id) {
  function walk(node) {
    if (!node) return null;
    if (node.type === 'pane' && node.id == id) return node;
    if (node.type === 'split') {
      return walk(node.children[0]) || walk(node.children[1]);
    }
    return null;
  }
  return walk(_root);
}

function findParent(id) {
  function walk(node, parent) {
    if (!node) return null;
    if (node.id == id) return parent;
    if (node.type === 'split') {
      return walk(node.children[0], node) || walk(node.children[1], node);
    }
    return null;
  }
  return walk(_root, null);
}

function allPanes() {
  const panes = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'pane') panes.push(node);
    else { walk(node.children[0]); walk(node.children[1]); }
  }
  walk(_root);
  return panes;
}

function firstPaneIn(node) {
  if (!node) return null;
  if (node.type === 'pane') return node;
  return firstPaneIn(node.children[0]);
}

// ── GETTERS PUBLICS ──────────────────────────────────────

export function getActivePane() { return findPane(_activePaneId); }
export function getActivePaneId() { return _activePaneId; }

export function getDirtyTabs() {
  return allPanes().flatMap(p => p.tabs.filter(t => t.isDirty));
}

export function updateTabSha(path, sha) {
  allPanes().forEach(p => {
    const tab = p.tabs.find(t => t.path === path);
    if (tab) tab.sha = sha;
  });
}

export function openGraphInPane(paneId) {
  const pane = findPane(paneId || _activePaneId);
  if (!pane) return;
  const existing = pane.tabs.findIndex(t => t.path === '__graph__');
  if (existing !== -1) { pane.activeIdx = existing; renderPane(pane.id); return; }
  pane.tabs.push({ path: '__graph__', content: '', sha: null, isDirty: false });
  pane.activeIdx = pane.tabs.length - 1;
  renderPane(pane.id);
  // Re-init le canvas graph
  setTimeout(() => emit('graph:mount', { paneId: pane.id }), 50);
}

// ── UTILS ────────────────────────────────────────────────

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}