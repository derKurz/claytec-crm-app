/* ============================================================
   Claytec CRM — Eingang-Sync (Handy → OneDrive → Laptop)
   Da localStorage pro Gerät isoliert ist und die Excel-Ablage nur am
   Desktop läuft (File System Access API), merkt sich die App auf dem
   Handy, welche Kontakte/Besuche neu sind, und exportiert sie als
   kleine JSON-Datei in den OneDrive-"Eingang"-Ordner (per native
   Teilen-Funktion). Am Laptop liest CRM.ablage.processEingang() diesen
   Ordner aus und verarbeitet die Einträge automatisch — inkl. Excel-Ablage.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.sync = {
  KEY: 'crm_pending_sync',
};

CRM.sync.getPendingIds = function () {
  return new Set(CRM.storage.read(CRM.sync.KEY, []));
};

CRM.sync.markPending = function (contactId) {
  if (!contactId) return;
  const ids = CRM.sync.getPendingIds();
  ids.add(contactId);
  CRM.storage.write(CRM.sync.KEY, Array.from(ids));
};

CRM.sync.pendingCount = function () {
  return CRM.sync.getPendingIds().size;
};

CRM.sync.clearPending = function (ids) {
  if (!ids) { CRM.storage.write(CRM.sync.KEY, []); return; }
  const remaining = Array.from(CRM.sync.getPendingIds()).filter((id) => !ids.includes(id));
  CRM.storage.write(CRM.sync.KEY, remaining);
};

/* Bündelt alle ausstehenden Kontakte/Besuche in eine JSON-Datei und
   teilt sie per OS-Teilen-Funktion (oder Download als Fallback). */
CRM.sync.exportEingang = async function () {
  const ids = Array.from(CRM.sync.getPendingIds());
  if (!ids.length) {
    CRM.toast('Keine neuen Änderungen zum Exportieren.', 'success');
    return;
  }
  const contacts = ids.map((id) => CRM.db.getContact(id)).filter(Boolean);
  const payload = { exportedAt: new Date().toISOString(), contacts };
  const filename = `eingang-${Date.now()}.json`;
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Claytec CRM — Eingang', text: 'In den OneDrive-Ordner "Eingang" speichern.' });
      CRM.sync.clearPending(ids);
      CRM.toast(`${contacts.length} Kontakt(e) zum Teilen übergeben.`, 'success');
      return;
    } catch (e) {
      if (e.name === 'AbortError') return; // Nutzer hat abgebrochen — Queue bleibt erhalten
      // Sonstiger Fehler: auf Download zurückfallen
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  CRM.sync.clearPending(ids);
  CRM.toast(`${contacts.length} Kontakt(e) als Datei heruntergeladen — bitte in den OneDrive-„Eingang"-Ordner verschieben.`, 'success');
};

/* Teilt/lädt eine einzelne JSON-Datei im selben Format wie exportEingang
   ({exportedAt, contacts:[...]}) — Basis für den Einzelbericht-Export
   (2.2): ein Bericht darf nie nur "im großen Eingang-Export" rettbar sein.
   Rührt NICHT an die Pending-Sync-Queue (CRM.sync.KEY) — das ist ein
   unabhängiger, jederzeit wiederholbarer Sicherungsweg für genau einen
   Bericht, unabhängig vom Handy→Laptop-Sync-Zustand. */
CRM.sync._shareOrDownloadJSON = async function (payload, filename, successMsg) {
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: 'Claytec CRM — Bericht', text: 'In den OneDrive-Ordner "Eingang" speichern (oder anderswo sichern).' });
      CRM.toast(successMsg + ' zum Teilen übergeben.', 'success');
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false; // Nutzer hat abgebrochen — nichts geändert
      // Sonstiger Fehler: auf Download zurückfallen
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  CRM.toast(successMsg + ' als Datei heruntergeladen.', 'success');
  return true;
};

/* Exportiert GENAU EINEN Bericht (Besuch) als eigenständige Datei — damit
   ein einzelner Bericht gesichert/gerettet werden kann, ohne den kompletten
   Eingang exportieren zu müssen (Ursache des früheren Datenverlusts). Die
   Datei hat dasselbe Format wie der normale Eingang-Export und kann bei
   Bedarf auch manuell in den "Eingang"-Ordner gelegt und dort wie gewohnt
   verarbeitet werden. */
