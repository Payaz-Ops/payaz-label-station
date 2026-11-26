import { renderLabel, LABEL_FONT } from "./labels.js";
import { Printer, bluetoothSupported, isNativeApp } from "./printer.js";
import { loadLog, addLogEntry, deleteLogEntry, logRow, exportCsv } from "./log.js";
import { stock as realStock, friendlyError as realFriendly, DAMAGE_REASONS, offSite, onSite, OFF_SITE_REASONS } from "./stock.js";
// (automated tests can swap in a pretend stock app)
const S = window.__STOCK_MOCK__ || realStock;
const friendlyError = (window.__STOCK_MOCK__ && window.__STOCK_MOCK__.friendlyError) || realFriendly;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const printer = new Printer();

// The two label screens. Box types: "pad" = number keypad (with PZ on the end, and RR at the start for RR123456),
// "scan" = barcode scanner/camera (or type it), "text" = on-screen keyboard.
const MODES = {
  order: {
    title: "Order Label", logged: true,
    fields: [
      { k: "order", label: "Payaz Order Number:", ph: "Type the number", type: "pad" },
      { k: "sumup", label: "SumUp Card Reader:", ph: "Scan the reader", type: "scan" },
      { k: "tablet", label: "Tablet Serial Number:", ph: "Scan the tablet", type: "scan" },
    ],
  },
  stock: {
    title: "Stock Label", logged: false,
    fields: [
      { k: "name", label: "Name:", ph: "Tap here, then type the name", type: "text" },
      { k: "location", label: "Location:", ph: "Tap here, then type the location", type: "text" },
      { k: "code", label: "Stock Code:", ph: "Scan or type the code", type: "scan" },
    ],
  },
};
const vals = { order: "", sumup: "", tablet: "", name: "", location: "", code: "" };
let mode = "order", active = null, copies = 1, typing = false, caseMode = "Abc", idleTimer = null;
const fields = () => MODES[mode].fields;
const fieldOf = (k) => fields().find((f) => f.k === k);

// Number boxes: select what's in them when tapped, so typing replaces the 0
document.addEventListener("focusin", (e) => {
  const el = e.target;
  if (!el || el.tagName !== "INPUT" || el.type !== "number") return;
  el.addEventListener("mouseup", (ev) => ev.preventDefault(), { once: true });
  setTimeout(() => { try { if (document.activeElement === el) el.select(); } catch (err) {} }, 0);
});

/* ---------- settings (saved on this tablet) ---------- */
// stockOrient: how stock labels sit on the label: "upright", or landscape turned "right" / "left"
// lockMins: back to "Who's using the tablet?" after this many minutes untouched
const DEFAULTS = { widthMm: 40, heightMm: 30, density: 4, rotate: false, stockCode: "barcode", stockOrient: "upright", lockMins: 5, prodSize: 2 };
let settings = { ...DEFAULTS };
try {
  const saved = JSON.parse(localStorage.getItem("payaz-settings") || "{}");
  // Older versions saved stockLandscape on/off instead of stockOrient
  if (saved.stockOrient === undefined && saved.stockLandscape !== undefined) saved.stockOrient = saved.stockLandscape ? "right" : "upright";
  delete saved.stockLandscape;
  Object.assign(settings, saved);
} catch (e) {}
if (!["upright", "right", "left"].includes(settings.stockOrient)) settings.stockOrient = "upright";
if (![2, 5, 10, 15].includes(settings.lockMins)) settings.lockMins = 5;
if (![1, 2, 3, 4].includes(settings.prodSize)) settings.prodSize = 2; // Production tile size: 1 smallest .. 4 biggest
function saveSettings(change) {
  Object.assign(settings, change);
  settings.widthMm = Math.max(20, Math.min(50, +settings.widthMm));
  settings.heightMm = Math.max(15, Math.min(100, +settings.heightMm));
  settings.density = Math.max(1, Math.min(9, +settings.density));
  try { localStorage.setItem("payaz-settings", JSON.stringify(settings)); } catch (e) {}
  drawSettings();
}

/* ---------- navigation ---------- */
function show(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.toggle("on", s.id === id));
  const locked = id === "who";
  $("#backBtn").style.display = id === "home" || locked ? "none" : "";
  $("#setBtn").style.display = id === "home" ? "" : "none";
  $("#pill").style.display = id === "home" ? "" : "none";
  $("#whoBtn").style.display = S.person && !locked && id !== "addme" ? "" : "none";
  if (S.person) $("#whoName").textContent = S.person.name.split(" ")[0];
}
function home() {
  Object.keys(vals).forEach((k) => (vals[k] = ""));
  copies = 1;
  $("#hdrTitle").textContent = "Label Station";
  show("home");
}
// Order labels: one box filled -> that label on its own; two or three -> one combined label.
function printKind() {
  if (mode === "stock") return "stock";
  const filled = ["order", "sumup", "tablet"].filter((f) => vals[f]);
  return filled.length > 1 ? "all" : filled[0] || active;
}
const canPrint = () => mode === "stock" ? !!(vals.name || vals.code) : ["order", "sumup", "tablet"].some((f) => vals[f]);
function openMode(m) {
  mode = m; copies = 1; typing = false;
  $("#fields").innerHTML = fields().map((f) =>
    `<button class="field" data-f="${f.k}"><div class="lbl">${f.label}</div><div class="val"></div>` +
    (mode === "order" && (f.type === "scan" || f.k === "order") ? `<div class="sstat" data-s="${f.k}"></div>` : "") + `</button>`).join("");
  $("#fields").querySelectorAll(".field").forEach((b) => (b.onclick = () => setActive(b.dataset.f)));
  $("#fields").style.cssText = "display:flex;flex-direction:column;gap:8px";
  setActive(fields()[0].k);
  show("edit"); poke();
}
function setActive(k) {
  active = k; typing = false;
  render();
}

/* ---------- drawing ---------- */
// Under a preview: the code is too long for this label, so its bars are 1 dot wide
function thinWarning(thin) {
  if (!thin) return [];
  const p = document.createElement("div");
  p.className = "thinwarn";
  p.textContent = "Code too long for this label: the barcode lines will be very thin and may smudge together. Use a wider label (50 mm, or 50 × 80 landscape), a shorter code, or QR codes in Settings.";
  return [p];
}
function makeLabel(kind, values) {
  return renderLabel(kind, values, { widthMm: settings.widthMm, heightMm: settings.heightMm, rotate: settings.rotate, stockCode: settings.stockCode,
    landscape: kind === "stock" && settings.stockOrient !== "upright" ? settings.stockOrient : false });
}
let prevTimer;
function render() {
  document.querySelectorAll(".field").forEach((b) => {
    const f = fieldOf(b.dataset.f), v = b.querySelector(".val"), val = vals[f.k];
    b.classList.toggle("active", f.k === active);
    v.textContent = val || f.ph;
    v.classList.toggle("empty", !val);
    if (f.k === "sumup" && val.length > 3)
      v.innerHTML = `<span style="font-weight:500">${esc(val.slice(0, -3))}</span>${esc(val.slice(-3))}`;
    const st = b.querySelector(".sstat");
    if (st && f.k === "order") {
      const p = priorPrints(val)[0];
      st.textContent = p ? `\u26a0 Already printed ${whenText(p.ts)}${p.sumup || p.tablet ? ` (${[p.sumup && `reader ${p.sumup}`, p.tablet && `tablet ${p.tablet}`].filter(Boolean).join(", ")})` : ""}` : "";
      st.className = "sstat" + (p ? " warn" : "");
    } else if (st) {
      const info = val && serialInfo[f.k] && serialInfo[f.k].serial === val ? serialInfo[f.k] : null;
      st.textContent = info ? info.text : "";
      st.className = "sstat" + (info ? " " + info.tone : "");
    }
  });
  const type = fieldOf(active).type;
  $("#keypad").style.display = type === "pad" ? "grid" : "none";
  $("#scan").style.display = type === "scan" && !typing ? "flex" : "none";
  const kbdOn = type === "text" || (type === "scan" && typing);
  $("#kbd").style.display = kbdOn ? "flex" : "none";
  if (kbdOn) buildKbd($("#kbd"), { scanKey: type === "scan" });
  $("#copies").textContent = copies;
  $("#printBtn").disabled = !canPrint();
  $("#hdrTitle").textContent = mode === "stock" ? "Stock Label" : printKind() === "all" ? "Order Label (combined)" : "Order Label";
  clearTimeout(prevTimer);
  prevTimer = setTimeout(() => {
    const { canvas, thinBars } = makeLabel(printKind(), vals);
    $("#preview").replaceChildren(canvas, ...thinWarning(thinBars));
  }, 60);
}

/* ---------- typing ---------- */
const maxLen = (k) => (k === "order" ? 30 : 40);
function press(key) {
  poke();
  const f = fieldOf(active);
  let v = vals[active];
  if (key === "NEXT") { // Next: move down to the next empty box (the card reader after the order number)
    const ks = fields().map((x) => x.k), after = ks.slice(ks.indexOf(active) + 1);
    setActive(after.find((k) => !vals[k]) || after[0] || active);
    return;
  }
  if (key === "DEL") { v = v.slice(0, -1); if (v === "R") v = ""; }
  else if (key === "CASE") { caseMode = nextCase(); render(); return; }
  // RR orders look like RR123456: RR goes at the start (tapping it again takes it
  // off). PZ goes on the end (48374PZ).
  else if (key === "RR") { v = v.startsWith("RR") ? v.slice(2) : "RR" + v.replace(/\D/g, ""); }
  else if (key === "PZ") { if (!v.startsWith("RR")) v = v.replace(/PZ$/, "") + "PZ"; }
  else if (v.length < maxLen(active)) {
    if (active === "order" && /PZ$/.test(v)) return;
    if (key === "SPACE") key = " ";
    if (f.type !== "text") key = key.toUpperCase();
    else if (/^[a-z]$/i.test(key)) key = capsNext(v) ? key.toUpperCase() : key.toLowerCase();
    if (key === " " && (!v || v.endsWith(" "))) return;
    v += key;
  }
  vals[active] = v; render();
}
onKey($("#keypad"), (b) => press(b.dataset.k || b.textContent));

// Letter case for typed names: "Abc" = capital at the start of each word (default),
// "ABC" = all capitals, "abc" = all small.
const nextCase = () => ({ Abc: "ABC", ABC: "abc", abc: "Abc" })[caseMode];
const capsNext = (v) => caseMode === "ABC" || (caseMode === "Abc" && (!v || /[\s\-\/.]$/.test(v)));

// On-screen keyboard (letters, numbers, space and a few symbols)
const ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL-", "ZXCVBNM/."];
/* On-screen keys react the moment they're touched (like a real keyboard), so a tap
   that slides a little or is held a moment still counts. Each touch counts once:
   the click that follows it is ignored, so it can't also press whatever is under
   the finger if the key closed a pop-up. */
let swallowPointer = null;
document.addEventListener("pointerdown", () => { swallowPointer = null; }, true);
document.addEventListener("click", (e) => {
  if (swallowPointer !== null && e.pointerId === swallowPointer) { e.preventDefault(); e.stopPropagation(); swallowPointer = null; }
}, true);
function onKey(el, fn) {
  el.addEventListener("pointerdown", (e) => {
    const b = e.target.closest("button");
    if (!b || !el.contains(b) || b.disabled) return;
    e.preventDefault();
    swallowPointer = e.pointerId;
    b.classList.add("hit"); setTimeout(() => b.classList.remove("hit"), 140);
    fn(b);
  });
}
function buildKbd(el, { scanKey = false, doneKey = false, current = null } = {}) {
  const typed = current !== null ? current : active && fieldOf(active).type === "text" ? vals[active] : "";
  const big = current === null && active && fieldOf(active).type !== "text" ? true : capsNext(typed);
  const shown = (c) => (/[A-Z]/.test(c) && !big ? c.toLowerCase() : c);
  const sig = `${scanKey}|${doneKey}`;
  if (el.dataset.sig === sig) { // same keys: just change capitals / small letters (a key under a finger isn't replaced)
    el.querySelectorAll("[data-c]").forEach((b) => { const t = shown(b.dataset.c); if (b.textContent !== t) b.textContent = t; });
    el.querySelector("[data-k=CASE]").textContent = caseMode;
    return;
  }
  el.dataset.sig = sig;
  el.innerHTML = ROWS.map((r) => `<div class="row">${[...r].map((c) => `<button data-c="${c}">${shown(c)}</button>`).join("")}</div>`).join("") +
    `<div class="row"><button class="wide" data-k="CASE">${caseMode}</button>` +
    `<button style="flex:4" data-k="SPACE">space</button><button class="wide del" data-k="DEL">&#9003;</button>` +
    (scanKey ? `<button class="wide" data-k="SCAN">Scan instead</button>` : "") +
    (doneKey ? `<button class="wide" data-k="DONE" style="background:var(--teal);color:#fff">Done</button>` : "") + `</div>`;
}
onKey($("#kbd"), (b) => {
  if (b.dataset.k === "SCAN") { typing = false; render(); } else press(b.dataset.k || b.dataset.c);
});
$("#typeBtn").onclick = () => { typing = true; render(); };

/* ---------- serial numbers in Payaz Stock ---------- */
// What Payaz Stock knows about the serial in each box: { serial, tone: ok|warn|info, text }
const serialInfo = { sumup: null, tablet: null };
const stockLinked = () => !!(S.user && S.isStaff && S.lookupSerial);
const shortDate = (iso) => (iso ? new Date(iso).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "");
async function checkSerial(k) { // k can change if the unit is moved to its proper box
  const serial = vals[k];
  if (!serial) { serialInfo[k] = null; return; }
  if (!stockLinked()) {
    serialInfo[k] = { serial, tone: "warn", text: "Not signed in to Payaz Stock: this unit won't be recorded" };
    render(); return;
  }
  serialInfo[k] = { serial, tone: "info", text: "Checking Payaz Stock…" };
  render();
  let info;
  try {
    const u = await S.lookupSerial(serial);
    // In the wrong box for its product? Move it (or say so if that box is taken)
    if (u && u.item_id && vals[k] === serial) {
      const right = boxForUnit(u);
      if (right !== k) {
        if (!vals[right]) {
          vals[right] = serial; vals[k] = ""; serialInfo[k] = null; k = right;
          if (active === right || !vals[active]) active = ["sumup", "tablet"].find((f) => !vals[f]) || right;
        } else {
          serialInfo[k] = { serial, tone: "warn", text: `This is a ${u.item_name}: it belongs in the ${right === "sumup" ? "card reader" : "tablet"} box.` };
          render(); return;
        }
      }
    }
    if (!u) info = { tone: "info", text: "Not booked in yet. It will still be recorded on this order (stock count won't change)." };
    else if (u.status === "in_stock") info = { tone: "ok", text: `✓ ${u.item_name}, in stock` };
    else if (u.status === "dispatched") info = vals.order && u.order_number === vals.order
      ? { tone: "ok", text: `✓ Already recorded on this order` }
      : { tone: "warn", text: `Already sent on order ${u.order_number} (${shortDate(u.dispatched_at)}). Check before sending.` };
    else if (u.status === "off_site") info = { tone: "warn", text: `Recorded as off site${u.off_site_place ? ` (${u.off_site_place})` : ""}. A manager must bring it back on site before it's sent.` };
    else info = { tone: "warn", text: `Recorded as ${u.status === "damaged" ? "damaged" : u.status} in Payaz Stock. Check before sending.` };
  } catch (e) {
    info = { tone: "warn", text: "Couldn't check Payaz Stock: " + friendlyError(e) };
  }
  if (vals[k] === serial) { serialInfo[k] = { serial, ...info }; render(); }
}

/** After an Order Label prints: mark each scanned unit as sent on the order.
 *  Returns { problems: [text], done: [text] }. */
