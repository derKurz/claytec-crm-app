/* ============================================================
   Claytec CRM — Karte (Leaflet.js): Pins, Cluster, Tour-Modus
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.TYPE_COLORS = { haendler: '#3da9fc', verarbeiter: '#4cd17b', architekt: '#ff9f43', bauherr: '#c9a66b', sonstige: '#9aa4b5' };

CRM.map = {
  instance: null,
  markersLayer: null,
  selectedIds: new Set(),
  filters: { types: { haendler: true, verarbeiter: true, architekt: true, sonstige: true }, partnerOnly: false, query: '' },
};

CRM.map.init = function () {
  if (CRM.map.instance || typeof L === 'undefined') return;
  const map = L.map('map-container', { center: [48.95, 11.4], zoom: 8, zoomControl: false });
  L.control.zoom({ position: 'topright' }).addTo(map);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap-Mitwirkende',
  }).addTo(map);
  CRM.map.instance = map;
  CRM.map.markersLayer = L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup();
  map.addLayer(CRM.map.markersLayer);
  // Tippen auf die freie Kartenfläche (nicht auf einen Pin) schließt das
  // offene Kontakt-Panel — Marker-Klicks propagieren bei Leaflet nicht zum
  // Karten-Klick-Event, daher feuert das hier nur bei echten Leerflächen.
  map.on('click', CRM.map.closeSidePanel);
  CRM.map.renderControls();
  CRM.map.refresh();
};

CRM.map.makeIcon = function (c) {
  const selected = CRM.map.selectedIds.has(c.id);
  if (selected) {
    // Ausgewählte Kontakte stark hervorheben: größer, leuchtend cyan, weißer Rand, ✓, Puls
    const size = 34;
    return L.divIcon({
      className: 'crm-marker crm-marker-selected',
      html: `<div style="background:#19e3d3;width:${size}px;height:${size}px;border-radius:50%;border:3px solid #fff;display:flex;align-items:center;justify-content:center;font-size:17px;color:#06121c;font-weight:bold;">✓</div>`,
      iconSize: [size, size],
      iconAnchor: [size / 2, size / 2],
    });
  }
  const color = c.isPartner ? '#e6b94d' : (CRM.TYPE_COLORS[c.type] || '#9aa4b5');
  const star = c.isPartner ? '★' : '';
  return L.divIcon({
    className: 'crm-marker',
    html: `<div style="background:${color};width:22px;height:22px;border-radius:50%;border:2px solid #11151c;display:flex;align-items:center;justify-content:center;font-size:11px;color:#11151c;font-weight:bold;box-shadow:0 1px 4px rgba(0,0,0,.5);">${star}</div>`,
    iconSize: [22, 22],
    iconAnchor: [11, 11],
  });
};

CRM.map.refresh = function () {
  if (!CRM.map.instance) {
    CRM.map.init();
    return;
  }
  CRM.map.markersLayer.clearLayers();
  CRM.map._markerById = {};
  const all = CRM.db.getContacts();
  const withCoords = all.filter((c) => c.lat != null && c.lng != null);
  const q = (CRM.map.filters.query || '').trim().toLowerCase();
  const filtered = withCoords.filter((c) =>
    CRM.map.filters.types[c.type]
    && (!CRM.map.filters.partnerOnly || c.isPartner)
    && (!q || String(c.ort || '').toLowerCase().includes(q) || String(c.plz || '').toLowerCase().includes(q)));
  const markers = [];
  filtered.forEach((c) => {
    const sel = CRM.map.selectedIds.has(c.id);
    const marker = L.marker([c.lat, c.lng], { icon: CRM.map.makeIcon(c), zIndexOffset: sel ? 1000 : 0 });
    marker.on('click', () => CRM.map.onMarkerClick(c.id));
    marker.bindTooltip(c.firma1, { direction: 'top' });
    CRM.map._markerById[c.id] = marker;
    markers.push(marker);
  });
  // Bulk-Insert: bei MarkerCluster deutlich schneller als einzeln
  if (CRM.map.markersLayer.addLayers) CRM.map.markersLayer.addLayers(markers);
  else markers.forEach((m) => CRM.map.markersLayer.addLayer(m));
  CRM.map.updateStatusLine(all.length, withCoords.length, filtered.length);

  // Bei aktiver Ort/PLZ-Suche automatisch auf die Treffer zoomen
  if (q && filtered.length) {
    const pts = filtered.map((c) => [c.lat, c.lng]);
    if (pts.length === 1) CRM.map.instance.setView(pts[0], 14);
    else CRM.map.instance.fitBounds(L.latLngBounds(pts).pad(0.2));
  }
};

/* Karte sichtbar machen: Größe neu berechnen (Leaflet braucht das nach
   display:none) und Marker rendern. */
