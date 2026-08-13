/* ============================================================
   Claytec CRM — Vergleichs-/Zusammenführen-Fenster (Batch 4, 2026-08)

   NEUES, ADDITIVES Fenster-System (CRM.win.*). Bewusst NICHT auf
   CRM.openModal/CRM.closeModal aufgebaut, sondern eigenes DOM
   (#crm-win-layer), damit:
   - mehrere Kontakt-„Fenster" gleichzeitig offen sein können
     (das bestehende Modal-System erlaubt nur EIN Modal, siehe
     CRM.openModal in app.js, das immer zuerst closeModal() ruft),
   - ein offenes Formular-Modal (z.B. „+ Neuer Kontakt") beim Öffnen
     eines Vergleichsfensters NICHT verschwindet — genau das war der
     gemeldete Fehler ("Eingabeformular verschwindet beim Vergleichen").

   Diese Datei ruft NIRGENDS CRM.closeModal() auf. Einzige Ausnahme:
   "Vollständig bearbeiten" öffnet bewusst das bestehende
   CRM.openContactDetail() (normales Modal) — das ist laut Spezifikation
   ausdrücklich in Ordnung (ersetzt ggf. ein offenes Formular, weil der
   Nutzer aktiv die Voll-Bearbeitung gewählt hat).

   Zusammenführen nutzt ausschließlich die bestehende, geprüfte
   CRM.mergeContacts() (storage.js) + CRM.toastUndo() — keine eigene
   Merge-Logik.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.win = {
  _wins: [],   // [{winId, kind:'contact'|'draft'|'empty', contactId?, draftContact?, el}]
  _seq: 0,
};

/* ---------- Layer (eigenes DOM, NICHT #active-modal-overlay) ---------- */
CRM.win._layerEl = function () {
  let layer = document.getElementById('crm-win-layer');
  if (!layer) {
    layer = document.createElement('div');
    layer.id = 'crm-win-layer';
    document.body.appendChild(layer);
  }
  return layer;
};

CRM.win._updateLayerState = function () {
  CRM.win._layerEl().classList.toggle('has-windows', CRM.win._wins.length > 0);
};

CRM.win.count = function () {
  return CRM.win._wins.length;
};

/* ---------- Öffnen/Schließen ---------- */
CRM.win.openContact = function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) { CRM.toast('Kontakt nicht gefunden.', 'error'); return; }
  const existing = CRM.win._wins.find((w) => w.kind === 'contact' && w.contactId === contactId);
  if (existing) { CRM.win._bringToFront(existing.el); return; }
  CRM.win._addWindow({ winId: 'w' + (++CRM.win._seq), kind: 'contact', contactId: contactId });
};

/* Öffnet ein Vergleichsfenster mit den AKTUELL im "+ Neuer Kontakt"-Formular
   eingetragenen (auch ungespeicherten) Daten — löst "Eingabe nicht verlieren":
   das Formular-Modal bleibt unangetastet offen, dieses Fenster liegt nur
   optisch darüber. Findet zusätzlich automatisch den ähnlichsten
   bestehenden Kontakt und öffnet ihn direkt als zweites Fenster. */
CRM.win.openDraftFromForm = function () {
  if (!document.getElementById('ep-company')) {
    CRM.toast('Das Neu-Kontakt-Formular ist nicht offen.', 'error');
    return;
  }
  const data = {};
  CRM.emailParser.FIELDS.forEach(([, key]) => { data[key] = (document.getElementById('ep-' + key) || {}).value || ''; });
  if (!data.company && !data.name) {
    CRM.toast('Bitte zuerst Firma oder Name eingeben, dann vergleichen.', 'error');
    return;
  }
  const typeEl = document.getElementById('ep-type');
  const srcEl = document.getElementById('ep-source');
  const draftContact = CRM.emailParser.toContact(data, typeEl ? typeEl.value : 'privatbauherr', srcEl ? srcEl.value : 'eigene');

  const already = CRM.win._wins.find((w) => w.kind === 'draft');
  if (already) {
    already.draftContact = draftContact;
    CRM.win._bringToFront(already.el);
    CRM.win._renderAll();
  } else {
    CRM.win._addWindow({ winId: 'draft', kind: 'draft', draftContact: draftContact });
  }

  const similar = CRM.win._findSimilar(draftContact);
  if (similar[0] && !CRM.win._wins.some((w) => w.kind === 'contact' && w.contactId === similar[0].id)) {
    CRM.win.openContact(similar[0].id);
  } else if (!similar[0]) {
    CRM.toast('Keine ähnlichen Kontakte gefunden — über das Suchfeld im Fenster einen Kontakt zum Vergleich laden.');
  }
};

