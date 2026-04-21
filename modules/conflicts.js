import { emit, on } from './bus.js';

let _pendingConflict = null;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  const modal = document.getElementById('conflict-modal');
  const btnMine = document.getElementById('conflict-mine');
  const btnTheirs = document.getElementById('conflict-theirs');

  if (!modal || !btnMine || !btnTheirs) return;

  btnMine.addEventListener('click', () => {
    if (!_pendingConflict) return;
    // Garde ma version → force push avec le SHA remote
    emit('conflict:resolved', {
      path: _pendingConflict.path,
      content: _pendingConflict.localContent,
      sha: _pendingConflict.remoteSha,
      choice: 'mine',
    });
    hide();
  });

  btnTheirs.addEventListener('click', () => {
    if (!_pendingConflict) return;
    // Prend leur version → recharge le fichier
    emit('conflict:resolved', {
      path: _pendingConflict.path,
      content: _pendingConflict.remoteContent,
      sha: _pendingConflict.remoteSha,
      choice: 'theirs',
    });
    hide();
  });

  modal.addEventListener('click', (e) => {
    // Pas de fermeture au clic extérieur — doit choisir
    e.stopPropagation();
  });
}

// ─── SHOW ────────────────────────────────────────────────

export function show({ path, localContent, remoteContent, remoteSha }) {
  _pendingConflict = { path, localContent, remoteContent, remoteSha };

  const modal = document.getElementById('conflict-modal');
  const filename = path.split('/').pop();

  // Met à jour le body de la modal avec le nom du fichier
  const body = modal.querySelector('.modal-body');
  if (body) {
    body.textContent = `"${filename}" has been modified remotely. Choose which version to keep.`;
  }

  modal.classList.remove('hidden');
}

function hide() {
  _pendingConflict = null;
  const modal = document.getElementById('conflict-modal');
  if (modal) modal.classList.add('hidden');
}

// ─── DETECT ──────────────────────────────────────────────

// Appelé avant un push — compare le SHA local avec le SHA remote
export async function detectConflict({ path, localSha, remoteSha, localContent, fetchRemoteContent }) {
  if (!remoteSha || localSha === remoteSha) return false;

  // Conflit détecté — charge le contenu remote
  let remoteContent = '';
  try {
    remoteContent = await fetchRemoteContent(path);
  } catch {
    // Si on peut pas charger le remote, on laisse passer
    return false;
  }

  show({ path, localContent, remoteContent, remoteSha });
  return true;
}