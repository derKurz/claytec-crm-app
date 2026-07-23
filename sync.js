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
