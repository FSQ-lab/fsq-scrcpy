import assert from "node:assert/strict";
import { inspect } from "node:util";
import test from "node:test";
import {
  CONTROL_ERRORS,
  CONTROL_VERSION,
  ContractValidationError,
  RuntimeControlSession,
  controlError,
  controlErrorStatus,
  encodeCanonicalControlJson,
  parseCanonicalControlJson,
  revisionConflictError,
  validateAcquireRuntimeRequest,
  validateControlError,
  validateControlResult,
  validateControlVersion,
  validateControlWireValue,
  validateDeviceSelector,
  validateEnsureViewerValue,
  validateInspectControlValue,
  validateRevisionConflictError,
  validateRuntimeAttachment,
  validateRuntimeInstance,
  validateRuntimeTarget,
  validateStopStreamValue,
  type RuntimeControl,
  type RuntimeInstance,
} from "../src/index.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const GENERATION = "223e4567-e89b-42d3-a456-426614174000";
const STREAM = "323e4567-e89b-42d3-a456-426614174000";
const DEVICE = Object.freeze({ contractVersion: 2 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId: ID });
const INSTANCE: RuntimeInstance = Object.freeze({ controlVersion: CONTROL_VERSION, instanceId: ID, generation: GENERATION, contractVersion: 2, deviceRef: DEVICE, features: Object.freeze([]) as readonly [] });
const ATTACHMENT = Object.freeze({ disposition: "attached" as const, instance: INSTANCE });
const DESCRIPTOR = Object.freeze({ contractVersion: 2 as const, streamId: STREAM, standaloneUri: `http://127.0.0.1:43210/viewer/${STREAM}`, presentationModes: Object.freeze(["standalone"] as const), expiresAt: 1_800_000_060_000 });
const SNAPSHOT = Object.freeze({ streamId: STREAM, deviceRef: DEVICE, revision: 1, phase: "demand-pending" as const, activeViewerCount: 0 as const, updatedAt: 1_800_000_000_000 });
const invalid = (run: () => unknown): void => { assert.throws(run, (cause: unknown) => cause instanceof ContractValidationError); };
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

await test("control identity values accept only exact Android v1 shapes", () => {
  assert.equal(validateControlVersion(CONTROL_VERSION), CONTROL_VERSION);
  assert.deepEqual(validateRuntimeTarget({ instanceId: ID, generation: GENERATION }), { instanceId: ID, generation: GENERATION });
  assert.deepEqual(validateDeviceSelector({ kind: "auto", platform: "android" }), { kind: "auto", platform: "android" });
  assert.deepEqual(validateDeviceSelector({ kind: "known", deviceRef: DEVICE }), { kind: "known", deviceRef: DEVICE });
  assert.equal(validateRuntimeInstance(INSTANCE), INSTANCE);
  assert.equal(validateRuntimeAttachment(ATTACHMENT), ATTACHMENT);
  assert.deepEqual(validateAcquireRuntimeRequest({ mode: "start-or-attach", selector: { kind: "auto", platform: "android" } }), { mode: "start-or-attach", selector: { kind: "auto", platform: "android" } });
  assert.deepEqual(validateAcquireRuntimeRequest({ mode: "attach-only", selector: { kind: "known", deviceRef: DEVICE } }), { mode: "attach-only", selector: { kind: "known", deviceRef: DEVICE } });
});

await test("selectors reject iOS, legacy contracts, remapping fields and prototypes", () => {
  for (const value of [
    { kind: "auto", platform: "ios" },
    { kind: "auto", platform: "android", serial: "private" },
    { kind: "known", deviceRef: { ...DEVICE, platform: "ios" } },
    { kind: "known", deviceRef: { ...DEVICE, contractVersion: 1 } },
    { kind: "known", deviceRef: DEVICE, remap: true },
    Object.assign(Object.create({}), { kind: "auto", platform: "android" }),
    Object.assign({ kind: "auto", platform: "android" }, { [Symbol("private")]: true }),
  ]) invalid(() => validateDeviceSelector(value));
  for (const mode of ["start", "attach", "", null, 1]) invalid(() => validateAcquireRuntimeRequest({ mode, selector: { kind: "auto", platform: "android" } }));
});

