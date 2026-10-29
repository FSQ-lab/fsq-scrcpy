import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_VERSION,
  controlError,
  revisionConflictError,
  type DeviceRef,
  type RuntimeAttachment,
  type RuntimeControl,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import { createAgentControl } from "../src/agent-control.js";

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "223e4567-e89b-42d3-a456-426614174000";
const STREAM_ID = "323e4567-e89b-42d3-a456-426614174000";
const INSTANCE_ID = "423e4567-e89b-42d3-a456-426614174000";
const GENERATION_ID = "523e4567-e89b-42d3-a456-426614174000";
const DEVICE: DeviceRef = Object.freeze({
  contractVersion: 2,
  platform: "android",
  namespace: "fsq.android.local",
  opaqueId: DEVICE_ID,
});
const OTHER_DEVICE: DeviceRef = Object.freeze({ ...DEVICE, opaqueId: OTHER_ID });
const ATTACHMENT: RuntimeAttachment = Object.freeze({
  disposition: "attached",
  instance: Object.freeze({
    controlVersion: CONTROL_VERSION,
    instanceId: INSTANCE_ID,
    generation: GENERATION_ID,
    contractVersion: 2,
    deviceRef: DEVICE,
    features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const),
  }),
});
const snapshot = (
  revision = 1,
  deviceRef: DeviceRef = DEVICE,
  streamId = STREAM_ID,
): StreamSnapshot => Object.freeze({
  streamId,
  deviceRef,
  revision,
  phase: "demand-pending",
  activeViewerCount: 0,
  updatedAt: revision,
});
const observation = (revision = 1): unknown => ({
  ok: true,
  value: {
    snapshot: snapshot(revision),
    changes: [snapshot(revision)],
    reset: false,
    timedOut: false,
  },
});
const ensured = (): unknown => ({
  ok: true,
  value: {
    deviceRef: DEVICE,
    descriptor: {
      contractVersion: 2,
      streamId: STREAM_ID,
      standaloneUri: `http://127.0.0.1:49152/viewer/${STREAM_ID}`,
      presentationModes: ["standalone"],
      expiresAt: 60,
    },
    snapshot: snapshot(),
  },
});
const EXPECTED_UNEXPECTED = {
  ok: false,
  error: {
    controlVersion: { major: 1, minor: 0 },
    code: "runtime-exited",
    disposition: "state-unknown",
    operationState: "unknown",
    safeMessage: "The Runtime exited before its result was known.",
  },
};
interface Calls {
  acquire: unknown[];
  options: unknown[];
  control: unknown[];
  controlOptions: unknown[];
  closes: number;
}
function fixture(overrides: Partial<RuntimeControl> = {}): {
  calls: Calls;
  agent: ReturnType<typeof createAgentControl>;
  setAcquire(value: unknown): void;
} {
  const calls: Calls = { acquire: [], options: [], control: [], controlOptions: [], closes: 0 };
  const control: RuntimeControl = {
    async ensureViewer(options) {
      calls.control.push(["ensure"]);
      calls.controlOptions.push(options);
      return ensured() as never;
    },
    async inspect(input, options) {
      calls.control.push(["inspect", input]);
      calls.controlOptions.push(options);
      return observation() as never;
    },
    async wait(input, options) {
      calls.control.push(["wait", input]);
      calls.controlOptions.push(options);
      return observation(input.afterRevision + 1) as never;
    },
    async stopStream(input, options) {
      calls.control.push(["stop", input]);
      calls.controlOptions.push(options);
      return { ok: true, value: { snapshot: snapshot() } };
    },
    async close() {},
    ...overrides,
  };
  let acquireValue: unknown = {
    ok: true,
    session: {
      attachment: ATTACHMENT,
      control,
      async close() { calls.closes++; },
    },
  };
  return {
    calls,
    setAcquire(value) { acquireValue = value; },
    agent: createAgentControl({
      acquireRuntime: (async (request: unknown, options: unknown) => {
        calls.acquire.push(request);
        calls.options.push(options);
        if (acquireValue instanceof Error) throw acquireValue;
        return acquireValue;
      }) as never,
    }),
  };
}

await test("ensure owns the only start-or-attach mapping, validates parity, freezes output, and closes once", async () => {
  const value = fixture();
  const controller = new AbortController();
  const result = await value.agent.ensure(
    { selector: { kind: "known", deviceRef: DEVICE } },
    { signal: controller.signal },
  );
  assert.equal(result.ok, true);
  assert.deepEqual(value.calls.acquire, [{
    mode: "start-or-attach",
    selector: { kind: "known", deviceRef: DEVICE },
  }]);
  assert.equal((value.calls.options[0] as { signal: AbortSignal }).signal, controller.signal);
  assert.equal((value.calls.controlOptions[0] as { signal: AbortSignal }).signal, controller.signal);
  assert.equal(value.calls.closes, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.ok ? result.value : {}), true);
  assert.deepEqual(result, {
    ok: true,
    value: {
      attachment: ATTACHMENT,
      deviceRef: DEVICE,
      descriptor: (ensured() as { value: { descriptor: unknown } }).value.descriptor,
      snapshot: snapshot(),
    },
  });
});

