/* ============================================================
   Claytec CRM — App-Wiring (Schritt 1: Import, Liste, Backup)
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

/* ---------- PWA: Service Worker registrieren ---------- */
if ('serviceWorker' in navigator) {
  // Ohne diesen Listener übernimmt ein neuer Service Worker zwar im
  // Hintergrund (skipWaiting/clients.claim in sw.js), aber die bereits
  // offene Seite lief mit der ALTEN Version weiter — neue Tabs/Buttons
  // (z.B. "Netzwerk") erschienen erst nach einem zweiten Reload. Mit
  // diesem Reload bei Übernahme reicht künftig ein einziger Reload.
  let refreshingAfterSwUpdate = false;
  navigator.serviceWorker.addEventListener('controllerchange', function () {
    if (refreshingAfterSwUpdate) return;
    refreshingAfterSwUpdate = true;
    window.location.reload();
  });
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('./sw.js').then(function (reg) {
      reg.update(); // sofort auf neue Version prüfen, nicht auf Browser-Heuristik warten
    }).catch(function (err) {
      console.warn('Service Worker Registrierung fehlgeschlagen:', err);
    });
  });
}

/* ---------- Toasts ---------- */
CRM.toast = function (msg, type) {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => el.remove(), 3500);
};

/* ---------- Modal helper ---------- */
CRM.openModal = function (innerHTML, opts) {
  CRM.closeModal();
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'active-modal-overlay';
  overlay.innerHTML = `<div class="modal">${innerHTML}</div>`;
  // Schließen nur, wenn Maus-DRÜCKEN UND -LOSLASSEN beide auf dem Hintergrund
  // liegen. Ein Klick, der im Dialog beginnt (z.B. Text markieren) und außerhalb
  // endet, darf den Dialog NICHT schließen — sonst gehen Eingaben verloren.
  // opts.dismissible === false: Hintergrund schließt nie (nur Buttons im Dialog).
  const dismissible = !opts || opts.dismissible !== false;
  let downOnOverlay = false;
  overlay.addEventListener('mousedown', (e) => { downOnOverlay = e.target === overlay; });
  overlay.addEventListener('mouseup', (e) => {
    if (dismissible && downOnOverlay && e.target === overlay) CRM.closeModal();
    downOnOverlay = false;
  });
  document.body.appendChild(overlay);
  // Verlaufseintrag, damit die Zurück-Taste am Handy den Dialog schließt
  if (CRM.nav && CRM.nav.push) CRM.nav.push('modal');
  return overlay;
};
CRM.closeModal = function () {
  const existing = document.getElementById('active-modal-overlay');
  if (existing) existing.remove();
};

/* ---------- Progress overlay (Geocoding etc.) ---------- */
CRM.showProgress = function (label) {
  let overlay = document.getElementById('progress-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'progress-overlay';
    overlay.innerHTML = `
      <div id="progress-label" style="font-size:14px;color:#e6e9ef">${label}</div>
      <div class="progress-bar-outer"><div class="progress-bar-inner" id="progress-bar"></div></div>
    `;
    document.body.appendChild(overlay);
  } else {
    overlay.classList.remove('hidden');
    document.getElementById('progress-label').textContent = label;
  }
};
CRM.updateProgress = function (label, pct) {
  const overlay = document.getElementById('progress-overlay');
  if (!overlay) return;
  document.getElementById('progress-label').textContent = label;
  document.getElementById('progress-bar').style.width = Math.min(100, pct) + '%';
};
CRM.hideProgress = function () {
  const overlay = document.getElementById('progress-overlay');
  if (overlay) overlay.remove();
};

/* ============================================================
   Tabs
   ============================================================ */
CRM.switchTab = function (tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.bn-btn[data-tab]').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + tabId));
  if (tabId === 'start' && CRM.renderDashboard) CRM.renderDashboard();
  // FAB auf der Startseite ausblenden — die Dashboard-Schnellaktionen decken
  // dieselben Aktionen größer ab, und der FAB würde „Tour planen" überlappen.
  const fab = document.getElementById('fab-new');
  if (fab) fab.classList.toggle('fab-hidden', tabId === 'start');
  if (tabId === 'kontakte') CRM.renderContactList();
  if (tabId === 'projekte' && CRM.renderProjects) CRM.renderProjects();
  if (tabId === 'netzwerk' && CRM.renderNetzwerk) CRM.renderNetzwerk();
  if (tabId === 'agenda' && CRM.renderAgenda) CRM.renderAgenda();
  if (tabId === 'regionen' && CRM.renderRegionen) {
    // Bereits in Kontakte ausgewählte Kontakte mitnehmen: ihre Regionen
    // automatisch markieren, damit sie in der Liste vorausgewählt erscheinen
    // und weitere Kontakte einfach dazu ausgewählt werden können.
    if (CRM._contactSelection && CRM._contactSelection.size) {
      CRM._regionSelection = CRM._regionSelection || new Set();
      CRM.db.getContacts().forEach((c) => {
        if (CRM._contactSelection.has(c.id)) CRM._regionSelection.add(CRM.regionForPlz(c.plz));
      });
    }
    CRM.renderRegionen();
  }
  if (tabId === 'einstellungen' && CRM.renderSettings) CRM.renderSettings();
  if (tabId === 'karte' && CRM.map && CRM.map.onShow) CRM.map.onShow();
  // Letzten Tab merken: Wenn Android die PWA im Hintergrund beendet,
  // startet sie wieder dort, wo man war (Wiederherstellung beim App-Start).
  try { localStorage.setItem('crmLastTab', JSON.stringify({ tab: tabId, ts: Date.now() })); } catch (e) { /* voll/privat */ }
  // Tab-Wechsel im Verlauf vermerken (außer Startseite = Wurzel)
  if (tabId !== 'start' && CRM.nav && CRM.nav.push) CRM.nav.push('tab:' + tabId);
};

/* Nach einem Hintergrund-Kill der PWA den letzten Tab wiederherstellen —
   aber nur innerhalb von 4 Stunden; am nächsten Morgen startet die App
   bewusst frisch auf der Startseite. */
CRM.restoreLastTab = function () {
  try {
    const saved = JSON.parse(localStorage.getItem('crmLastTab') || 'null');
    if (!saved || saved.tab === 'start') return;
    if (Date.now() - (saved.ts || 0) > 4 * 60 * 60 * 1000) return;
    if (!document.getElementById('view-' + saved.tab)) return;
    CRM.switchTab(saved.tab);
  } catch (e) { /* defekter Eintrag — ignorieren */ }
};

/* ============================================================
   Kontaktliste (einfache Tabellenansicht für Schritt 1)
   ============================================================ */
CRM._quickFilters = CRM._quickFilters || { partner: false, overdue: false, week: false, aktiv: false, inaktiv: false, archiv: false, top25: false };

/* PLZ-Bereich parsen: "80-85", "80–85", "8000-8500" → {min, max} (auf Präfix-Länge normalisiert) */
CRM.parsePlzRange = function (raw) {
  if (!raw) return null;
  const m = raw.trim().match(/^(\d+)\s*[-–bis ]+\s*(\d+)$/i);
  if (m) return { from: m[1], to: m[2] };
  const single = raw.trim().match(/^\d+$/);
  if (single) return { prefix: raw.trim() };
  return null;
};

CRM.matchesPlzRange = function (plz, range) {
  if (!range || !plz) return !range;
  if (range.prefix) return String(plz).startsWith(range.prefix);
  // Vergleich auf Stellenzahl der Grenzen (z.B. "80"–"85" prüft die ersten 2 Stellen)
  const len = Math.max(range.from.length, range.to.length);
  const head = String(plz).slice(0, len).padEnd(len, '0');
  const num = parseInt(head, 10);
  return num >= parseInt(range.from.padEnd(len, '0'), 10) && num <= parseInt(range.to.padEnd(len, '9'), 10);
};

CRM.getContactFilters = function () {
  return {
    text: (document.getElementById('contact-search')?.value || '').trim().toLowerCase(),
    ort: (document.getElementById('filter-ort')?.value || '').trim().toLowerCase(),
    plz: CRM.parsePlzRange(document.getElementById('filter-plz')?.value || ''),
    type: document.getElementById('filter-type')?.value || '',
    source: document.getElementById('filter-source')?.value || '',
    abc: document.getElementById('filter-abc')?.value || '',
    qf: CRM._quickFilters,
  };
};

CRM.contactMatchesFilters = function (c, f) {
  // Archiv: standardmäßig ausgeblendet; nur im Archiv-Filter sichtbar
  if (f.qf.archiv) { if (!c.archived) return false; }
  else if (c.archived) return false;
  // Präziser Regionsfilter (mehrere, auch nicht benachbarte Gebiete) aus dem Regionen-Tab
  if (CRM._regionFilter && CRM._regionFilter.size) {
    if (!CRM._regionFilter.has(CRM.regionForPlz(c.plz))) return false;
  }
  if (f.text && !CRM.contactQueryMatch(f.text, c)) return false;
  if (f.ort && !String(c.ort || '').toLowerCase().includes(f.ort)) return false;
  if (f.plz && !CRM.matchesPlzRange(c.plz, f.plz)) return false;
  if (f.type && c.type !== f.type) return false;
  if (f.source && c.source !== f.source) return false;
  if (f.abc && c.abc !== f.abc) return false;
  if (f.qf.partner && !c.isPartner) return false;
  if (f.qf.top25 && !c.top25) return false;
  if (f.qf.aktiv && !c.aktiv) return false;
  if (f.qf.inaktiv && c.aktiv) return false;
  if (f.qf.eurobaustoff && c.source !== 'eurobaustoff') return false;
  if (f.qf.overdue || f.qf.week) {
    const st = CRM.getDueStatus(c).status;
    if (f.qf.overdue && f.qf.week) {
      if (st !== 'overdue' && st !== 'week' && st !== 'today') return false;
    } else if (f.qf.overdue && st !== 'overdue') return false;
    else if (f.qf.week && st !== 'week' && st !== 'today') return false;
  }
  return true;
};

/* Gemeinsame Tabellen-Darstellung für Kontaktlisten — genutzt von der
   Kontakte-Übersicht UND der Kontaktliste im Regionen-Tab, damit beide
   identisch aussehen. `opts.distanceHtml` hängt optional eine
   Entfernungs-Spalte an (nur im Regionen-Tab bei gesetztem Ausgangspunkt). */
CRM.contactTableHeaderHtml = function (showDistance, opts) {
  const o = opts || {};
  const sort = CRM._contactSort || {};
  const th = (field, label, extraClass) => {
    if (!o.sortable) return `<th class="${extraClass || ''}">${label}</th>`;
    const arrow = sort.field === field ? (sort.dir === 'desc' ? ' ▼' : ' ▲') : '';
    return `<th class="${extraClass || ''}" style="cursor:pointer" title="Sortieren" onclick="CRM.setContactSort('${field}')">${label}${arrow}</th>`;
  };
  return `<tr><th class="col-check"></th>${th('firma', 'Firma')}<th class="col-erp">ERP-Nr.</th>${th('typ', 'Typ', 'col-typ')}${th('plz', 'PLZ/Ort', 'col-ort')}<th class="col-region">Region</th>${th('abc', 'A/B/C', 'col-abc')}${th('todo', 'To Do', 'col-todo')}<th class="col-lastvisit">Letzter Besuch</th>${th('status', 'Status', 'col-status')}<th class="col-map"></th>${showDistance ? '<th class="col-dist">Entfernung</th>' : ''}</tr>`;
};

