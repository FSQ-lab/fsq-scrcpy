import { inspect } from "node:util";
import {
  CONTRACT_VERSION,
  ContractValidationError,
  validateDeviceRef,
  validateStreamId,
  validateStreamSnapshot,
  validateViewerDescriptor,
  type DeviceRef,
  type StreamId,
  type StreamSnapshot,
  type ViewerDescriptor,
} from "./index.js";

export const CONTROL_VERSION = Object.freeze({ major: 1 as const, minor: 0 as const });
export type ControlVersion = Readonly<{ major: 1; minor: 0 }>;
export type RuntimeTarget = Readonly<{ instanceId: string; generation: string }>;
export type DeviceSelector = Readonly<{ kind: "auto"; platform: "android" }> | Readonly<{ kind: "known"; deviceRef: DeviceRef }>;
export type RuntimeInstance = Readonly<{ controlVersion: ControlVersion; instanceId: string; generation: string; contractVersion: 2; deviceRef: DeviceRef; features: readonly [] }>;
export type RuntimeAttachment = Readonly<{ disposition: "started" | "attached"; instance: RuntimeInstance }>;
export type AcquireRuntimeRequest = Readonly<{ mode: "attach-only" | "start-or-attach"; selector: DeviceSelector }>;
export type AcquireRuntimeValue = Readonly<{ attachment: RuntimeAttachment }>;
export type HelloControlValue = Readonly<{ instance: RuntimeInstance }>;
export type EnsureViewerValue = Readonly<{ deviceRef: DeviceRef; descriptor: ViewerDescriptor; snapshot: StreamSnapshot }>;
export type InspectControlValue = Readonly<{ snapshot: StreamSnapshot; changes: readonly StreamSnapshot[]; reset: boolean }>;
export type StopStreamValue = Readonly<{ snapshot: StreamSnapshot }>;
export type ApproveViewerValue = Readonly<{ snapshot: StreamSnapshot; approvedAt: number }>;
export type ShutdownRuntimeValue = Readonly<{ instanceId: string; generation: string }>;
export type ControlWireValue = AcquireRuntimeValue | HelloControlValue | EnsureViewerValue | InspectControlValue | StopStreamValue | ApproveViewerValue | ShutdownRuntimeValue;
export type ControlErrorCode = keyof typeof CONTROL_ERRORS;
export type ControlError = Readonly<{ controlVersion: ControlVersion; code: ControlErrorCode; disposition: "recoverable" | "terminal" | "state-unknown"; operationState: "not-applied" | "unknown"; safeMessage: string }>;
export type RevisionConflictError = Readonly<{ controlVersion: ControlVersion; code: "revision-conflict"; disposition: "recoverable"; operationState: "not-applied"; safeMessage: "The expected revision does not match." }>;
export type ControlResult<T extends ControlWireValue> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; error: ControlError }>;
export type StopStreamResult = ControlResult<StopStreamValue> | Readonly<{ ok: false; error: RevisionConflictError; snapshot: StreamSnapshot }>;

export const CONTROL_ERRORS = Object.freeze({
  "instance-not-found": ["recoverable", "not-applied", "No matching Runtime is available.", 404],
  "instance-conflict": ["terminal", "not-applied", "The Runtime identity does not match.", 409],
  "control-version-mismatch": ["terminal", "not-applied", "The RuntimeControl version is incompatible.", 409],
  unauthorized: ["terminal", "not-applied", "Authorization failed.", 401],
  "malformed-control": ["terminal", "not-applied", "The control request is invalid.", 400],
  "deadline-exceeded": ["state-unknown", "unknown", "The control operation deadline was exceeded; its outcome is unknown.", 504],
  "request-cancelled": ["recoverable", "not-applied", "The control request was cancelled before it was applied.", 499],
  "runtime-exited": ["state-unknown", "unknown", "The Runtime exited before its result was known.", 503],
  "runtime-overload": ["recoverable", "not-applied", "The Runtime control plane is at capacity.", 429],
  "dependency-unavailable": ["terminal", "not-applied", "Required dependency is unavailable.", 503],
  "adb-incompatible": ["terminal", "not-applied", "ADB is incompatible.", 503],
  "device-not-found": ["terminal", "not-applied", "Device was not found.", 404],
  "device-ambiguous": ["terminal", "not-applied", "Device selection is ambiguous.", 409],
  "device-unavailable": ["terminal", "not-applied", "Device is unavailable.", 503],
  "artifact-unavailable": ["terminal", "not-applied", "Artifact is unavailable.", 503],
  "artifact-mismatch": ["terminal", "not-applied", "Artifact verification failed.", 412],
  "local-state-recovery-required": ["terminal", "not-applied", "Local Runtime state requires owner recovery.", 409],
} as const);