await test("expected acquire failures remain exact safe results", async () => {
  const value = fixture();
  value.setAcquire({ ok: false, error: controlError("instance-not-found") });
  assert.deepEqual(
    await value.agent.ensure({ selector: { kind: "auto", platform: "android" } }),
    { ok: false, error: controlError("instance-not-found") },
  );
  const session = await value.agent.openKnown({ deviceRef: DEVICE });
  assert.deepEqual(await session.inspect({ streamId: STREAM_ID }), {
    ok: false,
    error: controlError("instance-not-found"),
  });
  await session.close();
  assert.equal(value.calls.control.length, 0);
  assert.equal(value.calls.closes, 0);
});
await test("malformed acquire successes are closed and mapped without private or accessor leakage", async () => {
  const malformedValues: readonly { extra?: string; attachment?: unknown }[] = [
    { extra: "/Users/private/control.json" },
    { attachment: { ...ATTACHMENT, privateCredential: "secret" } },
    { attachment: { ...ATTACHMENT, instance: { ...ATTACHMENT.instance, features: [] } } },
  ];
  for (const malformed of malformedValues) {
    const value = fixture();
    value.setAcquire({
      ok: true,
      session: {
        attachment: malformed.attachment ?? ATTACHMENT,
        control: {},
        extra: malformed.extra,
        async close() { value.calls.closes++; },
      },
      ...(malformed.extra ? { privatePath: malformed.extra } : {}),
    });
    const result = await value.agent.ensure({ selector: { kind: "auto", platform: "android" } });
    assert.deepEqual(result, EXPECTED_UNEXPECTED);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(value.calls.closes, 1);
  }
  const accessor = fixture();
  const rawSession = {
    attachment: ATTACHMENT,
    async close() { accessor.calls.closes++; },
  } as { attachment: RuntimeAttachment; close(): Promise<void>; control?: unknown };
  Object.defineProperty(rawSession, "control", {
    enumerable: true,
    get() { throw new Error("credential=/Users/private/control.json"); },
  });
  accessor.setAcquire({ ok: true, session: rawSession });
  assert.deepEqual(
    await accessor.agent.ensure({ selector: { kind: "auto", platform: "android" } }),
    EXPECTED_UNEXPECTED,
  );
  assert.equal(accessor.calls.closes, 1);
});
await test("known acquire identity mismatches fail closed before any operation", async () => {
  const value = fixture();
  value.setAcquire({
    ok: true,
    session: {
      attachment: {
        ...ATTACHMENT,
        instance: { ...ATTACHMENT.instance, deviceRef: OTHER_DEVICE },
      },
      control: {},
      async close() { value.calls.closes++; },
    },
  });
  const session = await value.agent.openKnown({ deviceRef: DEVICE });
  assert.deepEqual(await session.wait({ streamId: STREAM_ID, afterRevision: 1, waitMs: 25_000 }), EXPECTED_UNEXPECTED);
  await session.close();
  assert.equal(value.calls.closes, 1);
});
await test("one openKnown session maps inspect, wait, and stop without reacquire", async () => {
  const value = fixture();
  const signal = new AbortController().signal;
  const session = await value.agent.openKnown({ deviceRef: DEVICE }, { signal });
  assert.deepEqual(Reflect.ownKeys(session), []);
  assert.deepEqual(Reflect.ownKeys(Object.getPrototypeOf(session)).filter((key) => key !== "constructor"), ["inspect", "wait", "stop", "close"]);
  for (const forbidden of ["control", "deviceRef", "closeSession", "unavailable"]) assert.equal(Reflect.get(session, forbidden), undefined);
  assert.equal(JSON.stringify(session), "{}");
  const inspected = await session.inspect({ streamId: STREAM_ID, afterRevision: 2 }, { signal });
  const waited = await session.wait({ streamId: STREAM_ID, afterRevision: 2, waitMs: 25_000 }, { signal });
  const stopped = await session.stop({ streamId: STREAM_ID, expectedRevision: 3 }, { signal });
  assert.equal(inspected.ok, true);
  assert.equal(waited.ok, true);
  assert.equal(stopped.ok, true);
  assert.deepEqual(value.calls.acquire, [{
    mode: "attach-only",
    selector: { kind: "known", deviceRef: DEVICE },
  }]);
  assert.deepEqual(value.calls.control, [
    ["inspect", { streamId: STREAM_ID, afterRevision: 2 }],
    ["wait", { streamId: STREAM_ID, afterRevision: 2, waitMs: 25_000 }],
    ["stop", { streamId: STREAM_ID, expectedRevision: 3 }],
  ]);
  for (const options of value.calls.controlOptions) {
    assert.equal((options as { signal: AbortSignal }).signal, signal);
  }
  await session.close();
  await session.close();
  assert.equal(value.calls.closes, 1);
});
await test("expected provider failures and the only stop snapshot failure remain exact", async () => {
  const failure = controlError("runtime-overload");
  const value = fixture({
    async inspect() { return { ok: false, error: failure }; },
    async wait() { return { ok: false, error: failure }; },
    async stopStream() {
      return {
        ok: false,
        error: revisionConflictError(),
        snapshot: snapshot(4),
      };
    },
  });
  const session = await value.agent.openKnown({ deviceRef: DEVICE });
  assert.deepEqual(await session.inspect({ streamId: STREAM_ID }), { ok: false, error: failure });
  assert.deepEqual(await session.wait({ streamId: STREAM_ID, afterRevision: 1, waitMs: 0 }), { ok: false, error: failure });
  assert.deepEqual(await session.stop({ streamId: STREAM_ID, expectedRevision: 3 }), {
    ok: false,
    error: revisionConflictError(),
    snapshot: snapshot(4),
  });
  await session.close();
});
await test("malformed, extra, prototype, accessor, and mismatched provider values use one fallback", async () => {
  const privateValues: readonly unknown[] = [
    { ok: true, value: { ...(observation() as { value: object }).value, credential: "secret" } },
    { ok: true, value: Object.assign(Object.create({ privatePath: "/tmp/private" }), (observation() as { value: object }).value) },
    { ok: true, value: { snapshot: snapshot(1, OTHER_DEVICE), changes: [], reset: false, timedOut: true } },
    { ok: true, value: { snapshot: snapshot(1), changes: [snapshot(1, OTHER_DEVICE)], reset: false, timedOut: false } },
  ];
  for (const output of privateValues) {
    const value = fixture({ async inspect() { return output as never; } });
    const session = await value.agent.openKnown({ deviceRef: DEVICE });
    const result = await session.inspect({ streamId: STREAM_ID });
    assert.deepEqual(result, EXPECTED_UNEXPECTED);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    assert.equal(JSON.stringify(result).includes("private"), false);
    await session.close();
    assert.equal(value.calls.closes, 1);
  }
  const accessor = fixture({
    async inspect() {
      const value = { ok: true } as { ok: true; value?: unknown };
      Object.defineProperty(value, "value", {
        enumerable: true,
        get() { throw new Error("credential=secret"); },
      });
      return value as never;
    },
  });
  const session = await accessor.agent.openKnown({ deviceRef: DEVICE });
  assert.deepEqual(await session.inspect({ streamId: STREAM_ID }), EXPECTED_UNEXPECTED);
  await session.close();
});

