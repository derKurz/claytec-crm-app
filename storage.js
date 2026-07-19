/* ============================================================
   Claytec CRM — Datenmodell & LocalStorage-Layer
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.KEYS = {
  CONTACTS: 'crm_contacts',
  PROJECTS: 'crm_projects',
  TASKS: 'crm_tasks',
  COMMS: 'crm_comms',
  JOURNAL: 'crm_journal',
  SETTINGS: 'crm_settings',
  META: 'crm_meta',
};

/* Kontaktjournal (PRODUCT_VISION.md): fortlaufende, NIE als Besuchsbericht
   gewertete Notizen (Telefon/Mail/Info/...). Getrennt von visits[], die der
   offizielle, exportierbare Besuchsbericht sind. */
CRM.JOURNAL_TYPES = ['info', 'telefon', 'mail', 'whatsapp', 'teams'];
CRM.JOURNAL_TYPE_LABELS = { info: '📝 Info', telefon: '📞 Telefon', mail: '✉ Mail', whatsapp: '💬 WhatsApp', teams: '👥 Teams' };

CRM.TYPES = ['haendler', 'verarbeiter', 'architekt', 'bauherr', 'sonstige'];
CRM.TYPE_LABELS = {
  haendler: 'Händler',
  verarbeiter: 'Verarbeiter',
  architekt: 'Architekt',
  bauherr: 'Bauherr',
  sonstige: 'Sonstige',
};
CRM.TYPE_SHORT = {
  haendler: 'HA',
  verarbeiter: 'BU',
  architekt: 'AR',
  bauherr: 'BH',
  sonstige: 'SO',
};
CRM.SOURCES = ['eigene', 'eurobaustoff', 'partner', 'baywa'];
CRM.SOURCE_LABELS = {
  eigene: 'Eigene',
  eurobaustoff: 'Eurobaustoff',
  partner: 'Partner',
  baywa: 'BayWa',
};
CRM.ABC = ['A', 'B', 'C'];

CRM.PROJECT_STATUS = ['planung', 'ausschreibung', 'laufend', 'abgeschlossen'];
CRM.PROJECT_STATUS_LABELS = {
  planung: 'Planung',
  ausschreibung: 'Ausschreibung',
  laufend: 'Laufend',
  abgeschlossen: 'Abgeschlossen',
};
CRM.PRODUCTS = ['YOSIMA', 'LEMIX', 'Lehmbauplatte'];
/* Projekt-Produkte nach Kategorie (CLAUDE.md: nur dokumentierte Produkte;
   eigene Aufbauvarianten kommen als Freitext mit "Kategorie: ..."-Präfix dazu) */
CRM.PRODUCT_CATEGORIES = {
  'Lehm-Putz': ['YOSIMA', 'LEMIX'],
  'Lehm-Trockenbau': ['Lehmbauplatte'],
};

/* Kommunikations-Typen (E-Mail-fähiges Fundament). Eine Kommunikation kann an
   mehreren Kontakten UND Projekten hängen (many-to-many) — so taucht z.B. eine
   Mail sowohl beim Architekten als auch bei „Projekt B" und „Projekt D" auf. */
CRM.COMM_TYPES = ['email', 'note', 'call'];
CRM.COMM_TYPE_LABELS = { email: '✉ E-Mail', note: '📝 Notiz', call: '📞 Anruf' };

CRM.DEFAULT_SETTINGS = {
  whisperApiKey: '',
  speechEngine: 'webspeech', // webspeech | whisper
  adKuerzel: 'CK', // Außendienst-Kürzel für Besuchsprotokoll (Spalte B)
  intervals: { A: 30, B: 60, C: 90 },
  lastBackupAt: null,
  lastBackupPromptAt: null,
  supabaseUrl: '', // Phase 3 (OFFLINE_SYNC.md) — Cloud-Sync, opt-in
  supabasePublishableKey: '', // "anon"/"public" Key — bewusst NICHT der secret/service_role Key
};

/* ---------- low-level storage helpers ---------- */
CRM.storage = {
  read(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      console.error('Storage read error', key, e);
      return fallback;
    }
  },
  write(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (e) {
      console.error('Storage write error', key, e);
      if (window.CRM.toast) window.CRM.toast('Speicherfehler — evtl. Speicher voll!', 'error');
      return false;
    }
  },
};

/* ---------- id generation ---------- */
CRM.uid = function (prefix) {
  return (prefix || 'id') + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 9);
};

/* ============================================================
   Data access objects
   ============================================================ */