async function recordDispatch(values) {
  const boxes = [["sumup", "Card reader"], ["tablet", "Tablet"]].filter(([k]) => values[k]);
  const out = { problems: [], done: [], queued: [] };
  if (!boxes.length) return out;
  if (!values.order) return out; // a serial label on its own, not an order
  if (!stockLinked() || !S.dispatchSerial) {
    out.problems.push("Not signed in to Payaz Stock, so these units weren't marked as sent. Open Stock and sign in, then print again.");
    return out;
  }
  for (const [k, name] of boxes) {
    try {
      if (!navigator.onLine || out.queued.length) throw Object.assign(new Error("No internet"), { code: "unavailable" }); // don't wait for another timeout
      const r = await withTimeout(S.dispatchSerial(values[k], values.order));
      if (r.kind === "dispatched") out.done.push(`${r.unit.item_name || name} ${values[k]} sent on order ${values.order}`);
      else if (r.kind === "same_order") out.done.push(`${name} ${values[k]} was already on this order`);
      else if (r.kind === "not_booked_in") out.done.push(`${name} ${values[k]} recorded on order ${values.order}${r.unit && r.unit.item_id ? ` (${r.unit.item_name})` : ""}. It wasn't booked in, so the stock count hasn't changed.`);
      else if (r.kind === "already_sent") out.problems.push(`${r.unit.item_name || name} ${values[k]} was already sent on order ${r.unit.order_number}. A manager has been told.`);
      else out.problems.push(`${r.unit.item_name || name} ${values[k]} is recorded as ${serialStatusText(r.unit)} in Payaz Stock, so it wasn't marked as sent. ${r.unit.status === "off_site" ? "A manager must bring it back on site first." : "A manager has been told."}`);
    } catch (e) {
      if (isNetworkError(e)) {
        // No internet: keep it and send it when the connection is back
        queueAdd({ serial: values[k], order: values.order, name, personId: S.person && S.person.id });
        out.queued.push(`${name} ${values[k]}`);
      } else out.problems.push(`${name} ${values[k]} wasn't recorded: ${friendlyError(e)}. Tell a manager.`);
    }
  }
  return out;
}

/* ---------- waiting to send (Order Label records made without internet) ---------- */
// Saved on the tablet and sent automatically when the internet is back (checked every
// 30 seconds, when the connection returns, and when someone signs in), under the
// person who printed the label. Sending twice is safe: the second time finds the unit
// already on that order.
const QUEUE_KEY = "payaz-dispatch-queue";
const queueLoad = () => { try { return JSON.parse(localStorage.getItem(QUEUE_KEY)) || []; } catch (e) { return []; } };
const queueSave = (q) => { try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {} drawQueue(); };
function queueAdd(x) {
  const q = queueLoad().filter((y) => !(y.serial === x.serial && y.order === x.order));
  q.push({ ...x, at: new Date().toISOString() }); queueSave(q);
}
const NETWORK_CODES = ["unavailable", "deadline-exceeded", "auth/network-request-failed", "timeout", "aborted", "internal", "resource-exhausted", "locked"];
const isNetworkError = (e) => !navigator.onLine || NETWORK_CODES.includes(e && e.code) || /offline|network|fetch/i.test((e && e.message) || "");
function withTimeout(p, ms = 12000) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error("No answer from Payaz Stock"), { code: "timeout" })), ms))]);
}
let queueBusy = false;
async function queueSend() {
  if (queueBusy || !queueLoad().length || !navigator.onLine) return;
  queueBusy = true;
  try {
    for (const x of queueLoad()) {
      try {
        const r = await withTimeout(S.dispatchSerial(x.serial, x.order, x.personId));
        // Sent (any answer from Payaz Stock counts: problems are flagged to managers there)
        queueSave(queueLoad().filter((y) => !(y.serial === x.serial && y.order === x.order)));
        if (r.kind !== "dispatched" && r.kind !== "same_order" && r.kind !== "not_booked_in")
          queueNote(`${x.name} ${x.serial} (order ${x.order}): ${r.kind === "already_sent" ? `already sent on order ${r.unit.order_number}` : `recorded as ${r.unit.status}`}. Managers have been told.`);
      } catch (e) {
        if (isNetworkError(e)) break; // still no internet: try again later
        queueSave(queueLoad().filter((y) => !(y.serial === x.serial && y.order === x.order)));
        queueNote(`${x.name} ${x.serial} (order ${x.order}) couldn't be recorded: ${friendlyError(e)}. Tell a manager.`);
      }
    }
  } finally { queueBusy = false; drawQueue(); }
}
const queueNotes = [];
function queueNote(t) { queueNotes.push(t); drawQueue(); }
function drawQueue() {
  const n = queueLoad().length, btn = $("#queueBtn");
  btn.style.display = n || queueNotes.length ? "" : "none";
  btn.classList.toggle("bad", !n && queueNotes.length > 0);
  btn.textContent = n ? `\u23f3 ${n} waiting to send` : `\u26a0 ${queueNotes.length} to check`;
}
$("#queueBtn").onclick = async () => {
  const q = queueLoad();
  const list = q.map((x) => `${x.name} ${x.serial} on order ${x.order} (${new Date(x.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })})`);
  overlay(q.length ? `${q.length} waiting to send to Payaz Stock` : "Sent, but check these",
    [...list, ...(q.length ? ["", "They'll be sent automatically when the internet is back. No need to print again."] : []), ...queueNotes].join("\n"),
    !q.length, false, q.length ? { label: "Try now", run: () => queueSend() } : null);
  if (!q.length) queueNotes.length = 0;
  drawQueue();
};
window.addEventListener("online", () => queueSend());
setInterval(queueSend, 30000);
S.watch(() => queueSend());
drawQueue(); setTimeout(queueSend, 3000);

// Put a scanned code in the right box.
const boxFor = (code) => /^\d{10,20}$/.test(code) ? "sumup" : /[A-Z]/.test(code) && /\d/.test(code) && code.length >= 6 ? "tablet" : null;
// Which box a booked-in unit belongs in, from its product in Payaz Stock
function boxForUnit(u) {
  const item = S.items.find((i) => i.id === u.item_id) || {};
  return /sum ?up|card ?reader|reader/i.test(`${u.item_name || ""} ${item.name || ""} ${item.category || ""}`) ? "sumup" : "tablet";
}
function acceptScan(code) {
  code = code.trim().replace(/[^\x20-\x7E]/g, "").slice(0, 40);
  if (!active || code.length < 2) return;
  if (mode === "stock") {
    vals.code = code;
    active = !vals.name ? "name" : !vals.location ? "location" : "code";
  } else {
    code = code.toUpperCase();
    if (code === vals.sumup || code === vals.tablet) { typing = false; render(); return; } // scanned twice
    // Scans go in the right box whichever is selected: SumUp card reader serials are
    // all numbers (e.g. 17 digits), tablet serials have letters. Payaz Stock's record
    // corrects it after the check below if a product doesn't follow that pattern.
    let target = boxFor(code) || active;
    if (target === "order") target = !vals.sumup ? "sumup" : "tablet";
    vals[target] = code;
    active = ["sumup", "tablet"].find((f) => !vals[f]) || target; // next empty scan box
    typing = false; poke(); render();
    checkSerial(target);
    return;
  }
  typing = false; poke(); render();
}

// Barcode scanner (USB or Bluetooth) "types" very fast then presses Enter.
// Slower key presses (a real keyboard) go into the box being edited.
let buf = "", bufTimer = null;
function keyInput(e, { onScan, onType, onDelete }) {
  if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); clearTimeout(bufTimer); if (buf) { const c = buf; buf = ""; onScan(c); } return; }
  if (e.key === "Backspace" && !buf) { onDelete(); return; }
  if (e.key.length === 1) {
    buf += e.key; clearTimeout(bufTimer);
    bufTimer = setTimeout(() => { const c = buf; buf = ""; onType(c); }, 150);
  }
}
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return; // typing in a real text box
  if ($("#typer").classList.contains("on")) return;
  if ($("#locPick").classList.contains("on")) return; // choosing a location
  if ($("#stock").classList.contains("on") && $("#takeMain").style.display !== "none") {
    keyInput(e, { onScan: (c) => takeScan(c.trim()), onType: (c) => { if (c.trim().length >= 4) takeScan(c.trim()); }, onDelete: () => {} });
    return;
  }
  if ($("#stock").classList.contains("on") && $("#stockMain").style.display !== "none" && !$("#sheet").classList.contains("on")) {
    keyInput(e, { onScan: (c) => stockScan(c.trim()), onType: (c) => setStockSearch(stockSearch + c), onDelete: () => setStockSearch(stockSearch.slice(0, -1)) });
    return;
  }
  if ($("#log").classList.contains("on")) {
    keyInput(e, { onScan: (c) => setSearch(c.trim()), onType: (c) => setSearch(search + c), onDelete: () => setSearch(search.slice(0, -1)) });
    return;
  }
  if (!$("#edit").classList.contains("on")) return;
  const type = fieldOf(active).type;
  keyInput(e, {
    onScan: acceptScan,
    onType: (c) => {
      if (type === "scan" && c.length >= 4) return acceptScan(c); // scanner without Enter
      if (type === "scan" && !typing) return;
      for (const ch of c) if (type !== "pad" || /[0-9]/.test(ch)) press(ch === " " ? "SPACE" : ch);
    },
    onDelete: () => press("DEL"),
  });
});

/* ---------- camera scanning ---------- */
let camStream = null, camTimer = null;
const NATIVE = isNativeApp();
const hasCamera = NATIVE || ("BarcodeDetector" in window && navigator.mediaDevices);
if (!hasCamera) $("#camBtn").style.display = "none";

// In the Android app: Google's barcode scanner (ML Kit) opens full screen.
let camCallback = acceptScan;
/** Scan one barcode with the camera and pass it to onCode. */
function scanWithCamera(onCode) { camCallback = onCode; return startCamera(); }
async function nativeCameraScan() {
  const scanner = window.Capacitor.Plugins.BarcodeScanner;
  try {
    const { available } = await scanner.isGoogleBarcodeScannerModuleAvailable();
    if (!available) {
      overlay("Getting the camera scanner ready…", "This only happens once and needs internet.", false, true);
      await scanner.installGoogleBarcodeScannerModule();
      for (let i = 0; i < 60 && !(await scanner.isGoogleBarcodeScannerModuleAvailable()).available; i++) await new Promise((r) => setTimeout(r, 1000));
      hideOverlay();
    }
    const { barcodes } = await scanner.scan({ formats: ["CODE_128", "CODE_39", "CODE_93", "EAN_13", "UPC_A", "QR_CODE", "DATA_MATRIX"] });
    if (barcodes && barcodes.length) camCallback(barcodes[0].rawValue || barcodes[0].displayValue || "");
  } catch (e) {
    if (!/cancel/i.test(e && e.message)) overlay("Camera not available", (e && e.message) || "Use the barcode scanner instead.", true);
  }
}

$("#camBtn").onclick = () => scanWithCamera(acceptScan);
async function startCamera() {
  if (NATIVE) return nativeCameraScan();
  try {
    const detector = new BarcodeDetector({ formats: ["code_128", "code_39", "ean_13", "qr_code", "data_matrix", "upc_a"] });
    camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment", width: { ideal: 1920 } } });
    const video = $("#video");
    video.srcObject = camStream; await video.play();
    $("#camera").classList.add("on");
    const tick = async () => {
      if (!camStream) return;
      try {
        const found = await detector.detect(video);
        if (found.length) { closeCamera(); camCallback(found[0].rawValue); return; }
      } catch (e) {}
      camTimer = setTimeout(tick, 150);
    };
    tick();
  } catch (e) { closeCamera(); overlay("Camera not available", "Allow camera access for this app, or use the barcode scanner.", true); }
}
function closeCamera() {
  clearTimeout(camTimer);
  if (camStream) camStream.getTracks().forEach((t) => t.stop());
  camStream = null; $("#camera").classList.remove("on");
}
$("#camClose").onclick = closeCamera;

/* ---------- printing ---------- */
// Connecting must start straight from a tap (Chrome shows the printer list).
async function connectFromTap() {
  if (!bluetoothSupported()) throw new Error("This browser can't use Bluetooth. Open the app in Google Chrome.");
  if (printer.connected) return;
  if (printer.known && (await printer.findKnown().catch(() => false))) return;
  await printer.choose();
}

// Explain a failed connection, with the most useful next step as a button.
function connectError(e) {
  const msg = e && e.name === "NotFoundError" ? "No printer was chosen." : (e && e.message) || String(e);
  if (e && e.code === "location")
    return overlay("Location is off", msg, true, false, { label: "Open Location settings", run: () => printer.openLocationSettings() });
  overlay("Couldn't connect", msg + " If the printer didn't appear, try showing all Bluetooth devices.", true, false,
    { label: "Show all Bluetooth devices", run: () => chooseFrom(true) });
}
async function chooseFrom(showAll) {
  overlay("Searching for printers…", "", false, true);
  try {
    if (printer.connected) await printer.disconnect();
    await printer.choose(showAll); overlay("Printer connected \u2713", printer.name, false, true); setTimeout(hideOverlay, 1200);
  } catch (e) { connectError(e); }
}

async function doPrint(kind, values, n, log = false) {
  overlay("Connecting…", "", false, true);
  try {
    if (!printer.connected) await connectFromTap();
    const { bitmap } = makeLabel(kind, values);
    await printer.print(bitmap, { copies: n, density: settings.density, onProgress: (m) => overlay(m, "", false, true) });
    if (log) addLogEntry(values);
    overlay("Printed ✓", log ? "Added to the log" : "", false, true);
    return true;
  } catch (err) {
    if (!printer.connected && (err.code === "location" || err.code === "notfound" || err.name === "NotFoundError" || /isn't the label printer/.test(err.message))) connectError(err);
    else overlay("Couldn't print", (err && err.message) || String(err), true);
    return false;
  }
}

// Order labels already printed for an order number (from the Log on this tablet), newest first
function priorPrints(order) {
  const o = String(order || "").trim().toUpperCase();
  return o ? loadLog().filter((e) => String(e.order || "").trim().toUpperCase() === o).sort((a, b) => b.ts.localeCompare(a.ts)) : [];
}
function whenText(ts) {
  const d = new Date(ts), t = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const days = Math.round((new Date().setHours(0, 0, 0, 0) - new Date(ts).setHours(0, 0, 0, 0)) / 86400000);
  return days === 0 ? `today at ${t}` : days === 1 ? `yesterday at ${t}` : `on ${d.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`;
}
$("#printBtn").onclick = () => {
  const prior = mode === "order" ? priorPrints(vals.order) : [];
  if (!prior.length) return printNow();
  const p = prior[0];
  overlay(`Order ${vals.order.trim()} has already been printed`,
    `Printed ${whenText(p.ts)}${prior.length > 1 ? ` (${prior.length} times in all)` : ""}.\nCard reader: ${p.sumup || "none"} \u00b7 Tablet: ${p.tablet || "none"}\n\nOnly print again if the label needs replacing.`,
    true, false, { label: "Print again", run: () => printNow() });
};
async function printNow() {
  const values = mode === "stock"
    ? { name: vals.name, location: vals.location, code: vals.code }
    : { order: vals.order, sumup: vals.sumup, tablet: vals.tablet };
  if (!(await doPrint(printKind(), values, copies, MODES[mode].logged))) return;
  if (mode === "order" && (values.sumup || values.tablet) && values.order) {
    overlay("Printed ✓", "Recording in Payaz Stock…", false, true);
    const r = await recordDispatch(values);
    if (r.queued.length) r.problems.push(`No internet: ${r.queued.join(" and ")} will be recorded in Payaz Stock automatically as soon as it's back. No need to print again.`);
    if (r.problems.length) {
      overlay("Printed, but check this", [...r.problems, ...r.done].join("\n"), true);
      $("#ovBtn").onclick = () => { hideOverlay(); $("#ovBtn").onclick = hideOverlay; home(); };
      return;
    }
    overlay("Printed ✓", r.done.join("\n") || "Added to the log", false, true);
  }
  setTimeout(() => { hideOverlay(); home(); }, 1200);
}
$("#clearBtn").onclick = () => { vals[active] = ""; if (active in serialInfo) serialInfo[active] = null; render(); };
$("#cMinus").onclick = () => { copies = Math.max(1, copies - 1); render(); };
$("#cPlus").onclick = () => { copies = Math.min(20, copies + 1); render(); };

/* ---------- printer status ---------- */
function drawPrinter() {
  const ok = printer.connected;
  $("#pill").textContent = ok ? "Printer connected" : "Connect printer";
  $("#pill").className = "pill " + (ok ? "ok" : "bad");
  const st = $("#pStatus");
  st.textContent = ok ? `✓ Connected to ${printer.name}` : "✗ Not connected";
  st.className = "status " + (ok ? "ok" : "bad");
  $("#connectBtn").textContent = ok ? "Choose a different printer" : "Connect printer";
  $("#disconnectBtn").style.display = ok ? "" : "none";
}
printer.onchange = drawPrinter;
$("#pill").onclick = async () => {
  if (printer.connected) { openSettings(); return; }
  overlay("Connecting…", "", false, true);
  try { await connectFromTap(); hideOverlay(); }
  catch (e) { connectError(e); }
};
$("#connectBtn").onclick = () => chooseFrom(false);
$("#allDevicesBtn").onclick = () => chooseFrom(true);
$("#disconnectBtn").onclick = () => printer.disconnect();
$("#testBtn").onclick = async () => {
  if (await doPrint("all", { order: "12345PZ", sumup: "TEST123", tablet: "TEST456" }, 1)) setTimeout(hideOverlay, 1200);
};
// Reconnect quietly to the printer used last time.
printer.findKnown().catch(() => {}).finally(drawPrinter);
// In the app, also reconnect when it comes back to the front.
document.addEventListener("visibilitychange", () => {
  if (NATIVE && document.visibilityState === "visible" && !printer.connected && printer.known) printer.findKnown().catch(() => {});
});

/* ---------- overlay ---------- */
function overlay(msg, sub, isErr, noBtn, alt) {
  $("#ovMsg").textContent = msg; $("#ovSub").textContent = sub || "";
  $("#ovBox").classList.toggle("err", !!isErr);
  $("#ovBtn").style.display = noBtn ? "none" : ""; $("#overlay").classList.add("on");
  $("#ovBtn").textContent = alt ? alt.closeLabel || "Cancel" : "OK";
  $("#ovAlt").style.display = alt ? "" : "none";
  if (alt) { $("#ovAlt").textContent = alt.label; $("#ovAlt").onclick = () => { hideOverlay(); alt.run(); }; }
}
function hideOverlay() { $("#overlay").classList.remove("on"); }
$("#ovBtn").onclick = hideOverlay;

/* ---------- settings screen ---------- */
const PRESETS = [[40, 30], [40, 40], [40, 60], [50, 30], [50, 50], [50, 80]];
function openSettings() { $("#hdrTitle").textContent = "Settings"; show("settings"); drawSettings(); drawPrinter(); drawPeopleSettings(); }
function drawSettings() {
  $("#wmm").textContent = settings.widthMm + " mm";
  $("#hmm").textContent = settings.heightMm + " mm";
  $("#dens").textContent = settings.density;
  $("#rotVal").textContent = settings.rotate ? "ON" : "OFF";
  document.querySelectorAll("#setOrient [data-so]").forEach((b) => b.classList.toggle("on", b.dataset.so === settings.stockOrient));
  document.querySelectorAll("[data-sc]").forEach((b) => b.classList.toggle("on", b.dataset.sc === settings.stockCode));
  $("#sizeChips").innerHTML = PRESETS.map(([w, h]) =>
    `<button class="chip ${w == settings.widthMm && h == settings.heightMm ? "on" : ""}" data-w="${w}" data-h="${h}">${w} × ${h} mm</button>`).join("");
  // 50 x 80 mm: stock labels print landscape (across the label); other sizes upright
  $("#sizeChips").querySelectorAll("button").forEach((b) => (b.onclick = () => {
    const tall = +b.dataset.w === 50 && +b.dataset.h === 80;
    saveSettings({ widthMm: +b.dataset.w, heightMm: +b.dataset.h, stockOrient: tall ? (settings.stockOrient === "left" ? "left" : "right") : "upright" });
  }));
}
document.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => {
  const [k, d] = b.dataset.d.split(":"); saveSettings({ [k]: +settings[k] + +d });
}));
$("#rotBtn").onclick = () => saveSettings({ rotate: !settings.rotate });
// Stock label orientation: in Settings and on the stock label pop-up
document.querySelectorAll("[data-so]").forEach((b) => (b.onclick = () => {
  saveSettings({ stockOrient: b.dataset.so });
  if ($("#sheet").classList.contains("on")) drawSheet();
}));
document.querySelectorAll("[data-sc]").forEach((b) => (b.onclick = () => saveSettings({ stockCode: b.dataset.sc })));
$("#reloadBtn").onclick = () => location.reload();

