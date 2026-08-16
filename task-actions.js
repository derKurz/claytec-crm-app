/* ============================================================
   Claytec CRM — Aufgaben-Aktionen (Batch 6a, 2026-08)
   Gemeinsames, kontaktunabhängiges Aufgaben-Modul, genutzt von
   Startseite (dashboard.js), Kontaktprofil (contact-detail.js) und
   Agenda/"Heute" (agenda.js) — EINE Implementierung statt drei Kopien.

   Chris' Meldung: von der Startseite aus ließ sich eine Aufgabe weder
   abhaken noch verschieben, bearbeiten oder verknüpfen — der bisherige
   Editor (CRM.activities.edit) verlangt zwingend einen bereits offenen
   Kontakt. CRM.taskActions.* funktioniert überall gleich:
   abhaken · verschieben · bearbeiten · verknüpfen · löschen.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.taskActions = {};

/* ---------- Rückkehr-/Refresh-Kontext ----------
   Wird aus generierten onclick-Strings heraus aufgerufen (siehe menuHtml),
   deshalb nur einfache String-Argumente — kein JSON in HTML-Attributen. */
CRM.taskActions.uiCtx = function (returnType, returnId) {
  if (returnType === 'contact') return { returnTo: { type: 'contact', contactId: returnId } };
  if (returnType === 'project') return { returnTo: { type: 'project', projectId: returnId } };
  if (returnType === 'dashboard') return { returnTo: { type: 'dashboard' } };
  if (returnType === 'agenda') return { returnTo: { type: 'agenda' } };
  return {};
};

/* Zeichnet nach einer Aktion defensiv alle Oberflächen neu, auf denen die
   Aufgabe sichtbar sein könnte (Funktion/Element vorhanden? nur dann tun).
   Batch 8b: nutzt die gemeinsame CRM._refreshAllVisibleViews() (app.js) —
   dieselbe Logik, die auch CRM.toastUndo nach einem Undo verwendet, statt
   einer zweiten, separat gepflegten Refresh-Liste. */
CRM.taskActions._refresh = function (opts) {
  opts = opts || {};
  if (opts.after) { opts.after(); return; }
  if (CRM._refreshAllVisibleViews) CRM._refreshAllVisibleViews({ contactId: opts.contactId, projectId: opts.projectId });
};

/* Nach Bearbeiten (Editor) gezielt zurückkehren — opts.returnTo sagt,
   woher der Aufruf kam; fällt sonst auf die defensive Auto-Aktualisierung
   zurück (z.B. wenn der Kontakt beim Umhängen gewechselt hat). */
CRM.taskActions._returnAfterEdit = function (opts, contactId, projectId) {
  opts = opts || {};
  const rt = opts.returnTo;
  if (rt && rt.type === 'contact' && rt.contactId && CRM.openContactDetail) { CRM.openContactDetail(rt.contactId); return; }
  if (rt && rt.type === 'project' && rt.projectId && CRM.openProjectDetail) { CRM.openProjectDetail(rt.projectId); return; }
  if (rt && rt.type === 'dashboard' && CRM.renderDashboard) { CRM.renderDashboard(); return; }
  if (rt && rt.type === 'agenda' && CRM.renderAgenda) { CRM.renderAgenda(); return; }
  CRM.taskActions._refresh({ contactId: contactId, projectId: projectId });
};

/* ---------- Abhaken / wieder öffnen ----------
   Batch 8b: genau wie CRM.taskActions.remove bekommt auch das Abhaken
   einen Undo-Snapshot — ein versehentliches Erledigen/Wiederöffnen war
   bisher nicht rückgängig zu machen. */