/* Sortierstatus für die Kontakttabelle (Firma/PLZ/Typ/To-Do/Status) — nur
   in der Kontakte-Übersicht aktiv; der Regionen-Tab hat eine eigene,
   bewusst andere Standardsortierung (Entfernung zum Ausgangspunkt/PLZ). */
CRM.setContactSort = function (field) {
  const cur = CRM._contactSort || {};
  CRM._contactSort = { field, dir: cur.field === field && cur.dir === 'asc' ? 'desc' : 'asc' };
  CRM.renderContactList();
};
CRM.sortContacts = function (list) {
  const s = CRM._contactSort;
  if (!s || !s.field) return list;
  const dir = s.dir === 'desc' ? -1 : 1;
  const statusRank = { overdue: 0, today: 1, week: 2, ok: 3 };
  const keyFns = {
    firma: (c) => (c.firma1 || '').toLowerCase(),
    plz: (c) => c.plz || '',
    typ: (c) => (CRM.TYPE_LABELS[c.type] || c.type || '').toLowerCase(),
    todo: (c) => (CRM.getOpenTodoText(c) ? 0 : 1),
    status: (c) => statusRank[CRM.getDueStatus(c).status] ?? 9,
  };
  const keyFn = keyFns[s.field];
  if (!keyFn) return list;
  return list.slice().sort((a, b) => {
    const ka = keyFn(a);
    const kb = keyFn(b);
    if (ka < kb) return -1 * dir;
    if (ka > kb) return 1 * dir;
    return 0;
  });
};

CRM.contactRowHtml = function (c, opts) {
  const o = opts || {};
  const checkboxClass = o.checkboxClass || 'contact-check';
  const selectionSet = o.selectionSet || new Set();
  const due = CRM.getDueStatus(c);
  const dueLabel = { overdue: 'Überfällig', today: 'Heute', week: 'Diese Woche', ok: 'OK' }[due.status];
  const checked = selectionSet.has(c.id) ? 'checked' : '';
  const todoText = CRM.getOpenTodoText(c);
  const todo = todoText ? `<span class="badge badge-todo" title="${esc(todoText)}">❗ ${esc(todoText)}</span>` : '';
  // due-overdue/due-ok steuert auf Mobile den farbigen linken Kartenrand
  const dueRowClass = due.status === 'overdue' ? 'due-overdue' : (due.status === 'ok' ? 'due-ok' : '');
  return `<tr class="${dueRowClass}" ${o.rowStyle ? `style="${o.rowStyle}"` : ''}>
      <td class="col-check"><input type="checkbox" class="${checkboxClass}" data-id="${c.id}" ${checked}></td>
      <td class="mc-title" data-label="" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">${esc(c.firma1)} ${c.top25 ? '🏆' : ''}${c.isPartner ? '⭐' : ''}${c.aktiv && !c.isPartner ? '<span title="aktiv (in OneNote-Notizen erwähnt)" style="color:var(--green)">●</span>' : ''}</td>
      <td class="col-erp" data-label="ERP-Nr." onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">${esc(c.erpNr || '')}</td>
      <td class="col-typ" data-label="Typ" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer"><span class="badge badge-${c.type}" title="${CRM.TYPE_LABELS[c.type]}">${CRM.TYPE_SHORT[c.type] || '–'}</span></td>
      <td class="col-ort" data-label="Ort" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">${esc(c.plz)} ${esc(c.ort)}</td>
      <td class="col-region" data-label="Region"><button class="btn-link" title="Region im Regionen-Tab öffnen" onclick="CRM.goToRegion('${CRM.regionForPlz(c.plz)}')">${esc(CRM.regionNameForPlz(c.plz))}</button></td>
      <td class="col-abc" data-label="A/B/C" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer"><span class="badge badge-${c.abc}">${c.abc}</span></td>
      <td class="col-todo" data-label="To Do" onclick="CRM.openContactDetail('${c.id}')" style="${todoText ? 'cursor:pointer' : ''}">${todo}</td>
      <td class="col-lastvisit" data-label="Letzter Besuch" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">${esc(CRM.formatLastVisit(c))}</td>
      <td class="col-status" data-label="Status" onclick="CRM.openContactDetail('${c.id}')" style="cursor:pointer">${due.status === 'overdue' ? `<span class="badge badge-overdue">${dueLabel}</span>` : dueLabel}</td>
      <td class="col-map" data-label=""><button class="btn btn-sm" title="Auf Karte zeigen" onclick="CRM.showContactOnMap('${c.id}')">📍</button></td>
      ${o.distanceHtml !== undefined ? `<td class="col-dist" data-label="Entfernung">${o.distanceHtml}</td>` : ''}
    </tr>`;
};

CRM.renderContactList = function () {
  const container = document.getElementById('contact-list-container');
  const contacts = CRM.db.getContacts();

  if (!contacts.length) {
    document.getElementById('contact-count').textContent = '0 Kontakte';
    container.innerHTML = '<p style="color:var(--text-dim)">Noch keine Kontakte. Importiere eine Excel-Datei oder lege einen Kontakt manuell an.</p>';
    return;
  }

  const f = CRM.getContactFilters();
  let filtered = contacts.filter((c) => CRM.contactMatchesFilters(c, f));
  if (f.text) {
    // Bei aktiver Suche: nach Treffer-Güte im Firmennamen sortieren (beste oben)
    const toks = CRM.searchNorm(f.text).split(' ').filter(Boolean);
    filtered.sort((a, b) => CRM.contactListSearchRank(toks, a) - CRM.contactListSearchRank(toks, b)
      || String(a.firma1 || '').localeCompare(String(b.firma1 || '')));
  } else {
    filtered = CRM.sortContacts(filtered);
  }
  document.getElementById('contact-count').textContent =
    filtered.length === contacts.length ? `${contacts.length} Kontakte` : `${filtered.length} von ${contacts.length} Kontakten`;

  let regionBanner = '';
  if (CRM._regionFilter && CRM._regionFilter.size) {
    const names = Array.from(CRM._regionFilter).map((rid) => { const r = (CRM.REGIONS || []).find((x) => x.id === rid); return r ? r.name : rid; });
    regionBanner = `<div class="card" style="padding:8px 12px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:8px">
        <span style="font-size:13px">📍 Gefiltert nach Region: <strong>${esc(names.join(', '))}</strong></span>
        <button class="btn btn-sm" onclick="CRM.clearRegionFilter()">Regionsfilter aufheben</button>
      </div>`;
  }

  if (!filtered.length) {
    container.innerHTML = regionBanner + '<p style="color:var(--text-dim)">Keine Kontakte entsprechen den Filtern.</p>';
    return;
  }

  CRM._contactSelection = CRM._contactSelection || new Set();
  const selCount = CRM._contactSelection.size;
  const toolbar = `<div class="row" id="contact-route-toolbar" style="gap:8px;margin-bottom:8px;${selCount ? '' : 'display:none'}">
      <span style="color:var(--text-dim);font-size:13px;align-self:center"><strong id="contact-sel-count">${selCount}</strong> ausgewählt</span>
      <button class="btn btn-sm" onclick="CRM.selectAllFiltered()">☑️ Alle auswählen</button>
      <button class="btn btn-sm" onclick="CRM.markSelectedAktiv()">⭐ Aktiv markieren</button>
      <button class="btn btn-sm" onclick="CRM.unmarkSelectedAktiv()">☆ Markierung weg</button>
      <button class="btn btn-sm btn-primary" onclick="CRM.archiveSelectedContacts()">🗄️ Archivieren</button>
      <button class="btn btn-sm" onclick="CRM.reactivateSelectedContacts()">↩️ Reaktivieren</button>
      <button class="btn btn-sm" onclick="CRM.routeSelectedGoogle()">🗺️ Route</button>
      <button class="btn btn-sm" onclick="CRM.routeSelectedOnMap()">📍 Karte</button>
      <button class="btn btn-sm btn-danger" onclick="CRM.deleteSelectedContacts()">🗑️ Löschen</button>
      <button class="btn btn-sm" onclick="CRM.clearContactSelection()">Leeren</button>
    </div>`;

  const showNotes = !!CRM._showNotes;
  let html = regionBanner + toolbar + `<table class="contact-table mobile-cards"><thead>${CRM.contactTableHeaderHtml(false, { sortable: true })}</thead><tbody>`;
  filtered.slice(0, 500).forEach((c) => {
    html += CRM.contactRowHtml(c, { checkboxClass: 'contact-check', selectionSet: CRM._contactSelection });
    if (showNotes) {
      html += `<tr class="note-row"><td></td><td colspan="10">
        <div class="note-inline">
          <textarea class="note-field" data-id="${c.id}" rows="2" placeholder="Notiz zu ${esc(c.firma1)}...">${esc(c.notiz || '')}</textarea>
          <input class="todo-field" data-id="${c.id}" value="${escAttr(c.nextStep || '')}" placeholder="To Do (erscheint in der Übersicht)">
        </div>
      </td></tr>`;
    }
  });
  html += '</tbody></table>';
  if (filtered.length > 500) html += `<p style="color:var(--text-dim)">... und ${filtered.length - 500} weitere (bitte filtern)</p>`;
  container.innerHTML = html;

  container.querySelectorAll('.contact-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) CRM._contactSelection.add(id);
      else CRM._contactSelection.delete(id);
      const tb = document.getElementById('contact-route-toolbar');
      const cnt = document.getElementById('contact-sel-count');
      if (cnt) cnt.textContent = CRM._contactSelection.size;
      if (tb) tb.style.display = CRM._contactSelection.size ? '' : 'none';
    });
  });

  container.querySelectorAll('.note-field').forEach((el) => {
    el.addEventListener('change', (e) => { CRM.db.updateContact(e.target.dataset.id, { notiz: e.target.value }); });
  });
  container.querySelectorAll('.todo-field').forEach((el) => {
    el.addEventListener('change', (e) => {
      CRM.db.updateContact(e.target.dataset.id, { nextStep: e.target.value });
      CRM.renderContactList(); // To-Do-Spalte aktualisieren
    });
  });

  CRM.initColumnResize();
};

/* Spaltenbreiten in der Kontakttabelle per Ziehen verstellen (nur Desktop).
   Breiten bleiben pro Spalte gespeichert. */
CRM._colWidthsKey = 'crm_contact_col_widths';
CRM.initColumnResize = function () {
  if (window.innerWidth <= 768) return; // Mobile = Kartenansicht
  const table = document.querySelector('#contact-list-container .contact-table');
  if (!table) return;
  const ths = table.querySelectorAll('thead th');
  const saved = CRM.storage.read(CRM._colWidthsKey, {}) || {};
  ths.forEach((th, i) => { if (saved[i]) th.style.width = saved[i] + 'px'; });
  ths.forEach((th, i) => {
    if (i === ths.length - 1) return; // letzte Spalte braucht keinen Griff
    const grip = document.createElement('div');
    grip.className = 'col-resizer';
    grip.title = 'Spaltenbreite ziehen';
    grip.addEventListener('click', (e) => { e.stopPropagation(); }); // nicht sortieren
    grip.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation();
      const startX = e.clientX;
      const startW = th.getBoundingClientRect().width;
      grip.classList.add('dragging');
      document.body.classList.add('resizing-col');
      const move = (ev) => { th.style.width = Math.max(36, startW + (ev.clientX - startX)) + 'px'; };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        grip.classList.remove('dragging');
        document.body.classList.remove('resizing-col');
        const widths = CRM.storage.read(CRM._colWidthsKey, {}) || {};
        widths[i] = Math.round(th.getBoundingClientRect().width);
        CRM.storage.write(CRM._colWidthsKey, widths);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
    th.appendChild(grip);
  });
};

