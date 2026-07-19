/* ============================================================
   Claytec CRM — Projekte (Schritt 10)
   Kanban: Planung → Ausschreibung → Laufend → Abgeschlossen
   Pro Projekt: beteiligte Kontakte (Architekt/Händler/Verarbeiter),
   Claytec-Produkte, und eine vereinte Aktivitäts-Timeline
   (Besuche beteiligter Kontakte + Kommunikation/E-Mails am Projekt).
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM._projFilter = CRM._projFilter || { text: '', kategorie: '' };

/* Projektsuche: Zahlen = ERP-Nr.- oder PLZ-Anfang, Text = Name/Ort (wie Kontakte) */
CRM.projectQueryMatch = function (query, p) {
  const tokens = CRM.searchNorm(query).split(' ').filter(Boolean);
  if (!tokens.length) return true;
  const hay = ' ' + CRM.searchNorm([p.name, p.ort, p.notes].filter(Boolean).join(' ')) + ' ';
  return tokens.every((t) => {
    if (/^\d+$/.test(t)) {
      return String(p.erpNr || '').replace(/\D/g, '').startsWith(t) || String(p.plz || '').startsWith(t);
    }
    return hay.includes(t);
  });
};

CRM.renderProjects = function () {
  const container = document.getElementById('view-projekte');
  const f = CRM._projFilter;
  const projects = CRM.db.getProjects()
    .filter((p) => !f.kategorie || (p.kategorie || 'baustelle') === f.kategorie)
    .filter((p) => !f.text || CRM.projectQueryMatch(f.text, p));

  const columns = CRM.PROJECT_STATUS.map((status) => {
    const items = projects.filter((p) => p.status === status);
    const cards = items.map((p) => CRM.projectCard(p)).join('') || '<p style="color:var(--text-dim);font-size:12px">—</p>';
    return `<div class="kanban-col" data-status="${status}"
        ondragover="event.preventDefault()" ondrop="CRM.dropProject(event,'${status}')">
        <div class="kanban-head">${CRM.PROJECT_STATUS_LABELS[status]} <span class="badge">${items.length}</span></div>
        ${cards}
      </div>`;
  }).join('');

  const total = CRM.db.getProjects().length;
  const katChip = (val, label) => `<button class="qf-btn ${f.kategorie === val ? 'active' : ''}" onclick="CRM.setProjKategorieFilter('${val}')">${label}</button>`;

  container.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px">
      <h2 style="margin:0">Projekte</h2>
      <button class="btn btn-primary btn-sm" onclick="CRM.createNewProject()">+ Neues Projekt</button>
    </div>
    <div class="row" style="margin-bottom:8px;align-items:center;gap:8px;flex-wrap:wrap">
      <input id="proj-search" placeholder="Suche: Name, ERP-Nr., PLZ, Ort..." value="${escAttr(f.text)}" style="max-width:280px">
      <div class="quick-filters" style="margin:0">
        ${katChip('', 'Alle')}${katChip('gross', '🏢 Großprojekte')}${katChip('baustelle', '🏠 Baustellen')}
      </div>
      <span style="color:var(--text-dim);font-size:12px">${projects.length} von ${total}</span>
    </div>
    <div class="kanban">${columns}</div>
  `;

  // Entprellte Suche (gleiches Muster wie Kontaktliste), Fokus/Cursor erhalten
  const search = document.getElementById('proj-search');
  let deb = null;
  search.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => {
      CRM._projFilter.text = search.value.trim();
      const pos = search.selectionStart;
      CRM.renderProjects();
      const s2 = document.getElementById('proj-search');
      if (s2) { s2.focus(); s2.setSelectionRange(pos, pos); }
    }, 250);
  });
};

CRM.setProjKategorieFilter = function (val) {
  CRM._projFilter.kategorie = val;
  CRM.renderProjects();
};

CRM.projectCard = function (p) {
  const roles = CRM.projectContactsByRole(p);
  const roleCounts = `${roles.architekt.length}A · ${roles.haendler.length}H · ${roles.verarbeiter.length}V`;
  const products = (p.products || []).map((pr) => `<span class="badge">${esc(pr)}</span>`).join(' ');
  const kat = p.kategorie || 'baustelle';
  // Nächste fällige offene Aufgabe des Projekts — das Steuerungssignal der Karte
  const nextTask = CRM.db.getTasksForProject(p.id)
    .filter((t) => !t.done && t.due)
    .sort((a, b) => (a.due < b.due ? -1 : 1))[0];
  const nextHtml = nextTask
    ? (() => {
      const st = CRM.getTaskDueStatus(nextTask);
      const overdue = st.status === 'overdue' || st.status === 'today';
      return `<div class="li-sub" style="margin-top:4px;${overdue ? 'color:var(--red)' : ''}">✓ ${esc(nextTask.title)} · ${esc(nextTask.due)}</div>`;
    })()
    : '';
  return `<div class="kanban-card" draggable="true"
      ondragstart="CRM.dragProject(event,'${p.id}')" onclick="CRM.openProjectDetail('${p.id}')">
      <div class="li-title">${kat === 'gross' ? '🏢 ' : '🏠 '}${esc(p.name) || '(ohne Namen)'}</div>
      <div class="li-sub">${esc([p.plz, p.ort].filter(Boolean).join(' ')) || '—'}${p.erpNr ? ' · ERP ' + esc(p.erpNr) : ''} · 👥 ${roleCounts}</div>
      ${nextHtml}
      ${products ? `<div class="li-badges" style="margin-top:6px">${products}</div>` : ''}
    </div>`;
};

CRM.projectContactsByRole = function (p) {
  const out = { architekt: [], haendler: [], verarbeiter: [], sonstige: [] };
  (p.contactIds || []).forEach((id) => {
    const c = CRM.db.getContact(id);
    if (c) (out[c.type] || out.sonstige).push(c);
  });
  return out;
};

/* ---------- Projekt-Aufgaben (gleiche Engine wie Kontakt-Aufgaben) ---------- */
CRM.renderProjectTasks = function (projectId) {
  const tasks = CRM.db.getTasksForProject(projectId).sort((a, b) => (a.done - b.done) || ((a.due || '') < (b.due || '') ? -1 : 1));
  if (!tasks.length) return '<p style="color:var(--text-dim);font-size:13px">Keine offenen Aufgaben.</p>';
  return tasks.map((t) => {
    const st = CRM.getTaskDueStatus(t);
    const cls = st.status === 'overdue' ? 'badge-overdue' : '';
    return `<div class="list-item" style="cursor:default">
      <input type="checkbox" style="width:auto;margin-right:10px" ${t.done ? 'checked' : ''} onchange="CRM.toggleProjectTask('${t.id}','${projectId}')">
      <div class="li-main"><div class="li-title" style="${t.done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc(t.title)}</div>
        <div class="li-sub"><span class="badge ${cls}">fällig ${esc(t.due)}</span></div></div>
      <button class="btn btn-sm" onclick="CRM.db.deleteTask('${t.id}');CRM.openProjectDetail('${projectId}')">🗑</button>
    </div>`;
  }).join('');
};

CRM.addProjectTask = function (projectId) {
  const title = document.getElementById('proj-task-title').value.trim();
  const due = document.getElementById('proj-task-due').value;
  if (!title) { CRM.toast('Bitte Aufgabentitel eingeben.', 'error'); return; }
  CRM.db.addTask({ title, due, projectId, contactId: null });
  CRM.toast(`✓ Aufgabe gespeichert: „${title}" (fällig ${due})`, 'success');
  CRM.openProjectDetail(projectId);
};

