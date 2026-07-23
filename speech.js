/* ============================================================
   Claytec CRM — Sprachsteuerung (Schritt 7)
   Standard: Web Speech API (kostenlos, de-DE)
   Erweitert: Whisper API (OpenAI), umschaltbar in Einstellungen
   Sprachbefehl "Besuch heute" → setzt Datum automatisch.
   Schnellerfassung in max. 3 Taps: Kontakt → Mikrofon → Speichern.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.speech = {
  recognition: null,
  mediaRecorder: null,
  chunks: [],
  active: false,
  targetContactId: null,
  transcript: '',
  parsedDate: null,
};

CRM.speech.webSpeechAvailable = function () {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
};

/* Befehl "Besuch heute" / "Besuch gestern" erkennen → Datum + bereinigter Notiztext */
CRM.speech.parseCommands = function (text) {
  let date = null;
  let cleaned = text;
  const lower = text.toLowerCase();
  if (/besuch\s+heute/.test(lower)) {
    date = new Date().toISOString().slice(0, 10);
    cleaned = cleaned.replace(/besuch\s+heute/i, '').trim();
  } else if (/besuch\s+gestern/.test(lower)) {
    const d = new Date(); d.setDate(d.getDate() - 1);
    date = d.toISOString().slice(0, 10);
    cleaned = cleaned.replace(/besuch\s+gestern/i, '').trim();
  }
  return { date, cleaned };
};

/* ---------- Aufnahme-Dialog öffnen ---------- */
CRM.speech.openCapture = function (contactId) {
  CRM.speech.targetContactId = contactId;
  CRM.speech.transcript = '';
  CRM.speech.parsedDate = null;
  const c = CRM.db.getContact(contactId);
  const engine = CRM.db.getSettings().speechEngine || 'webspeech';

  CRM.openModal(`
    <h2>🎤 Sprachnotiz${c ? ' — ' + esc(c.firma1) : ''}</h2>
    <p style="color:var(--text-dim);font-size:13px">Engine: ${engine === 'whisper' ? 'Whisper (OpenAI)' : 'Web Speech (de-DE, kostenlos)'} · Tipp: sage „Besuch heute" um das Datum automatisch zu setzen.</p>
    <div id="speech-status" class="speech-status">Bereit.</div>
    <div style="margin:12px 0">
      <label>Erkannter Text</label>
      <textarea id="speech-transcript" rows="4" placeholder="Hier erscheint die Transkription..."></textarea>
    </div>
    <div class="row" style="align-items:center;gap:8px">
      <label style="margin:0;max-width:160px">Besuchsdatum</label>
      <input type="date" id="speech-date" value="${new Date().toISOString().slice(0, 10)}" style="max-width:170px">
    </div>
    <div class="row" style="margin-top:14px">
      <button class="btn btn-primary" id="speech-rec-btn" onclick="CRM.speech.toggleRecord()">● Aufnahme starten</button>
      <button class="btn" onclick="CRM.speech.cancel()">Abbrechen</button>
      <button class="btn" style="margin-left:auto" onclick="CRM.speech.saveAsJournal()">📓 Als Notiz speichern</button>
      <button class="btn btn-primary" onclick="CRM.speech.saveAsVisit()">Als Besuch speichern</button>
    </div>
    <p style="color:var(--text-dim);font-size:12px;margin-top:8px">„Als Besuch" landet im offiziellen Besuchsbericht (Excel-Ablage). „Als Notiz" landet nur im fortlaufenden Kontaktjournal, ohne Export.</p>
  `);
};

CRM.speech.setStatus = function (txt, cls) {
  const el = document.getElementById('speech-status');
  if (el) { el.textContent = txt; el.className = 'speech-status' + (cls ? ' ' + cls : ''); }
};

CRM.speech.toggleRecord = function () {
  if (CRM.speech.active) { CRM.speech.stop(); return; }
  const engine = CRM.db.getSettings().speechEngine || 'webspeech';
  if (engine === 'whisper') CRM.speech.startWhisper();
  else CRM.speech.startWebSpeech();
};

