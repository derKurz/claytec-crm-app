/* ============================================================
   Claytec CRM — "Heute"-Ansicht (vormals Agenda)
   Leitprinzip aus Cloze-Nutzerkritik (Perplexity-Recherche):
   Das System startet handlungsorientiert mit drei Fragen —
   WER ist wichtig? · WAS ist zuletzt passiert? · WAS ist als Nächstes fällig?
   Enthält: Aufgaben-Engine + fällige Besuche + eingebetteten Kalender.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM._agendaSelection = CRM._agendaSelection || new Set();
CRM._heuteView = CRM._heuteView || 'liste'; // 'liste' | 'kalender'
CRM._calMode = CRM._calMode || 'monat'; // 'tag' | 'woche' | 'monat'
CRM._calAnchor = CRM._calAnchor || (function () { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); })();

CRM.formatLastVisit = function (c) {
  const v = CRM.getLastVisit(c);
  return v ? v.date : 'noch nie';
};

/* Lokales Datum als YYYY-MM-DD (vermeidet UTC-Off-by-one im Kalender) */
CRM.ymd = function (d) {
  const x = new Date(d);
  return x.getFullYear() + '-' + String(x.getMonth() + 1).padStart(2, '0') + '-' + String(x.getDate()).padStart(2, '0');
};

CRM.renderAgenda = function () {
  const container = document.getElementById('view-agenda');
  const today = new Date().toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  container.innerHTML = `
    <div class="heute-head">
      <div>
        <h2 style="margin:0">Heute</h2>
        <div style="color:var(--text-dim);font-size:13px">${today} · Wer ist wichtig? · Was zuletzt? · Was als Nächstes?</div>
      </div>
      <div class="seg-toggle">
        <button class="seg ${CRM._heuteView === 'liste' ? 'active' : ''}" onclick="CRM.setHeuteView('liste')">Liste</button>
        <button class="seg ${CRM._heuteView === 'kalender' ? 'active' : ''}" onclick="CRM.setHeuteView('kalender')">Kalender</button>
      </div>
    </div>
    <div id="heute-body"></div>
  `;
  if (CRM._heuteView === 'liste') CRM.renderHeuteListe();
  else CRM.renderKalender();
};

CRM.setHeuteView = function (v) {
  CRM._heuteView = v;
  CRM.renderAgenda();
};

/* ============================================================
   LISTE: Aufgaben + fällige Besuche, nach Dringlichkeit
   ============================================================ */
CRM.renderHeuteListe = function () {
  const body = document.getElementById('heute-body');
  const visits = CRM.computeAgenda();
  const tasks = CRM.computeTaskBuckets();

  const quickAdd = `
    <div class="card">
      <div class="row" style="align-items:flex-end">
        <div class="col"><label>Schnelle Aufgabe</label><input id="heute-task-title" placeholder="z.B. Angebot Kraft Baustoffe nachfassen"></div>
        <div class="col" style="max-width:160px"><label>Fällig</label><input type="date" id="heute-task-due" value="${new Date().toISOString().slice(0, 10)}"></div>
        <button class="btn btn-primary" onclick="CRM.quickAddTask()">+ Aufgabe</button>
      </div>
    </div>`;

  const tourBar = `
    <div class="row" style="margin:4px 0 12px;align-items:center">
      <button class="btn btn-primary" onclick="CRM.startTourFromSelection()">🚗 Tour mit Auswahl starten</button>
      <span style="color:var(--text-dim);font-size:13px" id="agenda-selection-count"></span>
    </div>`;

  const section = (title, taskItems, visitItems) => {
    const taskRows = taskItems.map(({ t, st }) => CRM.taskRow(t, st)).join('');
    const visitRows = visitItems.map(({ c, due }) => CRM.visitRow(c, due)).join('');
    const count = taskItems.length + visitItems.length;
    if (!count) return `<div class="card"><h3 style="margin-top:0">${title} (0)</h3><p style="color:var(--text-dim);font-size:13px">Nichts offen.</p></div>`;
    return `<div class="card"><h3 style="margin-top:0">${title} (${count})</h3>${taskRows}${visitRows}</div>`;
  };

  body.innerHTML = `
    ${quickAdd}
    ${tourBar}
    ${section('Überfällig', tasks.overdue, visits.overdue)}
    ${section('Heute fällig', tasks.today, visits.today)}
    ${section('Diese Woche', tasks.week, visits.week)}
  `;

  body.querySelectorAll('.agenda-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) CRM._agendaSelection.add(id);
      else CRM._agendaSelection.delete(id);
      CRM.updateAgendaSelectionCount();
    });
  });
  const titleInput = document.getElementById('heute-task-title');
  if (titleInput) titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') CRM.quickAddTask(); });
  CRM.updateAgendaSelectionCount();
};

