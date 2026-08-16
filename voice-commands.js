/* ============================================================
   Claytec CRM — Sprachsteuerung Phase 1 (Batch 9, 2026-08)
   Additiv: baut AUF der bestehenden Web-Speech-Erkennung auf (wie
   CRM.speech), aber als echter "Befehl"-Modus statt reinem Diktat.
   Kein Backend, kein LLM — vollständig lokal/regelbasiert (Phase 1).

   Ablauf: Mikrofon (Push-to-Talk) -> Text -> CRM.voice.parseUtterance()
   zerlegt in Teilbefehle -> CRM.voice.confirmAndExecute() zeigt IMMER
   eine Vorschau (Chris-Entscheidung 2026-08-13: jeder Befehl wird vor
   Ausführung bestätigt, auch wenn eindeutig) -> erst nach Klick auf
   "Ausführen" werden die echten CRM.*-Funktionen aufgerufen.

   Mehrfachbefehle in einem Satz sind der Normalfall (nicht die
   Ausnahme) — siehe die 7 echten Chris-Beispielsätze in der Spec.
   Ein bereits im Satz aufgelöster Kontakt gilt als Kontext für
   nachfolgende Teilbefehle ohne eigene Namensnennung (z.B. "neue
   Notiz" nach "Besuch bei X" bezieht sich auf X). Das wird über eine
   GETEILTE Objektreferenz gelöst: abhängige Befehle zeigen auf
   dasselbe resolution-Objekt wie ihr Kontext-Befehl — wählt Chris in
   der Vorschau später einen Kandidaten aus, aktualisieren sich alle
   davon abhängigen Zeilen automatisch mit.

   Phase-1-Umfang (nur bereits vorhandene, geprüfte Funktionen):
   Besuch anlegen (CRM.addVisit) · Notiz hinzufügen (CRM.db.addJournalEntry)
   · Muster-Dialog öffnen (CRM.muster.open) · Kontakt<->Kontakt verknüpfen
   (CRM.linkContacts) · Kontakt<->Projekt verknüpfen (CRM.linkContactToProject)
   · Aufgabe anlegen (CRM.db.addTask). Sätze, die eine noch nicht
   existierende Funktion bräuchten (z.B. "Aufbau schicken an...",
   "Richtpreise schicken an..."), werden NICHT halb ausgeführt oder
   geraten, sondern klar als "das kann ich noch nicht" markiert.
   Löschen gibt es in Phase 1 nicht — ein evtl. erkannter Löschen-Wunsch
   würde ebenfalls nur als "nicht unterstützt" markiert, nie ausgeführt
   (aktuell gibt es dafür noch kein eigenes Trigger-Muster).
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.voice = {
  _pending: null,        // aktuell zur Bestätigung anstehende Befehle (Array), s. confirmAndExecute
  _rec: null,             // aktive SpeechRecognition-Instanz (Befehl-Modus, unabhängig von CRM.speech)
  _active: false,
  _lastTranscript: '',
};

/* ============================================================
   Trigger-Erkennung (tolerant gegenüber ASR-Verhörern, siehe Spec:
   "Bausteinbesuch"/"Baustellenbesuch" für "Baustellenbesuch").
   \b am Anfang verhindert, dass z.B. "...lassbesuch bei" (mitten in
   einem anderen Wort) fälschlich anschlägt.
   ============================================================ */
CRM.voice._TRIGGERS = [
  { type: 'visit', re: /\b(?:neuer\s+)?(?:(?:baustellen|bau\s*stein(?:en)?)\s*)?besuch\s+bei\b/gi },
  { type: 'note', re: /\bneue\s+notiz\b\s*:?/gi },
  { type: 'muster', re: /\bmuster\s+(?:versenden|schicken|senden)\b/gi },
  { type: 'task', re: /\baufgabe\s*:\s*/gi },
];

/* "Verknüpfen"-Muster ist ein Sonderfall: das linke Ziel steht VOR dem
   Auslösewort, nicht danach wie bei den übrigen Triggern — braucht
   deshalb eine eigene Erkennung (siehe CRM.voice.parseUtterance). */
CRM.voice._LINK_RE = /\bverkn(?:ü|ue)pfen\s+mit\s+(?:der\s+|dem\s+)?(firma\s+|objekt\s+)?/gi;

