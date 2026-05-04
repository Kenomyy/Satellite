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
import * as Layout from './modules/layout.js';

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
  const layoutContainer = document.getElementById('layout-root');
  Layout.init(layoutContainer);
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
  // Fichiers dispo pour autocomplete liens
  const fileNames = indexed.filter(f => f.path.endsWith('.md')).map(f => f.path.split('/').pop().replace(/\.md$/, ''));
  Layout.setVaultFiles(fileNames);
  emit('vault:indexed', { files: indexed, tree: state.tree });
}

// ─── FILE OPERATIONS ─────────────────────────────────────

function setupFileOps() {

  // Ouvre un fichier
  on('file:open', async ({ path, newTab, paneId }) => {
    setSyncStatus('syncing', 'Loading…');
    try {
      let cached = state.fileCache.get(path);
      if (!cached) {
        const fetched = await GitHub.fetchFile(path);
        cached = fetched;
        state.fileCache.set(path, cached);
      }
      Layout.openInPane(paneId || Layout.getActivePaneId(), path, cached.content, cached.sha, !!newTab);
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Load failed');
      console.error('file:open:', err);
    }
  });

  // Onglet activé → met à jour breadcrumb + explorer
  on('pane:tab-activated', ({ path, content, sha }) => {
    updateBreadcrumb(path);
    emit('explorer:highlight', { path });
    emit('file:opened', { path, content, sha });
  });

  // Ouvre par nom (depuis un [[lien]])
  on('file:open-by-name', ({ name, paneId, newTab }) => {
    const files = Explorer.flatFiles(state.tree);
    const needle = name.toLowerCase().trim();
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
    if (match) emit('file:open', { path: match.path, paneId, newTab: !!newTab });
  });

  // Sauvegarde locale (Ctrl+S) — sauvegarde en mémoire uniquement, pas sur GitHub
  on('file:save', async ({ path, content }) => {
    const cached = state.fileCache.get(path);
    // Met à jour le cache local
    state.fileCache.set(path, { content, sha: cached?.sha });
    // Marque comme "à pusher" mais pas "unsaved" UI
    state.dirtyFiles.set(path, content);
    // Notifie le layout de passer le dot en vert
    emit('file:saved-silent', { path, content, sha: cached?.sha });
    const count = state.dirtyFiles.size;
    setSyncStatus('ok', count > 0 ? `${count} to push` : syncLabel());
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

  on('folder:new-request', ({ parent }) => {
    showNewFolderModal(parent);
  });

  // Renommage
  on('file:rename-request', ({ path, name }) => {
    showRenameModal(path, name);
  });

  on('folder:rename-request', ({ path, name }) => {
    showRenameFolderModal(path, name);
  });

  on('folder:delete-request', async ({ path }) => {
    if (!confirm(`Delete folder "${path}" and all its contents?`)) return;
    try {
      setSyncStatus('syncing', 'Deleting folder…');
      const files = Explorer.flatFiles(state.tree).filter(f => f.path.startsWith(`${path}/`));
      for (const file of files) {
        await GitHub.deleteFile(file.path, file.sha, `Delete ${file.path}`);
        state.fileCache.delete(file.path);
        state.dirtyFiles.delete(file.path);
        emit('file:deleted', { path: file.path });
      }
      await loadVault();
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Delete failed');
      console.error('folder:delete:', err);
    }
  });

  // Déplacement de note
  on('file:move-request', async ({ path, folder }) => {
    if (!folder) return;
    const name = path.split('/').pop();
    const newPath = `${folder}/${name}`;
    if (newPath === path) return;

    try {
      setSyncStatus('syncing', 'Moving…');
      let cached = state.fileCache.get(path);
      if (!cached) {
        cached = await GitHub.fetchFile(path);
      }
      await GitHub.renameFile(path, newPath, cached.content, cached.sha);
      state.fileCache.delete(path);
      state.fileCache.set(newPath, { content: cached.content, sha: null });
      emit('file:deleted', { path });
      await loadVault();
      emit('file:open', { path: newPath });
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Move failed');
      console.error('file:move:', err);
    }
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
        Layout.updateTabSha(path, newSha);
        emit('file:saved-silent', { path, content, sha: newSha });
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
  on('attachment:resolve', ({ filename, img }) => {
    resolveAttachmentImg(filename, img);
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

function showNewFolderModal(parent = '') {
  const modal = document.getElementById('newfile-modal');
  const input = document.getElementById('newfile-input');
  const confirmBtn = document.getElementById('newfile-confirm');
  const cancelBtn = document.getElementById('newfile-cancel');
  const title = modal.querySelector('.modal-title');
  if (title) title.textContent = 'NEW FOLDER';
  input.value = '';
  input.placeholder = 'folder-name';
  modal.classList.remove('hidden');
  input.focus();

  const handleConfirm = async () => {
    const name = input.value.trim();
    if (!name) return;
    cleanup();
    const folderPath = parent ? `${parent}/${name}` : name;
    // GitHub ne peut pas créer un dossier vide — on crée une note de bienvenue
    const now = new Date();
    const dateStr = now.toISOString().split('T')[0];
    await createFile(`${folderPath}/${name}.md`, `---\ndate: ${dateStr}\ntags: []\n---\n\n# ${name}\n`);
    if (title) title.textContent = 'NEW FILE';
    input.placeholder = 'filename.md';
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') cleanup();
  };

  const cleanup = () => {
    modal.classList.add('hidden');
    if (title) title.textContent = 'NEW FILE';
    input.placeholder = 'filename.md';
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  };

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', cleanup);
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

  function cleanup() {
    modal.classList.add('hidden');
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  }

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', cleanup);
  input.addEventListener('keydown', handleKey);
}

function showRenameFolderModal(path, currentName) {
  const modal = document.getElementById('rename-modal');
  const input = document.getElementById('rename-input');
  const confirmBtn = document.getElementById('rename-confirm');
  const cancelBtn = document.getElementById('rename-cancel');

  input.value = currentName;
  modal.classList.remove('hidden');
  input.focus();
  input.select();

  const handleConfirm = async () => {
    const newName = input.value.trim();
    if (!newName || newName === currentName) { cleanup(); return; }
    const parent = path.split('/').slice(0, -1).join('/');
    const newFolderPath = parent ? `${parent}/${newName}` : newName;

    cleanup();

    try {
      setSyncStatus('syncing', 'Renaming folder…');
      const filesToMove = Explorer.flatFiles(state.tree).filter(f => f.path.startsWith(`${path}/`));
      const currentPath = Layout.getCurrentPath();
      let reopenPath = null;
      for (const file of filesToMove) {
        const newPath = file.path.replace(`${path}/`, `${newFolderPath}/`);
        const cachedFile = state.fileCache.get(file.path);
        const content = cachedFile?.content ?? (await GitHub.fetchFile(file.path)).content;
        await GitHub.renameFile(file.path, newPath, content, file.sha);
        state.fileCache.delete(file.path);
        emit('file:deleted', { path: file.path });
        if (currentPath && currentPath.startsWith(`${file.path}`)) {
          reopenPath = newPath;
        }
      }
      await loadVault();
      if (reopenPath) emit('file:open', { path: reopenPath });
      setSyncStatus('ok', syncLabel());
    } catch (err) {
      setSyncStatus('error', 'Folder rename failed');
      console.error('renameFolder:', err);
    }
  };

  const handleKey = (e) => {
    if (e.key === 'Enter') handleConfirm();
    if (e.key === 'Escape') cleanup();
  };

  function cleanup() {
    modal.classList.add('hidden');
    confirmBtn.removeEventListener('click', handleConfirm);
    cancelBtn.removeEventListener('click', cleanup);
    input.removeEventListener('keydown', handleKey);
  }

  confirmBtn.addEventListener('click', handleConfirm);
  cancelBtn.addEventListener('click', cleanup);
  input.addEventListener('keydown', handleKey);
}

// ─── SYNC ────────────────────────────────────────────────

function setupSync() {
  // Pull
  document.getElementById('btn-pull')?.addEventListener('click', async () => {
    const hasDirty = Layout.getDirtyTabs().length > 0;
    if (hasDirty) {
      const ok = confirm('You have unsaved changes. Pull anyway?');
      if (!ok) return;
    }
    setSyncStatus('syncing', 'Pulling…');
    try {
      await loadVault();
      // Recharge le fichier actif si ouvert
      const activePath = Layout.getCurrentPath();
      if (activePath) emit('file:open', { path: activePath });
    } catch (err) {
      setSyncStatus('error', 'Pull failed');
    }
  });

  // Push
  document.getElementById('btn-push')?.addEventListener('click', () => {
    const now = new Date();
    const dd = String(now.getDate()).padStart(2,'0');
    const mm = String(now.getMonth()+1).padStart(2,'0');
    const yy = String(now.getFullYear()).slice(-2);
    const hh = String(now.getHours()).padStart(2,'0');
    const min = String(now.getMinutes()).padStart(2,'0');
    pushAllChanges(`${dd}/${mm}/${yy}.${hh}:${min}`);
  });
}


async function pushAllChanges(message) {
  setSyncStatus('syncing', 'Pushing…');

  try {
    // Ajoute tous les onglets dirty
    const dirtyTabs = Layout.getDirtyTabs();
    for (const tab of dirtyTabs) {
      state.dirtyFiles.set(tab.path, tab.content);
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

    // Met à jour l'état local et le badge de sauvegarde
    for (const { path, content } of files) {
      const cached = state.fileCache.get(path);
      if (cached) {
        state.fileCache.set(path, { content, sha: cached.sha });
      }
      emit('file:saved-silent', { path, content, sha: state.fileCache.get(path)?.sha });
    }
    state.dirtyFiles.clear();
    setSyncStatus('ok', syncLabel());

    // Rafraîchit les SHA en arrière-plan sans bloquer l'UI
    setTimeout(async () => {
      for (const path of [...state.fileCache.keys()]) {
        try {
          const { sha } = await GitHub.fetchFile(path);
          const cached = state.fileCache.get(path);
          if (cached) cached.sha = sha;
          Layout.updateTabSha(path, sha);
        } catch {}
      }
    }, 2000);
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

  document.getElementById('btn-new-folder')?.addEventListener('click', () => {
    showNewFolderModal();
  });

  document.getElementById('btn-graph')?.addEventListener('click', () => {
    Layout.openGraphInPane(Layout.getActivePaneId());
  });

  document.getElementById('btn-settings')?.addEventListener('click', () => {
    showSettingsModal();
  });

  document.getElementById('btn-preview-toggle')?.addEventListener('click', () => {
    Layout.toggleCurrentPreview();
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

  document.getElementById('settings-save')?.addEventListener('click', async () => {
    const accent = picker?.value || '#E8E8F0';
    const templatesFolder = document.getElementById('settings-templates-folder')?.value.trim() || 'templates';
    const attachmentsFolder = document.getElementById('settings-attachments-folder')?.value.trim() || 'source';
    const token = document.getElementById('settings-token')?.value.trim() || '';
    const repo = document.getElementById('settings-repo')?.value.trim() || '';
    const branch = document.getElementById('settings-branch')?.value.trim() || 'main';
    const previewShortcut = document.getElementById('settings-preview-shortcut')?.value.trim() || 'Ctrl+E';
    const readableWidth = document.getElementById('settings-readable-width')?.checked || false;

    const newSettings = {
      ...state.settings,
      accentColor: accent,
      templatesFolder,
      attachmentsFolder,
      token,
      repo,
      branch,
      previewShortcut,
      readableWidth,
    };

    saveSettings(newSettings);
    state.settings = newSettings;

    if (token && repo) {
      GitHub.init({ token, repo, branch });
      await loadVault();
    }

    // Applique readable width
    document.querySelectorAll('.layout-editor-wrap').forEach(el => {
      el.dataset.readable = readableWidth ? 'true' : 'false';
    });

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
  const rwCheck = document.getElementById('settings-readable-width');
  if (rwCheck) rwCheck.checked = state.settings.readableWidth || false;

  const tf = document.getElementById('settings-templates-folder');
  const af = document.getElementById('settings-attachments-folder');
  const tokenInput = document.getElementById('settings-token');
  const repoInput = document.getElementById('settings-repo');
  const branchInput = document.getElementById('settings-branch');
  const previewInput = document.getElementById('settings-preview-shortcut');
  if (tf) tf.value = state.settings.templatesFolder || 'templates';
  if (af) af.value = state.settings.attachmentsFolder || 'source';
  if (tokenInput) tokenInput.value = state.settings.token || '';
  if (repoInput) repoInput.value = state.settings.repo || '';
  if (branchInput) branchInput.value = state.settings.branch || 'main';
  if (previewInput) previewInput.value = state.settings.previewShortcut || 'Ctrl+E';

  modal?.classList.remove('hidden');
}

// ─── ATTACHMENTS ─────────────────────────────────────────

function resolveAttachment(filename) {
  resolveAttachmentImg(filename, null);
}

async function resolveAttachmentImg(filename, targetImg) {
  const { repo, branch, token } = state.settings;
  const folder = state.settings.attachmentsFolder || 'source';

  // Essaie de charger via l'API GitHub (supporte les repos privés)
  const paths = [
    `${folder}/${filename}`,
    filename,
  ];

  const apply = async (img) => {
    for (const p of paths) {
      try {
        const encodedPath = p.split('/').map(encodeURIComponent).join('/');
        const res = await fetch(`https://api.github.com/repos/${repo}/contents/${encodedPath}?ref=${branch}`, {
          headers: { 'Authorization': `token ${token}` }
        });
        if (res.ok) {
          const data = await res.json();
          img.src = `data:image/*;base64,${data.content.replace(/\n/g, '')}`;
          img.style.maxWidth = '100%';
          img.style.borderRadius = '4px';
          return;
        }
      } catch {}
    }
    // Fallback raw URL
    img.src = `https://raw.githubusercontent.com/${repo}/${branch}/${folder}/${encodeURIComponent(filename)}`;
  };

  if (targetImg) {
    apply(targetImg);
  } else {
    setTimeout(() => {
      document.querySelectorAll(`img[src="attachment://${filename}"]`).forEach(apply);
    }, 50);
  }
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