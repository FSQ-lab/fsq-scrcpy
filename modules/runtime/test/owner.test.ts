import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import {
  CONTROL_VERSION,
  controlError,
  type ControlResult,
  type DeviceRef,
  type RuntimeTarget,
  type ShutdownRuntimeValue,
} from "../../contracts/src/index.js";
import { LocalRuntimeState, controlStateInternals, type AndroidRuntimeSlot, type LocalRuntimeStateStage, type RuntimeGenerationState, type RuntimeSlot } from "../src/control-state.js";
import {
  createRuntimeOwnerLocal,
  ownerTestInternals,
  validateLocalStateStatusResult,
  validateRebindDeviceResult,
  validateResetControlStateResult,
  type RuntimeOwnerLocal,
} from "../src/owner.js";
import * as runtimePublic from "../src/index.js";

const BINDING = Object.freeze({ serial: "PRIVATE-SERIAL", adbPath: "/usr/bin/true", cacheRoot: "/tmp/fsq-owner-private", artifactSource: Object.freeze({ mode: "online" as const }) });
const REBOUND = Object.freeze({ ...BINDING, serial: "REBOUND-PRIVATE-SERIAL" });
const NOW = 1_800_000_000_000;

interface Fixture {
  readonly parent: string;
  readonly root: string;
  readonly state: LocalRuntimeState;
  readonly slot?: AndroidRuntimeSlot;
  close(): Promise<void>;
}
async function fixture(initialized = true, stage?: (value: LocalRuntimeStateStage) => void | Promise<void>): Promise<Fixture> {
  const made = await mkdtemp(join(tmpdir(), "fsq-owner-")), parent = await realpath(made);
  await chmod(parent, 0o700);
  const root = join(parent, "state"), state = new LocalRuntimeState(root, stage ? { stage } : {});
  const slot = initialized ? (await state.initialize(BINDING, NOW)).slot : undefined;
  return Object.freeze({ parent, root, state, ...(slot ? { slot } : {}), close: () => rm(parent, { recursive: true, force: true }) });
}
function generation(slot: AndroidRuntimeSlot): RuntimeGenerationState {
  return Object.freeze({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, instanceId: randomUUID(), generation: randomUUID(), port: slot.control.port, createdAt: NOW + 1, ready: true });
}
function live(slot: RuntimeSlot, target: RuntimeTarget) {
  return Object.freeze({ ok: true as const, value: Object.freeze({ instance: Object.freeze({ controlVersion: CONTROL_VERSION, ...target, contractVersion: 2 as const, deviceRef: slot.deviceRef, features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const) }) }) });
}
function fakeOwner(target: RuntimeTarget, _slot: RuntimeSlot, calls: unknown[]) {
  let closed = false;
  return {
    async shutdownRuntime(input: RuntimeTarget): Promise<ControlResult<ShutdownRuntimeValue>> {
      calls.push(Object.freeze({ operation: "shutdown", input }));
      if (closed) return Object.freeze({ ok: false, error: controlError("runtime-exited") });
      return Object.freeze({ ok: true, value: Object.freeze({ instanceId: target.instanceId, generation: target.generation }) });
    },
    async close() { closed = true; calls.push("close"); },
    async [Symbol.asyncDispose]() { await this.close(); },
  };
}
function ownerFor(state: LocalRuntimeState, configured: {
  hello?: (slot: RuntimeSlot, expected: RuntimeTarget | null, signal?: AbortSignal) => Promise<ReturnType<typeof live> | Readonly<{ ok: false; error: ReturnType<typeof controlError> }>>;
  resolveBinding?: (signal?: AbortSignal) => Promise<AndroidRuntimeSlot["binding"]>;
  now?: () => number;
  uuid?: () => string;
  owner?: (slot: RuntimeSlot, target: RuntimeTarget) => ReturnType<typeof fakeOwner>;
} = {}): RuntimeOwnerLocal {
  return ownerTestInternals.create({
    state: () => state,
    hello: configured.hello ?? (async () => Object.freeze({ ok: false, error: controlError("instance-not-found") })),
    resolveBinding: configured.resolveBinding ?? (async () => BINDING),
    now: configured.now ?? (() => NOW + 10),
    uuid: configured.uuid ?? randomUUID,
    ...(configured.owner ? { owner: configured.owner } : {}),
  });
}