/* Satzstück von führender/abschließender Interpunktion & Leerraum befreien */
CRM.voice._cleanClause = function (s) {
  return String(s || '').trim().replace(/^[.,;:\s]+/, '').replace(/[.,;:\s]+$/, '');
};

/* ============================================================
   CRM.voice.parseUtterance(transcript)
   Zerlegt einen (ggf. mehrteiligen) Satz in eine geordnete Liste von
   Teilbefehlen. Jeder Eintrag hat mindestens {intent, rawText, start,
   end}; je nach intent zusätzliche Felder (siehe Kommentare unten).
   Reine Erkennung — löst NICHTS aus, ruft keine CRM.db-Funktion auf
   außer den (lesenden) Such-/Auflösungsfunktionen.
   ============================================================ */
CRM.voice.parseUtterance = function (transcript) {
  const text = String(transcript || '').trim();
  if (!text) return [];

  /* ---- 1) Verknüpfen-Befehle zuerst (Ziel steht vor dem Trigger) ---- */
  const linkMatches = Array.from(text.matchAll(CRM.voice._LINK_RE));
  const linkCmds = [];
  let prevRightEnd = 0;
  linkMatches.forEach((m, i) => {
    const triggerStart = m.index;
    const triggerEnd = m.index + m[0].length;
    const kindWord = (m[1] || '').trim().toLowerCase();
    const rightKind = kindWord.indexOf('objekt') === 0 ? 'project' : 'contact';

    const nextTriggerStart = linkMatches[i + 1] ? linkMatches[i + 1].index : text.length;
    const periodIdx = text.indexOf('.', triggerEnd);
    let rightEnd = nextTriggerStart;
    if (periodIdx !== -1 && periodIdx < rightEnd) rightEnd = periodIdx;
    const rightRaw = CRM.voice._cleanClause(text.slice(triggerEnd, rightEnd));

    let leftStart = prevRightEnd;
    const lastPeriodBefore = text.lastIndexOf('.', triggerStart - 1);
    if (lastPeriodBefore !== -1 && lastPeriodBefore + 1 > leftStart) leftStart = lastPeriodBefore + 1;
    const gapClean = CRM.voice._cleanClause(text.slice(leftStart, triggerStart));
    // Leere Lücke zum vorherigen Befehl = keine eigene Namensnennung ->
    // dieser linke Teil übernimmt den zuletzt aufgelösten Kontakt
    // (siehe Beispiel 4: "...Gersthofen verknüpfen mit Objekt Tanzhaus").
    const useContext = !gapClean;
    const leftRaw = useContext ? null : gapClean.replace(/^(?:firma|objekt)\s+/i, '').trim();

    linkCmds.push({
      intent: 'link', start: leftStart, end: rightEnd,
      rawText: text.slice(leftStart, rightEnd).trim(),
      leftRaw: leftRaw, leftUsesContext: useContext, rightRaw: rightRaw, rightKind: rightKind,
    });
    prevRightEnd = rightEnd;
  });

  /* ---- 2) Verbrauchte Spannen maskieren, damit die generische
     Trigger-Suche unten nicht nochmal hineingreift ---- */
  let masked = text;
  linkCmds.forEach((c) => {
    masked = masked.slice(0, c.start) + ' '.repeat(c.end - c.start) + masked.slice(c.end);
  });

  /* ---- 3) Generische Trigger (Besuch/Notiz/Muster/Aufgabe) ---- */
  const found = [];
  CRM.voice._TRIGGERS.forEach((trig) => {
    const re = new RegExp(trig.re.source, trig.re.flags); // frischer lastIndex pro Aufruf
    let m;
    while ((m = re.exec(masked))) {
      found.push({ type: trig.type, start: m.index, triggerEnd: m.index + m[0].length });
    }
  });
  found.sort((a, b) => a.start - b.start);

  const triggerCmds = found.map((f, i) => {
    let end = found[i + 1] ? found[i + 1].start : text.length;
    // an einer bereits vergebenen Verknüpfen-Spanne stoppen, falls die
    // näher liegt als der nächste generische Trigger
    linkCmds.forEach((lc) => { if (lc.start >= f.triggerEnd && lc.start < end) end = lc.start; });
    const periodIdx = text.indexOf('.', f.triggerEnd);
    if (periodIdx !== -1 && periodIdx < end) end = periodIdx;
    const contentRaw = CRM.voice._cleanClause(text.slice(f.triggerEnd, end));
    return { intent: f.type, start: f.start, end: end, contentRaw: contentRaw, rawText: text.slice(f.start, end).trim() };
  });

  /* ---- 4) Unverbrauchte Reststücke einsammeln (nichts stillschweigend
     verschlucken) — je nachdem ob sie wie ein "senden/schicken"-Wunsch
     aussehen (Phase 1 nicht unterstützt) oder reiner Füllsatz sind. ---- */
  const consumed = linkCmds.map((c) => [c.start, c.end])
    .concat(triggerCmds.map((c) => [c.start, c.end]))
    .sort((a, b) => a[0] - b[0]);
  const unclaimed = [];
  let cursor = 0;
  consumed.forEach(([s, e]) => {
    if (s > cursor) unclaimed.push([cursor, s]);
    cursor = Math.max(cursor, e);
  });
  if (cursor < text.length) unclaimed.push([cursor, text.length]);

  const extraCmds = [];
  unclaimed.forEach(([s, e]) => {
    const chunk = CRM.voice._cleanClause(text.slice(s, e));
    if (!chunk) return;
    const wordCount = chunk.split(/\s+/).filter(Boolean).length;
    if (wordCount < 2 && chunk.length < 6) return; // reines Füllwort ("und", "auf" ...) — keine Info wert
    const looksLikeSend = /\b(schick\w*|send\w*|versend\w*)\b/i.test(chunk);
    extraCmds.push({ intent: looksLikeSend ? 'unsupported' : 'unrecognized', start: s, end: e, rawText: chunk });
  });

  /* ---- 5) In Sprechreihenfolge sortieren ---- */
  const all = linkCmds.concat(triggerCmds, extraCmds).sort((a, b) => a.start - b.start);

  /* ---- 6) Kontakt-/Projekt-Auflösung, in Sprechreihenfolge, damit
     "zuletzt genannter Kontakt" für nachfolgende Befehle ohne eigene
     Namensnennung korrekt weitergereicht wird ---- */
  all.forEach((cmd, idx) => {
    if (cmd.intent === 'visit') {
      cmd.resolution = CRM.voice.resolveContact(cmd.contentRaw, '');
    } else if (cmd.intent === 'note' || cmd.intent === 'muster') {
      cmd.content = cmd.contentRaw;
      cmd.resolution = CRM.voice._contextContact(all, idx)
        || { status: 'notfound', query: '(kein vorheriger Kontakt im Satz erkannt)', contact: null };
    } else if (cmd.intent === 'task') {
      cmd.title = cmd.contentRaw;
    } else if (cmd.intent === 'link') {
      cmd.leftResolution = cmd.leftUsesContext
        ? (CRM.voice._contextContact(all, idx) || { status: 'notfound', query: '(kein vorheriger Kontakt im Satz erkannt)', contact: null })
        : CRM.voice.resolveContact(cmd.leftRaw, '');
      cmd.rightResolution = cmd.rightKind === 'project'
        ? CRM.voice.resolveProject(cmd.rightRaw, '')
        : CRM.voice.resolveContact(cmd.rightRaw, '');
    }
  });

  return all;
};