CRM.toggleProjectTask = function (taskId, projectId) {
  const t = CRM.db.getTask(taskId);
  if (!t) return;
  CRM.db.updateTask(taskId, { done: !t.done, doneAt: !t.done ? new Date().toISOString() : null });
  CRM.openProjectDetail(projectId);
};

/* ---------- Drag & Drop zwischen Spalten ---------- */
CRM.dragProject = function (e, id) {
  e.dataTransfer.setData('text/plain', id);
};
CRM.dropProject = function (e, status) {
  e.preventDefault();
  const id = e.dataTransfer.getData('text/plain');
  if (id) {
    CRM.db.updateProject(id, { status });
    CRM.renderProjects();
  }
};

CRM.createNewProject = function () {
  const p = CRM.makeEmptyProject();
  p.name = 'Neues Projekt';
  CRM.db.addProject(p);
  CRM.renderProjects();
  CRM.openProjectDetail(p.id);
};

/* ============================================================
   Projekt-Detail
   ============================================================ */
CRM.openProjectDetail = function (id) {
  const p = CRM.db.getProject(id);
  if (!p) return;
  const statusOptions = CRM.PROJECT_STATUS.map((s) => `<option value="${s}" ${p.status === s ? 'selected' : ''}>${CRM.PROJECT_STATUS_LABELS[s]}</option>`).join('');

  // Eigene (Freitext-)Aufbauvarianten = alles, was kein bekanntes Produkt ist
  const knownProducts = Object.values(CRM.PRODUCT_CATEGORIES).flat();
  CRM._projCustomProducts = (p.products || []).filter((x) => !knownProducts.includes(x));

  const html = `
    <div class="cd-header">
      <div>
        <h2 style="margin:0 0 6px">${esc(p.name)}</h2>
        <span class="badge badge-status-${p.status}">${CRM.PROJECT_STATUS_LABELS[p.status]}</span>
      </div>
      <button class="btn btn-icon" onclick="CRM.closeModal()">✕</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Projektdaten</h3>
      <div class="row">
        <div class="col"><label>Projektname</label><input id="proj-name" value="${escAttr(p.name)}" onfocus="if(this.value==='Neues Projekt')this.select()"></div>
        <div class="col" style="max-width:150px"><label>ERP-Nr.</label><input id="proj-erp" value="${escAttr(p.erpNr || '')}" placeholder="z.B. 45123"></div>
        <div class="col" style="max-width:180px"><label>Status</label><select id="proj-status">${statusOptions}</select></div>
        <div class="col" style="max-width:180px"><label>Kategorie</label><select id="proj-kategorie">${CRM.PROJECT_KATEGORIEN.map((k) => `<option value="${k}" ${(p.kategorie || 'baustelle') === k ? 'selected' : ''}>${CRM.PROJECT_KATEGORIE_LABELS[k]}</option>`).join('')}</select></div>
      </div>
      <div class="row">
        <div class="col" style="max-width:120px"><label>PLZ</label><input id="proj-plz" value="${escAttr(p.plz || '')}"></div>
        <div class="col"><label>Ort</label><input id="proj-ort" value="${escAttr(p.ort || '')}"></div>
      </div>
      <label>Claytec-Produkte / Aufbauvarianten</label>
      <div id="proj-products-wrap" style="margin:4px 0 10px">${CRM.renderProjProducts(p)}</div>
      <label>Notizen</label>
      <textarea id="proj-notes" rows="2">${esc(p.notes || '')}</textarea>
      <button class="btn btn-primary btn-sm" style="margin-top:10px" onclick="CRM.saveProjectDetail('${p.id}')">Speichern</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Beteiligte Kontakte</h3>
      <div id="proj-contacts">${CRM.renderProjectContacts(p)}</div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="CRM.openProjectContactPicker('${p.id}')">+ Kontakt verknüpfen</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Aufgaben</h3>
      <div id="proj-tasks">${CRM.renderProjectTasks(p.id)}</div>
      <div class="row" style="margin-top:8px;align-items:flex-end">
        <div class="col"><input id="proj-task-title" placeholder="Neue Aufgabe für dieses Projekt" onkeydown="if(event.key==='Enter')CRM.addProjectTask('${p.id}')"></div>
        <div class="col" style="max-width:160px"><input type="date" id="proj-task-due" value="${new Date().toISOString().slice(0, 10)}"></div>
        <button class="btn btn-primary" style="min-height:44px" onclick="CRM.addProjectTask('${p.id}')">💾 Aufgabe speichern</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Aktivität & Kommunikation</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:0 0 8px">Besuche beteiligter Kontakte + E-Mails/Notizen zu diesem Projekt — chronologisch.</p>
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-sm" onclick="CRM.mailAblage.open(null,'${p.id}')">📧 E-Mail ablegen</button>
        <button class="btn btn-sm" onclick="CRM.openCommForm('project','${p.id}','note')">📝 Notiz</button>
        <button class="btn btn-sm" onclick="CRM.openCommForm('project','${p.id}','call')">📞 Anruf</button>
      </div>
      <div id="proj-timeline">${CRM.renderProjectTimeline(p)}</div>
    </div>

    <div style="text-align:right">
      <button class="btn" style="border-color:var(--red);color:var(--red)" onclick="CRM.deleteProjectConfirm('${p.id}')">Projekt löschen</button>
    </div>
  `;
  const overlay = CRM.openModal(html);
  overlay.querySelector('.modal').classList.add('modal-wide');
  CRM.wirePlzOrtAutofill(document.getElementById('proj-plz'), document.getElementById('proj-ort'));
};

