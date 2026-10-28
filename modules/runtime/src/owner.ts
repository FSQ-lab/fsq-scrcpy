import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import {
  controlError,
  validateApproveViewerValue,
  validateControlError,
  validateDeviceRef,
  validateRuntimeTarget,
  validateShutdownRuntimeValue,
  validateStreamId,
  type ApproveViewerValue,
  type ControlError,
  type ControlErrorCode,
  type ControlResult,
  type DeviceRef,
  type RuntimeTarget,
  type ShutdownRuntimeValue,
} from "../../contracts/src/index.js";
import {
  resolveSingleAndroidBinding,
  revealAndroidBinding,
  type ResolvedAndroidBinding,
} from "../../capture/src/index.js";
import {
  LocalRuntimeState,
  LocalStateFailure,
  type AndroidRuntimeSlot,
  type RuntimeGenerationState,
} from "./control-state.js";
import { helloControl, OwnerHttpControl, type RuntimeOwnerControl } from "./control.js";

export type RuntimeLiveError = Readonly<{
  code: "runtime-live";
  disposition: "terminal";
  operationState: "not-applied";
  safeMessage: "A matching Runtime is still running.";
}>;
export type OwnerMaintenanceError = ControlError | RuntimeLiveError;
export type OwnerLocalResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: OwnerMaintenanceError }>;
export type LocalStateStatusValue =
  | Readonly<{ platform: "android"; state: "uninitialized" }>
  | Readonly<{
      platform: "android";
      state: "ready";
      deviceRef: DeviceRef;
      stateRevision: number;
      runtime: Readonly<{ state: "not-running" }> | Readonly<{ state: "live"; target: RuntimeTarget }>;
    }>;
export type ResetControlStateValue = Readonly<{
  platform: "android";
  deviceRef: DeviceRef;
  previousStateRevision: number;
  stateRevision: number;
}>;
export type RebindDeviceValue = Readonly<{
  platform: "android";
  previousDeviceRef: DeviceRef;
  deviceRef: DeviceRef;
  previousStateRevision: number;
  stateRevision: number;
}>;

