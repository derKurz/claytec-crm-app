/* ============================================================
   Claytec CRM — Kontaktprofil (Cloze-Layout):
   Stammdaten → Beziehung (Tags/Nächster Schritt) → Verknüpfungen → Timeline
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}
function esc2(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
}

/* Kontakt formatiert (Adresse, Ansprechpartner, Notiz, To Do, Besuchshistorie)
   in die Zwischenablage legen — als Rich-Text, damit OneNote/Word die
   Formatierung beim Einfügen (Strg+V) übernimmt; Klartext als Fallback. */
CRM.copyForOneNote = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  const addr = CRM.formatAddress(c);
  const ap = c.ansprechpartner || {};
  const apName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const visits = (c.visits || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  const textLines = [`${c.firma1}${c.isPartner ? ' (Partner)' : ''}`];
  if (addr) textLines.push(addr);
  if (apName) textLines.push(`Ansprechpartner: ${apName}${ap.funktion ? ' (' + ap.funktion + ')' : ''}`);
  if (c.telFirma) textLines.push(`Tel: ${c.telFirma}`);
  if (c.emailFirma) textLines.push(`E-Mail: ${c.emailFirma}`);
  if (c.notiz) textLines.push(`Notiz: ${c.notiz}`);
  if (c.nextStep) textLines.push(`To Do: ${c.nextStep}`);
  textLines.push('', 'Besuchshistorie:');
  textLines.push(...(visits.length ? visits.map((v) => `${v.date}: ${v.note || '(ohne Notiz)'}`) : ['(noch keine Besuche)']));
  const text = textLines.join('\n');

  let html = `<div><b style="font-size:14px">${esc2(c.firma1)}${c.isPartner ? ' ⭐ Partner' : ''}</b><br>`;
  if (addr) html += `${esc2(addr)}<br>`;
  if (apName) html += `Ansprechpartner: ${esc2(apName)}${ap.funktion ? ' (' + esc2(ap.funktion) + ')' : ''}<br>`;
  if (c.telFirma) html += `Tel: ${esc2(c.telFirma)}<br>`;
  if (c.emailFirma) html += `E-Mail: ${esc2(c.emailFirma)}<br>`;
  if (c.notiz) html += `Notiz: ${esc2(c.notiz)}<br>`;
  if (c.nextStep) html += `To Do: ${esc2(c.nextStep)}<br>`;
  html += '<br><b>Besuchshistorie</b><ul>';
  html += visits.length
    ? visits.map((v) => `<li>${esc2(v.date)}: ${esc2(v.note || '(ohne Notiz)')}</li>`).join('')
    : '<li>(noch keine Besuche)</li>';
  html += '</ul></div>';

  CRM._copyRichText(html, text).then(() => {
    CRM.toast('Für OneNote kopiert — jetzt mit Strg+V in eine Seite einfügen.', 'success');
  }).catch(() => {
    CRM.toast('Kopieren fehlgeschlagen — Zwischenablage-Berechtigung prüfen.', 'error');
  });
};

CRM._copyRichText = async function (html, text) {
  if (navigator.clipboard && window.ClipboardItem) {
    try {
      const item = new ClipboardItem({
        'text/html': new Blob([html], { type: 'text/html' }),
        'text/plain': new Blob([text], { type: 'text/plain' }),
      });
      await navigator.clipboard.write([item]);
      return;
    } catch (e) {
      // Manche Browser/Kontexte blockieren HTML-Zwischenablage — auf Klartext ausweichen
    }
  }
  await navigator.clipboard.writeText(text);
};

/* Kontakt-Steckbrief für Notion in die Zwischenablage legen.
   Notion nimmt beim Einfügen bevorzugt die HTML-Variante (→ saubere Blöcke
   mit Überschriften/Listen); der Klartext ist Markdown als Fallback, den
   Notion ebenfalls in Blöcke umwandelt. Kundendaten bleiben lokal — es wird
   nur kopiert, nichts an Notion gesendet. */