CRM.taskActions.toggleDone = function (taskId, opts) {
  opts = opts || {};
  const t = CRM.db.getTask(taskId);
  if (!t) return;
  CRM.takeSnapshot('Vor Aufgabe erledigt/wieder geöffnet');
  const wasDone = t.done;
  CRM.db.updateTask(taskId, { done: !t.done, doneAt: !t.done ? new Date().toISOString() : null });
  CRM.taskActions._refresh(Object.assign({ contactId: t.contactId, projectId: t.projectId }, opts));
  CRM.toastUndo(wasDone ? 'Aufgabe wieder geöffnet.' : 'Aufgabe erledigt. ✓');
};

/* ---------- Verschieben ---------- */
CRM.taskActions._addDays = function (days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

CRM.taskActions.postpone = function (taskId, spec, opts) {
  opts = opts || {};
  const t = CRM.db.getTask(taskId);
  if (!t) return;
  let newDue = null;
  if (spec === 'morgen') newDue = CRM.taskActions._addDays(1);
  else if (spec === 'woche') newDue = CRM.taskActions._addDays(7);
  else if (spec === 'datum') { CRM.taskActions.openPostponeDialog(taskId, opts); return; }
  else if (typeof spec === 'number') newDue = CRM.taskActions._addDays(spec);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(String(spec))) newDue = spec;
  if (!newDue) return;
  CRM.db.updateTask(taskId, { due: newDue });
  CRM.toast('Aufgabe verschoben auf ' + new Date(newDue + 'T12:00:00').toLocaleDateString('de-DE') + '.', 'success');
  CRM.taskActions._refresh(Object.assign({ contactId: t.contactId, projectId: t.projectId }, opts));
};

CRM.taskActions._state = null; // {taskId, opts, contactId} — für offene Dialoge (Postpone/Editor)

CRM.taskActions.openPostponeDialog = function (taskId, opts) {
  const t = CRM.db.getTask(taskId);
  if (!t) return;
  CRM.taskActions._state = { taskId: taskId, opts: opts || {} };
  CRM.openModal(`
    <h2>📆 Fälligkeit verschieben</h2>
    <p style="color:var(--text-dim);font-size:13px">„${esc(t.title)}"</p>
    <label>Neues Datum</label>
    <input type="date" id="tpp-date" value="${t.due || new Date().toISOString().slice(0, 10)}">
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.taskActions._savePostponeDialog()">Speichern</button>
    </div>
  `);
  setTimeout(() => { const d = document.getElementById('tpp-date'); if (d) d.focus(); }, 60);
};

CRM.taskActions._savePostponeDialog = function () {
  const st = CRM.taskActions._state;
  if (!st) return;
  const dateEl = document.getElementById('tpp-date');
  const newDue = dateEl ? dateEl.value : '';
  if (!newDue) { CRM.toast('Bitte ein Datum wählen.', 'error'); return; }
  const t = CRM.db.getTask(st.taskId);
  if (!t) { CRM.closeModal(); return; }
  CRM.db.updateTask(st.taskId, { due: newDue });
  CRM.closeModal();
  CRM.toast('Aufgabe verschoben auf ' + new Date(newDue + 'T12:00:00').toLocaleDateString('de-DE') + '.', 'success');
  CRM.taskActions._state = null;
  CRM.taskActions._refresh(Object.assign({ contactId: t.contactId, projectId: t.projectId }, st.opts));
};

/* ---------- Löschen (nie ohne Undo) ---------- */
CRM.taskActions.remove = function (taskId, opts) {
  opts = opts || {};
  const t = CRM.db.getTask(taskId);
  if (!t) return;
  CRM.takeSnapshot('Vor Löschen einer Aufgabe');
  const ctx = { contactId: t.contactId, projectId: t.projectId };
  CRM.db.deleteTask(taskId);
  CRM.taskActions._refresh(Object.assign(ctx, opts));
  CRM.toastUndo('Aufgabe gelöscht.');
};

/* ---------- Bearbeiten & Verknüpfen ----------
   Kontaktunabhängiger Editor: Titel, Fälligkeit, Erledigt-Schalter,
   Kontakt-Zuordnung (Suchfeld) und Projekt-Zuordnung (Dropdown). Löst
   Befund 3+4: kein "nur mit Kontakt geht das"-Zwang mehr, und ein Weg,
   eine Aufgabe umzuhängen. */