const fail = (name = "RuntimeControl"): never => { throw new ContractValidationError(name); };
const ordinary = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): Record<string, unknown> => {
  if (!ordinary(value)) return fail();
  if (Reflect.ownKeys(value).length !== keys.length) return fail();
  for (const key of keys) { const descriptor = Object.getOwnPropertyDescriptor(value, key); if (!descriptor?.enumerable || !("value" in descriptor)) return fail(); }
  return value;
};
const safeInteger = (value: unknown, minimum = 0): number => typeof value === "number" && Number.isSafeInteger(value) && !Object.is(value, -0) && value >= minimum ? value : fail();
const sameDevice = (left: DeviceRef, right: DeviceRef): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

export function validateControlVersion(value: unknown): ControlVersion { const v = exact(value, ["major", "minor"]); if (v.major !== 1 || v.minor !== 0) fail(); return value as ControlVersion; }
export function validateRuntimeTarget(value: unknown): RuntimeTarget { const v = exact(value, ["instanceId", "generation"]); validateStreamId(v.instanceId); validateStreamId(v.generation); return value as RuntimeTarget; }
export function validateDeviceSelector(value: unknown): DeviceSelector {
  const object = ordinary(value) ? value : fail();
  if (object.kind === "auto") { const v = exact(object, ["kind", "platform"]); if (v.platform !== "android") return fail(); return object as DeviceSelector; }
  const v = exact(object, ["kind", "deviceRef"]); if (v.kind !== "known") return fail(); const device = validateDeviceRef(v.deviceRef); if (device.platform !== "android") return fail(); return object as DeviceSelector;
}
export function validateAcquireRuntimeRequest(value: unknown): AcquireRuntimeRequest { const v = exact(value, ["mode", "selector"]); if (v.mode !== "attach-only" && v.mode !== "start-or-attach") fail(); validateDeviceSelector(v.selector); return value as AcquireRuntimeRequest; }
export function validateRuntimeInstance(value: unknown): RuntimeInstance {
  const v = exact(value, ["controlVersion", "instanceId", "generation", "contractVersion", "deviceRef", "features"]); validateControlVersion(v.controlVersion); validateStreamId(v.instanceId); validateStreamId(v.generation); if (v.contractVersion !== CONTRACT_VERSION || !Array.isArray(v.features) || Object.getPrototypeOf(v.features) !== Array.prototype || Reflect.ownKeys(v.features).length !== 1 || v.features.length !== 0) fail(); const device = validateDeviceRef(v.deviceRef); if (device.platform !== "android") fail(); return value as RuntimeInstance;
}
export function validateRuntimeAttachment(value: unknown): RuntimeAttachment { const v = exact(value, ["disposition", "instance"]); if (v.disposition !== "started" && v.disposition !== "attached") fail(); validateRuntimeInstance(v.instance); return value as RuntimeAttachment; }
export function validateControlError(value: unknown): ControlError {
  const v = exact(value, ["controlVersion", "code", "disposition", "operationState", "safeMessage"]); validateControlVersion(v.controlVersion); if (typeof v.code !== "string" || !Object.hasOwn(CONTROL_ERRORS, v.code)) fail(); const tuple = CONTROL_ERRORS[v.code as ControlErrorCode]; if (v.disposition !== tuple[0] || v.operationState !== tuple[1] || v.safeMessage !== tuple[2]) fail(); return value as ControlError;
}
export function validateRevisionConflictError(value: unknown): RevisionConflictError { const v = exact(value, ["controlVersion", "code", "disposition", "operationState", "safeMessage"]); validateControlVersion(v.controlVersion); if (v.code !== "revision-conflict" || v.disposition !== "recoverable" || v.operationState !== "not-applied" || v.safeMessage !== "The expected revision does not match.") fail(); return value as RevisionConflictError; }
export function controlError(code: ControlErrorCode): ControlError { const tuple = CONTROL_ERRORS[code]; return frozen({ controlVersion: CONTROL_VERSION, code, disposition: tuple[0], operationState: tuple[1], safeMessage: tuple[2] }); }
export function revisionConflictError(): RevisionConflictError { return frozen({ controlVersion: CONTROL_VERSION, code: "revision-conflict", disposition: "recoverable", operationState: "not-applied", safeMessage: "The expected revision does not match." }); }
export function controlErrorStatus(error: ControlError | RevisionConflictError): number { if (error.code === "revision-conflict") return 409; return CONTROL_ERRORS[error.code][3]; }

