import {
  controlError,
  validateApproveViewerValue,
  validateControlError,
  validateControlResult,
  validateEnsureViewerValue,
  validateInspectControlValue,
  validateRuntimeAttachment,
  validateShutdownRuntimeValue,
  validateStopStreamValue,
  type ControlError,
  type DeviceRef,
  type RuntimeControl,
  RuntimeControlSession,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import { acquireRuntime } from "../../runtime/src/index.js";
import {
  createRuntimeOwnerLocal,
  validateLocalStateStatusResult,
  validateRebindDeviceResult,
  validateResetControlStateResult,
  type LocalStateStatusValue,
  type RuntimeOwnerLocal,
} from "../../runtime/src/owner.js";
import { syntaxMode, parseCommand, type CliCommand } from "./parse.js";
import { OutputWriter, type RecordStream } from "./output.js";

export type CliError = Readonly<{
  code: "invalid-cli-syntax" | "confirmation-required";
  disposition: "usage";
  operationState: "not-applied";
  safeMessage: "Invalid command syntax." | "Interactive confirmation is required.";
}>;
type Failure = Readonly<{ ok: false; error: ControlError | CliError | Readonly<{ code: "runtime-live"; disposition: "terminal"; operationState: "not-applied"; safeMessage: "A matching Runtime is still running." }> }>;
type Result = Readonly<{ ok: true; value: unknown }> | Failure | Readonly<{ ok: false; error: unknown; snapshot: unknown }>;

export interface CliIo {
  readonly stdin: Readonly<{ isTTY?: boolean }>;
  readonly stdout: Readonly<{ destroyed?: boolean; writableEnded?: boolean; write(value: string | Uint8Array, callback?: (error?: Error | null) => void): unknown; on?(event: string, listener: (...values: unknown[]) => void): unknown; removeListener?(event: string, listener: (...values: unknown[]) => void): unknown }>;
  readonly stderr: Readonly<{ isTTY?: boolean; write(value: string): unknown }>;
  question(prompt: string, signal?: AbortSignal): Promise<string | undefined>;
}
export interface CliRuntimeDependencies {
  acquireRuntime: typeof acquireRuntime;
  createRuntimeOwnerLocal: typeof createRuntimeOwnerLocal;
}
const DEFAULT_RUNTIME: CliRuntimeDependencies = Object.freeze({ acquireRuntime, createRuntimeOwnerLocal });

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Reflect.ownKeys(value)) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (descriptor && "value" in descriptor) deepFreeze(descriptor.value); }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable === true && "value" in descriptor; });
};
const sameDevice = (left: DeviceRef, right: DeviceRef): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
const failure = (code: ControlError["code"]): Readonly<{ ok: false; error: ControlError }> => freeze({ ok: false, error: controlError(code) });
const syntax = (confirmation = false): Readonly<{ ok: false; error: CliError }> => freeze({ ok: false, error: freeze(confirmation ? {
  code: "confirmation-required", disposition: "usage", operationState: "not-applied", safeMessage: "Interactive confirmation is required.",
} : {
  code: "invalid-cli-syntax", disposition: "usage", operationState: "not-applied", safeMessage: "Invalid command syntax.",
}) });
const runtimeLive = (): Failure => freeze({ ok: false, error: freeze({ code: "runtime-live", disposition: "terminal", operationState: "not-applied", safeMessage: "A matching Runtime is still running." } as const) });
const unexpected = (): Readonly<{ ok: false; error: ControlError }> => failure("runtime-exited");