CRM.visitRow = function (c, due) {
  const label = due.diffDays < 0 ? `${-due.diffDays} Tage überfällig` : (due.diffDays === 0 ? 'heute fällig' : `in ${due.diffDays} Tagen`);
  const ort = [c.plz, c.ort].filter(Boolean).join(' ');
  // Dritte Zeile: der Betreff — was beim fälligen Besuch ansteht (offene
  // Aufgaben + nächster Schritt). Nur wenn vorhanden.
  const betreff = CRM.getOpenTodoText(c);
  return `
    <div class="list-item">
      <input type="checkbox" class="agenda-check" data-id="${c.id}" style="width:auto;margin-right:10px" ${CRM._agendaSelection.has(c.id) ? 'checked' : ''}>
      <div class="li-main" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">
        <div class="li-title">📍 ${esc(c.firma1)} ${c.isPartner ? '⭐' : ''}</div>
        <div class="li-sub">${esc(ort)} · Besuch ${label}</div>
        ${betreff ? `<div class="li-sub li-betreff">🎯 ${esc(betreff)}</div>` : ''}
        <div class="li-badges">
          <span class="badge badge-${c.type}">${CRM.TYPE_LABELS[c.type]}</span>
          <span class="badge badge-${c.abc}">${c.abc}</span>
        </div>
      </div>
      <div class="li-quick">${CRM.quickActionButtons(c)}</div>
      <button class="btn btn-sm" onclick="event.stopPropagation();CRM.quickVisitFromAgenda('${c.id}')">📍 Besuch heute</button>
    </div>`;
};

CRM.taskRow = function (t, st) {
  const c = t.contactId ? CRM.db.getContact(t.contactId) : null;
  const p = t.projectId ? CRM.db.getProject(t.projectId) : null;
  const parts = [];
  if (c) parts.push(`${esc(c.firma1)} · ${esc(c.plz)} ${esc(c.ort)}`);
  if (p) parts.push(`${(p.kategorie || 'baustelle') === 'gross' ? '🏢' : '🏠'} ${esc(p.name)}`);
  const sub = parts.join(' · ') || 'Allgemeine Aufgabe';
  const dueLabel = st.diffDays < 0 ? `${-st.diffDays} Tage überfällig` : (st.diffDays === 0 ? 'heute' : `in ${st.diffDays} Tagen`);
  return `
    <div class="list-item">
      <input type="checkbox" style="width:auto;margin-right:10px" onchange="CRM.toggleTaskDone('${t.id}')">
      <div class="li-main" ${c ? `onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer"` : (p ? `onclick="CRM.openProjectDetail('${p.id}')" style="cursor:pointer"` : '')}>
        <div class="li-title">✓ ${esc(t.title)}</div>
        <div class="li-sub">${sub} · ${dueLabel}</div>
      </div>
      ${c ? `<button class="btn btn-sm" onclick="event.stopPropagation();CRM.muster.open('${c.id}','${t.id}')" title="Muster/Musterbuch bestellen und Aufgabe erledigen">📦 Muster</button>` : ''}
      <button class="btn btn-sm li-cal" onclick="event.stopPropagation();CRM.exportTaskICS('${t.id}')" title="In Kalender">📅</button>
      <button class="btn btn-sm" onclick="event.stopPropagation();CRM.db.deleteTask('${t.id}');CRM.renderAgenda()" title="Löschen">🗑</button>
    </div>`;
};

/* Schnellaktionen: Klick-to-Call / Mail (mobiler Gewinn) */
CRM.quickActionButtons = function (c) {
  const tel = c.telFirma || (c.ansprechpartner && c.ansprechpartner.telefon);
  const mail = c.emailFirma || (c.ansprechpartner && c.ansprechpartner.email);
  let html = '';
  if (tel) html += `<a class="btn btn-sm" href="tel:${esc(tel)}" onclick="event.stopPropagation()" title="Anrufen">📞</a>`;
  if (mail) html += `<a class="btn btn-sm" href="mailto:${esc(mail)}" onclick="event.stopPropagation()" title="E-Mail">✉</a>`;
  html += `<button class="btn btn-sm" onclick="event.stopPropagation();CRM.showContactOnMap('${c.id}')" title="Auf Karte zeigen">📍 Karte</button>`;
  const addr = CRM.formatAddress(c);
  if (addr) html += `<a class="btn btn-sm" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}&travelmode=driving" target="_blank" rel="noopener" onclick="event.stopPropagation()" title="In Google Maps öffnen">🗺️ Maps</a>`;
  html += `<button class="btn btn-sm" onclick="event.stopPropagation();CRM.copyForOneNote('${c.id}')" title="Für OneNote kopieren (danach Strg+V in eine Seite einfügen)">📋 OneNote</button>`;
  const inRoute = CRM._contactSelection && CRM._contactSelection.has(c.id);
  html += `<button class="btn btn-sm ${inRoute ? 'btn-primary' : ''}" onclick="event.stopPropagation();CRM.toggleRouteSelection('${c.id}')" title="Zur Routenauswahl hinzufügen/entfernen">${inRoute ? '✓ In Route' : '➕ Zur Route'}</button>`;
  return html;
};