CRM.copyForNotion = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  const addr = CRM.formatAddress(c);
  const ap = c.ansprechpartner || {};
  const apName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const visits = (c.visits || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1));

  const md = [];
  md.push(`# ${c.firma1}${c.isPartner ? ' ⭐ (Claytec-Partner)' : ''}`);
  md.push('');
  const meta = [`**Typ:** ${CRM.TYPE_LABELS[c.type]}`, `**Einstufung:** ${c.abc}`];
  if (c.erpNr) meta.push(`**ERP-/Kundennr.:** ${c.erpNr}`);
  md.push(meta.join('  ·  '));
  md.push('');
  md.push('## Kontakt');
  if (addr) md.push(`- **Adresse:** ${addr}`);
  if (apName) md.push(`- **Ansprechpartner:** ${apName}${ap.funktion ? ' (' + ap.funktion + ')' : ''}`);
  if (c.telFirma) md.push(`- **Telefon:** ${c.telFirma}`);
  if (ap.telefon) md.push(`- **Telefon (AP):** ${ap.telefon}`);
  if (c.emailFirma) md.push(`- **E-Mail:** ${c.emailFirma}`);
  if (ap.email) md.push(`- **E-Mail (AP):** ${ap.email}`);
  if (c.website) md.push(`- **Website:** ${c.website}`);
  if (c.nextStep) { md.push(''); md.push('## Nächster Schritt'); md.push(c.nextStep); }
  if (c.notiz) { md.push(''); md.push('## Notiz'); md.push(c.notiz); }
  md.push('');
  md.push('## Besuchshistorie');
  if (visits.length) visits.forEach((v) => md.push(`- **${v.date}:** ${v.note || '(ohne Notiz)'}`));
  else md.push('- (noch keine Besuche)');
  const text = md.join('\n');

  let html = `<h1>${esc2(c.firma1)}${c.isPartner ? ' ⭐ (Claytec-Partner)' : ''}</h1>`;
  html += `<p><b>Typ:</b> ${esc2(CRM.TYPE_LABELS[c.type])} · <b>Einstufung:</b> ${esc2(c.abc)}${c.erpNr ? ' · <b>ERP-/Kundennr.:</b> ' + esc2(c.erpNr) : ''}</p>`;
  html += '<h2>Kontakt</h2><ul>';
  if (addr) html += `<li><b>Adresse:</b> ${esc2(addr)}</li>`;
  if (apName) html += `<li><b>Ansprechpartner:</b> ${esc2(apName)}${ap.funktion ? ' (' + esc2(ap.funktion) + ')' : ''}</li>`;
  if (c.telFirma) html += `<li><b>Telefon:</b> ${esc2(c.telFirma)}</li>`;
  if (ap.telefon) html += `<li><b>Telefon (AP):</b> ${esc2(ap.telefon)}</li>`;
  if (c.emailFirma) html += `<li><b>E-Mail:</b> ${esc2(c.emailFirma)}</li>`;
  if (ap.email) html += `<li><b>E-Mail (AP):</b> ${esc2(ap.email)}</li>`;
  if (c.website) html += `<li><b>Website:</b> ${esc2(c.website)}</li>`;
  html += '</ul>';
  if (c.nextStep) html += `<h2>Nächster Schritt</h2><p>${esc2(c.nextStep)}</p>`;
  if (c.notiz) html += `<h2>Notiz</h2><p>${esc2(c.notiz)}</p>`;
  html += '<h2>Besuchshistorie</h2><ul>';
  html += visits.length
    ? visits.map((v) => `<li><b>${esc2(v.date)}:</b> ${esc2(v.note || '(ohne Notiz)')}</li>`).join('')
    : '<li>(noch keine Besuche)</li>';
  html += '</ul>';

  CRM._copyRichText(html, text).then(() => {
    CRM.toast('Für Notion kopiert — in Notion mit Strg+V als neue Seite einfügen.', 'success');
  }).catch(() => {
    CRM.toast('Kopieren fehlgeschlagen — Zwischenablage-Berechtigung prüfen.', 'error');
  });
};

/* Hinterlegte Notion-Seite im Browser/in der Notion-App öffnen. */
CRM.openNotion = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  let url = (c.notionUrl || '').trim();
  if (!url) {
    CRM.toast('Noch kein Notion-Link hinterlegt — Feld oben ausfüllen und verlassen (speichert automatisch).', 'error');
    return;
  }
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  window.open(url, '_blank', 'noopener');
};