CRM.db = {
  _contacts: null,
  _projects: null,
  _tasks: null,
  _comms: null,
  _journal: null,
  _settings: null,
  _meta: null,

  init() {
    this._contacts = CRM.storage.read(CRM.KEYS.CONTACTS, []);
    this._projects = CRM.storage.read(CRM.KEYS.PROJECTS, []);
    this._tasks = CRM.storage.read(CRM.KEYS.TASKS, []);
    this._comms = CRM.storage.read(CRM.KEYS.COMMS, []);
    this._journal = CRM.storage.read(CRM.KEYS.JOURNAL, []);
    this._settings = Object.assign({}, CRM.DEFAULT_SETTINGS, CRM.storage.read(CRM.KEYS.SETTINGS, {}));
    this._meta = CRM.storage.read(CRM.KEYS.META, { importedFiles: [] });
  },

  /* ---- Kontaktjournal (fortlaufend, nie Besuchsbericht/Excel) ---- */
  getJournalEntries() {
    return this._journal;
  },
  getJournalForContact(contactId) {
    return this._journal.filter((j) => j.contactId === contactId);
  },
  saveJournal() {
    CRM.storage.write(CRM.KEYS.JOURNAL, this._journal);
    CRM._mirrorToDexie('journal_entries', this._journal);
  },
  addJournalEntry(entry) {
    entry.id = entry.id || CRM.uid('j');
    entry.createdAt = entry.createdAt || new Date().toISOString();
    entry.isShared = !!entry.isShared;
    this._journal.push(entry);
    this.saveJournal();
    return entry;
  },
  deleteJournalEntry(id) {
    this._journal = this._journal.filter((j) => j.id !== id);
    this.saveJournal();
  },

  /* ---- Communications (E-Mail-fähiges Fundament, many-to-many) ---- */
  getComms() {
    return this._comms;
  },
  getComm(id) {
    return this._comms.find((m) => m.id === id) || null;
  },
  getCommsForContact(contactId) {
    return this._comms.filter((m) => (m.contactIds || []).includes(contactId));
  },
  getCommsForProject(projectId) {
    return this._comms.filter((m) => (m.projectIds || []).includes(projectId));
  },
  saveComms() {
    CRM.storage.write(CRM.KEYS.COMMS, this._comms);
    CRM._mirrorToDexie('comms', this._comms);
  },
  addComm(comm) {
    comm.id = comm.id || CRM.uid('m');
    comm.createdAt = comm.createdAt || new Date().toISOString();
    comm.contactIds = comm.contactIds || [];
    comm.projectIds = comm.projectIds || [];
    this._comms.push(comm);
    this.saveComms();
    return comm;
  },
  updateComm(id, patch) {
    const m = this.getComm(id);
    if (!m) return null;
    Object.assign(m, patch);
    this.saveComms();
    return m;
  },
  deleteComm(id) {
    this._comms = this._comms.filter((m) => m.id !== id);
    this.saveComms();
  },

  /* ---- Tasks (Follow-up-Engine) ---- */
  getTasks() {
    return this._tasks;
  },
  getTask(id) {
    return this._tasks.find((t) => t.id === id) || null;
  },
  getTasksForContact(contactId) {
    return this._tasks.filter((t) => t.contactId === contactId);
  },
  saveTasks() {
    CRM.storage.write(CRM.KEYS.TASKS, this._tasks);
    CRM._mirrorToDexie('tasks', this._tasks);
  },
  addTask(task) {
    task.id = task.id || CRM.uid('t');
    task.createdAt = task.createdAt || new Date().toISOString();
    task.done = !!task.done;
    this._tasks.push(task);
    this.saveTasks();
    return task;
  },
  updateTask(id, patch) {
    const t = this.getTask(id);
    if (!t) return null;
    Object.assign(t, patch);
    this.saveTasks();
    return t;
  },
  deleteTask(id) {
    this._tasks = this._tasks.filter((t) => t.id !== id);
    this.saveTasks();
  },

  /* ---- Contacts ---- */
  getContacts() {
    return this._contacts;
  },
  getContact(id) {
    return this._contacts.find((c) => c.id === id) || null;
  },
  saveContacts() {
    CRM.storage.write(CRM.KEYS.CONTACTS, this._contacts);
    CRM._mirrorToDexie('contacts', this._contacts);
  },
  addContact(contact) {
    contact.id = contact.id || CRM.uid('c');
    contact.createdAt = contact.createdAt || new Date().toISOString();
    contact.updatedAt = new Date().toISOString();
    this._contacts.push(contact);
    this.saveContacts();
    return contact;
  },
  updateContact(id, patch) {
    const c = this.getContact(id);
    if (!c) return null;
    Object.assign(c, patch, { updatedAt: new Date().toISOString() });
    this.saveContacts();
    return c;
  },
  deleteContact(id) {
    this._contacts = this._contacts.filter((c) => c.id !== id);
    // remove dangling links
    this._contacts.forEach((c) => {
      Object.keys(c.links || {}).forEach((k) => {
        c.links[k] = (c.links[k] || []).filter((x) => x !== id);
      });
    });
    this._projects.forEach((p) => {
      p.contactIds = (p.contactIds || []).filter((x) => x !== id);
    });
    this._tasks = this._tasks.filter((t) => t.contactId !== id);
    this._comms.forEach((m) => { m.contactIds = (m.contactIds || []).filter((x) => x !== id); });
    this._journal = this._journal.filter((j) => j.contactId !== id);
    this.saveContacts();
    this.saveProjects();
    this.saveTasks();
    this.saveComms();
    this.saveJournal();
  },

  /* ---- Projects ---- */
  getProjects() {
    return this._projects;
  },
  getProject(id) {
    return this._projects.find((p) => p.id === id) || null;
  },
  saveProjects() {
    CRM.storage.write(CRM.KEYS.PROJECTS, this._projects);
    CRM._mirrorToDexie('projects', this._projects);
  },
  addProject(project) {
    project.id = project.id || CRM.uid('p');
    project.createdAt = project.createdAt || new Date().toISOString();
    project.updatedAt = new Date().toISOString();
    project.status = project.status || 'planung';
    project.contactIds = project.contactIds || [];
    project.products = project.products || [];
    this._projects.push(project);
    this.saveProjects();
    return project;
  },
  updateProject(id, patch) {
    const p = this.getProject(id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date().toISOString() });
    this.saveProjects();
    return p;
  },
  deleteProject(id) {
    this._projects = this._projects.filter((p) => p.id !== id);
    this._contacts.forEach((c) => {
      c.links = c.links || {};
      c.links.projektIds = (c.links.projektIds || []).filter((x) => x !== id);
    });
    this._comms.forEach((m) => { m.projectIds = (m.projectIds || []).filter((x) => x !== id); });
    this.saveProjects();
    this.saveContacts();
    this.saveComms();
  },

  /* ---- Settings ---- */
  getSettings() {
    return this._settings;
  },
  saveSettings(patch) {
    Object.assign(this._settings, patch);
    CRM.storage.write(CRM.KEYS.SETTINGS, this._settings);
    CRM._mirrorKvToDexie('settings', this._settings);
    return this._settings;
  },

  /* ---- Meta ---- */
  getMeta() {
    return this._meta;
  },
  saveMeta(patch) {
    Object.assign(this._meta, patch);
    CRM.storage.write(CRM.KEYS.META, this._meta);
    CRM._mirrorKvToDexie('meta', this._meta);
    return this._meta;
  },
};