document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => openMode(b.dataset.go)));
$("#goStock").onclick = () => { pickForTake = false; if (takeMode === "damage") { takeMode = "take"; dmg = dmgFresh(); } openStock("take"); };
$("#goDamage").onclick = () => { pickForTake = false; takeItem = null; takeMode = "damage"; dmg = dmgFresh(); openStock("take"); };
$("#goStockLabel").onclick = () => { pickForTake = false; openStock("labels"); };
$("#goLog").onclick = openLog;
$("#goProd").onclick = () => openProd();

/* ---------- stock (linked to the Payaz Stock app) ---------- */
let stockSearch = "", stockReady = false, sheetItem = null, sheetCopies = 1;
let stockView = "take", pickForTake = false; // "take" = Stock button, "labels" = Stock Label button
S.watch(() => { stockReady = true; if ($("#stock").classList.contains("on")) openStock(); refreshSpotDue(); });

async function openStock(view = stockView) {
  stockView = view;
  $("#hdrTitle").textContent = pickForTake ? (takeMode === "damage" ? "Choose the damaged item" : "Choose an item to count") : view === "take" ? (takeMode === "damage" ? "Log damage" : "Stock") : "Stock Label";
  $("#takeModes").style.display = takeMode === "damage" ? "none" : "";
  show("stock"); poke();
  const signedIn = S.user && S.isStaff;
  if (!signedIn) { showWho(); return; }
  $("#stockSignin").style.display = "none";
  const showTake = signedIn && view === "take" && !pickForTake;
  $("#takeMain").style.display = showTake ? "flex" : "none";
  $("#stockMain").style.display = signedIn && !showTake ? "flex" : "none";
  $("#stCustom").style.display = pickForTake ? "none" : "";
  $("#stCustom2").style.display = view === "labels" ? "" : "none";
  if (!signedIn) return;
  $("#stWho").textContent = `Signed in as ${S.userName}`;
  if (!S.items.length) await refreshStock();
  else drawStock();
  if (showTake) drawTake();
}
async function refreshStock() {
  overlay("Loading stock…", "", false, true);
  try { await S.refresh(); hideOverlay(); }
  catch (e) { overlay("Couldn't load stock", friendlyError(e), true); }
  drawStock();
}
function setStockSearch(v) { stockSearch = v.slice(0, 40); drawStock(); poke(); }
function stockMatches() {
  const q = stockSearch.trim().toLowerCase();
  if (!q) return S.items;
  return S.items.filter((i) => [i.name, i.SKU, i.barcode, i.location, i.category].some((v) => (v || "").toLowerCase().includes(q)));
}
function drawStock() {
  const rows = stockMatches(), shown = rows.slice(0, 300);
  $("#stSearchText").innerHTML = stockSearch ? `<b>${esc(stockSearch)}</b>` : '<span class="ph">Scan an item, or tap to search name, SKU or location</span>';
  $("#stClear").style.display = stockSearch ? "" : "none";
  $("#stCount").textContent = stockSearch ? `${rows.length} of ${S.items.length} items` : `${S.items.length} items`;
  $("#stBody").innerHTML = shown.map((i) => `<tr class="row stockrow" data-id="${esc(i.id)}"><td>${esc(i.name || "-")}<small>${esc(i.category || "")}${i.is_discontinued ? " · discontinued" : ""}</small></td>` +
    `<td>${esc(S.labelCode(i))}</td><td>${esc(i.location || "-")}</td><td>${i.quantity_on_hand ?? "-"}</td></tr>`).join("");
  $("#stEmpty").textContent = rows.length ? (rows.length > shown.length ? `Showing the first ${shown.length}. Search to narrow it down.` : "")
    : S.items.length ? "Nothing matches that search." : "No items in the stock app yet. Tap + New item.";
  $("#stBody").querySelectorAll("tr").forEach((tr) => (tr.onclick = () => {
    const item = S.items.find((i) => i.id === tr.dataset.id);
    if (pickForTake) { pickForTake = false; stockSearch = ""; openStock("take"); takeStart(item); }
    else openSheet(item);
  }));
}
// A scan on the stock screen: open that item, or offer to add it.
async function stockScan(code) {
  if (!code) return;
  // Barcode / SKU, or the product a booked-in serial number belongs to
  const found = await S.findItemOrSerial(code);
  if (found) {
    stockSearch = ""; drawStock();
    if (pickForTake) { pickForTake = false; openStock("take"); takeStart(found.item); return; }
    openSheet(found.item, found.unit ? `Serial <b>${esc(found.unit.serial_number)}</b>: ${esc(serialStatusText(found.unit))}` : "");
    return;
  }
  setStockSearch(code);
  if (!stockMatches().length)
    overlay("Not in the stock app", `Nothing has the code ${code}.`, false, false, { label: "Add it as a new item", run: () => openNewItem({ barcode: code }) });
}
const stockLabelValues = (i) => ({ name: i.name || "", location: i.location || "", code: S.labelCode(i) });

// Item pop-up: print its label
const serialStatusText = (u) => u.status === "in_stock" ? "in stock" : u.status === "off_site" ? `off site${u.off_site_place ? ` (${u.off_site_place})` : ""}` : u.status === "dispatched" ? `sent on order ${u.order_number || "?"}` : u.status;
function openSheet(item, note = "") {
  if (!item) return;
  sheetItem = item; sheetCopies = 1;
  $("#shName").textContent = item.name || "(no name)";
  $("#shPic").style.display = item.image_url ? "" : "none";
  $("#shPic").style.backgroundImage = item.image_url ? `url("${item.image_url}")` : "";
  $("#shMeta").innerHTML = `SKU <b>${esc(item.SKU || "-")}</b>${item.barcode ? ` · Barcode <b>${esc(item.barcode)}</b>` : ""}<br>` +
    `Location <b>${esc(item.location || "-")}</b> · In stock <b>${item.quantity_on_hand ?? "-"}</b>${item.category ? ` · ${esc(item.category)}` : ""}` +
    (note ? `<br>${note}` : "");
  drawSheet(); $("#sheet").classList.add("on"); poke();
}
function drawSheet() {
  $("#shCopies").textContent = sheetCopies;
  document.querySelectorAll("#shOrient [data-so]").forEach((b) => b.classList.toggle("on", b.dataset.so === settings.stockOrient));
  const lbl = makeLabel("stock", stockLabelValues(sheetItem));
  $("#shPrev").replaceChildren(lbl.canvas, ...thinWarning(lbl.thinBars));
}
const closeSheet = () => $("#sheet").classList.remove("on");
$("#shClose").onclick = closeSheet;
$("#sheet").onclick = (e) => { if (e.target.id === "sheet") closeSheet(); };
$("#shMinus").onclick = () => { sheetCopies = Math.max(1, sheetCopies - 1); drawSheet(); };
$("#shPlus").onclick = () => { sheetCopies = Math.min(50, sheetCopies + 1); drawSheet(); };
$("#shPrint").onclick = async () => {
  if (await doPrint("stock", stockLabelValues(sheetItem), sheetCopies)) setTimeout(() => { hideOverlay(); closeSheet(); }, 1100);
};
$("#shEdit").onclick = () => { const item = sheetItem; closeSheet(); openEditItem(item); };

// Sign in / out
$("#stSignInBtn").onclick = async () => {
  const email = $("#stEmail").value, pass = $("#stPass").value;
  if (!email || !pass) { overlay("Enter your email and password", "", true); return; }
  overlay("Signing in…", "", false, true);
  try { await S.signIn(email, pass); $("#stPass").value = ""; hideOverlay(); openStock(); }
  catch (e) { overlay("Couldn't sign in", friendlyError(e), true); }
};
$("#stPass").onkeydown = (e) => { if (e.key === "Enter") $("#stSignInBtn").click(); };
$("#stForgot").onclick = async () => {
  const email = $("#stEmail").value.trim();
  if (!email) { overlay("Type your email first", "Then tap this again and we'll email you a link to set a password.", true); return; }
  try { await S.resetPassword(email); overlay("Check your email", `If ${email} has a Payaz Stock login, a link to set a password is on its way.`); }
  catch (e) { overlay("Couldn't send the email", friendlyError(e), true); }
};
$("#stSignOut").onclick = () => lockNow();
$("#stRefresh").onclick = refreshStock;
$("#stClear").onclick = () => setStockSearch("");
$("#stSearchBtn").onclick = () => { searchTarget = "stock"; drawTyper(); $("#typer").classList.add("on"); };
$("#stNew").onclick = () => openNewItem({});
$("#stCustom").onclick = () => openMode("stock");
$("#stCustom2").onclick = () => openMode("stock");

/* ---------- spot check: a small blind count (Payaz Stock's spot checks) ---------- */
// The counter is never shown what the system expects. A count that doesn't match is
// counted again; a big difference adds a deeper count; managers see the results in
// Payaz Stock and decide what to do about differences.
let spot = { check: null, count: 0, scanned: [], attempt: 1, first: null, msg: null, busy: false, status: null, exp: null };
// Serial items with lots of units (more than SPOT.sampleOver): the boxes are counted
// (a typed total), then any 30 serials are scanned and checked against the system.
// If most were scanned at the last check too, 10 more different ones are asked for.
const fresh = () => ({ count: 0, scanned: [], attempt: 1, first: null, msg: null, busy: false, exp: null });
const spotList = () => spot.check ? [...spot.check.item_ids, ...(spot.check.deep_item_ids || [])] : [];
const spotCurrentId = () => spotList().find((id) => !(spot.check.results || {})[id]);
const spotItem = (id) => S.items.find((i) => i.id === id) || { id, name: "(item no longer in stock app)" };

async function refreshSpotDue() {
  if (!(S.user && S.isStaff && S.spotStatus)) { $("#spotBtn").style.display = "none"; return; }
  try { spot.status = await S.spotStatus(); } catch (e) { spot.status = null; }
  $("#spotBtn").style.display = spot.status && spot.status.due ? "" : "none";
  $("#spotBtn").textContent = spot.status && spot.status.open && spot.status.open.status !== "requested" ? "Finish the spot check" : "Spot check due";
}
$("#spotBtn").onclick = async () => {
  pickForTake = false; await openStock("take");
  if (takeItem && !(await takeSave(true))) return;
  takeMode = "spot"; drawTake();
};

async function spotLoad(id) {
  spot.exp = { forId: id, loading: true };
  try {
    const e = await S.spotExpected(id);
    const sampled = e.serials && e.expected > S.SPOT.sampleOver;
    const prev = sampled ? new Set(await S.lastSpotSample(id, spot.check.id)) : new Set();
    spot.exp = { forId: id, ...e, sampled, prev, phase: sampled ? "total" : "count", sample: [], need: sampled ? Math.min(S.SPOT.sample, e.expected) : 0, more: false, totals: [] };
  } catch (err) {
    spot.exp = null; overlay("Couldn't load the item", friendlyError(err), true);
  }
  drawTake();
}

