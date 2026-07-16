/**
 * Entrypoint del bundle móvil (shim.js) — se inyecta ANTES de app.js.
 *
 * Instala SÍNCRONAMENTE el shim de fetch/WebSocket/window.open y arma
 * el backend embebido en segundo plano:
 *  - Android nativo: @capacitor-community/sqlite + Bluetooth SPP.
 *  - Web dev (npx vite/servidor cualquiera): sql.js + IndexedDB, sin BT
 *    (la báscula simulada funciona completa).
 */
import { Capacitor } from "@capacitor/core";
import { Hub, installShim, LocalBackend } from "./apishim";
import {
  createCapacitorDriver,
  createSqlJsDriver,
  idb,
  Repo,
  SqlDriver,
} from "./db";
import type { ScaleProfile } from "./models";
import profilesJson from "./profiles.json";

const PROFILES = profilesJson as unknown as ScaleProfile[];

async function nativeShareCsv(filename: string, csv: string): Promise<void> {
  const { Filesystem, Directory, Encoding } = await import("@capacitor/filesystem");
  const { Share } = await import("@capacitor/share");
  const res = await Filesystem.writeFile({
    path: filename,
    data: "﻿" + csv, // BOM: Excel abre UTF-8 con tildes bien
    directory: Directory.Cache,
    encoding: Encoding.UTF8,
  });
  await Share.share({ title: filename, files: [res.uri] });
}

async function createDriver(): Promise<{ driver: SqlDriver; native: boolean }> {
  if (Capacitor.isNativePlatform()) {
    return { driver: await createCapacitorDriver("porcipeso"), native: true };
  }
  let restore: Uint8Array | null = null;
  try {
    restore = await idb.load();
  } catch {
    restore = null;
  }
  const driver = await createSqlJsDriver({
    locateFile: (f) => "./" + f, // sql-wasm.wasm copiado a www/ por el build
    restore,
    persist: async (bytes) => {
      try {
        await idb.save(bytes);
      } catch {
        /* modo incógnito / cuota: seguimos en memoria */
      }
    },
  });
  return { driver, native: false };
}

async function initBackend(hub: Hub): Promise<LocalBackend> {
  const { driver, native } = await createDriver();
  const repo = await Repo.create(driver);
  return new LocalBackend({
    repo,
    profiles: PROFILES,
    hub,
    shareCsv: native ? nativeShareCsv : undefined,
  });
}

const hub = new Hub();
let ready: Promise<LocalBackend> | null = null;
const getBackend = (): Promise<LocalBackend> => (ready ??= initBackend(hub));

installShim(hub, getBackend);
void getBackend(); // warm-up: la DB queda lista antes del primer toque
