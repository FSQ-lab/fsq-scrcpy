import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  ContractValidationError, STREAM_PHASES, createViewerAccess, revealViewerGrant, validateDeviceRef,
  validateSize, validateStreamError, validateStreamId, validateStreamSnapshot, validateViewerDescriptor
} from "../src/index.js";

const id = "123e4567-e89b-42d3-a456-426614174000";
const device = { contractVersion: 2, platform: "android", namespace: "fsq.device-v1", opaqueId: id } as const;
const descriptor = { contractVersion: 2, streamId: id, standaloneUri: `http://127.0.0.1:8080/viewer/${id}`, presentationModes: ["standalone"], expiresAt: 0 } as const;
const snapshot = { streamId: id, deviceRef: device, revision: 1, phase: "streaming", codedSize: { width: 720, height: 1280 }, displaySize: { width: 720, height: 1280 }, activeViewerCount: 1, updatedAt: Number.MAX_SAFE_INTEGER } as const;
const error = { code: "malformed-media", scope: "stream", disposition: "terminal", safeMessage: "Invalid media" } as const;
const errorCases = [
  ["dependency-unavailable", "service", "terminal"], ["adb-incompatible", "service", "terminal"],
  ["runtime-bind-failed", "service", "terminal"], ["instance-conflict", "service", "terminal"],
  ["device-not-found", "capture", "terminal"], ["device-ambiguous", "capture", "terminal"],
  ["device-unavailable", "capture", "terminal"], ["artifact-unavailable", "capture", "terminal"],
  ["artifact-mismatch", "capture", "terminal"], ["version-mismatch", "capture", "terminal"],
  ["capture-start-failed", "capture", "terminal"], ["codec-disabled", "capture", "terminal"],
  ["codec-config-error", "capture", "terminal"], ["unsupported-codec", "capture", "terminal"],
  ["malformed-media", "stream", "terminal"], ["malformed-control", "viewer", "terminal"],
  ["start-timeout", "stream", "terminal"], ["quality-target-unmet", "acceptance", "terminal"],
  ["backpressure-gap", "stream", "recoverable"], ["backpressure-timeout", "stream", "terminal"],
  ["runtime-overload", "stream", "terminal"], ["stream-interrupted", "stream", "state-unknown"],
  ["device-disconnected", "capture", "terminal"], ["slow-consumer", "viewer", "terminal"],
  ["viewer-unsupported", "viewer", "terminal"], ["viewer-limit-reached", "viewer", "terminal"],
  ["unauthorized", "viewer", "terminal"], ["presentation-blocked", "presentation", "recoverable"],
  ["acceptance-failed", "acceptance", "terminal"]
] as const;
const invalid = (run: () => unknown) => assert.throws(run, (caught) => caught instanceof ContractValidationError && caught.code === "invalid-contract-value");

function withChange<T extends object>(value: T, key: string, replacement: unknown): object {
  return { ...value, [key]: replacement };
}

test("public serialized values validate exact v2 forms and boundaries", () => {
  assert.equal(validateStreamId(id), id);
  assert.equal(validateDeviceRef(device), device);
  assert.equal(validateViewerDescriptor(descriptor), descriptor);
  assert.equal(validateStreamSnapshot(snapshot), snapshot);
  assert.equal(validateStreamError(error), error);
  assert.deepEqual(validateSize({ width: 1, height: 0xffffffff }), { width: 1, height: 0xffffffff });
  assert.equal(validateViewerDescriptor({ ...descriptor, expiresAt: Number.MAX_SAFE_INTEGER }).expiresAt, Number.MAX_SAFE_INTEGER);
  assert.equal(validateStreamError({ ...error, safeMessage: "é".repeat(256) }).safeMessage.length, 256);
  assert.equal(validateStreamSnapshot({ ...snapshot, phase: "interrupted", reason: "stream-interrupted", epoch: Number.MAX_SAFE_INTEGER }).phase, "interrupted");
  assert.equal(validateStreamSnapshot({ ...snapshot, phase: "stopped", reason: "lease-expired", activeViewerCount: 0 }).phase, "stopped");
  assert.equal(validateStreamSnapshot({ ...snapshot, phase: "failed", reason: "start-timeout", activeViewerCount: 0 }).phase, "failed");
  assert.equal(validateStreamSnapshot({ ...snapshot, phase: "failed", reason: "stream-interrupted", activeViewerCount: 0 }).reason, "stream-interrupted");
  assert.equal(validateStreamSnapshot({ ...snapshot, phase: "device-disconnected", reason: "device-disconnected", activeViewerCount: 0 }).phase, "device-disconnected");
});