/* Sucht rückwärts den nächstgelegenen Befehl, der bereits einen
   Kontakt "mitbringt" (Besuch, oder die rechte Seite einer
   Kontakt-Verknüpfung) — gibt dessen resolution-OBJEKT (per Referenz)
   zurück, damit eine spätere Auswahl in der Vorschau automatisch auch
   hierher durchschlägt. */
CRM.voice._contextContact = function (all, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    const c = all[i];
    if (c.intent === 'visit' && c.resolution) return c.resolution;
    if (c.intent === 'link' && c.rightKind === 'contact' && c.rightResolution) return c.rightResolution;
  }
  return null;
};

/* ============================================================
   Kontakt-/Projekt-Auflösung — nutzt die bestehenden Such-Rangfolgen
   (CRM.contactQueryMatch / CRM.projectQueryMatch), erfindet keine
   eigene Fuzzy-Logik. Nie raten: 0 Treffer -> notfound, >1 Treffer ->
   ambiguous (Auswahl in der Vorschau), niemals automatisch der erste.
   ============================================================ */
CRM.voice.resolveContact = function (nameHint, locationHint) {
  const name = String(nameHint || '').trim();
  const loc = String(locationHint || '').trim();
  const combined = (name + (loc ? ' ' + loc : '')).trim();
  if (!combined) return { status: 'notfound', query: combined, contact: null };
  const contacts = CRM.db.getContacts();

  let matches = contacts.filter((c) => CRM.contactQueryMatch(combined, c));
  if (matches.length === 1) return { status: 'resolved', contact: matches[0], query: combined };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches.slice(0, 8), query: combined };

  // 0 Treffer mit der vollen Phrase (z.B. weil ein Straßenname nicht
  // exakt im Bestand steht) — schrittweise vom Ende her verkürzen und
  // den Rest nur noch als Orts-/Straßen-Filter (Substring) behandeln.
  const tokens = combined.split(/\s+/).filter(Boolean);
  for (let cut = tokens.length - 1; cut >= 1; cut--) {
    const namePart = tokens.slice(0, cut).join(' ');
    const rest = tokens.slice(cut).join(' ');
    let m2 = contacts.filter((c) => CRM.contactQueryMatch(namePart, c));
    if (!m2.length) continue;
    if (rest) {
      const rn = CRM.searchNorm(rest);
      const filtered = m2.filter((c) => CRM.searchNorm(c.ort || '').includes(rn) || CRM.searchNorm(c.strasse || '').includes(rn));
      if (filtered.length) m2 = filtered;
    }
    if (m2.length === 1) return { status: 'resolved', contact: m2[0], query: combined };
    if (m2.length > 1) return { status: 'ambiguous', candidates: m2.slice(0, 8), query: combined };
  }
  return { status: 'notfound', query: combined, contact: null };
};