await test("RuntimeInstance version, feature and identity axes remain independent", () => {
  for (const change of [
    { controlVersion: { major: 2, minor: 0 } },
    { controlVersion: { major: 1, minor: 1 } },
    { contractVersion: 1 },
    { features: ["wait-v1"] },
    { features: Object.assign([], { hidden: true }) },
    { instanceId: STREAM.toUpperCase() },
    { generation: "00000000-0000-4000-8000-000000000000", pid: 42 },
  ]) invalid(() => validateRuntimeInstance({ ...INSTANCE, ...change }));
  invalid(() => validateRuntimeTarget({ instanceId: ID, generation: GENERATION, port: 1 }));
});

await test("every ControlError has one tuple, one message and one HTTP mapping", () => {
  for (const [code, tuple] of Object.entries(CONTROL_ERRORS)) {
    const value = controlError(code as keyof typeof CONTROL_ERRORS);
    assert.equal(validateControlError(value), value);
    assert.deepEqual([value.disposition, value.operationState, value.safeMessage], tuple.slice(0, 3));
    assert.equal(controlErrorStatus(value), tuple[3]);
    assert.equal(Object.isFrozen(value), true);
    invalid(() => validateControlError({ ...value, disposition: value.disposition === "terminal" ? "recoverable" : "terminal" }));
    invalid(() => validateControlError({ ...value, operationState: value.operationState === "unknown" ? "not-applied" : "unknown" }));
    invalid(() => validateControlError({ ...value, safeMessage: "almost safe" }));
    invalid(() => validateControlError({ ...value, stack: "private/path" }));
  }
  const conflict = revisionConflictError();
  assert.equal(validateRevisionConflictError(conflict), conflict);
  assert.equal(controlErrorStatus(conflict), 409);
  for (const change of [{ code: "malformed-control" }, { disposition: "terminal" }, { operationState: "unknown" }, { safeMessage: "Revision conflict" }]) invalid(() => validateRevisionConflictError({ ...conflict, ...change }));
});

await test("wire values validate exact ensure, inspect, stop and owner records", () => {
  const ensure = Object.freeze({ deviceRef: DEVICE, descriptor: DESCRIPTOR, snapshot: SNAPSHOT });
  const inspectValue = Object.freeze({ snapshot: SNAPSHOT, changes: Object.freeze([SNAPSHOT]), reset: false });
  const stop = Object.freeze({ snapshot: SNAPSHOT });
  const approve = Object.freeze({ snapshot: SNAPSHOT, approvedAt: Number.MAX_SAFE_INTEGER });
  const shutdown = Object.freeze({ instanceId: ID, generation: GENERATION });
  assert.equal(validateEnsureViewerValue(ensure), ensure);
  assert.equal(validateInspectControlValue(inspectValue), inspectValue);
  assert.equal(validateStopStreamValue(stop), stop);
  for (const value of [{ attachment: ATTACHMENT }, { instance: INSTANCE }, ensure, inspectValue, stop, approve, shutdown]) assert.equal(validateControlWireValue(value), value);
  invalid(() => validateControlWireValue({ ...ensure, viewerGrant: "secret" }));
  invalid(() => validateControlWireValue({ snapshot: SNAPSHOT, changes: Array(17).fill(SNAPSHOT), reset: false }));
  invalid(() => validateControlWireValue({ snapshot: SNAPSHOT, changes: Object.assign([SNAPSHOT], { hidden: true }), reset: false }));
  invalid(() => validateControlWireValue({ snapshot: SNAPSHOT, approvedAt: -1 }));
  invalid(() => validateControlWireValue({ snapshot: SNAPSHOT, approvedAt: 1.5 }));
});

