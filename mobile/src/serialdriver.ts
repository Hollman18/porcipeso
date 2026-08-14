/**
 * Driver genérico transporte-de-bytes → parser → Reading. Mismo rol que
 * run_driver() en porcipeso/drivers/runner.py, sobre cualquier
 * ByteTransport (Bluetooth SPP crudo o USB/OTG del plugin PorciSerial).
 *
 * Los bytes pasan SIEMPRE por ingressBytes() (signal.ts): ahí — y solo
 * ahí — se corrige la polaridad si el perfil tiene extra.invert_bits.
 */
import { Reading, ScaleProfile } from "./models";
import { FrameParser, isParserSupported, PARSER_REGISTRY } from "./parsers";
import type { ByteTransport, LinkStatus } from "./serial";
import { ingressBytes } from "./signal";

const POLL_MS = 40;

export class SerialScaleDriver {
  readonly profile: ScaleProfile;
  private parser: FrameParser;
  private pollTimer: ReturnType<typeof setTimeout> | null = null;
  private connected = false;
  private silentErrors = 0;

  constructor(
    profile: ScaleProfile,
    private transport: ByteTransport,
    private onReading: (r: Reading) => void,
    private onError: (msg: string) => void = () => {},
  ) {
    if (!isParserSupported(profile.parser)) {
      throw new Error(
        `el perfil '${profile.id}' usa el parser '${profile.parser}', ` +
          "aún no soportado en la app móvil (soportados: " +
          Object.keys(PARSER_REGISTRY).join(", ") + ")",
      );
    }
    this.profile = profile;
    this.parser = new PARSER_REGISTRY[profile.parser](profile);
  }

  async connect(): Promise<void> {
    await this.transport.open();
    this.connected = true;
    this.schedulePoll(0);
  }

  private schedulePoll(delayMs = POLL_MS): void {
    if (!this.connected) return;
    this.pollTimer = setTimeout(() => void this.pollOnce(), delayMs);
  }

  private async pollOnce(): Promise<void> {
    if (!this.connected) return;
    try {
      const raw = await this.transport.read();
      if (raw.length) {
        // PUNTO ÚNICO de entrada al parser: aquí se corrige invert_bits.
        for (const reading of this.parser.push(ingressBytes(this.profile, raw))) {
          this.onReading(reading);
        }
      }
      this.silentErrors = 0;
    } catch (e) {
      // un fallo transitorio del bridge no tumba el driver; tres seguidos sí
      if (++this.silentErrors >= 3) {
        this.connected = false;
        this.onError(`Error leyendo ${this.transport.label}: ${String(e)}`);
      }
    } finally {
      this.schedulePoll();
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    if (this.pollTimer !== null) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    await this.transport.close();
  }

  async isConnected(): Promise<boolean> {
    return this.connected;
  }

  /**
   * Estado REAL del enlace de transporte para el indicador HONESTO: durante
   * una reconexión transparente del SPP el driver sigue "conectado"
   * (isConnected=true, el motor conserva el pesaje) pero el enlace está
   * "reconnecting" — la UI lo muestra en ámbar en vez de mentir en verde.
   * null si el transporte no reporta estado (p.ej. USB).
   */
  linkStatus(): LinkStatus | null {
    return this.transport.status ? this.transport.status() : null;
  }
}