/* ---------- Web Speech API ---------- */
CRM.speech.startWebSpeech = function () {
  if (!CRM.speech.webSpeechAvailable()) {
    CRM.toast('Web Speech API in diesem Browser nicht verfügbar. Nutze Chrome/Edge oder schalte auf Whisper um.', 'error');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'de-DE';
  rec.interimResults = true;
  rec.continuous = true;
  CRM.speech.recognition = rec;
  CRM.speech.active = true;
  CRM.speech.updateRecBtn(true);
  CRM.speech.setStatus('🔴 Aufnahme läuft… sprich jetzt.', 'rec');

  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t + ' ';
      else interim += t;
    }
    const full = (finalText + interim).trim();
    document.getElementById('speech-transcript').value = full;
    CRM.speech.applyParsed(full);
  };
  rec.onerror = (e) => {
    CRM.speech.setStatus('Fehler: ' + e.error, 'err');
    CRM.speech.active = false;
    CRM.speech.updateRecBtn(false);
  };
  rec.onend = () => {
    CRM.speech.active = false;
    CRM.speech.updateRecBtn(false);
    if (document.getElementById('speech-status')) CRM.speech.setStatus('Aufnahme beendet. Text prüfen und speichern.', '');
  };
  rec.start();
};

/* ---------- Whisper API (OpenAI) ---------- */
CRM.speech.startWhisper = async function () {
  const key = CRM.db.getSettings().whisperApiKey;
  if (!key) {
    CRM.toast('Kein Whisper API-Key hinterlegt. Bitte in Einstellungen eintragen.', 'error');
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const mr = new MediaRecorder(stream);
    CRM.speech.mediaRecorder = mr;
    CRM.speech.chunks = [];
    mr.ondataavailable = (e) => { if (e.data.size) CRM.speech.chunks.push(e.data); };
    mr.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      CRM.speech.sendToWhisper();
    };
    mr.start();
    CRM.speech.active = true;
    CRM.speech.updateRecBtn(true);
    CRM.speech.setStatus('🔴 Aufnahme läuft (Whisper)… sprich jetzt, dann „Aufnahme stoppen".', 'rec');
  } catch (e) {
    CRM.toast('Mikrofon-Zugriff verweigert: ' + e.message, 'error');
  }
};

CRM.speech.sendToWhisper = async function () {
  CRM.speech.setStatus('⏳ Transkription bei Whisper…', '');
  const key = CRM.db.getSettings().whisperApiKey;
  const blob = new Blob(CRM.speech.chunks, { type: 'audio/webm' });
  const form = new FormData();
  form.append('file', blob, 'audio.webm');
  form.append('model', 'whisper-1');
  form.append('language', 'de');
  try {
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + key },
      body: form,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const text = (data.text || '').trim();
    document.getElementById('speech-transcript').value = text;
    CRM.speech.applyParsed(text);
    CRM.speech.setStatus('Transkription fertig. Text prüfen und speichern.', '');
  } catch (e) {
    CRM.speech.setStatus('Whisper-Fehler: ' + e.message, 'err');
  }
};

/* ---------- Befehl auswerten & UI aktualisieren ---------- */
CRM.speech.applyParsed = function (full) {
  const { date, cleaned } = CRM.speech.parseCommands(full);
  if (date) {
    const dateEl = document.getElementById('speech-date');
    if (dateEl) dateEl.value = date;
    const txtEl = document.getElementById('speech-transcript');
    if (txtEl) txtEl.value = cleaned;
    CRM.speech.setStatus('✓ Befehl „Besuch" erkannt — Datum gesetzt: ' + date, 'ok');
  }
};

CRM.speech.updateRecBtn = function (recording) {
  const btn = document.getElementById('speech-rec-btn');
  if (!btn) return;
  btn.textContent = recording ? '■ Aufnahme stoppen' : '● Aufnahme starten';
  btn.classList.toggle('rec-active', recording);
};

CRM.speech.stop = function () {
  if (CRM.speech.recognition) { try { CRM.speech.recognition.stop(); } catch (e) {} }
  if (CRM.speech.mediaRecorder && CRM.speech.mediaRecorder.state !== 'inactive') CRM.speech.mediaRecorder.stop();
  CRM.speech.active = false;
  CRM.speech.updateRecBtn(false);
};

