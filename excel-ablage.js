/* ============================================================
   Claytec CRM — Excel-Ablage (File System Access API + ExcelJS)
   Button am Besuch → Kundenordner finden/anlegen → Besuchsprotokoll
   befüllen → Monatsbericht-Zeile ergänzen. Nur Chrome/Edge Desktop.
   Schreiben über ExcelJS = Formatierung der Vorlagen bleibt erhalten.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.ablage = {
  rootHandle: null, // Handle auf den "Claytec"-Ordner
  TYPE_FOLDER: { architekt: '.AR', haendler: '.BH', verarbeiter: '.BU', behoerde: '.BU' },
  PROTO_TEMPLATE_DIR: 'Berichte - Reisekosten - Spesen',
  PROTO_TEMPLATE_FILE: 'Besuchsprotokoll - CK.xlsx',
  MONTH_BASE_DIR: 'Berichte - Reisekosten - Spesen',
  MONTH_TEMPLATE_REL: ['.Kunden', 'Berichtswesen_Vertrieb.xlsx'],
};

CRM.ablage.supported = function () {
  return typeof window.showDirectoryPicker === 'function';
};

/* ---------- Ordnerzugriff: einmal "Claytec"-Ordner wählen, in IndexedDB merken ---------- */
CRM.ablage.idbGet = function (key) {
  return new Promise((res) => {
    const open = indexedDB.open('claytec-crm-fs', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', 'readonly');
      const rq = tx.objectStore('handles').get(key);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror = () => res(null);
    };
    open.onerror = () => res(null);
  });
};
CRM.ablage.idbSet = function (key, val) {
  return new Promise((res) => {
    const open = indexedDB.open('claytec-crm-fs', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onsuccess = () => {
      const tx = open.result.transaction('handles', 'readwrite');
      tx.objectStore('handles').put(val, key);
      tx.oncomplete = () => res(true);
      tx.onerror = () => res(false);
    };
    open.onerror = () => res(false);
  });
};

CRM.ablage.verifyPermission = async function (handle) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if ((await handle.requestPermission(opts)) === 'granted') return true;
  return false;
};

