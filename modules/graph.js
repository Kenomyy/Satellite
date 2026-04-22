import { emit, on } from './bus.js';
import { getAllLinks, getBacklinks, getForwardlinks } from './backlinks.js';
import { flatFiles } from './explorer.js';

let _canvas = null;
let _ctx = null;
let _nodes = new Map();
let _edges = [];
let _animFrame = null;
let _currentPath = null;
let _tree = [];

// Physics state
let _dragging = null;
let _offsetX = 0;
let _offsetY = 0;
let _panX = 0;
let _panY = 0;
let _isPanning = false;
let _panStartX = 0;
let _panStartY = 0;
let _scale = 1;

// ─── INIT ────────────────────────────────────────────────

export function init() {
  on('graph:mount', ({ canvas }) => {
    if (!canvas) return;
    // Stop l'ancienne loop si elle tourne
    stopLoop();
    _canvas = canvas;
    _ctx = _canvas.getContext('2d');
    resizeCanvas();
    setupInteraction();
    // Redessine immédiatement si on a déjà des données
    if (_nodes.size > 0) {
      startLoop();
    }
  });

  on('vault:indexed', ({ files, tree }) => {
    _tree = tree || [];
    buildGraph(files);
    // Si un canvas est monté, démarre la loop
    if (_canvas && document.contains(_canvas)) startLoop();
  });

  on('pane:tab-activated', ({ path, paneId }) => {
    if (path === '__graph__') return; // géré par graph:mount
    _currentPath = path;
    // Pas besoin de stopper la loop — le graph continue en arrière-plan
  });

  on('file:opened', ({ path }) => {
    if (path !== '__graph__') _currentPath = path;
  });

  on('editor:changed', () => {
    scheduleRebuild();
  });
}

// ─── BUILD GRAPH ─────────────────────────────────────────

function buildGraph(files) {
  const mdFiles = files.filter(f => f.path.endsWith('.md'));

  // Crée les noeuds
  _nodes.clear();
  for (const file of mdFiles) {
    const name = file.path.split('/').pop().replace(/\.md$/, '');
    _nodes.set(file.path, {
      path: file.path,
      name,
      x: Math.random() * 400 - 200,
      y: Math.random() * 400 - 200,
      vx: 0,
      vy: 0,
      radius: 4,
      links: 0,
    });
  }

  // Crée les arêtes
  _edges = [];
  const allLinks = getAllLinks();
  for (const { source, target } of allLinks) {
    // Résout le nom vers le path
    const targetPath = resolveNameToPath(target);
    if (!targetPath || !_nodes.has(source) || !_nodes.has(targetPath)) continue;

    _edges.push({ source, target: targetPath });
    _nodes.get(source).links++;
    _nodes.get(targetPath).links++;
  }

  // Radius proportionnel au nombre de liens
  for (const node of _nodes.values()) {
    node.radius = 3 + Math.min(node.links * 1.5, 8);
  }

  startLoop();
}

let _rebuildTimer = null;
function scheduleRebuild() {
  clearTimeout(_rebuildTimer);
  _rebuildTimer = setTimeout(() => {
    const links = getAllLinks();
    _edges = [];
    for (const { source, target } of links) {
      const targetPath = resolveNameToPath(target);
      if (!targetPath || !_nodes.has(source) || !_nodes.has(targetPath)) continue;
      _edges.push({ source, target: targetPath });
    }
  }, 2000);
}

function resolveNameToPath(name) {
  for (const path of _nodes.keys()) {
    const nodeName = path.split('/').pop().replace(/\.md$/, '');
    if (nodeName.toLowerCase() === name.toLowerCase()) return path;
  }
  return null;
}

// ─── PHYSICS (force-directed) ─────────────────────────────

const REPULSION = 800;
const ATTRACTION = 0.05;
const DAMPING = 0.85;
const CENTER_PULL = 0.01;

function tick() {
  const nodes = [..._nodes.values()];

  // Répulsion entre tous les noeuds
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const a = nodes[i];
      const b = nodes[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 1;
      const force = REPULSION / (dist * dist);
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      a.vx -= fx;
      a.vy -= fy;
      b.vx += fx;
      b.vy += fy;
    }
  }

  // Attraction sur les arêtes
  for (const edge of _edges) {
    const a = _nodes.get(edge.source);
    const b = _nodes.get(edge.target);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    a.vx += dx * ATTRACTION;
    a.vy += dy * ATTRACTION;
    b.vx -= dx * ATTRACTION;
    b.vy -= dy * ATTRACTION;
  }

  // Attraction vers le centre
  for (const node of nodes) {
    node.vx -= node.x * CENTER_PULL;
    node.vy -= node.y * CENTER_PULL;
  }

  // Intègre les vélocités
  for (const node of nodes) {
    if (_dragging && _dragging.path === node.path) continue;
    node.vx *= DAMPING;
    node.vy *= DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }
}

// ─── RENDER ──────────────────────────────────────────────

