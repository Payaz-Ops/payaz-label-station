// Link to the Payaz Stock app (payaz-stock.web.app): same Firebase project and
// database, same rules. Staff sign in with their Payaz Stock email and password.
// Reading items needs any sign-in; adding items needs an active staff profile
// (staff_accounts/{uid}), exactly as in the stock app.
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  initializeFirestore, collection, getDocs, doc, getDoc, writeBatch, runTransaction,
  query, where, getCountFromServer, serverTimestamp, orderBy, limit,
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

/* ---------- people on this tablet ----------
   Each person signs in once with their Payaz Stock email and password and picks a
   4-digit PIN. Their sign-in is kept in its own Firebase app (its own saved
   session), so switching person needs only the PIN and everything they do is
   recorded under their own name. Passwords are never stored; the PIN is kept as
   a salted hash on this tablet only. */
const PEOPLE_KEY = "payaz-people";
const MAX_TRIES = 5;
const instances = {}; // appName -> { app, auth, db }
function instance(appName) {
  if (!instances[appName]) {
    const a = initializeApp(CONFIG, appName);
    // initializeAuth without a popup resolver: no Google sign-in iframes, which
    // don't work inside the Android app. Stay signed in between launches.
    const au = initializeAuth(a, { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
    const d = initializeFirestore(a, { experimentalAutoDetectLongPolling: true }, DATABASE);
    instances[appName] = { app: a, auth: au, db: d };
  }
  return instances[appName];
}
let auth = null, db = null; // the person using the tablet now (null when locked)
function init() {
  if (!db) { const e = new Error("Choose your name and enter your PIN first."); e.code = "locked"; throw e; }
}
function loadPeople() { try { return JSON.parse(localStorage.getItem(PEOPLE_KEY)) || []; } catch (e) { return []; } }
function savePeople(list) { localStorage.setItem(PEOPLE_KEY, JSON.stringify(list)); }
const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
async function pinHash(pin, saltB64) {
  const salt = Uint8Array.from(atob(saltB64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  return b64(await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 150000, hash: "SHA-256" }, key, 256));
}
async function newPin(pin) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  return { salt, hash: await pinHash(pin, salt) };
}
const err = (code, message) => Object.assign(new Error(message), { code });

// Damage reasons, as in Payaz Stock's Report Damage form
export const DAMAGE_REASONS = {
  damaged_production: "Damaged in production",
  broken_component: "Broken or faulty part",
  inventory_discrepancy: "Count mismatch",
  missing_loss: "Missing or lost",
  other: "Other",
};
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

  person: null,   // the person using the tablet now: { id, name, email }
  watchers: [],
  /** Calls back whenever the person using the tablet changes (unlock or lock). */
  watch(callback) { this.watchers.push(callback); },
  _changed() { this.watchers.forEach((f) => { try { f(this.user); } catch (e) {} }); },

  /** Everyone set up on this tablet: [{ id, name, email }], in name order. */
  people() {
    return loadPeople().map(({ id, name, email }) => ({ id, name, email }))
      .sort((a, b) => a.name.localeCompare(b.name, "en", { sensitivity: "base" }));
  },

  /** Step 1 of adding a person (or a forgotten PIN): sign in with their email and
   *  password and check they're active staff. Nothing is saved until finishPerson. */
  async checkPerson(email, password) {
    email = String(email || "").trim();
    const known = loadPeople().find((p) => p.email.toLowerCase() === email.toLowerCase());
    const appName = known ? known.appName : "payaz-u-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const inst = instance(appName);
    const cred = await signInWithEmailAndPassword(inst.auth, email, password);
    const snap = await getDoc(doc(inst.db, "staff_accounts", cred.user.uid));
    const profile = snap.exists() ? snap.data() : null;
    if (!profile || profile.disabled === true || profile.removed === true) {
      await signOut(inst.auth);
      throw err("not-staff", `${email} isn't set up as Payaz Stock staff (or the account is turned off). Ask an admin to add you in Payaz Stock > Manage Staff.`);
    }
    this._pending = { id: cred.user.uid, name: profile.name || cred.user.displayName || email, email, appName, known: !!known };
    return { name: this._pending.name };
  },
  /** Step 2: save their PIN. Returns the person. */
  async finishPerson(pin) {
    const p = this._pending;
    if (!p) throw err("no-person", "Sign in with your email and password first.");
    if (!/^\d{4}$/.test(String(pin))) throw err("bad-pin", "The PIN must be 4 numbers.");
    const others = loadPeople().filter((x) => x.id !== p.id && x.email.toLowerCase() !== p.email.toLowerCase());
    savePeople([...others, { id: p.id, name: p.name, email: p.email, appName: p.appName, pin: await newPin(pin), tries: 0 }]);
    this._pending = null;
    return { id: p.id, name: p.name, email: p.email };
  },
  /** Gave up part way: a new person's sign-in is ended (a known person's is kept). */
  async cancelPerson() {
    const p = this._pending; this._pending = null;
    if (p && !p.known) { try { await signOut(instance(p.appName).auth); } catch (e) {} }
  },

  /** Unlock the tablet for a person with their PIN. Wrong PINs count down; after
   *  5 wrong tries (or if their saved sign-in has ended) they sign in again with
   *  their password (code "needs-password"). */
  async unlock(id, pin) {
    const list = loadPeople(), p = list.find((x) => x.id === id);
    if (!p) throw err("unknown", "That person isn't set up on this tablet any more.");
    if ((p.tries || 0) >= MAX_TRIES) throw err("needs-password", "Too many wrong PINs. Sign in with your password to choose a new PIN.");
    if ((await pinHash(pin, p.pin.salt)) !== p.pin.hash) {
      p.tries = (p.tries || 0) + 1; savePeople(list);
      const left = MAX_TRIES - p.tries;
      throw left > 0 ? err("wrong-pin", `Wrong PIN. ${left} ${left === 1 ? "try" : "tries"} left.`) : err("needs-password", "Too many wrong PINs. Sign in with your password to choose a new PIN.");
    }
    p.tries = 0; savePeople(list);
    const inst = instance(p.appName);
    await inst.auth.authStateReady();
    const user = inst.auth.currentUser;
    if (!user || user.uid !== p.id) throw err("needs-password", "Your sign-in has ended. Sign in with your password again.");
    auth = inst.auth; db = inst.db;
    this.user = user; this.person = { id: p.id, name: p.name, email: p.email };
    try {
      await this.loadProfile();
    } catch (e) {
      this.profile = { name: p.name }; // offline: carry on with the name saved on the tablet
    }
    if (this.profile && (this.profile.disabled === true || this.profile.removed === true)) {
      this.lock(); this.removePerson(p.id);
      throw err("not-staff", "Your Payaz Stock login has been turned off, so you've been taken off this tablet. Ask an admin.");
    }
    if (this.profile && this.profile.name && this.profile.name !== p.name) { p.name = this.profile.name; savePeople(list); }
    this._changed();
    return this.person;
  },

  /** Back to "Who's using the tablet?". Each person stays signed in underneath. */
  lock() {
    const was = !!db;
    auth = null; db = null; this.user = null; this.profile = null; this.person = null;
    if (was) this._changed();
  },

  /** Take a person off this tablet (they'd sign in with their password to come back). */
  async removePerson(id) {
    const list = loadPeople(), p = list.find((x) => x.id === id);
    if (!p) return;
    savePeople(list.filter((x) => x.id !== id));
    if (this.person && this.person.id === id) this.lock();
    try { await signOut(instance(p.appName).auth); } catch (e) {}
  },

  /** Before PIN sign-in, one shared sign-in was kept under "payaz-stock": end it. */
  async forgetOldSignIn() {
    try { const old = instance("payaz-stock"); await old.auth.authStateReady(); if (old.auth.currentUser) await signOut(old.auth); } catch (e) {}
  },

  resetPassword(email) { return sendPasswordResetEmail(instance("payaz-reset").auth, email.trim()); },

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
   * A unit that was never booked in (missed when stock was added) is still recorded
   * as sent on the order, without changing the stock count.
   * Returns { kind: "dispatched" | "same_order" | "already_sent" | "not_in_stock" | "not_booked_in", unit }.
   */
  async dispatchSerial(rawSerial, orderNumber) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const serial = this.normaliseSerial(rawSerial), key = this.serialKey(rawSerial);
    const order = String(orderNumber || "").trim();
    const who = { id: this.user.uid, name: this.userName };
    const unitRef = doc(db, "serial_units", key);
    // Never booked in? Work out the product from similar serial numbers first
    // (a search can't run inside the save below).
    let guess = null;
    if (!(await getDoc(unitRef)).exists()) guess = await this.guessSerialItem(serial).catch(() => null);
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
        const unit = {
          serial_key: key, serial_number: serial,
          item_id: guess ? guess.item_id : "", item_name: guess ? guess.item_name : "Unknown product", item_sku: guess ? guess.item_sku : "",
          status: "dispatched", received_at: now, received_by_id: who.id, received_by_name: who.name, received_mode: "not_booked_in",
          order_number: order, dispatched_at: now, dispatched_by_id: who.id, dispatched_by_name: who.name, dispatched_app: "Label Station",
          note: guess ? "Never booked in. Product worked out from similar serial numbers." : "Never booked in. Product not known.",
          updated_at: now,
        };
        tx.set(unitRef, unit);
        event({ item_id: unit.item_id, item_name: guess ? unit.item_name : "", type: "not_booked_in", note: "Sent on an order but never booked in: recorded on the order, stock count not changed" });
        result = { kind: "not_booked_in", unit };
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

  /** The product a serial number most likely belongs to: the one whose booked-in
   *  serials share the longest start with it (same length, at least 4 characters
   *  in common, and only one product that close). null if it can't tell. */
  async guessSerialItem(rawSerial) {
    const key = this.serialKey(rawSerial);
    if (key.length < 6) return null;
    const pre = key.slice(0, 4);
    const snap = await getDocs(query(collection(db, "serial_units"), where("serial_key", ">=", pre), where("serial_key", "<", pre + "\uf8ff"), limit(400)));
    let best = 0, found = new Map();
    snap.forEach((d) => {
      const u = d.data();
      if (!u.item_id || u.status === "cancelled" || u.serial_key === key || u.serial_key.length !== key.length) return;
      let n = 0;
      while (n < key.length && u.serial_key[n] === key[n]) n++;
      if (n > best) { best = n; found = new Map(); }
      if (n === best) found.set(u.item_id, u.item_name);
    });
    if (best < 4 || found.size !== 1) return null;
    const [itemId, itemName] = [...found][0];
    const item = this.items.find((i) => i.id === itemId);
    return { item_id: itemId, item_name: (item && item.name) || itemName || "", item_sku: (item && item.SKU) || "" };
  },

  /**
   * Log damaged or lost stock (the same as Payaz Stock's Report Damage): stock down,
   * a history entry, and a damage record with its own code (DMG and six digits) for
   * the damage box label. A booked-in serial is marked damaged too. Products tracked
   * by serial number need the serial of an in-stock unit, one at a time.
   * Returns the damage record.
   */
  async recordDamage(itemId, quantity, reasonCategory, notes = "", rawSerial = "") {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    const who = { id: this.user.uid, name: this.userName };
    const serial = rawSerial ? this.normaliseSerial(rawSerial) : "";
    const key = serial ? this.serialKey(serial) : "";
    quantity = Math.max(1, Math.round(quantity || 1));
    for (let attempt = 0; attempt < 6; attempt++) {
      const n = new Uint32Array(1);
      crypto.getRandomValues(n);
      const code = "DMG" + String(n[0] % 1000000).padStart(6, "0");
      const logRef = doc(db, "damage_loss_logs", code), itemRef = doc(db, "items", itemId);
      let log = null, taken = false;
      await runTransaction(db, async (tx) => {
        log = null; taken = false;
        if ((await tx.get(logRef)).exists()) { taken = true; return; }
        const itemSnap = await tx.get(itemRef);
        if (!itemSnap.exists()) throw new Error("That item isn't in the stock app any more.");
        const item = { id: itemSnap.id, ...itemSnap.data() };
        const unitSnap = key ? await tx.get(doc(db, "serial_units", key)) : null;
        const unit = unitSnap && unitSnap.exists() ? unitSnap.data() : null;
        const locked = item.tracking_type === "serial";
        if (locked) {
          if (!serial) throw new Error(`${item.name} is tracked by serial number: scan the serial number of the damaged unit.`);
          if (!unit) throw new Error(`Serial ${serial} isn't booked in. Book it in first (Book in serials), then log the damage.`);
          if (unit.item_id !== item.id) throw new Error(`Serial ${serial} is booked in as ${unit.item_name}, not ${item.name}.`);
          if (unit.status !== "in_stock") throw new Error(`Serial ${serial} isn't in stock (it's recorded as ${unit.status}).`);
          quantity = 1;
        }
        const now = new Date().toISOString();
        const oldQty = Number(item.quantity_on_hand) || 0, newQty = Math.max(0, oldQty - quantity);
        const markUnit = unit && unit.status === "in_stock";
        tx.update(itemRef, { quantity_on_hand: newQty, ...(markUnit && locked ? { last_serial_key: key } : {}), updated_at: now });
        const reasonText = DAMAGE_REASONS[reasonCategory] ? reasonCategory : "other";
        const movId = rid("mov");
        tx.set(doc(db, "movements", movId), {
          id: movId, timestamp: now, item_id: item.id, item_name: item.name, item_sku: item.SKU,
          serial_number: serial || null, direction: "out", quantity_delta: quantity,
          location_from: item.location, location_to: `Damage box ${code} (${reasonText})`,
          user_id: who.id, user_name: who.name,
          reason: `[Damage/Loss ${code}: ${reasonText}] ${notes || "Logged damage/loss discrepancy"} (Old: ${oldQty} \u2192 New: ${newQty})`,
          source: "manual",
        });
        log = {
          id: code, ref_code: code, item_id: item.id, item_name: item.name, item_sku: item.SKU || "",
          quantity, reason_category: reasonText, notes, serial_number: serial, box_status: "in_box",
          timestamp: now, user_id: who.id, user_name: who.name,
        };
        tx.set(logRef, log);
        if (markUnit) {
          tx.update(doc(db, "serial_units", key), { status: "damaged", damage_ref: code, damaged_at: now, damaged_by_id: who.id, damaged_by_name: who.name, updated_at: now });
          const id = "sev_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
          tx.set(doc(db, "serial_events", id), { id, serial_key: key, serial_number: unit.serial_number, type: "damaged", item_id: unit.item_id, item_name: unit.item_name, ref: code, user_id: who.id, user_name: who.name, app: "Label Station", timestamp: now });
        }
        const i = this.items.findIndex((x) => x.id === item.id);
        if (i >= 0) this.items[i] = { ...this.items[i], quantity_on_hand: newQty, updated_at: now };
      });
      if (!taken) return log;
    }
    throw new Error("Couldn't make a unique damage code. Please try again.");
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

  /* ---------- spot checks (small blind counts, Payaz Stock's spot_checks) ----------
     Keep SPOT in step with Payaz Stock's src/lib/spotChecks.ts. */
// sampleOver: serial items with more units than this are counted by a total + a sample
  // of `sample` serials (+ `sampleMore` if most were already scanned at the last check)
  SPOT: { items: 10, minSerial: 3, bigValue: 50, bigItems: 3, deep: 15, days: [1, 15], sampleOver: 15, sample: 30, sampleMore: 10 },

  /** The most recent scheduled date (1st or 15th) up to today, at 00:00. */
  lastScheduledDate(now = new Date()) {
    const d = now.getDate(), day = [...this.SPOT.days].reverse().find((x) => x <= d);
    return day ? new Date(now.getFullYear(), now.getMonth(), day) : new Date(now.getFullYear(), now.getMonth() - 1, this.SPOT.days[this.SPOT.days.length - 1]);
  },

  /** { open: a check requested or in progress (or null), due: true if one should be done now }. */
  async spotStatus() {
    init();
    const col = collection(db, "spot_checks");
    const open = await getDocs(query(col, where("status", "in", ["requested", "counting", "deep"]), limit(1)));
    if (!open.empty) return { open: open.docs[0].data(), due: true };
    const last = await getDocs(query(col, orderBy("created_at", "desc"), limit(1)));
    const lastAt = last.empty ? "" : last.docs[0].data().created_at || "";
    return { open: null, due: !lastAt || lastAt < this.lastScheduledDate().toISOString() };
  },

  /** Picks items to count: some serial-tracked (tablets, readers), the rest weighted
   *  towards items not counted for a while or wrong last time. */
  pickSpotItems(n, minSerial, exclude = [], preferLocations = []) {
    const skip = new Set(exclude);
    const pool = this.items.filter((i) => !i.is_discontinued && !skip.has(i.id) && ((Number(i.quantity_on_hand) || 0) > 0 || i.tracking_type === "serial"));
    const now = Date.now();
    const weight = (i) => {
      const days = i.last_counted_at ? (now - new Date(i.last_counted_at).getTime()) / 864e5 : 60;
      return 1 + Math.min(8, days / 7) + (i.last_count_diff ? 3 : 0) + (preferLocations.includes(i.location) ? 4 : 0) + Math.min(3, (Number(i.unit_cost) || 0) / 50);
    };
    const draw = (list, k) => {
      const out = [], left = [...list];
      while (out.length < k && left.length) {
        const total = left.reduce((a, i) => a + weight(i), 0);
        let r = Math.random() * total, idx = 0;
        while (idx < left.length - 1 && (r -= weight(left[idx])) > 0) idx++;
        out.push(left.splice(idx, 1)[0]);
      }
      return out;
    };
    const serial = draw(pool.filter((i) => i.tracking_type === "serial"), minSerial);
    const rest = draw(pool.filter((i) => !serial.includes(i)), n - serial.length);
    return [...serial, ...rest].map((i) => i.id);
  },

  /** Starts a spot check (or carries on a requested one). Returns the check. */
  async startSpotCheck(requested) {
    init();
    if (!this.user) throw new Error("Sign in to the stock app first.");
    if (!this.items.length) await this.refresh();
    const now = new Date().toISOString();
    const item_ids = this.pickSpotItems(this.SPOT.items, this.SPOT.minSerial);
    if (!item_ids.length) throw new Error("There's no stock to count yet.");
    const id = requested ? requested.id : "spot_" + now.replace(/\D/g, "").slice(0, 14) + "_" + Math.random().toString(36).slice(2, 6);
    const check = {
      ...(requested || { id, reason: "scheduled", created_at: now }),
      status: "counting", started_at: now, started_by_id: this.user.uid, started_by_name: this.userName,
      item_ids, deep_item_ids: [], results: {}, updated_at: now,
    };
    const b = writeBatch(db);
    if (requested) b.update(doc(db, "spot_checks", id), check); else b.set(doc(db, "spot_checks", id), check);
    await b.commit();
    return check;
  },

  /** What the system expects for an item right now (read fresh): quantity, and for a
   *  serial-tracked item the serials in stock. */
  async spotExpected(itemId) {
    init();
    const snap = await getDoc(doc(db, "items", itemId));
    const item = snap.exists() ? { id: snap.id, ...snap.data() } : this.items.find((i) => i.id === itemId);
    if (item && item.tracking_type === "serial") {
      const q = await getDocs(query(collection(db, "serial_units"), where("item_id", "==", itemId), where("status", "==", "in_stock")));
      const serials = q.docs.map((d) => d.data().serial_number);
      return { item, expected: serials.length, serials };
    }
    return { item, expected: Number(item && item.quantity_on_hand) || 0, serials: null };
  },

  /** The serials scanned for an item at the most recent earlier spot check (to ask for
   *  different boxes this time). */
  async lastSpotSample(itemId, excludeCheckId) {
    init();
    const q = await getDocs(query(collection(db, "spot_checks"), orderBy("created_at", "desc"), limit(12)));
    for (const d of q.docs) {
      const c = d.data();
      if (c.id === excludeCheckId) continue;
      const r = c.results && c.results[itemId];
      if (r && Array.isArray(r.sample)) return r.sample;
    }
    return [];
  },

  /** Saves one item's result on the check, and when it was last counted on the item. */
  async saveSpotResult(checkId, itemId, result) {
    init();
    const b = writeBatch(db), now = new Date().toISOString();
    b.update(doc(db, "spot_checks", checkId), { [`results.${itemId}`]: { ...result, at: now, by_id: this.user.uid, by_name: this.userName }, updated_at: now });
    b.update(doc(db, "items", itemId), { last_counted_at: now, last_count_diff: result.diff || 0 });
    await b.commit();
  },

  /** Big difference: any serial-tracked item short, or over £bigValue, or bigItems or more items wrong. */
  spotSeverity(results) {
    const r = Object.values(results);
    // A serial-tracked item is also wrong if a unit is missing or one that isn't booked in turned up
    const bad = (x) => x.diff || (x.missing && x.missing.length) || (x.extra && x.extra.length);
    const wrong = r.filter(bad), short = wrong.filter((x) => x.diff < 0 || (x.missing && x.missing.length)), over = wrong.filter((x) => x.diff > 0 || (x.extra && x.extra.length));
    const valueOff = wrong.reduce((a, x) => a + Math.abs(x.value || 0), 0);
    const big = short.some((x) => x.serial) || valueOff > this.SPOT.bigValue || wrong.length >= this.SPOT.bigItems;
    return { outcome: !wrong.length ? "green" : big ? "red" : "amber", over: over.length > 0, wrong: wrong.length, short: short.length, overCount: over.length, valueOff, counted: r.length };
  },

  /** Adds a deeper count: more items, favouring the locations where differences were found. */
  async addDeepCount(check) {
    const wrongLocs = Object.values(check.results).filter((x) => x.diff).map((x) => x.location);
    const deep = this.pickSpotItems(this.SPOT.deep, this.SPOT.minSerial, [...check.item_ids], wrongLocs);
    const now = new Date().toISOString(), b = writeBatch(db);
    b.update(doc(db, "spot_checks", check.id), { status: "deep", deep_item_ids: deep, updated_at: now });
    await b.commit();
    return { ...check, status: "deep", deep_item_ids: deep };
  },

  async finishSpotCheck(check) {
    const sev = this.spotSeverity(check.results), now = new Date().toISOString(), b = writeBatch(db);
    const summary = { counted: sev.counted, correct: sev.counted - sev.wrong, short: sev.short, over: sev.overCount, value_off: Math.round(sev.valueOff * 100) / 100 };
    b.update(doc(db, "spot_checks", check.id), { status: "finished", finished_at: now, finished_by_name: this.userName, outcome: sev.outcome, over: sev.over, summary, updated_at: now });
    await b.commit();
    return { ...check, status: "finished", outcome: sev.outcome, over: sev.over, summary };
  },
};
