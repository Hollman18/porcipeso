/**
 * Bluetooth Low Energy (BLE) — el módulo del cliente es BLE (o dual-mode que
 * solo anuncia por BLE) y la app clásica lo veía pero no conectaba. Estas
 * pruebas usan un GATT FALSO y controlable (sin hardware) y verifican que:
 *   · el descubrimiento de la característica UART funciona por los 3 caminos
 *     (Nordic UART Service / HM-10 FFE0-FFE1 / fallback: primera NOTIFY);
 *   · las notificaciones (DataView) → bytes → MISMO pipeline de parsers que
 *     el clásico (invert_bits/reverse_frame incluidos);
 *   · la reconexión automática (backoff + watchdog sin-bytes) reconecta SOLO
 *     al mismo dispositivo al caerse el GATT y sigue leyendo tras la caída;
 *   · a través de SerialScaleDriver el pesaje SIGUE tras una desconexión BLE.
 */
import { describe, expect, it } from "vitest";
import {
  BleTransport,
  BleNoUartError,
  pickUartCharacteristic,
  describeGatt,
  formatGattDump,
  normalizeUuid,
  NUS_SERVICE,
  NUS_TX_NOTIFY,
  NUS_RX_WRITE,
  HM10_SERVICE,
  HM10_CHAR,
  MICROCHIP_SERVICE,
  MICROCHIP_TX_NOTIFY,
  MICROCHIP_RX_WRITE,
  MICROCHIP_RX_WRITE_NR,
  type BleClientLike,
  type BleServiceInfo,
} from "../src/ble";
import { SerialScaleDriver } from "../src/serialdriver";
import { Reading, ScaleProfile } from "../src/models";
import { invertBytes } from "../src/signal";

// ---------------------------------------------------------------- utilidades

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const decode = (b: Uint8Array): string => new TextDecoder().decode(b);
async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error("timeout esperando condición");
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** Servicios de ejemplo por cada camino de descubrimiento. */
const NUS_SERVICES: BleServiceInfo[] = [
  {
    uuid: NUS_SERVICE,
    characteristics: [
      { uuid: NUS_RX_WRITE, properties: { write: true, writeWithoutResponse: true } },
      { uuid: NUS_TX_NOTIFY, properties: { notify: true } },
    ],
  },
];
const HM10_SERVICES: BleServiceInfo[] = [
  {
    uuid: HM10_SERVICE,
    characteristics: [{ uuid: HM10_CHAR, properties: { notify: true, write: true } }],
  },
];
/** HM-10 declarado en forma 16-bit ("ffe0"/"ffe1"): normalizeUuid lo expande. */
const HM10_SHORT_SERVICES: BleServiceInfo[] = [
  { uuid: "ffe0", characteristics: [{ uuid: "ffe1", properties: { notify: true } }] },
];
/** Microchip / ISSC "Transparent UART" (RN4870/71, BM70/71) — RS232-BLE. */
const MICROCHIP_SERVICES: BleServiceInfo[] = [
  {
    uuid: MICROCHIP_SERVICE,
    characteristics: [
      { uuid: MICROCHIP_RX_WRITE, properties: { write: true } },
      { uuid: MICROCHIP_TX_NOTIFY, properties: { notify: true } },
    ],
  },
];
/** Microchip cuyo RX es SOLO write-sin-respuesta (algunos firmwares). */
const MICROCHIP_WNR_SERVICES: BleServiceInfo[] = [
  {
    uuid: MICROCHIP_SERVICE,
    characteristics: [
      { uuid: MICROCHIP_TX_NOTIFY, properties: { notify: true } },
      { uuid: MICROCHIP_RX_WRITE_NR, properties: { writeWithoutResponse: true } },
    ],
  },
];
/** Un GATT cualquiera cuya única NOTIFY vive en un servivio no estándar. */
const FALLBACK_SERVICES: BleServiceInfo[] = [
  {
    uuid: "0000180a-0000-1000-8000-00805f9b34fb", // Device Information (sin notify)
    characteristics: [{ uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: { read: true } }],
  },
  {
    uuid: "12345678-1234-5678-1234-56789abcdef0",
    characteristics: [
      { uuid: "12345678-1234-5678-1234-56789abcdef1", properties: { write: true } },
      { uuid: "12345678-1234-5678-1234-56789abcdef2", properties: { notify: true } },
    ],
  },
];

