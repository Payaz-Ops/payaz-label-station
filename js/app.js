import { renderLabel, LABEL_FONT } from "./labels.js";
import { Printer, bluetoothSupported, isNativeApp } from "./printer.js";
import { loadLog, addLogEntry, deleteLogEntry, logRow, exportCsv } from "./log.js";
import { stock as realStock, friendlyError as realFriendly } from "./stock.js";
// (automated tests can swap in a pretend stock app)
const S = window.__STOCK_MOCK__ || realStock;
const friendlyError = (window.__STOCK_MOCK__ && window.__STOCK_MOCK__.friendlyError) || realFriendly;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const printer = new Printer();

// The two label screens. Box types: "pad" = number keypad (with PZ),
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

/* ---------- settings (saved on this tablet) ---------- */
const DEFAULTS = { widthMm: 40, heightMm: 30, density: 4, rotate: false, stockCode: "barcode" };
let settings = { ...DEFAULTS };
try { Object.assign(settings, JSON.parse(localStorage.getItem("payaz-settings") || "{}")); } catch (e) {}
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
  $("#backBtn").style.display = id === "home" ? "none" : "";
  $("#setBtn").style.display = id === "home" ? "" : "none";
  $("#pill").style.display = id === "home" ? "" : "none";
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
    `<button class="field" data-f="${f.k}"><div class="lbl">${f.label}</div><div class="val"></div></button>`).join("");
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
function makeLabel(kind, values) {
  return renderLabel(kind, values, { widthMm: settings.widthMm, heightMm: settings.heightMm, rotate: settings.rotate, stockCode: settings.stockCode });
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
    const { canvas } = makeLabel(printKind(), vals);
    $("#preview").replaceChildren(canvas);
  }, 60);
}

/* ---------- typing ---------- */
const maxLen = (k) => (k === "order" ? 30 : 40);
function press(key) {
  poke();
  const f = fieldOf(active);
  let v = vals[active];
  if (key === "DEL") v = v.slice(0, -1);
  else if (key === "CASE") { caseMode = nextCase(); render(); return; }
  else if (key === "PZ") { if (!v.endsWith("PZ")) v += "PZ"; }
  else if (v.length < maxLen(active)) {
    if (active === "order" && v.endsWith("PZ")) return;
    if (key === "SPACE") key = " ";
    if (f.type !== "text") key = key.toUpperCase();
    else if (/^[a-z]$/i.test(key)) key = capsNext(v) ? key.toUpperCase() : key.toLowerCase();
    if (key === " " && (!v || v.endsWith(" "))) return;
    v += key;
  }
  vals[active] = v; render();
}
$("#keypad").onclick = (e) => { const b = e.target.closest("button"); if (b) press(b.dataset.k || b.textContent); };

// Letter case for typed names: "Abc" = capital at the start of each word (default),
// "ABC" = all capitals, "abc" = all small.
const nextCase = () => ({ Abc: "ABC", ABC: "abc", abc: "Abc" })[caseMode];
const capsNext = (v) => caseMode === "ABC" || (caseMode === "Abc" && (!v || /[\s\-\/.]$/.test(v)));

// On-screen keyboard (letters, numbers, space and a few symbols)
const ROWS = ["1234567890", "QWERTYUIOP", "ASDFGHJKL-", "ZXCVBNM/."];
function buildKbd(el, { scanKey = false, doneKey = false, current = null } = {}) {
  const typed = current !== null ? current : active && fieldOf(active).type === "text" ? vals[active] : "";
  const big = current === null && active && fieldOf(active).type !== "text" ? true : capsNext(typed);
  const shown = (c) => (/[A-Z]/.test(c) && !big ? c.toLowerCase() : c);
  el.innerHTML = ROWS.map((r) => `<div class="row">${[...r].map((c) => `<button data-c="${c}">${shown(c)}</button>`).join("")}</div>`).join("") +
    `<div class="row"><button class="wide" data-k="CASE">${caseMode}</button>` +
    `<button style="flex:4" data-k="SPACE">space</button><button class="wide del" data-k="DEL">&#9003;</button>` +
    (scanKey ? `<button class="wide" data-k="SCAN">Scan instead</button>` : "") +
    (doneKey ? `<button class="wide" data-k="DONE" style="background:var(--teal);color:#fff">Done</button>` : "") + `</div>`;
}
$("#kbd").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  if (b.dataset.k === "SCAN") { typing = false; render(); } else press(b.dataset.k || b.dataset.c);
};
$("#typeBtn").onclick = () => { typing = true; render(); };