CRM.renderContactDetailModal = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) {
    CRM.toast('Kontakt nicht gefunden', 'error');
    return;
  }
  const due = CRM.getDueStatus(c);
  const dueLabelMap = { overdue: 'Überfällig', today: 'Heute fällig', week: 'Diese Woche fällig', ok: 'OK (' + due.diffDays + ' Tage)' };

  const typeOptions = CRM.TYPES.map((t) => `<option value="${t}" ${c.type === t ? 'selected' : ''}>${CRM.TYPE_LABELS[t]}</option>`).join('');
  const sourceOptions = CRM.SOURCES.map((s) => `<option value="${s}" ${c.source === s ? 'selected' : ''}>${CRM.SOURCE_LABELS[s]}</option>`).join('');
  const abcOptions = CRM.ABC.map((a) => `<option value="${a}" ${c.abc === a ? 'selected' : ''}>${a}</option>`).join('');

  const tagsHtml = (c.tags || []).map((t) => `<span class="badge">${esc2(t)} <span style="cursor:pointer;opacity:.7" onclick="CRM.removeTag('${c.id}','${escAttr(t)}')">✕</span></span>`).join(' ') || '<span style="color:var(--text-dim);font-size:12px">Keine Tags</span>';

  const linksHtml = CRM.renderLinksSection(c);

  // Besuche + abgelegte E-Mails/Kommunikation in EINER Timeline (nach Datum)
  const commRows = CRM.db.getCommsForContact(c.id).map((m) => ({ kind: 'comm', date: m.date || '', m }));
  const visitRows = (c.visits || []).map((v) => ({ kind: 'visit', date: v.date || '', v }));
  const merged = commRows.concat(visitRows).sort((a, b) => (a.date < b.date ? 1 : -1));

  const commHtml = (m) => {
    const dirLabel = m.direction === 'out' ? '📤 ausgehend' : '📥 eingehend';
    const typeLabel = m.type === 'email' ? `✉ E-Mail (${dirLabel})` : (CRM.COMM_TYPE_LABELS[m.type] || m.type);
    return `
      <div class="list-item" style="cursor:default;align-items:flex-start">
        <div class="li-main">
          <div class="li-title">${esc2(m.date)} · ${typeLabel}${m.subject ? ': ' + esc2(m.subject) : ''}</div>
          <details><summary style="cursor:pointer;color:var(--text-dim);font-size:12px">Text anzeigen</summary>
            <div class="li-sub" style="white-space:pre-wrap;margin-top:4px">${esc2((m.body || '').slice(0, 2000))}</div>
          </details>
        </div>
        <button class="btn btn-sm" title="Löschen" onclick="CRM.db.deleteComm('${m.id}');CRM.renderContactDetailModal('${c.id}')">🗑</button>
      </div>`;
  };

  const timelineHtml = merged.length
    ? merged.map((e) => (e.kind === 'comm' ? commHtml(e.m) : ((v) => `
      <div class="list-item" style="cursor:default;align-items:flex-start">
        <div class="li-main" id="visit-view-${v.id}">
          <div class="li-title">${esc2(v.date)}</div>
          <div class="li-sub">${esc2(v.note) || '<span style="color:var(--text-dim)">(ohne Notiz)</span>'}</div>
        </div>
        <div id="visit-edit-${v.id}" class="hidden" style="flex:1">
          <div class="row">
            <div class="col" style="max-width:150px"><input type="date" id="vedit-date-${v.id}" value="${esc2(v.date)}"></div>
            <div class="col"><textarea id="vedit-note-${v.id}" rows="2">${esc2(v.note || '')}</textarea></div>
          </div>
          <button class="btn btn-sm btn-primary" onclick="CRM.saveVisitEdit('${c.id}','${v.id}')">Speichern</button>
          <button class="btn btn-sm" onclick="CRM.renderContactDetailModal('${c.id}')">Abbrechen</button>
        </div>
        <div style="display:flex;gap:4px">
          <button class="btn btn-sm" title="Bearbeiten" onclick="CRM.editVisit('${v.id}')">✏️</button>
          <button class="btn btn-sm" title="Löschen" onclick="CRM.deleteVisit('${c.id}','${v.id}')">🗑</button>
          <button class="btn btn-sm" title="In Besuchsprotokoll + Monatsbericht ablegen" onclick='CRM.ablage.openDialog("${c.id}", ${JSON.stringify({ date: v.date, note: v.note || '' }).replace(/'/g, "&#39;")})'>📋</button>
        </div>
      </div>`)(e.v))).join('')
    : '<p style="color:var(--text-dim);font-size:13px">Noch keine Besuche oder E-Mails erfasst.</p>';

  const html = `
    <div class="cd-header">
      <div>
        <h2 style="margin:0 0 6px">${esc2(c.firma1)} ${c.isPartner ? '⭐' : ''}</h2>
        <div class="li-badges">
          <span class="badge badge-${c.type}">${CRM.TYPE_LABELS[c.type]}</span>
          <span class="badge badge-${c.abc}">${c.abc}</span>
          <span class="badge">${CRM.SOURCE_LABELS[c.source]}</span>
          <span class="badge ${due.status === 'overdue' ? 'badge-overdue' : ''}">${dueLabelMap[due.status]}</span>
          <button class="badge" style="cursor:pointer;border-color:var(--accent);color:var(--accent)" title="Region im Regionen-Tab öffnen" onclick="CRM.closeModal();CRM.goToRegion('${CRM.regionForPlz(c.plz)}')">📍 ${esc2(CRM.regionNameForPlz(c.plz))}</button>
        </div>
        <div class="li-badges" style="margin-top:8px">${CRM.quickActionButtons(c)}</div>
      </div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-icon" title="vCard (.vcf) erstellen — für Google Kontakte" onclick="CRM.vcard.exportContact('${c.id}')">📇</button>
        <button class="btn btn-icon" title="Kontakt löschen" onclick="CRM.deleteContactFromDetail('${c.id}')">🗑</button>
        <button class="btn btn-icon" onclick="CRM.closeModal()">✕</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Stammdaten</h3>
      <div style="font-size:12px;color:var(--text-dim);margin-bottom:10px;padding:6px 10px;background:var(--bg);border-radius:6px">
        ℹ️ Datenherkunft: ${CRM.formatProvenance(c)}
      </div>
      <div class="row">
        <div class="col"><label>Firma 1</label><input data-field="firma1" value="${escAttr(c.firma1)}"></div>
        <div class="col"><label>Firma 2 / Zusatz</label><input data-field="firma2" value="${escAttr(c.firma2)}"></div>
        <div class="col" style="max-width:150px"><label>ERP-/Kundennr.</label><input data-field="erpNr" value="${escAttr(c.erpNr || '')}" placeholder="z.B. 22769"></div>
      </div>
      <div class="row">
        <div class="col"><label>Straße</label><input data-field="strasse" value="${escAttr(c.strasse)}"></div>
        <div class="col" style="max-width:110px"><label>PLZ</label><input data-field="plz" value="${escAttr(c.plz)}"></div>
        <div class="col"><label>Ort</label><input data-field="ort" value="${escAttr(c.ort)}"></div>
      </div>
      <div class="row">
        <div class="col"><label>Telefon</label><input data-field="telFirma" value="${escAttr(c.telFirma)}"></div>
        <div class="col"><label>E-Mail</label><input data-field="emailFirma" value="${escAttr(c.emailFirma)}"></div>
        <div class="col"><label>Website</label><input data-field="website" value="${escAttr(c.website || '')}"></div>
      </div>
      <div class="row">
        <div class="col"><label>Ansprechpartner Vorname</label><input data-ap="vorname" value="${escAttr(c.ansprechpartner.vorname)}"></div>
        <div class="col"><label>Ansprechpartner Nachname</label><input data-ap="name" value="${escAttr(c.ansprechpartner.name)}"></div>
        <div class="col"><label>Funktion</label><input data-ap="funktion" value="${escAttr(c.ansprechpartner.funktion || '')}"></div>
      </div>
      <div class="row">
        <div class="col"><label>Telefon Ansprechpartner</label><input data-ap="telefon" value="${escAttr(c.ansprechpartner.telefon)}"></div>
        <div class="col"><label>E-Mail Ansprechpartner</label><input data-ap="email" value="${escAttr(c.ansprechpartner.email)}"></div>
      </div>
      <div class="row">
        <div class="col"><label>Typ</label><select data-field="type">${typeOptions}</select></div>
        <div class="col"><label>Einstufung</label><select data-field="abc">${abcOptions}</select></div>
        <div class="col"><label>Listenquelle</label><select data-field="source">${sourceOptions}</select></div>
        <div class="col" style="display:flex;align-items:flex-end;padding-bottom:9px">
          <label style="margin:0;display:flex;align-items:center;gap:6px;color:var(--text)">
            <input type="checkbox" id="cd-partner" ${c.isPartner ? 'checked' : ''} style="width:auto"> Claytec-Partner ⭐
          </label>
        </div>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Beziehung</h3>
      <label>Nächster Schritt</label>
      <input data-field="nextStep" value="${escAttr(c.nextStep || '')}" placeholder="z.B. Angebot nachfassen, Muster vorbeibringen...">
      <label style="margin-top:12px">Tags</label>
      <div class="li-badges" id="cd-tags">${tagsHtml}</div>
      <input id="cd-new-tag" placeholder="Tag eingeben + Enter" style="margin-top:6px">
    </div>

    <div class="card">
      <h3 style="margin-top:0">📓 Notion</h3>
      <label>Link zur Notion-Seite</label>
      <div class="row" style="align-items:flex-end">
        <div class="col"><input data-field="notionUrl" value="${escAttr(c.notionUrl || '')}" placeholder="Notion-Seite verlinken (URL einfügen)"></div>
        <button class="btn" style="min-height:44px" onclick="CRM.openNotion('${c.id}')">↗ In Notion öffnen</button>
      </div>
      <button class="btn btn-sm" style="margin-top:8px" onclick="CRM.copyForNotion('${c.id}')">📋 Steckbrief für Notion kopieren</button>
      <p style="color:var(--text-dim);font-size:12px;margin:6px 0 0">Kopiert Firma, Kontakt und Besuchshistorie als Notion-fähigen Text — in Notion mit Strg+V (Handy: Einfügen) als neue Seite ablegen. Kundendaten bleiben lokal; Notion ist nur für Wissen/Doku.</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Verknüpfungen</h3>
      <div id="cd-links">${linksHtml}</div>
      <div class="row" style="margin-top:8px">
        <button class="btn btn-sm" onclick="CRM.openLinkPicker('${c.id}')">+ Kontakt verknüpfen</button>
        <button class="btn btn-sm" onclick="CRM.openContactProjectPicker('${c.id}')">+ Projekt verknüpfen</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Aufgaben</h3>
      <div id="cd-tasks">${CRM.renderContactTasks(c.id)}</div>
      <div class="row" style="margin-top:8px;align-items:flex-end">
        <div class="col"><input id="cd-task-title" placeholder="Neue Aufgabe für diesen Kontakt" onkeydown="if(event.key==='Enter')CRM.addContactTask('${c.id}')"></div>
        <div class="col" style="max-width:160px"><input type="date" id="cd-task-due" value="${new Date().toISOString().slice(0, 10)}"></div>
        <button class="btn btn-primary" style="min-height:44px" onclick="CRM.addContactTask('${c.id}')">💾 Aufgabe speichern</button>
      </div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">📓 Kontaktjournal <span style="font-size:11px;color:var(--text-dim);font-weight:400">(fortlaufend, kein Besuchsbericht, kein Export)</span></h3>
      <div class="row" style="margin-bottom:10px;align-items:flex-end">
        <div class="col" style="max-width:140px"><label>Art</label><select id="cd-journal-type">${CRM.JOURNAL_TYPES.map((t) => `<option value="${t}">${CRM.JOURNAL_TYPE_LABELS[t]}</option>`).join('')}</select></div>
        <div class="col"><label>Notiz</label><input id="cd-journal-text" placeholder="z.B. kurzes Telefonat, Zwischenstand..."></div>
        <button class="btn btn-sm" onclick="CRM.addJournalEntryFromDetail('${c.id}')">+ Eintrag</button>
      </div>
      <div id="cd-journal-list">${CRM.renderJournalForContact(c.id)}</div>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Besuche & E-Mails</h3>
      <div class="row" style="margin-bottom:10px">
        <button class="btn btn-primary" onclick="CRM.quickVisitToday('${c.id}')">📍 Besuch heute</button>
        <button class="btn" onclick="CRM.speech.openCapture('${c.id}')">🎤 Sprachnotiz</button>
        <button class="btn" onclick="CRM.mailAblage.open('${c.id}')">📧 E-Mail ablegen</button>
        <button class="btn" onclick="CRM.muster.open('${c.id}')">📦 Muster schicken</button>
      </div>
      <details style="margin-bottom:10px">
        <summary style="cursor:pointer;color:var(--text-dim);font-size:13px">+ Eintrag mit Datum/Notiz manuell hinzufügen</summary>
        <div class="row" style="margin-top:8px">
          <div class="col" style="max-width:160px"><label>Datum</label><input type="date" id="cd-visit-date" value="${new Date().toISOString().slice(0, 10)}"></div>
          <div class="col"><label>Notiz</label><textarea id="cd-visit-note" placeholder="Was wurde besprochen?"></textarea></div>
        </div>
        <button class="btn btn-sm" onclick="CRM.saveManualVisit('${c.id}')">Eintrag speichern</button>
      </details>
      <div id="cd-timeline">${timelineHtml}</div>
    </div>
  `;

  const overlay = CRM.openModal(html);
  overlay.querySelector('.modal').classList.add('modal-wide');
  CRM.wireContactDetailEvents(c.id);
};