CRM.taskActions.openEditor = function (taskId, opts) {
  const t = CRM.db.getTask(taskId);
  if (!t) { CRM.toast('Aufgabe nicht gefunden.', 'error'); return; }
  CRM.taskActions._state = { taskId: taskId, opts: opts || {}, contactId: t.contactId || null };
  const projectOpts = CRM.db.getProjects()
    .map((p) => `<option value="${p.id}" ${p.id === (t.projectId || '') ? 'selected' : ''}>${((p.kategorie || 'baustelle') === 'gross' ? '🏢 ' : '🏠 ')}${esc(p.name)}</option>`).join('');
  CRM.openModal(`
    <h2>✓ Aufgabe bearbeiten</h2>
    <label>Titel</label>
    <input id="te-title" value="${escAttr(t.title || '')}">
    <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
      <div class="col" style="max-width:170px"><label>Fällig</label><input type="date" id="te-due" value="${escAttr(t.due || '')}"></div>
      <div class="col" style="display:flex;align-items:flex-end">
        <label style="display:flex;align-items:center;gap:6px;min-height:44px"><input type="checkbox" id="te-done" style="width:auto" ${t.done ? 'checked' : ''}> Erledigt</label>
      </div>
    </div>
    <label style="margin-top:8px">Kontakt</label>
    <div id="te-contact-chip">${CRM.taskActions._contactChipHtml(t.contactId)}</div>
    <div class="crm-win-search">
      <input type="text" id="te-contact-search" placeholder="Kontakt suchen (Firma, Ort, ERP)..." autocomplete="off">
      <div class="header-search-dropdown hidden" id="te-contact-results"></div>
    </div>
    <label style="margin-top:8px">Bauvorhaben / Projekt</label>
    <select id="te-project"><option value="">Kein Projekt</option>${projectOpts}</select>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.taskActions._cancelEditor()">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.taskActions._saveEditor()">💾 Speichern</button>
    </div>
  `, { dismissible: false });
  const search = document.getElementById('te-contact-search');
  const results = document.getElementById('te-contact-results');
  search.addEventListener('input', () => CRM.taskActions._editorContactSearch(search.value, results));
  search.addEventListener('focus', () => CRM.taskActions._editorContactSearch(search.value, results));
  setTimeout(() => { const el = document.getElementById('te-title'); if (el) { el.focus(); el.select(); } }, 60);
};

CRM.taskActions._contactChipHtml = function (contactId) {
  if (!contactId) return '<p style="color:var(--text-dim);font-size:13px;margin:2px 0">Kein Kontakt zugeordnet.</p>';
  const c = CRM.db.getContact(contactId);
  if (!c) return '<p style="color:var(--text-dim);font-size:13px;margin:2px 0">Kein Kontakt zugeordnet.</p>';
  return `<div class="badge" style="display:inline-flex;align-items:center;gap:6px;margin:2px 0">${esc(CRM.displayNameDisambig ? CRM.displayNameDisambig(c) : c.firma1)}
    <span style="cursor:pointer" title="Kontakt entfernen" onclick="CRM.taskActions._editorSetContact(null)">✕</span></div>`;
};

CRM.taskActions._editorContactSearch = function (q, resultsEl) {
  const query = (q || '').trim();
  if (!query) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; return; }
  const matches = CRM.db.getContacts().filter((c) => CRM.contactQueryMatch(query, c)).slice(0, 8);
  resultsEl.innerHTML = matches.length
    ? matches.map((c) => `<div class="header-search-item" data-id="${c.id}"><strong>${esc(CRM.displayNameDisambig ? CRM.displayNameDisambig(c) : c.firma1)}</strong>
        <span style="color:var(--text-dim);font-size:12px"> · ${esc(c.plz)} ${esc(c.ort)}</span></div>`).join('')
    : '<div class="header-search-empty">Keine Treffer</div>';
  resultsEl.querySelectorAll('.header-search-item').forEach((row) => {
    row.addEventListener('pointerdown', (e) => { e.preventDefault(); CRM.taskActions._editorSetContact(row.dataset.id); });
  });
  resultsEl.classList.remove('hidden');
};