/* Produktauswahl nach Kategorie: bekannte Produkte als Checkboxen,
   eigene Aufbauvarianten als Freitext-Chips („Kategorie: Variante") */
CRM.renderProjProducts = function (p) {
  const selected = new Set(p.products || []);
  return Object.entries(CRM.PRODUCT_CATEGORIES).map(([cat, prods]) => {
    const checks = prods.map((pr) => `
      <label style="display:inline-flex;align-items:center;gap:5px;margin-right:14px;color:var(--text)">
        <input type="checkbox" class="proj-product" value="${pr}" ${selected.has(pr) ? 'checked' : ''} style="width:auto"> ${pr}
      </label>`).join('');
    const customChips = CRM._projCustomProducts
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => v.startsWith(cat + ':'))
      .map(({ v, idx }) => `<span class="badge">${esc(v.slice(cat.length + 1).trim())}
        <span style="cursor:pointer;opacity:.7" onclick="CRM.removeProjVariant(${idx},'${p.id}')">✕</span></span>`).join(' ');
    const catKey = cat.replace(/[^a-z]/gi, '');
    return `<div style="margin-bottom:10px">
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px;font-weight:600">${cat}</div>
      ${checks}
      ${customChips ? `<div class="li-badges" style="margin-top:6px">${customChips}</div>` : ''}
      <div class="row" style="margin-top:6px;gap:6px">
        <input id="proj-var-${catKey}" placeholder="Eigene Aufbauvariante..." style="max-width:260px" onkeydown="if(event.key==='Enter')CRM.addProjVariant('${cat}','${p.id}')">
        <button class="btn btn-sm" onclick="CRM.addProjVariant('${cat}','${p.id}')">+ Variante</button>
      </div>
    </div>`;
  }).join('') + (function () {
    // Alt-Einträge ohne Kategorie-Präfix (aus der früheren Struktur) weiter anzeigen
    const legacy = CRM._projCustomProducts
      .map((v, idx) => ({ v, idx }))
      .filter(({ v }) => !Object.keys(CRM.PRODUCT_CATEGORIES).some((cat) => v.startsWith(cat + ':')));
    if (!legacy.length) return '';
    return `<div style="margin-bottom:6px"><div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Weitere</div>
      <div class="li-badges">${legacy.map(({ v, idx }) => `<span class="badge">${esc(v)}
        <span style="cursor:pointer;opacity:.7" onclick="CRM.removeProjVariant(${idx},'${p.id}')">✕</span></span>`).join(' ')}</div></div>`;
  })();
};