/* ============================================================
   Factory: leeres Projekt / leere Kommunikation
   ============================================================ */
CRM.makeEmptyProject = function () {
  return {
    id: null,
    name: '',
    status: 'planung',
    erpNr: '',
    ort: '',
    plz: '',
    contactIds: [],
    products: [],
    notes: '',
    createdAt: null,
    updatedAt: null,
  };
};

CRM.makeEmptyComm = function () {
  return {
    id: null,
    type: 'email',
    direction: 'in', // 'in' (eingehend) | 'out' (ausgehend)
    date: new Date().toISOString().slice(0, 10),
    subject: '',
    body: '',
    from: '',
    to: '',
    contactIds: [],
    projectIds: [],
    createdAt: null,
  };
};

/* ============================================================
   Factory: leeren Kontakt erzeugen (Default-Datenmodell)
   ============================================================ */
CRM.makeEmptyContact = function () {
  return {
    id: null,
    type: 'sonstige',
    isPartner: false,
    source: 'eigene',
    abc: 'C',
    erpNr: '', // ERP-/Kundennummer (gibt der Nutzer vor; für Ordner-/Dateinamen der Excel-Ablage)
    anredeFirma: '',
    firma1: '',
    firma2: '',
    firma3: '',
    firma4: '',
    strasse: '',
    land: 'D',
    plz: '',
    ort: '',
    telFirma: '',
    faxFirma: '',
    emailFirma: '',
    website: '',
    notionUrl: '', // Link zur zugehörigen Notion-Seite (Wissens-/Doku-Ablage)
    ansprechpartner: {
      anrede: '',
      name: '',
      vorname: '',
      funktion: '',
      telefon: '',
      email: '',
    },
    lat: null,
    lng: null,
    geocodeStatus: 'pending', // pending | ok | failed | manual
    tags: [],
    nextStep: '', // = "To Do" (Spalte in der Übersicht, Spalte G im Besuchsprotokoll)
    notiz: '', // freie Kurznotiz, inline unter der Adresse einblendbar
    visits: [], // {id, date, note, createdAt}
    links: {
      haendlerIds: [],
      verarbeiterIds: [],
      architektIds: [],
      bauherrIds: [],
      projektIds: [],
    },
    linkMeta: {}, // {otherContactId: 'Beziehungslabel'}, z.B. "Empfehlung"
    createdAt: null,
    updatedAt: null,
  };
};

/* ============================================================
   Verknüpfungen (bidirektional): Händler ↔ Verarbeiter ↔ Architekt ↔ Projekt
   ============================================================ */
CRM.LINK_FIELD_FOR_TYPE = {
  haendler: 'haendlerIds',
  verarbeiter: 'verarbeiterIds',
  architekt: 'architektIds',
  bauherr: 'bauherrIds',
};

/* label (optional): freier Text zur Beschreibung der Beziehung, z.B.
   "Empfehlung", "Stammhändler" — wird beidseitig in linkMeta gemerkt und
   im Beziehungsnetz als Kantenbeschriftung angezeigt. */
CRM.linkContacts = function (idA, idB, label) {
  if (idA === idB) return;
  const a = CRM.db.getContact(idA);
  const b = CRM.db.getContact(idB);
  if (!a || !b) return;
  // Defensiv: ältere Kontakte (vor Einführung von "bauherrIds") haben dieses
  // Feld in ihrem links-Objekt noch nicht — ohne diese Absicherung würde
  // das Verknüpfen mit einem neuen Bauherr-Kontakt sonst abstürzen.
  a.links = a.links || {};
  b.links = b.links || {};
  const fieldForB = CRM.LINK_FIELD_FOR_TYPE[b.type];
  const fieldForA = CRM.LINK_FIELD_FOR_TYPE[a.type];
  if (fieldForB && !a.links[fieldForB]) a.links[fieldForB] = [];
  if (fieldForA && !b.links[fieldForA]) b.links[fieldForA] = [];
  if (fieldForB && !a.links[fieldForB].includes(idB)) a.links[fieldForB].push(idB);
  if (fieldForA && !b.links[fieldForA].includes(idA)) b.links[fieldForA].push(idA);
  if (label) {
    a.linkMeta = a.linkMeta || {};
    b.linkMeta = b.linkMeta || {};
    a.linkMeta[idB] = label;
    b.linkMeta[idA] = label;
  }
  a.updatedAt = new Date().toISOString();
  b.updatedAt = new Date().toISOString();
  CRM.db.saveContacts();
};

/* Einen Kontakt gleichzeitig mit mehreren anderen verknüpfen, alle mit
   demselben Beziehungslabel — z.B. ein Architekt empfiehlt für ein Projekt
   drei Handwerker in einem Schritt. */
CRM.linkContactsBulk = function (fromId, toIds, label) {
  (toIds || []).forEach((toId) => CRM.linkContacts(fromId, toId, label));
};

CRM.unlinkContacts = function (idA, idB) {
  const a = CRM.db.getContact(idA);
  const b = CRM.db.getContact(idB);
  if (!a || !b) return;
  Object.values(CRM.LINK_FIELD_FOR_TYPE).forEach((field) => {
    a.links[field] = (a.links[field] || []).filter((x) => x !== idB);
    b.links[field] = (b.links[field] || []).filter((x) => x !== idA);
  });
  if (a.linkMeta) delete a.linkMeta[idB];
  if (b.linkMeta) delete b.linkMeta[idA];
  CRM.db.saveContacts();
};

