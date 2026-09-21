/* ============================================================
   Claytec CRM — Musterversand / Werbemittelbestellung
   Stellt Werbemittel für einen Kontakt zusammen und öffnet eine
   fertige Bestell-Mail an den Innendienst.
   Katalog: werbemittel.js (aus der ClayTec-Bestellliste erzeugt).
   WICHTIG: Bestellt wird in STÜCK, nicht in Verpackungseinheiten —
   bei Artikeln mit VE > 1 wird die VE in der Mail zur Klarstellung
   mitgeschickt („VE 10 Stk — bitte nur 2 Stk").
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.muster = { _contactId: null, _mengen: {}, _nurFav: false, _farbton: {} };

/* Braucht dieser Artikel eine Farbtonangabe? (YOSIMA-Beutel) */
CRM.muster.brauchtFarbton = function (nr) {
  return !!(CRM.YOSIMA_BEUTEL_ARTIKEL && CRM.YOSIMA_BEUTEL_ARTIKEL[nr]);
};

CRM.muster.getFavoriten = function () {
  return CRM.db.getSettings().musterFavoriten || [];
};

CRM.muster.toggleFavorit = function (nr) {
  const fav = CRM.muster.getFavoriten().slice();
  const i = fav.indexOf(nr);
  if (i >= 0) fav.splice(i, 1);
  else fav.push(nr);
  CRM.db.saveSettings({ musterFavoriten: fav });
  CRM.muster.renderListe();
};

/* ============================================================
   Geführter Ablauf (Chris-Feedback 2026-09-21): Kontakt → Adresse →
   Muster → Bestellkarte (Übersicht). EIN Dialog, der nur einmal geöffnet
   wird; die Schritte werden darin ausgetauscht (CRM.openModal ruft immer
   zuerst closeModal() — ein Modal pro Schritt würde den Ablauf zerstören).
   Weil beim Schrittwechsel das DOM neu gebaut wird, lebt alles, was der
   Nutzer eingegeben hat, im Zustand (_kopf, _mengen, …), nicht in Feldern.
   ============================================================ */
CRM.muster._kopf = { kunde: '', knr: '', ap: '', adresse: '', anlass: '' };
CRM.muster._step = '';
CRM.muster._skipKontakt = false;
CRM.muster._adrQuelle = 'firma'; // 'firma' | 'projekt:<id>' | 'frei'
CRM.muster._suche = '';
CRM.muster._kontaktQuery = '';

CRM.muster.STEP_LABELS = { kontakt: 'Kontakt', adresse: 'Lieferadresse', muster: 'Muster', karte: 'Übersicht' };

/* Einstieg: opts.contactId (Kontakt schon bekannt → Start bei "Adresse"),
   opts.taskId (Aufgabe wird nach dem Versenden erledigt),
   opts.query (Suchfeld in Schritt "Kontakt" vorbelegen). */
CRM.muster.start = function (opts) {
  opts = opts || {};
  const m = CRM.muster;
  const c = opts.contactId ? CRM.db.getContact(opts.contactId) : null;
  if (opts.contactId && !c) return;
  m._contactId = c ? c.id : null;
  m._taskId = opts.taskId || null; // wird nach dem Versand als erledigt markiert
  m._mengen = {};
  m._farbton = {};
  m._farbtonNr = {};
  m._einheit = {};   // pro Artikel: 'stk' oder 've'
  m._openKats = null; // wird in renderListe gesetzt: nur erste Kategorie offen
  m._suche = '';
  m._kopf = { kunde: '', knr: '', ap: '', adresse: '', anlass: '' };
  m._adrQuelle = 'firma';
  m._kontaktQuery = opts.query || '';
  m._skipKontakt = !!c;
  if (c) { m._initFromContact(c); m._step = 'adresse'; } else { m._step = 'kontakt'; }
  // Startet mit der eigenen Auswahl, sobald welche gepflegt ist
  m._nurFav = m.getFavoriten().length > 0;
  CRM.openModal('', { dismissible: false });
  m._render();
};

/* Bisheriger Einstieg (Kontaktprofil, Aufgabe, Sprachbefehl) — unverändert
   aufrufbar, startet jetzt bei "Lieferadresse". */
CRM.muster.open = function (contactId, taskId) {
  CRM.muster.start({ contactId, taskId });
};

/* Einstieg aus der Kopfsuche: "muster" / "muster kraft". Steht nach dem
   Stichwort ein Name, der GENAU einen Kontakt trifft, ist der gleich
   gewählt; bei mehreren Treffern bleibt es bei der Auswahl (nie
   automatisch der "beste von mehreren"). */
CRM.muster.startFromSearch = function (rawQuery) {
  const q = String(rawQuery || '').toLowerCase().trim();
  const keys = ['muster versenden', 'muster bestellen', 'musterversand', 'werbemittel', 'bestellung', 'muster'];
  let rest = q;
  for (const k of keys) { if (q.startsWith(k)) { rest = q.slice(k.length).trim(); break; } }
  if (rest.length >= 2) {
    const hits = CRM.db.getContacts().filter((c) => !c.archived && CRM.contactQueryMatch(rest, c));
    if (hits.length === 1) return CRM.muster.start({ contactId: hits[0].id });
    return CRM.muster.start({ query: rest });
  }
  return CRM.muster.start({});
};

