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
  // "anlegen"/"erstellen" zwischen "Besuch" und "bei" toleriert (Chris-
  // Beispiel 2026-08: "Besuch ANLEGEN bei ..." schlug bisher komplett fehl
  // und riss den kompletten Satzrest mit in den unrecognized-Topf).
  // Zweite Auslöser-Variante "war (heute/gerade/...) bei" (Chris: "das ist
  // normaler Sprachgebrauch, wichtig") — beim 30-Satz-Testlauf gefunden:
  // "War heute bei Erdraum..." fiel bisher KOMPLETT in unrecognized, weil
  // nur "Besuch bei" als Auslöser galt. "ich" davor optional.
  { type: 'visit', re: /\b(?:neuer\s+)?(?:(?:baustellen|bau\s*stein(?:en)?)\s*)?besuch\s*(?:anlegen\s+|erstellen\s+)?bei\b|\b(?:ich\s+)?war\s+(?:heute\s+|gerade\s+|eben\s+|vorhin\s+|kurz\s+)?bei\b/gi },
  { type: 'note', re: /\bneue\s+notiz\b\s*:?/gi },
  { type: 'muster', re: /\bmuster\s+(?:versenden|schicken|senden)\b/gi },
  // "Aufgabe für Firma Meier: ..." — der optionale Teil in der Klammer
  // fängt den Kontaktnamen ein (Gruppe 1), damit die Aufgabe direkt beim
  // richtigen Kontakt landet statt als "Allgemeine Aufgabe".
  { type: 'task', re: /\baufgabe\s*(?:f(?:ü|ue)r\s+(?:die\s+|den\s+)?(?:firma\s+)?([^:]{2,60}?)\s*)?:\s*/gi },
  // Chris (2026-08): "ich will Projekte genauso per Sprache anlegen,
  // bearbeiten und mit Kontakten verknüpfen können." Verknüpfen gab es
  // bereits (Sonderfall unten, "verknüpfen mit Objekt"). Neu: anlegen
  // ("Projekt anlegen: Name, Ort" — optional "...für Firma X" verknüpft
  // gleich mit) und eine Notiz AM Projekt (nicht am Kontakt).
  { type: 'projectcreate', re: /\b(?:neues\s+)?(?:projekt|bauvorhaben)\s+anlegen\s*:\s*/gi },
  { type: 'projectnote', re: /\bnotiz\s+(?:f(?:ü|ue)r|zu)\s+(?:projekt|bauvorhaben|objekt)\s+([^:]{2,60}?)\s*:\s*/gi },
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
      found.push({ type: trig.type, start: m.index, triggerEnd: m.index + m[0].length, targetRaw: m[1] || null });
    }
  });
  found.sort((a, b) => a.start - b.start);

  // "war bei X UND BEI Y wegen ..." — Chris nennt bei einem gemeinsamen
  // Bauvorhaben öfter zwei Firmen in einem Atemzug ("Ich war heute bei
  // Erdraum und bei Heinrich Schmid wegen Bauvorhaben Tanzhaus
  // Donauwörth."). Ohne Aufteilung würde die komplette Spanne als EIN
  // Name gesucht — Y verschwindet dann spurlos (verschluckt vom
  // Wortstamm-Fallback in resolveContact, der Y als bloßen Reststring
  // ignoriert). Nur bei intent 'visit' relevant: die anderen Trigger
  // (Notiz/Muster/Aufgabe) beziehen sich ohnehin nur auf EINEN Kontakt.
  const VISIT_CHAIN_RE = /\s+und\s+bei\s+/gi;
  // "...wegen Bauvorhaben/BV/Objekt/Projekt X" am Ende eines Besuch-Satzes:
  // Chris (2026-08) — "bei Projekten ist es wichtig, alle Eintragungen
  // aller beteiligten Unternehmen an einer Stelle zu sehen". Die Projekt-
  // Zeitleiste (CRM.renderProjectTimeline) liest bereits p.contactIds und
  // zeigt automatisch alle Besuche verknüpfter Kontakte — es fehlte nur
  // die Verknüpfung selbst. Gilt für JEDEN Besuch der ganzen Kette (ein
  // gemeinsam genanntes Bauvorhaben betrifft alle genannten Firmen).
  const PROJECT_CLAUSE_RE = /\s*wegen\s+(?:des\s+|dem\s+|der\s+)?(?:bauvorhabens?|bv|objekts?|projekts?)\s+(.+)$/i;
  const triggerCmds = found.map((f, i) => {
    let end = found[i + 1] ? found[i + 1].start : text.length;
    // an einer bereits vergebenen Verknüpfen-Spanne stoppen, falls die
    // näher liegt als der nächste generische Trigger
    linkCmds.forEach((lc) => { if (lc.start >= f.triggerEnd && lc.start < end) end = lc.start; });
    const periodIdx = text.indexOf('.', f.triggerEnd);
    if (periodIdx !== -1 && periodIdx < end) end = periodIdx;
    const contentRaw = CRM.voice._cleanClause(text.slice(f.triggerEnd, end));
    const rawText = text.slice(f.start, end).trim();

    if (f.type === 'visit') {
      const projMatch = contentRaw.match(PROJECT_CLAUSE_RE);
      const contentOhneProjekt = projMatch ? CRM.voice._cleanClause(contentRaw.slice(0, projMatch.index)) : contentRaw;
      // GETEILTE Referenz (bewusst, anders als bei Kontakt-Zuordnungen):
      // ein gemeinsam genanntes Bauvorhaben ist dieselbe Sache für alle
      // Besuche der Kette — wählt Chris später ein anderes Projekt, soll
      // sich das bei allen betroffenen Zeilen mit aktualisieren.
      const projectResolution = projMatch ? CRM.voice.resolveProject(projMatch[1], '') : null;
      const teile = contentOhneProjekt.split(VISIT_CHAIN_RE).map((p) => CRM.voice._cleanClause(p)).filter(Boolean);
      const namen = teile.length ? teile : [contentOhneProjekt];
      return namen.map((p) => ({ intent: 'visit', start: f.start, end: end, contentRaw: p, rawText: rawText, projectResolution: projectResolution }));
    }
    return [{ intent: f.type, start: f.start, end: end, contentRaw: contentRaw, targetRaw: f.targetRaw || null, rawText: rawText }];
  }).flat();

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
      if (cmd.targetRaw) {
        // Ausdrücklich genannt ("Aufgabe für Meier: ...") — muss auch
        // aufgelöst werden, sonst darf der Befehl nicht durchlaufen.
        cmd.targetExplicit = true;
        cmd.resolution = CRM.voice.resolveContact(cmd.targetRaw, '');
      } else {
        // Nicht genannt: den zuletzt im Satz aufgelösten Kontakt als
        // VORSCHLAG übernehmen ("Besuch bei X. Aufgabe: ..." gehört fast
        // immer zu X). Bewusst eine KOPIE, keine geteilte Referenz wie bei
        // Notiz/Muster: dort hat Chris den Bezug ausgesprochen, hier raten
        // wir ihn. Eine Korrektur an der Aufgabe darf deshalb nicht den
        // Besuch mitverändern (gleiche Falle wie bei _promoteUnrecognized).
        cmd.targetExplicit = false;
        const ctx = CRM.voice._contextContact(all, idx);
        cmd.resolution = ctx ? Object.assign({}, ctx) : null;
      }
    } else if (cmd.intent === 'link') {
      cmd.leftResolution = cmd.leftUsesContext
        ? (CRM.voice._contextContact(all, idx) || { status: 'notfound', query: '(kein vorheriger Kontakt im Satz erkannt)', contact: null })
        : CRM.voice.resolveContact(cmd.leftRaw, '');
      cmd.rightResolution = cmd.rightKind === 'project'
        ? CRM.voice.resolveProject(cmd.rightRaw, '')
        : CRM.voice.resolveContact(cmd.rightRaw, '');
    } else if (cmd.intent === 'projectcreate') {
      // "Tanzhaus, Donauwörth für Kraftbaustoffe" -> Name, Ort, optional
      // direkt verknüpfter Kontakt (Chris: "Projekt anlegen UND mit
      // Kontakt verknüpfen in einem Satz").
      const fMatch = cmd.contentRaw.match(/\s+für\s+(?:firma\s+|kontakt\s+)?(.+)$/i);
      const ohneFuer = fMatch ? CRM.voice._cleanClause(cmd.contentRaw.slice(0, fMatch.index)) : cmd.contentRaw;
      const kommaIdx = ohneFuer.indexOf(',');
      cmd.name = CRM.voice._cleanClause(kommaIdx === -1 ? ohneFuer : ohneFuer.slice(0, kommaIdx));
      cmd.ort = kommaIdx === -1 ? '' : CRM.voice._cleanClause(ohneFuer.slice(kommaIdx + 1));
      cmd.linkTargetRaw = fMatch ? fMatch[1] : null;
      cmd.linkResolution = cmd.linkTargetRaw ? CRM.voice.resolveContact(cmd.linkTargetRaw, '') : null;
      // Warnt (blockiert aber nicht) vor einem Namensdoppel — genau das
      // würde die von Chris gewünschte "alle Aktivitäten an einer Stelle"-
      // Übersicht aufspalten, wenn aus Versehen ein zweites Projekt mit
      // demselben Namen entsteht.
      cmd.duplicateOf = cmd.name
        ? CRM.db.getProjects().find((p) => CRM.searchNorm(p.name) === CRM.searchNorm(cmd.name))
        : null;
    } else if (cmd.intent === 'projectnote') {
      cmd.content = cmd.contentRaw;
      cmd.projectResolution = CRM.voice.resolveProject(cmd.targetRaw, '');
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
      // Chris-Feedback (2026-08): Text, der keinem Trigger-Wort zugeordnet
      // werden konnte, wurde bisher stillschweigend ignoriert ("wird
      // ignoriert") ohne jede Möglichkeit, ihn nachträglich doch noch einer
      // Notiz/Aufgabe zuzuordnen. Jetzt gibt's dafür zwei Buttons, die den
      // Rohtext in einen echten (danach normal bearbeitbaren) Teilbefehl
      // umwandeln, statt ihn zu verwerfen.
      return '<div class="voice-cmd voice-cmd-muted" data-idx="' + idx + '">'
        + '<span class="voice-cmd-badge">–</span>'
        + '<div class="voice-cmd-body"><div class="voice-cmd-desc">„' + esc(cmd.rawText) + '" — nicht zugeordnet.</div>'
        + '<div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">'
        + '<button class="btn btn-sm" onclick="CRM.voice._promoteUnrecognized(' + idx + ',\'note\')">→ als Notiz verwenden</button>'
        + '<button class="btn btn-sm" onclick="CRM.voice._promoteUnrecognized(' + idx + ',\'task\')">→ als Aufgabe verwenden</button>'
        + '<button class="btn btn-sm" onclick="CRM.voice._promoteToContact(' + idx + ')" title="Adresse/Signatur erkennen und Kontakt suchen oder anlegen">📇 als Kontakt anlegen</button>'
        + '</div></div>'
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

CRM.voice._candRowHtml = function (x, kind) {
  const label = kind === 'project' ? CRM.voice._projectLabel(x) : CRM.voice._contactLabel(x);
  const sub = [x.plz, x.ort].filter(Boolean).join(' ');
  return '<div class="header-search-item voice-cand-row" data-id="' + x.id + '">'
    + '<strong>' + esc(label) + '</strong>'
    + '<span style="color:var(--text-dim);font-size:12px"> · ' + esc(sub) + '</span>'
    + '</div>';
};

/* Chris-Feedback (2026-08): bei 0 Treffern ("notfound") gab es bisher GAR
   KEINE Möglichkeit, den Kontakt/das Projekt manuell zuzuordnen — nur eine
   graue, tote Zeile ("nicht gefunden"). Jetzt bekommt jede unvollständige
   Auflösung (notfound UND ambiguous) immer ein Suchfeld dazu, das live
   gegen CRM.contactQueryMatch/projectQueryMatch filtert (dieselbe Logik
   wie überall sonst in der App, keine neue Fuzzy-Suche erfunden).
   Auch bereits AUFGELÖSTE Zeilen bekommen (eingeklappt) dasselbe Suchfeld:
   ein aus dem Satz-Kontext übernommener Kontakt (z.B. bei einer aus
   "nicht zugeordnet" nachträglich erzeugten Notiz) kann falsch sein und
   muss ohne Umweg korrigierbar bleiben. */
CRM.voice._entityPickerHtml = function (res, idx, side, kind) {
  const searchBox = '<input type="text" class="voice-search-input" placeholder="' + (kind === 'project' ? 'Projekt/Baustelle suchen…' : 'Name suchen…') + '" oninput="CRM.voice._onSearchInput(this,' + idx + ',\'' + side + '\',\'' + kind + '\')">'
    + '<div class="voice-search-results"></div>';

  // Gar keine Auflösung (z.B. allgemeine Aufgabe ohne Kontakt): trotzdem
  // ein eingeklapptes Suchfeld anbieten, damit sich nachträglich einer
  // zuordnen lässt — sonst wäre die Zuordnung nur beim Diktieren möglich.
  if (!res) {
    return '<div class="voice-cand-list voice-cand-collapsed" data-idx="' + idx + '" data-side="' + side + '" data-kind="' + kind + '">'
      + '<button type="button" class="btn btn-sm voice-cand-toggle" onclick="this.closest(\'.voice-cand-list\').classList.toggle(\'voice-cand-collapsed\')">＋ Kontakt zuordnen</button>'
      + '<div class="voice-cand-toggle-body">' + searchBox + '</div>'
      + '</div>';
  }

  if (res.status === 'resolved') {
    return '<div class="voice-cand-list voice-cand-collapsed" data-idx="' + idx + '" data-side="' + side + '" data-kind="' + kind + '">'
      + '<button type="button" class="btn btn-sm voice-cand-toggle" onclick="this.closest(\'.voice-cand-list\').classList.toggle(\'voice-cand-collapsed\')">✎ anderen ' + (kind === 'project' ? 'Baustelle/Projekt' : 'Kontakt') + ' wählen</button>'
      + '<div class="voice-cand-toggle-body">' + searchBox + '</div>'
      + '</div>';
  }

  const hint = res.status === 'ambiguous'
    ? 'Mehrere Treffer für „' + esc(res.query) + '" — bitte wählen, oder unten neu suchen:'
    : '„' + esc(res.query) + '" nicht gefunden — bitte suchen und zuordnen:';
  const candRows = res.status === 'ambiguous'
    ? (res.candidates || []).map((x) => CRM.voice._candRowHtml(x, kind)).join('')
    : '';
  return '<div class="voice-cand-list" data-idx="' + idx + '" data-side="' + side + '" data-kind="' + kind + '">'
    + '<div class="voice-cand-hint">' + hint + '</div>'
    + candRows
    + searchBox
    + '</div>';
};

CRM.voice._onSearchInput = function (input, idx, side, kind) {
  const q = input.value.trim();
  const list = input.closest('.voice-cand-list');
  const results = list ? list.querySelector('.voice-search-results') : null;
  if (!results) return;
  if (!q) { results.innerHTML = ''; return; }
  const items = kind === 'project'
    ? CRM.db.getProjects().filter((p) => CRM.projectQueryMatch(q, p)).slice(0, 8)
    : CRM.db.getContacts().filter((c) => CRM.contactQueryMatch(q, c)).slice(0, 8);
  results.innerHTML = items.length
    ? items.map((x) => CRM.voice._candRowHtml(x, kind)).join('')
    : '<div style="color:var(--text-dim);font-size:12px;padding:4px 2px">Keine Treffer.</div>';
};

CRM.voice._cmdRowHtml = function (cmd, idx, num) {
  let desc = '';
  let candidatesHtml = '';
  let ready = true;
  const check = (res) => { if (!res || res.status !== 'resolved') ready = false; };

  if (cmd.intent === 'visit') {
    desc = 'Besuch anlegen bei <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong> — heute';
    check(cmd.resolution);
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.resolution, idx, 'target', 'contact');
    if (cmd.projectResolution) {
      // Projekt-Verknüpfung ist ein Zusatznutzen, kein Muss: bleibt das
      // Projekt unklar, wird der Besuch trotzdem angelegt (nur eben ohne
      // Verknüpfung) — daher bewusst NICHT über check() blockierend.
      desc += ' · Bauvorhaben <strong>' + CRM.voice._resDesc(cmd.projectResolution, 'project') + '</strong>';
      candidatesHtml += CRM.voice._entityPickerHtml(cmd.projectResolution, idx, 'project', 'project');
    }
  } else if (cmd.intent === 'note') {
    desc = 'Notiz hinzufügen bei <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong>';
    check(cmd.resolution);
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.resolution, idx, 'target', 'contact');
    candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Notiztext <span style="font-weight:400;color:var(--text-dim)">(bei Bedarf korrigieren)</span></label>'
      + '<input type="text" class="voice-edit-input" value="' + esc(cmd.content || '') + '" placeholder="(kein Text erkannt)" oninput="CRM.voice._updateCmdField(' + idx + ',\'content\',this.value)">';
  } else if (cmd.intent === 'muster') {
    desc = '📦 Muster-Dialog öffnen für <strong>' + CRM.voice._resDesc(cmd.resolution, 'contact') + '</strong>';
    check(cmd.resolution);
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.resolution, idx, 'target', 'contact');
  } else if (cmd.intent === 'task') {
    const title = cmd.title || '';
    if (!title) ready = false;
    const res = cmd.resolution;
    let bezug;
    if (res && res.status === 'resolved') bezug = ' für <strong>' + esc(CRM.voice._contactLabel(res.contact)) + '</strong>';
    else if (res) bezug = ' für „' + esc(res.query) + '" <span style="color:var(--text-dim)">(noch nicht zugeordnet)</span>';
    else bezug = ' <span style="color:var(--text-dim)">(ohne Kontakt)</span>';
    desc = 'Aufgabe anlegen' + bezug + ' — fällig heute';
    // Ein ausdrücklich genannter, aber nicht gefundener Kontakt blockiert;
    // ein bloß geratener Kontext-Bezug nicht (die Aufgabe ist auch ohne
    // Zuordnung sinnvoll).
    if (cmd.targetExplicit) check(res);
    candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Aufgabentext <span style="font-weight:400;color:var(--text-dim)">(bei Bedarf korrigieren)</span></label>'
      + '<input type="text" class="voice-edit-input" value="' + esc(title) + '" placeholder="Aufgabentext eingeben…" oninput="CRM.voice._updateCmdField(' + idx + ',\'title\',this.value)">';
    candidatesHtml += CRM.voice._entityPickerHtml(res, idx, 'target', 'contact');
    // Ausweg für JEDEN Zustand mit einer (noch) unerledigten Zuordnung —
    // nicht nur "resolved": ein genannter, aber nicht gefundener Name
    // (Verhörer/Tippfehler) darf die Aufgabe nicht blockieren, wenn Chris
    // sie lieber ohne Kontakt speichert, statt erst die Suche zu bemühen.
    if (res) {
      candidatesHtml += '<button class="btn btn-sm" style="margin-top:6px" onclick="CRM.voice._clearTaskContact(' + idx + ')">✕ ohne Kontakt anlegen</button>';
    }
  } else if (cmd.intent === 'link') {
    desc = '<strong>' + CRM.voice._resDesc(cmd.leftResolution, 'contact') + '</strong> verknüpfen mit '
      + (cmd.rightKind === 'project' ? 'Projekt ' : '')
      + '<strong>' + CRM.voice._resDesc(cmd.rightResolution, cmd.rightKind) + '</strong>';
    check(cmd.leftResolution);
    check(cmd.rightResolution);
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.leftResolution, idx, 'left', 'contact');
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.rightResolution, idx, 'right', cmd.rightKind);
  } else if (cmd.intent === 'projectcreate') {
    if (!(cmd.name && cmd.name.trim())) ready = false;
    desc = '🏗️ Neues Projekt anlegen: <strong>' + esc(cmd.name || '(kein Name erkannt)') + '</strong>' + (cmd.ort ? ' · ' + esc(cmd.ort) : '');
    if (cmd.linkTargetRaw) desc += ' · verknüpft mit <strong>' + CRM.voice._resDesc(cmd.linkResolution, 'contact') + '</strong>';
    if (cmd.duplicateOf) {
      desc += '<br><span style="color:var(--gold)">⚠️ Es gibt schon ein Projekt „' + esc(cmd.duplicateOf.name) + '"' + (cmd.duplicateOf.ort ? ' (' + esc(cmd.duplicateOf.ort) + ')' : '') + ' — trotzdem als neues anlegen?</span>';
    }
    candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Projektname</label>'
      + '<input type="text" class="voice-edit-input" value="' + esc(cmd.name || '') + '" placeholder="Projektname eingeben…" oninput="CRM.voice._updateCmdField(' + idx + ',\'name\',this.value)">'
      + '<label style="margin:6px 0 2px;font-size:12px;display:block">Ort</label>'
      + '<input type="text" class="voice-edit-input" value="' + esc(cmd.ort || '') + '" placeholder="(optional)" oninput="CRM.voice._updateCmdField(' + idx + ',\'ort\',this.value)">';
    if (cmd.linkTargetRaw) {
      // Ein ausdrücklich genannter Verknüpfungs-Kontakt muss aufgelöst
      // werden, blockiert sonst — Ausweg-Knopf wie bei Aufgaben, das
      // Projekt selbst ist auch ohne die Verknüpfung sinnvoll.
      check(cmd.linkResolution);
      candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Direkt verknüpfen mit</label>';
      candidatesHtml += CRM.voice._entityPickerHtml(cmd.linkResolution, idx, 'projectlink', 'contact');
      candidatesHtml += '<button class="btn btn-sm" style="margin-top:6px" onclick="CRM.voice._clearProjectLink(' + idx + ')">✕ ohne Verknüpfung anlegen</button>';
    }
  } else if (cmd.intent === 'projectnote') {
    desc = '📝 Notiz für Bauvorhaben <strong>' + CRM.voice._resDesc(cmd.projectResolution, 'project') + '</strong>';
    check(cmd.projectResolution);
    candidatesHtml += CRM.voice._entityPickerHtml(cmd.projectResolution, idx, 'project', 'project');
    candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Notiztext <span style="font-weight:400;color:var(--text-dim)">(bei Bedarf korrigieren)</span></label>'
      + '<input type="text" class="voice-edit-input" value="' + esc(cmd.content || '') + '" placeholder="(kein Text erkannt)" oninput="CRM.voice._updateCmdField(' + idx + ',\'content\',this.value)">';
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
  CRM.voice._logHistory(rawText, commands);
  CRM.voice._renderConfirmModal();
};

