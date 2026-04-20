import { emit, on } from './bus.js';
import { parseFrontmatter } from './editor.js';

// Index : Map<path, { content, meta, name }>
const _index = new Map();
let _searchInput = null;
let _resultsContainer = null;
let _debounceTimer = null;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  _searchInput = document.getElementById('search-input');
  _resultsContainer = createResultsContainer();

  setupEvents();

  on('vault:indexed', ({ files }) => {
    buildIndex(files);
  });

  on('editor:changed', ({ path, content }) => {
    updateIndex(path, content);
  });

  on('file:deleted', ({ path }) => {
    _index.delete(path);
  });

  on('search:by-tag', ({ tag }) => {
    if (_searchInput) {
      _searchInput.value = `#${tag}`;
      runSearch(`#${tag}`);
      _searchInput.focus();
    }
  });
}

// ─── INDEX ───────────────────────────────────────────────

export function buildIndex(files) {
  // files = [{ path, content }]
  _index.clear();
  for (const { path, content } of files) {
    indexFile(path, content);
  }
}

function indexFile(path, content) {
  const { meta, body } = parseFrontmatter(content);
  const name = path.split('/').pop().replace(/\.md$/, '');
  _index.set(path, { content: body.toLowerCase(), meta, name, raw: content });
}

function updateIndex(path, content) {
  indexFile(path, content);
}

// ─── SEARCH ──────────────────────────────────────────────

export function search(query) {
  if (!query || query.trim().length < 2) return [];

  const q = query.trim().toLowerCase();

  // Recherche par tag : #tagname
  if (q.startsWith('#')) {
    const tag = q.slice(1);
    return searchByTag(tag);
  }

  const results = [];

  for (const [path, { content, meta, name, raw }] of _index) {
    // Skip les fichiers non-markdown
    if (!path.endsWith('.md')) continue;

    const nameMatch = name.toLowerCase().includes(q);
    const contentIdx = content.indexOf(q);
    const tagMatch = (meta.tags || []).some(t => t.toLowerCase().includes(q));

    if (!nameMatch && contentIdx === -1 && !tagMatch) continue;

    let excerpt = '';
    if (contentIdx !== -1) {
      const start = Math.max(0, contentIdx - 60);
      const end = Math.min(content.length, contentIdx + q.length + 60);
      excerpt = raw.slice(start, end).replace(/\n/g, ' ').trim();
      if (start > 0) excerpt = '…' + excerpt;
      if (end < raw.length) excerpt += '…';
    }

    results.push({
      path,
      name,
      excerpt,
      score: (nameMatch ? 10 : 0) + (tagMatch ? 5 : 0) + (contentIdx !== -1 ? 1 : 0),
    });
  }

  // Trie par score décroissant
  return results.sort((a, b) => b.score - a.score).slice(0, 20);
}

function searchByTag(tag) {
  const results = [];

  for (const [path, { meta, name }] of _index) {
    if (!path.endsWith('.md')) continue;
    const tags = meta.tags || [];
    if (tags.some(t => t.toLowerCase().includes(tag))) {
      results.push({ path, name, excerpt: `tags: ${tags.join(', ')}`, score: 10 });
    }
  }

  return results;
}

// ─── UI ──────────────────────────────────────────────────

function createResultsContainer() {
  const el = document.createElement('div');
  el.className = 'search-results hidden';
  el.id = 'search-results';
  document.getElementById('app').appendChild(el);
  return el;
}

function showResults(results, query) {
  if (!results.length) {
    _resultsContainer.innerHTML = `
      <div class="search-result-item">
        <div class="search-result-path">No results for "${query}"</div>
      </div>
    `;
    _resultsContainer.classList.remove('hidden');
    return;
  }

  _resultsContainer.innerHTML = results.map(r => `
    <div class="search-result-item" data-path="${r.path}">
      <div class="search-result-path">${r.path}</div>
      <div class="search-result-excerpt">${highlight(r.excerpt, query)}</div>
    </div>
  `).join('');

  _resultsContainer.querySelectorAll('.search-result-item').forEach(el => {
    el.addEventListener('click', () => {
      const path = el.dataset.path;
      if (path) {
        emit('file:open', { path });
        hideResults();
        _searchInput.value = '';
      }
    });
  });

  _resultsContainer.classList.remove('hidden');
}

function hideResults() {
  _resultsContainer.classList.add('hidden');
}

function highlight(text, query) {
  if (!text || query.startsWith('#')) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp(`(${escaped})`, 'gi'), '<mark>$1</mark>');
}

// ─── EVENTS ──────────────────────────────────────────────

function setupEvents() {
  _searchInput.addEventListener('input', () => {
    clearTimeout(_debounceTimer);
    const q = _searchInput.value.trim();

    if (!q) {
      hideResults();
      emit('explorer:filter', { query: '' });
      return;
    }

    _debounceTimer = setTimeout(() => runSearch(q), 200);
  });

  _searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideResults();
      _searchInput.value = '';
      emit('explorer:filter', { query: '' });
      _searchInput.blur();
    }

    // Navigation dans les résultats avec les flèches
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      const first = _resultsContainer.querySelector('.search-result-item');
      if (first) first.focus();
    }
  });

  // Ferme les résultats si on clique ailleurs
  document.addEventListener('click', (e) => {
    if (!_resultsContainer.contains(e.target) && e.target !== _searchInput) {
      hideResults();
    }
  });
}

function runSearch(query) {
  // Recherche dans le nom de fichier → filtre l'explorer
  emit('explorer:filter', { query });

  // Recherche full-text si l'index est prêt
  if (_index.size > 0) {
    const results = search(query);
    showResults(results, query);
  }
}

// ─── EXPORT UTILS ────────────────────────────────────────

export function getAllTags() {
  const tags = new Set();
  for (const { meta } of _index.values()) {
    (meta.tags || []).forEach(t => tags.add(t));
  }
  return [...tags].sort();
}

export function getIndexedFiles() {
  return [..._index.entries()].map(([path, data]) => ({ path, ...data }));
}