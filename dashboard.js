/* ============================================================
   Claytec CRM — Start-Dashboard
   Cockpit beim App-Start: 4 Kennzahlen (Ampel-Überblick), die zwei
   dringendsten Einträge als Teaser (Rest über „Heute"), Schnellaktionen
   in der Daumen-Zone. Reine Lese-Aggregation über bestehende Funktionen
   (computeAgenda, computeTaskBuckets, getProjects) — kein eigener State.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.renderDashboard = function () {
  const container = document.getElementById('view-start');
  if (!container) return;

  const visits = CRM.computeAgenda();
  const tasks = CRM.computeTaskBuckets();
  const openTasks = CRM.db.getTasks().filter((t) => !t.done).length;
  const runningProjects = CRM.db.getProjects().filter((p) => p.status === 'laufend').length;
  const dueToday = visits.today.length + tasks.today.length;

  const now = new Date();
  const hour = now.getHours();
  const greeting = hour < 11 ? 'Guten Morgen' : (hour < 17 ? 'Guten Tag' : 'Guten Abend');
  const dateLabel = now.toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long' });

  container.innerHTML = `
    <div id="dash-root">
      <div class="dash-head">
        <div class="dash-date">${dateLabel}</div>
        <h2>${greeting}, Chris</h2>
      </div>

      <div class="dash-kpis">
        <button class="dash-kpi ${visits.overdue.length ? 'dash-kpi-red' : ''}" onclick="CRM.switchTab('agenda')">
          <span class="dash-kpi-num">${visits.overdue.length}</span>
          <span class="dash-kpi-label">Besuche überfällig</span>
        </button>
        <button class="dash-kpi ${dueToday ? 'dash-kpi-orange' : ''}" onclick="CRM.switchTab('agenda')">
          <span class="dash-kpi-num">${dueToday}</span>
          <span class="dash-kpi-label">Heute fällig</span>
        </button>
        <button class="dash-kpi" onclick="CRM.switchTab('agenda')">
          <span class="dash-kpi-num">${openTasks}</span>
          <span class="dash-kpi-label">Offene Aufgaben</span>
        </button>
        <button class="dash-kpi" onclick="CRM.switchTab('projekte')">
          <span class="dash-kpi-num">${runningProjects}</span>
          <span class="dash-kpi-label">Laufende Projekte</span>
        </button>
      </div>

      <div class="dash-section">
        <div class="dash-section-head">
          <span>Als Nächstes dran</span>
          <button class="btn btn-sm" onclick="CRM.switchTab('agenda')">Alle in „Heute" →</button>
        </div>
        ${CRM.dashboardNextUpHtml(visits, tasks)}
      </div>

      <div class="dash-section">
        <div class="dash-section-head"><span>Heute erfasst</span></div>
        ${CRM.dashboardTodayHtml()}
      </div>

      <div class="dash-actions">
        <button class="dash-action dash-action-primary" onclick="CRM.dashboardVoiceNote()">🎤 Sprachnotiz aufnehmen</button>
        <div class="dash-actions-row">
          <button class="dash-action" onclick="CRM.createNewContact()">➕ Neuer Kontakt</button>
          <button class="dash-action" onclick="CRM.switchTab('karte')">🚗 Tour planen</button>
        </div>
      </div>
    </div>
  `;
};

/* Die zwei dringendsten Einträge: erst Überfälliges (Besuche vor Aufgaben,
   je nach Rückstand), dann heute Fälliges. Buckets sind bereits sortiert
   (Besuche: A vor B vor C, dann Dringlichkeit). */
