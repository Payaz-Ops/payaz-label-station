// The log of Order Labels printed. Shared between tablets through Payaz Stock
// (order_labels); this tablet keeps a copy so it works without internet.
// Each entry: { id, ts: ISO time, order, sumup, tablet, by, device, cancelled,
// cancelledBy, synced (saved in Payaz Stock), imported }.
// Also written as a CSV backup to Documents/PayazLabels/ in the Android app.
import { formatDate } from "./labels.js";
import { isNativeApp } from "./printer.js";

const KEY = "payaz-log";
const BACKUP_DIR = "PayazLabels";
const BACKUP_FILE = `${BACKUP_DIR}/payaz-label-log.csv`;

const hash = (s) => { let h = 5381; for (const c of s) h = ((h * 33) ^ c.charCodeAt(0)) >>> 0; return h.toString(36); };
export function loadLog() {
  let entries;
  try { entries = JSON.parse(localStorage.getItem(KEY) || "[]"); } catch (e) { entries = []; }
  // Entries from before the Log was shared get an id (the same every time) and are uploaded
  if (entries.some((e) => !e.id)) {
    entries = entries.map((e) => (e.id ? e : { ...e, id: `lbl_old_${hash(`${e.ts}|${e.order}|${e.sumup}|${e.tablet}`)}`, synced: false, imported: true }));
    try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (e) {}
  }
  return entries;
}

function saveLog(entries) {
  try { localStorage.setItem(KEY, JSON.stringify(entries)); } catch (e) {}
  writeBackup(entries);
}

export function addLogEntry({ order = "", sumup = "", tablet = "" }, extra = {}, when = new Date()) {
  const entries = loadLog();
  const entry = { id: `lbl_${when.getTime().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ts: when.toISOString(), order, sumup, tablet, by: extra.by || "", device: extra.device || "", synced: false };
  entries.push(entry);
  saveLog(entries);
  return entry;
}

export function deleteLogEntry(id) {
  const entries = loadLog().filter((e) => e.id !== id);
  saveLog(entries);
  return entries;
}

export function markLogSynced(ids) {
  const set = new Set(ids);
  saveLog(loadLog().map((e) => (set.has(e.id) ? { ...e, synced: true } : e)));
}

/** The shared Log from Payaz Stock, plus anything here not uploaded yet. */
export function mergeRemoteLog(remote) {
  const local = loadLog();
  const byId = new Map(remote.map((l) => [l.id, {
    id: l.id, ts: l.printed_at, order: l.order || "", sumup: l.sumup || "", tablet: l.tablet || "",
    by: l.printed_by_name || "", device: l.device || "", cancelled: l.cancelled_at || "", cancelledBy: l.cancelled_by_name || "",
    imported: !!l.imported, synced: true,
  }]));
  for (const e of local) if (!e.synced && !byId.has(e.id)) byId.set(e.id, e);
  const merged = [...byId.values()].sort((a, b) => (a.ts || "").localeCompare(b.ts || ""));
  saveLog(merged);
  return merged;
}

/** An order cancelled after its label was printed: the entry stays, marked cancelled. */
export function cancelLogEntry(id, by, when = new Date()) {
  const entries = loadLog().map((e) => (e.id === id ? { ...e, cancelled: when.toISOString(), cancelledBy: by } : e));
  saveLog(entries);
  return entries;
}

/** Warranty runs 12 months from the day the label was printed. */
export function warrantyDate(ts) {
  const d = new Date(ts);
  const w = new Date(d.getFullYear() + 1, d.getMonth(), d.getDate());
  if (w.getDate() !== d.getDate()) w.setDate(0); // 29 Feb -> 28 Feb next year
  return w;
}

export const logRow = (e) => ({
  order: e.order, date: formatDate(new Date(e.ts)), sumup: e.sumup, tablet: e.tablet, by: e.by || "", device: e.device || "",
  warranty: formatDate(warrantyDate(e.ts)), expired: warrantyDate(e.ts) < new Date(new Date().toDateString()),
  cancelled: e.cancelled ? `${formatDate(new Date(e.cancelled))}${e.cancelledBy ? ` by ${e.cancelledBy}` : ""}` : "",
});

const HEADERS = ["Payaz Order Number", "Date", "Card Reader", "Tablet", "Warranty Expires", "Cancelled", "Printed by", "Tablet used"];
const cell = (v) => {
  v = String(v ?? "");
  // Quote everything; a leading tab stops spreadsheets turning serials like 0123 into numbers
  const safe = /^[0-9]{6,}$/.test(v) || /^0[0-9]+$/.test(v) ? `\t${v}` : v;
  return `"${safe.replace(/"/g, '""')}"`;
};

export function toCsv(entries = loadLog()) {
  const lines = [HEADERS.map(cell).join(",")];
  for (const e of entries) {
    const r = logRow(e);
    lines.push([r.order, r.date, r.sumup, r.tablet, r.cancelled ? "" : r.warranty, r.cancelled, r.by, r.device].map(cell).join(","));
  }
  return "﻿" + lines.join("\r\n") + "\r\n"; // BOM so Excel reads it as UTF-8
}

const plugins = () => window.Capacitor.Plugins;

async function writeBackup(entries) {
  if (!isNativeApp()) return;
  try {
    await plugins().Filesystem.writeFile({
      path: BACKUP_FILE, data: toCsv(entries), directory: "DOCUMENTS", encoding: "utf8", recursive: true,
    });
  } catch (e) { /* backup is best effort; the log is still kept in the app */ }
}

/** Share (Android app) or download (browser) the log as a CSV file. */
export async function exportCsv() {
  const csv = toCsv();
  const name = `payaz-label-log-${formatDate().split("/").reverse().join("-")}.csv`;
  if (isNativeApp()) {
    const { uri } = await plugins().Filesystem.writeFile({ path: name, data: csv, directory: "CACHE", encoding: "utf8" });
    await plugins().Share.share({ title: "Payaz label log", text: "Payaz label log (CSV)", files: [uri], dialogTitle: "Send the label log" });
    return;
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
  a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