CRM.voice.resolveProject = function (nameHint, locationHint) {
  const name = String(nameHint || '').trim();
  const loc = String(locationHint || '').trim();
  const combined = (name + (loc ? ' ' + loc : '')).trim();
  if (!combined) return { status: 'notfound', query: combined, project: null };
  const projects = CRM.db.getProjects();

  let matches = projects.filter((p) => CRM.projectQueryMatch(combined, p));
  if (matches.length === 1) return { status: 'resolved', project: matches[0], query: combined };
  if (matches.length > 1) return { status: 'ambiguous', candidates: matches.slice(0, 8), query: combined };

  const tokens = combined.split(/\s+/).filter(Boolean);
  for (let cut = tokens.length - 1; cut >= 1; cut--) {
    const namePart = tokens.slice(0, cut).join(' ');
    const rest = tokens.slice(cut).join(' ');
    let m2 = projects.filter((p) => CRM.projectQueryMatch(namePart, p));
    if (!m2.length) continue;
    if (rest) {
      const rn = CRM.searchNorm(rest);
      const filtered = m2.filter((p) => CRM.searchNorm(p.ort || '').includes(rn));
      if (filtered.length) m2 = filtered;
    }
    if (m2.length === 1) return { status: 'resolved', project: m2[0], query: combined };
    if (m2.length > 1) return { status: 'ambiguous', candidates: m2.slice(0, 8), query: combined };
  }
  return { status: 'notfound', query: combined, project: null };
};

/* ============================================================
   Anzeige-Helfer (deutsche Kurzbeschreibung je Treffer)
   ============================================================ */
CRM.voice._contactLabel = function (c) {
  return (CRM.displayNameDisambig ? CRM.displayNameDisambig(c) : c.firma1) || '?';
};
CRM.voice._projectLabel = function (p) {
  return (((p.kategorie || 'baustelle') === 'gross') ? '🏢 ' : '🏠 ') + (p.name || '?');
};
CRM.voice._resDesc = function (res, kind) {
  if (!res) return '?';
  if (res.status === 'resolved') {
    return esc(kind === 'project' ? CRM.voice._projectLabel(res.project) : CRM.voice._contactLabel(res.contact));
  }
  if (res.status === 'ambiguous') return '„' + esc(res.query) + '" — mehrdeutig, bitte auswählen';
  return '„' + esc(res.query) + '" — nicht gefunden';
};

/* ============================================================
   CRM.voice.buildPreview(commands) — verständliche deutsche
   Zusammenfassung je Teilbefehl + Korrektur-Auswahl bei Mehrdeutigkeit.
   ============================================================ */