CRM.dashboardNextUpHtml = function (visits, tasks) {
  const items = [];
  visits.overdue.forEach(({ c, due }) => items.push({ kind: 'visit', c, diff: due.diffDays }));
  tasks.overdue.forEach(({ t, st }) => items.push({ kind: 'task', t, diff: st.diffDays }));
  items.sort((a, b) => a.diff - b.diff);
  visits.today.forEach(({ c, due }) => items.push({ kind: 'visit', c, diff: due.diffDays }));
  tasks.today.forEach(({ t, st }) => items.push({ kind: 'task', t, diff: st.diffDays }));

  const top = items.slice(0, 2);
  if (!top.length) {
    return '<div class="dash-empty">Nichts Dringendes — alles im grünen Bereich. ✅</div>';
  }

  return top.map((it) => {
    if (it.kind === 'visit') {
      const c = it.c;
      const label = it.diff < 0 ? `${-it.diff} Tage überfällig` : 'heute fällig';
      return `
        <div class="dash-next" onclick="CRM.openContactDetail('${c.id}')">
          <span class="dash-next-icon">📍</span>
          <div class="dash-next-main">
            <div class="dash-next-title">${esc(c.firma1)} ${c.isPartner ? '⭐' : ''}</div>
            <div class="dash-next-sub">${c.abc}-Kunde · ${esc(c.plz)} ${esc(c.ort)} · ${label}</div>
          </div>
          <span class="dash-next-chev">›</span>
        </div>`;
    }
    const t = it.t;
    const c = t.contactId ? CRM.db.getContact(t.contactId) : null;
    const label = it.diff < 0 ? `${-it.diff} Tage überfällig` : 'heute fällig';
    const open = c ? `CRM.openContactDetail('${c.id}')` : `CRM.switchTab('agenda')`;
    return `
      <div class="dash-next" onclick="${open}">
        <span class="dash-next-icon">✓</span>
        <div class="dash-next-main">
          <div class="dash-next-title">${esc(t.title)}</div>
          <div class="dash-next-sub">${c ? esc(c.firma1) + ' · ' : ''}${label}</div>
        </div>
        <span class="dash-next-chev">›</span>
      </div>`;
  }).join('');
};

/* Tagesübersicht: alles, was HEUTE eingetragen oder geändert wurde —
   Besuche (neu/geändert), Journal-Einträge, Aufgaben (angelegt/erledigt),
   neue Kontakte. Tipp auf einen Eintrag öffnet den Kontakt. */
CRM.dashboardTodayHtml = function () {
  const todayStr = CRM.ymd(new Date());
  const isToday = (iso) => iso && CRM.ymd(new Date(iso)) === todayStr;
  const items = [];

  CRM.db.getContacts().forEach((c) => {
    (c.visits || []).forEach((v) => {
      if (isToday(v.createdAt)) {
        items.push({ ts: v.createdAt, icon: '📍', title: `Besuch erfasst: ${c.firma1}`, sub: v.note ? v.note.slice(0, 60) : ('Besuchsdatum ' + v.date), contactId: c.id });
      } else if (isToday(v.updatedAt)) {
        items.push({ ts: v.updatedAt, icon: '✏️', title: `Besuch geändert: ${c.firma1}`, sub: 'Besuchsdatum ' + v.date, contactId: c.id });
      }
    });
    if (isToday(c.createdAt)) {
      items.push({ ts: c.createdAt, icon: '👤', title: `Kontakt angelegt: ${c.firma1}`, sub: [c.plz, c.ort].filter(Boolean).join(' '), contactId: c.id });
    }
  });

  CRM.db.getJournalEntries().forEach((j) => {
    if (!isToday(j.createdAt)) return;
    const c = j.contactId ? CRM.db.getContact(j.contactId) : null;
    const typeLabel = (CRM.JOURNAL_TYPE_LABELS && CRM.JOURNAL_TYPE_LABELS[j.type]) || 'Notiz';
    items.push({ ts: j.createdAt, icon: '📓', title: `${typeLabel}: ${c ? c.firma1 : 'Ohne Kontakt'}`, sub: (j.text || '').slice(0, 60), contactId: j.contactId });
  });

  CRM.db.getComms().forEach((m) => {
    if (!isToday(m.createdAt)) return;
    const c = (m.contactIds || []).length ? CRM.db.getContact(m.contactIds[0]) : null;
    const dirLabel = m.direction === 'out' ? 'ausgehend' : 'eingehend';
    const label = m.type === 'email' ? `E-Mail (${dirLabel})` : (CRM.COMM_TYPE_LABELS[m.type] || 'Kommunikation').replace(/^[^\w]+/, '');
    items.push({ ts: m.createdAt, icon: '✉️', title: `${label}: ${c ? c.firma1 : 'Ohne Kontakt'}`, sub: (m.subject || '').slice(0, 60), contactId: c ? c.id : null });
  });

  CRM.db.getTasks().forEach((t) => {
    const c = t.contactId ? CRM.db.getContact(t.contactId) : null;
    if (isToday(t.doneAt)) {
      items.push({ ts: t.doneAt, icon: '✅', title: `Aufgabe erledigt: ${t.title}`, sub: c ? c.firma1 : 'Allgemein', contactId: t.contactId });
    } else if (isToday(t.createdAt)) {
      items.push({ ts: t.createdAt, icon: '➕', title: `Aufgabe angelegt: ${t.title}`, sub: (c ? c.firma1 + ' · ' : '') + 'fällig ' + (t.due || '–'), contactId: t.contactId });
    }
  });

  items.sort((a, b) => (a.ts < b.ts ? 1 : -1));
  const top = items.slice(0, 15);
  if (!top.length) return '<div class="dash-empty">Heute noch nichts erfasst.</div>';

  const time = (iso) => new Date(iso).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  return top.map((it) => `
    <div class="dash-next" onclick="${it.contactId ? `CRM.openContactDetail('${it.contactId}')` : `CRM.switchTab('agenda')`}">
      <span class="dash-next-icon">${it.icon}</span>
      <div class="dash-next-main">
        <div class="dash-next-title">${esc(it.title)}</div>
        <div class="dash-next-sub">${time(it.ts)} Uhr${it.sub ? ' · ' + esc(it.sub) : ''}</div>
      </div>
      <span class="dash-next-chev">›</span>
    </div>`).join('')
    + (items.length > 15 ? `<div class="dash-empty">+ ${items.length - 15} weitere Einträge</div>` : '');
};

