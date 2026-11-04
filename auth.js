// Ledger sign-in (Supabase Auth, passwordless email) + authenticated requests + local-data cleanup.
//
// * Sign-in: signInWithOtp({ email }) sends one email holding BOTH a sign-in link and a 6-digit code.
//   The link works in a browser tab; the code is what makes sign-in work in the Home Screen app on
//   iPhone (a link from Mail opens Safari, which can't hand its session to the installed app).
// * The session (access + refresh token) is kept by supabase-js in this device's localStorage
//   ("ledger.auth") and refreshed automatically, so reopening the app stays signed in.
// * Every API request carries `Authorization: Bearer <access token>`.
// * Local data (cached lists, offline queue, preferences) lives under "ledger.u.<user id>.", so two
//   people using one device never see each other's cache; sign-out wipes everything stored by Ledger.
"use strict";
window.LedgerAuth = (() => {
  const URL_ = (window.SUPABASE_URL || "").replace(/\/+$/, "");
  const KEY = window.SUPABASE_PUBLISHABLE_KEY || "";
  const configured = !!(URL_ && KEY && window.supabase?.createClient);
  const client = configured ? window.supabase.createClient(URL_, KEY, {
    auth: {
      storageKey: "ledger.auth",
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true,    // the email link lands here with the session in the URL fragment
      flowType: "implicit",        // the link also works when opened in another browser than the one that asked
    },
  }) : null;
  let session = null;
  const listeners = new Set();

  async function init() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    session = data.session;
    client.auth.onAuthStateChange((event, s) => {
      session = s;
      for (const f of listeners) { try { f(event, s); } catch { /* listener errors don't break auth */ } }
    });
    // the sign-in link put the tokens in the URL: remove them from the address bar / history
    if (/access_token=|error_description=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    return session;
  }
  const onChange = (f) => { listeners.add(f); return () => listeners.delete(f); };

  const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
  function friendly(error) {
    const m = String(error?.message || error || "");
    if (/rate limit|too many|seconds/i.test(m)) return "Too many emails in a short time. Wait a minute and try again.";
    if (/expired|invalid/i.test(m)) return "That code is wrong or has expired. Request a new one.";
    if (/not authorized|signups not allowed/i.test(m)) return "This email can't sign in to Ledger.";
    if (/fetch|network|load failed/i.test(m)) return "No connection. Check your internet and try again.";
    return m || "Something went wrong. Try again.";
  }
  async function sendCode(email) {
    if (!client) throw new Error("Sign-in isn't set up on this copy of Ledger yet (config.js).");
    email = String(email || "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new Error("Enter a valid email address.");
    const { error } = await client.auth.signInWithOtp({
      email, options: { shouldCreateUser: true, emailRedirectTo: location.origin + location.pathname },
    });
    if (error) throw new Error(friendly(error));
    return email;
  }
  async function verifyCode(email, code) {
    code = String(code || "").replace(/\s+/g, "");
    if (!/^\d{6,10}$/.test(code)) throw new Error("Enter the code from the email.");
    const { data, error } = await client.auth.verifyOtp({ email: String(email).trim().toLowerCase(), token: code, type: "email" });
    if (error) throw new Error(friendly(error));
    session = data.session;
    return session;
  }

  /** Current access token (refreshed by supabase-js when it is about to expire), or null. */
  async function token() {
    if (!client) return null;
    const { data } = await client.auth.getSession();
    session = data.session;
    return session?.access_token || null;
  }
  const user = () => session?.user || null;
  const uid = () => session?.user?.id || null;
  const email = () => session?.user?.email || null;

  /** fetch with the signed-in user's token. */
  async function authedFetch(url, init = {}) {
    const t = await token();
    const headers = new Headers(init.headers || {});
    if (t) headers.set("authorization", `Bearer ${t}`);
    return fetch(url, { ...init, headers });
  }

  /** Everything Ledger stored on this device: caches, offline queues, preferences, the session. */
  async function clearLocalData() {
    try {
      for (const k of Object.keys(localStorage)) if (k.startsWith("ledger.") || k.startsWith("sb-")) localStorage.removeItem(k);
    } catch { /* storage unavailable */ }
    try { sessionStorage.clear(); } catch { /* */ }
    try { if (window.caches) for (const k of await caches.keys()) await caches.delete(k); } catch { /* */ }
    try {
      if (indexedDB.databases) for (const d of await indexedDB.databases()) if (d.name) indexedDB.deleteDatabase(d.name);
    } catch { /* */ }
  }

  /**
   * Sign out on this device: `beforeClear` runs first (e.g. remove this device's push subscription on the
   * server while the token still works), then the session ends and all local data is wiped.
   */
  async function signOut({ beforeClear } = {}) {
    try { await beforeClear?.(); } catch { /* keep signing out */ }
    try { await client?.auth.signOut({ scope: "local" }); } catch { /* offline: the local session is dropped anyway */ }
    session = null;
    await clearLocalData();
  }

  return { configured, init, onChange, sendCode, verifyCode, token, user, uid, email, authedFetch, signOut, clearLocalData };
})();