function drawSampled(card, item, head) {
  const x = spot.exp;
  if (x.phase === "total") {
    card.innerHTML = `${head}
      <div class="meta">Step 1 of 2: count the boxes on the shelf and enter the total. (Then you'll scan some serials.)</div>
      <div class="counter"><button id="spMinus">&minus;</button><button class="num" id="spNum"><small>BOXES</small><b>${spot.count}</b></button><button id="spPlus">+</button></div>
      ${spot.msg ? `<div class="bookmsg ${spot.msg.tone}">${spot.msg.text}</div>` : ""}
      <div class="takebtns"><button class="print" id="spOk">NEXT</button></div>`;
    $("#spMinus").onclick = () => { spot.count = Math.max(0, spot.count - 1); drawTake(); poke(); };
    $("#spPlus").onclick = () => { spot.count++; drawTake(); poke(); };
    $("#spNum").onclick = () => { searchTarget = "spot"; drawTyper(); $("#typer").classList.add("on"); };
    $("#spOk").onclick = spotTotalDone;
    return;
  }
  const okN = x.sample.filter((v) => v.ok).length, enough = x.sample.length >= x.need;
  card.innerHTML = `${head}
    <div class="meta">Step 2 of 2: scan the serial number on <b>${x.need}</b> boxes (any boxes)${x.more ? ", <b>not</b> ones checked last time" : ""}.</div>
    <div class="spotcount">${x.sample.length} / ${x.need}</div>
    <div class="spotserials">${x.sample.map((v) => `<span style="${v.ok ? "" : "background:#fde7e9;color:#b3263a"}" title="${esc(v.why || "")}">${v.ok ? "\u2713" : "\u26a0"} ${esc(v.sn)}</span>`).join("")}</div>
    <div class="meta">${okN} on the system${x.sample.length - okN ? ` · <b style="color:#b3263a">${x.sample.length - okN} problem${x.sample.length - okN === 1 ? "" : "s"}</b>` : ""}</div>
    ${spot.msg ? `<div class="bookmsg ${spot.msg.tone}">${spot.msg.text}</div>` : ""}
    <div class="takebtns"><button class="ghost cam" id="spCam" style="min-height:70px">&#128247; Camera</button>
      ${enough ? "" : `<button class="ghost" id="spFewer" style="min-height:70px">Finish with fewer</button>`}
      <button class="print" id="spOk" ${enough && !spot.busy ? "" : "disabled"}>DONE</button></div>`;
  $("#spCam").onclick = () => scanWithCamera((code) => spotScan(code.trim()));
  $("#spOk").onclick = spotSampleDone;
  if (!enough) $("#spFewer").onclick = () => overlay("Finish with fewer?", `${x.sample.length} of ${x.need} scanned. The report will say so.`, false, false, { label: "Finish", run: spotSampleDone });
}

function spotTotalDone() {
  const x = spot.exp;
  if (spot.count !== x.expected && spot.attempt === 1) {
    spot = { ...spot, first: spot.count, attempt: 2, count: 0, msg: { tone: "bad", text: "That doesn't match what's recorded. Please count the boxes again carefully." } };
    drawTake(); return;
  }
  x.totals = spot.first === null ? [spot.count] : [spot.first, spot.count];
  x.phase = "sample"; spot.msg = null; drawTake(); poke();
}

async function spotSampleScan(sn) {
  const x = spot.exp;
  if (x.sample.some((v) => v.sn === sn)) { spot.msg = { tone: "bad", text: `${esc(sn)} already scanned.` }; drawTake(); return; }
  if (x.more && x.prev.has(sn)) { spot.msg = { tone: "bad", text: `${esc(sn)} was checked last time: pick a different box.` }; drawTake(); return; }
  let ok = x.serials.includes(sn), why = "";
  if (!ok) {
    const u = await S.lookupSerial(sn).catch(() => null);
    why = !u ? "not booked in" : u.item_id !== spot.exp.forId ? `booked in as ${u.item_name}` : u.status === "dispatched" ? `recorded as sent on order ${u.order_number}` : `recorded as ${u.status}`;
  }
  x.sample.push({ sn, ok, why });
  spot.msg = ok ? { tone: "good", text: `\u2713 ${esc(sn)} is on the system` } : { tone: "bad", text: `\u26a0 ${esc(sn)}: ${esc(why)}. Put it aside for a manager.` };
  // Reached the number: if most were also scanned last time, ask for some different ones
  if (x.sample.length >= x.need && !x.more && x.prev.size) {
    const repeat = x.sample.filter((v) => x.prev.has(v.sn)).length;
    if (repeat > x.need / 2) {
      x.more = true; x.need += S.SPOT.sampleMore;
      spot.msg = { tone: "bad", text: `Most of these were checked last time. Please scan ${S.SPOT.sampleMore} more <b>different</b> boxes.` };
    }
  }
  drawTake(); poke();
}

async function spotSampleDone() {
  if (spot.busy) return;
  const id = spotCurrentId(), item = spotItem(id), x = spot.exp;
  spot.busy = true; drawTake();
  try {
    const final = x.totals[x.totals.length - 1], diff = final - x.expected, cost = Number((x.item || item).unit_cost) || 0;
    const flagged = x.sample.filter((v) => !v.ok);
    await S.saveSpotResult(spot.check.id, id, {
      name: item.name || "", sku: item.SKU || "", location: item.location || "", serial: true, sampled: true,
      expected: x.expected, counts: x.totals, final, diff, unit_cost: cost, value: Math.round(diff * cost * 100) / 100,
      missing: [], extra: flagged.map((v) => v.sn), extra_why: Object.fromEntries(flagged.map((v) => [v.sn, v.why])),
      sample: x.sample.map((v) => v.sn), sample_target: x.need, sample_ok: x.sample.length - flagged.length, recount: x.totals.length > 1,
    });
    const ok = !diff && !flagged.length;
    await spotAdvance(id, item, ok, diff, cost, [], flagged.map((v) => v.sn));
  } catch (e) {
    spot.busy = false; overlay("Couldn't save the count", friendlyError(e), true); drawTake();
  }
}

function drawSpot(card) {
  const c = spot.check;
  if (!c) {
    const st = spot.status, open = st && st.open;
    card.innerHTML = `<h2>Spot check</h2>
      <div class="meta" style="line-height:1.5">A quick count of about ${S.SPOT.items} items picked at random, including some tablets and card readers.
      You won't be shown how many there should be: just count what's there. If a count doesn't match, you'll be asked to count it again.</div>
      <div class="bookmsg ${st && st.due ? "bad" : ""}">${open ? (open.status === "requested" ? `Requested by ${esc(open.requested_by_name || "a manager")}.` : `Started by ${esc(open.started_by_name || "")}: carry on where it was left.`) : st && st.due ? "A spot check is due (1st and 15th of the month)." : "Not due yet: you can still do one."}</div>
      <div class="takebtns"><button class="print" id="spStart">${open && open.status !== "requested" ? "CARRY ON" : "START SPOT CHECK"}</button></div>`;
    $("#spStart").onclick = spotStart;
    return;
  }
  if (c.status === "finished") {
    const s = c.summary || {};
    const text = c.outcome === "green" ? "✓ All correct. Thank you!" : c.outcome === "amber" ? "Small differences found. Managers have been told." : "Big differences found. Managers have been told.";
    const wrong = spotList().map((id) => c.results[id]).filter((x) => x && (x.diff || (x.missing || []).length || (x.extra || []).length));
    card.innerHTML = `<h2>Spot check finished</h2>
      <div class="spotres ${c.outcome}">${text}${c.over ? " Some items had more than recorded." : ""}</div>
      <div class="meta">${s.counted || 0} items counted · ${s.correct || 0} correct${s.short ? ` · ${s.short} short` : ""}${s.over ? ` · ${s.over} over` : ""}</div>
      ${wrong.length ? `<div class="meta" style="line-height:1.6">${wrong.map((x) => `<b>${esc(x.name)}</b>: ${x.diff < 0 ? `${-x.diff} short` : x.diff > 0 ? `${x.diff} over` : `${(x.extra || []).length + (x.missing || []).length} serial problem${(x.extra || []).length + (x.missing || []).length === 1 ? "" : "s"}`}${(x.missing || []).length ? ` (missing ${x.missing.map(esc).join(", ")})` : ""}${(x.extra || []).length ? ` (${x.extra.map(esc).join(", ")}: put aside for a manager)` : ""}`).join("<br>")}</div>` : ""}
      <div class="takebtns"><button class="print" id="spDone">DONE</button></div>`;
    $("#spDone").onclick = () => { spot = { ...spot, check: null, msg: null }; takeMode = "take"; refreshSpotDue(); drawTake(); };
    return;
  }
  const id = spotCurrentId(), item = spotItem(id), serial = item.tracking_type === "serial";
  const main = c.item_ids.length, deep = (c.deep_item_ids || []).length;
  const pos = spotList().indexOf(id) + 1;
  const head = `<div class="meta">${pos <= main ? `Item ${pos} of ${main}` : `Deeper count: item ${pos - main} of ${deep}`}${spot.attempt === 2 ? " · <b style=\"color:#b3263a\">COUNT AGAIN</b>" : ""}</div>
    <h2>${esc(item.name || "")}</h2>
    <div class="meta">SKU ${esc(item.SKU || "-")} · Location <b>${esc(item.location || "-")}</b></div>`;
  if (!spot.exp || spot.exp.forId !== id) {
    card.innerHTML = `${head}<div class="meta">Loading\u2026</div>`;
    if (!spot.exp || spot.exp.forId !== id) spotLoad(id);
    return;
  }
  if (spot.exp.loading) { card.innerHTML = `${head}<div class="meta">Loading\u2026</div>`; return; }
  if (spot.exp.sampled) { drawSampled(card, item, head); return; }
  card.innerHTML = `${head}
    <div class="meta">${serial ? "Scan the serial number on every unit you can find." : "Scan each unit (or its shelf label once per unit), or use + / −."}</div>
    ${serial ? `<div class="spotcount">${spot.scanned.length}</div><div class="spotserials">${spot.scanned.map((x) => `<span>${esc(x)}</span>`).join("")}</div>`
      : `<div class="counter"><button id="spMinus">&minus;</button><button class="num" id="spNum"><small>COUNTED</small><b>${spot.count}</b></button><button id="spPlus">+</button></div>`}
    ${spot.msg ? `<div class="bookmsg ${spot.msg.tone}">${spot.msg.text}</div>` : ""}
    <div class="takebtns"><button class="ghost cam" id="spCam" style="min-height:70px">&#128247; Camera</button><button class="print" id="spOk" ${spot.busy ? "disabled" : ""}>DONE COUNTING</button></div>`;
  if (!serial) {
    $("#spMinus").onclick = () => { spot.count = Math.max(0, spot.count - 1); drawTake(); poke(); };
    $("#spPlus").onclick = () => { spot.count++; drawTake(); poke(); };
    $("#spNum").onclick = () => { searchTarget = "spot"; drawTyper(); $("#typer").classList.add("on"); };
  }
  $("#spCam").onclick = () => scanWithCamera((code) => spotScan(code.trim()));
  $("#spOk").onclick = spotDone;
}

async function spotStart() {
  overlay("Starting the spot check…", "", false, true);
  try {
    const st = await S.spotStatus(); spot.status = st;
    spot.check = st.open && st.open.status !== "requested" ? st.open : await S.startSpotCheck(st.open && st.open.status === "requested" ? st.open : null);
    if (!S.items.length) await S.refresh();
    spot = { ...spot, ...fresh() };
    hideOverlay(); refreshSpotDue();
  } catch (e) { overlay("Couldn't start the spot check", friendlyError(e), true); }
  drawTake();
}

function spotScan(code) {
  if (!spot.check || spot.check.status === "finished" || !code) return;
  const item = spotItem(spotCurrentId()), product = S.findByCode(code);
  if (spot.exp && spot.exp.sampled && spot.exp.forId === item.id) {
    if (product) { spot.msg = { tone: "bad", text: product.id === item.id ? (spot.exp.phase === "total" ? "Count the boxes and enter the number, then scan serials." : "That's the product barcode. Scan the serial number (S/N).") : `That's ${esc(product.name)}. This check is counting ${esc(item.name)}.` }; drawTake(); return; }
    if (spot.exp.phase === "total") { spot.msg = { tone: "bad", text: "First count the boxes and press NEXT. Then scan serials." }; drawTake(); return; }
    spotSampleScan(S.normaliseSerial(code)); return;
  }
  if (item.tracking_type === "serial") {
    if (product) { spot.msg = { tone: "bad", text: product.id === item.id ? "That's the product barcode. Scan the serial number (S/N) on each unit." : `That's ${esc(product.name)}. This check is counting ${esc(item.name)}.` }; drawTake(); return; }
    const sn = S.normaliseSerial(code);
    if (spot.scanned.includes(sn)) { spot.msg = { tone: "bad", text: `${esc(sn)} already scanned.` }; drawTake(); return; }
    spot.scanned.push(sn); spot.msg = { tone: "good", text: `✓ ${esc(sn)}` };
  } else if (product && product.id === item.id) {
    spot.count++; spot.msg = null;
  } else {
    spot.msg = { tone: "bad", text: product ? `That's ${esc(product.name)}. This check is counting ${esc(item.name)}.` : `${esc(code)} isn't this item's barcode.` };
  }
  drawTake(); poke();
}

async function spotDone() {
  if (spot.busy) return;
  const id = spotCurrentId(), item = spotItem(id), serial = item.tracking_type === "serial";
  spot.busy = true; drawTake();
  try {
    const exp = await S.spotExpected(id);
    let counted, missing = [], extra = [];
    if (serial) {
      counted = spot.scanned.length;
      missing = exp.serials.filter((x) => !spot.scanned.includes(x));
      extra = spot.scanned.filter((x) => !exp.serials.includes(x));
    } else counted = spot.count;
    const ok = serial ? !missing.length && !extra.length : counted === exp.expected;
    if (!ok && spot.attempt === 1) {
      // Count again, without saying by how much it was out
      spot = { ...spot, first: counted, attempt: 2, count: 0, scanned: [], busy: false, msg: { tone: "bad", text: "That doesn't match what's recorded. Please count it again carefully." } };
      drawTake(); return;
    }
    const cost = Number((exp.item || item).unit_cost) || 0, diff = counted - exp.expected;
    await S.saveSpotResult(spot.check.id, id, {
      name: item.name || "", sku: item.SKU || "", location: item.location || "", serial,
      expected: exp.expected, counts: spot.first === null ? [counted] : [spot.first, counted], final: counted, diff,
      unit_cost: cost, value: Math.round(diff * cost * 100) / 100, missing, extra, recount: spot.attempt === 2,
    });
    await spotAdvance(id, item, ok, diff, cost, missing, extra);
    return;
  } catch (e) {
    spot.busy = false; overlay("Couldn't save the count", friendlyError(e), true);
  }
  drawTake();
}

/** After an item is saved: note it, then the next item, a deeper count, or finish. */
async function spotAdvance(id, item, ok, diff, cost, missing, extra) {
  try {
    spot.check.results = { ...(spot.check.results || {}), [id]: { name: item.name, location: item.location, serial: item.tracking_type === "serial", diff, value: diff * cost, missing, extra } };
    takeSession.unshift({ name: item.name, what: ok ? "Spot check: correct" : `Spot check: ${diff < 0 ? `${-diff} short` : diff > 0 ? `${diff} over` : `${extra.length} serial problem${extra.length === 1 ? "" : "s"}`}`, time: hhmm(), bad: !ok });
    spot = { ...spot, ...fresh() };
    if (!spotCurrentId()) {
      const sev = S.spotSeverity(spot.check.results);
      if (sev.outcome === "red" && spot.check.status === "counting") {
        spot.check = await S.addDeepCount(spot.check);
        spot.msg = { tone: "bad", text: `Big difference found. Please count ${spot.check.deep_item_ids.length} more items.` };
      }
      if (!spotCurrentId()) {
        spot.check = await S.finishSpotCheck(spot.check);
        refreshSpotDue();
      }
    }
  } catch (e) {
    spot.busy = false; overlay("Couldn't save the count", friendlyError(e), true);
  }
  drawTake();
}

/* ---------- stock take (Stock button) ---------- */
// Same as the stock app's Stock Take / Add Stock / Remove Stock scan modes:
// each scan of the item counts 1; the result is saved with the same history text.
let takeMode = "take", takeItem = null, takeCount = 0, takeBusy = false, takeLoc = "";
const takeSession = [];
const MODE_TEXT = {
  take: { name: "Stock take", counter: "COUNTED", hint: "Scan every unit of an item: each scan counts 1. Scanning the next item saves this one." },
  add: { name: "Add stock", counter: "ADDING", hint: "Scan each unit you're putting into stock." },
  remove: { name: "Remove stock", counter: "REMOVING", hint: "Scan each unit you're taking out of stock." },
  spot: { name: "Spot check", hint: "" },
  offsite: { name: "Off site", hint: "" },
  bookin: { name: "Book in serials", hint: "Scan the product barcode (or its shelf label), or tap Find an item. Then scan the serial number on each unit." },
};
const recorded = (i) => onSite(i); // what should be on the shelves (stock kept off site isn't)
function takeResult() {
  const old = recorded(takeItem);
  return takeMode === "take" ? takeCount : takeMode === "add" ? old + takeCount : Math.max(0, old - takeCount);
}
function drawTake() {
  document.querySelectorAll("#takeModes button").forEach((b) => b.classList.toggle("on", b.dataset.m === takeMode));
  $("#modeOffsite").style.display = S.isManager ? "" : "none";
  $("#takeNew").style.display = takeMode === "damage" ? "none" : "";
  if (takeMode === "offsite" && !S.isManager) takeMode = "take";
  const M = MODE_TEXT[takeMode], card = $("#takeCard");
  if (takeMode === "offsite") drawOffSite(card);
  else if (takeMode === "damage") drawDamage(card);
  else if (takeMode === "spot") drawSpot(card);
  else if (takeMode === "bookin" && bookItem) drawBookIn(card);
  else if (!takeItem) {
    card.innerHTML = `<div class="scanwait"><div class="beam"></div><h2>Scan an item or its shelf label</h2>
      <p style="margin:0;color:var(--muted);font-size:17px">${M.hint}</p>
      <div class="btns" style="display:flex;gap:10px"><button class="ghost cam" id="takeCam">&#128247; Use camera</button></div></div>`;
    $("#takeCam").onclick = () => scanWithCamera((c) => takeScan(c.trim()));
  } else {
    const old = recorded(takeItem), res = takeResult(), diff = res - old;
    card.innerHTML = `<h2>${esc(takeItem.name || "(no name)")}</h2>
      <div class="meta">SKU ${esc(takeItem.SKU || "-")} · ${offSite(takeItem) ? `On site now: <b>${old}</b> (${offSite(takeItem)} more off site, not counted here)` : `In stock now: <b>${old}</b>`}</div>
      <button class="locbtn${takeLoc !== (takeItem.location || "") ? " moved" : ""}" id="tkLoc">&#128205; Location: <b>${esc(takeLoc || "none")}</b>${takeLoc !== (takeItem.location || "") ? ` (moves from ${esc(takeItem.location || "none")} when saved)` : " · tap to change"}</button>
      <div class="counter"><button id="tkMinus">&minus;</button><button class="num" id="tkNum"><small>${M.counter}</small><b>${takeCount}</b></button><button id="tkPlus">+</button></div>
      <div class="change ${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff === 0 ? `Stays at ${old}` : `${old} \u2192 ${res} (${diff > 0 ? "+" : ""}${diff})`}</div>
      <div class="takebtns"><button class="ghost" id="tkCancel" style="min-height:70px">Cancel</button><button class="print" id="tkSave">SAVE</button></div>`;
    $("#tkMinus").onclick = () => { takeCount = Math.max(0, takeCount - 1); drawTake(); poke(); };
    $("#tkPlus").onclick = () => { takeCount++; drawTake(); poke(); };
    $("#tkNum").onclick = () => { searchTarget = "count"; drawTyper(); $("#typer").classList.add("on"); };
    $("#tkCancel").onclick = () => { takeItem = null; drawTake(); };
    $("#tkSave").onclick = () => takeSave();
    $("#tkLoc").onclick = () => pickLocation(takeItem, takeLoc, (loc) => { takeLoc = loc; drawTake(); });
  }
  $("#takeSession").innerHTML = `<h4>THIS SESSION</h4>` + (takeSession.length ? takeSession.map((x, i) =>
    `<div class="it${x.bad ? " bad" : ""}${x.undone ? " undone" : ""}"><div class="itrow"><span>${esc(x.name)}<small>${esc(x.what)} · ${x.time}</small></span>` +
    (canUndo(x) ? `<button class="undo" data-undo="${i}">Undo</button>` : "") + `</div></div>`).join("") : `<div class="it"><small>Nothing saved yet.</small></div>`);
  $("#takeSession").querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => undoEntry(takeSession[+b.dataset.undo])));
}