export function validateControlWireValue(value: unknown): ControlWireValue {
  const object = ordinary(value) ? value : fail();
  const keys = Object.keys(object);
  if (Reflect.ownKeys(object).length !== keys.length || keys.some((key) => { const descriptor = Object.getOwnPropertyDescriptor(object, key); return !descriptor?.enumerable || !("value" in descriptor); })) return fail();
  const has = (expected: readonly string[]): boolean => keys.length === expected.length && expected.every((key) => Object.hasOwn(object, key));
  if (has(["attachment"])) { validateRuntimeAttachment(object.attachment); return object as AcquireRuntimeValue; }
  if (has(["instance"])) { validateRuntimeInstance(object.instance); return object as HelloControlValue; }
  if (has(["deviceRef", "descriptor", "snapshot"])) { const device = validateDeviceRef(object.deviceRef), descriptor = validateViewerDescriptor(object.descriptor), snapshot = validateStreamSnapshot(object.snapshot); if (descriptor.streamId !== snapshot.streamId || !sameDevice(device, snapshot.deviceRef)) return fail(); return object as EnsureViewerValue; }
  if (has(["snapshot", "changes", "reset"])) {
    const snapshot = validateStreamSnapshot(object.snapshot), changes = object.changes;
    if (!Array.isArray(changes) || changes.length > 16 || Object.getPrototypeOf(changes) !== Array.prototype || Reflect.ownKeys(changes).length !== changes.length + 1) return fail();
    let revision = 0; for (let index = 0; index < changes.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(changes, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) return fail(); const change = validateStreamSnapshot(descriptor.value); if (change.streamId !== snapshot.streamId || change.revision <= revision || change.revision > snapshot.revision) return fail(); revision = change.revision; }
    if (typeof object.reset !== "boolean" || (object.reset && changes.length !== 0)) return fail(); return object as InspectControlValue;
  }
  if (has(["snapshot"])) { validateStreamSnapshot(object.snapshot); return object as StopStreamValue; }
  if (has(["snapshot", "approvedAt"])) { validateStreamSnapshot(object.snapshot); safeInteger(object.approvedAt); return object as ApproveViewerValue; }
  if (has(["instanceId", "generation"])) { validateStreamId(object.instanceId); validateStreamId(object.generation); return object as ShutdownRuntimeValue; }
  return fail();
}
export function validateControlResult(value: unknown): ControlResult<ControlWireValue> | StopStreamResult {
  const result = ordinary(value) ? value : fail();
  if (typeof result.ok !== "boolean") return fail();
  if (result.ok) { const v = exact(result, ["ok", "value"]); validateControlWireValue(v.value); return result as Readonly<{ ok: true; value: ControlWireValue }>; }
  if (Object.hasOwn(result, "snapshot")) { const v = exact(result, ["ok", "error", "snapshot"]); validateRevisionConflictError(v.error); validateStreamSnapshot(v.snapshot); return result as Readonly<{ ok: false; error: RevisionConflictError; snapshot: StreamSnapshot }>; }
  const v = exact(result, ["ok", "error"]); validateControlError(v.error); return result as Readonly<{ ok: false; error: ControlError }>;
}
const isEnsureViewerValue = (value: ControlWireValue): value is EnsureViewerValue => Object.hasOwn(value, "descriptor");
const isInspectControlValue = (value: ControlWireValue): value is InspectControlValue => Object.hasOwn(value, "changes");
const isStopStreamValue = (value: ControlWireValue): value is StopStreamValue => Object.keys(value).length === 1 && Object.hasOwn(value, "snapshot");
export function validateEnsureViewerValue(value: unknown): EnsureViewerValue { const checked = validateControlWireValue(value); return isEnsureViewerValue(checked) ? checked : fail(); }
export function validateInspectControlValue(value: unknown): InspectControlValue { const checked = validateControlWireValue(value); return isInspectControlValue(checked) ? checked : fail(); }
export function validateStopStreamValue(value: unknown): StopStreamValue { const checked = validateControlWireValue(value); return isStopStreamValue(checked) ? checked : fail(); }
export function validateHelloControlValue(value: unknown): HelloControlValue { const object=exact(value,["instance"]);validateRuntimeInstance(object.instance);return object as HelloControlValue; }
export function validateApproveViewerValue(value: unknown): ApproveViewerValue { const object=exact(value,["snapshot","approvedAt"]);validateStreamSnapshot(object.snapshot);safeInteger(object.approvedAt);return object as ApproveViewerValue; }
export function validateShutdownRuntimeValue(value: unknown): ShutdownRuntimeValue { const object=exact(value,["instanceId","generation"]);validateRuntimeTarget(object);return object as ShutdownRuntimeValue; }

