/* ============================================================
   Claytec CRM — vCard-Export (.vcf)
   Format wie contact_parser.py (vCard 3.0): beim Anlegen eines
   Kontakts wird die .vcf automatisch im Kundenordner der
   Excel-Ablage (.Kunden\<Typ>\<Kunde>\) gespeichert — für den
   späteren Import in Google Kontakte. Am Handy (kein Ordner-
   zugriff) wird die Datei stattdessen heruntergeladen.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.vcard = {};

/* vCard-3.0-Text aus einem CRM-Kontakt bauen (Feld-Mapping wie
   contact_parser.py: N/FN, ORG, TITLE, EMAIL pref/2., CELL/WORK, ADR, URL) */
CRM.vcard.build = function (c) {
  const ap = c.ansprechpartner || {};
  const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];

  const fullName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  if (fullName) {
    lines.push('N:' + esc(ap.name) + ';' + esc(ap.vorname) + ';;;');
    lines.push('FN:' + esc(fullName));
  } else {
    lines.push('FN:' + esc(c.firma1));
  }
  if (c.firma1) lines.push('ORG:' + esc(c.firma1));
  if (ap.funktion) lines.push('TITLE:' + esc(ap.funktion));
  if (ap.email) lines.push('EMAIL;TYPE=INTERNET,PREF:' + esc(ap.email));
  if (c.emailFirma && c.emailFirma !== ap.email) lines.push('EMAIL;TYPE=INTERNET:' + esc(c.emailFirma));
  if (ap.telefon) lines.push('TEL;TYPE=CELL:' + esc(ap.telefon));
  if (c.telFirma) lines.push('TEL;TYPE=WORK:' + esc(c.telFirma));
  if (c.strasse || c.ort || c.plz) lines.push('ADR;TYPE=WORK:;;' + esc(c.strasse) + ';' + esc(c.ort) + ';;' + esc(c.plz) + ';;');
  if (c.website) lines.push('URL:' + esc(c.website));
  if (c.erpNr) lines.push('NOTE:' + esc('ERP-Nr.: ' + c.erpNr));
  lines.push('END:VCARD');
  return lines.join('\n') + '\n';
};

CRM.vcard.fileName = function (c) {
  const ap = c.ansprechpartner || {};
  const person = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const base = person ? c.firma1 + ' - ' + person : c.firma1;
  return (CRM.ablage ? CRM.ablage.sanitizeFile(base) : base).replace(/\s+/g, '_') + '.vcf';
};