/* ---------- undo a scan made by mistake ---------- */
// Saved counts and adds/removes can be undone (the change is reversed, with its own
// history entry). Serials booked in can be undone by the same person for 15 minutes.
const canUndo = (x) => x.undo && !x.undone && (x.undo.kind !== "serial" || Date.now() - x.undo.at < 15 * 60000);
async function undoEntry(x) {
  if (!x || !canUndo(x)) return;
  overlay("Undoing…", x.name, false, true);
  try {
    if (x.undo.kind === "serial") {
      const r = await S.undoBookIn(x.undo.serial);
      x.what = `Undone: taken back out${r.newQty !== null ? ` (stock now ${r.newQty})` : ""}`;
    } else {
      const r = await S.adjustStock(x.undo.itemId, { change: -x.undo.delta, reason: `Undo: ${x.undo.label} (scanned by mistake)` });
      x.what = `Undone: back to ${r.newQty}`;
    }
    x.undone = true;
    overlay("Undone \u2713", x.name, false, true);
    setTimeout(hideOverlay, 900);
  } catch (e) {
    overlay("Couldn't undo", friendlyError(e), true);
  }
  drawTake();
}
function takeStart(item) {
  if (takeMode === "bookin") { bookStart(item); return; }
  if (takeMode === "damage") { dmgStart(item); return; }
  if (takeMode === "offsite") { offStart(item); return; }
  if (item && item.tracking_type === "serial") {
    // Serial-tracked: the count is locked, units are booked in one by one
    overlay(`${item.name} is tracked by serial number`, "Its stock count can't be changed here. Book new units in by their serial numbers; they come off stock when sent on an Order Label.", false, false,
      { label: "Book in serials", run: async () => { if (takeItem && !(await takeSave(true))) return; takeMode = "bookin"; bookStart(item); } });
    return;
  }

  takeItem = item; takeCount = 1; takeLoc = item.location || ""; drawTake(); poke();
}

/* ---------- location picker ---------- */
// Choose where an item is kept: one of the known locations, or type a new one.
let locDone = null;
function pickLocation(item, current, done) {
  locDone = done;
  $("#locFor").textContent = `${item.name || "Item"} · now: ${item.location || "no location"}`;
  const all = [...new Set([...(S.locations || []), item.location, current].filter(Boolean))].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  $("#locChips").innerHTML = all.map((l) => `<button class="chip ${l === current ? "on" : ""}" data-loc="${esc(l)}">${esc(l)}</button>`).join("");
  $("#locChips").querySelectorAll("[data-loc]").forEach((b) => (b.onclick = () => { $("#locPick").classList.remove("on"); locDone(b.dataset.loc); }));
  $("#locPick").classList.add("on"); poke();
}
$("#locClose").onclick = () => $("#locPick").classList.remove("on");
$("#locPick").onclick = (e) => { if (e.target.id === "locPick") $("#locPick").classList.remove("on"); };
$("#locType").onclick = () => { $("#locPick").classList.remove("on"); searchTarget = "location"; locTyped = ""; drawTyper(); $("#typer").classList.add("on"); };
let locTyped = "";

/* ---------- book in serials (same records as Payaz Stock's Book in serials) ---------- */
// Choose the product, then scan the serial on each unit. Each scan saves at once.
let bookItem = null, bookMode = "delivery", bookRef = "", bookMsg = null, bookCount = 0, bookQueue = Promise.resolve();
function bookStart(item) {
  bookItem = item; bookCount = 0;
  bookMsg = { tone: "", text: `Now scan the serial number on each ${item.name || "unit"}.` };
  drawTake(); poke();
}
function drawBookIn(card) {
  const item = S.items.find((i) => i.id === bookItem.id) || bookItem;
  card.innerHTML = `<h2>${esc(item.name || "(no name)")}</h2>
    <div class="meta">SKU ${esc(item.SKU || "-")} · In stock now: <b>${recorded(item)}</b> · Booked in this time: <b>${bookCount}</b></div>
    <button class="locbtn" id="bkLoc">&#128205; Location: <b>${esc(item.location || "none")}</b> · tap to change</button>
    <div class="seg" id="bkMode"><button data-v="delivery" class="${bookMode === "delivery" ? "on" : ""}">New delivery<br><small style="font-weight:500">each scan adds 1 to stock</small></button>` +
    `<button data-v="shelf" class="${bookMode === "shelf" ? "on" : ""}">Already on the shelf<br><small style="font-weight:500">count stays the same, unless you scan more than it shows</small></button></div>
    ${bookMode === "delivery" ? `<button class="field" id="bkRef" style="padding:8px 14px"><div class="lbl">Delivery note or order reference (optional)</div>` +
      `<div class="val${bookRef ? "" : " empty"}" style="font-size:22px">${bookRef ? esc(bookRef) : "Tap to type it, e.g. PO 1043"}</div></button>` : ""}
    <div class="bookmsg ${bookMsg ? bookMsg.tone : ""}" id="bkMsg">${bookMsg ? bookMsg.text : ""}</div>
    <div class="takebtns"><button class="ghost cam" id="bkCam" style="min-height:70px">&#128247; Camera</button>` +
    `<button class="ghost" id="bkType" style="min-height:70px">&#9000; Type it</button>` +
    `<button class="print" id="bkDone">DONE</button></div>`;
  card.querySelectorAll("#bkMode button").forEach((b) => (b.onclick = () => { bookMode = b.dataset.v; drawTake(); poke(); }));
  $("#bkCam").onclick = () => scanWithCamera((c) => bookScan(c.trim()));
  $("#bkLoc").onclick = () => pickLocation(item, item.location || "", async (loc) => {
    try {
      if (await S.setLocation(item.id, loc)) { bookItem = S.items.find((i) => i.id === item.id) || bookItem; bookNote("good", `\u2713 Location changed to <b>${esc(loc)}</b>`, item.name, `Moved to ${loc}`); }
    } catch (e) { overlay("Couldn't change the location", friendlyError(e), true); }
  });
  if ($("#bkRef")) $("#bkRef").onclick = () => { searchTarget = "bookref"; drawTyper(); $("#typer").classList.add("on"); };
  $("#bkType").onclick = () => { searchTarget = "serial"; serialTyped = ""; drawTyper(); $("#typer").classList.add("on"); };
  $("#bkDone").onclick = () => { bookItem = null; bookMsg = null; drawTake(); };
}
function bookNote(tone, html, sessionName, sessionWhat, undoSerial) {
  bookMsg = { tone, text: html };
  if (sessionName) takeSession.unshift({ name: sessionName, what: sessionWhat, time: hhmm(), bad: tone === "bad",
    undo: undoSerial ? { kind: "serial", serial: undoSerial, at: Date.now() } : null });
  drawTake(); poke();
}
function bookScan(code) {
  code = (code || "").trim();
  if (!code) return;
  const product = S.findByCode(code);
  if (!bookItem) { if (product) bookStart(product); else overlay("Not in the stock app", `Nothing has the code ${code}. Scan the product barcode first, then the serial numbers.`, true); return; }
  if (product) {
    if (product.id === bookItem.id) bookNote("bad", `<b>${esc(code)}</b> is the product barcode, not a serial number. Scan the barcode marked S/N or Serial.`);
    else bookStart(product);
    return;
  }
  const serial = S.normaliseSerial(code), item = bookItem, mode = bookMode, ref = mode === "delivery" ? bookRef.trim() : "";
  bookNote("", `Saving <b>${esc(serial)}</b>…`);
  bookQueue = bookQueue.then(async () => {
    try {
      const r = await S.bookInSerial(item.id, serial, mode, ref);
      if (r.kind === "added") {
        if (bookItem && bookItem.id === item.id) bookCount++;
        bookNote("good", `\u2713 <b>${esc(serial)}</b> booked in${mode === "delivery" ? `, stock now ${r.newQty}` : r.raised ? `. More serials than the stock count, so the count went up to ${r.newQty}` : ""}`,
          serial, `Booked in: ${item.name}${mode === "delivery" ? ` (new delivery${ref ? `, ${ref}` : ""})` : " (already on the shelf)"}`, serial);
      } else if (r.kind === "exists") {
        const u = r.unit, when = shortDate(u.received_at);
        const where = u.status === "dispatched" ? `and sent on order ${u.order_number}. Tell a manager.` : `(${u.status === "in_stock" ? "in stock" : u.status}).`;
        bookNote("bad", `<b>${esc(serial)}</b> was already booked in on ${when} by ${esc(u.received_by_name)} as ${esc(u.item_name)} ${where}`,
          serial, `Already booked in (${u.item_name})`);
      } else bookNote("bad", esc(r.message), serial, r.message);
    } catch (e) {
      bookNote("bad", `<b>${esc(serial)}</b> wasn't saved: ${esc(friendlyError(e))}`, serial, "Not saved: " + friendlyError(e));
    }
  });
}

