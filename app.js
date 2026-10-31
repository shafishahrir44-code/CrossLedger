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
    assets: store.get("assets", []),        // for the entry form's account / target pickers
    assetCats: store.get("assetCats", []),
    dashSummary: null,                      // last /summary, adjusted locally on optimistic deletes
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
      loadReminders(true);   // an expense logged from a reminder is unlinked from it
      loadFormAssets();      // a linked account / asset got its amount back
    } catch (e) { toast("Couldn't undo: " + e.message, { bad: true }); }
  });

  // ---------- tabs ----------
  function showTab(tab) {
    for (const t of ["add", "dash", "assets", "reminders"]) $(t).hidden = t !== tab;
    for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false");
    clearInterval(S.dashTimer);
    if (tab === "dash") {
      loadDash();
      // Poll while the dashboard is open and visible: near-real-time on the phone.
      S.dashTimer = setInterval(() => { if (document.visibilityState === "visible") loadDash(true); }, 15000);
    }
    if (tab === "assets") loadAssets();
    if (tab === "reminders") { renderReminderViews(); loadReminders(true); renderNotif(); }
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
    $("setup").hidden = false; $("add").hidden = true; $("dash").hidden = true; $("assets").hidden = true; $("reminders").hidden = true; $("tabs").hidden = true;
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
  const ASSET_TYPE_LABEL = { investment: "investment", commodity: "commodity", savings: "savings" };
  function renderPickList(container, names, current, { editing, onPick, onEdit, onAdd, addLabel, badge = () => null }) {
    const chips = names.map((v) => {
      const type = badge(v);
      const chip = el("button", {
      type: "button", role: editing ? null : "radio", "aria-checked": editing ? null : String(v === current), "data-v": v, text: v,
      "aria-label": editing ? `Edit ${v}` : type ? `${v}, adds to your ${ASSET_TYPE_LABEL[type]} assets` : null,
      onclick: () => {
        if (editing) return onEdit(v);
        onPick(v);
        for (const b of container.children) if (!b.classList.contains("chip-add")) b.setAttribute("aria-checked", String(b.dataset.v === v));
      },
      });
      // asset-building categories (Gold, ASB, Savings) get a small "+" badge
      if (type) { chip.classList.add("chip-asset"); chip.title = `Adds to your ${ASSET_TYPE_LABEL[type]} assets`; chip.append(el("span", { class: "chip-badge", "aria-hidden": "true", text: "+" })); }
      return chip;
    });
    for (const c of chips) for (const a of ["role", "aria-checked", "aria-label"]) if (c.getAttribute(a) === "null") c.removeAttribute(a);
    chips.push(el("button", { type: "button", class: "chip-add", "aria-label": addLabel, text: "+", onclick: onAdd }));
    container.replaceChildren(...chips);
  }
  // Categories / payment methods of the active currency only (RM and ₩ lists are separate).
  const inCur = (x) => !x.currency || x.currency === S.currency;
  const curCats = () => S.meta.categories.filter(inCur);
  const findCat = (name) => curCats().find((c) => c.name === name);
  // "investment" | "commodity" | "savings" for asset-building categories, "" for plain expenses
  const catAssetType = (c) => (c?.is_asset ?? (c?.asset_type && c.asset_type !== "expense")) ? c.asset_type : "";
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
      onPick: (c) => { S.category = c; store.set(catKey(), c); $("form-err").hidden = true; renderLinks(); },
      onEdit: (c) => openItem("cat", c),
      onAdd: () => openItem("cat", null),
      addLabel: "Add category",
      badge: (c) => catAssetType(findCat(c)) || null,
    });
    const hint = $("cat-hint");
    hint.hidden = cats.length > 0 && !S.editCats;
    hint.textContent = S.editCats ? "Tap a category to rename it, change its type or remove it."
      : `Tap + to add your first ${SYM[S.currency] || S.currency} ${S.type} category.`;
    $("cat-edit").hidden = curCats().length === 0;
    renderLinks();
  }
  function renderBanks() {
    const banks = banksForCur();
    let cur = S.bankByCur[S.currency];
    if (!banks.includes(cur)) cur = banks[0] ?? null;
    S.bankByCur[S.currency] = cur;
    renderPickList($("bank-pills"), banks, cur, {
      editing: S.editBanks,
      onPick: (b) => { S.bankByCur[S.currency] = b; store.set("bankByCur", S.bankByCur); $("form-err").hidden = true; renderLinks(); },
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
    renderLinks();
  }

  // ---------- automatic asset links ----------
  // Each payment method is an account asset: an expense is taken from it (income is added). A category
  // tagged as an asset type (Gold, ASB, Savings) also adds the cost to its asset. The server does both,
  // in the same database transaction as the entry; the form only shows what will happen.
  const assetName = (a) => a.name || a.category;
  // one fetch keeps the form hints AND the Assets tab (list, history, charts) current, so an asset
  // created by an entry (first Gold purchase) is already there when the tab opens
  const loadFormAssets = () => loadAssets(true);
  function setFormAssets(list, cats) {
    S.assets = list || []; store.set("assets", S.assets);
    if (cats) { S.assetCats = cats.map((c) => (typeof c === "string" ? c : c.name)); store.set("assetCats", S.assetCats); }
    renderLinks();
  }
  const pmAsset = (name = S.bankByCur[S.currency], cur = S.currency) => {
    const id = S.meta?.payment_methods?.find((p) => p.name === name && p.currency === cur)?.asset_id;
    return id ? S.assets.find((a) => a.asset_id === id) || null : null;
  };
  // the asset an asset-building category adds to (same rule as the server): the asset named exactly like
  // the category in this currency, or a new one with that name
  function catTarget(catName = S.category) {
    const c = findCat(catName);
    if (!catAssetType(c) || S.type !== "expense") return null;
    const src = pmAsset();
    const hit = S.assets.find((a) => a.currency === S.currency && (a.name || "").toLowerCase() === c.name.toLowerCase()
                                     && a.asset_id !== src?.asset_id);
    return hit || { name: c.name, value: 0, currency: S.currency, isNew: true };
  }
  // one line under the payment methods: "Maybank savings RM 987.50 → RM 975.00 · Gold +RM 12.50"
  function renderLinks() {
    const h = $("pm-bal");
    if (!S.meta || !h) return;
    const a = pmAsset();
    const amt = Number(plain($("amount").value)) || 0;
    const sign = S.type === "income" ? 1 : -1;
    const parts = [];
    if (a) {
      const now = Number(a.value ?? 0), after = now + sign * amt;
      parts.push(amt ? `${assetName(a)} ${money(now, a.currency)} → ${money(after, a.currency)}` : `${assetName(a)} ${money(now, a.currency)}`);
    }
    const t = catTarget();
    if (t) parts.push(amt ? `${t.isNew ? "new " : ""}${assetName(t)} asset +${money(amt, S.currency)}`
                          : `adds to ${t.isNew ? "a new " : "your "}${assetName(t)} asset`);
    h.textContent = parts.join(" · ");
    h.hidden = parts.length === 0;
    h.classList.toggle("neg", !!a && Number(a.value ?? 0) + sign * amt < 0);
  }
  const linkHints = renderLinks;
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
    $("item-atype-wrap").hidden = $("item-budget-wrap").hidden;
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
    $("item-atype").value = catAssetType(existing);
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
      const atype = list === "cat" && kind !== "income" ? $("item-atype").value : "";
      const acatChanged = list === "cat" && atype !== catAssetType(existing);
      const catChanged = !original || name !== original || (list === "cat" && existing && (existing.kind !== kind || acatChanged));
      if (list === "acat") {
        if (!original) r = await api("POST", "/asset-categories", { name });
        else if (name !== original) r = await api("PATCH", "/asset-categories", { name: original, new_name: name });
        $("item-dlg").close();
        if (r) await afterAssetCatChange(original, r.asset_category.name, r.message);
        return;
      }
      if (!original) r = await api("POST", path, list === "cat" ? { name, kind, currency, ...(atype ? { asset_type: atype } : {}) } : { name, currency });
      else if (list === "cat" && catChanged) {
        r = await api("PATCH", path, { name: original, ...(name !== original ? { new_name: name } : {}), kind, currency,
                                      ...(acatChanged ? { asset_type: atype || null } : {}) });
      }
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
  // Swipe-deletes made offline are queued too, as { type: "DELETE", entity: "expense"|"reminder", id }.
  const queue = () => store.get("queue", []);
  const DEL_PATH = { expense: (id) => `/transactions/${id}`, reminder: (id) => `/reminders/${id}` };
  function enqueue(job) {
    const q = queue(); q.push(job); store.set("queue", q);
    // Chrome / Android: ask sw.js to wake the app when the connection is back (iOS has no Background
    // Sync, so there the queue is sent when the app is next opened or comes back online)
    navigator.serviceWorker?.ready.then((reg) => reg.sync?.register("ledger-queue")).catch(() => {});
  }
  const pendingDeletes = (entity) => new Set(queue().filter((j) => j.type === "DELETE" && j.entity === entity).map((j) => String(j.id)));
  let flushing = false;
  async function flushQueue() {
    const q = queue();
    if (!q.length || !S.key || flushing) return;
    flushing = true;
    const left = [];
    let sentTx = 0, sentDel = 0;
    for (const job of q) {
      try {
        if (job.type === "DELETE") { await api("DELETE", DEL_PATH[job.entity](job.id)); sentDel++; }
        else { await api("POST", "/transactions", job); sentTx++; }
      } catch (e) {
        if (job.type === "DELETE" && e instanceof ApiError && e.status === 404) { sentDel++; continue; }  // already gone
        if (!(e instanceof ApiError) || e.status >= 500) left.push(job);
      }
    }
    // keep anything queued while this ran
    const added = queue().slice(q.length);
    store.set("queue", [...left, ...added]);
    flushing = false;
    const n = sentTx + sentDel;
    if (n) {
      toast(`Synced ${n} offline change${n === 1 ? "" : "s"}.`);
      loadRecent(); loadFormAssets();
      if (sentDel) loadReminders(true);
      if (!$("dash").hidden) loadDash(true);
    }
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
      // new balances straight from the response, so the pickers are right before the refresh lands
      for (const a of r.assets || []) {
        const local = S.assets.find((x) => x.asset_id === a.asset_id);
        if (local) local.value = Number(a.value);
      }
      const moved = (r.assets || []).map((a) => `${a.name} ${money(a.value, a.currency)}`).join(" · ");
      toast(moved ? `Logged · ${moved}` : "Logged successfully", { undo: !r.duplicate, ms: 5000 });
      resetForm();
      loadRecent();
      if (r.assets?.length) { renderLinks(); loadFormAssets(); if (!$("assets").hidden) loadAssets(true); }
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
    linkHints();
  }

  async function loadRecent() {
    try {
      const r = await api("GET", "/transactions?limit=8");
      const gone = pendingDeletes("expense");
      r.transactions = r.transactions.filter((t) => !gone.has(String(t.transaction_id)));
      $("recent-list").replaceChildren(...r.transactions.map(txRow));
      if (!r.transactions.length) $("recent-list").append(el("li", { class: "muted", text: "Nothing yet. Your entries appear here." }));
    } catch { /* stay quiet on the entry screen */ }
  }
  function txRow(t) {
    const inc = t.transaction_type === "Income";
    const links = (t.source_asset ? ` · from ${t.source_asset}` : "") + (t.target_asset ? ` → ${t.target_asset}` : "");
    return swipeable(el("li", { tabindex: "0", "aria-label": `${t.item}, ${money(t.amount, t.currency)}. Swipe left or press Enter to delete.`,
                                onclick: () => askDelete(t), onkeydown: (e) => { if (e.key === "Enter") askDelete(t); } },
      el("div", { class: "t-main" }, el("div", { class: "t1", text: t.item }), el("div", { class: "t2", text: `${t.category}, ${t.which_bank}, ${t.date}${links}` })),
      el("div", { class: "t-right" },
        el("div", { class: "amt num" + (inc ? " inc" : ""), text: (inc ? "+" : "") + money(t.amount, t.currency) }))),
      { entity: "expense", id: t.transaction_id, tx: t });
  }

  // ---------- swipe to delete (Latest entries and reminders; touch only) ----------
  // Drag left past 80px: the row stays open at -80px over a red "Delete" zone (light haptic).
  // Past 200px, or a tap on the red zone: the row slides off, is removed after 200ms, then deleted.
  // Rows use touch-action: pan-y and every listener is passive, so vertical scrolling is never blocked.
  const SWIPE_OPEN = 80, SWIPE_FULL = 200, SWIPE_SLOP = 8;
  let swOpen = null, drag = null;
  const buzz = (ms) => { try { navigator.vibrate?.(ms); } catch { /* unsupported (iOS Safari) */ } };
  function swipeable(li, { entity, id, tx = null }) {
    li.classList.add("swipe");
    li._tx = tx;
    li.dataset.entity = entity; li.dataset.id = String(id);
    const fg = el("div", { class: "swipe-fg" }, ...li.childNodes);   // the row's own content, moved (listeners kept)
    const act = el("button", { type: "button", class: "swipe-act", tabindex: "-1", "aria-hidden": "true" }, el("span", { text: "Delete" }));
    act.addEventListener("click", (e) => { e.stopPropagation(); commitSwipe(li); });   // not the row's own tap
    li.replaceChildren(act, fg);
    return li;
  }
  const fgOf = (li) => li.querySelector(":scope > .swipe-fg");
  function setX(li, x) { fgOf(li).style.transform = x ? `translateX(${x}px)` : ""; }
  function openSwipe(li) { setX(li, -SWIPE_OPEN); li.classList.add("swipe-open"); swOpen = li; }
  function closeSwipe(li) { if (!li) return; setX(li, 0); li.classList.remove("swipe-open", "swipe-armed"); if (swOpen === li) swOpen = null; }
  function commitSwipe(li) {
    if (li.classList.contains("swipe-gone")) return;
    li.classList.add("swipe-gone"); li.classList.remove("swipe-open");
    fgOf(li).style.transform = "translateX(-100%)";
    buzz(50);
    if (swOpen === li) swOpen = null;
    setTimeout(() => { li.remove(); deleteEntity(li.dataset.entity, li.dataset.id, li._tx); }, 200);
  }
  // a swipe (or a tap that only closes an open row) must not also count as a tap on the row
  let noClickUntil = 0, noClickRow = null;
  document.addEventListener("click", (e) => {
    if (Date.now() < noClickUntil && noClickRow?.contains(e.target) && !e.target.closest(".swipe-act")) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
  document.addEventListener("touchstart", (e) => {
    const li = e.target.closest?.("li.swipe");
    if (swOpen && swOpen !== li) closeSwipe(swOpen);       // touching anywhere else closes the open row
    drag = null;
    if (!li || e.touches.length !== 1 || li.classList.contains("swipe-gone") || e.target.closest(".swipe-act")) return;
    const t = e.touches[0];
    drag = { li, x0: t.clientX, y0: t.clientY, base: li === swOpen ? -SWIPE_OPEN : 0, x: 0, axis: null,
             wasOpen: li === swOpen, pastOpen: li === swOpen };
  }, { passive: true });
  document.addEventListener("touchmove", (e) => {
    if (!drag) return;
    const t = e.touches[0], dx = t.clientX - drag.x0, dy = t.clientY - drag.y0;
    if (!drag.axis) {
      if (Math.abs(dx) < SWIPE_SLOP && Math.abs(dy) < SWIPE_SLOP) return;
      drag.axis = Math.abs(dx) > Math.abs(dy) ? "x" : "y";
      if (drag.axis === "y") { if (!drag.wasOpen) drag = null; return; }   // vertical: leave it to the page
      drag.li.classList.add("swiping");                                     // no transition while following the finger
    }
    if (drag.axis !== "x") return;
    drag.x = Math.min(0, drag.base + dx);
    setX(drag.li, drag.x);
    const past = -drag.x >= SWIPE_OPEN;
    if (past && !drag.pastOpen) buzz(20);
    drag.pastOpen = past;
    drag.li.classList.toggle("swipe-armed", -drag.x >= SWIPE_FULL);
  }, { passive: true });
  function endDrag() {
    if (!drag) return;
    const d = drag; drag = null;
    d.li.classList.remove("swiping", "swipe-armed");
    if (d.axis === "x" || d.wasOpen) { noClickUntil = Date.now() + 400; noClickRow = d.li; }
    if (d.axis !== "x") { if (d.wasOpen) closeSwipe(d.li); return; }       // a tap on an open row closes it
    if (-d.x >= SWIPE_FULL) commitSwipe(d.li);
    else if (-d.x >= SWIPE_OPEN) openSwipe(d.li);
    else closeSwipe(d.li);
  }
  document.addEventListener("touchend", endDrag, { passive: true });
  document.addEventListener("touchcancel", endDrag, { passive: true });

  // Optimistic delete: drop the row everywhere, take it out of the dashboard totals ("Spent vs. budget",
  // category bars, donut) and give its amount back to the linked account / take it off the asset,
  // before the API answers. The next server refresh replaces these local numbers.
  function optimisticRemoveTx(id, t) {
    t = t || S.monthTx.find((x) => String(x.transaction_id) === id);
    S.monthTx = S.monthTx.filter((x) => String(x.transaction_id) !== id);
    for (const li of document.querySelectorAll(`li.swipe[data-entity="expense"][data-id="${CSS.escape(id)}"]`)) {
      if (!li.classList.contains("swipe-gone")) li.remove();
    }
    if (!t) return;
    const amt = Number(t.amount), inc = t.transaction_type === "Income";
    const s = S.dashSummary;
    if (s && s.currency === t.currency && s.month === String(t.date).slice(0, 7)) {
      const k = s.kpi;
      if (inc) { k.total_income = Number(k.total_income) - amt; k.net = Number(k.net) - amt; }
      else {
        k.total_expenses = Number(k.total_expenses) - amt; k.net = Number(k.net) + amt;
        if (k.monthly_budget !== null) {
          k.remaining_budget = Number(k.monthly_budget) - k.total_expenses;
          k.budget_used_pct = Math.round(k.total_expenses / Number(k.monthly_budget) * 10000) / 100;
          k.over_budget = k.remaining_budget < 0;
        }
        const c = s.by_category.find((x) => x.category === t.category);
        if (c) {
          c.amount = Math.max(0, Number(c.amount) - amt);
          if (c.budget !== null && c.budget !== undefined) {
            c.remaining = Number(c.budget) - c.amount;
            c.used_pct = Math.round(c.amount / Number(c.budget) * 10000) / 100;
            c.over = c.amount > Number(c.budget);
          } else if (c.amount === 0) s.by_category = s.by_category.filter((x) => x !== c);
          s.by_category.sort((a, b) => Number(b.amount) - Number(a.amount));
        }
      }
      renderDash(s, s.currency);
      renderTable(s.currency);
    }
    // balances: the account gets the money back (or loses refunded income), the asset loses the cost
    const move = (assetId, delta) => {
      if (assetId == null) return;
      // S.assets and A.list usually hold the same objects: move each one once
      const hit = new Set([S.assets, A.list].map((l) => l.find((x) => x.asset_id === assetId)).filter(Boolean));
      for (const a of hit) a.value = Number(a.value ?? 0) + delta;
    };
    move(t.source_asset_id, inc ? -amt : amt);
    move(t.target_asset_id, -amt);
    store.set("assets", S.assets);
    renderLinks();
    if (!$("assets").hidden) renderAssets();
  }

  // delete from a swipe: online -> API now; offline -> queued for the next connection
  async function deleteEntity(entity, id, tx = null) {
    const job = { type: "DELETE", entity, id: String(id) };
    if (entity === "expense" && String(S.lastSavedId) === String(id)) S.lastSavedId = null;
    if (entity === "expense") optimisticRemoveTx(String(id), tx);
    if (entity === "reminder") {
      R.list = R.list.filter((x) => String(x.id) !== String(id)); R.completed = R.completed.filter((x) => String(x.id) !== String(id));
      renderReminderViews();
    }
    if (!navigator.onLine) {
      enqueue(job);
      toast("Offline: deleted here, will sync when you're back online.");
      return;
    }
    try {
      await api("DELETE", DEL_PATH[entity](id));
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) {                  // 404 = already deleted
        if (!(e instanceof ApiError) || e.status >= 500) {
          enqueue(job);
          toast("No connection. It will be deleted when you're back online.", { bad: true, ms: 7000 });
          return;
        }
        toast("Couldn't delete: " + e.message, { bad: true, ms: 7000 });   // put the row back
        if (entity === "expense") { loadRecent(); loadFormAssets(); if (!$("dash").hidden) loadDash(true); }
        else loadReminders(true);
        return;
      }
    }
    if (entity === "expense") {
      toast("Deleted.");
      // reconcile with the server (the screen already shows the result)
      loadRecent(); loadFormAssets(); loadReminders(true);
      if (!$("dash").hidden) loadDash(true);
      if (!$("assets").hidden) loadAssets(true);
    } else {
      toast("Reminder deleted.");
      loadReminders(true);
    }
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
      optimisticRemoveTx(String(t.transaction_id), t);
      toast(`Deleted ${t.item}.`);
      loadRecent(); loadFormAssets();
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

  // ---------- charts (hand-drawn SVG) ----------
  // Colours: 8 categorical slots, --s1..--s8 in styles.css (validated for colour-blind separation in
  // light and dark). A category keeps its colour wherever it appears: its colour is its position in the
  // user's own category list for that currency, so adding/removing others never repaints it.
  // Categories past the 8th fold into "Other" (grey) instead of inventing a 9th hue.
  const SLOTS = 8;
  const svgNS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs = {}) => { const n = document.createElementNS(svgNS, tag); for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v); return n; };
  function catPalette(cur, extraNames = []) {
    const names = S.meta.categories.filter((c) => (!c.currency || c.currency === cur) && c.kind !== "income").map((c) => c.name);
    for (const n of extraNames) if (!names.includes(n)) names.push(n);   // hidden categories that still have spending
    const slot = new Map(names.map((n, i) => [n, i]));
    return {
      key: (n) => ((slot.get(n) ?? SLOTS) < SLOTS ? n : "Other"),
      color: (n) => { const i = slot.get(n) ?? SLOTS; return i < SLOTS ? `var(--s${i + 1})` : "var(--s-other)"; },
      order: (a, b) => (slot.get(a) ?? 99) - (slot.get(b) ?? 99),
    };
  }
  function compactMoney(v, cur) {
    const n = Math.abs(Number(v)), sym = SYM[cur] ?? cur + " ", sp = cur === "MYR" ? " " : "";
    const t = n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M"
      : n >= 1e4 ? (n / 1e3).toFixed(0) + "k" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(Math.round(n));
    return (Number(v) < 0 ? "−" : "") + sym + sp + t.replace(".0", "");
  }

  // Doughnut: share of this month's spending per category. Tap a slice for its amount.
  function renderDonut(box, items, cur) {
    const total = items.reduce((a, x) => a + x.value, 0);
    box.replaceChildren();
    if (!(total > 0)) { box.hidden = true; return; }
    box.hidden = false;
    const R = 52, C = 2 * Math.PI * R, gap = items.length > 1 ? 1.5 : 0;   // 2px surface gap between slices (viewBox units)
    const svg = svgEl("svg", { viewBox: "0 0 140 140", role: "img", "aria-label": "Spending by category" });
    const center = el("div", { class: "donut-center" });
    // the hole fits ~9 characters at full size; longer amounts step the font down so they never spill
    const vClass = (txt) => "num donut-v" + (txt.length > 12 ? " xs" : txt.length > 9 ? " sm" : "");
    const showTotal = () => center.replaceChildren(el("div", { class: "muted small", text: "Spent" }), el("div", { class: vClass(money(total, cur)), text: money(total, cur) }));
    let off = 0;
    const segs = [];
    const apply = () => {   // the picked slice survives the 15-second refresh
      const x = items.find((i) => i.label === S.donutPick);
      if (!x) { S.donutPick = null; for (const g of segs) g.classList.remove("dim"); return showTotal(); }
      for (const g of segs) g.classList.toggle("dim", g.dataset.label !== x.label);
      center.replaceChildren(el("div", { class: "muted small", text: x.label }), el("div", { class: vClass(money(x.value, cur)), text: money(x.value, cur) }),
        el("div", { class: "muted small", text: `${(x.value / total * 100).toFixed(1)}%` }));
    };
    for (const x of items) {
      const len = (x.value / total) * C;
      const c = svgEl("circle", { cx: 70, cy: 70, r: R, fill: "none", "stroke-width": 16,
        "stroke-dasharray": `${Math.max(0.01, len - gap).toFixed(2)} ${(C - len + gap).toFixed(2)}`,
        "stroke-dashoffset": (-off).toFixed(2), transform: "rotate(-90 70 70)", class: "donut-seg", tabindex: "0" });
      c.style.stroke = x.color; c.dataset.label = x.label; segs.push(c);
      c.append(svgEl("title")); c.lastChild.textContent = `${x.label}: ${money(x.value, cur)} (${(x.value / total * 100).toFixed(1)}%)`;
      const pick = () => { S.donutPick = S.donutPick === x.label ? null : x.label; apply(); };
      c.addEventListener("click", pick);
      c.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(); } });
      svg.append(c);
      off += len;
    }
    apply();
    box.append(el("div", { class: "donut" }, svg, center));
  }

  // Stacked bars: spending per category for each month in the window (ends at the selected month).
  // Tap a month for its breakdown.
  function renderTrend(trend, cur, pal) {
    const box = $("ch-trend"), detail = $("trend-detail"), legend = $("trend-legend");
    const months = trend?.months || [];
    const byMonth = new Map(months.map((m) => [m, new Map()]));
    for (const r of trend?.rows || []) {
      const m = byMonth.get(r.month); if (!m) continue;
      const k = pal.key(r.category);
      m.set(k, (m.get(k) || 0) + Number(r.amount));
    }
    const cats = [...new Set([...byMonth.values()].flatMap((m) => [...m.keys()]))].sort((a, b) => (a === "Other") - (b === "Other") || pal.order(a, b));
    const totals = months.map((m) => [...byMonth.get(m).values()].reduce((a, v) => a + v, 0));
    const max = Math.max(...totals, 0);
    box.replaceChildren(); legend.replaceChildren(); detail.textContent = "";
    if (!(max > 0)) { box.append(el("p", { class: "muted small", text: "No spending in these months yet." })); return; }
    const W = 340, H = 170, pl = 2, pr = 2, pt = 18, pb = 22, slotW = (W - pl - pr) / months.length, bw = Math.min(40, slotW * 0.6);
    const y = (v) => (H - pb) - (H - pt - pb) * (v / max);
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Monthly spending by category" });
    svg.append(svgEl("line", { x1: pl, x2: W - pr, y1: H - pb, y2: H - pb, class: "axis" }));
    const label = (m) => new Date(m + "-01T00:00:00").toLocaleString("en", { month: "short" });
    const showMonth = (i) => {
      const m = months[i], parts = cats.filter((c) => byMonth.get(m).get(c)).map((c) => `${c} ${money(byMonth.get(m).get(c), cur)}`);
      detail.textContent = `${new Date(m + "-01T00:00:00").toLocaleString("en", { month: "long", year: "numeric" })}: ${money(totals[i], cur)}` + (parts.length ? ` · ${parts.join(", ")}` : "");
      for (const g of svg.querySelectorAll(".col")) g.classList.toggle("dim", g.dataset.i !== String(i));
    };
    months.forEach((m, i) => {
      const g = svgEl("g", { class: "col", "data-i": i, tabindex: "0" });
      const x = pl + slotW * i + (slotW - bw) / 2;
      let base = 0;
      for (const c of cats) {
        const v = byMonth.get(m).get(c) || 0; if (!(v > 0)) continue;
        const y0 = y(base), y1 = y(base + v), h = Math.max(1, y0 - y1 - 2);   // 2px surface gap between segments
        const r = svgEl("rect", { x: x.toFixed(1), y: (y1).toFixed(1), width: bw.toFixed(1), height: h.toFixed(1), rx: 3 });
        r.style.fill = pal.color(c === "Other" ? "\u0000" : c);
        r.append(svgEl("title")); r.lastChild.textContent = `${label(m)} · ${c}: ${money(v, cur)}`;
        g.append(r);
        base += v;
      }
      if (totals[i] > 0) { const t = svgEl("text", { x: (x + bw / 2).toFixed(1), y: (y(totals[i]) - 5).toFixed(1), "text-anchor": "middle", class: "val" }); t.textContent = compactMoney(totals[i], cur); g.append(t); }
      const t = svgEl("text", { x: (x + bw / 2).toFixed(1), y: H - 6, "text-anchor": "middle", class: i === months.length - 1 ? "cur" : "" }); t.textContent = label(m); g.append(t);
      g.append(svgEl("rect", { x: (pl + slotW * i).toFixed(1), y: 0, width: slotW.toFixed(1), height: H, class: "hit" }));   // bigger tap target
      g.addEventListener("click", () => showMonth(i));
      g.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); showMonth(i); } });
      svg.append(g);
    });
    box.append(svg);
    for (const c of cats) { const i = el("i"); i.style.background = pal.color(c === "Other" ? "\u0000" : c); legend.append(el("span", {}, i, c)); }
    showMonth(months.length - 1);
  }

  // ---------- dashboard ----------
  async function loadDash(silent = false) {
    const cur = S.dashCurrency, month = $("month").value || todayLocal().slice(0, 7);
    try {
      const [s, t] = await Promise.all([
        api("GET", `/summary?month=${month}&currency=${cur}`),
        api("GET", `/transactions?limit=200&currency=${cur}&month=${month}`),
      ]);
      S.dashSummary = s;
      renderDash(s, cur);
      const gone = pendingDeletes("expense");
      S.monthTx = t.transactions.filter((x) => !gone.has(String(x.transaction_id))); renderTable(cur);
      if (Date.now() - R.loadedAt > 30000) loadReminders(true); else renderUpcoming();
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

    // Spending by category: doughnut + rows. Colours come from the user's own category list for
    // this currency, so creating / renaming / removing a category redraws everything consistently.
    const pal = catPalette(cur, [...s.by_category.map((c) => c.category), ...(s.category_trend?.rows || []).map((r) => r.category)]);
    const slices = new Map();
    for (const c of s.by_category) if (Number(c.amount) > 0) { const kk = pal.key(c.category); slices.set(kk, (slices.get(kk) || 0) + Number(c.amount)); }
    renderDonut($("ch-donut"), [...slices.entries()].sort((a, b) => b[1] - a[1])
      .map(([label, value]) => ({ label, value, color: pal.color(label === "Other" ? "\u0000" : label) })), cur);

    // rows = budget progress bars: with a budget the bar and the value show % of that budget used;
    // without one, the bar is the share of the biggest spend and the value is the amount
    const maxC = Math.max(1, ...s.by_category.map((c) => Number(c.amount)));
    const fill = (pct) => { const i = document.createElement("i"); i.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + "%"; return i; };
    $("ch-cat").replaceChildren(s.by_category.length
      ? el("div", { class: "bars" }, ...s.by_category.map((c) => {
          const hasB = c.budget !== null && c.budget !== undefined;
          const pct = hasB ? Number(c.used_pct) : null;
          const dot = el("i", { class: "dot" }); dot.style.background = pal.color(c.category);
          return el("div", { class: "bar-row" + (hasB && c.over ? " over" : ""),
                             title: hasB ? `${f(c.amount)} of ${f(c.budget)}` : f(c.amount) },
            el("span", { class: "cat-name" }, dot, el("span", { text: c.category })),
            el("span", { class: "bar-track" + (hasB ? " has-budget" : "") },
              fill(hasB ? pct : Number(c.amount) / maxC * 100)),
            el("span", { class: "num", text: hasB ? `${pct.toFixed(1)}% used` : f(c.amount) }));
        }))
      : el("p", { class: "muted small", text: "No spending this month yet." }));

    renderTrend(s.category_trend, cur, pal);
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
      const links = (t.source_asset ? ` · ${t.source_asset}` : "") + (t.target_asset ? ` → ${t.target_asset}` : "");
      return swipeable(el("li", { "data-tx": String(t.transaction_id), tabindex: "0",
                                  "aria-label": `${t.item}, ${money(t.amount, cur)}. Swipe left or press Enter to delete.`,
                                  onclick: () => askDelete(t), onkeydown: (e) => { if (e.key === "Enter") askDelete(t); } },
        el("span", { class: "c-date", text: t.date.slice(5) }),
        el("span", { class: "c-item" }, el("span", { class: "c-item-t", text: t.item }), el("span", { class: "sub", text: `${t.category}, ${t.which_bank}${links}` })),
        el("span", { class: "c-cat", text: t.category }),
        el("span", { class: "c-amt r num" + (inc ? " inc" : ""), text: (inc ? "+" : "") + money(t.amount, cur) }),
        el("span", { class: "c-bank", text: t.which_bank }),
        el("span", { class: "c-type", text: t.transaction_type })), { entity: "expense", id: t.transaction_id, tx: t });
    }));
    if (!rows.length) $("tx-body").append(el("li", { class: "muted tx-empty", text: "No transactions match." }));
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
  $("amount").addEventListener("input", () => { formatInput($("amount"), S.currency); linkHints(); });

  // ---------- assets / net worth ----------
  // asset categories are a user-managed list (shared by RM and ₩): + to add, Edit to rename / remove
  const A = { list: [], totals: {}, categories: [], history: [], ctx: null, editCats: false,
              open: new Set(store.get("assetOpen", [])) };   // expanded category groups ("MYR|Gold")
  const assetCatNames = () => A.categories.map((c) => (typeof c === "string" ? c : c.name));
  const curOrder = () => S.meta.currencies.map((c) => c.code).sort((a, b) => (a === "MYR" ? -1 : b === "MYR" ? 1 : a.localeCompare(b)));
  async function loadAssets(silent = false) {
    try {
      const r = await api("GET", "/assets");
      A.list = r.assets; A.totals = r.totals; A.categories = r.categories; A.history = r.history || [];
      setFormAssets(r.assets, r.categories);
      renderAssets();
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return showSetup("Your API key was rejected. Enter it again.");
      if (e instanceof ApiError && e.status === 404) {
        $("asset-groups").replaceChildren(el("p", { class: "muted small", text: "Your server needs this update first: run scripts\\deploy.ps1 on your laptop." }));
        return;
      }
      if (!silent) toast("Couldn't load assets: " + e.message, { bad: true });
    }
  }
  const curTitle = (code) => (code === "MYR" ? "Ringgit (RM)" : code === "KRW" ? "Won (₩)" : code);
  const fmtDay = (d) => new Date(d + "T00:00:00").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  function renderAssets() {
    const codes = curOrder();
    // net worth per currency, never mixed
    $("networth").replaceChildren(...codes.map((code) => el("div", { class: "kpi" },
      el("div", { class: "muted small", text: `Net worth (${SYM[code] || code})` }),
      el("div", { class: "num kpi-v", text: money(A.totals[code] ?? 0, code) }),
      el("div", { class: "muted small", text: `${A.list.filter((a) => a.currency === code).length} asset${A.list.filter((a) => a.currency === code).length === 1 ? "" : "s"}` }))));
    renderAssetTrends();
    if (!A.list.length) {
      $("asset-groups").replaceChildren(el("section", { class: "panel empty" },
        el("p", { class: "muted", text: "Track what you own: savings accounts, ASB, gold, stocks and more. Tap + Add asset." })));
      return;
    }
    // per currency: one collapsible row per asset category, with its total; tap to see the assets inside
    $("asset-groups").replaceChildren(...codes.filter((code) => A.list.some((a) => a.currency === code)).map((code) => {
      const inCur = A.list.filter((a) => a.currency === code);
      const cats = [...new Set(inCur.map((a) => a.category))].sort((a, b) => assetCatNames().indexOf(a) - assetCatNames().indexOf(b));
      return el("section", { class: "panel" },
        el("div", { class: "group-head" }, el("h2", { text: curTitle(code) }), el("span", { class: "num muted", text: money(A.totals[code] ?? 0, code) })),
        el("div", { class: "acc" }, ...cats.map((cat) => {
          const items = inCur.filter((a) => a.category === cat), key = `${code}|${cat}`, open = A.open.has(key);
          const total = items.reduce((t, a) => t + Number(a.value || 0), 0);
          const body = el("ul", { class: "tx-list asset-list acc-body", id: "acc-" + btoa(unescape(encodeURIComponent(key))).replace(/=/g, "") }, ...items.map(assetRow));
          body.hidden = !open;
          const head = el("button", { type: "button", class: "acc-head", "aria-expanded": String(open), "aria-controls": body.id,
            onclick: () => {
              const now = !A.open.has(key);
              now ? A.open.add(key) : A.open.delete(key);
              store.set("assetOpen", [...A.open]);
              head.setAttribute("aria-expanded", String(now)); body.hidden = !now;
            } },
            el("span", { class: "chev", "aria-hidden": "true", text: "›" }),
            el("span", { class: "acc-name" }, el("span", { class: "t1", text: cat }),
              el("span", { class: "t2", text: `${items.length} asset${items.length === 1 ? "" : "s"}` })),
            el("span", { class: "amt num", text: money(total, code) }));
          return el("div", { class: "acc-item" }, head, body);
        })));
    }));
  }
  // one asset inside an expanded category: name, details, value, and its recent value history
  function assetRow(a) {
    // earlier values (the current one is already shown on the right)
    const hist = A.history.filter((h) => h.asset_id === a.asset_id && h.date !== a.value_date).slice(-3).reverse();
    const short = (d) => (d.slice(0, 4) === todayLocal().slice(0, 4) ? fmtDay(d).replace(/ \d{4}$/, "") : fmtDay(d));
    const pmName = S.meta?.payment_methods?.find((p) => p.asset_id === a.asset_id)?.name;
    const sub = [pmName ? `Payment method: ${pmName}` : null, a.value_date ? "updated " + fmtDay(a.value_date) : null, a.notes].filter(Boolean).join(" · ");
    return el("li", { class: "asset-row", tabindex: "0", role: "button", "aria-label": `Edit ${a.name || a.category}`,
                      onclick: () => openAsset(a), onkeydown: (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openAsset(a); } } },
      el("div", { class: "t-main" },
        el("div", { class: "t1", text: a.name || a.category }),
        el("div", { class: "t2", text: sub }),
        ...(hist.length ? [el("div", { class: "t3", text: "Before: " + hist.map((h) => `${short(h.date)} ${money(h.value, a.currency)}`).join(" · ") })] : [])),
      el("div", { class: "amt num", text: money(a.value, a.currency) }));
  }

  // ---- 3-month trend: one line chart per currency, side by side ----
  // Value on a day = each asset's latest value dated on or before that day (an asset counts from its
  // first value). Drawn as steps, because values only change when you update them.
  function assetSeries(code, cat, start, end) {
    const assets = A.list.filter((a) => a.currency === code && (!cat || a.category === cat));
    const ids = new Set(assets.map((a) => a.asset_id));
    const hist = A.history.filter((h) => ids.has(h.asset_id));
    const valueOn = (day) => {
      let t = 0;
      for (const id of ids) {
        let v = null;
        for (const h of hist) if (h.asset_id === id && h.date <= day) v = Number(h.value);
        if (v !== null) t += v;
      }
      return t;
    };
    // the line begins when there is something to show: the window start, or the first value logged inside it
    const firstLogged = hist.length ? hist.reduce((m, h) => (h.date < m ? h.date : m), hist[0].date) : end;
    const from = firstLogged > start ? (firstLogged > end ? end : firstLogged) : start;
    const days = [...new Set([from, ...hist.map((h) => h.date).filter((d) => d > from && d <= end), end])].sort();
    return { has: assets.length > 0, from, points: days.map((d) => ({ d, v: valueOn(d) })) };
  }
  function renderAssetTrends() {
    const panel = $("asset-trend-panel");
    panel.hidden = !A.list.length;
    if (!A.list.length) return;
    // filter: total net worth, or one category (only categories that hold assets)
    const sel = $("asset-trend-cat"), keep = sel.value;
    const used = assetCatNames().filter((n) => A.list.some((a) => a.category === n));
    sel.replaceChildren(sel.options[0], ...used.map((n) => el("option", { value: n, text: n })));
    sel.value = used.includes(keep) ? keep : "";
    const cat = sel.value || null;
    const today = todayLocal(), t = new Date(today + "T00:00:00");
    const start = new Date(t.getFullYear(), t.getMonth() - 2, 1);
    const startStr = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, "0")}-01`;
    $("asset-trends").replaceChildren(...curOrder().map((code) => assetTrendCard(code, cat, startStr, today)));
  }
  $("asset-trend-cat").addEventListener("change", renderAssetTrends);
  function assetTrendCard(code, cat, start, end) {
    const { has, points, from } = assetSeries(code, cat, start, end);
    const card = el("div", { class: "trend-card" });
    const head = el("div", { class: "trend-card-head" });
    card.append(el("div", { class: "muted small", text: `${SYM[code] || code}${cat ? " · " + cat : ""}` }), head);
    if (!has) { head.append(el("div", { class: "muted small trend-empty", text: cat ? `No ${cat} in ${SYM[code] || code}` : `No ${SYM[code] || code} assets` })); return card; }
    const first = points[0].v, last = points[points.length - 1].v, diff = last - first;
    const showHead = (p, isEnd) => head.replaceChildren(
      el("div", { class: "num trend-v", text: money(p.v, code) }),
      el("div", { class: "small " + (isEnd ? (diff > 0 ? "inc" : diff < 0 ? "neg" : "muted") : "muted"),
        text: isEnd ? `${diff > 0 ? "+" : diff < 0 ? "−" : "±"}${compactMoney(Math.abs(diff), code)} since ${from === start ? new Date(start + "T00:00:00").toLocaleString("en", { month: "short" }) : fmtDay(from).replace(/ \d{4}$/, "")}` : fmtDay(p.d) }));
    showHead(points[points.length - 1], true);
    // geometry
    const W = 170, H = 96, pl = 3, pr = 5, pt = 8, pb = 16;
    const t0 = Date.parse(start), t1 = Date.parse(end) || t0 + 1, span = Math.max(1, t1 - t0);
    const x = (d) => pl + (W - pl - pr) * ((Date.parse(d) - t0) / span);
    let lo = Math.min(...points.map((p) => p.v)), hi = Math.max(...points.map((p) => p.v));
    if (hi === lo) { const pad = hi ? Math.abs(hi) * 0.1 : 1; lo -= pad; hi += pad; } else { const pad = (hi - lo) * 0.12; lo -= pad; hi += pad; }
    const y = (v) => pt + (H - pt - pb) * (1 - (v - lo) / (hi - lo));
    const svg = svgEl("svg", { viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": `${SYM[code] || code} ${cat || "net worth"}, last 3 months` });
    // month gridlines + labels (recessive)
    const sd = new Date(start + "T00:00:00");
    for (let i = 0; i < 3; i++) {
      const m = new Date(sd.getFullYear(), sd.getMonth() + i, 1);
      const ds = `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, "0")}-01`, xx = x(ds);
      svg.append(svgEl("line", { x1: xx.toFixed(1), x2: xx.toFixed(1), y1: pt, y2: H - pb, class: "grid" }));
      const tx = svgEl("text", { x: (xx + 2).toFixed(1), y: H - 4 }); tx.textContent = m.toLocaleString("en", { month: "short" }); svg.append(tx);
    }
    // step line
    let d = `M${x(points[0].d).toFixed(1)},${y(points[0].v).toFixed(1)}`;
    for (let i = 1; i < points.length; i++) d += ` H${x(points[i].d).toFixed(1)} V${y(points[i].v).toFixed(1)}`;
    const line = svgEl("path", { d, class: "nw-line", fill: "none" });
    svg.append(line);
    const dot = svgEl("circle", { r: 3.5, class: "nw-dot", cx: x(points[points.length - 1].d).toFixed(1), cy: y(last).toFixed(1) });
    const cross = svgEl("line", { y1: pt, y2: H - pb, class: "cross", visibility: "hidden" });
    svg.append(cross, dot);
    // hover / drag: crosshair + the value on that day in the header
    const pick = (ev) => {
      const r = svg.getBoundingClientRect(), px = ((ev.clientX - r.left) / r.width) * W;
      const day = new Date(t0 + span * Math.min(1, Math.max(0, (px - pl) / (W - pl - pr))));
      const ds = `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, "0")}-${String(day.getDate()).padStart(2, "0")}`;
      let p = points[0]; for (const q of points) if (q.d <= ds) p = q;
      const at = { d: ds, v: p.v };
      cross.setAttribute("x1", x(ds).toFixed(1)); cross.setAttribute("x2", x(ds).toFixed(1)); cross.setAttribute("visibility", "visible");
      dot.setAttribute("cx", x(ds).toFixed(1)); dot.setAttribute("cy", y(at.v).toFixed(1));
      showHead(at, false);
    };
    const reset = () => {
      cross.setAttribute("visibility", "hidden");
      dot.setAttribute("cx", x(points[points.length - 1].d).toFixed(1)); dot.setAttribute("cy", y(last).toFixed(1));
      showHead(points[points.length - 1], true);
    };
    svg.addEventListener("pointermove", pick);
    svg.addEventListener("pointerdown", pick);
    svg.addEventListener("pointerleave", reset);
    card.append(svg);
    return card;
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
    // date the value applies to: today by default. Editing: a new value is added on this date (history kept);
    // changing only the date moves the last update to that date.
    $("asset-date").value = todayLocal(); $("asset-date").max = todayLocal();
    A.ctx.dateDefault = todayLocal();
    $("asset-date-hint").textContent = a?.value_date ? `Last updated ${fmtDay(a.value_date)}` : "";
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
    const date = $("asset-date").value || todayLocal();
    if (date > todayLocal()) { $("asset-err").textContent = "The date can't be in the future."; $("asset-err").hidden = false; return; }
    $("asset-save").disabled = true;
    try {
      if (!A.ctx.id) {
        await api("POST", "/assets", { category, value, currency: A.ctx.currency, date,
                                       ...(name ? { name } : {}), ...(notes ? { notes } : {}) });
      } else {
        const o = A.ctx.original, body = {};
        if (category !== o.category) body.category = category;
        if (name !== (o.name ?? "")) body.name = name;
        if (notes !== (o.notes ?? "")) body.notes = notes;
        if (Number(value) !== Number(o.value)) { body.value = value; body.date = date; }
        else if (date !== A.ctx.dateDefault && o.value_date && date !== o.value_date) { body.date = date; body.move_from = o.value_date; }
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

  // ---------- reminders ----------
  // Reminders live apart from transactions: completing one can optionally open the normal expense
  // form pre-filled, and nothing is counted as spending until that expense is saved.
  const R = { list: [], completed: [], loadedAt: 0, filter: store.get("remFilter", "upcoming"), ctx: null, pendingOpen: null, devices: 0 };
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Seoul"; } catch { return "Asia/Seoul"; } })();
  const pad2 = (n) => String(n).padStart(2, "0");
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const clockText = (d) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/[  ]/g, " ");
  const remStatus = (r, now = Date.now()) => (r.isCompleted ? "completed" : new Date(r.dueAt).getTime() < now ? "overdue" : "upcoming");
  // RM120 · RM120.50 · ₩15,000
  function remAmount(r) {
    if (r.amount === null || r.amount === undefined || r.amount === "") return "";
    const n = Number(r.amount), d = r.currency === "KRW" || Number.isInteger(n) ? 0 : 2;
    return (SYM[r.currency] ?? r.currency + " ") + n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  // "Today, 9:00 PM" · "Tomorrow, 9:00 PM" · "Fri, 9:00 PM" · "Nov 20, 9:00 PM" · "Overdue · Nov 10"
  function schedText(r, now = new Date()) {
    const due = new Date(r.dueAt);
    const md = (d) => d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) + (d.getFullYear() !== now.getFullYear() ? ` ${d.getFullYear()}` : "");
    if (r.isCompleted) return "Done " + md(new Date(r.completedAt || r.dueAt));
    const today = dayKey(now), day = dayKey(due);
    const shift = (n) => dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + n));
    if (due < now) {
      if (day === today) return `Overdue · Today, ${clockText(due)}`;
      if (day === shift(-1)) return "Overdue · Yesterday";
      return `Overdue · ${md(due)}`;
    }
    if (day === today) return `Today, ${clockText(due)}`;
    if (day === shift(1)) return `Tomorrow, ${clockText(due)}`;
    const days = Math.round((new Date(due.getFullYear(), due.getMonth(), due.getDate()) - new Date(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
    if (days < 7) return `${due.toLocaleDateString("en-US", { weekday: "short" })}, ${clockText(due)}`;
    return `${md(due)}, ${clockText(due)}`;
  }
  const openSorted = () => [...R.list].sort((a, b) => {
    const sa = remStatus(a), sb = remStatus(b);
    if (sa !== sb) return sa === "overdue" ? -1 : 1;           // overdue first, then soonest
    return new Date(a.dueAt) - new Date(b.dueAt) || a.id - b.id;
  });

  async function loadReminders(silent = false) {
    try {
      const r = await api("GET", "/reminders");
      const gone = pendingDeletes("reminder");
      R.list = r.reminders.filter((x) => !gone.has(String(x.id))); R.completed = r.completed.filter((x) => !gone.has(String(x.id)));
      R.devices = r.push_devices ?? 0; R.loadedAt = Date.now(); R.missing = false;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return showSetup("Your API key was rejected. Enter it again.");
      if (e instanceof ApiError && e.status === 404) R.missing = true;
      else if (!silent) toast("Couldn't load reminders: " + e.message, { bad: true });
    }
    renderReminderViews();
    if (R.pendingOpen) { const id = R.pendingOpen; R.pendingOpen = null; openReminderById(id); }
  }
  function renderReminderViews() { renderUpcoming(); renderReminderList(); renderBadge(); }

  function remItem(r) {
    const st = remStatus(r), amt = remAmount(r);
    const when = el("span", { class: "rem-when", text: schedText(r) });
    // the badge uses the category's dashboard colour (same slot as in the charts)
    const badge = el("span", { class: "badge", text: r.category || "No category" });
    if (r.category) badge.style.setProperty("--bc", catPalette(r.currency, [r.category]).color(r.category));
    const meta = el("span", { class: "rem-meta" }, badge, when);
    if (r.repeat !== "Once") meta.append(el("span", { class: "rem-rep", text: "↻ " + r.repeat }));
    if (!r.pushEnabled && st !== "completed") meta.append(el("span", { class: "rem-rep", text: "No alert" }));
    if (r.transactionId) meta.append(el("span", { class: "rem-rep rem-logged", text: "✓ Logged" }));
    const main = el("button", { type: "button", class: "rem-main", onclick: () => openReminder(r) },
      el("span", { class: "rem-title", text: r.title }), meta);
    const right = el("div", { class: "rem-right" });
    if (amt) right.append(el("span", { class: "rem-amt num", text: amt }));
    if (st === "completed") {
      right.append(el("button", { type: "button", class: "rem-act", text: "Reopen", onclick: () => reopenReminder(r) }));
    } else {
      right.append(el("button", { type: "button", class: "rem-check", "aria-label": `Mark ${r.title} as complete`,
                                  title: "Mark as complete", onclick: () => askComplete(r) }));
    }
    return swipeable(el("li", { class: `rem-item ${st}`, "data-id": String(r.id) }, main, right), { entity: "reminder", id: r.id });
  }
  function renderUpcoming() {
    const box = $("upcoming-list");
    if (R.missing) { box.replaceChildren(el("li", { class: "muted small", text: "Your server needs this update first: run scripts\\deploy.ps1 on your laptop." })); $("rem-view-all").hidden = true; return; }
    const open = openSorted();
    box.replaceChildren(...open.slice(0, 3).map(remItem));
    if (!open.length) box.append(el("li", { class: "rem-empty muted small", text: "Nothing coming up. Tap + Reminder to add a bill or payment." }));
    $("rem-view-all").textContent = open.length > 3 ? `View all (${open.length})` : "View all";
  }
  function renderReminderList() {
    const now = Date.now();
    const over = R.list.filter((r) => remStatus(r, now) === "overdue");
    const up = R.list.filter((r) => remStatus(r, now) === "upcoming");
    $("rem-n-upcoming").textContent = up.length ? String(up.length) : "";
    $("rem-n-overdue").textContent = over.length ? String(over.length) : "";
    for (const b of $("rem-tabs").children) b.setAttribute("aria-selected", String(b.dataset.f === R.filter));
    const rows = R.filter === "completed" ? R.completed
      : (R.filter === "overdue" ? over : up).sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));
    const box = $("rem-list");
    box.replaceChildren(...rows.map(remItem));
    if (R.missing) box.replaceChildren(el("li", { class: "rem-empty muted small", text: "Your server needs this update first: run scripts\\deploy.ps1 on your laptop." }));
    else if (!rows.length) {
      box.append(el("li", { class: "rem-empty muted small", text: R.filter === "upcoming" ? "No upcoming reminders. Tap + Reminder to add one."
        : R.filter === "overdue" ? "Nothing overdue." : "Completed reminders appear here." }));
    }
  }
  function renderBadge() {
    const n = R.list.filter((r) => remStatus(r) === "overdue").length;
    $("tab-badge").hidden = !n; $("tab-badge").textContent = String(n);
    try { if (navigator.setAppBadge) n ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } catch { /* not allowed */ }
  }
  for (const b of $("rem-tabs").children) b.addEventListener("click", () => { R.filter = b.dataset.f; store.set("remFilter", R.filter); renderReminderList(); });
  $("rem-view-all").addEventListener("click", () => showTab("reminders"));
  $("rem-add").addEventListener("click", () => openReminder(null));
  $("rem-add-dash").addEventListener("click", () => openReminder(null));

  // ---------- create / edit dialog ----------
  // Categories are your expense categories (each belongs to RM or ₩). Picking one sets the currency;
  // switching the currency by hand moves to the category of the same name in that list, if there is one.
  const expenseCats = (code) => S.meta.categories.filter((c) => (!c.currency || c.currency === code) && c.kind !== "income").map((c) => c.name);
  const payMethods = (code) => (S.meta.payment_methods || []).filter((b) => !b.currency || b.currency === code).map((b) => b.name);
  function fillCatSelect(sel, { only = null, value = "" } = {}) {
    const groups = curOrder().filter((code) => !only || code === only).map((code) => {
      const names = expenseCats(code);
      if (!names.length) return null;
      return el("optgroup", { label: `${SYM[code] || code} categories` }, ...names.map((n) => el("option", { value: `${code}|${n}`, text: n })));
    }).filter(Boolean);
    sel.replaceChildren(el("option", { value: "", text: groups.length ? "Choose a category" : "No expense categories yet" }), ...groups);
    sel.value = value;
    if (sel.value !== value) sel.value = "";
  }
  function fillPmSelect(sel, code, value, emptyText = "None") {
    const names = payMethods(code);
    sel.replaceChildren(el("option", { value: "", text: names.length ? emptyText : `No ${SYM[code] || code} payment methods yet` }),
      ...names.map((n) => el("option", { value: n, text: n })));
    sel.value = names.includes(value) ? value : "";
  }
  const remCatName = () => ($("rem-cat").value ? $("rem-cat").value.split("|").slice(1).join("|") : "");
  function remCatHint() {
    const h = $("rem-cat-hint"), code = R.ctx.currency, name = R.ctx.wantCat;
    let msg = "";
    if (!expenseCats(code).length) msg = `You have no ${SYM[code] || code} expense categories yet: add one on the Add screen.`;
    else if (!$("rem-cat").value && name) msg = `“${name}” isn't in your ${SYM[code] || code} list: pick a ${SYM[code] || code} category.`;
    h.textContent = msg; h.hidden = !msg;
  }
  $("rem-cat").addEventListener("change", () => {
    const v = $("rem-cat").value;
    R.ctx.wantCat = null;
    if (v) { const code = v.split("|")[0]; if (code !== R.ctx.currency) setRemCur(code, { keepCat: true }); }
    remCatHint(); $("rem-err").hidden = true;
  });
  function setRemCur(code, { keepCat = false } = {}) {
    const prev = R.ctx.currency;
    R.ctx.currency = code;
    if (!keepCat) {
      const name = remCatName() || R.ctx.wantCat;
      const target = name && expenseCats(code).find((n) => n.toLowerCase() === name.toLowerCase());
      $("rem-cat").value = target ? `${code}|${target}` : "";
      R.ctx.wantCat = target ? null : name || null;
    }
    // payment method: same name in the new currency, else the one last used for that currency
    const pmWas = $("rem-pm").value;
    const pmSame = pmWas && payMethods(code).find((n) => n.toLowerCase() === pmWas.toLowerCase());
    fillPmSelect($("rem-pm"), code, pmSame || (prev !== code || !R.ctx.id ? S.bankByCur[code] : pmWas) || "");
    remCatHint();
    for (const b of $("rem-cur").children) b.setAttribute("aria-checked", String(b.dataset.v === code));
    $("rem-sym").textContent = SYM[code] || code;
    $("rem-amount").placeholder = decimals(code) ? "0.00" : "0";
    $("rem-amount").setAttribute("inputmode", decimals(code) ? "decimal" : "numeric");
    formatInput($("rem-amount"), code);
  }
  function nextHour() {
    const d = new Date(Date.now() + 3600000);
    return { date: dayKey(d), time: `${pad2(d.getHours())}:00` };
  }
  function openReminder(r) {
    R.ctx = { id: r?.id ?? null, original: r ?? null, currency: r?.currency ?? S.currency, requestId: uuid() };
    const nh = nextHour();
    $("rem-h").textContent = r ? (r.isCompleted ? "Completed reminder" : "Edit reminder") : "New reminder";
    $("rem-title").value = r?.title ?? "";
    fillCatSelect($("rem-cat"), { value: r?.category ? `${r.currency}|${r.category}` : "" });
    fillPmSelect($("rem-pm"), R.ctx.currency, r ? r.paymentMethod ?? "" : S.bankByCur[R.ctx.currency] ?? "");
    $("rem-cur").replaceChildren(...curOrder().map((code) => el("button", {
      type: "button", role: "radio", "data-v": code, text: SYM[code] || code, onclick: () => setRemCur(code) })));
    $("rem-amount").value = r?.amount != null ? groupDigits(Number(r.amount).toFixed(decimals(r.currency)), r.currency) : "";
    setRemCur(R.ctx.currency, { keepCat: true });
    if (r) $("rem-pm").value = payMethods(r.currency).includes(r.paymentMethod) ? r.paymentMethod : "";
    $("rem-date").value = r?.date ?? nh.date;
    $("rem-time").value = r?.time ?? nh.time;
    $("rem-repeat").value = r?.repeat ?? "Once";
    $("rem-before").value = r?.remindBefore ?? "At scheduled time";
    $("rem-notes").value = r?.notes ?? "";
    $("rem-push").checked = r ? !!r.pushEnabled : true;
    renderPushHint();
    $("rem-err").hidden = true;
    $("rem-save").disabled = false;
    $("rem-complete").hidden = !r || r.isCompleted;
    const rm = $("rem-remove");
    rm.hidden = !r; rm.classList.remove("confirm"); rm.dataset.armed = "";
    rm.textContent = r && r.repeat !== "Once" && !r.isCompleted ? "Delete reminder (stops repeating)" : "Delete reminder";
    $("rem-dlg").showModal();
    if (!r) setTimeout(() => $("rem-title").focus(), 50);
  }
  async function openReminderById(id) {
    showTab("reminders");
    const r = [...R.list, ...R.completed].find((x) => String(x.id) === String(id));
    if (r) return openReminder(r);
    try { openReminder((await api("GET", `/reminders/${encodeURIComponent(id)}`)).reminder); }
    catch (e) { toast(e instanceof ApiError && e.status === 404 ? "That reminder was deleted." : "Couldn't open the reminder: " + e.message, { bad: true }); }
  }
  $("rem-amount").addEventListener("input", () => formatInput($("rem-amount"), R.ctx?.currency || "MYR"));
  function remError(err) {
    let msg = err.message;
    if (err instanceof ApiError && err.status === 404 && /Route/.test(msg)) msg = "Your server needs this update first: run scripts\\deploy.ps1 on your laptop.";
    else if (err.body?.error?.fields) msg = Object.entries(err.body.error.fields).map(([k, v]) => `${k} ${v}`).join(", ");
    $("rem-err").textContent = msg; $("rem-err").hidden = false;
  }
  $("rem-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") { R.ctx = null; return; }
    e.preventDefault();
    const title = $("rem-title").value.replace(/\s+/g, " ").trim();
    const amount = plain($("rem-amount").value);
    const err = (m, focus) => { $("rem-err").textContent = m; $("rem-err").hidden = false; if (focus) $(focus).focus(); };
    if (!title) return err("Enter a title.", "rem-title");
    if (!$("rem-cat").value) return err("Choose a category.", "rem-cat");
    if (amount !== "" && !(Number(amount) > 0)) return err("Enter an amount above zero, or leave it empty.", "rem-amount");
    if (!$("rem-date").value) return err("Pick a date.", "rem-date");
    if (!/^\d{2}:\d{2}/.test($("rem-time").value)) return err("Pick a time.", "rem-time");
    const body = {
      title, category: remCatName(), paymentMethod: $("rem-pm").value || null,
      amount: amount === "" ? null : amount, currency: R.ctx.currency,
      date: $("rem-date").value, time: $("rem-time").value.slice(0, 5), repeat: $("rem-repeat").value,
      remindBefore: $("rem-before").value, notes: $("rem-notes").value.trim() || null,
      pushEnabled: $("rem-push").checked, timeZone: TZ,
    };
    // Turning on alerts for the first time on this device: the permission prompt must come from this tap.
    let pushNote = "";
    if (body.pushEnabled && !P.sub && pushEnv().ok) {
      try { await enablePush(); } catch (x) { pushNote = " " + x.message; }
    }
    $("rem-save").disabled = true;
    try {
      const r = R.ctx.id ? await api("PATCH", `/reminders/${R.ctx.id}`, body)
                         : await api("POST", "/reminders", { request_id: R.ctx.requestId, ...body });
      $("rem-dlg").close();
      const env = pushEnv();
      if (body.pushEnabled && !pushNote && !P.sub) pushNote = env.ok ? " Turn on notifications in Reminders to get the alert." : " " + env.msg;
      toast((R.ctx.id ? "Reminder saved." : "Reminder added.") + pushNote, { ms: pushNote ? 8000 : 4000 });
      R.ctx = null;
      upsertLocal(r.reminder);
      loadReminders(true);
    } catch (x) { remError(x); $("rem-save").disabled = false; }
  });
  function upsertLocal(r) {
    R.list = R.list.filter((x) => x.id !== r.id); R.completed = R.completed.filter((x) => x.id !== r.id);
    (r.isCompleted ? R.completed : R.list).push(r);
    renderReminderViews();
  }
  $("rem-remove").addEventListener("click", async () => {
    const rm = $("rem-remove");
    if (!rm.dataset.armed) { rm.dataset.armed = "1"; rm.classList.add("confirm"); rm.textContent = "Tap again to delete"; return; }
    const id = R.ctx.id;
    try {
      await api("DELETE", `/reminders/${id}`);
    } catch (x) { if (!(x instanceof ApiError && x.status === 404)) return remError(x); }
    $("rem-dlg").close(); R.ctx = null;
    R.list = R.list.filter((x) => x.id !== id); R.completed = R.completed.filter((x) => x.id !== id);
    renderReminderViews(); toast("Reminder deleted."); loadReminders(true);
  });
  $("rem-complete").addEventListener("click", () => { const r = R.ctx?.original; $("rem-dlg").close(); R.ctx = null; if (r) askComplete(r); });

  // ---------- complete: "Mark as Paid / Done?" ----------
  // "Mark Complete & Create Expense" logs the expense straight from the reminder (server side, in the same
  // database transaction as completing it). If the reminder has no amount, category or payment method yet,
  // the dialog asks for just those first; they are saved to the reminder (and its next instance) too.
  let doneCtx = null;
  const missingFor = (r) => ({ amount: r.amount === null || r.amount === undefined || r.amount === "", category: !r.category, paymentMethod: !r.paymentMethod });
  function askComplete(r) {
    doneCtx = { r, filling: false };
    const amt = remAmount(r);
    $("done-what").textContent = `${r.title}${amt ? ` · ${amt}` : ""} · ${schedText(r)}`;
    $("done-next").hidden = r.repeat === "Once";
    $("done-next").textContent = `Repeats ${r.repeat.toLowerCase()}: the next reminder is scheduled automatically.`;
    $("done-err").hidden = true;
    $("done-fill").hidden = true;
    $("done-expense").textContent = "Mark Complete & Create Expense";
    $("done-expense").className = "ghost strong"; $("done-only").hidden = false;
    const miss = missingFor(r);
    $("done-log").textContent = r.transactionId ? "The expense for this reminder is already logged."
      : (miss.amount || miss.category || miss.paymentMethod) ? "Logs an expense from this reminder; you'll be asked for the missing details."
      : `Logs ${amt} · ${r.category} · ${r.paymentMethod}, dated today.`;
    for (const id of ["done-only", "done-expense"]) $(id).disabled = false;
    $("done-dlg").showModal();
  }
  function showFill(r, fields) {
    doneCtx.filling = true;
    const code = r.currency;
    $("done-amt-wrap").hidden = !fields.amount;
    $("done-cat-wrap").hidden = !fields.category;
    $("done-pm-wrap").hidden = !fields.paymentMethod;
    $("done-sym").textContent = SYM[code] || code;
    $("done-amount").value = "";
    $("done-amount").setAttribute("inputmode", decimals(code) ? "decimal" : "numeric");
    $("done-amount").placeholder = decimals(code) ? "0.00" : "0";
    fillCatSelect($("done-cat"), { only: code });
    fillPmSelect($("done-pm"), code, S.bankByCur[code] ?? "", "Choose a payment method");
    $("done-fill").hidden = false;
    $("done-expense").textContent = "Log expense & complete";
    $("done-expense").className = "primary"; $("done-only").hidden = true;   // one clear next step while filling in
    $("done-log").textContent = "";
    const first = fields.amount ? "done-amount" : fields.category ? "done-cat" : "done-pm";
    setTimeout(() => $(first).focus(), 50);
  }
  $("done-amount").addEventListener("input", () => formatInput($("done-amount"), doneCtx?.r.currency || "MYR"));
  $("done-form").addEventListener("submit", async (e) => {
    const how = e.submitter?.value;
    if (how !== "done" && how !== "expense") { doneCtx = null; return; }
    e.preventDefault();
    const r = doneCtx.r;
    const fail = (m) => { $("done-err").textContent = m; $("done-err").hidden = false; };
    $("done-err").hidden = true;
    let body;
    if (how === "expense") {
      const miss = missingFor(r);
      if (!r.transactionId && !doneCtx.filling && (miss.amount || miss.category || miss.paymentMethod)) return showFill(r, miss);
      body = { createExpense: true, date: todayLocal() };
      if (doneCtx.filling) {
        if (!$("done-amt-wrap").hidden) {
          const a = plain($("done-amount").value);
          if (!(Number(a) > 0)) { $("done-amount").focus(); return fail("Enter the amount you paid."); }
          body.amount = a;
        }
        if (!$("done-cat-wrap").hidden) {
          if (!$("done-cat").value) { $("done-cat").focus(); return fail("Choose a category."); }
          body.category = $("done-cat").value.split("|").slice(1).join("|");
        }
        if (!$("done-pm-wrap").hidden) {
          if (!$("done-pm").value) { $("done-pm").focus(); return fail("Choose a payment method."); }
          body.paymentMethod = $("done-pm").value;
        }
      }
    }
    for (const id of ["done-only", "done-expense"]) $(id).disabled = true;
    try {
      const res = await api("POST", `/reminders/${r.id}/complete`, body);
      $("done-dlg").close(); doneCtx = null;
      upsertLocal(res.reminder);
      if (res.next) upsertLocal(res.next);
      const next = res.next ? ` Next: ${schedText(res.next)}.` : "";
      if (how === "expense" && res.transaction) {
        const t = res.transaction;
        if (body.paymentMethod) { S.bankByCur[t.currency] = t.which_bank; store.set("bankByCur", S.bankByCur); }
        S.lastSavedId = res.expense_logged ? t.transaction_id : null;
        toast(`${res.expense_logged ? "Logged" : "Already logged"} ${remAmount({ amount: t.amount, currency: t.currency })} · ${t.item} · ${t.which_bank}.${next}`,
              { undo: res.expense_logged, ms: 7000 });
        loadRecent();
        if (!$("dash").hidden) loadDash(true);
      } else toast(`Marked complete.${next}`);
      loadReminders(true);
    } catch (x) {
      for (const id of ["done-only", "done-expense"]) $(id).disabled = false;
      if (x instanceof ApiError && x.status === 404 && x.body?.error?.code === "not_found" && !/Route/.test(x.message)) {
        $("done-dlg").close(); toast("That reminder was deleted."); loadReminders(true); return;
      }
      if (x instanceof ApiError && x.body?.error?.code === "expense_details_missing") {   // stale copy: ask for what the server says
        const f = x.body.error.fields || {};
        showFill(r, { amount: !!f.amount, category: !!f.category, paymentMethod: !!f.paymentMethod });
        return fail("Add the missing details to log the expense.");
      }
      fail("Couldn't complete it: " + (x.body?.error?.message || x.message));
    }
  });
  async function reopenReminder(r) {
    try { const res = await api("POST", `/reminders/${r.id}/reopen`); upsertLocal(res.reminder); toast("Reopened."); }
    catch (x) { toast("Couldn't reopen: " + x.message, { bad: true }); }
  }

  // ---------- Web Push: this device ----------
  const P = { reg: null, sub: null };
  function pushEnv() {
    const ua = navigator.userAgent;
    const iOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const standalone = navigator.standalone === true || window.matchMedia?.("(display-mode: standalone)").matches;
    if (!window.isSecureContext) return { ok: false, msg: "Notifications need the app to be opened over https." };
    if (!("serviceWorker" in navigator && "PushManager" in window && "Notification" in window)) {
      if (iOS && !standalone) return { ok: false, msg: "On iPhone, notifications work in the Home Screen app: tap Share, then Add to Home Screen, and open Ledger from there (iOS 16.4 or later)." };
      if (iOS) return { ok: false, msg: "This iOS version can't show web notifications. Update to iOS 16.4 or later." };
      return { ok: false, msg: "This browser doesn't support push notifications. Reminders still show here." };
    }
    if (!S.meta?.push?.available) return { ok: false, msg: "The server isn't set up for notifications yet: run scripts\\deploy.ps1 on your laptop." };
    if (Notification.permission === "denied") {
      return { ok: false, denied: true, msg: iOS ? "Notifications are blocked. Allow them in iPhone Settings › Notifications › Ledger."
                                                 : "Notifications are blocked for this site. Allow them in the browser's site settings." };
    }
    return { ok: true };
  }
  const keyBytes = (b64) => { const s = atob(b64.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((b64.length + 3) % 4)); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
  function sameKey(sub, key) {
    const k = sub?.options?.applicationServerKey;
    if (!k || !key) return true;
    const a = new Uint8Array(k), b = keyBytes(key);
    return a.length === b.length && a.every((x, i) => x === b[i]);
  }
  async function enablePush() {
    const env = pushEnv();
    if (!env.ok) throw new Error(env.msg);
    // requested first, straight from the tap (iOS only shows the prompt for a user gesture)
    const perm = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (perm !== "granted") throw new Error(pushEnv().msg || "Notifications weren't allowed.");
    const reg = P.reg || await navigator.serviceWorker.ready;
    const key = S.meta.push.vapid_public_key;
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub, key)) { await sub.unsubscribe(); sub = null; }
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(key) });
    await api("POST", "/push/subscriptions", sub.toJSON());
    P.sub = sub;
    renderNotif();
  }
  async function disablePush() {
    const sub = P.sub;
    P.sub = null;
    if (sub) {
      try { await api("DELETE", "/push/subscriptions", { endpoint: sub.endpoint }); } catch { /* server copy expires on its own */ }
      try { await sub.unsubscribe(); } catch { /* already gone */ }
    }
    renderNotif();
  }
  function renderNotif() {
    const env = pushEnv(), on = !!P.sub && "Notification" in window && Notification.permission === "granted";
    const sw = $("notif-switch");
    sw.checked = on; sw.disabled = !on && !env.ok;
    $("notif-msg").textContent = on ? "On. Reminder alerts arrive even when Ledger is closed."
      : env.ok ? "Off. Turn on to get reminder alerts on this device." : env.msg;
    $("notif-card").classList.toggle("warn", !on && !env.ok);
    $("notif-test").hidden = !on;
    if ($("rem-dlg").open) renderPushHint();
  }
  function renderPushHint() {
    const h = $("rem-push-hint"), env = pushEnv();
    let msg = "";
    if ($("rem-push").checked && !P.sub) msg = env.ok ? "Notifications aren't on for this device yet: you'll be asked to allow them when you save." : env.msg;
    h.textContent = msg; h.hidden = !msg;
  }
  $("rem-push").addEventListener("change", renderPushHint);
  for (const id of ["rem-title", "rem-amount", "rem-date", "rem-time"]) $(id).addEventListener("input", () => { $("rem-err").hidden = true; });
  $("notif-switch").addEventListener("change", async () => {
    const sw = $("notif-switch");
    sw.disabled = true;
    try {
      if (sw.checked) { await enablePush(); toast("Notifications are on for this device."); }
      else { await disablePush(); toast("Notifications are off for this device."); }
    } catch (x) {
      toast(x.message, { bad: true, ms: 8000 });
    } finally { renderNotif(); }
  });
  $("notif-test").addEventListener("click", async () => {
    try { const r = await api("POST", "/push/test", { endpoint: P.sub?.endpoint }); toast(r.message); }
    catch (x) {
      if (x instanceof ApiError && x.status === 404 && x.body?.error?.code === "no_devices") {   // server dropped it: register again
        try { await api("POST", "/push/subscriptions", P.sub.toJSON()); toast("Re-registered this device. Try the test again."); } catch (y) { toast(y.message, { bad: true }); }
      } else toast("Test failed: " + x.message, { bad: true, ms: 7000 });
    }
  });
  async function initPush() {
    if ("serviceWorker" in navigator && window.isSecureContext) {
      try { P.reg = await navigator.serviceWorker.register("sw.js", { scope: "./" }); } catch { /* unsupported (e.g. private mode) */ }
      try { P.sub = P.reg?.pushManager ? await P.reg.pushManager.getSubscription() : null; } catch { P.sub = null; }
      navigator.serviceWorker.addEventListener("message", (e) => {
        if (e.data?.type === "flush-queue") flushQueue();   // sw.js: Background Sync fired (connection is back)
        if (e.data?.type === "open-reminder") {
          if (e.data.id != null) openReminderById(e.data.id); else showTab("reminders");
        }
      });
      // keep the server's device list in step with this browser (it drops expired subscriptions)
      if (P.sub && Notification.permission === "granted" && S.meta?.push?.available) {
        if (!sameKey(P.sub, S.meta.push.vapid_public_key)) {
          try { await P.sub.unsubscribe(); } catch { /* */ }
          P.sub = null;
          try { await enablePush(); } catch { /* user can turn it on again */ }
        } else api("POST", "/push/subscriptions", P.sub.toJSON()).catch(() => {});
      }
    }
    renderNotif();
  }

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
    const params = new URLSearchParams(location.search);
    const want = params.get("tab");
    const tab = ["dash", "assets", "reminders"].includes(want) ? want : "add";
    if (/^\d+$/.test(params.get("reminder") || "")) R.pendingOpen = params.get("reminder");   // opened from a notification
    showTab(tab);
    if (tab !== "reminders" && tab !== "dash") loadReminders(true);   // tab badge
    initPush();
    if (tab === "add") setTimeout(() => $("amount").focus(), 50);
    flushQueue().finally(loadRecent);
    loadFormAssets();
  }
  window.addEventListener("online", flushQueue);
  // relative times ("Tomorrow", "Overdue") stay current while a reminder list is on screen (display only;
  // notifications are scheduled by the server)
  setInterval(() => {
    if (document.visibilityState === "visible" && (!$("reminders").hidden || !$("dash").hidden)) renderReminderViews();
  }, 30000);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    flushQueue();
    if (!$("dash").hidden) loadDash(true);
    if (!$("assets").hidden) loadAssets(true);
    if (!$("reminders").hidden) loadReminders(true);
    else renderReminderViews();
    renderNotif();
  });
  if (!S.key || !S.api) showSetup(); else start();
})();
