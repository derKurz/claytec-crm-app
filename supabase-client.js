/* ============================================================
   Claytec CRM — Phase 3 der Migration (OFFLINE_SYNC.md): Supabase
   Erster, bewusst kleiner Schritt: nur Client + Verbindungstest.
   NOCH KEINE echte Synchronisation (Sync-Queue/Realtime folgt erst,
   wenn die Verbindung sich im Alltag bewährt hat — siehe AskUserQuestion-
   Entscheidung "erst nur Verbindung testen").

   Zugangsdaten (Project URL + Publishable/"anon" Key) liegen in den
   Einstellungen (CRM.db.getSettings()), nicht im Code — analog zum
   onedrivePath-Muster. Der Publishable Key ist bewusst fürs Client-
   Bundle gedacht (durch Row Level Security abgesichert), trotzdem bleibt
   er konfigurierbar statt hartkodiert, damit er sich ohne Code-Änderung
   austauschen lässt.
   ============================================================ */
var CRM = window.CRM || {};
window.CRM = CRM;

CRM.supabase = null;
CRM.supabaseUser = null;

/* Verzeiht versehentlich eingefügte REST-Endpunkt-URLs
   (".../rest/v1/" oder mit Trailing Slash) — der JS-Client braucht die
   reine Project-URL ohne Pfad. */
CRM.normalizeSupabaseUrl = function (raw) {
  return String(raw || '').trim().replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
};

CRM.initSupabase = function () {
  const s = CRM.db.getSettings();
  const url = CRM.normalizeSupabaseUrl(s.supabaseUrl);
  const key = String(s.supabasePublishableKey || '').trim();
  if (!url || !key) {
    CRM.supabase = null;
    return null;
  }
  if (typeof window.supabase === 'undefined' || !window.supabase.createClient) {
    console.error('Supabase-JS-Bibliothek nicht geladen.');
    CRM.supabase = null;
    return null;
  }
  try {
    CRM.supabase = window.supabase.createClient(url, key);
    CRM.supabase.auth.getSession().then(({ data }) => {
      CRM.supabaseUser = data.session ? data.session.user : null;
      if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
    });
    CRM.supabase.auth.onAuthStateChange((event, session) => {
      CRM.supabaseUser = session ? session.user : null;
      if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
    });
    return CRM.supabase;
  } catch (e) {
    console.error('Supabase-Client konnte nicht erstellt werden.', e);
    CRM.supabase = null;
    return null;
  }
};

/* ---------- Anmeldung (nur für Cloud-Sync nötig, App bleibt ohne
   Login vollständig lokal nutzbar — Offline-first-Prinzip aus
   OFFLINE_SYNC.md). Es gibt bewusst keine Registrierung im Code: der
   einzige Zugang wird einmalig im Supabase-Dashboard angelegt
   (Authentication → Users → Add user). ---------- */
CRM.supabaseSignIn = async function (email, password) {
  if (!CRM.supabase) CRM.initSupabase();
  if (!CRM.supabase) {
    CRM.toast('Supabase ist nicht konfiguriert — erst URL/Key speichern.', 'error');
    return { ok: false };
  }
  const { data, error } = await CRM.supabase.auth.signInWithPassword({ email, password });
  if (error) {
    CRM.toast('Anmeldung fehlgeschlagen: ' + error.message, 'error');
    return { ok: false, error };
  }
  CRM.supabaseUser = data.user;
  CRM.toast('Angemeldet als ' + data.user.email, 'success');
  if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
  return { ok: true, user: data.user };
};

CRM.supabaseSignOut = async function () {
  if (!CRM.supabase) return;
  await CRM.supabase.auth.signOut();
  CRM.supabaseUser = null;
  CRM.toast('Abgemeldet.', 'success');
  if (document.querySelector('#view-einstellungen.active')) CRM.renderSettings();
};

CRM.openSupabaseLoginModal = function () {
  CRM.openModal(`
    <h2>🔐 Bei Supabase anmelden</h2>
    <p style="color:var(--text-dim);font-size:13px">Nur für den Cloud-Sync nötig — die App funktioniert auch ohne Anmeldung weiterhin vollständig lokal.</p>
    <label>E-Mail</label>
    <input type="email" id="sb-login-email" placeholder="du@beispiel.de">
    <label style="margin-top:10px">Passwort</label>
    <input type="password" id="sb-login-password">
    <div class="modal-footer">
      <button class="btn" onclick="CRM.closeModal()">Abbrechen</button>
      <button class="btn btn-primary" id="sb-login-go">Anmelden</button>
    </div>
  `);
  document.getElementById('sb-login-go').addEventListener('click', async () => {
    const email = document.getElementById('sb-login-email').value.trim();
    const password = document.getElementById('sb-login-password').value;
    if (!email || !password) {
      CRM.toast('E-Mail und Passwort eingeben.', 'error');
      return;
    }
    const btn = document.getElementById('sb-login-go');
    btn.disabled = true;
    btn.textContent = 'Anmelden…';
    const result = await CRM.supabaseSignIn(email, password);
    if (result.ok) {
      CRM.closeModal();
    } else {
      btn.disabled = false;
      btn.textContent = 'Anmelden';
    }
  });
};

/* Verbindungstest ohne Annahme, dass schon Tabellen existieren (Schema/
   SQL-Migration ist ein eigener, späterer Schritt). "relation does not
   exist" gilt hier ausdrücklich als ERFOLG — der Server wurde erreicht
   und der Key wurde akzeptiert, es fehlt nur noch das Schema. */
CRM.testSupabaseConnection = async function () {
  if (!CRM.supabase) CRM.initSupabase();
  if (!CRM.supabase) {
    CRM.toast('Supabase-URL/Key fehlt oder ungültig — bitte in den Einstellungen prüfen.', 'error');
    return { ok: false, reason: 'not-configured' };
  }
  try {
    const { error } = await CRM.supabase.from('config').select('key').limit(1);
    if (!error) {
      CRM.toast('✅ Verbindung erfolgreich — Tabelle „config" existiert bereits.', 'success');
      return { ok: true, schemaExists: true };
    }
    if (error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message || '')) {
      CRM.toast('✅ Verbindung erfolgreich (Server erreicht, Key akzeptiert) — Schema/Tabellen fehlen noch, das ist normal im jetzigen Schritt.', 'success');
      return { ok: true, schemaExists: false };
    }
    CRM.toast('⚠️ Verbindung fehlgeschlagen: ' + error.message, 'error');
    return { ok: false, reason: error.message };
  } catch (e) {
    CRM.toast('⚠️ Verbindung fehlgeschlagen: ' + (e && e.message ? e.message : e), 'error');
    return { ok: false, reason: e && e.message };
  }
};