/* Chris-Frage (2026-08): "wo finde ich den gesprochenen Text? ist der
   irgendwo gespeichert?" — Antwort war bisher: nirgends, _lastTranscript
   lebt nur im Arbeitsspeicher der Seite und ist nach dem Schließen weg.

   Chris-Folgefrage (2026-08): "kannst du dir nicht einen Speicher ablegen,
   wo gesprochene Aufgaben abgelegt werden, um sie spaeter als Testlauf an
   reellen Praxisbeispielen zu nutzen?" — mit 20 rollierenden Eintraegen
   (Vortag) war das nur ein Debug-Puffer, kein wachsender Testkorpus.
   Deckel jetzt bei 300 (praktisch "alles" bei Chris' Nutzungsmenge) UND
   ein Export-Knopf, der ALLE gespeicherten Saetze als Text kopiert — die
   kann Chris jederzeit einfach hier reinpasten, dann laufen sie durch
   genau die Testschleife, die eben mit erfundenen Saetzen lief, diesmal
   aber mit echten. Weiterhin rein lokal, nichts Cloud. */
CRM.voice._HISTORY_LIMIT = 300;
CRM.voice._logHistory = function (rawText, commands) {
  const text = String(rawText || '').trim();
  if (!text) return;
  const settings = CRM.db.getSettings();
  const history = (settings.voiceHistory || []).slice(0, CRM.voice._HISTORY_LIMIT - 1);
  const kurz = (commands || []).map((c) => {
    if (c.intent === 'unrecognized') return 'nicht zugeordnet: „' + c.rawText + '"';
    if (c.intent === 'unsupported') return 'nicht unterstützt: „' + c.rawText + '"';
    return c.intent;
  }).join(', ') || '(nichts erkannt)';
  history.unshift({ ts: new Date().toISOString(), text: text, erkannt: kurz });
  CRM.db.saveSettings({ voiceHistory: history });
};

