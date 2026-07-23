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
  CRM.map.addLocateControl(map);
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

/* ============================================================
   GPS-Standort: Button unter dem Zoom (oben rechts) ermittelt die
   aktuelle Position und zeigt sie als pulsierenden Punkt + Genauigkeits-
   kreis. Zweiter Tipp = neu lokalisieren. Position wird NICHT gespeichert
   und NICHT an Server gesendet — reine Anzeige auf der Karte.
   ============================================================ */
CRM.map.addLocateControl = function (map) {
  const Locate = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'crm-locate-btn', div);
      a.href = '#';
      a.title = 'Meinen Standort anzeigen';
      a.setAttribute('aria-label', 'Meinen Standort anzeigen');
      a.innerHTML = '🧭';
      L.DomEvent.on(a, 'click', function (e) {
        L.DomEvent.stop(e);
        CRM.map.locateMe();
      });
      return div;
    },
  });
  map.addControl(new Locate());

  const Nearby = L.Control.extend({
    options: { position: 'topright' },
    onAdd: function () {
      const div = L.DomUtil.create('div', 'leaflet-bar');
      const a = L.DomUtil.create('a', 'crm-locate-btn crm-nearby-btn', div);
      a.href = '#';
      a.title = 'Kontakte in der Nähe';
      a.setAttribute('aria-label', 'Kontakte in der Nähe');
      a.innerHTML = '🔎';
      L.DomEvent.on(a, 'click', function (e) {
        L.DomEvent.stop(e);
        CRM.map.openNearby();
      });
      return div;
    },
  });
  map.addControl(new Nearby());
};

CRM.map.locateMe = function (onSuccess) {
  if (!navigator.geolocation) {
    CRM.toast('Standortbestimmung wird von diesem Browser nicht unterstützt.', 'error');
    return;
  }
  const btn = document.querySelector('.crm-locate-btn');
  if (btn) btn.classList.add('locating');
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      if (btn) btn.classList.remove('locating');
      CRM.map.showGpsPosition(pos.coords.latitude, pos.coords.longitude, pos.coords.accuracy);
      if (onSuccess) onSuccess();
    },
    (err) => {
      if (btn) btn.classList.remove('locating');
      const msg = err.code === 1
        ? 'Standort-Zugriff verweigert — bitte in den Browser-/App-Einstellungen für diese Seite erlauben.'
        : (err.code === 3 ? 'Zeitüberschreitung bei der Standortbestimmung — bitte nochmal tippen.' : 'Standort konnte nicht ermittelt werden.');
      CRM.toast(msg, 'error');
    },
    { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 }
  );
};

CRM.map.showGpsPosition = function (lat, lng, accuracy) {
  const map = CRM.map.instance;
  if (!map) return;
  CRM.map._gpsPos = { lat, lng, ts: Date.now() };
  if (CRM.map._gpsMarker) { map.removeLayer(CRM.map._gpsMarker); CRM.map._gpsMarker = null; }
  if (CRM.map._gpsCircle) { map.removeLayer(CRM.map._gpsCircle); CRM.map._gpsCircle = null; }

  CRM.map._gpsCircle = L.circle([lat, lng], {
    radius: Math.max(accuracy || 0, 15),
    color: '#3da9fc', fillColor: '#3da9fc', fillOpacity: 0.12, weight: 1,
  }).addTo(map);
  CRM.map._gpsMarker = L.marker([lat, lng], {
    icon: L.divIcon({ className: 'crm-gps-dot-wrap', html: '<div class="crm-gps-dot"></div>', iconSize: [18, 18], iconAnchor: [9, 9] }),
    zIndexOffset: 2000,
    interactive: false,
  }).addTo(map);

  map.setView([lat, lng], Math.max(map.getZoom(), 14));
  const acc = Math.round(accuracy || 0);
  CRM.toast(acc ? `Standort gefunden (±${acc} m).` : 'Standort gefunden.', 'success');
};

