/* ============================================================
   Claytec CRM — Aktivitäten (vereinte Kontakt-Historie)
   Führt Besuche, E-Mails/Kommunikation, Journal-Einträge und
   erledigte Aufgaben in EINEN chronologischen Strang zusammen.
   Beantwortet die Frage „Was ist mit diesem Kunden gelaufen?"
   an einer Stelle statt in drei getrennten Listen.

   Bewusst NICHT hier: offene Aufgaben — die bleiben in der
   Aufgaben-Karte (Zukunft), Aktivitäten zeigen die Vergangenheit.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.activities = { _filter: 'alle', _showMore: false };

/* Filterkategorien: die ersten fünf sind der Alltag und stehen als
   Chips oben. Reklamation/Schulung u.a. sind seltener und liegen
   hinter „▾ Mehr" — verfügbar, aber nicht im Weg. */
CRM.activities.PRIMARY = [
  ['alle', 'Alle'],
  ['besuch', '📍 Besuche'],
  ['mail', '✉ Mails'],
  ['muster', '📦 Muster'],
  ['angebot', '📄 Angebote'],
  ['aufgabe', '✓ Aufgaben'],
];
CRM.activities.SECONDARY = [
  ['reklamation', '⚠️ Reklamationen'],
  ['schulung', '🎓 Schulungen'],
  ['notiz', '📝 Notizen'],
  ['telefon', '📞 Telefonate'],
];

/* Journal-Typ → Filterkategorie + Farbe der Zeitstrahl-Punkte */
CRM.activities.KAT = {
  muster: 'muster', angebot: 'angebot', reklamation: 'reklamation', schulung: 'schulung',
  telefon: 'telefon', mail: 'mail', whatsapp: 'notiz', teams: 'notiz', info: 'notiz',
};
CRM.activities.FARBE = {
  besuch: '#1D9E75', mail: '#D85A30', muster: '#BA7517', angebot: '#534AB7',
  aufgabe: '#888780', reklamation: '#C93C3C', schulung: '#1668B0', notiz: '#888780',
  telefon: '#888780',
};

/* Alle Vorgänge eines Kontakts einsammeln und chronologisch sortieren. */
CRM.activities.build = function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return [];
  const list = [];

  (c.visits || []).forEach((v) => {
    list.push({
      kat: 'besuch', icon: '📍', label: 'Besuch', datum: v.date,
      text: v.note || '(ohne Notiz)', quelle: 'visit', id: v.id,
      status: v.status || 'offen', erledigtAm: v.erledigtAm || '',
      excelFiled: !!v.excelFiled, note: v.note || '',
    });
  });

  CRM.db.getCommsForContact(contactId).forEach((m) => {
    const istMail = m.type === 'email';
    const richtung = m.direction === 'out' ? 'ausgehend' : 'eingegangen';
    list.push({
      kat: istMail ? 'mail' : (m.type === 'call' ? 'telefon' : 'notiz'),
      icon: istMail ? '✉' : (m.type === 'call' ? '📞' : '📝'),
      label: istMail ? ('E-Mail ' + richtung) : (CRM.COMM_TYPE_LABELS[m.type] || 'Kommunikation').replace(/^\S+\s/, ''),
      datum: m.date, text: m.subject || (m.body || '').slice(0, 80) || '(ohne Betreff)',
      projectId: (m.projectIds || [])[0] || null, quelle: 'comm', id: m.id,
      status: m.status || 'offen', erledigtAm: m.erledigtAm || '',
      // Eingegangene Mails bekommen die Antwort-Aktionen (siehe renderInner)
      eingehendeMail: istMail && m.direction !== 'out',
    });
  });

  CRM.db.getJournalForContact(contactId).forEach((j) => {
    const typ = j.entryType || 'info';
    const label = (CRM.JOURNAL_TYPE_LABELS[typ] || typ);
    list.push({
      kat: CRM.activities.KAT[typ] || 'notiz',
      icon: label.split(' ')[0],
      label: label.replace(/^\S+\s/, ''),
      datum: (j.createdAt || '').slice(0, 10),
      text: j.content || '(ohne Text)',
      projectId: j.projectId || null, quelle: 'journal', id: j.id,
      status: j.status || 'offen', erledigtAm: j.erledigtAm || '',
    });
  });

  CRM.db.getTasksForContact(contactId).filter((t) => t.done).forEach((t) => {
    list.push({
      kat: 'aufgabe', icon: '✓', label: 'Aufgabe erledigt',
      datum: (t.doneAt || t.due || '').slice(0, 10), text: t.title,
      projectId: t.projectId || null, quelle: 'task', id: t.id,
      status: 'erledigt', erledigtAm: (t.doneAt || '').slice(0, 10), // Aufgaben stehen hier immer als erledigt
    });
  });

  list.sort((a, b) => ((a.datum || '') < (b.datum || '') ? 1 : -1));
  return list;
};