/* Für Einstellungen → "Zwei Kontakte manuell zusammenführen": EIN leeres
   Suchfenster (Chris-Feedback 2026-08: zwei leere Fenster gleichzeitig zu
   öffnen war "Quatsch" — bei 380px Fensterbreite lagen sie fast komplett
   übereinander, das obenliegende zweite Fenster fing dabei Klicks und
   Suchergebnisse des ersten ab ("Schließen reagiert nicht",
   "Kontakte werden nicht gefunden"). Jetzt: erst EIN Fenster, darin einen
   Kontakt suchen/laden (_assignContact); sobald es einen Kontakt zeigt,
   erscheint automatisch ein zweites Suchfeld im Footer (siehe
   _footerHtml, total<2-Zweig) — das zweite Fenster wird erst dann,
   separat, über CRM.win.openContact() geöffnet (landet dank _positionNew
   nebeneinander, nicht überlappend). */
CRM.win.openManualMerge = function () {
  CRM.win.closeAll();
  CRM.win._addWindow({ winId: 'w' + (++CRM.win._seq), kind: 'empty' });
};

CRM.win.close = function (winId) {
  const idx = CRM.win._wins.findIndex((w) => w.winId === winId);
  if (idx === -1) return;
  CRM.win._wins[idx].el.remove();
  CRM.win._wins.splice(idx, 1);
  CRM.win._updateLayerState();
  CRM.win._renderAll();
};

CRM.win.closeTop = function () {
  const layer = CRM.win._layerEl();
  const topEl = layer.lastElementChild;
  if (!topEl) return;
  CRM.win.close(topEl.dataset.winId);
};

CRM.win.closeAll = function () {
  CRM.win._wins.slice().forEach((w) => w.el.remove());
  CRM.win._wins = [];
  CRM.win._updateLayerState();
};

/* ---------- Fenster erzeugen, positionieren, verschiebbar machen ---------- */
CRM.win._addWindow = function (winObj) {
  const layer = CRM.win._layerEl();
  const el = document.createElement('div');
  el.className = 'crm-window';
  el.dataset.winId = winObj.winId;
  el.innerHTML = `
    <div class="crm-win-titlebar">
      <span class="crm-win-title"></span>
      <button class="crm-win-close" title="Schließen" onclick="CRM.win.close('${winObj.winId}')">✕</button>
    </div>
    <div class="crm-win-body"></div>
    <div class="crm-win-footer"></div>
  `;
  winObj.el = el;
  CRM.win._positionNew(el);
  layer.appendChild(el);
  CRM.win._wins.push(winObj);
  CRM.win._wireDrag(el);
  CRM.win._updateLayerState();
  CRM.win._renderAll();
  if (CRM.nav && CRM.nav.push) CRM.nav.push('crmWindow');
};

/* Bug (gemeldet, 2026-08): "Zwei Kontakte manuell zusammenführen" und
   "🔍 Ähnliche prüfen" öffnen BEIDE Fenster sofort gleichzeitig, ohne dass
   der Nutzer dazwischen ziehen kann. Der alte diagonale 34px-Versatz ist
   bei 380px Fensterbreite viel zu klein — die Fenster lagen fast komplett
   übereinander, das ZULETZT geöffnete (im DOM oben, siehe _bringToFront)
   fing dabei Klicks/Suchergebnisse des ERSTEN Fensters ab (per
   elementFromPoint bestätigt: an der Stelle der Ergebnisliste von Fenster 1
   saß tatsächlich das Eingabefeld von Fenster 2). Das erklärte sowohl
   "Schließen reagiert nicht" (traf oft das falsche, obenliegende Fenster)
   als auch "Kontakte werden nicht gefunden" (Ergebnisliste optisch verdeckt).
   Fix: genügend breiter Viewport -> echtes Nebeneinander (Fenster 0 links,
   Fenster 1 rechts, wie von Chris ursprünglich gewünscht "nebeneinander
   legen, um sie zu vergleichen"); schmaler Viewport -> alter Diagonal-
   Versatz als Fallback. */
CRM.win._positionNew = function (el) {
  const n = CRM.win._wins.length; // Position VOR dem Push -> 0,1,2,...
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = 380, minVisible = 200;
  let left, top;
  if (vw >= w * 2 + 48) {
    const col = n % 2; // 0 = linke Spalte, 1 = rechte Spalte
    const stackInCol = Math.floor(n / 2); // 3./5./... Fenster: leichter Versatz je Spalte
    left = col === 0 ? (24 + stackInCol * 24) : (vw - w - 24 - stackInCol * 24);
    top = 60 + stackInCol * 34;
  } else {
    left = 24 + (n % 5) * 34;
    top = 60 + (n % 5) * 34;
  }
  left = Math.min(Math.max(left, 0), Math.max(0, vw - w - 16));
  top = Math.min(Math.max(top, 0), Math.max(0, vh - minVisible));
  el.style.left = left + 'px';
  el.style.top = top + 'px';
};