/* ---------- off site (managers): units kept off site to keep them safe ---------- */
// Scan a tablet or card reader serial and it moves at once; scan a product counted by
// quantity and choose how many. Same records as Payaz Stock's Off site page.
const offFresh = () => ({ dir: "off", reason: "", takenBy: null, place: "", item: null, qty: 1, msg: null, busy: false, units: null });
let off = offFresh();
const offDetails = () => ({ reason: off.reason, takenBy: off.takenBy || "", place: off.place });
const offReady = () => off.dir === "on" || (!!off.reason && !!(off.takenBy || "").trim());
const offDate = (iso) => (iso ? new Date(iso).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }) : "");
function offLoadUnits() {
  S.offSiteUnits().then((u) => { off.units = u; if (takeMode === "offsite" && $("#takeMain").style.display !== "none") drawTake(); }).catch(() => {});
}
function offStart(item) {
  if (item.tracking_type === "serial") { off.msg = { tone: "", text: `${esc(item.name)} is tracked by serial number: scan the serial number on each unit.` }; drawTake(); return; }
  if (off.item && off.item.id === item.id) off.qty++;
  else { off.item = item; off.qty = 1; off.msg = null; }
  drawTake(); poke();
}
async function offScan(code) {
  code = (code || "").trim();
  if (!code || off.busy) return;
  const product = S.findByCode(code);
  if (product) { offStart(product); return; }
  if (!offReady()) { off.msg = { tone: "bad", text: "Choose why it's going off site, and who is taking it, first. Then scan again." }; drawTake(); return; }
  off.busy = true; off.msg = { tone: "", text: `Saving <b>${esc(S.normaliseSerial(code))}</b>…` }; drawTake();
  try {
    const r = await S.moveSerialOffSite(code, off.dir, offDetails());
    const sn = esc(S.normaliseSerial(code));
    if (r.kind === "moved") {
      off.msg = { tone: "good", text: `\u2713 <b>${sn}</b> (${esc(r.unit.item_name)}) ${off.dir === "off" ? `taken off site (${esc(OFF_SITE_REASONS[off.reason])}) by ${esc(off.takenBy)}${off.place ? ` to ${esc(off.place)}` : ""}` : "back on site"}` };
      takeSession.unshift({ name: r.unit.item_name, what: `${S.normaliseSerial(code)} ${off.dir === "off" ? `off site: ${OFF_SITE_REASONS[off.reason]}, ${off.takenBy}` : "back on site"}`, time: hhmm(), bad: false, undo: null });
      offLoadUnits();
    } else if (r.kind === "already") off.msg = { tone: "bad", text: `<b>${sn}</b> is already ${off.dir === "off" ? "off site" : "on site"}.` };
    else if (r.kind === "not_here") off.msg = { tone: "bad", text: `<b>${sn}</b> (${esc(r.unit.item_name)}) is recorded as ${esc(serialStatusText(r.unit))}, so it can't be moved ${off.dir} site.` };
    else off.msg = { tone: "bad", text: `<b>${sn}</b> isn't booked in, and no product has that barcode.` };
  } catch (e) {
    off.msg = { tone: "bad", text: `Not saved: ${esc(friendlyError(e))}` };
  } finally { off.busy = false; drawTake(); poke(); }
}
async function offSave() {
  if (!off.item || off.busy) return;
  off.busy = true;
  const item = off.item, n = off.qty, dir = off.dir;
  overlay("Saving…", item.name, false, true);
  try {
    const r = await S.moveQuantityOffSite(item.id, dir, n, offDetails());
    hideOverlay();
    off.item = null;
    off.msg = { tone: "good", text: `\u2713 ${n} \u00d7 <b>${esc(item.name)}</b> ${dir === "off" ? "taken off site" : "brought back on site"}. On site now ${r.onSite}, off site ${r.offSite}.` };
    takeSession.unshift({ name: item.name, what: `${n} ${dir === "off" ? `off site: ${OFF_SITE_REASONS[off.reason]}, ${off.takenBy}` : "back on site"}`, time: hhmm(), bad: false, undo: null });
  } catch (e) { overlay("Couldn't save", friendlyError(e), true); }
  finally { off.busy = false; drawTake(); }
}
function drawOffSite(card) {
  if (off.takenBy === null) off.takenBy = S.userName || "";
  if (off.units === null) { off.units = []; offLoadUnits(); }
  const offItems = S.items.filter((i) => offSite(i) > 0 && i.tracking_type !== "serial").sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  const it = off.item && (S.items.find((i) => i.id === off.item.id) || off.item);
  const max = it ? (off.dir === "off" ? onSite(it) : offSite(it)) : 0;
  if (it) off.qty = Math.max(1, Math.min(off.qty, Math.max(1, max)));
  const ready = offReady();
  card.innerHTML = `<div class="seg" id="offDir"><button data-v="off" class="${off.dir === "off" ? "on" : ""}">Taking off site</button><button data-v="on" class="${off.dir === "on" ? "on" : ""}">Bringing back on site</button></div>
    ${off.dir === "off" ? `<div class="lbl dmglbl" style="margin:2px 0 -4px">Why is it going off site?</div>
      <div class="offwhy" id="offWhy">${Object.entries(OFF_SITE_REASONS).map(([k, t]) => `<button data-v="${k}" class="${off.reason === k ? "on" : ""}">${esc(t)}</button>`).join("")}</div>
      <div class="offrow"><button class="field" id="offTaken"><div class="lbl">Taken off site by</div><div class="val${off.takenBy ? "" : " empty"}">${off.takenBy ? esc(off.takenBy) : "Tap to type who"}</div></button>
      <button class="field" id="offPlace"><div class="lbl">Where to (optional)</div><div class="val${off.place ? "" : " empty"}">${off.place ? esc(off.place) : "e.g. Safe store"}</div></button></div>` : ""}
    ${it ? `<h2 style="margin:4px 0 0">${esc(it.name || "(no name)")}</h2>
      <div class="meta">On site <b>${onSite(it)}</b> \u00b7 off site <b>${offSite(it)}</b> \u00b7 total ${onSite(it) + offSite(it)}</div>
      <div class="counter" style="margin:0"><button id="offMinus">&minus;</button><button class="num"><small>${off.dir === "off" ? "TAKING OFF SITE" : "BRINGING BACK"}</small><b>${off.qty}</b></button><button id="offPlus">+</button></div>
      ${max ? "" : `<div class="bookmsg bad">None ${off.dir === "off" ? "on site" : "off site"} to move.</div>`}
      <div class="takebtns"><button class="ghost" id="offCancel" style="min-height:62px">Cancel</button><button class="print" id="offSave" ${max && ready && !off.busy ? "" : "disabled"}>SAVE</button></div>`
    : `<div class="offscan"><b>Scan a serial number or a product.</b> Tablets and card readers move straight away; other stock: scan its barcode or tap Find an item, then choose how many.
      <div style="display:flex;gap:10px;margin-top:8px"><button class="ghost cam" id="offCam">&#128247; Use camera</button><button class="ghost" id="offType">&#9000; Type a serial</button></div></div>`}
    ${!ready ? `<div class="bookmsg bad">Choose why it's going off site, and who is taking it, before scanning.</div>` : off.msg ? `<div class="bookmsg ${off.msg.tone}">${off.msg.text}</div>` : ""}
    <div class="offlist"><div class="offlisthead">OFF SITE NOW</div>
      ${off.units.length || offItems.length ? `<table>${off.units.map((u) => `<tr><td><b>${esc(u.serial_number)}</b><br><small>${esc(u.item_name || "")}</small></td><td>${esc(OFF_SITE_REASONS[u.off_site_reason] || "Off site")}${u.off_site_place ? `<br><small>${esc(u.off_site_place)}</small>` : ""}</td><td>${esc(u.off_site_taken_by || u.off_site_by_name || "")}</td><td>${esc(offDate(u.off_site_at))}</td></tr>`).join("")}
        ${offItems.map((i) => `<tr><td><b>${esc(i.name)}</b><br><small>by quantity</small></td><td colspan="3"><b>${offSite(i)}</b> off site</td></tr>`).join("")}</table>` : `<div style="padding:6px 0">Nothing is off site.</div>`}</div>`;
  card.querySelectorAll("#offDir button").forEach((b) => (b.onclick = () => { off.dir = b.dataset.v; off.msg = null; drawTake(); poke(); }));
  card.querySelectorAll("#offWhy button").forEach((b) => (b.onclick = () => { off.reason = b.dataset.v; off.msg = null; drawTake(); poke(); }));
  if ($("#offTaken")) $("#offTaken").onclick = () => { searchTarget = "offtaken"; drawTyper(); $("#typer").classList.add("on"); };
  if ($("#offPlace")) $("#offPlace").onclick = () => { searchTarget = "offplace"; drawTyper(); $("#typer").classList.add("on"); };
  if ($("#offCam")) $("#offCam").onclick = () => scanWithCamera((c) => offScan(c.trim()));
  if ($("#offType")) $("#offType").onclick = () => { searchTarget = "offserial"; serialTyped = ""; drawTyper(); $("#typer").classList.add("on"); };
  if ($("#offMinus")) {
    $("#offMinus").onclick = () => { off.qty = Math.max(1, off.qty - 1); drawTake(); poke(); };
    $("#offPlus").onclick = () => { off.qty = Math.min(Math.max(1, max), off.qty + 1); drawTake(); poke(); };
    $("#offCancel").onclick = () => { off.item = null; drawTake(); };
    $("#offSave").onclick = offSave;
  }
}

/* ---------- log damage (same records as Payaz Stock's Report Damage) ---------- */
// Scan the damaged item (or its serial number), choose why, and log it: stock goes
// down and a damage record is made with its own code. Then print its label, stick
// it on, and put the item in the damage box.
const dmgFresh = () => ({ item: null, unit: null, serialText: "", qty: 1, reason: "damaged_production", note: "", msg: null, saved: null, busy: false });
let dmg = dmgFresh();
function dmgStart(item, unit = null) {
  dmg = { ...dmgFresh(), reason: dmg.reason, item, unit, msg: item.tracking_type === "serial" && !unit
    ? { tone: "", text: `${esc(item.name)} is tracked by serial number: now scan the serial number of the damaged unit.` } : null };
  if (unit && unit.status !== "in_stock") dmg.msg = { tone: "bad", text: `Serial <b>${esc(unit.serial_number)}</b> isn't in stock (${esc(serialStatusText(unit))}). Tell a manager.` };
  drawTake(); poke();
}
async function dmgScan(code) {
  code = (code || "").trim();
  if (!code || dmg.busy) return;
  const needSerial = dmg.item && !dmg.saved && dmg.item.tracking_type === "serial";
  const found = await S.findItemOrSerial(code);
  if (found && found.unit) { dmgStart(found.item, found.unit); return; }
  if (found && found.item) {
    if (needSerial && found.item.id === dmg.item.id) { dmg.msg = { tone: "bad", text: `<b>${esc(code)}</b> is the product barcode. Scan the serial number (marked S/N or Serial).` }; drawTake(); return; }
    dmgStart(found.item); return;
  }
  if (needSerial) { dmg.msg = { tone: "bad", text: `Serial <b>${esc(S.normaliseSerial(code))}</b> isn't booked in. Book it in first (Stock, then Book in serials), then log the damage.` }; drawTake(); return; }
  // An item without serial tracking: an unknown code is the damaged unit's serial number (optional, as in Payaz Stock)
  if (dmg.item && !dmg.saved && !dmg.unit) { dmg.serialText = S.normaliseSerial(code).slice(0, 40); dmg.msg = null; drawTake(); poke(); return; }
  overlay("Not in the stock app", `Nothing has the code ${code}. Scan the item's barcode or shelf label, or tap Find an item.`, true);
}
const dmgLabelValues = (log) => ({ code: log.ref_code, item: log.item_name, serial: log.serial_number || "", by: log.user_name });
function drawDamage(card) {
  if (dmg.saved) {
    const log = dmg.saved;
    card.innerHTML = `<h2>Damage logged \u2713</h2>
      <div class="bookmsg good">Logged as <b>${esc(log.ref_code)}</b>: ${log.quantity} \u00d7 ${esc(log.item_name)}${log.serial_number ? ` (serial ${esc(log.serial_number)})` : ""}, taken off stock.</div>
      <div class="dmgprev" id="dmgPrev"></div>
      <div class="meta">1. Print the label. 2. Stick it on the item (or its bag). 3. Put it in the damage box.</div>
      <div class="takebtns"><button class="ghost" id="dmgAgain" style="min-height:70px">Print again</button><button class="print" id="dmgDone">DONE</button></div>`;
    const lbl = makeLabel("damage", dmgLabelValues(log));
    $("#dmgPrev").replaceChildren(lbl.canvas, ...thinWarning(lbl.thinBars));
    $("#dmgAgain").onclick = () => dmgPrint();
    $("#dmgDone").onclick = () => { dmg = { ...dmgFresh(), reason: dmg.reason }; drawTake(); };
    return;
  }
  // The same form as Payaz Stock's "Report Damage, Loss or Discrepancy"
  const item = dmg.item ? S.items.find((i) => i.id === dmg.item.id) || dmg.item : null;
  const serialItem = !!(item && item.tracking_type === "serial"), hasSerial = !!(dmg.unit && dmg.unit.status === "in_stock");
  const ready = !!item && (serialItem ? hasSerial : !dmg.unit || hasSerial);
  const oneUnit = !!(dmg.unit || dmg.serialText || serialItem);
  const serialVal = dmg.unit ? `<span style="font-family:monospace">${esc(dmg.unit.serial_number)}</span>${dmg.unit.status === "in_stock" ? "" : ` <small style="color:#b3263a">\u00b7 ${esc(serialStatusText(dmg.unit))}</small>`}`
    : dmg.serialText ? `<span style="font-family:monospace">${esc(dmg.serialText)}</span>`
    : serialItem ? `<span style="color:#b3263a">Needed: scan or tap to type the serial of the damaged unit</span>` : "Type it, or scan the serial barcode";
  card.innerHTML = `<div class="dmghead"><h2>Report Damage, Loss or Discrepancy</h2><div class="meta">Log broken components or missing stock for audit</div></div>
    <button class="field" id="dmgItem"><div class="lbl">Stock Item / Component</div><div class="val${item ? "" : " empty"}">${item ? `${esc(item.name || "(no name)")} <small style="font-weight:500;color:var(--muted)">(SKU: ${esc(item.SKU || "-")}) \u2014 Available: ${recorded(item)}</small>` : "Tap to choose an item, or scan its barcode"}</div></button>
    ${item ? `<div class="meta" style="margin-top:-4px">Current stock on hand: <b>${recorded(item)}</b>${offSite(item) ? ` (+${offSite(item)} off site)` : ""} \u00b7 Location: ${esc(item.location || "-")}</div>` : ""}
    <button class="field" id="dmgSerial"><div class="lbl">Serial number <span style="font-weight:500">(if the unit has one)</span></div><div class="val${dmg.unit || dmg.serialText ? "" : " empty"}">${serialVal}</div></button>
    <div class="dmgrow">
      <div><div class="lbl dmglbl">Quantity Affected</div>
        <div class="counter dmgqty"><button id="dmgMinus" ${oneUnit ? "disabled" : ""}>&minus;</button><button class="num" id="dmgNum"><b>${oneUnit ? 1 : dmg.qty}</b></button><button id="dmgPlus" ${oneUnit ? "disabled" : ""}>+</button></div>
        ${oneUnit ? `<div class="meta" style="font-size:13px">One unit per serial number</div>` : ""}</div>
      <div style="flex:1"><div class="lbl dmglbl">Category / Reason</div>
        <div class="dmgwhy" id="dmgWhy">${Object.entries(DAMAGE_REASONS).map(([k, t]) => `<button data-v="${k}" class="${dmg.reason === k ? "on" : ""}">${esc(t)}</button>`).join("")}</div></div>
    </div>
    <button class="field" id="dmgNote"><div class="lbl">Notes / Details</div><div class="val${dmg.note ? "" : " empty"}">${dmg.note ? esc(dmg.note) : "Describe what happened (e.g. screen cracked, card reader failed QC test)\u2026"}</div></button>
    ${dmg.msg ? `<div class="bookmsg ${dmg.msg.tone}">${dmg.msg.text}</div>` : ""}
    <div class="takebtns"><button class="ghost" id="dmgCancel" style="min-height:66px">Cancel</button><button class="print dmgsave" id="dmgSave" ${ready && !dmg.busy ? "" : "disabled"}>&#128737; Log Damage &amp; Print Label</button></div>`;
  $("#dmgItem").onclick = () => { pickForTake = true; stockSearch = ""; openStock("take"); };
  $("#dmgSerial").onclick = () => { searchTarget = "dmgserial"; serialTyped = dmg.unit ? "" : dmg.serialText; drawTyper(); $("#typer").classList.add("on"); };
  $("#dmgMinus").onclick = () => { dmg.qty = Math.max(1, dmg.qty - 1); drawTake(); poke(); };
  $("#dmgPlus").onclick = () => { dmg.qty = Math.min(9999, dmg.qty + 1); drawTake(); poke(); };
  card.querySelectorAll("#dmgWhy button").forEach((b) => (b.onclick = () => { dmg.reason = b.dataset.v; drawTake(); poke(); }));
  $("#dmgNote").onclick = () => { searchTarget = "dmgnote"; drawTyper(); $("#typer").classList.add("on"); };
  $("#dmgCancel").onclick = () => { dmg = { ...dmgFresh(), reason: dmg.reason }; drawTake(); };
  $("#dmgSave").onclick = dmgSave;
}
async function dmgSave() {
  if (dmg.busy || !dmg.item) return;
  dmg.busy = true;
  overlay("Logging the damage…", dmg.item.name, false, true);
  try {
    const serial = dmg.unit ? dmg.unit.serial_number : dmg.serialText.trim();
    const log = await S.recordDamage(dmg.item.id, serial ? 1 : dmg.qty, dmg.reason, dmg.note.trim(), serial);
    dmg = { ...dmgFresh(), reason: dmg.reason, saved: log };
    takeSession.unshift({ name: log.item_name, what: `Damage ${log.ref_code}: ${log.quantity} off stock (${DAMAGE_REASONS[log.reason_category] || log.reason_category})`, time: hhmm(), bad: false, undo: null });
    hideOverlay(); drawTake();
    dmgPrint();
  } catch (e) {
    dmg.busy = false;
    overlay("Couldn't log the damage", friendlyError(e), true);
    drawTake();
  }
}
async function dmgPrint() {
  if (!dmg.saved) return;
  if (await doPrint("damage", dmgLabelValues(dmg.saved), 1)) setTimeout(hideOverlay, 1100);
}

async function takeScan(code) {
  if (takeMode === "bookin") { bookScan(code); return; }
  if (takeMode === "spot") { spotScan(code); return; }
  if (takeMode === "damage") { dmgScan(code); return; }
  if (takeMode === "offsite") { offScan(code); return; }
  if (!code || takeBusy) return;
  const found = await S.findItemOrSerial(code);
  const item = found && found.item;
  if (!item) {
    overlay("Not in the stock app", `Nothing has the code ${code}.`, false, false, { label: "Add it as a new item", run: () => openNewItem({ barcode: code }) });
    return;
  }
  if (item.tracking_type === "serial") { takeStart(item); return; }
  if (takeItem && takeItem.id === item.id) { takeCount++; drawTake(); poke(); return; }
  if (takeItem && !(await takeSave(true))) return;
  takeStart(item);
}
const hhmm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** Save the item being counted. Returns false if it couldn't be saved. */
async function takeSave(auto = false) {
  if (!takeItem) return true;
  const item = takeItem, n = takeCount, mode = takeMode, loc = takeLoc.trim();
  const moveTo = loc && loc !== (item.location || "").trim() ? loc : "";
  const noChange = mode === "take" ? n === recorded(item) : n === 0;
  if (noChange) {
    if (moveTo) {
      try { await S.setLocation(item.id, moveTo); } catch (e) { overlay("Couldn't change the location", friendlyError(e), true); return false; }
    }
    takeSession.unshift({ name: item.name, what: `${MODE_TEXT[mode].name}: no change (${recorded(item)})${moveTo ? ` · moved to ${moveTo}` : ""}`, time: hhmm() });
    takeItem = null; drawTake(); return true;
  }
  takeBusy = true;
  overlay("Saving…", item.name, false, true);
  try {
    const r = mode === "take" ? await S.saveCount(item, n) : mode === "add" ? await S.addStock(item, n) : await S.removeStock(item, n);
    let moved = "";
    if (moveTo) {
      try { await S.setLocation(item.id, moveTo); moved = ` · moved to ${moveTo}`; } catch (e) { moved = ` · location not changed (${friendlyError(e)})`; }
    }
    takeSession.unshift({ name: item.name, what: `${MODE_TEXT[mode].name}: ${r.oldQty} \u2192 ${r.newQty}${moved}`, time: hhmm(),
      undo: { kind: "adjust", itemId: item.id, delta: r.newQty - r.oldQty, label: `${MODE_TEXT[mode].name} ${r.oldQty} \u2192 ${r.newQty}` } });
    takeItem = null; drawTake();
    overlay("Saved \u2713", `${item.name}: ${r.oldQty} \u2192 ${r.newQty}${moved}`, false, true);
    setTimeout(hideOverlay, auto ? 700 : 1000);
    return true;
  } catch (e) {
    overlay("Couldn't save", `${item.name}: ${friendlyError(e)}`, true);
    return false;
  } finally { takeBusy = false; }
}
document.querySelectorAll("#takeModes button").forEach((b) => (b.onclick = async () => {
  if (b.dataset.m === takeMode) return;
  if (takeItem && !(await takeSave(true))) return;
  takeMode = b.dataset.m; bookItem = null; bookMsg = null; bookRef = ""; drawTake();
}));
$("#takeFind").onclick = () => { pickForTake = true; stockSearch = ""; openStock("take"); };
$("#takeNew").onclick = () => openNewItem({});
// Leaving the stock screens saves any count in progress first.
async function leaveToHome() { if (takeItem && !(await takeSave(true))) return; pickForTake = false; home(); }