CRM.toggleNotesColumn = function () {
  CRM._showNotes = !CRM._showNotes;
  const btn = document.getElementById('btn-toggle-notes');
  if (btn) { btn.classList.toggle('active', CRM._showNotes); btn.textContent = CRM._showNotes ? '📝 Notizen ausblenden' : '📝 Notizen anzeigen'; }
  CRM.renderContactList();
};

CRM.clearContactSelection = function () {
  CRM._contactSelection.clear();
  CRM.renderContactList();
};

/* Alle aktuell gefilterten Kontakte anhaken (für gebietsweises Bereinigen:
   erst alle wählen, dann die wenigen Behalter abwählen, dann löschen). */
CRM.selectAllFiltered = function () {
  CRM._contactSelection = CRM._contactSelection || new Set();
  const filtered = CRM.getFilteredContacts();
  if (!filtered.length) { CRM.toast('Keine Kontakte im aktuellen Filter.', 'error'); return; }
  filtered.forEach((c) => CRM._contactSelection.add(c.id));
  CRM.renderContactList();
  CRM.toast('☑️ ' + filtered.length + ' Kontakte ausgewählt — jetzt die Behalter abwählen, dann „Auswahl löschen".', 'success');
};

/* ============================================================
   Aktiv-Erkennung — OneNote-CSV einlesen und Kontakte markieren, deren
   Firmenname in den Notizen vorkommt (Abgleich komplett auf dem Gerät).
   Markierte (+ Partner + besuchte) gelten als „aktiv/behalten" und sind
   beim Bereinigen geschützt. Filter „nur unmarkierte" zeigt die Kandidaten.
   ============================================================ */
CRM.GENERIC_FIRMA_TOKENS = new Set(('bau gmbh gmbhco der die und mit fuer von handel baustoffe baustoff '
  + 'malerbetrieb malermeister maler zimmerei holzbau naturbaustoffe ohgc ohg gbr '
  + 'architekt architekten architekturbuero ingenieur ingenieure bautraeger stuck stuckateur putz farben '
  + 'firma herr frau').split(' '));
CRM._normText = function (s) {
  return (' ' + (s || '').toLowerCase() + ' ')
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .replace(/[^a-z0-9]+/g, ' ');
};
CRM._distinctiveTokens = function (firma) {
  const toks = CRM._normText(firma).split(' ')
    .filter((t) => t.length >= 5 && !CRM.GENERIC_FIRMA_TOKENS.has(t));
  toks.sort((a, b) => b.length - a.length);
  return toks.slice(0, 2);
};
CRM.openAktivImport = function () {
  const inp = document.getElementById('file-input-aktiv');
  if (inp) inp.click();
};
CRM.runAktivImport = function (file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const corpus = ' ' + CRM._normText(reader.result) + ' ';
      const contacts = CRM.db.getContacts();
      CRM.takeSnapshot('Vor Aktiv-Markierung');
      let marked = 0, byNote = 0;
      contacts.forEach((c) => {
        const toks = CRM._distinctiveTokens(c.firma1);
        const hit = toks.some((t) => corpus.indexOf(' ' + t + ' ') !== -1);
        if (hit) byNote++;
        c.aktiv = hit || !!c.isPartner || ((c.visits || []).length > 0);
        if (c.aktiv) marked++;
      });
      CRM.db.saveContacts();
      CRM.renderContactList();
      CRM.toastUndo('⭐ ' + marked + ' von ' + contacts.length + ' Kontakten als aktiv markiert (' + byNote + ' über Notizen). '
        + 'Nutze den Filter „Nur unmarkierte" (' + (contacts.length - marked) + ') zum Bereinigen.');
    } catch (e) {
      CRM.toast('Fehler beim Einlesen: ' + (e && e.message || e), 'error');
    }
  };
  reader.readAsText(file, 'utf-8');
};

/* Aktuell gefilterte Kontakte als CSV exportieren (Excel-lesbar, ;-getrennt,
   UTF-8 mit BOM -> korrekte Umlaute). Für „unmarkierte sichern vor dem
   Löschen, ggf. später wieder aufnehmen". */
CRM.exportFilteredCsv = function () {
  const rows = CRM.getFilteredContacts();
  if (!rows.length) { CRM.toast('Keine Kontakte im aktuellen Filter.', 'error'); return; }
  const cols = ['Firma', 'ERP-Nr', 'Typ', 'PLZ', 'Ort', 'Region', 'Telefon', 'Email', 'Letzter Besuch', 'Markiert (aktiv)'];
  const cell = (v) => {
    v = (v == null ? '' : String(v));
    return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  const lines = [cols.join(';')];
  rows.forEach((c) => {
    lines.push([
      c.firma1, c.erpNr || '', (CRM.TYPE_LABELS[c.type] || c.type || ''),
      c.plz || '', c.ort || '', CRM.regionNameForPlz(c.plz),
      c.telFirma || '', c.emailFirma || '', CRM.formatLastVisit(c),
      c.aktiv ? 'ja' : 'nein',
    ].map(cell).join(';'));
  });
  const csv = '﻿' + lines.join('\r\n'); // BOM = Excel zeigt Umlaute korrekt
  const stamp = new Date().toISOString().slice(0, 10);
  const name = 'claytec-kontakte-export-' + stamp + '.csv';
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const file = new File([blob], name, { type: 'text/csv' });
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    navigator.share({ files: [file], title: 'Claytec Kontakte-Export' }).catch(() => {});
  } else {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  CRM.toast('⬇️ ' + rows.length + ' Kontakte exportiert (' + name + ').', 'success');
};

CRM.clearRegionFilter = function () {
  CRM._regionFilter = new Set();
  CRM.renderContactList();
};

/* ============================================================
   Kontakte-Bereinigung — gefilterte Kontakte gesammelt löschen.
   Sicherheitsnetz: Partner/besuchte werden geschützt, vor dem Löschen
   wird automatisch ein Backup erstellt UND ein Undo-Snapshot gesetzt.
   ============================================================ */
CRM.getFilteredContacts = function () {
  const f = CRM.getContactFilters();
  return CRM.db.getContacts().filter((c) => CRM.contactMatchesFilters(c, f));
};
CRM._isProtectedContact = function (c) {
  return !!c.isPartner || !!c.aktiv || ((c.visits || []).length > 0);
};
CRM.openCleanupDialog = function () {
  const all = CRM.db.getContacts();
  if (!all.length) { CRM.toast('Keine Kontakte vorhanden.', 'error'); return; }
  const filtered = CRM.getFilteredContacts();
  const protectedArr = filtered.filter(CRM._isProtectedContact);
  const partnerN = filtered.filter((c) => c.isPartner).length;
  const visitedN = filtered.filter((c) => (c.visits || []).length > 0).length;
  CRM._cleanupState = { filtered, protectedArr };
  const noFilter = filtered.length === all.length;
  const toDelete = filtered.length - protectedArr.length;
  CRM.openModal(`
    <h2>🧹 Kontakte bereinigen</h2>
    <p>Dein aktueller Filter trifft <strong>${filtered.length}</strong> von ${all.length} Kontakten.</p>
    ${noFilter ? `<p style="background:rgba(255,92,92,.12);border:1px solid var(--red);border-radius:8px;padding:8px 10px;font-size:13px">⚠️ <strong>Kein Filter aktiv</strong> — das betrifft deine GESAMTE Liste. Setz oben zuerst einen Filter (Suche, Typ, Region, PLZ, Quelle), um gezielt zu kürzen.</p>` : ''}
    <label style="display:flex;align-items:center;gap:8px;margin:12px 0;font-size:14px;cursor:pointer">
      <input type="checkbox" id="cleanup-protect" checked>
      🛡️ Partner (${partnerN}) und besuchte (${visitedN}) Kontakte schützen
    </label>
    <p style="font-size:15px;margin:6px 0">➡️ Es werden <strong id="cleanup-todelete" style="color:var(--red)">${toDelete}</strong> Kontakte gelöscht.</p>
    <p style="color:var(--text-dim);font-size:12px">Vor dem Löschen wird automatisch ein <strong>Backup</strong> erstellt; danach kannst du per „↶ Rückgängig" sofort zurück. Große Bereinigungen am besten am <strong>Laptop</strong> machen, dann Backup aufs Handy einspielen.</p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-danger" id="cleanup-go" onclick="CRM.runCleanup()">🗑️ Backup + löschen</button>
    </div>
  `);
  const cb = document.getElementById('cleanup-protect');
  if (cb) cb.addEventListener('change', CRM._updateCleanupCount);
  CRM._updateCleanupCount();
};
CRM._updateCleanupCount = function () {
  const st = CRM._cleanupState; if (!st) return;
  const protect = !!(document.getElementById('cleanup-protect') || {}).checked;
  const n = protect ? (st.filtered.length - st.protectedArr.length) : st.filtered.length;
  const el = document.getElementById('cleanup-todelete');
  if (el) el.textContent = n;
  const go = document.getElementById('cleanup-go');
  if (go) go.disabled = n === 0;
};
/* Gemeinsamer, sicherer Lösch-Ablauf: Schutz anwenden → Backup → Undo-
   Snapshot → in einem Rutsch löschen → Oberfläche aktualisieren. */
CRM._performContactDeletion = async function (ids, opts) {
  opts = opts || {};
  const set = ids instanceof Set ? new Set(ids) : new Set(ids);
  let skipped = 0;
  if (opts.protect !== false) {
    CRM.db.getContacts().forEach((c) => {
      if (set.has(c.id) && CRM._isProtectedContact(c)) { set.delete(c.id); skipped++; }
    });
  }
  if (!set.size) {
    CRM.toast(skipped ? 'Nur Partner/besuchte ausgewählt — nichts gelöscht.' : 'Nichts zu löschen.', 'error');
    return;
  }
  const go = document.getElementById('cleanup-go');
  if (go) { go.disabled = true; go.textContent = 'Backup läuft…'; }
  try {
    await CRM.backup.exportJSON(); // Sicherung ZUERST — bei Fehler kein Löschen
  } catch (e) {
    CRM.toast('Backup fehlgeschlagen — Löschen abgebrochen. (' + (e && e.message || e) + ')', 'error');
    if (go) { go.disabled = false; go.textContent = '🗑️ Backup + löschen'; }
    return;
  }
  let undoOk = true;
  try { CRM.takeSnapshot('Vor Bereinigung (' + set.size + ' Kontakte)'); }
  catch (e) { undoOk = false; }
  const removed = CRM.db.deleteContacts(set);
  if (CRM._contactSelection) CRM._contactSelection.clear();
  CRM.closeModal();
  CRM.renderContactList();
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
  if (CRM.renderDashboard) CRM.renderDashboard();
  const extra = skipped ? ' (' + skipped + ' Partner/besuchte geschützt)' : '';
  if (undoOk) CRM.toastUndo('🧹 ' + removed + ' Kontakte gelöscht' + extra + '. Backup wurde gespeichert.');
  else CRM.toast('🧹 ' + removed + ' Kontakte gelöscht' + extra + '. Backup gespeichert (Undo hier nicht verfügbar).', 'success');
};
// Weg 1: kompletten gefilterten Satz löschen (Dialog).
CRM.runCleanup = async function () {
  const st = CRM._cleanupState; if (!st) return;
  const protect = !!(document.getElementById('cleanup-protect') || {}).checked;
  const victims = protect ? st.filtered.filter((c) => !CRM._isProtectedContact(c)) : st.filtered.slice();
  await CRM._performContactDeletion(victims.map((c) => c.id), { protect: false });
};
// Weg 2: einzeln angehakte Kontakte löschen (Auswahl-Leiste).
CRM.deleteSelectedContacts = async function () {
  const ids = Array.from(CRM._contactSelection || []);
  if (!ids.length) { CRM.toast('Keine Kontakte ausgewählt.', 'error'); return; }
  if (!confirm(ids.length + ' ausgewählte Kontakte löschen? (Partner/besuchte bleiben geschützt, vorher wird ein Backup erstellt.)')) return;
  await CRM._performContactDeletion(ids, { protect: true });
};

/* Archivieren = nicht löschen, nur aus Liste + Karte ausblenden (reversibel).
   Gute, sichere Alternative zum Löschen: alles bleibt erhalten. */
CRM._setArchivedForSelection = function (value) {
  const ids = new Set(CRM._contactSelection || []);
  if (!ids.size) { CRM.toast('Keine Kontakte ausgewählt.', 'error'); return; }
  let undoOk = true;
  try { CRM.takeSnapshot(value ? 'Vor Archivieren' : 'Vor Reaktivieren'); } catch (e) { undoOk = false; }
  let n = 0;
  CRM.db.getContacts().forEach((c) => { if (ids.has(c.id)) { c.archived = value; n++; } });
  CRM.db.saveContacts();
  CRM._contactSelection.clear();
  CRM.renderContactList();
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
  if (CRM.renderDashboard) CRM.renderDashboard();
  const msg = value ? ('🗄️ ' + n + ' Kontakte archiviert (aus Liste + Karte ausgeblendet).')
                    : ('↩️ ' + n + ' Kontakte reaktiviert.');
  if (undoOk) CRM.toastUndo(msg); else CRM.toast(msg, 'success');
};
CRM.archiveSelectedContacts = function () { CRM._setArchivedForSelection(true); };
CRM.reactivateSelectedContacts = function () { CRM._setArchivedForSelection(false); };

/* Aktiv-Markierung von Hand setzen/entfernen (für ausgewählte Kontakte). */
CRM._setAktivForSelection = function (value) {
  const ids = new Set(CRM._contactSelection || []);
  if (!ids.size) { CRM.toast('Keine Kontakte ausgewählt.', 'error'); return; }
  let n = 0;
  CRM.db.getContacts().forEach((c) => { if (ids.has(c.id)) { c.aktiv = value; n++; } });
  CRM.db.saveContacts();
  CRM._contactSelection.clear();
  CRM.renderContactList();
  CRM.toast(value ? ('⭐ ' + n + ' Kontakte als aktiv markiert.') : (n + ' Markierungen entfernt.'), 'success');
};
CRM.markSelectedAktiv = function () { CRM._setAktivForSelection(true); };
CRM.unmarkSelectedAktiv = function () { CRM._setAktivForSelection(false); };
/* Aktiv-Markierung eines einzelnen Kontakts umschalten (aus der Detailansicht). */
CRM.toggleContactAktiv = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  c.aktiv = !c.aktiv;
  CRM.db.saveContacts();
  CRM.renderContactList();
  if (CRM.openContactDetail) CRM.openContactDetail(id); // Detail neu zeichnen
  CRM.toast(c.aktiv ? '⭐ Als aktiv markiert.' : 'Markierung entfernt.', 'success');
};
/* Top-25-Kunde von Hand markieren (besondere Kontaktpflege). */
CRM.toggleContactTop25 = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  c.top25 = !c.top25;
  CRM.db.saveContacts();
  CRM.renderContactList();
  if (CRM.openContactDetail) CRM.openContactDetail(id);
  CRM.toast(c.top25 ? '🏆 Als Top-25-Kunde markiert.' : 'Top-25-Markierung entfernt.', 'success');
};