CRM.muster._initFromContact = function (c) {
  const ap = CRM.mainAnsprechpartner(c);
  const k = CRM.muster._kopf;
  k.kunde = c.firma1 || '';
  k.knr = c.erpNr || '';
  k.ap = [ap.vorname, ap.name].filter(Boolean).join(' ');
  k.adresse = CRM.muster._firmenAdresse(c);
  CRM.muster._adrQuelle = 'firma';
};

CRM.muster._firmenAdresse = function (c) {
  return [c.strasse, [c.plz, c.ort].filter(Boolean).join(' ')].filter(Boolean).join('\n');
};

/* Adressen, die für diesen Kontakt als Lieferziel in Frage kommen:
   Firmenadresse + Adressen verknüpfter Projekte/Baustellen (mit Straße). */
CRM.muster._adressOptionen = function (c) {
  const out = [];
  const firma = CRM.muster._firmenAdresse(c);
  if (firma) out.push({ key: 'firma', label: '🏢 Firmenadresse', text: firma });
  const ids = new Set((c.links && c.links.projektIds) || []);
  CRM.db.getProjects().forEach((p) => { if ((p.contactIds || []).indexOf(c.id) >= 0) ids.add(p.id); });
  ids.forEach((id) => {
    const p = CRM.db.getProject(id);
    if (!p || !String(p.strasse || '').trim()) return;
    const text = [p.strasse, [p.plz, p.ort].filter(Boolean).join(' ')].filter(Boolean).join('\n');
    out.push({ key: 'projekt:' + p.id, label: '🏗 ' + (p.name || 'Baustelle'), text, projekt: p.name || 'Baustelle' });
  });
  out.push({ key: 'frei', label: '✎ Andere Adresse', text: '' });
  return out;
};

/* Kurzbezeichnung der gewählten Lieferadresse (für Bestellkarte + Journal). */
CRM.muster._adrLabel = function () {
  const q = CRM.muster._adrQuelle;
  if (q === 'firma') return 'Firmenadresse';
  if (q === 'frei') return 'andere Adresse';
  const p = CRM.db.getProject(q.replace('projekt:', ''));
  return 'Baustelle' + (p && p.name ? ' „' + p.name + '"' : '');
};

/* Sichert die (möglicherweise geänderten) Feldwerte des aktuellen Schritts
   in den Zustand — vor JEDEM Neuzeichnen aufrufen. */
CRM.muster._syncKopf = function () {
  const k = CRM.muster._kopf;
  [['kunde', 'mu-kunde'], ['knr', 'mu-knr'], ['ap', 'mu-ap'], ['anlass', 'mu-anlass'], ['adresse', 'mu-adresse']].forEach(([key, id]) => {
    const el = document.getElementById(id);
    if (el) k[key] = el.value;
  });
};

CRM.muster._steps = function () {
  return CRM.muster._skipKontakt ? ['adresse', 'muster', 'karte'] : ['kontakt', 'adresse', 'muster', 'karte'];
};

CRM.muster._render = function () {
  const modal = document.querySelector('#active-modal-overlay .modal');
  if (!modal) return;
  const m = CRM.muster;
  const steps = m._steps();
  const nr = steps.indexOf(m._step) + 1;
  const parts = {
    kontakt: m._stepKontakt,
    adresse: m._stepAdresse,
    muster: m._stepMuster,
    karte: m._stepKarte,
  }[m._step].call(m);
  modal.innerHTML = '<h2 style="margin:0 0 2px">📦 Muster versenden</h2>'
    + '<div style="font-size:12px;color:var(--text-dim);margin-bottom:12px">Schritt ' + nr + ' von ' + steps.length + ' · ' + m.STEP_LABELS[m._step] + '</div>'
    + parts.body
    + '<div class="modal-footer">' + parts.footer + '</div>';
  if (parts.after) parts.after();
};

CRM.muster._abbrechen = function () {
  const m = CRM.muster;
  // Kam der Nutzer aus einem Kontaktprofil, geht es dorthin zurück.
  if (m._skipKontakt && m._contactId && CRM.renderContactDetailModal) CRM.renderContactDetailModal(m._contactId);
  else CRM.closeModal();
};

CRM.muster._zurueck = function () {
  const m = CRM.muster;
  m._syncKopf();
  const steps = m._steps();
  const i = steps.indexOf(m._step);
  if (i <= 0) { m._abbrechen(); return; }
  m._step = steps[i - 1];
  m._render();
};

CRM.muster._weiter = function () {
  const m = CRM.muster;
  m._syncKopf();
  if (m._step === 'adresse') {
    if (!m._kopf.kunde.trim()) { CRM.toast('Bitte einen Kunden angeben.', 'error'); return; }
    if (!m._kopf.adresse.trim()) { CRM.toast('Bitte eine Lieferadresse wählen oder eintragen.', 'error'); return; }
    m._step = 'muster';
  } else if (m._step === 'muster') {
    // Pflichtprüfung schon hier: die Bestellkarte ist dadurch nie unvollständig.
    if (!m._pruefe(m._collect())) return;
    m._step = 'karte';
  }
  m._render();
};

