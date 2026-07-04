/* ============================================================
   Claytec CRM — Beziehungsnetz (Netzwerk-Tab)
   Canvas-Graph über direkte Kontakt-Verknüpfungen (links/linkMeta)
   und Projekt-Zugehörigkeit (project.contactIds). Klick auf einen
   Knoten öffnet rechts ein Detail-Panel mit allen Verknüpfungen.
   Nur Kontakte/Projekte mit mindestens einer Verknüpfung werden
   angezeigt — sonst wäre der Graph bei 500+ Kontakten unlesbar.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.net = {
  canvas: null,
  ctx: null,
  nodes: [],
  edges: [],
  selectedId: null,
  dragNode: null,
  isDragging: false,
  dragMoved: false,
};

CRM.renderNetzwerk = function () {
  const container = document.getElementById('view-netzwerk');
  container.innerHTML = `
    <div class="net-wrap">
      <div class="net-toolbar">
        <input type="text" id="net-search" placeholder="🔍 Kontakt suchen und zentrieren...">
        <span id="net-count" style="color:var(--text-dim);font-size:12px;white-space:nowrap"></span>
      </div>
      <div class="net-body">
        <div class="net-canvas-wrap" id="net-canvas-wrap">
          <canvas id="net-canvas"></canvas>
          <div id="net-empty" class="net-empty hidden">
            Noch keine Verknüpfungen vorhanden.<br>
            Öffne einen Kontakt → „+ Kontakt verknüpfen" oder „+ Projekt verknüpfen", um das Netz aufzubauen.
          </div>
        </div>
        <div class="net-side" id="net-side">
          <div class="net-side-empty">Klicke auf einen Knoten, um Details zu sehen.</div>
        </div>
      </div>
      <div class="net-legend">
        ${CRM.TYPES.map((t) => `<span class="net-leg-item"><span class="net-leg-dot" style="background:${CRM.TYPE_COLORS[t]}"></span>${CRM.TYPE_LABELS[t]}</span>`).join('')}
        <span class="net-leg-item"><span class="net-leg-dot net-leg-dot-proj"></span>Projekt</span>
      </div>
    </div>
  `;
  CRM.net.selectedId = null;
  CRM.net.build();
  CRM.net.setupCanvas();
  CRM.net.layout();
  CRM.net.draw();

  document.getElementById('net-search').addEventListener('input', (e) => CRM.net.onSearch(e.target.value));
};

/* ---------- Daten: Knoten + Kanten aus Kontakten/Projekten ableiten ---------- */
CRM.net.build = function () {
  const contacts = CRM.db.getContacts();
  const projects = (CRM.db.getProjects && CRM.db.getProjects()) || [];
  const nodeMap = new Map();
  const edges = [];
  const edgeKey = (a, b) => [a, b].sort().join('|');
  const seenEdges = new Set();

  function ensureContactNode(c) {
    if (!c || nodeMap.has('c:' + c.id)) return;
    nodeMap.set('c:' + c.id, {
      id: 'c:' + c.id,
      refId: c.id,
      kind: 'contact',
      name: c.firma1 || '(ohne Namen)',
      type: c.type,
      sub: [c.plz, c.ort].filter(Boolean).join(' '),
      erpNr: c.erpNr || '',
      color: CRM.TYPE_COLORS[c.type] || '#9aa4b5',
      x: 0, y: 0, r: 16,
    });
  }
  function ensureProjectNode(p) {
    if (!p || nodeMap.has('p:' + p.id)) return;
    nodeMap.set('p:' + p.id, {
      id: 'p:' + p.id,
      refId: p.id,
      kind: 'project',
      name: p.name || '(Projekt ohne Namen)',
      type: 'projekt',
      sub: [p.plz, p.ort].filter(Boolean).join(' '),
      status: p.status,
      color: '#e6b94d',
      x: 0, y: 0, r: 20,
    });
  }
  function addEdge(idA, idB, label) {
    if (idA === idB) return;
    const k = edgeKey(idA, idB);
    if (seenEdges.has(k)) {
      if (label) { const e = edges.find((e) => edgeKey(e.a, e.b) === k); if (e && !e.label) e.label = label; }
      return;
    }
    seenEdges.add(k);
    edges.push({ a: idA, b: idB, label: label || '' });
  }

  // Direkte Kontakt-Verknüpfungen (links.*Ids + linkMeta)
  contacts.forEach((c) => {
    const linkFields = ['haendlerIds', 'verarbeiterIds', 'architektIds', 'bauherrIds'];
    const hasAnyLink = linkFields.some((f) => (c.links && c.links[f] || []).length) || (c.links && c.links.projektIds || []).length;
    if (!hasAnyLink) return;
    ensureContactNode(c);
    linkFields.forEach((f) => {
      (c.links[f] || []).forEach((otherId) => {
        const other = CRM.db.getContact(otherId);
        if (!other) return;
        ensureContactNode(other);
        addEdge('c:' + c.id, 'c:' + otherId, (c.linkMeta && c.linkMeta[otherId]) || '');
      });
    });
  });

  // Projekt-Verknüpfungen
  projects.forEach((p) => {
    const ids = (p.contactIds || []).filter((id) => CRM.db.getContact(id));
    if (!ids.length) return;
    ensureProjectNode(p);
    ids.forEach((cid) => {
      ensureContactNode(CRM.db.getContact(cid));
      addEdge('p:' + p.id, 'c:' + cid, '');
    });
  });

  CRM.net.nodes = Array.from(nodeMap.values());
  CRM.net.edges = edges
    .map((e) => ({ a: CRM.net.nodes.find((n) => n.id === e.a), b: CRM.net.nodes.find((n) => n.id === e.b), label: e.label }))
    .filter((e) => e.a && e.b);

  document.getElementById('net-count').textContent = CRM.net.nodes.length
    ? CRM.net.nodes.length + ' verknüpfte Kontakte/Projekte'
    : '';
  document.getElementById('net-empty').classList.toggle('hidden', CRM.net.nodes.length > 0);
};