await test("unclassified acquire, provider, and cleanup exceptions map safely while close rejects once", async () => {
  const thrownAcquire = fixture();
  thrownAcquire.setAcquire(new Error("serial=private path=/Users/private"));
  const unexpected = await thrownAcquire.agent.ensure({ selector: { kind: "auto", platform: "android" } });
  assert.deepEqual(unexpected, EXPECTED_UNEXPECTED);
  assert.equal(Object.isFrozen(unexpected) && Object.isFrozen(unexpected.error) && Object.isFrozen(unexpected.error.controlVersion), true);
  const thrownProvider = fixture({
    async wait() { throw new Error("root credential secret"); },
  });
  const session = await thrownProvider.agent.openKnown({ deviceRef: DEVICE });
  assert.deepEqual(await session.wait({ streamId: STREAM_ID, afterRevision: 1, waitMs: 1 }), EXPECTED_UNEXPECTED);
  await session.close();
  const closeFailure = fixture();
  const rejecting = {
    attachment: ATTACHMENT,
    control: { async ensureViewer() { return ensured(); }, async inspect() { return observation(); } },
    async close() {
      closeFailure.calls.closes++;
      throw new Error("owner credential secret");
    },
  };
  closeFailure.setAcquire({ ok: true, session: rejecting });
  assert.deepEqual(await closeFailure.agent.ensure({ selector: { kind: "auto", platform: "android" } }), EXPECTED_UNEXPECTED);
  assert.equal(closeFailure.calls.closes, 1);
  closeFailure.setAcquire({ ok: true, session: rejecting });
  const active = await closeFailure.agent.openKnown({ deviceRef: DEVICE });
  assert.equal((await active.inspect({ streamId: STREAM_ID })).ok, true);
  const closed = await Promise.allSettled([active.close(), active.close()]);
  assert.deepEqual(closed.map((value) => value.status), ["rejected", "rejected"]);
  assert.equal(closeFailure.calls.closes, 2);
});