// Put a scanned code in the right box.
function acceptScan(code) {
  code = code.trim().replace(/[^\x20-\x7E]/g, "").slice(0, 40);
  if (!active || code.length < 2) return;
  if (mode === "stock") {
    vals.code = code;
    active = !vals.name ? "name" : !vals.location ? "location" : "code";
  } else {
    code = code.toUpperCase();
    let target = active;
    if (target === "order") target = !vals.sumup ? "sumup" : "tablet";
    vals[target] = code;
    active = ["sumup", "tablet"].find((f) => !vals[f]) || target; // next empty scan box
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

$("#printBtn").onclick = async () => {
  const values = mode === "stock"
    ? { name: vals.name, location: vals.location, code: vals.code }
    : { order: vals.order, sumup: vals.sumup, tablet: vals.tablet };
  if (await doPrint(printKind(), values, copies, MODES[mode].logged)) setTimeout(() => { hideOverlay(); home(); }, 1200);
};
$("#clearBtn").onclick = () => { vals[active] = ""; render(); };
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
  $("#ovBtn").textContent = alt ? "Cancel" : "OK";
  $("#ovAlt").style.display = alt ? "" : "none";
  if (alt) { $("#ovAlt").textContent = alt.label; $("#ovAlt").onclick = () => { hideOverlay(); alt.run(); }; }
}
function hideOverlay() { $("#overlay").classList.remove("on"); }
$("#ovBtn").onclick = hideOverlay;

/* ---------- settings screen ---------- */
const PRESETS = [[40, 30], [40, 40], [40, 60], [50, 30], [50, 50]];
function openSettings() { $("#hdrTitle").textContent = "Settings"; show("settings"); drawSettings(); drawPrinter(); }
function drawSettings() {
  $("#wmm").textContent = settings.widthMm + " mm";
  $("#hmm").textContent = settings.heightMm + " mm";
  $("#dens").textContent = settings.density;
  $("#rotVal").textContent = settings.rotate ? "ON" : "OFF";
  document.querySelectorAll("[data-sc]").forEach((b) => b.classList.toggle("on", b.dataset.sc === settings.stockCode));
  $("#sizeChips").innerHTML = PRESETS.map(([w, h]) =>
    `<button class="chip ${w == settings.widthMm && h == settings.heightMm ? "on" : ""}" data-w="${w}" data-h="${h}">${w} × ${h} mm</button>`).join("");
  $("#sizeChips").querySelectorAll("button").forEach((b) => (b.onclick = () => saveSettings({ widthMm: +b.dataset.w, heightMm: +b.dataset.h })));
}
document.querySelectorAll("[data-d]").forEach((b) => (b.onclick = () => {
  const [k, d] = b.dataset.d.split(":"); saveSettings({ [k]: +settings[k] + +d });
}));
$("#rotBtn").onclick = () => saveSettings({ rotate: !settings.rotate });
document.querySelectorAll("[data-sc]").forEach((b) => (b.onclick = () => saveSettings({ stockCode: b.dataset.sc })));
$("#reloadBtn").onclick = () => location.reload();

document.querySelectorAll("[data-go]").forEach((b) => (b.onclick = () => openMode(b.dataset.go)));
$("#goStock").onclick = () => { pickForTake = false; openStock("take"); };
$("#goStockLabel").onclick = () => { pickForTake = false; openStock("labels"); };
$("#goLog").onclick = openLog;

/* ---------- stock (linked to the Payaz Stock app) ---------- */
let stockSearch = "", stockReady = false, sheetItem = null, sheetCopies = 1;
let stockView = "take", pickForTake = false; // "take" = Stock button, "labels" = Stock Label button
S.watch(() => { stockReady = true; if ($("#stock").classList.contains("on")) openStock(); });

async function openStock(view = stockView) {
  stockView = view;
  $("#hdrTitle").textContent = pickForTake ? "Choose an item to count" : view === "take" ? "Stock" : "Stock Label";
  show("stock"); poke();
  const signedIn = S.user && S.isStaff;
  $("#stockSignin").style.display = signedIn ? "none" : "flex";
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
function stockScan(code) {
  if (!code) return;
  const item = S.findByCode(code);
  if (item) { stockSearch = ""; drawStock(); openSheet(item); return; }
  setStockSearch(code);
  if (!stockMatches().length)
    overlay("Not in the stock app", `Nothing has the code ${code}.`, false, false, { label: "Add it as a new item", run: () => openNewItem({ barcode: code }) });
}
const stockLabelValues = (i) => ({ name: i.name || "", location: i.location || "", code: S.labelCode(i) });

// Item pop-up: print its label
function openSheet(item) {
  if (!item) return;
  sheetItem = item; sheetCopies = 1;
  $("#shName").textContent = item.name || "(no name)";
  $("#shMeta").innerHTML = `SKU <b>${esc(item.SKU || "-")}</b>${item.barcode ? ` · Barcode <b>${esc(item.barcode)}</b>` : ""}<br>` +
    `Location <b>${esc(item.location || "-")}</b> · In stock <b>${item.quantity_on_hand ?? "-"}</b>${item.category ? ` · ${esc(item.category)}` : ""}`;
  drawSheet(); $("#sheet").classList.add("on"); poke();
}
function drawSheet() {
  $("#shCopies").textContent = sheetCopies;
  $("#shPrev").replaceChildren(makeLabel("stock", stockLabelValues(sheetItem)).canvas);
}
const closeSheet = () => $("#sheet").classList.remove("on");
$("#shClose").onclick = closeSheet;
$("#sheet").onclick = (e) => { if (e.target.id === "sheet") closeSheet(); };
$("#shMinus").onclick = () => { sheetCopies = Math.max(1, sheetCopies - 1); drawSheet(); };
$("#shPlus").onclick = () => { sheetCopies = Math.min(50, sheetCopies + 1); drawSheet(); };
$("#shPrint").onclick = async () => {
  if (await doPrint("stock", stockLabelValues(sheetItem), sheetCopies)) setTimeout(() => { hideOverlay(); closeSheet(); }, 1100);
};
$("#shEdit").onclick = () => {
  const v = stockLabelValues(sheetItem); closeSheet();
  openMode("stock"); Object.assign(vals, v); setActive("name");
};

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
$("#stSignOut").onclick = () => overlay("Sign out of Payaz Stock?", "You'll need your email and password to sign in again.", false, false,
  { label: "Sign out", run: async () => { await S.signOut(); openStock(); } });
$("#stRefresh").onclick = refreshStock;
$("#stClear").onclick = () => setStockSearch("");
$("#stSearchBtn").onclick = () => { searchTarget = "stock"; drawTyper(); $("#typer").classList.add("on"); };
$("#stNew").onclick = () => openNewItem({});
$("#stCustom").onclick = () => openMode("stock");
$("#stCustom2").onclick = () => openMode("stock");

/* ---------- stock take (Stock button) ---------- */
// Same as the stock app's Stock Take / Add Stock / Remove Stock scan modes:
// each scan of the item counts 1; the result is saved with the same history text.
let takeMode = "take", takeItem = null, takeCount = 0, takeBusy = false;
const takeSession = [];
const MODE_TEXT = {
  take: { name: "Stock take", counter: "COUNTED", hint: "Scan every unit of an item: each scan counts 1. Scanning the next item saves this one." },
  add: { name: "Add stock", counter: "ADDING", hint: "Scan each unit you're putting into stock." },
  remove: { name: "Remove stock", counter: "REMOVING", hint: "Scan each unit you're taking out of stock." },
};
const recorded = (i) => Number(i.quantity_on_hand) || 0;
function takeResult() {
  const old = recorded(takeItem);
  return takeMode === "take" ? takeCount : takeMode === "add" ? old + takeCount : Math.max(0, old - takeCount);
}
function drawTake() {
  document.querySelectorAll("#takeModes button").forEach((b) => b.classList.toggle("on", b.dataset.m === takeMode));
  const M = MODE_TEXT[takeMode], card = $("#takeCard");
  if (!takeItem) {
    card.innerHTML = `<div class="scanwait"><div class="beam"></div><h2>Scan an item or its shelf label</h2>
      <p style="margin:0;color:var(--muted);font-size:17px">${M.hint}</p>
      <div class="btns" style="display:flex;gap:10px"><button class="ghost cam" id="takeCam">&#128247; Use camera</button></div></div>`;
    $("#takeCam").onclick = () => scanWithCamera((c) => takeScan(c.trim()));
  } else {
    const old = recorded(takeItem), res = takeResult(), diff = res - old;
    card.innerHTML = `<h2>${esc(takeItem.name || "(no name)")}</h2>
      <div class="meta">SKU ${esc(takeItem.SKU || "-")} · ${esc(takeItem.location || "no location")} · In stock now: <b>${old}</b></div>
      <div class="counter"><button id="tkMinus">&minus;</button><button class="num" id="tkNum"><small>${M.counter}</small><b>${takeCount}</b></button><button id="tkPlus">+</button></div>
      <div class="change ${diff > 0 ? "up" : diff < 0 ? "down" : ""}">${diff === 0 ? `Stays at ${old}` : `${old} \u2192 ${res} (${diff > 0 ? "+" : ""}${diff})`}</div>
      <div class="takebtns"><button class="ghost" id="tkCancel" style="min-height:70px">Cancel</button><button class="print" id="tkSave">SAVE</button></div>`;
    $("#tkMinus").onclick = () => { takeCount = Math.max(0, takeCount - 1); drawTake(); poke(); };
    $("#tkPlus").onclick = () => { takeCount++; drawTake(); poke(); };
    $("#tkNum").onclick = () => { searchTarget = "count"; drawTyper(); $("#typer").classList.add("on"); };
    $("#tkCancel").onclick = () => { takeItem = null; drawTake(); };
    $("#tkSave").onclick = () => takeSave();
  }
  $("#takeSession").innerHTML = `<h4>THIS SESSION</h4>` + (takeSession.length ? takeSession.map((x) =>
    `<div class="it">${esc(x.name)}<small>${x.what} · ${x.time}</small></div>`).join("") : `<div class="it"><small>Nothing saved yet.</small></div>`);
}
function takeStart(item) { takeItem = item; takeCount = 1; drawTake(); poke(); }
async function takeScan(code) {
  if (!code || takeBusy) return;
  const item = S.findByCode(code);
  if (!item) {
    overlay("Not in the stock app", `Nothing has the code ${code}.`, false, false, { label: "Add it as a new item", run: () => openNewItem({ barcode: code }) });
    return;
  }
  if (takeItem && takeItem.id === item.id) { takeCount++; drawTake(); poke(); return; }
  if (takeItem && !(await takeSave(true))) return;
  takeStart(item);
}
const hhmm = () => new Date().toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** Save the item being counted. Returns false if it couldn't be saved. */
async function takeSave(auto = false) {
  if (!takeItem) return true;
  const item = takeItem, n = takeCount, mode = takeMode;
  const noChange = mode === "take" ? n === recorded(item) : n === 0;
  if (noChange) {
    takeSession.unshift({ name: item.name, what: `${MODE_TEXT[mode].name}: no change (${recorded(item)})`, time: hhmm() });
    takeItem = null; drawTake(); return true;
  }
  takeBusy = true;
  overlay("Saving…", item.name, false, true);
  try {
    const r = mode === "take" ? await S.saveCount(item, n) : mode === "add" ? await S.addStock(item, n) : await S.removeStock(item, n);
    takeSession.unshift({ name: item.name, what: `${MODE_TEXT[mode].name}: ${r.oldQty} \u2192 ${r.newQty}`, time: hhmm() });
    takeItem = null; drawTake();
    overlay("Saved \u2713", `${item.name}: ${r.oldQty} \u2192 ${r.newQty}`, false, true);
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
  takeMode = b.dataset.m; drawTake();
}));
$("#takeFind").onclick = () => { pickForTake = true; stockSearch = ""; openStock("take"); };
$("#takeNew").onclick = () => openNewItem({});
// Leaving the stock screens saves any count in progress first.
async function leaveToHome() { if (takeItem && !(await takeSave(true))) return; pickForTake = false; home(); }

// New item form
let niTracking = "quantity", niPrintAfter = true;
const NEW_OPT = "__new__";
function fillSelect(sel, options, current) {
  sel.innerHTML = options.map((o) => `<option${o === current ? " selected" : ""}>${esc(o)}</option>`).join("") +
    `<option value="${NEW_OPT}">+ New…</option>`;
}
function openNewItem(prefill) {
  $("#hdrTitle").textContent = "New stock item"; show("newitem"); poke();
  $("#niName").value = prefill.name || "";
  $("#niSku").value = S.suggestSku();
  $("#niBarcode").value = prefill.barcode || "";
  fillSelect($("#niCat"), S.categories.length ? S.categories : ["General"], S.categories.includes("General") ? "General" : S.categories[0]);
  fillSelect($("#niLoc"), S.locations.length ? S.locations : ["Bin A-1"], S.locations[0]);
  $("#niCatNew").style.display = $("#niLocNew").style.display = "none";
  $("#niCatNew").value = $("#niLocNew").value = "";
  $("#niQty").value = "0"; $("#niReorder").value = "5"; $("#niNotes").value = "";
  niTracking = "quantity"; drawNewItem();
  setTimeout(() => $("#niName").focus(), 50);
}
const pick = (sel, other) => (sel.value === NEW_OPT ? other.value.trim() : sel.value);
function newItemInput() {
  return {
    name: $("#niName").value, SKU: $("#niSku").value, barcode: $("#niBarcode").value,
    category: pick($("#niCat"), $("#niCatNew")), location: pick($("#niLoc"), $("#niLocNew")),
    tracking_type: niTracking, quantity_on_hand: $("#niQty").value, reorder_threshold: $("#niReorder").value, notes: $("#niNotes").value,
  };
}
function drawNewItem() {
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
$("#niSave").onclick = async () => {
  const input = newItemInput();
  const problem = S.check(input) || (!input.category ? "Type the new category name." : !input.location ? "Type the new location name." : null);
  if (problem) { overlay("Check the details", problem, true); return; }
  overlay("Saving to Payaz Stock…", "", false, true);
  let item;
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
let searchTarget = "log";
const typerValue = () => (searchTarget === "count" ? String(takeCount) : searchTarget === "stock" ? stockSearch : search);
const typerSet = (v) => {
  if (searchTarget === "count") { takeCount = Math.min(99999, parseInt(v.replace(/\D/g, ""), 10) || 0); drawTake(); return; }
  return searchTarget === "stock" ? setStockSearch(v) : setSearch(v);
};
$("#searchBtn").onclick = () => { searchTarget = "log"; drawTyper(); $("#typer").classList.add("on"); };
function drawTyper() {
  $("#typerShown").textContent = typerValue() || " ";
  buildKbd($("#typerKbd"), { doneKey: true, current: typerValue() });
}
$("#typerKbd").onclick = (e) => {
  const b = e.target.closest("button"); if (!b) return;
  const k = b.dataset.k, c = b.dataset.c;
  if (k === "DONE") { $("#typer").classList.remove("on"); return; }
  const cur = typerValue();
  if (k === "CASE") caseMode = nextCase();
  else if (k === "DEL") typerSet(cur.slice(0, -1));
  else if (k === "SPACE") typerSet(cur + " ");
  else typerSet(cur + (capsNext(cur) ? c : c.toLowerCase()));
  drawTyper();
};
$("#typer").onclick = (e) => { if (e.target.id === "typer") $("#typer").classList.remove("on"); };
$("#backBtn").onclick = () => {
  if ($("#newitem").classList.contains("on")) return openStock();
  if ($("#stock").classList.contains("on") && pickForTake) { pickForTake = false; return openStock("take"); }
  if ($("#stock").classList.contains("on")) return leaveToHome();
  home();
};
$("#setBtn").onclick = openSettings;

/* ---------- tablet niceties ---------- */
// Back to the start screen after 3 minutes of no use
function poke() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(async () => {
    if (takeItem && !(await takeSave(true))) return; // keep an unsaved count on screen if saving failed
    hideOverlay(); closeCamera(); closeSheet(); pickForTake = false; home();
  }, 180000);
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

// For automated tests
window.__payaz = { renderLabel, printer, vals, loadLog, S };
