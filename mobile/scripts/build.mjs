#!/usr/bin/env node
/**
 * Build de la webapp móvil (mobile/www):
 *  1. Regenera src/profiles.json desde porcipeso/drivers/profiles.yaml.
 *  2. Copia porcipeso/ui/static → www/ (la UI NO se modifica en origen).
 *  3. Bundle esbuild de src/main.ts → www/shim.js (IIFE).
 *  4. Inyecta <script src="shim.js"> ANTES de app.js en www/index.html.
 *  5. Copia sql-wasm.wasm (fallback web de la DB) a www/.
 */
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
const MOBILE = join(HERE, "..");
const REPO = join(MOBILE, "..");
const STATIC = join(REPO, "porcipeso", "ui", "static");
const WWW = join(MOBILE, "www");

// 1. profiles.json
execFileSync(process.execPath, [join(HERE, "gen_profiles.mjs")], { stdio: "inherit" });

// 2. copiar la UI tal cual
if (!existsSync(STATIC)) throw new Error(`no existe la UI estática: ${STATIC}`);
rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
cpSync(STATIC, WWW, { recursive: true });

// 3. bundle del shim
await build({
  entryPoints: [join(MOBILE, "src", "main.ts")],
  outfile: join(WWW, "shim.js"),
  bundle: true,
  format: "iife",
  platform: "browser",
  target: ["es2021"],
  sourcemap: false,
  minify: true,
  logLevel: "info",
});

// 4. inyectar el shim ANTES de app.js
const indexPath = join(WWW, "index.html");
let html = readFileSync(indexPath, "utf-8");
const appTag = '<script src="app.js"></script>';
if (!html.includes(appTag)) {
  throw new Error(`index.html sin ${appTag}: no puedo inyectar el shim`);
}
if (!html.includes('src="shim.js"')) {
  html = html.replace(appTag, `<script src="shim.js"></script>\n${appTag}`);
  writeFileSync(indexPath, html, "utf-8");
}

// 5. wasm de sql.js para el fallback web. OJO: esbuild (platform browser)
// resuelve la variante "browser" de sql.js, que pide sql-wasm-browser.wasm.
for (const f of ["sql-wasm.wasm", "sql-wasm-browser.wasm"]) {
  const src = join(MOBILE, "node_modules", "sql.js", "dist", f);
  if (existsSync(src)) cpSync(src, join(WWW, f));
}

console.log(`OK: www/ listo (UI copiada + shim.js inyectado antes de app.js)`);
