/* ============================================================
   Claytec CRM — Einstellungen
   Schritt 7: Sprach-Engine + Whisper-Key.
   (Besuchsintervalle & Daten-Reset werden in Schritt 13 ergänzt.)
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.renderSettings = function () {
  const s = CRM.db.getSettings();
  const container = document.getElementById('view-einstellungen');
  const webOk = CRM.speech && CRM.speech.webSpeechAvailable();

  container.innerHTML = `
    <h2 style="margin-top:0">Einstellungen</h2>

    <div class="card">
      <h3 style="margin-top:0">🎨 Design</h3>
      <label>Farbschema</label>
      <select id="set-theme" style="max-width:200px" onchange="CRM.saveTheme()">
        <option value="hell" ${(s.theme || 'hell') === 'hell' ? 'selected' : ''}>☀️ Hell</option>
        <option value="dunkel" ${s.theme === 'dunkel' ? 'selected' : ''}>🌙 Dunkel</option>
      </select>
    </div>

    <div class="card">
      <h3 style="margin-top:0">🤖 Antwort vorbereiten</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Steuert, welche Daten der „🤖 Antwort vorbereiten"-Block enthält, den du in Claude Code einfügst.</p>
      <label style="display:flex;align-items:center;gap:8px;color:var(--text);min-height:44px">
        <input type="checkbox" id="set-antwort-sparsam" style="width:auto" ${s.antwortDatensparsam !== false ? 'checked' : ''} onchange="CRM.saveAntwortSetting()">
        <span>🔒 Datensparsam (empfohlen)</span>
      </label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 0">
        Aktiv: <strong>Firma und Projekt bleiben als Referenz</strong> erhalten — Klarnamen, Telefon, Mailadressen und Straße werden entfernt.<br>
        Inaktiv: alle Kontaktdaten werden mitgegeben.
      </p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">📦 Musterversand</h3>
      <label>Empfänger der Bestell-Mail (Standard: auftrag@claytec.com)</label>
      <input id="set-muster-mail" value="${escAttr(s.musterEmail || '')}" placeholder="auftrag@claytec.com" style="max-width:320px">
      <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="CRM.saveMusterSettings()">Speichern</button>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Artikelkatalog</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">
        ${(CRM.WERBEMITTEL || []).length} Artikel aus der ClayTec-Werbemittelbestellliste (Stand 06/2026) sind hinterlegt —
        Auswahl und Stückzahl setzt du direkt beim „📦 Muster schicken"-Button im Kontaktprofil.
        Deine Favoriten (★) erscheinen dort vorgefiltert.
      </p>
      <p style="font-size:13px;margin:0">⭐ Als meine Auswahl markiert: <strong>${((s.musterFavoriten || []).length)}</strong> Artikel
        ${((s.musterFavoriten || []).length) ? `<button class="btn btn-sm" style="margin-left:8px" onclick="CRM.db.saveSettings({musterFavoriten:[]});CRM.renderSettings();CRM.toast('Favoriten zurückgesetzt.','success')">Zurücksetzen</button>` : ''}</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Außendienst & Excel-Ablage</h3>
      <label>AD-Kürzel (Spalte „AD Kürzel" im Besuchsprotokoll)</label>
      <input id="set-ad-kuerzel" value="${escAttr(s.adKuerzel || 'CK')}" placeholder="z.B. CK" style="max-width:120px">
      <button class="btn btn-primary btn-sm" style="margin-left:8px" onclick="CRM.saveAdKuerzel()">Speichern</button>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Claytec-Ordner (für die automatische Excel-Ablage)</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">
        ${CRM.ablage && CRM.ablage.supported()
          ? 'Wähle einmalig deinen <strong>Claytec</strong>-Ordner (enthält <code>.Kunden</code> und <code>Berichte - Reisekosten - Spesen</code>). Nur Chrome/Edge am Laptop.'
          : '⚠️ Dieser Browser unterstützt keinen direkten Ordnerzugriff. Nutze Chrome oder Edge am Laptop.'}
      </p>
      ${CRM.ablage && CRM.ablage.supported() ? `
      <div style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:12px;color:var(--text-dim)">
        <strong>OneDrive statt Google Drive im Dialog?</strong> Der Windows-Dialog zeigt zuerst den zuletzt benutzten Ort.
        Oben in die <strong>Adressleiste</strong> des Dialogs den OneDrive-Pfad einfügen und Enter drücken — dann bist du direkt am richtigen Ort.
        ${s.onedrivePath ? `<div style="margin-top:6px">Dein hinterlegter Pfad (zum Kopieren):
          <code id="ablage-copy-path" style="user-select:all;cursor:pointer" title="Klicken kopiert den Pfad" onclick="CRM.copyOnedrivePath()">${esc(s.onedrivePath)}</code></div>`
          : `<div style="margin-top:6px">Tipp: Trag deinen OneDrive-Pfad weiter unten unter „Pfad des Claytec-Ordners" ein — dann steht er hier zum Kopieren bereit.</div>`}
      </div>` : ''}
      <button class="btn btn-sm" ${CRM.ablage && CRM.ablage.supported() ? '' : 'disabled'} onclick="CRM.ablage.connectRoot()">📁 Claytec-Ordner verbinden</button>
      <span id="ablage-root-status" style="font-size:12px;color:var(--text-dim);margin-left:8px">${CRM.ablage && CRM.ablage.rootHandle ? '✓ verbunden: ' + esc(CRM.ablage.rootHandle.name) : 'noch nicht verbunden'}</span>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Handy-Eingang verarbeiten</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Liest Besuche/Kontakte, die du am Handy über „📤 Eingang exportieren" (Mehr-Menü) in den OneDrive-Ordner <code>Eingang</code> geteilt hast, übernimmt sie hier und legt neue Besuche automatisch in Excel ab. Läuft auch automatisch im Hintergrund, wenn du die App öffnest.</p>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Liegt dein <code>Eingang</code>-Ordner an einem <strong>anderen</strong> Ort als der Claytec-Ordner (z.B. <code>…\\Claytec CRM\\Eingang</code>)? Dann wähle ihn hier einmalig direkt aus — sonst wird automatisch der Unterordner <code>Eingang</code> im Claytec-Ordner benutzt.</p>
      <button class="btn btn-sm" ${CRM.ablage && CRM.ablage.supported() ? '' : 'disabled'} onclick="CRM.ablage.connectEingang()">📁 Eingang-Ordner wählen</button>
      <span id="ablage-eingang-status" style="font-size:12px;color:var(--text-dim);margin-left:8px">${CRM.ablage && CRM.ablage.eingangHandle ? '✓ eigener Ordner: ' + esc(CRM.ablage.eingangHandle.name) + ' <a href="#" onclick="CRM.ablage.clearEingang();return false" style="margin-left:6px;color:var(--text-dim)">(entfernen)</a>' : 'Standard: „Eingang" im Claytec-Ordner'}</span>
      <div style="margin-top:8px"><button class="btn btn-sm" ${CRM.ablage && CRM.ablage.supported() ? '' : 'disabled'} onclick="CRM.ablage.processEingang(false)">📥 Eingang jetzt verarbeiten</button></div>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Notion-Feierabend-Notizen</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Bündelt Besuche, Notizen und neue Aufgaben je Kontakt mit hinterlegtem Notion-Link zu einem kopierfertigen Block. Den bei Claude einfügen: „übertrage die Feierabend-Notizen nach Notion" — Claude schreibt sie über den Notion-Konnektor in die Seiten. (Kein Notion-Zugriff aus der App selbst — die App ist öffentlich gehostet.)</p>
      <button class="btn btn-sm" onclick="CRM.notion.openDialog()">📓 Notion-Block erzeugen</button>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Pfad des Claytec-Ordners (für „Ordner öffnen"-Buttons nach der Ablage)</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Der Browser gibt aus Sicherheitsgründen keine echten Dateipfade heraus — trag den vollen Pfad einmalig hier ein, z.B. <code>C:\\Users\\Name\\OneDrive - Claytec GmbH + Co. KG\\Claytec</code></p>
      <input id="set-onedrive-path" value="${escAttr(s.onedrivePath || '')}" placeholder="C:\\Users\\...\\OneDrive - Claytec GmbH + Co. KG\\Claytec">
      <button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="CRM.saveOnedrivePath()">Speichern</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">🏠 Zuhause (Start/Ziel für Routen)</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Deine Wohnort-Adresse — damit du Routen „ab Zuhause" starten und „zurück nach Hause" enden lassen kannst. Bleibt nur lokal auf diesem Gerät.</p>
      <label>Adresse (Straße Nr., PLZ Ort)</label>
      <input id="set-home-adresse" value="${escAttr((s.home && s.home.adresse) || '')}" placeholder="z.B. Musterstraße 1, 92224 Amberg">
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn btn-primary btn-sm" onclick="CRM.saveHome()">Speichern</button>
        <button class="btn btn-sm" onclick="CRM.geocodeHome()">📍 Auf Karte prüfen (geocodieren)</button>
      </div>
      <p id="home-status" style="font-size:12px;color:var(--text-dim);margin:8px 0 0">${(s.home && s.home.lat != null) ? '✓ verortet (' + s.home.lat.toFixed(4) + ', ' + s.home.lng.toFixed(4) + ')' : (s.home && s.home.adresse ? 'noch nicht geocodiert — „Auf Karte prüfen" antippen' : 'noch nicht hinterlegt')}</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Supabase (Cloud-Sync, Phase 3 — erster Schritt)</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">Noch keine echte Synchronisation — nur Verbindung herstellen und testen (siehe OFFLINE_SYNC.md). Nur den <strong>Veröffentlichungsschlüssel</strong> („anon"/"public") eintragen, niemals den geheimen/<code>service_role</code>-Key.</p>
      <label>Project URL</label>
      <input id="set-supabase-url" value="${escAttr(s.supabaseUrl || '')}" placeholder="https://xxxxx.supabase.co">
      <label style="margin-top:8px">Veröffentlichungsschlüssel (Publishable/anon Key)</label>
      <input id="set-supabase-key" value="${escAttr(s.supabasePublishableKey || '')}" placeholder="sb_publishable_...">
      <div class="row" style="gap:8px;margin-top:8px">
        <button class="btn btn-primary btn-sm" onclick="CRM.saveSupabaseConfig()">Speichern</button>
        <button class="btn btn-sm" onclick="CRM.testSupabaseConnection()">🔌 Verbindung testen</button>
      </div>
      <hr style="border-color:var(--border);margin:14px 0">
      <label>Anmeldung (nur für Cloud-Sync nötig — App funktioniert auch ohne)</label>
      <p style="font-size:13px;margin:6px 0">
        ${CRM.supabaseUser
          ? `✅ Angemeldet als <strong>${esc(CRM.supabaseUser.email)}</strong>`
          : '⚪ Nicht angemeldet'}
      </p>
      ${CRM.supabaseUser
        ? '<button class="btn btn-sm" onclick="CRM.supabaseSignOut()">Abmelden</button>'
        : '<button class="btn btn-sm" onclick="CRM.openSupabaseLoginModal()">🔐 Anmelden</button>'}
      <p style="color:var(--text-dim);font-size:12px;margin-top:8px">Ersten Zugang legst du im Supabase-Dashboard an: <strong>Authentication → Users → Add user</strong> (E-Mail + Passwort direkt vergeben, keine Bestätigungsmail nötig).</p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Sprachsteuerung</h3>
      <label>Engine</label>
      <select id="set-speech-engine">
        <option value="webspeech" ${s.speechEngine === 'webspeech' ? 'selected' : ''}>Web Speech API (kostenlos, de-DE)</option>
        <option value="whisper" ${s.speechEngine === 'whisper' ? 'selected' : ''}>Whisper API (OpenAI, genauer)</option>
      </select>
      <p style="color:var(--text-dim);font-size:12px;margin:6px 0">
        Web Speech: ${webOk ? '✓ in diesem Browser verfügbar' : '⚠️ in diesem Browser nicht verfügbar (Chrome/Edge empfohlen)'}.
        Whisper braucht einen OpenAI-API-Key und sendet Audio an OpenAI.
      </p>
      <label style="margin-top:10px">Whisper API-Key (OpenAI)</label>
      <div class="row">
        <input type="password" id="set-whisper-key" value="${escAttr(s.whisperApiKey || '')}" placeholder="sk-..." style="flex:1">
        <button class="btn btn-sm" onclick="CRM.toggleKeyVisibility()">👁</button>
      </div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="CRM.saveSpeechSettings()">Speichern</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Besuchsintervalle</h3>
      <p style="color:var(--text-dim);font-size:12px;margin:0 0 10px">Tage bis zum nächsten fälligen Besuch, je nach A/B/C-Einstufung. Steuert „Heute"-Ansicht, Kalender und Status-Badges.</p>
      <div class="row">
        <div class="col" style="max-width:140px"><label>A-Kunden (Tage)</label><input type="number" min="1" id="set-interval-A" value="${s.intervals.A}"></div>
        <div class="col" style="max-width:140px"><label>B-Kunden (Tage)</label><input type="number" min="1" id="set-interval-B" value="${s.intervals.B}"></div>
        <div class="col" style="max-width:140px"><label>C-Kunden (Tage)</label><input type="number" min="1" id="set-interval-C" value="${s.intervals.C}"></div>
      </div>
      <button class="btn btn-primary" style="margin-top:10px" onclick="CRM.saveIntervals()">Intervalle speichern</button>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Datenschutz-Hinweis</h3>
      <p style="color:var(--text-dim);font-size:13px;margin:0">
        Alle Kontaktdaten bleiben lokal im Browser (LocalStorage) — kein Upload. Externe Anfragen nur:
        Geocoding an Nominatim (nur Adressdaten, keine Namen), PLZ-Ort-Suche an zippopotam.us (nur die PLZ), — falls aktiviert — Whisper-Transkription an OpenAI,
        und — falls eingerichtet — Supabase (eigenes Cloud-Projekt, aktuell nur Verbindungstest/Anmeldung, noch kein Daten-Upload).
        LocalStorage kann durch Browser-Reset verloren gehen — regelmäßig Backup sichern.
      </p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Datensicherung</h3>
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px">
        Letztes Backup: <strong>${s.lastBackupAt ? new Date(s.lastBackupAt).toLocaleString('de-DE') : 'noch nie'}</strong>.
        Das JSON-Backup enthält <em>alles</em> (Kontakte, Notizen, Besuche, Koordinaten, Verknüpfungen, Projekte, E-Mails, Kontaktjournal) und dient auch dem Sync zwischen PC und Handy.
      </p>
      <div class="row" style="flex-wrap:wrap;gap:8px">
        <button class="btn btn-primary btn-sm" onclick="CRM.backup.exportJSON().then(()=>CRM.renderSettings())">💾 JSON-Backup exportieren</button>
        <button class="btn btn-sm" onclick="document.getElementById('btn-backup-import').click()">📂 JSON wiederherstellen</button>
        <button class="btn btn-sm" onclick="CRM.exportExcelFromSettings()">📊 Excel-Export (mit Notizen & Historie)</button>
      </div>
      <hr style="border-color:var(--border);margin:12px 0">
      <label>Backup-Zielordner (direkt speichern statt Download)</label>
      <p style="color:var(--text-dim);font-size:12px;margin:4px 0 8px">
        ${CRM.ablage && CRM.ablage.supported()
          ? 'Einmalig deinen Backup-Ordner verbinden (z.B. <code>…\\Claytec\\KI\\Claytec CRM</code>). Danach schreibt „💾 Backup" direkt dorthin, ohne Speichern-Dialog. Nur Chrome/Edge am Laptop.'
          : '📱 Am Handy öffnet „💾 Backup" den Teilen-Dialog — dort <strong>Google Drive</strong>, OneDrive oder Mail als Ziel wählen.'}
      </p>
      <button class="btn btn-sm" ${CRM.ablage && CRM.ablage.supported() ? '' : 'disabled'} onclick="CRM.backup.connectFolder()">📁 Backup-Ordner verbinden</button>
      <span style="font-size:12px;color:var(--text-dim);margin-left:8px">${s.backupFolderName ? '✓ verbunden: ' + esc(s.backupFolderName) : 'noch nicht verbunden (Download)'}</span>
      <p style="color:var(--orange);font-size:12px;margin:10px 0 0">
        ⚠️ LocalStorage kann durch Browser-Reset/Cache-Löschen verloren gehen — sichere regelmäßig ein JSON-Backup!
      </p>
    </div>

    <div class="card">
      <h3 style="margin-top:0">Duplikate zusammenführen</h3>
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px">
        Findet Kontakte, die wahrscheinlich doppelt sind (z.B. aus zwei verschiedenen Import-Listen) — gleicher Firmenname (auch bei Schreibvarianten) und gleiche PLZ. Du wählst danach, welcher Eintrag bleibt; Besuche, Aufgaben, Notizen und Verknüpfungen werden übernommen.
      </p>
      <button class="btn btn-sm" onclick="CRM.renderDuplicatesPanel()">🔍 Duplikate suchen</button>
      <button class="btn btn-sm" onclick="CRM.win.openManualMerge()" title="Öffnet zwei leere Vergleichsfenster mit Suchfeld — beliebige zwei Kontakte wählen und nebeneinander vergleichen">✋ Zwei Kontakte manuell zusammenführen</button>
      <div id="dupe-results"></div>
    </div>

    <div class="card" style="border-color:var(--red)">
      <h3 style="margin-top:0;color:var(--red)">Daten zurücksetzen</h3>
      <p style="color:var(--text-dim);font-size:13px;margin:0 0 10px">
        Löscht <strong>alle</strong> Kontakte, Projekte, Aufgaben, Besuche, Notizen und Koordinaten unwiderruflich aus diesem Browser.
        Sichere vorher ein Backup! Einstellungen (inkl. API-Key) bleiben erhalten.
      </p>
      <button class="btn" style="border-color:var(--red);color:var(--red)" onclick="CRM.confirmDataReset()">Alle Daten löschen…</button>
    </div>
  `;
};

CRM.saveIntervals = function () {
  const A = parseInt(document.getElementById('set-interval-A').value, 10);
  const B = parseInt(document.getElementById('set-interval-B').value, 10);
  const C = parseInt(document.getElementById('set-interval-C').value, 10);
  if ([A, B, C].some((x) => !x || x < 1)) {
    CRM.toast('Bitte gültige Tageswerte (≥ 1) eingeben.', 'error');
    return;
  }
  CRM.db.saveSettings({ intervals: { A, B, C } });
  CRM.toast('Besuchsintervalle gespeichert.', 'success');
  if (CRM.renderContactList) CRM.renderContactList();
};

CRM.confirmDataReset = function () {
  CRM.openModal(`
    <h2 style="color:var(--red)">⚠️ Alle Daten löschen?</h2>
    <p>Dies löscht unwiderruflich:</p>
    <ul style="color:var(--text-dim);font-size:14px">
      <li>${CRM.db.getContacts().length} Kontakte (inkl. Besuche & Notizen)</li>
      <li>${CRM.db.getProjects().length} Projekte</li>
      <li>${CRM.db.getTasks().length} Aufgaben</li>
      <li>${CRM.db.getJournalEntries().length} Journal-Einträge & ${CRM.db.getComms().length} Kommunikationen</li>
    </ul>
    <p style="font-size:13px">Zum Bestätigen tippe <strong>LÖSCHEN</strong> in das Feld:</p>
    <input id="reset-confirm-input" placeholder="LÖSCHEN" autocomplete="off">
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn" style="border-color:var(--red);color:var(--red)" onclick="CRM.doDataReset()">Endgültig löschen</button>
    </div>
  `);
};

CRM.doDataReset = function () {
  const val = (document.getElementById('reset-confirm-input').value || '').trim().toUpperCase();
  if (val !== 'LÖSCHEN') {
    CRM.toast('Bitte „LÖSCHEN" exakt eintippen, um zu bestätigen.', 'error');
    return;
  }
  CRM.takeSnapshot('Vor Daten-Reset');
  CRM.db._contacts = [];
  CRM.db._projects = [];
  CRM.db._tasks = [];
  CRM.db._comms = [];
  CRM.db._journal = [];
  CRM.db.saveContacts();
  CRM.db.saveProjects();
  CRM.db.saveTasks();
  CRM.db.saveComms();
  CRM.db.saveJournal();
  CRM.closeModal();
  CRM.toastUndo('Alle Daten gelöscht.');
  CRM.renderContactList();
  if (CRM.map && CRM.map.refresh) CRM.map.refresh();
};

CRM.renderDuplicatesPanel = function () {
  const el = document.getElementById('dupe-results');
  if (!el) return;
  const pairs = CRM.findDuplicateContacts();
  if (!pairs.length) {
    el.innerHTML = '<p style="color:var(--text-dim);font-size:13px;margin-top:10px">Keine Duplikate gefunden.</p>';
    return;
  }
  // Gleichnamige Duplikate ließen sich vorher nicht auseinanderhalten: beide
  // Spalten und beide Knöpfe zeigten denselben Firmennamen (Chris: „sonst
  // wähle ich hier den Falschen aus"). Jetzt klare Seiten-Kennzeichnung
  // A/B + Straße/ERP/Ansprechpartner + die Datenmengen je Seite.
  // Außerdem: Zusammenführen ist die Hauptaktion (nichts geht verloren),
  // reines Löschen ist bewusst zurückgestuft (vernichtet Daten).
  const seite = (kennung, c) => {
    const cnt = CRM._mergeSideCounts(c);
    return `
      <div style="flex:1;min-width:230px">
        <div style="display:flex;align-items:center;gap:6px">
          <span class="badge" style="border-color:var(--accent);color:var(--accent)">${kennung}</span>
          <strong>${esc(CRM.displayNameDisambig(c))}</strong>
        </div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:3px">${CRM._mergeSideInfo(c)}</div>
        <div style="font-size:12px;color:var(--text-dim);margin-top:3px">📍 ${cnt.besuche} Besuche · ✅ ${cnt.aufgaben} Aufgaben · 🔗 ${cnt.verknuepfungen} Verknüpfungen${cnt.notiz ? ' · 📝 Notiz' : ''}</div>
      </div>`;
  };
  el.innerHTML = pairs.map((p) => `
    <div class="card" style="margin-top:10px;padding:10px 12px">
      <div class="row" style="justify-content:space-between;align-items:flex-start;gap:12px;flex-wrap:wrap">
        ${seite('A', p.a)}
        ${seite('B', p.b)}
        <div style="font-size:12px;color:var(--text-dim);align-self:center">${Math.round(p.score * 100)}% ähnlich</div>
      </div>
      <div class="row" style="gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center">
        <button class="btn btn-sm btn-primary" onclick="CRM.confirmMergeContacts('${p.a.id}','${p.b.id}')">⇄ Zusammenführen — <strong>A</strong> behalten</button>
        <button class="btn btn-sm btn-primary" onclick="CRM.confirmMergeContacts('${p.b.id}','${p.a.id}')">⇄ Zusammenführen — <strong>B</strong> behalten</button>
        <button class="btn btn-sm" onclick="CRM.win.closeAll();CRM.win.openContact('${p.a.id}');CRM.win.openContact('${p.b.id}')" title="Beide nebeneinander öffnen und im Detail vergleichen">🔍 Vergleichen</button>
        <button class="btn btn-sm" onclick="CRM.dismissDupe('${p.key}')">Kein Duplikat</button>
      </div>
      <details style="margin-top:8px">
        <summary style="font-size:12px;color:var(--text-dim);cursor:pointer">Einen Eintrag stattdessen löschen (Daten gehen verloren)</summary>
        <div class="row" style="gap:8px;margin-top:6px;flex-wrap:wrap">
          <button class="btn btn-sm" style="border-color:var(--red);color:var(--red)" onclick="CRM.confirmDeleteDuplicate('${p.a.id}')">🗑 A löschen</button>
          <button class="btn btn-sm" style="border-color:var(--red);color:var(--red)" onclick="CRM.confirmDeleteDuplicate('${p.b.id}')">🗑 B löschen</button>
        </div>
      </details>
    </div>`).join('');
};

/* Reine Löschung ohne Zusammenführen — für den Fall, dass einer der
   beiden Kandidaten schlicht überflüssig ist (kein Datenabgleich nötig).
   App-eigene Bestätigung statt nativem confirm() (Lehre: Browser
   unterdrücken confirm() teils stumm — scheitert dort zwar sicher, aber
   ein ganzer Kontakt samt Besuchen/Aufgaben/Journal soll trotzdem einen
   bewussten zweiten Klick brauchen, nicht nur einen Undo-Toast danach;
   gleiches Muster wie CRM.deleteContactFromDetail/deleteProjectConfirm). */
