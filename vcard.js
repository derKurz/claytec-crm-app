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
    if (rel) CRM.toast('📇 vCard im Kundenordner gespeichert.', 'success');
  } catch (e) {
    // Ablage nicht verbunden / Ordnerstruktur fehlt — kein Fehler wert,
    // der 📇-Button im Kontaktprofil bleibt als manueller Weg.
  }
};

/* Manuell aus dem Kontaktprofil: Laptop → Kundenordner, Handy → Download */
CRM.vcard.exportContact = async function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  try {
    const rel = await CRM.vcard.saveToCustomerFolder(c);
    if (rel) {
      CRM.toast('📇 vCard gespeichert: ' + rel, 'success');
      return;
    }
  } catch (e) {
    // Fallback: Download
  }
  CRM.vcard.download(c);
  CRM.toast('📇 vCard heruntergeladen — am Handy zum Importieren antippen.', 'success');
};