CRM.map.onShow = function () {
  if (!CRM.map.instance) { CRM.map.init(); return; }
  CRM.map.instance.invalidateSize();
  CRM.map.refresh();
};

/* Karte anzeigen und optional auf eine Kontaktmenge zoomen — eine einzige
   Render-Runde statt mehrfachem refresh. */
CRM.map.showWith = function (contacts) {
  const pts = (contacts || []).filter((c) => c.lat != null && c.lng != null).map((c) => [c.lat, c.lng]);
  CRM.switchTab('karte');
  setTimeout(() => {
    if (!CRM.map.instance) return;
    CRM.map.instance.invalidateSize();
    if (pts.length === 1) CRM.map.instance.setView(pts[0], 14);
    else if (pts.length > 1) CRM.map.instance.fitBounds(L.latLngBounds(pts).pad(0.2));
  }, 80);
};

CRM.map.onMarkerClick = function (id) {
  CRM.map.openSidePanel(id);
};

CRM.map.toggleSelect = function (id) {
  if (CRM.map.selectedIds.has(id)) CRM.map.selectedIds.delete(id);
  else CRM.map.selectedIds.add(id);
  // Nur das eine Marker-Icon aktualisieren statt alle Marker neu aufzubauen
  const m = CRM.map._markerById && CRM.map._markerById[id];
  const c = CRM.db.getContact(id);
  if (m && c) { m.setIcon(CRM.map.makeIcon(c)); m.setZIndexOffset(CRM.map.selectedIds.has(id) ? 1000 : 0); }
  else CRM.map.refresh();
  CRM.map.updateTourCount();
  // Panel des betroffenen Kontakts auffrischen, damit die Checkbox synchron bleibt
  if (CRM.map._panelContactId === id) CRM.map.openSidePanel(id);
};

