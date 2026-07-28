/* ============================================================
   Claytec CRM — Muster-/Prospekt-Lager (Inventar zu Hause)
   Bestand je Artikel aus der Werbemittelliste. Abgänge beim
   Kunden reduzieren den Bestand und werden dort als Aktivität
   vermerkt. Warnung, sobald Bestand <= Mindestbestand.
   Speicher: eigener localStorage-Key, getrennt von der (statischen)
   Werbemittelliste — nur aufgenommene Artikel haben einen Eintrag.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.lager = { KEY: 'crm_lager' };

CRM.lager.all = function () { return CRM.storage.read(CRM.lager.KEY, {}); };
CRM.lager.save = function (obj) { CRM.storage.write(CRM.lager.KEY, obj); };
CRM.lager.get = function (nr) { return CRM.lager.all()[nr] || null; };

CRM.lager._werbemittel = function (nr) {
  return (CRM.WERBEMITTEL || []).find((w) => w.nr === nr) || { nr: nr, name: nr, kat: '' };
};

/* Angereicherte, sortierte Artikelliste (knappe zuerst). */
CRM.lager.artikel = function () {
  const store = CRM.lager.all();
  return Object.keys(store).map((nr) => {
    const w = CRM.lager._werbemittel(nr);
    const e = store[nr];
    return { nr: nr, name: w.name, kat: w.kat, bestand: e.bestand || 0, mindest: e.mindest || 0 };
  }).sort((a, b) => {
    const ka = a.bestand <= a.mindest ? 0 : 1;
    const kb = b.bestand <= b.mindest ? 0 : 1;
    return ka - kb || String(a.name).localeCompare(String(b.name));
  });
};
CRM.lager.knapp = function () { return CRM.lager.artikel().filter((a) => a.bestand <= a.mindest); };

CRM.lager.add = function (nr, bestand, mindest) {
  const store = CRM.lager.all();
  store[nr] = { bestand: Math.max(0, bestand || 0), mindest: Math.max(0, mindest || 0) };
  CRM.lager.save(store);
};
CRM.lager.remove = function (nr) { const s = CRM.lager.all(); delete s[nr]; CRM.lager.save(s); };
CRM.lager.setMindest = function (nr, n) { const s = CRM.lager.all(); if (s[nr]) { s[nr].mindest = Math.max(0, n); CRM.lager.save(s); } };
CRM.lager.bump = function (nr, delta) { const s = CRM.lager.all(); if (s[nr]) { s[nr].bestand = Math.max(0, (s[nr].bestand || 0) + delta); CRM.lager.save(s); } };
CRM.lager.abgang = function (nr, menge) { const s = CRM.lager.all(); if (s[nr]) { s[nr].bestand = Math.max(0, (s[nr].bestand || 0) - menge); CRM.lager.save(s); } };

/* Kategorie → grobe Art (nur fürs Label). */
CRM.lager._artLabel = function (kat) {
  return /brosch|arbeitsbl|leitfaden|flyer|katalog|prospekt/i.test(kat || '') ? 'Prospekt' : 'Muster';
};

/* ---------- Übersicht (im „Mehr"-Menü) ---------- */
CRM.lager.openDialog = function () {
  const artikel = CRM.lager.artikel();
  const rows = artikel.map((a) => {
    const status = a.bestand <= a.mindest ? 'rot' : (a.bestand <= a.mindest * 2 ? 'gelb' : 'gruen');
    const farbe = status === 'rot' ? 'var(--red)' : (status === 'gelb' ? 'var(--orange)' : 'var(--green)');
    const max = Math.max(a.bestand, a.mindest * 3, 1);
    const pct = Math.min(100, Math.round((a.bestand / max) * 100));
    return `<div class="lager-row">
      <div class="lager-main">
        <div class="lager-name">${esc(a.name)}</div>
        <div class="lager-sub">${esc(CRM.lager._artLabel(a.kat))} · Mindestbestand
          <input type="number" min="0" value="${a.mindest}" class="lager-mindest" style="width:48px" onchange="CRM.lager.setMindest('${a.nr}',parseInt(this.value||0,10));CRM.lager.openDialog()"></div>
        <div class="lager-bar"><div style="width:${pct}%;background:${farbe}"></div></div>
      </div>
      <div class="lager-count" style="${status === 'rot' ? 'color:var(--red)' : ''}">${a.bestand}<span> Stk</span></div>
      <div class="lager-btns">
        <button class="btn btn-sm" title="einer weniger" onclick="CRM.lager.bump('${a.nr}',-1);CRM.lager.openDialog()">−</button>
        <button class="btn btn-sm" title="einer mehr" onclick="CRM.lager.bump('${a.nr}',1);CRM.lager.openDialog()">+</button>
        <button class="btn btn-sm" title="aus dem Lager entfernen" onclick="CRM.lager.remove('${a.nr}');CRM.lager.openDialog()">🗑</button>
      </div>
    </div>`;
  }).join('');

  const knapp = CRM.lager.knapp();
  CRM.openModal(`
    <h2 style="margin-top:0">📦 Muster-Lager</h2>
    <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px">Bestand zu Hause. Balken grün = genug, gelb = knapp, rot = nachbestellen. „+ / −" bucht Nachschub bzw. korrigiert.</p>
    ${knapp.length ? `<div class="card" style="background:rgba(255,159,67,.12);border-color:var(--orange);padding:8px 12px;margin-bottom:10px;display:flex;justify-content:space-between;align-items:center;gap:8px">
      <span style="font-size:13px">🔔 <strong>${knapp.length}</strong> Artikel am/unter Mindestbestand</span>
      <button class="btn btn-sm" onclick="CRM.lager.bestellMailKnapp()">✉ Nachbestellen</button>
    </div>` : ''}
    <div class="lager-list">${rows || '<p style="color:var(--text-dim);font-size:13px">Noch keine Artikel im Lager. Unten aufnehmen.</p>'}</div>
    <hr style="border-color:var(--border);margin:14px 0">
    <label>Artikel aufnehmen (aus Werbemitteln)</label>
    <div class="row" style="gap:6px;flex-wrap:wrap;align-items:flex-end;margin-top:6px">
      <div class="col" style="min-width:200px;flex:2"><select id="lager-add-nr">${(CRM.WERBEMITTEL || []).filter((w) => !CRM.lager.get(w.nr)).map((w) => `<option value="${w.nr}">${esc(w.name)}</option>`).join('')}</select></div>
      <div class="col" style="max-width:90px"><label style="font-size:11px">Bestand</label><input type="number" id="lager-add-bestand" min="0" value="10"></div>
      <div class="col" style="max-width:90px"><label style="font-size:11px">Mindest</label><input type="number" id="lager-add-mindest" min="0" value="4"></div>
      <button class="btn btn-primary btn-sm" style="min-height:40px" onclick="CRM.lager.addFromDialog()">+ Aufnehmen</button>
    </div>
    <div class="modal-footer"><button class="btn btn-primary" onclick="CRM.closeModal()">Fertig</button></div>
  `);
};