function checkedControl(value: unknown, validator: (value: unknown) => unknown, revisionConflict = false): Result {
  const result = validateControlResult(value);
  if (result.ok) validator(result.value);
  else if (Object.hasOwn(result, "snapshot") && !revisionConflict) throw new TypeError("Invalid operation result");
  return deepFreeze(result) as Result;
}
function checkedStream(value: unknown, validator: (value: unknown) => unknown, deviceRef: DeviceRef, streamId: string, revisionConflict = false): Result {
  const result = checkedControl(value, validator, revisionConflict);
  const snapshot = result.ok ? (result.value as { snapshot: StreamSnapshot }).snapshot : Object.hasOwn(result, "snapshot") ? (result as { snapshot: StreamSnapshot }).snapshot : undefined;
  const changes = result.ok ? (result.value as { changes?: readonly StreamSnapshot[] }).changes : undefined;
  if (snapshot && (snapshot.streamId !== streamId || !sameDevice(snapshot.deviceRef, deviceRef)) || changes?.some((change) => change.streamId !== streamId || !sameDevice(change.deviceRef, deviceRef))) throw new TypeError("Invalid stream result identity");
  return result;
}
type RecognizedSession = Readonly<{ session: RuntimeControlSession; close: () => Promise<void> }>;
function recognizeSession(value: unknown): RecognizedSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value), attachment = Object.getOwnPropertyDescriptor(value, "attachment");
  if (!attachment?.enumerable || !("value" in attachment)) return;
  let close: unknown, control: unknown;
  if (prototype === RuntimeControlSession.prototype) {
    close = Object.getOwnPropertyDescriptor(RuntimeControlSession.prototype, "close")?.value;
    try { control = Reflect.get(value, "control", value); } catch { return; }
  } else if (prototype === Object.prototype || prototype === null) {
    const closeDescriptor = Object.getOwnPropertyDescriptor(value, "close"), controlDescriptor = Object.getOwnPropertyDescriptor(value, "control");
    if (!closeDescriptor || !("value" in closeDescriptor) || !controlDescriptor?.enumerable || !("value" in controlDescriptor)) return;
    close = closeDescriptor.value; control = controlDescriptor.value;
  } else return;
  if (typeof close !== "function" || typeof control !== "object" || control === null) return;
  const session = value as RuntimeControlSession;
  return freeze({ session, close: async () => { await Reflect.apply(close as () => unknown, session, []); } });
}
function rawAcquireSession(value: unknown): RecognizedSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const ok = Object.getOwnPropertyDescriptor(value, "ok"), session = Object.getOwnPropertyDescriptor(value, "session");
  return ok?.enumerable && "value" in ok && ok.value === true && session?.enumerable && "value" in session ? recognizeSession(session.value) : undefined;
}
function checkedAcquire(value: unknown): Readonly<{ ok: true; session: RuntimeControlSession }> | Readonly<{ ok: false; error: ControlError }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid acquire result");
  const okDescriptor = Object.getOwnPropertyDescriptor(value, "ok");
  if (!okDescriptor?.enumerable || !("value" in okDescriptor) || typeof okDescriptor.value !== "boolean") throw new TypeError("Invalid acquire result");
  const ok = okDescriptor.value, branch = ok ? "session" : "error";
  if (!exact(value, ["ok", branch])) throw new TypeError("Invalid acquire result");
  if (!ok) { const error = Object.getOwnPropertyDescriptor(value, "error"); if (!error || !("value" in error)) throw new TypeError("Invalid acquire result"); return freeze({ ok: false, error: deepFreeze(validateControlError(error.value)) }); }
  const recognized = rawAcquireSession(value), attachment = recognized && Object.getOwnPropertyDescriptor(recognized.session, "attachment");
  if (!recognized || !attachment || !("value" in attachment)) throw new TypeError("Invalid acquire result");
  validateRuntimeAttachment(attachment.value);
  return freeze({ ok: true, session: recognized.session });
}
async function withSession(runtime: CliRuntimeDependencies, request: Parameters<typeof acquireRuntime>[0], signal: AbortSignal | undefined, operation: (control: RuntimeControl, session: RuntimeControlSession) => Promise<Result>): Promise<Result> {
  const acquired = checkedAcquire(await runtime.acquireRuntime(request, signal ? { signal } : undefined));
  if (!acquired.ok) return acquired;
  try {
    if (request.selector.kind === "known" && !sameDevice(acquired.session.attachment.instance.deviceRef, request.selector.deviceRef)) throw new TypeError("Invalid acquired identity");
    return await operation(acquired.session.control, acquired.session);
  } finally { await acquired.session.close().catch(() => undefined); }
}
async function withOwner<T>(runtime: CliRuntimeDependencies, operation: (owner: RuntimeOwnerLocal) => Promise<T>): Promise<T> {
  const owner = runtime.createRuntimeOwnerLocal();
  try { return await operation(owner); }
  finally { await owner.close().catch(() => undefined); }
}

async function lookup(owner: RuntimeOwnerLocal, opaqueId: string | undefined, signal?: AbortSignal): Promise<Readonly<{ ok: true; value: Extract<LocalStateStatusValue, { state: "ready" }> }> | Failure> {
  const status = validateLocalStateStatusResult(await owner.inspectLocalState({ platform: "android" }, signal ? { signal } : undefined));
  if (!status.ok) return status;
  if (status.value.state === "uninitialized") return failure("instance-not-found");
  if (opaqueId !== undefined && status.value.deviceRef.opaqueId !== opaqueId) return failure("instance-conflict");
  return freeze({ ok: true, value: status.value });
}