CRM.speech.cancel = function () {
  CRM.speech.stop();
  CRM.closeModal();
};

CRM.speech.saveAsVisit = function () {
  CRM.speech.stop();
  const text = (document.getElementById('speech-transcript').value || '').trim();
  const date = document.getElementById('speech-date').value || new Date().toISOString().slice(0, 10);
  const id = CRM.speech.targetContactId;
  if (!id) { CRM.toast('Kein Kontakt zugeordnet.', 'error'); return; }
  CRM.addVisit(id, date, text);
  CRM.toast('Sprachnotiz als Besuch gespeichert.', 'success');
  if (CRM.renderContactDetailModal && document.getElementById('view-kontakte')) CRM.renderContactList();
  if (CRM._heuteView !== undefined && document.querySelector('#view-agenda.active')) CRM.renderAgenda();
  CRM.speech.showPostSaveActions(id, { date, note: text });
};

/* Direkt nach dem Speichern: statt einfach zu schließen, sofort die
   nächsten naheliegenden Schritte anbieten (Kontakt öffnen / Excel-Ablage) —
   ohne dass der Nutzer erst manuell zum Kontakt navigieren muss. Bei
   Journal-Einträgen gibt es keinen Excel-Button, da diese laut Konzept
   nie exportiert werden. */
CRM.speech.showPostSaveActions = function (contactId, visit, noteText) {
  const c = CRM.db.getContact(contactId);
  const excelBtn = visit
    ? `<button class="btn btn-primary" style="justify-content:center;padding:14px" onclick='CRM.ablage.openDialog("${contactId}", ${JSON.stringify(visit).replace(/'/g, '&#39;')})'>📋 In Excel ablegen</button>`
    : '';

  // Aufgaben aus dem gesprochenen Text erkennen (Bezugsdatum = Besuchsdatum)
  const text = noteText || (visit && visit.note) || '';
  const baseISO = (visit && visit.date) || new Date().toISOString().slice(0, 10);
  CRM.speech._vorschlaege = CRM.speech.detectTasks(text, baseISO);
  CRM.speech._vorschlagContactId = contactId;

  let taskBlock = '';
  if (CRM.speech._vorschlaege.length) {
    const karten = CRM.speech._vorschlaege.map((t, i) => `
      <div class="speech-task" id="speech-task-${i}" style="border:1px solid var(--border);border-radius:8px;padding:10px;margin-bottom:8px;background:var(--bg)">
        <input type="text" id="speech-task-title-${i}" value="${escAttr(t.title)}" style="width:100%;margin-bottom:6px">
        <div class="row" style="align-items:center;gap:8px;flex-wrap:wrap">
          <label style="margin:0;font-size:12px;color:var(--text-dim)">Fällig</label>
          <input type="date" id="speech-task-due-${i}" value="${escAttr(t.due)}" style="max-width:160px">
          <button class="btn btn-primary btn-sm" onclick="CRM.speech.uebernehmeTask(${i})">✓ Übernehmen</button>
          <button class="btn btn-sm" onclick="CRM.speech.verwerfeTask(${i})">Verwerfen</button>
        </div>
      </div>`).join('');
    taskBlock = `
      <div style="margin:14px 0 4px">
        <div style="font-weight:600;font-size:14px;margin-bottom:6px">📋 ${CRM.speech._vorschlaege.length === 1 ? 'Aufgabe erkannt' : CRM.speech._vorschlaege.length + ' Aufgaben erkannt'}</div>
        <p style="color:var(--text-dim);font-size:12px;margin:0 0 8px">Aus deiner Notiz — Text und Datum prüfen, dann übernehmen.</p>
        ${karten}
        ${CRM.speech._vorschlaege.length > 1 ? `<button class="btn btn-sm" onclick="CRM.speech.uebernehmeAlleTasks()">Alle übernehmen</button>` : ''}
      </div>`;
  }

  CRM.openModal(`
    <h2 style="margin-top:0">✓ Gespeichert${c ? ' — ' + esc(c.firma1) : ''}</h2>
    ${taskBlock}
    <div class="row" style="flex-direction:column;gap:10px;margin-top:10px">
      ${excelBtn}
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.openContactDetail('${contactId}')">→ Kontakt öffnen</button>
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.closeModal()">Fertig</button>
    </div>
  `);
};