await test("generic results exclude local sessions and permit snapshot only for revision conflict", () => {
  const success = Object.freeze({ ok: true as const, value: Object.freeze({ attachment: ATTACHMENT }) });
  const failure = Object.freeze({ ok: false as const, error: controlError("instance-not-found") });
  const conflict = Object.freeze({ ok: false as const, error: revisionConflictError(), snapshot: SNAPSHOT });
  assert.equal(validateControlResult(success), success);
  assert.equal(validateControlResult(failure), failure);
  assert.equal(validateControlResult(conflict), conflict);
  invalid(() => validateControlResult({ ...failure, snapshot: SNAPSHOT }));
  invalid(() => validateControlResult({ ok: false, error: revisionConflictError() }));
  invalid(() => validateControlResult({ ok: true, value: { session: {} } }));
  invalid(() => validateControlResult({ ok: false, error: controlError("unauthorized"), cause: new Error("private") }));
});

await test("canonical encoder fixes nested and result key order exactly", () => {
  const value = {
    ok: true,
    value: {
      deviceRef: DEVICE,
      descriptor: DESCRIPTOR,
      snapshot: SNAPSHOT,
    },
  };
  const expected = `{"ok":true,"value":{"deviceRef":{"contractVersion":2,"platform":"android","namespace":"fsq.android.local","opaqueId":"${ID}"},"descriptor":{"contractVersion":2,"streamId":"${STREAM}","standaloneUri":"http://127.0.0.1:43210/viewer/${STREAM}","presentationModes":["standalone"],"expiresAt":1800000060000},"snapshot":{"streamId":"${STREAM}","deviceRef":{"contractVersion":2,"platform":"android","namespace":"fsq.android.local","opaqueId":"${ID}"},"revision":1,"phase":"demand-pending","activeViewerCount":0,"updatedAt":1800000000000}}}`;
  assert.equal(new TextDecoder().decode(encodeCanonicalControlJson(value)), expected);
  assert.equal(JSON.stringify(parseCanonicalControlJson(bytes(expected))), expected);
  const reordered = { value: { snapshot: SNAPSHOT, descriptor: DESCRIPTOR, deviceRef: DEVICE }, ok: true };
  assert.equal(new TextDecoder().decode(encodeCanonicalControlJson(reordered)), expected);
});

await test("canonical requests preserve nullable fields and exact route orders", () => {
  const target = { instanceId: ID, generation: GENERATION };
  const cases: readonly [unknown, string][] = [
    [{ controlVersion: CONTROL_VERSION, contractVersion: 2, deviceRef: DEVICE, expectedInstance: null }, `{"controlVersion":{"major":1,"minor":0},"contractVersion":2,"deviceRef":{"contractVersion":2,"platform":"android","namespace":"fsq.android.local","opaqueId":"${ID}"},"expectedInstance":null}`],
    [{ controlVersion: CONTROL_VERSION, target }, `{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"${ID}","generation":"${GENERATION}"}}`],
    [{ controlVersion: CONTROL_VERSION, target, streamId: STREAM, afterRevision: null }, `{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"${ID}","generation":"${GENERATION}"},"streamId":"${STREAM}","afterRevision":null}`],
    [{ controlVersion: CONTROL_VERSION, target, streamId: STREAM, expectedRevision: 9 }, `{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"${ID}","generation":"${GENERATION}"},"streamId":"${STREAM}","expectedRevision":9}`],
    [{ controlVersion: CONTROL_VERSION, target, streamId: STREAM, pairingCode: "ABCDEFGH" }, `{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"${ID}","generation":"${GENERATION}"},"streamId":"${STREAM}","pairingCode":"ABCDEFGH"}`],
  ];
  for (const [value, expected] of cases) {
    const encoded = encodeCanonicalControlJson(value);
    assert.equal(new TextDecoder().decode(encoded), expected);
    assert.equal(JSON.stringify(parseCanonicalControlJson(encoded)), expected);
  }
});

await test("canonical parser rejects whitespace, duplicate keys and alternate numbers", () => {
  const malformed = [
    " {\"ok\":false,\"error\":{}}",
    "{\"ok\":false, \"error\":{}}",
    "{\"ok\":false,\"ok\":true}",
    "{\"major\":1e0,\"minor\":0}",
    "{\"major\":-0,\"minor\":0}",
    "{\"major\":01,\"minor\":0}",
    "{\"major\":1.0,\"minor\":0}",
    "[]",
    "null",
    "{\"unknown\":1}",
    "{\"major\":1,\"minor\":0}\n",
  ];
  for (const source of malformed) invalid(() => parseCanonicalControlJson(bytes(source)));
  invalid(() => parseCanonicalControlJson(bytes("{\"major\":1,\"minor\":0}"), 10));
  invalid(() => parseCanonicalControlJson(Uint8Array.of(0xff)));
});

