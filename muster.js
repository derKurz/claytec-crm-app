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

CRM.muster.open = function (contactId) {
  CRM.muster._contactId = contactId;
  CRM.muster._mengen = {};
  CRM.muster._farbton = {};
  const c = CRM.db.getContact(contactId);
  if (!c) return;
  const ap = c.ansprechpartner || {};
  const apName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  const adresse = [c.strasse, [c.plz, c.ort].filter(Boolean).join(' ')].filter(Boolean).join('\n');

  CRM.openModal([
    '<h2>📦 Muster / Werbemittel schicken</h2>',
    '<p style="color:var(--text-dim);font-size:13px">Stückzahl je Artikel setzen — auch weniger als eine ganze Verpackungseinheit ist möglich.</p>',
    '<div class="row" style="flex-wrap:wrap;gap:8px">',
    '  <div class="col" style="min-width:200px"><label>Kunde</label><input id="mu-kunde" value="' + escAttr(c.firma1) + '"></div>',
    '  <div class="col" style="max-width:150px"><label>Kunden-Nr.</label><input id="mu-knr" value="' + escAttr(c.erpNr || '') + '" placeholder="ERP-Nr."></div>',
    '  <div class="col" style="min-width:180px"><label>Ansprechpartner</label><input id="mu-ap" value="' + escAttr(apName) + '" placeholder="Name"></div>',
    '</div>',
    '<label style="margin-top:8px">Lieferanschrift</label>',
    '<textarea id="mu-adresse" rows="3">' + esc2(adresse) + '</textarea>',
    '<label style="margin-top:8px">Anlass / Bemerkung (optional)</label>',
    '<input id="mu-anlass" placeholder="z.B. nach Besuch am ' + new Date().toLocaleDateString('de-DE') + ', bitte an Baustelle">',
    '<div class="row" style="margin-top:12px;align-items:center;gap:8px">',
    '  <input id="mu-suche" placeholder="🔍 Artikel oder Art.-Nr. suchen..." style="flex:1" oninput="CRM.muster.renderListe()">',
    '  <button class="btn btn-sm" id="mu-favbtn" onclick="CRM.muster.toggleNurFav()">⭐ Nur meine</button>',
    '</div>',
    '<div id="mu-liste" style="max-height:40vh;overflow-y:auto;border:1px solid var(--border);border-radius:8px;margin-top:8px"></div>',
    '<div id="mu-summe" style="font-size:13px;margin-top:8px;font-weight:600"></div>',
    '<div class="modal-footer">',
    '  <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>',
    '  <button class="btn" onclick="CRM.muster.copy()">📋 Kopieren</button>',
    '  <button class="btn btn-primary" onclick="CRM.muster.send()">✉ Bestell-Mail öffnen</button>',
    '</div>',
  ].join('\n'), { dismissible: false });

  // Startet mit der eigenen Auswahl, sobald welche gepflegt ist
  CRM.muster._nurFav = CRM.muster.getFavoriten().length > 0;
  CRM.muster.renderListe();
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

  let html = '';
  let lastKat = null;
  items.forEach((it) => {
    if (it.kat !== lastKat) {
      lastKat = it.kat;
      html += '<div style="background:var(--bg-elev2);padding:6px 10px;font-size:12px;font-weight:600;color:var(--text-dim)">' + esc2(it.kat) + '</div>';
    }
    const menge = CRM.muster._mengen[it.nr] || 0;
    const isFav = fav.indexOf(it.nr) >= 0;
    html += [
      '<div style="display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--border);min-height:52px' + (menge ? ';background:rgba(30,142,80,.10)' : '') + '">',
      '  <button class="btn btn-sm" style="padding:4px 7px;' + (isFav ? 'color:var(--gold)' : 'opacity:.35') + '" title="Zu meiner Auswahl" onclick="CRM.muster.toggleFavorit(\'' + escAttr(it.nr) + '\')">★</button>',
      '  <div style="flex:1;min-width:0">',
      '    <div style="font-size:13px;font-weight:600">' + esc2(it.name) + '</div>',
      '    <div style="font-size:11px;color:var(--text-dim)">' + esc2(it.nr) + (it.ve > 1 ? ' · VE ' + it.ve + ' Stk' : '') + (it.desc ? ' · ' + esc2(it.desc) : '') + '</div>',
      '  </div>',
      '  <div style="display:flex;align-items:center;gap:4px;flex-shrink:0">',
      '    <button class="btn btn-sm" style="min-width:36px;min-height:36px" onclick="CRM.muster.setMenge(\'' + escAttr(it.nr) + '\',-1)">−</button>',
      '    <span style="min-width:26px;text-align:center;font-weight:700;font-size:14px">' + menge + '</span>',
      '    <button class="btn btn-sm" style="min-width:36px;min-height:36px" onclick="CRM.muster.setMenge(\'' + escAttr(it.nr) + '\',1)">+</button>',
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
        '  <button class="btn btn-sm" onclick="CRM.muster.openFarbwahl(\'' + escAttr(it.nr) + '\')">🎨 ' + (gew ? 'Farbton ändern' : 'Farbton wählen') + '</button>',
        '</div>',
      ].join('');
    }
  });
  el.innerHTML = html;
  CRM.muster.updateSumme();
};