CRM.lager.addFromDialog = function () {
  const nr = (document.getElementById('lager-add-nr') || {}).value;
  if (!nr) { CRM.toast('Kein Artikel wählbar — alle sind schon im Lager.', 'error'); return; }
  const bestand = parseInt((document.getElementById('lager-add-bestand') || {}).value || '0', 10);
  const mindest = parseInt((document.getElementById('lager-add-mindest') || {}).value || '0', 10);
  CRM.lager.add(nr, bestand, mindest);
  CRM.lager.openDialog();
};

/* Bestell-Mail für alle knappen Artikel (Auffüllen auf ~3× Mindestbestand). */
CRM.lager.bestellMailKnapp = function () {
  const knapp = CRM.lager.knapp();
  if (!knapp.length) { CRM.toast('Nichts unter Mindestbestand.', 'success'); return; }
  const to = CRM.db.getSettings().musterEmail || 'auftrag@claytec.com';
  const zeilen = knapp.map((a) => {
    const nachbestellen = Math.max(a.mindest * 3 - a.bestand, a.mindest);
    return `- ${nachbestellen}× ${a.name} (Art.-Nr. ${a.nr})`;
  });
  const betreff = 'Nachbestellung Muster/Prospekte — Lager Chris Kurz';
  const body = 'Bitte folgende Muster/Prospekte nachliefern:\n\n' + zeilen.join('\n') + '\n\nDanke!';
  window.location.href = 'mailto:' + encodeURIComponent(to) + '?subject=' + encodeURIComponent(betreff) + '&body=' + encodeURIComponent(body);
  CRM.toast('✉ Nachbestell-Mail vorbereitet (' + knapp.length + ' Artikel).', 'success');
};

/* ---------- „Muster dagelassen" beim Kunden ---------- */
CRM.lager.openDagelassen = function (contactId) {
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  const artikel = CRM.lager.artikel();
  if (!artikel.length) { CRM.toast('Noch keine Artikel im Lager — erst im Mehr-Menü „📦 Muster-Lager" anlegen.', 'error'); return; }
  const rows = artikel.map((a) => `
    <label class="dagelassen-row">
      <input type="checkbox" class="dg-check" data-nr="${a.nr}" data-name="${escAttr(a.name)}" style="width:auto">
      <span class="dg-name">${esc(a.name)} <span style="color:var(--text-dim);font-size:11px">(${a.bestand} da)</span></span>
      <input type="number" class="dg-menge" data-nr="${a.nr}" min="1" value="1" style="width:52px">
    </label>`).join('');
  CRM.openModal(`
    <h2 style="margin-top:0">📦 Muster dagelassen — ${esc(c.firma1)}</h2>
    <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px">Ankreuzen, Menge setzen — das Lager zählt automatisch runter und der Vorgang wird als Aktivität beim Kunden vermerkt.</p>
    <div class="dagelassen-list">${rows}</div>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.renderContactDetailModal('${contactId}')">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.lager.saveDagelassen('${contactId}')">✓ Dagelassen speichern</button>
    </div>
  `, { dismissible: false });
};

CRM.lager.saveDagelassen = function (contactId) {
  const checks = Array.prototype.slice.call(document.querySelectorAll('.dg-check:checked'));
  if (!checks.length) { CRM.toast('Bitte mindestens ein Muster ankreuzen.', 'error'); return; }
  const teile = [];
  checks.forEach((cb) => {
    const nr = cb.dataset.nr;
    const mengeEl = document.querySelector('.dg-menge[data-nr="' + nr + '"]');
    const menge = Math.max(1, parseInt((mengeEl || {}).value || '1', 10));
    CRM.lager.abgang(nr, menge);
    teile.push(menge + '× ' + cb.dataset.name);
  });
  CRM.db.addJournalEntry({ contactId: contactId, entryType: 'muster', content: 'Muster dagelassen: ' + teile.join(', '), inputMethod: 'lager' });
  CRM.renderContactDetailModal(contactId);
  CRM.toast('✓ ' + teile.length + ' Muster verbucht — Lager aktualisiert.', 'success');
};
