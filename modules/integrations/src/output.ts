export interface RecordStream {
  readonly destroyed?: boolean;
  readonly writableEnded?: boolean;
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean;
  on(event: "error", listener: (cause: unknown) => void): unknown;
  on(event: "close" | "drain", listener: () => void): unknown;
  removeListener(event: "error", listener: (cause: unknown) => void): unknown;
  removeListener(event: "close" | "drain", listener: () => void): unknown;
}
export type OutputFailure = Readonly<{ exitStatus: 3 | 5 }>;
const recoverable = Object.freeze({ exitStatus: 3 as const });
const unknown = Object.freeze({ exitStatus: 5 as const });
function outputFailure(cause: unknown, closed = false): OutputFailure {
  return closed || (typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "EPIPE") ? recoverable : unknown;
}
export class OutputWriter {
  readonly #stream: RecordStream;
  readonly #abort: () => void;
  #failure: OutputFailure | undefined;
  #reject: ((failure: OutputFailure) => void) | undefined;
  #busy = false;
  #disposed = false;
  readonly #error = (cause: unknown): void => { this.#fail(cause); };
  readonly #close = (): void => { this.#fail(undefined, true); };
  constructor(stream: RecordStream, abort: () => void) {
    this.#stream = stream;
    this.#abort = abort;
    stream.on("error", this.#error);
    stream.on("close", this.#close);
    if (stream.destroyed || stream.writableEnded) this.#fail(undefined, true);
  }

  get failure(): OutputFailure | undefined { return this.#failure; }

  async write(result: unknown, sequence: boolean): Promise<void> {
    if (this.#failure) throw this.#failure;
    if (this.#busy || this.#disposed) { this.#fail(undefined); throw this.#failure; }
    this.#busy = true;
    let bytes: Buffer;
    try {
      const text = JSON.stringify(result);
      if (text === undefined) throw new TypeError("Unserializable output");
      bytes = sequence ? Buffer.concat([Buffer.from([0x1e]), Buffer.from(text), Buffer.from([0x0a])]) : Buffer.from(`${text}\n`);
      if (bytes.byteLength > (sequence ? 16_386 : 16_385)) throw new RangeError("Output record too large");
      await new Promise<void>((resolve, reject) => {
        let callbackDone = false, drained = false, needDrain: boolean | undefined, settled = false;
        const cleanup = (): void => { this.#stream.removeListener("drain", onDrain); this.#reject = undefined; };
        const fail = (failure: OutputFailure): void => { if (settled) return; settled = true; cleanup(); reject(failure); };
        const finish = (): void => { if (settled || !callbackDone || needDrain === undefined || needDrain && !drained) return; settled = true; cleanup(); resolve(); };
        const onDrain = (): void => { drained = true; finish(); };
        const callback = (error?: Error | null): void => { if (error) { this.#fail(error); return; } callbackDone = true; finish(); };
        this.#reject = fail;
        this.#stream.on("drain", onDrain);
        try { needDrain = !this.#stream.write(bytes, callback); if (!needDrain) this.#stream.removeListener("drain", onDrain); finish(); }
        catch (cause) { this.#fail(cause); }
      });
    } catch (cause) {
      if (!this.#failure) this.#fail(cause);
      throw this.#failure;
    } finally { this.#busy = false; }
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stream.removeListener("error", this.#error);
    this.#stream.removeListener("close", this.#close);
  }

  #fail(cause: unknown, closed = false): void {
    if (this.#failure || this.#disposed) return;
    this.#failure = outputFailure(cause, closed);
    this.#abort();
    this.#reject?.(this.#failure);
  }
}