const ORDERS = [
  ["ok", "value"], ["ok", "error"], ["ok", "error", "snapshot"],
  ["major", "minor"], ["instanceId", "generation"], ["contractVersion", "platform", "namespace", "opaqueId"],
  ["controlVersion", "instanceId", "generation", "contractVersion", "deviceRef", "features"], ["disposition", "instance"],
  ["controlVersion", "code", "disposition", "operationState", "safeMessage"], ["descriptor"], ["attachment"], ["instance"],
  ["deviceRef", "descriptor", "snapshot"], ["snapshot", "changes", "reset"], ["snapshot"], ["snapshot", "approvedAt"],
  ["streamId", "deviceRef", "revision", "phase", "reason", "epoch", "codedSize", "displaySize", "activeViewerCount", "updatedAt"],
  ["width", "height"], ["contractVersion", "streamId", "standaloneUri", "presentationModes", "expiresAt"],
  ["controlVersion", "contractVersion", "deviceRef", "expectedInstance"], ["controlVersion", "target"],
  ["controlVersion", "target", "streamId", "afterRevision"], ["controlVersion", "target", "streamId", "expectedRevision"],
  ["controlVersion", "target", "streamId", "pairingCode"], ["kind", "platform"], ["kind", "deviceRef"], ["mode", "selector"],
] as const;
function orderFor(keys: readonly string[]): readonly string[] {
  for (const order of ORDERS) { const candidate: readonly string[] = order; if (keys.every((key) => candidate.includes(key)) && candidate.filter((key) => keys.includes(key)).length === keys.length) return candidate.filter((key) => keys.includes(key)); }
  return fail("CanonicalControlJson");
}
function canonical(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return safeInteger(value);
  if (Array.isArray(value)) { if (Object.getPrototypeOf(value) !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1) return fail("CanonicalControlJson"); for (let index = 0; index < value.length; index++) { const descriptor = Object.getOwnPropertyDescriptor(value, String(index)); if (!descriptor?.enumerable || !("value" in descriptor)) return fail("CanonicalControlJson"); } return value.map(canonical); }
  const object = ordinary(value) ? value : fail("CanonicalControlJson"), keys: string[] = [];
  for (const key of Reflect.ownKeys(object)) { if (typeof key !== "string") return fail("CanonicalControlJson"); keys.push(key); }
  const out: Record<string, unknown> = {};
  for (const key of orderFor(keys)) { const descriptor = Object.getOwnPropertyDescriptor(object, key); if (!descriptor?.enumerable || !("value" in descriptor)) return fail("CanonicalControlJson"); out[key] = canonical(descriptor.value); }
  return out;
}
export function encodeCanonicalControlJson(value: unknown): Uint8Array { return new TextEncoder().encode(JSON.stringify(canonical(value))); }