CRM.speech.uebernehmeTask = function (i) {
  const titleEl = document.getElementById('speech-task-title-' + i);
  const dueEl = document.getElementById('speech-task-due-' + i);
  if (!titleEl) return;
  const title = titleEl.value.trim();
  if (!title) { CRM.toast('Kein Aufgabentext.', 'error'); return; }
  const due = dueEl && dueEl.value ? dueEl.value : new Date().toISOString().slice(0, 10);
  CRM.db.addTask({ title, due, contactId: CRM.speech._vorschlagContactId || null });
  const karte = document.getElementById('speech-task-' + i);
  if (karte) { karte.style.opacity = '.5'; karte.innerHTML = '<span style="color:var(--green);font-size:13px">✓ Aufgabe gespeichert: ' + esc(title) + ' (fällig ' + esc(due) + ')</span>'; }
  CRM.toast('✓ Aufgabe gespeichert — fällig ' + due, 'success');
  if (CRM._heuteView !== undefined && document.querySelector('#view-agenda.active')) CRM.renderAgenda();
};

CRM.speech.verwerfeTask = function (i) {
  const karte = document.getElementById('speech-task-' + i);
  if (karte) karte.remove();
};

CRM.speech.uebernehmeAlleTasks = function () {
  (CRM.speech._vorschlaege || []).forEach((t, i) => {
    const karte = document.getElementById('speech-task-' + i);
    // nur noch nicht übernommene/verworfene Karten
    if (karte && document.getElementById('speech-task-title-' + i)) CRM.speech.uebernehmeTask(i);
  });
};

/* Sprachnotiz als fortlaufendes Kontaktjournal speichern — kein
   Besuchsbericht, kein Export, taucht nur im Kontaktjournal des Kontakts auf. */
CRM.speech.saveAsJournal = function () {
  CRM.speech.stop();
  const text = (document.getElementById('speech-transcript').value || '').trim();
  const id = CRM.speech.targetContactId;
  if (!id) { CRM.toast('Kein Kontakt zugeordnet.', 'error'); return; }
  if (!text) { CRM.toast('Kein Text erfasst.', 'error'); return; }
  CRM.db.addJournalEntry({ contactId: id, entryType: 'info', content: text, inputMethod: 'voice' });
  CRM.toast('Als Notiz im Kontaktjournal gespeichert.', 'success');
  if (CRM.renderContactDetailModal && document.getElementById('view-kontakte')) CRM.renderContactList();
  CRM.speech.showPostSaveActions(id, null, text);
};

/* ============================================================
   To-do-Erkennung aus diktiertem Text (regelbasiert, offline).
   Sagst du beim Diktieren z.B. „…nächste Woche Mittwoch nachfassen
   wegen Angebot", wird daraus ein Aufgaben-Vorschlag mit Zieldatum,
   den du im Post-Save-Dialog bestätigst (nicht blind gespeichert —
   Spracherkennung verhört sich).
   ============================================================ */
CRM.speech.WOCHENTAGE = { sonntag: 0, montag: 1, dienstag: 2, mittwoch: 3, donnerstag: 4, freitag: 5, samstag: 6, sonnabend: 6 };
CRM.speech.MONATE = { januar: 1, februar: 2, 'märz': 3, maerz: 3, april: 4, mai: 5, juni: 6, juli: 7, august: 8, september: 9, oktober: 10, november: 11, dezember: 12 };
CRM.speech.ZAHLWORT = { ein: 1, eine: 1, einer: 1, einem: 1, zwei: 2, drei: 3, vier: 4, 'fünf': 5, fuenf: 5, sechs: 6, sieben: 7, acht: 8, neun: 9, zehn: 10, elf: 11, 'zwölf': 12, zwoelf: 12, dreizehn: 13, vierzehn: 14, zwanzig: 20, dreissig: 30, 'dreißig': 30 };
/* Auslöser sind HANDLUNGS-Verben, keine bloßen Substantive: „Muster
   zuschicken" ist eine Aufgabe, „braucht noch Muster" oder „Termin lief
   gut" nicht. Das hält Beobachtungssätze aus der Aufgabenliste heraus. */