CRM.refreshProjProducts = function (projectId) {
  const wrap = document.getElementById('proj-products-wrap');
  const p = CRM.db.getProject(projectId);
  if (wrap && p) {
    // Häkchen-Zustand vor dem Re-Render sichern, damit ungespeicherte Auswahl erhalten bleibt
    const checked = Array.from(document.querySelectorAll('.proj-product:checked')).map((el) => el.value);
    const pView = Object.assign({}, p, { products: checked.concat(CRM._projCustomProducts) });
    wrap.innerHTML = CRM.renderProjProducts(pView);
  }
};

CRM.addProjVariant = function (cat, projectId) {
  const catKey = cat.replace(/[^a-z]/gi, '');
  const input = document.getElementById('proj-var-' + catKey);
  const val = (input ? input.value : '').trim();
  if (!val) return;
  const entry = cat + ': ' + val;
  if (!CRM._projCustomProducts.includes(entry)) CRM._projCustomProducts.push(entry);
  CRM.refreshProjProducts(projectId);
};

CRM.removeProjVariant = function (idx, projectId) {
  CRM._projCustomProducts.splice(idx, 1);
  CRM.refreshProjProducts(projectId);
};

CRM.saveProjectDetail = function (id) {
  const products = Array.from(document.querySelectorAll('.proj-product:checked')).map((el) => el.value)
    .concat(CRM._projCustomProducts || []);
  CRM.db.updateProject(id, {
    name: document.getElementById('proj-name').value.trim() || '(ohne Namen)',
    erpNr: document.getElementById('proj-erp').value.trim(),
    status: document.getElementById('proj-status').value,
    kategorie: document.getElementById('proj-kategorie').value,
    plz: document.getElementById('proj-plz').value.trim(),
    ort: document.getElementById('proj-ort').value.trim(),
    notes: document.getElementById('proj-notes').value,
    products,
  });
  CRM.toast('Projekt gespeichert.', 'success');
  CRM.openProjectDetail(id);
  CRM.renderProjects();
};

