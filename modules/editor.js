import { emit, on } from './bus.js';

let _editor = null;
let _preview = null;
let _container = null;
let _isPreview = false;
let _currentPath = null;
let _currentSha = null;
let _isDirty = false;
let _saveTimeout = null;

export function init() {
  _editor = document.getElementById('editor');
  _preview = document.getElementById('preview');
  _container = document.getElementById('editor-container');

  setupEvents();
  setupShortcuts();
  setupMarked();
}

function setupMarked() {
  const renderer = new marked.Renderer();

  const originalParagraph = renderer.paragraph.bind(renderer);
  renderer.paragraph = (token) => {
    const raw = typeof token === 'string' ? token : (token.text || '');
    const parsed = parseObsidianLinks(parseObsidianTags(raw));
    if (typeof token === 'string') return originalParagraph(parsed);
    return originalParagraph({ ...token, text: parsed });
  };

  const originalHeading = renderer.heading.bind(renderer);
  renderer.heading = (token) => {
    if (typeof token === 'string') return originalHeading(token);
    const parsed = parseObsidianLinks(token.text || '');
    return originalHeading({ ...token, text: parsed });
  };

  renderer.image = (token) => {
    const href = typeof token === 'string' ? token : (token.href || '');
    const text = typeof token === 'string' ? '' : (token.text || '');
    const title = typeof token === 'string' ? '' : (token.title || '');
    return `<img src="${href}" alt="${text}" ${title ? `title="${title}"` : ''} loading="lazy">`;
  };

  marked.use({ renderer, breaks: true, gfm: true });
}

function parseObsidianLinks(text) {
  // ![[image.ext]] — image embed
  text = text.replace(/!\[\[([^\]]+)\]\]/g, (_, src) => {
    const cleanSrc = src.split('|')[0].trim();
    return `<img src="attachment://${cleanSrc}" alt="${cleanSrc}" loading="lazy">`;
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
  return text.replace(/(?<![\/\w])#([\w\u00C0-\u017F\/-]+)/g, (_, tag) => {
    return `<span class="ob-tag" data-tag="${tag}">#${tag}</span>`;
  });
}

export function parseFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return { meta: {}, body: content };

  const raw = match[1];
  const meta = {};
  const lines = raw.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = line.slice(0, colonIdx).trim();
    const val = line.slice(colonIdx + 1).trim();

    // Liste inline : tags: [a, b]
    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val.slice(1, -1).split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
      i++;
    // Liste multi-ligne :
    // tags:
    //   - item
    } else if (val === '') {
      const items = [];
      i++;
      while (i < lines.length && lines[i].trim().startsWith('- ')) {
        items.push(lines[i].trim().slice(2).trim().replace(/^["']|["']$/g, ''));
        i++;
      }
      meta[key] = items.length ? items : '';
    } else {
      meta[key] = val.replace(/^["']|["']$/g, '');
      i++;
    }
  }

  return { meta, body: content.slice(match[0].length).trimStart() };
}

export function openFile(path, content, sha) {
  _currentPath = path;
  _currentSha = sha;
  _isDirty = false;

  _editor.value = content;

  document.getElementById('empty-state').classList.add('hidden');
  _container.classList.remove('hidden');

  if (_isPreview) togglePreview();

  _editor.focus();

  const { meta } = parseFrontmatter(content);
  emit('file:meta', { path, meta });

  updateDirtyState();
}

export function togglePreview() {
  _isPreview = !_isPreview;

  if (_isPreview) {
    const html = renderMarkdown(_editor.value);
    _preview.innerHTML = html;
    _preview.classList.remove('hidden');
    _editor.classList.add('hidden');

    _preview.querySelectorAll('.ob-link').forEach(el => {
      el.addEventListener('click', (e) => {
        e.preventDefault();
        emit('file:open-by-name', { name: el.dataset.target });
      });
    });

    _preview.querySelectorAll('.ob-tag').forEach(el => {
      el.addEventListener('click', () => {
        emit('tag:filter', { tag: el.dataset.tag });
      });
    });

    // Resolve attachments
    _preview.querySelectorAll('img[src^="attachment://"]').forEach(img => {
      const filename = img.src.replace(/.*attachment:\/\//, '');
      emit('attachment:resolve', { filename });
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
  const withoutFrontmatter = content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return marked.parse(withoutFrontmatter);
}

function updateDirtyState() {
  const breadcrumb = document.getElementById('breadcrumb');
  if (!breadcrumb) return;

  const name = _currentPath
    ? _currentPath.split('/').pop().replace(/\.md$/, '')
    : '';

  breadcrumb.textContent = _isDirty ? `${name} \u25CF` : name;
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

function setupEvents() {
  _editor.addEventListener('input', () => {
    if (!_isDirty) {
      _isDirty = true;
      updateDirtyState();
    }

    clearTimeout(_saveTimeout);
    _saveTimeout = setTimeout(() => {
      emit('editor:changed', {
        path: _currentPath,
        content: _editor.value,
      });
    }, 1000);
  });

  _editor.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const start = _editor.selectionStart;
      const end = _editor.selectionEnd;
      _editor.value = _editor.value.slice(0, start) + '  ' + _editor.value.slice(end);
      _editor.selectionStart = _editor.selectionEnd = start + 2;
    }
  });

  on('file:opened', ({ path, content, sha }) => {
    openFile(path, content, sha);
  });
}

function setupShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey && e.key === 'e') {
      e.preventDefault();
      if (_currentPath) togglePreview();
    }

    if (e.ctrlKey && e.key === 's') {
      e.preventDefault();
      if (_currentPath && _isDirty) {
        emit('file:save', { path: _currentPath, content: _editor.value, sha: _currentSha });
      }
    }

    if (e.ctrlKey && e.key === 'k') {
      e.preventDefault();
      const searchInput = document.getElementById('search-input');
      if (searchInput) searchInput.focus();
    }

    if (e.ctrlKey && e.key === 'n') {
      e.preventDefault();
      emit('file:new-request', { folder: '' });
    }
  });
}