/* Sprachnotiz vom Dashboard: erst Kontakt wählen (Suche wie Header-Suche),
   dann direkt in den bestehenden Aufnahme-Dialog (CRM.speech.openCapture). */
CRM.dashboardVoiceNote = function () {
  CRM.openModal(`
    <h2>🎤 Sprachnotiz — Kontakt wählen</h2>
    <input type="text" id="dash-voice-search" placeholder="Firma, Ort, PLZ, ERP-Nr..." autocomplete="off">
    <div id="dash-voice-results" style="margin-top:8px"></div>
    <div class="modal-footer"><button class="btn" onclick="CRM.closeModal()">Abbrechen</button></div>
  `);
  const input = document.getElementById('dash-voice-search');
  const results = document.getElementById('dash-voice-results');
  const norm = (s) => String(s || '').toLowerCase();

  const render = () => {
    const q = norm(input.value).trim();
    if (!q) { results.innerHTML = '<div class="dash-empty">Tippe, um einen Kontakt zu suchen.</div>'; return; }
    const matches = CRM.db.getContacts().filter((c) => {
      const ap = c.ansprechpartner || {};
      return norm(c.firma1).includes(q) || norm(c.ort).includes(q) || norm(c.plz).includes(q)
        || norm(ap.name).includes(q) || norm(ap.vorname).includes(q) || norm(c.erpNr).includes(q);
    }).slice(0, 8);
    if (!matches.length) { results.innerHTML = '<div class="dash-empty">Keine Treffer.</div>'; return; }
    results.innerHTML = matches.map((c) => `
      <div class="dash-next" data-id="${c.id}">
        <span class="dash-next-icon">🎤</span>
        <div class="dash-next-main">
          <div class="dash-next-title">${esc(c.firma1)} ${c.isPartner ? '⭐' : ''}</div>
          <div class="dash-next-sub">${esc(c.plz)} ${esc(c.ort)} · ${CRM.TYPE_LABELS[c.type] || ''}</div>
        </div>
        <span class="dash-next-chev">›</span>
      </div>`).join('');
    results.querySelectorAll('.dash-next').forEach((row) => {
      row.addEventListener('click', () => {
        const id = row.dataset.id;
        CRM.closeModal();
        CRM.speech.openCapture(id);
      });
    });
  };

  input.addEventListener('input', render);
  render();
  setTimeout(() => input.focus(), 100);
};