CRM.confirmDeleteDuplicate = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  CRM.openModal(`
    <h2 style="color:var(--red)">Kontakt löschen (ohne Zusammenführen)?</h2>
    <p>„<strong>${esc(CRM.displayNameDisambig ? CRM.displayNameDisambig(c) : c.firma1)}</strong>“ wird gelöscht — Besuche, Aufgaben und Journal-Einträge gehen mit verloren (per „↶ Rückgängig" direkt danach wiederherstellbar).</p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn" style="border-color:var(--red);color:var(--red)" onclick="CRM._doDeleteDuplicate('${id}')">Endgültig löschen</button>
    </div>
  `);
};
CRM._doDeleteDuplicate = function (id) {
  const c = CRM.db.getContact(id);
  if (!c) return;
  CRM.takeSnapshot('Vor Löschen von Duplikat „' + c.firma1 + '"');
  CRM.db.deleteContact(id);
  CRM.closeModal();
  CRM.renderDuplicatesPanel();
  if (CRM.renderContactList) CRM.renderContactList();
  CRM.toastUndo('Kontakt „' + c.firma1 + '" gelöscht.');
};

CRM.dismissDupe = function (key) {
  CRM._dismissedDupes = CRM._dismissedDupes || new Set();
  CRM._dismissedDupes.add(key);
  CRM.renderDuplicatesPanel();
};