// Nur die letzten 50 werden gerendert (lesbar bleiben) — der Export-Knopf
// nimmt trotzdem ALLE, unabhängig von der Anzeige.
CRM.voice._HISTORY_SHOW = 50;
CRM.voice.openHistory = function () {
  const history = (CRM.db.getSettings().voiceHistory || []);
  const shown = history.slice(0, CRM.voice._HISTORY_SHOW);
  const rows = shown.length
    ? shown.map((h) => {
        const datum = new Date(h.ts).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
        return '<div style="border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px">'
          + '<div style="font-size:11px;color:var(--text-dim)">' + esc(datum) + '</div>'
          + '<div style="margin:4px 0;user-select:text">„' + esc(h.text) + '"</div>'
          + '<div style="font-size:12px;color:var(--text-dim)">' + esc(h.erkannt) + '</div>'
          + '<div class="row" style="margin-top:6px">'
          + '<button class="btn btn-sm" onclick="CRM.voice.reuseFromHistory(' + history.indexOf(h) + ')">↺ In Vorschau erneut prüfen</button>'
          + '</div></div>';
      }).join('')
    : '<p style="color:var(--text-dim)">Noch nichts aufgezeichnet — nach dem nächsten Sprachbefehl steht er hier.</p>';
  const mehrHinweis = history.length > shown.length
    ? '<p style="color:var(--text-dim);font-size:12px">... und ' + (history.length - shown.length) + ' weitere (im Export enthalten).</p>' : '';
  CRM.openModal('<h2>🕘 Verlauf erkannter Sätze</h2>'
    + '<p style="color:var(--text-dim);font-size:13px">Nur auf diesem Gerät gespeichert (bis zu ' + CRM.voice._HISTORY_LIMIT + '). "Alle exportieren" kopiert jeden gespeicherten Satz als Text — zum Einfügen in den Chat für einen erneuten Testlauf an echten Beispielen.</p>'
    + (history.length ? '<div class="row" style="margin-bottom:10px"><button class="btn btn-sm" onclick="CRM.voice.exportHistory()">📋 Alle ' + history.length + ' exportieren</button></div>' : '')
    + rows + mehrHinweis
    + '<div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Schließen</button></div>');
};