CRM.activities.setFilter = function (contactId, kat) {
  CRM.activities._filter = kat;
  CRM.activities.refresh(contactId);
};
CRM.activities.toggleMore = function (contactId) {
  CRM.activities._showMore = !CRM.activities._showMore;
  CRM.activities.refresh(contactId);
};
CRM.activities.refresh = function (contactId) {
  const el = document.getElementById('cd-activities');
  if (el) el.innerHTML = CRM.activities.renderInner(contactId);
};

CRM.activities.render = function (contactId) {
  return '<div id="cd-activities">' + CRM.activities.renderInner(contactId) + '</div>';
};

CRM.activities.renderInner = function (contactId) {
  const alle = CRM.activities.build(contactId);
  const f = CRM.activities._filter;
  let gefiltert = (f === 'alle') ? alle : alle.filter((a) => a.kat === f);
  if (CRM.activities._hideErledigt) gefiltert = gefiltert.filter((a) => a.status !== 'erledigt');

  const zaehler = {};
  alle.forEach((a) => { zaehler[a.kat] = (zaehler[a.kat] || 0) + 1; });

  const chip = ([kat, label]) => {
    const n = kat === 'alle' ? alle.length : (zaehler[kat] || 0);
    if (kat !== 'alle' && !n && f !== kat) return ''; // leere Kategorien ausblenden
    return `<button class="qf-btn ${f === kat ? 'active' : ''}" onclick="CRM.activities.setFilter('${contactId}','${kat}')">${label}${n ? ' ' + n : ''}</button>`;
  };

  const primary = CRM.activities.PRIMARY.map(chip).join('');
  const secondary = CRM.activities._showMore ? CRM.activities.SECONDARY.map(chip).join('') : '';
  const hatSekundaer = CRM.activities.SECONDARY.some(([k]) => zaehler[k]);

  const zeilen = gefiltert.map((a) => {
    const erledigt = a.status === 'erledigt';
    const inArbeit = a.status === 'inArbeit';
    const farbe = erledigt ? '#1D9E75' : (inArbeit ? '#E0A030' : (CRM.activities.FARBE[a.kat] || '#888780'));
    const p = a.projectId ? CRM.db.getProject(a.projectId) : null;
    const projChip = p
      ? `<span class="badge" style="cursor:pointer;margin-top:4px" onclick="event.stopPropagation();CRM.closeModal();CRM.switchTab('projekte');CRM.openProjectDetail('${p.id}')">${(p.kategorie || 'baustelle') === 'gross' ? '🏢' : '🏠'} ${esc2(p.name)}</span>`
      : '';
    const datum = a.datum ? a.datum.split('-').reverse().join('.') : '—';
    const statusVermerk = erledigt
      ? `<div class="act-status act-status-done">✓ Erledigt${a.erledigtAm ? ' am ' + a.erledigtAm.split('-').reverse().join('.') : ''}</div>`
      : (inArbeit ? '<div class="act-status act-status-wip">🔧 In Arbeit</div>' : '');
    // Status-Knopf nur für echte Vorgänge — die Aufgaben-Historie steht ohnehin fest auf erledigt
    const statusBtn = a.quelle !== 'task'
      ? `<button class="btn btn-sm act-status-btn" title="Status setzen: offen / in Arbeit / erledigt" onclick="CRM.activities.statusDialog('${contactId}','${a.quelle}','${a.id}')">${erledigt ? '↩' : '✓'}</button>`
      : '';
    return `
      <div class="act-row${erledigt ? ' act-row-done' : ''}">
        <span class="act-dot" style="background:${farbe}"></span>
        <div class="act-main">
          <div class="act-head">
            <strong>${a.icon} ${esc2(a.label)}</strong>
            <span class="act-date">${esc2(datum)}</span>
          </div>
          <div class="act-text">${esc2(a.text)}</div>
          ${a.quelle === 'visit' && a.excelFiled ? '<div class="act-status" style="color:var(--green)">✓ in Excel abgelegt</div>' : ''}
          ${statusVermerk}
          ${projChip}
          ${a.eingehendeMail ? `
            <div class="act-actions">
              <button class="btn btn-sm" onclick="event.stopPropagation();CRM.mailAntwort.prepare('${contactId}','${a.id}')">🤖 Antwort vorbereiten</button>
              <button class="btn btn-sm" onclick="event.stopPropagation();CRM.mailAntwort.dokumentieren('${contactId}','${a.id}')">✉ Antwort dokumentieren</button>
            </div>` : ''}
        </div>
        <div class="act-btns">
          ${a.quelle === 'visit' && CRM.ablage && CRM.ablage.supported()
            ? `<button class="btn btn-sm" title="${a.excelFiled ? 'Erneut in Excel ablegen (fügt eine weitere Zeile hinzu)' : 'In Excel ablegen (Besuchsprotokoll + Berichtswesen Vertrieb)'}" onclick="CRM.activities.fileVisit('${contactId}','${a.id}')">📋</button>`
            : ''}
          ${statusBtn}
          <button class="btn btn-sm act-edit" title="Eintrag bearbeiten"
            onclick="CRM.activities.edit('${contactId}','${a.quelle}','${a.id}')">✏️</button>
          <button class="btn btn-sm act-del" title="Eintrag löschen"
            onclick="CRM.activities.remove('${contactId}','${a.quelle}','${a.id}')">✕</button>
        </div>
      </div>`;
  }).join('');

  return `
    <div class="quick-filters" style="margin:0 0 10px">
      ${primary}
      ${hatSekundaer || CRM.activities._showMore
        ? `<button class="qf-btn" onclick="CRM.activities.toggleMore('${contactId}')">${CRM.activities._showMore ? '▴ Weniger' : '▾ Mehr'}</button>${secondary}`
        : ''}
      <button class="qf-btn ${CRM.activities._hideErledigt ? 'active' : ''}" style="margin-left:auto" title="Erledigte Aktivitäten aus-/einblenden" onclick="CRM.activities.toggleHideErledigt('${contactId}')">${CRM.activities._hideErledigt ? '👁 Erledigte zeigen' : '✓ Erledigte ausblenden'}</button>
    </div>
    <div class="act-list">
      ${zeilen || '<p style="color:var(--text-dim);font-size:13px;margin:8px 0">Noch keine Aktivitäten' + (f !== 'alle' ? ' in dieser Kategorie' : '') + '.</p>'}
    </div>
    <div class="row" style="gap:6px;margin-top:12px;flex-wrap:wrap">
      <button class="btn btn-sm" onclick="CRM.activities.openEintrag('${contactId}','angebot')">📄 Angebot vermerken</button>
      <button class="btn btn-sm" onclick="CRM.activities.openEintrag('${contactId}','info')">📝 Notiz</button>
      <button class="btn btn-sm" onclick="CRM.activities.openEintrag('${contactId}','reklamation')">⚠️ Reklamation</button>
      <button class="btn btn-sm" onclick="CRM.activities.openEintrag('${contactId}','schulung')">🎓 Schulung</button>
    </div>`;
};

