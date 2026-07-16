#!/usr/bin/env node
/**
 * Genera src/profiles.json copiando porcipeso/drivers/profiles.yaml
 * (fuente de verdad del catálogo). Corre en `npm run build` y antes de
 * los tests; el JSON generado NO se edita a mano.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const SRC_YAML = join(REPO, "porcipeso", "drivers", "profiles.yaml");
const OUT_JSON = join(HERE, "..", "src", "profiles.json");

const doc = yaml.load(readFileSync(SRC_YAML, "utf-8"));
if (!doc || !Array.isArray(doc.profiles)) {
  throw new Error(`profiles.yaml sin lista 'profiles': ${SRC_YAML}`);
}

// Misma forma que ScaleProfile (defaults de porcipeso/core/models.py).
const profiles = doc.profiles.map((p) => ({
  id: String(p.id),
  name: String(p.name),
  brand: String(p.brand),
  parser: String(p.parser),
  transport: p.transport ?? "serial",
  port: p.port ?? null,
  baudrate: p.baudrate ?? 9600,
  bytesize: p.bytesize ?? 8,
  parity: p.parity ?? "N",
  stopbits: p.stopbits ?? 1,
  host: p.host ?? null,
  tcp_port: p.tcp_port ?? null,
  extra: p.extra ?? {},
}));

writeFileSync(OUT_JSON, JSON.stringify(profiles, null, 1) + "\n", "utf-8");
console.log(`OK: ${profiles.length} perfiles -> ${OUT_JSON}`);
