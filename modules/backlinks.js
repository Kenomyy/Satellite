import { emit, on } from './bus.js';

// Index : Map<noteName, Set<path>> — qui pointe vers cette note
const _backlinks = new Map();
// Index : Map<path, Set<noteName>> — quelles notes cette note pointe vers
const _forwardlinks = new Map();

let _panel = null;
let _list = null;
let _currentPath = null;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  _panel = document.getElementById('backlinks-panel');
  _list = document.getElementById('backlinks-list');

  on('vault:indexed', ({ files }) => {
    buildIndex(files);
  });

  on('editor:changed', ({ path, content }) => {
    updateIndex(path, content);
  });

  on('file:opened', ({ path }) => {
    _currentPath = path;
    render(path);
  });

  on('file:deleted', ({ path }) => {
    removeFromIndex(path);
  });
}

// ─── INDEX ───────────────────────────────────────────────

export function buildIndex(files) {
  _backlinks.clear();
  _forwardlinks.clear();

  for (const { path, content } of files) {
    if (!path.endsWith('.md')) continue;
    indexFile(path, content);
  }
}

function indexFile(path, content) {
  const links = extractLinks(content);
  _forwardlinks.set(path, links);

  for (const target of links) {
    if (!_backlinks.has(target)) _backlinks.set(target, new Set());
    _backlinks.get(target).add(path);
  }
}

function updateIndex(path, content) {
  // Retire les anciens forward links de ce fichier
  const oldLinks = _forwardlinks.get(path) || new Set();
  for (const target of oldLinks) {
    const bl = _backlinks.get(target);
    if (bl) bl.delete(path);
  }

  // Réindexe
  indexFile(path, content);

  // Re-render si on regarde la note courante
  if (_currentPath) render(_currentPath);
}

function removeFromIndex(path) {
  const links = _forwardlinks.get(path) || new Set();
  for (const target of links) {
    const bl = _backlinks.get(target);
    if (bl) bl.delete(path);
  }
  _forwardlinks.delete(path);

  // Retire aussi comme cible
  const name = pathToName(path);
  _backlinks.delete(name);
}

// ─── EXTRACT LINKS ───────────────────────────────────────

function extractLinks(content) {
  const links = new Set();
  const regex = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    const target = match[1].trim();
    links.add(target);
  }

  return links;
}

// ─── RENDER ──────────────────────────────────────────────

function render(path) {
  if (!_panel || !_list) return;

  const name = pathToName(path);
  const sources = _backlinks.get(name);

  if (!sources || sources.size === 0) {
    _panel.classList.add('hidden');
    return;
  }

  _list.innerHTML = [...sources].map(sourcePath => {
    const sourceName = pathToName(sourcePath);
    return `<div class="backlink-item" data-path="${sourcePath}">${sourceName}</div>`;
  }).join('');

  _list.querySelectorAll('.backlink-item').forEach(el => {
    el.addEventListener('click', () => {
      emit('file:open', { path: el.dataset.path });
    });
  });

  _panel.classList.remove('hidden');
}

// ─── UTILS ───────────────────────────────────────────────

function pathToName(path) {
  return path.split('/').pop().replace(/\.md$/, '');
}

export function getBacklinks(path) {
  const name = pathToName(path);
  return [...(_backlinks.get(name) || [])];
}

export function getForwardlinks(path) {
  return [...(_forwardlinks.get(path) || [])];
}

// Retourne tous les liens pour le graph
export function getAllLinks() {
  const links = [];
  for (const [source, targets] of _forwardlinks) {
    for (const target of targets) {
      links.push({ source, target });
    }
  }
  return links;
}