CRM.map.openSidePanel = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  CRM.map._panelContactId = id;
  const inTour = CRM.map.selectedIds.has(id);
  const panel = document.getElementById('map-side-panel');
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <h3 style="margin:0">${esc(c.firma1)} ${c.isPartner ? '⭐' : ''}</h3>
      <button class="btn btn-icon map-panel-close" onclick="CRM.map.closeSidePanel()">✕ Schließen</button>
    </div>
    <p style="margin:6px 0 4px">${esc(c.plz)} ${esc(c.ort)}</p>
    ${(() => { const t = CRM.getOpenTodoText(c); return t ? `<p style="margin:6px 0"><span class="badge badge-todo" title="${esc(t)}">❗ ${esc(t)}</span></p>` : ''; })()}
    <div class="map-panel-extra">
      <div class="li-badges">
        <span class="badge badge-${c.type}">${CRM.TYPE_LABELS[c.type]}</span>
        <span class="badge badge-${c.abc}">${c.abc}</span>
      </div>
      <p style="margin:10px 0 4px">${esc(c.strasse)}</p>
      <p style="color:var(--text-dim);font-size:13px">Letzter Besuch: ${esc(CRM.formatLastVisit(c))}</p>
    </div>
    <label class="tour-add-row" style="display:flex;align-items:center;gap:8px;margin:12px 0;padding:8px;border:1px solid var(--border);border-radius:8px;cursor:pointer;${inTour ? 'background:rgba(25,227,211,.1);border-color:#19e3d3' : ''}">
      <input type="checkbox" style="width:auto" ${inTour ? 'checked' : ''} onchange="CRM.map.toggleSelect('${c.id}')">
      <span>${inTour ? '✓ Teil der Tour' : 'Zur Tour hinzufügen'}</span>
    </label>
    <button class="btn btn-primary" style="margin-top:4px;width:100%" onclick="CRM.openContactDetail('${c.id}')">Vollständiges Profil öffnen</button>
  `;
  panel.classList.add('open');
};
CRM.map.closeSidePanel = function () {
  document.getElementById('map-side-panel').classList.remove('open');
  CRM.map._panelContactId = null;
};

/* ---------- Steuerungsleiste: Filter + Tour-Modus ---------- */
CRM.map.renderControls = function () {
  const el = document.getElementById('map-controls');
  el.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center">
      <div style="font-weight:600">Filter</div>
      <button type="button" class="btn btn-sm mobile-only-filter" id="map-btn-toggle-filter">▾</button>
    </div>
    <div class="map-filter-fields" id="map-filter-fields">
      <input id="map-filter-query" placeholder="🔍 Ort oder PLZ..." value="${escAttr(CRM.map.filters.query || '')}" style="margin:8px 0 10px">
      ${Object.keys(CRM.TYPE_LABELS).map((t) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:4px"><input type="checkbox" class="map-filter-type" data-type="${t}" checked style="width:auto"> ${CRM.TYPE_LABELS[t]}</label>`).join('')}
      <label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:8px"><input type="checkbox" id="map-filter-partner" style="width:auto"> Nur Partner ⭐</label>
      <button class="btn btn-sm" style="margin-bottom:8px;width:100%" onclick="CRM.geocoding.geocodeAllPending()">📍 Fehlende Pins geocodieren</button>
    </div>
    <hr style="border-color:var(--border)">
    <div style="font-weight:600;margin:8px 0 6px">Tour</div>
    <div id="map-tour-summary" style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Noch keine Stopps ausgewählt — auf einen Pin klicken und „Zur Tour hinzufügen“ abhaken.</div>
    <div id="map-tour-info" class="hidden">
      <button class="btn btn-sm" style="width:100%;margin-bottom:6px" onclick="CRM.map.showTour()">🔎 Tour auf Karte anzeigen</button>
      <button class="btn btn-primary btn-sm" style="width:100%;margin-bottom:6px" onclick="CRM.map.startTour()">🗺️ Route in Google Maps öffnen</button>
      <button class="btn btn-sm" style="width:100%" onclick="CRM.map.clearTourSelection()">Auswahl leeren</button>
    </div>
    <div style="font-size:11px;color:var(--text-dim);margin-top:10px" id="map-status-line"></div>
  `;
  document.getElementById('map-filter-query').addEventListener('input', (e) => {
    CRM.map.filters.query = e.target.value;
    CRM.map.refresh();
  });
  el.querySelectorAll('.map-filter-type').forEach((cb) => cb.addEventListener('change', (e) => {
    CRM.map.filters.types[e.target.dataset.type] = e.target.checked;
    CRM.map.refresh();
  }));
  document.getElementById('map-filter-partner').addEventListener('change', (e) => {
    CRM.map.filters.partnerOnly = e.target.checked;
    CRM.map.refresh();
  });
  document.getElementById('map-btn-toggle-filter').addEventListener('click', CRM.map.toggleFilterPanel);
  CRM.map.updateTourCount();
};

CRM.map.toggleFilterPanel = function () {
  const fields = document.getElementById('map-filter-fields');
  const btn = document.getElementById('map-btn-toggle-filter');
  const open = fields.classList.toggle('open');
  btn.textContent = open ? '▴' : '▾';
};

CRM.map.updateTourCount = function () {
  const n = CRM.map.selectedIds.size;
  const summary = document.getElementById('map-tour-summary');
  const info = document.getElementById('map-tour-info');
  if (summary) summary.textContent = n ? `${n} Stopp${n === 1 ? '' : 'e'} ausgewählt` : 'Noch keine Stopps ausgewählt — auf einen Pin klicken und „Zur Tour hinzufügen“ abhaken.';
  if (info) info.classList.toggle('hidden', !n);
};

/* Nur auf die ausgewählten Tour-Stopps zoomen, ohne Google Maps zu öffnen */
CRM.map.showTour = function () {
  const ids = Array.from(CRM.map.selectedIds);
  const contacts = ids.map((id) => CRM.db.getContact(id)).filter(Boolean);
  const pts = contacts.filter((c) => c.lat != null && c.lng != null).map((c) => [c.lat, c.lng]);
  if (!pts.length) { CRM.toast('Keine Tour-Stopps mit Koordinaten ausgewählt.', 'error'); return; }
  CRM.map.closeSidePanel();
  if (!CRM.map.instance) return;
  CRM.map.instance.invalidateSize();
  if (pts.length === 1) CRM.map.instance.setView(pts[0], 14);
  else CRM.map.instance.fitBounds(L.latLngBounds(pts).pad(0.2));
};
CRM.map.clearTourSelection = function () {
  CRM.map.selectedIds.clear();
  CRM.map.refresh();
  CRM.map.updateTourCount();
};
CRM.map.updateStatusLine = function (total, withCoords, shown) {
  const el = document.getElementById('map-status-line');
  if (el) el.textContent = `${shown} Pins sichtbar · ${withCoords}/${total} geocodiert`;
};

CRM.map.startTour = function () {
  const ids = Array.from(CRM.map.selectedIds);
  if (!ids.length) {
    CRM.toast('Bitte zuerst im Tour-Modus Pins anklicken.', 'error');
    return;
  }
  let contacts = ids.map((id) => CRM.db.getContact(id)).filter(Boolean);
  contacts = CRM.optimizeRouteOrder(contacts);
  const legs = CRM.buildGoogleMapsLegs(contacts, 10);
  CRM.showRouteLegsModal(legs);
};