CRM.linkContactToProject = function (contactId, projectId) {
  const c = CRM.db.getContact(contactId);
  const p = CRM.db.getProject(projectId);
  if (!c || !p) return;
  c.links.projektIds = c.links.projektIds || [];
  if (!c.links.projektIds.includes(projectId)) c.links.projektIds.push(projectId);
  p.contactIds = p.contactIds || [];
  if (!p.contactIds.includes(contactId)) p.contactIds.push(contactId);
  CRM.db.saveContacts();
  CRM.db.saveProjects();
};

CRM.unlinkContactFromProject = function (contactId, projectId) {
  const c = CRM.db.getContact(contactId);
  const p = CRM.db.getProject(projectId);
  if (c) c.links.projektIds = (c.links.projektIds || []).filter((x) => x !== projectId);
  if (p) p.contactIds = (p.contactIds || []).filter((x) => x !== contactId);
  CRM.db.saveContacts();
  CRM.db.saveProjects();
};

/* ============================================================
   Visit / Besuchsrhythmus Helpers
   ============================================================ */
CRM.addVisit = function (contactId, dateStr, note) {
  const c = CRM.db.getContact(contactId);
  if (!c) return null;
  c.visits = c.visits || [];
  const visit = {
    id: CRM.uid('v'),
    date: dateStr || new Date().toISOString().slice(0, 10),
    note: note || '',
    createdAt: new Date().toISOString(),
  };
  c.visits.push(visit);
  c.visits.sort((a, b) => (a.date < b.date ? 1 : -1));
  c.updatedAt = new Date().toISOString();
  CRM.db.saveContacts();
  return visit;
};

CRM.updateVisit = function (contactId, visitId, patch) {
  const c = CRM.db.getContact(contactId);
  if (!c) return null;
  const v = (c.visits || []).find((x) => x.id === visitId);
  if (!v) return null;
  Object.assign(v, patch);
  v.updatedAt = new Date().toISOString();
  c.visits.sort((a, b) => (a.date < b.date ? 1 : -1));
  c.updatedAt = new Date().toISOString();
  CRM.db.saveContacts();
  return v;
};

CRM._removeVisit = function (contactId, visitId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  c.visits = (c.visits || []).filter((x) => x.id !== visitId);
  c.updatedAt = new Date().toISOString();
  CRM.db.saveContacts();
};

/* ============================================================
   Intelligente Suche: Normalisierung + Token-Vergleich.
   Behebt die typischen „findet nichts, obwohl richtig geschrieben"-Fälle:
   - Umlaute/Schreibweisen: „Müller" = „Mueller" = „Muller"
   - Satzzeichen: „Maier-Bau GmbH & Co." findet man mit „maier bau"
   - Wortreihenfolge: „baustoffe maier" findet „Maier Baustoffe"
   Jedes Suchwort muss irgendwo im Kontakt vorkommen (UND-Logik).
   ============================================================ */
CRM.searchNorm = function (s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ß/g, 'ss')
    .replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u')
    .replace(/ae/g, 'a').replace(/oe/g, 'o').replace(/ue/g, 'u')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
};

CRM.smartMatch = function (query, fields) {
  const tokens = CRM.searchNorm(query).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  const hay = ' ' + CRM.searchNorm(fields.filter(Boolean).join(' ')) + ' ';
  return tokens.every((t) => hay.includes(t));
};

/* Kontakt-Suche mit PLZ-Logik: reine Zahlen-Tokens wirken als
   PLZ-ANFANG („9" → 9xxxx, „92" → 92xxx, „923" → 923xx) oder
   ERP-Nr.-Anfang — nicht mehr als Treffer irgendwo in Telefon-/
   Hausnummern. Text-Tokens wie gehabt (Umlaute/Reihenfolge egal). */
CRM.contactQueryMatch = function (query, c) {
  const tokens = CRM.searchNorm(query).split(' ').filter(Boolean);
  if (!tokens.length) return false;
  let hay = null;
  return tokens.every((t) => {
    if (/^\d+$/.test(t)) {
      // 1–3 Ziffern: eindeutig PLZ-Anfang. Ab 4 Ziffern auch ERP-Nr.-Anfang.
      if (String(c.plz || '').startsWith(t)) return true;
      return t.length >= 4 && String(c.erpNr || '').replace(/\D/g, '').startsWith(t);
    }
    if (hay === null) hay = ' ' + CRM.searchNorm(CRM.contactSearchFields(c).filter(Boolean).join(' ')) + ' ';
    return hay.includes(t);
  });
};

CRM.contactSearchFields = function (c) {
  const ap = c.ansprechpartner || {};
  return [c.firma1, c.firma2, c.firma3, c.strasse, c.ort, c.plz, c.erpNr,
    ap.name, ap.vorname, ap.telefon, ap.email, c.telFirma, c.emailFirma,
    (c.tags || []).join(' ')];
};

CRM.getLastVisit = function (contact) {
  if (!contact.visits || !contact.visits.length) return null;
  return contact.visits.reduce((latest, v) => (!latest || v.date > latest.date ? v : latest), null);
};

CRM.getNextDueDate = function (contact) {
  const settings = CRM.db.getSettings();
  const interval = settings.intervals[contact.abc] || 60;
  const last = CRM.getLastVisit(contact);
  const base = last ? new Date(last.date) : new Date(contact.createdAt || Date.now());
  const due = new Date(base);
  due.setDate(due.getDate() + interval);
  return due;
};

CRM.getDueStatus = function (contact) {
  const due = CRM.getNextDueDate(contact);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  due.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (diffDays < 0) return { status: 'overdue', diffDays, due };
  if (diffDays === 0) return { status: 'today', diffDays, due };
  if (diffDays <= 7) return { status: 'week', diffDays, due };
  return { status: 'ok', diffDays, due };
};