await test("owner-local is dedicated and ordinary Runtime exports no maintenance seam", async () => {
  assert.equal(Object.hasOwn(runtimePublic, "createRuntimeOwnerLocal"), false);
  const owner = createRuntimeOwnerLocal();
  try {
    assert.deepEqual(Object.keys(owner), []);
    assert.equal(JSON.stringify(owner), "{}");
    assert.deepEqual(inspect(owner), "{}");
    for (const method of ["inspectLocalState", "shutdownRuntime", "resetControlState", "rebindDevice", "close"]) assert.equal(typeof owner[method as keyof RuntimeOwnerLocal], "function");
  } finally { await owner.close(); }
});

await test("status on an absent root is frozen uninitialized and performs zero writes", async () => {
  const f = await fixture(false), owner = ownerFor(f.state);
  try {
    assert.deepEqual(await readdir(f.parent), []);
    const result = await owner.inspectLocalState({ platform: "android" });
    assert.deepEqual(result, { ok: true, value: { platform: "android", state: "uninitialized" } });
    assert.equal(Object.isFrozen(result), true);
    assert.ok(result.ok && Object.isFrozen(result.value));
    assert.deepEqual(await readdir(f.parent), []);
  } finally { await owner.close(); await f.close(); }
});

await test("status distinguishes refused and authenticated live authority without exposing private state", async () => {
  const f = await fixture(), slot = f.slot!, target = Object.freeze({ instanceId: randomUUID(), generation: randomUUID() });
  const absent = ownerFor(f.state), present = ownerFor(f.state, { hello: async (candidate, expected) => { assert.equal(candidate.revision, 1); assert.equal(expected, null); return live(candidate, target); } });
  try {
    const notRunning = await absent.inspectLocalState({ platform: "android" });
    assert.ok(notRunning.ok);
    if (notRunning.ok) assert.deepEqual(notRunning.value, { platform: "android", state: "ready", deviceRef: slot.deviceRef, stateRevision: 1, runtime: { state: "not-running" } });
    const running = await present.inspectLocalState({ platform: "android" });
    assert.ok(running.ok);
    if (running.ok && running.value.state === "ready") assert.deepEqual(running.value.runtime, { state: "live", target });
    for (const result of [notRunning, running]) {
      const rendered = `${JSON.stringify(result)}${inspect(result)}`;
      for (const secret of [BINDING.serial, BINDING.adbPath, BINDING.cacheRoot, String(slot.control.port), slot.control.credential]) assert.equal(rendered.includes(secret), false);
    }
  } finally { await absent.close(); await present.close(); await f.close(); }
});

await test("status is strictly read-only and does not sweep private candidate temps", async () => {
  const f = await fixture(), candidate = join(f.state.devices, `.android-only.${randomUUID()}.tmp`);
  await writeFile(candidate, "private-temp", { mode: 0o600 });
  const owner = ownerFor(f.state);
  try {
    const before = await readdir(f.state.devices), result = await owner.inspectLocalState({ platform: "android" }), after = await readdir(f.state.devices);
    assert.ok(result.ok);
    assert.deepEqual(after, before);
    assert.equal(await readFile(candidate, "utf8"), "private-temp");
  } finally { await owner.close(); await f.close(); }
});

await test("status fails closed for corrupt generation, wrong authority, timeout, and cancellation", async () => {
  const f = await fixture(), slot = f.slot!, path = f.state.generationPath(slot.deviceRef);
  try {
    await writeFile(path, "{}", { mode: 0o600 });
    let owner = ownerFor(f.state);
    let result = await owner.inspectLocalState({ platform: "android" });
    assert.equal(result.ok ? "" : result.error.code, "local-state-recovery-required");
    await owner.close();
    await rm(path);
    for (const code of ["instance-conflict", "control-version-mismatch", "deadline-exceeded", "runtime-exited"] as const) {
      owner = ownerFor(f.state, { hello: async () => Object.freeze({ ok: false, error: controlError(code) }) });
      result = await owner.inspectLocalState({ platform: "android" });
      assert.equal(result.ok ? "" : result.error.code, "local-state-recovery-required");
      await owner.close();
    }
    const controller = new AbortController(); controller.abort();
    owner = ownerFor(f.state);
    result = await owner.inspectLocalState({ platform: "android" }, { signal: controller.signal });
    assert.equal(result.ok ? "" : result.error.code, "request-cancelled");
    await owner.close();
  } finally { await f.close(); }
});

