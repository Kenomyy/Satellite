import { emit, on } from './modules/bus.js';
import * as GitHub from './modules/github.js';
import * as Explorer from './modules/explorer.js';
import * as Editor from './modules/editor.js';
import * as Search from './modules/search.js';
import * as Tags from './modules/tags.js';
import * as Backlinks from './modules/backlinks.js';
import * as Graph from './modules/graph.js';
import * as Templates from './modules/templates.js';
import * as Conflicts from './modules/conflicts.js';
import * as Tabs from './modules/tabs.js';

// ─── STATE ───────────────────────────────────────────────

const state = {
  tree: [],
  fileCache: new Map(),   // path → { content, sha }
  dirtyFiles: new Map(),  // path → content (fichiers modifiés non pushés)
  settings: loadSettings(),
};

// ─── BOOT ────────────────────────────────────────────────

async function boot() {
  const { token, repo, branch } = state.settings;

  if (token && repo) {
    GitHub.init({ token, repo, branch });
    showApp();
    await loadVault();
  } else {
    showSetup();
  }
}

// ─── SETUP ───────────────────────────────────────────────

function showSetup() {
  document.getElementById('setup-screen').classList.remove('hidden');
  document.getElementById('app').classList.add('hidden');

  document.getElementById('setup-connect').addEventListener('click', async () => {
    const token = document.getElementById('setup-token').value.trim();
    const repo = document.getElementById('setup-repo').value.trim();
    const branch = document.getElementById('setup-branch').value.trim() || 'main';

    if (!token || !repo) return;

    setSyncStatus('syncing', 'Connecting…');

    try {
      GitHub.init({ token, repo, branch });
      await GitHub.validateToken();

      saveSettings({ token, repo, branch });
      state.settings = loadSettings();

      document.getElementById('setup-screen').classList.add('hidden');
      showApp();
      await loadVault();
    } catch (err) {
      showSetupError(err.message);
      setSyncStatus('error', 'Error');
    }
  });

  // Enter sur les inputs
  ['setup-token', 'setup-repo', 'setup-branch'].forEach(id => {
    document.getElementById(id)?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') document.getElementById('setup-connect').click();
    });
  });
}

function showSetupError(msg) {
  const el = document.getElementById('setup-error');
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}

// ─── APP ─────────────────────────────────────────────────

function showApp() {
  document.getElementById('app').classList.remove('hidden');
  document.getElementById('setup-screen').classList.add('hidden');

  // Init tous les modules
  Editor.init();
  Explorer.init(document.getElementById('file-explorer'));
  Search.init();
  Tags.init();
  Backlinks.init();
  Graph.init();
  Conflicts.init();
  Tabs.init();
  Templates.init(state.settings.templatesFolder);

  setupSidebar();
  setupSync();
  setupFileOps();
  setupSettings();
  applyAccentColor(state.settings.accentColor || '#E8E8F0');
}

// ─── VAULT LOADING ───────────────────────────────────────

async function loadVault() {
  setSyncStatus('syncing', 'Loading vault…');

  try {
    const tree = await GitHub.fetchTree();
    state.tree = tree;

    emit('tree:loaded', { tree });

    // Indexe tous les fichiers markdown en arrière-plan
    setSyncStatus('syncing', 'Indexing…');
    await indexVault(tree);

    setSyncStatus('ok', syncLabel());
  } catch (err) {
    setSyncStatus('error', 'Load failed');
    console.error('loadVault:', err);
  }
}

async function indexVault(tree) {
  const mdFiles = Explorer.flatFiles(tree).filter(f => f.path.endsWith('.md'));

  // Charge tous les fichiers en parallèle par batch de 10
  const BATCH = 10;
  const indexed = [];

  for (let i = 0; i < mdFiles.length; i += BATCH) {
    const batch = mdFiles.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(async (file) => {
        const { content, sha } = await GitHub.fetchFile(file.path);
        state.fileCache.set(file.path, { content, sha });
        return { path: file.path, content };
      })
    );

    results.forEach(r => {
      if (r.status === 'fulfilled') indexed.push(r.value);
    });
  }

  Search.buildIndex(indexed);
  Backlinks.buildIndex(indexed);
  emit('vault:indexed', { files: indexed, tree: state.tree });
}