/* Fasst offene Aufgaben (Aufgaben-Karte im Kontaktprofil) + "Nächster
   Schritt" zu einem Text für die To-Do-Spalte in den Übersichten zusammen,
   damit beide Eingabewege dort sichtbar sind. */
CRM.getOpenTodoText = function (c) {
  const items = CRM.db.getTasksForContact(c.id).filter((t) => !t.done).map((t) => t.title);
  if (c.nextStep && !items.includes(c.nextStep)) items.push(c.nextStep);
  return items.join(' · ');
};

/* ============================================================
   Zwei bestehende Kontakte zusammenführen (Duplikate aus zwei
   verschiedenen Listen): `keepId` bleibt erhalten, leere Felder
   werden aus `dropId` ergänzt; Besuche, Tags, Aufgaben, E-Mails/
   Kommunikation, Projekt- und Kontaktverknüpfungen werden auf
   `keepId` umgehängt, `dropId` wird danach gelöscht.
   ============================================================ */
CRM.mergeContacts = function (keepId, dropId) {
  if (keepId === dropId) return;
  const keep = CRM.db.getContact(keepId);
  const drop = CRM.db.getContact(dropId);
  if (!keep || !drop) return;
  CRM.takeSnapshot('Vor Zusammenführen von Kontakten');

  const simpleFields = ['anredeFirma', 'firma2', 'firma3', 'firma4', 'erpNr', 'strasse', 'plz', 'ort', 'land', 'telFirma', 'faxFirma', 'emailFirma', 'website', 'notiz', 'nextStep'];
  simpleFields.forEach((f) => {
    if (!String(keep[f] || '').trim() && String(drop[f] || '').trim()) keep[f] = drop[f];
  });
  ['anrede', 'name', 'vorname', 'funktion', 'telefon', 'email'].forEach((f) => {
    if (!String(keep.ansprechpartner[f] || '').trim() && String(drop.ansprechpartner[f] || '').trim()) keep.ansprechpartner[f] = drop.ansprechpartner[f];
  });
  if (keep.lat == null && drop.lat != null) {
    keep.lat = drop.lat;
    keep.lng = drop.lng;
    keep.geocodeStatus = drop.geocodeStatus;
  }
  if (drop.isPartner) keep.isPartner = true;
  keep.tags = Array.from(new Set([...(keep.tags || []), ...(drop.tags || [])]));
  keep.visits = (keep.visits || []).concat(drop.visits || []).sort((a, b) => (a.date < b.date ? 1 : -1));
  Object.keys(keep.links || {}).forEach((k) => {
    keep.links[k] = Array.from(new Set([...(keep.links[k] || []), ...((drop.links || {})[k] || [])])).filter((x) => x !== keepId);
  });
  if (!keep._sources) keep._sources = [keep.source];
  if (drop.source && !keep._sources.includes(drop.source)) keep._sources.push(drop.source);
  keep.updatedAt = new Date().toISOString();

  CRM.db.getTasks().forEach((t) => { if (t.contactId === dropId) t.contactId = keepId; });
  CRM.db.saveTasks();
  // Journal-Einträge umhängen, sonst löscht deleteContact(dropId) sie mit
  CRM.db.getJournalEntries().forEach((j) => { if (j.contactId === dropId) j.contactId = keepId; });
  CRM.db.saveJournal();
  CRM.db.getComms().forEach((m) => {
    if ((m.contactIds || []).includes(dropId)) {
      m.contactIds = Array.from(new Set(m.contactIds.map((x) => (x === dropId ? keepId : x))));
    }
  });
  CRM.db.saveComms();
  CRM.db.getProjects().forEach((p) => {
    if ((p.contactIds || []).includes(dropId)) {
      p.contactIds = Array.from(new Set(p.contactIds.map((x) => (x === dropId ? keepId : x))));
    }
  });
  CRM.db.saveProjects();
  CRM.db.getContacts().forEach((c) => {
    Object.keys(c.links || {}).forEach((k) => {
      if ((c.links[k] || []).includes(dropId)) {
        c.links[k] = Array.from(new Set(c.links[k].map((x) => (x === dropId ? keepId : x)))).filter((x) => x !== c.id);
      }
    });
  });
  CRM.db.saveContacts();
  CRM.db.deleteContact(dropId);
  return keep;
};

/* ============================================================
   Eingang-Sync: ein vom Handy exportierter Kontakt-Snapshot wird mit
   dem lokalen (Desktop-)Kontakt zusammengeführt. Bewusst konservativ:
   Stammdaten (Firma, Adresse, Geo) werden NIE überschrieben, da diese
   typischerweise am PC gepflegt/importiert/geocodiert werden — nur
   Besuche (additiv, per Visit-ID dedupliziert), Tags (Vereinigung) und
   Notiz/Nächster-Schritt (per updatedAt, neuester gewinnt) werden
   übernommen. Gibt die neu übernommenen Besuche zurück (für die
   automatische Excel-Ablage durch CRM.ablage.processEingang).
   ============================================================ */
CRM.mergeIncomingContact = function (existing, incoming) {
  const existingVisitIds = new Set((existing.visits || []).map((v) => v.id));
  const newVisits = (incoming.visits || []).filter((v) => !existingVisitIds.has(v.id));
  if (newVisits.length) {
    existing.visits = (existing.visits || []).concat(newVisits).sort((a, b) => (a.date < b.date ? 1 : -1));
  }
  existing.tags = Array.from(new Set([...(existing.tags || []), ...(incoming.tags || [])]));
  const incomingNewer = incoming.updatedAt && (!existing.updatedAt || incoming.updatedAt > existing.updatedAt);
  if (incomingNewer) {
    if (incoming.nextStep !== undefined) existing.nextStep = incoming.nextStep;
    if (incoming.notiz !== undefined) existing.notiz = incoming.notiz;
    if (incoming.isPartner) existing.isPartner = true;
  }
  existing.updatedAt = new Date().toISOString();
  CRM.db.saveContacts();
  return newVisits;
};

