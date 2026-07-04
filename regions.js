/* ============================================================
   Claytec CRM — Regionen (Schritt 11)
   Bayern in sinnvolle PLZ-Tourcluster aufgeteilt (nicht nur
   Regierungsbezirke, sondern fahrbare Gebiete nach 2-stelligem
   PLZ-Präfix). Pro Region: Kontaktzahl, A-Partner, überfällige
   Besuche, Ampel-Status.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

/* PLZ-Präfix (2-stellig) → Tourgebiet. Reihenfolge = grobe Tour-Logik. */
CRM.REGIONS = [
  { id: 'muc-stadt', name: 'München Stadt', prefixes: ['80', '81'] },
  { id: 'muc-umland', name: 'München Umland (S/W)', prefixes: ['82'] },
  { id: 'obb-soe', name: 'Oberbayern Süd-Ost (Rosenheim/Traunstein/BGL)', prefixes: ['83'] },
  { id: 'ndb-west', name: 'Niederbayern West (Landshut/Dingolfing)', prefixes: ['84'] },
  { id: 'muc-nord', name: 'München Nord (Freising/Erding/Ingolstadt)', prefixes: ['85'] },
  { id: 'schwaben-n', name: 'Augsburg / Schwaben Nord', prefixes: ['86'] },
  { id: 'allgaeu', name: 'Allgäu (Kempten/Kaufbeuren)', prefixes: ['87', '88'] },
  { id: 'mfr', name: 'Nürnberg / Mittelfranken', prefixes: ['90', '91'] },
  { id: 'opf', name: 'Oberpfalz (Amberg/Weiden)', prefixes: ['92'] },
  { id: 'regensburg', name: 'Regensburg', prefixes: ['93'] },
  { id: 'ndb-ost', name: 'Niederbayern Ost (Passau/Deggendorf)', prefixes: ['94'] },
  { id: 'ofr-ost', name: 'Oberfranken Ost (Bayreuth/Hof)', prefixes: ['95'] },
  { id: 'bamberg', name: 'Bamberg / Coburg', prefixes: ['96'] },
  { id: 'ufr', name: 'Würzburg / Unterfranken', prefixes: ['97'] },
];

CRM.regionForPlz = function (plz) {
  const p2 = String(plz || '').slice(0, 2);
  const r = CRM.REGIONS.find((reg) => reg.prefixes.includes(p2));
  return r ? r.id : 'other';
};

CRM.regionNameForPlz = function (plz) {
  const rid = CRM.regionForPlz(plz);
  const r = CRM.REGIONS.find((reg) => reg.id === rid);
  return r ? r.name : 'Außerhalb Bayerns / ohne PLZ';
};

/* Von Kontaktliste/-profil aus direkt zur Region springen: Region-Häkchen
   setzen und im Regionen-Tab die zugehörigen Kontakte darunter anzeigen. */
CRM.goToRegion = function (rid) {
  CRM._regionSelection = new Set([rid]);
  CRM.switchTab('regionen');
};

/* Typ/Listenquelle-Filter für den Regionen-Tab — wirkt auf Zahlen in den
   Regionskarten UND auf die Kontaktliste darunter. */
CRM._regionTypeFilter = CRM._regionTypeFilter || { haendler: true, verarbeiter: true, architekt: true, bauherr: true, sonstige: true };
CRM._regionSourceFilter = CRM._regionSourceFilter || { eigene: true, eurobaustoff: true, partner: true, baywa: true };

CRM.regionContactPassesFilter = function (c) {
  if (CRM._regionTypeFilter[c.type] === false) return false;
  if (CRM._regionSourceFilter[c.source] === false) return false;
  return true;
};

CRM.computeRegionStats = function () {
  const stats = {};
  CRM.REGIONS.forEach((r) => {
    stats[r.id] = { region: r, total: 0, partner: 0, aCount: 0, overdue: 0, geocoded: 0 };
  });
  stats.other = { region: { id: 'other', name: 'Außerhalb Bayerns / ohne PLZ' }, total: 0, partner: 0, aCount: 0, overdue: 0, geocoded: 0 };

  CRM.db.getContacts().filter(CRM.regionContactPassesFilter).forEach((c) => {
    const rid = CRM.regionForPlz(c.plz);
    const s = stats[rid] || stats.other;
    s.total++;
    if (c.isPartner) s.partner++;
    if (c.abc === 'A') s.aCount++;
    if (c.lat != null && c.lng != null) s.geocoded++;
    if (CRM.getDueStatus(c).status === 'overdue') s.overdue++;
  });
  return stats;
};