CRM.speech.TASK_TRIGGER = /\b(nachfass\w*|nachhak\w*|nachreich\w*|nachfrag\w*|wiedervorlage|wieder ?vorlage|\bwv\b|erinner\w*|nicht vergessen|dran denken|drandenken|anrufen|anzurufen|zur[üu]ckrufen|r[üu]ckruf\b|telefonier\w*|schicken|zuschicken|zuzuschicken|zusenden|zuzusenden|zuschick\w*|senden|verschicken|schick\b|klären|klaeren|abklären|abklaeren|prüfen|pruefen|checken|k[üu]mmern|besorgen|bestellen|nachbestellen|liefern|mitbringen|mitnehmen|vorbeischauen|vorbei ?kommen|vereinbaren|organisier\w*|erledigen)\b/i;

CRM.speech._toISO = function (d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
};
CRM.speech._addDays = function (base, n) {
  const d = new Date(base.getTime());
  d.setDate(d.getDate() + n);
  return d;
};
/* Nächstes Vorkommen eines Wochentags NACH base (nie base selbst).
   „nächsten Montag" am Donnerstag = der kommende Montag. */
CRM.speech._nextWeekday = function (base, wd) {
  let diff = (wd - base.getDay() + 7) % 7;
  if (diff === 0) diff = 7;
  return CRM.speech._addDays(base, diff);
};
/* Wochentag der KOMMENDEN Kalenderwoche (für „nächste Woche Mittwoch"):
   Montag der nächsten Woche + Offset (Mo=0 … So=6). */
CRM.speech._weekdayNextWeek = function (base, wd) {
  const seitMontag = (base.getDay() + 6) % 7;          // Mo=0, So=6
  const montagNaechste = CRM.speech._addDays(base, 7 - seitMontag);
  const offset = (wd + 6) % 7;                          // Mo=0 … So=6
  return CRM.speech._addDays(montagNaechste, offset);
};

/* Findet eine deutsche Datumsangabe im Text. Gibt {iso, matched} zurück
   oder null. baseISO ist der Bezugspunkt für relative Angaben (Besuchsdatum). */