// ─── FILE OPERATIONS ─────────────────────────────────────

function setupFileOps() {

  // Ouvre un fichier (newTab = true si clic molette)
  on('file:open', async ({ path, sha, newTab }) => {
    setSyncStatus('syncing', 'Loading…');

    try {
      let cached = state.fileCache.get(path);

      if (!cached) {
        const fetched = await GitHub.fetchFile(path);
        cached = fetched;
        state.fileCache.set(path, cached);
      }

      Tabs.openTab(path, cached.content, cached.sha, !!newTab);
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Load failed');
      console.error('file:open:', err);
    }
  });

  // Activation d'un onglet → charge dans l'éditeur
  on('tab:activate', ({ path, content, sha }) => {
    emit('file:opened', { path, content, sha });
    updateBreadcrumb(path);
    emit('explorer:highlight', { path });
  });

  // Plus d'onglets ouverts → empty state
  on('tabs:empty', () => {
    document.getElementById('editor-container').classList.add('hidden');
    document.getElementById('empty-state').classList.remove('hidden');
    document.getElementById('backlinks-panel').classList.add('hidden');
    document.getElementById('breadcrumb').textContent = '';
  });

  // Ouvre par nom (depuis un [[lien]])
  on('file:open-by-name', ({ name }) => {
    const files = Explorer.flatFiles(state.tree);
    const needle = name.toLowerCase().trim();
    // Cherche d'abord correspondance exacte, puis partielle
    let match = files.find(f => {
      const fname = f.path.split('/').pop().replace(/\.md$/, '').toLowerCase();
      return fname === needle;
    });
    if (!match) {
      match = files.find(f => {
        const fname = f.path.split('/').pop().replace(/\.md$/, '').toLowerCase();
        return fname.includes(needle) || needle.includes(fname);
      });
    }
    if (match) emit('file:open', { path: match.path });
  });

  // Sauvegarde locale (Ctrl+S)
  on('file:save', async ({ path, content, sha }) => {
    const cached = state.fileCache.get(path);
    state.fileCache.set(path, { content, sha: cached?.sha });
    state.dirtyFiles.set(path, content);
    emit('file:saved-silent', { path, content, sha: cached?.sha });
    setSyncStatus('ok', `${state.dirtyFiles.size} unsaved`);
  });

  // Mise à jour de l'index quand l'éditeur change
  on('editor:changed', ({ path, content }) => {
    if (path) {
      const cached = state.fileCache.get(path);
      state.fileCache.set(path, { content, sha: cached?.sha });
    }
  });

  // Nouveau fichier
  on('file:new-request', ({ folder }) => {
    showNewFileModal(folder);
  });

  // Renommage
  on('file:rename-request', ({ path, name }) => {
    showRenameModal(path, name);
  });

  // Suppression
  on('file:delete-request', async ({ path, sha }) => {
    if (!confirm(`Delete "${path.split('/').pop()}"?`)) return;

    try {
      const cached = state.fileCache.get(path);
      await GitHub.deleteFile(path, sha || cached?.sha, `Delete ${path}`);
      state.fileCache.delete(path);
      state.dirtyFiles.delete(path);
      emit('file:deleted', { path });
      await loadVault();
    } catch (err) {
      setSyncStatus('error', 'Delete failed');
      console.error('file:delete:', err);
    }
  });

  // Résolution de conflit
  on('conflict:resolved', async ({ path, content, sha, choice }) => {
    if (choice === 'mine') {
      // Force push avec le SHA remote
      try {
        const res = await GitHub.writeFile(path, content, sha, `Update ${path}`);
        const newSha = res.content.sha;
        state.fileCache.set(path, { content, sha: newSha });
        Editor.updateSha(newSha);
        Editor.clearDirty();
        state.dirtyFiles.delete(path);
        setSyncStatus('ok', syncLabel());
      } catch (err) {
        setSyncStatus('error', 'Push failed');
      }
    } else {
      // Recharge leur version
      state.fileCache.set(path, { content, sha });
      emit('file:opened', { path, content, sha });
    }
  });

  // Résolution d'image Obsidian
  on('attachment:resolve', ({ filename }) => {
    resolveAttachment(filename);
  });
}

