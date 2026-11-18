// Rebuild js/firebase.js (run after changing scripts/firebase-entry.mjs or the firebase version).
import { build } from "esbuild";
await build({
  entryPoints: ["scripts/firebase-entry.mjs"], bundle: true, format: "esm", minify: true,
  target: ["chrome90"], outfile: "js/firebase.js", legalComments: "eof",
  banner: { js: "// Firebase JS SDK (Apache-2.0), bundled for the Payaz Label Station. Do not edit: run node scripts/build-firebase.mjs" },
});
console.log("js/firebase.js built");