/* ---------- Schritt 1: Kontakt ---------- */
CRM.muster._stepKontakt = function () {
  const m = CRM.muster;
  return {
    body: '<label style="margin-top:0">Für wen sind die Muster?</label>'
      + '<input id="mu-kq" placeholder="🔍 Firma, Ort oder PLZ suchen..." value="' + escAttr(m._kontaktQuery) + '" oninput="CRM.muster._kontaktSuche()" autocomplete="off">'
      + '<div id="mu-kres" style="margin-top:8px"></div>',
    footer: '<button class="btn" onclick="CRM.muster._abbrechen()">Abbrechen</button>',
    after: () => {
      m._kontaktSuche();
      const f = document.getElementById('mu-kq');
      if (f) { f.focus(); f.setSelectionRange(f.value.length, f.value.length); }
    },
  };
};

CRM.muster._kontaktSuche = function () {
  const el = document.getElementById('mu-kres');
  const inp = document.getElementById('mu-kq');
  if (!el || !inp) return;
  const q = inp.value.trim();
  CRM.muster._kontaktQuery = inp.value;
  if (!q) { el.innerHTML = '<p style="color:var(--text-dim);font-size:13px">Tippe einen Namen, Ort oder eine PLZ.</p>'; return; }
  const qn = CRM.searchNorm(q);
  const hits = CRM.db.getContacts()
    .filter((c) => !c.archived && CRM.contactQueryMatch(q, c))
    .sort((a, b) => CRM.contactSearchRank(qn, a) - CRM.contactSearchRank(qn, b)
      || String(a.firma1 || '').localeCompare(String(b.firma1 || '')))
    .slice(0, 8);
  el.innerHTML = hits.length
    ? hits.map((c) => '<div class="header-search-item" style="min-height:48px;display:flex;align-items:center;gap:6px;flex-wrap:wrap" onclick="CRM.muster._waehleKontakt(\'' + c.id + '\')">'
      + '<span class="badge badge-' + c.type + '">' + (CRM.TYPE_SHORT[c.type] || '–') + '</span>'
      + '<strong>' + esc2(CRM.displayNameDisambig(c)) + '</strong>'
      + '<span style="color:var(--text-dim);font-size:12px">' + esc2([c.plz, c.ort].filter(Boolean).join(' ')) + '</span></div>').join('')
    : '<div class="header-search-empty">Keine Treffer</div>';
};

CRM.muster._waehleKontakt = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  const m = CRM.muster;
  m._contactId = id;
  m._initFromContact(c);
  m._step = 'adresse';
  m._render();
};

/* ---------- Schritt 2: Lieferadresse ---------- */
CRM.muster._stepAdresse = function () {
  const m = CRM.muster;
  const c = CRM.db.getContact(m._contactId);
  const opts = c ? m._adressOptionen(c) : [{ key: 'frei', label: '✎ Andere Adresse', text: '' }];
  const kopf = m._kopf;
  const tiles = opts.map((o) => '<button class="mu-tile' + (m._adrQuelle === o.key ? ' active' : '') + '" onclick="CRM.muster._waehleAdresse(\'' + escAttr(o.key) + '\')">'
    + '<div style="font-weight:600">' + esc2(o.label) + '</div>'
    + (o.text ? '<div class="mu-tile-sub">' + esc2(o.text.replace(/\n/g, ', ')) + '</div>' : '<div class="mu-tile-sub">selbst eintragen</div>')
    + '</button>').join('');
  return {
    body: '<label style="margin-top:0">Wohin soll geliefert werden?</label>' + tiles
      + (m._adrQuelle === 'frei'
        ? '<label>Lieferadresse</label><textarea id="mu-adresse" rows="3" placeholder="Firma / Straße / PLZ Ort">' + esc2(kopf.adresse) + '</textarea>'
        : '')
      + '<div class="row" style="flex-wrap:wrap;gap:8px;margin-top:4px">'
      + '  <div class="col" style="min-width:200px"><label>Kunde</label><input id="mu-kunde" value="' + escAttr(kopf.kunde) + '"></div>'
      + '  <div class="col" style="max-width:150px"><label>Kunden-Nr.</label><input id="mu-knr" value="' + escAttr(kopf.knr) + '" placeholder="ERP-Nr."></div>'
      + '  <div class="col" style="min-width:180px"><label>Ansprechpartner</label><input id="mu-ap" value="' + escAttr(kopf.ap) + '" placeholder="Name"></div>'
      + '</div>'
      + '<label>Anlass / Bemerkung (optional)</label>'
      + '<input id="mu-anlass" value="' + escAttr(kopf.anlass) + '" placeholder="z.B. nach Besuch am ' + new Date().toLocaleDateString('de-DE') + ', bitte an Baustelle">',
    footer: '<button class="btn" onclick="CRM.muster._zurueck()">' + (m._skipKontakt ? 'Abbrechen' : '‹ Zurück') + '</button>'
      + '<button class="btn btn-primary" onclick="CRM.muster._weiter()">Weiter ›</button>',
  };
};

CRM.muster._waehleAdresse = function (key) {
  const m = CRM.muster;
  m._syncKopf(); // erst sichern, dann neu zeichnen — sonst gehen Eingaben verloren
  const c = CRM.db.getContact(m._contactId);
  const opt = c ? m._adressOptionen(c).find((o) => o.key === key) : null;
  m._adrQuelle = key;
  if (opt && key !== 'frei') m._kopf.adresse = opt.text;
  m._render();
};