CRM._selectedContacts = function () {
  return Array.from(CRM._contactSelection).map((id) => CRM.db.getContact(id)).filter(Boolean);
};

CRM.routeSelectedGoogle = function () {
  const contacts = CRM._selectedContacts().filter((c) => c.strasse && c.plz);
  if (!contacts.length) { CRM.toast('Für die Auswahl fehlen Adressen (Straße/PLZ).', 'error'); return; }
  CRM.openRouteModal(contacts);
};

/* Routen-Fenster mit optionalem Start/Ziel „Zuhause" (aus den Einstellungen). */
CRM.openRouteModal = function (contacts) {
  CRM._routeContacts = CRM.optimizeRouteOrder(contacts);
  const s = CRM.db.getSettings();
  const home = (s.home && s.home.adresse) ? s.home.adresse : '';
  CRM._routeOpts = { startHome: !!s.routeStartHome && !!home, endHome: !!s.routeEndHome && !!home };
  CRM.openModal(`
    <h2>🗺️ Route planen</h2>
    <p style="color:var(--text-dim);font-size:13px">${CRM._routeContacts.length} Stopps, nach Nähe sortiert. Google Maps: max. 10 Stopps pro Route.</p>
    ${home ? `
    <div style="display:flex;gap:18px;flex-wrap:wrap;margin:10px 0">
      <label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer"><input type="checkbox" id="route-start-home" ${CRM._routeOpts.startHome ? 'checked' : ''}> 🏠 Start Zuhause</label>
      <label style="display:flex;align-items:center;gap:6px;font-size:14px;cursor:pointer"><input type="checkbox" id="route-end-home" ${CRM._routeOpts.endHome ? 'checked' : ''}> 🏠 Ziel Zuhause</label>
    </div>` : '<p style="font-size:12px;color:var(--text-dim)">Tipp: Wohnort in den Einstellungen hinterlegen → dann „Start/Ziel Zuhause".</p>'}
    <div id="route-legs"></div>
    <div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>
  `);
  const upd = () => {
    const cbS = document.getElementById('route-start-home');
    const cbE = document.getElementById('route-end-home');
    CRM._routeOpts.startHome = !!(cbS && cbS.checked);
    CRM._routeOpts.endHome = !!(cbE && cbE.checked);
    CRM.db.saveSettings({ routeStartHome: CRM._routeOpts.startHome, routeEndHome: CRM._routeOpts.endHome });
    CRM._renderRouteLegs();
  };
  ['route-start-home', 'route-end-home'].forEach((id) => { const el = document.getElementById(id); if (el) el.addEventListener('change', upd); });
  CRM._renderRouteLegs();
};
CRM._renderRouteLegs = function () {
  const box = document.getElementById('route-legs');
  if (!box) return;
  const s = CRM.db.getSettings();
  const home = (s.home && s.home.adresse) ? s.home.adresse : '';
  const legs = CRM.buildGoogleMapsLegs(CRM._routeContacts, 10, { homeAddr: home, startHome: CRM._routeOpts.startHome, endHome: CRM._routeOpts.endHome });
  box.innerHTML = legs.map((l) => `<div class="list-item" style="cursor:default">
      <div class="li-main"><div class="li-title">${l.label}</div></div>
      <a class="btn btn-primary btn-sm" href="${l.url}" target="_blank" rel="noopener">Öffnen</a>
    </div>`).join('');
};

CRM.routeSelectedOnMap = function () {
  const ids = Array.from(CRM._contactSelection);
  const withCoords = ids.map((id) => CRM.db.getContact(id)).filter((c) => c && c.lat != null && c.lng != null);
  if (!withCoords.length) { CRM.toast('Keine der ausgewählten Adressen ist geocodiert — bitte erst Karte/Geocoding laufen lassen.', 'error'); return; }
  CRM.map.selectedIds = new Set(withCoords.map((c) => c.id));
  CRM.map.updateTourCount();
  CRM.map.showWith(withCoords);
};

CRM.showContactOnMap = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  if (c.lat == null || c.lng == null) { CRM.toast('Dieser Kontakt ist noch nicht geocodiert (Karte öffnen → Geocoding).', 'error'); return; }
  CRM.map.showWith([c]);
  setTimeout(() => CRM.map.openSidePanel(id), 120);
};

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* Tastatur-Navigation in Treffer-Dropdowns: ↑/↓ markiert einen Treffer,
   Enter löst ihn aus. Gibt true zurück, wenn die Taste verarbeitet wurde
   (dann soll der Aufrufer nichts weiter tun). */
CRM.dropdownKeydown = function (e, containerId, itemSel) {
  const box = document.getElementById(containerId);
  if (!box || box.classList.contains('hidden')) return false;
  const items = Array.prototype.slice.call(box.querySelectorAll(itemSel));
  if (!items.length) return false;
  let idx = items.findIndex((i) => i.classList.contains('kbd-active'));
  if (e.key === 'ArrowDown') idx = (idx + 1) % items.length;
  else if (e.key === 'ArrowUp') idx = (idx - 1 + items.length) % items.length;
  else if (e.key === 'Enter') {
    const target = items[idx >= 0 ? idx : 0];
    if (target) {
      e.preventDefault();
      // Manche Dropdowns wählen per mousedown (Header/Mail), andere per
      // click (Karte) — beides auslösen, damit Enter überall greift.
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
      target.click();
      return true;
    }
    return false;
  } else return false;
  e.preventDefault();
  items.forEach((i) => i.classList.remove('kbd-active'));
  items[idx].classList.add('kbd-active');
  items[idx].scrollIntoView({ block: 'nearest' });
  return true;
};

CRM.openContactDetail = function (id) {
  if (CRM.renderContactDetailModal) return CRM.renderContactDetailModal(id);
  CRM.toast('Kontaktprofil folgt in Schritt 6', 'error');
};

/* ============================================================
   Excel-Import-Flow
   ============================================================ */
CRM.importFlow = {
  sheetsData: [], // [{name, rows, headerRowIdx, headers, dataRows}]
  currentSheetIdx: 0,
  mapping: {},
  defaults: { source: 'eigene', type: 'sonstige', isPartner: false, abc: 'C' },
};

/* Farbschema anwenden — Standard ist HELL (bessere Lesbarkeit),
   Dunkel bleibt in den Einstellungen wählbar. */
CRM.applyTheme = function () {
  const t = (CRM.db.getSettings().theme) || 'hell';
  document.body.classList.toggle('theme-hell', t === 'hell');
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = t === 'hell' ? '#f3f5f8' : '#11151c';
};

