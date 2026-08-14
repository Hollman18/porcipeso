/**
 * Endurecimiento del SPP: RECONEXIÓN AUTOMÁTICA + LECTURA RESILIENTE.
 *
 * En campo el HC-05/BC04 pierde el socket (alimentación floja que reinicia el
 * módulo, el celular se aleja, ruido) → "mucha intermitencia, no toma bien los
 * datos". Estas pruebas usan un plugin BT FALSO y controlable que se "cae" a
 * voluntad y verifican que:
 *   · el transporte reconecta SOLO al mismo dispositivo y sigue leyendo las
 *     tramas POSTERIORES sin perderlas;
 *   · una excepción puntual de btRead no tumba el enlace; N seguidas sí;
 *   · el watchdog SIN DATOS reconecta aunque "conectado";
 *   · el backoff (0.5→1→2→5 s, tope 5 s) reintenta hasta lograrlo;
 *   · close() (el usuario desconecta) DETIENE la reconexión;
 *   · a través de SerialScaleDriver el pesaje sigue tras una caída.
 */
import { describe, expect, it } from "vitest";
import { RawBtTransport, type PorciSerialPlugin } from "../src/serial";
import { SerialScaleDriver } from "../src/serialdriver";
import { Reading, ScaleProfile } from "../src/models";

// ---------------------------------------------------------------- utilidades

function toB64(bytes: number[]): string {
  return Buffer.from(Uint8Array.from(bytes)).toString("base64");
}
function ascii(s: string): number[] {
  return Array.from(s, (c) => c.charCodeAt(0) & 0xff);
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Plugin BT FALSO y controlable: sirve chunks base64, se "cae" a voluntad. */
class FakeBtPlugin {
  connectCount = 0;
  disconnectCount = 0;
  private live = false; // socket "vivo" en el nativo
  private linkUp = true; // lo que btRead reporta como `connected`
  private failNextConnects = 0; // intentos de conexión que fallarán
  private throwNextReads = 0; // excepciones puntuales del puente
  private queue: string[] = []; // chunks base64 pendientes de drenar

  async btConnect(): Promise<void> {
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error("connect fail (simulado)");
    }
    this.connectCount++;
    this.live = true;
    this.linkUp = true;
    this.queue = []; // el nativo resetea su buffer al conectar
  }
  async btRead(): Promise<{ data: string; connected?: boolean }> {
    if (this.throwNextReads > 0) {
      this.throwNextReads--;
      throw new Error("bridge read fail (simulado)");
    }
    return { data: this.queue.shift() ?? "", connected: this.linkUp };
  }
  async btStatus(): Promise<{ connected: boolean }> {
    return { connected: this.live && this.linkUp };
  }
  async btDisconnect(): Promise<void> {
    this.disconnectCount++;
    this.live = false;
  }

  // ------------------------------------------------- controles de la prueba
  feed(s: string): void {
    this.queue.push(toB64(ascii(s)));
  }
  /** El hilo lector nativo "muere" (módulo reiniciado): el enlace cae. */
  dropSocket(): void {
    this.linkUp = false;
  }
  failConnects(n: number): void {
    this.failNextConnects = n;
  }
  throwReads(n: number): void {
    this.throwNextReads = n;
  }
  asPlugin(): PorciSerialPlugin {
    return this as unknown as PorciSerialPlugin;
  }
}

const decode = (b: Uint8Array): string => new TextDecoder().decode(b);

// ------------------------------------------------------------------ pruebas