/* ---------- Schritt 3: Muster (bestehende Artikelliste) ---------- */
CRM.muster._stepMuster = function () {
  const m = CRM.muster;
  return {
    body: '<p style="color:var(--text-dim);font-size:13px;margin-top:0">Bereich antippen zum Auf-/Zuklappen. Menge je Artikel setzen und <strong>Stück</strong> oder <strong>VE</strong> (Verpackungseinheit) wählen.</p>'
      + '<div class="row" style="align-items:center;gap:8px">'
      + '  <input id="mu-suche" placeholder="🔍 Artikel oder Art.-Nr. suchen..." style="flex:1" value="' + escAttr(m._suche) + '" oninput="CRM.muster._suche=this.value;CRM.muster.renderListe()">'
      + '  <button class="btn btn-sm" id="mu-favbtn" onclick="CRM.muster.toggleNurFav()">⭐ Nur meine</button>'
      + '</div>'
      + '<div id="mu-liste" style="max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-top:8px"></div>'
      + '<div id="mu-summe" style="font-size:13px;margin-top:8px;font-weight:600"></div>',
    footer: '<button class="btn" onclick="CRM.muster._zurueck()">‹ Zurück</button>'
      + '<button class="btn btn-primary" onclick="CRM.muster._weiter()">Weiter ›</button>',
    after: () => m.renderListe(),
  };
};

/* ---------- Schritt 4: Bestellkarte (Übersicht) ---------- */
CRM.muster._stepKarte = function () {
  const m = CRM.muster;
  const res = m._collect();
  const k = m._kopf;
  const lbl = (t) => '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim);margin:12px 0 4px">' + t + '</div>';
  const pos = res.positionen.map((p) => '<div style="padding:8px 0;border-bottom:1px solid var(--border)">'
    + '<div style="display:flex;justify-content:space-between;gap:10px;align-items:baseline">'
    + '<strong style="font-size:14px">' + esc2(p.it.name) + '</strong>'
    + '<span style="font-weight:700;white-space:nowrap">' + esc2(p.mengeText) + '</span></div>'
    + '<div style="font-size:11px;color:var(--text-dim)">Art.-Nr. ' + esc2(p.it.nr) + '</div>'
    + (p.ton ? '<div style="font-size:12px;margin-top:2px">🎨 ' + esc2(p.ton) + (p.tonNr ? ' <span style="color:var(--text-dim)">(Art.-Nr. ' + esc2(p.tonNr) + ')</span>' : '')
      + (p.stLabel ? '<br>Strukturzuschlag: ' + esc2(p.stLabel) : '') + '</div>' : '')
    + '</div>').join('');
  const stueck = Object.keys(m._mengen).reduce((s, nr) => s + m._stueckOf(nr), 0);
  return {
    body: '<div class="card" style="margin:0">'
      + '<div style="font-size:12px;color:var(--text-dim)">Bestellung an den Innendienst</div>'
      + '<div style="font-size:17px;font-weight:700;margin-top:2px">' + esc2(k.kunde) + '</div>'
      + (k.knr ? '<div style="font-size:13px;color:var(--text-dim)">Kd-Nr. ' + esc2(k.knr) + '</div>' : '')
      + (k.ap ? '<div style="font-size:13px;margin-top:2px">z.Hd. ' + esc2(k.ap) + '</div>' : '')
      + lbl('Lieferadresse · ' + esc2(m._adrLabel()))
      + '<div style="white-space:pre-line;font-size:14px">' + esc2(k.adresse.trim()) + '</div>'
      + (k.anlass.trim() ? lbl('Anlass / Bemerkung') + '<div style="font-size:14px">' + esc2(k.anlass.trim()) + '</div>' : '')
      + lbl('Positionen')
      + pos
      + '<div style="margin-top:10px;font-weight:700;color:var(--accent-2)">' + res.positionen.length + ' Position' + (res.positionen.length === 1 ? '' : 'en') + ' · ' + stueck + ' Stück gesamt</div>'
      + '</div>',
    footer: '<button class="btn" onclick="CRM.muster._zurueck()">‹ Ändern</button>'
      + '<button class="btn" onclick="CRM.muster.copy()">📋 Kopieren</button>'
      + '<button class="btn btn-primary" onclick="CRM.muster.send()">✉ Bestell-Mail öffnen</button>',
  };
};

CRM.muster.toggleNurFav = function () {
  CRM.muster._nurFav = !CRM.muster._nurFav;
  CRM.muster.renderListe();
};

