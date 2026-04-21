import { emit, on } from './bus.js';

let _root = null;
let _activePaneId = null;
let _container = null;
let _idCounter = 0;
let _dragState = null;

function uid() { return ++_idCounter; }

// ── INIT ─────────────────────────────────────────────────

export function init(container) {
  _container = container;
  _root = makePane();
  _activePaneId = _root.id;

  on('file:loaded', ({ path, content, sha, newTab, paneId }) => {
    openInPane(paneId || _activePaneId, path, content, sha, newTab);
  });

  on('editor:changed', ({ path, content, paneId }) => {
    const pane = findPane(paneId || _activePaneId);
    if (!pane) return;
    const tab = pane.tabs.find(t => t.path === path);
    if (tab) { tab.content = content; tab.isDirty = true; }
    renderTabBar(pane);
  });

  on('file:saved-silent', ({ path }) => {
    allPanes().forEach(pane => {
      const tab = pane.tabs.find(t => t.path === path);
      if (tab) { tab.isDirty = false; renderTabBar(pane); }
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

  const existing = pane.tabs.findIndex(t => t.path === path);
  if (existing !== -1) {
    pane.activeIdx = existing;
    _activePaneId = pane.id;
    renderTabBar(pane);
    renderPaneContent(pane);
    emitActivate(pane);
    return;
  }

  const tab = { path, content, sha, isDirty: false };

  if (inNewTab || pane.tabs.length === 0) {
    pane.tabs.push(tab);
    pane.activeIdx = pane.tabs.length - 1;
  } else {
    if (pane.tabs[pane.activeIdx]?.isDirty) {
      pane.tabs.push(tab);
      pane.activeIdx = pane.tabs.length - 1;
    } else {
      pane.tabs[pane.activeIdx] = tab;
    }
  }

  _activePaneId = pane.id;
  renderTabBar(pane);
  renderPaneContent(pane);
  emitActivate(pane);
}

// ── CLOSE TAB ────────────────────────────────────────────

function closeTab(paneId, tabIdx) {
  const pane = findPane(paneId);
  if (!pane) return;

  pane.tabs.splice(tabIdx, 1);

  if (pane.tabs.length === 0) {
    const isLast = allPanes().length === 1;
    if (isLast) {
      // Pane principal — empty state
      renderTabBar(pane);
      renderPaneContent(pane);
      emit('pane:empty', { paneId });
      return;
    }
    // Pane secondaire — le ferme
    removePane(paneId);
    return;
  }

  pane.activeIdx = Math.min(pane.activeIdx, pane.tabs.length - 1);
  renderTabBar(pane);
  renderPaneContent(pane);
  emitActivate(pane);
}

// ── ACTIVE TAB ───────────────────────────────────────────

function setActiveTab(paneId, tabIdx) {
  const pane = findPane(paneId);
  if (!pane) return;
  pane.activeIdx = tabIdx;
  _activePaneId = pane.id;
  renderTabBar(pane);
  renderPaneContent(pane);
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
  if (!parent) return;

  const idx = parent.children.findIndex(c => c.id === paneId);
  const sibling = parent.children[1 - idx];

  const grandParent = findParent(parent.id);
  if (!grandParent) {
    _root = sibling;
  } else {
    const parentIdx = grandParent.children.findIndex(c => c.id === parent.id);
    grandParent.children[parentIdx] = sibling;
  }

  const firstPane = firstPaneIn(sibling);
  if (firstPane) {
    _activePaneId = firstPane.id;
    emitActivate(firstPane);
  }

  render();
}

// ── RENDER FULL ──────────────────────────────────────────

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

  const tabBar = buildTabBar(pane);
  const content = buildPaneContent(pane);

  el.appendChild(tabBar);
  el.appendChild(content);

  setupPaneEvents(el, pane);
  return el;
}

// ── TAB BAR ──────────────────────────────────────────────

function buildTabBar(pane) {
  const tabBar = document.createElement('div');
  tabBar.className = 'layout-tab-bar';
  tabBar.dataset.paneTabBar = pane.id;

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

  const actions = document.createElement('div');
  actions.className = 'layout-pane-actions';
  actions.innerHTML = `
    <button class="layout-split-btn" data-pane="${pane.id}" data-dir="v" title="Split vertical">&#x2502;</button>
    <button class="layout-split-btn" data-pane="${pane.id}" data-dir="h" title="Split horizontal">&#x2500;</button>
  `;
  tabBar.appendChild(actions);

  setupTabBarEvents(tabBar, pane);
  return tabBar;
}

function renderTabBar(pane) {
  const existing = _container.querySelector(`[data-pane-tab-bar="${pane.id}"]`);
  if (!existing) return;
  const newBar = buildTabBar(pane);
  existing.replaceWith(newBar);
}

function setupTabBarEvents(tabBar, pane) {
  tabBar.querySelectorAll('.layout-tab').forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (e.target.classList.contains('layout-tab-close')) return;
      setActiveTab(tab.dataset.pane, parseInt(tab.dataset.idx));
    });

    tab.addEventListener('auxclick', (e) => {
      if (e.button === 1) { e.preventDefault(); closeTab(tab.dataset.pane, parseInt(tab.dataset.idx)); }
    });

    tab.addEventListener('dragstart', (e) => {
      _dragState = { fromPane: tab.dataset.pane, tabIdx: parseInt(tab.dataset.idx) };
      e.dataTransfer.effectAllowed = 'move';
      tab.classList.add('dragging');
    });

    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
  });

  tabBar.querySelectorAll('.layout-tab-close').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeTab(btn.dataset.pane, parseInt(btn.dataset.idx));
    });
  });

  tabBar.querySelectorAll('.layout-split-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      splitPane(btn.dataset.pane, btn.dataset.dir);
    });
  });
}