CRM.ablage.connectRoot = async function () {
  if (!CRM.ablage.supported()) {
    CRM.toast('Dateizugriff nur in Chrome/Edge am Laptop möglich.', 'error');
    return null;
  }
  try {
    // startIn:'documents' bringt den Dialog in den Dokumente-Ordner (liegt bei
    // aktivierter OneDrive-Sicherung meist schon UNTER OneDrive) statt im zuletzt
    // benutzten Ort (z.B. Google Drive). Zum eigentlichen Claytec-Ordner
    // navigiert man dann über die Adressleiste des Windows-Dialogs.
    const handle = await window.showDirectoryPicker({ id: 'claytec-root', mode: 'readwrite', startIn: 'documents' });
    CRM.ablage.rootHandle = handle;
    await CRM.ablage.idbSet('claytecRoot', handle);
    CRM.toast('Claytec-Ordner verbunden: ' + handle.name, 'success');
    if (CRM.renderSettings && document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
    return handle;
  } catch (e) {
    if (e.name !== 'AbortError') CRM.toast('Ordner-Auswahl abgebrochen: ' + e.message, 'error');
    return null;
  }
};

CRM.ablage.ensureRoot = async function () {
  if (CRM.ablage.rootHandle) {
    if (await CRM.ablage.verifyPermission(CRM.ablage.rootHandle)) return CRM.ablage.rootHandle;
  }
  const stored = await CRM.ablage.idbGet('claytecRoot');
  if (stored && (await CRM.ablage.verifyPermission(stored))) {
    CRM.ablage.rootHandle = stored;
    return stored;
  }
  return CRM.ablage.connectRoot();
};

/* ---------- Namens-/Ordner-Helfer ---------- */
CRM.ablage.normalizeName = function (s) {
  return String(s || '').toLowerCase().replace(/[.,;\-_]/g, ' ').replace(/\s+/g, ' ').trim();
};

CRM.ablage.customerFolderName = function (c) {
  const parts = [CRM.displayName(c)];
  if (c.ort) parts.push(c.ort);
  let base = parts.filter(Boolean).join(', ');
  if (c.erpNr) base += ' - ' + c.erpNr;
  return CRM.ablage.sanitizeFile(base);
};
CRM.ablage.sanitizeFile = function (s) {
  return String(s || '').replace(/[\\/:*?"<>|]/g, '').trim();
};

/* Ähnlichkeit zweier (normalisierter) Ordner-/Kundennamen: Wortüberlappung
   (erkennt z.B. "Idrizi, Türkheim" als Teil von "Idrizi Putzbau Innen- und
   Aussenputz Wdvs, Türkheim") UND Levenshtein-Ähnlichkeit als Fallback für
   Tippfehler/Umstellungen. */
CRM.ablage.SIMILARITY_ASK_THRESHOLD = 0.65;
CRM.ablage.wordSet = function (s) {
  return new Set(String(s || '').split(/\s+/).filter((w) => w.length > 2));
};
CRM.ablage.folderSimilarity = function (normA, normB) {
  if (!normA || !normB) return 0;
  const wa = CRM.ablage.wordSet(normA);
  const wb = CRM.ablage.wordSet(normB);
  let overlap = 0;
  if (wa.size && wb.size) {
    let shared = 0;
    wa.forEach((w) => { if (wb.has(w)) shared++; });
    overlap = shared / Math.min(wa.size, wb.size);
  }
  const lev = typeof similarity === 'function' ? similarity(normA, normB) : 0;
  return Math.max(overlap, lev);
};

/* Bestehenden Kundenordner per Name/ERP-Nr finden — exakt (ERP-Nr. oder
   Name als Präfix/Teilstring) oder unsicher-ähnlich (zum Rückfragen). */
CRM.ablage.findCustomerDir = async function (typeDir, c) {
  const wantName = CRM.ablage.normalizeName(c.firma1);
  // Vollständiger erwarteter Ordnername: "Firma, Ort - ErpNr"
  const wantFull = CRM.ablage.normalizeName(CRM.ablage.customerFolderName(c));
  const wantErpDigits = String(c.erpNr || '').replace(/\D/g, '');
  let exact = null;
  let fuzzy = null;

  // Prüft einen einzelnen Ordner-Eintrag gegen den gesuchten Kunden.
  const consider = (entry) => {
    if (entry.kind !== 'directory' || exact) return;
    // 1) ERP-/Kundennummer-Treffer = eindeutig (exakte Zahl im Ordnernamen,
    //    egal wie der Firmenname geschrieben ist).
    if (wantErpDigits.length >= 3 && (entry.name.match(/\d+/g) || []).includes(wantErpDigits)) { exact = entry; return; }
    const norm = CRM.ablage.normalizeName(entry.name);
    // 2) Name stimmt überein ODER beginnt mit dem Firmennamen.
    if (norm === wantFull || (wantName && norm.startsWith(wantName))) { exact = entry; return; }
    // 3) Ähnlichkeit (Wortüberlappung) → Rückfrage.
    const score = CRM.ablage.folderSimilarity(norm, wantFull);
    if (score >= CRM.ablage.SIMILARITY_ASK_THRESHOLD && (!fuzzy || score > fuzzy.score)) fuzzy = { entry, score };
  };

  for await (const entry of typeDir.values()) {
    if (entry.kind !== 'directory') continue;
    consider(entry);
    if (exact) break;
    // Eine Ebene tiefer suchen — fängt VERSCHACHTELTE Kundenordner ab,
    // z.B. .BH\BayWa\BayWa, Lauf - 51157 (Sammelordner „BayWa" darüber).
    try {
      for await (const sub of entry.values()) { consider(sub); if (exact) break; }
    } catch (e) { /* kein Zugriff / keine Unterordner */ }
    if (exact) break;
  }
  return { exact, fuzzy };
};

/* Alle Kundenordner in einem Typ-Verzeichnis flach einsammeln (inkl. einer
   Ebene Unterordner, z.B. Sammelordner "BayWa") — Basis für die manuelle
   Ordnersuche im Ablage-Dialog (2.1), wenn findCustomerDir keinen exakten
   Treffer liefert. */
CRM.ablage.listAllFolders = async function (typeDir) {
  const out = [];
  for await (const entry of typeDir.values()) {
    if (entry.kind !== 'directory') continue;
    out.push({ entry, display: entry.name, norm: CRM.ablage.normalizeName(entry.name) });
    try {
      for await (const sub of entry.values()) {
        if (sub.kind !== 'directory') continue;
        const display = entry.name + ' \\ ' + sub.name;
        out.push({ entry: sub, display, norm: CRM.ablage.normalizeName(display) });
      }
    } catch (e) { /* kein Zugriff / keine Unterordner */ }
  }
  out.sort((a, b) => a.display.localeCompare(b.display, 'de'));
  return out;
};

/* ============================================================
   Ordner-Auswahl-Dialog (2.1): wenn findCustomerDir keinen exakten Treffer
   liefert, muss Chris den richtigen Ordner manuell finden können — per
   angezeigtem Ähnlich-Vorschlag ODER per Live-Suche über ALLE Ordner im
   Typ-Verzeichnis — oder bewusst einen neuen Ordner anlegen.

   WICHTIG (Datenverlust-Vermeidung, Anlass: verlorener Bericht 04.08.2026):
   Der Bericht (visit/monthEssence) lebt ausschließlich in der aufrufenden
   fileVisit()-Funktion, NIE in diesem Dialog/DOM. Wechsel zwischen Suche,
   Vorschlag und Neuanlage rendern nur diesen Dialog neu (render()) — dabei
   wird nichts vom Bericht berührt oder verworfen. "Abbrechen" bricht NUR
   die Ordnerwahl ab; der Besuch bleibt unverändert in der App gespeichert
   (excelFiled bleibt false) und kann jederzeit erneut abgelegt werden.
   Gibt bei Erfolg { dirHandle, created, name } zurück, bei Abbruch null.
   ============================================================ */
CRM.ablage.chooseFolderDialog = function (c, typeDir, typeFolderName, fuzzy) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => { if (settled) return; settled = true; CRM.closeModal(); resolve(result); };
    const state = { mode: 'search', query: '', folders: null, newName: CRM.ablage.customerFolderName(c) };

    const render = () => { if (state.mode === 'create') renderCreate(); else renderSearch(); };

    const renderSearch = () => {
      const q = CRM.ablage.normalizeName(state.query);
      const all = state.folders || [];
      const filtered = q ? all.filter((f) => f.norm.includes(q)) : all;
      const shown = filtered.slice(0, 60);
      const suggestion = fuzzy ? `
        <div style="border:1px solid var(--border);padding:8px 10px;border-radius:8px;margin-bottom:10px;background:rgba(255,193,7,.08)">
          <div style="font-size:12px;color:var(--text-dim)">Ähnlichster gefundener Ordner (${Math.round(fuzzy.score * 100)}% Übereinstimmung) — ist das derselbe Kunde?</div>
          <div class="row" style="align-items:center;gap:8px;margin-top:4px">
            <div class="li-title" style="flex:1">📁 ${esc(fuzzy.entry.name)}</div>
            <button class="btn btn-sm btn-primary" id="cfd-use-fuzzy">Diesen Ordner nutzen</button>
          </div>
        </div>` : '';
      const rows = shown.length
        ? shown.map((f, i) => `<div class="list-item cfd-item" data-idx="${i}" style="cursor:pointer"><div class="li-main"><div class="li-title">📁 ${esc(f.display)}</div></div></div>`).join('')
        : `<p style="color:var(--text-dim);font-size:13px;padding:10px">${state.folders ? 'Kein Ordner passt zur Suche.' : 'Ordner werden geladen…'}</p>`;
      CRM.openModal(`
        <h2>📂 Ordner wählen — ${esc(CRM.displayNameDisambig(c))}</h2>
        <p style="font-size:13px;color:var(--text-dim)">Kein exakt passender Ordner in <code>.Kunden\\${esc(typeFolderName)}</code> gefunden. Der Bericht bleibt gespeichert, egal wie oft du hier wechselst.</p>
        ${suggestion}
        <label>Ordner durchsuchen</label>
        <input type="text" id="cfd-search" placeholder="Namen eingeben zum Filtern…" value="${escAttr(state.query)}" autocomplete="off">
        <div style="max-height:32vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-top:8px">${rows}</div>
        <div class="modal-footer">
          <button class="btn" id="cfd-cancel">Abbrechen</button>
          <button class="btn" id="cfd-new">➕ Neuen Ordner anlegen</button>
        </div>
      `, { dismissible: false });

      const input = document.getElementById('cfd-search');
      if (input) {
        input.focus();
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
        input.addEventListener('input', () => { state.query = input.value; renderSearch(); });
      }
      document.getElementById('cfd-cancel').addEventListener('click', () => done(null));
      document.getElementById('cfd-new').addEventListener('click', () => { state.mode = 'create'; render(); });
      const fuzzyBtn = document.getElementById('cfd-use-fuzzy');
      if (fuzzyBtn) fuzzyBtn.addEventListener('click', () => done({ dirHandle: fuzzy.entry, created: false, name: fuzzy.entry.name }));
      document.querySelectorAll('.cfd-item').forEach((el) => {
        el.addEventListener('click', () => {
          const f = shown[parseInt(el.dataset.idx, 10)];
          done({ dirHandle: f.entry, created: false, name: f.entry.name });
        });
      });
    };

    const renderCreate = () => {
      CRM.openModal(`
        <h2>➕ Neuen Ordner anlegen — ${esc(CRM.displayNameDisambig(c))}</h2>
        <p style="font-size:13px;color:var(--text-dim)">Wird angelegt unter <code>.Kunden\\${esc(typeFolderName)}\\…</code>. „Zurück" verwirft nichts — der Bericht bleibt erhalten.</p>
        <label>Ordnername</label>
        <input type="text" id="cfd-newname" value="${escAttr(state.newName)}">
        <div class="modal-footer">
          <button class="btn" id="cfd-back">← Zurück zur Suche</button>
          <button class="btn" id="cfd-cancel2">Abbrechen</button>
          <button class="btn btn-primary" id="cfd-create-go">Ordner anlegen</button>
        </div>
      `, { dismissible: false });
      const nameInput = document.getElementById('cfd-newname');
      nameInput.addEventListener('input', () => { state.newName = nameInput.value; });
      document.getElementById('cfd-back').addEventListener('click', () => { state.mode = 'search'; render(); });
      document.getElementById('cfd-cancel2').addEventListener('click', () => done(null));
      document.getElementById('cfd-create-go').addEventListener('click', async () => {
        const name = CRM.ablage.sanitizeFile(nameInput.value.trim()) || state.newName;
        const goBtn = document.getElementById('cfd-create-go');
        goBtn.disabled = true; goBtn.textContent = 'Lege an…';
        try {
          const dirHandle = await typeDir.getDirectoryHandle(name, { create: true });
          done({ dirHandle, created: true, name });
        } catch (e) {
          CRM.toast('Ordner konnte nicht angelegt werden: ' + (e && e.message ? e.message : e), 'error');
          goBtn.disabled = false; goBtn.textContent = 'Ordner anlegen';
        }
      });
    };

    render();
    // Ordnerliste im Hintergrund laden (kann bei vielen Kunden etwas dauern),
    // danach live filterbar — Suchfeld ist bis dahin schon bedienbar.
    CRM.ablage.listAllFolders(typeDir).then((folders) => {
      state.folders = folders;
      if (state.mode === 'search') renderSearch();
    });
  });
};