CRM.muster.renderListe = function () {
  const el = document.getElementById('mu-liste');
  if (!el) return;
  const q = ((document.getElementById('mu-suche') || {}).value || '').trim().toLowerCase();
  const fav = CRM.muster.getFavoriten();
  const btn = document.getElementById('mu-favbtn');
  if (btn) btn.classList.toggle('btn-primary', !!CRM.muster._nurFav);

  let items = CRM.WERBEMITTEL || [];
  if (CRM.muster._nurFav && fav.length) items = items.filter((i) => fav.indexOf(i.nr) >= 0);
  if (q) items = items.filter((i) => (i.nr + ' ' + i.name + ' ' + i.desc).toLowerCase().indexOf(q) >= 0);

  if (!items.length) {
    el.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:12px">Keine Treffer.'
      + (CRM.muster._nurFav ? ' (Filter „⭐ Nur meine" ist aktiv)' : '') + '</p>';
    CRM.muster.updateSumme();
    return;
  }

  // Nach Kategorie gruppieren (Reihenfolge des Katalogs beibehalten)
  const kats = [];
  const byKat = {};
  items.forEach((it) => { if (!byKat[it.kat]) { byKat[it.kat] = []; kats.push(it.kat); } byKat[it.kat].push(it); });
  // Erststart: nur die erste Kategorie offen
  if (!CRM.muster._openKats) CRM.muster._openKats = new Set(kats.length ? [kats[0]] : []);
  const searching = !!q; // beim Suchen alles aufklappen, damit Treffer sichtbar sind

  let html = '';
  kats.forEach((kat) => {
    const open = searching || CRM.muster._openKats.has(kat);
    const gewaehlt = byKat[kat].filter((it) => CRM.muster._mengen[it.nr]).length;
    html += '<div onclick="CRM.muster.toggleKat(\'' + escAttr(kat) + '\')" style="display:flex;justify-content:space-between;align-items:center;background:var(--bg-elev2);padding:8px 10px;font-size:12px;font-weight:600;color:var(--text-dim);cursor:pointer;position:sticky;top:0;user-select:none">'
      + '<span>' + (open ? '▾' : '▸') + ' ' + esc2(kat) + '</span>'
      + (gewaehlt ? '<span style="color:var(--accent-2)">' + gewaehlt + ' gewählt</span>' : '')
      + '</div>';
    html += '<div style="' + (open ? '' : 'display:none') + '">';
    byKat[kat].forEach((it) => { html += CRM.muster._itemRowHtml(it, fav); });
    html += '</div>';
  });
  el.innerHTML = html;
  CRM.muster.updateSumme();
};

/* Eine Artikelzeile (Menge, Stück/VE-Umschalter, ggf. Farbton). */
CRM.muster._itemRowHtml = function (it, fav) {
  const menge = CRM.muster._mengen[it.nr] || 0;
  const isFav = (fav || CRM.muster.getFavoriten()).indexOf(it.nr) >= 0;
  const ve = it.ve || 1;
  const unit = (ve > 1 && CRM.muster._einheit[it.nr] === 've') ? 've' : 'stk';
  const nrEsc = escAttr(it.nr);
  let html = [
    '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);min-height:52px' + (menge ? ';background:rgba(30,142,80,.10)' : '') + '">',
    '  <button class="btn btn-sm" style="padding:4px 7px;' + (isFav ? 'color:var(--gold)' : 'opacity:.35') + '" title="Zu meiner Auswahl" onclick="CRM.muster.toggleFavorit(\'' + nrEsc + '\')">★</button>',
    '  <div style="flex:1;min-width:0">',
    '    <div style="font-size:13px;font-weight:600">' + esc2(it.name) + '</div>',
    '    <div style="font-size:11px;color:var(--text-dim)">' + esc2(it.nr) + (ve > 1 ? ' · 1 VE = ' + ve + ' Stück' : '') + (it.desc ? ' · ' + esc2(it.desc) : '') + '</div>',
    // Umschalter nur bei echten VE-Artikeln (VE > 1)
    ve > 1 ? ('    <div style="display:flex;gap:0;margin-top:5px">'
      + '<button class="btn btn-sm ' + (unit === 'stk' ? 'btn-primary' : '') + '" style="border-top-right-radius:0;border-bottom-right-radius:0" onclick="CRM.muster.setEinheit(\'' + nrEsc + '\',\'stk\')">Stück</button>'
      + '<button class="btn btn-sm ' + (unit === 've' ? 'btn-primary' : '') + '" style="border-top-left-radius:0;border-bottom-left-radius:0;margin-left:-1px" onclick="CRM.muster.setEinheit(\'' + nrEsc + '\',\'ve\')">VE</button>'
      + (menge && unit === 've' ? '<span style="align-self:center;margin-left:8px;font-size:11px;color:var(--accent-2)">= ' + (menge * ve) + ' Stück</span>' : '')
      + '</div>') : '',
    '  </div>',
    '  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">',
    '    <button class="btn btn-sm" style="min-width:36px;min-height:36px" onclick="CRM.muster.setMenge(\'' + nrEsc + '\',-1)">−</button>',
    '    <span style="min-width:44px;text-align:center;font-weight:700;font-size:14px">' + menge + '<span style="font-size:10px;color:var(--text-dim);display:block;font-weight:400">' + (unit === 've' ? 'VE' : 'Stk') + '</span></span>',
    '    <button class="btn btn-sm" style="min-width:36px;min-height:36px" onclick="CRM.muster.setMenge(\'' + nrEsc + '\',1)">+</button>',
    '  </div>',
    '</div>',
  ].join('');
  // YOSIMA-Beutel: Farbton ist Pflicht — Auswahlzeile direkt darunter
  if (menge && CRM.muster.brauchtFarbton(it.nr)) {
    const gew = CRM.muster._farbton[it.nr];
    const brauchtStruktur = CRM.YOSIMA_BEUTEL_ARTIKEL[it.nr].struktur;
    html += [
      '<div style="padding:8px 10px 10px 46px;border-bottom:1px solid var(--border);background:' + (gew ? 'rgba(30,142,80,.10)' : 'rgba(200,107,9,.12)') + '">',
      '  <div style="font-size:12px;margin-bottom:6px;' + (gew ? '' : 'color:var(--orange);font-weight:600') + '">',
      gew ? ('✓ Farbton: <strong>' + esc2(gew) + '</strong>') : ('⚠ Farbton' + (brauchtStruktur ? ' + Strukturzuschlag' : '') + ' erforderlich'),
      '  </div>',
      '  <button class="btn btn-sm" onclick="CRM.muster.openFarbwahl(\'' + nrEsc + '\')">🎨 ' + (gew ? 'Farbton ändern' : 'Farbton wählen') + '</button>',
      '</div>',
    ].join('');
  }
  return html;
};