// ── PANE CONTENT ─────────────────────────────────────────

function buildPaneContent(pane) {
  const content = document.createElement('div');
  content.className = 'layout-pane-content';
  content.dataset.paneContent = pane.id;

  if (pane.tabs.length === 0) {
    content.innerHTML = `<div class="layout-empty-state">Open a file or drop a tab here</div>`;
    setupDropTarget(content, pane);
    return content;
  }

  const activeTab = pane.tabs[pane.activeIdx];

  if (activeTab?.path === '__graph__') {
    const canvas = document.createElement('canvas');
    canvas.className = 'layout-graph-canvas';
    canvas.dataset.pane = pane.id;
    content.appendChild(canvas);
    setTimeout(() => {
      const rect = content.getBoundingClientRect();
      canvas.width = rect.width || 600;
      canvas.height = rect.height || 400;
      emit('graph:mount', { paneId: pane.id, canvas });
    }, 80);
  } else {
    const editor = document.createElement('textarea');
    editor.className = 'layout-editor';
    editor.dataset.pane = pane.id;
    editor.spellcheck = false;
    editor.value = activeTab?.content || '';

    const preview = document.createElement('div');
    preview.className = 'layout-preview hidden';
    preview.dataset.pane = pane.id;

    content.appendChild(editor);
    content.appendChild(preview);

    setupEditorEvents(editor, preview, pane);
  }

  setupDropTarget(content, pane);
  return content;
}

function renderPaneContent(pane) {
  const existing = _container.querySelector(`[data-pane-content="${pane.id}"]`);
  if (!existing) return;
  const newContent = buildPaneContent(pane);
  existing.replaceWith(newContent);
}

// ── EDITOR EVENTS ────────────────────────────────────────

function setupEditorEvents(editor, preview, pane) {
  editor.addEventListener('input', () => {
    const tab = pane.tabs[pane.activeIdx];
    if (!tab) return;
    tab.content = editor.value;
    tab.isDirty = true;
    renderTabBar(pane);
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
      togglePreview(editor, preview, pane);
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
    if (e.ctrlKey && e.key === 'Tab') {
      e.preventDefault();
      if (pane.tabs.length > 1) setActiveTab(pane.id, (pane.activeIdx + 1) % pane.tabs.length);
    }
  });
}

function togglePreview(editor, preview, pane) {
  const isPreview = !preview.classList.contains('hidden');
  if (isPreview) {
    preview.classList.add('hidden');
    editor.classList.remove('hidden');
  } else {
    const tab = pane.tabs[pane.activeIdx];
    if (!tab) return;
    preview.innerHTML = renderMarkdown(tab.content || '');
    preview.classList.remove('hidden');
    editor.classList.add('hidden');

    preview.querySelectorAll('.ob-link').forEach(a => {
      a.addEventListener('click', (e) => {
        e.preventDefault();
        emit('file:open-by-name', { name: a.dataset.target, paneId: pane.id });
      });
    });
  }
}