CRM.voice.exportHistory = function () {
  const history = (CRM.db.getSettings().voiceHistory || []);
  if (!history.length) return;
  const text = history.slice().reverse().map((h) => {
    const datum = new Date(h.ts).toLocaleString('de-DE');
    return datum + ' — ' + h.text + '  [' + h.erkannt + ']';
  }).join('\n');
  const done = () => CRM.toast('✓ ' + history.length + ' Sätze in die Zwischenablage kopiert.', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => CRM.toast('Kopieren fehlgeschlagen.', 'error'));
  } else {
    CRM.toast('Kopieren in diesem Browser nicht verfügbar.', 'error');
  }
};

CRM.voice.reuseFromHistory = function (i) {
  const h = (CRM.db.getSettings().voiceHistory || [])[i];
  if (!h) return;
  CRM.voice._lastTranscript = h.text;
  CRM.voice._pending = CRM.voice.parseUtterance(h.text);
  CRM.voice._renderConfirmModal();
};

/* Chris-Feedback (2026-08): die Texterkennung ist bei längeren/komplizierten
   Sätzen überschaubar — der erkannte Text muss sich HIER, in der Vorschau,
   korrigieren lassen (Tippfehler/Verhörer ausbessern und neu zerlegen),
   statt nur "so übernehmen oder ganz abbrechen und neu aufnehmen". Der
   Text steht deshalb in einem editierbaren <textarea>, "🔄 Neu prüfen"
   parst den (ggf. korrigierten) Text erneut und baut die Vorschau darunter
   neu auf — ohne die Aufnahme zu wiederholen. */