CRM.sync.exportSingleVisit = async function (contactId, visitId) {
  const c = CRM.db.getContact(contactId);
  if (!c) { CRM.toast('Kontakt nicht gefunden.', 'error'); return; }
  const visit = (c.visits || []).find((v) => v.id === visitId);
  if (!visit) { CRM.toast('Bericht nicht gefunden.', 'error'); return; }
  const contactExport = Object.assign({}, c, { visits: [visit] });
  const payload = { exportedAt: new Date().toISOString(), contacts: [contactExport] };
  // Kennung im Dateinamen bewusst MIT Ort (2.3, Handy→Laptop): "Maier Baustoffe GmbH"
  // ohne Ort war am Laptop nicht zuordenbar. CRM.identifyingLabel() liefert
  // Name+Ort (analog zum Excel-Ordnernamen) und bei echter Dopplung zusätzlich
  // die Straße. Die eigentliche Ordnersuche (findCustomerDir) bleibt davon
  // unberührt — die liest weiterhin c.firma1/c.ort direkt aus dem
  // mitgesendeten Kontakt-Objekt.
  const kennung = CRM.ablage && CRM.ablage.sanitizeFile
    ? CRM.ablage.sanitizeFile(CRM.identifyingLabel(c))
    : (c.firma1 || 'kontakt');
  const safeName = (kennung || 'kontakt').replace(/\s+/g, '_');
  const filename = `bericht-${safeName}-${visit.date || 'ohne-datum'}-${Date.now()}.json`;
  await CRM.sync._shareOrDownloadJSON(payload, filename, '1 Bericht');
};

/* ============================================================
   Abgleich-Prüfung (Punkt 8, Chris 2026-10-02): "Tagesabschluss ist leer,
   obwohl ich viele Einträge am Handy gemacht habe — ich kann nicht
   nachvollziehen, wo die Berichte geblieben sind." Rein LESEND: schreibt
   nichts, ändert nichts. Zeigt (A) wie die Besuche auf DIESEM Gerät stehen
   und (B) wo die Besuche einer Backup-/Eingang-Datei hier gelandet sind.
   ============================================================ */
CRM.sync.zaehleBesuche = function (contacts) {
  const z = { gesamt: 0, mitNotiz: 0, ohneNotiz: 0, abgelegt: 0, abgelegtOhneZeit: 0, offen: 0 };
  (contacts || []).forEach((c) => (c.visits || []).forEach((v) => {
    z.gesamt++;
    const hatNotiz = !!(v.note && v.note.trim());
    if (hatNotiz) z.mitNotiz++; else z.ohneNotiz++;
    if (v.excelFiled) { z.abgelegt++; if (!v.excelFiledAt) z.abgelegtOhneZeit++; }
    else if (hatNotiz) z.offen++;
  }));
  return z;
};

/* Ordnet jeden Besuch der Datei einer Kategorie zu (Kontakt-ID + Besuchs-ID,
   Ersatz: gleiches Datum + gleiche Notiz, falls die Besuchs-ID abweicht). */
CRM.sync.vergleicheBesuche = function (fileData, contacts) {
  const byId = new Map((contacts || []).map((c) => [c.id, c]));
  const norm = (s) => String(s || '').trim();
  const counts = { 'fehlt-kontakt': 0, 'fehlt-besuch': 0, offen: 0, abgelegt: 0, konflikt: 0 };
  const rows = [];
  ((fileData && fileData.contacts) || []).forEach((fc) => {
    const local = byId.get(fc.id);
    (fc.visits || []).forEach((fv) => {
      const row = { datum: fv.date || '', firma: fc.firma1 || '', note: norm(fv.note), kat: '', grund: '' };
      if (!local) { row.kat = 'fehlt-kontakt'; row.grund = 'Kontakt existiert hier nicht'; }
      else {
        const lv = (local.visits || []).find((x) => x.id === fv.id)
          || (local.visits || []).find((x) => x.date === fv.date && norm(x.note) === norm(fv.note));
        if (!lv) { row.kat = 'fehlt-besuch'; row.grund = 'Kontakt vorhanden, Besuch fehlt hier'; }
        else if (norm(lv.note) !== norm(fv.note)) { row.kat = 'konflikt'; row.grund = 'Notiz hier anders als in der Datei'; }
        else if (!!lv.excelFiled !== !!fv.excelFiled) {
          row.kat = 'konflikt';
          row.grund = fv.excelFiled ? 'Datei: abgelegt — hier: offen' : 'Datei: offen — hier: abgelegt';
        } else { row.kat = lv.excelFiled ? 'abgelegt' : 'offen'; row.grund = lv.excelFiled ? 'hier abgelegt' : 'hier offen (im Tagesabschluss)'; }
      }
      counts[row.kat]++;
      rows.push(row);
    });
  });
  return { counts, rows };
};