CRM.speech.parseGermanDate = function (text, baseISO) {
  if (!text) return null;
  const t = ' ' + text.toLowerCase().replace(/\s+/g, ' ') + ' ';
  const base = baseISO ? new Date(baseISO + 'T12:00:00') : (() => { const d = new Date(); d.setHours(12, 0, 0, 0); return d; })();
  const zahl = (w) => (/^\d+$/.test(w) ? parseInt(w, 10) : CRM.speech.ZAHLWORT[w]);
  const wdAlt = 'montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonnabend|sonntag';
  const monAlt = Object.keys(CRM.speech.MONATE).join('|');
  let m;

  // „übermorgen" / „morgen" / „heute"
  if ((m = t.match(/ übermorgen /))) return { iso: CRM.speech._toISO(CRM.speech._addDays(base, 2)), matched: 'übermorgen' };
  if ((m = t.match(/ morgen /))) return { iso: CRM.speech._toISO(CRM.speech._addDays(base, 1)), matched: 'morgen' };
  if ((m = t.match(/ heute /))) return { iso: CRM.speech._toISO(base), matched: 'heute' };

  // „in 3 Tagen" / „in zwei Wochen" / „in einer Woche"
  if ((m = t.match(new RegExp(' in (\\d+|[a-zäöü]+) tag(?:en|e)? ')))) { const n = zahl(m[1]); if (n) return { iso: CRM.speech._toISO(CRM.speech._addDays(base, n)), matched: m[0].trim() }; }
  if ((m = t.match(new RegExp(' in (\\d+|[a-zäöü]+) woche(?:n)? ')))) { const n = zahl(m[1]); if (n) return { iso: CRM.speech._toISO(CRM.speech._addDays(base, n * 7)), matched: m[0].trim() }; }

  // „nächste Woche [Wochentag]" / „nächste Woche"
  if ((m = t.match(new RegExp(' (?:n[äa]chste[nr]?|kommende[nr]?) woche (' + wdAlt + ') ')))) {
    return { iso: CRM.speech._toISO(CRM.speech._weekdayNextWeek(base, CRM.speech.WOCHENTAGE[m[1]])), matched: m[0].trim() };
  }
  if ((m = t.match(/ (?:n[äa]chste[nr]?|kommende[nr]?) woche /))) return { iso: CRM.speech._toISO(CRM.speech._addDays(base, 7)), matched: m[0].trim() };

  // konkretes Datum: „am 15.8.2026" / „am 15. August" / „15.08."
  if ((m = t.match(new RegExp(' (?:am )?(\\d{1,2})\\.? ?(' + monAlt + ') ?(\\d{4})? ')))) {
    const day = parseInt(m[1], 10), mon = CRM.speech.MONATE[m[2]], yr = m[3] ? parseInt(m[3], 10) : null;
    const d = CRM.speech._resolveDayMonth(base, day, mon, yr);
    if (d) return { iso: CRM.speech._toISO(d), matched: m[0].trim() };
  }
  if ((m = t.match(/ (?:am )?(\d{1,2})\.(\d{1,2})\.(\d{2,4})? /))) {
    const day = parseInt(m[1], 10), mon = parseInt(m[2], 10);
    let yr = m[3] ? parseInt(m[3], 10) : null; if (yr && yr < 100) yr += 2000;
    const d = CRM.speech._resolveDayMonth(base, day, mon, yr);
    if (d) return { iso: CRM.speech._toISO(d), matched: m[0].trim() };
  }
  // „am 15." (nur Tag) → nächstes Vorkommen dieses Tags
  if ((m = t.match(/ am (\d{1,2})\.(?![\d]) /))) {
    const day = parseInt(m[1], 10);
    const d = CRM.speech._resolveDayMonth(base, day, null, null);
    if (d) return { iso: CRM.speech._toISO(d), matched: m[0].trim() };
  }

  // „KW 32" → Montag der Kalenderwoche
  if ((m = t.match(/ (?:kw|kalenderwoche) ?(\d{1,2}) /))) {
    const d = CRM.speech._mondayOfWeek(base.getFullYear(), parseInt(m[1], 10));
    if (d) return { iso: CRM.speech._toISO(d), matched: m[0].trim() };
  }

  // „Ende der Woche" → Freitag dieser Woche; „Ende des Monats"
  if ((m = t.match(/ ende (?:der|dieser) woche /))) return { iso: CRM.speech._toISO(CRM.speech._nextWeekday(CRM.speech._addDays(base, -1), 5)), matched: m[0].trim() };
  if ((m = t.match(/ ende (?:des|dieses) monats? /))) { const d = new Date(base.getFullYear(), base.getMonth() + 1, 0, 12); return { iso: CRM.speech._toISO(d), matched: m[0].trim() }; }

  // „(diesen|nächsten|kommenden) Wochentag" oder bloßer Wochentag
  if ((m = t.match(new RegExp(' (diesen|n[äa]chsten|kommenden)? ?(' + wdAlt + ') ')))) {
    return { iso: CRM.speech._toISO(CRM.speech._nextWeekday(base, CRM.speech.WOCHENTAGE[m[2]])), matched: m[0].trim() };
  }
  return null;
};

/* Tag+Monat zu einem Datum auflösen; fehlender Monat/Jahr → nächstes
   künftiges Vorkommen (keine Termine in der Vergangenheit vorschlagen). */
