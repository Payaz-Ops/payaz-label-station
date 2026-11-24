// Link to the Payaz Stock app (payaz-stock.web.app): same Firebase project and
// database, same rules. Staff sign in with their Payaz Stock email and password.
// Reading items needs any sign-in; adding items needs an active staff profile
// (staff_accounts/{uid}), exactly as in the stock app.
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  initializeFirestore, collection, getDocs, doc, getDoc, writeBatch, runTransaction,
  query, where, getCountFromServer, serverTimestamp,
} from "./firebase.js";

// Public web settings of the Payaz Stock app (the same values its website uses).
// Access is controlled by sign-in and the database rules, not by this key.
const CONFIG = {
  apiKey: "AIzaSyBYBCSt_YL0n47YH6KKDiZgdIfy_k0VFmI",
  authDomain: "oceanic-cache-418312.firebaseapp.com",
  projectId: "oceanic-cache-418312",
  storageBucket: "oceanic-cache-418312.firebasestorage.app",
  messagingSenderId: "718760925976",
  appId: "1:718760925976:web:6926109f3a93103ce89c6d",
};
const DATABASE = "stock";

let app, auth, db;
function init() {
  if (app) return;
  app = initializeApp(CONFIG, "payaz-stock");
  // initializeAuth without a popup resolver: no Google sign-in iframes, which
  // don't work inside the Android app. Stay signed in between launches.
  auth = initializeAuth(app, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
  db = initializeFirestore(app, { experimentalAutoDetectLongPolling: true }, DATABASE);
}

const rid = (prefix) => prefix + "_" + Math.random().toString(36).substring(2, 11);

const FRIENDLY = {
  "auth/invalid-credential": "That email or password isn't right.",
  "auth/wrong-password": "That email or password isn't right.",
  "auth/user-not-found": "That email or password isn't right.",
  "auth/invalid-email": "That doesn't look like an email address.",
  "auth/too-many-requests": "Too many tries. Wait a few minutes, or reset the password.",
  "auth/network-request-failed": "No internet connection. The stock app needs internet.",
  "auth/user-disabled": "This login has been turned off.",
  "permission-denied": "Your account isn't allowed to change stock. Ask an admin to add you in Payaz Stock > Manage Staff.",
  "unavailable": "Can't reach the stock database. Check the internet connection.",
};
export const friendlyError = (e) => FRIENDLY[e && e.code] || (e && e.message) || String(e);

export const stock = {
  user: null,     // Firebase user
  profile: null,  // staff_accounts profile ({ name, role, ... })
  items: [], locations: [], categories: [],

  /** Calls back whenever sign-in changes (after the saved sign-in is restored). */
  watch(callback) {
    init();
    return onAuthStateChanged(auth, async (user) => {
      this.user = user; this.profile = null;
      if (user) { try { await this.loadProfile(); } catch (e) {} }
      callback(user);
    });
  },

  async signIn(email, password) {
    init();
    const cred = await signInWithEmailAndPassword(auth, email.trim(), password);
    this.user = cred.user;
    await this.loadProfile();
    if (!this.isStaff) {
      const name = cred.user.email;
      await signOut(auth);
      const err = new Error(`${name} isn't set up as Payaz Stock staff (or the account is turned off). Ask an admin to add you in Payaz Stock > Manage Staff.`);
      err.code = "not-staff";
      throw err;
    }
  },

  async signOut() { init(); await signOut(auth); this.items = []; },

  resetPassword(email) { init(); return sendPasswordResetEmail(auth, email.trim()); },

  async loadProfile() {
    const snap = await getDoc(doc(db, "staff_accounts", this.user.uid));
    this.profile = snap.exists() ? snap.data() : null;
  },

  get isStaff() {
    return !!(this.profile && this.profile.disabled !== true && this.profile.removed !== true);
  },
  get userName() {
    return (this.profile && this.profile.name) || (this.user && (this.user.displayName || this.user.email)) || "Label Station";
  },

  /** Items, locations and categories, gathered the same way the stock app does. */
  async refresh() {
    init();
    const [itemSnap, locSnap, catSnap] = await Promise.all([
      getDocs(collection(db, "items")),
      getDocs(collection(db, "locations")).catch(() => null),
      getDocs(collection(db, "categories")).catch(() => null),
    ]);
    const items = [];
    itemSnap.forEach((d) => items.push({ id: d.id, ...d.data() }));
    items.sort((a, b) => (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" }));
    const locs = new Set(), cats = new Set();
    if (locSnap) locSnap.forEach((d) => d.data().name && locs.add(d.data().name));
    if (catSnap) catSnap.forEach((d) => d.data().name && cats.add(d.data().name));
    for (const i of items) { if (i.location) locs.add(i.location); if (i.category) cats.add(i.category); }
    this.items = items;
    this.locations = [...locs].sort();
    this.categories = [...cats].sort();
    return items;
  },

  /** The code the stock app prints on its labels and finds when scanned. */
  labelCode: (item) => (item.barcode || item.SKU || item.id || "").trim(),

  /** Find an item by a scanned code: barcode, SKU or item ID (as the stock app's scanner). */
  findByCode(code) {
    const c = String(code || "").trim().toLowerCase();
    if (!c) return null;
    return this.items.find((i) => i.barcode && i.barcode.toLowerCase() === c)
      || this.items.find((i) => i.SKU && i.SKU.toLowerCase() === c)
      || this.items.find((i) => i.id && i.id.toLowerCase() === c) || null;
  },

  /** Problems with an item before saving (duplicate SKU/barcode, missing name).
   *  excludeId: the item being edited (it may keep its own codes). */
  check({ name, SKU, barcode }, excludeId = null) {
    if (!name || !name.trim()) return "Give the item a name.";
    const others = this.items.filter((i) => i.id !== excludeId);
    const sku = (SKU || "").trim().toLowerCase(), bc = (barcode || "").trim().toLowerCase();
    const dupSku = sku && others.find((i) => (i.SKU || "").toLowerCase() === sku || (i.barcode || "").toLowerCase() === sku);
    if (dupSku) return `SKU ${SKU} is already used by "${dupSku.name}".`;
    const dupBc = bc && others.find((i) => (i.barcode || "").toLowerCase() === bc || (i.SKU || "").toLowerCase() === bc);
    if (dupBc) return `Barcode ${barcode} is already on "${dupBc.name}".`;
    return null;
  },

  /** A SKU in the stock app's style that isn't used yet. */
  suggestSku() {
    for (let n = 0; n < 50; n++) {
      const sku = "SKU-" + Math.floor(1000 + Math.random() * 9000);
      if (!this.items.some((i) => (i.SKU || "").toLowerCase() === sku.toLowerCase())) return sku;
    }
    return "SKU-" + Date.now().toString().slice(-6);
  },

  /**
   * Change an item's quantity, exactly like the stock app's adjustStock: one
   * transaction that reads the latest quantity, updates it and writes the
   * movement, with the reason ending "(Old: x → New: y)".
   *   newQuantity: set the count (stock take)   or   change: +n / -n (add / remove stock)
   */
  async adjustStock(itemId, { newQuantity, change, reason, source = "scan" }) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const itemRef = doc(db, "items", itemId);
    const now = new Date().toISOString();
    const movId = rid("mov");
    let result;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists()) throw new Error("That item isn't in the stock app any more.");
      const item = { id: snap.id, ...snap.data() };
      if (item.tracking_type === "serial") {
        const err = new Error(`${item.name} is tracked by serial number, so its count can't be changed here. Use Book in serials for new units; units come off stock when sent on an Order Label.`);
        err.code = "serial-locked";
        throw err;
      }
      const oldQty = Number(item.quantity_on_hand) || 0;
      const newQty = newQuantity !== undefined ? Math.max(0, Math.round(newQuantity)) : Math.max(0, oldQty + Math.round(change || 0));
      const movement = {
        id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
        serial_number: null,
        direction: newQty > oldQty ? "in" : newQty < oldQty ? "out" : "adjustment",
        quantity_delta: Math.abs(newQty - oldQty),
        location_from: item.location, location_to: item.location,
        user_id: this.user.uid, user_name: this.userName,
        reason: `${reason} (Old: ${oldQty} \u2192 New: ${newQty})`,
        source,
      };
      tx.update(itemRef, { quantity_on_hand: newQty, updated_at: now });
      tx.set(doc(db, "movements", movId), movement);
      result = { item: { ...item, quantity_on_hand: newQty, updated_at: now }, oldQty, newQty, movement };
    });
    const i = this.items.findIndex((x) => x.id === itemId);
    if (i >= 0) this.items[i] = result.item;
    return result;
  },

  /** Save a stock take count (same reason text as the stock app's Stock Take). */
  saveCount(item, counted) {
    return this.adjustStock(item.id, {
      newQuantity: counted,
      reason: `Stock Take Audit (Recorded: ${Number(item.quantity_on_hand) || 0}, Counted: ${counted})`,
    });
  },
  /** Add or remove stock by scanning (same reason text as the stock app's scan modes). */
  addStock(item, n) { return this.adjustStock(item.id, { change: n, reason: `Add Stock Scan Mode (+${n})` }); },
  removeStock(item, n) { return this.adjustStock(item.id, { change: -n, reason: `Remove Stock Scan Mode (-${n})` }); },

  /** Save changes to an item's details (same as editing it in the stock app). */
  async updateItem(itemId, input) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const problem = this.check(input, itemId);
    if (problem) throw new Error(problem);
    const current = this.items.find((i) => i.id === itemId);
    const changes = {
      name: input.name.trim(),
      SKU: (input.SKU || "").trim() || (current && current.SKU) || this.suggestSku(),
      barcode: (input.barcode || "").trim(),
      category: (input.category || "").trim() || "General",
      location: (input.location || "").trim() || "Bin A-1",
      notes: (input.notes || "").trim(),
      updated_at: new Date().toISOString(),
    };
    if (input.image_url !== undefined) changes.image_url = input.image_url || "";
    const batch = writeBatch(db);
    batch.update(doc(db, "items", itemId), changes);
    await batch.commit();
    const updated = { ...(current || { id: itemId }), ...changes };
    const i = this.items.findIndex((x) => x.id === itemId);
    if (i >= 0) this.items[i] = updated;
    if (!this.locations.includes(updated.location)) this.locations = [...this.locations, updated.location].sort();
    if (!this.categories.includes(updated.category)) this.categories = [...this.categories, updated.category].sort();
    return updated;
  },

  /** Add an item to the stock app, plus its "created" movement (same as the stock app's own Add Item). */
  async addItem(input) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const problem = this.check(input);
    if (problem) throw new Error(problem);
    const now = new Date().toISOString();
    const itemId = rid("itm");
    const item = {
      id: itemId,
      name: input.name.trim(),
      SKU: (input.SKU || "").trim() || this.suggestSku(),
      barcode: (input.barcode || "").trim(),
      category: (input.category || "").trim() || "General",
      tracking_type: input.tracking_type === "serial" ? "serial" : "quantity",
      // A serial-tracked product starts at 0; its units are booked in one by one
      quantity_on_hand: input.tracking_type === "serial" ? 0 : Math.max(0, Number(input.quantity_on_hand) || 0),
      reorder_threshold: Math.max(0, Number(input.reorder_threshold ?? 5) || 0),
      unit_cost: 0,
      supplier: "",
      location: (input.location || "").trim() || "Bin A-1",
      notes: (input.notes || "").trim(),
      image_url: input.image_url || "",
      is_discontinued: false,
      created_at: now,
      updated_at: now,
    };
    const movId = rid("mov");
    const movement = {
      id: movId, timestamp: now, item_id: itemId, item_name: item.name, item_sku: item.SKU,
      serial_number: null, direction: "in", quantity_delta: item.quantity_on_hand,
      location_from: "External", location_to: item.location,
      user_id: this.user.uid, user_name: this.userName,
      reason: "Added from the Payaz Label Station", source: "manual",
    };
    const batch = writeBatch(db);
    batch.set(doc(db, "items", itemId), item);
    batch.set(doc(db, "movements", movId), movement);
    await batch.commit();
    this.items.push(item);
    this.items.sort((a, b) => (a.name || "").localeCompare(b.name || "", "en", { sensitivity: "base" }));
    if (!this.locations.includes(item.location)) this.locations = [...this.locations, item.location].sort();
    if (!this.categories.includes(item.category)) this.categories = [...this.categories, item.category].sort();
    return item;
  },

  /* ---------- serial numbers (tablets, card readers) ----------
     The same records as Payaz Stock's src/lib/serials.ts: serial_units/{key} for
     each unit (booked in there by scanning) and serial_events, a history nobody
     can change or delete. Keep the two in step. */

  /** The same clean-up as this app's scanner and Payaz Stock. */
  normaliseSerial: (raw) => String(raw || "").trim().replace(/[^\x20-\x7E]/g, "").toUpperCase().slice(0, 40).trim(),
  serialKey(serial) { return this.normaliseSerial(serial).replace(/\//g, "_"); },

  /** The unit's record, or null if it was never booked in. */
  async lookupSerial(serial) {
    init();
    const snap = await getDoc(doc(db, "serial_units", this.serialKey(serial)));
    return snap.exists() ? snap.data() : null;
  },

  /**
   * Mark a unit as sent on an order: its record, stock down by 1 (with a movement)
   * and a history entry, in one transaction. Problems (never booked in, already
   * sent on another order, damaged) are written to the history for managers.
   * Returns { kind: "dispatched" | "same_order" | "already_sent" | "not_in_stock" | "not_booked_in", unit }.
   */
  async dispatchSerial(rawSerial, orderNumber) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const serial = this.normaliseSerial(rawSerial), key = this.serialKey(rawSerial);
    const order = String(orderNumber || "").trim();
    const who = { id: this.user.uid, name: this.userName };
    const unitRef = doc(db, "serial_units", key);
    let result;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(unitRef);
      const now = new Date().toISOString();
      const event = (extra) => {
        const id = "sev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
        const e = { id, serial_key: key, serial_number: serial, order_number: order, user_id: who.id, user_name: who.name, app: "Label Station", timestamp: now, ...extra };
        Object.keys(e).forEach((k) => (e[k] === undefined || e[k] === "") && delete e[k]);
        tx.set(doc(db, "serial_events", id), e);
      };
      if (!snap.exists()) {
        event({ type: "not_booked_in", note: "Sent on an order but never booked in" });
        result = { kind: "not_booked_in", unit: null };
        return;
      }
      const unit = snap.data();
      const known = { item_id: unit.item_id, item_name: unit.item_name };
      if (unit.status === "dispatched") {
        if (unit.order_number === order) { result = { kind: "same_order", unit }; return; }
        event({ ...known, type: "already_sent", note: `Already sent on order ${unit.order_number || "?"}` });
        result = { kind: "already_sent", unit };
        return;
      }
      if (unit.status !== "in_stock") {
        event({ ...known, type: "not_in_stock", note: `Recorded as ${unit.status}` });
        result = { kind: "not_in_stock", unit };
        return;
      }
      const itemRef = doc(db, "items", unit.item_id);
      const itemSnap = await tx.get(itemRef);
      const changes = {
        status: "dispatched", order_number: order, dispatched_at: now,
        dispatched_by_id: who.id, dispatched_by_name: who.name, dispatched_app: "Label Station", updated_at: now,
      };
      tx.update(unitRef, changes);
      if (itemSnap.exists()) {
        const item = { id: itemSnap.id, ...itemSnap.data() };
        const oldQty = Number(item.quantity_on_hand) || 0, newQty = Math.max(0, oldQty - 1);
        const movId = rid("mov");
        // last_serial_key: the database rules check this serial changed in the same save
        tx.update(itemRef, { quantity_on_hand: newQty, tracking_type: "serial", last_serial_key: key, updated_at: now });
        tx.set(doc(db, "movements", movId), {
          id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
          serial_number: serial, direction: "out", quantity_delta: 1,
          location_from: item.location, location_to: "External",
          user_id: who.id, user_name: who.name,
          reason: `[Sent on order ${order}] ${serial} (Old: ${oldQty} → New: ${newQty})`, source: "scan",
        });
        const i = this.items.findIndex((x) => x.id === item.id);
        if (i >= 0) this.items[i] = { ...this.items[i], quantity_on_hand: newQty, updated_at: now };
      }
      event({ ...known, type: "dispatched" });
      result = { kind: "dispatched", unit: { ...unit, ...changes } };
    });
    return result;
  },

  /**
   * Book one unit in (the same as Payaz Stock's Book in serials): its record and a
   * history entry; for a new delivery, stock up by 1 with a movement.
   *   mode: "delivery" (adds 1 to stock) or "shelf" (already counted, stock unchanged)
   * Returns { kind: "added" | "exists" | "invalid", unit, message }.
   */
  async bookInSerial(itemId, rawSerial, mode, ref = "") {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const serial = this.normaliseSerial(rawSerial), key = this.serialKey(rawSerial);
    if (serial.length < 4) return { kind: "invalid", message: "That scan is too short to be a serial number." };
    const who = { id: this.user.uid, name: this.userName };
    const unitRef = doc(db, "serial_units", key), itemRef = doc(db, "items", itemId);
    ref = String(ref || "").trim().slice(0, 60);
    // Already on the shelf: if the serials in stock would go above the stock count,
    // the count goes up to match (it was too low). Count them before saving.
    let inStockBefore = 0;
    if (mode === "shelf") {
      const agg = await getCountFromServer(query(collection(db, "serial_units"), where("item_id", "==", itemId), where("status", "==", "in_stock")));
      inStockBefore = agg.data().count;
    }
    let result;
    await runTransaction(db, async (tx) => {
      const existing = await tx.get(unitRef);
      // A unit cancelled (scanned by mistake) can be booked in again, e.g. under the right product
      if (existing.exists() && existing.data().status !== "cancelled") { result = { kind: "exists", unit: existing.data() }; return; }
      const itemSnap = await tx.get(itemRef);
      if (!itemSnap.exists()) throw new Error("That item isn't in the stock app any more.");
      const item = { id: itemSnap.id, ...itemSnap.data() };
      const now = new Date().toISOString();
      const unit = {
        serial_key: key, serial_number: serial, item_id: item.id, item_name: item.name, item_sku: item.SKU,
        status: "in_stock", received_at: now, received_by_id: who.id, received_by_name: who.name,
        received_mode: mode === "shelf" ? "shelf" : "delivery", updated_at: now,
      };
      if (ref) unit.received_ref = ref;
      let newQty = Number(item.quantity_on_hand) || 0, raised = false;
      const shelfOver = unit.received_mode === "shelf" && inStockBefore + 1 > newQty;
      // received_ts: server time, so the person who scanned it can undo it for 15 minutes;
      // received_raised: this booking added 1 to stock (undoing it takes 1 off)
      tx.set(unitRef, { ...unit, received_ts: serverTimestamp(), received_raised: unit.received_mode === "delivery" || shelfOver });
      if (unit.received_mode === "delivery" || shelfOver) {
        const oldQty = newQty; newQty = oldQty + 1; raised = shelfOver;
        const movId = rid("mov");
        // last_serial_key: the database rules check this serial changed in the same save
        tx.update(itemRef, { quantity_on_hand: newQty, tracking_type: "serial", last_serial_key: key, updated_at: now });
        tx.set(doc(db, "movements", movId), {
          id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
          serial_number: serial, direction: "in", quantity_delta: 1,
          location_from: "External", location_to: item.location,
          user_id: who.id, user_name: who.name,
          reason: `[Serial booked in${shelfOver ? ": on the shelf, more serials than the count" : ref ? `: ${ref}` : ""}] ${serial} (Old: ${oldQty} → New: ${newQty})`, source: "scan",
        });
      } else if (item.tracking_type !== "serial") {
        tx.update(itemRef, { tracking_type: "serial", updated_at: now });
      }
      const id = "sev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const e = {
        id, serial_key: key, serial_number: serial, type: "received", item_id: item.id, item_name: item.name,
        note: unit.received_mode === "delivery" ? "New delivery: added to stock" : shelfOver ? "Already on the shelf: more serials than the stock count, so the count went up by 1" : "Already on the shelf: stock count unchanged",
        user_id: who.id, user_name: who.name, app: "Label Station", timestamp: now,
      };
      if (ref) e.ref = ref;
      tx.set(doc(db, "serial_events", id), e);
      const i = this.items.findIndex((x) => x.id === item.id);
      if (i >= 0) this.items[i] = { ...this.items[i], quantity_on_hand: newQty, tracking_type: "serial", updated_at: now };
      result = { kind: "added", unit, newQty, raised };
    });
    return result;
  },

  /** Undo a unit booked in by mistake: only the person who scanned it, within 15
   *  minutes (the database rules check both). Takes 1 off stock if the booking added 1. */
  async undoBookIn(rawSerial) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const key = this.serialKey(rawSerial), who = { id: this.user.uid, name: this.userName };
    const unitRef = doc(db, "serial_units", key);
    let undone;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(unitRef);
      if (!snap.exists()) throw new Error("That serial isn't booked in.");
      const u = snap.data();
      if (u.status !== "in_stock") throw new Error(`It's no longer in stock (it's recorded as ${u.status}).`);
      if (u.received_by_id !== who.id) throw new Error("Only the person who booked it in can undo it. Ask a manager.");
      if (Date.now() - new Date(u.received_at).getTime() > 15 * 60000) throw new Error("It's more than 15 minutes since it was booked in. Ask a manager to cancel it in Payaz Stock.");
      const raised = u.received_raised ?? u.received_mode === "delivery";
      const itemRef = doc(db, "items", u.item_id);
      const itemSnap = raised ? await tx.get(itemRef) : null;
      const now = new Date().toISOString(), note = "Scanned by mistake: undone by the person who scanned it";
      tx.update(unitRef, { status: "cancelled", cancelled_at: now, cancelled_by_id: who.id, cancelled_by_name: who.name, note, updated_at: now });
      let newQty = null;
      if (itemSnap && itemSnap.exists()) {
        const item = { id: itemSnap.id, ...itemSnap.data() };
        const oldQty = Number(item.quantity_on_hand) || 0; newQty = Math.max(0, oldQty - 1);
        const movId = rid("mov");
        tx.update(itemRef, { quantity_on_hand: newQty, last_serial_key: key, updated_at: now });
        tx.set(doc(db, "movements", movId), {
          id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
          serial_number: u.serial_number, direction: "out", quantity_delta: 1,
          location_from: item.location, location_to: "External", user_id: who.id, user_name: who.name,
          reason: `[Serial booked in by mistake] ${u.serial_number}: ${note} (Old: ${oldQty} → New: ${newQty})`, source: "scan",
        });
        const i = this.items.findIndex((x) => x.id === item.id);
        if (i >= 0) this.items[i] = { ...this.items[i], quantity_on_hand: newQty, updated_at: now };
      }
      const id = "sev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      tx.set(doc(db, "serial_events", id), {
        id, serial_key: key, serial_number: u.serial_number, type: "cancelled", item_id: u.item_id, item_name: u.item_name,
        note, user_id: who.id, user_name: who.name, app: "Label Station", timestamp: now,
      });
      undone = { unit: u, newQty };
    });
    return undone;
  },

  /** An item by its barcode / SKU / id, or else the product a booked-in serial belongs to.
   *  Returns { item, unit } (unit only for a serial), or null. */
  async findItemOrSerial(code) {
    const item = this.findByCode(code);
    if (item) return { item, unit: null };
    if (!this.user || this.normaliseSerial(code).length < 4) return null;
    try {
      const unit = await this.lookupSerial(code);
      const product = unit && this.items.find((i) => i.id === unit.item_id);
      return product ? { item: product, unit } : null;
    } catch (e) { return null; }
  },

  /** Move a product to another location: the item plus a history entry
   *  ("Location changed: A -> B"), as Payaz Stock does. Returns true if it moved. */
  async setLocation(itemId, location) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const loc = String(location || "").trim();
    if (!loc) return false;
    const itemRef = doc(db, "items", itemId);
    let moved = false;
    await runTransaction(db, async (tx) => {
      const snap = await tx.get(itemRef);
      if (!snap.exists()) throw new Error("That item isn't in the stock app any more.");
      const item = { id: snap.id, ...snap.data() };
      if ((item.location || "").trim() === loc) return;
      const now = new Date().toISOString(), movId = rid("mov");
      tx.update(itemRef, { location: loc, updated_at: now });
      tx.set(doc(db, "movements", movId), {
        id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
        serial_number: null, direction: "adjustment", quantity_delta: 0,
        location_from: item.location || "", location_to: loc,
        user_id: this.user.uid, user_name: this.userName,
        reason: `Location changed: ${item.location || "(none)"} → ${loc}`, source: "manual",
      });
      moved = true;
    });
    if (moved) {
      const i = this.items.findIndex((x) => x.id === itemId);
      if (i >= 0) this.items[i] = { ...this.items[i], location: loc };
      if (!this.locations.includes(loc)) this.locations = [...this.locations, loc].sort();
      // Add it to the stock app's list of locations (best effort)
      try {
        const id = "loc_" + loc.toLowerCase().replace(/[^a-z0-9]/g, "_");
        const b = writeBatch(db); b.set(doc(db, "locations", id), { id, name: loc, created_at: new Date().toISOString() }, { merge: true }); await b.commit();
      } catch (e) {}
    }
    return moved;
  },
};