/* Kontakt unabhängig von der Listen-Checkbox zur bestehenden Routenauswahl
   hinzufügen/entfernen — nutzt dieselbe CRM._contactSelection wie die
   Kontaktliste/Karte, damit „Route in Google Maps" überall dieselbe
   Auswahl sieht. */
CRM.toggleRouteSelection = function (id) {
  CRM._contactSelection = CRM._contactSelection || new Set();
  if (CRM._contactSelection.has(id)) CRM._contactSelection.delete(id);
  else CRM._contactSelection.add(id);
  if (document.getElementById('active-modal-overlay') && CRM.renderContactDetailModal) CRM.renderContactDetailModal(id);
  if (document.querySelector('#view-kontakte.active') && CRM.renderContactList) CRM.renderContactList();
  if (document.querySelector('#view-agenda.active') && CRM.renderAgenda) CRM.renderAgenda();
};

CRM.updateAgendaSelectionCount = function () {
  const el = document.getElementById('agenda-selection-count');
  if (el) el.textContent = CRM._agendaSelection.size + ' für Tour ausgewählt';
};

/* ============================================================
   Aufgaben-Aktionen
   ============================================================ */
CRM.quickAddTask = function (contactId) {
  const titleEl = document.getElementById('heute-task-title');
  const dueEl = document.getElementById('heute-task-due');
  const title = titleEl ? titleEl.value.trim() : '';
  if (!title) {
    CRM.toast('Bitte einen Aufgabentitel eingeben.', 'error');
    return;
  }
  CRM.db.addTask({ title, due: dueEl ? dueEl.value : new Date().toISOString().slice(0, 10), contactId: contactId || null });
  CRM.toast('Aufgabe angelegt.', 'success');
  CRM.renderAgenda();
};

CRM.toggleTaskDone = function (id) {
  const t = CRM.db.getTask(id);
  if (!t) return;
  CRM.db.updateTask(id, { done: !t.done, doneAt: !t.done ? new Date().toISOString() : null });
  CRM.toast(t.done ? 'Aufgabe wieder geöffnet.' : 'Aufgabe erledigt. ✓', 'success');
  setTimeout(() => { if (CRM._heuteView === 'liste') CRM.renderAgenda(); }, 300);
};

CRM.exportTaskICS = function (id) {
  const t = CRM.db.getTask(id);
  if (!t) return;
  const c = t.contactId ? CRM.db.getContact(t.contactId) : null;
  CRM.exportICS(t.title, t.due, c ? 'Kontakt: ' + c.firma1 : '', c ? CRM.formatAddress(c) : '');
  CRM.toast('Termin als .ics exportiert.', 'success');
};

CRM.quickVisitFromAgenda = function (id) {
  CRM.addVisit(id, new Date().toISOString().slice(0, 10), '');
  CRM.toast('Besuch heute erfasst.', 'success');
  CRM.renderAgenda();
  CRM.renderContactList();
};

/* ============================================================
   KALENDER (Tag / Woche / Monat) — fällige Besuche + Aufgaben
   ============================================================ */
