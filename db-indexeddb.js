/* ============================================================
   Claytec CRM — Phase 1 der Migration (OFFLINE_SYNC.md)
   IndexedDB (Dexie.js) als Spiegel neben localStorage — noch NICHT die
   Quelle der Wahrheit. Alle Lesezugriffe (CRM.db.get*) bleiben unverändert
   synchron auf den In-Memory-Arrays aus storage.js. Jede Schreiboperation
   (save*) schreibt zusätzlich (asynchron, "fire-and-forget") nach Dexie,
   damit eine vollständige IndexedDB-Kopie entsteht — das ist die technische
   Grundlage für Phase 2/3, ohne dass sich an den ~800 bestehenden
   CRM.db.*-Aufrufstellen im Code etwas ändern muss.

   Schlägt Dexie/IndexedDB fehl (alter Browser, privater Modus etc.), läuft
   die App unverändert nur mit localStorage weiter — das ist hier bewusst
   so gebaut, nicht vergessen.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.dexie = null;

try {
  if (typeof Dexie !== 'undefined') {
    CRM.dexie = new Dexie('claytec_crm');
    CRM.dexie.version(1).stores({
      contacts: 'id, type, plz, ort, abc',
      projects: 'id, status',
      tasks: 'id, contactId, done',
      comms: 'id',
      kv: 'key', // settings, meta, interne Flags (z.B. Migrationsstatus)
    });

    /* Phase 2 (OFFLINE_SYNC.md): neue Tabellen aus DATABASE_SCHEMA.md, die es
       bisher gar nicht gibt. Reine Datenstruktur — noch keine CRUD-Helper,
       keine UI. Bestehende Tabellen aus Version 1 bleiben unverändert
       erhalten (Dexie übernimmt sie automatisch in jede neue Version). */
    CRM.dexie.version(2).stores({
      contact_relations: 'id, from_contact, to_contact, relation_type',
      journal_entries: 'id, contact_id, project_id, created_at',
      visit_reports: 'id, contact_id, project_id, visit_date',
      private_notes: 'id, contact_id, project_id',
      photos: 'id, contact_id, project_id, visit_report_id',
      products: 'id, category, name',
      competitors: 'id, competitor_name, category',
      social_leads: 'id, status, source',
      config: 'key',
    });

    /* Phase 2 hatte die Indexnamen direkt aus DATABASE_SCHEMA.md (Postgres-
       snake_case) übernommen — inkonsistent zum Rest des lokalen Datenmodells
       (contacts/tasks nutzen camelCase: contactId, plz, ort). Hier korrigiert,
       weil journal_entries jetzt erstmals echt befüllt wird (Kontaktjournal). */
    CRM.dexie.version(3).stores({
      contact_relations: 'id, fromContact, toContact, relationType',
      journal_entries: 'id, contactId, projectId, createdAt',
      visit_reports: 'id, contactId, projectId, visitDate',
      private_notes: 'id, contactId, projectId',
      photos: 'id, contactId, projectId, visitReportId',
      competitors: 'id, competitorName, category',
    });
  }
} catch (e) {
  console.error('Dexie/IndexedDB konnte nicht initialisiert werden — App arbeitet ausschließlich mit localStorage weiter.', e);
  CRM.dexie = null;
}

/* Spiegelt eine komplette Liste (contacts/projects/tasks/comms) nach Dexie.
   clear()+bulkPut() statt diff — für die heutige Datenmenge (~600 Kontakte)
   schnell genug, Optimierung ist erst relevant, wenn Dexie in Phase 3 zur
   echten Schreibquelle wird. */
CRM._mirrorToDexie = function (table, records) {
  if (!CRM.dexie) return;
  CRM.dexie.transaction('rw', CRM.dexie[table], async () => {
    await CRM.dexie[table].clear();
    if (records && records.length) await CRM.dexie[table].bulkPut(records);
  }).catch((e) => console.error('Dexie-Spiegelung fehlgeschlagen (' + table + ')', e));
};

/* Spiegelt Einzelobjekte (settings/meta) in die kv-Tabelle. */
CRM._mirrorKvToDexie = function (key, value) {
  if (!CRM.dexie) return;
  CRM.dexie.kv.put({ key, value }).catch((e) => console.error('Dexie-Spiegelung fehlgeschlagen (kv:' + key + ')', e));
};