await test("canonical JSON rejects accessors, symbols, wrong prototypes and unsafe integers", () => {
  const accessor = Object.defineProperty({ minor: 0 }, "major", { get: () => 1, enumerable: true });
  for (const value of [
    accessor,
    Object.assign({ major: 1, minor: 0 }, { [Symbol("private")]: true }),
    Object.assign(Object.create({}), { major: 1, minor: 0 }),
    { major: Number.MAX_SAFE_INTEGER + 1, minor: 0 },
    { major: Number.NaN, minor: 0 },
    { major: -0, minor: 0 },
  ]) invalid(() => encodeCanonicalControlJson(value));
});

await test("RuntimeControlSession exposes only a deeply frozen attachment", async () => {
  const calls: string[] = [];
  const control: RuntimeControl = {
    async ensureViewer() { calls.push("ensure"); return { ok: false, error: controlError("instance-not-found") }; },
    async inspect() { calls.push("inspect"); return { ok: false, error: controlError("instance-not-found") }; },
    async stopStream() { calls.push("stop"); return { ok: false, error: controlError("instance-not-found") }; },
    async close() { calls.push("close"); },
  };
  const session = new RuntimeControlSession(ATTACHMENT, control);
  assert.deepEqual(Object.keys(session), ["attachment"]);
  assert.deepEqual(Object.getOwnPropertySymbols(session), []);
  assert.equal(Object.getOwnPropertyDescriptor(session, "control"), undefined);
  assert.equal(session.control, control);
  assert.equal(Object.isFrozen(session), true);
  assert.equal(Object.isFrozen(session.attachment), true);
  assert.equal(Object.isFrozen(session.attachment.instance), true);
  assert.equal(Object.isFrozen(session.attachment.instance.deviceRef), true);
  assert.equal(Object.isFrozen(session.attachment.instance.features), true);
  assert.deepEqual(session.toValue(), { attachment: session.attachment });
  assert.deepEqual(JSON.parse(JSON.stringify(session)), { attachment: session.attachment });
  assert.deepEqual(inspect(session), inspect({ attachment: session.attachment }));
  const rendered = inspect(session);
  for (const privateValue of ["ensureViewer", "stopStream", "FSQ-Control", "FSQ-Owner", "credential", "viewerGrant"]) assert.equal(rendered.includes(privateValue), false);
  await session.close(); await session[Symbol.asyncDispose]();
  assert.deepEqual(calls, ["close", "close"]);
});

await test("session constructor copies attachment and rejects forged values", () => {
  const mutableDevice: { contractVersion: 2; platform: "android"; namespace: string; opaqueId: string } = { ...DEVICE };
  const mutable = { disposition: "started" as const, instance: { ...INSTANCE, deviceRef: mutableDevice, controlVersion: { ...CONTROL_VERSION }, features: [] as [] } };
  const control = { ensureViewer: async () => ({ ok: false as const, error: controlError("instance-not-found") }), inspect: async () => ({ ok: false as const, error: controlError("instance-not-found") }), stopStream: async () => ({ ok: false as const, error: controlError("instance-not-found") }), close: async () => undefined };
  const session = new RuntimeControlSession(mutable, control);
  mutable.instance.deviceRef.namespace = "changed";
  assert.equal(session.attachment.instance.deviceRef.namespace, "fsq.android.local");
  invalid(() => new RuntimeControlSession({ ...ATTACHMENT, disposition: "other" as never }, control));
});