CRM.voice.buildPreview = function (commands) {
  if (!commands || !commands.length) {
    return '<p style="color:var(--text-dim)">Ich habe keinen Befehl erkannt. Beispiel: „Neuer Besuch bei [Firma]" oder „Aufgabe: ...".</p>';
  }
  let n = 0;
  const rows = commands.map((cmd, idx) => {
    if (cmd.intent === 'unrecognized') {
      return '<div class="voice-cmd voice-cmd-muted" data-idx="' + idx + '">'
        + '<span class="voice-cmd-badge">–</span>'
        + '<div class="voice-cmd-body"><div class="voice-cmd-desc">„' + esc(cmd.rawText) + '" — nicht zugeordnet, wird ignoriert.</div></div>'
        + '</div>';
    }
    n++;
    if (cmd.intent === 'unsupported') {
      return '<div class="voice-cmd voice-cmd-blocked" data-idx="' + idx + '">'
        + '<span class="voice-cmd-badge">✕</span>'
        + '<div class="voice-cmd-body"><div class="voice-cmd-desc"><strong>' + n + '.</strong> „' + esc(cmd.rawText) + '" — das kann ich noch nicht (diese Funktion gibt es in der App noch nicht, Phase 1 unterstützt nur Anlegen/Verknüpfen bereits vorhandener Funktionen).</div></div>'
        + '</div>';
    }
    return CRM.voice._cmdRowHtml(cmd, idx, n);
  }).join('');
  return '<ol class="voice-cmd-list" style="list-style:none;padding:0;margin:0">' + rows + '</ol>';
};

CRM.voice._candListHtml = function (res, idx, side, kind) {
  if (!res || res.status !== 'ambiguous') return '';
  const rowsHtml = (res.candidates || []).map((x) => {
    const label = kind === 'project' ? CRM.voice._projectLabel(x) : CRM.voice._contactLabel(x);
    const sub = kind === 'project' ? [x.plz, x.ort].filter(Boolean).join(' ') : [x.plz, x.ort].filter(Boolean).join(' ');
    return '<div class="header-search-item voice-cand-row" data-id="' + x.id + '">'
      + '<strong>' + esc(label) + '</strong>'
      + '<span style="color:var(--text-dim);font-size:12px"> · ' + esc(sub) + '</span>'
      + '</div>';
  }).join('');
  return '<div class="voice-cand-list" data-idx="' + idx + '" data-side="' + side + '" data-kind="' + kind + '">'
    + '<div class="voice-cand-hint">Mehrere Treffer für „' + esc(res.query) + '" — bitte wählen:</div>'
    + rowsHtml
    + '</div>';
};

CRM.voice._cmdRowHtml = function (cmd, idx, num) {
  let desc = '';
  let candidatesHtml = '';
  let ready = true;
  const check = (res) => { if (!res || res.status !== 'resolved') ready = false; };

  if (cmd.intent === 'visit') {
    desc = 'Besuch anlegen bei <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong> — heute';
    check(cmd.resolution);
    candidatesHtml += CRM.voice._candListHtml(cmd.resolution, idx, 'target', 'contact');
  } else if (cmd.intent === 'note') {
    desc = 'Notiz hinzufügen bei <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong>'
      + (cmd.content ? ': „' + esc(cmd.content) + '"' : ' <span style="color:var(--text-dim)">(kein Text erkannt)</span>');
    check(cmd.resolution);
    candidatesHtml += CRM.voice._candListHtml(cmd.resolution, idx, 'target', 'contact');
  } else if (cmd.intent === 'muster') {
    desc = '📦 Muster-Dialog öffnen für <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong>';
    check(cmd.resolution);
    candidatesHtml += CRM.voice._candListHtml(cmd.resolution, idx, 'target', 'contact');
  } else if (cmd.intent === 'task') {
    const title = cmd.title || '';
    if (!title) ready = false;
    desc = title ? 'Aufgabe anlegen: „' + esc(title) + '" — fällig heute' : 'Aufgabe erkannt, aber kein Aufgabentext gefunden';
  } else if (cmd.intent === 'link') {
    desc = '<strong>' + CRM.voice._resDesc(cmd.leftResolution, 'contact') + '</strong> verknüpfen mit '
      + (cmd.rightKind === 'project' ? 'Projekt ' : '')
      + '<strong>' + CRM.voice._resDesc(cmd.rightResolution, cmd.rightKind) + '</strong>';
    check(cmd.leftResolution);
    check(cmd.rightResolution);
    candidatesHtml += CRM.voice._candListHtml(cmd.leftResolution, idx, 'left', 'contact');
    candidatesHtml += CRM.voice._candListHtml(cmd.rightResolution, idx, 'right', cmd.rightKind);
  }

  const cls = ready ? 'voice-cmd-ready' : 'voice-cmd-ambiguous';
  return '<div class="voice-cmd ' + cls + '" data-idx="' + idx + '">'
    + '<span class="voice-cmd-badge">' + (ready ? '✓' : '?') + '</span>'
    + '<div class="voice-cmd-body"><div class="voice-cmd-desc"><strong>' + num + '.</strong> ' + desc + '</div>' + candidatesHtml + '</div>'
    + '</div>';
};