/* ============================================================
   Phase 1 ABSCHLUSS (2026-08): Dexie wird echte Quelle statt stiller
   Spiegel. Ersetzt das alte CRM.migrateToIndexedDB (das lief nur
   fire-and-forget NACH dem Rendern und kopierte das Kontaktjournal gar
   nicht mit — beim Nachbau hier bewusst korrigiert). Orchestriert wird
   das von CRM.db.switchToDexieIfNeeded() in storage.js; hier stehen nur
   die reinen Dexie-Grundfunktionen, keine UI, kein Settings-Merge
   (der bleibt bei storage.js/DEFAULT_SETTINGS, wo er hingehört). */

/* Eigenes Flag, bewusst getrennt vom alten "_migrated_v1"-Spiegel-Flag:
   ein Gerät kann längst gespiegelt haben, ohne dass Dexie je als Quelle
   geprüft wurde — beide Zustände dürfen sich nicht vermischen. */
CRM._dexiePrimaryFlagSet = async function () {
  if (!CRM.dexie) return false;
  const flag = await CRM.dexie.kv.get('_dexie_primary_v1');
  return !!flag;
};

/* true nur, wenn wirklich etwas zu sichern ist UND der Umstieg noch
   nicht passiert ist — ein leerer Erststart (neues Gerät/Profil) soll
   nicht mit einem Backup-Hinweis belästigt werden, es gibt nichts zu
   verlieren. */
CRM._dexieNeedsGate = async function (contacts, projects, tasks, comms, journal) {
  if (!CRM.dexie) return false;
  if (await CRM._dexiePrimaryFlagSet()) return false;
  return !!((contacts && contacts.length) || (projects && projects.length)
    || (tasks && tasks.length) || (comms && comms.length) || (journal && journal.length));
};

/* Kopiert den AKTUELLEN localStorage-Stand frisch nach Dexie (nicht den
   evtl. veralteten Mirror-Stand) und setzt danach das Flag — alles in
   EINER Transaktion, damit ein Abbruch mittendrin (Tab geschlossen,
   Absturz) nie einen halb kopierten Zustand hinterlässt: entweder
   läuft der ganze Block durch, oder gar nichts davon. */
CRM._dexieCopyFreshAndFlag = async function (contacts, projects, tasks, comms, journal, settings, meta) {
  if (!CRM.dexie) return;
  await CRM.dexie.transaction('rw',
    [CRM.dexie.contacts, CRM.dexie.projects, CRM.dexie.tasks, CRM.dexie.comms, CRM.dexie.journal_entries, CRM.dexie.kv],
    async () => {
      await CRM.dexie.contacts.clear(); await CRM.dexie.contacts.bulkPut(contacts || []);
      await CRM.dexie.projects.clear(); await CRM.dexie.projects.bulkPut(projects || []);
      await CRM.dexie.tasks.clear(); await CRM.dexie.tasks.bulkPut(tasks || []);
      await CRM.dexie.comms.clear(); await CRM.dexie.comms.bulkPut(comms || []);
      await CRM.dexie.journal_entries.clear(); await CRM.dexie.journal_entries.bulkPut(journal || []);
      await CRM.dexie.kv.put({ key: 'settings', value: settings || {} });
      await CRM.dexie.kv.put({ key: 'meta', value: meta || { importedFiles: [] } });
      await CRM.dexie.kv.put({ key: '_dexie_primary_v1', value: true });
    });
};

/* Liest alles roh aus Dexie — KEIN Settings-Default-Merge hier (der
   passiert bewusst in storage.js, an derselben Stelle wie beim
   localStorage-Lesepfad, damit beide Pfade garantiert dieselben
   Defaults anwenden). */
CRM._dexieReadAll = async function () {
  if (!CRM.dexie) return null;
  const [contacts, projects, tasks, comms, journal, settingsRow, metaRow] = await Promise.all([
    CRM.dexie.contacts.toArray(),
    CRM.dexie.projects.toArray(),
    CRM.dexie.tasks.toArray(),
    CRM.dexie.comms.toArray(),
    CRM.dexie.journal_entries.toArray(),
    CRM.dexie.kv.get('settings'),
    CRM.dexie.kv.get('meta'),
  ]);
  return {
    contacts, projects, tasks, comms, journal,
    settings: settingsRow ? settingsRow.value : {},
    meta: metaRow ? metaRow.value : { importedFiles: [] },
  };
};