await test("inspect values admit exactly sixteen ordered changes and reject seventeen", () => {
  const changes = Object.freeze(Array.from({ length: 16 }, (_, index) => Object.freeze({ ...SNAPSHOT, revision: index + 1 })));
  const value = Object.freeze({ snapshot: changes.at(-1)!, changes, reset: false });
  assert.equal(validateInspectControlValue(value), value);
  assert.equal(encodeCanonicalControlJson(changes).byteLength > 0, true);
  invalid(() => validateInspectControlValue({ ...value, changes: [...changes, Object.freeze({ ...SNAPSHOT, revision: 17 })] }));
  invalid(() => validateInspectControlValue({ ...value, changes: changes.slice().reverse(), reset: 0 }));
});

await test("control wall times and positive revision fields preserve exact numeric boundaries", () => {
  const maxSnapshot = Object.freeze({ ...SNAPSHOT, revision: Number.MAX_SAFE_INTEGER, updatedAt: Number.MAX_SAFE_INTEGER });
  const descriptor = Object.freeze({ ...DESCRIPTOR, expiresAt: Number.MAX_SAFE_INTEGER });
  const ensure = { deviceRef: DEVICE, descriptor, snapshot: maxSnapshot };
  assert.equal(validateEnsureViewerValue(ensure), ensure);
  const minimum = { snapshot: maxSnapshot, approvedAt: 0 }, maximum = { snapshot: maxSnapshot, approvedAt: Number.MAX_SAFE_INTEGER };
  assert.equal(validateControlWireValue(minimum), minimum); assert.equal(validateControlWireValue(maximum), maximum);
  for (const approvedAt of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY, "1"]) invalid(() => validateControlWireValue({ snapshot: maxSnapshot, approvedAt }));
});

await test("null-prototype control values are valid but inherited and hidden fields are not", () => {
  const target = Object.assign(Object.create(null), { instanceId: ID, generation: GENERATION });
  assert.equal(validateRuntimeTarget(target), target);
  const selector = Object.assign(Object.create(null), { kind: "auto", platform: "android" });
  assert.equal(validateDeviceSelector(selector), selector);
  const hidden = Object.defineProperty({ instanceId: ID, generation: GENERATION }, "private", { value: true });
  const accessor = Object.defineProperty({ generation: GENERATION }, "instanceId", { enumerable: true, get: () => ID });
  for (const value of [hidden, accessor, Object.assign({ instanceId: ID, generation: GENERATION }, { [Symbol("private")]: true })]) invalid(() => validateRuntimeTarget(value));
});

await test("canonical result branches cannot be confused by reordered or omitted discriminants", () => {
  const success = { value: { instance: INSTANCE }, ok: true };
  const encoded = new TextDecoder().decode(encodeCanonicalControlJson(success));
  assert.equal(encoded.startsWith('{"ok":true,"value":'), true);
  assert.equal(validateControlResult(parseCanonicalControlJson(bytes(encoded))).ok, true);
  for (const value of [
    { value: { instance: INSTANCE } },
    { ok: "true", value: { instance: INSTANCE } },
    { ok: false, value: { instance: INSTANCE } },
    { ok: true, error: controlError("instance-not-found") },
    { ok: false, error: controlError("instance-not-found"), snapshot: SNAPSHOT },
  ]) invalid(() => validateControlResult(value));
});

await test("canonical string grammar rejects invalid escapes and unpaired surrogates", () => {
  for (const source of [
    '{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"\\x","generation":"x"}}',
    '{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"\\uD800","generation":"x"}}',
    '{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"line\nbreak","generation":"x"}}',
    '{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"unterminated,"generation":"x"}}',
  ]) invalid(() => parseCanonicalControlJson(bytes(source)));
});

await test("canonical body byte limit counts UTF-8 octets, not JavaScript characters", () => {
  const exactBody = encodeCanonicalControlJson({ controlVersion: CONTROL_VERSION, target: { instanceId: ID, generation: GENERATION } });
  assert.equal(typeof parseCanonicalControlJson(exactBody), "object");
  invalid(() => parseCanonicalControlJson(exactBody, exactBody.byteLength - 1));
  const unicode = bytes('{"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"é","generation":"é"}}');
  assert.equal(unicode.byteLength > new TextDecoder().decode(unicode).length, true);
  invalid(() => parseCanonicalControlJson(unicode, unicode.byteLength - 1));
});