CRM.voice._renderConfirmModal = function () {
  const commands = CRM.voice._pending || [];
  const html = '<h2>🎤 Sprachbefehl bestätigen</h2>'
    + '<label style="margin-top:0">Erkannter Text <span style="font-weight:400;color:var(--text-dim)">(bei Bedarf korrigieren, dann „Neu prüfen")</span></label>'
    + '<textarea id="voice-confirm-text" rows="2">' + esc(CRM.voice._lastTranscript || '') + '</textarea>'
    + '<div class="row" style="margin:6px 0 12px">'
    + '<button class="btn btn-sm" onclick="CRM.voice.reparseFromConfirm()">🔄 Neu prüfen</button>'
    + '</div>'
    + CRM.voice.buildPreview(commands)
    + '<div class="modal-footer">'
    + '<button class="btn" onclick="CRM.voice.cancelPreview()">✕ Abbrechen</button>'
    + '<button class="btn btn-primary" onclick="CRM.voice.executeConfirmed()">✓ Ausführen</button>'
    + '</div>';
  CRM.openModal(html, { dismissible: false });
  CRM.voice._wirePreviewCandidates();
};

/* Liest den (evtl. von Chris korrigierten) Text aus dem Textfeld, parst
   ihn neu und baut die Vorschau darunter neu auf — das Textfeld selbst
   bleibt dieselbe Stelle, kein Zurück-zur-Aufnahme nötig. */