CRM.ablage.copyTemplateInto = async function (destDir, fileName, templateFileHandle) {
  const tplFile = await templateFileHandle.getFile();
  const buf = await tplFile.arrayBuffer();
  const newFile = await destDir.getFileHandle(fileName, { create: true });
  const w = await newFile.createWritable();
  await w.write(buf);
  await w.close();
  return newFile;
};

CRM.ablage.readWorkbook = async function (fileHandle) {
  const file = await fileHandle.getFile();
  const buf = await file.arrayBuffer();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buf);
  return wb;
};
CRM.ablage.writeWorkbook = async function (fileHandle, wb) {
  const buf = await wb.xlsx.writeBuffer();
  const w = await fileHandle.createWritable();
  await w.write(buf);
  await w.close();
};

CRM.ablage.firstEmptyRow = function (ws, start, col) {
  let r = start;
  while (r < start + 500) {
    const v = ws.getCell(r, col).value;
    if (v === null || v === undefined || v === '') return r;
    r++;
  }
  return r;
};

/* Findet die Zeile eines Tages im Monatsbericht per Wert-Suche in Spalte A.
   Robuster als fester Offset (d.getDate()+4), da eingefügte Folgezeilen
   die Zeilennummern verschieben. */
CRM.ablage.findDayRow = function (ws, day) {
  for (let r = 5; r <= 50; r++) {
    const v = ws.getCell(r, 1).value;
    if (v === null || v === undefined || v === '') continue;
    if (typeof v === 'number' && v === day) return r;
    if (typeof v === 'string' && parseInt(v, 10) === day) return r;
    if (v instanceof Date && v.getDate() === day) return r;
  }
  return day + 4; // Fallback: ursprünglicher fester Offset
};

/* Wandelt einen Besuchsbericht-Text in Stichpunkte für den Monatsbericht um. */
CRM.ablage.noteToEssence = function (noteText) {
  if (!noteText) return '';
  const lines = String(noteText).split('\n').map(l => l.trim()).filter(l => l.length > 3);
  if (!lines.length) return '';
  return lines.map(l => (/^[•\-*]/.test(l) ? l : '• ' + l)).join('\n');
};

CRM.MONTH_NAMES_DE = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

/* ============================================================
   Hauptablauf: einen Besuch ablegen
   visit = {date:'YYYY-MM-DD', note, ...}; monthEssence = Kurztext für Monatsbericht
   ============================================================ */