CRM.deleteProjectConfirm = function (id) {
  const p = CRM.db.getProject(id);
  if (confirm(`Projekt „${p.name}" wirklich löschen? Verknüpfungen werden entfernt, Kontakte bleiben erhalten.`)) {
    CRM.db.deleteProject(id);
    CRM.closeModal();
    CRM.renderProjects();
    CRM.toast('Projekt gelöscht.', 'success');
  }
};

/* ---------- Beteiligte Kontakte nach Rolle ---------- */
CRM.renderProjectContacts = function (p) {
  const roles = CRM.projectContactsByRole(p);
  const groups = [
    { key: 'architekt', label: 'Architekten' },
    { key: 'haendler', label: 'Händler' },
    { key: 'verarbeiter', label: 'Verarbeiter' },
    { key: 'sonstige', label: 'Sonstige' },
  ];
  let html = '';
  groups.forEach((g) => {
    if (!roles[g.key].length) return;
    const chips = roles[g.key].map((c) => `<span class="badge" style="cursor:pointer" onclick="CRM.openContactDetail('${c.id}')">${esc(c.firma1)}
      <span style="opacity:.7" onclick="event.stopPropagation();CRM.unlinkProjectContact('${p.id}','${c.id}')">✕</span></span>`).join(' ');
    html += `<div style="margin-bottom:8px"><label style="margin-bottom:4px">${g.label}</label><div class="li-badges">${chips}</div></div>`;
  });
  return html || '<p style="color:var(--text-dim);font-size:13px">Noch keine Kontakte verknüpft.</p>';
};

CRM.unlinkProjectContact = function (projectId, contactId) {
  CRM.unlinkContactFromProject(contactId, projectId);
  CRM.openProjectDetail(projectId);
  CRM.renderProjects();
};

/* ---------- Kontakt-Picker für Projekt ---------- */
CRM.openProjectContactPicker = function (projectId) {
  CRM._projPicker = { projectId, query: '' };
  CRM.openModal(`
    <h2>Kontakt mit Projekt verknüpfen</h2>
    <input id="proj-pick-search" placeholder="Suche Firma, Ort, PLZ...">
    <div style="margin-top:10px;max-height:50vh;overflow-y:auto" id="proj-pick-results"></div>
    <div class="modal-footer"><button class="btn" onclick="CRM.openProjectDetail('${projectId}')">Zurück zum Projekt</button></div>
  `);
  document.getElementById('proj-pick-search').addEventListener('input', (e) => {
    CRM._projPicker.query = e.target.value;
    CRM.updateProjPickResults();
  });
  CRM.updateProjPickResults();
};

CRM.updateProjPickResults = function () {
  const { projectId, query } = CRM._projPicker;
  const p = CRM.db.getProject(projectId);
  const linked = new Set(p.contactIds || []);
  const q = query.toLowerCase();
  const results = CRM.db.getContacts()
    .filter((c) => !q || (c.firma1 + ' ' + c.ort + ' ' + c.plz).toLowerCase().includes(q))
    .slice(0, 60);
  document.getElementById('proj-pick-results').innerHTML = results.length ? results.map((c) => `
    <div class="list-item" onclick="CRM.pickProjectContact('${c.id}')">
      <div class="li-main"><div class="li-title">${esc(c.firma1)}</div>
      <div class="li-sub">${CRM.TYPE_LABELS[c.type]} · ${esc(c.plz)} ${esc(c.ort)}</div></div>
      ${linked.has(c.id) ? '<span class="badge">verknüpft</span>' : ''}
    </div>`).join('') : '<p style="color:var(--text-dim)">Keine Treffer</p>';
};

CRM.pickProjectContact = function (contactId) {
  CRM.linkContactToProject(contactId, CRM._projPicker.projectId);
  CRM.toast('Kontakt verknüpft.', 'success');
  CRM.openProjectDetail(CRM._projPicker.projectId);
  CRM.renderProjects();
};

/* ============================================================
   Vereinte Aktivitäts-Timeline (E-Mail-fähig)
   ============================================================ */