async function ensure(command: Extract<CliCommand, { path: "viewer ensure" }>, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
  if (command.platform) return withSession(runtime, { mode: "start-or-attach", selector: { kind: "auto", platform: "android" } }, signal, (control, session) => ensureSession(control, session, signal));
  return withOwner(runtime, async (owner) => {
    const found = await lookup(owner, command.deviceRef, signal);
    if (!found.ok) return found;
    return withSession(runtime, { mode: "start-or-attach", selector: { kind: "known", deviceRef: found.value.deviceRef } }, signal, (control, session) => ensureSession(control, session, signal));
  });
}
async function ensureSession(control: RuntimeControl, session: RuntimeControlSession, signal?: AbortSignal): Promise<Result> {
  const ensured = checkedControl(await control.ensureViewer(signal ? { signal } : undefined), validateEnsureViewerValue);
  if (!ensured.ok) return ensured;
  const value = ensured.value as ReturnType<typeof validateEnsureViewerValue>;
  if (!sameDevice(session.attachment.instance.deviceRef, value.deviceRef)) throw new TypeError("Invalid ensure identity");
  return deepFreeze({ ok: true as const, value: { attachment: session.attachment, deviceRef: value.deviceRef, descriptor: value.descriptor, snapshot: value.snapshot } });
}

async function storedCommand(command: Exclude<CliCommand, { path: "viewer ensure" | "stream wait" | "stream watch" | "local-state status" | "local-state reset-control" | "local-state rebind-device" }>, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
  return withOwner(runtime, async (owner) => {
    const opaqueId = command.path === "runtime shutdown" ? command.deviceRef : undefined;
    const found = await lookup(owner, opaqueId, signal);
    if (!found.ok) return found;
    const deviceRef = found.value.deviceRef, options = signal ? { signal } : undefined;
    if (command.path === "viewer approve") return checkedStream(await owner.approveViewerPairing({ deviceRef, streamId: command.streamId, pairingCode: command.code }, options), validateApproveViewerValue, deviceRef, command.streamId);
    if (command.path === "runtime shutdown") return checkedControl(await owner.shutdownRuntime({ deviceRef }, options), validateShutdownRuntimeValue);
    const request = { mode: "attach-only" as const, selector: { kind: "known" as const, deviceRef } };
    return withSession(runtime, request, signal, async (control) => command.path === "stream inspect"
      ? checkedStream(await control.inspect({ streamId: command.streamId, ...(command.afterRevision === undefined ? {} : { afterRevision: command.afterRevision }) }, options), validateInspectControlValue, deviceRef, command.streamId)
      : checkedStream(await control.stopStream({ streamId: command.streamId, ...(command.expectedRevision === undefined ? {} : { expectedRevision: command.expectedRevision }) }, options), validateStopStreamValue, deviceRef, command.streamId, true));
  });
}