/* ============================================================
   Agenda: Priorisierung (A vor B vor C, dann nach Überfälligkeit)
   Inspiriert von Cloze's täglicher Agenda — das meistgelobte Feature
   in Nutzerbewertungen (automatische Nachfass-Vorschläge ohne Konfiguration)
   ============================================================ */
CRM.ABC_RANK = { A: 0, B: 1, C: 2 };

/* ============================================================
   Undo-Snapshot (Lehre aus Cloze-Reviews: #1-Kritikpunkt war
   Datenverlust durch Merge ohne Rückgängig-Option).
   Vor riskanten Aktionen (Import/Merge, Restore) einen Snapshot ziehen.
   ============================================================ */
CRM.SNAPSHOT_KEY = 'crm_undo_snapshot';
CRM.takeSnapshot = function (label) {
  const snap = {
    label: label || 'Aktion',
    at: new Date().toISOString(),
    contacts: JSON.parse(JSON.stringify(CRM.db.getContacts())),
    projects: JSON.parse(JSON.stringify(CRM.db.getProjects())),
    tasks: JSON.parse(JSON.stringify(CRM.db.getTasks())),
    comms: JSON.parse(JSON.stringify(CRM.db.getComms())),
    journal: JSON.parse(JSON.stringify(CRM.db.getJournalEntries())),
  };
  CRM.storage.write(CRM.SNAPSHOT_KEY, snap);
};
CRM.hasSnapshot = function () {
  return !!CRM.storage.read(CRM.SNAPSHOT_KEY, null);
};
CRM.restoreSnapshot = function () {
  const snap = CRM.storage.read(CRM.SNAPSHOT_KEY, null);
  if (!snap) return false;
  CRM.db._contacts = snap.contacts || [];
  CRM.db._projects = snap.projects || [];
  CRM.db._tasks = snap.tasks || [];
  CRM.db._comms = snap.comms || [];
  CRM.db._journal = snap.journal || [];
  CRM.db.saveContacts();
  CRM.db.saveProjects();
  CRM.db.saveTasks();
  CRM.db.saveComms();
  CRM.db.saveJournal();
  CRM.storage.write(CRM.SNAPSHOT_KEY, null);
  return true;
};

/* ============================================================
   Aufgaben (Follow-up-Engine) — Status & Heute-Aggregation
   ============================================================ */
CRM.getTaskDueStatus = function (task) {
  if (!task.due) return { status: 'none', diffDays: null };
  const due = new Date(task.due);
  const today = new Date();
  due.setHours(0, 0, 0, 0);
  today.setHours(0, 0, 0, 0);
  const diffDays = Math.round((due - today) / 86400000);
  if (task.done) return { status: 'done', diffDays };
  if (diffDays < 0) return { status: 'overdue', diffDays };
  if (diffDays === 0) return { status: 'today', diffDays };
  if (diffDays <= 7) return { status: 'week', diffDays };
  return { status: 'future', diffDays };
};

/* Aufgaben + fällige Besuche in einem Strom (für die Heute-Ansicht) */
CRM.computeTaskBuckets = function () {
  const buckets = { overdue: [], today: [], week: [] };
  CRM.db.getTasks().forEach((t) => {
    if (t.done) return;
    const st = CRM.getTaskDueStatus(t);
    if (buckets[st.status]) buckets[st.status].push({ t, st });
  });
  const sortFn = (a, b) => a.st.diffDays - b.st.diffDays;
  buckets.overdue.sort(sortFn);
  buckets.today.sort(sortFn);
  buckets.week.sort(sortFn);
  return buckets;
};

CRM.computeAgenda = function () {
  const buckets = { overdue: [], today: [], week: [] };
  CRM.db.getContacts().forEach((c) => {
    const due = CRM.getDueStatus(c);
    if (due.status === 'overdue') buckets.overdue.push({ c, due });
    else if (due.status === 'today') buckets.today.push({ c, due });
    else if (due.status === 'week') buckets.week.push({ c, due });
  });
  const sortFn = (x, y) => (CRM.ABC_RANK[x.c.abc] - CRM.ABC_RANK[y.c.abc]) || (x.due.diffDays - y.due.diffDays);
  buckets.overdue.sort(sortFn);
  buckets.today.sort(sortFn);
  buckets.week.sort(sortFn);
  return buckets;
};

/* ============================================================
   Google-Maps-Tour-Export über Adress-Strings
   (funktioniert auch ohne Geocoding/Lat-Lng — max. 10 Stopps pro Etappe)
   ============================================================ */