/* Besuch (erneut) in Excel ablegen — öffnet den bekannten Ablage-Dialog. */
CRM.activities.fileVisit = function (contactId, visitId) {
  const c = CRM.db.getContact(contactId);
  const v = c && (c.visits || []).find((x) => x.id === visitId);
  if (!v) return;
  CRM.ablage.openDialog(contactId, { id: v.id, date: v.date, note: v.note || '' });
};

/* Eintrag löschen — mit Undo-Sicherung, da Verlust sonst endgültig wäre. */
CRM.activities.remove = function (contactId, quelle, id) {
  const c = CRM.db.getContact(contactId);
  CRM.takeSnapshot('Vor Löschen eines Aktivitäts-Eintrags');
  if (quelle === 'visit') CRM._removeVisit(contactId, id);
  else if (quelle === 'comm') CRM.db.deleteComm(id);
  else if (quelle === 'journal') CRM.db.deleteJournalEntry(id);
  else if (quelle === 'task') CRM.db.deleteTask(id);
  CRM.renderContactDetailModal(contactId);
  CRM.toastUndo('Eintrag bei „' + (c ? CRM.displayNameDisambig(c) : '') + '" gelöscht.');
};

/* ============================================================
   Status einer Aktivität: offen / in Arbeit / erledigt (+ Datum)
   ============================================================ */