function draw() {
  const W = _canvas.width;
  const H = _canvas.height;
  const cx = W / 2 + _panX;
  const cy = H / 2 + _panY;

  _ctx.clearRect(0, 0, W, H);
  _ctx.save();
  _ctx.translate(cx, cy);
  _ctx.scale(_scale, _scale);

  // Arêtes
  for (const edge of _edges) {
    const a = _nodes.get(edge.source);
    const b = _nodes.get(edge.target);
    if (!a || !b) continue;

    const isHighlighted =
      edge.source === _currentPath || edge.target === _currentPath;

    _ctx.beginPath();
    _ctx.moveTo(a.x, a.y);
    _ctx.lineTo(b.x, b.y);
    _ctx.strokeStyle = isHighlighted
      ? 'rgba(232, 232, 240, 0.4)'
      : 'rgba(46, 47, 69, 0.6)';
    _ctx.lineWidth = isHighlighted ? 1 : 0.5;
    _ctx.stroke();
  }

  // Noeuds
  for (const node of _nodes.values()) {
    const isActive = node.path === _currentPath;
    const isConnected =
      _currentPath &&
      _edges.some(
        e =>
          (e.source === _currentPath && e.target === node.path) ||
          (e.target === _currentPath && e.source === node.path)
      );

    // Cercle
    _ctx.beginPath();
    _ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);

    if (isActive) {
      _ctx.fillStyle = 'var(--accent, #E8E8F0)';
    } else if (isConnected) {
      _ctx.fillStyle = 'rgba(232, 232, 240, 0.6)';
    } else {
      _ctx.fillStyle = 'rgba(46, 47, 69, 0.9)';
    }

    _ctx.fill();

    // Bordure sur le noeud actif
    if (isActive) {
      _ctx.strokeStyle = 'rgba(232, 232, 240, 0.3)';
      _ctx.lineWidth = 4;
      _ctx.stroke();
    }

    // Label si assez de liens ou noeud actif
    if (isActive || isConnected || node.links >= 2) {
      _ctx.font = `${isActive ? 500 : 400} 10px 'Montserrat', sans-serif`;
      _ctx.fillStyle = isActive
        ? 'rgba(232, 232, 240, 1)'
        : 'rgba(107, 108, 133, 0.9)';
      _ctx.textAlign = 'center';
      _ctx.fillText(node.name, node.x, node.y - node.radius - 4);
    }
  }

  _ctx.restore();
}

// ─── LOOP ────────────────────────────────────────────────

function loop() {
  tick();
  draw();
  _animFrame = requestAnimationFrame(loop);
}

function startLoop() {
  if (_animFrame) return;
  if (!isTabVisible()) return;
  _animFrame = requestAnimationFrame(loop);
}

function stopLoop() {
  if (_animFrame) {
    cancelAnimationFrame(_animFrame);
    _animFrame = null;
  }
}

function isTabVisible() {
  // Le graph est visible si son canvas est dans le DOM
  return _canvas && document.contains(_canvas);
}

// ─── HIGHLIGHT ───────────────────────────────────────────

function highlightNode(path) {
  _currentPath = path;
  // Pas besoin de rebuild, le draw gère le highlight
}

// ─── INTERACTION ─────────────────────────────────────────

function setupInteraction() {
  if (!_canvas) return;

  // Drag noeud
  _canvas.addEventListener('mousedown', (e) => {
    _mouseDownX = e.offsetX;
    _mouseDownY = e.offsetY;
    const { wx, wy } = screenToWorld(e.offsetX, e.offsetY);
    const hit = hitTest(wx, wy);

    if (hit) {
      _dragging = hit;
      _offsetX = hit.x - wx;
      _offsetY = hit.y - wy;
      _canvas.style.cursor = 'grabbing';
    } else {
      _isPanning = true;
      _panStartX = e.clientX - _panX;
      _panStartY = e.clientY - _panY;
      _canvas.style.cursor = 'grab';
    }
  });

  _canvas.addEventListener('mousemove', (e) => {
    if (_dragging) {
      const { wx, wy } = screenToWorld(e.offsetX, e.offsetY);
      _dragging.x = wx + _offsetX;
      _dragging.y = wy + _offsetY;
      _dragging.vx = 0;
      _dragging.vy = 0;
    } else if (_isPanning) {
      _panX = e.clientX - _panStartX;
      _panY = e.clientY - _panStartY;
    } else {
      const { wx, wy } = screenToWorld(e.offsetX, e.offsetY);
      _canvas.style.cursor = hitTest(wx, wy) ? 'pointer' : 'default';
    }
  });

  let _mouseDownX = 0, _mouseDownY = 0;

  _canvas.addEventListener('mouseup', (e) => {
    if (_dragging) {
      // Clic simple = pas de mouvement (< 4px) → ouvre la note
      const dx = e.offsetX - _mouseDownX;
      const dy = e.offsetY - _mouseDownY;
      const moved = Math.sqrt(dx*dx + dy*dy);
      if (moved < 4) {
        emit('file:open', { path: _dragging.path });
      }
      // Si drag → on ne fait rien, juste repositionne le node
    }
    _dragging = null;
    _isPanning = false;
    _canvas.style.cursor = 'default';
  });

  // Zoom molette
  _canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    _scale = Math.min(Math.max(_scale * delta, 0.2), 4);
  }, { passive: false });

  // Double-clic → reset vue
  _canvas.addEventListener('dblclick', () => {
    _panX = 0;
    _panY = 0;
    _scale = 1;
  });

  // Resize
  const resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(_canvas.parentElement);
}

function screenToWorld(sx, sy) {
  const W = _canvas.width;
  const H = _canvas.height;
  const cx = W / 2 + _panX;
  const cy = H / 2 + _panY;
  return {
    wx: (sx - cx) / _scale,
    wy: (sy - cy) / _scale,
  };
}

function hitTest(wx, wy) {
  for (const node of _nodes.values()) {
    const dx = wx - node.x;
    const dy = wy - node.y;
    if (Math.sqrt(dx * dx + dy * dy) <= node.radius + 4) return node;
  }
  return null;
}

function resizeCanvas() {
  if (!_canvas || !_canvas.parentElement) return;
  const rect = _canvas.parentElement.getBoundingClientRect();
  _canvas.width = rect.width || 400;
  _canvas.height = rect.height || 400;
}