// ─── NEW FILE MODAL ───────────────────────────────────────

function showNewFileModal(folder) {
  const modal = document.getElementById('newfile-modal');
  const input = document.getElementById('newfile-input');
  const confirm = document.getElementById('newfile-confirm');
  const cancel = document.getElementById('newfile-cancel');

  input.value = '';
  modal.classList.remove('hidden');
  input.focus();

  const handleConfirm = async () => {
    let name = input.value.trim();
    if (!name) return;
    if (!name.endsWith('.md')) name += '.md';

    const path = folder ? `${folder}/${name}` : name;
    const title = name.replace(/\.md$/, '');

    cleanup();

    if (Templates.hasTemplates()) {
      Templates.showTemplateModal(async (templateName) => {
        const content = Templates.newFileContent(templateName, title);
        await createFile(path, content);
      });
    } else {
      const content = Templates.newFileContent(null, title);
      await createFile(path, content);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') cleanup();
  };

  const cleanup = () => {
    modal.classList.add('hidden');
    confirm.removeEventListener('click', handleConfirm);
    cancel.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  };

  confirm.addEventListener('click', handleConfirm);
  cancel.addEventListener('click', cleanup);
  input.addEventListener('keydown', handleKey);
}

async function createFile(path, content) {
  try {
    setSyncStatus('syncing', 'Creating…');
    const res = await GitHub.writeFile(path, content, null, `Create ${path}`);
    const sha = res.content.sha;
    state.fileCache.set(path, { content, sha });
    await loadVault();
    emit('file:open', { path });
    setSyncStatus('ok', syncLabel());
  } catch (err) {
    setSyncStatus('error', 'Create failed');
    console.error('createFile:', err);
  }
}

// ─── RENAME MODAL ─────────────────────────────────────────

function showRenameModal(path, currentName) {
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-input');
  const confirmBtn = document.getElementById('rename-confirm');
  const cancelBtn = document.getElementById('rename-cancel');

  input.value = currentName;
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  const handleConfirm = async () => {
    let newName = input.value.trim();
    if (!newName || newName === currentName) { cleanup(); return; }
    if (!newName.endsWith('.md') && currentName.endsWith('.md')) newName += '.md';

    const parts = path.split('/');
    parts[parts.length - 1] = newName;
    const newPath = parts.join('/');

    cleanup();

    try {
      setSyncStatus('syncing', 'Renaming…');
      const cached = state.fileCache.get(path);
      await GitHub.renameFile(path, newPath, cached?.content || '', cached?.sha);
      state.fileCache.delete(path);
      state.fileCache.set(newPath, { content: cached?.content || '', sha: null });
      await loadVault();
      emit('file:open', { path: newPath });
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Rename failed');
      console.error('renameFile:', err);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') cleanup();
  };

  const cleanup = () => {
    modal.classList.add('hidden');
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', cleanup);
  input.addEventListener('keydown', handleKey);
}

// ─── SYNC ────────────────────────────────────────────────

function setupSync() {
  // Pull
  document.getElementById('btn-pull')?.addEventListener('click', async () => {
    if (Editor.isDirty()) {
      const ok = confirm('You have unsaved changes. Pull anyway?');
      if (!ok) return;
    }
    setSyncStatus('syncing', 'Pulling…');
    try {
      await loadVault();
      // Recharge le fichier actif si ouvert
      const activePath = Editor.getCurrentPath();
      if (activePath) emit('file:open', { path: activePath });
    } catch (err) {
      setSyncStatus('error', 'Pull failed');
    }
  });

  // Push
  document.getElementById('btn-push')?.addEventListener('click', () => {
    showCommitModal();
  });
}

function showCommitModal() {
  const modal = document.getElementById('commit-modal');
  const input = document.getElementById('commit-message');
  const confirmBtn = document.getElementById('commit-confirm');
  const cancelBtn = document.getElementById('commit-cancel');

  // Message par défaut
  const count = state.dirtyFiles.size + (Editor.isDirty() ? 1 : 0);
  input.value = count === 1
    ? `Update ${Editor.getCurrentPath()?.split('/').pop() || 'note'}`
    : `Update ${count} notes`;

  modal.classList.remove('hidden');
  input.focus();
  input.select();

  const handleConfirm = async () => {
    const message = input.value.trim() || 'Update notes';
    cleanup();
    await pushAllChanges(message);
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') cleanup();
  };

  const cleanup = () => {
    modal.classList.add('hidden');
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', cleanup);
  input.addEventListener('keydown', handleKey);
}

async function pushAllChanges(message) {
  setSyncStatus('syncing', 'Pushing…');

  try {
    // Ajoute tous les onglets dirty
    const dirtyTabs = Tabs.getDirtyTabs();
    for (const tab of dirtyTabs) {
      state.dirtyFiles.set(tab.path, tab.content);
    }
    // Ajoute aussi l'onglet actif si l'éditeur a des modifs non propagées
    if (Editor.isDirty()) {
      const path = Editor.getCurrentPath();
      const content = Editor.getContent();
      if (path) state.dirtyFiles.set(path, content);
    }

    if (state.dirtyFiles.size === 0) {
      setSyncStatus('ok', syncLabel());
      return;
    }

    // Vérifie les conflits avant push
    for (const [path, content] of state.dirtyFiles) {
      const cached = state.fileCache.get(path);
      const remoteSha = await GitHub.checkRemoteSha(path);

      const hasConflict = await Conflicts.detectConflict({
        path,
        localSha: cached?.sha,
        remoteSha,
        localContent: content,
        fetchRemoteContent: async (p) => {
          const { content: c } = await GitHub.fetchFile(p);
          return c;
        },
      });

      if (hasConflict) return; // La modal prend le relais
    }

    // Push tous les fichiers modifiés
    const files = [...state.dirtyFiles.entries()].map(([path, content]) => ({
      path,
      content,
    }));

    await GitHub.pushChanges(files, message);

    // Met à jour les SHA en cache
    for (const path of state.dirtyFiles.keys()) {
      const { sha } = await GitHub.fetchFile(path);
      const cached = state.fileCache.get(path);
      if (cached) cached.sha = sha;
      if (path === Editor.getCurrentPath()) Editor.updateSha(sha);
    }

    state.dirtyFiles.clear();
    Editor.clearDirty();
    setSyncStatus('ok', syncLabel());
  } catch (err) {
    setSyncStatus('error', 'Push failed');
    console.error('push:', err);
  }
}

// ─── SIDEBAR TABS ────────────────────────────────────────

function setupSidebar() {
  const tabs = document.querySelectorAll('.sidebar-tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      const target = document.getElementById(`tab-${tab.dataset.tab}`);
      if (target) target.classList.add('active');
      emit('sidebar:tab', { tab: tab.dataset.tab });
    });
  });

  on('sidebar:tab', ({ tab }) => {
    const tabEl = document.querySelector(`.sidebar-tab[data-tab="${tab}"]`);
    if (tabEl) tabEl.click();
  });

  // Explorer filter depuis la recherche
  on('explorer:filter', ({ query }) => {
    Explorer.filter(query);
  });

  // Boutons header
  document.getElementById('btn-new-file')?.addEventListener('click', () => {
    emit('file:new-request', { folder: '' });
  });

  document.getElementById('btn-settings')?.addEventListener('click', () => {
    showSettingsModal();
  });

  document.getElementById('btn-preview-toggle')?.addEventListener('click', () => {
    if (Editor.getCurrentPath()) Editor.togglePreview();
  });
}

// ─── SETTINGS ────────────────────────────────────────────

function setupSettings() {
  const modal = document.getElementById('settings-modal');
  const picker = document.getElementById('accent-color-picker');
  const pickerVal = document.getElementById('accent-color-value');

  picker?.addEventListener('input', () => {
    const color = picker.value;
    pickerVal.textContent = color.toUpperCase();
    applyAccentColor(color);
  });

  document.getElementById('settings-save')?.addEventListener('click', () => {
    const accent = picker?.value || '#E8E8F0';
    const templatesFolder = document.getElementById('settings-templates-folder')?.value.trim() || 'templates';
    const attachmentsFolder = document.getElementById('settings-attachments-folder')?.value.trim() || 'source';

    saveSettings({ ...state.settings, accentColor: accent, templatesFolder, attachmentsFolder });
    state.settings = loadSettings();

    emit('settings:updated', state.settings);
    modal.classList.add('hidden');
  });

  document.getElementById('settings-disconnect')?.addEventListener('click', () => {
    if (!confirm('Disconnect and clear credentials?')) return;
    localStorage.removeItem('satellite_settings');
    location.reload();
  });

  modal?.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.add('hidden');
  });
}

