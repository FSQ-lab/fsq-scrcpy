import { isAbsolute, resolve } from "node:path";
import { validateDeviceRef, validateStreamError, type DeviceRef, type StreamError, type StreamErrorCode } from "../../contracts/src/index.js";
import { acquireArtifact, ArtifactError, type ArtifactSource } from "./artifact/index.js";
import { probeAdb, TransportError, type DeviceEntry } from "./adb/index.js";
import { ScrcpyV501CaptureSession, type CaptureSession } from "./session.js";
import { openScrcpyTransport, type AdbPort, type ScrcpyTransport } from "./scrcpy/transport.js";
export { validateDeviceRef, validateSize, validateStreamError } from "../../contracts/src/index.js";
export type { DeviceRef, Size, StreamError, StreamErrorCode } from "../../contracts/src/index.js";
export * from "./session.js";
export { WdaMjpegCaptureAdapter } from "./wda/adapter.js";

export interface OpenCaptureRequest { readonly deviceRef: DeviceRef }
export interface CaptureSource { open(request: OpenCaptureRequest, cancellation?: AbortSignal): Promise<CaptureSession> }
export interface CaptureAdapterConfig { readonly adbPath?: string; readonly cacheRoot: string; readonly deviceRegistry: readonly DeviceEntry[]; readonly artifactSource: ArtifactSource }
export class CaptureOpenError extends Error { constructor(readonly error: StreamError) { super(error.safeMessage); this.name = "CaptureOpenError"; } }
const CONFIG_KEYS = ["adbPath", "cacheRoot", "deviceRegistry", "artifactSource"], REQUEST_KEYS = ["deviceRef"], ENTRY_KEYS = ["opaqueId", "serial"];
const plain = (value: unknown, keys: readonly string[], optional: readonly string[] = []): value is Record<string, unknown> => { if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false; const own = Reflect.ownKeys(value); return own.every((key) => typeof key === "string" && keys.includes(key)) && keys.filter((key) => !optional.includes(key)).every((key) => Object.prototype.hasOwnProperty.call(value, key)) && own.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable === true && "value" in descriptor; }); };
const path = (value: unknown): string => { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) throw failure("capture-start-failed"); return value; };
type CaptureOpenErrorCode = Extract<StreamErrorCode, import("./adb/index.js").TransportErrorCode | import("./session.js").CaptureErrorCode>;
const failure = (code: CaptureOpenErrorCode): CaptureOpenError => { const capture = new Set<StreamErrorCode>(["device-not-found", "device-ambiguous", "device-unavailable", "artifact-unavailable", "artifact-mismatch", "capture-start-failed", "codec-disabled", "codec-config-error", "unsupported-codec", "device-disconnected"]), service = new Set<StreamErrorCode>(["dependency-unavailable", "adb-incompatible"]), stream = new Set<StreamErrorCode>(["start-timeout", "malformed-media", "backpressure-timeout", "runtime-overload", "stream-interrupted"]); return new CaptureOpenError(validateStreamError({ code, scope: service.has(code) ? "service" : stream.has(code) ? "stream" : capture.has(code) ? "capture" : "acceptance", disposition: code === "stream-interrupted" ? "state-unknown" : "terminal", safeMessage: "Capture could not be opened" })); };
const validatedRef = (value: unknown): DeviceRef => { try { return validateDeviceRef(value); } catch { throw failure("capture-start-failed"); } };
const artifactSource = (value: unknown): ArtifactSource => { if (plain(value, ["mode"]) && value.mode === "online") return Object.freeze({ mode: "online" }); if (!plain(value, ["mode", "keyFile", "checksumFile", "signatureFile", "serverFile"]) || value.mode !== "offline") throw failure("capture-start-failed"); return Object.freeze({ mode: "offline", keyFile: path(value.keyFile), checksumFile: path(value.checksumFile), signatureFile: path(value.signatureFile), serverFile: path(value.serverFile) }); };
interface SourceHooks { acquire(cacheRoot: string, source: ArtifactSource, signal?: AbortSignal): ReturnType<typeof acquireArtifact>; probe(opaqueId: string, registry: readonly DeviceEntry[], explicit?: string, envPath?: string, hooks?: never, signal?: AbortSignal): Promise<{ client: AdbPort; serial: string; version: string }>; transport(request: { client: AdbPort; serial: string; artifact: Awaited<ReturnType<typeof acquireArtifact>>; signal?: AbortSignal }): Promise<ScrcpyTransport> }
const SOURCE_HOOKS: SourceHooks = { acquire: acquireArtifact, probe: probeAdb, transport: openScrcpyTransport };
export class ScrcpyV501CaptureAdapter implements CaptureSource {
  private readonly config: CaptureAdapterConfig;
  constructor(value: unknown, private readonly hooks: SourceHooks = SOURCE_HOOKS) { if (!plain(value, CONFIG_KEYS, ["adbPath"]) || typeof value.cacheRoot !== "string" || !Array.isArray(value.deviceRegistry) || (Object.prototype.hasOwnProperty.call(value, "adbPath") && typeof value.adbPath !== "string")) throw failure("capture-start-failed"); const registry = value.deviceRegistry.map((entry) => { if (!plain(entry, ENTRY_KEYS) || typeof entry.serial !== "string" || entry.serial.length === 0) throw failure("capture-start-failed"); const ref = validatedRef({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: entry.opaqueId }); return Object.freeze({ opaqueId: ref.opaqueId, serial: entry.serial }); }); this.config = Object.freeze({ ...(value.adbPath === undefined ? {} : { adbPath: path(value.adbPath) }), cacheRoot: path(value.cacheRoot), deviceRegistry: Object.freeze(registry), artifactSource: artifactSource(value.artifactSource) }); }
  async open(value: unknown, cancellation?: AbortSignal): Promise<CaptureSession> {
    if (cancellation?.aborted || !plain(value, REQUEST_KEYS)) throw failure("capture-start-failed");
    const deviceRef = validatedRef(value.deviceRef);
    if (deviceRef.platform !== "android" || deviceRef.namespace !== "fsq.android.local") throw failure("capture-start-failed");
    let transport: ScrcpyTransport | undefined;
    try {
      const artifact = await this.hooks.acquire(this.config.cacheRoot, this.config.artifactSource, cancellation);
      if (cancellation?.aborted) throw new TransportError("capture-start-failed");
      const admitted = await this.hooks.probe(deviceRef.opaqueId, this.config.deviceRegistry, this.config.adbPath, undefined, undefined, cancellation);
      if (cancellation?.aborted) throw new TransportError("capture-start-failed");
      transport = await this.hooks.transport({ client: admitted.client, serial: admitted.serial, artifact, ...(cancellation ? { signal: cancellation } : {}) });
      if (cancellation?.aborted) { await transport.close(); throw new TransportError("capture-start-failed"); }
      return new ScrcpyV501CaptureSession({ transport, client: admitted.client, serial: admitted.serial, ...(cancellation ? { cancellation } : {}) });
    } catch (error) {
      if (transport) await transport.close().catch(() => undefined);
      if (error instanceof ArtifactError || error instanceof TransportError) throw failure(error.code);
      throw failure("capture-start-failed");
    }
  }
}
