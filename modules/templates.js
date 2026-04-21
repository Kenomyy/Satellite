import { emit, on } from './bus.js';

let _templatesFolder = 'templates';
let _templates = new Map(); // name → content
let _panel = null;

// ─── INIT ────────────────────────────────────────────────

export function init(templatesFolder) {
  _templatesFolder = templatesFolder || 'templates';

  on('vault:indexed', ({ files }) => {
    buildTemplateIndex(files);
  });

  on('settings:updated', ({ templatesFolder: tf }) => {
    if (tf) _templatesFolder = tf;
  });
}

// ─── INDEX ───────────────────────────────────────────────

function buildTemplateIndex(files) {
  _templates.clear();
  for (const { path, content } of files) {
    if (!path.startsWith(_templatesFolder + '/')) continue;
    if (!path.endsWith('.md')) continue;
    const name = path.split('/').pop().replace(/\.md$/, '');
    _templates.set(name, { path, content });
  }
}

// ─── APPLY TEMPLATE ──────────────────────────────────────

export function applyTemplate(templateName, targetTitle = '') {
  const template = _templates.get(templateName);
  if (!template) return null;

  const now = new Date();
  const content = template.content
    .replace(/{{title}}/gi, targetTitle)
    .replace(/{{date}}/gi, formatDate(now))
    .replace(/{{time}}/gi, formatTime(now))
    .replace(/{{datetime}}/gi, `${formatDate(now)} ${formatTime(now)}`);

  return content;
}

// ─── MODAL ───────────────────────────────────────────────

export function showTemplateModal(onSelect) {
  if (_templates.size === 0) {
    onSelect(null);
    return;
  }

  // Crée une modal dynamique
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <div class="modal-title">CHOOSE TEMPLATE</div>
      <div class="template-list"></div>
      <div class="modal-actions">
        <button class="btn-ghost" id="template-skip">NO TEMPLATE</button>
      </div>
    </div>
  `;

  const list = overlay.querySelector('.template-list');
  list.style.cssText = 'display:flex;flex-direction:column;gap:6px;max-height:240px;overflow-y:auto;';

  for (const [name] of _templates) {
    const btn = document.createElement('button');
    btn.className = 'btn-ghost';
    btn.style.cssText = 'text-align:left;justify-content:flex-start;font-family:var(--font-body);font-size:13px;letter-spacing:0;text-transform:none;';
    btn.textContent = name;
    btn.addEventListener('click', () => {
      document.body.removeChild(overlay);
      onSelect(name);
    });
    list.appendChild(btn);
  }

  overlay.querySelector('#template-skip').addEventListener('click', () => {
    document.body.removeChild(overlay);
    onSelect(null);
  });

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) {
      document.body.removeChild(overlay);
      onSelect(null);
    }
  });

  document.body.appendChild(overlay);
}

// ─── NEW FILE WITH TEMPLATE ──────────────────────────────

export function newFileContent(templateName, title) {
  if (!templateName) {
    // Frontmatter minimal par défaut
    const now = new Date();
    return `---\ndate: ${formatDate(now)}\ntags: []\n---\n\n# ${title}\n\n`;
  }
  return applyTemplate(templateName, title) || `# ${title}\n\n`;
}

// ─── UTILS ───────────────────────────────────────────────

function formatDate(d) {
  return d.toISOString().split('T')[0];
}

function formatTime(d) {
  return d.toTimeString().slice(0, 5);
}

export function getTemplateNames() {
  return [..._templates.keys()];
}

export function hasTemplates() {
  return _templates.size > 0;
}