/** GATT FALSO: sirve DataViews como notificaciones, se "cae" a voluntad. */
class FakeGatt implements BleClientLike {
  connectCount = 0;
  disconnectCount = 0;
  startNotifCount = 0;
  lastSubscribed: { service: string; characteristic: string } | null = null;
  failNextConnects = 0;
  private onDisconnect: ((id: string) => void) | null = null;
  private notifyCb: ((v: DataView) => void) | null = null;
  private services: BleServiceInfo[];

  constructor(services: BleServiceInfo[]) {
    this.services = services;
  }

  async initialize(): Promise<void> {}
  async connect(_id: string, cb?: (id: string) => void): Promise<void> {
    if (this.failNextConnects > 0) {
      this.failNextConnects--;
      throw new Error("connect fail (simulado)");
    }
    this.connectCount++;
    this.onDisconnect = cb ?? null;
  }
  async disconnect(): Promise<void> {
    this.disconnectCount++;
    this.notifyCb = null;
  }
  async getServices(): Promise<BleServiceInfo[]> {
    return this.services;
  }
  async startNotifications(
    _id: string,
    service: string,
    characteristic: string,
    cb: (v: DataView) => void,
  ): Promise<void> {
    this.startNotifCount++;
    this.lastSubscribed = { service, characteristic };
    this.notifyCb = cb;
  }
  async stopNotifications(): Promise<void> {
    this.notifyCb = null;
  }

  // ---------------------------------------------------- controles de la prueba
  feed(bytes: number[]): void {
    this.notifyCb?.(new DataView(Uint8Array.from(bytes).buffer));
  }
  feedStr(s: string): void {
    this.feed(ascii(s));
  }
  /** El GATT se cae (el peripheral se apaga/aleja): el plugin avisa disconnect. */
  drop(): void {
    this.notifyCb = null;
    this.onDisconnect?.("dev");
  }
  failConnects(n: number): void {
    this.failNextConnects = n;
  }
  asClient(): BleClientLike {
    return this;
  }
}

const MATRIX_PROFILE: ScaleProfile = {
  id: "gx",
  name: "Genérica BLE",
  brand: "Test",
  parser: "matrix",
  transport: "bluetooth",
  extra: {},
};

// ------------------------------------------------ descubrimiento de característica