/* ============================================================
   SUCHORT — ein gesuchter Ort/eine Adresse als echter Punkt auf der
   Karte (Marker + Ortsumrandung), NICHT als Kontaktfilter. Bleibt
   bestehen, bis er entfernt wird; kann als Tour-Stopp dienen und ist
   Ausgangspunkt für die Umkreis-Suche.
   Datenschutz: An Nominatim geht nur der eingetippte Ort/die Adresse.
   ============================================================ */
CRM.map._suchort = null; // {lat, lng, name, strasse, plz, ort}

CRM.map.sucheOrt = async function () {
  const input = document.getElementById('map-ort-suche');
  const q = (input ? input.value : '').trim();
  if (!q) { CRM.toast('Bitte einen Ort, eine PLZ oder eine Adresse eingeben.', 'error'); return; }

  const btn = document.getElementById('map-ort-btn');
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  const params = new URLSearchParams({
    format: 'jsonv2', q: q + ', Deutschland', limit: '1',
    polygon_geojson: '1', addressdetails: '1',
  });
  try {
    const res = await fetch('https://nominatim.openstreetmap.org/search?' + params.toString(), { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.length) { CRM.toast('Kein Ort gefunden — Schreibweise prüfen oder PLZ ergänzen.', 'error'); return; }
    const d = data[0];
    const a = d.address || {};
    CRM.map.setSuchort({
      lat: parseFloat(d.lat),
      lng: parseFloat(d.lon),
      name: (a.city || a.town || a.village || a.municipality || (d.display_name || q).split(',')[0]).trim(),
      strasse: [a.road, a.house_number].filter(Boolean).join(' '),
      plz: a.postcode || '',
      ort: a.city || a.town || a.village || a.municipality || '',
      geojson: d.geojson || null,
    });
  } catch (e) {
    CRM.toast('Ortssuche fehlgeschlagen — Internetverbindung prüfen.', 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📍 Auf Karte'; }
  }
};

CRM.map.setSuchort = function (s) {
  const map = CRM.map.instance;
  if (!map) return;
  CRM.map._clearSuchortLayers();
  CRM.map._suchort = s;
  // Neuer Suchort startet immer ohne Tour-Zugehörigkeit — sonst würde er
  // den Status des vorherigen Orts stillschweigend erben.
  CRM.map._suchortInTour = false;

  // Ortsgrenze zeichnen, wenn OSM eine Fläche liefert; sonst Umkreis-Ring
  // (bei Hausadressen gibt es keine Grenze)
  const flaeche = s.geojson && (s.geojson.type === 'Polygon' || s.geojson.type === 'MultiPolygon');
  if (flaeche) {
    CRM.map._suchortShape = L.geoJSON(s.geojson, {
      style: { color: '#7F77DD', weight: 2, dashArray: '6 4', fillColor: '#7F77DD', fillOpacity: 0.10 },
      interactive: false,
    }).addTo(map);
  } else {
    CRM.map._suchortShape = L.circle([s.lat, s.lng], {
      radius: 700, color: '#7F77DD', weight: 2, dashArray: '6 4', fillColor: '#7F77DD', fillOpacity: 0.08, interactive: false,
    }).addTo(map);
  }

  CRM.map._suchortMarker = L.marker([s.lat, s.lng], {
    icon: L.divIcon({
      className: 'crm-suchort-wrap',
      html: '<div class="crm-suchort-pin">📍</div>',
      iconSize: [30, 30], iconAnchor: [15, 15],
    }),
    zIndexOffset: 1500,
  }).addTo(map);
  CRM.map._suchortMarker.on('click', CRM.map.openSuchortPanel);
  CRM.map._suchortMarker.bindTooltip(s.name, { direction: 'top' });

  // Auf die Ortsfläche zoomen (bzw. auf den Punkt)
  if (CRM.map._suchortShape.getBounds && flaeche) map.fitBounds(CRM.map._suchortShape.getBounds().pad(0.15));
  else map.setView([s.lat, s.lng], Math.max(map.getZoom(), 13));

  CRM.map.openSuchortPanel();
  CRM.map.updateTourCount();
};

CRM.map._clearSuchortLayers = function () {
  const map = CRM.map.instance;
  if (!map) return;
  if (CRM.map._suchortMarker) { map.removeLayer(CRM.map._suchortMarker); CRM.map._suchortMarker = null; }
  if (CRM.map._suchortShape) { map.removeLayer(CRM.map._suchortShape); CRM.map._suchortShape = null; }
};

CRM.map.clearSuchort = function () {
  CRM.map._clearSuchortLayers();
  CRM.map._suchort = null;
  CRM.map._suchortInTour = false;
  CRM.map.closeSidePanel();
  CRM.map.updateTourCount();
  const input = document.getElementById('map-ort-suche');
  if (input) input.value = '';
  CRM.toast('Suchort entfernt.', 'success');
};

/* Suchort als Routenpunkt — bekommt Adressfelder wie ein Kontakt,
   dadurch funktionieren optimizeRouteOrder und buildGoogleMapsLegs
   ohne Sonderbehandlung. */
CRM.map.suchortAlsStopp = function () {
  if (!CRM.map._suchort) return;
  CRM.map._suchortInTour = !CRM.map._suchortInTour;
  CRM.map.openSuchortPanel();
  CRM.map.updateTourCount();
  CRM.toast(CRM.map._suchortInTour ? 'Suchort als Tour-Stopp gesetzt.' : 'Suchort aus der Tour entfernt.', 'success');
};

CRM.map.suchortAlsRoutenobjekt = function () {
  const s = CRM.map._suchort;
  if (!s) return null;
  return {
    id: '_suchort', firma1: s.name, lat: s.lat, lng: s.lng,
    strasse: s.strasse || '', plz: s.plz || '', ort: s.ort || s.name,
  };
};

CRM.map.openSuchortPanel = function () {
  const s = CRM.map._suchort;
  if (!s) return;
  const panel = document.getElementById('map-side-panel');
  CRM.map._panelContactId = null;
  const adresse = [s.strasse, [s.plz, s.ort].filter(Boolean).join(' ')].filter(Boolean).join(', ') || s.name;
  const inTour = !!CRM.map._suchortInTour;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <h3 style="margin:0">📍 ${esc(s.name)}</h3>
      <button class="btn btn-icon map-panel-close" onclick="CRM.map.closeSidePanel()">✕ Schließen</button>
    </div>
    <p style="margin:6px 0 10px;color:var(--text-dim);font-size:13px">${esc(adresse)} · Suchort</p>
    <button class="btn ${inTour ? '' : 'btn-primary'}" style="width:100%;min-height:44px;margin-bottom:8px" onclick="CRM.map.suchortAlsStopp()">
      ${inTour ? '✓ Ist Tour-Stopp — entfernen' : '➕ Als Tour-Stopp hinzufügen'}
    </button>
    <div class="row" style="gap:6px">
      <button class="btn" style="flex:1;min-height:44px" onclick="CRM.map.nearbyAbSuchort()">🔎 In der Nähe</button>
      <a class="btn" style="flex:1;min-height:44px;justify-content:center" target="_blank" rel="noopener"
         href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(adresse)}&travelmode=driving">🗺️ Navigation</a>
    </div>
    <button class="btn btn-sm" style="width:100%;margin-top:8px" onclick="CRM.map.clearSuchort()">✕ Suchort entfernen</button>
  `;
  panel.classList.add('open');
};

CRM.map.nearbyAbSuchort = function () {
  const s = CRM.map._suchort;
  if (!s) return;
  CRM.map.openNearby({ lat: s.lat, lng: s.lng, label: s.name });
};

/* ============================================================
   Umkreis-Suche: „Was ist in der Nähe?" — Kontakte im Radius um einen
   Ausgangspunkt (GPS-Position ODER Suchort), nach Luftlinie sortiert.
   Radius-Chips + „nur überfällige".
   Nutzt das bestehende Seiten-Panel/Bottom-Sheet der Karte.
   ============================================================ */
CRM.map._nearbyRadius = CRM.map._nearbyRadius || 10;
CRM.map._nearbyOverdueOnly = CRM.map._nearbyOverdueOnly || false;
CRM.map._nearbyExpandedId = null;
CRM.map._nearbyType = CRM.map._nearbyType || ''; // '' = alle Typen

CRM.map.setNearbyType = function (t) {
  CRM.map._nearbyType = (CRM.map._nearbyType === t) ? '' : t;
  CRM.map.renderNearbyPanel();
};

/* Kontakt in der Trefferliste überfahren/antippen → zugehörigen Pin auf
   der Karte hervorheben. Bei Hover nur Hervorhebung (keine Kartenbewegung),
   beim Antippen zusätzlich aus dem Cluster herauszoomen. */
CRM.map.highlightContact = function (id, on) {
  const m = CRM.map._markerById && CRM.map._markerById[id];
  const c = CRM.db.getContact(id);
  if (!m || !c) return;
  if (on) {
    m.setIcon(CRM.map.makeIcon(c, true));
    m.setZIndexOffset(3000);
    if (m._map) m.openTooltip();
  } else {
    m.setIcon(CRM.map.makeIcon(c));
    m.setZIndexOffset(CRM.map.selectedIds.has(id) ? 1000 : 0);
    if (m._map) m.closeTooltip();
  }
};

/* Beim Antippen einer Trefferzeile: Pin sichtbar machen (auch wenn er in
   einem Cluster steckt) und hervorheben — bewusste Aktion, daher darf
   sich die Kartenansicht ändern. */
CRM.map.focusNearby = function (id) {
  const m = CRM.map._markerById && CRM.map._markerById[id];
  if (!m) return;
  const done = () => CRM.map.highlightContact(id, true);
  if (CRM.map.markersLayer && CRM.map.markersLayer.zoomToShowLayer) {
    CRM.map.markersLayer.zoomToShowLayer(m, done);
  } else {
    CRM.map.instance.setView(m.getLatLng(), Math.max(CRM.map.instance.getZoom(), 14));
    done();
  }
};

CRM.map.distKm = function (lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
};

/* origin optional: {lat, lng, label} — z.B. der Suchort. Ohne origin
   wird die GPS-Position genutzt (und bei Bedarf neu ermittelt). */
CRM.map.openNearby = function (origin) {
  if (origin && origin.lat != null) {
    CRM.map._nearbyOrigin = origin;
    CRM.map.renderNearbyPanel();
    return;
  }
  // Position älter als 5 Minuten → neu lokalisieren (im Auto ist man weitergefahren)
  const pos = CRM.map._gpsPos;
  if (!pos || Date.now() - pos.ts > 5 * 60 * 1000) {
    CRM.map.locateMe(() => {
      CRM.map._nearbyOrigin = { lat: CRM.map._gpsPos.lat, lng: CRM.map._gpsPos.lng, label: 'meinem Standort' };
      CRM.map.renderNearbyPanel();
    });
    return;
  }
  CRM.map._nearbyOrigin = { lat: pos.lat, lng: pos.lng, label: 'meinem Standort' };
  CRM.map.renderNearbyPanel();
};

CRM.map.setNearbyRadius = function (km) {
  CRM.map._nearbyRadius = km;
  CRM.map.renderNearbyPanel();
};
CRM.map.toggleNearbyOverdue = function () {
  CRM.map._nearbyOverdueOnly = !CRM.map._nearbyOverdueOnly;
  CRM.map.renderNearbyPanel();
};
CRM.map.toggleNearbyExpand = function (id) {
  CRM.map._nearbyExpandedId = CRM.map._nearbyExpandedId === id ? null : id;
  CRM.map.renderNearbyPanel();
};

CRM.map.renderNearbyPanel = function () {
  const pos = CRM.map._nearbyOrigin || CRM.map._gpsPos;
  if (!pos) return;
  const radius = CRM.map._nearbyRadius;

  let hits = CRM.db.getContacts()
    .filter((c) => c.lat != null && c.lng != null)
    .map((c) => ({ c, dist: CRM.map.distKm(pos.lat, pos.lng, c.lat, c.lng), due: CRM.getDueStatus(c) }))
    .filter((h) => h.dist <= radius);
  if (CRM.map._nearbyOverdueOnly) hits = hits.filter((h) => h.due.status === 'overdue' || h.due.status === 'today');
  if (CRM.map._nearbyType) hits = hits.filter((h) => h.c.type === CRM.map._nearbyType);
  hits.sort((a, b) => a.dist - b.dist);
  const total = hits.length;
  hits = hits.slice(0, 30);

  const chip = (km) => `<button class="qf-btn ${CRM.map._nearbyRadius === km ? 'active' : ''}" onclick="CRM.map.setNearbyRadius(${km})">${km} km</button>`;
  const typChip = (t, label) => `<button class="qf-btn ${CRM.map._nearbyType === t ? 'active' : ''}" onclick="CRM.map.setNearbyType('${t}')">${label}</button>`;

  const rows = hits.map(({ c, dist, due }) => {
    const overdue = due.status === 'overdue' || due.status === 'today';
    const dueLabel = due.status === 'overdue' ? `${-due.diffDays} Tage überfällig`
      : (due.status === 'today' ? 'heute fällig' : `letzter Besuch: ${CRM.formatLastVisit(c)}`);
    const expanded = CRM.map._nearbyExpandedId === c.id;
    const tel = c.telFirma || (c.ansprechpartner && c.ansprechpartner.telefon);
    const addr = CRM.formatAddress(c);
    const inTour = CRM.map.selectedIds.has(c.id);
    const actions = expanded ? `
      <div class="nearby-actions">
        <button class="btn btn-sm ${inTour ? 'btn-primary' : ''}" onclick="event.stopPropagation();CRM.map.toggleSelect('${c.id}');CRM.map.renderNearbyPanel()">${inTour ? '✓ In Tour' : '➕ Zur Tour'}</button>
        ${tel ? `<a class="btn btn-sm" href="tel:${esc(tel)}" onclick="event.stopPropagation()">📞 Anrufen</a>` : ''}
        ${addr ? `<a class="btn btn-sm" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(addr)}&travelmode=driving" target="_blank" rel="noopener" onclick="event.stopPropagation()">🚗 Hinfahren</a>` : ''}
        <button class="btn btn-sm" onclick="event.stopPropagation();CRM.openContactDetail('${c.id}')">Profil</button>
      </div>` : '';
    return `
      <div class="nearby-row ${overdue ? 'nearby-overdue' : ''} ${inTour ? 'nearby-intour' : ''}"
           onmouseenter="CRM.map.highlightContact('${c.id}',true)"
           onmouseleave="CRM.map.highlightContact('${c.id}',false)"
           onclick="CRM.map.focusNearby('${c.id}');CRM.map.toggleNearbyExpand('${c.id}')">
        <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
          <div class="nearby-title">${inTour ? '✓ ' : ''}${esc(c.firma1)} ${c.isPartner ? '⭐' : ''}</div>
          <div class="nearby-dist">${dist < 10 ? dist.toFixed(1).replace('.', ',') : Math.round(dist)} km</div>
        </div>
        <div class="nearby-sub">${c.abc} · ${CRM.TYPE_LABELS[c.type] || ''} · ${dueLabel}</div>
        ${actions}
      </div>`;
  }).join('');

  const panel = document.getElementById('map-side-panel');
  CRM.map._panelContactId = null;
  panel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
      <h3 style="margin:0">In der Nähe (${total})</h3>
      <button class="btn btn-icon map-panel-close" onclick="${CRM.map._suchort && pos.label !== 'meinem Standort' ? 'CRM.map.openSuchortPanel()' : 'CRM.map.closeSidePanel()'}">${CRM.map._suchort && pos.label !== 'meinem Standort' ? '‹ Zurück' : '✕ Schließen'}</button>
    </div>
    <p style="margin:2px 0 0;color:var(--text-dim);font-size:12px">ab ${esc(pos.label || 'meinem Standort')}</p>
    <div class="nearby-chips">
      ${chip(5)}${chip(10)}${chip(25)}${chip(50)}
      <button class="qf-btn ${CRM.map._nearbyOverdueOnly ? 'active' : ''}" onclick="CRM.map.toggleNearbyOverdue()" style="margin-left:auto">nur überfällige</button>
    </div>
    <div class="nearby-chips" style="margin-top:-4px">
      ${typChip('', 'Alle Typen')}${typChip('haendler', 'Händler')}${typChip('verarbeiter', 'Verarbeiter')}${typChip('architekt', 'Architekt')}${typChip('bauherr', 'Bauherr')}
    </div>
    <div class="nearby-list">
      ${rows || '<p style="color:var(--text-dim);font-size:13px;margin:10px 0">Keine Kontakte in diesem Radius'
        + (CRM.map._nearbyType ? ` (Typ „${CRM.TYPE_LABELS[CRM.map._nearbyType]}")` : '')
        + (CRM.map._nearbyOverdueOnly ? ' (Filter „nur überfällige" aktiv)' : '') + '.</p>'}
      ${total > 30 ? `<p style="color:var(--text-dim);font-size:12px;margin:6px 0 0">${total - 30} weitere — Radius verkleinern oder Filter nutzen.</p>` : ''}
    </div>
    <p style="color:var(--text-dim);font-size:11px;margin:8px 0 0">Entfernung = Luftlinie ab ${esc(pos.label || 'meinem Standort')}. Zeile antippen zeigt den Pin auf der Karte.</p>
  `;
  panel.classList.add('open');
};

CRM.map.makeIcon = function (c, highlight) {
  // Hervorhebung beim Überfahren/Antippen in der „In der Nähe"-Liste:
  // größer, weißer Ring, Pulsieren — hebt sich klar von allen anderen ab.
  if (highlight) {
    const color = c.isPartner ? '#e6b94d' : (CRM.TYPE_COLORS[c.type] || '#9aa4b5');
    return L.divIcon({
      className: 'crm-marker crm-marker-hl',
      html: `<div style="background:${color};width:32px;height:32px;border-radius:50%;border:4px solid #fff;box-shadow:0 0 0 3px ${color}88,0 2px 8px rgba(0,0,0,.5)"></div>`,
      iconSize: [32, 32],
      iconAnchor: [16, 16],
    });
  }
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
  // Zustand merken; am Handy standardmäßig EINGEKLAPPT, damit die Karte frei bleibt
  if (CRM.map._panelOffen === undefined) {
    let gespeichert = null;
    try { gespeichert = localStorage.getItem('crmMapPanel'); } catch (e) { /* privat */ }
    CRM.map._panelOffen = gespeichert !== null ? gespeichert === '1' : window.innerWidth > 768;
  }
  const el = document.getElementById('map-controls');
  el.innerHTML = `
    <div class="map-panel-head" onclick="CRM.map.togglePanel()">
      <span><span id="map-panel-arrow">${CRM.map._panelOffen === false ? '▸' : '▾'}</span> Suche &amp; Filter</span>
      <span id="map-panel-hint" style="font-size:11px;color:var(--text-dim)"></span>
    </div>
    <div id="map-panel-body" class="${CRM.map._panelOffen === false ? 'hidden' : ''}">
    <div style="font-weight:600;margin-bottom:6px">Ort / Adresse auf der Karte</div>
    <div class="row" style="gap:6px;margin-bottom:4px">
      <input id="map-ort-suche" placeholder="z.B. Velburg oder Hauptstr. 12, 92355 Velburg" style="flex:1"
             onkeydown="if(event.key==='Enter'){event.preventDefault();CRM.map.sucheOrt();}">
      <button class="btn btn-primary" id="map-ort-btn" style="min-height:40px;white-space:nowrap" onclick="CRM.map.sucheOrt()">📍 Auf Karte</button>
    </div>
    <p style="color:var(--text-dim);font-size:11px;margin:0 0 10px">Markiert den Ort dauerhaft — Kontakte bleiben alle sichtbar.</p>
    <hr style="border-color:var(--border)">
    <div class="row" style="justify-content:space-between;align-items:center">
      <div style="font-weight:600">Filter</div>
      <button type="button" class="btn btn-sm mobile-only-filter" id="map-btn-toggle-filter">▾</button>
    </div>
    <div class="map-filter-fields" id="map-filter-fields">
      <input id="map-filter-query" placeholder="🔍 Kontakte nach Ort/PLZ filtern..." value="${escAttr(CRM.map.filters.query || '')}" style="margin:8px 0 10px">
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
    </div>
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
  CRM.map.updatePanelHint();
};

CRM.map.togglePanel = function () {
  CRM.map._panelOffen = (CRM.map._panelOffen === false);
  const body = document.getElementById('map-panel-body');
  const arrow = document.getElementById('map-panel-arrow');
  if (body) body.classList.toggle('hidden', !CRM.map._panelOffen);
  if (arrow) arrow.textContent = CRM.map._panelOffen ? '▾' : '▸';
  CRM.map.updatePanelHint();
  try { localStorage.setItem('crmMapPanel', CRM.map._panelOffen ? '1' : '0'); } catch (e) { /* voll */ }
};

/* Zusammenfassung in der Kopfzeile, wenn eingeklappt — man sieht auf einen
   Blick, ob ein Suchort/Filter aktiv ist, ohne aufzuklappen. */
CRM.map.updatePanelHint = function () {
  const el = document.getElementById('map-panel-hint');
  if (!el) return;
  if (CRM.map._panelOffen !== false) { el.textContent = ''; return; }
  const teile = [];
  if (CRM.map._suchort) teile.push('📍 ' + CRM.map._suchort.name);
  const n = CRM.map.selectedIds.size + (CRM.map._suchortInTour ? 1 : 0);
  if (n) teile.push(n + ' Stopps');
  el.textContent = teile.join(' · ') || 'eingeklappt';
};

CRM.map.toggleFilterPanel = function () {
  const fields = document.getElementById('map-filter-fields');
  const btn = document.getElementById('map-btn-toggle-filter');
  const open = fields.classList.toggle('open');
  btn.textContent = open ? '▴' : '▾';
};

CRM.map.updateTourCount = function () {
  const n = CRM.map.selectedIds.size;
  const mitSuchort = !!(CRM.map._suchortInTour && CRM.map._suchort);
  const gesamt = n + (mitSuchort ? 1 : 0);
  const summary = document.getElementById('map-tour-summary');
  const info = document.getElementById('map-tour-info');
  if (summary) {
    summary.textContent = gesamt
      ? `${gesamt} Stopp${gesamt === 1 ? '' : 's'} ausgewählt` + (mitSuchort ? ` (inkl. 📍 ${CRM.map._suchort.name})` : '')
      : 'Noch keine Stopps ausgewählt — auf einen Pin klicken und „Zur Tour hinzufügen“ abhaken.';
  }
  if (info) info.classList.toggle('hidden', !gesamt);
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
  const suchortStopp = CRM.map._suchortInTour ? CRM.map.suchortAlsRoutenobjekt() : null;
  if (!ids.length && !suchortStopp) {
    CRM.toast('Bitte zuerst im Tour-Modus Pins anklicken.', 'error');
    return;
  }
  let contacts = ids.map((id) => CRM.db.getContact(id)).filter(Boolean);
  // Suchort als Startpunkt voranstellen — die Nearest-Neighbor-Optimierung
  // beginnt beim ersten Eintrag, dadurch wird ab dem Suchort geplant.
  if (suchortStopp) contacts = [suchortStopp].concat(contacts);
  contacts = CRM.optimizeRouteOrder(contacts);
  const legs = CRM.buildGoogleMapsLegs(contacts, 10);
  CRM.showRouteLegsModal(legs);
};
