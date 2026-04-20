const BASE = 'https://api.github.com';

let _token = null;
let _repo = null;
let _branch = null;

// ─── INIT ────────────────────────────────────────────────

export function init({ token, repo, branch }) {
  _token = token;
  _repo = repo;
  _branch = branch || 'main';
}

export function isConfigured() {
  return !!(_token && _repo);
}

// ─── INTERNAL ────────────────────────────────────────────

function headers() {
  return {
    'Authorization': `token ${_token}`,
    'Content-Type': 'application/json',
    'Accept': 'application/vnd.github+json',
  };
}

async function request(path, options = {}) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    headers: { ...headers(), ...options.headers },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `GitHub API error ${res.status}`);
  }

  if (res.status === 204) return null;
  return res.json();
}

// ─── AUTH ────────────────────────────────────────────────

export async function validateToken() {
  const user = await request('/user');
  return user.login;
}

// ─── TREE ────────────────────────────────────────────────

// Charge l'arbre complet du repo en un seul appel
export async function fetchTree() {
  const data = await request(
    `/repos/${_repo}/git/trees/${_branch}?recursive=1`
  );

  // Construit un arbre hiérarchique à partir de la liste flat
  return buildTree(data.tree);
}

function buildTree(items) {
  const root = { name: '', type: 'tree', children: [], path: '' };
  const map = { '': root };

  // Trier : dossiers d'abord, puis fichiers, alphabétique
  const sorted = [...items].sort((a, b) => {
    if (a.type !== b.type) return a.type === 'tree' ? -1 : 1;
    return a.path.localeCompare(b.path);
  });

  for (const item of sorted) {
    const parts = item.path.split('/');
    const name = parts[parts.length - 1];
    const parentPath = parts.slice(0, -1).join('/');

    const node = {
      name,
      path: item.path,
      type: item.type, // 'blob' | 'tree'
      sha: item.sha,
      children: item.type === 'tree' ? [] : undefined,
    };

    map[item.path] = node;

    const parent = map[parentPath];
    if (parent) parent.children.push(node);
  }

  return root.children;
}

// ─── FILE OPS ────────────────────────────────────────────

// Lit le contenu d'un fichier (retourne le texte décodé + sha)
export async function fetchFile(path) {
  const data = await request(`/repos/${_repo}/contents/${encodeFilePath(path)}?ref=${_branch}`);
  const content = decodeBase64(data.content);
  return { content, sha: data.sha };
}

// Crée ou met à jour un fichier
export async function writeFile(path, content, sha = null, message = null) {
  const body = {
    message: message || `Update ${path}`,
    content: encodeBase64(content),
    branch: _branch,
  };
  if (sha) body.sha = sha;

  return request(`/repos/${_repo}/contents/${encodeFilePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// Supprime un fichier
export async function deleteFile(path, sha, message = null) {
  return request(`/repos/${_repo}/contents/${encodeFilePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({
      message: message || `Delete ${path}`,
      sha,
      branch: _branch,
    }),
  });
}

// Renomme un fichier (GitHub API ne supporte pas le rename direct — delete + create)
export async function renameFile(oldPath, newPath, content, sha) {
  await writeFile(newPath, content, null, `Rename ${oldPath} → ${newPath}`);
  await deleteFile(oldPath, sha, `Rename ${oldPath} → ${newPath}`);
}

// ─── BULK PUSH ───────────────────────────────────────────

// Push plusieurs fichiers modifiés en un seul commit via l'API Git
export async function pushChanges(files, message) {
  // files = [{ path, content }]

  // 1. Récupère le SHA du dernier commit sur la branche
  const refData = await request(`/repos/${_repo}/git/ref/heads/${_branch}`);
  const latestCommitSha = refData.object.sha;

  // 2. Récupère le tree du dernier commit
  const commitData = await request(`/repos/${_repo}/git/commits/${latestCommitSha}`);
  const baseTreeSha = commitData.tree.sha;

  // 3. Crée les blobs pour chaque fichier modifié
  const blobs = await Promise.all(
    files.map(async ({ path, content }) => {
      const blob = await request(`/repos/${_repo}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({
          content: encodeBase64(content),
          encoding: 'base64',
        }),
      });
      return { path, sha: blob.sha, mode: '100644', type: 'blob' };
    })
  );

  // 4. Crée le nouveau tree
  const newTree = await request(`/repos/${_repo}/git/trees`, {
    method: 'POST',
    body: JSON.stringify({
      base_tree: baseTreeSha,
      tree: blobs,
    }),
  });

  // 5. Crée le commit
  const newCommit = await request(`/repos/${_repo}/git/commits`, {
    method: 'POST',
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: [latestCommitSha],
    }),
  });

  // 6. Met à jour la référence de branche
  await request(`/repos/${_repo}/git/refs/heads/${_branch}`, {
    method: 'PATCH',
    body: JSON.stringify({ sha: newCommit.sha }),
  });

  return newCommit;
}

// ─── CONFLICT DETECTION ──────────────────────────────────

// Vérifie si le SHA d'un fichier a changé sur le remote
export async function checkRemoteSha(path) {
  try {
    const data = await request(
      `/repos/${_repo}/contents/${encodeFilePath(path)}?ref=${_branch}`
    );
    return data.sha;
  } catch {
    return null;
  }
}

// ─── UTILS ───────────────────────────────────────────────

function encodeFilePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

function encodeBase64(str) {
  return btoa(unescape(encodeURIComponent(str)));
}

function decodeBase64(str) {
  // L'API GitHub renvoie du base64 avec des sauts de ligne
  return decodeURIComponent(escape(atob(str.replace(/\n/g, ''))));
}