describe("pickUartCharacteristic — los 5 perfiles de Serial Bluetooth Terminal", () => {
  it("(1) Nordic UART Service: TX notify + RX write", () => {
    const uart = pickUartCharacteristic(NUS_SERVICES);
    expect(uart).not.toBeNull();
    expect(normalizeUuid(uart!.service)).toBe(NUS_SERVICE);
    expect(normalizeUuid(uart!.notifyChar)).toBe(NUS_TX_NOTIFY);
    expect(normalizeUuid(uart!.writeChar!)).toBe(NUS_RX_WRITE);
  });

  it("(2) TI CC254x / HM-10 / CC41-A: FFE0/FFE1 (notify+write)", () => {
    const uart = pickUartCharacteristic(HM10_SERVICES);
    expect(normalizeUuid(uart!.service)).toBe(HM10_SERVICE);
    expect(normalizeUuid(uart!.notifyChar)).toBe(HM10_CHAR);
  });

  it("(2') HM-10 en forma 16-bit ('ffe0'/'ffe1') se normaliza y matchea", () => {
    const uart = pickUartCharacteristic(HM10_SHORT_SERVICES);
    expect(normalizeUuid(uart!.service)).toBe(HM10_SERVICE);
    expect(normalizeUuid(uart!.notifyChar)).toBe(HM10_CHAR);
  });

  it("(3) Microchip / ISSC 'Transparent UART': TX notify + RX write (con respuesta)", () => {
    const uart = pickUartCharacteristic(MICROCHIP_SERVICES);
    expect(uart).not.toBeNull();
    expect(normalizeUuid(uart!.service)).toBe(MICROCHIP_SERVICE);
    expect(normalizeUuid(uart!.notifyChar)).toBe(MICROCHIP_TX_NOTIFY);
    expect(normalizeUuid(uart!.writeChar!)).toBe(MICROCHIP_RX_WRITE);
  });

  it("(3') Microchip con RX SOLO write-sin-respuesta → usa la variante WNR", () => {
    const uart = pickUartCharacteristic(MICROCHIP_WNR_SERVICES);
    expect(normalizeUuid(uart!.service)).toBe(MICROCHIP_SERVICE);
    expect(normalizeUuid(uart!.notifyChar)).toBe(MICROCHIP_TX_NOTIFY);
    expect(normalizeUuid(uart!.writeChar!)).toBe(MICROCHIP_RX_WRITE_NR);
  });

  it("(4/5) fallback genérico: la PRIMERA NOTIFY de un servicio DESCONOCIDO (+ WRITE)", () => {
    const uart = pickUartCharacteristic(FALLBACK_SERVICES);
    expect(uart!.service).toBe("12345678-1234-5678-1234-56789abcdef0");
    expect(uart!.notifyChar).toBe("12345678-1234-5678-1234-56789abcdef2");
    expect(uart!.writeChar).toBe("12345678-1234-5678-1234-56789abcdef1");
  });

  it("(5) fallback por INDICATE cuando el servicio raro solo indica (sin notify)", () => {
    const indicateOnly: BleServiceInfo[] = [
      {
        uuid: "aaaa1111-0000-1000-8000-00805f9b34fb",
        characteristics: [
          { uuid: "aaaa2222-0000-1000-8000-00805f9b34fb", properties: { indicate: true } },
        ],
      },
    ];
    const uart = pickUartCharacteristic(indicateOnly);
    expect(uart!.notifyChar).toBe("aaaa2222-0000-1000-8000-00805f9b34fb");
  });

  it("sin ninguna NOTIFY/INDICATE → null (no es una báscula serial-BLE)", () => {
    const none: BleServiceInfo[] = [
      { uuid: "0000180a-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: { read: true } },
      ] },
    ];
    expect(pickUartCharacteristic(none)).toBeNull();
  });
});

// ------------------------------------------------------- diagnóstico GATT

describe("diagnóstico GATT — cuando no hay UART, expón lo que el módulo publica", () => {
  const EXOTIC: BleServiceInfo[] = [
    {
      uuid: "0000180a-0000-1000-8000-00805f9b34fb", // Device Information
      characteristics: [
        { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: { read: true } },
      ],
    },
    {
      uuid: "abcd0000-1234-5678-1234-56789abcdef0", // servicio raro sin notify
      characteristics: [
        { uuid: "abcd0001-1234-5678-1234-56789abcdef0", properties: { write: true } },
      ],
    },
  ];

  it("describeGatt lista servicios + características con sus propiedades", () => {
    const dump = describeGatt(EXOTIC);
    expect(dump).toHaveLength(2);
    expect(dump[0].uuid).toBe("0000180a-0000-1000-8000-00805f9b34fb");
    expect(dump[0].characteristics[0]).toMatchObject({
      uuid: "00002a29-0000-1000-8000-00805f9b34fb",
      properties: ["read"],
    });
    expect(dump[1].characteristics[0].properties).toEqual(["write"]);
  });

  it("formatGattDump produce texto copiable con UUIDs y propiedades", () => {
    const text = formatGattDump(EXOTIC);
    expect(text).toContain("Servicio 0000180a-0000-1000-8000-00805f9b34fb");
    expect(text).toContain("abcd0001-1234-5678-1234-56789abcdef0 [write]");
  });

  it("BleTransport.open() rechaza con BleNoUartError que CARGA el volcado GATT", async () => {
    const gatt = new FakeGatt(EXOTIC);
    const t = new BleTransport("dev-1", { client: gatt.asClient(), sleep: () => Promise.resolve() });
    let caught: unknown = null;
    await t.open().catch((e) => (caught = e));
    expect(caught).toBeInstanceOf(BleNoUartError);
    const e = caught as BleNoUartError;
    expect(e.message).toMatch(/no_uart/);
    // el diagnóstico viaja para que la UI lo muestre y soporte clave el perfil
    expect(e.gatt).toHaveLength(2);
    expect(e.gattText).toContain("abcd0001-1234-5678-1234-56789abcdef0");
    // cerró limpio el GATT antes de rendirse
    expect(gatt.disconnectCount).toBeGreaterThanOrEqual(1);
  });
});

