// Ledger budget widget for the free iOS app "Scriptable".
// Home Screen: small / medium.  Lock Screen: rectangular / circular / inline.
// Widget parameter (long-press widget → Edit Widget → Parameter): MYR or KRW (default MYR).
// Medium widget shows both currencies.
// The API key is asked once and stored in the iOS Keychain (never in this file).

const API = "https://themifjtlrkwytebkkig.supabase.co/functions/v1/expense-api";
const WEB = "https://shafishahrir44-code.github.io/ledger/";
const KEY_NAME = "ledger_api_key";
const SYM = { MYR: "RM ", KRW: "₩" };

const C = {
  bg: Color.dynamic(new Color("#ffffff"), new Color("#1a2129")),
  ink: Color.dynamic(new Color("#16202a"), new Color("#e8edf2")),
  ink2: Color.dynamic(new Color("#536170"), new Color("#93a1b0")),
  exp: Color.dynamic(new Color("#2944c9"), new Color("#8ea3ff")),
  track: Color.dynamic(new Color("#dfe5fb"), new Color("#252f57")),
  inc: Color.dynamic(new Color("#0b7a63"), new Color("#4fd1ad")),
  over: Color.dynamic(new Color("#c0263a"), new Color("#ff7085")),
};

async function getKey() {
  if (Keychain.contains(KEY_NAME)) return Keychain.get(KEY_NAME);
  if (config.runsInWidget) return null;
  const a = new Alert();
  a.title = "Ledger API key";
  a.message = "Paste the API key from secrets\\values.txt. It is stored in the iPhone Keychain.";
  a.addSecureTextField("API key", "");
  a.addAction("Save");
  a.addCancelAction("Cancel");
  if ((await a.present()) === -1) return null;
  const k = a.textFieldValue(0).trim();
  if (k) Keychain.set(KEY_NAME, k);
  return k || null;
}

async function summary(key, cur) {
  const r = new Request(`${API}/summary?currency=${cur}`);
  r.headers = { "x-api-key": key };
  r.timeoutInterval = 15;
  const j = await r.loadJSON();
  if (r.response.statusCode === 401) throw new Error("API key rejected - run the script in the app to re-enter it");
  if (!j.ok) throw new Error(j.error ? j.error.message : "API error");
  return j;
}

function money(v, cur) {
  if (v === null || v === undefined) return "—";
  const n = Math.abs(Number(v));
  const d = cur === "KRW" ? 0 : 2;
  const s = n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
  return (Number(v) < 0 ? "−" : "") + (SYM[cur] || cur + " ") + s;
}
function compact(v, cur) {
  const n = Math.abs(Number(v));
  const trim = (x) => x.replace(/\.0$/, "");
  if (cur === "KRW" && n >= 10000) return "₩" + trim((n / 10000).toFixed(n >= 1e6 ? 0 : 1)) + "만";
  if (cur === "MYR" && n >= 10000) return "RM" + trim((n / 1000).toFixed(1)) + "k";
  return money(v, cur);
}

function bar(pct, w, h, over) {
  const dc = new DrawContext();
  dc.size = new Size(w, h);
  dc.opaque = false;
  dc.respectScreenScale = true;
  const r = h / 2;
  const track = new Path();
  track.addRoundedRect(new Rect(0, 0, w, h), r, r);
  dc.addPath(track);
  dc.setFillColor(over ? new Color("#f8dde1") : new Color("#dfe5fb"));
  dc.fillPath();
  const fw = Math.max(h, Math.min(1, pct / 100) * w);
  if (pct > 0) {
    const fill = new Path();
    fill.addRoundedRect(new Rect(0, 0, fw, h), r, r);
    dc.addPath(fill);
    dc.setFillColor(over ? new Color("#c0263a") : new Color("#2944c9"));
    dc.fillPath();
  }
  return dc.getImage();
}

