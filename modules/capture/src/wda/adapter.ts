import { Socket } from "node:net";
import { validateDeviceRef, validateStreamError, type DeviceRef, type StreamError } from "../../../contracts/src/index.js";
import { CaptureOpenError, type CaptureSource } from "../index.js";
import type { CaptureClosed, CaptureError, CaptureEvent, CaptureSession } from "../session.js";
import { inspectJpeg, type JpegMetadata } from "./jpeg.js";
import { parseWda, WdaMediaError } from "./parser.js";

type Frame = Extract<CaptureEvent, { kind: "Frame" }>;
type Control = Extract<CaptureEvent, { kind: "SessionStarted" | "SessionEnded" | "CaptureEnded" | "CaptureFailed" }>;
type FailureCode = "malformed-media" | "runtime-overload" | "stream-interrupted";
class ControlOverflow extends Error {}
const IDENTITY = ["contractVersion", "platform", "namespace", "opaqueId"] as const;
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const own = Reflect.ownKeys(value);
  return own.length === keys.length && keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}
function error(code: FailureCode | "dependency-unavailable" | "capture-start-failed"): StreamError {
  const messages = {
    "malformed-media": "Source media is malformed",
    "runtime-overload": "Capture consumer is overloaded",
    "stream-interrupted": "Source stream was interrupted",
    "dependency-unavailable": "Source connection is unavailable",
    "capture-start-failed": "Source binding is invalid",
  };
  const scope = code === "dependency-unavailable" ? "service"
    : code === "capture-start-failed" ? "capture" : "stream";
  return validateStreamError({
    code, scope, disposition: code === "stream-interrupted" ? "state-unknown" : "terminal",
    safeMessage: messages[code],
  });
}
function invalid(): never { throw new CaptureOpenError(error("capture-start-failed")); }
function identity(value: unknown): DeviceRef {
  try { return validateDeviceRef(value); } catch { return invalid(); }
}
async function connect(port: number, cancellation?: AbortSignal): Promise<{ socket: Socket; released: Promise<void> }> {
  const socket = new Socket();
  const released = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  let timer: NodeJS.Timeout | undefined;
  let connected!: () => void, failed!: () => void, aborted!: () => void;
  try {
    await new Promise<void>((resolve, reject) => {
      connected = resolve;
      failed = () => reject(new CaptureOpenError(error("dependency-unavailable")));
      aborted = () => reject(new CaptureOpenError(error("capture-start-failed")));
      socket.once("connect", connected);
      socket.on("error", failed);
      cancellation?.addEventListener("abort", aborted, { once: true });
      timer = setTimeout(failed, 5000);
      socket.connect({ host: "127.0.0.1", port, family: 4 });
      if (cancellation?.aborted) aborted();
    });
    if (cancellation?.aborted) invalid();
    return { socket, released };
  } catch (cause) {
    socket.destroy();
    await released;
    throw cause instanceof CaptureOpenError ? cause : new CaptureOpenError(error("dependency-unavailable"));
  } finally {
    clearTimeout(timer);
    socket.removeListener("connect", connected);
    socket.removeListener("error", failed);
    cancellation?.removeEventListener("abort", aborted);
  }
}