test("control v2 accepts provider-neutral iOS identities and rejects legacy/provider values", () => {
  const ios = { ...device, platform: "ios", namespace: "fsq.devices" } as const;
  assert.equal(validateDeviceRef(ios), ios);
  assert.equal(validateStreamSnapshot({ ...snapshot, deviceRef: ios }).deviceRef, ios);
  for (const platform of ["macos", "IOS", "wda", "", null]) invalid(() => validateDeviceRef({ ...ios, platform }));
  for (const contractVersion of [1, 0, 3, "2"]) {
    invalid(() => validateDeviceRef({ ...ios, contractVersion }));
    invalid(() => validateViewerDescriptor({ ...descriptor, contractVersion }));
    invalid(() => validateStreamSnapshot({ ...snapshot, deviceRef: { ...ios, contractVersion } }));
  }
  for (const key of ["provider", "udid", "endpoint", "port", "sessionId", "path"]) {
    invalid(() => validateDeviceRef({ ...ios, [key]: "private" }));
    invalid(() => validateDeviceRef({ ...device, [key]: "private" }));
  }
});

test("public validators reject malformed, coerced and additional values", () => {
  const cases: Array<() => unknown> = [
    () => validateStreamId("123E4567-e89b-42d3-a456-426614174000"),
    () => validateDeviceRef(withChange(device, "namespace", "ADB")),
    () => validateDeviceRef({ ...device, serial: "secret" }),
    () => validateDeviceRef(Object.assign(Object.create({}), device)),
    () => validateSize({ width: 0, height: 1 }),
    () => validateSize({ width: 1, height: 0x1_0000_0000 }),
    () => validateViewerDescriptor(withChange(descriptor, "contractVersion", 1)),
    () => validateViewerDescriptor(withChange(descriptor, "standaloneUri", `http://localhost:8080/viewer/${id}`)),
    () => validateViewerDescriptor(withChange(descriptor, "standaloneUri", `${descriptor.standaloneUri}?grant=secret`)),
    () => validateViewerDescriptor(withChange(descriptor, "standaloneUri", `http://127.0.0.1:080/viewer/${id}`)),
    () => validateViewerDescriptor(withChange(descriptor, "expiresAt", 1.5)),
    () => validateViewerDescriptor({ ...descriptor, embedResource: "forbidden" }),
    () => validateStreamError(withChange(error, "scope", "capture")),
    () => validateStreamError(withChange(error, "safeMessage", "line\nbreak")),
    () => validateStreamError(withChange(error, "safeMessage", "e\u0301")),
    () => validateStreamError(withChange(error, "safeMessage", "x".repeat(513))),
    () => validateStreamError({ ...error, retryAfter: 1 }),
    () => validateStreamSnapshot(withChange(snapshot, "activeViewerCount", 2)),
    () => validateStreamSnapshot(withChange(snapshot, "updatedAt", Number.POSITIVE_INFINITY)),
    () => validateStreamSnapshot({ ...snapshot, reason: "explicit-stop" }),
    () => validateStreamSnapshot({ ...snapshot, phase: "failed", reason: "slow-consumer" }),
    () => validateStreamSnapshot({ ...snapshot, phase: "interrupted" }),
    () => validateStreamSnapshot({ ...snapshot, epoch: undefined }),
    () => validateStreamSnapshot({ ...snapshot, reason: undefined }),
    () => validateStreamSnapshot({ ...snapshot, pid: 42 })
  ];
  for (const run of cases) invalid(run);
  const nullPrototype = Object.assign(Object.create(null), device);
  assert.equal(validateDeviceRef(nullPrototype), nullPrototype);
});

test("exact object validation rejects hidden, symbol and accessor properties", () => {
  const hidden = Object.defineProperty({ ...device }, "toJSON", { value: () => device, enumerable: false });
  const nonEnumerable = Object.defineProperty({ ...device }, "namespace", { value: "fsq", enumerable: false });
  const accessor = Object.defineProperty({ ...device }, "namespace", { get: () => "fsq" });
  for (const value of [hidden, nonEnumerable, accessor, { ...device, [Symbol("hidden")]: true }]) invalid(() => validateDeviceRef(value));
  const accessorModes = Object.defineProperty(["standalone"], "0", { get: () => "standalone" });
  const hiddenModes = Object.defineProperty(["standalone"], "hidden", { value: true });
  const extraModes = Object.assign(["standalone"], { extra: true });
  const symbolModes = Object.assign(["standalone"], { [Symbol("hidden")]: true });
  for (const presentationModes of [accessorModes, hiddenModes, extraModes, symbolModes]) invalid(() => validateViewerDescriptor({ ...descriptor, presentationModes }));
});