/* Kontakt vollständig löschen — mit Undo-Snapshot, da unwiderruflich
   ohne Backup (Lehre aus der Merge-Funktion, siehe CRM.takeSnapshot). */
CRM.deleteContactFromDetail = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  if (!confirm('„' + c.firma1 + '" wirklich vollständig löschen? Besuche, Aufgaben, Journal-Einträge und Verknüpfungen gehen mit verloren.')) return;
  CRM.takeSnapshot('Vor Löschen von Kontakt „' + c.firma1 + '"');
  CRM.db.deleteContact(id);
  CRM.closeModal();
  CRM.renderContactList();
  CRM.toastUndo('Kontakt „' + c.firma1 + '" gelöscht.');
};

/* ---------- Inline-Edit Wiring ---------- */
CRM.wireContactDetailEvents = function (id) {
  const modal = document.querySelector('#active-modal-overlay .modal');
  modal.querySelectorAll('input[data-field], select[data-field]').forEach((el) => {
    el.addEventListener('change', () => {
      CRM.db.updateContact(id, { [el.dataset.field]: el.value });
      if (['strasse', 'plz', 'ort', 'land'].includes(el.dataset.field)) {
        CRM.geocoding.markStale(id);
        CRM.geocoding.geocodeSingle(id);
      }
      CRM.renderContactList();
    });
  });
  modal.querySelectorAll('input[data-ap]').forEach((el) => {
    el.addEventListener('change', () => {
      const c = CRM.db.getContact(id);
      c.ansprechpartner[el.dataset.ap] = el.value;
      c.updatedAt = new Date().toISOString();
      CRM.db.saveContacts();
    });
  });
  document.getElementById('cd-partner').addEventListener('change', (e) => {
    CRM.db.updateContact(id, { isPartner: e.target.checked });
    CRM.renderContactList();
  });
  // PLZ eingeben → Ort automatisch ergänzen (wenn leer); programmatisches
  // Setzen feuert kein change-Event, daher explizit speichern + geocoden
  CRM.wirePlzOrtAutofill(
    modal.querySelector('input[data-field="plz"]'),
    modal.querySelector('input[data-field="ort"]'),
    (ort) => {
      CRM.db.updateContact(id, { ort });
      CRM.geocoding.markStale(id);
      CRM.geocoding.geocodeSingle(id);
      CRM.renderContactList();
    }
  );
  document.getElementById('cd-new-tag').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && e.target.value.trim()) {
      CRM.addTag(id, e.target.value.trim());
      e.target.value = '';
    }
  });
};

