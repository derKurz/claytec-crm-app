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
    });
  });

  CRM.db.getTasksForContact(contactId).filter((t) => t.done).forEach((t) => {
    list.push({
      kat: 'aufgabe', icon: '✓', label: 'Aufgabe erledigt',
      datum: (t.doneAt || t.due || '').slice(0, 10), text: t.title,
      projectId: t.projectId || null, quelle: 'task', id: t.id,
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
  const gefiltert = (f === 'alle') ? alle : alle.filter((a) => a.kat === f);

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
    const farbe = CRM.activities.FARBE[a.kat] || '#888780';
    const p = a.projectId ? CRM.db.getProject(a.projectId) : null;
    const projChip = p
      ? `<span class="badge" style="cursor:pointer;margin-top:4px" onclick="event.stopPropagation();CRM.closeModal();CRM.switchTab('projekte');CRM.openProjectDetail('${p.id}')">${(p.kategorie || 'baustelle') === 'gross' ? '🏢' : '🏠'} ${esc2(p.name)}</span>`
      : '';
    const datum = a.datum ? a.datum.split('-').reverse().join('.') : '—';
    return `
      <div class="act-row">
        <span class="act-dot" style="background:${farbe}"></span>
        <div class="act-main">
          <div class="act-head">
            <strong>${a.icon} ${esc2(a.label)}</strong>
            <span class="act-date">${esc2(datum)}</span>
          </div>
          <div class="act-text">${esc2(a.text)}</div>
          ${projChip}
          ${a.eingehendeMail ? `
            <div class="act-actions">
              <button class="btn btn-sm" onclick="event.stopPropagation();CRM.mailAntwort.prepare('${contactId}','${a.id}')">🤖 Antwort vorbereiten</button>
              <button class="btn btn-sm" onclick="event.stopPropagation();CRM.mailAntwort.dokumentieren('${contactId}','${a.id}')">✉ Antwort dokumentieren</button>
            </div>` : ''}
        </div>
        <button class="btn btn-sm act-del" title="Eintrag löschen"
          onclick="CRM.activities.remove('${contactId}','${a.quelle}','${a.id}')">✕</button>
      </div>`;
  }).join('');

  return `
    <div class="quick-filters" style="margin:0 0 10px">
      ${primary}
      ${hatSekundaer || CRM.activities._showMore
        ? `<button class="qf-btn" onclick="CRM.activities.toggleMore('${contactId}')">${CRM.activities._showMore ? '▴ Weniger' : '▾ Mehr'}</button>${secondary}`
        : ''}
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

/* Eintrag löschen — mit Undo-Sicherung, da Verlust sonst endgültig wäre. */
CRM.activities.remove = function (contactId, quelle, id) {
  const c = CRM.db.getContact(contactId);
  CRM.takeSnapshot('Vor Löschen eines Aktivitäts-Eintrags');
  if (quelle === 'visit') CRM._removeVisit(contactId, id);
  else if (quelle === 'comm') CRM.db.deleteComm(id);
  else if (quelle === 'journal') CRM.db.deleteJournalEntry(id);
  else if (quelle === 'task') CRM.db.deleteTask(id);
  CRM.renderContactDetailModal(contactId);
  CRM.toastUndo('Eintrag bei „' + (c ? c.firma1 : '') + '" gelöscht.');
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