CRM.sync._KAT_LABEL = {
  'fehlt-kontakt': '❌ Kontakt fehlt hier', 'fehlt-besuch': '❌ Besuch fehlt hier',
  offen: '🟡 hier offen', abgelegt: '✅ hier abgelegt', konflikt: '⚠️ Konflikt',
};

CRM.sync.openPruefung = function () {
  const z = CRM.sync.zaehleBesuche(CRM.db.getContacts());
  const excelOk = CRM.ablage && CRM.ablage.supported && CRM.ablage.supported();
  CRM.openModal(''
    + '<h2>🔍 Abgleich prüfen</h2>'
    + '<p style="color:var(--text-dim);font-size:13px">Nur Ansicht — es wird nichts geändert oder gesendet.</p>'
    + '<h3 style="margin:10px 0 4px">Dieses Gerät</h3>'
    + '<div style="font-size:14px;line-height:1.7">'
    + '<div>Besuche gesamt: <strong>' + z.gesamt + '</strong> (mit Notiz ' + z.mitNotiz + ', ohne Notiz ' + z.ohneNotiz + ' — ohne Notiz nie ablegbar)</div>'
    + '<div>In Excel abgelegt: <strong>' + z.abgelegt + '</strong>' + (z.abgelegtOhneZeit ? ' (davon ' + z.abgelegtOhneZeit + ' ohne Ablage-Zeitpunkt)' : '') + '</div>'
    + '<div>Offen = im Tagesabschluss („Alle offenen"): <strong>' + z.offen + '</strong></div>'
    + (excelOk ? '' : '<div style="color:var(--orange)">Excel-Ablage ist auf diesem Gerät nicht möglich (nur Chrome/Edge am Laptop) — am Handy gibt es keinen Tagesabschluss.</div>')
    + '</div>'
    + '<h3 style="margin:14px 0 4px">Datei vergleichen</h3>'
    + '<p style="color:var(--text-dim);font-size:13px">Backup (<code>claytec-crm-backup-….json</code>) oder <code>eingang-….json</code> wählen — zeigt, wo jeder Besuch daraus hier gelandet ist.</p>'
    + '<input type="file" id="pruef-file" accept=".json,application/json">'
    + '<div id="pruef-result" style="margin-top:10px"></div>'
    + '<div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>');
  document.getElementById('pruef-file').addEventListener('change', async (e) => {
    const f = e.target.files && e.target.files[0];
    const out = document.getElementById('pruef-result');
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || !Array.isArray(data.contacts)) throw new Error('keine Kontakte in der Datei');
      const res = CRM.sync.vergleicheBesuche(data, CRM.db.getContacts());
      CRM.sync._pruefRows = res.rows;
      const L = CRM.sync._KAT_LABEL;
      const summary = Object.keys(L).map((k) => '<div>' + L[k] + ': <strong>' + res.counts[k] + '</strong></div>').join('');
      const list = res.rows.slice().sort((a, b) => (a.datum < b.datum ? 1 : -1)).slice(0, 200).map((r) =>
        '<div class="list-item" style="cursor:default"><div class="li-main" style="min-width:0">'
        + '<div class="li-title">' + esc(r.firma) + ' · ' + esc(r.datum) + '</div>'
        + '<div style="font-size:12px;color:var(--text-dim)">' + esc(L[r.kat]) + ' — ' + esc(r.grund) + '</div>'
        + '<div style="font-size:12px;color:var(--text-dim)">' + esc(r.note.replace(/\s+/g, ' ').slice(0, 80)) + '</div>'
        + '</div></div>').join('');
      out.innerHTML = '<div style="font-size:14px;line-height:1.7">Datei: <strong>' + res.rows.length + '</strong> Besuche aus ' + data.contacts.length + ' Kontakten (Stand ' + esc(data.exportedAt || '?') + ')' + summary + '</div>'
        + '<div class="row" style="margin:8px 0"><button class="btn btn-sm" onclick="CRM.sync.kopierePruefliste()">📋 Liste kopieren</button></div>'
        + '<div style="max-height:35vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">' + list + '</div>';
    } catch (err) {
      out.innerHTML = '<p style="color:var(--red)">Datei konnte nicht gelesen werden: ' + esc(err.message) + '</p>';
    }
  });
};

CRM.sync.kopierePruefliste = function () {
  const L = CRM.sync._KAT_LABEL;
  const text = (CRM.sync._pruefRows || []).map((r) => [r.datum, r.firma, L[r.kat], r.grund].join(' | ')).join('\n');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => CRM.toast('Liste kopiert.', 'success'), () => CRM.toast('Kopieren fehlgeschlagen.', 'error'));
  } else CRM.toast('Kopieren in diesem Browser nicht verfügbar.', 'error');
};