// New item form
let niTracking = "quantity", niPrintAfter = true, niEditId = null, niPhoto = "";
const NEW_OPT = "__new__";
function fillSelect(sel, options, current) {
  sel.innerHTML = options.map((o) => `<option${o === current ? " selected" : ""}>${esc(o)}</option>`).join("") +
    `<option value="${NEW_OPT}">+ New…</option>`;
}
function openNewItem(prefill) { openItemForm(null, prefill); }
function openEditItem(item) { openItemForm(item, {}); }
// One form for adding a new item and for editing an existing one.
function openItemForm(item, prefill) {
  niEditId = item ? item.id : null;
  $("#hdrTitle").textContent = item ? "Edit stock item" : "New stock item"; show("newitem"); poke();
  document.querySelectorAll("#newitem .newonly").forEach((el) => (el.style.display = item ? "none" : ""));
  $("#niSave").textContent = item ? "SAVE CHANGES" : "SAVE TO STOCK";
  $("#niName").value = item ? item.name || "" : prefill.name || "";
  $("#niSku").value = item ? item.SKU || "" : S.suggestSku();
  $("#niBarcode").value = item ? item.barcode || "" : prefill.barcode || "";
  const cats = S.categories.length ? S.categories : ["General"], locs = S.locations.length ? S.locations : ["Bin A-1"];
  const withCurrent = (list, v) => (v && !list.includes(v) ? [...list, v].sort() : list);
  fillSelect($("#niCat"), withCurrent(cats, item && item.category), item ? item.category : cats.includes("General") ? "General" : cats[0]);
  fillSelect($("#niLoc"), withCurrent(locs, item && item.location), item ? item.location : locs[0]);
  niPhoto = item ? item.image_url || "" : "";
  $("#niCatNew").style.display = $("#niLocNew").style.display = "none";
  $("#niCatNew").value = $("#niLocNew").value = "";
  $("#niQty").value = "0"; $("#niReorder").value = "5"; $("#niNotes").value = item ? item.notes || "" : "";
  niTracking = "quantity"; drawNewItem();
  setTimeout(() => $("#niName").focus(), 50);
}
const pick = (sel, other) => (sel.value === NEW_OPT ? other.value.trim() : sel.value);
function newItemInput() {
  return {
    name: $("#niName").value, SKU: $("#niSku").value, barcode: $("#niBarcode").value,
    category: pick($("#niCat"), $("#niCatNew")), location: pick($("#niLoc"), $("#niLocNew")),
    tracking_type: niTracking, quantity_on_hand: $("#niQty").value, reorder_threshold: $("#niReorder").value, notes: $("#niNotes").value,
    image_url: niPhoto,
  };
}
function drawNewItem() {
  // A serial-tracked product starts at 0: its units are booked in by serial afterwards
  $("#niQty").disabled = niTracking === "serial";
  if (niTracking === "serial") $("#niQty").value = "0";
  $("#niPhoto").style.backgroundImage = niPhoto ? `url("${niPhoto}")` : "";
  $("#niPhoto").textContent = niPhoto ? "" : "No photo";
  $("#niPhotoBtn").innerHTML = niPhoto ? "&#128247; Change photo" : "&#128247; Add photo";
  $("#niPhotoDel").style.display = niPhoto ? "" : "none";
  document.querySelectorAll("#niTrack button").forEach((b) => b.classList.toggle("on", b.dataset.v === niTracking));
  $("#niPrintAfter button").classList.toggle("on", niPrintAfter);
  $("#niPrintAfter button").textContent = niPrintAfter ? "\u2713 Print label after saving" : "Don't print a label";
  const v = newItemInput();
  $("#niPreview").replaceChildren(makeLabel("stock", { name: v.name, location: v.location, code: (v.barcode || v.SKU).trim() }).canvas);
}
["niName", "niSku", "niBarcode", "niCatNew", "niLocNew", "niQty", "niReorder"].forEach((id) => ($("#" + id).oninput = () => { poke(); drawNewItem(); }));
$("#niBarcode").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); $("#niQty").focus(); } }; // scanner presses Enter
[["niCat", "niCatNew"], ["niLoc", "niLocNew"]].forEach(([sel, other]) => ($("#" + sel).onchange = () => {
  const isNew = $("#" + sel).value === NEW_OPT;
  $("#" + other).style.display = isNew ? "" : "none";
  if (isNew) $("#" + other).focus();
  drawNewItem();
}));
document.querySelectorAll("#niTrack button").forEach((b) => (b.onclick = (e) => { e.preventDefault(); niTracking = b.dataset.v; drawNewItem(); }));
$("#niPrintAfter button").onclick = (e) => { e.preventDefault(); niPrintAfter = !niPrintAfter; drawNewItem(); };
$("#niScan").onclick = (e) => { e.preventDefault(); scanWithCamera((code) => { $("#niBarcode").value = code.trim(); drawNewItem(); }); };
// Photos: the same size and format the stock app uses (up to 600 x 600, JPEG 80%).
function shrinkPhoto(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const k = Math.min(1, 600 / img.width, 600 / img.height);
      const c = document.createElement("canvas");
      c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/jpeg", 0.8));
    };
    img.onerror = () => reject(new Error("That picture couldn't be read."));
    img.src = dataUrl;
  });
}
async function usePhoto(dataUrl) {
  try { niPhoto = await shrinkPhoto(dataUrl); drawNewItem(); }
  catch (e) { overlay("Couldn't use that photo", e.message, true); }
}
$("#niPhotoBtn").onclick = async (e) => {
  e.preventDefault(); poke();
  if (NATIVE && window.Capacitor.Plugins.Camera) {
    try {
      const photo = await window.Capacitor.Plugins.Camera.getPhoto({
        quality: 80, resultType: "dataUrl", source: "PROMPT", width: 1200, correctOrientation: true,
        promptLabelHeader: "Product photo", promptLabelPhoto: "Choose from the gallery", promptLabelPicture: "Take a photo",
      });
      if (photo && photo.dataUrl) usePhoto(photo.dataUrl);
    } catch (err) { if (!/cancel/i.test(err && err.message)) overlay("Camera not available", (err && err.message) || "", true); }
    return;
  }
  $("#niPhotoFile").value = ""; $("#niPhotoFile").click();
};
$("#niPhotoFile").onchange = () => {
  const f = $("#niPhotoFile").files[0]; if (!f) return;
  const r = new FileReader(); r.onload = () => usePhoto(r.result); r.readAsDataURL(f);
};
$("#niPhotoDel").onclick = (e) => { e.preventDefault(); niPhoto = ""; drawNewItem(); };

$("#niSave").onclick = async () => {
  const input = newItemInput();
  const problem = S.check(input, niEditId) || (!input.category ? "Type the new category name." : !input.location ? "Type the new location name." : null);
  if (problem) { overlay("Check the details", problem, true); return; }
  overlay(niEditId ? "Saving changes to Payaz Stock…" : "Saving to Payaz Stock…", "", false, true);
  let item;
  if (niEditId) {
    try { item = await S.updateItem(niEditId, input); }
    catch (e) { overlay("Couldn't save", friendlyError(e), true); return; }
    if (niPrintAfter) {
      if (await doPrint("stock", stockLabelValues(item), 1)) overlay("Saved and printed \u2713", `${item.name} is updated in the stock app.`, false, true);
      else return;
    } else overlay("Changes saved \u2713", `${item.name} is updated in the stock app.`, false, true);
    setTimeout(() => { hideOverlay(); stockSearch = ""; openStock(); }, 1400);
    return;
  }
  try { item = await S.addItem(input); }
  catch (e) { overlay("Couldn't save", friendlyError(e), true); return; }
  takeSession.unshift({ name: item.name, what: `New item added (${item.quantity_on_hand} in stock)`, time: hhmm() });
  if (niPrintAfter) {
    if (await doPrint("stock", stockLabelValues(item), 1)) overlay("Saved and printed \u2713", `${item.name} is in the stock app.`, false, true);
    else return; // print error is showing; the item is saved
  } else overlay("Saved to Payaz Stock \u2713", `${item.name} (SKU ${item.SKU})`, false, true);
  setTimeout(() => { hideOverlay(); stockSearch = ""; openStock(); }, 1400);
};

/* ---------- log screen ---------- */
let search = "";
function openLog() { search = ""; $("#hdrTitle").textContent = "Log"; show("log"); drawLog(); poke(); }
function setSearch(v) { search = v.slice(0, 40); drawLog(); poke(); }
function drawLog() {
  const q = search.trim().toLowerCase();
  const all = loadLog().slice().reverse(); // newest first
  const rows = all.filter((e) => !q || [e.order, e.sumup, e.tablet].some((v) => (v || "").toLowerCase().includes(q)));
  $("#searchText").innerHTML = search ? `<b>${esc(search)}</b>` : '<span class="ph">Scan or tap to search (order, reader or tablet)</span>';
  $("#clearSearch").style.display = search ? "" : "none";
  $("#logCount").textContent = q ? `${rows.length} of ${all.length} labels` : `${all.length} label${all.length === 1 ? "" : "s"} printed`;
  $("#logBody").innerHTML = rows.map((e) => {
    const r = logRow(e);
    return `<tr class="row" data-ts="${esc(e.ts)}"><td>${esc(r.order || "-")}</td><td>${r.date}</td><td>${esc(r.sumup || "-")}</td>` +
      `<td>${esc(r.tablet || "-")}</td><td class="${r.expired ? "exp" : ""}">${r.warranty}${r.expired ? " (expired)" : ""}</td></tr>`;
  }).join("");
  $("#logEmpty").textContent = rows.length ? "" : all.length ? "Nothing matches that search." : "No labels printed yet. Order labels appear here when you print them.";
  $("#logBody").querySelectorAll("tr").forEach((tr) => (tr.onclick = () => {
    const e = all.find((x) => x.ts === tr.dataset.ts), r = logRow(e);
    overlay(`Order ${r.order || "(none)"}`, `Printed ${r.date} · Reader ${r.sumup || "-"} · Tablet ${r.tablet || "-"} · Warranty until ${r.warranty}`, false, false,
      { label: "Delete this entry", run: () => { deleteLogEntry(e.ts); drawLog(); } });
  }));
}
$("#clearSearch").onclick = () => setSearch("");
$("#exportBtn").onclick = async () => {
  if (!loadLog().length) { overlay("Nothing to export yet", "Print an order label first."); return; }
  try { await exportCsv(); }
  catch (e) { if (!/cancel/i.test(e && e.message)) overlay("Couldn't export", (e && e.message) || String(e), true); }
};
// Search typing pop-up
let searchTarget = "log", serialTyped = "";
const typerValue = () => (searchTarget === "offtaken" ? off.takenBy || "" : searchTarget === "offplace" ? off.place : searchTarget === "offserial" ? serialTyped : searchTarget === "dmgnote" ? dmg.note : searchTarget === "dmgserial" ? serialTyped : searchTarget === "spot" ? String(spot.count) : searchTarget === "location" ? locTyped : searchTarget === "bookref" ? bookRef : searchTarget === "serial" ? serialTyped : searchTarget === "count" ? String(takeCount) : searchTarget === "stock" ? stockSearch : search);
const typerSet = (v) => {
  if (searchTarget === "offplace") { off.place = v.slice(0, 60); drawTake(); return; }
  if (searchTarget === "offtaken") { off.takenBy = v.slice(0, 60); drawTake(); return; }
  if (searchTarget === "serial" || searchTarget === "dmgserial" || searchTarget === "offserial") { serialTyped = v.toUpperCase().slice(0, 40); return; }
  if (searchTarget === "dmgnote") { dmg.note = v.slice(0, 200); drawTake(); return; }
  if (searchTarget === "location") { locTyped = v.slice(0, 60); return; }
  if (searchTarget === "spot") { spot.count = Math.min(99999, parseInt(v.replace(/\D/g, ""), 10) || 0); drawTake(); return; }
  if (searchTarget === "bookref") { bookRef = v.toUpperCase().slice(0, 60); drawTake(); return; }
  if (searchTarget === "count") { takeCount = Math.min(99999, parseInt(v.replace(/\D/g, ""), 10) || 0); drawTake(); return; }
  return searchTarget === "stock" ? setStockSearch(v) : setSearch(v);
};
$("#searchBtn").onclick = () => { searchTarget = "log"; drawTyper(); $("#typer").classList.add("on"); };
function drawTyper() {
  $("#typerShown").textContent = typerValue() || " ";
  buildKbd($("#typerKbd"), { doneKey: true, current: typerValue() });
}
onKey($("#typerKbd"), (b) => {
  const k = b.dataset.k, c = b.dataset.c;
  if (k === "DONE") {
    $("#typer").classList.remove("on");
    if (searchTarget === "serial" && serialTyped.trim()) bookScan(serialTyped);
    if (searchTarget === "offserial" && serialTyped.trim()) offScan(serialTyped.trim());
    if (searchTarget === "dmgserial") { if (serialTyped.trim()) dmgScan(serialTyped.trim()); else if (dmg.item && !dmg.unit) { dmg.serialText = ""; drawTake(); } }
    if (searchTarget === "location" && locTyped.trim() && locDone) locDone(locTyped.trim());
    return;
  }
  const cur = typerValue();
  if (k === "CASE") caseMode = nextCase();
  else if (k === "DEL") typerSet(cur.slice(0, -1));
  else if (k === "SPACE") typerSet(cur + " ");
  else typerSet(cur + (capsNext(cur) ? c : c.toLowerCase()));
  drawTyper();
});
$("#typer").onclick = (e) => { if (e.target.id === "typer") $("#typer").classList.remove("on"); };
$("#backBtn").onclick = async () => {
  if ($("#addme").classList.contains("on")) { await S.cancelPerson(); return showWho(); }
  if ($("#newitem").classList.contains("on")) return openStock();
  if ($("#stock").classList.contains("on") && pickForTake) { pickForTake = false; return openStock("take"); }
  if ($("#stock").classList.contains("on")) return leaveToHome();
  home();
};
$("#setBtn").onclick = openSettings;

/* ---------- tablet niceties ---------- */
// Back to the start screen after 3 minutes of no use
let lockTimer = null;
function poke() {
  clearTimeout(idleTimer); clearTimeout(lockTimer);
  idleTimer = setTimeout(async () => {
    if (!S.person) return;
    if (takeItem && !(await takeSave(true))) return; // keep an unsaved count on screen if saving failed
    hideOverlay(); closeCamera(); closeSheet(); $("#buildSheet").classList.remove("on"); pickForTake = false; home();
  }, Math.min(180000, settings.lockMins * 60000 - 1000));
  if (S.person) lockTimer = setTimeout(() => lockNow(true), settings.lockMins * 60000);
}
document.addEventListener("pointerdown", poke);
document.addEventListener("contextmenu", (e) => e.preventDefault());
// Keep the screen on while the app is open
async function keepAwake() {
  try {
    if (NATIVE && window.Capacitor.Plugins.KeepAwake) await window.Capacitor.Plugins.KeepAwake.keepAwake();
    else if ("wakeLock" in navigator) await navigator.wakeLock.request("screen");
  } catch (e) {}
}
keepAwake();
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") keepAwake(); });
// Work offline once loaded
if (!NATIVE && "serviceWorker" in navigator && location.protocol === "https:") navigator.serviceWorker.register("sw.js").catch(() => {});

// Load the label font before drawing any label
const face = new FontFace(LABEL_FONT, "url(fonts/AtkinsonHyperlegible-Bold.ttf)");
face.load().then((f) => document.fonts.add(f)).catch(() => {}).finally(() => { if (active) render(); });