CRM.renderProjectTimeline = function (p) {
  const events = [];
  // Kommunikation, die an diesem Projekt hängt
  CRM.db.getCommsForProject(p.id).forEach((m) => {
    events.push({ date: m.date, kind: 'comm', comm: m });
  });
  // Besuche der beteiligten Kontakte
  (p.contactIds || []).forEach((cid) => {
    const c = CRM.db.getContact(cid);
    if (!c) return;
    (c.visits || []).forEach((v) => events.push({ date: v.date, kind: 'visit', contact: c, visit: v }));
  });
  events.sort((a, b) => (a.date < b.date ? 1 : -1));
  if (!events.length) return '<p style="color:var(--text-dim);font-size:13px">Noch keine Aktivität. Erfasse eine E-Mail/Notiz oder einen Besuch bei einem beteiligten Kontakt.</p>';

  return events.map((e) => {
    if (e.kind === 'comm') {
      const m = e.comm;
      const meta = [m.from && ('von ' + m.from), m.to && ('an ' + m.to)].filter(Boolean).join(' · ');
      return `<div class="list-item" style="cursor:default">
        <div class="li-main">
          <div class="li-title">${CRM.COMM_TYPE_LABELS[m.type] || m.type}: ${esc(m.subject) || '(ohne Betreff)'}</div>
          <div class="li-sub">${esc(m.date)}${meta ? ' · ' + esc(meta) : ''}</div>
          ${m.body ? `<div class="li-sub" style="white-space:pre-wrap;margin-top:4px">${esc(m.body)}</div>` : ''}
        </div>
        <button class="btn btn-sm" onclick="CRM.db.deleteComm('${m.id}');CRM.openProjectDetail('${p.id}')">🗑</button>
      </div>`;
    }
    return `<div class="list-item" onclick="CRM.openContactDetail('${e.contact.id}')" style="cursor:pointer">
      <div class="li-main">
        <div class="li-title">📍 Besuch: ${esc(e.contact.firma1)}</div>
        <div class="li-sub">${esc(e.visit.date)}${e.visit.note ? ' · ' + esc(e.visit.note) : ''}</div>
      </div></div>`;
  }).join('');
};

/* ============================================================
   Kommunikation erfassen (E-Mail/Notiz/Anruf) — manuell nutzbar,
   automatischer Import kann später dieselbe Struktur befüllen.
   scope: 'project' | 'contact'
   ============================================================ */
CRM.openCommForm = function (scope, ownerId, type) {
  CRM._commForm = { scope, ownerId, type };
  const label = CRM.COMM_TYPE_LABELS[type] || type;
  CRM.openModal(`
    <h2>${label} erfassen</h2>
    <div class="row">
      <div class="col" style="max-width:170px"><label>Datum</label><input type="date" id="comm-date" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="col"><label>Betreff</label><input id="comm-subject" placeholder="Worum geht es?"></div>
    </div>
    ${type === 'email' ? `<div class="row">
      <div class="col"><label>Von</label><input id="comm-from" placeholder="Absender"></div>
      <div class="col"><label>An</label><input id="comm-to" placeholder="Empfänger"></div>
    </div>` : ''}
    <label>Inhalt</label>
    <textarea id="comm-body" rows="5" placeholder="E-Mail-Text / Notiz hier einfügen..."></textarea>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.commFormBack()">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.saveComm()">Speichern</button>
    </div>
  `);
};

CRM.commFormBack = function () {
  const { scope, ownerId } = CRM._commForm;
  if (scope === 'project') CRM.openProjectDetail(ownerId);
  else CRM.openContactDetail(ownerId);
};

CRM.saveComm = function () {
  const { scope, ownerId, type } = CRM._commForm;
  const comm = CRM.makeEmptyComm();
  comm.type = type;
  comm.date = document.getElementById('comm-date').value || new Date().toISOString().slice(0, 10);
  comm.subject = document.getElementById('comm-subject').value.trim();
  comm.body = document.getElementById('comm-body').value;
  if (type === 'email') {
    comm.from = (document.getElementById('comm-from') || {}).value || '';
    comm.to = (document.getElementById('comm-to') || {}).value || '';
  }
  if (scope === 'project') comm.projectIds = [ownerId];
  else comm.contactIds = [ownerId];
  CRM.db.addComm(comm);
  CRM.toast('Erfasst.', 'success');
  CRM.commFormBack();
};
