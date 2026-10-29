"use strict";
(() => {
  // ---------- storage (localStorage may throw in private mode) ----------
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem("ledger." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("ledger." + k, JSON.stringify(v)); } catch { /* ignore */ } },
    del(k) { try { localStorage.removeItem("ledger." + k); } catch { /* ignore */ } },
  };
  const $ = (id) => document.getElementById(id);
  const el = (tag, props = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(props)) {
      if (k === "class") n.className = v; else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v); else n.setAttribute(k, v);
    }
    for (const c of kids) n.append(c);
    return n;
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 12));

  // ---------- state ----------
  const S = {
    api: store.get("api", window.EXPENSE_API_URL || ""),
    key: store.get("key", ""),
    meta: store.get("meta", null),
    type: "expense",
    currency: store.get("currency", "MYR"),
    dashCurrency: store.get("dashCurrency", store.get("currency", "MYR")),
    category: null,
    bankByCur: store.get("bankByCur", {}),
    requestId: uuid(),
    editCats: false,
    editBanks: false,
    lastSavedId: null,
    dashTimer: null,
    monthTx: [],
  };
  const SYM = { MYR: "RM", KRW: "₩" };
  const decimals = (cur) => (S.meta?.currencies.find((c) => c.code === cur)?.minor_units ?? 2);
  function money(v, cur, { sign = false } = {}) {
    if (v === null || v === undefined || v === "") return "—";
    const n = Number(v), d = decimals(cur);
    const s = Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
    const sym = SYM[cur] ?? cur + " ";
    return `${n < 0 ? "−" : sign && n > 0 ? "+" : ""}${sym}${cur === "MYR" ? " " : ""}${s}`;
  }
  // Live thousand separators while typing (204800 -> 204,800). Commas are
  // stripped again before sending; KRW has no decimals.
  const plain = (v) => String(v ?? "").replace(/,/g, "").trim();
  function groupDigits(raw, cur) {
    let v = String(raw).replace(/[^\d.]/g, "");
    const d = decimals(cur);
    const dot = v.indexOf(".");
    let int = dot < 0 ? v : v.slice(0, dot), frac = dot < 0 ? null : v.slice(dot + 1).replace(/\./g, "");
    int = int.replace(/^0+(?=\d)/, "");
    if (!d) frac = null; else if (frac !== null) frac = frac.slice(0, d);
    const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    return frac === null ? g : `${g || "0"}.${frac}`;
  }
  function formatInput(input, cur) {
    const before = input.value, caret = input.selectionStart ?? before.length;
    const sig = before.slice(0, caret).replace(/[^\d.]/g, "").length;   // digits (and dot) left of the caret
    const after = groupDigits(before, cur);
    if (after !== before) {
      input.value = after;
      let pos = 0, seen = 0;
      while (pos < after.length && seen < sig) { if (/[\d.]/.test(after[pos])) seen++; pos++; }
      try { input.setSelectionRange(pos, pos); } catch { /* not focusable */ }
    }
    if (input.id === "amount") {   // the big amount grows with its digits so 1,234,567 never clips
      const digits = after.replace(/[^\d]/g, "").length, marks = after.length - digits;
      input.style.width = Math.max(4.2, digits + marks * 0.5 + 0.4) + "ch";
    }
  }
  const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);

  // ---------- API ----------
  class ApiError extends Error { constructor(status, body) { super(body?.error?.message || `HTTP ${status}`); this.status = status; this.body = body; } }
  async function api(method, path, body) {
    const res = await fetch(S.api.replace(/\/+$/, "") + path, {
      method,
      headers: { "x-api-key": S.key, ...(body ? { "content-type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch { /* non-json */ }
    if (!res.ok) throw new ApiError(res.status, data);
    return data;
  }

  // ---------- toast ----------
  let toastTimer;
  function toast(msg, { bad = false, undo = false, ms = 5000 } = {}) {
    $("toast-msg").textContent = msg;
    $("toast").classList.toggle("bad", bad);
    $("toast-undo").hidden = !undo;
    $("toast").hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, ms);
  }
  $("toast-undo").addEventListener("click", async () => {
    if (!S.lastSavedId) return;
    try {
      await api("DELETE", `/transactions/${S.lastSavedId}`);
      S.lastSavedId = null;
      toast("Deleted.");
      loadRecent(); if (!$("dash").hidden) loadDash();
    } catch (e) { toast("Couldn't undo: " + e.message, { bad: true }); }
  });

  // ---------- tabs ----------
  function showTab(tab) {
    for (const t of ["add", "dash", "assets"]) $(t).hidden = t !== tab;
    for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false");
    clearInterval(S.dashTimer);
    if (tab === "dash") {
      loadDash();
      // Poll while the dashboard is open and visible: near-real-time on the phone.
      S.dashTimer = setInterval(() => { if (document.visibilityState === "visible") loadDash(true); }, 15000);
    }
    if (tab === "assets") loadAssets();
    history.replaceState(null, "", "?tab=" + tab);
  }
  document.querySelectorAll("#tabs button").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

  // ---------- setup ----------
  async function loadMeta() {
    const m = await api("GET", "/meta");
    S.meta = m; store.set("meta", m);
    return m;
  }
  function showSetup(err) {
    $("setup").hidden = false; $("add").hidden = true; $("dash").hidden = true; $("assets").hidden = true; $("tabs").hidden = true;
    $("setup-url").value = S.api;
    if (err) { $("setup-error").textContent = err; $("setup-error").hidden = false; }
  }
  $("setup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    S.api = $("setup-url").value.trim(); S.key = $("setup-key").value.trim();
    $("setup-error").hidden = true;
    try {
      await loadMeta();
      store.set("api", S.api); store.set("key", S.key);
      start();
    } catch (err) {
      $("setup-error").textContent = err.status === 401 ? "That API key was not accepted." : "Couldn't reach the API: " + err.message;
      $("setup-error").hidden = false;
    }
  });

  // ---------- entry form ----------
  function radioGroup(container, items, current, onPick, label = (x) => x) {
    container.replaceChildren(...items.map((v) => el("button", {
      type: "button", role: "radio", "aria-checked": String(v === current), "data-v": v, text: label(v),
      onclick: () => { onPick(v); for (const b of container.children) b.setAttribute("aria-checked", String(b.dataset.v === v)); },
    })));
  }
  function renderCurrencySegs() {
    const codes = S.meta.currencies.map((c) => c.code).sort((a, b) => (a === "MYR" ? -1 : b === "MYR" ? 1 : a.localeCompare(b)));
    radioGroup($("cur-seg"), codes, S.currency, (c) => { S.currency = c; store.set("currency", c); renderCurrency(); }, (c) => SYM[c] || c);
    radioGroup($("dash-cur-seg"), codes, S.dashCurrency, (c) => { S.dashCurrency = c; store.set("dashCurrency", c); loadDash(); }, (c) => c);
  }
  function renderCurrency() {
    $("amount-sym").textContent = SYM[S.currency] || S.currency;
    $("amount").placeholder = decimals(S.currency) ? "0.00" : "0";
    $("amount").setAttribute("inputmode", decimals(S.currency) ? "decimal" : "numeric");
    formatInput($("amount"), S.currency);
    // each currency has its own categories and payment methods
    renderType();
    renderBanks();
  }
  // Chips for a user-managed list, ending with a "+" chip. In edit mode a tap opens the editor.
  function renderPickList(container, names, current, { editing, onPick, onEdit, onAdd, addLabel }) {
    const chips = names.map((v) => el("button", {
      type: "button", role: editing ? null : "radio", "aria-checked": editing ? null : String(v === current), "data-v": v, text: v,
      "aria-label": editing ? `Edit ${v}` : null,
      onclick: () => {
        if (editing) return onEdit(v);
        onPick(v);
        for (const b of container.children) if (!b.classList.contains("chip-add")) b.setAttribute("aria-checked", String(b.dataset.v === v));
      },
    }));
    for (const c of chips) for (const a of ["role", "aria-checked", "aria-label"]) if (c.getAttribute(a) === "null") c.removeAttribute(a);
    chips.push(el("button", { type: "button", class: "chip-add", "aria-label": addLabel, text: "+", onclick: onAdd }));
    container.replaceChildren(...chips);
  }
  // Categories / payment methods of the active currency only (RM and ₩ lists are separate).
  const inCur = (x) => !x.currency || x.currency === S.currency;
  const curCats = () => S.meta.categories.filter(inCur);
  const findCat = (name) => curCats().find((c) => c.name === name);
  function catsForType() {
    return curCats().filter((c) => c.kind === S.type || c.kind === "both").map((c) => c.name);
  }
  function banksForCur() {
    return S.meta.payment_methods ? S.meta.payment_methods.filter(inCur).map((b) => b.name) : S.meta.banks;
  }
  const catKey = () => `cat.${S.currency}.${S.type}`;
  function renderType() {
    document.body.classList.toggle("is-income", S.type === "income");
    for (const b of document.querySelectorAll('#add .seg button[data-type]')) b.setAttribute("aria-checked", String(b.dataset.type === S.type));
    $("save").textContent = S.type === "income" ? "Save income" : "Save expense";
    const cats = catsForType();
    if (!cats.includes(S.category)) S.category = store.get(catKey(), cats[0]);
    if (!cats.includes(S.category)) S.category = cats[0] ?? null;
    renderPickList($("cat-chips"), cats, S.category, {
      editing: S.editCats,
      onPick: (c) => { S.category = c; store.set(catKey(), c); $("form-err").hidden = true; },
      onEdit: (c) => openItem("cat", c),
      onAdd: () => openItem("cat", null),
      addLabel: "Add category",
    });
    const hint = $("cat-hint");
    hint.hidden = cats.length > 0 && !S.editCats;
    hint.textContent = S.editCats ? "Tap a category to rename it, change its type or remove it."
      : `Tap + to add your first ${SYM[S.currency] || S.currency} ${S.type} category.`;
    $("cat-edit").hidden = curCats().length === 0;
  }
  function renderBanks() {
    const banks = banksForCur();
    let cur = S.bankByCur[S.currency];
    if (!banks.includes(cur)) cur = banks[0] ?? null;
    S.bankByCur[S.currency] = cur;
    renderPickList($("bank-pills"), banks, cur, {
      editing: S.editBanks,
      onPick: (b) => { S.bankByCur[S.currency] = b; store.set("bankByCur", S.bankByCur); $("form-err").hidden = true; },
      onEdit: (b) => openItem("bank", b),
      onAdd: () => openItem("bank", null),
      addLabel: "Add payment method",
    });
    const hint = $("bank-hint");
    hint.hidden = banks.length > 0 && !S.editBanks;
    hint.textContent = S.editBanks ? "Tap a payment method to rename or remove it."
      : (S.currency === "KRW" ? "Tap + to add a ₩ payment method, e.g. Cash, KakaoBank, T-money."
        : `Tap + to add a ${SYM[S.currency] || S.currency} payment method, e.g. Cash, Maybank, Touch 'n Go.`);
    $("bank-edit").hidden = banks.length === 0;
  }
  function toggleEdit(which) {
    const key = which === "cat" ? "editCats" : "editBanks";
    S[key] = !S[key];
    const btn = $(which === "cat" ? "cat-edit" : "bank-edit");
    btn.textContent = S[key] ? "Done" : "Edit";
    btn.setAttribute("aria-pressed", String(S[key]));
    btn.closest(".field").classList.toggle("editing", S[key]);
    which === "cat" ? renderType() : renderBanks();
  }
  $("cat-edit").addEventListener("click", () => toggleEdit("cat"));
  $("bank-edit").addEventListener("click", () => toggleEdit("bank"));

  // ---------- add / edit / remove a category or payment method ----------
  let itemCtx = null; // { list: "cat"|"bank", original: name|null, kind }
  function setItemKind(kind) {
    itemCtx.kind = kind;
    for (const b of $("item-kind").children) b.setAttribute("aria-checked", String(b.dataset.kind === kind));
    showBudgetFields();
  }
  function showBudgetFields() {
    // budgets are for spending: hidden for payment methods and Income categories
    $("item-budget-wrap").hidden = !itemCtx || itemCtx.list !== "cat" || itemCtx.kind === "income";
  }
  function budgetChanges() {
    // returns [{currency, amount|null}] for inputs that differ from what's saved
    if (itemCtx.list !== "cat" || itemCtx.kind === "income") return [];
    const out = [];
    for (const c of S.meta.currencies.filter((c) => c.code === itemCtx.currency)) {
      const raw = ($(`item-budget-${c.code}`)?.value || "").replace(/,/g, "").trim();
      const before = itemCtx.budgets?.[c.code];
      const was = before === undefined || before === null ? null : Number(before);
      const now = raw === "" || Number(raw) === 0 ? null : Number(raw);
      if (raw !== "" && !(Number(raw) >= 0)) out.push({ currency: c.code, amount: raw }); // let the API explain
      else if (now !== was) out.push({ currency: c.code, amount: now === null ? null : raw });
    }
    return out;
  }
  for (const b of $("item-kind").children) b.addEventListener("click", () => setItemKind(b.dataset.kind));
  function openItem(list, name) {
    if (list === "acat") return openAssetCat(name);
    const isCat = list === "cat";
    const existing = isCat && name ? findCat(name) : null;
    itemCtx = { list, original: name, kind: existing ? existing.kind : S.type, currency: S.currency };
    const sym = SYM[S.currency] || S.currency;
    $("item-title").textContent = (name ? "Edit " : "New ") + sym + " " + (isCat ? "category" : "payment method");
    $("item-name").value = name || "";
    $("item-name").placeholder = isCat ? (S.type === "income" ? "e.g. Allowance" : "e.g. Food") : "e.g. Cash, KakaoBank";
    $("item-kind-wrap").hidden = !isCat;
    if (isCat) setItemKind(itemCtx.kind);
    itemCtx.budgets = existing?.budgets || {};
    $("item-budgets").replaceChildren(...S.meta.currencies.filter((c) => c.code === S.currency).map((c) => {
      const cur = existing?.budgets?.[c.code];
      const input = el("input", { id: `item-budget-${c.code}`, inputmode: c.minor_units ? "decimal" : "numeric",
        placeholder: "No budget", autocomplete: "off", "aria-label": `Monthly budget in ${c.code}` });
      if (cur !== undefined && cur !== null) input.value = groupDigits(Number(cur).toFixed(c.minor_units), c.code);
      input.addEventListener("input", () => formatInput(input, c.code));
      return el("label", { class: "budget-input" }, el("span", { text: SYM[c.code] || c.code }), input);
    }));
    showBudgetFields();
    $("item-save").textContent = name ? "Save" : "Add";
    $("item-save").disabled = false;
    $("item-err").hidden = true;
    const rm = $("item-remove");
    rm.hidden = !name; rm.classList.remove("confirm"); rm.dataset.armed = "";
    rm.textContent = isCat ? "Remove category" : "Remove payment method";
    $("item-dlg").showModal();
    setTimeout(() => $("item-name").focus(), 50);
  }
  function itemError(err) {
    let msg = err.message;
    if (err instanceof ApiError && err.status === 404 && err.body?.error?.code === "not_found" && /Route/.test(msg)) {
      msg = "Your server needs this update first: run scripts\\deploy.ps1 on your laptop.";
    } else if (err.body?.error?.fields) {
      msg = Object.entries(err.body.error.fields).map(([k, v]) => `${k === "kind" ? "type" : k} ${v}`).join(", ");
    }
    $("item-err").textContent = msg;
    $("item-err").hidden = false;
  }
  async function afterListChange(list, selectName, message) {
    await loadMeta();
    if (list === "cat" && S.editCats && curCats().length === 0) toggleEdit("cat");
    if (list === "bank" && S.editBanks && banksForCur().length === 0) toggleEdit("bank");
    if (list === "cat") {
      if (selectName && catsForType().includes(selectName)) { S.category = selectName; store.set(catKey(), selectName); }
      renderType();
    } else {
      if (selectName) { S.bankByCur[S.currency] = selectName; store.set("bankByCur", S.bankByCur); }
      renderBanks();
    }
    loadRecent();
    if (!$("dash").hidden) loadDash(true);
    toast(message);
  }
  $("item-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") { itemCtx = null; return; }
    e.preventDefault();
    const name = $("item-name").value.replace(/\s+/g, " ").trim();
    if (!name) { $("item-err").textContent = "Enter a name."; $("item-err").hidden = false; return; }
    const { list, original, kind, currency } = itemCtx;
    const path = list === "cat" ? "/categories" : "/payment-methods";
    $("item-save").disabled = true;
    try {
      let r = null;
      const existing = list === "cat" && original ? findCat(original) : null;
      const catChanged = !original || name !== original || (list === "cat" && existing && existing.kind !== kind);
      if (list === "acat") {
        if (!original) r = await api("POST", "/asset-categories", { name });
        else if (name !== original) r = await api("PATCH", "/asset-categories", { name: original, new_name: name });
        $("item-dlg").close();
        if (r) await afterAssetCatChange(original, r.asset_category.name, r.message);
        return;
      }
      if (!original) r = await api("POST", path, list === "cat" ? { name, kind, currency } : { name, currency });
      else if (list === "cat" && catChanged) r = await api("PATCH", path, { name: original, ...(name !== original ? { new_name: name } : {}), kind, currency });
      else if (list === "bank" && name !== original) r = await api("PATCH", path, { name: original, new_name: name, currency });
      const saved = r ? (r.category || r.payment_method).name : original;
      if (r) {
        // from here on, edits apply to the saved item (so a budget error can be fixed without re-adding)
        itemCtx.original = saved;
        if (original && list === "cat" && S.category === original) S.category = saved;
        if (original && list === "bank") for (const k of Object.keys(S.bankByCur)) if (S.bankByCur[k] === original) S.bankByCur[k] = saved;
      }
      const msgs = r ? [r.message] : [];
      for (const b of budgetChanges()) {
        const br = await api("PUT", "/category-budgets", { category: saved, currency: b.currency, amount: b.amount });
        msgs.push(br.message);
        itemCtx.budgets = { ...itemCtx.budgets, [b.currency]: br.category_budget.amount };
      }
      $("item-dlg").close();
      if (msgs.length) await afterListChange(list, original ? null : saved, msgs.join(". "));
    } catch (err) {
      if (itemCtx.original && !original) {   // category was created, budget failed: switch dialog to edit mode
        $("item-title").textContent = "Edit category"; $("item-save").textContent = "Save";
        await loadMeta(); renderType();
      }
      itemError(err); $("item-save").disabled = false;
    }
  });
  $("item-remove").addEventListener("click", async () => {
    const rm = $("item-remove");
    if (!rm.dataset.armed) {                       // first tap arms, second tap removes
      rm.dataset.armed = "1"; rm.classList.add("confirm");
      rm.textContent = `Tap again to remove "${itemCtx.original}"`;
      return;
    }
    const { list, original, currency } = itemCtx;
    if (list === "acat") {
      try {
        const r = await api("DELETE", "/asset-categories", { name: original });
        $("item-dlg").close();
        await afterAssetCatChange(original, null, r.message);
      } catch (err) { itemError(err); }
      return;
    }
    try {
      const r = await api("DELETE", list === "cat" ? "/categories" : "/payment-methods", { name: original, currency });
      $("item-dlg").close();
      await afterListChange(list, null, r.message);
    } catch (err) { itemError(err); }
  });
  document.querySelectorAll('#add .seg button[data-type]').forEach((b) =>
    b.addEventListener("click", () => { S.type = b.dataset.type; renderType(); }));

  function readForm() {
    return {
      request_id: S.requestId,
      type: S.type,
      item: $("item").value.trim() || S.category || "",
      amount: plain($("amount").value),
      category: S.category,
      currency: S.currency,
      which_bank: S.bankByCur[S.currency],
      date: $("date").value || todayLocal(),
      notes: $("notes").value.trim() || undefined,
    };
  }

  // Offline queue: a failed network send keeps its request_id, so replaying
  // can never create a duplicate.
  const queue = () => store.get("queue", []);
  async function flushQueue() {
    const q = queue();
    if (!q.length || !S.key) return;
    const left = [];
    for (const body of q) {
      try { await api("POST", "/transactions", body); }
      catch (e) { if (!(e instanceof ApiError) || e.status >= 500) left.push(body); }
    }
    store.set("queue", left);
    if (left.length < q.length) { toast(`Sent ${q.length - left.length} saved-offline entr${q.length - left.length === 1 ? "y" : "ies"}.`); loadRecent(); }
  }

  $("tx-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = readForm();
    $("amount-err").hidden = true; $("form-err").hidden = true;
    if (!body.amount || !(Number(body.amount) > 0)) {
      $("amount-err").textContent = "Enter an amount above zero.";
      $("amount-err").hidden = false; $("amount").focus(); return;
    }
    if (!body.category || !body.which_bank) {
      $("form-err").textContent = !body.category
        ? `Add ${S.type === "income" ? "an income" : "an expense"} category first: tap + under Category.`
        : "Add a payment method first: tap + under Payment method.";
      $("form-err").hidden = false; return;
    }
    $("save").disabled = true;
    try {
      const r = await api("POST", "/transactions", body);
      S.lastSavedId = r.transaction.transaction_id;
      toast("Logged successfully", { undo: !r.duplicate, ms: 5000 });
      resetForm();
      loadRecent();
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) { showSetup("Your API key was rejected. Enter it again."); }
      else if (err instanceof ApiError && err.status < 500) {
        const f = err.body?.error?.fields;
        toast(f ? Object.entries(f).map(([k, v]) => `${k} ${v}`).join(", ") : err.message, { bad: true, ms: 7000 });
      } else {
        const q = queue(); q.push(body); store.set("queue", q);
        toast("No connection. Kept on this phone and will send automatically.", { bad: true, ms: 7000 });
        resetForm();
      }
    } finally { $("save").disabled = false; }
  });
  function resetForm() {
    $("amount").value = ""; formatInput($("amount"), S.currency);
    $("item").value = ""; $("notes").value = ""; $("date").value = todayLocal();
    S.requestId = uuid();
  }

  async function loadRecent() {
    try {
      const r = await api("GET", "/transactions?limit=8");
      $("recent-list").replaceChildren(...r.transactions.map(txRow));
      if (!r.transactions.length) $("recent-list").append(el("li", { class: "muted", text: "Nothing yet. Your entries appear here." }));
    } catch { /* stay quiet on the entry screen */ }
  }
  function txRow(t) {
    const inc = t.transaction_type === "Income";
    return el("li", {},
      el("div", { class: "t-main" }, el("div", { class: "t1", text: t.item }), el("div", { class: "t2", text: `${t.category}, ${t.which_bank}, ${t.date}` })),
      el("div", { class: "t-right" },
        el("div", { class: "amt num" + (inc ? " inc" : ""), text: (inc ? "+" : "") + money(t.amount, t.currency) }),
        el("button", { type: "button", class: "del-btn", "aria-label": `Delete ${t.item}`, text: "Delete",
                       onclick: () => askDelete(t) })));
  }

  // ---------- delete any entry (with confirmation) ----------
  let pendingDelete = null;
  function askDelete(t) {
    pendingDelete = t;
    const inc = t.transaction_type === "Income";
    $("del-what").textContent = `${t.item}, ${(inc ? "+" : "") + money(t.amount, t.currency)} on ${t.date} (${t.category}, ${t.which_bank})`;
    $("del-err").hidden = true;
    $("del-yes").disabled = false;
    $("del-dlg").showModal();
  }
  $("del-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "delete" || !pendingDelete) { pendingDelete = null; return; }
    e.preventDefault();
    $("del-yes").disabled = true;
    const t = pendingDelete;
    try {
      await api("DELETE", `/transactions/${t.transaction_id}`);
      $("del-dlg").close();
      pendingDelete = null;
      if (String(S.lastSavedId) === String(t.transaction_id)) S.lastSavedId = null;
      toast(`Deleted ${t.item}.`);
      loadRecent();
      if (!$("dash").hidden) loadDash(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) {
        $("del-dlg").close(); pendingDelete = null; toast("That entry was already deleted.");
        loadRecent(); if (!$("dash").hidden) loadDash(true);
      } else {
        $("del-err").textContent = "Couldn't delete: " + err.message;
        $("del-err").hidden = false;
        $("del-yes").disabled = false;
      }
    }
  });

  // ---------- dashboard ----------
  function svgBars(values, labels, { color = "b-exp", h = 140, budgetLine = null, series2 = null, color2 = "b-inc", fmt } = {}) {
    const W = 600, pad = { l: 8, r: 8, t: 10, b: 22 };
    const max = Math.max(1, ...values, ...(series2 || []), budgetLine ?? 0);
    const n = values.length, slot = (W - pad.l - pad.r) / n, bw = Math.max(2, slot * (series2 ? 0.36 : 0.62));
    const y = (v) => pad.t + (h - pad.t - pad.b) * (1 - v / max);
    let s = `<svg viewBox="0 0 ${W} ${h}" role="img" aria-label="chart">`;
    values.forEach((v, i) => {
      const x = pad.l + slot * i + (slot - (series2 ? bw * 2 + 2 : bw)) / 2;
      if (v > 0) s += `<rect x="${x.toFixed(1)}" y="${y(v).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad.b - y(v)).toFixed(1)}" rx="2" class="${color}"><title>${esc(labels[i])}: ${esc(fmt(v))}</title></rect>`;
      if (series2 && series2[i] > 0) s += `<rect x="${(x + bw + 2).toFixed(1)}" y="${y(series2[i]).toFixed(1)}" width="${bw.toFixed(1)}" height="${(h - pad.b - y(series2[i])).toFixed(1)}" rx="2" class="${color2}"><title>${esc(labels[i])}: ${esc(fmt(series2[i]))}</title></rect>`;
    });
    if (budgetLine) s += `<line x1="${pad.l}" x2="${W - pad.r}" y1="${y(budgetLine)}" y2="${y(budgetLine)}" class="b-line"/>`;
    const every = Math.ceil(n / 8);
    labels.forEach((lb, i) => { if (i % every === 0 || i === n - 1) s += `<text x="${(pad.l + slot * i + slot / 2).toFixed(1)}" y="${h - 6}" text-anchor="middle">${esc(lb)}</text>`; });
    return s + "</svg>";
  }

  async function loadDash(silent = false) {
    const cur = S.dashCurrency, month = $("month").value || todayLocal().slice(0, 7);
    try {
      const [s, t] = await Promise.all([
        api("GET", `/summary?month=${month}&currency=${cur}`),
        api("GET", `/transactions?limit=200&currency=${cur}&month=${month}`),
      ]);
      renderDash(s, cur);
      S.monthTx = t.transactions; renderTable(cur);
      $("updated").textContent = "Updated " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) + ", refreshes every 15 s";
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return showSetup("Your API key was rejected. Enter it again.");
      if (!silent) toast("Couldn't load the dashboard: " + e.message, { bad: true });
    }
  }
  function renderDash(s, cur) {
    const k = s.kpi, f = (v) => money(v, cur);
    $("k-exp").textContent = f(k.total_expenses);
    $("k-inc").textContent = f(k.total_income);
    $("k-net").textContent = money(k.net, cur, { sign: true });
    $("k-net").className = "num kpi-v" + (Number(k.net) >= 0 ? " inc" : "");
    const hasBudget = k.monthly_budget !== null;
    $("k-bud").textContent = hasBudget ? f(k.monthly_budget) : "not set";
    $("k-rem-label").textContent = k.over_budget ? "Over budget by" : "Remaining";
    $("k-rem").textContent = hasBudget ? f(Math.abs(Number(k.remaining_budget))) : "—";
    $("k-used").textContent = hasBudget ? `${Number(k.budget_used_pct).toFixed(1)}% of budget used` : "Set a budget to track it";
    document.body.classList.toggle("over", !!k.over_budget);
    const pct = hasBudget ? Math.min(100, Number(k.budget_used_pct)) : 0;
    $("meter-fill").style.width = pct + "%";
    $("meter").setAttribute("aria-valuenow", String(pct));
    const [y, m] = s.month.split("-").map(Number), days = new Date(y, m, 0).getDate();
    const isNow = s.month === todayLocal().slice(0, 7);
    $("meter-today").hidden = !isNow;
    if (isNow) $("meter-today").style.left = ((new Date().getDate() / days) * 100).toFixed(1) + "%";

    // by category: with a budget the bar and the value show % of that budget used;
    // without one, the bar is the share of the biggest spend and the value is the amount
    const maxC = Math.max(1, ...s.by_category.map((c) => Number(c.amount)));
    const fill = (pct) => { const i = document.createElement("i"); i.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + "%"; return i; };
    $("ch-cat").replaceChildren(s.by_category.length
      ? el("div", { class: "bars" }, ...s.by_category.map((c) => {
          const hasB = c.budget !== null && c.budget !== undefined;
          const pct = hasB ? Number(c.used_pct) : null;
          return el("div", { class: "bar-row" + (hasB && c.over ? " over" : ""),
                             title: hasB ? `${f(c.amount)} of ${f(c.budget)}` : f(c.amount) },
            el("span", { class: "cat-name", text: c.category }),
            el("span", { class: "bar-track" + (hasB ? " has-budget" : "") },
              fill(hasB ? pct : Number(c.amount) / maxC * 100)),
            el("span", { class: "num", text: hasB ? `${pct.toFixed(1)}% used` : f(c.amount) }));
        }))
      : el("p", { class: "muted small", text: "No spending this month yet." }));

    $("ch-daily").innerHTML = svgBars(s.daily.map((d) => Number(d.expenses)), s.daily.map((d) => String(Number(d.date.slice(8)))), { fmt: f });
    const months = s.monthly.map((x) => x.month.slice(2).replace("-", "/"));
    $("ch-month").innerHTML = svgBars(s.monthly.map((x) => Number(x.expenses)), months, { fmt: f, budgetLine: hasBudget ? Number(k.monthly_budget) : null })
      + (hasBudget ? `<div class="legend"><span><i class="l-exp"></i>Spending</span><span><i class="l-over"></i>This month's budget</span></div>` : "");
    $("ch-ie").innerHTML = svgBars(s.monthly.map((x) => Number(x.income)), months, { fmt: f, color: "b-inc", series2: s.monthly.map((x) => Number(x.expenses)), color2: "b-exp" })
      + `<div class="legend"><span><i class="l-inc"></i>Income</span><span><i class="l-exp"></i>Expenses</span></div>`;
  }
  function fillSelect(sel, values) {
    const keep = sel.value;
    sel.replaceChildren(sel.options[0], ...values.map((v) => el("option", { text: v })));
    sel.value = values.includes(keep) ? keep : "";
  }
  function renderTable(cur) {
    fillSelect($("f-cat"), [...new Set(S.monthTx.map((t) => t.category))].sort());
    fillSelect($("f-bank"), [...new Set(S.monthTx.map((t) => t.which_bank))].sort());
    const ft = $("f-type").value, fc = $("f-cat").value, fb = $("f-bank").value;
    const rows = S.monthTx.filter((t) => (!ft || t.transaction_type === ft) && (!fc || t.category === fc) && (!fb || t.which_bank === fb));
    $("tx-body").replaceChildren(...rows.map((t) => {
      const inc = t.transaction_type === "Income";
      return el("tr", { "data-id": String(t.transaction_id), onclick: () => askDelete(t) },
        el("td", { text: t.date.slice(5) }), el("td", { class: "item" }, el("div", { text: t.item }), el("div", { class: "sub", text: `${t.category}, ${t.which_bank}` })), el("td", { text: t.category }),
        el("td", { class: "r num" + (inc ? " inc" : ""), text: (inc ? "+" : "") + money(t.amount, cur) }),
        el("td", { text: t.which_bank }), el("td", { text: t.transaction_type }));
    }));
    if (!rows.length) $("tx-body").append(el("tr", {}, el("td", { colspan: "6", class: "muted", text: "No transactions match." })));
  }
  ["f-type", "f-cat", "f-bank"].forEach((id) => $(id).addEventListener("change", () => renderTable(S.dashCurrency)));
  $("month").addEventListener("change", () => loadDash());

  // budget dialog
  $("budget-btn").addEventListener("click", () => {
    $("budget-title").textContent = `Monthly budget (${S.dashCurrency})`;
    $("budget-amt").value = ""; $("budget-err").hidden = true;
    $("budget-amt").setAttribute("inputmode", decimals(S.dashCurrency) ? "decimal" : "numeric");
    $("budget-dlg").showModal();
  });
  $("budget-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    try {
      await api("PUT", "/budget", {
        currency: S.dashCurrency, amount: plain($("budget-amt").value),
        ...($("budget-only-month").checked ? { month: $("month").value } : {}),
      });
      $("budget-dlg").close(); toast("Budget saved."); loadDash();
    } catch (err) { $("budget-err").textContent = err.message; $("budget-err").hidden = false; }
  });

  $("budget-amt").addEventListener("input", () => formatInput($("budget-amt"), S.dashCurrency));
  $("amount").addEventListener("input", () => formatInput($("amount"), S.currency));

  // ---------- assets / net worth ----------
  // asset categories are a user-managed list (shared by RM and ₩): + to add, Edit to rename / remove
  const A = { list: [], totals: {}, categories: [], ctx: null, editCats: false };
  const assetCatNames = () => A.categories.map((c) => (typeof c === "string" ? c : c.name));
  const curOrder = () => S.meta.currencies.map((c) => c.code).sort((a, b) => (a === "MYR" ? -1 : b === "MYR" ? 1 : a.localeCompare(b)));
  async function loadAssets(silent = false) {
    try {
      const r = await api("GET", "/assets");
      A.list = r.assets; A.totals = r.totals; A.categories = r.categories;
      renderAssets();
      $("assets-updated").textContent = A.list.length ? "Values are what you last entered. Tap an asset to update it." : "";
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return showSetup("Your API key was rejected. Enter it again.");
      if (e instanceof ApiError && e.status === 404) {
        $("asset-groups").replaceChildren(el("p", { class: "muted small", text: "Your server needs this update first: run scripts\\deploy.ps1 on your laptop." }));
        return;
      }
      if (!silent) toast("Couldn't load assets: " + e.message, { bad: true });
    }
  }
  function renderAssets() {
    const codes = curOrder();
    // net worth per currency, never mixed
    $("networth").replaceChildren(...codes.map((code) => el("div", { class: "kpi" },
      el("div", { class: "muted small", text: `Net worth (${SYM[code] || code})` }),
      el("div", { class: "num kpi-v", text: money(A.totals[code] ?? 0, code) }),
      el("div", { class: "muted small", text: `${A.list.filter((a) => a.currency === code).length} asset${A.list.filter((a) => a.currency === code).length === 1 ? "" : "s"}` }))));
    if (!A.list.length) {
      $("asset-groups").replaceChildren(el("section", { class: "panel empty" },
        el("p", { class: "muted", text: "Track what you own: savings accounts, ASB, gold, stocks and more. Tap + Add asset." })));
      return;
    }
    $("asset-groups").replaceChildren(...codes.filter((code) => A.list.some((a) => a.currency === code)).map((code) =>
      el("section", { class: "panel" }, el("h2", { text: code === "MYR" ? "Ringgit (RM)" : code === "KRW" ? "Won (₩)" : code }),
        el("ul", { class: "tx-list asset-list" }, ...A.list.filter((a) => a.currency === code).map((a) =>
          el("li", { class: "asset-row", tabindex: "0", role: "button", "aria-label": `Edit ${a.name || a.category}`,
                     onclick: () => openAsset(a), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAsset(a); } } },
            el("div", { class: "t-main" },
              el("div", { class: "t1", text: a.name || a.category }),
              el("div", { class: "t2", text: [a.name ? a.category : null, a.value_date ? "updated " + a.value_date : null, a.notes].filter(Boolean).join(" · ") })),
            el("div", { class: "amt num", text: money(a.value, a.currency) })))))));
  }
  function setAssetCur(code) {
    A.ctx.currency = code;
    for (const b of $("asset-cur").children) b.setAttribute("aria-checked", String(b.dataset.v === code));
    $("asset-sym").textContent = SYM[code] || code;
    $("asset-value").placeholder = decimals(code) ? "0.00" : "0";
    $("asset-value").setAttribute("inputmode", decimals(code) ? "decimal" : "numeric");
    formatInput($("asset-value"), code);
  }
  function renderAssetCats() {
    const names = assetCatNames();
    if (A.ctx && !names.includes(A.ctx.category)) A.ctx.category = null;
    renderPickList($("asset-cat-chips"), names, A.ctx?.category ?? null, {
      editing: A.editCats,
      onPick: (n) => { A.ctx.category = n; $("asset-err").hidden = true; },
      onEdit: (n) => openItem("acat", n),
      onAdd: () => openItem("acat", null),
      addLabel: "Add asset category",
    });
    const hint = $("asset-cat-hint");
    hint.hidden = names.length > 0 && !A.editCats;
    hint.textContent = A.editCats ? "Tap a category to rename or remove it. Only empty categories can be removed."
      : "Tap + to add a category, e.g. Savings, ASB, Gold.";
    $("asset-cat-edit").hidden = names.length === 0 && !A.editCats;
    $("asset-cat-edit").textContent = A.editCats ? "Done" : "Edit";
    $("asset-cat-edit").setAttribute("aria-pressed", String(A.editCats));
    $("asset-cat-edit").closest(".field").classList.toggle("editing", A.editCats);
  }
  $("asset-cat-edit").addEventListener("click", () => { A.editCats = !A.editCats; renderAssetCats(); });
  function openAssetCat(name) {
    itemCtx = { list: "acat", original: name, kind: null, currency: null };
    $("item-title").textContent = name ? "Edit asset category" : "New asset category";
    $("item-name").value = name || "";
    $("item-name").placeholder = "e.g. Tabung Haji, Unit trust";
    $("item-kind-wrap").hidden = true;
    $("item-budget-wrap").hidden = true;
    $("item-save").textContent = name ? "Save" : "Add";
    $("item-save").disabled = false;
    $("item-err").hidden = true;
    const rm = $("item-remove");
    rm.hidden = !name; rm.classList.remove("confirm"); rm.dataset.armed = "";
    rm.textContent = "Remove asset category";
    $("item-dlg").showModal();
    setTimeout(() => $("item-name").focus(), 50);
  }
  async function afterAssetCatChange(original, saved, message) {
    if (A.ctx && original && A.ctx.category === original) A.ctx.category = saved;   // renamed (or removed -> null)
    if (A.ctx && !original && saved) A.ctx.category = saved;                       // new one: select it
    await loadAssets(true);
    if (A.editCats && !assetCatNames().length) A.editCats = false;
    if ($("asset-dlg").open) renderAssetCats();
    toast(message);
  }
  function openAsset(a) {
    A.ctx = { id: a?.asset_id ?? null, currency: a?.currency ?? (S.dashCurrency || S.currency), original: a ?? null,
              category: a?.category ?? null };
    A.editCats = false;
    $("asset-title").textContent = a ? "Update asset" : "New asset";
    $("asset-cur").replaceChildren(...curOrder().map((code) => el("button", {
      type: "button", role: "radio", "data-v": code, text: SYM[code] || code, onclick: () => { if (!A.ctx.id) setAssetCur(code); },
    })));
    $("asset-cur-wrap").classList.toggle("locked", !!a);
    $("asset-name").value = a?.name ?? "";
    $("asset-notes").value = a?.notes ?? "";
    $("asset-value").value = a?.value != null ? groupDigits(Number(a.value).toFixed(decimals(a.currency)), a.currency) : "";
    setAssetCur(A.ctx.currency);
    renderAssetCats();
    $("asset-save").textContent = a ? "Save" : "Add";
    $("asset-save").disabled = false;
    $("asset-err").hidden = true;
    const rm = $("asset-remove");
    rm.hidden = !a; rm.classList.remove("confirm"); rm.dataset.armed = ""; rm.textContent = "Delete asset";
    $("asset-dlg").showModal();
    setTimeout(() => { if (a) $("asset-value").focus(); }, 50);
  }
  $("asset-add").addEventListener("click", () => openAsset(null));
  $("asset-value").addEventListener("input", () => formatInput($("asset-value"), A.ctx?.currency || "MYR"));
  function assetError(err) {
    let msg = err.message;
    if (err instanceof ApiError && err.status === 404 && /Route/.test(msg)) msg = "Your server needs this update first: run scripts\\deploy.ps1 on your laptop.";
    else if (err.body?.error?.fields) msg = Object.entries(err.body.error.fields).map(([k, v]) => `${k} ${v}`).join(", ");
    $("asset-err").textContent = msg; $("asset-err").hidden = false;
  }
  $("asset-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") { A.ctx = null; return; }
    e.preventDefault();
    const category = A.ctx.category;
    const value = plain($("asset-value").value);
    if (!category) { $("asset-err").textContent = "Pick an asset category (or tap + to add one)."; $("asset-err").hidden = false; return; }
    if (value === "" || !(Number(value) >= 0)) { $("asset-err").textContent = "Enter the current value (0 or more)."; $("asset-err").hidden = false; $("asset-value").focus(); return; }
    const name = $("asset-name").value.trim(), notes = $("asset-notes").value.trim();
    $("asset-save").disabled = true;
    try {
      if (!A.ctx.id) {
        await api("POST", "/assets", { category, value, currency: A.ctx.currency, ...(name ? { name } : {}), ...(notes ? { notes } : {}) });
      } else {
        const o = A.ctx.original, body = {};
        if (category !== o.category) body.category = category;
        if (name !== (o.name ?? "")) body.name = name;
        if (notes !== (o.notes ?? "")) body.notes = notes;
        if (Number(value) !== Number(o.value)) body.value = value;
        if (Object.keys(body).length) await api("PATCH", `/assets/${A.ctx.id}`, body);
      }
      $("asset-dlg").close();
      toast(A.ctx.id ? "Asset saved" : "Asset added");
      A.ctx = null;
      loadAssets(true);
    } catch (err) { assetError(err); $("asset-save").disabled = false; }
  });
  $("asset-remove").addEventListener("click", async () => {
    const rm = $("asset-remove");
    if (!rm.dataset.armed) { rm.dataset.armed = "1"; rm.classList.add("confirm"); rm.textContent = "Tap again to delete"; return; }
    try {
      await api("DELETE", `/assets/${A.ctx.id}`);
      $("asset-dlg").close(); A.ctx = null; toast("Asset deleted"); loadAssets(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) { $("asset-dlg").close(); A.ctx = null; loadAssets(true); }
      else assetError(err);
    }
  });

  // ---------- boot ----------
  async function start() {
    $("setup").hidden = true; $("tabs").hidden = false;
    try { await loadMeta(); } catch (e) {
      if (e instanceof ApiError && e.status === 401) return showSetup("Your API key was rejected. Enter it again.");
      if (!S.meta) return showSetup("Couldn't reach the API. Check the address and your connection.");
    }
    $("date").value = todayLocal();
    $("month").value = todayLocal().slice(0, 7);
    renderCurrencySegs(); renderCurrency(); renderType();
    const want = new URLSearchParams(location.search).get("tab");
    const tab = ["dash", "assets"].includes(want) ? want : "add";
    showTab(tab);
    if (tab === "add") setTimeout(() => $("amount").focus(), 50);
    loadRecent(); flushQueue();
  }
  window.addEventListener("online", flushQueue);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    flushQueue();
    if (!$("dash").hidden) loadDash(true);
    if (!$("assets").hidden) loadAssets(true);
  });
  if (!S.key || !S.api) showSetup(); else start();
})();
