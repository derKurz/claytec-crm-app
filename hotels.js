/* ============================================================
   Claytec CRM — Hotel-/Übernachtungs-Favoriten
   Für die Tourenplanung: Hotels/Gasthöfe mit Kontaktdaten und
   letztem Preis/Nacht speichern. Liegt in den Einstellungen
   (settings.hotels) — dadurch automatisch im JSON-Backup enthalten.
   Alles bleibt lokal auf dem Gerät.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.hotels = { _editId: null };

CRM.hotels.all = function () { return (CRM.db.getSettings().hotels || []).slice(); };
CRM.hotels.save = function (list) { CRM.db.saveSettings({ hotels: list }); };
CRM.hotels.get = function (id) { return CRM.hotels.all().find((h) => h.id === id) || null; };

CRM.hotels._linkBtns = function (h) {
  let s = '';
  if (h.telefon) s += '<a class="btn btn-sm" href="tel:' + escAttr(h.telefon) + '" title="Anrufen">📞</a>';
  if (h.email) s += '<a class="btn btn-sm" href="mailto:' + escAttr(h.email) + '" title="E-Mail">✉</a>';
  if (h.website) {
    const url = /^https?:\/\//i.test(h.website) ? h.website : 'https://' + h.website;
    s += '<a class="btn btn-sm" href="' + escAttr(url) + '" target="_blank" rel="noopener" title="Website">🌐</a>';
  }
  const q = h.adresse || [h.name, h.ort].filter(Boolean).join(' ');
  if (q) s += '<a class="btn btn-sm" href="https://www.google.com/maps/search/?api=1&query=' + encodeURIComponent(q) + '" target="_blank" rel="noopener" title="Auf Karte">🗺️</a>';
  return s;
};

CRM.hotels._rowHtml = function (h) {
  const preis = (h.preis !== '' && h.preis != null) ? ' · <span style="color:var(--accent-2)">' + esc2(h.preis) + ' €/Nacht</span>' : '';
  const sub = [h.ort, h.adresse].filter(Boolean).join(' · ');
  return '<div class="list-item">'
    + '<div class="li-main" style="min-width:0">'
    + '<div class="li-title">' + esc2(h.name) + preis + '</div>'
    + (sub || h.notiz ? '<div style="font-size:12px;color:var(--text-dim)">' + esc2(sub) + (h.notiz ? (sub ? ' · ' : '') + esc2(h.notiz) : '') + '</div>' : '')
    + '</div>'
    + '<div style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start">' + CRM.hotels._linkBtns(h)
    + '<button class="btn btn-sm" title="Bearbeiten" onclick="CRM.hotels._editId=\'' + h.id + '\';CRM.hotels.openDialog()">✏</button>'
    + '<button class="btn btn-sm" title="Löschen" onclick="CRM.hotels.remove(\'' + h.id + '\')">🗑</button>'
    + '</div></div>';
};

CRM.hotels.openDialog = function () {
  const list = CRM.hotels.all().sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  const e = CRM.hotels._editId ? (CRM.hotels.get(CRM.hotels._editId) || {}) : {};
  const rows = list.length ? list.map(CRM.hotels._rowHtml).join('') : '<p style="color:var(--text-dim);font-size:13px;padding:8px">Noch keine Hotels gespeichert.</p>';
  CRM.openModal([
    '<h2>🏨 Hotels / Übernachtungen</h2>',
    '<div class="card" style="margin:0 0 10px">',
    '  <div style="font-weight:600;margin-bottom:6px">' + (CRM.hotels._editId ? '✏ Hotel bearbeiten' : '+ Neues Hotel') + '</div>',
    '  <div class="row" style="flex-wrap:wrap;gap:8px">',
    '    <div class="col" style="min-width:180px;flex:2"><label>Name</label><input id="ho-name" value="' + escAttr(e.name || '') + '" placeholder="z.B. Gasthof Post"></div>',
    '    <div class="col" style="min-width:120px"><label>Ort</label><input id="ho-ort" value="' + escAttr(e.ort || '') + '"></div>',
    '    <div class="col" style="max-width:140px"><label>Preis/Nacht (€)</label><input id="ho-preis" type="number" min="0" step="0.5" value="' + escAttr(e.preis != null ? e.preis : '') + '"></div>',
    '  </div>',
    '  <label style="margin-top:6px">Adresse</label><input id="ho-adresse" value="' + escAttr(e.adresse || '') + '" placeholder="Straße Nr., PLZ Ort">',
    '  <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:6px">',
    '    <div class="col" style="min-width:130px"><label>Telefon</label><input id="ho-tel" value="' + escAttr(e.telefon || '') + '"></div>',
    '    <div class="col" style="min-width:160px"><label>E-Mail</label><input id="ho-mail" value="' + escAttr(e.email || '') + '"></div>',
    '    <div class="col" style="min-width:160px"><label>Website</label><input id="ho-web" value="' + escAttr(e.website || '') + '"></div>',
    '  </div>',
    '  <label style="margin-top:6px">Notiz</label><input id="ho-notiz" value="' + escAttr(e.notiz || '') + '" placeholder="z.B. gutes Frühstück, Parkplatz, ruhig">',
    '  <div class="row" style="gap:8px;margin-top:8px">',
    '    <button class="btn btn-primary btn-sm" onclick="CRM.hotels.saveForm()">' + (CRM.hotels._editId ? 'Speichern' : 'Hinzufügen') + '</button>',
    (CRM.hotels._editId ? '    <button class="btn btn-sm" onclick="CRM.hotels._editId=null;CRM.hotels.openDialog()">Abbrechen</button>' : ''),
    '  </div>',
    '</div>',
    '<div style="max-height:42vh;overflow-y:auto">' + rows + '</div>',
    '<div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>',
  ].join('\n'));
};

CRM.hotels.saveForm = function () {
  const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const name = val('ho-name');
  if (!name) { CRM.toast('Bitte einen Namen eingeben.', 'error'); return; }
  const obj = {
    name: name, ort: val('ho-ort'), adresse: val('ho-adresse'),
    telefon: val('ho-tel'), email: val('ho-mail'), website: val('ho-web'),
    preis: val('ho-preis'), notiz: val('ho-notiz'), updatedAt: new Date().toISOString(),
  };
  const list = CRM.hotels.all();
  if (CRM.hotels._editId) {
    const i = list.findIndex((h) => h.id === CRM.hotels._editId);
    if (i >= 0) list[i] = Object.assign(list[i], obj);
  } else {
    obj.id = 'ho_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    list.push(obj);
  }
  CRM.hotels.save(list);
  CRM.hotels._editId = null;
  CRM.toast('🏨 Hotel gespeichert.', 'success');
  CRM.hotels.openDialog();
};

CRM.hotels.remove = function (id) {
  if (!confirm('Hotel wirklich löschen?')) return;
  CRM.hotels.save(CRM.hotels.all().filter((h) => h.id !== id));
  if (CRM.hotels._editId === id) CRM.hotels._editId = null;
  CRM.hotels.openDialog();
};