CRM.voice.reparseFromConfirm = function () {
  const ta = document.getElementById('voice-confirm-text');
  const text = ta ? ta.value.trim() : '';
  if (!text) { CRM.toast('Bitte Text eingeben.', 'error'); return; }
  CRM.voice._lastTranscript = text;
  CRM.voice._pending = CRM.voice.parseUtterance(text);
  CRM.voice._renderConfirmModal();
};

CRM.voice._wirePreviewCandidates = function () {
  // Delegiert auf den (stabilen) .voice-cand-list-Container statt auf
  // einzelne .voice-cand-row-Elemente: die Suchergebnis-Zeilen entstehen
  // erst NACH diesem Aufruf dynamisch (Tippen im Suchfeld, s.
  // _onSearchInput) und müssten sonst separat neu verdrahtet werden.
  document.querySelectorAll('.voice-cand-list').forEach((list) => {
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
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.voice-cand-row');
      if (!row || !list.contains(row)) return;
      e.preventDefault();
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
  else if (side === 'project') res = cmd.projectResolution;
  else if (side === 'projectlink') res = cmd.linkResolution;
  else res = cmd.resolution;
  // Noch gar keine Auflösung vorhanden (allgemeine Aufgabe, der Chris
  // jetzt erst einen Kontakt zuweist, ein Besuch ohne genanntes
  // Bauvorhaben, dem jetzt eins zugeordnet wird, ODER ein neues Projekt
  // ohne bisher genannten Verknüpfungs-Kontakt) — hier anlegen statt
  // abbrechen.
  if (!res && side === 'target') { res = { status: 'notfound', query: '', contact: null }; cmd.resolution = res; }
  if (!res && side === 'project') { res = { status: 'notfound', query: '', project: null }; cmd.projectResolution = res; }
  if (!res && side === 'projectlink') { res = { status: 'notfound', query: '', contact: null }; cmd.linkResolution = res; }
  if (!res) return;
  res.status = 'resolved';
  res.candidates = null;
  if (kind === 'project') res.project = entity; else res.contact = entity;
  // Neu zeichnen: dank geteilter Objekt-Referenz aktualisieren sich
  // davon abhängige Zeilen (z.B. "neue Notiz" nach diesem Besuch) mit.
  CRM.voice._renderConfirmModal();
};

/* Chris-Feedback (2026-08): der Aufgabentext/Notiztext einer einzelnen
   Zeile war bisher nur über "ganzen Satz neu diktieren/korrigieren + neu
   prüfen" korrigierbar — das zerlegt bei komplexeren Sätzen aber auch
   bereits korrekt erkannte Nachbar-Zeilen neu. Direktes Editieren EINER
   Zeile ändert nur cmd.title/cmd.content, ohne den Rest neu zu parsen.
   Bewusst OHNE komplettes CRM.voice._renderConfirmModal() (das würde bei
   jedem Tastendruck den Fokus aus dem Eingabefeld reißen) — nur die
   Bereit/Unklar-Markierung der betroffenen Zeile wird direkt im DOM
   nachgezogen. */
// Pro Intent das EINE Feld, dessen leer/nicht-leer über Bereit/Unklar
// entscheidet (Aufgabentext bzw. Projektname) — Notiztext/Ort sind immer
// optional und ändern die Markierung nicht.
CRM.voice._READINESS_FIELD = { task: 'title', projectcreate: 'name' };
CRM.voice._updateCmdField = function (idx, field, value) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd[field] = value;
  if (CRM.voice._READINESS_FIELD[cmd.intent] === field) {
    const row = document.querySelector('.voice-cmd[data-idx="' + idx + '"]');
    if (!row) return;
    const ready = !!(cmd[field] || '').trim();
    row.classList.toggle('voice-cmd-ready', ready);
    row.classList.toggle('voice-cmd-ambiguous', !ready);
    const badge = row.querySelector('.voice-cmd-badge');
    if (badge) badge.textContent = ready ? '✓' : '?';
  }
};

// Projekt trotzdem OHNE die genannte Verknüpfung anlegen — der genannte
// Kontakt wurde nicht gefunden (Verhörer/Tippfehler), das Projekt selbst
// ist auch ohne die Verknüpfung sinnvoll.
CRM.voice._clearProjectLink = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.linkResolution = null;
  cmd.linkTargetRaw = null;
  CRM.voice._renderConfirmModal();
};

