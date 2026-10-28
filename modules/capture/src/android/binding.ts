import { constants, type Stats } from "node:fs";
import { access, chmod, lstat, mkdir, realpath, rmdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import { acquireArtifact, ArtifactError, SCRCPY_V501, type ArtifactSource, type VerifiedArtifact } from "../artifact/index.js";
import { ADB_DEADLINES, AdbClient, type CommandResult } from "../adb/index.js";

export type AndroidBindingErrorCode =
  | "dependency-unavailable"
  | "adb-incompatible"
  | "device-not-found"
  | "device-ambiguous"
  | "device-unavailable"
  | "artifact-unavailable"
  | "artifact-mismatch";

export type AndroidBindingError = Readonly<{
  code: AndroidBindingErrorCode;
  safeMessage: string;
}>;

export type AndroidBindingSnapshot = Readonly<{
  bindingVersion: 1;
  platform: "android";
  provider: "scrcpy-v5.0.1";
  adbVersion: string;
  artifactVersion: "5.0.1";
  artifactSha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
  observedAt: number;
}>;

export type ResolvedAndroidBinding = Readonly<{
  serial: string;
  adbPath: string;
  cacheRoot: string;
  artifactSource: Readonly<{ mode: "online" }>;
}>;

export type AndroidBindingOptions = Readonly<{ signal?: AbortSignal }>;

const REDACTED = "[REDACTED]";
const INSPECT = Symbol.for("nodejs.util.inspect.custom");
const ONLINE_SOURCE: Readonly<{ mode: "online" }> = Object.freeze({ mode: "online" });
const SAFE_MESSAGES: Readonly<Record<AndroidBindingErrorCode, string>> = Object.freeze({
  "dependency-unavailable": "Required dependency is unavailable",
  "adb-incompatible": "ADB is incompatible",
  "device-not-found": "Device was not found",
  "device-ambiguous": "Device selection is ambiguous",
  "device-unavailable": "Device is unavailable",
  "artifact-unavailable": "Artifact is unavailable",
  "artifact-mismatch": "Artifact verification failed",
});

class BindingFailure extends Error {
  constructor(readonly code: AndroidBindingErrorCode) {
    super(SAFE_MESSAGES[code]);
    this.name = "BindingFailure";
  }
}

const ACCESS_TOKEN = Object.freeze({});
let revealBindingAccess!: (value: unknown) => ResolvedAndroidBinding;

class BindingAccess {
  readonly snapshot: AndroidBindingSnapshot;
  readonly #binding: ResolvedAndroidBinding;

  constructor(token: typeof ACCESS_TOKEN, snapshot: AndroidBindingSnapshot, binding: ResolvedAndroidBinding) {
    if (token !== ACCESS_TOKEN) throw new TypeError("Invalid Android binding access");
    this.snapshot = snapshot;
    this.#binding = binding;
    Object.freeze(this);
  }

  toJSON(): Readonly<{ snapshot: AndroidBindingSnapshot }> {
    return { snapshot: this.snapshot };
  }
  toString(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return REDACTED;
  }

  static {
    revealBindingAccess = (value: unknown): ResolvedAndroidBinding => {
      if ((typeof value !== "object" && typeof value !== "function") || value === null || !(#binding in value)) {
        throw new TypeError("Invalid Android binding access");
      }
      return value.#binding;
    };
  }
}

export type AndroidBindingAccess = BindingAccess;
export type AndroidBindingResult =
  | Readonly<{ ok: true; value: Readonly<{ access: AndroidBindingAccess }> }>
  | Readonly<{ ok: false; error: AndroidBindingError }>;

interface AdbProbe {
  run(
    serial: string | undefined,
    args: readonly string[],
    timeout: number,
    failure: AndroidBindingErrorCode,
    signal?: AbortSignal,
  ): Promise<CommandResult>;
}

interface BindingHooks {
  readonly path: () => string | undefined;
  readonly now: () => number;
  readonly homedir: () => string;
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<Pick<Stats, "isFile" | "isSymbolicLink">>;
  readonly access: (path: string, mode: number) => Promise<void>;
  readonly createAdb: (path: string) => AdbProbe;
  readonly prepareCacheRoot: (path: string, signal?: AbortSignal) => Promise<void>;
  readonly acquire: (cacheRoot: string, source: ArtifactSource, signal?: AbortSignal) => Promise<VerifiedArtifact>;
  readonly afterAccess?: (access: AndroidBindingAccess) => void;
}

interface CacheRootHooks {
  readonly realpath: (path: string) => Promise<string>;
  readonly lstat: (path: string) => Promise<Pick<Stats, "isDirectory" | "isSymbolicLink" | "uid" | "mode">>;
  readonly mkdir: (path: string) => Promise<void>;
  readonly chmod: (path: string, mode: number) => Promise<void>;
  readonly rmdir: (path: string) => Promise<void>;
  readonly euid: () => number;
}

const CACHE_ROOT_HOOKS: CacheRootHooks = Object.freeze({
  realpath,
  lstat,
  mkdir: async (path: string) => { await mkdir(path, { mode: 0o700 }); },
  chmod,
  rmdir,
  euid: () => process.geteuid?.() ?? fail("artifact-unavailable"),
});

async function prepareCacheRoot(path: string, signal?: AbortSignal, hooks: CacheRootHooks = CACHE_ROOT_HOOKS): Promise<void> {
  let created = false, validated = false;
  try {
    const parent = dirname(path), canonicalParent = await hooks.realpath(parent);
    checkAbort(signal, "artifact-unavailable");
    if (canonicalParent !== parent) fail("artifact-unavailable");
    const parentState = await hooks.lstat(parent);
    checkAbort(signal, "artifact-unavailable");
    if (parentState.isSymbolicLink() || !parentState.isDirectory()) fail("artifact-unavailable");
    try {
      await hooks.mkdir(path);
      created = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    checkAbort(signal, "artifact-unavailable");
    if (created) {
      await hooks.chmod(path, 0o700);
      checkAbort(signal, "artifact-unavailable");
    }
    const state = await hooks.lstat(path);
    checkAbort(signal, "artifact-unavailable");
    const euid = hooks.euid();
    if (state.isSymbolicLink() || !state.isDirectory() || state.uid !== euid || (state.mode & 0o7777) !== 0o700) {
      fail("artifact-unavailable");
    }
    validated = true;
  } finally {
    if (created && !validated) await hooks.rmdir(path).catch(() => undefined);
  }
}

const SYSTEM_HOOKS: BindingHooks = Object.freeze({
  path: () => process.env.PATH,
  now: Date.now,
  homedir: () => userInfo().homedir,
  realpath,
  lstat,
  access,
  createAdb: (path: string) => new AdbClient(path),
  prepareCacheRoot,
  acquire: acquireArtifact,
});

function options(value: unknown): AndroidBindingOptions {
  if (value === undefined) return Object.freeze({});
  try {
    if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
      throw new Error("invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (keys.length > 1 || keys.some((key) => key !== "signal")) throw new Error("invalid");
    if (keys.length === 0) return Object.freeze({});
    const descriptor = Object.getOwnPropertyDescriptor(value, "signal");
    if (descriptor?.enumerable !== true || !("value" in descriptor) || !(descriptor.value instanceof AbortSignal)) {
      throw new Error("invalid");
    }
    return Object.freeze({ signal: descriptor.value });
  } catch {
    throw new TypeError("Invalid Android binding options");
  }
}

const fail = (code: AndroidBindingErrorCode): never => {
  throw new BindingFailure(code);
};

function checkAbort(signal: AbortSignal | undefined, code: "device-unavailable" | "artifact-unavailable"): void {
  if (signal?.aborted) fail(code);
}

type PathAwait<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false }>;

async function pathAwait<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<PathAwait<T>> {
  try {
    const value = await operation;
    checkAbort(signal, "device-unavailable");
    return { ok: true, value };
  } catch (error) {
    checkAbort(signal, "device-unavailable");
    if (error instanceof BindingFailure) throw error;
    return { ok: false };
  }
}

async function resolvePath(pathValue: string | undefined, signal: AbortSignal | undefined, hooks: BindingHooks): Promise<string> {
  checkAbort(signal, "device-unavailable");
  for (const directory of (pathValue ?? "").split(delimiter)) {
    if (directory.length === 0 || !isAbsolute(directory)) continue;
    const canonical = await pathAwait(hooks.realpath(join(directory, "adb")), signal);
    if (!canonical.ok) continue;
    const state = await pathAwait(hooks.lstat(canonical.value), signal);
    if (!state.ok || !state.value.isFile() || state.value.isSymbolicLink()) continue;
    const executable = await pathAwait(hooks.access(canonical.value, constants.X_OK), signal);
    if (executable.ok) return canonical.value;
  }
  return fail("dependency-unavailable");
}

async function command(
  client: AdbProbe,
  serial: string | undefined,
  args: readonly string[],
  failure: "adb-incompatible" | "device-unavailable",
  signal: AbortSignal | undefined,
): Promise<CommandResult> {
  try {
    const result = await client.run(serial, args, ADB_DEADLINES.probe, failure, signal);
    checkAbort(signal, "device-unavailable");
    return result;
  } catch {
    checkAbort(signal, "device-unavailable");
    return fail(failure);
  }
}

function adbVersion(stdout: string): string {
  if (/[^\x00-\x7f]/.test(stdout)) return fail("adb-incompatible");
  const first = stdout.split(/\r?\n/, 1)[0] ?? "";
  const match = /^Android Debug Bridge version (0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$/.exec(first);
  if (!match) return fail("adb-incompatible");
  const parts = match.slice(1).map(Number);
  if (parts.some((part) => part > 65_535)) return fail("adb-incompatible");
  const canonical = parts.join(".");
  return canonical.length <= 17 ? canonical : fail("adb-incompatible");
}

function singleDevice(stdout: string): string {
  const rows = stdout.split(/\r?\n/).slice(1).filter((line) => line.length > 0);
  if (rows.length === 0) return fail("device-not-found");
  if (rows.length > 1) return fail("device-ambiguous");
  const [serial = "", state] = rows[0]!.trim().split(/\s+/, 3);
  if (state !== "device") return fail("device-unavailable");
  return /^[\x21-\x7e]{1,256}$/.test(serial) ? serial : fail("adb-incompatible");
}

function snapshot(adb: string, observedAt: number): AndroidBindingSnapshot {
  return Object.freeze({
    bindingVersion: 1,
    platform: "android",
    provider: "scrcpy-v5.0.1",
    adbVersion: adb,
    artifactVersion: "5.0.1",
    artifactSha256: SCRCPY_V501.sha256 as AndroidBindingSnapshot["artifactSha256"],
    observedAt,
  });
}

function binding(serial: string, adbPath: string, cacheRoot: string): ResolvedAndroidBinding {
  return Object.freeze({ serial, adbPath, cacheRoot, artifactSource: ONLINE_SOURCE });
}

function failure(code: AndroidBindingErrorCode): AndroidBindingResult {
  return Object.freeze({ ok: false, error: Object.freeze({ code, safeMessage: SAFE_MESSAGES[code] }) });
}

async function resolve(
  value: AndroidBindingOptions,
  pathValue: string | undefined,
  observedAt: number,
  hooks: BindingHooks,
): Promise<AndroidBindingResult> {
  const signal = value.signal;
  try {
    checkAbort(signal, "device-unavailable");
    const adbPath = await resolvePath(pathValue, signal, hooks);
    checkAbort(signal, "device-unavailable");
    const client = hooks.createAdb(adbPath);
    const versionResult = await command(client, undefined, ["version"], "adb-incompatible", signal);
    const version = adbVersion(versionResult.stdout);
    const devices = await command(client, undefined, ["devices", "-l"], "device-unavailable", signal);
    const serial = singleDevice(devices.stdout);
    const state = await command(client, serial, ["get-state"], "device-unavailable", signal);
    if (!/^device(?:\r?\n)?$/.test(state.stdout)) fail("device-unavailable");
    checkAbort(signal, "device-unavailable");

    let cacheRoot: string;
    try {
      cacheRoot = join(hooks.homedir(), "Library", "Caches", "FSQ_scrcpy");
      await hooks.prepareCacheRoot(cacheRoot, signal);
      checkAbort(signal, "artifact-unavailable");
      await hooks.acquire(cacheRoot, ONLINE_SOURCE, signal);
      checkAbort(signal, "artifact-unavailable");
    } catch (error) {
      checkAbort(signal, "artifact-unavailable");
      if (error instanceof ArtifactError && error.code === "artifact-mismatch") throw new BindingFailure("artifact-mismatch");
      throw new BindingFailure("artifact-unavailable");
    }

    const access = new BindingAccess(ACCESS_TOKEN, snapshot(version, observedAt), binding(serial, adbPath, cacheRoot));
    hooks.afterAccess?.(access);
    return Object.freeze({ ok: true, value: Object.freeze({ access }) });
  } catch (error) {
    return failure(error instanceof BindingFailure ? error.code : "device-unavailable");
  }
}

function invoke(value: unknown, hooks: BindingHooks): Promise<AndroidBindingResult> {
  const validated = options(value);
  try {
    const pathValue = hooks.path();
    const observedAt = hooks.now();
    if (!Number.isSafeInteger(observedAt) || observedAt < 0) return Promise.resolve(failure("device-unavailable"));
    return resolve(validated, pathValue, observedAt, hooks);
  } catch {
    return Promise.resolve(failure("device-unavailable"));
  }
}

export function resolveSingleAndroidBinding(options?: AndroidBindingOptions): Promise<AndroidBindingResult> {
  return invoke(options, SYSTEM_HOOKS);
}

export function revealAndroidBinding(access: AndroidBindingAccess): ResolvedAndroidBinding {
  return revealBindingAccess(access);
}

export const bindingInternals = Object.freeze({ resolve: invoke, prepareCacheRoot, safeMessages: SAFE_MESSAGES });
