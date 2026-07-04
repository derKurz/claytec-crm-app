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
CRM.speech.showPostSaveActions = function (contactId, visit) {
  const c = CRM.db.getContact(contactId);
  const excelBtn = visit
    ? `<button class="btn btn-primary" style="justify-content:center;padding:14px" onclick='CRM.ablage.openDialog("${contactId}", ${JSON.stringify(visit).replace(/'/g, '&#39;')})'>📋 In Excel ablegen</button>`
    : '';
  CRM.openModal(`
    <h2 style="margin-top:0">✓ Gespeichert${c ? ' — ' + esc(c.firma1) : ''}</h2>
    <div class="row" style="flex-direction:column;gap:10px;margin-top:10px">
      ${excelBtn}
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.openContactDetail('${contactId}')">→ Kontakt öffnen</button>
      <button class="btn" style="justify-content:center;padding:14px" onclick="CRM.closeModal()">Fertig</button>
    </div>
  `);
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
  CRM.speech.showPostSaveActions(id, null);
};