/* Aufgabe bewusst ohne Kontakt anlegen — der aus dem Satzzusammenhang
   geratene Bezug kann falsch sein (z.B. eine allgemeine Büroaufgabe, die
   nur zufällig nach einem Besuch diktiert wurde). */
CRM.voice._clearTaskContact = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.resolution = null;
  cmd.targetExplicit = false;
  CRM.voice._renderConfirmModal();
};

/* Wandelt einen bisher nicht zugeordneten Satzteil (intent:'unrecognized')
   in einen echten Teilbefehl um — danach normal editierbar/zuordenbar wie
   jede andere Zeile (Kontaktsuche, Textfeld). Übernimmt einen im Satz
   vorher schon aufgelösten Kontakt als VORSCHLAG (wie bei "neue Notiz"
   ohne eigene Namensnennung), lässt sich in der Vorschau aber jederzeit
   über das Suchfeld ändern.
   WICHTIG: bewusst eine KOPIE der resolution (Object.assign), keine
   geteilte Objektreferenz wie beim regulären Kontext-Mechanismus (s.
   _contextContact-Kommentar oben). Ein promoteter Satzteil war vom Parser
   ausdrücklich NICHT verstanden worden — der übernommene Kontakt ist nur
   eine Rate-Hilfe, kein bestätigter Bezug. Mit geteilter Referenz hätte
   eine spätere Korrektur HIER (z.B. "eigentlich Recep Yasar, nicht die
   Firma vom Besuch") den bereits korrekt aufgelösten Besuchs-Kontakt
   MIT-verändert — gefunden beim Testen mit Chris' Beispielsatz. */