CRM.ablage.fileVisit = async function (contactId, visit, monthEssence, opts) {
  const silent = !!(opts && opts.silent);
  if (!CRM.ablage.supported()) {
    if (!silent) CRM.toast('Excel-Ablage nur in Chrome/Edge am Laptop.', 'error');
    return { ok: false };
  }
  const c = CRM.db.getContact(contactId);
  if (!c) return { ok: false };
  const root = await CRM.ablage.ensureRoot();
  if (!root) return { ok: false };

  const log = [];
  try {
    // ---------- A) Besuchsprotokoll ----------
    const kunden = await root.getDirectoryHandle('.Kunden');
    const typeFolderName = CRM.ablage.TYPE_FOLDER[c.type] || '.BU';
    const typeDir = await kunden.getDirectoryHandle(typeFolderName);

    const found = await CRM.ablage.findCustomerDir(typeDir, c);
    let custDir = found.exact;
    if (custDir) {
      log.push('Kundenordner gefunden: ' + typeFolderName + '\\' + custDir.name);
    } else if (silent) {
      // Automatischer/stiller Lauf (Eingang-Verarbeitung, Tagesabschluss):
      // NIE ungefragt einen unsicheren oder neuen Ordner wählen. Der Besuch
      // ist zu diesem Zeitpunkt bereits sicher als Kontakt-Datensatz in der
      // App gespeichert (excelFiled bleibt einfach false) und kann jederzeit
      // manuell über den Kontakt ("📋 In Excel ablegen") nachgeholt werden —
      // nichts geht verloren, es wird nur nicht automatisch geraten.
      return { ok: false, needsFolder: true, log: ['Kein exakter Kundenordner gefunden — automatischer Lauf übersprungen, Bericht bleibt gespeichert für manuelle Ablage.'] };
    } else {
      // Kein exakter Treffer: Auswahl-Dialog mit Ähnlich-Vorschlag + Suche
      // über alle Ordner + "neuen Ordner anlegen" (siehe chooseFolderDialog).
      // visit/monthEssence leben ausschließlich in dieser Funktion, nicht im
      // Dialog — ein Abbruch dort verwirft daher nichts vom Bericht.
      const choice = await CRM.ablage.chooseFolderDialog(c, typeDir, typeFolderName, found.fuzzy);
      if (!choice) {
        CRM.toast('Ordnerauswahl abgebrochen — Bericht bleibt gespeichert, jederzeit über „📋 In Excel ablegen" erneut versuchbar.', 'error');
        return { ok: false, aborted: true, log: ['Ordnerauswahl abgebrochen.'] };
      }
      custDir = choice.dirHandle;
      log.push((choice.created ? 'Ordner neu angelegt: ' : 'Ordner manuell ausgewählt: ') + typeFolderName + '\\' + choice.name);
    }

    // Protokolldatei finden oder aus Vorlage kopieren
    const protoName = 'Besuchsprotokoll - ' + CRM.ablage.customerFolderName(c) + ' - ' + (CRM.db.getSettings().adKuerzel || 'CK') + '.xlsx';
    let protoHandle = null;
    for await (const entry of custDir.values()) {
      if (entry.kind === 'file' && /^Besuchsprotokoll.*\.xlsx$/i.test(entry.name)) { protoHandle = entry; break; }
    }
    if (!protoHandle) {
      const tplDir = await root.getDirectoryHandle(CRM.ablage.PROTO_TEMPLATE_DIR);
      const tplFile = await tplDir.getFileHandle(CRM.ablage.PROTO_TEMPLATE_FILE);
      protoHandle = await CRM.ablage.copyTemplateInto(custDir, protoName, tplFile);
      log.push('Protokoll aus Vorlage angelegt: ' + protoName);
    } else {
      log.push('Protokoll gefunden: ' + protoHandle.name);
    }

    const wb = await CRM.ablage.readWorkbook(protoHandle);
    const ws = wb.getWorksheet('Tabelle1') || wb.worksheets[0];
    // Kopf füllen (nur wenn leer/Platzhalter)
    const a1 = ws.getCell('A1');
    if (!a1.value || /Kunde inkl/.test(String(a1.value))) {
      a1.value = 'Kunde inkl. (ERP Nummer): ' + [c.firma1, c.ort].filter(Boolean).join(', ') + (c.erpNr ? ' - ' + c.erpNr : '');
    }
    const a2 = ws.getCell('A2');
    if (!a2.value || /Kundengruppe/.test(String(a2.value))) {
      a2.value = 'Kundengruppe (HÄ, HW): ' + (c.type === 'haendler' ? 'HÄ' : 'HW');
    }
    const row = CRM.ablage.firstEmptyRow(ws, 5, 1);
    ws.getCell(row, 1).value = CRM.ablage.deDate(visit.date);
    ws.getCell(row, 2).value = CRM.db.getSettings().adKuerzel || 'CK';
    ws.getCell(row, 5).value = visit.note || '';
    if (c.nextStep) ws.getCell(row, 7).value = c.nextStep;
    await CRM.ablage.writeWorkbook(protoHandle, wb);
    log.push('Besuchszeile eingetragen (Zeile ' + row + ')');

    const custFolderRel = '.Kunden\\' + typeFolderName + '\\' + custDir.name;

    // ---------- A2) Kopie in den Monats-Sammelordner (072026, 082026, ...) ----------
    // Eigener try/catch: ein Fehler hier darf die eigentliche Ablage nicht abbrechen.
    try {
      await CRM.ablage.copyProtoToMonthFolder(root, protoHandle, visit.date, log);
    } catch (e) {
      log.push('⚠️ Monats-Sammelordner: Kopie fehlgeschlagen (' + (e && e.message ? e.message : e) + ')');
    }

    // ---------- B) Monatsbericht ----------
    const monthFolderRel = await CRM.ablage.appendMonthEntry(root, c, visit.date, monthEssence, log);

    // Besuch als „in Excel abgelegt" markieren (per ID) — verhindert doppeltes
    // Ablegen und ist die Basis für den Tagesabschluss.
    if (visit && visit.id) {
      const stored = (c.visits || []).find((x) => x.id === visit.id);
      if (stored && !stored.excelFiled) { stored.excelFiled = true; stored.excelFiledAt = new Date().toISOString(); CRM.db.saveContacts(); }
    }
    if (!silent) CRM.ablage.showResult(true, log, { custFolderRel, monthFolderRel });
    return { ok: true, log, paths: { custFolderRel, monthFolderRel } };
  } catch (e) {
    log.push('FEHLER: ' + (e && e.message ? e.message : e));
    if (!silent) CRM.ablage.showResult(false, log);
    return { ok: false, log, error: e };
  }
};

/* Alle Besuchsprotokolle eines Monats gesammelt in einem Ordner:
   Berichte - Reisekosten - Spesen\MMYYYY (z.B. 072026) — bei jeder Ablage
   wird die aktuelle Fassung des Kunden-Protokolls dorthin kopiert
   (überschreibt die ältere Kopie desselben Kunden im selben Monat).
   Neuer Monat → neuer Ordner, automatisch. */