// -------------------------------------------------------- BleTransport (GATT sim)

describe("BleTransport — notificaciones → bytes → parser", () => {
  for (const [name, services] of [
    ["Nordic UART Service", NUS_SERVICES],
    ["HM-10 FFE0/FFE1", HM10_SERVICES],
    ["Microchip/ISSC Transparent UART", MICROCHIP_SERVICES],
    ["fallback primera NOTIFY", FALLBACK_SERVICES],
  ] as const) {
    it(`descubre y suscribe por: ${name}`, async () => {
      const gatt = new FakeGatt(services);
      const t = new BleTransport("dev-1", { client: gatt.asClient(), sleep: () => Promise.resolve() });
      await t.open();
      expect(t.status()).toBe("connected");
      expect(gatt.connectCount).toBe(1);
      expect(gatt.startNotifCount).toBe(1);

      // una notificación entra como bytes crudos, intactos
      gatt.feedStr("= 126.35");
      expect(decode(await t.read())).toBe("= 126.35");
      // sin datos nuevos → vacío (no bloquea)
      expect((await t.read()).length).toBe(0);
      await t.close();
      expect(t.status()).toBe("closed");
    });
  }

  it("los bytes crudos llegan intactos (apto para señal invertida)", async () => {
    const gatt = new FakeGatt(NUS_SERVICES);
    const t = new BleTransport("dev-1", { client: gatt.asClient(), sleep: () => Promise.resolve() });
    await t.open();
    // señal invertida a nivel TTL: bytes >= 0x80; el transporte NO los decodifica
    const inverted = Array.from(invertBytes(Uint8Array.from(ascii("= 126.35"))));
    gatt.feed(inverted);
    const got = await t.read();
    expect(Array.from(got)).toEqual(inverted); // intactos: la polaridad la corrige el pipeline
  });

  it("watchdog SIN DATOS: 'conectado' pero sin bytes en X s → reconecta", async () => {
    let clock = 0;
    const gatt = new FakeGatt(NUS_SERVICES);
    const t = new BleTransport("dev-1", {
      client: gatt.asClient(),
      backoffMs: [1],
      noDataTimeoutMs: 100,
      now: () => clock,
      sleep: () => Promise.resolve(),
    });
    await t.open(); // lastDataAt = 0
    clock = 50; // dentro del timeout → NO reconecta
    await t.read();
    expect(t.status()).toBe("connected");
    clock = 250; // pasó el timeout sin un byte → reconecta
    await t.read();
    expect(t.status()).toBe("reconnecting");
    await waitFor(() => t.status() === "connected");
    expect(gatt.connectCount).toBe(2);
  });

  it("el GATT se cae → reconecta SOLO y sigue leyendo tras la caída", async () => {
    const gatt = new FakeGatt(NUS_SERVICES);
    const t = new BleTransport("dev-1", {
      client: gatt.asClient(),
      backoffMs: [1],
      sleep: () => Promise.resolve(),
    });
    await t.open();
    gatt.feedStr("126.35\r\n");
    expect(decode(await t.read())).toBe("126.35\r\n");

    // el peripheral se apaga/aleja: el plugin avisa la desconexión
    gatt.drop();
    await t.read(); // detecta linkDown → dispara reconexión
    expect(t.status()).toBe("reconnecting");
    await waitFor(() => t.status() === "connected");
    expect(gatt.connectCount).toBe(2); // reconectó al MISMO dispositivo
    expect(gatt.disconnectCount).toBeGreaterThanOrEqual(1); // cerró limpio antes
    expect(gatt.startNotifCount).toBe(2); // re-suscribió las notificaciones

    // tramas POSTERIORES a la reconexión: NO se pierden
    gatt.feedStr("130.10\r\n");
    expect(decode(await t.read())).toBe("130.10\r\n");
  });

  it("reintenta con BACKOFF hasta lograrlo (tope repetido)", async () => {
    const gatt = new FakeGatt(NUS_SERVICES);
    const waits: number[] = [];
    const t = new BleTransport("dev-1", {
      client: gatt.asClient(),
      backoffMs: [500, 1000, 2000, 5000],
      sleep: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    await t.open();
    gatt.failConnects(5); // los primeros 5 reintentos fallan
    gatt.drop();
    await t.read(); // dispara reconexión
    await waitFor(() => t.status() === "connected");
    expect(waits.slice(0, 6)).toEqual([500, 1000, 2000, 5000, 5000, 5000]);
    expect(gatt.connectCount).toBe(2); // 1 inicial + la reconexión exitosa
  });

  it("close() DURANTE la reconexión la detiene (el usuario manda)", async () => {
    const gatt = new FakeGatt(NUS_SERVICES);
    const gate: { resolve: (() => void) | null } = { resolve: null };
    const t = new BleTransport("dev-1", {
      client: gatt.asClient(),
      backoffMs: [10],
      sleep: () => new Promise<void>((r) => (gate.resolve = r)),
    });
    await t.open();
    gatt.drop();
    await t.read(); // dispara la reconexión
    await new Promise((r) => setTimeout(r, 0)); // deja llegar al sleep
    expect(t.status()).toBe("reconnecting");
    const before = gatt.connectCount;
    await t.close();
    expect(t.status()).toBe("closed");
    gate.resolve?.();
    await new Promise((r) => setTimeout(r, 0));
    expect(gatt.connectCount).toBe(before); // NO reconectó tras cerrar
    expect((await t.read()).length).toBe(0); // read ya no toca el GATT
  });

  it("sin característica UART → open() lanza y desconecta limpio", async () => {
    const gatt = new FakeGatt([
      { uuid: "0000180a-0000-1000-8000-00805f9b34fb", characteristics: [
        { uuid: "00002a29-0000-1000-8000-00805f9b34fb", properties: { read: true } },
      ] },
    ]);
    const t = new BleTransport("dev-1", { client: gatt.asClient(), sleep: () => Promise.resolve() });
    await expect(t.open()).rejects.toThrow(/no_uart/);
    expect(gatt.disconnectCount).toBeGreaterThanOrEqual(1);
  });
});

// ---------------------------------------- SerialScaleDriver end-to-end sobre BLE

describe("SerialScaleDriver sobre BLE — pesaje continuo con reconexión", () => {
  it("las notificaciones alimentan el engine y el pesaje sigue tras una caída BLE", async () => {
    const gatt = new FakeGatt(HM10_SERVICES);
    const transport = new BleTransport("dev-1", {
      client: gatt.asClient(),
      backoffMs: [1],
      noDataTimeoutMs: 5000,
      sleep: () => Promise.resolve(),
    });
    const readings: Reading[] = [];
    const driver = new SerialScaleDriver(MATRIX_PROFILE, transport, (r) => readings.push(r));

    await driver.connect();
    expect(await driver.isConnected()).toBe(true);
    expect(driver.linkStatus()).toBe("connected");

    gatt.feedStr("= 126.35");
    await waitFor(() => readings.some((r) => Math.round(r.kg * 100) === 12635));

    // el módulo BLE se cae a mitad del pesaje
    gatt.drop();
    await waitFor(() => driver.linkStatus() === "reconnecting" || gatt.connectCount === 2);
    // el driver NUNCA se desconectó lógicamente → el motor conserva el pesaje
    expect(await driver.isConnected()).toBe(true);
    await waitFor(() => driver.linkStatus() === "connected");
    expect(gatt.connectCount).toBe(2);

    // tramas POSTERIORES siguen llegando PARSEADAS
    gatt.feedStr("= 130.10");
    await waitFor(() => readings.some((r) => Math.round(r.kg * 100) === 13010));

    await driver.disconnect();
    expect(driver.linkStatus()).toBe("closed");
  });
});