/* Kompakte Kennzeichnung eines Kontakts für Merge-Dialoge: bei
   gleichnamigen Kontakten reicht der Firmenname NICHT zur Unterscheidung
   (Chris: „nur den Namen ohne Zuordnung, ohne Ort — sonst wähle ich den
   Falschen aus"). Darum immer mit Straße/Ort/ERP-Nr. und den Datenmengen,
   die am Kontakt hängen. */
CRM._mergeSideInfo = function (c) {
  const zeilen = [];
  if (c.strasse) zeilen.push(esc(c.strasse));
  const ortZeile = [c.plz, c.ort].filter(Boolean).join(' ');
  if (ortZeile) zeilen.push(esc(ortZeile));
  if (c.erpNr) zeilen.push('ERP-Nr. ' + esc(c.erpNr));
  zeilen.push(esc(CRM.SOURCE_LABELS[c.source] || c.source || ''));
  const ap = CRM.mainAnsprechpartner(c);
  const apName = [ap.vorname, ap.name].filter(Boolean).join(' ');
  if (apName) zeilen.push('AP: ' + esc(apName));
  return zeilen.filter(Boolean).join(' · ');
};
CRM._mergeSideCounts = function (c) {
  return {
    besuche: (c.visits || []).length,
    aufgaben: CRM.db.getTasksForContact(c.id).length,
    verknuepfungen: Object.keys(c.links || {}).reduce((s, k) => s + ((c.links[k] || []).length), 0),
    notiz: !!(c.notiz && String(c.notiz).trim()),
  };
};