CRM.muster.toggleKat = function (kat) {
  if (!CRM.muster._openKats) CRM.muster._openKats = new Set();
  if (CRM.muster._openKats.has(kat)) CRM.muster._openKats.delete(kat);
  else CRM.muster._openKats.add(kat);
  CRM.muster.renderListe();
};

CRM.muster.setEinheit = function (nr, u) {
  CRM.muster._einheit[nr] = u;
  CRM.muster.renderListe();
};

CRM.muster.setMenge = function (nr, delta) {
  const cur = CRM.muster._mengen[nr] || 0;
  const next = Math.max(0, Math.min(99, cur + delta));
  if (next === 0) delete CRM.muster._mengen[nr];
  else CRM.muster._mengen[nr] = next;
  CRM.muster.renderListe();
};

/* VE-Faktor eines Artikels (1, falls kein echter VE-Artikel). */
CRM.muster._veOf = function (nr) {
  const it = (CRM.WERBEMITTEL || []).find((x) => x.nr === nr);
  return (it && it.ve > 1) ? it.ve : 1;
};
/* Gesamt-Stückzahl eines Artikels je nach gewählter Einheit. */
CRM.muster._stueckOf = function (nr) {
  const m = CRM.muster._mengen[nr] || 0;
  const unit = CRM.muster._einheit[nr] === 've' ? 've' : 'stk';
  return unit === 've' ? m * CRM.muster._veOf(nr) : m;
};

CRM.muster.updateSumme = function () {
  const el = document.getElementById('mu-summe');
  if (!el) return;
  const nrs = Object.keys(CRM.muster._mengen);
  const stueck = nrs.reduce((s, nr) => s + CRM.muster._stueckOf(nr), 0);
  el.textContent = nrs.length
    ? nrs.length + ' Position' + (nrs.length === 1 ? '' : 'en') + ' · ' + stueck + ' Stück gesamt'
    : 'Noch nichts ausgewählt';
  el.style.color = nrs.length ? 'var(--accent-2)' : 'var(--text-dim)';
};

/* ---------- YOSIMA-Farbtonwahl (1022 Töne, durchsuchbar) ---------- */
CRM.muster.openFarbwahl = function (artikelNr) {
  CRM.muster._farbwahlFuer = artikelNr;
  const braucht = CRM.YOSIMA_BEUTEL_ARTIKEL[artikelNr];
  const strukturen = [];
  (CRM.YOSIMA_FARBTOENE || []).forEach((f) => {
    if (f.st && strukturen.indexOf(f.st) < 0) strukturen.push(f.st);
  });
  strukturen.sort();

  const lbl = (s) => (CRM.YOSIMA_STRUKTUR_LABELS || {})[s] || s;
  const strukturChips = braucht.struktur
    ? '<div class="quick-filters" style="margin:8px 0">'
      + strukturen.map((s) => '<button class="qf-btn" data-st="' + s + '" title="' + escAttr(lbl(s)) + '" onclick="CRM.muster.setStrukturFilter(\'' + s + '\')">' + s + ' · ' + esc2(lbl(s).split(' (')[0]) + '</button>').join('')
      + '</div>'
    : '';

  document.querySelector('#active-modal-overlay .modal').innerHTML = [
    '<h2>🎨 Farbton wählen</h2>',
    '<p style="color:var(--text-dim);font-size:13px">Bezeichnungen exakt wie in der ClayTec-Bestellliste.'
      + (braucht.struktur ? ' Für diesen Artikel ist ein <strong>Strukturzuschlag</strong> nötig — bitte einen der Kürzel-Filter wählen.' : '') + '</p>',
    strukturChips,
    '<input id="fw-suche" placeholder="🔍 Farbton suchen, z.B. GR 2 oder Weiss..." oninput="CRM.muster.renderFarbliste()" autocomplete="off">',
    '<div id="fw-liste" style="max-height:46vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-top:8px"></div>',
    '<div class="modal-footer">',
    '  <button class="btn" onclick="CRM.muster.closeFarbwahl()">Zurück ohne Auswahl</button>',
    '</div>',
  ].join('\n');
  CRM.muster._strukturFilter = braucht.struktur ? (strukturen[0] || '') : null;
  if (braucht.struktur) CRM.muster.setStrukturFilter(CRM.muster._strukturFilter);
  else CRM.muster.renderFarbliste();
  setTimeout(() => { const s = document.getElementById('fw-suche'); if (s) s.focus(); }, 60);
};