CRM.taskActions._editorSetContact = function (contactId) {
  if (!CRM.taskActions._state) return;
  CRM.taskActions._state.contactId = contactId || null;
  const chip = document.getElementById('te-contact-chip');
  if (chip) chip.innerHTML = CRM.taskActions._contactChipHtml(contactId);
  const search = document.getElementById('te-contact-search');
  const results = document.getElementById('te-contact-results');
  if (search) search.value = '';
  if (results) { results.classList.add('hidden'); results.innerHTML = ''; }
};

CRM.taskActions._cancelEditor = function () {
  const st = CRM.taskActions._state;
  CRM.taskActions._state = null;
  CRM.closeModal();
  if (st) {
    const t = CRM.db.getTask(st.taskId);
    CRM.taskActions._refresh(Object.assign({ contactId: t ? t.contactId : null, projectId: t ? t.projectId : null }, st.opts));
  }
};

CRM.taskActions._saveEditor = function () {
  const st = CRM.taskActions._state;
  if (!st) return;
  const title = (document.getElementById('te-title') || {}).value.trim();
  if (!title) { CRM.toast('Bitte einen Titel eingeben.', 'error'); return; }
  const due = (document.getElementById('te-due') || {}).value || '';
  const done = !!(document.getElementById('te-done') || {}).checked;
  const projectId = (document.getElementById('te-project') || {}).value || null;
  const existing = CRM.db.getTask(st.taskId);
  const patch = {
    title: title,
    due: due,
    contactId: st.contactId || null,
    projectId: projectId || null,
    done: done,
    doneAt: done ? ((existing && existing.doneAt) || new Date().toISOString()) : null,
  };
  CRM.db.updateTask(st.taskId, patch);
  CRM.closeModal();
  CRM.toast('✓ Aufgabe gespeichert.', 'success');
  CRM.taskActions._state = null;
  CRM.taskActions._returnAfterEdit(st.opts, patch.contactId, patch.projectId);
};

/* ---------- Gemeinsames "⋯"-Overflow-Menü ----------
   Nutzt das bestehende CRM.toggleOvMenu (app.js, Batch 5b) — kein
   eigenes Menü-System. returnType/returnId beschreiben, wohin nach
   Bearbeiten zurückgekehrt werden soll ('dashboard' | 'agenda' |
   'contact'+id | 'project'+id). */
CRM.taskActions.menuHtml = function (taskId, returnType, returnId) {
  const ridArg = returnId ? `'${returnId}'` : 'null';
  const ctx = `CRM.taskActions.uiCtx('${returnType}',${ridArg})`;
  return `<div class="ov-menu">
    <button class="btn btn-sm" title="Weitere Aktionen" onclick="event.stopPropagation();CRM.toggleOvMenu(this,event)">⋯</button>
    <div class="ov-menu-list hidden">
      <button onclick="event.stopPropagation();CRM.taskActions.postpone('${taskId}','morgen',${ctx})">📅 Auf morgen verschieben</button>
      <button onclick="event.stopPropagation();CRM.taskActions.postpone('${taskId}','woche',${ctx})">📅 Auf nächste Woche</button>
      <button onclick="event.stopPropagation();CRM.taskActions.openPostponeDialog('${taskId}',${ctx})">📆 Datum wählen…</button>
      <button onclick="event.stopPropagation();CRM.taskActions.openEditor('${taskId}',${ctx})">✏️ Bearbeiten &amp; verknüpfen</button>
      <button onclick="event.stopPropagation();CRM.taskActions.remove('${taskId}',${ctx})" style="color:var(--red)">🗑 Löschen</button>
    </div>
  </div>`;
};
