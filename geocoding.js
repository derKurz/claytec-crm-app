/* ============================================================
   Claytec CRM — Geocoding (Nominatim/OpenStreetMap), robust & datensparsam
   - max. 1 Anfrage/Sekunde (Nominatim-Nutzungsrichtlinie)
   - sendet NUR Straße/PLZ/Ort/Land — niemals Firmen- oder Personennamen
   - Koordinaten dauerhaft in LocalStorage, nur neue/geänderte Adressen erneut abfragen
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.geocoding = {
  queueRunning: false,
  rateLimitMs: 1100,
};

CRM.geocoding.addressKey = function (c) {
  return [c.strasse, c.plz, c.ort, c.land].join('|').trim().toLowerCase();
};

CRM.geocoding.markStale = function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c || c.geocodeStatus === 'manual') return;
  c.geocodeStatus = 'pending';
  CRM.db.saveContacts();
};

CRM.geocoding.getPendingContacts = function () {
  return CRM.db.getContacts().filter((c) => {
    if (!c.plz && !c.ort && !c.strasse) return false;
    if (c.geocodeStatus === 'manual') return false;
    const key = CRM.geocoding.addressKey(c);
    if (c.geocodeStatus === 'ok' && c._geoAddressKey === key) return false;
    return true;
  });
};

/* Datensparsam: NUR Adressdaten an Nominatim, keine Firmen-/Personennamen */
CRM.geocoding.geocodeOne = async function (c) {
  const params = new URLSearchParams({
    format: 'jsonv2',
    street: c.strasse || '',
    postalcode: c.plz || '',
    city: c.ort || '',
    country: 'Deutschland',
    limit: '1',
  });
  const url = 'https://nominatim.openstreetmap.org/search?' + params.toString();
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (data && data.length) {
      c.lat = parseFloat(data[0].lat);
      c.lng = parseFloat(data[0].lon);
      c.geocodeStatus = 'ok';
    } else {
      c.geocodeStatus = 'failed';
    }
  } catch (e) {
    c.geocodeStatus = 'failed';
  }
  c._geoAddressKey = CRM.geocoding.addressKey(c);
  CRM.db.saveContacts();
};

CRM.geocoding.geocodeAllPending = async function () {
  if (CRM.geocoding.queueRunning) return;
  const pending = CRM.geocoding.getPendingContacts();
  if (!pending.length) {
    CRM.toast('Alle Adressen bereits geocodiert.', 'success');
    return;
  }
  CRM.geocoding.queueRunning = true;
  CRM.showProgress(`Geocoding: 0 / ${pending.length}`);
  for (let i = 0; i < pending.length; i++) {
    await CRM.geocoding.geocodeOne(pending[i]);
    CRM.updateProgress(`Geocoding: ${i + 1} / ${pending.length}`, ((i + 1) / pending.length) * 100);
    if (i < pending.length - 1) await new Promise((r) => setTimeout(r, CRM.geocoding.rateLimitMs));
  }
  CRM.hideProgress();
  CRM.geocoding.queueRunning = false;
  const failed = pending.filter((c) => c.geocodeStatus === 'failed').length;
  CRM.toast(`Geocoding abgeschlossen: ${pending.length} Adressen verarbeitet${failed ? `, ${failed} fehlgeschlagen` : ''}.`, failed ? 'error' : 'success');
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
  if (CRM.renderContactList) CRM.renderContactList();
};

/* Nur EINEN Kontakt geocodieren (z.B. direkt nach Neuanlage oder Adress-
   Änderung) — bewusst getrennt von geocodeAllPending, das sonst versehentlich
   den gesamten Rückstand aller noch offenen Adressen mit abarbeiten würde. */
CRM.geocoding.geocodeSingle = async function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  await CRM.geocoding.geocodeOne(c);
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
  if (CRM.renderContactList) CRM.renderContactList();
};

CRM.geocoding.retrySingle = async function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  c.geocodeStatus = 'pending';
  CRM.db.saveContacts();
  await CRM.geocoding.geocodeOne(c);
  CRM.toast(c.geocodeStatus === 'ok' ? 'Geocoding erfolgreich.' : 'Geocoding weiterhin fehlgeschlagen.', c.geocodeStatus === 'ok' ? 'success' : 'error');
  if (CRM.renderContactDetailModal) CRM.renderContactDetailModal(id);
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
};

CRM.geocoding.setManual = function (contactId, lat, lng) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  c.lat = lat;
  c.lng = lng;
  c.geocodeStatus = 'manual';
  c._geoAddressKey = CRM.geocoding.addressKey(c);
  CRM.db.saveContacts();
};