CRM.setCalMode = function (m) {
  CRM._calMode = m;
  CRM.renderKalender();
};
CRM.calShift = function (dir) {
  const d = new Date(CRM._calAnchor);
  if (CRM._calMode === 'tag') d.setDate(d.getDate() + dir);
  else if (CRM._calMode === 'woche') d.setDate(d.getDate() + dir * 7);
  else d.setMonth(d.getMonth() + dir);
  CRM._calAnchor = CRM.ymd(d);
  CRM.renderKalender();
};
CRM.calToday = function () {
  CRM._calAnchor = CRM.ymd(new Date());
  CRM.renderKalender();
};

/* Sammelt alle Termin-Ereignisse je Datum (YYYY-MM-DD -> [{type,label,id}]) */
CRM.collectCalendarEvents = function () {
  const map = {};
  const push = (date, ev) => { (map[date] = map[date] || []).push(ev); };
  CRM.db.getTasks().forEach((t) => {
    if (t.done || !t.due) return;
    const c = t.contactId ? CRM.db.getContact(t.contactId) : null;
    push(t.due, { type: 'task', label: '✓ ' + t.title, id: t.id, contactId: t.contactId, color: 'var(--accent)' });
  });
  CRM.db.getContacts().forEach((c) => {
    const due = CRM.getNextDueDate(c);
    const ds = CRM.ymd(due);
    push(ds, { type: 'visit', label: '📍 ' + c.firma1, id: c.id, contactId: c.id, color: CRM.TYPE_COLORS ? (CRM.TYPE_COLORS[c.type] || '#888') : '#888' });
  });
  return map;
};

CRM.renderKalender = function () {
  const body = document.getElementById('heute-body');
  const events = CRM.collectCalendarEvents();
  const anchor = new Date(CRM._calAnchor);
  const monthNames = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
  let titleLabel = '';
  let grid = '';

  if (CRM._calMode === 'monat') {
    titleLabel = monthNames[anchor.getMonth()] + ' ' + anchor.getFullYear();
    grid = CRM.calMonthGrid(anchor, events);
  } else if (CRM._calMode === 'woche') {
    const start = CRM.startOfWeek(anchor);
    const end = new Date(start); end.setDate(end.getDate() + 6);
    titleLabel = 'KW ' + CRM.isoWeek(start) + ' · ' + start.toLocaleDateString('de-DE', { day: 'numeric', month: 'short' }) + ' – ' + end.toLocaleDateString('de-DE', { day: 'numeric', month: 'short', year: 'numeric' });
    grid = CRM.calWeekGrid(start, events);
  } else {
    titleLabel = anchor.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) + ' (KW ' + CRM.isoWeek(anchor) + ')';
    grid = CRM.calDayList(CRM._calAnchor, events);
  }

  body.innerHTML = `
    <div class="card">
      <div class="cal-toolbar">
        <div class="seg-toggle">
          <button class="seg ${CRM._calMode === 'tag' ? 'active' : ''}" onclick="CRM.setCalMode('tag')">Tag</button>
          <button class="seg ${CRM._calMode === 'woche' ? 'active' : ''}" onclick="CRM.setCalMode('woche')">Woche</button>
          <button class="seg ${CRM._calMode === 'monat' ? 'active' : ''}" onclick="CRM.setCalMode('monat')">Monat</button>
        </div>
        <div class="cal-nav">
          <button class="btn btn-sm" onclick="CRM.calShift(-1)">‹</button>
          <button class="btn btn-sm" onclick="CRM.calToday()">Heute</button>
          <button class="btn btn-sm" onclick="CRM.calShift(1)">›</button>
        </div>
        <div style="font-weight:600">${titleLabel}</div>
      </div>
      ${grid}
    </div>`;
};

/* ISO-Kalenderwoche (DIN 1355: Woche mit dem ersten Donnerstag) */
CRM.isoWeek = function (d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() + 3 - ((x.getDay() + 6) % 7));
  const jan4 = new Date(x.getFullYear(), 0, 4);
  return 1 + Math.round(((x - jan4) / 86400000 - 3 + ((jan4.getDay() + 6) % 7)) / 7);
};

CRM.startOfWeek = function (d) {
  const x = new Date(d);
  const day = (x.getDay() + 6) % 7; // Montag = 0
  x.setDate(x.getDate() - day);
  x.setHours(0, 0, 0, 0);
  return x;
};