async function observation(command: Extract<CliCommand, { path: "stream wait" | "stream watch" }>, io: CliIo, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<number> {
  const controller = new AbortController(), forward = (): void => controller.abort();
  signal?.addEventListener("abort", forward, { once: true }); if (signal?.aborted) forward();
  const writer = new OutputWriter(io.stdout as unknown as RecordStream, forward); let closeSession: (() => Promise<void>) | undefined;
  const failureStatus = (): 3 | 5 | undefined => writer.failure?.exitStatus;
  const emit = async (result: Result): Promise<number> => {
    const failed = failureStatus();
    if (failed !== undefined) return failed;
    try { await writer.write(result, command.path === "stream watch"); }
    catch { return failureStatus() ?? 5; }
    return exitStatus(result);
  };
  try {
    const failed = failureStatus();
    if (failed !== undefined) return failed;
    const found = await withOwner(runtime, (owner) => lookup(owner, undefined, controller.signal));
    if (!found.ok) return await emit(found);
    const rawAcquire = await runtime.acquireRuntime({ mode: "attach-only", selector: { kind: "known", deviceRef: found.value.deviceRef } }, { signal: controller.signal });
    closeSession = rawAcquireSession(rawAcquire)?.close;
    const acquired = checkedAcquire(rawAcquire);
    if (!acquired.ok) return await emit(acquired);
    const active = acquired.session;
    if (!sameDevice(active.attachment.instance.deviceRef, found.value.deviceRef)) throw new TypeError("Invalid acquired identity");
    if (command.path === "stream wait") {
      const result = checkedStream(await active.control.wait({ streamId: command.streamId, afterRevision: command.afterRevision, waitMs: command.waitMs }, { signal: controller.signal }), validateInspectControlValue, found.value.deviceRef, command.streamId);
      return await emit(result);
    }
    let cursor = command.afterRevision;
    for (;;) {
      const failed = failureStatus();
      if (failed !== undefined) return failed;
      const raw = cursor === undefined
        ? await active.control.inspect({ streamId: command.streamId }, { signal: controller.signal })
        : await active.control.wait({ streamId: command.streamId, afterRevision: cursor, waitMs: 30_000 }, { signal: controller.signal });
      const result = checkedStream(raw, validateInspectControlValue, found.value.deviceRef, command.streamId), status = await emit(result);
      if (status !== exitStatus(result)) return status;
      if (!result.ok) return status;
      const snapshot = (result.value as { snapshot: StreamSnapshot }).snapshot;
      cursor = snapshot.revision;
      if (snapshot.phase === "stopped" || snapshot.phase === "device-disconnected" || snapshot.phase === "failed") return 0;
    }
  } catch {
    return failureStatus() ?? await emit(unexpected());
  } finally {
    signal?.removeEventListener("abort", forward);
    await closeSession?.().catch(() => undefined);
    writer.dispose();
  }
}

function maintenanceValue(status: Extract<LocalStateStatusValue, { state: "ready" }>, value: DeviceRef, revision: number, applied: boolean): Result {
  return freeze({ ok: true, value: freeze({ applied, platform: "android", previousDeviceRef: status.deviceRef, deviceRef: value, previousStateRevision: status.stateRevision, stateRevision: revision }) });
}
async function maintenance(command: Extract<CliCommand, { path: "local-state reset-control" | "local-state rebind-device" }>, io: CliIo, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
  return withOwner(runtime, async (owner) => {
    const found = await lookup(owner, command.deviceRef, signal);
    if (!found.ok) return found;
    const status = found.value;
    if (status.runtime.state === "live") return runtimeLive();
    const rebind = command.path === "local-state rebind-device", word = rebind ? "REBIND" : "RESET";
    const prompt = rebind
      ? `Rebind android device ${status.deviceRef.opaqueId} at state revision ${status.stateRevision} and create a new DeviceRef? Type REBIND to continue: `
      : `Reset android device ${status.deviceRef.opaqueId} at state revision ${status.stateRevision}? Type RESET to continue: `;
    let answer: string | undefined;
    try { answer = await io.question(prompt, signal); }
    catch { return signal?.aborted ? failure("request-cancelled") : unexpected(); }
    if (signal?.aborted) return failure("request-cancelled");
    if (answer !== word) return maintenanceValue(status, status.deviceRef, status.stateRevision, false);
    const input = { platform: "android" as const, expectedDeviceRef: status.deviceRef, expectedStateRevision: status.stateRevision }, options = signal ? { signal } : undefined;
    if (rebind) {
      const result = validateRebindDeviceResult(await owner.rebindDevice(input, options));
      if (!result.ok) return result;
      if (!sameDevice(result.value.previousDeviceRef, status.deviceRef) || result.value.previousStateRevision !== status.stateRevision || result.value.stateRevision !== status.stateRevision + 1 || sameDevice(result.value.deviceRef, status.deviceRef)) throw new TypeError("Invalid rebind result");
      return maintenanceValue(status, result.value.deviceRef, result.value.stateRevision, true);
    }
    const result = validateResetControlStateResult(await owner.resetControlState(input, options));
    if (!result.ok) return result;
    if (!sameDevice(result.value.deviceRef, status.deviceRef) || result.value.previousStateRevision !== status.stateRevision || result.value.stateRevision !== status.stateRevision + 1) throw new TypeError("Invalid reset result");
    return maintenanceValue(status, result.value.deviceRef, result.value.stateRevision, true);
  });
}

async function dispatch(command: Exclude<CliCommand, { path: "stream wait" | "stream watch" }>, io: CliIo, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
  if (command.path === "viewer ensure") return ensure(command, runtime, signal);
  if (command.path === "local-state status") return withOwner(runtime, async (owner) => validateLocalStateStatusResult(await owner.inspectLocalState({ platform: "android" }, signal ? { signal } : undefined)));
  if (command.path === "local-state reset-control" || command.path === "local-state rebind-device") return maintenance(command, io, runtime, signal);
  return storedCommand(command, runtime, signal);
}
function exitStatus(result: Result): number {
  if (result.ok) return 0;
  const disposition = (result.error as { disposition?: unknown }).disposition;
  return disposition === "usage" ? 2 : disposition === "recoverable" ? 3 : disposition === "terminal" ? 4 : 5;
}
function render(result: Result, compact: boolean): string { return `${JSON.stringify(result, undefined, compact ? undefined : 2)}\n`; }

export async function executeCli(argv: readonly string[], io: CliIo, runtime: CliRuntimeDependencies = DEFAULT_RUNTIME, signal?: AbortSignal): Promise<number> {
  const mode = syntaxMode(argv), command = parseCommand(argv);
  if (!command) { const result = syntax(); io.stdout.write(mode === "sequence" ? `\u001e${JSON.stringify(result)}\n` : render(result, mode === "compact")); return 2; }
  if ((command.path === "local-state reset-control" || command.path === "local-state rebind-device") && !(io.stdin.isTTY && io.stderr.isTTY)) {
    const result = syntax(true); io.stdout.write(render(result, command.json)); return 2;
  }
  if (command.path === "stream wait" || command.path === "stream watch") return observation(command, io, runtime, signal);
  let result: Result;
  try { result = await dispatch(command, io, runtime, signal); }
  catch { result = unexpected(); }
  io.stdout.write(render(result, command.json));
  return exitStatus(result);
}