CRM.muster.setStrukturFilter = function (st) {
  CRM.muster._strukturFilter = st;
  document.querySelectorAll('#active-modal-overlay .qf-btn[data-st]').forEach((b) => {
    b.classList.toggle('active', b.dataset.st === st);
  });
  CRM.muster.renderFarbliste();
};

CRM.muster.renderFarbliste = function () {
  const el = document.getElementById('fw-liste');
  if (!el) return;
  const q = ((document.getElementById('fw-suche') || {}).value || '').trim().toLowerCase();
  const nurStruktur = CRM.muster._strukturFilter;

  let list = CRM.YOSIMA_FARBTOENE || [];
  // Ohne Struktur-Artikel: nur Grundtöne. Mit Struktur: nur das gewählte Kürzel.
  list = (nurStruktur === null) ? list.filter((f) => !f.st) : list.filter((f) => f.st === nurStruktur);
  if (q) list = list.filter((f) => (f.ton + ' ' + f.nr).toLowerCase().indexOf(q) >= 0);

  if (!list.length) { el.innerHTML = '<p style="color:var(--text-dim);font-size:13px;padding:12px">Kein Farbton gefunden.</p>'; return; }
  el.innerHTML = list.slice(0, 300).map((f) => [
    '<div class="header-search-item" style="min-height:44px;display:flex;align-items:center;justify-content:space-between;gap:8px"',
    ' onclick="CRM.muster.waehleFarbton(\'' + escAttr(f.ton) + '\',\'' + escAttr(f.nr) + '\')">',
    '<strong>' + esc2(f.ton) + '</strong>',
    '<span style="color:var(--text-dim);font-size:11px">' + esc2(f.nr) + '</span>',
    '</div>',
  ].join('')).join('')
    + (list.length > 300 ? '<p style="color:var(--text-dim);font-size:12px;padding:8px 12px">' + (list.length - 300) + ' weitere — bitte Suche verfeinern.</p>' : '');
};

CRM.muster.waehleFarbton = function (ton, nr) {
  CRM.muster._farbton[CRM.muster._farbwahlFuer] = ton;
  CRM.muster._farbtonNr = CRM.muster._farbtonNr || {};
  CRM.muster._farbtonNr[CRM.muster._farbwahlFuer] = nr;
  CRM.muster.closeFarbwahl();
};

/* Zurück aus der Farbtonwahl: Schritt "Muster" komplett aus dem Zustand neu
   zeichnen (Mengen/Farbtöne/Favoriten-Filter bleiben erhalten) — kein
   gemerktes HTML mehr, das veralten könnte. */
CRM.muster.closeFarbwahl = function () {
  CRM.muster._render();
};

/* Gewählte Artikel als strukturierte Liste (Reihenfolge des Katalogs) —
   Grundlage für Mailtext UND Bestellkarte, damit beide dasselbe zeigen. */
CRM.muster._positionen = function () {
  const out = [];
  (CRM.WERBEMITTEL || []).forEach((it) => {
    const m = CRM.muster._mengen[it.nr];
    if (!m) return;
    // Klartext je nach gewählter Einheit — eindeutig, ohne Misch-Hinweise:
    //   Stück:  „12 Stück"
    //   VE:     „2 VE (= 20 Stück)"
    const unit = (it.ve > 1 && CRM.muster._einheit[it.nr] === 've') ? 've' : 'stk';
    const mengeText = unit === 've'
      ? m + ' VE (= ' + (m * it.ve) + ' Stück)'
      : m + ' Stück';
    const p = { it, mengeText, braucht: CRM.muster.brauchtFarbton(it.nr), ton: '', tonNr: '', stLabel: '' };
    if (p.braucht) {
      const ton = CRM.muster._farbton[it.nr];
      if (ton) {
        p.ton = ton;
        p.tonNr = (CRM.muster._farbtonNr || {})[it.nr] || '';
        // Strukturzuschlag im Klartext ergänzen (Kürzel steht am Farbton-Ende)
        const stCode = (ton.match(/\b(ST|RS|FL|PE|JA|HE)$/) || [])[1];
        p.stLabel = stCode ? ((CRM.YOSIMA_STRUKTUR_LABELS || {})[stCode] || '') : '';
      }
    }
    out.push(p);
  });
  return out;
};