/* ============================================================
   CRM.voice.confirmAndExecute(commands, rawText)
   EIN Bestätigungsdialog (CRM.openModal, dismissible:false — kein
   natives confirm()!) mit allen erkannten Teilbefehlen. Erst nach
   Klick auf "Ausführen" werden die echten CRM.*-Funktionen gerufen.
   ============================================================ */
CRM.voice.confirmAndExecute = function (commands, rawText) {
  CRM.voice._pending = commands || [];
  if (rawText !== undefined) CRM.voice._lastTranscript = rawText;
  CRM.voice._renderConfirmModal();
};

CRM.voice._renderConfirmModal = function () {
  const commands = CRM.voice._pending || [];
  const html = '<h2>🎤 Sprachbefehl bestätigen</h2>'
    + '<p style="color:var(--text-dim);font-size:13px">Erkannter Text: „' + esc(CRM.voice._lastTranscript || '') + '"</p>'
    + CRM.voice.buildPreview(commands)
    + '<div class="modal-footer">'
    + '<button class="btn" onclick="CRM.voice.cancelPreview()">✕ Abbrechen</button>'
    + '<button class="btn btn-primary" onclick="CRM.voice.executeConfirmed()">✓ Ausführen</button>'
    + '</div>';
  CRM.openModal(html, { dismissible: false });
  CRM.voice._wirePreviewCandidates();
};

CRM.voice._wirePreviewCandidates = function () {
  document.querySelectorAll('.voice-cand-row').forEach((row) => {
    // BEWUSST 'click', NICHT 'pointerdown' (Opus-Review-Korrektur, 2026-08):
    // CRM.voice._pickCandidate ruft CRM.openModal() erneut auf, was das
    // GESAMTE Modal-DOM entfernt und NEU aufbaut (nicht nur verschiebt wie
    // beim windows.js-Fall, auf den sich die vorherige Begründung bezog).
    // Auf 'pointerdown' verdrahtet, riss das den Dialog schon WÄHREND der
    // Klick-Geste ab — das nachfolgende Loslassen (mouseup/click) landete
    // dann auf einem BELIEBIGEN Element der frisch aufgebauten Seite (im
    // Test: versehentlich "Abbrechen"). Bei echten Mausklicks wäre das
    // genauso passiert. 'click' feuert als LETZTES Ereignis der Geste — bis
    // dahin ist die Original-Seite stabil, das DOM wird erst danach
    // ausgetauscht. (Die pointerdown-Regel bleibt korrekt für Fälle, in
    // denen ein Element per appendChild nur VERSCHOBEN wird, siehe
    // windows.js — hier ist es aber ein voller DOM-Neubau, ein anderer Fall.)
    row.addEventListener('click', (e) => {
      e.preventDefault();
      const list = row.closest('.voice-cand-list');
      if (!list) return;
      CRM.voice._pickCandidate(parseInt(list.dataset.idx, 10), list.dataset.side, list.dataset.kind, row.dataset.id);
    });
  });
};

CRM.voice._pickCandidate = function (idx, side, kind, id) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  const entity = kind === 'project' ? CRM.db.getProject(id) : CRM.db.getContact(id);
  if (!entity) return;
  let res;
  if (side === 'left') res = cmd.leftResolution;
  else if (side === 'right') res = cmd.rightResolution;
  else res = cmd.resolution;
  if (!res) return;
  res.status = 'resolved';
  res.candidates = null;
  if (kind === 'project') res.project = entity; else res.contact = entity;
  // Neu zeichnen: dank geteilter Objekt-Referenz aktualisieren sich
  // davon abhängige Zeilen (z.B. "neue Notiz" nach diesem Besuch) mit.
  CRM.voice._renderConfirmModal();
};