function addCurrencyBlock(stack, s, compactMode) {
  const k = s.kpi, cur = s.currency, hasBudget = k.monthly_budget !== null;
  const t = stack.addText(compactMode ? `${cur} budget` : `${cur} · ${s.month}`);
  t.font = Font.mediumSystemFont(11); t.textColor = C.ink2;
  stack.addSpacer(2);
  const big = stack.addText(hasBudget ? money(Math.abs(k.remaining_budget), cur) : money(k.total_expenses, cur));
  big.font = Font.boldRoundedSystemFont(compactMode ? 20 : 22);
  big.textColor = !hasBudget ? C.ink : (k.over_budget ? C.over : C.inc);
  big.minimumScaleFactor = 0.5; big.lineLimit = 1;
  const sub = stack.addText(!hasBudget ? "spent · no budget set" : (k.over_budget ? "over budget" : "left this month"));
  sub.font = Font.systemFont(11); sub.textColor = C.ink2;
  if (hasBudget) {
    stack.addSpacer(6);
    stack.addImage(bar(Number(k.budget_used_pct), 130, 8, k.over_budget)).imageSize = new Size(130, 8);
    stack.addSpacer(4);
    const u = stack.addText(`${Number(k.budget_used_pct).toFixed(0)}% of ${compact(k.monthly_budget, cur)}`);
    u.font = Font.mediumSystemFont(11); u.textColor = k.over_budget ? C.over : C.ink2;
  }
}

async function build() {
  const fam = config.widgetFamily || "medium";
  const param = (args.widgetParameter || "MYR").trim().toUpperCase();
  const w = new ListWidget();
  w.url = WEB + "?tab=dash";
  w.refreshAfterDate = new Date(Date.now() + 15 * 60 * 1000);
  if (!fam.startsWith("accessory")) { w.backgroundColor = C.bg; w.setPadding(14, 14, 14, 14); }

  const key = await getKey();
  if (!key) { const t = w.addText("Open Scriptable and run LedgerWidget to add your API key"); t.font = Font.systemFont(12); return w; }

  try {
    if (fam === "medium" || fam === "large") {
      const [a, b] = await Promise.all([summary(key, "MYR"), summary(key, "KRW")]);
      const row = w.addStack(); row.layoutHorizontally();
      const l = row.addStack(); l.layoutVertically(); addCurrencyBlock(l, a, false);
      row.addSpacer();
      const r = row.addStack(); r.layoutVertically(); addCurrencyBlock(r, b, false);
    } else if (fam === "small") {
      addCurrencyBlock(w, await summary(key, param), true);
    } else {
      const s = await summary(key, param), k = s.kpi, cur = s.currency, has = k.monthly_budget !== null;
      if (fam === "accessoryInline") {
        w.addText(has ? `${compact(Math.abs(k.remaining_budget), cur)} ${k.over_budget ? "over" : "left"} · ${Number(k.budget_used_pct).toFixed(0)}%`
                      : `${compact(k.total_expenses, cur)} spent`);
      } else if (fam === "accessoryCircular") {
        const g = w.addStack(); g.layoutVertically(); g.centerAlignContent();
        const p = g.addText(has ? `${Number(k.budget_used_pct).toFixed(0)}%` : "—"); p.font = Font.boldRoundedSystemFont(16); p.centerAlignText();
        const c = g.addText(cur); c.font = Font.systemFont(10); c.centerAlignText();
      } else { // accessoryRectangular
        const h = w.addText(`${cur} ${has ? (k.over_budget ? "over budget" : "left") : "spent"}`); h.font = Font.mediumSystemFont(12);
        const v = w.addText(has ? money(Math.abs(k.remaining_budget), cur) : money(k.total_expenses, cur)); v.font = Font.boldRoundedSystemFont(18); v.minimumScaleFactor = 0.6;
        if (has) { const u = w.addText(`${Number(k.budget_used_pct).toFixed(0)}% of ${compact(k.monthly_budget, cur)} used`); u.font = Font.systemFont(11); }
      }
    }
    if (!fam.startsWith("accessory")) {
      w.addSpacer();
      const f = new DateFormatter(); f.useShortTimeStyle();
      const u = w.addText("Updated " + f.string(new Date())); u.font = Font.systemFont(9); u.textColor = C.ink2;
    }
  } catch (e) {
    const t = w.addText("Ledger: " + e.message); t.font = Font.systemFont(11); t.textColor = C.over;
  }
  return w;
}

const widget = await build();
if (config.runsInWidget) Script.setWidget(widget);
else await widget.presentMedium();
Script.complete();
