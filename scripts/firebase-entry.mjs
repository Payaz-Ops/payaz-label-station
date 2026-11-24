// The parts of Firebase the label app uses (bundled into js/firebase.js by scripts/build-firebase.mjs).
export { initializeApp } from "firebase/app";
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithEmailAndPassword, signOut, onAuthStateChanged, sendPasswordResetEmail,
} from "firebase/auth";
export {
  initializeFirestore, collection, getDocs, doc, getDoc, writeBatch, runTransaction,
  query, where, getCountFromServer, serverTimestamp, orderBy, limit,
} from "firebase/firestore";
