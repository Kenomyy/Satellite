import { emit, on } from './bus.js';

let _tree = [];
let _activeFile = null;
let _container = null;
let _contextTarget = null;

// ─── INIT ────────────────────────────────────────────────

export function init(container) {
  _container = container;

  on('tree:loaded', ({ tree }) => {
    _tree = tree;
    render();
  });

  on('file:opened', ({ path }) => {
    _activeFile = path;
    updateActive();
  });

  on('tree:refresh', () => render());

  setupContextMenu();
}

// ─── RENDER ──────────────────────────────────────────────

export function render() {
  if (!_container) return;
  _container.innerHTML = '';
  _tree.forEach(node => _container.appendChild(renderNode(node, 0)));
}

function renderNode(node, depth) {
  if (node.type === 'tree') {
    return renderFolder(node, depth);
  }
  return renderFile(node, depth);
}

function renderFolder(node, depth) {
  const wrapper = document.createElement('div');

  const row = document.createElement('div');
  row.className = 'explorer-item folder';
  row.dataset.path = node.path;
  row.style.paddingLeft = `${12 + depth * 14}px`;

  row.innerHTML = `
    <svg class="chevron" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M6 4l4 4-4 4"/>
    </svg>
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
      <path d="M2 4.5A1.5 1.5 0 013.5 3h3l1.5 1.5H12.5A1.5 1.5 0 0114 6v5.5A1.5 1.5 0 0112.5 13h-9A1.5 1.5 0 012 11.5v-7z"/>
    </svg>
    <span class="explorer-folder-name">${node.name}</span>
  `;

  const children = document.createElement('div');
  children.className = 'explorer-children';

  // Restore open state from sessionStorage
  const isOpen = sessionStorage.getItem(`folder:${node.path}`) === 'open';
  if (isOpen) {
    row.classList.add('open');
    children.classList.add('open');
  }

  node.children.forEach(child => {
    children.appendChild(renderNode(child, depth + 1));
  });

  row.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = row.classList.toggle('open');
    children.classList.toggle('open', open);
    sessionStorage.setItem(`folder:${node.path}`, open ? 'open' : 'closed');
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, node, 'folder');
  });

  wrapper.appendChild(row);
  wrapper.appendChild(children);
  return wrapper;
}

function renderFile(node, depth) {
  const row = document.createElement('div');
  row.className = 'explorer-item file';
  row.dataset.path = node.path;
  row.style.paddingLeft = `${12 + depth * 14}px`;

  const isMarkdown = node.name.endsWith('.md');
  const icon = isMarkdown
    ? `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z"/><path d="M9 2v4h4"/></svg>`
    : `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M9 2H4a1 1 0 00-1 1v10a1 1 0 001 1h8a1 1 0 001-1V6L9 2z"/><path d="M9 2v4h4"/></svg>`;

  const displayName = node.name.replace(/\.md$/, '');

  row.innerHTML = `${icon}<span>${displayName}</span>`;

  if (_activeFile === node.path) row.classList.add('active');

  row.addEventListener('click', () => {
    emit('file:open', { path: node.path, sha: node.sha });
  });

  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    showContextMenu(e, node, 'file');
  });

  return row;
}

// ─── ACTIVE STATE ────────────────────────────────────────

function updateActive() {
  _container.querySelectorAll('.explorer-item.active').forEach(el => {
    el.classList.remove('active');
  });

  if (!_activeFile) return;

  const el = _container.querySelector(`[data-path="${_activeFile}"]`);
  if (el) {
    el.classList.add('active');
    // Ouvre les dossiers parents si nécessaire
    expandParents(_activeFile);
  }
}

function expandParents(path) {
  const parts = path.split('/');
  for (let i = 1; i < parts.length; i++) {
    const parentPath = parts.slice(0, i).join('/');
    const parentEl = _container.querySelector(`.folder[data-path="${parentPath}"]`);
    if (parentEl && !parentEl.classList.contains('open')) {
      parentEl.classList.add('open');
      const children = parentEl.nextElementSibling;
      if (children) children.classList.add('open');
      sessionStorage.setItem(`folder:${parentPath}`, 'open');
    }
  }
}

// ─── CONTEXT MENU ────────────────────────────────────────

function setupContextMenu() {
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  document.addEventListener('click', () => hideContextMenu());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideContextMenu();
  });

  menu.addEventListener('click', (e) => {
    const action = e.target.dataset.action;
    if (!action || !_contextTarget) return;
    handleContextAction(action, _contextTarget);
    hideContextMenu();
  });
}

function showContextMenu(e, node, type) {
  const menu = document.getElementById('context-menu');
  if (!menu) return;

  _contextTarget = { node, type };

  // Adapte les items selon le type
  menu.innerHTML = type === 'file'
    ? `
      <button class="context-item" data-action="rename">Rename</button>
      <button class="context-item" data-action="delete">Delete</button>
      <button class="context-item" data-action="new-file">New file here</button>
    `
    : `
      <button class="context-item" data-action="rename">Rename folder</button>
      <button class="context-item" data-action="delete-folder">Delete folder</button>
      <button class="context-item" data-action="new-file">New file here</button>
      <button class="context-item" data-action="new-folder">New folder here</button>
    `;

  menu.style.left = `${e.clientX}px`;
  menu.style.top = `${e.clientY}px`;
  menu.classList.remove('hidden');
}

function hideContextMenu() {
  const menu = document.getElementById('context-menu');
  if (menu) menu.classList.add('hidden');
  _contextTarget = null;
}

function handleContextAction(action, { node }) {
  switch (action) {
    case 'rename':
      emit('file:rename-request', { path: node.path, name: node.name });
      break;
    case 'delete':
      emit('file:delete-request', { path: node.path, sha: node.sha });
      break;
    case 'delete-folder':
      emit('folder:delete-request', { path: node.path });
      break;
    case 'new-file':
      emit('file:new-request', { folder: node.type === 'tree' ? node.path : parentPath(node.path) });
      break;
    case 'new-folder':
      emit('folder:new-request', { parent: node.path });
      break;
  }
}

// ─── FILTER (search) ─────────────────────────────────────

export function filter(query) {
  if (!query) {
    render();
    return;
  }

  const q = query.toLowerCase();
  const matches = flatFiles(_tree).filter(f =>
    f.name.toLowerCase().includes(q) || f.path.toLowerCase().includes(q)
  );

  _container.innerHTML = '';
  matches.forEach(node => {
    const row = renderFile(node, 0);
    row.style.paddingLeft = '12px';
    // Affiche le chemin complet en tooltip
    row.title = node.path;
    _container.appendChild(row);
  });
}

// ─── TAG FILTER ──────────────────────────────────────────

export function filterByTag(tag) {
  emit('search:by-tag', { tag });
}

// ─── UTILS ───────────────────────────────────────────────

export function flatFiles(tree) {
  const files = [];
  function walk(nodes) {
    for (const node of nodes) {
      if (node.type === 'blob') files.push(node);
      else if (node.children) walk(node.children);
    }
  }
  walk(tree);
  return files;
}

export function findNode(path) {
  function walk(nodes) {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = walk(node.children);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(_tree);
}

function parentPath(path) {
  const parts = path.split('/');
  return parts.slice(0, -1).join('/');
}