test("all error metadata and identity/URI/grant boundaries are exact", () => {
  for (const [code, scope, disposition] of errorCases) assert.equal(validateStreamError({ code, scope, disposition, safeMessage: "safe" }).code, code);
  assert.equal(validateStreamError({ ...error, safeMessage: "x" }).safeMessage, "x");
  invalid(() => validateStreamError({ ...error, safeMessage: "" }));
  for (const variant of ["8", "9", "a", "b"]) assert.equal(validateStreamId(`${id.slice(0, 19)}${variant}${id.slice(20)}`).length, 36);
  invalid(() => validateStreamId(`${id.slice(0, 14)}5${id.slice(15)}`));
  invalid(() => validateStreamId(`${id.slice(0, 19)}7${id.slice(20)}`));
  for (const namespace of ["a", `a${"b".repeat(63)}`]) assert.equal(validateDeviceRef({ ...device, namespace }).namespace, namespace);
  for (const namespace of ["", `a${"b".repeat(64)}`]) invalid(() => validateDeviceRef({ ...device, namespace }));
  for (const port of [1, 65535]) assert.equal(validateViewerDescriptor({ ...descriptor, standaloneUri: `http://127.0.0.1:${port}/viewer/${id}` }).streamId, id);
  for (const port of [0, 65536]) invalid(() => validateViewerDescriptor({ ...descriptor, standaloneUri: `http://127.0.0.1:${port}/viewer/${id}` }));
  assert.equal(revealViewerGrant(createViewerAccess(descriptor, "A".repeat(22)).viewerGrant).length, 22);
  assert.equal(revealViewerGrant(createViewerAccess(descriptor, "A".repeat(2048)).viewerGrant).length, 2048);
  invalid(() => createViewerAccess(descriptor, "A".repeat(2050)));
  const max = Number.MAX_SAFE_INTEGER;
  for (const revision of [1, max]) assert.equal(validateStreamSnapshot({ ...snapshot, revision }).revision, revision);
  for (const revision of [0, max + 1]) invalid(() => validateStreamSnapshot({ ...snapshot, revision }));
  for (const epoch of [1, max]) assert.equal(validateStreamSnapshot({ ...snapshot, epoch }).epoch, epoch);
  for (const epoch of [0, max + 1]) invalid(() => validateStreamSnapshot({ ...snapshot, epoch }));
  for (const expiresAt of [0, max]) assert.equal(validateViewerDescriptor({ ...descriptor, expiresAt }).expiresAt, expiresAt);
  for (const expiresAt of [-1, max + 1]) invalid(() => validateViewerDescriptor({ ...descriptor, expiresAt }));
  for (const updatedAt of [0, max]) assert.equal(validateStreamSnapshot({ ...snapshot, updatedAt }).updatedAt, updatedAt);
  for (const updatedAt of [-1, max + 1]) invalid(() => validateStreamSnapshot({ ...snapshot, updatedAt }));
});

test("exported phases are immutable and cannot change validation", () => {
  assert.equal(Object.isFrozen(STREAM_PHASES), true);
  assert.throws(() => (STREAM_PHASES as unknown as string[]).push("rogue"));
  invalid(() => validateStreamSnapshot({ ...snapshot, phase: "rogue" }));
});

test("ViewerAccess exposes the descriptor while keeping grant secret", () => {
  const raw = "AAAAAAAAAAAAAAAAAAAAAA";
  const access = createViewerAccess(descriptor, raw);
  assert.deepEqual(Object.keys(access), ["descriptor"]);
  assert.deepEqual(Object.getOwnPropertySymbols(access), [Symbol.for("nodejs.util.inspect.custom")]);
  assert.equal(Object.getOwnPropertyDescriptor(access, "viewerGrant")?.enumerable, false);
  assert.equal(Object.isFrozen(access), true);
  assert.equal(Object.isFrozen(access.descriptor), true);
  assert.equal(Object.isFrozen(access.descriptor.presentationModes), true);
  assert.equal(String(access.viewerGrant), "[REDACTED]");
  assert.equal(JSON.stringify(access.viewerGrant), '"[REDACTED]"');
  assert.equal(JSON.stringify(access), JSON.stringify({ descriptor: access.descriptor }));
  assert.equal(inspect(access.viewerGrant), "[REDACTED]");
  assert.equal(inspect(access).includes(raw), false);
  assert.equal(revealViewerGrant(access.viewerGrant), raw);
  invalid(() => createViewerAccess(descriptor, "short"));
  invalid(() => createViewerAccess(descriptor, "AAAAAAAAAAAAAAAAAAAAAB"));
});