export interface RuntimeOwnerLocal extends AsyncDisposable {
  inspectLocalState(input: Readonly<{ platform: "android" }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<LocalStateStatusValue>>;
  approveViewerPairing(input: Readonly<{ deviceRef: DeviceRef; streamId: string; pairingCode: string }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ApproveViewerValue>>;
  shutdownRuntime(input: Readonly<{ deviceRef: DeviceRef }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ShutdownRuntimeValue>>;
  resetControlState(input: Readonly<{ platform: "android"; expectedDeviceRef: DeviceRef; expectedStateRevision: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<ResetControlStateValue>>;
  rebindDevice(input: Readonly<{ platform: "android"; expectedDeviceRef: DeviceRef; expectedStateRevision: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<RebindDeviceValue>>;
  close(): Promise<void>;
}

const RUNTIME_LIVE: RuntimeLiveError = Object.freeze({
  code: "runtime-live",
  disposition: "terminal",
  operationState: "not-applied",
  safeMessage: "A matching Runtime is still running.",
});
const CAPTURE_ERRORS = new Set<ControlErrorCode>([
  "dependency-unavailable", "adb-incompatible", "device-not-found", "device-ambiguous",
  "device-unavailable", "artifact-unavailable", "artifact-mismatch",
]);
const ordinary = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => ordinary(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return !!descriptor?.enumerable && "value" in descriptor; });
const sameDevice = (left: DeviceRef, right: DeviceRef): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
const positiveRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && !Object.is(value, -0);
const cloneDevice = (value: DeviceRef): DeviceRef => Object.freeze({ contractVersion: 2, platform: value.platform, namespace: value.namespace, opaqueId: value.opaqueId });
const cloneTarget = (value: RuntimeTarget): RuntimeTarget => Object.freeze({ instanceId: value.instanceId, generation: value.generation });
const ok = <T>(value: T): Readonly<{ ok: true; value: T }> => Object.freeze({ ok: true, value });
const failure = (code: ControlErrorCode): Readonly<{ ok: false; error: ControlError }> => Object.freeze({ ok: false, error: controlError(code) });
const ownerFailure = (error: OwnerMaintenanceError): Readonly<{ ok: false; error: OwnerMaintenanceError }> => Object.freeze({ ok: false, error });

function deepFreezeCopy<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map((entry) => deepFreezeCopy(entry))) as T;
  if (ordinary(value)) {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(value)) copy[key] = deepFreezeCopy(value[key]);
    return Object.freeze(copy) as T;
  }
  return value;
}
function options(value: unknown): Readonly<{ signal?: AbortSignal }> | undefined {
  if (value === undefined) return undefined;
  if (!ordinary(value)) throw new TypeError("Invalid owner-local options");
  const keys = Object.hasOwn(value, "signal") ? ["signal"] : [];
  if (!exact(value, keys) || (Object.hasOwn(value, "signal") && !(value.signal instanceof AbortSignal))) throw new TypeError("Invalid owner-local options");
  return value as Readonly<{ signal?: AbortSignal }>;
}
function platformInput(value: unknown): void {
  if (!exact(value, ["platform"]) || value.platform !== "android") throw new TypeError("Invalid owner-local input");
}
function expectedInput(value: unknown): Readonly<{ expectedDeviceRef: DeviceRef; expectedStateRevision: number }> {
  if (!exact(value, ["platform", "expectedDeviceRef", "expectedStateRevision"]) || value.platform !== "android" || !positiveRevision(value.expectedStateRevision)) throw new TypeError("Invalid owner-local input");
  const expectedDeviceRef = validateDeviceRef(value.expectedDeviceRef);
  if (expectedDeviceRef.platform !== "android") throw new TypeError("Invalid owner-local input");
  return Object.freeze({ expectedDeviceRef, expectedStateRevision: value.expectedStateRevision });
}
function deviceInput(value: unknown): DeviceRef {
  if (!exact(value, ["deviceRef"])) throw new TypeError("Invalid owner-local input");
  const deviceRef = validateDeviceRef(value.deviceRef);
  if (deviceRef.platform !== "android") throw new TypeError("Invalid owner-local input");
  return deviceRef;
}
function approveInput(value: unknown): Readonly<{ deviceRef: DeviceRef; streamId: string; pairingCode: string }> {
  if (!exact(value, ["deviceRef", "streamId", "pairingCode"]) || typeof value.pairingCode !== "string" || !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(value.pairingCode)) throw new TypeError("Invalid owner-local input");
  const deviceRef = validateDeviceRef(value.deviceRef), streamId = validateStreamId(value.streamId);
  if (deviceRef.platform !== "android") throw new TypeError("Invalid owner-local input");
  return Object.freeze({ deviceRef, streamId, pairingCode: value.pairingCode });
}
function maintenanceError(value: unknown): OwnerMaintenanceError {
  try { const error = validateControlError(value); return controlError(error.code); } catch { /* try local error */ }
  if (!exact(value, ["code", "disposition", "operationState", "safeMessage"]) || value.code !== RUNTIME_LIVE.code || value.disposition !== RUNTIME_LIVE.disposition || value.operationState !== RUNTIME_LIVE.operationState || value.safeMessage !== RUNTIME_LIVE.safeMessage) throw new TypeError("Invalid owner-local result");
  return RUNTIME_LIVE;
}
function result<T>(value: unknown, validateValue: (input: unknown) => T): OwnerLocalResult<T> {
  if (exact(value, ["ok", "value"]) && value.ok === true) return ok(validateValue(value.value));
  if (exact(value, ["ok", "error"]) && value.ok === false) return ownerFailure(maintenanceError(value.error));
  throw new TypeError("Invalid owner-local result");
}
function statusValue(value: unknown): LocalStateStatusValue {
  if (exact(value, ["platform", "state"]) && value.platform === "android" && value.state === "uninitialized") return Object.freeze({ platform: "android", state: "uninitialized" });
  if (!exact(value, ["platform", "state", "deviceRef", "stateRevision", "runtime"]) || value.platform !== "android" || value.state !== "ready" || !positiveRevision(value.stateRevision)) throw new TypeError("Invalid owner-local status");
  const deviceRef = validateDeviceRef(value.deviceRef);
  if (deviceRef.platform !== "android") throw new TypeError("Invalid owner-local status");
  let runtime: Extract<LocalStateStatusValue, { state: "ready" }>["runtime"];
  if (exact(value.runtime, ["state"]) && value.runtime.state === "not-running") runtime = Object.freeze({ state: "not-running" });
  else if (exact(value.runtime, ["state", "target"]) && value.runtime.state === "live") runtime = Object.freeze({ state: "live", target: cloneTarget(validateRuntimeTarget(value.runtime.target)) });
  else throw new TypeError("Invalid owner-local status");
  return Object.freeze({ platform: "android", state: "ready", deviceRef: cloneDevice(deviceRef), stateRevision: value.stateRevision, runtime });
}
function resetValue(value: unknown): ResetControlStateValue {
  if (!exact(value, ["platform", "deviceRef", "previousStateRevision", "stateRevision"]) || value.platform !== "android" || !positiveRevision(value.previousStateRevision) || value.stateRevision !== value.previousStateRevision + 1) throw new TypeError("Invalid owner-local reset result");
  const deviceRef = validateDeviceRef(value.deviceRef);
  if (deviceRef.platform !== "android") throw new TypeError("Invalid owner-local reset result");
  return Object.freeze({ platform: "android", deviceRef: cloneDevice(deviceRef), previousStateRevision: value.previousStateRevision, stateRevision: value.stateRevision });
}
function rebindValue(value: unknown): RebindDeviceValue {
  if (!exact(value, ["platform", "previousDeviceRef", "deviceRef", "previousStateRevision", "stateRevision"]) || value.platform !== "android" || !positiveRevision(value.previousStateRevision) || value.stateRevision !== value.previousStateRevision + 1) throw new TypeError("Invalid owner-local rebind result");
  const previousDeviceRef = validateDeviceRef(value.previousDeviceRef), deviceRef = validateDeviceRef(value.deviceRef);
  if (previousDeviceRef.platform !== "android" || deviceRef.platform !== "android" || sameDevice(previousDeviceRef, deviceRef)) throw new TypeError("Invalid owner-local rebind result");
  return Object.freeze({ platform: "android", previousDeviceRef: cloneDevice(previousDeviceRef), deviceRef: cloneDevice(deviceRef), previousStateRevision: value.previousStateRevision, stateRevision: value.stateRevision });
}

export const validateLocalStateStatusResult = (value: unknown): OwnerLocalResult<LocalStateStatusValue> => result(value, statusValue);
export const validateResetControlStateResult = (value: unknown): OwnerLocalResult<ResetControlStateValue> => result(value, resetValue);
export const validateRebindDeviceResult = (value: unknown): OwnerLocalResult<RebindDeviceValue> => result(value, rebindValue);

interface OwnerDependencies {
  readonly state: () => LocalRuntimeState;
  readonly hello: typeof helloControl;
  readonly owner: (slot: AndroidRuntimeSlot, target: RuntimeTarget) => RuntimeOwnerControl;
  readonly resolveBinding: (signal?: AbortSignal) => Promise<ResolvedAndroidBinding>;
  readonly now: () => number;
  readonly uuid: () => string;
}
const dependencies: OwnerDependencies = Object.freeze({
  state: () => new LocalRuntimeState(),
  hello: helloControl,
  owner: (slot: AndroidRuntimeSlot, target: RuntimeTarget) => new OwnerHttpControl(slot.control.port, target, slot.control.credential),
  resolveBinding: async (signal?: AbortSignal) => {
    const resolved = await resolveSingleAndroidBinding(signal ? { signal } : undefined);
    if (!resolved.ok) throw resolved.error;
    return revealAndroidBinding(resolved.value.access);
  },
  now: Date.now,
  uuid: randomUUID,
});

class RuntimeOwnerLocalImpl implements RuntimeOwnerLocal {
  #closed = false;
  readonly #dependencies: OwnerDependencies;
  readonly #controls = new Set<RuntimeOwnerControl>();
  constructor(configured: OwnerDependencies) { this.#dependencies = configured; }

  async inspectLocalState(input: Readonly<{ platform: "android" }>, configured?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<LocalStateStatusValue>> {
    try {
      platformInput(input); const checked = options(configured);
      if (this.#closed) return failure("runtime-exited");
      if (checked?.signal?.aborted) return failure("request-cancelled");
      const state = this.#dependencies.state();
      if (!await state.openExisting()) return validateLocalStateStatusResult(ok(Object.freeze({ platform: "android", state: "uninitialized" as const })));
      const slot = await state.readSlot();
      if (!slot) return validateLocalStateStatusResult(ok(Object.freeze({ platform: "android", state: "uninitialized" as const })));
      const live = await this.#authority(state, slot, checked?.signal);
      if (live.kind === "error") return validateLocalStateStatusResult(failure(live.code));
      const runtime = live.kind === "absent" ? Object.freeze({ state: "not-running" as const }) : Object.freeze({ state: "live" as const, target: live.target });
      return validateLocalStateStatusResult(ok(Object.freeze({ platform: "android" as const, state: "ready" as const, deviceRef: slot.deviceRef, stateRevision: slot.revision, runtime })));
    } catch (cause) { return validateLocalStateStatusResult(failure(this.#map(cause))); }
  }

  async approveViewerPairing(input: Readonly<{ deviceRef: DeviceRef; streamId: string; pairingCode: string }>, configured?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ApproveViewerValue>> {
    try {
      const checkedInput = approveInput(input), checked = options(configured);
      if (this.#closed) return failure("runtime-exited");
      if (checked?.signal?.aborted) return failure("request-cancelled");
      const current = await this.#current(checkedInput.deviceRef, checked?.signal);
      if (!current.ok) return current.result;
      const control = this.#dependencies.owner(current.slot, current.target); this.#controls.add(control);
      try { return this.#controlResult(await control.approveViewerPairing({ streamId: checkedInput.streamId, pairingCode: checkedInput.pairingCode }, checked), validateApproveViewerValue); }
      finally { this.#controls.delete(control); await control.close(); }
    } catch (cause) { return failure(this.#map(cause)); }
  }

  async shutdownRuntime(input: Readonly<{ deviceRef: DeviceRef }>, configured?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ShutdownRuntimeValue>> {
    try {
      const checkedInput = deviceInput(input), checked = options(configured);
      if (this.#closed) return failure("runtime-exited");
      if (checked?.signal?.aborted) return failure("request-cancelled");
      const current = await this.#current(checkedInput, checked?.signal);
      if (!current.ok) return current.result;
      const control = this.#dependencies.owner(current.slot, current.target); this.#controls.add(control);
      try { return this.#controlResult(await control.shutdownRuntime(current.target, checked), validateShutdownRuntimeValue); }
      finally { this.#controls.delete(control); await control.close(); }
    } catch (cause) { return failure(this.#map(cause)); }
  }

  async resetControlState(input: Readonly<{ platform: "android"; expectedDeviceRef: DeviceRef; expectedStateRevision: number }>, configured?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<ResetControlStateValue>> {
    try {
      const expected = expectedInput(input), checked = options(configured);
      if (this.#closed) return validateResetControlStateResult(failure("runtime-exited"));
      if (checked?.signal?.aborted) return validateResetControlStateResult(failure("request-cancelled"));
      const state = this.#dependencies.state(), slot = await this.#maintenanceSlot(state, expected, checked?.signal);
      if ("result" in slot) return validateResetControlStateResult(slot.result);
      const replaced = await state.replaceSlot(slot.slot, slot.generation, slot.slot.binding, slot.slot.deviceRef, this.#dependencies.now(), checked?.signal);
      return validateResetControlStateResult(ok(Object.freeze({ platform: "android" as const, deviceRef: replaced.slot.deviceRef, previousStateRevision: replaced.previous.revision, stateRevision: replaced.slot.revision })));
    } catch (cause) { return validateResetControlStateResult(failure(this.#map(cause))); }
  }

  async rebindDevice(input: Readonly<{ platform: "android"; expectedDeviceRef: DeviceRef; expectedStateRevision: number }>, configured?: Readonly<{ signal?: AbortSignal }>): Promise<OwnerLocalResult<RebindDeviceValue>> {
    try {
      const expected = expectedInput(input), checked = options(configured);
      if (this.#closed) return validateRebindDeviceResult(failure("runtime-exited"));
      if (checked?.signal?.aborted) return validateRebindDeviceResult(failure("request-cancelled"));
      const binding = await this.#dependencies.resolveBinding(checked?.signal);
      if (checked?.signal?.aborted) return validateRebindDeviceResult(failure("request-cancelled"));
      const state = this.#dependencies.state(), slot = await this.#maintenanceSlot(state, expected, checked?.signal);
      if ("result" in slot) return validateRebindDeviceResult(slot.result);
      let opaqueId = "";
      for (let attempt = 0; attempt < 32 && (!opaqueId || opaqueId === slot.slot.deviceRef.opaqueId); attempt++) opaqueId = this.#dependencies.uuid();
      const deviceRef = Object.freeze({ contractVersion: 2 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId });
      validateDeviceRef(deviceRef);
      if (sameDevice(deviceRef, slot.slot.deviceRef)) throw new LocalStateFailure("local-state-recovery-required");
      const replaced = await state.replaceSlot(slot.slot, slot.generation, binding, deviceRef, this.#dependencies.now(), checked?.signal);
      return validateRebindDeviceResult(ok(Object.freeze({ platform: "android" as const, previousDeviceRef: replaced.previous.deviceRef, deviceRef: replaced.slot.deviceRef, previousStateRevision: replaced.previous.revision, stateRevision: replaced.slot.revision })));
    } catch (cause) { return validateRebindDeviceResult(failure(this.#map(cause))); }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const controls = [...this.#controls]; this.#controls.clear();
    await Promise.all(controls.map((control) => control.close().catch(() => undefined)));
  }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }

  async #authority(state: LocalRuntimeState, slot: AndroidRuntimeSlot, signal?: AbortSignal): Promise<Readonly<{ kind: "live"; target: RuntimeTarget }> | Readonly<{ kind: "absent"; generation: RuntimeGenerationState | undefined }> | Readonly<{ kind: "error"; code: ControlErrorCode }>> {
    let generation: RuntimeGenerationState | undefined;
    try { generation = await state.readGeneration(slot); } catch { return Object.freeze({ kind: "error", code: "local-state-recovery-required" }); }
    const expected = generation ? Object.freeze({ instanceId: generation.instanceId, generation: generation.generation }) : null;
    const answer = await this.#dependencies.hello(slot, expected, signal);
    if (answer.ok) return Object.freeze({ kind: "live", target: cloneTarget({ instanceId: answer.value.instance.instanceId, generation: answer.value.instance.generation }) });
    if (answer.error.code === "instance-not-found") return Object.freeze({ kind: "absent", generation });
    if (answer.error.code === "request-cancelled") return Object.freeze({ kind: "error", code: "request-cancelled" });
    return Object.freeze({ kind: "error", code: "local-state-recovery-required" });
  }
  async #current(deviceRef: DeviceRef, signal?: AbortSignal): Promise<Readonly<{ ok: true; state: LocalRuntimeState; slot: AndroidRuntimeSlot; target: RuntimeTarget }> | Readonly<{ ok: false; result: Readonly<{ ok: false; error: ControlError }> }>> {
    const state = this.#dependencies.state();
    if (!await state.openExisting()) return Object.freeze({ ok: false, result: failure("instance-not-found") });
    const slot = await state.readSlot();
    if (!slot) return Object.freeze({ ok: false, result: failure("instance-not-found") });
    if (!sameDevice(slot.deviceRef, deviceRef)) return Object.freeze({ ok: false, result: failure("instance-conflict") });
    const authority = await this.#authority(state, slot, signal);
    if (authority.kind === "absent") return Object.freeze({ ok: false, result: failure("instance-not-found") });
    if (authority.kind === "error") return Object.freeze({ ok: false, result: failure(authority.code) });
    const latest = await state.readSlot();
    if (!latest || latest.revision !== slot.revision || !sameDevice(latest.deviceRef, slot.deviceRef) || latest.control.port !== slot.control.port || latest.control.credential !== slot.control.credential) return Object.freeze({ ok: false, result: failure("instance-conflict") });
    return Object.freeze({ ok: true, state, slot: latest, target: authority.target });
  }
  async #maintenanceSlot(state: LocalRuntimeState, expected: Readonly<{ expectedDeviceRef: DeviceRef; expectedStateRevision: number }>, signal?: AbortSignal): Promise<Readonly<{ slot: AndroidRuntimeSlot; generation: RuntimeGenerationState | undefined }> | Readonly<{ result: OwnerLocalResult<never> }>> {
    if (!await state.openExisting()) return Object.freeze({ result: failure("instance-not-found") });
    const slot = await state.readSlot();
    if (!slot) return Object.freeze({ result: failure("instance-not-found") });
    if (!sameDevice(slot.deviceRef, expected.expectedDeviceRef) || slot.revision !== expected.expectedStateRevision) return Object.freeze({ result: failure("instance-conflict") });
    const authority = await this.#authority(state, slot, signal);
    if (authority.kind === "live") return Object.freeze({ result: ownerFailure(RUNTIME_LIVE) });
    if (authority.kind === "error") return Object.freeze({ result: failure(authority.code) });
    return Object.freeze({ slot, generation: authority.generation });
  }
  #controlResult<T extends ApproveViewerValue | ShutdownRuntimeValue>(value: unknown, validateValue: (input: unknown) => T): ControlResult<T> {
    if (exact(value, ["ok", "value"]) && value.ok === true) return ok(deepFreezeCopy(validateValue(value.value))) as ControlResult<T>;
    if (exact(value, ["ok", "error"]) && value.ok === false) { const error = validateControlError(value.error); return failure(error.code); }
    throw new TypeError("Invalid owner control result");
  }
  #map(cause: unknown): ControlErrorCode {
    if (cause instanceof LocalStateFailure) return cause.code;
    if (cause instanceof TypeError) return "malformed-control";
    if (ordinary(cause) && typeof cause.code === "string" && CAPTURE_ERRORS.has(cause.code as ControlErrorCode)) return cause.code as ControlErrorCode;
    return "local-state-recovery-required";
  }
}
Object.defineProperty(RuntimeOwnerLocalImpl.prototype, inspect.custom, { value() { return Object.freeze({}); } });

export function createRuntimeOwnerLocal(): RuntimeOwnerLocal { return new RuntimeOwnerLocalImpl(dependencies); }

export const ownerTestInternals = Object.freeze({
  create(configured: Partial<OwnerDependencies> = {}): RuntimeOwnerLocal {
    return new RuntimeOwnerLocalImpl(Object.freeze({ ...dependencies, ...configured }));
  },
  runtimeLiveError: RUNTIME_LIVE,
});