/* ============================================================
   Notion-Feierabend-Block
   Sammelt alles, was seit dem letzten Notion-Export erfasst wurde
   (Besuche, Notizen, neu angelegte Aufgaben) und bündelt es je Kontakt
   MIT Notion-Link zu einem kopierfertigen Textblock. Diesen fügt Chris
   bei Claude ein („übertrage die Feierabend-Notizen nach Notion") —
   Claude schreibt sie über den Notion-Konnektor in die Seiten.
   Bewusst KEIN direkter Schreibzugriff aus der App: die App ist öffentlich
   gehostet, ein Notion-Token wäre dort angreifbar.
   ============================================================ */
CRM.notion = {};

CRM.notion._deDate = function (iso) {
  if (!iso) return '';
  const d = new Date((iso.length <= 10 ? iso + 'T12:00:00' : iso));
  if (isNaN(d)) return iso;
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
};

/* Sammelt neue Einträge seit `seitISO` (voller ISO-Zeitstempel).
   Gibt { kontakte:[{c, zeilen:[]}], ohneLink:[{c, zeilen}], anzahl } zurück. */
CRM.notion.collect = function (seitISO) {
  const grenze = seitISO || '0000';
  const mitLink = [];
  const ohneLink = [];
  let anzahl = 0;

  CRM.db.getContacts().forEach((c) => {
    const zeilen = [];
    (c.visits || []).forEach((v) => {
      if ((v.createdAt || (v.date + 'T12:00:00')) > grenze && (v.note || '').trim()) {
        zeilen.push({ ts: v.createdAt || v.date, text: '• ' + CRM.notion._deDate(v.date) + ' (Besuch): ' + v.note.trim() });
      }
    });
    CRM.db.getJournalForContact(c.id).forEach((j) => {
      if ((j.createdAt || '') > grenze && (j.content || '').trim()) {
        const label = j.entryType && j.entryType !== 'info' ? ' [' + j.entryType + ']' : '';
        zeilen.push({ ts: j.createdAt, text: '• ' + CRM.notion._deDate(j.createdAt) + ' (Notiz' + label + '): ' + j.content.trim() });
      }
    });
    CRM.db.getTasksForContact(c.id).forEach((t) => {
      if ((t.createdAt || '') > grenze && (t.title || '').trim()) {
        zeilen.push({ ts: t.createdAt, text: '• 📋 Aufgabe: ' + t.title.trim() + (t.due ? ' (fällig ' + CRM.notion._deDate(t.due) + ')' : '') });
      }
    });
    if (!zeilen.length) return;
    zeilen.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    anzahl += zeilen.length;
    (c.notionUrl && c.notionUrl.trim() ? mitLink : ohneLink).push({ c, zeilen: zeilen.map((z) => z.text) });
  });

  return { kontakte: mitLink, ohneLink, anzahl };
};

/* Baut den kopierfertigen Textblock. */
CRM.notion.buildText = function (daten) {
  const kopf = 'Bitte diese Notizen in die jeweils verlinkte Notion-Seite als neuen Notiz-Block eintragen (Datum voranstellen). Nur ergänzen, nichts löschen oder überschreiben.\n\n';
  const abschnitt = (e) => {
    const c = e.c;
    const titel = [c.firma1, c.erpNr ? 'ERP ' + c.erpNr : '', c.ort].filter(Boolean).join(' — ');
    return '## ' + titel + '\nNotion: ' + (c.notionUrl || '').trim() + '\n' + e.zeilen.join('\n');
  };
  return kopf + daten.kontakte.map(abschnitt).join('\n\n');
};

CRM.notion.getMarker = function () {
  return CRM.db.getSettings().lastNotionExportAt || '';
};

/* Öffnet den Feierabend-Dialog: Grenzdatum wählbar, Vorschau, kopieren,
   als übertragen markieren (setzt den Zeitstempel). */