await test("shutdown revalidates full DeviceRef and binds the authenticated current target", async () => {
  const f = await fixture(), slot = f.slot!, target = Object.freeze({ instanceId: randomUUID(), generation: randomUUID() }), record = generation(slot), calls: unknown[] = [];
  await f.state.publishGeneration(Object.freeze({ ...record, instanceId: target.instanceId, generation: target.generation }));
  const owner = ownerFor(f.state, { hello: async (candidate, expected) => { assert.deepEqual(expected, target); return live(candidate, target); }, owner: (candidate, current) => fakeOwner(current, candidate, calls) });
  try {
    const shutdown = await owner.shutdownRuntime({ deviceRef: slot.deviceRef });
    assert.deepEqual(shutdown, { ok: true, value: target });
    assert.deepEqual(calls, [{ operation: "shutdown", input: target }, "close"]);
    const wrong = Object.freeze({ ...slot.deviceRef, opaqueId: randomUUID() });
    assert.equal((await owner.shutdownRuntime({ deviceRef: wrong })).ok, false);
  } finally { await owner.close(); await f.close(); }
});

await test("owner operations fence a slot replacement between hello and route dispatch", async () => {
  const f = await fixture(), slot = f.slot!, target = Object.freeze({ instanceId: randomUUID(), generation: randomUUID() }); let routes = 0, replaced = false;
  const owner = ownerFor(f.state, {
    hello: async (candidate) => {
      assert.equal(candidate.platform, "android");
      if (candidate.platform !== "android") throw new Error("unexpected platform");
      if (!replaced) { replaced = true; await f.state.replaceSlot(candidate, undefined, candidate.binding, candidate.deviceRef, candidate.createdAt + 1); }
      return live(candidate, target);
    },
    owner: (candidate, current) => { routes++; return fakeOwner(current, candidate, []); },
  });
  try {
    const result = await owner.shutdownRuntime({ deviceRef: slot.deviceRef });
    assert.equal(result.ok ? "" : result.error.code, "instance-conflict");
    assert.equal(routes, 0);
    assert.equal((await f.state.readSlot())!.revision, 2);
  } finally { await owner.close(); await f.close(); }
});

await test("shutdown never repairs or starts an absent Runtime", async () => {
  const f = await fixture(), owner = ownerFor(f.state);
  try {
    const shutdown = await owner.shutdownRuntime({ deviceRef: f.slot!.deviceRef });
    assert.equal(shutdown.ok ? "" : shutdown.error.code, "instance-not-found");
    assert.equal(await f.state.readGeneration(f.slot!), undefined);
  } finally { await owner.close(); await f.close(); }
});

await test("reset rotates authority, preserves identity, increments revision, and deletes exact generation", async () => {
  const f = await fixture(), slot = f.slot!, record = generation(slot); await f.state.publishGeneration(record);
  const owner = ownerFor(f.state);
  try {
    const result = await owner.resetControlState({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: 1 });
    assert.ok(result.ok);
    const next = (await f.state.readSlot())!;
    assert.ok(result.ok && result.value.stateRevision === 2);
    assert.deepEqual(next.deviceRef, slot.deviceRef);
    assert.equal(next.revision, 2);
    assert.equal(next.createdAt, slot.createdAt);
    assert.equal(next.updatedAt, NOW + 10);
    assert.notEqual(next.control.port, slot.control.port);
    assert.notEqual(next.control.credential, slot.control.credential);
    assert.equal(await f.state.readGeneration(next), undefined);
    assert.equal(await readFile(f.state.slotPath, "utf8"), controlStateInternals.canonicalSlot(next));
  } finally { await owner.close(); await f.close(); }
});