CRM.activities.toggleHideErledigt = function (contactId) {
  CRM.activities._hideErledigt = !CRM.activities._hideErledigt;
  CRM.activities.refresh(contactId);
};

CRM.activities._getStatus = function (contactId, quelle, id) {
  let o = null;
  if (quelle === 'visit') { const c = CRM.db.getContact(contactId); o = (c && (c.visits || []).find((v) => v.id === id)) || null; }
  else if (quelle === 'comm') o = CRM.db.getComm(id);
  else if (quelle === 'journal') o = CRM.db.getJournalEntries().find((x) => x.id === id);
  o = o || {};
  return { status: o.status || 'offen', erledigtAm: o.erledigtAm || '' };
};

CRM.activities.statusDialog = function (contactId, quelle, id) {
  const akt = CRM.activities._getStatus(contactId, quelle, id);
  const heute = new Date().toISOString().slice(0, 10);
  const opt = (val, label) => `<label class="act-status-opt"><input type="radio" name="akt-status" value="${val}" ${akt.status === val ? 'checked' : ''}> ${label}</label>`;
  CRM.openModal(`
    <h2>Status der Aktivität</h2>
    <div class="row" style="flex-direction:column;gap:10px;margin:12px 0">
      ${opt('offen', '⚪ Offen')}
      ${opt('inArbeit', '🟠 In Arbeit')}
      ${opt('erledigt', '🟢 Erledigt')}
    </div>
    <div class="row" style="align-items:center;gap:8px">
      <label style="margin:0">Erledigt am</label>
      <input type="date" id="akt-erledigt-datum" value="${escAttr(akt.erledigtAm || heute)}" style="max-width:170px">
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.renderContactDetailModal('${contactId}')">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.activities.saveStatus('${contactId}','${quelle}','${id}')">💾 Speichern</button>
    </div>
  `, { dismissible: false });
};

CRM.activities.saveStatus = function (contactId, quelle, id) {
  const sel = document.querySelector('input[name="akt-status"]:checked');
  const status = sel ? sel.value : 'offen';
  const datum = (document.getElementById('akt-erledigt-datum') || {}).value || '';
  const patch = { status, erledigtAm: status === 'erledigt' ? datum : '' };
  if (quelle === 'visit') CRM.updateVisit(contactId, id, patch);
  else if (quelle === 'comm') CRM.db.updateComm(id, patch);
  else if (quelle === 'journal') { const j = CRM.db.getJournalEntries().find((x) => x.id === id); if (j) { Object.assign(j, patch); CRM.db.saveJournal(); } }
  CRM.renderContactDetailModal(contactId);
  CRM.toast('Status: ' + { offen: 'Offen', inArbeit: 'In Arbeit', erledigt: 'Erledigt' }[status], 'success');
};

