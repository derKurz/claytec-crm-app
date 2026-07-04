/* ============================================================
   Claytec CRM — Excel-Import mit Spalten-Mapping & Duplikat-Erkennung
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.importer = {};

/* Felder, auf die Excel-Spalten gemappt werden können */
CRM.importer.TARGET_FIELDS = [
  { key: 'erpNr', label: 'ERP-/Kundennummer (Nr.)' },
  { key: 'firma1', label: 'Firma 1 (Name)', required: true },
  { key: 'firma2', label: 'Firma 2 / Ansprechpartner-Zusatz' },
  { key: 'firma3', label: 'Firma 3' },
  { key: 'firma4', label: 'Firma 4' },
  { key: 'anredeFirma', label: 'Anrede Firma' },
  { key: 'strasse', label: 'Straße' },
  { key: 'land', label: 'Land' },
  { key: 'plz', label: 'PLZ', required: true },
  { key: 'ort', label: 'Ort' },
  { key: 'telFirma', label: 'Telefon Firma' },
  { key: 'faxFirma', label: 'Fax Firma' },
  { key: 'emailFirma', label: 'E-Mail Firma' },
  { key: 'name', label: 'Nachname Ansprechpartner' },
  { key: 'vorname', label: 'Vorname Ansprechpartner' },
  { key: 'telAnsp', label: 'Telefon Ansprechpartner' },
  { key: 'emailAnsp', label: 'E-Mail Ansprechpartner' },
  { key: 'kategorie', label: 'Kategorie-Code (z.B. AR/HA/BU)' },
];

/* Auto-Mapping anhand bekannter Spaltenüberschriften aus den Claytec-Quelldateien */
CRM.importer.HEADER_ALIASES = {
  erpNr: ['nr.', 'nr', 'erp-nr', 'erp nr', 'kundennr', 'kunden-nr', 'adressnr', 'adress-nr'],
  firma1: ['firma 1', 'firma1', 'firmenname'],
  firma2: ['firma 2', 'firma2'],
  firma3: ['firma 3', 'firma3'],
  firma4: ['firma 4', 'firma4'],
  anredeFirma: ['anrede firma'],
  strasse: ['straße', 'strasse'],
  land: ['land'],
  plz: ['plz'],
  ort: ['ort'],
  telFirma: ['tel. firma', 'telefon firma'],
  faxFirma: ['fax firma'],
  emailFirma: ['e-mail firma', 'email firma'],
  name: ['name'],
  vorname: ['vorname'],
  telAnsp: ['tel. ansp.', 'telefon ansprechpartner'],
  emailAnsp: ['e-mail ansp.', 'email ansprechpartner'],
  kategorie: ['kategorie'],
};

CRM.importer.KATEGORIE_TYPE_MAP = {
  AR: 'architekt',
  HA: 'haendler',
  BU: 'verarbeiter', // Bauunternehmen/Handwerk -> Verarbeiter
};

function normalizeHeader(h) {
  return String(h || '').trim().toLowerCase();
}

CRM.importer.guessMapping = function (headers) {
  const mapping = {};
  headers.forEach((h, idx) => {
    const norm = normalizeHeader(h);
    for (const [field, aliases] of Object.entries(CRM.importer.HEADER_ALIASES)) {
      if (aliases.includes(norm) && mapping[field] === undefined) {
        mapping[field] = idx;
      }
    }
  });
  return mapping;
};

/* ---------- Excel parsing via SheetJS ---------- */
CRM.importer.parseWorkbook = function (arrayBuffer) {
  const wb = XLSX.read(arrayBuffer, { type: 'array' });
  const sheets = wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    return { name, rows };
  }).filter((s) => s.rows.length > 1);
  return sheets;
};

/* Findet die wahrscheinlichste Header-Zeile (erste Zeile mit >=3 nicht-leeren Strings) */
CRM.importer.findHeaderRowIndex = function (rows) {
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    const nonEmpty = rows[i].filter((c) => String(c).trim() !== '').length;
    if (nonEmpty >= 3) return i;
  }
  return 0;
};

function clean(v) {
  return String(v == null ? '' : v).trim();
}

/* Baut aus einer Datenzeile + Mapping ein Contact-Rohobjekt (noch nicht final typisiert) */
CRM.importer.rowToContact = function (row, mapping, defaults) {
  const c = CRM.makeEmptyContact();
  c.source = defaults.source;
  c.type = defaults.type || 'sonstige';
  c.isPartner = !!defaults.isPartner;
  c.abc = defaults.abc || 'C';

  const get = (field) => (mapping[field] != null ? clean(row[mapping[field]]) : '');

  c.erpNr = get('erpNr');
  c.firma1 = get('firma1');
  c.firma2 = get('firma2');
  c.firma3 = get('firma3');
  c.firma4 = get('firma4');
  c.anredeFirma = get('anredeFirma');
  c.strasse = get('strasse');
  c.land = get('land') || 'D';
  c.plz = get('plz').replace(/\s+/g, '');
  c.ort = get('ort');
  c.telFirma = get('telFirma');
  c.faxFirma = get('faxFirma');
  c.emailFirma = get('emailFirma');
  c.ansprechpartner.name = get('name');
  c.ansprechpartner.vorname = get('vorname');
  c.ansprechpartner.telefon = get('telAnsp');
  c.ansprechpartner.email = get('emailAnsp');

  const kategorie = get('kategorie').toUpperCase();
  if (kategorie && CRM.importer.KATEGORIE_TYPE_MAP[kategorie]) {
    c.type = CRM.importer.KATEGORIE_TYPE_MAP[kategorie];
  }

  // "kein Eintrag" Platzhalter aus Quelldaten bereinigen
  ['name', 'vorname', 'telefon', 'email'].forEach((k) => {
    if (clean(c.ansprechpartner[k]).toLowerCase() === 'kein eintrag') c.ansprechpartner[k] = '';
  });

  return c;
};