CRM.voice._promoteUnrecognized = function (idx, newIntent) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  if (newIntent === 'note') {
    cmd.intent = 'note';
    cmd.content = cmd.rawText;
    const ctx = CRM.voice._contextContact(CRM.voice._pending, idx);
    cmd.resolution = ctx ? Object.assign({}, ctx) : { status: 'notfound', query: '', contact: null };
  } else if (newIntent === 'task') {
    cmd.intent = 'task';
    cmd.title = cmd.rawText;
  }
  CRM.voice._renderConfirmModal();
};

CRM.voice.cancelPreview = function () {
  CRM.voice._pending = null;
  CRM.closeModal();
};

/* Chris (2026-08): "wenn ich hier eine Kontaktadresse reinkopiere, muss
   erkannt werden, dass das ein Kontakt ist, er wird entweder gesucht
   oder neu erstellt." Sprachbefehle erkennen nur Trigger-Wörter
   ("Besuch bei", "Aufgabe:", ...) — eine eingefügte Adresse/Signatur
   ohne solches Wort landet komplett in "nicht zugeordnet". Statt hier
   eine zweite Adress-Erkennung zu bauen, wird der bereits vorhandene
   "+ Neuer Kontakt"-Dialog (email-parser.js — erkennt Firma/Adresse/
   Telefon aus Freitext UND warnt bei einem möglichen Doppelkontakt)
   direkt mit dem unzugeordneten Text befüllt und sofort analysiert. */
CRM.voice._promoteToContact = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  const text = cmd.rawText;
  CRM.voice.cancelPreview();
  CRM.emailParser.openDialog();
  const input = document.getElementById('ep-input');
  if (input) input.value = text;
  CRM.emailParser.analyze();
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
        // Bauvorhaben-Verknüpfung ist Zusatznutzen: nur verknüpfen, wenn
        // aufgelöst — bleibt es offen/unklar, wird der Besuch trotzdem
        // ganz normal angelegt (kein skipped, kein Blockieren).
        if (cmd.projectResolution && cmd.projectResolution.status === 'resolved') {
          CRM.linkContactToProject(cmd.resolution.contact.id, cmd.projectResolution.project.id);
        }
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
      const res = cmd.resolution;
      const zielOffen = cmd.targetExplicit && !(res && res.status === 'resolved');
      if (cmd.title && !zielOffen) {
        CRM.db.addTask({
          title: cmd.title,
          due: CRM.ymd(new Date()),
          contactId: (res && res.status === 'resolved') ? res.contact.id : null,
        });
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
    } else if (cmd.intent === 'projectcreate') {
      const linkOffen = cmd.linkTargetRaw && !(cmd.linkResolution && cmd.linkResolution.status === 'resolved');
      if (cmd.name && !linkOffen) {
        const proj = CRM.db.addProject(Object.assign(CRM.makeEmptyProject(), { name: cmd.name, ort: cmd.ort || '' }));
        if (cmd.linkResolution && cmd.linkResolution.status === 'resolved') {
          CRM.linkContactToProject(cmd.linkResolution.contact.id, proj.id);
        }
        done++;
      } else skipped++;
    } else if (cmd.intent === 'projectnote') {
      if (cmd.projectResolution && cmd.projectResolution.status === 'resolved') {
        CRM.db.addComm(Object.assign(CRM.makeEmptyComm(), {
          type: 'note',
          subject: '',
          body: cmd.content || '(per Sprachbefehl angelegt, ohne weiteren Text)',
          projectIds: [cmd.projectResolution.project.id],
          contactIds: [],
        }));
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
    <div class="row" style="justify-content:space-between;align-items:flex-start">
      <h2 style="margin:0">🎤 Sprachbefehl</h2>
      <button class="btn btn-sm" onclick="CRM.voice.openHistory()" title="Bisher erkannte Sätze ansehen (lokal gespeichert)">🕘 Verlauf</button>
    </div>
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
