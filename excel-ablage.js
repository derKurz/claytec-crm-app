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
  TYPE_FOLDER: { architekt: '.AR', haendler: '.BH', verarbeiter: '.BU', sonstige: '.BU' },
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
  const parts = [c.firma1];
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
  const wantErp = String(c.erpNr || '').trim();
  let exact = null;
  let fuzzy = null;
  for await (const entry of typeDir.values()) {
    if (entry.kind !== 'directory') continue;
    const norm = CRM.ablage.normalizeName(entry.name);
    // ERP-Treffer = immer eindeutig, sofortiger Abbruch
    if (wantErp && entry.name.includes(wantErp)) { exact = entry; break; }
    // Exakter Name-Treffer: normalisierter Ordnername stimmt überein ODER beginnt mit Firma
    if (norm === wantFull || (wantName && norm.startsWith(wantName))) {
      exact = exact || entry;
      continue;
    }
    // Ähnlichkeit nur als letzter Ausweg (erhöhter Schwellenwert)
    if (exact) continue;
    const score = CRM.ablage.folderSimilarity(norm, wantFull);
    if (score >= CRM.ablage.SIMILARITY_ASK_THRESHOLD && (!fuzzy || score > fuzzy.score)) fuzzy = { entry, score };
  }
  return { exact, fuzzy };
};

/* Rückfrage-Dialog, wenn kein sicherer Treffer, aber ein ähnlicher Ordner existiert */
CRM.ablage.confirmSimilarFolder = function (c, entry) {
  return new Promise((resolve) => {
    CRM.openModal(`
      <h2>Ähnlicher Ordner gefunden</h2>
      <p style="font-size:13px">Für „<strong>${esc(c.firma1)}</strong>“ gibt es keinen exakt passenden Ordner — aber diesen ähnlichen:</p>
      <div class="list-item" style="cursor:default"><div class="li-main"><div class="li-title">📁 ${esc(entry.name)}</div></div></div>
      <p style="font-size:13px;color:var(--text-dim)">Ist das derselbe Kunde? Dann wird dort weitergeschrieben — sonst wird ein neuer Ordner „${esc(CRM.ablage.customerFolderName(c))}“ angelegt.</p>
      <div class="modal-footer">
        <button class="btn" id="abl-fuzzy-no">Nein, neuen Ordner anlegen</button>
        <button class="btn btn-primary" id="abl-fuzzy-yes">Ja, diesen Ordner verwenden</button>
      </div>
    `);
    document.getElementById('abl-fuzzy-yes').addEventListener('click', () => { CRM.closeModal(); resolve(true); });
    document.getElementById('abl-fuzzy-no').addEventListener('click', () => { CRM.closeModal(); resolve(false); });
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
    let usedFuzzy = false;
    if (!custDir && found.fuzzy) {
      usedFuzzy = await CRM.ablage.confirmSimilarFolder(c, found.fuzzy.entry);
      if (usedFuzzy) custDir = found.fuzzy.entry;
    }
    if (!custDir) {
      const folderName = CRM.ablage.customerFolderName(c);
      custDir = await typeDir.getDirectoryHandle(folderName, { create: true });
      log.push('Ordner neu angelegt: ' + typeFolderName + '\\' + folderName);
    } else if (usedFuzzy) {
      log.push('Ähnlichen Kundenordner bestätigt und verwendet: ' + typeFolderName + '\\' + custDir.name);
    } else {
      log.push('Kundenordner gefunden: ' + typeFolderName + '\\' + custDir.name);
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
    <h2>📋 In Excel ablegen — ${esc(c.firma1)}</h2>
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
CRM.ablage.getEingangDir = async function (create) {
  const root = await CRM.ablage.ensureRoot();
  if (!root) return null;
  try {
    return await root.getDirectoryHandle('Eingang', { create: !!create });
  } catch (e) {
    return null;
  }
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

  const stats = { neu: 0, aktualisiert: 0, besucheUebernommen: 0, inExcelAbgelegt: 0, fehler: 0 };

  for (const fileHandle of files) {
    let payload;
    try {
      const text = await (await fileHandle.getFile()).text();
      payload = JSON.parse(text);
    } catch (e) {
      stats.fehler++;
      continue; // Datei bleibt liegen, falls sie defekt ist — keine Löschung
    }

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
        continue;
      }

      for (const v of newVisits) {
        if (!v.note) continue; // leere Schnell-Besuche ohne Inhalt nicht in Excel ablegen
        try {
          const essence = CRM.ablage.noteToEssence(v.note);
          const result = await CRM.ablage.fileVisit(contactId, v, essence, { silent: true });
          if (result && result.ok) stats.inExcelAbgelegt++; else stats.fehler++;
        } catch (e) {
          stats.fehler++;
        }
      }
    }

    await dir.removeEntry(fileHandle.name);
  }

  if (CRM.renderContactList && document.querySelector('#view-kontakte.active')) CRM.renderContactList();
  const summary = `📥 Eingang verarbeitet: ${stats.neu} neue Kontakte, ${stats.aktualisiert} aktualisiert, ${stats.besucheUebernommen} Besuche übernommen, ${stats.inExcelAbgelegt} in Excel abgelegt${stats.fehler ? `, ${stats.fehler} Fehler` : ''}.`;
  if (!silent || stats.neu || stats.aktualisiert || stats.fehler) {
    CRM.toast(summary, stats.fehler ? 'error' : 'success');
  }
};
