import { emit, on } from './bus.js';

let _editor = null;
let _preview = null;
let _container = null;
let _isPreview = false;
let _currentPath = null;
let _currentSha = null;
let _isDirty = false;
let _saveTimeout = null;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  _editor = document.getElementById('editor');
  _preview = document.getElementById('preview');
  _container = document.getElementById('editor-container');

  setupEvents();
  setupShortcuts();
  setupMarked();
}

// ─── MARKED CONFIG ───────────────────────────────────────

function setupMarked() {
  const renderer = new marked.Renderer();

  // Liens internes Obsidian [[note]] et [[note|alias]]
  const originalParagraph = renderer.paragraph.bind(renderer);
  renderer.paragraph = (text) => {
    text = parseObsidianLinks(text);
    text = parseObsidianTags(text);
    return originalParagraph(text);
  };

  renderer.heading = (text, level) => {
    text = parseObsidianLinks(text);
    return `<h${level}>${text}</h${level}>`;
  };

  // Images Obsidian ![[image.png]]
  const originalImage = renderer.image.bind(renderer);
  renderer.image = (href, title, text) => {
    return `<img src="${href}" alt="${text}" ${title ? `title="${title}"` : ''} loading="lazy">`;
  };

  marked.setOptions({
    renderer,
    breaks: true,
    gfm: true,
  });
}

// ─── OBSIDIAN SYNTAX PARSERS ─────────────────────────────

function parseObsidianLinks(text) {
  // ![[image.ext]] — image embed
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_, src) => {
    const cleanSrc = src.split('|')[0].trim();
    return `<img src="${resolveAttachment(cleanSrc)}" alt="${cleanSrc}" loading="lazy">`;
  });

  // [[note|alias]] ou [[note]]
  text = text.replace(/\[\[([^\]]+)\]\]/g, (_, inner) => {
    const [path, alias] = inner.split('|').map(s => s.trim());
    const label = alias || path;
    return `<a class="ob-link" data-target="${path}" href="#">${label}</a>`;
  });

  return text;
}

function parseObsidianTags(text) {
  // #tag (pas dans les URLs ni les titres markdown)
  return text.replace(/(?<![/\w])#([\w\u00C0-\u017F/-]+)/g, (_, tag) => {
    return `<span class="ob-tag" data-tag="${tag}">#${tag}</span>`;
  });
}

function resolveAttachment(filename) {
  // Sera résolu dynamiquement via GitHub raw content
  emit('attachment:resolve', { filename });
  return `attachment://${filename}`; // placeholder, remplacé par app.js
}

// parseFrontmatter : extrait le YAML frontmatter d'une note
export function parseFrontmatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return { meta: {}, body: content };

  const raw = match[1];
  const meta = {};

  raw.split('\n').forEach(line => {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) return;
    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();

    // Tags: liste YAML inline [a, b] ou valeur simple
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
    }
  });

  return { meta, body: content.slice(match[0].length).trimStart() };
}

// ─── OPEN FILE ───────────────────────────────────────────

export function openFile(path, content, sha) {
  _currentPath = path;
  _currentSha = sha;
  _isDirty = false;

  _editor.value = content;

  // Cache le empty state, affiche l'éditeur
  document.getElementById('empty-state').classList.add('hidden');
  _container.classList.remove('hidden');

  // Preview off par défaut à l'ouverture
  if (_isPreview) togglePreview();

  _editor.focus();

  // Extrait les métadonnées et notifie
  const { meta } = parseFrontmatter(content);
  emit('file:meta', { path, meta });

  updateDirtyState();
}

// ─── PREVIEW ─────────────────────────────────────────────

export function togglePreview() {
  _isPreview = !_isPreview;

  if (_isPreview) {
    const html = renderMarkdown(_editor.value);
    _preview.innerHTML = html;
    _preview.classList.remove('hidden');
    _editor.classList.add('hidden');

    // Attache les handlers sur les liens internes
    _preview.querySelectorAll('.ob-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        emit('file:open-by-name', { name: el.dataset.target });
      });
    });

    // Attache les handlers sur les tags
    _preview.querySelectorAll('.ob-tag').forEach(el => {
      el.addEventListener('click', () => {
        emit('tag:filter', { tag: el.dataset.tag });
      });
    });
  } else {
    _preview.classList.add('hidden');
    _editor.classList.remove('hidden');
    _editor.focus();
  }

  const btn = document.getElementById('btn-preview-toggle');
  if (btn) btn.style.color = _isPreview ? 'var(--accent)' : '';
}

function renderMarkdown(content) {
  // Cache le frontmatter dans le rendu
  const withoutFrontmatter = content.replace(/^---\n[\s\S]*?\n---\n?/, '');
  return marked.parse(withoutFrontmatter);
}

// ─── DIRTY STATE ─────────────────────────────────────────

function updateDirtyState() {
  const breadcrumb = document.getElementById('breadcrumb');
  if (!breadcrumb) return;

  const name = _currentPath
    ? _currentPath.split('/').pop().replace(/\.md$/, '')
    : '';

  breadcrumb.textContent = _isDirty ? `${name} ●` : name;
}

export function getContent() {
  return _editor ? _editor.value : '';
}

export function getCurrentPath() {
  return _currentPath;
}

export function getCurrentSha() {
  return _currentSha;
}

export function updateSha(sha) {
  _currentSha = sha;
}

export function isDirty() {
  return _isDirty;
}

export function clearDirty() {
  _isDirty = false;
  updateDirtyState();
}

// ─── EVENTS ──────────────────────────────────────────────

function setupEvents() {
  _editor.addEventListener('input', () => {
    if (!_isDirty) {
      _isDirty = true;
      updateDirtyState();
    }

    // Auto-index pour backlinks/tags en arrière-plan (debounce 1s)
    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
      emit('editor:changed', {
        path: _currentPath,
        content: _editor.value,
      });
    }, 1000);
  });

  // Gestion Tab dans l'éditeur
  _editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = _editor.selectionStart;
      const end = _editor.selectionEnd;
      _editor.value = _editor.value.slice(0, start) + '  ' + _editor.value.slice(end);
      _editor.selectionStart = _editor.selectionEnd = start + 2;
    }
  });

  // Clic sur lien interne en mode preview → déjà géré dans togglePreview
  on('file:opened', ({ path, content, sha }) => {
    openFile(path, content, sha);
  });
}

function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    // Ctrl+E — toggle preview
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      if (_currentPath) togglePreview();
    }

    // Ctrl+S — save (emit pour que app.js gère le push si besoin)
    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (_currentPath && _isDirty) {
        emit('file:save', { path: _currentPath, content: _editor.value, sha: _currentSha });
      }
    }

    // Ctrl+K — focus search
    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.focus();
    }

    // Ctrl+N — nouvelle note
    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      emit('file:new-request', { folder: '' });
    }
  });
}