/* Datenherkunft transparent (Perplexity-Lehre: "Woher stammt diese Info?") */
CRM.formatProvenance = function (c) {
  const sources = (c._sources && c._sources.length ? c._sources : [c.source]).map((s) => CRM.SOURCE_LABELS[s] || s);
  let txt = 'Quelle: ' + sources.join(', ');
  if (c._importFile) txt += ' · importiert aus „' + c._importFile + '"';
  if (c.createdAt) txt += ' · angelegt ' + new Date(c.createdAt).toLocaleDateString('de-DE');
  if (c.updatedAt && c.updatedAt !== c.createdAt) txt += ' · zuletzt geändert ' + new Date(c.updatedAt).toLocaleDateString('de-DE');
  return txt;
};

/* Aufgaben im Kontaktprofil */
CRM.renderContactTasks = function (contactId) {
  const tasks = CRM.db.getTasksForContact(contactId).sort((a, b) => (a.done - b.done) || ((a.due || '') < (b.due || '') ? -1 : 1));
  if (!tasks.length) return '<p style="color:var(--text-dim);font-size:13px">Keine offenen Aufgaben.</p>';
  return tasks.map((t) => {
    const st = CRM.getTaskDueStatus(t);
    const cls = st.status === 'overdue' ? 'badge-overdue' : '';
    return `<div class="list-item" style="cursor:default">
      <input type="checkbox" style="width:auto;margin-right:10px" ${t.done ? 'checked' : ''} onchange="CRM.toggleContactTask('${t.id}','${contactId}')">
      <div class="li-main"><div class="li-title" style="${t.done ? 'text-decoration:line-through;opacity:.6' : ''}">${esc2(t.title)}</div>
        <div class="li-sub"><span class="badge ${cls}">fällig ${esc2(t.due)}</span></div></div>
      <button class="btn btn-sm" onclick="CRM.db.deleteTask('${t.id}');CRM.renderContactDetailModal('${contactId}')">🗑</button>
    </div>`;
  }).join('');
};
CRM.addContactTask = function (contactId) {
  const title = document.getElementById('cd-task-title').value.trim();
  const due = document.getElementById('cd-task-due').value;
  if (!title) {
    CRM.toast('Bitte Aufgabentitel eingeben.', 'error');
    return;
  }
  CRM.db.addTask({ title, due, contactId });
  CRM.toast(`✓ Aufgabe gespeichert: „${title}" (fällig ${due})`, 'success');
  CRM.renderContactDetailModal(contactId);
};
CRM.toggleContactTask = function (taskId, contactId) {
  const t = CRM.db.getTask(taskId);
  if (t) CRM.db.updateTask(taskId, { done: !t.done, doneAt: !t.done ? new Date().toISOString() : null });
  CRM.renderContactDetailModal(contactId);
};

/* ---------- Kontaktjournal (fortlaufend, kein Besuchsbericht) ---------- */
CRM.renderJournalForContact = function (contactId) {
  const entries = CRM.db.getJournalForContact(contactId).slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  if (!entries.length) return '<p style="color:var(--text-dim);font-size:13px">Noch keine Journal-Einträge.</p>';
  return entries.map((j) => `
    <div class="list-item" style="cursor:default;align-items:flex-start">
      <div class="li-main">
        <div class="li-title">${esc2(CRM.JOURNAL_TYPE_LABELS[j.entryType] || j.entryType)} · ${new Date(j.createdAt).toLocaleDateString('de-DE')}</div>
        <div class="li-sub">${esc2(j.content)}</div>
      </div>
      <button class="btn btn-sm" title="Löschen" onclick="CRM.deleteJournalEntryFromDetail('${contactId}','${j.id}')">🗑</button>
    </div>`).join('');
};
CRM.addJournalEntryFromDetail = function (contactId) {
  const type = document.getElementById('cd-journal-type').value;
  const text = document.getElementById('cd-journal-text').value.trim();
  if (!text) {
    CRM.toast('Bitte Text eingeben.', 'error');
    return;
  }
  CRM.db.addJournalEntry({ contactId, entryType: type, content: text, inputMethod: 'manual' });
  CRM.renderContactDetailModal(contactId);
};
CRM.deleteJournalEntryFromDetail = function (contactId, journalId) {
  if (!confirm('Diesen Journal-Eintrag wirklich löschen?')) return;
  CRM.db.deleteJournalEntry(journalId);
  CRM.renderContactDetailModal(contactId);
};

