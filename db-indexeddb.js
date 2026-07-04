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

/* Einmalige Migration: liest die bereits aus localStorage geladenen
   In-Memory-Arrays (CRM.db._contacts etc., von CRM.db.init() befüllt) und
   schreibt sie nach Dexie. localStorage bleibt dabei vollständig unverändert
   — keine Löschung, kein Risiko für die bestehenden Produktivdaten. */
CRM.migrateToIndexedDB = async function () {
  if (!CRM.dexie) return;
  try {
    const flag = await CRM.dexie.kv.get('_migrated_v1');
    if (flag) return;
    await CRM.dexie.contacts.bulkPut(CRM.db._contacts || []);
    await CRM.dexie.projects.bulkPut(CRM.db._projects || []);
    await CRM.dexie.tasks.bulkPut(CRM.db._tasks || []);
    await CRM.dexie.comms.bulkPut(CRM.db._comms || []);
    await CRM.dexie.kv.put({ key: 'settings', value: CRM.db._settings });
    await CRM.dexie.kv.put({ key: 'meta', value: CRM.db._meta });
    await CRM.dexie.kv.put({ key: '_migrated_v1', value: true });
    console.log('IndexedDB-Migration (Phase 1, OFFLINE_SYNC.md) abgeschlossen — localStorage bleibt unverändert die aktive Quelle.');
  } catch (e) {
    console.error('IndexedDB-Migration fehlgeschlagen — App arbeitet unverändert mit localStorage weiter, kein Datenverlust.', e);
  }
};