CRM.vcard.download = function (c) {
  const blob = new Blob([CRM.vcard.build(c)], { type: 'text/vcard;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = CRM.vcard.fileName(c);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

/* Bereits verbundenen Claytec-Ordner holen OHNE einen Auswahl-Dialog zu
   öffnen — für die automatische Ablage beim Kontakt-Anlegen. */
CRM.vcard.getConnectedRoot = async function () {
  if (!CRM.ablage || !CRM.ablage.supported()) return null;
  if (CRM.ablage.rootHandle) {
    if (await CRM.ablage.verifyPermission(CRM.ablage.rootHandle)) return CRM.ablage.rootHandle;
    return null;
  }
  const stored = await CRM.ablage.idbGet('claytecRoot');
  if (stored && (await CRM.ablage.verifyPermission(stored))) {
    CRM.ablage.rootHandle = stored;
    return stored;
  }
  return null;
};

/* .vcf in den Kundenordner schreiben (Ordner wird bei Bedarf angelegt —
   dieselbe Logik wie die Excel-Ablage). Rückgabe: relativer Pfad oder null. */
CRM.vcard.saveToCustomerFolder = async function (c) {
  const root = await CRM.vcard.getConnectedRoot();
  if (!root) return null;
  const kunden = await root.getDirectoryHandle('.Kunden');
  const typeFolderName = CRM.ablage.TYPE_FOLDER[c.type] || '.BU';
  const typeDir = await kunden.getDirectoryHandle(typeFolderName);
  const found = await CRM.ablage.findCustomerDir(typeDir, c);
  let custDir = found.exact;
  if (!custDir) {
    custDir = await typeDir.getDirectoryHandle(CRM.ablage.customerFolderName(c), { create: true });
  }
  const name = CRM.vcard.fileName(c);
  const fh = await custDir.getFileHandle(name, { create: true });
  const w = await fh.createWritable();
  await w.write(CRM.vcard.build(c));
  await w.close();
  return '.Kunden\\' + typeFolderName + '\\' + custDir.name + '\\' + name;
};

/* Automatik beim Anlegen eines neuen Kontakts: am Laptop in den
   Kundenordner schreiben, sonst still überspringen (am Handy gibt es
   den 📇-Button im Kontaktprofil für den Download bei Bedarf). */
CRM.vcard.autoSave = async function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  try {
    const rel = await CRM.vcard.saveToCustomerFolder(c);
    // Kein Dialog beim automatischen Anlegen (zu aufdringlich) — aber der
    // Ordner wird genannt, damit die Datei auffindbar ist.
    if (rel) CRM.toast('📇 vCard gespeichert: ' + rel, 'success');
  } catch (e) {
    // Ablage nicht verbunden / Ordnerstruktur fehlt — kein Fehler wert,
    // der 📇-Button im Kontaktprofil bleibt als manueller Weg.
  }
};

/* Manuell aus dem Kontaktprofil: Laptop → Kundenordner, Handy → Download.
   Zeigt danach einen Dialog mit dem konkreten Speicherort und dem Weg
   nach Google Kontakte — eine flüchtige Toast-Meldung reicht dafür nicht. */
CRM.vcard.exportContact = async function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  try {
    const rel = await CRM.vcard.saveToCustomerFolder(c);
    if (rel) { CRM.vcard.showResult(c, rel); return; }
  } catch (e) {
    // Ablage nicht verbunden → Download-Weg
  }
  CRM.vcard.download(c);
  CRM.vcard.showResult(c, null);
};

CRM.vcard.showResult = function (c, rel) {
  const dateiname = CRM.vcard.fileName(c);
  const voll = rel && CRM.ablage ? CRM.ablage.fullPath(rel) : null;
  const hatBasis = !!((CRM.db.getSettings().onedrivePath || '').trim());

  const ortHtml = rel
    ? `
      <p style="margin:0 0 6px"><strong>Gespeichert im Kundenordner:</strong></p>
      <p style="font-family:monospace;font-size:12px;background:var(--bg);padding:8px 10px;border-radius:6px;word-break:break-all;margin:0 0 8px">${esc(voll || rel)}</p>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        ${voll ? `<a class="btn btn-sm" href="${esc(CRM.ablage.fileUrl(voll))}" target="_blank" rel="noopener">📂 Ordner öffnen</a>` : ''}
        <button class="btn btn-sm" onclick="CRM.ablage.copyPath('${escAttr(voll || rel)}')">📋 Pfad kopieren</button>
        <button class="btn btn-sm" onclick="CRM.vcard.downloadFromDialog('${c.id}')">⬇ Zusätzlich herunterladen</button>
      </div>
      ${hatBasis ? '' : '<p style="font-size:12px;color:var(--text-dim);margin:8px 0 0">Hinterlege deinen Claytec-Ordnerpfad in den Einstellungen, dann führt „Ordner öffnen" direkt in den Explorer.</p>'}`
    : `
      <p style="margin:0 0 6px"><strong>Heruntergeladen als:</strong></p>
      <p style="font-family:monospace;font-size:12px;background:var(--bg);padding:8px 10px;border-radius:6px;word-break:break-all;margin:0 0 8px">${esc(dateiname)}</p>
      <p style="font-size:13px;margin:0">Die Datei liegt in deinem <strong>Download-Ordner</strong> (am Handy: „Downloads", am Laptop meist <code>C:\\Users\\...\\Downloads</code>).</p>`;

  CRM.openModal(`
    <h2>📇 vCard erstellt</h2>
    ${ortHtml}
    <hr style="border-color:var(--border);margin:14px 0">
    <p style="margin:0 0 6px"><strong>So kommt der Kontakt zu Google Kontakte:</strong></p>
    <p style="font-size:13px;margin:0 0 4px"><strong>Am Handy:</strong> Datei in den Downloads antippen → Android bietet „Zu Kontakten hinzufügen" an.</p>
    <p style="font-size:13px;margin:0 0 10px"><strong>Am Laptop:</strong> Google Kontakte öffnen → links <em>Importieren</em> → <em>Datei auswählen</em> → die <code>.vcf</code> auswählen.</p>
    <a class="btn btn-primary btn-sm" href="https://contacts.google.com/" target="_blank" rel="noopener">🌐 Google Kontakte öffnen</a>
    <div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>
  `);
};

CRM.vcard.downloadFromDialog = function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (c) { CRM.vcard.download(c); CRM.toast('vCard zusätzlich in den Download-Ordner gelegt.', 'success'); }
};