await test("rebind resolves first, creates a fresh DeviceRef, and atomically rotates all private state", async () => {
  const f = await fixture(), slot = f.slot!, nextId = randomUUID(); let resolves = 0;
  const owner = ownerFor(f.state, { resolveBinding: async () => { resolves++; return REBOUND; }, uuid: () => nextId });
  try {
    const result = await owner.rebindDevice({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: 1 });
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.value.previousDeviceRef, slot.deviceRef);
      assert.equal(result.value.deviceRef.opaqueId, nextId);
      assert.equal(result.value.previousStateRevision, 1);
      assert.equal(result.value.stateRevision, 2);
    }
    const next = (await f.state.readSlot())!;
    assert.equal(resolves, 1);
    assert.equal(next.binding.serial, REBOUND.serial);
    assert.notEqual(next.deviceRef.opaqueId, slot.deviceRef.opaqueId);
    assert.notEqual(next.control.port, slot.control.port);
    assert.notEqual(next.control.credential, slot.control.credential);
  } finally { await owner.close(); await f.close(); }
});

await test("rebind maps every fixed resolver failure without mutating the slot", async () => {
  const codes = ["dependency-unavailable", "adb-incompatible", "device-not-found", "device-ambiguous", "device-unavailable", "artifact-unavailable", "artifact-mismatch"] as const;
  for (const code of codes) {
    const f = await fixture(), original = await readFile(f.state.slotPath, "utf8");
    const owner = ownerFor(f.state, { resolveBinding: async () => { throw Object.freeze({ code }); } });
    try {
      const result = await owner.rebindDevice({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 });
      assert.equal(result.ok ? "" : result.error.code, code);
      assert.equal(await readFile(f.state.slotPath, "utf8"), original);
    } finally { await owner.close(); await f.close(); }
  }
});

await test("maintenance rejects live, missing, stale identity, stale revision, and overflow with zero mutation", async () => {
  const f = await fixture(), slot = f.slot!, target = Object.freeze({ instanceId: randomUUID(), generation: randomUUID() });
  const liveOwner = ownerFor(f.state, { hello: async (candidate) => live(candidate, target) }), absent = await fixture(false), absentOwner = ownerFor(absent.state);
  try {
    let result = await liveOwner.resetControlState({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: 1 });
    assert.equal(result.ok ? "" : result.error.code, "runtime-live");
    result = await liveOwner.resetControlState({ platform: "android", expectedDeviceRef: Object.freeze({ ...slot.deviceRef, opaqueId: randomUUID() }), expectedStateRevision: 1 });
    assert.equal(result.ok ? "" : result.error.code, "instance-conflict");
    result = await liveOwner.resetControlState({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: 2 });
    assert.equal(result.ok ? "" : result.error.code, "instance-conflict");
    result = await absentOwner.resetControlState({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: 1 });
    assert.equal(result.ok ? "" : result.error.code, "instance-not-found");
    assert.equal((await f.state.readSlot())!.revision, 1);
    const max = Object.freeze({ ...slot, revision: Number.MAX_SAFE_INTEGER, updatedAt: slot.updatedAt });
    await writeFile(f.state.slotPath, controlStateInternals.canonicalSlot(max));
    const maxOwner = ownerFor(f.state);
    try {
      const maxResult = await maxOwner.resetControlState({ platform: "android", expectedDeviceRef: slot.deviceRef, expectedStateRevision: Number.MAX_SAFE_INTEGER });
      assert.equal(maxResult.ok ? "" : maxResult.error.code, "local-state-recovery-required");
    } finally { await maxOwner.close(); }
  } finally { await liveOwner.close(); await absentOwner.close(); await f.close(); await absent.close(); }
});

await test("replacement cancellation before rename keeps old authority while cancellation after rename returns success", async () => {
  for (const point of ["replacement-cas", "replacement-rename"] as const) {
    const controller = new AbortController(); let once = true;
    const f = await fixture(true, (stage) => { if (once && stage === point) { once = false; controller.abort(); } });
    const owner = ownerFor(f.state);
    try {
      const result = await owner.resetControlState({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 }, { signal: controller.signal });
      const current = (await f.state.readSlot())!;
      if (point === "replacement-cas") { assert.equal(result.ok ? "" : result.error.code, "request-cancelled"); assert.equal(current.revision, 1); }
      else { assert.ok(result.ok); assert.equal(current.revision, 2); }
      assert.deepEqual((await readdir(f.state.devices)).filter((name) => name.endsWith(".tmp")), []);
    } finally { await owner.close(); await f.close(); }
  }
});

