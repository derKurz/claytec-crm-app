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
  // Chris (2026-09-24, echte Wispr-Sätze): "Termin bei X" ist für ihn
  // Alltagssprache für einen STATTGEFUNDENEN Kundentermin, genau wie
  // "Besuch bei"/"war bei" — eigener Trigger-Typ (nicht einfach im visit-
  // Muster mit-ergänzt), weil "Termin bei" zusätzlich eine Zukunfts-Sperre
  // braucht (siehe _FUTURE_RE unten): "Termin bei X am Freitag" ist eine
  // Planung, kein Besuch, und darf keinen Besuchseintrag erzeugen.
  { type: 'termin', re: /\b(?:ich\s+)?(?:hatte\s+)?(?:(?:einen|den)\s+)?(?:kunden|baustellen)?termin\s+(?:heute\s+|gerade\s+|eben\s+|vorhin\s+)?bei\b/gi },
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
  // Zukunfts-Sperre für "Termin bei" (Chris 2026-09-24): ein Satz mit einer
  // erkennbaren Zukunftsangabe ist eine PLANUNG, kein stattgefundener
  // Besuch — dann lieber gar keinen Besuch anlegen (Satz bleibt Text/
  // "nicht zugeordnet") als einen falschen. "Besuch bei"/"war bei" bleiben
  // davon unberührt (Chris nennt die nur für tatsächlich Geschehenes).
  const FUTURE_WORDS_RE = /\b(vereinbar\w*|ausgemacht|ausmachen|geplant|planen|verschoben|um\s*\d{1,2}([:.]\d{2})?\s*uhr)\b/i;
  const isFutureTermin = (satzstueck) => {
    if (FUTURE_WORDS_RE.test(satzstueck)) return true;
    if (window.CRM && CRM.speech && CRM.speech.parseGermanDate) {
      const heute = CRM.ymd ? CRM.ymd(new Date()) : new Date().toISOString().slice(0, 10);
      const d = CRM.speech.parseGermanDate(satzstueck, heute);
      // "heute"/"gerade"/"eben"/"vorhin" landen selbst schon im Trigger-Wort,
      // parseGermanDate würde für reinen Trigger-Text nichts finden — nur
      // ein Datum NACH heute zählt als Planung.
      if (d && d.iso > heute) return true;
    }
    return false;
  };
  const triggerCmds = found.map((f, i) => {
    let end = found[i + 1] ? found[i + 1].start : text.length;
    // an einer bereits vergebenen Verknüpfen-Spanne stoppen, falls die
    // näher liegt als der nächste generische Trigger
    linkCmds.forEach((lc) => { if (lc.start >= f.triggerEnd && lc.start < end) end = lc.start; });
    const periodIdx = text.indexOf('.', f.triggerEnd);
    if (periodIdx !== -1 && periodIdx < end) end = periodIdx;
    // Zeilenumbruch zählt wie ein Punkt als Klausel-Ende (wichtig für
    // Wispr-/Stichpunkt-Text, siehe _normalizeList) — nur für visit/termin,
    // die übrigen Trigger beziehen sich ohnehin nur auf einen Kontakt.
    if (f.type === 'visit' || f.type === 'termin') {
      const nlIdx = text.indexOf('\n', f.triggerEnd);
      if (nlIdx !== -1 && nlIdx < end) end = nlIdx;
    }
    const contentRaw = CRM.voice._cleanClause(text.slice(f.triggerEnd, end));
    const rawText = text.slice(f.start, end).trim();

    if (f.type === 'visit' || f.type === 'termin') {
      if (f.type === 'termin' && isFutureTermin(rawText)) return []; // Planung, kein Besuch — Satz bleibt unclaimed
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

/* ============================================================
   CRM.voice.analyze(text) — Deutungs-Schicht (Chris 2026-09-24, echte
   Wispr-Sätze): parseUtterance() bleibt unverändert die GRAMMATIK-Schicht
   (Trigger zerlegen, Kontakte auflösen) — die 33 bestehenden Tests rufen
   sie weiterhin direkt auf und bleiben grün. analyze() davor/danach deutet
   nur das um, was parseUtterance NICHT verstanden hat (unrecognized/
   unsupported), oder erkennt VORAB einen ganz anderen Fall (neuer Kontakt/
   Signatur). Ablauf:
     1. _asrFixes        — bekannte Verhörer korrigieren (sichtbar/abschaltbar)
     2. _detectContactCreate — "Neuer Kontakt"/Signatur? Dann EIN exklusiver Befehl
     3. _normalizeList    — Stichpunkte/Kopfzeile+Firmenzeile zusammenführen
     4. parseUtterance    — wie bisher (inkl. neuem "Termin bei"-Trigger)
     5. _attachReports    — unzugeordneter Freitext nach einem Besuch -> Bericht
     6. _suggestTasks     — Aufgaben-Vorschläge aus dem Bericht (Opt-in)
   ============================================================ */
CRM.voice.analyze = function (rawText, opts) {
  opts = opts || {};
  const text = String(rawText || '');
  const fixed = opts.skipAsrFixes ? { text, fixes: [] } : CRM.voice._asrFixes(text);
  const created = CRM.voice._detectContactCreate(fixed.text);
  if (created) return { commands: [created], fixes: fixed.fixes };
  const normalized = CRM.voice._normalizeList(fixed.text);
  let all = CRM.voice.parseUtterance(normalized);
  all = CRM.voice._attachReports(all);
  all = CRM.voice._suggestTasks(all);
  return { commands: all, fixes: fixed.fixes };
};

/* ---------- 1) Verhörer-Korrektur (A5) — feste Wortliste, NUR die 3
   dokumentierten Claytec-Produkte (CLAUDE.md). Firmen-/Ortsnamen laufen
   über die klangliche Suche in resolveContact/resolveProject (A6), nicht
   hier — eine Wortliste würde dort nur EINEN Einzelfall abdecken. ---------- */
CRM.voice._ASR_FIXES = [
  { re: /\bjo[sz]?\s?sim[ae]r?\b|\byosima\b/gi, to: 'YOSIMA' },
  { re: /\bleim\s?bauplatte(n?)\b/gi, to: 'Lehmbauplatte$1' },
  { re: /\b(?:le\s?mix|lehmix)\b/gi, to: 'LEMIX' },
];
CRM.voice._asrFixes = function (text) {
  let out = text;
  const fixes = [];
  CRM.voice._ASR_FIXES.forEach((f) => {
    const re = new RegExp(f.re.source, f.re.flags);
    out = out.replace(re, (m, ...rest) => {
      const replacement = f.to.replace(/\$(\d)/g, (_, n) => rest[n - 1] || '');
      if (m.toLowerCase() !== replacement.toLowerCase()) fixes.push(m + ' → ' + replacement);
      return replacement;
    });
  });
  return { text: out, fixes };
};

/* ---------- 2) "Neuer Kontakt" / vorgelesene Signatur (A4) ---------- */
/* Punktesystem für "sieht das strukturell wie eine Signatur/Visitenkarte
   aus" — bewusst keine feste Trigger-Wortliste (Firmen klingen zu
   unterschiedlich), sondern Anhaltspunkte, die eine echte Signatur fast
   immer hat. Nur wenn KEIN anderer Sprachbefehl-Trigger im Text vorkommt
   (sonst bliebe "Besuch bei Erdraum, neue Nummer 0941…" ein Besuch). */
CRM.voice._SIGNATURE_PATTERNS = [
  { re: /\b\d{5}\s+[A-ZÄÖÜ][a-zäöüß]/, pts: 2 },
  { re: /[\w.+-]+@[\w.-]+\.\w+/, pts: 2 },
  { re: /\b(?:T|Tel\.?|Telefon|Fon|M|Mobil|Fax)\s*[:.]?\s*\+?\d{2,}|(?:\d[\s\/-]?){8,}/i, pts: 1 },
  { re: /\bwww\.|https?:\/\//i, pts: 1 },
  { re: /\b(GmbH|AG|KG|OHG|UG|e\.\s?K\.?|GbR|eG)\b/, pts: 1 },
  { re: /\b[A-ZÄÖÜ][a-zäöüß]+(?:stra[ßs]e|str\.?|weg|allee|gasse|platz)\b.{0,15}\d/i, pts: 1 },
];
CRM.voice._looksLikeSignature = function (text) {
  let score = 0, hasAnchor = false;
  CRM.voice._SIGNATURE_PATTERNS.forEach((p) => {
    if (p.re.test(text)) {
      score += p.pts;
      if (p.pts >= 2) hasAnchor = true;
    }
  });
  return score >= 3 && hasAnchor;
};
CRM.voice._CONTACT_CREATE_RE = /^\s*(?:neue[rn]?\s+kontakt|kontakt\s+(?:anlegen|erstellen))\b\s*(?:anlegen|erstellen)?\s*[:.,-]?\s*/i;
CRM.voice._detectContactCreate = function (text) {
  const explicitMatch = text.match(CRM.voice._CONTACT_CREATE_RE);
  let content = null;
  if (explicitMatch) {
    content = text.slice(explicitMatch[0].length).trim();
  } else {
    // Strukturell nur prüfen, wenn kein anderer Trigger im Text steckt.
    const hatAnderenTrigger = CRM.voice._TRIGGERS.some((t) => new RegExp(t.re.source, t.re.flags.replace('g', '')).test(text))
      || new RegExp(CRM.voice._LINK_RE.source, CRM.voice._LINK_RE.flags.replace('g', '')).test(text);
    if (!hatAnderenTrigger && CRM.voice._looksLikeSignature(text)) content = text.trim();
  }
  if (content === null) return null;
  // Wispr-Signaturen sind oft eine oder wenige, kommadurchsetzte Zeilen —
  // erst in das von parse() erwartete Zeilenformat bringen (reine Funktion,
  // rührt parse() selbst nicht an).
  const lineCount = content.split('\n').filter((l) => l.trim()).length;
  const forParse = (content && lineCount < 3) ? CRM.emailParser.splitFlatSignature(content) : content;
  const data = content ? CRM.emailParser.parse(forParse) : { company: '', name: '', _confidence: {} };
  const match = content ? CRM.mailAblage.matchParsed(data, data.email || '') : null;
  return {
    intent: 'contactcreate', start: 0, end: text.length, rawText: text,
    data: (match && match.data) || data,
    match: match,
    typ: (match && match.typVorschlag) || '',
  };
};

/* ---------- 3) Stichpunkte / Kopfzeile+Firmenzeile (A3) ---------- */
CRM.voice._BULLET_RE = /^\s*[-–•*]\s*/;
CRM.voice._TERMIN_HEADER_RE = /^(?:ich\s+)?(?:hatte\s+)?(?:kunden|baustellen)?(?:termin|besuch)(?:\s+(?:heute|gerade|eben|vorhin))?$/i;
CRM.voice._normalizeList = function (text) {
  let lines = text.split('\n');
  const nonEmpty = lines.filter((l) => l.trim());
  const bulletCount = nonEmpty.filter((l) => CRM.voice._BULLET_RE.test(l)).length;
  if (nonEmpty.length >= 3 && bulletCount >= 2) {
    lines = lines.map((l) => l.replace(CRM.voice._BULLET_RE, ''));
  }
  // Kopfzeilen-Regel: 1. Zeile nur "Termin/Besuch (heute/…)", 2. Zeile kurz
  // und ohne eigenen Trigger -> "Termin bei <2. Zeile>" (Chris' Stichpunkt-
  // Beispiel: "Termin heute" / "Beiwa Lauf" -> "Termin bei Beiwa Lauf").
  const trimmed = lines.map((l) => l.trim());
  const erste = trimmed[0] || '';
  const zweite = trimmed[1] || '';
  if (erste && zweite && CRM.voice._TERMIN_HEADER_RE.test(erste) && zweite.split(/\s+/).length <= 5) {
    const hatTrigger = CRM.voice._TRIGGERS.some((t) => new RegExp(t.re.source, t.re.flags.replace('g', '')).test(zweite));
    if (!hatTrigger) {
      const rest = lines.slice(2);
      return ['Termin bei ' + zweite].concat(rest).join('\n');
    }
  }
  return lines.join('\n');
};

/* ---------- 5) Freitext nach einem Besuch -> Besuchsbericht (A2) ---------- */
/* Sende-Wünsche ("schicken/senden/versenden") bleiben eigene unsupported-
   Zeilen — erledigte Fakten ("zugesandt", "geschickt") zählen NICHT dazu
   und bleiben im Bericht. Satzweise geprüft, damit ein Chunk mit beidem
   (Bericht + ein Sende-Wunsch) sauber getrennt wird. */
CRM.voice._SEND_RE = /\b(schick\w*|send\w*|versend\w*)\b/i;
CRM.voice._splitSentences = function (text) {
  const geschuetzt = String(text || '').replace(/(\d)\.(?=\s|\d|$)/g, '$1\x00');
  return geschuetzt.split(/[.!?\n]+/).map((s) => s.replace(/\x00/g, '.').trim()).filter(Boolean);
};
CRM.voice._attachReports = function (all) {
  let chain = null; // {start, visits:[...]} — Besuch(e) mit demselben start = eine Kette
  const out = [];
  all.forEach((cmd) => {
    if (cmd.intent === 'visit') {
      if (!chain || chain.start !== cmd.start) chain = { start: cmd.start, visits: [] };
      chain.visits.push(cmd);
      out.push(cmd);
      return;
    }
    if (cmd.intent === 'link' || cmd.intent === 'projectcreate' || cmd.intent === 'projectnote') {
      chain = null; // eigener Bezug — kein Bericht mehr an einen früheren Besuch
      out.push(cmd);
      return;
    }
    if ((cmd.intent === 'unrecognized' || cmd.intent === 'unsupported') && chain && chain.visits.length) {
      const sentences = CRM.voice._splitSentences(cmd.rawText);
      const sendParts = sentences.filter((s) => CRM.voice._SEND_RE.test(s));
      const keepParts = sentences.filter((s) => !CRM.voice._SEND_RE.test(s));
      if (keepParts.length) {
        const txt = keepParts.join('. ');
        // Eigene Kopie pro Besuch (kein geteiltes Objekt) — eine spätere
        // Korrektur bei A darf den Bericht bei B nicht mitverändern.
        chain.visits.forEach((v) => { v.report = v.report ? v.report + '\n' + txt : txt; });
      }
      if (sendParts.length) {
        out.push({ intent: 'unsupported', start: cmd.start, end: cmd.end, rawText: sendParts.join('. ') });
      }
      return; // Original-Zeile ist absorbiert (ganz oder teilweise umgewandelt)
    }
    out.push(cmd);
  });
  return out;
};

/* ---------- 6) Aufgaben-Vorschläge aus dem Bericht (A3, Opt-in) ---------- */
CRM.voice._suggestTasks = function (all) {
  if (!(window.CRM && CRM.speech && CRM.speech.detectTasks)) return all;
  const out = all.slice();
  const heute = CRM.ymd ? CRM.ymd(new Date()) : new Date().toISOString().slice(0, 10);
  all.forEach((cmd, i) => {
    if (cmd.intent !== 'visit' || !(cmd.report || '').trim()) return;
    const vorschlaege = CRM.speech.detectTasks(cmd.report, heute);
    vorschlaege.forEach((v) => {
      out.push({
        intent: 'task', start: cmd.start, end: cmd.end, rawText: v.title,
        title: v.title, due: v.due || '', suggested: true, accepted: false,
        targetExplicit: false, resolution: cmd.resolution ? Object.assign({}, cmd.resolution) : null,
      });
    });
  });
  return out;
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
  // Letzte Stufe (A6, Chris 2026-09-24: "Wallauf" war ein Wispr-Verhörer
  // von "BayWa Lauf") — klangliche Ähnlichkeit gegen die echte Kontakt-
  // datenbank, NIE automatisch übernommen (siehe status 'phonetic', wird
  // in der Vorschau ausdrücklich bestätigungspflichtig dargestellt).
  const guess = CRM.voice._phoneticGuess(combined, contacts, 'contact');
  if (guess) return { status: 'phonetic', contact: guess, query: combined };
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
  const guess = CRM.voice._phoneticGuess(combined, projects, 'project');
  if (guess) return { status: 'phonetic', project: guess, query: combined };
  return { status: 'notfound', query: combined, project: null };
};

/* ============================================================
   Klangliche Ähnlichkeitssuche (A6) — Levenshtein-basiert, gegen die
   echte Kontakt-/Projektdatenbank, kein fester Wortlisten-Fix. Nur EIN
   klarer Treffer mit deutlichem Abstand zum zweitbesten gilt überhaupt
   als Vorschlag; alles andere bleibt "notfound". Rein lokal, kein Lernen/
   Merken — jeder Satz wird neu geprüft (Chris 2026-09-24).
   ============================================================ */
CRM.voice._levenshtein = function (a, b) {
  const m = a.length, n = b.length;
  if (!m) return n;
  if (!n) return m;
  const dp = new Array(n + 1);
  for (let j = 0; j <= n; j++) dp[j] = j;
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
};
CRM.voice._similarity = function (a, b) {
  if (!a || !b) return 0;
  return 1 - CRM.voice._levenshtein(a, b) / Math.max(a.length, b.length);
};
CRM.voice._PHONETIC_THRESHOLD = 0.5;
CRM.voice._PHONETIC_MARGIN = 0.1;
// Rechtsformen weglassen (Chris' "Wallauf" für "BayWa AG, Lauf a.d.
// Pegnitz" — das "AG" und der lange Ortszusatz verwässern sonst die
// Ähnlichkeit spürbar, gemessen an echten Beispielen: "BayWa Lauf" statt
// "BayWa AG Lauf a.d. Pegnitz" hebt die Trefferquote deutlich).
CRM.voice._LEGAL_FORM_WORDS_RE = /\b(gmbh|co\s*kg|kg|ag|ohg|ug|e\.?\s?v\.?|eg|gbr|mbh|inc|ltd|llc|e\.?\s?k\.?)\b\.?/gi;
CRM.voice._phoneticGuess = function (query, items, kind) {
  const qn = CRM.searchNorm(query).replace(/\s+/g, '');
  if (qn.length < 4 || !items || !items.length) return null;
  let best = null, bestScore = 0, second = 0;
  items.forEach((it) => {
    const rawName = kind === 'project' ? (it.name || '') : (it.firma1 || '');
    if (!rawName) return;
    const name = rawName.replace(CRM.voice._LEGAL_FORM_WORDS_RE, '').replace(/\s+/g, ' ').trim() || rawName;
    const ortErstesWort = String(it.ort || '').split(/[\s,]+/)[0] || '';
    const varianten = [name, ortErstesWort, name + ' ' + ortErstesWort, rawName]
      .map((v) => CRM.searchNorm(v).replace(/\s+/g, '')).filter(Boolean);
    let itemBest = 0;
    varianten.forEach((v) => { const s = CRM.voice._similarity(qn, v); if (s > itemBest) itemBest = s; });
    if (itemBest > bestScore) { second = bestScore; bestScore = itemBest; best = it; }
    else if (itemBest > second) second = itemBest;
  });
  if (best && bestScore >= CRM.voice._PHONETIC_THRESHOLD && (bestScore - second) >= CRM.voice._PHONETIC_MARGIN) return best;
  return null;
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
  if (res.status === 'phonetic') {
    return '🔊 Klingt wie: ' + esc(kind === 'project' ? CRM.voice._projectLabel(res.project) : CRM.voice._contactLabel(res.contact)) + ' — passt das?';
  }
  if (res.status === 'ambiguous') return '„' + esc(res.query) + '" — mehrdeutig, bitte auswählen';
  return '„' + esc(res.query) + '" — nicht gefunden';
};
/* Liefert das resolution-Objekt zur passenden Seite eines Befehls —
   gemeinsam genutzt von _pickCandidate und den Phonetic-Bestätigen/
   Ablehnen-Funktionen, damit die Seiten-Zuordnung nur an einer Stelle steht. */
CRM.voice._resForSide = function (cmd, side) {
  if (side === 'left') return cmd.leftResolution;
  if (side === 'right') return cmd.rightResolution;
  if (side === 'project') return cmd.projectResolution;
  if (side === 'projectlink') return cmd.linkResolution;
  return cmd.resolution;
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
      // A2 (Chris 2026-09-24): auch ein als "senden/schicken" erkannter
      // Satz soll nicht spurlos verworfen werden können — genau wie bei
      // "nicht zugeordnet" zwei Auswege, den Text doch noch zu verwenden.
      return '<div class="voice-cmd voice-cmd-blocked" data-idx="' + idx + '">'
        + '<span class="voice-cmd-badge">✕</span>'
        + '<div class="voice-cmd-body"><div class="voice-cmd-desc"><strong>' + n + '.</strong> „' + esc(cmd.rawText) + '" — das kann ich noch nicht (diese Funktion gibt es in der App noch nicht, Phase 1 unterstützt nur Anlegen/Verknüpfen bereits vorhandener Funktionen).</div>'
        + '<div class="row" style="margin-top:6px;gap:6px;flex-wrap:wrap">'
        + '<button class="btn btn-sm" onclick="CRM.voice._promoteUnrecognized(' + idx + ',\'task\')">→ als Aufgabe verwenden</button>'
        + '<button class="btn btn-sm" onclick="CRM.voice._promoteUnsupportedToReport(' + idx + ')">→ in Bericht übernehmen</button>'
        + '</div></div>'
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

  if (res.status === 'phonetic') {
    // Klanglicher Vorschlag (A6) — bewusst NICHT wie "ambiguous" mit
    // Kandidatenliste, sondern EIN Vorschlag mit Ja/Nein, weil nur ein
    // einziger, deutlich führender Treffer diesen Status überhaupt erreicht.
    return '<div class="voice-cand-list" data-idx="' + idx + '" data-side="' + side + '" data-kind="' + kind + '">'
      + '<div class="voice-cand-hint">🔊 „' + esc(res.query) + '" klingt wie ein Verhörer — passt das?</div>'
      + '<div class="row" style="gap:6px;margin:4px 0">'
      + '<button type="button" class="btn btn-sm btn-primary" onclick="CRM.voice._confirmPhonetic(' + idx + ',\'' + side + '\')">✓ Ja</button>'
      + '<button type="button" class="btn btn-sm" onclick="CRM.voice._rejectPhonetic(' + idx + ',\'' + side + '\')">✕ Nein, weitersuchen</button>'
      + '</div>'
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
    // A2 (Chris 2026-09-24): frei erzählter Bericht landet automatisch hier
    // (siehe CRM.voice._attachReports) — sichtbar und korrigierbar, statt
    // unsichtbar im Hintergrund zu verschwinden.
    candidatesHtml += '<label style="margin:6px 0 2px;font-size:12px;display:block">Besuchsbericht <span style="font-weight:400;color:var(--text-dim)">(landet im Besuchsprotokoll/Excel — automatisch aus deinem Text übernommen)</span></label>'
      + '<textarea class="voice-edit-input" rows="3" placeholder="(kein Bericht erkannt)" oninput="CRM.voice._updateCmdField(' + idx + ',\'report\',this.value)">' + esc(cmd.report || '') + '</textarea>';
    if ((cmd.report || '').trim()) {
      candidatesHtml += '<button class="btn btn-sm" style="margin-top:4px" onclick="CRM.voice._detachReport(' + idx + ')" title="Bericht stattdessen als eigene Journal-Notiz speichern, nicht im Besuchsprotokoll">✂ als eigene Notiz abtrennen</button>';
    }
    // A7: Bericht auch bei weiteren Kontakten desselben Bauvorhabens
    // vermerken — jede Baustelle hat für Chris immer auch einen
    // beliefernden Händler, der oft gar nicht namentlich genannt wird.
    if (cmd.projectResolution && cmd.projectResolution.status === 'resolved') {
      const proj = cmd.projectResolution.project;
      const visitedId = cmd.resolution && cmd.resolution.status === 'resolved' ? cmd.resolution.contact.id : null;
      const linked = (proj.contactIds || []).map((cid) => CRM.db.getContact(cid)).filter((c) => c && c.id !== visitedId);
      const haendler = linked.filter((c) => c.type === 'haendler');
      if (haendler.length) {
        candidatesHtml += '<div style="margin-top:8px;font-size:12px">Auch bei verknüpften Kontakten dieses Bauvorhabens vermerken:</div>'
          + haendler.map((h) => '<label style="display:flex;align-items:center;gap:6px;font-size:13px;margin-top:2px"><input type="checkbox" style="width:auto" ' + ((cmd.mirrorTo || []).indexOf(h.id) >= 0 ? 'checked' : '') + ' onchange="CRM.voice._toggleMirror(' + idx + ',\'' + h.id + '\',this.checked)"> ' + esc(h.firma1) + ' (Händler)</label>').join('');
      } else if (cmd.newHaendlerId) {
        candidatesHtml += '<div style="font-size:12px;color:var(--accent-2);margin-top:8px">✓ ' + esc((CRM.db.getContact(cmd.newHaendlerId) || {}).firma1 || '') + ' wird als beliefernder Händler verknüpft — <a href="#" onclick="event.preventDefault();CRM.voice._updateCmdField(' + idx + ',\'newHaendlerId\',null);CRM.voice._renderConfirmModal()">ändern</a></div>';
      } else if (!cmd.haendlerSkip) {
        candidatesHtml += '<div class="voice-cand-list" style="margin-top:8px">'
          + '<div class="voice-cand-hint">🏗 Kein Baustoffhändler für „' + esc(proj.name || 'dieses Bauvorhaben') + '" hinterlegt — wer beliefert diese Baustelle?</div>'
          + '<input type="text" class="voice-search-input" placeholder="Händler suchen…" oninput="CRM.voice._haendlerSearch(this,' + idx + ')">'
          + '<div class="voice-search-results" id="voice-haendler-res-' + idx + '"></div>'
          + '<button class="btn btn-sm" style="margin-top:4px" onclick="CRM.voice._skipHaendlerPrompt(' + idx + ')">✕ Jetzt nicht</button>'
          + '</div>';
      }
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
    const faelligLabel = cmd.due ? cmd.due.split('-').reverse().join('.') : 'heute';
    desc = 'Aufgabe anlegen' + bezug + ' — fällig ' + faelligLabel;
    // A3 (Chris 2026-09-24): aus dem Besuchsbericht abgeleiteter Vorschlag
    // — NIE vorausgewählt, zählt unangenommen auch nicht als übersprungen.
    if (cmd.suggested && !cmd.accepted) { desc = '💡 Vorschlag: ' + desc; ready = false; }
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
    if (cmd.suggested) {
      candidatesHtml += '<div class="row" style="gap:6px;margin-top:6px">'
        + (cmd.accepted
          ? '<span style="color:var(--accent-2);font-size:12px;align-self:center">✓ übernommen</span>'
          : '<button class="btn btn-sm btn-primary" onclick="CRM.voice._acceptSuggestedTask(' + idx + ')">✓ übernehmen</button>')
        + '<button class="btn btn-sm" onclick="CRM.voice._dropCmd(' + idx + ')">✕ weglassen</button>'
        + '</div>';
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
  } else if (cmd.intent === 'contactcreate') {
    candidatesHtml = CRM.voice._contactCreateHtml(cmd, idx);
    const treffer = cmd.match && cmd.match.treffer;
    const brauchtNeuenKontakt = !treffer || cmd.decision === 'forceNew'; // sonst nur Ansprechpartner/Öffnen — kein Typ nötig
    if (!(cmd.data.company || cmd.data.name)) ready = false;
    if (brauchtNeuenKontakt && !cmd.typ) ready = false;
    if (treffer && !cmd.decision) ready = false; // Chris muss aktiv eine der 3 Optionen wählen
    desc = '➕ Neuer Kontakt' + ((cmd.data.company || cmd.data.name) ? ': <strong>' + esc(cmd.data.company || cmd.data.name) + '</strong>' : ' <span style="color:var(--text-dim)">(noch keine Angaben)</span>');
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

/* Gemeinsamer Einstieg für alle drei Aufrufstellen (Aufnahme prüfen, "Neu
   prüfen", Verlauf erneut prüfen) — läuft über CRM.voice.analyze() statt
   direkt über parseUtterance() (Chris 2026-09-24: "Termin"/Stichpunkte/
   neuer Kontakt/Verhörer-Korrektur). _lastRawText merkt sich den Text VOR
   der Verhörer-Korrektur, damit "↺ ohne Korrektur prüfen" wieder vom
   Original ausgehen kann. */
CRM.voice._runAnalyze = function (text, skipAsrFixes) {
  CRM.voice._lastTranscript = text;
  if (!skipAsrFixes) CRM.voice._lastRawText = text;
  const result = CRM.voice.analyze(text, { skipAsrFixes: !!skipAsrFixes });
  CRM.voice._pending = result.commands;
  CRM.voice._pendingFixes = result.fixes || [];
  CRM.voice._logHistory(text, result.commands);
  CRM.voice._renderConfirmModal();
};
CRM.voice._reparseWithoutFixes = function () {
  CRM.voice._runAnalyze(CRM.voice._lastRawText || CRM.voice._lastTranscript, true);
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
  CRM.voice._runAnalyze(h.text);
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
  // A5: sichtbarer, abschaltbarer Hinweis auf automatisch korrigierte
  // Verhörer (Josima→YOSIMA u.ä.) — Chris soll nie unbemerkt etwas anderes
  // verstanden bekommen, als er gesagt hat.
  const fixesHtml = (CRM.voice._pendingFixes && CRM.voice._pendingFixes.length)
    ? '<p style="font-size:12px;color:var(--text-dim);margin:4px 0 10px">🔤 Automatisch korrigiert: ' + esc(CRM.voice._pendingFixes.join(', '))
      + ' — <a href="#" onclick="event.preventDefault();CRM.voice._reparseWithoutFixes()">ohne Korrektur prüfen</a></p>'
    : '';
  const html = '<h2>🎤 Sprachbefehl bestätigen</h2>'
    + '<label style="margin-top:0">Erkannter Text <span style="font-weight:400;color:var(--text-dim)">(bei Bedarf korrigieren, dann „Neu prüfen")</span></label>'
    + '<textarea id="voice-confirm-text" rows="2">' + esc(CRM.voice._lastTranscript || '') + '</textarea>'
    + fixesHtml
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
  CRM.voice._runAnalyze(text);
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
  let res = CRM.voice._resForSide(cmd, side);
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

/* Klanglicher Vorschlag (A6) bestätigt/abgelehnt — NIE automatisch, immer
   ein bewusster Tipp. Bestätigt: wird zu einem normalen 'resolved'-Treffer
   (gleiche Objekt-Referenz, geteilte Kontexte aktualisieren sich mit).
   Abgelehnt: zurück zu 'notfound', das normale Suchfeld erscheint. */
CRM.voice._confirmPhonetic = function (idx, side) {
  const cmd = (CRM.voice._pending || [])[idx];
  const res = cmd && CRM.voice._resForSide(cmd, side);
  if (!res || res.status !== 'phonetic') return;
  res.status = 'resolved';
  CRM.voice._renderConfirmModal();
};
CRM.voice._rejectPhonetic = function (idx, side) {
  const cmd = (CRM.voice._pending || [])[idx];
  const res = cmd && CRM.voice._resForSide(cmd, side);
  if (!res || res.status !== 'phonetic') return;
  res.status = 'notfound';
  if ('contact' in res) res.contact = null;
  if ('project' in res) res.project = null;
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

/* ============================================================
   A4: "Neuer Kontakt" / vorgelesene Signatur — Vorschau-Karte. Baut die
   "Variante B"-Bestätigungskarte (email-parser.js/mailAblage) im eigenen
   DOM der Sprachvorschau nach, weil renderMatch()/showNeuForm() fest an
   die #ma-*-Feld-IDs der Mail-Ablage gebunden sind. Bindet stattdessen an
   cmd.data.* über _updateContactField.
   ============================================================ */
CRM.voice._updateContactField = function (idx, key, value) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.data[key] = value;
};
CRM.voice._setContactType = function (idx, value) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.typ = value;
};
/* Entscheidung bei Bestandstreffer (Chris 2026-09-24, Beispiel 3): primär
   "Ansprechpartner hinzufügen" statt eine zweite Firma anzulegen. */
CRM.voice._setContactDecision = function (idx, decision) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.decision = decision;
  CRM.voice._renderConfirmModal();
};
CRM.voice._contactCreateHtml = function (cmd, idx) {
  const d = cmd.data || {};
  const m = cmd.match;
  const field = (label, key, opts) => '<div class="col" style="min-width:' + ((opts && opts.w) || 160) + 'px"><label>' + label + '</label>'
    + '<input class="' + (d._confidence && d._confidence[key] === 'low' ? 'ep-unsicher' : '') + '" value="' + escAttr(d[key] || '') + '" oninput="CRM.voice._updateContactField(' + idx + ',\'' + key + '\',this.value)"></div>';
  const typeOpts = '<option value="">– bitte wählen –</option>' + CRM.TYPES.map((t) => '<option value="' + t + '"' + (t === cmd.typ ? ' selected' : '') + '>' + CRM.TYPE_LABELS[t] + '</option>').join('');
  let html = '';
  if (m && m.unsicher && m.gruende.length) {
    html += '<div style="font-size:12px;color:var(--orange);margin-bottom:6px">⚠ ' + m.gruende.map(esc).join(' · ') + '</div>';
  }
  if (m && m.treffer) {
    const t = m.treffer;
    html += '<div style="background:rgba(90,155,255,.12);border:1px solid var(--accent);border-radius:8px;padding:8px 12px;margin-bottom:8px">'
      + '<div>💡 Gibt es schon: <strong>' + esc(t.firma1) + '</strong> <span style="color:var(--text-dim);font-size:12px">(' + esc(t.plz) + ' ' + esc(t.ort) + ')</span></div>'
      + '<div class="row" style="gap:6px;margin-top:6px;flex-wrap:wrap">'
      + '<button class="btn btn-sm btn-primary" onclick="CRM.voice._setContactDecision(' + idx + ',\'addAp\')">✓ Ansprechpartner hinzufügen' + (cmd.decision === 'addAp' ? ' ✓' : '') + '</button>'
      + '<button class="btn btn-sm" onclick="CRM.voice._setContactDecision(' + idx + ',\'open\')">→ Nur Kontakt öffnen' + (cmd.decision === 'open' ? ' ✓' : '') + '</button>'
      + '<button class="btn btn-sm" onclick="CRM.voice._setContactDecision(' + idx + ',\'forceNew\')">Trotzdem als neue Firma anlegen' + (cmd.decision === 'forceNew' ? ' ✓' : '') + '</button>'
      + '</div></div>';
  }
  const felderAusblenden = m && m.treffer && cmd.decision && cmd.decision !== 'forceNew';
  if (!felderAusblenden) {
    html += '<div class="row" style="flex-wrap:wrap;gap:8px">' + field('Firma', 'company', { w: 200 }) + field('Name', 'name', { w: 200 }) + '</div>'
      + '<div class="row" style="flex-wrap:wrap;gap:8px">' + field('Funktion', 'title') + field('Straße', 'street') + '</div>'
      + '<div class="row" style="flex-wrap:wrap;gap:8px">' + field('PLZ', 'postal', { w: 90 }) + field('Ort', 'city') + '</div>'
      + '<div class="row" style="flex-wrap:wrap;gap:8px">' + field('Telefon', 'phone_work') + field('Mobil', 'phone_mobile') + field('E-Mail', 'email', { w: 200 }) + '</div>'
      + '<div class="row" style="flex-wrap:wrap;gap:8px"><div class="col" style="min-width:160px"><label>Kontakttyp</label><select onchange="CRM.voice._setContactType(' + idx + ',this.value)">' + typeOpts + '</select></div></div>';
  }
  if (!(d.company || d.name)) {
    html += '<p style="color:var(--text-dim);font-size:12px;margin-top:6px">Signatur ins Textfeld oben diktieren/einfügen und „🔄 Neu prüfen" — oder Felder direkt ausfüllen.</p>';
  }
  return html;
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

/* ---------- A7: Bericht auch bei verknüpften/neu zu verknüpfenden
   Händlern desselben Bauvorhabens (Chris 2026-09-24) ---------- */
CRM.voice._toggleMirror = function (idx, contactId, on) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.mirrorTo = cmd.mirrorTo || [];
  const i = cmd.mirrorTo.indexOf(contactId);
  if (on && i < 0) cmd.mirrorTo.push(contactId);
  else if (!on && i >= 0) cmd.mirrorTo.splice(i, 1);
  // Kein Neuzeichnen nötig — reine Checkbox-Zustandsänderung, würde sonst
  // das Bericht-Textfeld mitten im Tippen den Fokus rauben.
};
CRM.voice._haendlerSearch = function (input, idx) {
  const q = input.value.trim();
  const results = document.getElementById('voice-haendler-res-' + idx);
  if (!results) return;
  if (!q) { results.innerHTML = ''; return; }
  const items = CRM.db.getContacts().filter((c) => !c.archived && c.type === 'haendler' && CRM.contactQueryMatch(q, c)).slice(0, 8);
  results.innerHTML = items.length
    ? items.map((c) => CRM.voice._candRowHtml(c, 'contact')).join('')
    : '<div style="color:var(--text-dim);font-size:12px;padding:4px 2px">Keine Treffer unter den Händlern — <a href="#" onclick="event.preventDefault();CRM.voice._haendlerSearchAlleTypen(\'' + esc(q).replace(/'/g, '&#39;') + '\',' + idx + ')">auch andere Typen zeigen</a></div>';
  results.querySelectorAll('.voice-cand-row').forEach((row) => {
    row.addEventListener('click', () => { CRM.voice._pickHaendler(idx, row.dataset.id); });
  });
};
CRM.voice._haendlerSearchAlleTypen = function (q, idx) {
  const results = document.getElementById('voice-haendler-res-' + idx);
  if (!results) return;
  const items = CRM.db.getContacts().filter((c) => !c.archived && CRM.contactQueryMatch(q, c)).slice(0, 8);
  results.innerHTML = items.length ? items.map((c) => CRM.voice._candRowHtml(c, 'contact')).join('') : '<div style="color:var(--text-dim);font-size:12px;padding:4px 2px">Keine Treffer.</div>';
  results.querySelectorAll('.voice-cand-row').forEach((row) => {
    row.addEventListener('click', () => { CRM.voice._pickHaendler(idx, row.dataset.id); });
  });
};
CRM.voice._pickHaendler = function (idx, contactId) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.newHaendlerId = contactId;
  cmd.haendlerSkip = false;
  CRM.voice._renderConfirmModal();
};
CRM.voice._skipHaendlerPrompt = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.haendlerSkip = true;
  CRM.voice._renderConfirmModal();
};

/* Bericht stattdessen als eigene Journal-Notiz speichern (Chris will es
   nicht im offiziellen Besuchsprotokoll) — KOPIE der Kontakt-Zuordnung,
   wie bei einer aus "nicht zugeordnet" erzeugten Aufgabe: eine spätere
   Korrektur hier darf den Besuch selbst nicht mitverändern. */
CRM.voice._detachReport = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd || !(cmd.report || '').trim()) return;
  const noteCmd = {
    intent: 'note', start: cmd.start, end: cmd.end,
    rawText: cmd.report, content: cmd.report,
    resolution: cmd.resolution ? Object.assign({}, cmd.resolution) : { status: 'notfound', query: '', contact: null },
  };
  cmd.report = '';
  CRM.voice._pending.splice(idx + 1, 0, noteCmd);
  CRM.voice._renderConfirmModal();
};

/* Vorschau-Zeile komplett verwerfen (A3: eine nicht angenommene Aufgaben-
   Vorschlagszeile). */
CRM.voice._dropCmd = function (idx) {
  if (!CRM.voice._pending) return;
  CRM.voice._pending.splice(idx, 1);
  CRM.voice._renderConfirmModal();
};
CRM.voice._acceptSuggestedTask = function (idx) {
  const cmd = (CRM.voice._pending || [])[idx];
  if (!cmd) return;
  cmd.accepted = true;
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
    // A2 (Chris 2026-09-24): auch hier den zuletzt genannten Kontakt als
    // Vorschlag übernehmen (Kopie, siehe Funktionskommentar oben) und ein
    // im Text genanntes Datum statt immer "heute" verwenden.
    const ctx = CRM.voice._contextContact(CRM.voice._pending, idx);
    cmd.resolution = ctx ? Object.assign({}, ctx) : null;
    cmd.targetExplicit = false;
    if (window.CRM && CRM.speech && CRM.speech.parseGermanDate) {
      const d = CRM.speech.parseGermanDate(cmd.rawText, CRM.ymd(new Date()));
      if (d) cmd.due = d.iso;
    }
  }
  CRM.voice._renderConfirmModal();
};

/* "→ in Bericht übernehmen" an einer unsupported-Zeile (A2): hängt den
   Text an den zuletzt genannten Besuch (bzw. die ganze Kette) an, statt
   ihn als eigenen, unausführbaren Befehl stehen zu lassen. */
CRM.voice._promoteUnsupportedToReport = function (idx) {
  const all = CRM.voice._pending || [];
  const cmd = all[idx];
  if (!cmd) return;
  let chainStart = null;
  for (let i = idx - 1; i >= 0; i--) {
    if (all[i].intent === 'visit') { chainStart = all[i].start; break; }
    if (['link', 'projectcreate', 'projectnote'].indexOf(all[i].intent) >= 0) break;
  }
  if (chainStart == null) { CRM.toast('Kein vorheriger Besuch im Satz gefunden.', 'error'); return; }
  all.filter((c) => c.intent === 'visit' && c.start === chainStart).forEach((v) => {
    v.report = v.report ? v.report + '\n' + cmd.rawText : cmd.rawText;
  });
  all.splice(idx, 1);
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
  let openContactTarget = null; // dito für "→ Nur Kontakt öffnen" (A4)

  commands.forEach((cmd) => {
    if (cmd.intent === 'unrecognized') return;
    if (cmd.intent === 'unsupported') { skipped++; return; }

    if (cmd.intent === 'visit') {
      if (cmd.resolution && cmd.resolution.status === 'resolved') {
        CRM.addVisit(cmd.resolution.contact.id, null, (cmd.report || '').trim());
        // Bauvorhaben-Verknüpfung ist Zusatznutzen: nur verknüpfen, wenn
        // aufgelöst — bleibt es offen/unklar, wird der Besuch trotzdem
        // ganz normal angelegt (kein skipped, kein Blockieren).
        if (cmd.projectResolution && cmd.projectResolution.status === 'resolved') {
          const projId = cmd.projectResolution.project.id;
          CRM.linkContactToProject(cmd.resolution.contact.id, projId);
          // A7: Bericht zusätzlich bei bereits verknüpften Kontakten
          // hinterlegen, die Chris in der Vorschau angehakt hat.
          (cmd.mirrorTo || []).forEach((cid) => {
            if (cid && cid !== cmd.resolution.contact.id) CRM.addVisit(cid, null, (cmd.report || '').trim());
          });
          // A7: neu ausgewählter, bisher nicht verknüpfter Händler — wird
          // dauerhaft mit dem Bauvorhaben verknüpft UND bekommt denselben Bericht.
          if (cmd.newHaendlerId && cmd.newHaendlerId !== cmd.resolution.contact.id) {
            CRM.linkContactToProject(cmd.newHaendlerId, projId);
            CRM.addVisit(cmd.newHaendlerId, null, (cmd.report || '').trim());
          }
        }
        done++;
      } else skipped++;
    } else if (cmd.intent === 'contactcreate') {
      const treffer = cmd.match && cmd.match.treffer;
      if (treffer && cmd.decision === 'open') {
        openContactTarget = treffer.id;
        done++;
      } else if (treffer && cmd.decision === 'addAp') {
        CRM.addAnsprechpartnerData(treffer.id, CRM.emailParser.apFromData(cmd.data));
        done++;
      } else if ((!treffer || cmd.decision === 'forceNew') && (cmd.data.company || cmd.data.name) && cmd.typ) {
        const c = CRM.emailParser.toContact(cmd.data, cmd.typ, 'eigene');
        const saved = CRM.emailParser._addContactMitNachlauf(c, { openDetail: false, toast: false });
        openContactTarget = saved.id;
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
      // Vorschlag (A3, aus dem Bericht abgeleitet) ohne "✓ übernehmen":
      // zählt NICHT als übersprungen — Chris hat ihn nie angefordert.
      if (cmd.suggested && !cmd.accepted) return;
      const res = cmd.resolution;
      const zielOffen = cmd.targetExplicit && !(res && res.status === 'resolved');
      if (cmd.title && !zielOffen) {
        CRM.db.addTask({
          title: cmd.title,
          due: cmd.due || CRM.ymd(new Date()),
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
  else if (openContactTarget) CRM.openContactDetail(openContactTarget);
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
  CRM.voice._runAnalyze(text);
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
