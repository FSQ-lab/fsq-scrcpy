import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { spawn, type SpawnOptions } from "node:child_process";
import { delimiter, isAbsolute, resolve } from "node:path";

export type TransportErrorCode = "dependency-unavailable" | "adb-incompatible" | "device-not-found" | "device-ambiguous" | "device-unavailable" | "artifact-unavailable" | "artifact-mismatch" | "start-timeout" | "capture-start-failed";
export class TransportError extends Error { constructor(readonly code: TransportErrorCode) { super(SAFE[code]); this.name = "TransportError"; } }
const SAFE: Record<TransportErrorCode, string> = { "dependency-unavailable": "Required dependency is unavailable", "adb-incompatible": "ADB is incompatible", "device-not-found": "Device was not found", "device-ambiguous": "Device selection is ambiguous", "device-unavailable": "Device is unavailable", "artifact-unavailable": "Artifact is unavailable", "artifact-mismatch": "Artifact verification failed", "start-timeout": "Capture start timed out", "capture-start-failed": "Capture failed to start" };
const LIMIT = 64 * 1024;
export const ADB_DEADLINES = Object.freeze({ probe: 5_000, operation: 15_000, push: 30_000, start: 30_000, terminate: 2_000 });
interface StreamLike { on(event: string, listener: (...args: unknown[]) => void): this }
interface ChildLike { readonly pid?: number; readonly stdout: StreamLike | null; readonly stderr: StreamLike | null; once(event: string, listener: (...args: unknown[]) => void): this; on(event: string, listener: (...args: unknown[]) => void): this }
interface ProcessHooks { spawn(file: string, args: readonly string[], options: SpawnOptions): ChildLike; signal(pid: number, signal: NodeJS.Signals): void; setTimer(ms: number, callback: () => void): unknown; clearTimer(token: unknown): void }
const PROCESS: ProcessHooks = { spawn: (file, args, options) => spawn(file, args, options) as unknown as ChildLike, signal: (pid, signal) => process.kill(-pid, signal), setTimer: (ms, callback) => setTimeout(callback, ms), clearTimer: (token) => clearTimeout(token as NodeJS.Timeout) };
export interface CommandResult { readonly stdout: string; readonly stderr: string }