CRM.confirmMergeContacts = function (keepId, dropId) {
  const keep = CRM.db.getContact(keepId);
  const drop = CRM.db.getContact(dropId);
  if (!keep || !drop) return;
  const kName = CRM.displayNameDisambig(keep);
  const dName = CRM.displayNameDisambig(drop);
  const kc = CRM._mergeSideCounts(keep);
  const dc = CRM._mergeSideCounts(drop);
  // Konkret zeigen, was übernommen wird — Chris' Sorge war ausdrücklich,
  // dass beim Zusammenführen Informationen verloren gehen.
  const uebernahme = [];
  if (dc.besuche) uebernahme.push(dc.besuche + ' Besuch(e)');
  if (dc.aufgaben) uebernahme.push(dc.aufgaben + ' Aufgabe(n)');
  if (dc.verknuepfungen) uebernahme.push(dc.verknuepfungen + ' Verknüpfung(en)');
  if (dc.notiz) uebernahme.push('Notiz');
  const seite = (titel, name, c, counts, farbe) => `
    <div style="flex:1;min-width:220px;border:1px solid ${farbe};border-radius:8px;padding:10px 12px">
      <div style="font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:${farbe}">${titel}</div>
      <div style="font-weight:600;margin-top:2px">${esc(name)}</div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:4px">${CRM._mergeSideInfo(c)}</div>
      <div style="font-size:12px;color:var(--text-dim);margin-top:6px">📍 ${counts.besuche} Besuche · ✅ ${counts.aufgaben} Aufgaben · 🔗 ${counts.verknuepfungen} Verknüpfungen${counts.notiz ? ' · 📝 Notiz' : ''}</div>
    </div>`;
  CRM.openModal(`
    <h2 style="margin-top:0">Kontakte zusammenführen?</h2>
    <div class="row" style="gap:10px;flex-wrap:wrap">
      ${seite('Bleibt bestehen', kName, keep, kc, 'var(--green)')}
      ${seite('Wird eingefügt &amp; entfernt', dName, drop, dc, 'var(--orange)')}
    </div>
    <p style="font-size:13px;margin-top:12px">
      ${uebernahme.length
        ? '<strong>Wird übernommen:</strong> ' + esc(uebernahme.join(', ')) + '.'
        : 'Beim eingefügten Kontakt hängen keine Besuche/Aufgaben/Verknüpfungen.'}
      Leere Felder oben links werden aus dem rechten Kontakt ergänzt — <strong>es gehen keine Daten verloren</strong>, und „↶ Rückgängig" stellt beide sofort wieder her.
    </p>
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" onclick="CRM.doMergeContacts('${keepId}','${dropId}')">⇄ Jetzt zusammenführen</button>
    </div>
  `);
};