/* Ampel: grün (alles im Plan), gelb (einige überfällig), rot (viele überfällig) */
CRM.regionAmpel = function (s) {
  if (!s.total) return { color: 'grey', label: 'leer' };
  const ratio = s.overdue / s.total;
  if (s.overdue === 0) return { color: 'green', label: 'im Plan' };
  if (ratio < 0.25) return { color: 'yellow', label: `${s.overdue} überfällig` };
  return { color: 'red', label: `${s.overdue} überfällig` };
};

CRM.renderRegionen = function () {
  const container = document.getElementById('view-regionen');
  const stats = CRM.computeRegionStats();
  const order = CRM.REGIONS.map((r) => r.id).concat('other');

  CRM._regionSelection = CRM._regionSelection || new Set();
  const cards = order.map((rid) => {
    const s = stats[rid];
    if (!s || (!s.total && rid === 'other')) return '';
    const a = CRM.regionAmpel(s);
    const checked = CRM._regionSelection.has(rid) ? 'checked' : '';
    return `
      <div class="region-card">
        <div class="region-head">
          <input type="checkbox" class="region-check" data-rid="${rid}" ${checked} title="Für Tour auswählen" onclick="event.stopPropagation()" style="width:auto">
          <span class="ampel ampel-${a.color}"></span>
          <span class="region-name" style="cursor:pointer" onclick="CRM.filterByRegion('${rid}')">${esc(s.region.name)}</span>
        </div>
        <div class="region-stats" style="cursor:pointer" onclick="CRM.filterByRegion('${rid}')">
          <div><strong>${s.total}</strong><span>Kontakte</span></div>
          <div><strong>${s.aCount}</strong><span>A-Kunden</span></div>
          <div><strong>${s.partner}</strong><span>Partner ⭐</span></div>
          <div class="${s.overdue ? 'stat-warn' : ''}"><strong>${s.overdue}</strong><span>überfällig</span></div>
        </div>
        <div class="region-foot">${a.label} · ${s.geocoded}/${s.total} auf Karte</div>
      </div>`;
  }).join('');

  const totalContacts = CRM.db.getContacts().filter(CRM.regionContactPassesFilter).length;
  const totalAll = CRM.db.getContacts().length;
  const selSize = CRM._regionSelection.size;
  const filterHtml = `
    <div class="card" style="margin-bottom:12px">
      <div style="font-weight:600;margin-bottom:8px">Filter (wirkt auf Zahlen & Liste unten)</div>
      <div class="row" style="flex-wrap:wrap;gap:20px">
        <div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Typ</div>
          ${CRM.TYPES.map((t) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:4px"><input type="checkbox" class="region-type-filter" data-type="${t}" ${CRM._regionTypeFilter[t] ? 'checked' : ''} style="width:auto"> ${CRM.TYPE_LABELS[t]}</label>`).join('')}
        </div>
        <div>
          <div style="font-size:12px;color:var(--text-dim);margin-bottom:4px">Listenquelle</div>
          ${CRM.SOURCES.map((s) => `<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-bottom:4px"><input type="checkbox" class="region-source-filter" data-source="${s}" ${CRM._regionSourceFilter[s] ? 'checked' : ''} style="width:auto"> ${CRM.SOURCE_LABELS[s]}</label>`).join('')}
        </div>
      </div>
    </div>`;
  container.innerHTML = `
    <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px">
      <h2 style="margin:0">Regionen (Tourgebiete)</h2>
      <span style="color:var(--text-dim);font-size:13px">${totalContacts === totalAll ? `${totalAll} Kontakte gesamt` : `${totalContacts} von ${totalAll} Kontakten (gefiltert)`}</span>
    </div>
    <p style="color:var(--text-dim);font-size:13px;margin-top:0">Bayern in fahrbare PLZ-Cluster. Auf eine Region klicken zeigt ihre Kontakte gefiltert an. Mit den Häkchen <strong>mehrere Regionen</strong> für eine grenzübergreifende Tour kombinieren.</p>
    ${filterHtml}
    <div class="row" id="region-tour-bar" style="gap:8px;margin-bottom:12px;${selSize ? '' : 'display:none'}">
      <span style="color:var(--text-dim);font-size:13px;align-self:center"><strong id="region-sel-count">${selSize}</strong> Regionen gewählt</span>
      <button class="btn btn-sm" onclick="CRM.showSelectedRegionsContacts()">📋 Kontakte anzeigen</button>
      <button class="btn btn-sm" onclick="CRM.routeRegionsOnMap()">📍 Auf Karte anzeigen</button>
      <button class="btn btn-sm btn-primary" onclick="CRM.routeRegionsGoogle()">🗺️ Tour in Google Maps</button>
      <button class="btn btn-sm" onclick="CRM.clearRegionSelection()">Leeren</button>
    </div>
    <div class="region-grid">${cards || '<p style="color:var(--text-dim)">Noch keine Kontakte.</p>'}</div>
    <div id="region-contacts" style="margin-top:16px"></div>
  `;

  container.querySelectorAll('.region-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const rid = e.target.dataset.rid;
      if (e.target.checked) CRM._regionSelection.add(rid); else CRM._regionSelection.delete(rid);
      const bar = document.getElementById('region-tour-bar');
      const cnt = document.getElementById('region-sel-count');
      if (cnt) cnt.textContent = CRM._regionSelection.size;
      if (bar) bar.style.display = CRM._regionSelection.size ? '' : 'none';
      CRM.renderRegionContacts();
    });
  });
  container.querySelectorAll('.region-type-filter').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      CRM._regionTypeFilter[e.target.dataset.type] = e.target.checked;
      CRM.renderRegionen();
    });
  });
  container.querySelectorAll('.region-source-filter').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      CRM._regionSourceFilter[e.target.dataset.source] = e.target.checked;
      CRM.renderRegionen();
    });
  });
  CRM.renderRegionContacts();
};

/* Inline-Liste der Kontakte der gewählten Regionen — mit Einzel-Auswahl.
   Ist bereits ein Kontakt mit Koordinaten ausgewählt, dient er als
   Ausgangspunkt: die anderen werden nach Entfernung (km, Luftlinie)
   sortiert und mit Distanz angezeigt — wahlweise alle oder nur die 5
   nächsten (Umschalter). */
CRM.renderRegionContacts = function () {
  const el = document.getElementById('region-contacts');
  if (!el) return;
  if (!CRM._regionSelection.size) { el.innerHTML = ''; return; }
  CRM._contactSelection = CRM._contactSelection || new Set();
  const all = CRM.contactsInSelectedRegions();
  const totalCount = all.length;

  const anchor = all.find((c) => CRM._contactSelection.has(c.id) && c.lat != null && c.lng != null);
  let contacts;
  let distById = null;
  if (anchor) {
    if (CRM._rcDistanceLimit === undefined) CRM._rcDistanceLimit = 5;
    const others = all.filter((c) => c.id !== anchor.id).map((c) => ({
      c,
      km: (c.lat != null && c.lng != null) ? CRM.haversineKm(anchor.lat, anchor.lng, c.lat, c.lng) : null,
    })).sort((a, b) => (a.km ?? Infinity) - (b.km ?? Infinity));
    const limited = CRM._rcDistanceLimit ? others.slice(0, CRM._rcDistanceLimit) : others;
    contacts = [anchor, ...limited.map((x) => x.c)];
    distById = new Map(limited.map((x) => [x.c.id, x.km]));
  } else {
    contacts = all.slice().sort((a, b) => (parseInt(a.plz, 10) || 0) - (parseInt(b.plz, 10) || 0));
  }

  if (!contacts.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:13px">Keine Kontakte in den gewählten Regionen.</p>'; return; }
  const selCount = all.filter((c) => CRM._contactSelection.has(c.id)).length;
  const rows = contacts.slice(0, 300).map((c) => {
    const isAnchor = anchor && c.id === anchor.id;
    let distanceHtml;
    if (anchor) {
      if (isAnchor) distanceHtml = '<span style="color:var(--accent-2);font-size:12px">📍 Ausgangspunkt</span>';
      else { const km = distById.get(c.id); distanceHtml = km != null ? `${km.toFixed(1)} km` : '–'; }
    }
    return CRM.contactRowHtml(c, {
      checkboxClass: 'rc-check',
      selectionSet: CRM._contactSelection,
      distanceHtml,
      rowStyle: isAnchor ? 'background:rgba(94,230,196,.08)' : '',
    });
  }).join('');
  el.innerHTML = `
    <div class="card" style="padding:10px 12px">
      <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:8px;flex-wrap:wrap;gap:8px">
        <strong style="font-size:14px">${totalCount} Kontakte in den gewählten Regionen${anchor ? ` · Entfernung zu „${esc(anchor.firma1)}“` : ''}</strong>
        <div class="row" style="gap:6px">
          ${anchor ? `<button class="btn btn-sm" onclick="CRM.toggleRcDistanceLimit()">${CRM._rcDistanceLimit ? `Alle ${totalCount - 1} anzeigen` : 'Nur 5 nächste'}</button>` : ''}
          <button class="btn btn-sm" onclick="CRM.rcSelectAll(true)">Alle wählen</button>
          <button class="btn btn-sm" onclick="CRM.rcSelectAll(false)">Auswahl leeren</button>
          <button class="btn btn-sm" onclick="CRM.showSelectedRegionsContacts()">Im Kontakte-Tab öffnen →</button>
        </div>
      </div>
      <div class="row" id="rc-toolbar" style="gap:8px;margin-bottom:8px;${selCount ? '' : 'display:none'}">
        <span style="color:var(--text-dim);font-size:13px;align-self:center"><strong id="rc-sel-count">${selCount}</strong> ausgewählt</span>
        <button class="btn btn-sm btn-primary" onclick="CRM.routeSelectedGoogle()">🗺️ Route in Google Maps</button>
        <button class="btn btn-sm" onclick="CRM.routeSelectedOnMap()">📍 Auf Karte anzeigen</button>
      </div>
      <table class="contact-table mobile-cards"><thead>${CRM.contactTableHeaderHtml(!!anchor)}</thead><tbody>${rows}</tbody></table>
      ${contacts.length > 300 ? `<p style="color:var(--text-dim);font-size:12px">… und ${contacts.length - 300} weitere</p>` : ''}
    </div>`;

  el.querySelectorAll('.rc-check').forEach((cb) => {
    cb.addEventListener('change', (e) => {
      const id = e.target.dataset.id;
      if (e.target.checked) CRM._contactSelection.add(id); else CRM._contactSelection.delete(id);
      CRM.updateRcToolbar();
    });
  });
};

CRM.updateRcToolbar = function () {
  const contacts = CRM.contactsInSelectedRegions();
  const n = contacts.filter((c) => CRM._contactSelection.has(c.id)).length;
  const tb = document.getElementById('rc-toolbar');
  const cnt = document.getElementById('rc-sel-count');
  if (cnt) cnt.textContent = n;
  if (tb) tb.style.display = n ? '' : 'none';
};

CRM.toggleRcDistanceLimit = function () {
  CRM._rcDistanceLimit = CRM._rcDistanceLimit ? null : 5;
  CRM.renderRegionContacts();
};

CRM.rcSelectAll = function (select) {
  CRM._contactSelection = CRM._contactSelection || new Set();
  CRM.contactsInSelectedRegions().forEach((c) => { if (select) CRM._contactSelection.add(c.id); else CRM._contactSelection.delete(c.id); });
  CRM.renderRegionContacts();
};

/* Kontakte aller gewählten Regionen sammeln */
CRM.contactsInSelectedRegions = function () {
  return CRM.db.getContacts().filter((c) => CRM._regionSelection.has(CRM.regionForPlz(c.plz)) && CRM.regionContactPassesFilter(c));
};

CRM.clearRegionSelection = function () { CRM._regionSelection.clear(); CRM.renderRegionen(); };

CRM.showSelectedRegionsContacts = function () {
  // Präziser Filter: exakt die gewählten Regionen (auch nicht benachbarte)
  CRM._regionFilter = new Set(CRM._regionSelection);
  CRM.switchTab('kontakte');
  // PLZ-Feld leeren, damit nur der Regionsfilter greift
  const plzField = document.getElementById('filter-plz');
  if (plzField) plzField.value = '';
  CRM.renderContactList();
};

CRM.routeRegionsGoogle = function () {
  let contacts = CRM.contactsInSelectedRegions().filter((c) => c.strasse && c.plz);
  if (!contacts.length) { CRM.toast('In den gewählten Regionen keine Adressen gefunden.', 'error'); return; }
  if (contacts.length > 10) CRM.toast(`${contacts.length} Kontakte — Route wird in Etappen à 10 Stopps aufgeteilt.`, 'success');
  contacts = CRM.optimizeRouteOrder(contacts);
  CRM.showRouteLegsModal(CRM.buildGoogleMapsLegs(contacts, 10));
};

CRM.routeRegionsOnMap = function () {
  const withCoords = CRM.contactsInSelectedRegions().filter((c) => c.lat != null && c.lng != null);
  if (!withCoords.length) { CRM.toast('Keine geocodierten Kontakte in den Regionen (Karte/Geocoding zuerst).', 'error'); return; }
  CRM.map.selectedIds = new Set(withCoords.map((c) => c.id));
  CRM.map.updateTourCount();
  CRM.map.showWith(withCoords);
};

/* Region anklicken → Kontakte-Tab mit PLZ-Bereichsfilter der Region */
CRM.filterByRegion = function (rid) {
  // Präziser Filter auf genau diese Region
  CRM._regionFilter = new Set([rid]);
  CRM.switchTab('kontakte');
  const plzField = document.getElementById('filter-plz');
  if (plzField) plzField.value = '';
  CRM.renderContactList();
};