CRM.formatAddress = function (c) {
  return [c.strasse, [c.plz, c.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ');
};

/* ============================================================
   PLZ → Ort: erst offline über die eigenen Kontakte, dann
   api.zippopotam.us (übermittelt wird NUR die PLZ — datensparsam,
   gleiche Linie wie das Nominatim-Geocoding).
   ============================================================ */
CRM.ortForPlz = async function (plz) {
  plz = String(plz || '').trim();
  if (!/^\d{5}$/.test(plz)) return null;
  const local = CRM.db.getContacts().find((c) => c.plz === plz && c.ort);
  if (local) return local.ort;
  try {
    const res = await fetch('https://api.zippopotam.us/de/' + plz);
    if (!res.ok) return null;
    const j = await res.json();
    return (j.places && j.places[0] && j.places[0]['place name']) || null;
  } catch (e) {
    return null; // offline → kein Autofill, kein Fehler
  }
};

/* PLZ-Feld mit Ort-Feld verdrahten: sobald eine 5-stellige PLZ eingegeben
   ist und das Ort-Feld leer ist, wird der Ort automatisch eingetragen.
   onFilled (optional) wird nach erfolgreichem Eintrag aufgerufen (z.B. zum
   Speichern), damit programmatisches Setzen kein change-Event braucht. */
CRM.wirePlzOrtAutofill = function (plzInput, ortInput, onFilled) {
  if (!plzInput || !ortInput) return;
  const tryFill = async () => {
    const plz = plzInput.value.trim();
    if (!/^\d{5}$/.test(plz) || ortInput.value.trim()) return;
    const ort = await CRM.ortForPlz(plz);
    if (ort && !ortInput.value.trim()) {
      ortInput.value = ort;
      if (onFilled) onFilled(ort);
    }
  };
  plzInput.addEventListener('change', tryFill);
  plzInput.addEventListener('input', () => { if (/^\d{5}$/.test(plzInput.value.trim())) tryFill(); });
};

/* Distanz in km (Haversine) */
CRM.haversineKm = function (lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
};

/* Reihenfolge nach Nähe optimieren (Nearest-Neighbor auf Lat/Lng, Fallback PLZ-Sortierung) */
CRM.optimizeRouteOrder = function (contacts) {
  const withCoords = contacts.filter((c) => c.lat != null && c.lng != null);
  const withoutCoords = contacts.filter((c) => c.lat == null || c.lng == null);
  withoutCoords.sort((a, b) => (parseInt(a.plz, 10) || 0) - (parseInt(b.plz, 10) || 0));
  if (!withCoords.length) return withoutCoords;
  const remaining = withCoords.slice();
  const ordered = [remaining.shift()];
  while (remaining.length) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    remaining.forEach((c, i) => {
      const d = CRM.haversineKm(last.lat, last.lng, c.lat, c.lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    });
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered.concat(withoutCoords);
};

CRM.buildGoogleMapsLegs = function (contacts, maxStops) {
  maxStops = maxStops || 10;
  const addrs = contacts.map(CRM.formatAddress).filter(Boolean);
  const legs = [];
  for (let i = 0; i < addrs.length; i += maxStops) {
    const chunk = addrs.slice(i, i + maxStops);
    const destination = chunk[chunk.length - 1];
    const waypoints = chunk.slice(0, -1);
    let url = 'https://www.google.com/maps/dir/?api=1&destination=' + encodeURIComponent(destination) + '&travelmode=driving';
    if (waypoints.length) url += '&waypoints=' + waypoints.map(encodeURIComponent).join('|');
    legs.push({ url, stops: chunk.length, label: `Etappe ${legs.length + 1} (${chunk.length} Stopps)` });
  }
  return legs;
};

/* ============================================================
   JSON Backup / Restore
   ============================================================ */
CRM.backup = {
  exportJSON() {
    const data = {
      version: 4,
      exportedAt: new Date().toISOString(),
      contacts: CRM.db.getContacts(),
      projects: CRM.db.getProjects(),
      tasks: CRM.db.getTasks(),
      comms: CRM.db.getComms(),
      journal: CRM.db.getJournalEntries(),
      settings: CRM.db.getSettings(),
      meta: CRM.db.getMeta(),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const stamp = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `claytec-crm-backup-${stamp}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    CRM.db.saveSettings({ lastBackupAt: new Date().toISOString() });
    return data;
  },

  /* Excel-Export inkl. Notizen, Besuchshistorie, Status, Verknüpfungen.
     Benötigt SheetJS (XLSX), das bereits für den Import geladen ist. */
  exportExcel() {
    if (typeof XLSX === 'undefined') {
      CRM.toast('Excel-Bibliothek nicht geladen.', 'error');
      return;
    }
    const contacts = CRM.db.getContacts();
    const nameOf = (id) => { const c = CRM.db.getContact(id); return c ? c.firma1 : id; };

    // Blatt 1: Kontakte (eine Zeile je Kontakt, mit aggregierter Besuchshistorie)
    const contactRows = contacts.map((c) => {
      const last = CRM.getLastVisit(c);
      const due = CRM.getDueStatus(c);
      const dueLabels = { overdue: 'Überfällig', today: 'Heute', week: 'Diese Woche', ok: 'OK' };
      const visitHist = (c.visits || []).slice().sort((a, b) => (a.date < b.date ? 1 : -1))
        .map((v) => `${v.date}: ${v.note || '(ohne Notiz)'}`).join(' | ');
      const links = []
        .concat((c.links.haendlerIds || []).map((id) => 'Händler: ' + nameOf(id)))
        .concat((c.links.verarbeiterIds || []).map((id) => 'Verarbeiter: ' + nameOf(id)))
        .concat((c.links.architektIds || []).map((id) => 'Architekt: ' + nameOf(id)))
        .concat((c.links.projektIds || []).map((id) => { const p = CRM.db.getProject(id); return 'Projekt: ' + (p ? p.name : id); }))
        .join(' | ');
      return {
        Firma: c.firma1,
        'Firma 2': c.firma2 || '',
        Typ: CRM.TYPE_LABELS[c.type] || c.type,
        Partner: c.isPartner ? 'Ja' : '',
        Einstufung: c.abc,
        Listenquelle: CRM.SOURCE_LABELS[c.source] || c.source,
        Straße: c.strasse,
        PLZ: c.plz,
        Ort: c.ort,
        Telefon: c.telFirma,
        'E-Mail': c.emailFirma,
        Ansprechpartner: [c.ansprechpartner.vorname, c.ansprechpartner.name].filter(Boolean).join(' '),
        'Tel. Anspr.': c.ansprechpartner.telefon || '',
        'E-Mail Anspr.': c.ansprechpartner.email || '',
        Tags: (c.tags || []).join(', '),
        'Nächster Schritt': c.nextStep || '',
        'Letzter Besuch': last ? last.date : '',
        Besuchsstatus: dueLabels[due.status],
        'Nächster Besuch fällig': due.due ? due.due.toISOString().slice(0, 10) : '',
        Besuchshistorie: visitHist,
        Verknüpfungen: links,
        Lat: c.lat ?? '',
        Lng: c.lng ?? '',
      };
    });

    // Blatt 2: Besuche (eine Zeile je Besuch — für Pivot/Auswertung)
    const visitRows = [];
    contacts.forEach((c) => (c.visits || []).forEach((v) => visitRows.push({
      Firma: c.firma1, Datum: v.date, Notiz: v.note || '',
    })));

    // Blatt 3: Projekte
    const projectRows = CRM.db.getProjects().map((p) => ({
      Projekt: p.name,
      Status: CRM.PROJECT_STATUS_LABELS[p.status] || p.status,
      PLZ: p.plz || '',
      Ort: p.ort || '',
      Produkte: (p.products || []).join(', '),
      'Beteiligte Kontakte': (p.contactIds || []).map(nameOf).join(' | '),
      Notizen: p.notes || '',
    }));

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(contactRows), 'Kontakte');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(visitRows), 'Besuche');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(projectRows), 'Projekte');
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `claytec-crm-export-${stamp}.xlsx`);
    return { contacts: contactRows.length, visits: visitRows.length, projects: projectRows.length };
  },

  importJSON(jsonObj, mode) {
    // mode: 'replace' | 'merge'
    if (!jsonObj || !Array.isArray(jsonObj.contacts)) {
      throw new Error('Ungültiges Backup-Format');
    }
    if (mode === 'replace') {
      CRM.db._contacts = jsonObj.contacts || [];
      CRM.db._projects = jsonObj.projects || [];
      CRM.db._tasks = jsonObj.tasks || [];
      CRM.db._comms = jsonObj.comms || [];
      // Ältere Backups (version < 4) haben kein journal-Feld — dann das
      // lokale Journal behalten statt es durch "Ersetzen" zu verlieren.
      if (Array.isArray(jsonObj.journal)) CRM.db._journal = jsonObj.journal;
      if (jsonObj.settings) CRM.db._settings = Object.assign({}, CRM.DEFAULT_SETTINGS, jsonObj.settings);
      if (jsonObj.meta) CRM.db._meta = jsonObj.meta;
    } else {
      // merge: incoming wins on id collision, else append
      const existingIds = new Set(CRM.db._contacts.map((c) => c.id));
      (jsonObj.contacts || []).forEach((c) => {
        if (existingIds.has(c.id)) {
          const idx = CRM.db._contacts.findIndex((x) => x.id === c.id);
          CRM.db._contacts[idx] = c;
        } else {
          CRM.db._contacts.push(c);
        }
      });
      const existingProjIds = new Set(CRM.db._projects.map((p) => p.id));
      (jsonObj.projects || []).forEach((p) => {
        if (existingProjIds.has(p.id)) {
          const idx = CRM.db._projects.findIndex((x) => x.id === p.id);
          CRM.db._projects[idx] = p;
        } else {
          CRM.db._projects.push(p);
        }
      });
      const existingTaskIds = new Set(CRM.db._tasks.map((t) => t.id));
      (jsonObj.tasks || []).forEach((t) => {
        if (existingTaskIds.has(t.id)) {
          const idx = CRM.db._tasks.findIndex((x) => x.id === t.id);
          CRM.db._tasks[idx] = t;
        } else {
          CRM.db._tasks.push(t);
        }
      });
      const existingCommIds = new Set(CRM.db._comms.map((m) => m.id));
      (jsonObj.comms || []).forEach((m) => {
        if (existingCommIds.has(m.id)) {
          const idx = CRM.db._comms.findIndex((x) => x.id === m.id);
          CRM.db._comms[idx] = m;
        } else {
          CRM.db._comms.push(m);
        }
      });
      const existingJournalIds = new Set(CRM.db._journal.map((j) => j.id));
      (jsonObj.journal || []).forEach((j) => {
        if (existingJournalIds.has(j.id)) {
          const idx = CRM.db._journal.findIndex((x) => x.id === j.id);
          CRM.db._journal[idx] = j;
        } else {
          CRM.db._journal.push(j);
        }
      });
    }
    CRM.db.saveContacts();
    CRM.db.saveProjects();
    CRM.db.saveTasks();
    CRM.db.saveComms();
    CRM.db.saveJournal();
    CRM.db.saveSettings({});
    CRM.db.saveMeta({});
  },
};

/* ============================================================
   ICS-Termin-Export (offline, datensparsam) — Alternative zur
   Cloud-Kalender-Sync. Erzeugt eine .ics-Datei, die in jeden
   Kalender (Google/Outlook/Apple) importiert werden kann.
   ============================================================ */
CRM.exportICS = function (title, dateStr, description, location) {
  const dt = (dateStr || new Date().toISOString().slice(0, 10)).replace(/-/g, '');
  const esc = (s) => String(s || '').replace(/[\\;,]/g, (m) => '\\' + m).replace(/\n/g, '\\n');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').slice(0, 15) + 'Z';
  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Claytec CRM//DE',
    'BEGIN:VEVENT',
    'UID:' + CRM.uid('ics') + '@claytec-crm',
    'DTSTAMP:' + stamp,
    'DTSTART;VALUE=DATE:' + dt,
    'SUMMARY:' + esc(title),
    'DESCRIPTION:' + esc(description),
    'LOCATION:' + esc(location),
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const blob = new Blob([ics], { type: 'text/calendar' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'termin-' + dt + '.ics';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};