CRM.doMergeContacts = function (keepId, dropId) {
  const keep = CRM.mergeContacts(keepId, dropId);
  CRM.closeModal();
  if (!keep) { CRM.toast('Zusammenführen fehlgeschlagen — Kontakt nicht gefunden.', 'error'); return; }
  // Gemeinsame Nachbereitung (Undo-Toast, Listen/Karte/Duplikat-Panel
  // aktualisieren) — auch vom Vergleichsfenster genutzt.
  if (CRM.win && CRM.win._afterMerge) { CRM.win._afterMerge(keep); return; }
  CRM.toastUndo(`Kontakte zu „${CRM.displayNameDisambig(keep)}“ zusammengeführt.`);
  CRM.renderDuplicatesPanel();
  if (CRM.renderContactList) CRM.renderContactList();
};

CRM.saveAdKuerzel = function () {
  CRM.db.saveSettings({ adKuerzel: (document.getElementById('set-ad-kuerzel').value || 'CK').trim() });
  CRM.toast('AD-Kürzel gespeichert.', 'success');
};

CRM.saveOnedrivePath = function () {
  CRM.db.saveSettings({ onedrivePath: document.getElementById('set-onedrive-path').value.trim().replace(/[\\/]+$/, '') });
  CRM.toast('Pfad gespeichert.', 'success');
  if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings(); // Kopier-Hinweis oben aktualisieren
};