CRM.ablage.copyProtoToMonthFolder = async function (root, protoHandle, dateStr, log) {
  const d = new Date(dateStr);
  const key = String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear(); // 07.2026
  const baseDir = await root.getDirectoryHandle(CRM.ablage.MONTH_BASE_DIR);
  const dir = await baseDir.getDirectoryHandle(key, { create: true });
  const file = await protoHandle.getFile();
  const buf = await file.arrayBuffer();
  const dest = await dir.getFileHandle(protoHandle.name, { create: true });
  const w = await dest.createWritable();
  await w.write(buf);
  await w.close();
  log.push('Kopie im Monats-Sammelordner: ' + CRM.ablage.MONTH_BASE_DIR + '\\' + key + '\\' + protoHandle.name);
  return key;
};

CRM.ablage.appendMonthEntry = async function (root, c, dateStr, essence, log) {
  const d = new Date(dateStr);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const folderName = mm + '.' + yyyy;
  const fileName = 'Berichtswesen_Vertrieb - ' + folderName + ' ' + (CRM.db.getSettings().adKuerzel || 'CK') + '.xlsx';

  const baseDir = await root.getDirectoryHandle(CRM.ablage.MONTH_BASE_DIR);
  const monthDir = await baseDir.getDirectoryHandle(folderName, { create: true });
  const monthFolderRel = CRM.ablage.MONTH_BASE_DIR + '\\' + folderName;

  let fileHandle = null;
  for await (const entry of monthDir.values()) {
    if (entry.kind === 'file' && /^Berichtswesen_Vertrieb.*\.xlsx$/i.test(entry.name)) { fileHandle = entry; break; }
  }
  if (!fileHandle) {
    // Vorlage aus .Kunden\Berichtswesen_Vertrieb.xlsx
    let tplDir = root;
    const rel = CRM.ablage.MONTH_TEMPLATE_REL;
    for (let i = 0; i < rel.length - 1; i++) tplDir = await tplDir.getDirectoryHandle(rel[i]);
    const tplFile = await tplDir.getFileHandle(rel[rel.length - 1]);
    fileHandle = await CRM.ablage.copyTemplateInto(monthDir, fileName, tplFile);
    log.push('Monatsbericht aus Vorlage angelegt: ' + folderName + '\\' + fileName);
  } else {
    log.push('Monatsbericht gefunden: ' + fileHandle.name);
  }

  const wb = await CRM.ablage.readWorkbook(fileHandle);
  const ws = wb.getWorksheet('ABWESENHEIT und BERICHTE') || wb.worksheets[0];
  ws.getCell('D1').value = CRM.MONTH_NAMES_DE[d.getMonth()] + ' ' + yyyy;

  const dayRow = CRM.ablage.findDayRow(ws, d.getDate());
  const kundeText = [c.firma1, c.ort].filter(Boolean).join(', ') + (c.erpNr ? ' - ' + c.erpNr : '');
  let target = dayRow;
  if (ws.getCell(dayRow, 3).value) {
    // Tageszeile belegt — letzte Folgezeile des Tages suchen (Spalte A leer, Spalte 3 belegt)
    let lastOccupied = dayRow;
    for (let r = dayRow + 1; r <= dayRow + 30; r++) {
      const c1 = ws.getCell(r, 1).value;
      const isNextDayRow = c1 !== null && c1 !== undefined && c1 !== '' &&
        (typeof c1 === 'number' ? c1 > 0 : (!isNaN(parseInt(c1, 10)) && parseInt(c1, 10) > 0));
      if (isNextDayRow) break;
      if (ws.getCell(r, 3).value) { lastOccupied = r; } else break;
    }
    ws.insertRow(lastOccupied + 1, [], 'i');
    target = lastOccupied + 1;
    ws.getCell(target, 1).value = null;
    log.push('Monatsbericht: Folgeeintrag in eingefügter Zeile ' + target);
  } else {
    log.push('Monatsbericht: Eintrag in Tageszeile ' + target + ' (Tag ' + d.getDate() + ')');
  }
  ws.getCell(target, 3).value = kundeText;
  ws.getCell(target, 4).value = essence || '';
  await CRM.ablage.writeWorkbook(fileHandle, wb);
  return monthFolderRel;
};

CRM.ablage.deDate = function (isoStr) {
  const d = new Date(isoStr);
  if (isNaN(d)) return isoStr;
  return String(d.getDate()).padStart(2, '0') + '.' + String(d.getMonth() + 1).padStart(2, '0') + '.' + d.getFullYear();
};

/* ---------- Dialog: Besuch ablegen (mit Kurznotiz für Monatsbericht) ---------- */
CRM.ablage.openDialog = function (contactId, visit) {
  if (!CRM.ablage.supported()) {
    CRM.toast('Excel-Ablage funktioniert nur in Chrome/Edge am Laptop (nicht am Handy).', 'error');
    return;
  }
  const c = CRM.db.getContact(contactId);
  const essencePre = CRM.ablage.noteToEssence(visit.note);
  const kundeVorschau = [c.firma1, c.ort].filter(Boolean).join(', ') + (c.erpNr ? ' - ' + c.erpNr : '');
  CRM.openModal(`
    <h2>📋 In Excel ablegen — ${esc(CRM.displayNameDisambig(c))}</h2>
    <p style="color:var(--text-dim);font-size:13px">Schreibt in das Besuchsprotokoll des Kunden <strong>und</strong> in den Monatsbericht. Ziel-Ordner: <code>.Kunden\\${CRM.ablage.TYPE_FOLDER[c.type] || '.BU'}\\…</code></p>
    <label>Besuchsdatum</label>
    <input type="date" id="abl-date" value="${esc(visit.date)}" style="max-width:180px">
    <label style="margin-top:10px">Inhalt fürs Besuchsprotokoll (Spalte „Inhalte")</label>
    <textarea id="abl-note" rows="3">${esc(visit.note || '')}</textarea>
    <label style="margin-top:10px">Bemerkungen / Ergebnis — Stichpunkte für Monatsbericht</label>
    <textarea id="abl-essence" rows="4" placeholder="• Stichpunkt 1&#10;• Stichpunkt 2&#10;• Stichpunkt 3">${esc(essencePre)}</textarea>
    <p style="font-size:11px;color:var(--text-dim);margin-top:3px">Kunde im Monatsbericht: <strong>${esc(kundeVorschau)}</strong></p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="abl-go">In Excel ablegen</button>
    </div>
  `);
  document.getElementById('abl-go').addEventListener('click', async () => {
    const v = {
      id: visit.id,
      date: document.getElementById('abl-date').value || visit.date,
      note: document.getElementById('abl-note').value,
    };
    const essence = document.getElementById('abl-essence').value;
    document.getElementById('abl-go').disabled = true;
    document.getElementById('abl-go').textContent = 'Lege ab…';
    await CRM.ablage.fileVisit(contactId, v, essence);
  });
};