CRM.muster._collect = function () {
  const c = CRM.db.getContact(CRM.muster._contactId);
  const val = (key) => String((CRM.muster._kopf || {})[key] || '').trim();
  const kunde = val('kunde');
  const knr = val('knr');
  const apName = val('ap');
  const adresse = val('adresse');
  const anlass = val('anlass');

  const positionen = CRM.muster._positionen();
  const zeilen = [];
  const fehlendeFarbe = [];
  positionen.forEach((p) => {
    let zeile = '- ' + p.it.nr + '  ' + p.it.name + ': ' + p.mengeText;
    if (p.braucht) {
      if (!p.ton) fehlendeFarbe.push(p.it.name);
      else {
        zeile += '\n    Farbton: ' + p.ton + (p.tonNr ? '  (Art.-Nr. ' + p.tonNr + ')' : '');
        if (p.stLabel) zeile += '\n    Strukturzuschlag: ' + p.stLabel;
      }
    }
    zeilen.push(zeile);
  });

  const betreff = 'Werbemittelbestellung: ' + kunde + (knr ? ' (Kd-Nr. ' + knr + ')' : '');
  const teile = ['Hallo zusammen,', '', 'bitte folgende Werbemittel/Muster versenden:', ''];
  zeilen.forEach((z) => teile.push(z));
  teile.push('', 'Empfänger:', kunde + (knr ? '   (Kd-Nr. ' + knr + ')' : ''));
  if (apName) teile.push('z.Hd. ' + apName);
  if (adresse) teile.push(adresse);
  if (anlass) teile.push('', 'Anlass/Bemerkung: ' + anlass);
  teile.push('', 'Danke und Grüße');

  return { c, zeilen, positionen, fehlendeFarbe, betreff, body: teile.join('\n') };
};

/* Pflichtprüfung: YOSIMA-Beutel ohne Farbton darf nicht rausgehen
   („BITTE GEWÜNSCHTEN FARBTON ANGEBEN!" laut Bestellliste) */
CRM.muster._pruefe = function (res) {
  if (!res.zeilen.length) {
    CRM.toast('Bitte mindestens einen Artikel mit Stückzahl wählen.', 'error');
    return false;
  }
  if (res.fehlendeFarbe.length) {
    CRM.toast('⚠ Farbton fehlt bei: ' + res.fehlendeFarbe.join(', ') + ' — bitte „🎨 Farbton wählen" antippen.', 'error');
    return false;
  }
  return true;
};

CRM.muster._journal = function (c) {
  const txt = Object.keys(CRM.muster._mengen).map((nr) => {
    const it = (CRM.WERBEMITTEL || []).find((x) => x.nr === nr);
    const ton = CRM.muster._farbton[nr];
    const m = CRM.muster._mengen[nr];
    const unit = (it && it.ve > 1 && CRM.muster._einheit[nr] === 've') ? ' VE ' : '× ';
    return m + unit + (it ? it.name : nr) + (ton ? ' (' + ton + ')' : '');
  }).join(', ');
  // Geht die Sendung NICHT an die Firmenadresse (Baustelle/andere Adresse),
  // gehört das ins Journal — sonst weiß später niemand, wohin sie ging.
  let ziel = '';
  if (CRM.muster._adrQuelle !== 'firma') {
    const adr = String(CRM.muster._kopf.adresse || '').trim().replace(/\s*\n+\s*/g, ', ');
    if (adr) ziel = ' → ' + CRM.muster._adrLabel() + ': ' + adr;
  }
  // Feldnamen müssen zum Journal-Datenmodell passen (entryType/content) —
  // sonst wird der Eintrag zwar gespeichert, aber leer angezeigt.
  CRM.db.addJournalEntry({ contactId: c.id, entryType: 'muster', content: 'Werbemittel bestellt: ' + txt + ziel, inputMethod: 'muster' });
};

CRM.muster.send = function () {
  const res = CRM.muster._collect();
  if (!CRM.muster._pruefe(res)) return;
  const to = CRM.db.getSettings().musterEmail || 'auftrag@claytec.com';
  CRM.muster._journal(res.c);
  // Wurde der Versand aus einer Aufgabe heraus gestartet, gilt sie mit dem
  // Verschicken als erledigt.
  const taskId = CRM.muster._taskId;
  let taskInfo = '';
  if (taskId) {
    const t = CRM.db.getTask(taskId);
    if (t && !t.done) { CRM.db.updateTask(taskId, { done: true, doneAt: new Date().toISOString() }); taskInfo = ' Aufgabe erledigt.'; }
    CRM.muster._taskId = null;
  }
  CRM.closeModal();
  window.location.href = 'mailto:' + encodeURIComponent(to)
    + '?subject=' + encodeURIComponent(res.betreff)
    + '&body=' + encodeURIComponent(res.body);
  CRM.toast('✓ Bestell-Mail vorbereitet (' + res.zeilen.length + ' Positionen) — im Journal vermerkt.' + taskInfo, 'success');
  // betroffene Ansichten aktualisieren (Batch 8a: "Heute" ist Teil von
  // view-start, ein separater view-agenda-Check ist damit hinfällig)
  if (document.querySelector('#view-kontakte.active') && CRM.renderContactList) CRM.renderContactList();
  if (document.querySelector('#view-start.active') && CRM.renderDashboard) CRM.renderDashboard();
};

CRM.muster.copy = function () {
  const res = CRM.muster._collect();
  if (!CRM.muster._pruefe(res)) return;
  CRM._copyRichText('<pre>' + esc2(res.betreff) + '\n\n' + esc2(res.body) + '</pre>', res.betreff + '\n\n' + res.body)
    .then(() => {
      CRM.muster._journal(res.c);
      CRM.closeModal();
      CRM.toast('✓ Kopiert (' + res.zeilen.length + ' Positionen) — im Journal vermerkt.', 'success');
    })
    .catch(() => CRM.toast('Kopieren fehlgeschlagen.', 'error'));
};