document.addEventListener('DOMContentLoaded', () => {
  CRM.db.init();
  CRM.applyTheme();
  CRM.nav.init();
  CRM.swipe.init();
  if (CRM.migrateToIndexedDB) CRM.migrateToIndexedDB();
  if (CRM.initSupabase) CRM.initSupabase();
  CRM.renderContactList();
  if (CRM.renderDashboard) CRM.renderDashboard();
  if (CRM.map && CRM.map.init) CRM.map.init();
  // Deep-Link (?erp= / ?kontakt=) hat Vorrang vor dem zuletzt offenen Tab
  if (!(CRM.openFromUrl && CRM.openFromUrl())) CRM.restoreLastTab();
  // Browser bitten, den Speicher als „dauerhaft" zu markieren — verhindert,
  // dass Android/Chrome die CRM-Daten bei Speicherdruck still löscht.
  if (navigator.storage && navigator.storage.persist) {
    navigator.storage.persist().catch(() => {});
  }

  // Sicherheitswarnung: läuft die App NICHT auf der echten Hosting-Adresse
  // (z.B. versehentlich auf localhost/Test-Server), einen unübersehbaren
  // roten Balken einblenden. Verhindert die localhost/github.io-Verwechslung.
  CRM.warnWrongOrigin();

  document.getElementById('btn-import-excel').addEventListener('click', () => {
    document.getElementById('file-input-excel').click();
  });
  document.getElementById('file-input-excel').addEventListener('change', (e) => {
    const files = Array.from(e.target.files || []);
    if (files.length) CRM.startImportFlow(files);
    e.target.value = '';
  });

  document.getElementById('btn-backup-export').addEventListener('click', () => {
    CRM.backup.exportJSON(); // zeigt eigene Meldung (Ordner ODER Download)
  });
  document.getElementById('btn-backup-import').addEventListener('click', () => {
    CRM._backupMergeDirect = false;
    document.getElementById('file-input-backup').click();
  });
  document.getElementById('file-input-backup').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (CRM._backupMergeDirect) { CRM._backupMergeDirect = false; CRM.confirmMerge(data); }
        else CRM.confirmRestoreBackup(data);
      } catch (err) {
        CRM.toast('Backup-Datei ungültig: ' + err.message, 'error');
      }
    };
    reader.readAsText(file);
    e.target.value = '';
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => CRM.switchTab(btn.dataset.tab));
  });

  CRM.initContactFilters();
  CRM.initHeaderSearch();
  CRM.initMobileNav();

  CRM.checkBackupReminder();

  // Eingang-Sync: beim Start automatisch prüfen, ob vom Handy etwas
  // im OneDrive-"Eingang"-Ordner liegt — nur wenn der Claytec-Ordner
  // schon verbunden ist (kein ungefragter Datei-Auswahl-Dialog).
  if (CRM.ablage && CRM.ablage.supported()) {
    Promise.all([
      CRM.ablage.idbGet('claytecRoot'),
      CRM.ablage.idbGet('claytecEingang'),
    ]).then(([root, eingang]) => {
      if (eingang) CRM.ablage.eingangHandle = eingang;
      // Läuft, sobald ENTWEDER der Claytec-Ordner ODER ein eigener
      // Eingang-Ordner verbunden ist.
      if (root || eingang) CRM.ablage.processEingang(true).catch(() => {});
    });
  }
});

/* ============================================================
   Sicherheitswarnung bei falscher Adresse (localhost/Test-Server)
   ============================================================ */
CRM.warnWrongOrigin = function () {
  var host = location.hostname;
  var OK = 'derkurz.github.io'; // die einzige echte Hosting-Adresse
  if (host === OK) return;      // richtige App → keine Warnung
  if (document.getElementById('wrong-origin-banner')) return;
  var bar = document.createElement('div');
  bar.id = 'wrong-origin-banner';
  bar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;'
    + 'background:#c0392b;color:#fff;padding:10px 14px;font-size:14px;'
    + 'line-height:1.4;text-align:center;box-shadow:0 2px 8px rgba(0,0,0,.35)';
  bar.innerHTML = '⚠️ <strong>Achtung: Test-Version (' + host + ')</strong> — '
    + 'das ist NICHT die echte App, deine Daten hier sind getrennt gespeichert. '
    + 'Bitte benutze: <a href="https://derkurz.github.io/claytec-crm-app/" '
    + 'style="color:#fff;text-decoration:underline;font-weight:700">'
    + 'derkurz.github.io/claytec-crm-app</a>';
  document.body.insertBefore(bar, document.body.firstChild);
  document.body.style.paddingTop = (bar.offsetHeight || 44) + 'px';
};

/* ============================================================
   Mobile-Navigation: Bottom Nav + "Mehr"-Sheet + FAB
   ============================================================ */
CRM.initMobileNav = function () {
  document.querySelectorAll('.bn-btn[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => CRM.switchTab(btn.dataset.tab));
  });

  const overlay = document.getElementById('more-sheet-overlay');
  const eingangBtn = document.getElementById('more-sheet-eingang');
  const openSheet = () => {
    const n = CRM.sync ? CRM.sync.pendingCount() : 0;
    eingangBtn.textContent = n ? `📤 Eingang exportieren (${n})` : '📤 Eingang exportieren';
    overlay.classList.remove('hidden');
  };
  const closeSheet = () => overlay.classList.add('hidden');

  document.getElementById('bn-more-btn').addEventListener('click', openSheet);
  document.getElementById('more-sheet-close').addEventListener('click', closeSheet);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeSheet(); });

  document.querySelectorAll('.more-sheet-item[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => { CRM.switchTab(btn.dataset.tab); closeSheet(); });
  });
  eingangBtn.addEventListener('click', () => {
    closeSheet();
    CRM.sync.exportEingang();
  });
  document.getElementById('more-sheet-lager').addEventListener('click', () => {
    closeSheet();
    CRM.lager.openDialog();
  });
  document.getElementById('more-sheet-hotels')?.addEventListener('click', () => {
    closeSheet();
    CRM.hotels.openDialog();
  });
  document.getElementById('more-sheet-import').addEventListener('click', () => {
    closeSheet();
    document.getElementById('file-input-excel').click();
  });
  document.getElementById('more-sheet-backup').addEventListener('click', () => {
    closeSheet();
    CRM.backup.exportJSON();
  });
  document.getElementById('more-sheet-merge').addEventListener('click', () => {
    closeSheet();
    CRM._backupMergeDirect = true; // direkt mischen, kein Ersetzen anbieten
    document.getElementById('file-input-backup').click();
  });
  document.getElementById('more-sheet-restore').addEventListener('click', () => {
    closeSheet();
    CRM._backupMergeDirect = false;
    document.getElementById('file-input-backup').click();
  });

  document.getElementById('fab-new').addEventListener('click', CRM.openQuickActionSheet);
};

CRM.openQuickActionSheet = function () {
  CRM.openModal(`
    <h2 style="margin-top:0">Schnellaktion</h2>
    <div class="row" style="flex-direction:column;gap:10px">
      <button class="btn btn-primary" style="justify-content:center;padding:14px" onclick="CRM.closeModal();CRM.createNewContact()">+ Neuer Kontakt</button>
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.closeModal();CRM.mailAblage.open()">📧 E-Mail ablegen</button>
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.closeModal();CRM.switchTab('kontakte');setTimeout(() => document.getElementById('header-search')?.focus(), 150)">🔍 Kontakt suchen (für Besuch)</button>
    </div>
  `);
};

/* ============================================================
   Header-Suche (auf jeder Seite erreichbar, neben dem Logo) —
   springt direkt auf die Karte und öffnet das Profil des Treffers.
   ============================================================ */
CRM.initHeaderSearch = function () {
  const input = document.getElementById('header-search');
  const results = document.getElementById('header-search-results');
  if (!input || !results) return;

  const norm = (s) => String(s || '').toLowerCase();

  // Universelle Aktionen/Reiter — anspringbar per Stichwort.
  const COMMANDS = [
    { icon: '🗺️', label: 'Karte öffnen', keys: ['karte', 'map'], run: () => CRM.switchTab('karte') },
    { icon: '📅', label: 'Heute / Agenda / To-Dos', keys: ['heute', 'agenda', 'aufgaben', 'aufgabe', 'todo', 'to do', 'wiedervorlage'], run: () => CRM.switchTab('agenda') },
    { icon: '👥', label: 'Kontakte', keys: ['kontakte', 'kontakt'], run: () => CRM.switchTab('kontakte') },
    { icon: '📍', label: 'Regionen', keys: ['regionen', 'region', 'gebiet'], run: () => CRM.switchTab('regionen') },
    { icon: '🕸️', label: 'Netzwerk', keys: ['netzwerk', 'beziehung'], run: () => CRM.switchTab('netzwerk') },
    { icon: '📋', label: 'Projekte', keys: ['projekte', 'projekt', 'baustelle', 'bv'], run: () => CRM.switchTab('projekte') },
    { icon: '📦', label: 'Muster-Lager', keys: ['muster', 'lager', 'inventur'], run: () => { if (CRM.lager && CRM.lager.openDialog) CRM.lager.openDialog(); else CRM.switchTab('start'); } },
    { icon: '🏨', label: 'Hotels / Übernachtungen', keys: ['hotel', 'hotels', 'uebernachtung', 'übernachtung', 'gasthof'], run: () => { if (CRM.hotels && CRM.hotels.openDialog) CRM.hotels.openDialog(); } },
    { icon: '💾', label: 'Backup erstellen', keys: ['backup', 'sicherung', 'sichern'], run: () => CRM.backup && CRM.backup.exportJSON() },
    { icon: '📥', label: 'Handy-Eingang verarbeiten', keys: ['eingang', 'sync', 'synchronisieren'], run: () => CRM.ablage && CRM.ablage.processEingang(false) },
    { icon: '➕', label: 'Neuer Kontakt', keys: ['neuer kontakt', 'kontakt anlegen', 'neu'], run: () => CRM.createNewContact && CRM.createNewContact() },
    { icon: '⚙️', label: 'Einstellungen', keys: ['einstellungen', 'settings', 'optionen'], run: () => CRM.switchTab('einstellungen') },
  ];

  const cat = (label) => `<div class="header-search-cat">${label}</div>`;

  const render = () => {
    const q = norm(input.value).trim();
    if (!q) { results.classList.add('hidden'); results.innerHTML = ''; return; }
    const contacts = CRM.db.getContacts();

    // 1) Aktionen (Stichwort trifft Reiter/Funktion)
    const cmds = q.length >= 2
      ? COMMANDS.map((c, i) => ({ c, i }))
        .filter(({ c }) => c.keys.some((k) => k.startsWith(q) || q.startsWith(k)) || c.label.toLowerCase().includes(q))
        .slice(0, 4)
      : [];

    // 2) Orte (Stadt) und 3) PLZ
    const orte = q.length >= 2
      ? [...new Set(contacts.filter((c) => !c.archived && c.ort && norm(c.ort).includes(q)).map((c) => c.ort))].slice(0, 5)
      : [];
    const plz = /^\d{2,5}$/.test(q) ? q : null;

    // 4) Kontakte (Firma/Person/ERP) nach Relevanz
    const qn = CRM.searchNorm(q);
    const matches = contacts
      .filter((c) => CRM.contactQueryMatch(q, c))
      .sort((a, b) => CRM.contactSearchRank(qn, a) - CRM.contactSearchRank(qn, b)
        || String(a.firma1 || '').localeCompare(String(b.firma1 || '')))
      .slice(0, 10);

    // 5) To-Dos (offene nächste Schritte, die zum Text passen)
    const todos = q.length >= 2
      ? contacts.map((c) => ({ c, t: CRM.getOpenTodoText(c) })).filter((x) => x.t && norm(x.t).includes(q)).slice(0, 5)
      : [];

    // 6) Projekte
    const projMatches = CRM.db.getProjects().filter((p) => CRM.smartMatch(q, [p.name, p.erpNr, p.ort])).slice(0, 4);

    let html = '';
    if (cmds.length) html += cat('Aktionen') + cmds.map(({ c, i }) => `
      <div class="header-search-item" data-action="${i}"><span style="margin-right:6px">${c.icon}</span><strong>${esc(c.label)}</strong></div>`).join('');
    if (plz) html += cat('PLZ') + `
      <div class="header-search-item" data-plz="${esc(plz)}"><span style="margin-right:6px">📮</span>Kontakte mit PLZ <strong>${esc(plz)}</strong> anzeigen</div>`;
    if (orte.length) html += cat('Orte') + orte.map((o) => `
      <div class="header-search-item" data-ort="${esc(o)}"><span style="margin-right:6px">📍</span><strong>${esc(o)}</strong> <span style="color:var(--text-dim);font-size:12px">· Kontakte hier</span></div>`).join('');
    if (matches.length) html += cat('Kontakte') + matches.map((c) => `
      <div class="header-search-item" data-id="${c.id}">
        <span class="badge badge-${c.type}" style="margin-right:6px">${CRM.TYPE_SHORT[c.type] || '–'}</span>
        <strong>${esc(c.firma1)}</strong> ${c.isPartner ? '⭐' : ''}${c.aktiv && !c.isPartner ? '<span style="color:var(--green)">●</span>' : ''}
        <span style="color:var(--text-dim);font-size:12px"> · ${esc(c.plz)} ${esc(c.ort)}</span>
      </div>`).join('');
    if (todos.length) html += cat('To-Dos') + todos.map((x) => `
      <div class="header-search-item" data-id="${x.c.id}"><span style="margin-right:6px">❗</span>${esc(x.t)} <span style="color:var(--text-dim);font-size:12px">· ${esc(x.c.firma1)}</span></div>`).join('');
    if (projMatches.length) html += cat('Projekte') + projMatches.map((p) => `
      <div class="header-search-item" data-project-id="${p.id}"><span class="badge badge-status-${p.status}" style="margin-right:6px">📋</span><strong>${esc(p.name)}</strong><span style="color:var(--text-dim);font-size:12px"> · Projekt${p.ort ? ' · ' + esc(p.ort) : ''}</span></div>`).join('');

    results.innerHTML = html || '<div class="header-search-empty">Keine Treffer</div>';
    results.querySelectorAll('.header-search-item').forEach((row) => {
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
        const d = row.dataset;
        if (d.action != null) {
          input.value = ''; results.classList.add('hidden');
          const cmd = COMMANDS[+d.action]; if (cmd) cmd.run();
        } else if (d.plz != null) {
          input.value = ''; results.classList.add('hidden'); CRM.jumpToContactsFilter({ plz: d.plz });
        } else if (d.ort != null) {
          input.value = ''; results.classList.add('hidden'); CRM.jumpToContactsFilter({ ort: d.ort });
        } else if (d.projectId) {
          input.value = ''; results.classList.add('hidden'); CRM.openProjectDetail(d.projectId);
        } else if (d.id) {
          CRM.goToContactFromSearch(d.id);
        }
      });
    });
    results.classList.remove('hidden');
  };

  input.addEventListener('input', render);
  input.addEventListener('focus', render);
  input.addEventListener('keydown', (e) => {
    if (CRM.dropdownKeydown(e, 'header-search-results', '.header-search-item')) return;
    if (e.key === 'Escape') { input.value = ''; results.classList.add('hidden'); input.blur(); }
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#header-search-wrap')) results.classList.add('hidden');
  });
};