CRM.win._bringToFront = function (el) {
  const layer = CRM.win._layerEl();
  layer.appendChild(el); // letztes Kind = oben (kein z-index-Zähler nötig)
};

/* Verschiebbar per Titelleiste (Pointer Events), im Viewport geklammert.
   Am Handy (<=768px) werden Fenster laut CSS zu vollbreiten, gestapelten
   Panels — dort ist Ziehen weder möglich noch nötig (kein Drag-Zwang). */
CRM.win._wireDrag = function (el) {
  const titlebar = el.querySelector('.crm-win-titlebar');
  el.addEventListener('pointerdown', () => CRM.win._bringToFront(el));
  titlebar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.crm-win-close')) return;
    if (window.innerWidth <= 768) return; // mobil: kein Drag, siehe CSS-Fallback
    e.preventDefault();
    CRM.win._bringToFront(el);
    const rect = el.getBoundingClientRect();
    const offX = e.clientX - rect.left;
    const offY = e.clientY - rect.top;
    const w = rect.width, h = rect.height;
    const onMove = (ev) => {
      const vw = window.innerWidth, vh = window.innerHeight;
      let left = ev.clientX - offX;
      let top = ev.clientY - offY;
      left = Math.min(Math.max(left, 0), Math.max(0, vw - w));
      top = Math.min(Math.max(top, 0), Math.max(0, vh - h));
      el.style.left = left + 'px';
      el.style.top = top + 'px';
    };
    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
};

/* ---------- Ähnlichkeits-Suche (für "🔍 Ähnliche prüfen") ---------- */
CRM.win._findSimilar = function (contactLike) {
  const nameNorm = CRM.searchNorm(contactLike.firma1 || '');
  if (!nameNorm) return [];
  return CRM.db.getContacts()
    .map((c) => {
      let score = CRM.importer.matchScore(contactLike, c) || 0;
      if (!score) {
        const cn = CRM.searchNorm(c.firma1 || '');
        if (cn && (cn.indexOf(nameNorm) !== -1 || nameNorm.indexOf(cn) !== -1)) score = 0.5;
      }
      return { c: c, score: score };
    })
    .filter((x) => x.score >= 0.45)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
    .map((x) => x.c);
};

/* ---------- Inhalt: normalisierter Datensatz für Kontakt ODER Entwurf ---------- */
CRM.win._record = function (winObj) {
  if (winObj.kind === 'draft') return CRM.win._recordFromContactLike(winObj.draftContact, true);
  if (winObj.kind === 'contact') {
    const c = CRM.db.getContact(winObj.contactId);
    if (!c) return null;
    return CRM.win._recordFromContactLike(c, false);
  }
  return null; // 'empty'
};

CRM.win._recordFromContactLike = function (c, isDraft) {
  const ap = c.ansprechpartner || {};
  const apName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const apLine = apName ? (apName + (ap.funktion ? ' (' + ap.funktion + ')' : '')) : '';
  const counts = isDraft
    ? { visits: 0, tasks: 0, links: 0 }
    : {
      visits: (c.visits || []).length,
      tasks: CRM.db.getTasksForContact(c.id).filter((t) => !t.done).length,
      links: Object.values(c.links || {}).reduce((s, arr) => s + ((arr || []).length), 0),
    };
  return {
    title: isDraft ? (c.firma1 || apName || 'Neuer Kontakt') : CRM.displayNameDisambig(c),
    fields: [
      ['firma', 'Firma', c.firma1 || ''],
      ['strasse', 'Straße', c.strasse || ''],
      ['plzOrt', 'PLZ/Ort', [c.plz, c.ort].filter(Boolean).join(' ')],
      ['ansprechpartner', 'Ansprechpartner', apLine],
      ['typ', 'Typ', CRM.TYPE_LABELS[c.type] || c.type || ''],
      ['abc', 'Einstufung', c.abc || ''],
      ['erpNr', 'ERP-/Kundennr.', c.erpNr || ''],
      ['notiz', 'Notiz', c.notiz || ''],
      ['nextStep', 'Nächster Schritt', c.nextStep || ''],
    ],
    counts: counts,
  };
};