/* Projekt mit Kontakt verknüpfen (von der Kontaktseite aus) */
CRM.openContactProjectPicker = function (contactId) {
  const projects = CRM.db.getProjects();
  const c = CRM.db.getContact(contactId);
  const linked = new Set(c.links.projektIds || []);
  const list = projects.length ? projects.map((p) => `
    <div class="list-item" onclick="CRM.pickContactProject('${contactId}','${p.id}')">
      <div class="li-main"><div class="li-title">${esc2(p.name)}</div>
      <div class="li-sub">${CRM.PROJECT_STATUS_LABELS[p.status]}${p.ort ? ' · ' + esc2(p.ort) : ''}</div></div>
      ${linked.has(p.id) ? '<span class="badge">verknüpft</span>' : ''}
    </div>`).join('') : '<p style="color:var(--text-dim)">Noch keine Projekte. Lege im Projekte-Tab eines an.</p>';
  CRM.openModal(`
    <h2>Projekt verknüpfen</h2>
    <div style="max-height:50vh;overflow-y:auto">${list}</div>
    <div class="modal-footer">
      <button class="btn btn-sm" onclick="CRM.createProjectFromContact('${contactId}')">+ Neues Projekt anlegen</button>
      <button class="btn" onclick="CRM.openContactDetail('${contactId}')">Zurück</button>
    </div>
  `);
};
CRM.pickContactProject = function (contactId, projectId) {
  CRM.linkContactToProject(contactId, projectId);
  CRM.toast('Projekt verknüpft.', 'success');
  CRM.openContactDetail(contactId);
};
CRM.createProjectFromContact = function (contactId) {
  const p = CRM.makeEmptyProject();
  p.name = 'Neues Projekt';
  CRM.db.addProject(p);
  CRM.linkContactToProject(contactId, p.id);
  CRM.toast('Projekt angelegt und verknüpft.', 'success');
  CRM.openProjectDetail(p.id);
};

CRM.addTag = function (id, tag) {
  const c = CRM.db.getContact(id);
  c.tags = c.tags || [];
  if (!c.tags.includes(tag)) c.tags.push(tag);
  CRM.db.saveContacts();
  CRM.renderContactDetailModal(id);
};
CRM.removeTag = function (id, tag) {
  const c = CRM.db.getContact(id);
  c.tags = (c.tags || []).filter((t) => t !== tag);
  CRM.db.saveContacts();
  CRM.renderContactDetailModal(id);
};

/* ---------- Besuchshistorie ---------- */
CRM.quickVisitToday = function (id) {
  CRM.addVisit(id, new Date().toISOString().slice(0, 10), '');
  CRM.toast('Besuch heute erfasst.', 'success');
  CRM.renderContactDetailModal(id);
  CRM.renderContactList();
};
CRM.saveManualVisit = function (id) {
  const date = document.getElementById('cd-visit-date').value || new Date().toISOString().slice(0, 10);
  const note = document.getElementById('cd-visit-note').value || '';
  CRM.addVisit(id, date, note);
  CRM.toast('Eintrag gespeichert.', 'success');
  CRM.renderContactDetailModal(id);
  CRM.renderContactList();
};

/* ---- Besuch bearbeiten / löschen ---- */
CRM.editVisit = function (visitId) {
  document.getElementById('visit-view-' + visitId).classList.add('hidden');
  document.getElementById('visit-edit-' + visitId).classList.remove('hidden');
};
CRM.saveVisitEdit = function (contactId, visitId) {
  const date = document.getElementById('vedit-date-' + visitId).value;
  const note = document.getElementById('vedit-note-' + visitId).value;
  CRM.updateVisit(contactId, visitId, { date: date, note: note });
  CRM.toast('Besuch aktualisiert.', 'success');
  CRM.renderContactDetailModal(contactId);
  CRM.renderContactList();
};
CRM.deleteVisit = function (contactId, visitId) {
  if (!confirm('Diesen Besuchseintrag wirklich löschen?')) return;
  CRM._removeVisit(contactId, visitId);
  CRM.toast('Besuch gelöscht.', 'success');
  CRM.renderContactDetailModal(contactId);
  CRM.renderContactList();
};

/* ============================================================
   Verknüpfungen — Anzeige + Link-Picker
   ============================================================ */
CRM.renderLinksSection = function (c) {
  const groups = [
    { field: 'haendlerIds', label: 'Händler' },
    { field: 'verarbeiterIds', label: 'Verarbeiter' },
    { field: 'architektIds', label: 'Architekten' },
  ];
  let html = '';
  groups.forEach((g) => {
    const ids = (c.links && c.links[g.field]) || [];
    if (!ids.length) return;
    const chips = ids.map((linkedId) => {
      const lc = CRM.db.getContact(linkedId);
      if (!lc) return '';
      const label = c.linkMeta && c.linkMeta[linkedId];
      return `<span class="badge" style="cursor:pointer" onclick="CRM.openContactDetail('${lc.id}')">${esc2(lc.firma1)}${label ? ' <em style="opacity:.7;font-style:normal">· ' + esc2(label) + '</em>' : ''}
        <span style="cursor:pointer;opacity:.7" onclick="event.stopPropagation();CRM.unlinkAndRefresh('${c.id}','${lc.id}')">✕</span></span>`;
    }).join(' ');
    html += `<div style="margin-bottom:8px"><label style="margin-bottom:4px">${g.label}</label><div class="li-badges">${chips}</div></div>`;
  });
  const projIds = (c.links && c.links.projektIds) || [];
  if (projIds.length) {
    const chips = projIds.map((pid) => {
      const p = CRM.db.getProject(pid);
      if (!p) return '';
      return `<span class="badge badge-status-${p.status}" style="cursor:pointer" onclick="CRM.closeModal();CRM.openProjectDetail('${pid}')">${esc2(p.name)}
        <span style="cursor:pointer;opacity:.7" onclick="event.stopPropagation();CRM.unlinkProjectAndRefresh('${c.id}','${pid}')">✕</span></span>`;
    }).join(' ');
    html += `<div style="margin-bottom:8px"><label style="margin-bottom:4px">Projekte</label><div class="li-badges">${chips}</div></div>`;
  }
  if (!html) html = '<p style="color:var(--text-dim);font-size:13px">Noch keine Verknüpfungen.</p>';
  return html;
};