/* ---------- Layout: einfache Kräfte-Simulation, statisch berechnet ---------- */
CRM.net.layout = function () {
  const nodes = CRM.net.nodes;
  const w = CRM.net.canvas ? CRM.net.canvas.width : 800;
  const h = CRM.net.canvas ? CRM.net.canvas.height : 500;
  if (!nodes.length) return;
  const cx = w / 2, cy = h / 2;
  nodes.forEach((n, i) => {
    const angle = (i / nodes.length) * Math.PI * 2;
    const rad = Math.min(w, h) * 0.32;
    n.x = cx + Math.cos(angle) * rad;
    n.y = cy + Math.sin(angle) * rad;
  });

  const edges = CRM.net.edges;
  for (let iter = 0; iter < 300; iter++) {
    // Abstoßung zwischen allen Knotenpaaren
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const minDist = 90;
        if (dist < minDist * 3) {
          const force = (minDist * minDist) / (dist * dist) * 0.6;
          dx /= dist; dy /= dist;
          a.x += dx * force; a.y += dy * force;
          b.x -= dx * force; b.y -= dy * force;
        }
      }
    }
    // Anziehung entlang Kanten
    edges.forEach((e) => {
      let dx = e.b.x - e.a.x, dy = e.b.y - e.a.y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const targetDist = 140;
      const force = (dist - targetDist) * 0.02;
      dx /= dist; dy /= dist;
      e.a.x += dx * force; e.a.y += dy * force;
      e.b.x -= dx * force; e.b.y -= dy * force;
    });
    // Zentrierende Kraft, damit der Graph nicht wegdriftet
    nodes.forEach((n) => {
      n.x += (cx - n.x) * 0.002;
      n.y += (cy - n.y) * 0.002;
      n.x = Math.max(30, Math.min(w - 30, n.x));
      n.y = Math.max(30, Math.min(h - 30, n.y));
    });
  }
};