/* Sind genau zwei Fenster mit vergleichbarem Inhalt offen (Kontakt/Entwurf,
   nicht 'empty'), werden abweichende Felder in BEIDEN Fenstern markiert. */
CRM.win._computeDiffKeys = function () {
  if (CRM.win._wins.length !== 2) return new Set();
  const ra = CRM.win._record(CRM.win._wins[0]);
  const rb = CRM.win._record(CRM.win._wins[1]);
  if (!ra || !rb) return new Set();
  const norm = (s) => CRM.searchNorm(String(s || ''));
  const mapB = new Map(rb.fields.map((f) => [f[0], f[2]]));
  const diff = new Set();
  ra.fields.forEach((f) => {
    const key = f[0], val = f[2];
    const other = mapB.get(key) || '';
    if ((val || other) && norm(val) !== norm(other)) diff.add(key);
  });
  return diff;
};

/* ---------- Rendering ---------- */
CRM.win._renderAll = function () {
  const diffKeys = CRM.win._computeDiffKeys();
  CRM.win._wins.forEach((w) => CRM.win._render(w, diffKeys));
};

CRM.win._render = function (winObj, diffKeys) {
  const el = winObj.el;
  const titleEl = el.querySelector('.crm-win-title');
  const bodyEl = el.querySelector('.crm-win-body');
  const footerEl = el.querySelector('.crm-win-footer');

  if (winObj.kind === 'empty') {
    titleEl.textContent = 'Kontakt wählen';
    bodyEl.innerHTML = `<p style="color:var(--text-dim);font-size:13px;margin-top:0">Kontakt suchen, um ihn hier zum Vergleichen/Zusammenführen zu laden.</p>${CRM.win._searchBoxHtml(winObj.winId)}`;
    footerEl.innerHTML = `<button class="btn btn-sm" onclick="CRM.win.close('${winObj.winId}')">✕ Schließen</button>`;
    CRM.win._wireSearchBox(el, winObj.winId);
    return;
  }

  const rec = CRM.win._record(winObj);
  if (!rec) {
    titleEl.textContent = 'Kontakt nicht mehr vorhanden';
    bodyEl.innerHTML = '<p style="color:var(--text-dim);font-size:13px;margin-top:0">Dieser Kontakt existiert nicht mehr (z.B. gerade zusammengeführt).</p>';
    footerEl.innerHTML = `<button class="btn btn-sm" onclick="CRM.win.close('${winObj.winId}')">✕ Schließen</button>`;
    return;
  }

  titleEl.innerHTML = esc(rec.title) + (winObj.kind === 'draft' ? ' <span class="crm-win-draft-tag">ungespeichert</span>' : '');
  titleEl.title = rec.title;
  bodyEl.innerHTML = CRM.win._fieldsHtml(rec, diffKeys);
  footerEl.innerHTML = CRM.win._footerHtml(winObj);
  CRM.win._wireSearchBox(el, winObj.winId);
};

CRM.win._fieldsHtml = function (rec, diffKeys) {
  const rows = rec.fields.map(([key, label, val]) => `
    <div class="crm-win-field${diffKeys.has(key) ? ' diff' : ''}">
      <div class="crm-win-field-label">${esc(label)}</div>
      <div class="crm-win-field-value">${val ? esc(val) : '<span style="color:var(--text-dim)">—</span>'}</div>
    </div>`).join('');
  const counts = `<div class="crm-win-counts">
    <span class="badge">📍 ${rec.counts.visits} Besuche</span>
    <span class="badge">✅ ${rec.counts.tasks} offene Aufgabe(n)</span>
    <span class="badge">🔗 ${rec.counts.links} Verknüpfung(en)</span>
  </div>`;
  return rows + counts;
};

CRM.win._footerHtml = function (winObj) {
  const total = CRM.win._wins.length;
  let html = '';
  if (winObj.kind === 'contact') {
    html += `<button class="btn btn-sm" onclick="CRM.win.closeAll();CRM.openContactDetail('${winObj.contactId}')">✎ Vollständig bearbeiten</button>`;
  }
  if (total === 2) {
    const other = CRM.win._wins.find((w) => w.winId !== winObj.winId);
    if (winObj.kind === 'contact' && other && other.kind === 'contact') {
      html += `<button class="btn btn-sm btn-primary" onclick="CRM.win.mergeKeep('${winObj.contactId}','${other.contactId}')">⇄ Diesen behalten &amp; zusammenführen</button>`;
    }
  } else if (total < 2 && winObj.kind !== 'empty') {
    html += CRM.win._searchBoxHtml(winObj.winId);
  }
  html += `<button class="btn btn-sm" onclick="CRM.win.close('${winObj.winId}')">✕ Schließen</button>`;
  return html;
};