/* Voller OS-Pfad eines Ablage-Ortes — der Browser gibt aus Sicherheitsgründen
   keine echten Dateipfade heraus, daher der einmalig in den Einstellungen
   hinterlegte OneDrive-Basispfad + der bekannte relative Unterordner. */
CRM.ablage.fullPath = function (relPath) {
  const base = (CRM.db.getSettings().onedrivePath || '').trim();
  if (!base) return null;
  return base + '\\' + relPath;
};

CRM.ablage.fileUrl = function (fullPath) {
  const parts = fullPath.replace(/\\/g, '/').split('/');
  return 'file:///' + parts.map((seg, i) => (i === 0 ? seg : encodeURIComponent(seg))).join('/');
};

CRM.ablage.copyPath = async function (path) {
  try {
    await navigator.clipboard.writeText(path);
    CRM.toast('Pfad kopiert — in den Explorer einfügen (Strg+L, dann Strg+V, Enter).', 'success');
  } catch (e) {
    CRM.toast('Kopieren fehlgeschlagen.', 'error');
  }
};

CRM.ablage.showResult = function (ok, log, paths) {
  const rows = [];
  if (paths && paths.custFolderRel) rows.push({ label: 'Kundenordner', rel: paths.custFolderRel });
  if (paths && paths.monthFolderRel) rows.push({ label: 'Monatsbericht-Ordner', rel: paths.monthFolderRel });
  const hasBase = !!(CRM.db.getSettings().onedrivePath || '').trim();

  const pathButtons = rows.map((r) => {
    const full = CRM.ablage.fullPath(r.rel);
    return `<div class="row" style="gap:6px;margin-top:6px;align-items:center;flex-wrap:wrap">
      <span style="font-size:12px;color:var(--text-dim);min-width:140px">${esc(r.label)}:</span>
      ${full ? `<a class="btn btn-sm" href="${esc(CRM.ablage.fileUrl(full))}" target="_blank" rel="noopener">📂 Ordner öffnen</a>` : ''}
      <button class="btn btn-sm ablage-copy-path" data-path="${escAttr(full || r.rel)}">📋 Pfad kopieren</button>
    </div>`;
  }).join('');

  CRM.openModal(`
    <h2>${ok ? '✅ In Excel abgelegt' : '⚠️ Ablage mit Fehler'}</h2>
    <ul style="font-size:13px;line-height:1.7">${log.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>
    ${pathButtons ? `<div style="margin-top:10px">${pathButtons}</div>${hasBase ? '' : '<p style="font-size:12px;color:var(--text-dim);margin-top:8px">Hinterlege deinen OneDrive-Pfad in den Einstellungen, dann öffnet „Ordner öffnen" direkt den Explorer.</p>'}` : ''}
    <div class="modal-footer"><button class="btn btn-primary" onclick="CRM.closeModal()">OK</button></div>
  `);

  document.querySelectorAll('.ablage-copy-path').forEach((btn) => {
    btn.addEventListener('click', () => CRM.ablage.copyPath(btn.dataset.path));
  });
};

/* ============================================================
   Eingang-Sync: liest vom Handy exportierte JSON-Dateien aus dem
   OneDrive-Unterordner "Eingang" (im verbundenen Claytec-Ordner),
   merged neue/geänderte Kontakte (CRM.mergeIncomingContact) und legt
   jeden neu hinzugekommenen Besuch automatisch in Excel ab — dieselbe
   Logik wie beim manuellen "📋 In Excel ablegen"-Button, nur ohne
   Dialog pro Besuch (silent:true). Verarbeitete Dateien werden danach
   aus dem Eingang-Ordner gelöscht.
   ============================================================ */
/* Separat verbundener Eingang-Ordner (falls gesetzt) — erlaubt, den
   Eingang in einen ANDEREN Ordner als die Kundenablage zu legen
   (z.B. …\Claytec CRM\Eingang, während .Kunden woanders liegt). */
CRM.ablage.getEingangHandle = async function () {
  if (CRM.ablage.eingangHandle) {
    if (await CRM.ablage.verifyPermission(CRM.ablage.eingangHandle)) return CRM.ablage.eingangHandle;
    return null;
  }
  const stored = await CRM.ablage.idbGet('claytecEingang');
  if (stored && (await CRM.ablage.verifyPermission(stored))) { CRM.ablage.eingangHandle = stored; return stored; }
  return null;
};

CRM.ablage.getEingangDir = async function (create) {
  // 1) Eigener Eingang-Ordner, falls verbunden — direkt nutzen
  const eigen = await CRM.ablage.getEingangHandle();
  if (eigen) return eigen;
  // 2) Fallback: Unterordner „Eingang" im verbundenen Claytec-Ordner
  const root = await CRM.ablage.ensureRoot();
  if (!root) return null;
  try {
    return await root.getDirectoryHandle('Eingang', { create: !!create });
  } catch (e) {
    return null;
  }
};

/* Eigenen Eingang-Ordner wählen (den „Eingang"-Ordner selbst, nicht dessen
   Elternordner). Danach liest/löscht processEingang direkt darin. */