/* Wohnort speichern (Adresse; Koordinaten bleiben bis zum Geocodieren leer). */
CRM.saveHome = function () {
  const adresse = (document.getElementById('set-home-adresse').value || '').trim();
  const prev = CRM.db.getSettings().home || {};
  // Adresse geändert → alte Koordinaten verwerfen (müssen neu geocodiert werden)
  const home = (prev.adresse === adresse) ? Object.assign({}, prev, { adresse }) : { adresse, lat: null, lng: null };
  CRM.db.saveSettings({ home });
  CRM.toast(adresse ? 'Wohnort gespeichert.' : 'Wohnort entfernt.', 'success');
  if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
};

/* Wohnort geocodieren (Nominatim) → Koordinaten für „Zuhause" ermitteln. */
CRM.geocodeHome = async function () {
  const adresse = (document.getElementById('set-home-adresse').value || '').trim();
  if (!adresse) { CRM.toast('Bitte zuerst eine Adresse eintragen.', 'error'); return; }
  const st = document.getElementById('home-status');
  if (st) st.textContent = 'suche Koordinaten …';
  const hit = await CRM.geocoding.geocodeFree(adresse);
  if (hit) {
    CRM.db.saveSettings({ home: { adresse, lat: hit.lat, lng: hit.lng } });
    CRM.toast('✓ Wohnort verortet.', 'success');
  } else {
    CRM.db.saveSettings({ home: { adresse, lat: null, lng: null } });
    CRM.toast('Adresse nicht gefunden — Route funktioniert trotzdem über die Adresse.', 'error');
  }
  if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
};