CRM.unlinkAndRefresh = function (idA, idB) {
  CRM.unlinkContacts(idA, idB);
  CRM.renderContactDetailModal(idA);
};
CRM.unlinkProjectAndRefresh = function (contactId, projectId) {
  CRM.unlinkContactFromProject(contactId, projectId);
  CRM.renderContactDetailModal(contactId);
};

CRM.openLinkPicker = function (contactId) {
  CRM._linkPicker = { contactId, query: '', typeFilter: 'all', multi: false, selected: new Set(), label: '' };
  CRM.renderLinkPicker();
};

CRM.renderLinkPicker = function () {
  const { contactId, multi } = CRM._linkPicker;
  const filterBtns = ['all', 'haendler', 'verarbeiter', 'architekt'].map(
    (t) => `<button class="qf-btn ${t === 'all' ? 'active' : ''}" data-t="${t}" onclick="CRM.setLinkPickerFilter('${t}')">${t === 'all' ? 'Alle' : CRM.TYPE_LABELS[t]}</button>`
  ).join('');

  CRM.openModal(`
    <h2>Verknüpfung hinzufügen</h2>
    <div class="row" style="justify-content:space-between;align-items:center">
      <input id="link-picker-search" placeholder="Suche Firma, Ort, PLZ..." style="flex:1">
      <button class="btn btn-sm" id="link-picker-multi-toggle" style="margin-left:8px">${multi ? '✕ Mehrfachauswahl beenden' : '☑ Mehrere auswählen'}</button>
    </div>
    <div class="quick-filters" id="link-picker-filters" style="margin-top:8px">${filterBtns}</div>
    ${multi ? `
    <label style="margin-top:10px">Beziehung (optional, z.B. „Empfehlung")</label>
    <input id="link-picker-label" placeholder="z.B. Empfehlung für Projekt X" value="${escAttr(CRM._linkPicker.label)}">
    ` : ''}
    <div style="margin-top:10px;max-height:45vh;overflow-y:auto" id="link-picker-results"></div>
    <div class="modal-footer">
      ${multi ? `<button class="btn btn-primary" id="link-picker-bulk-go" disabled>0 verknüpfen</button>` : ''}
      <button class="btn" onclick="CRM.openContactDetail('${contactId}')">Zurück zum Kontakt</button>
    </div>
  `);
  document.getElementById('link-picker-search').addEventListener('input', (e) => {
    CRM._linkPicker.query = e.target.value;
    CRM.updateLinkPickerResults();
  });
  document.getElementById('link-picker-multi-toggle').addEventListener('click', () => {
    CRM._linkPicker.multi = !CRM._linkPicker.multi;
    CRM._linkPicker.selected = new Set();
    CRM.renderLinkPicker();
  });
  if (multi) {
    document.getElementById('link-picker-label').addEventListener('input', (e) => {
      CRM._linkPicker.label = e.target.value;
    });
    document.getElementById('link-picker-bulk-go').addEventListener('click', CRM.commitBulkLink);
  }
  CRM.updateLinkPickerResults();
};

CRM.setLinkPickerFilter = function (t) {
  CRM._linkPicker.typeFilter = t;
  document.querySelectorAll('#link-picker-filters .qf-btn').forEach((b) => b.classList.toggle('active', b.dataset.t === t));
  CRM.updateLinkPickerResults();
};

CRM.updateLinkPickerResults = function () {
  const { contactId, query, typeFilter, multi, selected } = CRM._linkPicker;
  const self = CRM.db.getContact(contactId);
  const linkedIds = new Set([].concat(self.links.haendlerIds || [], self.links.verarbeiterIds || [], self.links.architektIds || []));
  const q = query.toLowerCase();
  const results = CRM.db.getContacts()
    .filter((c) => c.id !== contactId)
    .filter((c) => typeFilter === 'all' || c.type === typeFilter)
    .filter((c) => !q || (c.firma1 + ' ' + c.ort + ' ' + c.plz).toLowerCase().includes(q))
    .slice(0, 60);

  const html = results.length ? results.map((c) => `
    <div class="list-item" onclick="${multi ? `CRM.toggleBulkSelect('${c.id}')` : `CRM.pickLink('${c.id}')`}">
      ${multi ? `<input type="checkbox" style="width:auto;margin-right:8px" ${selected.has(c.id) ? 'checked' : ''} onclick="event.stopPropagation();CRM.toggleBulkSelect('${c.id}')">` : ''}
      <div class="li-main">
        <div class="li-title">${esc2(c.firma1)}</div>
        <div class="li-sub">${CRM.TYPE_LABELS[c.type]} · ${esc2(c.plz)} ${esc2(c.ort)}</div>
      </div>
      ${linkedIds.has(c.id) ? '<span class="badge">verknüpft</span>' : ''}
    </div>`).join('') : '<p style="color:var(--text-dim)">Keine Treffer</p>';

  document.getElementById('link-picker-results').innerHTML = html;
};

CRM.toggleBulkSelect = function (id) {
  const sel = CRM._linkPicker.selected;
  if (sel.has(id)) sel.delete(id); else sel.add(id);
  CRM.updateLinkPickerResults();
  const btn = document.getElementById('link-picker-bulk-go');
  if (btn) { btn.textContent = sel.size + ' verknüpfen'; btn.disabled = sel.size === 0; }
};

CRM.commitBulkLink = function () {
  const { contactId, selected, label } = CRM._linkPicker;
  if (!selected.size) return;
  CRM.linkContactsBulk(contactId, Array.from(selected), label.trim());
  CRM.toast(selected.size + ' Verknüpfung(en) hinzugefügt.', 'success');
  CRM.openContactDetail(contactId);
};

CRM.pickLink = function (otherId) {
  CRM.linkContacts(CRM._linkPicker.contactId, otherId);
  CRM.toast('Verknüpfung hinzugefügt.', 'success');
  CRM.openContactDetail(CRM._linkPicker.contactId);
};

/* ============================================================
   Musterversand: Muster/Prospekte für einen Kontakt auswählen und
   als fertige Bestell-Mail öffnen. Die Auswahlliste pflegst du in
   den Einstellungen (aus deiner Werbemittel-Liste).
   Zusätzlich wird der Versand im Kontaktjournal dokumentiert.
   ============================================================ */
CRM.muster = { _contactId: null };

CRM.muster.getListe = function () {
  return String(CRM.db.getSettings().musterListe || '')
    .split('\n').map((z) => z.trim()).filter(Boolean);
};

CRM.muster.open = function (contactId) {
  CRM.muster._contactId = contactId;
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  const liste = CRM.muster.getListe();

  if (!liste.length) {
    CRM.openModal(`
      <h2>📦 Muster schicken</h2>
      <p>Es ist noch keine Muster-/Prospektliste hinterlegt.</p>
      <p style="color:var(--text-dim);font-size:13px">Trag deine Auswahl einmalig unter <strong>Einstellungen → 📦 Musterversand</strong> ein (ein Eintrag pro Zeile) — danach steht sie hier immer als Auswahl bereit.</p>
      <div class="modal-footer">
        <button class="btn" onclick="CRM.closeModal()">Schließen</button>
        <button class="btn btn-primary" onclick="CRM.closeModal();CRM.switchTab('einstellungen')">Zu den Einstellungen</button>
      </div>`);
    return;
  }

  const ap = c.ansprechpartner || {};
  const empfName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const checks = liste.map((item, i) => `
    <label style="display:flex;align-items:center;gap:8px;padding:8px 6px;border-bottom:1px solid var(--border);cursor:pointer;min-height:44px">
      <input type="checkbox" class="muster-item" value="${escAttr(item)}" style="width:auto">
      <span>${esc2(item)}</span>
    </label>`).join('');

  CRM.openModal(`
    <h2>📦 Muster schicken — ${esc2(c.firma1)}</h2>
    <p style="color:var(--text-dim);font-size:13px">Auswählen, was der Kunde braucht — daraus wird eine fertige Bestell-Mail.</p>
    <div style="max-height:38vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;padding:0 8px;margin-bottom:10px">${checks}</div>
    <label>Zusätzliche Anmerkung (optional)</label>
    <input id="muster-note" placeholder="z.B. bitte an Baustelle senden, eilt">
    <div class="row" style="margin-top:10px">
      <div class="col"><label>Lieferanschrift</label>
        <textarea id="muster-adresse" rows="3">${esc2([c.firma1, empfName ? 'z.Hd. ' + empfName : '', c.strasse, [c.plz, c.ort].filter(Boolean).join(' ')].filter(Boolean).join('\n'))}</textarea></div>
    </div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn" onclick="CRM.muster.copy()">📋 Kopieren</button>
      <button class="btn btn-primary" onclick="CRM.muster.send()">✉ Bestell-Mail öffnen</button>
    </div>
  `, { dismissible: false });
};

CRM.muster._collect = function () {
  const c = CRM.db.getContact(CRM.muster._contactId);
  const items = Array.from(document.querySelectorAll('.muster-item:checked')).map((el) => el.value);
  const note = (document.getElementById('muster-note') || {}).value || '';
  const adresse = (document.getElementById('muster-adresse') || {}).value || '';
  const betreff = `Musterversand: ${c ? c.firma1 : ''}${c && c.erpNr ? ' (ERP ' + c.erpNr + ')' : ''}`;
  const body = [
    'Hallo zusammen,',
    '',
    'bitte folgende Muster/Unterlagen versenden:',
    '',
    ...items.map((i) => '- ' + i),
    '',
    'Lieferanschrift:',
    adresse,
    ...(note ? ['', 'Anmerkung: ' + note] : []),
    '',
    'Danke und Grüße',
  ].join('\n');
  return { c, items, betreff, body };
};

CRM.muster.send = function () {
  const { c, items, betreff, body } = CRM.muster._collect();
  if (!items.length) { CRM.toast('Bitte mindestens ein Muster auswählen.', 'error'); return; }
  const to = CRM.db.getSettings().musterEmail || '';
  const link = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(betreff)}&body=${encodeURIComponent(body)}`;
  // Versand im Journal dokumentieren (kein Excel-Export, wie beim Journal üblich)
  CRM.db.addJournalEntry({ contactId: c.id, type: 'mail', text: 'Muster angefordert: ' + items.join(', ') });
  CRM.closeModal();
  window.location.href = link;
  CRM.toast(`✓ Bestell-Mail vorbereitet (${items.length} Positionen) — im Journal vermerkt.`, 'success');
};

CRM.muster.copy = function () {
  const { c, items, betreff, body } = CRM.muster._collect();
  if (!items.length) { CRM.toast('Bitte mindestens ein Muster auswählen.', 'error'); return; }
  CRM._copyRichText(`<pre>${esc2(betreff)}\n\n${esc2(body)}</pre>`, betreff + '\n\n' + body).then(() => {
    CRM.db.addJournalEntry({ contactId: c.id, type: 'mail', text: 'Muster angefordert: ' + items.join(', ') });
    CRM.closeModal();
    CRM.toast(`✓ Kopiert (${items.length} Positionen) — im Journal vermerkt.`, 'success');
  }).catch(() => CRM.toast('Kopieren fehlgeschlagen.', 'error'));
};