CRM.voice.cancelPreview = function () {
  CRM.voice._pending = null;
  CRM.closeModal();
};

/* ---------- Ausführen: nur Befehle, deren Auflösung vollständig ist.
   Nie raten, nie bei 0/>1 Treffer ohne Klärung ausführen. Löschen gibt
   es in Phase 1 nicht — dafür existiert ohnehin kein Trigger. ---------- */
CRM.voice.executeConfirmed = function () {
  const commands = CRM.voice._pending || [];
  let done = 0;
  let skipped = 0;
  let musterTarget = null; // Muster-Dialog erst NACH allen anderen Aktionen öffnen (nur 1 Modal gleichzeitig)

  commands.forEach((cmd) => {
    if (cmd.intent === 'unrecognized') return;
    if (cmd.intent === 'unsupported') { skipped++; return; }

    if (cmd.intent === 'visit') {
      if (cmd.resolution && cmd.resolution.status === 'resolved') {
        CRM.addVisit(cmd.resolution.contact.id, null, '');
        done++;
      } else skipped++;
    } else if (cmd.intent === 'note') {
      if (cmd.resolution && cmd.resolution.status === 'resolved') {
        CRM.db.addJournalEntry({
          contactId: cmd.resolution.contact.id,
          entryType: 'info',
          content: cmd.content || '(per Sprachbefehl angelegt, ohne weiteren Text)',
          inputMethod: 'voice-command',
        });
        done++;
      } else skipped++;
    } else if (cmd.intent === 'muster') {
      if (cmd.resolution && cmd.resolution.status === 'resolved') {
        musterTarget = cmd.resolution.contact.id;
        done++;
      } else skipped++;
    } else if (cmd.intent === 'task') {
      if (cmd.title) {
        CRM.db.addTask({ title: cmd.title, due: CRM.ymd(new Date()), contactId: null });
        done++;
      } else skipped++;
    } else if (cmd.intent === 'link') {
      const lr = cmd.leftResolution;
      const rr = cmd.rightResolution;
      if (lr && lr.status === 'resolved' && rr && rr.status === 'resolved') {
        if (cmd.rightKind === 'project') CRM.linkContactToProject(lr.contact.id, rr.project.id);
        else CRM.linkContacts(lr.contact.id, rr.contact.id);
        done++;
      } else skipped++;
    }
  });

  CRM.voice._pending = null;
  CRM.closeModal();
  if (done) {
    CRM.toast('✓ ' + done + ' Sprachbefehl(e) ausgeführt' + (skipped ? ', ' + skipped + ' übersprungen (nicht eindeutig/nicht unterstützt)' : '') + '.', 'success');
  } else {
    CRM.toast('Kein Befehl konnte ausgeführt werden.', 'error');
  }
  if (CRM._refreshAllVisibleViews) CRM._refreshAllVisibleViews();
  if (musterTarget) CRM.muster.open(musterTarget); // erst jetzt, damit CRM.openModal nicht vorher schon wieder schließt
};

/* ============================================================
   Mikrofon-Einstieg: Push-to-Talk-Aufnahme-Dialog (eigener
   "Befehl"-Modus, nutzt dieselbe Web Speech API wie CRM.speech, aber
   kein Dauer-Zuhören — nur solange die Aufnahme aktiv läuft).
   ============================================================ */
CRM.voice.webSpeechAvailable = function () {
  return !!(window.SpeechRecognition || window.webkitSpeechRecognition);
};