/* ---------- Canvas: Setup, Draw, Interaktion ---------- */
CRM.net.setupCanvas = function () {
  const canvas = document.getElementById('net-canvas');
  const wrap = document.getElementById('net-canvas-wrap');
  canvas.width = wrap.clientWidth;
  canvas.height = wrap.clientHeight || 480;
  CRM.net.canvas = canvas;
  CRM.net.ctx = canvas.getContext('2d');

  canvas.onmousedown = (e) => CRM.net.onDown(CRM.net.getPos(canvas, e));
  canvas.onmousemove = (e) => CRM.net.onMove(CRM.net.getPos(canvas, e));
  // Kein window.onmouseup= (würde fremde Handler überschreiben); bei jedem
  // Re-Render den alten Listener abhängen, damit sich keine ansammeln.
  if (CRM.net._mouseUpHandler) window.removeEventListener('mouseup', CRM.net._mouseUpHandler);
  CRM.net._mouseUpHandler = () => CRM.net.onUp();
  window.addEventListener('mouseup', CRM.net._mouseUpHandler);
  canvas.onclick = (e) => { if (!CRM.net.dragMoved) CRM.net.onClick(CRM.net.getPos(canvas, e)); };

  // Touch-Unterstützung (Handy/Tablet)
  canvas.addEventListener('touchstart', (e) => { const t = e.touches[0]; CRM.net.onDown(CRM.net.getPos(canvas, t)); }, { passive: true });
  canvas.addEventListener('touchmove', (e) => { const t = e.touches[0]; CRM.net.onMove(CRM.net.getPos(canvas, t)); }, { passive: true });
  canvas.addEventListener('touchend', () => { CRM.net.onUp(); if (!CRM.net.dragMoved) CRM.net.onClick(CRM.net._lastPos); });

  window.addEventListener('resize', CRM.net._resizeHandler = () => {
    if (!document.getElementById('net-canvas-wrap')) { window.removeEventListener('resize', CRM.net._resizeHandler); return; }
    canvas.width = wrap.clientWidth;
    canvas.height = wrap.clientHeight || 480;
    CRM.net.draw();
  });
};

CRM.net.getPos = function (canvas, e) {
  const r = canvas.getBoundingClientRect();
  const pos = { x: e.clientX - r.left, y: e.clientY - r.top };
  CRM.net._lastPos = pos;
  return pos;
};

CRM.net.nodeAt = function (pos) {
  return CRM.net.nodes.find((n) => Math.hypot(n.x - pos.x, n.y - pos.y) < n.r + 5);
};

CRM.net.onDown = function (pos) {
  const n = CRM.net.nodeAt(pos);
  CRM.net.dragMoved = false;
  if (n) { CRM.net.dragNode = n; CRM.net.isDragging = true; }
};
CRM.net.onMove = function (pos) {
  if (CRM.net.isDragging && CRM.net.dragNode) {
    CRM.net.dragNode.x = pos.x;
    CRM.net.dragNode.y = pos.y;
    CRM.net.dragMoved = true;
    CRM.net.draw();
  }
};
CRM.net.onUp = function () {
  CRM.net.isDragging = false;
  CRM.net.dragNode = null;
};
CRM.net.onClick = function (pos) {
  const n = CRM.net.nodeAt(pos);
  CRM.net.selectedId = n ? n.id : null;
  CRM.net.draw();
  CRM.net.renderSide();
};

CRM.net.draw = function () {
  const ctx = CRM.net.ctx;
  if (!ctx) return;
  const canvas = CRM.net.canvas;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  CRM.net.edges.forEach((e) => {
    const isSel = CRM.net.selectedId && (e.a.id === CRM.net.selectedId || e.b.id === CRM.net.selectedId);
    ctx.beginPath();
    ctx.moveTo(e.a.x, e.a.y);
    ctx.lineTo(e.b.x, e.b.y);
    ctx.strokeStyle = isSel ? 'rgba(227,140,47,.85)' : 'rgba(255,255,255,.14)';
    ctx.lineWidth = isSel ? 2 : 1;
    ctx.stroke();
    if (isSel && e.label) {
      const mx = (e.a.x + e.b.x) / 2, my = (e.a.y + e.b.y) / 2;
      ctx.font = '10px system-ui,sans-serif';
      ctx.fillStyle = '#ff9f43';
      ctx.textAlign = 'center';
      ctx.fillText(e.label, mx, my - 4);
    }
  });

  CRM.net.nodes.forEach((n) => {
    const isSel = CRM.net.selectedId === n.id;
    const isConn = CRM.net.selectedId && CRM.net.edges.some((e) => (e.a.id === CRM.net.selectedId && e.b.id === n.id) || (e.b.id === CRM.net.selectedId && e.a.id === n.id));

    if (isSel || isConn) {
      ctx.beginPath();
      ctx.arc(n.x, n.y, n.r + 6, 0, Math.PI * 2);
      ctx.fillStyle = n.color + '30';
      ctx.fill();
    }
    ctx.beginPath();
    if (n.kind === 'project') {
      const s = n.r;
      ctx.moveTo(n.x, n.y - s); ctx.lineTo(n.x + s, n.y); ctx.lineTo(n.x, n.y + s); ctx.lineTo(n.x - s, n.y);
      ctx.closePath();
    } else {
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
    }
    ctx.fillStyle = isSel ? n.color : (isConn ? n.color + 'cc' : n.color + '55');
    ctx.fill();
    ctx.strokeStyle = n.color;
    ctx.lineWidth = isSel ? 2.5 : 1.4;
    ctx.stroke();

    ctx.fillStyle = isSel ? '#fff' : (isConn ? '#ddd' : '#9aa4b5');
    ctx.font = (isSel ? 'bold ' : '') + '10px system-ui,sans-serif';
    ctx.textAlign = 'center';
    const words = n.name.split(' ').slice(0, 2).join(' ');
    ctx.fillText(words.length > 22 ? words.slice(0, 20) + '…' : words, n.x, n.y + n.r + 13);
  });
};