CRM.win._searchBoxHtml = function (winId) {
  return `<div class="crm-win-search" data-win="${winId}">
    <input type="text" placeholder="+ Kontakt zum Vergleich suchen (Firma/Ort/ERP)">
    <div class="header-search-dropdown hidden"></div>
  </div>`;
};

CRM.win._wireSearchBox = function (el, winId) {
  const box = el.querySelector('.crm-win-search');
  if (!box) return;
  const input = box.querySelector('input');
  const results = box.querySelector('.header-search-dropdown');
  input.addEventListener('input', () => CRM.win._onSearchInput(winId, input.value, results));
  input.addEventListener('focus', () => CRM.win._onSearchInput(winId, input.value, results));
};

CRM.win._onSearchInput = function (winId, q, resultsEl) {
  const query = (q || '').trim();
  if (!query) { resultsEl.classList.add('hidden'); resultsEl.innerHTML = ''; return; }
  const openIds = new Set(CRM.win._wins.filter((w) => w.kind === 'contact').map((w) => w.contactId));
  const matches = CRM.db.getContacts()
    .filter((c) => CRM.contactQueryMatch(query, c))
    .filter((c) => !openIds.has(c.id))
    .slice(0, 8);
  resultsEl.innerHTML = matches.length
    ? matches.map((c) => `
      <div class="header-search-item" data-id="${c.id}">
        <span class="badge badge-${c.type}" style="margin-right:6px">${CRM.TYPE_SHORT[c.type] || '–'}</span>
        <strong>${esc(CRM.displayNameDisambig(c))}</strong>
        <span style="color:var(--text-dim);font-size:12px"> · ${esc(c.plz)} ${esc(c.ort)}</span>
      </div>`).join('')
    : '<div class="header-search-empty">Keine Treffer</div>';
  resultsEl.querySelectorAll('.header-search-item').forEach((row) => {
    row.addEventListener('mousedown', (e) => {
      e.preventDefault();
      const w = CRM.win._wins.find((x) => x.winId === winId);
      if (w && w.kind === 'empty') CRM.win._assignContact(winId, row.dataset.id);
      else CRM.win.openContact(row.dataset.id);
    });
  });
  resultsEl.classList.remove('hidden');
};

CRM.win._assignContact = function (winId, contactId) {
  const w = CRM.win._wins.find((x) => x.winId === winId);
  if (!w) return;
  if (CRM.win._wins.some((x) => x.winId !== winId && x.kind === 'contact' && x.contactId === contactId)) {
    CRM.toast('Dieser Kontakt ist bereits in einem anderen Fenster geöffnet.', 'error');
    return;
  }
  w.kind = 'contact';
  w.contactId = contactId;
  delete w.draftContact;
  CRM.win._renderAll();
};

/* ---------- Zusammenführen (B1: einen als Master behalten) ----------
   Nutzt AUSSCHLIESSLICH die bestehende, geprüfte CRM.mergeContacts()
   (storage.js:832, zieht selbst takeSnapshot VOR dem Merge) + den
   bestehenden CRM.toastUndo() (Ein-Klick-Rückgängig). Keine eigene
   Merge-/Snapshot-Logik. */
CRM.win.mergeKeep = function (keepId, dropId) {
  const keep = CRM.db.getContact(keepId);
  const drop = CRM.db.getContact(dropId);
  if (!keep || !drop) return;
  const ok = confirm('„' + CRM.displayNameDisambig(drop) + '" wird in „' + CRM.displayNameDisambig(keep)
    + '" eingefügt und danach gelöscht. Besuche, Aufgaben, Notizen und Verknüpfungen bleiben erhalten. Fortfahren?');
  if (!ok) return;
  const merged = CRM.mergeContacts(keepId, dropId);
  CRM.win.closeAll();
  if (!merged) return;
  // Ein evtl. offenes Kontaktprofil-Modal (Merge kann aus dem Profil heraus
  // gestartet worden sein) zeigt sonst veraltete/gelöschte Daten neu zeichnen.
  const openModalEl = document.getElementById('active-modal-overlay');
  if (openModalEl && openModalEl.querySelector('.cd-header') && CRM.renderContactDetailModal) {
    CRM.renderContactDetailModal(merged.id);
  }
  CRM.toastUndo('Kontakte zu „' + CRM.displayNameDisambig(merged) + '" zusammengeführt.');
  if (CRM.renderContactList) CRM.renderContactList();
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
  if (CRM.renderDuplicatesPanel && document.getElementById('dupe-results')) CRM.renderDuplicatesPanel();
};