/* Neuen Eintrag anlegen — Typ vorgegeben, Datum und Projekt wählbar. */
CRM.activities.openEintrag = function (contactId, typ) {
  const label = CRM.JOURNAL_TYPE_LABELS[typ] || typ;
  const projectOpts = CRM.db.getProjects()
    .map((p) => `<option value="${p.id}">${((p.kategorie || 'baustelle') === 'gross' ? '🏢 ' : '🏠 ')}${esc2(p.name)}</option>`).join('');
  CRM.openModal(`
    <h2>${label}</h2>
    <label>Was ist passiert?</label>
    <textarea id="act-text" rows="3" placeholder="${typ === 'angebot' ? 'z.B. Lehmputz Mineral 20, 240 m² — Angebot per Mail' : 'Kurz beschreiben...'}"></textarea>
    <div class="row" style="margin-top:8px;flex-wrap:wrap;gap:8px">
      <div class="col" style="max-width:170px"><label>Datum</label>
        <input type="date" id="act-datum" value="${new Date().toISOString().slice(0, 10)}"></div>
      <div class="col" style="min-width:200px"><label>Bauvorhaben / Projekt (optional)</label>
        <select id="act-projekt"><option value="">Kein Projekt</option>${projectOpts}</select></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.renderContactDetailModal('${contactId}')">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.activities.saveEintrag('${contactId}','${typ}')">💾 Speichern</button>
    </div>
  `, { dismissible: false });
  setTimeout(() => { const t = document.getElementById('act-text'); if (t) t.focus(); }, 60);
};

CRM.activities.saveEintrag = function (contactId, typ) {
  const text = (document.getElementById('act-text').value || '').trim();
  if (!text) { CRM.toast('Bitte kurz beschreiben, was passiert ist.', 'error'); return; }
  const datum = document.getElementById('act-datum').value;
  const projectId = document.getElementById('act-projekt').value || null;
  CRM.db.addJournalEntry({
    contactId, entryType: typ, content: text, projectId,
    inputMethod: 'manual',
    createdAt: datum ? new Date(datum + 'T12:00:00').toISOString() : new Date().toISOString(),
  });
  CRM.renderContactDetailModal(contactId);
  CRM.toast('✓ ' + (CRM.JOURNAL_TYPE_LABELS[typ] || typ) + ' gespeichert.', 'success');
};

/* ============================================================
   Eintrag bearbeiten — Besuche, Journal-Einträge und Mails.
   Wichtig: „📍 Besuch heute" legt einen Eintrag OHNE Notiz an;
   diese muss nachtragbar sein, sonst ist der Vorgang wertlos.
   ============================================================ */