function showSettingsModal() {
  const modal = document.getElementById('settings-modal');
  const picker = document.getElementById('accent-color-picker');
  const pickerVal = document.getElementById('accent-color-value');

  if (picker) {
    picker.value = state.settings.accentColor || '#E8E8F0';
    if (pickerVal) pickerVal.textContent = picker.value.toUpperCase();
  }

  const tf = document.getElementById('settings-templates-folder');
  const af = document.getElementById('settings-attachments-folder');
  if (tf) tf.value = state.settings.templatesFolder || 'templates';
  if (af) af.value = state.settings.attachmentsFolder || 'source';

  modal?.classList.remove('hidden');
}

// ─── ATTACHMENTS ─────────────────────────────────────────

function resolveAttachment(filename) {
  // Construit l'URL raw GitHub pour les images
  const { repo, branch } = state.settings;
  const folder = state.settings.attachmentsFolder || 'source';

  // Cherche d'abord dans le dossier attachments, sinon vault root
  const candidates = [
    `https://raw.githubusercontent.com/${repo}/${branch}/${folder}/${filename}`,
    `https://raw.githubusercontent.com/${repo}/${branch}/${filename}`,
  ];

  // Remplace les src placeholder dans le preview
  setTimeout(() => {
    document.querySelectorAll(`img[src="attachment://${filename}"]`).forEach(img => {
      img.src = candidates[0];
      img.onerror = () => { img.src = candidates[1]; };
    });
  }, 50);
}