function strictParse(bytes: Uint8Array): unknown {
  const source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); let at = 0;
  function parseString(): string { const start = at; if (source[at++] !== '"') return fail("CanonicalControlJson"); while (at < source.length) { const c = source[at++]!; if (c === '"') { const parsed = JSON.parse(source.slice(start, at)) as unknown; if (typeof parsed !== "string" || !parsed.isWellFormed()) return fail("CanonicalControlJson"); return parsed; } if (c < " " || (c === "\\" && at++ >= source.length)) return fail("CanonicalControlJson"); } return fail("CanonicalControlJson"); }
  function parseValue(): unknown { const c = source[at]; if (c === '"') return parseString(); if (c === "{") return parseObject(); if (c === "[") return parseArray(); const literals: readonly (readonly [string, boolean | null])[] = [["true", true], ["false", false], ["null", null]]; for (const [literal, parsed] of literals) if (source.startsWith(literal, at)) { at += literal.length; return parsed; } const match = /^(?:0|[1-9][0-9]*)/.exec(source.slice(at)); if (!match) return fail("CanonicalControlJson"); at += match[0].length; return safeInteger(Number(match[0])); }
  function parseObject(): Readonly<Record<string, unknown>> { at++; const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>; if (source[at] === "}") { at++; return Object.freeze(out); } for (;;) { const key = parseString(); if (Object.hasOwn(out, key) || source[at++] !== ":") return fail("CanonicalControlJson"); out[key] = parseValue(); const c = source[at++]; if (c === "}") return Object.freeze(out); if (c !== ",") return fail("CanonicalControlJson"); } }
  function parseArray(): readonly unknown[] { at++; const out: unknown[] = []; if (source[at] === "]") { at++; return Object.freeze(out); } for (;;) { out.push(parseValue()); const c = source[at++]; if (c === "]") return Object.freeze(out); if (c !== ",") return fail("CanonicalControlJson"); } }
  const result = parseValue(); if (at !== source.length) return fail("CanonicalControlJson"); return result;
}
export function parseCanonicalControlJson(bytes: Uint8Array, maxBytes = 16_384): unknown { try { if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes) return fail("CanonicalControlJson"); const parsed = strictParse(bytes); if (!ordinary(parsed)) return fail("CanonicalControlJson"); const encoded = encodeCanonicalControlJson(parsed); if (!Buffer.from(encoded).equals(Buffer.from(bytes))) return fail("CanonicalControlJson"); return parsed; } catch (cause) { if (cause instanceof ContractValidationError) throw cause; return fail("CanonicalControlJson"); } }

export interface RuntimeControl {
  ensureViewer(options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<EnsureViewerValue>>;
  inspect(input: Readonly<{ streamId: StreamId; afterRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<InspectControlValue>>;
  stopStream(input: Readonly<{ streamId: StreamId; expectedRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<StopStreamResult>;
  close(): Promise<void>;
}
export class RuntimeControlSession implements AsyncDisposable {
  #control: RuntimeControl;
  readonly attachment: RuntimeAttachment;
  constructor(attachment: RuntimeAttachment, control: RuntimeControl) { this.attachment = deepFreezeAttachment(validateRuntimeAttachment(attachment)); this.#control = control; Object.freeze(this); }
  get control(): RuntimeControl { return this.#control; }
  toValue(): AcquireRuntimeValue { return frozen({ attachment: this.attachment }); }
  toJSON(): AcquireRuntimeValue { return this.toValue(); }
  close(): Promise<void> { return this.#control.close(); }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
Object.defineProperty(RuntimeControlSession.prototype, inspect.custom, { value(this: RuntimeControlSession) { return this.toValue(); } });
function deepFreezeAttachment(value: RuntimeAttachment): RuntimeAttachment { const deviceRef = frozen({ ...value.instance.deviceRef }); const controlVersion = frozen({ ...value.instance.controlVersion }); const features = Object.freeze([]) as readonly []; const instance = frozen({ ...value.instance, controlVersion, deviceRef, features }); return frozen({ disposition: value.disposition, instance }); }
