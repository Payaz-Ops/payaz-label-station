// Link to the Payaz Stock app (payaz-stock.web.app): same Firebase project and
// database, same rules. Staff sign in with their Payaz Stock email and password.
// Reading items needs any sign-in; adding items needs an active staff profile
// (staff_accounts/{uid}), exactly as in the stock app.
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
  initializeFirestore, collection, getDocs, doc, getDoc, writeBatch,
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

  /** Problems with a new item before saving (duplicate SKU/barcode, missing name). */
  check({ name, SKU, barcode }) {
    if (!name || !name.trim()) return "Give the item a name.";
    const sku = (SKU || "").trim().toLowerCase(), bc = (barcode || "").trim().toLowerCase();
    const dupSku = sku && this.items.find((i) => (i.SKU || "").toLowerCase() === sku);
    if (dupSku) return `SKU ${SKU} is already used by "${dupSku.name}".`;
    const dupBc = bc && this.items.find((i) => (i.barcode || "").toLowerCase() === bc || (i.SKU || "").toLowerCase() === bc);
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
      quantity_on_hand: Math.max(0, Number(input.quantity_on_hand) || 0),
      reorder_threshold: Math.max(0, Number(input.reorder_threshold ?? 5) || 0),
      unit_cost: 0,
      supplier: "",
      location: (input.location || "").trim() || "Bin A-1",
      notes: (input.notes || "").trim(),
      image_url: "",
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
};
