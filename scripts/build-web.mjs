// Copies the web app into www/ for the Android app (the repo root stays the
// GitHub Pages site). Run by `npm run sync` and by the GitHub build.
import { cpSync, rmSync, mkdirSync } from "node:fs";
rmSync("www", { recursive: true, force: true });
mkdirSync("www");
for (const p of ["index.html", "manifest.webmanifest", "js", "fonts", "img"]) cpSync(p, `www/${p}`, { recursive: true });
// The app's own version (the GitHub build number), so it can tell when a newer one is out
import { writeFileSync } from "node:fs";
writeFileSync("www/js/version.js", `// Written by scripts/build-web.mjs\nexport const APP_VERSION = ${Number(process.env.VERSION_CODE) || 0};\n`);
console.log("www/ ready");