function renderMarkdown(content) {
  const clean = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  if (typeof marked === 'undefined') return clean;

  // Parse Obsidian links
  const withLinks = clean
    .replace(/!\[\[([^\]]+)\]\]/g, (_, src) => `![${src}](attachment://${src.split('|')[0].trim()})`)
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_, path, alias) =>
      `<a class="ob-link" data-target="${path}" href="#">${alias || path}</a>`
    );

  return marked.parse(withLinks);
}

// ── DROP TARGET ──────────────────────────────────────────

function setupDropTarget(el, pane) {
  // Zones de drop sur les 4 bords — apparaissent seulement pendant le drag
  const zones = ['top', 'bottom', 'left', 'right'];

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
    zone.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.stopPropagation();
      // Highlight seulement la zone survolée
      overlay.querySelectorAll('.layout-drop-zone').forEach(z => z.classList.remove('hover'));
      zone.classList.add('hover');
    });
    zone.addEventListener('dragleave', () => zone.classList.remove('hover'));
    zone.addEventListener('drop', (e) => {
      e.preventDefault();
      e.stopPropagation();
      overlay.classList.add('hidden');
      overlay.querySelectorAll('.layout-drop-zone').forEach(z => z.classList.remove('hover'));

      if (!_dragState) return;
      const { fromPane, tabIdx } = _dragState;
      _dragState = null;

      handleTabDrop(fromPane, tabIdx, pane.id, zone.dataset.zone);
    });
  });
}

function handleTabDrop(fromPaneId, tabIdx, toPaneId, zone) {
  if (fromPaneId === toPaneId) return;

  const fromPane = findPane(fromPaneId);
  if (!fromPane) return;

  const tab = { ...fromPane.tabs[tabIdx] };

  // Retire du pane source
  fromPane.tabs.splice(tabIdx, 1);
  if (fromPane.tabs.length === 0 && allPanes().length > 1) {
    removePane(fromPaneId);
  } else if (fromPane.tabs.length > 0) {
    fromPane.activeIdx = Math.min(fromPane.activeIdx, fromPane.tabs.length - 1);
    renderTabBar(fromPane);
    renderPaneContent(fromPane);
  }

  // Direction du split selon le bord
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
  emitActivate(newPane);
}

// ── SPLIT EL ─────────────────────────────────────────────

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

// ── PANE EVENTS ──────────────────────────────────────────

function setupPaneEvents(el, pane) {
  el.addEventListener('mousedown', () => {
    if (_activePaneId !== pane.id) {
      _activePaneId = pane.id;
      _container.querySelectorAll('.layout-pane').forEach(p => p.classList.remove('active'));
      el.classList.add('active');
      emitActivate(pane);
    }
  });
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
        splitNode.ratio = Math.min(0.85, Math.max(0.15, startRatio + (e.clientX - startX) / rect.width));
      } else {
        splitNode.ratio = Math.min(0.85, Math.max(0.15, startRatio + (e.clientY - startY) / rect.height));
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

// ── GRAPH ────────────────────────────────────────────────

export function openGraphInPane(paneId) {
  const pane = findPane(paneId || _activePaneId);
  if (!pane) return;

  const existing = pane.tabs.findIndex(t => t.path === '__graph__');
  if (existing !== -1) {
    setActiveTab(pane.id, existing);
    return;
  }

  pane.tabs.push({ path: '__graph__', content: '', sha: null, isDirty: false });
  pane.activeIdx = pane.tabs.length - 1;
  renderTabBar(pane);
  renderPaneContent(pane);
}

// ── TREE UTILS ───────────────────────────────────────────

function findPane(id) {
  function walk(node) {
    if (!node) return null;
    if (node.type === 'pane' && node.id == id) return node;
    if (node.type === 'split') return walk(node.children[0]) || walk(node.children[1]);
    return null;
  }
  return walk(_root);
}

function findParent(id) {
  function walk(node, parent) {
    if (!node) return null;
    if (node.id == id) return parent;
    if (node.type === 'split') return walk(node.children[0], node) || walk(node.children[1], node);
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

// ── GETTERS ──────────────────────────────────────────────

export function getActivePane() { return findPane(_activePaneId); }
export function getActivePaneId() { return _activePaneId; }
export function getDirtyTabs() { return allPanes().flatMap(p => p.tabs.filter(t => t.isDirty && t.path !== '__graph__')); }
export function updateTabSha(path, sha) {
  allPanes().forEach(p => { const t = p.tabs.find(t => t.path === path); if (t) t.sha = sha; });
}