CRM.activities.edit = function (contactId, quelle, id) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  let datum = '', text = '', betreff = null, titel = 'Eintrag bearbeiten';
  let richtung = null, projektId = ''; // nur für E-Mails (comm)

  if (quelle === 'visit') {
    const v = (c.visits || []).find((x) => x.id === id);
    if (!v) return;
    datum = v.date || ''; text = v.note || ''; titel = '📍 Besuch bearbeiten';
  } else if (quelle === 'journal') {
    const j = CRM.db.getJournalEntries().find((x) => x.id === id);
    if (!j) return;
    datum = (j.createdAt || '').slice(0, 10); text = j.content || '';
    titel = (CRM.JOURNAL_TYPE_LABELS[j.entryType] || 'Eintrag') + ' bearbeiten';
  } else if (quelle === 'comm') {
    const m = CRM.db.getComm(id);
    if (!m) return;
    datum = m.date || ''; text = m.body || ''; betreff = m.subject || '';
    richtung = m.direction || 'in'; projektId = (m.projectIds || [])[0] || '';
    titel = '✉ E-Mail bearbeiten';
  } else if (quelle === 'task') {
    const t = CRM.db.getTask(id);
    if (!t) return;
    datum = (t.doneAt || t.due || '').slice(0, 10); text = t.title || '';
    titel = '✓ Aufgabe bearbeiten';
  }

  // Projekt-Auswahl (nur E-Mails): das aktuell zugeordnete vorwählen
  const projektOpts = CRM.db.getProjects()
    .map((p) => `<option value="${p.id}" ${p.id === projektId ? 'selected' : ''}>${((p.kategorie || 'baustelle') === 'gross' ? '🏢 ' : '🏠 ')}${esc2(p.name)}</option>`).join('');

  CRM.openModal(`
    <h2>${titel}</h2>
    <div class="row" style="flex-wrap:wrap;gap:8px">
      <div class="col" style="max-width:170px"><label>Datum</label>
        <input type="date" id="ae-datum" value="${escAttr(datum)}"></div>
      ${betreff !== null ? `<div class="col" style="min-width:200px"><label>Betreff</label>
        <input id="ae-betreff" value="${escAttr(betreff)}"></div>` : ''}
    </div>
    ${richtung !== null ? `<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:8px">
      <div class="col" style="max-width:170px"><label>Richtung</label>
        <select id="ae-richtung">
          <option value="in" ${richtung === 'in' ? 'selected' : ''}>Eingehend</option>
          <option value="out" ${richtung === 'out' ? 'selected' : ''}>Ausgehend</option>
        </select></div>
      <div class="col" style="min-width:200px"><label>Bauvorhaben / Projekt</label>
        <select id="ae-projekt"><option value="">Kein Projekt</option>${projektOpts}</select></div>
    </div>` : ''}
    <label style="margin-top:8px">${quelle === 'task' ? 'Aufgabe' : (quelle === 'comm' ? 'Text' : 'Notiz')}</label>
    <textarea id="ae-text" rows="${quelle === 'comm' ? 8 : 4}" placeholder="Was wurde besprochen / notiert?">${esc2(text)}</textarea>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.renderContactDetailModal('${contactId}')">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.activities.saveEdit('${contactId}','${quelle}','${id}')">💾 Speichern</button>
    </div>
  `, { dismissible: false });
  setTimeout(() => { const t = document.getElementById('ae-text'); if (t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); } }, 60);
};

CRM.activities.saveEdit = function (contactId, quelle, id) {
  const datum = (document.getElementById('ae-datum') || {}).value || '';
  const text = (document.getElementById('ae-text') || {}).value || '';
  const betreffEl = document.getElementById('ae-betreff');

  if (quelle === 'visit') {
    CRM.updateVisit(contactId, id, { date: datum, note: text });
    CRM.renderContactList();
  } else if (quelle === 'journal') {
    const j = CRM.db.getJournalEntries().find((x) => x.id === id);
    if (j) {
      j.content = text;
      if (datum) j.createdAt = new Date(datum + 'T12:00:00').toISOString();
      CRM.db.saveJournal();
    }
  } else if (quelle === 'comm') {
    const patch = { date: datum, body: text, subject: betreffEl ? betreffEl.value : undefined };
    const richtungEl = document.getElementById('ae-richtung');
    if (richtungEl) patch.direction = richtungEl.value;
    const projektEl = document.getElementById('ae-projekt');
    if (projektEl) patch.projectIds = projektEl.value ? [projektEl.value] : [];
    CRM.db.updateComm(id, patch);
  } else if (quelle === 'task') {
    CRM.db.updateTask(id, { title: text, due: datum });
  }
  CRM.renderContactDetailModal(contactId);
  CRM.toast('✓ Eintrag aktualisiert.', 'success');
};
