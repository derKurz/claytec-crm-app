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