CRM.notion.openDialog = function () {
  const marker = CRM.notion.getMarker();
  const defaultDatum = (marker ? marker.slice(0, 10) : new Date().toISOString().slice(0, 10));
  CRM.openModal(`
    <h2 style="margin-top:0">📓 Notion-Feierabend-Notizen</h2>
    <p style="color:var(--text-dim);font-size:13px;margin:4px 0 10px">Sammelt Besuche, Notizen und neue Aufgaben seit dem gewählten Tag. Den Block kopieren und bei Claude einfügen: „übertrage die Feierabend-Notizen nach Notion".</p>
    <div class="row" style="align-items:center;gap:8px;margin-bottom:10px">
      <label style="margin:0;font-size:13px">Einträge seit</label>
      <input type="date" id="notion-seit" value="${defaultDatum}" style="max-width:170px" onchange="CRM.notion.refresh()">
      <span id="notion-marker-hint" style="font-size:12px;color:var(--text-dim)">${marker ? 'letzter Export: ' + CRM.notion._deDate(marker) : 'noch kein Export'}</span>
    </div>
    <div id="notion-warn" style="font-size:12px;color:var(--orange);margin-bottom:8px"></div>
    <textarea id="notion-out" rows="12" style="width:100%;font-family:monospace;font-size:12px" readonly></textarea>
    <div class="row" style="margin-top:12px;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" onclick="CRM.notion.copy()">📋 Block kopieren</button>
      <button class="btn" onclick="CRM.notion.markiereUebertragen()">✓ Als übertragen markieren</button>
      <button class="btn" style="margin-left:auto" onclick="CRM.closeModal()">Schließen</button>
    </div>
  `);
  CRM.notion.refresh();
};

CRM.notion._seitISO = function () {
  const el = document.getElementById('notion-seit');
  const marker = CRM.notion.getMarker();
  // Feld unverändert auf dem Marker-Tag → exakten letzten Export-Zeitpunkt
  // nehmen, damit bereits Übertragenes nicht erneut erscheint. Wählt Chris
  // bewusst einen (früheren) Tag, gilt dieser ab 00:00.
  if (marker && el && el.value === marker.slice(0, 10)) return marker;
  const d = el && el.value ? el.value : new Date().toISOString().slice(0, 10);
  return new Date(d + 'T00:00:00').toISOString();
};

CRM.notion.refresh = function () {
  const daten = CRM.notion.collect(CRM.notion._seitISO());
  const out = document.getElementById('notion-out');
  const warn = document.getElementById('notion-warn');
  if (!out) return;
  if (!daten.anzahl) {
    out.value = '(Keine neuen Einträge im gewählten Zeitraum.)';
  } else if (!daten.kontakte.length) {
    out.value = '(Einträge vorhanden, aber bei keinem Kontakt ist ein Notion-Link hinterlegt.)';
  } else {
    out.value = CRM.notion.buildText(daten);
  }
  // Kontakte mit neuen Einträgen, aber ohne Notion-Link → Hinweis
  if (warn) {
    warn.textContent = daten.ohneLink.length
      ? '⚠️ Ohne Notion-Link (nicht im Block): ' + daten.ohneLink.map((e) => e.c.firma1).join(', ')
      : '';
  }
};

CRM.notion.copy = function () {
  const out = document.getElementById('notion-out');
  if (!out || !out.value || out.value.startsWith('(')) { CRM.toast('Nichts zu kopieren.', 'error'); return; }
  const fertig = () => CRM.toast('📋 Block kopiert — bei Claude einfügen: „übertrage die Feierabend-Notizen nach Notion".', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(out.value).then(fertig).catch(() => { out.select(); document.execCommand('copy'); fertig(); });
  } else { out.select(); try { document.execCommand('copy'); fertig(); } catch (e) { CRM.toast('Bitte Text markieren und mit Strg+C kopieren.', 'error'); } }
};

CRM.notion.markiereUebertragen = function () {
  CRM.db.saveSettings({ lastNotionExportAt: new Date().toISOString() });
  CRM.toast('✓ Als übertragen markiert — beim nächsten Mal erscheinen nur neuere Einträge.', 'success');
  const hint = document.getElementById('notion-marker-hint');
  if (hint) hint.textContent = 'letzter Export: gerade eben';
  CRM.notion.refresh();
};

/* ---------- Automatisches Mitschreiben: jede Kontakt-Änderung/jeder
   neue Besuch landet in der Pending-Queue, egal über welchen
   Eingabeweg (Schnell-Besuch, manuelle Notiz, Spracheingabe). ---------- */
(function () {
  const origAddContact = CRM.db.addContact.bind(CRM.db);
  CRM.db.addContact = function (c) {
    const r = origAddContact(c);
    CRM.sync.markPending(r.id);
    return r;
  };
  const origUpdateContact = CRM.db.updateContact.bind(CRM.db);
  CRM.db.updateContact = function (id, patch) {
    const r = origUpdateContact(id, patch);
    if (r) CRM.sync.markPending(id);
    return r;
  };
  const origAddVisit = CRM.addVisit;
  CRM.addVisit = function (contactId, dateStr, note) {
    const r = origAddVisit(contactId, dateStr, note);
    if (r) CRM.sync.markPending(contactId);
    return r;
  };
})();