/* ---------- Seiten-Panel: Details + Verknüpfungen des gewählten Knotens ---------- */
CRM.net.renderSide = function () {
  const side = document.getElementById('net-side');
  const id = CRM.net.selectedId;
  if (!id) { side.innerHTML = '<div class="net-side-empty">Klicke auf einen Knoten, um Details zu sehen.</div>'; return; }
  const n = CRM.net.nodes.find((x) => x.id === id);
  if (!n) return;

  const connected = CRM.net.edges
    .filter((e) => e.a.id === id || e.b.id === id)
    .map((e) => ({ node: e.a.id === id ? e.b : e.a, label: e.label }));

  const openAction = n.kind === 'contact'
    ? `CRM.openContactDetail('${n.refId}')`
    : `CRM.openProjectDetail('${n.refId}')`;

  side.innerHTML = `
    <div class="net-side-header">
      <div class="net-side-name">${n.kind === 'project' ? '📋 ' : ''}${esc(n.name)}</div>
      ${n.kind === 'contact' ? `<span class="badge badge-${n.type}">${CRM.TYPE_LABELS[n.type] || n.type}</span>` : `<span class="badge badge-status-${n.status}">${CRM.PROJECT_STATUS_LABELS[n.status] || n.status}</span>`}
      <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${esc(n.sub || '')}${n.erpNr ? ' · ERP: ' + esc(n.erpNr) : ''}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="${openAction}">Öffnen</button>
    </div>
    <div class="net-side-rels">
      <div class="net-side-rels-title">Verknüpfungen (${connected.length})</div>
      ${connected.length ? connected.map((c) => `
        <div class="net-rel-card" onclick="CRM.net.selectedId='${c.node.id}';CRM.net.draw();CRM.net.renderSide()">
          <span class="net-rel-dot" style="background:${c.node.color}"></span>
          <div>
            <div class="net-rel-name">${c.node.kind === 'project' ? '📋 ' : ''}${esc(c.node.name)}</div>
            <div class="net-rel-meta">${c.label ? esc(c.label) + ' · ' : ''}${c.node.kind === 'project' ? 'Projekt' : (CRM.TYPE_LABELS[c.node.type] || c.node.type)}</div>
          </div>
        </div>
      `).join('') : '<p style="color:var(--text-dim);font-size:12px">Keine Verknüpfungen.</p>'}
    </div>
  `;
};

/* ---------- Suche: Knoten zentrieren + auswählen ---------- */
CRM.net.onSearch = function (query) {
  const q = query.trim().toLowerCase();
  if (!q) return;
  const match = CRM.net.nodes.find((n) => n.name.toLowerCase().includes(q));
  if (!match) return;
  CRM.net.selectedId = match.id;
  const canvas = CRM.net.canvas;
  match.x = canvas.width / 2;
  match.y = canvas.height / 2;
  CRM.net.draw();
  CRM.net.renderSide();
};