CRM.speech._resolveDayMonth = function (base, day, mon, yr) {
  if (day < 1 || day > 31) return null;
  if (yr) { const d = new Date(yr, (mon || 1) - 1, day, 12); return isNaN(d) ? null : d; }
  if (mon) {
    let d = new Date(base.getFullYear(), mon - 1, day, 12);
    if (d < base) d = new Date(base.getFullYear() + 1, mon - 1, day, 12);
    return d;
  }
  // nur Tag: dieser Monat, sonst nächster
  let d = new Date(base.getFullYear(), base.getMonth(), day, 12);
  if (d < base) d = new Date(base.getFullYear(), base.getMonth() + 1, day, 12);
  return d;
};

/* Montag der ISO-Kalenderwoche kw im Jahr yr. */
CRM.speech._mondayOfWeek = function (yr, kw) {
  if (kw < 1 || kw > 53) return null;
  const jan4 = new Date(yr, 0, 4, 12);
  const week1Monday = CRM.speech._addDays(jan4, 1 - (jan4.getDay() || 7));
  return CRM.speech._addDays(week1Monday, (kw - 1) * 7);
};

/* Zerlegt den Text in Segmente und liefert für jedes Segment mit einem
   Aufgaben-Auslöser einen Vorschlag {title, due}. */
CRM.speech.detectTasks = function (text, baseISO) {
  if (!text) return [];
  // Datums-/Ordinalpunkte schützen („am 15." darf den Satz nicht zerschneiden),
  // dann an Satzzeichen und Aufzähl-Konjunktionen trennen, danach Punkte zurück.
  const geschuetzt = text.replace(/(\d)\.(?=\s|\d|$)/g, '$1\x00');
  const rohSegmente = geschuetzt
    .replace(/\b(und dann|und danach|außerdem|ausserdem|des weiteren|desweiteren|dann noch|sowie)\b/gi, '|')
    .split(/[.;!?\n|]+/)
    .map((s) => s.replace(/\x00/g, '.'));
  const tasks = [];
  const gesehen = new Set();
  rohSegmente.forEach((seg) => {
    const s = seg.trim();
    if (s.length < 3 || !CRM.speech.TASK_TRIGGER.test(s)) return;
    // Datum bevorzugt aus dem Segment, sonst aus dem Gesamttext
    const dat = CRM.speech.parseGermanDate(s, baseISO) || CRM.speech.parseGermanDate(text, baseISO);
    const title = CRM.speech._segmentZuTitel(s, dat && dat.matched);
    if (!title) return;
    const key = title.toLowerCase();
    if (gesehen.has(key)) return;
    gesehen.add(key);
    tasks.push({ title, due: dat ? dat.iso : '' });
  });
  return tasks;
};

/* Führende Füllwörter/Modalphrasen, die vor dem eigentlichen Auftrag stehen.
   Iterativ abgetragen — „und" u.ä. NUR am Anfang, nicht in der Mitte
   (sonst wird aus „anrufen und Preise durchgeben" ein Wortsalat). */
CRM.speech._FUELL_VORNE = /^(und|dann|danach|noch|nochmal|mal|bitte|also|so|ja|ähm|ehm|ich muss|ich müsste|ich sollte|ich möchte|ich will|wir müssen|wir sollten|man muss|nicht vergessen|dran denken|daran denken|zu|dem kunden|ihm|ihr|ihnen|ihn|bis|spätestens|spaetestens|am)\b[\s,:;\-–]*/i;

/* Segment zu einem knappen Aufgaben-Titel aufräumen. */
CRM.speech._segmentZuTitel = function (seg, matchedDate) {
  let t = seg;
  if (matchedDate) t = t.replace(new RegExp(matchedDate.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'), ' ');
  t = t.replace(/\s+/g, ' ').trim();
  let prev;
  do { prev = t; t = t.replace(CRM.speech._FUELL_VORNE, ''); } while (t !== prev && t.length);
  // isolierte Präpositions-/Datumsreste am Rand
  t = t.replace(/\b(am|bis|um|im|zum)\s*$/i, '').replace(/^\s*(am|bis|um|im|zum)\b/i, '');
  t = t.replace(/\s+/g, ' ').trim().replace(/^[,\-–:;\s]+|[,\-–:;\s]+$/g, '');
  if (t.length < 2) return '';
  return t.charAt(0).toUpperCase() + t.slice(1);
};