CRM.muster.setMenge = function (nr, delta) {
  const cur = CRM.muster._mengen[nr] || 0;
  const next = Math.max(0, Math.min(99, cur + delta));
  if (next === 0) delete CRM.muster._mengen[nr];
  else CRM.muster._mengen[nr] = next;
  CRM.muster.renderListe();
};

CRM.muster.updateSumme = function () {
  const el = document.getElementById('mu-summe');
  if (!el) return;
  const nrs = Object.keys(CRM.muster._mengen);
  const stueck = nrs.reduce((s, nr) => s + CRM.muster._mengen[nr], 0);
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

  CRM._musterModalBackup = document.querySelector('#active-modal-overlay .modal').innerHTML;
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

CRM.muster.closeFarbwahl = function () {
  document.querySelector('#active-modal-overlay .modal').innerHTML = CRM._musterModalBackup;
  CRM.muster.renderListe();
};

CRM.muster._collect = function () {
  const c = CRM.db.getContact(CRM.muster._contactId);
  const val = (id) => ((document.getElementById(id) || {}).value || '').trim();
  const kunde = val('mu-kunde');
  const knr = val('mu-knr');
  const apName = val('mu-ap');
  const adresse = val('mu-adresse');
  const anlass = val('mu-anlass');

  const zeilen = [];
  const fehlendeFarbe = [];
  (CRM.WERBEMITTEL || []).forEach((it) => {
    const m = CRM.muster._mengen[it.nr];
    if (!m) return;
    // Bei VE > 1 ausdrücklich klarstellen, dass NUR Teilmenge gewünscht ist
    const veHinweis = it.ve > 1 ? ' (VE ' + it.ve + ' Stk — bitte nur ' + m + ' Stk)' : '';
    let zeile = '- ' + it.nr + '  ' + it.name + ': ' + m + ' Stück' + veHinweis;
    if (CRM.muster.brauchtFarbton(it.nr)) {
      const ton = CRM.muster._farbton[it.nr];
      if (!ton) fehlendeFarbe.push(it.name);
      else {
        const tonNr = (CRM.muster._farbtonNr || {})[it.nr];
        // Strukturzuschlag im Klartext ergänzen (Kürzel steht am Farbton-Ende)
        const stCode = (ton.match(/\b(ST|RS|FL|PE|JA|HE)$/) || [])[1];
        const stLabel = stCode ? (CRM.YOSIMA_STRUKTUR_LABELS || {})[stCode] : '';
        zeile += '\n    Farbton: ' + ton + (tonNr ? '  (Art.-Nr. ' + tonNr + ')' : '');
        if (stLabel) zeile += '\n    Strukturzuschlag: ' + stLabel;
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

  return { c, zeilen, fehlendeFarbe, betreff, body: teile.join('\n') };
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
    return CRM.muster._mengen[nr] + '× ' + (it ? it.name : nr) + (ton ? ' (' + ton + ')' : '');
  }).join(', ');
  // Feldnamen müssen zum Journal-Datenmodell passen (entryType/content) —
  // sonst wird der Eintrag zwar gespeichert, aber leer angezeigt.
  CRM.db.addJournalEntry({ contactId: c.id, entryType: 'muster', content: 'Werbemittel bestellt: ' + txt, inputMethod: 'muster' });
};

CRM.muster.send = function () {
  const res = CRM.muster._collect();
  if (!CRM.muster._pruefe(res)) return;
  const to = CRM.db.getSettings().musterEmail || '';
  CRM.muster._journal(res.c);
  CRM.closeModal();
  window.location.href = 'mailto:' + encodeURIComponent(to)
    + '?subject=' + encodeURIComponent(res.betreff)
    + '&body=' + encodeURIComponent(res.body);
  CRM.toast('✓ Bestell-Mail vorbereitet (' + res.zeilen.length + ' Positionen) — im Journal vermerkt.', 'success');
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
