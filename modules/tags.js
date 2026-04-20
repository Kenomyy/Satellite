import { emit, on } from './bus.js';
import { getAllTags } from './search.js';

let _panel = null;
let _activeTag = null;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  _panel = document.getElementById('tags-panel');

  on('vault:indexed', () => render());
  on('editor:changed', () => renderDebounced());
  on('tag:filter', ({ tag }) => setActiveTag(tag));
  on('file:meta', ({ meta }) => highlightFileTags(meta.tags || []));
}

// ─── RENDER ──────────────────────────────────────────────

export function render() {
  if (!_panel) return;

  const tags = getAllTags();

  if (!tags.length) {
    _panel.innerHTML = `<div style="padding:12px;font-size:11px;color:var(--text-disabled);font-family:var(--font-mono)">No tags found</div>`;
    return;
  }

  _panel.innerHTML = tags.map(tag => `
    <div class="tag-chip ${_activeTag === tag ? 'active' : ''}" data-tag="${tag}">
      #${tag}
    </div>
  `).join('');

  _panel.querySelectorAll('.tag-chip').forEach(el => {
    el.addEventListener('click', () => {
      const tag = el.dataset.tag;
      if (_activeTag === tag) {
        clearActiveTag();
      } else {
        setActiveTag(tag);
      }
    });
  });
}

let _renderTimer = null;
function renderDebounced() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(render, 1500);
}

// ─── ACTIVE TAG ──────────────────────────────────────────

function setActiveTag(tag) {
  _activeTag = tag;
  render();
  emit('tag:filter', { tag });
  // Switche sur l'onglet tags si on est ailleurs
  emit('sidebar:tab', { tab: 'tags' });
}

function clearActiveTag() {
  _activeTag = null;
  render();
  emit('search:by-tag', { tag: '' });
  emit('explorer:filter', { query: '' });
}

function highlightFileTags(tags) {
  if (!_panel) return;
  _panel.querySelectorAll('.tag-chip').forEach(el => {
    const isInFile = tags.includes(el.dataset.tag);
    el.style.borderColor = isInFile ? 'var(--accent)' : '';
    el.style.color = isInFile ? 'var(--accent)' : '';
  });
}

// ─── FRONTMATTER HELPERS ─────────────────────────────────

// Insère ou met à jour un tag dans le frontmatter d'un contenu
export function addTag(content, tag) {
  return updateFrontmatterTags(content, tags => {
    if (!tags.includes(tag)) tags.push(tag);
    return tags;
  });
}

export function removeTag(content, tag) {
  return updateFrontmatterTags(content, tags => tags.filter(t => t !== tag));
}

function updateFrontmatterTags(content, updater) {
  const hasFrontmatter = content.startsWith('---\n');

  if (hasFrontmatter) {
    return content.replace(/^---\n([\s\S]*?)\n---/, (_, block) => {
      const hasTagsLine = /^tags:/m.test(block);

      if (hasTagsLine) {
        const updated = block.replace(/^tags:.*$/m, () => {
          const current = block.match(/^tags:\s*\[([^\]]*)\]/m);
          const currentTags = current
            ? current[1].split(',').map(s => s.trim()).filter(Boolean)
            : [];
          const newTags = updater(currentTags);
          return `tags: [${newTags.join(', ')}]`;
        });
        return `---\n${updated}\n---`;
      } else {
        const newTags = updater([]);
        return `---\n${block}\ntags: [${newTags.join(', ')}]\n---`;
      }
    });
  }

  // Pas de frontmatter — on en crée un
  const newTags = updater([]);
  if (!newTags.length) return content;
  return `---\ntags: [${newTags.join(', ')}]\n---\n\n${content}`;
}

// Retourne les tags d'un contenu
export function extractTags(content) {
  const match = content.match(/^---\n[\s\S]*?\n---/);
  if (!match) return extractInlineTags(content);

  const tagsLine = match[0].match(/^tags:\s*\[([^\]]*)\]/m);
  const frontmatterTags = tagsLine
    ? tagsLine[1].split(',').map(s => s.trim()).filter(Boolean)
    : [];

  return [...new Set([...frontmatterTags, ...extractInlineTags(content)])];
}

function extractInlineTags(content) {
  const matches = content.match(/(?<![/\w])#([\w\u00C0-\u017F/-]+)/g) || [];
  return matches.map(t => t.slice(1));
}