// ─── SYNC STATUS ─────────────────────────────────────────

function setSyncStatus(type, label) {
  const dot = document.querySelector('.sync-dot');
  const labelEl = document.getElementById('sync-label');
  if (!dot || !labelEl) return;

  dot.className = 'sync-dot';
  if (type) dot.classList.add(type);
  labelEl.textContent = label || '—';
}

function syncLabel() {
  const now = new Date();
  const hh = now.getHours().toString().padStart(2, '0');
  const mm = now.getMinutes().toString().padStart(2, '0');
  return `Synced ${hh}:${mm}`;
}

// ─── BREADCRUMB ───────────────────────────────────────────

function updateBreadcrumb(path) {
  const el = document.getElementById('breadcrumb');
  if (!el) return;
  const parts = path.split('/');
  const name = parts.pop().replace(/\.md$/, '');
  const folder = parts.join(' / ');
  el.innerHTML = folder
    ? `<span>${folder} /</span> ${name}`
    : name;
}

// ─── ACCENT COLOR ────────────────────────────────────────

function applyAccentColor(color) {
  document.documentElement.style.setProperty('--accent', color);
}

// ─── PERSISTENCE ─────────────────────────────────────────

function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem('satellite_settings')) || {};
  } catch {
    return {};
  }
}

function saveSettings(settings) {
  localStorage.setItem('satellite_settings', JSON.stringify(settings));
}

// ─── START ───────────────────────────────────────────────

boot();