await test("reset/reset and reset/rebind races admit one CAS winner and never split authority", async () => {
  for (const second of ["reset", "rebind"] as const) {
    let release!: () => void, entered!: () => void, first = true;
    const gate = new Promise<void>((resolve) => { release = resolve; }), atCas = new Promise<void>((resolve) => { entered = resolve; });
    const f = await fixture(true, async (stage) => { if (stage === "replacement-cas" && first) { first = false; entered(); await gate; } });
    const one = ownerFor(f.state), two = ownerFor(f.state, { resolveBinding: async () => REBOUND });
    try {
      const firstResult = one.resetControlState({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 });
      await atCas;
      const secondResult = second === "reset"
        ? two.resetControlState({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 })
        : two.rebindDevice({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 });
      release();
      const results = await Promise.all([firstResult, secondResult]);
      assert.equal(results.filter((value) => value.ok).length, 1);
      assert.equal((await f.state.readSlot())!.revision, 2);
      assert.deepEqual((await readdir(f.state.devices)).filter((name) => name.endsWith(".tmp")), []);
    } finally { release(); await one.close(); await two.close(); await f.close(); }
  }
});

await test("owner-local validators reject extras and freeze exact safe DTOs", () => {
  const deviceRef: DeviceRef = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: randomUUID() });
  const status = validateLocalStateStatusResult({ ok: true, value: { platform: "android", state: "ready", deviceRef, stateRevision: 1, runtime: { state: "not-running" } } });
  assert.ok(status.ok && Object.isFrozen(status.value) && status.value.state === "ready" && Object.isFrozen(status.value.deviceRef));
  assert.throws(() => validateLocalStateStatusResult({ ok: true, value: { platform: "android", state: "uninitialized", extra: true } }));
  assert.throws(() => validateLocalStateStatusResult({ ok: false, error: { ...ownerTestInternals.runtimeLiveError, extra: true } }));
  assert.throws(() => validateResetControlStateResult({ ok: true, value: { platform: "android", deviceRef, previousStateRevision: 1, stateRevision: 3 } }));
  assert.throws(() => validateRebindDeviceResult({ ok: true, value: { platform: "android", previousDeviceRef: deviceRef, deviceRef, previousStateRevision: 1, stateRevision: 2 } }));
  const failed = validateResetControlStateResult({ ok: false, error: controlError("instance-conflict") });
  assert.equal(failed.ok ? "" : failed.error.code, "instance-conflict");
});

await test("owner-local validates and reports iOS state without provider details", async () => {
  const made = await mkdtemp(join(tmpdir(), "fsq-owner-ios-")), parent = await realpath(made); await chmod(parent, 0o700);
  const state = new LocalRuntimeState(join(parent, "state"), {}, "ios"), slot = (await state.initialize(undefined, NOW)).slot;
  const owner = ownerTestInternals.create({ state: () => state as LocalRuntimeState<"android" | "ios"> });
  try {
    const status = await owner.inspectLocalState({ platform: "ios" });
    assert.deepEqual(status, { ok: true, value: { platform: "ios", state: "ready", deviceRef: slot.deviceRef, stateRevision: 1, runtime: { state: "not-running" } } });
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes("endpoint"), false);
    assert.equal(serialized.includes("provider"), false);
    assert.throws(() => validateLocalStateStatusResult({ ok: true, value: { platform: "ios", state: "ready", deviceRef: { ...slot.deviceRef, platform: "android" }, stateRevision: 1, runtime: { state: "not-running" } } }));
  } finally { await owner.close(); await rm(parent, { recursive: true, force: true }); }
});

await test("invalid local shapes fail before state, resolver, or owner I/O", async () => {
  const f = await fixture(); let io = 0;
  const owner = ownerTestInternals.create({
    state: () => { io++; return f.state; },
    resolveBinding: async () => { io++; return BINDING; },
  });
  try {
    for (const result of [
      await owner.inspectLocalState({ platform: "windows" } as never),
      await owner.resetControlState({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 0 }),
      await owner.rebindDevice({ platform: "android", expectedDeviceRef: f.slot!.deviceRef, expectedStateRevision: 1 }, { signal: {} as AbortSignal }),
    ]) assert.equal(result.ok ? "" : result.error.code, "malformed-control");
    assert.equal(io, 0);
  } finally { await owner.close(); await f.close(); }
});