CRM.voice.openCapture = function () {
  CRM.voice._pending = null;
  CRM.voice._lastTranscript = '';
  CRM.openModal(`
    <h2>🎤 Sprachbefehl</h2>
    <p style="color:var(--text-dim);font-size:13px">Push-to-Talk: Aufnahme starten, sprechen, stoppen. Text bei Bedarf korrigieren, dann prüfen — jeder erkannte Befehl wird danach einzeln bestätigt, bevor etwas gespeichert wird.</p>
    <div id="voice-status" class="speech-status">Bereit.</div>
    <div style="margin:12px 0">
      <label>Erkannter Text</label>
      <textarea id="voice-transcript" rows="3" placeholder="Hier erscheint die Transkription..."></textarea>
    </div>
    <div class="row" style="margin-top:10px;gap:8px;flex-wrap:wrap">
      <button class="btn btn-primary" id="voice-rec-btn" onclick="CRM.voice.toggleRecord()">● Aufnahme starten</button>
      <button class="btn" onclick="CRM.voice.closeCaptureDialog()">Abbrechen</button>
      <button class="btn btn-primary" style="margin-left:auto" onclick="CRM.voice.reviewFromCapture()">Befehle prüfen →</button>
    </div>
  `, { dismissible: false });
};

CRM.voice.closeCaptureDialog = function () {
  CRM.voice.stop();
  CRM.closeModal();
};

CRM.voice.setStatus = function (txt, cls) {
  const el = document.getElementById('voice-status');
  if (el) { el.textContent = txt; el.className = 'speech-status' + (cls ? ' ' + cls : ''); }
};

CRM.voice.toggleRecord = function () {
  if (CRM.voice._active) { CRM.voice.stop(); return; }
  CRM.voice.start();
};

CRM.voice.start = function () {
  if (!CRM.voice.webSpeechAvailable()) {
    CRM.toast('Web Speech API in diesem Browser nicht verfügbar. Nutze Chrome/Edge.', 'error');
    return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const rec = new SR();
  rec.lang = 'de-DE';
  rec.interimResults = true;
  rec.continuous = true; // läuft nur während der aktiven Aufnahme — kein Dauer-Zuhören im Hintergrund
  CRM.voice._rec = rec;
  CRM.voice._active = true;
  CRM.voice._updateRecBtn(true);
  CRM.voice.setStatus('🔴 Aufnahme läuft… sprich jetzt.', 'rec');

  let finalText = '';
  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t + ' ';
      else interim += t;
    }
    const full = (finalText + interim).trim();
    const ta = document.getElementById('voice-transcript');
    if (ta) ta.value = full;
    CRM.voice._lastTranscript = full;
  };
  rec.onerror = (e) => {
    CRM.voice.setStatus('Fehler: ' + e.error, 'err');
    CRM.voice._active = false;
    CRM.voice._updateRecBtn(false);
  };
  rec.onend = () => {
    CRM.voice._active = false;
    CRM.voice._updateRecBtn(false);
    if (document.getElementById('voice-status')) CRM.voice.setStatus('Aufnahme beendet. Text prüfen und auf „Befehle prüfen" tippen.', '');
  };
  rec.start();
};

CRM.voice.stop = function () {
  if (CRM.voice._rec && CRM.voice._active) {
    try { CRM.voice._rec.stop(); } catch (e) { /* bereits beendet */ }
  }
  CRM.voice._active = false;
};

CRM.voice._updateRecBtn = function (active) {
  const btn = document.getElementById('voice-rec-btn');
  if (!btn) return;
  btn.textContent = active ? '⬛ Aufnahme stoppen' : '● Aufnahme starten';
};

CRM.voice.reviewFromCapture = function () {
  const ta = document.getElementById('voice-transcript');
  const text = ta ? ta.value.trim() : (CRM.voice._lastTranscript || '').trim();
  CRM.voice.stop();
  if (!text) { CRM.toast('Kein Text erkannt.', 'error'); return; }
  const commands = CRM.voice.parseUtterance(text);
  CRM.voice.confirmAndExecute(commands, text);
};

/* ---------- Mikrofon-Einstiege verdrahten ----------
   (a) auffälliger Button auf der Startseite: siehe dashboard.js
       (dash-actions, ruft direkt CRM.voice.openCapture() auf).
   (b) kleiner, von jedem Tab erreichbarer Einstieg: Desktop-Kopfzeile
       (#btn-voice-command) + mobiler FAB (#fab-voice), beide hier
       verdrahtet, defensiv falls Elemente fehlen. */
document.addEventListener('DOMContentLoaded', () => {
  const fabVoice = document.getElementById('fab-voice');
  if (fabVoice) fabVoice.addEventListener('click', () => CRM.voice.openCapture());
  const btnVoice = document.getElementById('btn-voice-command');
  if (btnVoice) btnVoice.addEventListener('click', () => CRM.voice.openCapture());
});