export class WdaMjpegCaptureAdapter implements CaptureSource {
  readonly #deviceRef: DeviceRef;
  readonly #port: number;
  #opening = false;
  #session: WdaMjpegSession | undefined;
  constructor(value: unknown) {
    if (!exact(value, ["deviceRef", "endpoint"])) invalid();
    const ref = identity(value.deviceRef);
    const match = typeof value.endpoint === "string" && /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/$/.exec(value.endpoint);
    const port = Number(match && match[1]);
    if (!match || match[0] !== value.endpoint || ref.platform !== "ios" || !port || port > 65535) invalid();
    this.#deviceRef = Object.freeze({ ...ref });
    this.#port = port;
  }
  async open(value: unknown, cancellation?: AbortSignal): Promise<WdaMjpegSession> {
    if (!exact(value, ["deviceRef"]) || cancellation?.aborted || this.#opening || this.#session) invalid();
    const ref = identity(value.deviceRef);
    if (IDENTITY.some((key) => ref[key] !== this.#deviceRef[key])) invalid();
    this.#opening = true;
    try {
      const transport = await connect(this.#port, cancellation);
      const session = new WdaMjpegSession(transport.socket, transport.released, this.#port, cancellation);
      this.#session = session;
      void session.closed().then(() => { this.#session = undefined; });
      return session;
    } finally {
      this.#opening = false;
    }
  }
}

class WdaMjpegSession implements CaptureSession {
  readonly #socket: Socket;
  readonly #released: Promise<void>;
  readonly #signal: AbortSignal | undefined;
  readonly #started = process.hrtime.bigint();
  readonly #closed: Promise<CaptureClosed>;
  #resolveClosed!: (result: CaptureClosed) => void;
  #controls: Control[] = [];
  #pending: Frame | undefined;
  #wake: (() => void) | undefined;
  #claimed = false;
  #ended = false;
  #terminal: CaptureClosed | undefined;
  #timer: NodeJS.Timeout | undefined;
  #headers = false;
  #epoch = 0;
  #active = false;
  #sequence = 0n;
  #dropped = 0n;
  #metadata: JpegMetadata | undefined;
  readonly #abort = (): void => { this.stop("cancelled"); };
  constructor(socket: Socket, released: Promise<void>, port: number, cancellation?: AbortSignal) {
    this.#socket = socket;
    this.#released = released;
    this.#signal = cancellation;
    this.#closed = new Promise((resolve) => { this.#resolveClosed = resolve; });
    cancellation?.addEventListener("abort", this.#abort, { once: true });
    this.#arm(5000);
    void this.#produce(port).then(() => this.#complete());
    if (cancellation?.aborted) this.stop("cancelled");
  }
  get droppedFrames(): bigint { return this.#dropped; }
  closed(): Promise<CaptureClosed> { return this.#closed; }
  stop(cause: "explicit-stop" | "cancelled"): Promise<CaptureClosed> {
    if (!this.#terminal) this.#finish({ status: "ended", cause });
    return this.#closed;
  }
  async *events(): AsyncGenerator<CaptureEvent> {
    if (this.#claimed) throw new Error("Capture events already have a consumer");
    this.#claimed = true;
    for (;;) {
      const event = this.#controls.shift() ?? this.#pending;
      if (event) {
        if (event === this.#pending) this.#pending = undefined;
        yield event;
      } else if (this.#ended) return;
      else await new Promise<void>((resolve) => { this.#wake = resolve; });
    }
  }
  #notify(): void {
    this.#wake?.();
    this.#wake = undefined;
  }
  #control(event: Control): void {
    // Reserve two of the 64 small, payload-free controls for finalization.
    if (this.#controls.length >= 62) throw new ControlOverflow();
    this.#controls.push(event);
    this.#notify();
  }
  #arm(ms: number): void {
    clearTimeout(this.#timer);
    this.#timer = setTimeout(() => this.#fail("stream-interrupted"), ms);
  }
  #fail(code: FailureCode): void {
    if (!this.#terminal) this.#finish({ status: "failed", error: error(code) as CaptureError });
  }
  #finish(result: CaptureClosed): void {
    if (this.#terminal) return;
    this.#terminal = result;
    clearTimeout(this.#timer);
    this.#pending = undefined;
    this.#socket.destroy();
  }
  async *#input(): AsyncGenerator<Uint8Array> {
    for await (const chunk of this.#socket) {
      if (this.#terminal) return;
      if (this.#headers) this.#arm(12_000);
      yield chunk as Uint8Array;
    }
  }
  async #produce(port: number): Promise<void> {
    try {
      this.#socket.write(`GET / HTTP/1.0\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
      for await (const bytes of parseWda(this.#input(), () => { this.#headers = true; this.#arm(12_000); })) {
        if (this.#terminal) break;
        const metadata = await inspectJpeg(bytes);
        if (this.#terminal) break;
        const ptsUs = (process.hrtime.bigint() - this.#started) / 1000n;
        const previous = this.#metadata;
        if (!previous || previous.width !== metadata.width || previous.height !== metadata.height || previous.orientation !== metadata.orientation) {
          if (this.#pending) {
            this.#pending = undefined;
            this.#dropped++;
          }
          if (this.#active) {
            this.#control({ kind: "SessionEnded", epoch: this.#epoch, cause: "reconfigured" });
            this.#active = false;
          }
          const codedSize = { width: metadata.width, height: metadata.height };
          const displaySize = metadata.orientation >= 5 ? { width: metadata.height, height: metadata.width } : codedSize;
          this.#control({
            kind: "SessionStarted", epoch: this.#epoch + 1, codec: "mjpeg",
            codedSize, displaySize, timebase: 1_000_000, timestampOrigin: "host-arrival",
          });
          this.#epoch++;
          this.#active = true;
          this.#metadata = metadata;
        }
        if (this.#pending) this.#dropped++;
        this.#pending = {
          kind: "Frame", epoch: this.#epoch, sequence: ++this.#sequence, ptsUs, key: true, bytes,
        };
        this.#notify();
      }
      this.#fail("stream-interrupted");
    } catch (cause) {
      if (cause instanceof WdaMediaError) this.#fail("malformed-media");
      else if (cause instanceof ControlOverflow) this.#fail("runtime-overload");
      else this.#fail("stream-interrupted");
    } finally {
      clearTimeout(this.#timer);
      this.#signal?.removeEventListener("abort", this.#abort);
      this.#socket.destroy();
      await this.#released;
      // Destroying a readable socket closes I/O, but unread chunks may still be
      // referenced by its stream buffer. Release them before closed() resolves.
      while (this.#socket.read() !== null) { /* discard owned unread bytes */ }
      this.#metadata = undefined;
    }
  }
  #complete(): void {
    const result = this.#terminal!;
    if (this.#active) {
      this.#controls.push({
        kind: "SessionEnded", epoch: this.#epoch,
        cause: result.status === "ended" ? result.cause : "failed",
      });
    }
    this.#controls.push(result.status === "ended"
      ? { kind: "CaptureEnded", cause: result.cause }
      : { kind: "CaptureFailed", error: result.error });
    this.#ended = true;
    this.#notify();
    this.#resolveClosed(result);
  }
}