async function runProcess(file: string, args: readonly string[], timeout: number, failure: TransportErrorCode, hooks: ProcessHooks = PROCESS, cancellation?: AbortSignal): Promise<CommandResult> {
  if (cancellation?.aborted) throw new TransportError(failure);
  return await new Promise((done, reject) => {
    let child: ChildLike; try { child = hooks.spawn(file, args, { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); } catch { reject(new TransportError(failure)); return; }
    const out: Buffer[] = [], err: Buffer[] = []; let outBytes = 0, errBytes = 0, aborted = false, cause: TransportError | undefined, grace: unknown;
    const signal = (name: NodeJS.Signals): void => { if (child.pid !== undefined) { try { hooks.signal(child.pid, name); } catch { /* already exited */ } } };
    const abort = (error: TransportError): void => { if (aborted) return; aborted = true; cause = error; signal("SIGTERM"); grace = hooks.setTimer(ADB_DEADLINES.terminate, () => signal("SIGKILL")); }, cancel = (): void => abort(new TransportError(failure));
    const collect = (target: Buffer[], stdout: boolean) => (value: unknown): void => { if (!(value instanceof Uint8Array)) { abort(new TransportError(failure)); return; } const copy = Buffer.from(value); if (stdout) outBytes += copy.length; else errBytes += copy.length; if ((stdout ? outBytes : errBytes) > LIMIT) { abort(new TransportError(failure)); return; } target.push(copy); };
    child.stdout?.on("data", collect(out, true)); child.stderr?.on("data", collect(err, false)); child.on("error", () => abort(new TransportError(failure))); cancellation?.addEventListener("abort", cancel, { once: true }); if (cancellation?.aborted) cancel();
    const deadline = hooks.setTimer(timeout, () => abort(new TransportError(failure)));
    child.once("close", (code) => { cancellation?.removeEventListener("abort", cancel); hooks.clearTimer(deadline); if (grace !== undefined) hooks.clearTimer(grace); if (cause) { reject(cause); return; } if (code !== 0) { reject(new TransportError(failure)); return; } done({ stdout: Buffer.concat(out, outBytes).toString("utf8"), stderr: Buffer.concat(err, errBytes).toString("utf8") }); });
  });
}

async function executable(path: string): Promise<string | undefined> { try { const canonical = await realpath(path), stat = await lstat(canonical); if (!stat.isFile() || stat.isSymbolicLink()) return undefined; await access(canonical, constants.X_OK); return canonical; } catch { return undefined; } }
export async function resolveAdbPath(explicit?: string, envPath = process.env.PATH): Promise<string> {
  if (explicit !== undefined) { if (!isAbsolute(explicit) || resolve(explicit) !== explicit) throw new TransportError("dependency-unavailable"); const canonical = await executable(explicit); if (!canonical) throw new TransportError("dependency-unavailable"); return canonical; }
  for (const directory of (envPath ?? "").split(delimiter)) { if (!directory) continue; const canonical = await executable(resolve(directory, "adb")); if (canonical) return canonical; }
  throw new TransportError("dependency-unavailable");
}
export interface DeviceEntry { readonly opaqueId: string; readonly serial: string }
export function admitDevice(opaqueId: string, registry: readonly DeviceEntry[], devicesOutput: string): string {
  const matches = registry.filter((entry) => entry.opaqueId === opaqueId); if (matches.length === 0) throw new TransportError("device-not-found");
  if (matches.length !== 1 || new Set(registry.map((entry) => entry.opaqueId)).size !== registry.length || new Set(registry.map((entry) => entry.serial)).size !== registry.length) throw new TransportError("device-ambiguous");
  const rows = devicesOutput.split(/\r?\n/).slice(1).filter(Boolean).map((line) => { const [serial, state] = line.trim().split(/\s+/, 3); return { serial, state }; }); const target = matches[0]!;
  const authorized = rows.filter((row) => row.state === "device" && registry.some((entry) => entry.serial === row.serial)); if (authorized.length !== 1 || authorized[0]!.serial !== target.serial) throw new TransportError("device-unavailable");
  return target.serial;
}
export interface OwnedProcess { readonly closed: Promise<void>; stop(): Promise<void> }
export class AdbClient {
  constructor(readonly path: string, private readonly hooks: ProcessHooks = PROCESS) {}
  async run(serial: string | undefined, args: readonly string[], timeout: number, failure: TransportErrorCode, cancellation?: AbortSignal): Promise<CommandResult> { return await runProcess(this.path, serial ? ["-s", serial, ...args] : args, timeout, failure, this.hooks, cancellation); }
  start(serial: string, args: readonly string[], cancellation?: AbortSignal): OwnedProcess {
    if (cancellation?.aborted) throw new TransportError("capture-start-failed"); const child = this.hooks.spawn(this.path, ["-s", serial, ...args], { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); let reaped = false, stopped = false, first: TransportError | undefined, killTimer: unknown, termination: Promise<void> | undefined, stopCall: Promise<void> | undefined, reap!: () => void, settle!: () => void, fail!: (error: unknown) => void, stdout = 0, stderr = 0; const reapedPromise = new Promise<void>((done) => { reap = done; }), closed = new Promise<void>((done, reject) => { settle = done; fail = reject; });
    const signal = (name: NodeJS.Signals): void => { if (child.pid !== undefined) { try { this.hooks.signal(child.pid, name); } catch {} } }; const terminate = (error?: TransportError): Promise<void> => { first ??= error; if (reaped) return Promise.resolve(); if (!termination) { signal("SIGTERM"); killTimer = this.hooks.setTimer(ADB_DEADLINES.terminate, () => signal("SIGKILL")); termination = reapedPromise.finally(() => this.hooks.clearTimer(killTimer)); } return termination; }, cancel = (): void => { void terminate(new TransportError("capture-start-failed")); };
    const data = (isStdout: boolean) => (value: unknown): void => { if (!(value instanceof Uint8Array)) { void terminate(new TransportError("capture-start-failed")); return; } if (isStdout) stdout += value.byteLength; else stderr += value.byteLength; if ((isStdout ? stdout : stderr) > LIMIT) void terminate(new TransportError("capture-start-failed")); }; child.stdout?.on("data", data(true)); child.stderr?.on("data", data(false)); child.on("error", () => { void terminate(new TransportError("capture-start-failed")); }); cancellation?.addEventListener("abort", cancel, { once: true }); if (cancellation?.aborted) cancel(); child.once("close", (code) => { cancellation?.removeEventListener("abort", cancel); if (reaped) return; reaped = true; reap(); if (first) fail(first); else if (code === 0 || stopped) settle(); else fail(new TransportError("capture-start-failed")); });
    return { closed, stop: () => stopCall ??= (async () => { stopped = true; await terminate(); await closed.catch(() => undefined); })() };
  }
}
export async function probeAdb(opaqueId: string, registry: readonly DeviceEntry[], explicit?: string, envPath?: string, hooks?: ProcessHooks, cancellation?: AbortSignal): Promise<{ client: AdbClient; serial: string; version: string }> {
  if (cancellation?.aborted) throw new TransportError("device-unavailable"); const path = await resolveAdbPath(explicit, envPath); if (cancellation?.aborted) throw new TransportError("device-unavailable"); const client = new AdbClient(path, hooks); const version = await client.run(undefined, ["version"], ADB_DEADLINES.probe, "adb-incompatible", cancellation); if (!/^Android Debug Bridge version /m.test(version.stdout)) throw new TransportError("adb-incompatible"); const devices = await client.run(undefined, ["devices", "-l"], ADB_DEADLINES.probe, "device-unavailable", cancellation), serial = admitDevice(opaqueId, registry, devices.stdout); const state = await client.run(serial, ["get-state"], ADB_DEADLINES.probe, "device-unavailable", cancellation); if (state.stdout.trim() !== "device") throw new TransportError("device-unavailable"); await client.run(serial, ["shell", "true"], ADB_DEADLINES.operation, "device-unavailable", cancellation); if (cancellation?.aborted) throw new TransportError("device-unavailable"); return { client, serial, version: version.stdout.split(/\r?\n/, 1)[0] ?? "" };
}
export const adbInternals = Object.freeze({ runProcess, executable, processHooks: PROCESS, outputLimit: LIMIT });