CRM.calDayCellEvents = function (dateStr, events) {
  const list = events[dateStr] || [];
  return list.map((e) => `<div class="cal-ev" style="border-left:3px solid ${e.color}" onclick="CRM.openContactDetail('${e.contactId}')" title="${esc(e.label)}">${esc(e.label)}</div>`).join('');
};

CRM.calMonthGrid = function (anchor, events) {
  const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
  const start = CRM.startOfWeek(first);
  const todayStr = CRM.ymd(new Date());
  const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let html = '<div class="cal-grid cal-month cal-kw-grid"><div class="cal-wd cal-kw-head">KW</div>' + wd.map((d) => `<div class="cal-wd">${d}</div>`).join('');
  const cur = new Date(start);
  for (let i = 0; i < 42; i++) {
    if (i % 7 === 0) html += `<div class="cal-kw-cell">${CRM.isoWeek(cur)}</div>`;
    const ds = CRM.ymd(cur);
    const inMonth = cur.getMonth() === anchor.getMonth();
    const isToday = ds === todayStr;
    html += `<div class="cal-cell ${inMonth ? '' : 'cal-out'} ${isToday ? 'cal-today' : ''}">
      <div class="cal-daynum">${cur.getDate()}</div>${CRM.calDayCellEvents(ds, events)}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  return html + '</div>';
};

CRM.calWeekGrid = function (start, events) {
  const todayStr = CRM.ymd(new Date());
  const wd = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
  let html = '<div class="cal-grid cal-month cal-kw-grid"><div class="cal-wd cal-kw-head">KW</div>' + wd.map((d) => `<div class="cal-wd">${d}</div>`).join('');
  html += `<div class="cal-kw-cell">${CRM.isoWeek(start)}</div>`;
  const cur = new Date(start);
  for (let i = 0; i < 7; i++) {
    const ds = CRM.ymd(cur);
    const isToday = ds === todayStr;
    html += `<div class="cal-cell cal-cell-week ${isToday ? 'cal-today' : ''}">
      <div class="cal-daynum">${cur.getDate()}.${cur.getMonth() + 1}.</div>${CRM.calDayCellEvents(ds, events)}</div>`;
    cur.setDate(cur.getDate() + 1);
  }
  return html + '</div>';
};

CRM.calDayList = function (dateStr, events) {
  const list = events[dateStr] || [];
  if (!list.length) return '<p style="color:var(--text-dim);font-size:13px;margin-top:12px">Keine fälligen Besuche oder Aufgaben an diesem Tag.</p>';
  return list.map((e) => `
    <div class="list-item" onclick="CRM.openContactDetail('${e.contactId}')" style="cursor:pointer">
      <div class="li-main"><div class="li-title">${esc(e.label)}</div>
      <div class="li-sub">${e.type === 'task' ? 'Aufgabe' : 'Besuch fällig'}</div></div>
    </div>`).join('');
};

/* ============================================================
   Tour-Export nach Google Maps (geteilt mit map.js)
   ============================================================ */
CRM.startTourFromSelection = function () {
  const ids = Array.from(CRM._agendaSelection);
  if (!ids.length) {
    CRM.toast('Bitte zuerst Kontakte über die Checkbox auswählen.', 'error');
    return;
  }
  let contacts = ids.map((id) => CRM.db.getContact(id)).filter((c) => c && c.strasse && c.plz);
  if (!contacts.length) {
    CRM.toast('Für die Auswahl fehlen Adressdaten (Straße/PLZ).', 'error');
    return;
  }
  contacts = CRM.optimizeRouteOrder(contacts);
  const legs = CRM.buildGoogleMapsLegs(contacts, 10);
  CRM.showRouteLegsModal(legs);
};

CRM.showRouteLegsModal = function (legs) {
  if (legs.length === 1) {
    window.open(legs[0].url, '_blank');
    return;
  }
  CRM.openModal(`
    <h2>Tour in ${legs.length} Etappen aufgeteilt</h2>
    <p style="color:var(--text-dim);font-size:13px">Google Maps erlaubt max. 10 Stopps pro Route — bei mehr Kontakten wird automatisch aufgeteilt. Reihenfolge wurde nach Nähe optimiert.</p>
    ${legs.map((l) => `<div class="list-item" style="cursor:default">
      <div class="li-main"><div class="li-title">${l.label}</div></div>
      <a class="btn btn-primary btn-sm" href="${l.url}" target="_blank" rel="noopener">Öffnen</a>
    </div>`).join('')}
    <div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>
  `);
};