/* ---------- Production (Payaz Stock's Production Floor tiles) ---------- */
// The same tiles as the website. Tap one (e.g. Giving Station), choose how many and
// Build: all its parts come off stock under your name. Tablets and card readers aren't
// in tiles: they go out on the Order Label (Next: Order Label).
let prodTiles = [], bsTile = null, bsQty = 1, bsBusy = false;
const prodSession = [];
const canBuild = (t) => {
  const r = (t.recipe || []).filter((x) => x && x.item_id && Number(x.quantity_per_unit) > 0);
  if (!r.length || r.some((x) => { const it = S.items.find((i) => i.id === x.item_id); return !it || it.tracking_type === "serial"; })) return 0;
  return Math.max(0, Math.min(...r.map((x) => { const it = S.items.find((i) => i.id === x.item_id); return Math.floor(onSite(it) / x.quantity_per_unit); })));
};
async function openProd() {
  $("#hdrTitle").textContent = "Production"; show("prod"); poke();
  overlay("Loading…", "", false, true);
  try {
    const [tiles] = await Promise.all([S.productionTiles(), S.items.length ? null : S.refresh()]);
    prodTiles = tiles; hideOverlay();
  } catch (e) { overlay("Couldn't load Production Floor", friendlyError(e), true); }
  drawProd();
}
function drawProd() {
  $("#prodGrid").className = `prodgrid size-${settings.prodSize}`;
  $("#prodSmaller").disabled = settings.prodSize <= 1; $("#prodBigger").disabled = settings.prodSize >= 4;
  $("#prodGrid").innerHTML = prodTiles.map((t) => {
    const n = canBuild(t), hasParts = (t.recipe || []).length > 0;
    const serialPart = (t.recipe || []).some((x) => { const it = S.items.find((i) => i.id === x.item_id); return it && it.tracking_type === "serial"; });
    const badge = !hasParts ? `<div class="cb none">No parts set up</div>` : serialPart ? `<div class="cb warn">Has a tablet or card reader: ask a manager</div>` : `<div class="cb ${n ? "" : "none"}">${n} ready</div>`;
    return `<button class="ptile" data-id="${esc(t.id)}"><div class="pic">${tilePic(t)}</div><div class="nm">${esc(t.name || "(no name)")}</div>${badge}</button>`;
  }).join("");
  $("#prodEmpty").textContent = prodTiles.length ? "" : "No Production Floor tiles yet. Set them up on the website: Payaz Stock > Production Floor.";
  $("#prodGrid").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => openBuild(prodTiles.find((t) => t.id === b.dataset.id))));
  $("#prodSession").innerHTML = `<h4>BUILT THIS SESSION</h4>` + (prodSession.length ? prodSession.map((x, i) =>
    `<div class="it${x.undone ? " undone" : ""}"><div class="itrow"><span>${x.qty} \u00d7 ${esc(x.name)}<small>${esc(x.what)} \u00b7 ${x.time}</small></span>` +
    (x.undone ? "" : `<button class="undo" data-undo="${i}">Undo</button>`) + `</div></div>`).join("") : `<div class="it"><small>Nothing built yet.</small></div>`);
  $("#prodSession").querySelectorAll("[data-undo]").forEach((b) => (b.onclick = () => undoBuildEntry(prodSession[+b.dataset.undo])));
}
// The tile's picture from Payaz Stock (a box if it has none or it won't load)
const tilePic = (t) => t.image_url && /^(https?:|data:image\/)/i.test(t.image_url)
  ? `<img src="${esc(t.image_url)}" alt="" onerror="this.replaceWith(document.createTextNode('\u{1F4E6}'))">` : "&#128230;";
function openBuild(t) {
  if (!t) return;
  bsTile = t; bsQty = 1; drawBuild(); $("#buildSheet").classList.add("on"); poke();
}
function drawBuild() {
  const t = bsTile, recipe = (t.recipe || []).filter((x) => x && x.item_id && Number(x.quantity_per_unit) > 0);
  let short = false, serial = false;
  $("#bsName").textContent = t.name || "(no name)";
  $("#bsPic").innerHTML = tilePic(t);
  $("#bsMeta").textContent = recipe.length ? `${recipe.length} part${recipe.length === 1 ? "" : "s"} \u00b7 ${canBuild(t)} ready with the stock there is now` : "";
  $("#bsParts").innerHTML = recipe.map((x) => {
    const it = S.items.find((i) => i.id === x.item_id), have = onSite(it), need = x.quantity_per_unit * bsQty;
    const bad = !it || have < need || (it && it.tracking_type === "serial");
    if (bad) short = true; if (it && it.tracking_type === "serial") serial = true;
    return `<tr class="${bad ? "short" : ""}"><td>${esc(it ? it.name : "Part no longer in the stock app")}</td><td class="n">${x.quantity_per_unit}</td><td class="n">${need}</td><td class="n">${it ? have : "-"}</td></tr>`;
  }).join("");
  $("#bsQty").textContent = bsQty;
  $("#bsMsg").className = "bookmsg" + (short || !recipe.length ? " bad" : "");
  $("#bsMsg").textContent = !recipe.length ? "No parts set up for this tile yet. Add them on the website: Payaz Stock > Production Floor."
    : serial ? "A part tracked by serial number is in this tile. Those go out on the Order Label: ask a manager to take it out of the tile."
    : short ? `Not enough of the parts in red to build ${bsQty}.` : `Tapping Build takes these parts off stock under ${S.userName}.`;
  $("#bsBuild").disabled = short || !recipe.length || bsBusy;
}
$("#bsMinus").onclick = () => { bsQty = Math.max(1, bsQty - 1); drawBuild(); poke(); };
$("#bsPlus").onclick = () => { bsQty = Math.min(99, bsQty + 1); drawBuild(); poke(); };
$("#bsCancel").onclick = () => $("#buildSheet").classList.remove("on");
$("#buildSheet").onclick = (e) => { if (e.target.id === "buildSheet") $("#buildSheet").classList.remove("on"); };
$("#bsBuild").onclick = async () => {
  if (bsBusy || !bsTile) return;
  bsBusy = true; drawBuild();
  overlay(`Building ${bsQty} \u00d7 ${bsTile.name}…`, "", false, true);
  try {
    const log = await S.buildTile(bsTile, bsQty);
    $("#buildSheet").classList.remove("on");
    prodSession.unshift({ id: log.id, name: log.tile_name, qty: log.quantity_built, what: `${log.deductions.length} parts off stock`, time: hhmm() });
    drawProd();
    overlay(`Built ${log.quantity_built} \u00d7 ${log.tile_name} \u2713`, `Saved: these parts have been taken off stock and the build is logged.\n${log.deductions.map((d) => `${d.item_name} \u2212${d.quantity_deducted}`).join("\n")}\n\nBuild more, or go on to the tablet and card reader on the Order Label.`, false, false,
      { label: "Next: Order Label", closeLabel: "Back to Production", run: () => openMode("order") });
  } catch (e) {
    overlay("Couldn't build", friendlyError(e), true);
    try { await S.refresh(); } catch (e2) {}
    drawProd(); if ($("#buildSheet").classList.contains("on")) drawBuild();
  } finally { bsBusy = false; }
};
async function undoBuildEntry(x) {
  if (!x || x.undone) return;
  overlay(`Undo ${x.qty} \u00d7 ${x.name}?`, "Its parts go back into stock.", false, false, { label: "Undo", run: async () => {
    overlay("Undoing…", "", false, true);
    try { await S.undoBuild(x.id); x.undone = true; x.what = "Undone: parts back in stock"; overlay("Undone \u2713", "", false, true); setTimeout(hideOverlay, 900); }
    catch (e) { overlay("Couldn't undo", friendlyError(e), true); }
    drawProd();
  } });
}
$("#prodRefresh").onclick = () => openProd();
$("#prodSmaller").onclick = () => { saveSettings({ prodSize: Math.max(1, settings.prodSize - 1) }); drawProd(); poke(); };
$("#prodBigger").onclick = () => { saveSettings({ prodSize: Math.min(4, settings.prodSize + 1) }); drawProd(); poke(); };
$("#prodOrder").onclick = () => openMode("order");

/* ---------- who's using the tablet (PIN sign-in) ---------- */
// Each person adds themselves once (email + password, then a 4-digit PIN). After
// that they tap their name and enter their PIN, and everything they do is saved
// under their name. The tablet locks after a few minutes untouched.
let pin = { mode: "unlock", id: null, name: "", digits: "", first: "", msg: "", bad: false, forgot: false };
const initials = (n) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join("") || "?";
function showWho() {
  $("#pinPad").classList.remove("on"); $("#typer").classList.remove("on"); $("#locPick").classList.remove("on"); $("#buildSheet").classList.remove("on");
  closeSheet(); closeCamera();
  $("#hdrTitle").textContent = "Label Station";
  show("who"); drawWho();
  // Names added on other tablets (shared sign-in)
  S.refreshPeople().then(() => { if ($("#who").classList.contains("on")) drawWho(); });
}
function drawWho() {
  const people = S.people();
  $("#whoGrid").innerHTML = people.map((p) => `<button class="whoname" data-id="${esc(p.id)}"><span class="av">${esc(initials(p.name))}</span>${esc(p.name)}</button>`).join("") +
    `<button class="whoname add" id="whoAdd"><span class="av">+</span>Add me</button>`;
  $("#whoGrid").querySelectorAll("[data-id]").forEach((b) => (b.onclick = () => {
    const p = people.find((x) => x.id === b.dataset.id);
    openPin("unlock", { id: p.id, name: p.name, email: p.email });
  }));
  $("#whoAdd").onclick = () => openAddMe();
  $("#whoConnectBox").style.display = S.connected ? "none" : "flex";
}
$("#whoConnect").onclick = () => openAddMe("", "", "connect");
/** Lock the tablet: save any count in progress, then "Who's using the tablet?". */
async function lockNow(idle = false) {
  if (!S.person) return;
  if (takeItem && !(await takeSave(true))) { if (!idle) return; }
  takeItem = null; bookItem = null; pickForTake = false;
  if (takeMode === "damage") dmg = dmgFresh();
  off = offFresh();
  Object.keys(vals).forEach((k) => (vals[k] = ""));
  hideOverlay();
  S.lock();
  showWho();
}
$("#whoBtn").onclick = () => lockNow();
function openPin(mode, extra = {}) {
  pin = { ...pin, mode, digits: "", msg: "", bad: false, ...extra };
  drawPin(); $("#pinPad").classList.add("on");
}
function drawPin() {
  $("#ppName").textContent = pin.mode === "unlock" ? pin.name : pin.mode === "choose" ? "Choose a 4-digit PIN" : "Enter the same PIN again";
  $("#ppMsg").textContent = pin.msg || (pin.mode === "unlock" ? "Enter your PIN" : pin.mode === "choose" ? `For ${pin.name}. Don't use 1234 or your birthday.` : "");
  $("#ppMsg").className = "pinmsg" + (pin.bad ? " bad" : "");
  $("#ppDots").innerHTML = [0, 1, 2, 3].map((i) => `<span class="${i < pin.digits.length ? "on" : ""}"></span>`).join("");
  $("#ppKeys [data-k=FORGOT]").style.visibility = pin.mode === "unlock" ? "visible" : "hidden";
}
function pinShake(msg) {
  pin.digits = ""; pin.msg = msg; pin.bad = true; drawPin();
  const d = $("#ppDots"); d.classList.remove("shake"); void d.offsetWidth; d.classList.add("shake");
}
let pinBusy = false;
onKey($("#ppKeys"), async (b) => {
  if (pinBusy) return;
  const k = b.dataset.k || b.textContent.trim();
  if (k === "FORGOT") { $("#pinPad").classList.remove("on"); openAddMe(pin.email, "Forgot your PIN? Sign in with your password to choose a new one."); return; }
  if (k === "DEL") { pin.digits = pin.digits.slice(0, -1); drawPin(); return; }
  if (!/^\d$/.test(k) || pin.digits.length >= 4) return;
  pin.digits += k; pin.bad = false; drawPin();
  if (pin.digits.length < 4) return;
  pinBusy = true;
  try { await pinEntered(); } finally { pinBusy = false; }
});
async function pinEntered() {
  if (pin.mode === "unlock") {
    pin.msg = "Checking…"; drawPin();
    try {
      await S.unlock(pin.id, pin.digits);
      $("#pinPad").classList.remove("on"); home(); poke();
    } catch (e) {
      if (e.code === "needs-password") { $("#pinPad").classList.remove("on"); openAddMe(pin.email, e.message); }
      else if (e.code === "wrong-pin") pinShake(e.message);
      else { $("#pinPad").classList.remove("on"); overlay("Couldn't sign in", friendlyError(e), true); drawWho(); }
    }
    return;
  }
  if (pin.mode === "choose") {
    if (/^(\d)\1{3}$/.test(pin.digits) || ["1234", "4321", "0123"].includes(pin.digits)) { pinShake("That PIN is too easy to guess. Choose another."); return; }
    pin.first = pin.digits; pin.mode = "confirm"; pin.digits = ""; pin.msg = ""; drawPin(); return;
  }
  if (pin.digits !== pin.first) { pin.mode = "choose"; pinShake("Those didn't match. Choose your PIN again."); return; }
  try {
    const p = await S.finishPerson(pin.digits);
    await S.unlock(p.id, pin.digits);
    $("#pinPad").classList.remove("on");
    overlay(`Hello ${p.name.split(" ")[0]} \u2713`, "Next time, just tap your name and enter your PIN.", false, true);
    setTimeout(hideOverlay, 1600);
    home(); poke();
  } catch (e) {
    $("#pinPad").classList.remove("on"); overlay("Couldn't save your PIN", friendlyError(e), true); showWho();
  }
}
$("#ppCancel").onclick = async () => {
  $("#pinPad").classList.remove("on");
  if (pin.mode !== "unlock") { await S.cancelPerson(); showWho(); }
};
let addMode = "person"; // "person": add yourself / new PIN; "connect": a manager connects this tablet
function openAddMe(email = "", note = "", mode = "person") {
  addMode = mode;
  $("#amTitle").textContent = mode === "connect" ? "Connect this tablet" : email ? "Sign in with your password" : "Add yourself to this tablet";
  $("#amSub").textContent = mode === "connect"
    ? "A manager (an admin, or someone ticked for the damage box) signs in once with their Payaz Stock email and password. After that, everyone with a PIN can use it on this tablet too."
    : note || "Sign in once with your Payaz Stock email and password. Then you choose a 4-digit PIN to use from now on, on every connected tablet.";
  $("#amNext").textContent = mode === "connect" ? "Connect this tablet" : "Next: choose your PIN";
  $("#amEmail").value = email; $("#amEmail").readOnly = !!email; $("#amPass").value = "";
  $("#hdrTitle").textContent = mode === "connect" ? "Connect tablet" : email ? "New PIN" : "Add me";
  show("addme");
  setTimeout(() => (email ? $("#amPass") : $("#amEmail")).focus(), 50);
}
$("#amNext").onclick = async () => {
  const email = $("#amEmail").value.trim(), pass = $("#amPass").value;
  if (!email || !pass) { overlay("Enter your email and password", "", true); return; }
  if (addMode === "connect") {
    overlay("Connecting this tablet…", "", false, true);
    try {
      await S.connectTablet(email, pass, "Label Station tablet");
      $("#amPass").value = ""; addMode = "person";
      showWho();
      overlay("Tablet connected \u2713", "Everyone with a PIN now shows here. People added on this tablet before are shared the next time they enter their PIN.", false, false);
    } catch (e) { overlay("Couldn't connect the tablet", friendlyError(e), true); }
    return;
  }
  overlay("Checking…", "", false, true);
  try {
    const p = await S.checkPerson(email, pass);
    $("#amPass").value = ""; hideOverlay();
    openPin("choose", { name: p.name, email, first: "" });
  } catch (e) { overlay("Couldn't sign in", friendlyError(e), true); }
};
$("#amPass").onkeydown = (e) => { if (e.key === "Enter") $("#amNext").click(); };
$("#amForgot").onclick = async () => {
  const email = $("#amEmail").value.trim();
  if (!email) { overlay("Type your email first", "Then tap this again and we'll email you a link to set a password.", true); return; }
  try { await S.resetPassword(email); overlay("Check your email", `If ${email} has a Payaz Stock login, a link to set a password is on its way.`); }
  catch (e) { overlay("Couldn't send the email", friendlyError(e), true); }
};
// Settings: how soon it locks, and who's on this tablet
function drawPeopleSettings() {
  $("#shareHint").textContent = S.connected
    ? "Shared sign-in is on: everyone's PIN works on every connected tablet, and removing someone takes them off every tablet."
    : "Shared sign-in isn't set up on this tablet: a manager can connect it from \"Who's using the tablet?\".";
  $("#lockChips").innerHTML = [2, 5, 10, 15].map((m) => `<button class="chip ${settings.lockMins === m ? "on" : ""}" data-lock="${m}">Lock after ${m} min</button>`).join("");
  $("#lockChips").querySelectorAll("[data-lock]").forEach((b) => (b.onclick = () => { saveSettings({ lockMins: +b.dataset.lock }); drawPeopleSettings(); poke(); }));
  const people = S.people();
  $("#peopleList").innerHTML = people.map((p) => `<div class="prow"><span><b>${esc(p.name)}</b> <small style="color:var(--muted)">${esc(p.email)}</small></span><button class="chip" data-rm="${esc(p.id)}">Remove</button></div>`).join("") || `<div class="hint">Nobody yet.</div>`;
  $("#peopleList").querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => {
    const p = people.find((x) => x.id === b.dataset.rm);
    overlay(`Take ${p.name} off this tablet?`, "They can add themselves again with their email and password.", false, false,
      { label: "Remove", run: async () => {
        const me = S.person && S.person.id === p.id;
        try { await S.removePerson(p.id); } catch (e) { overlay("Couldn't remove them", friendlyError(e), true); return; }
        if (me) showWho(); else drawPeopleSettings();
      } });
  }));
}
S.forgetOldSignIn();
showWho();

// For automated tests
window.__payaz = { renderLabel, printer, vals, loadLog, S };