CRM.goToContactFromSearch = function (id) {
  const input = document.getElementById('header-search');
  const results = document.getElementById('header-search-results');
  if (input) input.value = '';
  if (results) { results.classList.add('hidden'); results.innerHTML = ''; }
  const c = CRM.db.getContact(id);
  if (!c) return;
  if (c.lat != null && c.lng != null) {
    CRM.showContactOnMap(id);
  } else {
    CRM.openContactDetail(id);
  }
};

/* Aus der Schnellsuche in die Kontaktliste springen, gefiltert nach Ort/PLZ. */
CRM.jumpToContactsFilter = function (opts) {
  opts = opts || {};
  CRM.switchTab('kontakte');
  const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };
  if (opts.ort != null) { setVal('filter-ort', opts.ort); setVal('filter-plz', ''); }
  if (opts.plz != null) { setVal('filter-plz', opts.plz); setVal('filter-ort', ''); }
  // „Mehr Filter" auf Mobile aufklappen, damit der aktive Filter sichtbar ist
  const extra = document.getElementById('filter-bar-extra');
  const tgl = document.getElementById('btn-toggle-extra-filters');
  if (extra && tgl && !extra.classList.contains('open')) { extra.classList.add('open'); tgl.textContent = '▴ Filter ausblenden'; }
  CRM.renderContactList();
};

/* Sichtbare Dropdown-Filter für Ort + PLZ-Bereich: ▾-Pfeil öffnet die volle
   Liste (aus den eigenen Kontakten), Tippen filtert sie, Klick wählt aus.
   Optionen werden bei jedem Öffnen frisch berechnet — immer aktuell. */
CRM._comboOptions = {
  'filter-ort': () => {
    const counts = {};
    CRM.db.getContacts().forEach((c) => { const o = String(c.ort || '').trim(); if (o) counts[o] = (counts[o] || 0) + 1; });
    return Object.keys(counts).sort((a, b) => a.localeCompare(b, 'de'))
      .map((o) => ({ value: o, label: o, sub: counts[o] + (counts[o] === 1 ? ' Kontakt' : ' Kontakte') }));
  },
  'filter-plz': () => {
    const plzs = {};
    CRM.db.getContacts().forEach((c) => { const p = String(c.plz || '').trim(); if (p) plzs[p] = c.ort || ''; });
    const keys = Object.keys(plzs).sort();
    const bereiche = {};
    keys.forEach((p) => { const b = p.slice(0, 2); bereiche[b] = (bereiche[b] || 0) + 1; });
    return Object.keys(bereiche).sort().map((b) => ({ value: b, label: b + 'xxx', sub: 'Bereich · ' + bereiche[b] + (bereiche[b] === 1 ? ' Kontakt' : ' Kontakte') }))
      .concat(keys.map((p) => ({ value: p, label: p, sub: plzs[p] })));
  },
};

CRM.initFilterCombos = function () {
  ['filter-ort', 'filter-plz'].forEach((id) => {
    const input = document.getElementById(id);
    const list = document.getElementById('combo-' + id);
    if (!input || !list || input._comboWired) return;
    input._comboWired = true;

    const render = () => {
      const q = input.value.trim().toLowerCase();
      const opts = CRM._comboOptions[id]().filter((o) =>
        !q || o.value.toLowerCase().indexOf(q) === 0 || o.label.toLowerCase().indexOf(q) !== -1);
      list.innerHTML = opts.length
        ? opts.slice(0, 60).map((o) => `
          <div class="header-search-item combo-item" data-value="${escAttr(o.value)}">
            <strong>${esc(o.label)}</strong>${o.sub ? `<span style="color:var(--text-dim);font-size:12px"> · ${esc(o.sub)}</span>` : ''}
          </div>`).join('')
        : '<div class="header-search-empty">Keine Treffer</div>';
      list.querySelectorAll('.combo-item').forEach((row) => {
        row.addEventListener('mousedown', (e) => {
          e.preventDefault();
          input.value = row.dataset.value;
          list.classList.add('hidden');
          CRM.renderContactList();
        });
      });
      list.classList.remove('hidden');
    };

    input.addEventListener('focus', render);
    input.addEventListener('input', render);
    input.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === 'Enter') list.classList.add('hidden'); });
    const arrow = document.querySelector(`.combo-arrow[data-combo="${id}"]`);
    if (arrow) arrow.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (list.classList.contains('hidden')) { input.focus(); render(); }
      else list.classList.add('hidden');
    });
  });
  if (!CRM._comboOutsideWired) {
    CRM._comboOutsideWired = true;
    document.addEventListener('mousedown', (e) => {
      if (e.target.closest('.combo-wrap')) return;
      document.querySelectorAll('.combo-list').forEach((l) => l.classList.add('hidden'));
    });
  }
};

/* ---------- Filterleiste verdrahten (Schritt 5) ---------- */
CRM.initContactFilters = function () {
  CRM.initFilterCombos();
  // Selects befüllen
  const typeSel = document.getElementById('filter-type');
  if (typeSel && typeSel.options.length <= 1) {
    CRM.TYPES.forEach((t) => typeSel.add(new Option(CRM.TYPE_LABELS[t], t)));
  }
  const srcSel = document.getElementById('filter-source');
  if (srcSel && srcSel.options.length <= 1) {
    CRM.SOURCES.forEach((s) => srcSel.add(new Option(CRM.SOURCE_LABELS[s], s)));
  }
  // Entprellt: bei 500+ Kontakten würde sonst jeder Tastendruck die ganze
  // Tabelle neu aufbauen — spürbares Ruckeln auf dem Handy (Review-Punkt 3).
  let filterDebounce = null;
  ['contact-search', 'filter-ort', 'filter-plz'].forEach((id) => {
    document.getElementById(id)?.addEventListener('input', () => {
      clearTimeout(filterDebounce);
      filterDebounce = setTimeout(() => CRM.renderContactList(), 200);
    });
  });
  ['filter-type', 'filter-source', 'filter-abc'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => CRM.renderContactList());
  });
  document.querySelectorAll('#contact-quick-filters .qf-btn[data-qf]').forEach((btn) => {
    btn.addEventListener('click', () => CRM.toggleQuickFilter(btn.dataset.qf));
  });
  document.querySelectorAll('.typ-chip').forEach((btn) => {
    btn.addEventListener('click', () => CRM.setTypeChipFilter(btn.dataset.typ));
  });
  document.getElementById('btn-new-contact')?.addEventListener('click', () => CRM.createNewContact());
  document.getElementById('btn-toggle-extra-filters')?.addEventListener('click', () => CRM.toggleExtraFilters());
  document.getElementById('file-input-aktiv')?.addEventListener('change', (e) => {
    const f = e.target.files[0];
    if (f) CRM.runAktivImport(f);
    e.target.value = '';
  });
};

/* Mobile: Ort/PLZ/Listenquelle/A-B-C standardmäßig eingeklappt (belegten sonst
   die halbe Seite) — Suche und Typ-Chips bleiben immer sichtbar. */
CRM.toggleExtraFilters = function () {
  const el = document.getElementById('filter-bar-extra');
  const btn = document.getElementById('btn-toggle-extra-filters');
  if (!el || !btn) return;
  const open = el.classList.toggle('open');
  btn.textContent = open ? '▴ Filter ausblenden' : '▾ Mehr Filter';
};

/* Mobile Typ-Chips (Alle/HA/BU/AR/SO) — setzen denselben #filter-type wie
   das Desktop-Dropdown, damit die Filterlogik (CRM.getContactFilters)
   für beide Layouts identisch bleibt. */
CRM.setTypeChipFilter = function (typ) {
  const sel = document.getElementById('filter-type');
  if (sel) sel.value = typ;
  document.querySelectorAll('.typ-chip').forEach((b) => b.classList.toggle('active', b.dataset.typ === typ));
  CRM.renderContactList();
};