/* Klick auf den angezeigten Pfad kopiert ihn in die Zwischenablage —
   zum Einfügen in die Adressleiste des Windows-Ordner-Dialogs. */
CRM.copyOnedrivePath = function () {
  const path = (CRM.db.getSettings().onedrivePath || '').trim();
  if (!path) return;
  const fertig = () => CRM.toast('📋 Pfad kopiert — im Ordner-Dialog oben in die Adressleiste einfügen (Strg+V) und Enter.', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(path).then(fertig).catch(() => CRM.toast('Kopieren nicht möglich — Pfad bitte markieren und mit Strg+C kopieren.', 'error'));
  } else {
    // Fallback für ältere/eingeschränkte Umgebungen
    const el = document.getElementById('ablage-copy-path');
    if (el) { const r = document.createRange(); r.selectNodeContents(el); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r); }
    try { document.execCommand('copy'); fertig(); } catch (e) { CRM.toast('Bitte den Pfad markieren und mit Strg+C kopieren.', 'error'); }
  }
};

CRM.saveSupabaseConfig = function () {
  const url = CRM.normalizeSupabaseUrl(document.getElementById('set-supabase-url').value);
  const key = document.getElementById('set-supabase-key').value.trim();
  if (key.startsWith('sb_secret_')) {
    CRM.toast('⚠️ Das sieht nach dem GEHEIMEN Key aus (sb_secret_...) — bitte nur den Veröffentlichungsschlüssel (sb_publishable_...) eintragen!', 'error');
    return;
  }
  CRM.db.saveSettings({ supabaseUrl: url, supabasePublishableKey: key });
  CRM.initSupabase();
  CRM.toast('Supabase-Zugangsdaten gespeichert.', 'success');
};

