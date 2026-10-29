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
    for (const t of ["add", "dash"]) $(t).hidden = t !== tab;
    for (const b of document.querySelectorAll("#tabs button")) b.setAttribute("aria-current", b.dataset.tab === tab ? "page" : "false");
    clearInterval(S.dashTimer);
    if (tab === "dash") {
      loadDash();
      // Poll while the dashboard is open and visible: near-real-time on the phone.
      S.dashTimer = setInterval(() => { if (document.visibilityState === "visible") loadDash(true); }, 15000);
    }
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
    $("setup").hidden = false; $("add").hidden = true; $("dash").hidden = true; $("tabs").hidden = true;
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
  function catsForType() {
    return S.meta.categories.filter((c) => c.kind === S.type || c.kind === "both").map((c) => c.name);
  }
  function renderType() {
    document.body.classList.toggle("is-income", S.type === "income");
    for (const b of document.querySelectorAll('#add .seg button[data-type]')) b.setAttribute("aria-checked", String(b.dataset.type === S.type));
    $("save").textContent = S.type === "income" ? "Save income" : "Save expense";
    const cats = catsForType();
    if (!cats.includes(S.category)) S.category = store.get("cat." + S.type, cats[0]);
    if (!cats.includes(S.category)) S.category = cats[0] ?? null;
    renderPickList($("cat-chips"), cats, S.category, {
      editing: S.editCats,
      onPick: (c) => { S.category = c; store.set("cat." + S.type, c); $("form-err").hidden = true; },
      onEdit: (c) => openItem("cat", c),
      onAdd: () => openItem("cat", null),
      addLabel: "Add category",
    });
    const hint = $("cat-hint");
    hint.hidden = cats.length > 0 && !S.editCats;
    hint.textContent = S.editCats ? "Tap a category to rename it, change its type or remove it."
      : `Tap + to add your first ${S.type} category.`;
    $("cat-edit").hidden = S.meta.categories.length === 0;
  }
  function renderBanks() {
    const banks = S.meta.banks;
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
      : "Tap + to add a payment method, e.g. Cash, KakaoBank, Maybank card.";
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
    for (const c of S.meta.currencies) {
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
    const isCat = list === "cat";
    const existing = isCat && name ? S.meta.categories.find((c) => c.name === name) : null;
    itemCtx = { list, original: name, kind: existing ? existing.kind : S.type };
    $("item-title").textContent = (name ? "Edit " : "New ") + (isCat ? "category" : "payment method");
    $("item-name").value = name || "";
    $("item-name").placeholder = isCat ? (S.type === "income" ? "e.g. Allowance" : "e.g. Food") : "e.g. Cash, KakaoBank";
    $("item-kind-wrap").hidden = !isCat;
    if (isCat) setItemKind(itemCtx.kind);
    itemCtx.budgets = existing?.budgets || {};
    $("item-budgets").replaceChildren(...S.meta.currencies.map((c) => {
      const cur = existing?.budgets?.[c.code];
      const input = el("input", { id: `item-budget-${c.code}`, inputmode: c.minor_units ? "decimal" : "numeric",
        placeholder: "No budget", autocomplete: "off", "aria-label": `Monthly budget in ${c.code}` });
      if (cur !== undefined && cur !== null) input.value = String(Number(cur));
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
    if (list === "cat" && S.editCats && S.meta.categories.length === 0) toggleEdit("cat");
    if (list === "bank" && S.editBanks && S.meta.banks.length === 0) toggleEdit("bank");
    if (list === "cat") {
      if (selectName && catsForType().includes(selectName)) { S.category = selectName; store.set("cat." + S.type, selectName); }
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
    const { list, original, kind } = itemCtx;
    const path = list === "cat" ? "/categories" : "/payment-methods";
    $("item-save").disabled = true;
    try {
      let r = null;
      const existing = list === "cat" && original ? S.meta.categories.find((c) => c.name === original) : null;
      const catChanged = !original || name !== original || (list === "cat" && existing && existing.kind !== kind);
      if (!original) r = await api("POST", path, list === "cat" ? { name, kind } : { name });
      else if (list === "cat" && catChanged) r = await api("PATCH", path, { name: original, ...(name !== original ? { new_name: name } : {}), kind });
      else if (list === "bank" && name !== original) r = await api("PATCH", path, { name: original, new_name: name });
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
    const { list, original } = itemCtx;
    try {
      const r = await api("DELETE", list === "cat" ? "/categories" : "/payment-methods", { name: original });
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
      amount: $("amount").value.trim(),
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
    if (!body.amount || !(Number(body.amount.replace(/,/g, "")) > 0)) {
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
      toast(r.message, { undo: !r.duplicate, ms: 6000 });
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
    $("amount").value = ""; $("item").value = ""; $("notes").value = ""; $("date").value = todayLocal();
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

    // by category: bars show % of the category budget where there is one, otherwise share of the biggest spend
    const maxC = Math.max(1, ...s.by_category.map((c) => Number(c.amount)));
    const fill = (pct) => { const i = document.createElement("i"); i.style.width = Math.min(100, Math.max(0, pct)).toFixed(1) + "%"; return i; };
    $("ch-cat").replaceChildren(s.by_category.length
      ? el("div", { class: "bars" }, ...s.by_category.map((c) => {
          const hasB = c.budget !== null && c.budget !== undefined;
          const sub = !hasB ? null : c.over
            ? `${f(-Number(c.remaining))} over ${f(c.budget)} budget`
            : `${f(c.remaining)} left of ${f(c.budget)}`;
          return el("div", { class: "bar-row" + (hasB && c.over ? " over" : "") },
            el("span", { class: "cat-name" }, el("span", { text: c.category }), ...(sub ? [el("span", { class: "cat-sub", text: sub })] : [])),
            el("span", { class: "bar-track" + (hasB ? " has-budget" : ""), title: hasB ? `${Number(c.used_pct).toFixed(0)}% of budget used` : "" },
              fill(hasB ? Number(c.used_pct) : Number(c.amount) / maxC * 100)),
            el("span", { class: "num", text: f(c.amount) }));
        }))
      : el("p", { class: "muted small", text: "No spending this month yet." }));
    $("cat-note").hidden = !s.by_category.some((c) => c.budget !== null && c.budget !== undefined);

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
    $("budget-dlg").showModal();
  });
  $("budget-form").addEventListener("submit", async (e) => {
    if (e.submitter?.value !== "save") return;
    e.preventDefault();
    try {
      await api("PUT", "/budget", {
        currency: S.dashCurrency, amount: $("budget-amt").value.trim(),
        ...($("budget-only-month").checked ? { month: $("month").value } : {}),
      });
      $("budget-dlg").close(); toast("Budget saved."); loadDash();
    } catch (err) { $("budget-err").textContent = err.message; $("budget-err").hidden = false; }
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
    const tab = new URLSearchParams(location.search).get("tab") === "dash" ? "dash" : "add";
    showTab(tab);
    if (tab === "add") setTimeout(() => $("amount").focus(), 50);
    loadRecent(); flushQueue();
  }
  window.addEventListener("online", flushQueue);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    flushQueue();
    if (!$("dash").hidden) loadDash(true);
  });
  if (!S.key || !S.api) showSetup(); else start();
})();
