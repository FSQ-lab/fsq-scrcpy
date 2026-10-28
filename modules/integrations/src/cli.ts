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
  type RuntimeControlSession,
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
import { compactSyntax, parseCommand, type CliCommand } from "./parse.js";

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
  readonly stdout: Readonly<{ write(value: string): unknown }>;
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
function checkedAcquire(value: unknown): Readonly<{ ok: true; session: RuntimeControlSession }> | Readonly<{ ok: false; error: ControlError }> {
  if (!exact(value, ["ok", (value as { ok?: unknown }).ok === true ? "session" : "error"]) || typeof value.ok !== "boolean") throw new TypeError("Invalid acquire result");
  if (!value.ok) { const error = validateControlError(value.error); return freeze({ ok: false, error: deepFreeze(error) }); }
  const session = value.session as RuntimeControlSession;
  if (typeof session !== "object" || session === null || typeof session.close !== "function" || typeof session.control !== "object") throw new TypeError("Invalid acquire result");
  validateRuntimeAttachment(session.attachment);
  return value as Readonly<{ ok: true; session: RuntimeControlSession }>;
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

async function storedCommand(command: Exclude<CliCommand, { path: "viewer ensure" | "local-state status" | "local-state reset-control" | "local-state rebind-device" }>, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
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

async function dispatch(command: CliCommand, io: CliIo, runtime: CliRuntimeDependencies, signal?: AbortSignal): Promise<Result> {
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
  const compactFailure = compactSyntax(argv), command = parseCommand(argv);
  if (!command) { const result = syntax(); io.stdout.write(render(result, compactFailure)); return 2; }
  if ((command.path === "local-state reset-control" || command.path === "local-state rebind-device") && !(io.stdin.isTTY && io.stderr.isTTY)) {
    const result = syntax(true); io.stdout.write(render(result, command.json)); return 2;
  }
  let result: Result;
  try { result = await dispatch(command, io, runtime, signal); }
  catch { result = unexpected(); }
  io.stdout.write(render(result, command.json));
  return exitStatus(result);
}