CRM.exportExcelFromSettings = function () {
  const res = CRM.backup.exportExcel();
  if (res) CRM.toast(`Excel exportiert: ${res.contacts} Kontakte, ${res.visits} Besuche, ${res.projects} Projekte.`, 'success');
};

CRM.toggleKeyVisibility = function () {
  const el = document.getElementById('set-whisper-key');
  el.type = el.type === 'password' ? 'text' : 'password';
};

CRM.saveSpeechSettings = function () {
  CRM.db.saveSettings({
    speechEngine: document.getElementById('set-speech-engine').value,
    whisperApiKey: document.getElementById('set-whisper-key').value.trim(),
  });
  CRM.toast('Einstellungen gespeichert.', 'success');
};

/* ---------- Design + Musterversand ---------- */
CRM.saveTheme = function () {
  const t = document.getElementById('set-theme').value;
  CRM.db.saveSettings({ theme: t });
  CRM.applyTheme();
  CRM.toast(t === 'hell' ? 'Helles Design aktiviert. ☀️' : 'Dunkles Design aktiviert. 🌙', 'success');
};

CRM.saveMusterSettings = function () {
  CRM.db.saveSettings({ musterEmail: document.getElementById('set-muster-mail').value.trim() });
  CRM.toast('Empfänger für Werbemittelbestellungen gespeichert.', 'success');
};

CRM.saveAntwortSetting = function () {
  const on = document.getElementById('set-antwort-sparsam').checked;
  CRM.db.saveSettings({ antwortDatensparsam: on });
  CRM.toast(on ? '🔒 Datensparsam aktiv.' : 'Vollständige Daten werden mitgegeben.', 'success');
};