CRM.ablage.connectEingang = async function () {
  if (!CRM.ablage.supported()) { CRM.toast('Nur in Chrome/Edge am Laptop möglich.', 'error'); return null; }
  try {
    const handle = await window.showDirectoryPicker({ id: 'claytec-eingang', mode: 'readwrite', startIn: 'documents' });
    CRM.ablage.eingangHandle = handle;
    await CRM.ablage.idbSet('claytecEingang', handle);
    CRM.toast('Eingang-Ordner verbunden: ' + handle.name, 'success');
    if (CRM.renderSettings && document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
    return handle;
  } catch (e) {
    if (e.name !== 'AbortError') CRM.toast('Ordner-Auswahl abgebrochen: ' + e.message, 'error');
    return null;
  }
};

CRM.ablage.clearEingang = async function () {
  CRM.ablage.eingangHandle = null;
  await CRM.ablage.idbSet('claytecEingang', null);
  if (CRM.renderSettings && document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
  CRM.toast('Eigener Eingang-Ordner entfernt — nutzt wieder „Eingang" im Claytec-Ordner.', 'success');
};

/* ============================================================
   Tagesabschluss: alle noch nicht abgelegten Besuche (mit Inhalt)
   gesammelt in Excel ablegen — ohne jeden Kunden einzeln zu öffnen.
   Standard „nur heute"; „alle offenen" holt auch ältere nach.
   ============================================================ */
CRM.ablage._taScope = 'heute';
CRM.ablage._taCandidates = function (scope) {
  const today = new Date().toISOString().slice(0, 10);
  const out = [];
  CRM.db.getContacts().forEach((c) => {
    (c.visits || []).forEach((v) => {
      if (!v.note || !v.note.trim()) return; // nur Besuche mit Inhalt
      if (v.excelFiled) return;              // schon abgelegt
      if (scope === 'heute' && v.date !== today) return;
      out.push({ c: c, v: v });
    });
  });
  out.sort((a, b) => (a.v.date < b.v.date ? 1 : a.v.date > b.v.date ? -1 : 0)
    || String(a.c.firma1 || '').localeCompare(String(b.c.firma1 || '')));
  return out;
};
CRM.ablage.openTagesabschluss = function () {
  if (!CRM.ablage.supported()) { CRM.toast('Tagesabschluss (Excel) nur in Chrome/Edge am Laptop.', 'error'); return; }
  CRM.ablage._taScope = CRM.ablage._taScope || 'heute';
  CRM.ablage._renderTagesabschluss();
};
CRM.ablage.setTaScope = function (s) { CRM.ablage._taScope = s; CRM.ablage._renderTagesabschluss(); };
CRM.ablage._renderTagesabschluss = function () {
  const scope = CRM.ablage._taScope;
  const list = CRM.ablage._taCandidates(scope);
  const kunden = new Set(list.map((x) => x.c.id)).size;
  const rows = list.length
    ? list.slice(0, 200).map((x) => '<div class="list-item" style="cursor:default">'
        + '<div class="li-main" style="min-width:0">'
        + '<div class="li-title">' + esc(CRM.displayNameDisambig(x.c)) + '</div>'
        + '<div style="font-size:12px;color:var(--text-dim)">' + esc(x.v.date) + ' · ' + esc((x.v.note || '').replace(/\s+/g, ' ').slice(0, 80)) + '</div>'
        + '</div>'
        + '<div class="row" style="gap:4px;flex-shrink:0">'
        + '<button class="btn btn-sm ta-row-file" data-cid="' + escAttr(x.c.id) + '" data-vid="' + escAttr(x.v.id) + '" title="Nur diesen Bericht jetzt ablegen">📋 Ablegen</button>'
        + '<button class="btn btn-sm ta-row-export" data-cid="' + escAttr(x.c.id) + '" data-vid="' + escAttr(x.v.id) + '" title="Diesen Bericht als Datei sichern/exportieren">⬇ Export</button>'
        + '</div></div>').join('')
      + (list.length > 200 ? '<p style="color:var(--text-dim);font-size:12px;padding:6px">… und ' + (list.length - 200) + ' weitere</p>' : '')
    : '<p style="color:var(--text-dim);font-size:13px;padding:10px">Keine offenen Besuche' + (scope === 'heute' ? ' von heute' : '') + ' — alles abgelegt. ✅</p>';
  CRM.openModal(''
    + '<h2>🗂️ Tagesabschluss — Besuche in Excel ablegen</h2>'
    + '<p style="color:var(--text-dim);font-size:13px">Legt alle noch nicht abgelegten Besuche (mit Inhalt) gesammelt in die Besuchsprotokolle <strong>und</strong> den Monatsbericht — jeder Besuch genau einmal. Einzelne Berichte können hier auch separat abgelegt oder gesichert/exportiert werden, ohne die anderen anzufassen.</p>'
    + '<div class="quick-filters" style="margin:8px 0">'
    + '  <button class="qf-btn ' + (scope === 'heute' ? 'active' : '') + '" onclick="CRM.ablage.setTaScope(\'heute\')">Nur heute</button>'
    + '  <button class="qf-btn ' + (scope === 'offen' ? 'active' : '') + '" onclick="CRM.ablage.setTaScope(\'offen\')">Alle offenen</button>'
    + '</div>'
    + '<p style="font-size:15px;margin:6px 0"><strong>' + list.length + '</strong> Besuche von <strong>' + kunden + '</strong> Kunden werden abgelegt.</p>'
    + '<div style="max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px">' + rows + '</div>'
    + '<div class="modal-footer">'
    + '  <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>'
    + '  <button class="btn btn-primary" id="ta-go" ' + (list.length ? '' : 'disabled') + ' onclick="CRM.ablage.runTagesabschluss()">🗂️ ' + list.length + ' jetzt ablegen</button>'
    + '</div>');

  // Einzelaktionen je Zeile — "Ablegen" nutzt bewusst den bestehenden
  // Ablage-Dialog (CRM.ablage.openDialog), damit derselbe robuste
  // Ordner-Auswahl-Flow (Suche/Vorschlag/Neuanlage, siehe chooseFolderDialog)
  // greift und kein zweiter, abweichender Ablageweg entsteht.
  document.querySelectorAll('.ta-row-file').forEach((btn) => {
    btn.addEventListener('click', () => {
      const c = CRM.db.getContact(btn.dataset.cid);
      const v = c && (c.visits || []).find((vv) => vv.id === btn.dataset.vid);
      if (!c || !v) { CRM.toast('Bericht nicht mehr gefunden — evtl. schon anderweitig verarbeitet.', 'error'); CRM.ablage._renderTagesabschluss(); return; }
      CRM.ablage.openDialog(c.id, v);
    });
  });
  document.querySelectorAll('.ta-row-export').forEach((btn) => {
    btn.addEventListener('click', () => CRM.sync.exportSingleVisit(btn.dataset.cid, btn.dataset.vid));
  });
};
CRM.ablage.runTagesabschluss = async function () {
  const list = CRM.ablage._taCandidates(CRM.ablage._taScope);
  if (!list.length) { CRM.toast('Nichts abzulegen.', 'error'); return; }
  const btn = document.getElementById('ta-go');
  if (btn) btn.disabled = true;
  let ok = 0, offenOrdner = 0, fehler = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i].c;
    const v = list[i].v;
    if (btn) btn.textContent = 'Lege ab… (' + (i + 1) + '/' + list.length + ')';
    try {
      const res = await CRM.ablage.fileVisit(c.id, v, CRM.ablage.noteToEssence(v.note), { silent: true });
      if (res && res.ok) ok++;
      else if (res && res.needsFolder) offenOrdner++;
      else fehler++;
    } catch (e) { fehler++; }
  }
  CRM.closeModal();
  if (CRM.renderContactList && document.querySelector('#view-kontakte.active')) CRM.renderContactList();
  if (CRM.renderDashboard && document.querySelector('#view-start.active')) CRM.renderDashboard();
  const teile = [ok + ' abgelegt'];
  if (offenOrdner) teile.push(offenOrdner + ' brauchen manuelle Ordnerauswahl (einzeln über „📋 Ablegen")');
  if (fehler) teile.push(fehler + ' Fehler');
  CRM.toast('🗂️ Tagesabschluss: ' + teile.join(', ') + '. Nichts geht verloren — offene Berichte bleiben in der Liste.', (fehler || offenOrdner) ? 'error' : 'success');
};