CRM.toggleQuickFilter = function (qf) {
  if (qf === 'reset') {
    CRM._quickFilters = { partner: false, overdue: false, week: false, eurobaustoff: false, aktiv: false, inaktiv: false, archiv: false, top25: false };
    CRM._regionFilter = new Set();
    ['contact-search', 'filter-ort', 'filter-plz'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    ['filter-type', 'filter-source', 'filter-abc'].forEach((id) => { const el = document.getElementById(id); if (el) el.value = ''; });
    document.querySelectorAll('.typ-chip').forEach((b) => b.classList.toggle('active', b.dataset.typ === ''));
  } else {
    CRM._quickFilters[qf] = !CRM._quickFilters[qf];
    // „markiert" und „unmarkiert" schließen sich gegenseitig aus
    if (qf === 'aktiv' && CRM._quickFilters.aktiv) CRM._quickFilters.inaktiv = false;
    if (qf === 'inaktiv' && CRM._quickFilters.inaktiv) CRM._quickFilters.aktiv = false;
  }
  document.querySelectorAll('#contact-quick-filters .qf-btn[data-qf]').forEach((b) => {
    if (b.dataset.qf !== 'reset') b.classList.toggle('active', !!CRM._quickFilters[b.dataset.qf]);
  });
  CRM.renderContactList();
};

CRM.createNewContact = function () {
  CRM.emailParser.openDialog();
};

/* ---------- Schritt 1a: Datei(en) einlesen ---------- */
CRM.startImportFlow = async function (files) {
  CRM.importFlow.allSheets = [];
  for (const file of files) {
    const buf = await file.arrayBuffer();
    let sheets;
    try {
      sheets = CRM.importer.parseWorkbook(buf);
    } catch (e) {
      CRM.toast(`Fehler beim Lesen von ${file.name}: ${e.message}`, 'error');
      continue;
    }
    sheets.forEach((s) => {
      const headerIdx = CRM.importer.findHeaderRowIndex(s.rows);
      CRM.importFlow.allSheets.push({
        fileName: file.name,
        sheetName: s.name,
        headerRow: s.rows[headerIdx],
        dataRows: s.rows.slice(headerIdx + 1).filter((r) => r.some((c) => String(c).trim() !== '')),
      });
    });
  }
  if (!CRM.importFlow.allSheets.length) {
    CRM.toast('Keine verwertbaren Tabellenblätter gefunden.', 'error');
    return;
  }
  CRM.importFlow.sheetIdx = 0;
  CRM.showMappingDialogForSheet(0);
};

/* ---------- Schritt 1b: Mapping-Dialog pro Sheet ---------- */
CRM.showMappingDialogForSheet = function (idx) {
  const sheets = CRM.importFlow.allSheets;
  if (idx >= sheets.length) {
    CRM.runDedupForAllCandidates();
    return;
  }
  CRM.importFlow.sheetIdx = idx;
  const sheet = sheets[idx];
  const headers = sheet.headerRow;
  const guessed = CRM.importer.guessMapping(headers);

  let fieldsHtml = CRM.importer.TARGET_FIELDS.map((f) => {
    const options = headers.map((h, i) => `<option value="${i}" ${guessed[f.key] === i ? 'selected' : ''}>${esc(h) || '(Spalte ' + (i + 1) + ')'}</option>`).join('');
    return `<div class="col" style="min-width:180px">
      <label>${f.label}${f.required ? ' *' : ''}</label>
      <select data-field="${f.key}">
        <option value="">— nicht zuordnen —</option>
        ${options}
      </select>
    </div>`;
  }).join('');

  const sourceOptions = CRM.SOURCES.map((s) => `<option value="${s}">${CRM.SOURCE_LABELS[s]}</option>`).join('');
  const typeOptions = CRM.TYPES.map((t) => `<option value="${t}">${CRM.TYPE_LABELS[t]}</option>`).join('');

  CRM.openModal(`
    <h2>Excel-Import: Spalten zuordnen</h2>
    <p style="color:var(--text-dim);font-size:13px">Datei: ${esc(sheet.fileName)} — Blatt: ${esc(sheet.sheetName)} (${sheet.dataRows.length} Datenzeilen) [${idx + 1}/${sheets.length}]</p>
    <div class="row" style="margin-bottom:8px">
      <div class="col">
        <label>Listenquelle</label>
        <select id="import-source">${sourceOptions}</select>
      </div>
      <div class="col">
        <label>Standard-Kontakttyp (falls keine Kategorie-Spalte)</label>
        <select id="import-type">${typeOptions}</select>
      </div>
      <div class="col">
        <label>Standard A/B/C</label>
        <select id="import-abc">
          <option value="C" selected>C</option><option value="B">B</option><option value="A">A</option>
        </select>
      </div>
      <div class="col" style="display:flex;align-items:center;gap:6px;margin-top:18px">
        <input type="checkbox" id="import-is-partner" style="width:auto">
        <label style="margin:0">Claytec-Partnerfirma (⭐)</label>
      </div>
    </div>
    <div class="row">${fieldsHtml}</div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn" onclick="CRM.skipImportSheet()">Blatt überspringen</button>
      <button class="btn btn-primary" onclick="CRM.applyMappingForSheet()">Weiter</button>
    </div>
  `);
};

CRM.skipImportSheet = function () {
  CRM.showMappingDialogForSheet(CRM.importFlow.sheetIdx + 1);
};

CRM.applyMappingForSheet = function () {
  const modal = document.querySelector('#active-modal-overlay .modal');
  const mapping = {};
  modal.querySelectorAll('select[data-field]').forEach((sel) => {
    if (sel.value !== '') mapping[sel.dataset.field] = parseInt(sel.value, 10);
  });
  if (mapping.firma1 == null || mapping.plz == null) {
    CRM.toast('Firma 1 und PLZ müssen zugeordnet werden.', 'error');
    return;
  }
  const defaults = {
    source: document.getElementById('import-source').value,
    type: document.getElementById('import-type').value,
    abc: document.getElementById('import-abc').value,
    isPartner: document.getElementById('import-is-partner').checked,
  };
  const sheet = CRM.importFlow.allSheets[CRM.importFlow.sheetIdx];
  const candidates = sheet.dataRows
    .map((row) => CRM.importer.rowToContact(row, mapping, defaults))
    .filter((c) => c.firma1) // Zeilen ohne Firmenname verwerfen
    .map((c) => { c._importFile = sheet.fileName; return c; }); // Datenherkunft

  CRM.importFlow.candidates = (CRM.importFlow.candidates || []).concat(candidates);
  CRM.showMappingDialogForSheet(CRM.importFlow.sheetIdx + 1);
};

/* ---------- Schritt 1c: Duplikat-Erkennung & Bestätigung ---------- */
CRM.runDedupForAllCandidates = function () {
  const candidates = CRM.importFlow.candidates || [];
  if (!candidates.length) {
    CRM.toast('Keine Kontakte zum Importieren gefunden.', 'error');
    CRM.importFlow = { sheetsData: [], mapping: {}, defaults: {} };
    return;
  }
  const existing = CRM.db.getContacts();
  const { duplicates, clean: cleanList } = CRM.importer.findDuplicates(candidates, existing);

  CRM.importFlow.duplicates = duplicates;
  CRM.importFlow.cleanList = cleanList;
  CRM.importFlow.dupDecisions = duplicates.map(() => 'merge'); // default: merge

  if (!duplicates.length) {
    CRM.finalizeImport();
    return;
  }
  CRM.importFlow.dupIdx = 0;
  CRM.showDuplicateReviewDialog();
};

CRM.showDuplicateReviewDialog = function () {
  const { duplicates, dupIdx } = CRM.importFlow;
  if (dupIdx >= duplicates.length) {
    CRM.finalizeImport();
    return;
  }
  const entry = duplicates[dupIdx];
  const cand = entry.candidate;
  const best = entry.matches[0];
  const ex = best.contact;

  CRM.openModal(`
    <h2>Mögliches Duplikat (${dupIdx + 1}/${duplicates.length})</h2>
    <p style="color:var(--text-dim);font-size:13px">Übereinstimmung: ${Math.round(best.score * 100)}%</p>
    <div class="row">
      <div class="col card">
        <h3 style="margin-top:0;font-size:13px;color:var(--text-dim)">NEU (Import)</h3>
        <div><strong>${esc(cand.firma1)}</strong></div>
        <div>${esc(cand.strasse)}</div>
        <div>${esc(cand.plz)} ${esc(cand.ort)}</div>
        <div>${esc(cand.ansprechpartner.vorname)} ${esc(cand.ansprechpartner.name)}</div>
      </div>
      <div class="col card">
        <h3 style="margin-top:0;font-size:13px;color:var(--text-dim)">BESTEHEND${best.isNewBatch ? ' (aus diesem Import)' : ''}</h3>
        <div><strong>${esc(ex.firma1)}</strong></div>
        <div>${esc(ex.strasse)}</div>
        <div>${esc(ex.plz)} ${esc(ex.ort)}</div>
        <div>${esc(ex.ansprechpartner.vorname)} ${esc(ex.ansprechpartner.name)}</div>
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.resolveDuplicate('skip')">Neu verwerfen</button>
      <button class="btn" onclick="CRM.resolveDuplicate('both')">Beide behalten (kein Duplikat)</button>
      <button class="btn btn-primary" onclick="CRM.resolveDuplicate('merge')">Zusammenführen</button>
    </div>
  `);
};

CRM.resolveDuplicate = function (decision) {
  const { duplicates, dupIdx } = CRM.importFlow;
  const entry = duplicates[dupIdx];
  if (decision === 'merge') {
    const target = entry.matches[0].contact;
    CRM.importer.mergeIntoExisting(target, entry.candidate);
    if (entry.matches[0].isNewBatch) {
      // Ziel ist selbst ein neuer Kandidat -> sicherstellen, dass er im cleanList landet (einmalig)
      if (!CRM.importFlow.cleanList.includes(target)) CRM.importFlow.cleanList.push(target);
    }
  } else if (decision === 'both') {
    CRM.importFlow.cleanList.push(entry.candidate);
  }
  // 'skip' -> Kandidat wird verworfen
  CRM.importFlow.dupIdx++;
  CRM.showDuplicateReviewDialog();
};

CRM.finalizeImport = function () {
  CRM.takeSnapshot('Vor Import');
  const toInsert = CRM.importFlow.cleanList || [];
  toInsert.forEach((c) => CRM.db.addContact(c));
  CRM.closeModal();
  CRM.toastUndo(`Import abgeschlossen: ${toInsert.length} Kontakte hinzugefügt/aktualisiert.`);
  CRM.importFlow = { sheetsData: [], mapping: {}, defaults: {} };
  CRM.renderContactList();
  if (CRM.geocoding && CRM.geocoding.geocodeAllPending) CRM.geocoding.geocodeAllPending();
};

/* Toast mit Rückgängig-Button (stellt letzten Snapshot wieder her) */
CRM.toastUndo = function (msg) {
  const host = document.getElementById('toast-container') || document.body;
  const el = document.createElement('div');
  el.className = 'toast success';
  el.innerHTML = `<span>${esc(msg)}</span> <button class="btn btn-sm" style="margin-left:10px">↶ Rückgängig</button>`;
  el.querySelector('button').addEventListener('click', () => {
    if (CRM.restoreSnapshot()) {
      CRM.toast('Import rückgängig gemacht — vorheriger Stand wiederhergestellt.', 'success');
      CRM.renderContactList();
      if (CRM.map && CRM.map.refresh) CRM.map.refresh();
    }
    el.remove();
  });
  host.appendChild(el);
  setTimeout(() => el.remove(), 12000);
};

/* ============================================================
   JSON-Backup Wiederherstellung
   ============================================================ */
CRM.confirmRestoreBackup = function (data) {
  const n = (data.contacts || []).length;
  CRM.openModal(`
    <h2>Backup wiederherstellen</h2>
    <p>Das Backup enthält <strong>${n}</strong> Kontakte und ${(data.projects || []).length} Projekte (Stand: ${esc(data.exportedAt || '?')}).</p>
    <p style="color:var(--text-dim);font-size:13px">"Ersetzen" überschreibt alle aktuellen Daten. "Zusammenführen" fügt hinzu / aktualisiert per ID.</p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn" onclick='CRM.doRestore("merge")'>Zusammenführen</button>
      <button class="btn btn-danger" onclick='CRM.doRestore("replace")'>Ersetzen</button>
    </div>
  `);
  CRM._pendingRestoreData = data;
};
/* Dedizierter Laptop→Handy-Weg: nur zusammenführen, keine Ersetzen-Option
   (schützt vor versehentlichem Plattmachen des Handy-Bestands). */
CRM.confirmMerge = function (data) {
  const n = (data.contacts || []).length;
  CRM.openModal(`
    <h2>🔀 Vom Laptop zusammenführen</h2>
    <p>Diese Datei enthält <strong>${n}</strong> Kontakte und ${(data.projects || []).length} Projekte (Stand: ${esc(data.exportedAt || '?')}).</p>
    <p style="color:var(--text-dim);font-size:13px">Die Daten werden <strong>hinzugefügt und aktualisiert</strong> — nichts auf diesem Gerät wird gelöscht. Bei gleicher ID gewinnt die Version aus der Datei (dein Laptop-Stand).</p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick='CRM.doRestore("merge")'>🔀 Zusammenführen</button>
    </div>
  `);
  CRM._pendingRestoreData = data;
};

CRM.doRestore = function (mode) {
  try {
    CRM.takeSnapshot('Vor Backup-Wiederherstellung');
    CRM.backup.importJSON(CRM._pendingRestoreData, mode);
    CRM.closeModal();
    CRM.toastUndo('Backup wiederhergestellt (' + (mode === 'replace' ? 'ersetzt' : 'zusammengeführt') + ').');
    CRM.renderContactList();
  } catch (e) {
    CRM.toast('Fehler: ' + e.message, 'error');
  }
};

/* ============================================================
   Auto-Backup-Erinnerung
   ============================================================ */
CRM.checkBackupReminder = function () {
  const settings = CRM.db.getSettings();
  const today = new Date().toISOString().slice(0, 10);
  if (settings.lastBackupPromptAt === today) return;
  if (!CRM.db.getContacts().length) return; // nichts zu sichern
  const lastBackup = settings.lastBackupAt ? new Date(settings.lastBackupAt) : null;
  const daysSince = lastBackup ? Math.floor((Date.now() - lastBackup) / 86400000) : Infinity;
  if (daysSince >= 1) {
    setTimeout(() => {
      CRM.showBackupReminder(daysSince);
      CRM.db.saveSettings({ lastBackupPromptAt: today });
    }, 1500);
  }
  window.addEventListener('beforeunload', (e) => {
    const s = CRM.db.getSettings();
    const last = s.lastBackupAt ? new Date(s.lastBackupAt) : null;
    const days = last ? Math.floor((Date.now() - last) / 86400000) : Infinity;
    if (days >= 1 && CRM.db.getContacts().length) {
      e.preventDefault();
      e.returnValue = '';
      return '';
    }
  });
};

/* Handlungsfähige Erinnerung: Toast mit „Jetzt sichern"-Button */
CRM.showBackupReminder = function (daysSince) {
  const host = document.getElementById('toast-container') || document.body;
  const el = document.createElement('div');
  el.className = 'toast';
  const since = daysSince === Infinity ? 'noch nie gesichert' : `letztes Backup vor ${daysSince} Tag(en)`;
  el.innerHTML = `<span>📦 Backup-Erinnerung (${since})</span>
    <button class="btn btn-sm" style="margin-left:10px">💾 Jetzt sichern</button>
    <button class="btn btn-sm" style="margin-left:6px">Später</button>`;
  const [saveBtn, laterBtn] = el.querySelectorAll('button');
  saveBtn.addEventListener('click', () => { CRM.backup.exportJSON(); el.remove(); });
  laterBtn.addEventListener('click', () => el.remove());
  host.appendChild(el);
  setTimeout(() => el.remove(), 15000);
};

/* ============================================================
   Zurück-Taste am Handy (Android) — schließt nicht mehr die App.
   Jedes Öffnen eines Dialogs und jeder Tab-Wechsel legt einen
   Verlaufseintrag an; „Zurück" macht genau EINEN Schritt rückgängig:
     offener Dialog  → Dialog schließen
     anderer Tab     → zurück zur Startseite
     Startseite      → App darf schließen (zweites Drücken)
   ============================================================ */
CRM.nav = { _tief: 0 };

CRM.nav.push = function (typ) {
  CRM.nav._tief++;
  try { history.pushState({ crm: typ, tief: CRM.nav._tief }, ''); } catch (e) { /* ignorieren */ }
};

CRM.nav.init = function () {
  // Basiseintrag, damit das erste „Zurück" bei uns landet und nicht draußen
  try { history.replaceState({ crm: 'start', tief: 0 }, ''); } catch (e) { /* ignorieren */ }

  window.addEventListener('popstate', () => {
    // 1) Offener Dialog? → nur den schließen
    if (document.getElementById('active-modal-overlay')) {
      CRM.closeModal();
      CRM.nav.push('nachDialog'); // Eintrag ersetzen, damit weiter zurück möglich bleibt
      return;
    }
    // 2) Offenes Karten-Seitenpanel? → schließen
    const panel = document.getElementById('map-side-panel');
    if (panel && panel.classList.contains('open')) {
      CRM.map.closeSidePanel();
      CRM.nav.push('nachPanel');
      return;
    }
    // 3) Nicht auf der Startseite? → dorthin zurück
    const aktiv = document.querySelector('.view.active');
    if (aktiv && aktiv.id !== 'view-start') {
      CRM.switchTab('start');
      CRM.nav.push('start');
      return;
    }
    // 4) Startseite ohne Dialog → App darf schließen (kein pushState mehr)
  });
};

/* ============================================================
   Wischen zwischen den Reitern (Android/Touch).
   Bewusst zurückhaltend: Nur klar horizontale, ausreichend lange
   Wischer zählen. Ausgenommen sind Bereiche, die selbst horizontal
   bedient werden — sonst kämpft die Geste gegen die Karte oder das
   Kanban-Board.
   ============================================================ */
CRM.swipe = {
  REIHENFOLGE: ['start', 'karte', 'kontakte', 'agenda', 'projekte', 'netzwerk', 'regionen', 'einstellungen'],
  MIN_X: 55,     // Mindeststrecke, damit ein Tippen nicht auslöst
  ENTSCHEID: 10, // ab hier wird entschieden: waagrecht (Reiter) oder senkrecht (Scrollen)
};

/* Darf an dieser Stelle überhaupt gewischt werden? Nur harte Sperren —
   Bereiche, die den Finger grundsätzlich selbst brauchen. */
CRM.swipe._erlaubt = function (el) {
  if (!el || !el.closest) return true;
  // Die Wischstreifen am Rand der Karte sind ausdrücklich dafür da
  if (el.closest('.map-swipe-zone')) return true;
  return !el.closest('#map-container, .leaflet-container, #active-modal-overlay, input, textarea, select');
};

/* Liegt unter dem Finger etwas, das in DIESER Richtung noch weiterscrollen
   kann (Kanban-Board, breite Tabelle)? Dann gehört die Geste dem Inhalt.
   Früher waren solche Bereiche pauschal gesperrt — dadurch endete das
   Wischen auf „Projekte", weil das Kanban die ganze Seite ausfüllt. Jetzt
   scrollt erst das Board, und am Anschlag geht es zum nächsten Reiter.
   richtung: 1 = weiter (Finger nach links), -1 = zurück. */
CRM.swipe._inhaltScrolltNoch = function (el, richtung) {
  let n = el;
  while (n && n !== document.body && !n.classList.contains('view') && n.id !== 'main') {
    const rest = n.scrollWidth - n.clientWidth;
    if (rest > 4 && /(auto|scroll)/.test(getComputedStyle(n).overflowX)) {
      // 2px Toleranz: Browser runden scrollLeft bei Zoomstufen ungenau
      if (richtung > 0 && n.scrollLeft < rest - 2) return true;
      if (richtung < 0 && n.scrollLeft > 2) return true;
    }
    n = n.parentElement;
  }
  return false;
};

/* Die Auswertung passiert WÄHREND des Ziehens, nicht erst beim Loslassen:
   Sobald die Mindeststrecke erreicht ist, wird umgeschaltet. Das ist nicht
   nur direkter, es ist auch robuster — bricht der Browser die Geste ab
   (touchcancel statt touchend), ginge ein Wischer am Ende sonst verloren. */
CRM.swipe.init = function () {
  let x0 = 0, y0 = 0, aktiv = false, waagrecht = null, start = null;

  const zuruecksetzen = () => { aktiv = false; waagrecht = null; start = null; };

  document.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1) { zuruecksetzen(); return; }
    const t = e.touches[0];
    start = e.target;
    aktiv = CRM.swipe._erlaubt(start);
    waagrecht = null;
    x0 = t.clientX; y0 = t.clientY;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!aktiv || e.touches.length !== 1) return;
    const dx = e.touches[0].clientX - x0;
    const dy = e.touches[0].clientY - y0;

    // Richtung einmalig festlegen und dann dabei bleiben — sonst kippt ein
    // Wischer, der leicht schräg endet, mitten in der Bewegung um.
    if (waagrecht === null) {
      if (Math.abs(dx) < CRM.swipe.ENTSCHEID && Math.abs(dy) < CRM.swipe.ENTSCHEID) return;
      waagrecht = Math.abs(dx) > Math.abs(dy);
      if (!waagrecht) { aktiv = false; return; } // senkrecht = Scrollen, Finger gehört der Liste
    }

    if (Math.abs(dx) >= CRM.swipe.MIN_X) {
      aktiv = false; // pro Berührung nur eine Aktion
      const richtung = dx < 0 ? 1 : -1;
      // Kanban & Co. dürfen erst zu Ende scrollen, bevor der Reiter wechselt
      if (CRM.swipe._inhaltScrolltNoch(start, richtung)) return;
      CRM.swipe.wechsle(richtung);
    }
  }, { passive: true });

  document.addEventListener('touchend', zuruecksetzen, { passive: true });
  document.addEventListener('touchcancel', zuruecksetzen, { passive: true });
};

CRM.swipe.wechsle = function (richtung) {
  const aktuell = (document.querySelector('.view.active') || {}).id || 'view-start';
  const key = aktuell.replace('view-', '');
  const i = CRM.swipe.REIHENFOLGE.indexOf(key);
  if (i < 0) return;
  const ziel = CRM.swipe.REIHENFOLGE[i + richtung];
  if (!ziel) return; // an den Enden nicht umbrechen — sonst verliert man die Orientierung
  CRM.switchTab(ziel);
};