describe("RawBtTransport — reconexión automática transparente", () => {
  it("se cae a mitad → reconecta SOLO y sigue leyendo las tramas POSTERIORES", async () => {
    const fake = new FakeBtPlugin();
    const t = new RawBtTransport("00:11:22:33:44:55", {
      plugin: fake.asPlugin(),
      backoffMs: [1],
      noDataTimeoutMs: 50,
      sleep: () => Promise.resolve(),
    });

    await t.open();
    expect(t.status()).toBe("connected");
    expect(fake.connectCount).toBe(1);

    fake.feed("126.35\r\n");
    expect(decode(await t.read())).toBe("126.35\r\n");

    // el módulo se reinicia: el hilo lector nativo reporta el socket muerto
    fake.dropSocket();
    await t.read(); // detecta connected:false → dispara reconexión
    expect(t.status()).toBe("reconnecting");

    await waitFor(() => t.status() === "connected");
    expect(fake.connectCount).toBe(2); // reconectó al MISMO dispositivo
    expect(fake.disconnectCount).toBeGreaterThanOrEqual(1); // cerró limpio antes

    // tramas POSTERIORES a la reconexión: NO se pierden
    fake.feed("130.10\r\n");
    expect(decode(await t.read())).toBe("130.10\r\n");
  });

  it("excepción puntual de btRead: NO tumba el enlace; N seguidas → reconecta", async () => {
    const fake = new FakeBtPlugin();
    const t = new RawBtTransport("AA:BB", {
      plugin: fake.asPlugin(),
      backoffMs: [1],
      maxReadFails: 3,
      sleep: () => Promise.resolve(),
    });
    await t.open();

    // dos fallos aislados: el read loop NO muere y el enlace sigue vivo
    fake.throwReads(2);
    expect((await t.read()).length).toBe(0);
    expect((await t.read()).length).toBe(0);
    expect(t.status()).toBe("connected");

    // una lectura buena limpia el contador de fallos
    fake.feed("100.0\r\n");
    expect(decode(await t.read())).toBe("100.0\r\n");

    // ahora 3 fallos SEGUIDOS → dispara la reconexión (sin crashear)
    fake.throwReads(3);
    await t.read();
    await t.read();
    await t.read();
    expect(t.status()).toBe("reconnecting");
    await waitFor(() => t.status() === "connected");
    expect(fake.connectCount).toBe(2);
  });

  it("watchdog SIN DATOS: 'conectado' pero sin bytes en X s → reconecta", async () => {
    let clock = 0;
    const fake = new FakeBtPlugin();
    const t = new RawBtTransport("AA:BB", {
      plugin: fake.asPlugin(),
      backoffMs: [1],
      noDataTimeoutMs: 100,
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    await t.open(); // lastDataAt = 0

    clock = 50; // dentro del timeout → NO reconecta
    await t.read();
    expect(t.status()).toBe("connected");

    clock = 250; // pasó el timeout sin un solo byte → reconecta
    await t.read();
    expect(t.status()).toBe("reconnecting");
    await waitFor(() => t.status() === "connected");
    expect(fake.connectCount).toBe(2);
  });

  it("reintenta con BACKOFF (0.5→1→2→5 s, tope 5 s) hasta lograrlo", async () => {
    const fake = new FakeBtPlugin();
    const waits: number[] = [];
    const t = new RawBtTransport("AA:BB", {
      plugin: fake.asPlugin(),
      backoffMs: [500, 1000, 2000, 5000],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await t.open();

    fake.failConnects(5); // los primeros 5 reintentos fallan
    fake.dropSocket();
    await t.read(); // dispara reconexión
    await waitFor(() => t.status() === "connected");

    // backoff en orden, con el último valor REPETIDO al topar (5 s)
    expect(waits.slice(0, 6)).toEqual([500, 1000, 2000, 5000, 5000, 5000]);
    expect(fake.connectCount).toBe(2); // 1 inicial + la reconexión exitosa
  });

  it("close() DURANTE la reconexión la detiene (el usuario manda)", async () => {
    const fake = new FakeBtPlugin();
    // holder (no `let`) para que el sleep quede "colgado" y lo liberemos a mano
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const t = new RawBtTransport("AA:BB", {
      plugin: fake.asPlugin(),
      backoffMs: [10],
      sleep: () =>
        new Promise<void>((r) => {
          gate.resolve = r;
        }),
    });
    await t.open();

    fake.dropSocket();
    await t.read(); // dispara la reconexión
    await tick(); // deja que el bucle llegue al sleep
    expect(t.status()).toBe("reconnecting");
    expect(gate.resolve).not.toBeNull();

    const before = fake.connectCount;
    await t.close(); // el usuario desconecta
    expect(t.status()).toBe("closed");
    gate.resolve?.(); // libera el sleep pendiente
    await tick();
    await tick();

    expect(fake.connectCount).toBe(before); // NO reconectó tras cerrar
    expect((await t.read()).length).toBe(0); // read() ya no toca el plugin
  });

  it("compat: el 2º arg histórico (plugin directo) sigue funcionando", async () => {
    const fake = new FakeBtPlugin();
    const t = new RawBtTransport("AA:BB", fake.asPlugin());
    await t.open();
    expect(t.status()).toBe("connected");
    fake.feed("42.0\r\n");
    expect(decode(await t.read())).toBe("42.0\r\n");
  });
});

describe("SerialScaleDriver — reconexión transparente end-to-end", () => {
  it("el pesaje SIGUE tras la caída del SPP (sin desconexión lógica)", async () => {
    const fake = new FakeBtPlugin();
    const transport = new RawBtTransport("AA:BB", {
      plugin: fake.asPlugin(),
      backoffMs: [1],
      noDataTimeoutMs: 30,
    });
    const profile: ScaleProfile = {
      id: "gx",
      name: "Genérica",
      brand: "Test",
      parser: "generic_regex",
      transport: "bluetooth",
      extra: {},
    };
    const readings: Reading[] = [];
    const driver = new SerialScaleDriver(profile, transport, (r) => readings.push(r));

    await driver.connect();
    expect(await driver.isConnected()).toBe(true);
    expect(driver.linkStatus()).toBe("connected");

    fake.feed("126.35\r\n");
    await waitFor(() => readings.some((r) => Math.round(r.kg * 100) === 12635));

    // el módulo se cae a mitad del pesaje
    fake.dropSocket();
    await waitFor(() => driver.linkStatus() === "reconnecting" || fake.connectCount === 2);
    // el driver NUNCA se desconectó lógicamente → el motor conserva el pesaje
    expect(await driver.isConnected()).toBe(true);
    await waitFor(() => driver.linkStatus() === "connected");
    expect(fake.connectCount).toBe(2);

    // tramas POSTERIORES: siguen llegando PARSEADAS (no se pierde el stream)
    fake.feed("130.10\r\n");
    await waitFor(() => readings.some((r) => Math.round(r.kg * 100) === 13010));

    await driver.disconnect();
    expect(driver.linkStatus()).toBe("closed");
  });
});