CRM.ablage.processEingang = async function (silent) {
  if (!CRM.ablage.supported()) {
    if (!silent) CRM.toast('Eingang-Verarbeitung nur in Chrome/Edge am Laptop möglich.', 'error');
    return;
  }
  const dir = await CRM.ablage.getEingangDir(false);
  if (!dir) {
    if (!silent) CRM.toast('Kein „Eingang"-Ordner gefunden (wird automatisch angelegt, sobald vom Handy etwas exportiert wurde).', 'error');
    return;
  }

  const files = [];
  for await (const entry of dir.values()) {
    if (entry.kind === 'file' && /\.json$/i.test(entry.name)) files.push(entry);
  }
  if (!files.length) {
    if (!silent) CRM.toast('Eingang-Ordner ist leer — nichts zu verarbeiten.', 'success');
    return;
  }

  const stats = { neu: 0, aktualisiert: 0, besucheUebernommen: 0, inExcelAbgelegt: 0, offenOrdner: 0, fehler: 0, dateienBehalten: 0 };

  for (const fileHandle of files) {
    let payload;
    try {
      const text = await (await fileHandle.getFile()).text();
      payload = JSON.parse(text);
    } catch (e) {
      stats.fehler++;
      continue; // Datei bleibt liegen, falls sie defekt ist — keine Löschung
    }

    // WICHTIG (Datenverlust-Vermeidung): eine Eingang-Datei kann mehrere
    // Kontakte enthalten. Scheitert das ÜBERNEHMEN (Merge in die App) auch
    // nur eines einzelnen Kontakts, darf die Datei am Ende NICHT gelöscht
    // werden — sonst wäre genau dieser Bericht unwiederbringlich weg (das
    // war die Ursache des Datenverlusts vom 04.08.2026). Ein fehlgeschlagenes
    // spätere ABLEGEN in Excel gefährdet dagegen keine Daten: der Besuch ist
    // dann schon sicher im Kontakt gespeichert und bleibt über excelFiled
    // jederzeit nachholbar (Tagesabschluss / Kontakt selbst).
    let allContactsMerged = true;

    for (const incoming of (payload.contacts || [])) {
      let newVisits = [];
      let contactId = incoming.id;
      try {
        const existing = CRM.db.getContact(incoming.id);
        if (existing) {
          newVisits = CRM.mergeIncomingContact(existing, incoming);
          stats.aktualisiert++;
        } else {
          CRM.db.addContact(incoming);
          newVisits = incoming.visits || [];
          stats.neu++;
        }
        stats.besucheUebernommen += newVisits.length;
      } catch (e) {
        stats.fehler++;
        allContactsMerged = false;
        continue;
      }

      for (const v of newVisits) {
        if (!v.note) continue; // leere Schnell-Besuche ohne Inhalt nicht in Excel ablegen
        try {
          const essence = CRM.ablage.noteToEssence(v.note);
          const result = await CRM.ablage.fileVisit(contactId, v, essence, { silent: true });
          if (result && result.ok) stats.inExcelAbgelegt++;
          else if (result && result.needsFolder) stats.offenOrdner++;
          else stats.fehler++;
        } catch (e) {
          stats.fehler++;
        }
        // Absichtlich KEIN Einfluss auf allContactsMerged: der Bericht ist
        // bereits im Kontakt gespeichert (siehe oben), egal ob die
        // Excel-Ablage hier klappt.
      }
    }

    if (allContactsMerged) {
      await dir.removeEntry(fileHandle.name);
    } else {
      stats.dateienBehalten++; // Datei bleibt für einen erneuten Versuch liegen
    }
  }

  if (CRM.renderContactList && document.querySelector('#view-kontakte.active')) CRM.renderContactList();
  const teile = [`${stats.neu} neue Kontakte`, `${stats.aktualisiert} aktualisiert`, `${stats.besucheUebernommen} Besuche übernommen`, `${stats.inExcelAbgelegt} in Excel abgelegt`];
  if (stats.offenOrdner) teile.push(`${stats.offenOrdner} warten auf Ordnerauswahl (siehe Tagesabschluss)`);
  if (stats.fehler) teile.push(`${stats.fehler} Fehler`);
  if (stats.dateienBehalten) teile.push(`${stats.dateienBehalten} Datei(en) zur Sicherheit NICHT gelöscht`);
  const summary = `📥 Eingang verarbeitet: ${teile.join(', ')}.`;
  if (!silent || stats.neu || stats.aktualisiert || stats.fehler || stats.dateienBehalten) {
    CRM.toast(summary, (stats.fehler || stats.dateienBehalten) ? 'error' : 'success');
  }
};