/* ============================================================
   Duplikat-Erkennung: Firmenname (normalisiert) + PLZ, Fuzzy-Matching
   ============================================================ */
function normalizeCompanyName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[äöüß]/g, (m) => ({ ä: 'ae', ö: 'oe', ü: 'ue', ß: 'ss' }[m]))
    .replace(/\b(gmbh|co\.?\s*kg|kg|ag|gbr|e\.?k\.?|inh\.?|& co|gmbh & co)\b/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/* Levenshtein-Distanz */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function similarity(a, b) {
  if (!a && !b) return 1;
  if (!a || !b) return 0;
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length);
  return maxLen === 0 ? 1 : 1 - dist / maxLen;
}

/* Vergleicht Kandidat mit bestehendem Kontakt -> Score 0..1 */
CRM.importer.matchScore = function (candidate, existing) {
  if (clean(candidate.plz) !== clean(existing.plz)) return 0;
  const n1 = normalizeCompanyName(candidate.firma1);
  const n2 = normalizeCompanyName(existing.firma1);
  return similarity(n1, n2);
};

CRM.importer.DUPLICATE_THRESHOLD = 0.82;

/* Findet für eine Liste neuer Kandidaten mögliche Duplikate in bestehenden Kontakten,
   sowie Duplikate untereinander innerhalb der neuen Liste. */
CRM.importer.findDuplicates = function (candidates, existingContacts) {
  const results = []; // { candidate, matches: [{contact, score, isNewBatch}] }
  const accepted = []; // candidates ohne erkanntes Duplikat (werden in pool eingereiht für Batch-internen Vergleich)

  candidates.forEach((cand) => {
    const matches = [];
    existingContacts.forEach((ex) => {
      const score = CRM.importer.matchScore(cand, ex);
      if (score >= CRM.importer.DUPLICATE_THRESHOLD) {
        matches.push({ contact: ex, score, isNewBatch: false });
      }
    });
    accepted.forEach((other) => {
      const score = CRM.importer.matchScore(cand, other);
      if (score >= CRM.importer.DUPLICATE_THRESHOLD) {
        matches.push({ contact: other, score, isNewBatch: true });
      }
    });
    if (matches.length) {
      matches.sort((a, b) => b.score - a.score);
      results.push({ candidate: cand, matches });
    } else {
      accepted.push(cand);
    }
  });

  return { duplicates: results, clean: accepted };
};

/* Merged Felder eines Duplikat-Kandidaten in einen bestehenden Kontakt
   (überschreibt nur leere Felder, fügt source-Tag hinzu falls neu) */
CRM.importer.mergeIntoExisting = function (existing, candidate) {
  const fieldsToFill = [
    'strasse', 'land', 'plz', 'ort', 'telFirma', 'faxFirma', 'emailFirma',
    'firma2', 'firma3', 'firma4', 'anredeFirma',
  ];
  fieldsToFill.forEach((f) => {
    if (!clean(existing[f]) && clean(candidate[f])) existing[f] = candidate[f];
  });
  ['name', 'vorname', 'telefon', 'email'].forEach((f) => {
    if (!clean(existing.ansprechpartner[f]) && clean(candidate.ansprechpartner[f])) {
      existing.ansprechpartner[f] = candidate.ansprechpartner[f];
    }
  });
  if (candidate.isPartner) existing.isPartner = true;
  if (!existing._sources) existing._sources = [existing.source];
  if (!existing._sources.includes(candidate.source)) existing._sources.push(candidate.source);
  existing.updatedAt = new Date().toISOString();
  return existing;
};

/* ============================================================
   Duplikat-Suche im bestehenden Bestand (z.B. nach Import aus
   mehreren Listen) — nutzt dieselbe Ähnlichkeits-Logik wie der
   Import-Abgleich, vergleicht aber alle Kontaktpaare miteinander.
   ============================================================ */
CRM.findDuplicateContacts = function () {
  const contacts = CRM.db.getContacts();
  const dismissed = CRM._dismissedDupes || new Set();
  const pairs = [];
  for (let i = 0; i < contacts.length; i++) {
    for (let j = i + 1; j < contacts.length; j++) {
      const a = contacts[i];
      const b = contacts[j];
      const key = [a.id, b.id].sort().join('|');
      if (dismissed.has(key)) continue;
      const score = CRM.importer.matchScore(a, b);
      if (score >= CRM.importer.DUPLICATE_THRESHOLD) pairs.push({ a, b, score, key });
    }
  }
  pairs.sort((x, y) => y.score - x.score);
  return pairs;
};
