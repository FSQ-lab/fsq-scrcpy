import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  CONTROL_VERSION,
  controlError,
  revisionConflictError,
  type ControlError,
  type DeviceRef,
  type RuntimeAttachment,
  type RuntimeControl,
  type RuntimeControlSession,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import type { RuntimeOwnerLocal } from "../../runtime/src/owner.js";
import { executeCli, type CliIo, type CliRuntimeDependencies } from "../src/cli.js";

const ID = "123e4567-e89b-42d3-a456-426614174000";
const STREAM = "223e4567-e89b-42d3-a456-426614174000";
const INSTANCE = "323e4567-e89b-42d3-a456-426614174000";
const GENERATION = "423e4567-e89b-42d3-a456-426614174000";
const NEXT = "523e4567-e89b-42d3-a456-426614174000";
const DEVICE: DeviceRef = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: ID });
const NEXT_DEVICE: DeviceRef = Object.freeze({ ...DEVICE, opaqueId: NEXT });
const SNAPSHOT: StreamSnapshot = Object.freeze({ streamId: STREAM, deviceRef: DEVICE, revision: 1, phase: "demand-pending", activeViewerCount: 0, updatedAt: 1 });
const ATTACHMENT: RuntimeAttachment = Object.freeze({ disposition: "attached", instance: Object.freeze({ controlVersion: CONTROL_VERSION, instanceId: INSTANCE, generation: GENERATION, contractVersion: 2, deviceRef: DEVICE, features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const) }) });
const STATUS = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "android" as const, state: "ready" as const, deviceRef: DEVICE, stateRevision: 7, runtime: Object.freeze({ state: "not-running" as const }) }) });
const LIVE_STATUS = Object.freeze({ ok: true as const, value: Object.freeze({ ...STATUS.value, runtime: Object.freeze({ state: "live" as const, target: Object.freeze({ instanceId: INSTANCE, generation: GENERATION }) }) }) });
const UNINITIALIZED = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "android" as const, state: "uninitialized" as const }) });
const IOS_ID = "623e4567-e89b-42d3-a456-426614174000";
const IOS_DEVICE: DeviceRef = Object.freeze({ contractVersion: 2, platform: "ios", namespace: "fsq.ios.local", opaqueId: IOS_ID });
const IOS_SNAPSHOT: StreamSnapshot = Object.freeze({ streamId: STREAM, deviceRef: IOS_DEVICE, revision: 1, phase: "demand-pending", activeViewerCount: 0, updatedAt: 1 });
const IOS_ATTACHMENT: RuntimeAttachment = Object.freeze({ disposition: "started", instance: Object.freeze({ controlVersion: CONTROL_VERSION, instanceId: INSTANCE, generation: GENERATION, contractVersion: 2, deviceRef: IOS_DEVICE, features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const) }) });
const IOS_STATUS = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "ios" as const, state: "ready" as const, deviceRef: IOS_DEVICE, stateRevision: 1, runtime: Object.freeze({ state: "not-running" as const }) }) });
const IOS_UNINITIALIZED = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "ios" as const, state: "uninitialized" as const }) });
const DESCRIPTOR = Object.freeze({ contractVersion: 2 as const, streamId: STREAM, standaloneUri: `http://127.0.0.1:49152/viewer/${STREAM}`, presentationModes: Object.freeze(["standalone"] as const), expiresAt: 60 });
const snapshot = (revision: number, phase: StreamSnapshot["phase"] = "demand-pending"): StreamSnapshot => Object.freeze({ ...SNAPSHOT, revision, phase, updatedAt: revision, ...(phase === "stopped" ? { reason: "explicit-stop" as const } : {}) });
const observed = (value: StreamSnapshot, options: { timedOut?: boolean; reset?: boolean } = {}): unknown => ({ ok: true, value: { snapshot: value, changes: options.timedOut || options.reset ? [] : [value], reset: options.reset ?? false, timedOut: options.timedOut ?? false } });

type Calls = { acquire: unknown[]; owner: string[]; control: string[]; closed: string[]; prompts: string[]; aborts: number };
interface Fixture { runtime: CliRuntimeDependencies; calls: Calls; setStatus(value: unknown): void; setIosStatus(value: unknown): void; setAcquire(value: unknown): void; setControl(name: "ensure" | "inspect" | "wait" | "stop", value: unknown): void; setOwner(name: "shutdown" | "reset" | "rebind", value: unknown): void; throwAcquire(cause: unknown): void }
function fixture(): Fixture {
  const calls: Calls = { acquire: [], owner: [], control: [], closed: [], prompts: [], aborts: 0 };
  let status: unknown = STATUS, iosStatus: unknown = IOS_UNINITIALIZED, acquireCause: unknown, acquireValue: unknown;
  const values: Record<string, unknown> = {
    ensure: { ok: true, value: { deviceRef: DEVICE, descriptor: DESCRIPTOR, snapshot: SNAPSHOT } },
    inspect: { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false } },
    wait: { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: true } },
    stop: { ok: true, value: { snapshot: SNAPSHOT } },
    shutdown: { ok: true, value: { instanceId: INSTANCE, generation: GENERATION } },
    reset: { ok: true, value: { platform: "android", deviceRef: DEVICE, previousStateRevision: 7, stateRevision: 8 } },
    rebind: { ok: true, value: { platform: "android", previousDeviceRef: DEVICE, deviceRef: NEXT_DEVICE, previousStateRevision: 7, stateRevision: 8 } },
  };
  const take = (name: string): unknown => Array.isArray(values[name]) ? (values[name] as unknown[]).shift() : values[name];
  const control: RuntimeControl = {
    async ensureViewer(options) { calls.control.push(`ensure:${Boolean(options?.signal)}`); return take("ensure") as never; },
    async inspect(input, options) { calls.control.push(`inspect:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return take("inspect") as never; },
    async wait(input, options) { calls.control.push(`wait:${JSON.stringify(input)}:${Boolean(options?.signal)}:${Boolean(options?.signal?.aborted)}`); if (options?.signal?.aborted) calls.aborts++; else options?.signal?.addEventListener("abort", () => { calls.aborts++; }, { once: true }); return take("wait") as never; },
    async stopStream(input, options) { calls.control.push(`stop:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return take("stop") as never; },
    async close() { calls.closed.push("control"); },
  };
  const session = { attachment: ATTACHMENT, control, async close() { calls.closed.push("session"); } } as unknown as RuntimeControlSession;
  acquireValue = { ok: true, session };
  const owner: RuntimeOwnerLocal = {
    async inspectLocalState(input, options) { calls.owner.push(`status:${input.platform}:${Boolean(options?.signal)}`); return (input.platform === "ios" ? iosStatus : status) as never; },
    async shutdownRuntime(input, options) { calls.owner.push(`shutdown:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.shutdown as never; },
    async resetControlState(input, options) { calls.owner.push(`reset:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.reset as never; },
    async rebindDevice(input, options) { calls.owner.push(`rebind:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.rebind as never; },
    async close() { calls.closed.push("owner"); },
    async [Symbol.asyncDispose]() { await this.close(); },
  };
  let runtime: CliRuntimeDependencies = {
    acquireRuntime: (async (request, options) => { calls.acquire.push({ request, signal: Boolean(options?.signal) }); if (acquireCause) throw acquireCause; return acquireValue as never; }) as CliRuntimeDependencies["acquireRuntime"],
    createRuntimeOwnerLocal: () => owner,
  };
  return {
    get runtime() { return runtime; }, calls,
    setStatus(value) { status = value; },
    setIosStatus(value) { iosStatus = value; },
    setAcquire(value) { acquireValue = value; },
    setControl(name, value) { values[name] = value; },
    setOwner(name, value) { values[name] = value; },
    throwAcquire(cause) { acquireCause = cause; runtime = { ...runtime }; },
  };
}
interface Invocation { code: number; stdout: string; stderr: string; value: Record<string, unknown>; records: readonly Record<string, unknown>[]; calls: Calls; outputListeners: number }
async function invoke(args: readonly string[], options: { tty?: boolean; answers?: readonly (string | undefined)[]; fixture?: Fixture; signal?: AbortSignal; onWrite?(count: number): void; outputFailure?: "EPIPE" | "EIO" | "close" } = {}): Promise<Invocation> {
  const value = options.fixture ?? fixture(), output: string[] = [], errors: string[] = [], answers = [...(options.answers ?? [])], events = new EventEmitter();
  const io: CliIo = {
    stdin: { isTTY: options.tty ?? false },
    stdout: Object.assign(events, { write(chunk: string | Uint8Array, callback?: (error?: Error | null) => void) {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
      if (options.outputFailure === "close") events.emit("close");
      else callback?.(options.outputFailure ? Object.assign(new Error("private output cause"), { code: options.outputFailure }) : undefined);
      options.onWrite?.(output.length);
      return true;
    } }),
    stderr: { isTTY: options.tty ?? false, write(chunk) { errors.push(chunk); } },
    async question(prompt) { value.calls.prompts.push(prompt); errors.push(prompt); return answers.shift(); },
  };
  const code = await executeCli(args, io, value.runtime, options.signal), stdout = output.join("");
  assert.equal(output.length > 0, true);
  const records = stdout.startsWith("\u001e") ? stdout.split("\u001e").slice(1).map((record) => JSON.parse(record.slice(0, -1)) as Record<string, unknown>) : [JSON.parse(stdout) as Record<string, unknown>];
  return { code, stdout, stderr: errors.join(""), value: records[0]!, records, calls: value.calls, outputListeners: events.listenerCount("error") + events.listenerCount("close") + events.listenerCount("drain") };
}

await test("rejects every malformed grammar before product I/O with deterministic render mode", async () => {
  const invalid = [
    [], ["viewer"], ["viewer", "unknown"], ["--json", "viewer", "ensure"],
    ["viewer", "ensure", "--platform", "windows"],
    ["viewer", "ensure", "--platform", "android", "--device-ref", ID],
    ["viewer", "ensure", "--platform", "android", "--platform", "android"],
    ["viewer", "ensure", "--platform", "android", "extra"],
    ["viewer", "ensure", "--platform", "android", "--"],
    ["viewer", "ensure", "--platform", "android", "--json", "--json"],
    ["stream", "inspect", "--stream-id", "not-a-uuid"],
    ["stream", "inspect", "--stream-id", STREAM, "--after-revision", "0"],
    ["stream", "inspect", "--stream-id", STREAM, "--after-revision", "01"],
    ["stream", "inspect", "--stream-id", STREAM, "--after-revision", "9007199254740992"],
    ["stream", "stop", "--stream-id", STREAM, "--expected-revision", "-1"],
    ["viewer", "approve", "--stream-id", STREAM, "--code", "01234567"],
    ["runtime", "shutdown", "--device-ref", ID.toUpperCase()],
    ["local-state", "status", "--platform", "windows"],
    ["local-state", "reset-control", "--platform", "android"],
    ["local-state", "rebind-device", "--platform", "android", "--device-ref", ID, "--force"],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1"],
    ["stream", "watch", "--stream-id", STREAM],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--wait-ms", "30001", "--json"],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--wait-ms", "01", "--json"],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json", "--json-seq"],
    ["stream", "watch", "--stream-id", STREAM, "--json"],
    ["stream", "watch", "--stream-id", STREAM, "--wait-ms", "1", "--json-seq"],
    ["stream", "watch", "--stream-id", STREAM, "--json-seq", "--json-seq"],
  ];
  for (const args of invalid) {
    const value = fixture(), result = await invoke(args, { fixture: value });
    assert.equal(result.code, 2, args.join(" "));
    assert.deepEqual(result.value, { ok: false, error: { code: "invalid-cli-syntax", disposition: "usage", operationState: "not-applied", safeMessage: "Invalid command syntax." } });
    assert.equal(result.stderr, "");
    assert.deepEqual(value.calls, { acquire: [], owner: [], control: [], closed: [], prompts: [], aborts: 0 });
  }
  const compact = await invoke(["nonsense", "command", "--json"]);
  assert.equal(compact.stdout.includes("\n  \""), false);
  const malformedEquals = await invoke(["nonsense", "command", "--json=true"]);
  assert.equal(malformedEquals.stdout.includes("\n  \""), true);
  const sequenced = await invoke(["nonsense", "command", "--json", "--json-seq"]);
  assert.equal(sequenced.stdout.startsWith("\u001e{"), true); assert.equal(sequenced.stdout.endsWith("}\n"), true); assert.equal(sequenced.stdout.includes("\n  \""), false);
});

await test("maps auto and known ensure to the only allowed selectors and safe combined result", async () => {
  const auto = await invoke(["viewer", "ensure", "--platform=android"]);
  assert.equal(auto.code, 0); assert.equal(auto.stderr, "");
  assert.deepEqual(auto.calls.owner, []);
  assert.deepEqual(auto.calls.acquire[0], { request: { mode: "start-or-attach", selector: { kind: "auto", platform: "android" } }, signal: false });
  assert.deepEqual((auto.value.value as Record<string, unknown>).attachment, ATTACHMENT);
  assert.deepEqual((((auto.value.value as Record<string, unknown>).attachment as RuntimeAttachment).instance.features), ["wait-v1", "auto-bootstrap-v1"]);
  const known = await invoke(["viewer", "ensure", "--device-ref", ID, "--json"]);
  assert.equal(known.stdout.includes("\n  \""), false);
  assert.deepEqual(known.value, auto.value);
  assert.deepEqual(known.calls.owner, ["status:android:false", "status:ios:false"]);
  assert.deepEqual(known.calls.acquire[0], { request: { mode: "start-or-attach", selector: { kind: "known", deviceRef: DEVICE } }, signal: false });
  assert.deepEqual(known.calls.closed.sort(), ["owner", "session"]);
});

await test("maps iOS auto ensure and status without exposing provider internals", async () => {
  const value = fixture();
  const control: RuntimeControl = {
    async ensureViewer() { return { ok: true, value: { deviceRef: IOS_DEVICE, descriptor: DESCRIPTOR, snapshot: IOS_SNAPSHOT } }; },
    async inspect() { return { ok: false, error: controlError("instance-not-found") }; },
    async wait() { return { ok: false, error: controlError("instance-not-found") }; },
    async stopStream() { return { ok: false, error: controlError("instance-not-found") }; },
    async close() { value.calls.closed.push("ios-control"); },
  };
  value.setAcquire({ ok: true, session: { attachment: IOS_ATTACHMENT, control, async close() { value.calls.closed.push("ios-session"); } } as unknown as RuntimeControlSession });
  const ensured = await invoke(["viewer", "ensure", "--platform", "ios", "--json"], { fixture: value });
  assert.equal(ensured.code, 0);
  assert.deepEqual(ensured.calls.acquire[0], { request: { mode: "start-or-attach", selector: { kind: "auto", platform: "ios" } }, signal: false });
  assert.equal(JSON.stringify(ensured.value).includes("endpoint"), false);
  assert.equal(JSON.stringify(ensured.value).includes("provider"), false);
  const statusFixture = fixture(); statusFixture.setIosStatus(IOS_STATUS);
  const status = await invoke(["local-state", "status", "--platform=ios", "--json"], { fixture: statusFixture });
  assert.deepEqual(status.value, IOS_STATUS);
  assert.deepEqual(status.calls.owner, ["status:ios:false"]);
});


await test("maps inspect and stop through status plus attach-only without spawning", async () => {
  const controller = new AbortController();
  const inspect = await invoke(["stream", "inspect", "--stream-id", STREAM, "--after-revision=9"], { signal: controller.signal });
  assert.deepEqual(inspect.calls.acquire[0], { request: { mode: "attach-only", selector: { kind: "known", deviceRef: DEVICE } }, signal: true });
  assert.equal(inspect.calls.control[0], `inspect:${JSON.stringify({ streamId: STREAM, afterRevision: 9 })}:true`);
  assert.deepEqual(inspect.value.value, { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false });
  const compact = await invoke(["stream", "inspect", "--stream-id", STREAM, "--after-revision=9", "--json"], { signal: controller.signal });
  assert.deepEqual(compact.value, inspect.value); assert.equal(compact.stdout.includes("\n  \""), false);
  const stop = await invoke(["stream", "stop", "--stream-id", STREAM, "--expected-revision", "8"]);
  assert.equal(stop.calls.control[0], `stop:${JSON.stringify({ streamId: STREAM, expectedRevision: 8 })}:false`);
  assert.deepEqual(stop.calls.owner, ["status:android:false", "status:ios:false"]);
});


await test("one-shot wait applies exact defaults, bounds, attach-only ownership, and one provider call", async () => {
  const value = fixture(), result = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "9", "--json"], { fixture: value });
  assert.equal(result.code, 0); assert.equal(result.stdout.startsWith("{"), true); assert.equal(result.stdout.endsWith("\n"), true);
  assert.deepEqual(result.calls.owner, ["status:android:true", "status:ios:true"]);
  assert.deepEqual(result.calls.acquire, [{ request: { mode: "attach-only", selector: { kind: "known", deviceRef: DEVICE } }, signal: true }]);
  assert.deepEqual(result.calls.control, [`wait:${JSON.stringify({ streamId: STREAM, afterRevision: 9, waitMs: 30_000 })}:true:false`]);
  assert.deepEqual(result.calls.closed, ["owner", "session"]);
  const zero = fixture(); await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision=1", "--wait-ms=0", "--json"], { fixture: zero });
  assert.equal(zero.calls.control[0], `wait:${JSON.stringify({ streamId: STREAM, afterRevision: 1, waitMs: 0 })}:true:false`);
});

await test("malformed recognizable acquire success closes raw sessions without accessor, prototype, or private leakage", async () => {
  const value = fixture(); let rawCloses = 0;
  value.setAcquire({ ok: true, session: { attachment: { ...ATTACHMENT, privateAuthority: "OWNER-PRIVATE" }, control: {}, async close() { rawCloses++; } } });
  const malformed = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json"], { fixture: value });
  assert.equal(malformed.code, 5); assert.equal((malformed.value.error as Record<string, unknown>).code, "runtime-exited");
  assert.equal(rawCloses, 1); assert.deepEqual(malformed.calls.closed, ["owner"]); assert.equal(`${malformed.stdout}${malformed.stderr}`.includes("OWNER-PRIVATE"), false);

  const outerExtra = fixture(); let outerCloses = 0;
  outerExtra.setAcquire({ ok: true, session: { attachment: ATTACHMENT, control: {}, async close() { outerCloses++; } }, privateAuthority: "OUTER-PRIVATE" });
  const outerRejected = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json"], { fixture: outerExtra });
  assert.equal(outerRejected.code, 5); assert.equal(outerCloses, 1); assert.deepEqual(outerRejected.calls.closed, ["owner"]); assert.equal(`${outerRejected.stdout}${outerRejected.stderr}`.includes("OUTER-PRIVATE"), false);

  let getterTouches = 0, inheritedCloses = 0;
  const accessor = Object.create({ async close() { inheritedCloses++; } }) as Record<string, unknown>;
  Object.defineProperty(accessor, "attachment", { enumerable: true, get() { getterTouches++; return ATTACHMENT; } });
  Object.defineProperty(accessor, "control", { enumerable: true, value: {} });
  const hostile = fixture(); hostile.setAcquire({ ok: true, session: accessor });
  const rejected = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json"], { fixture: hostile });
  assert.equal(rejected.code, 5); assert.equal(getterTouches, 0); assert.equal(inheritedCloses, 0); assert.deepEqual(rejected.calls.closed, ["owner"]);

  let outerOkTouches = 0, hiddenCloses = 0;
  const outerAccessor = { session: { attachment: ATTACHMENT, control: {}, async close() { hiddenCloses++; } } } as Record<string, unknown>;
  Object.defineProperty(outerAccessor, "ok", { enumerable: true, get() { outerOkTouches++; return true; } });
  const hostileOuter = fixture(); hostileOuter.setAcquire(outerAccessor);
  const outerAccessorRejected = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json"], { fixture: hostileOuter });
  assert.equal(outerAccessorRejected.code, 5); assert.equal(outerOkTouches, 0); assert.equal(hiddenCloses, 0); assert.deepEqual(outerAccessorRejected.calls.closed, ["owner"]);
});

await test("watch emits exact records and advances its local cursor only after accepted writes", async () => {
  const value = fixture(), stopping = snapshot(2, "stopping"), stopped = snapshot(3, "stopped");
  value.setControl("wait", [observed(SNAPSHOT, { timedOut: true }), observed(stopping), observed(stopped)]);
  const result = await invoke(["stream", "watch", "--stream-id", STREAM, "--json-seq"], { fixture: value });
  assert.equal(result.code, 0); assert.equal(result.records.length, 4); assert.equal(result.stdout.match(/\u001e/g)?.length, 4);
  assert.deepEqual(result.records.map((record) => ((record.value as { snapshot: StreamSnapshot }).snapshot.revision)), [1, 1, 2, 3]);
  assert.deepEqual(result.calls.control, [
    `inspect:${JSON.stringify({ streamId: STREAM })}:true`,
    `wait:${JSON.stringify({ streamId: STREAM, afterRevision: 1, waitMs: 30_000 })}:true:false`,
    `wait:${JSON.stringify({ streamId: STREAM, afterRevision: 1, waitMs: 30_000 })}:true:false`,
    `wait:${JSON.stringify({ streamId: STREAM, afterRevision: 2, waitMs: 30_000 })}:true:false`,
  ]);
  assert.equal(result.calls.control.some((call) => /ensure|stop/.test(call)), false); assert.deepEqual(result.calls.closed, ["owner", "session"]);
  const resumed = fixture(); resumed.setControl("wait", observed(snapshot(8, "stopped")));
  const cursor = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "7", "--json-seq"], { fixture: resumed });
  assert.equal(cursor.records.length, 1); assert.equal(cursor.calls.control.some((call) => call.startsWith("inspect:")), false);
  assert.equal(cursor.calls.control[0], `wait:${JSON.stringify({ streamId: STREAM, afterRevision: 7, waitMs: 30_000 })}:true:false`);
});

await test("first signal preserves an accepted record then obtains one exact cancellation record", async () => {
  const controller = new AbortController(), value = fixture();
  value.setControl("wait", [observed(snapshot(2)), { ok: false, error: controlError("request-cancelled") }]);
  const result = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"], { fixture: value, signal: controller.signal, onWrite(count) { if (count === 1) controller.abort(); } });
  assert.equal(result.code, 3); assert.equal(result.records.length, 2);
  assert.equal((result.records[1]!.error as Record<string, unknown>).code, "request-cancelled");
  assert.equal(result.calls.control[1]!.endsWith(":true:true"), true); assert.deepEqual(result.calls.closed, ["owner", "session"]);
});

await test("watch validates provider identity and extra private fields before RFC output", async () => {
  for (const malformed of [
    { ok: true, value: { snapshot: { ...SNAPSHOT, deviceRef: NEXT_DEVICE }, changes: [], reset: false, timedOut: false } },
    { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false, serial: "SERIAL-PRIVATE" } },
  ]) {
    const value = fixture(); value.setControl("wait", malformed);
    const result = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"], { fixture: value });
    assert.equal(result.code, 5); assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
    assert.equal(result.stdout.includes("SERIAL-PRIVATE"), false); assert.equal(result.stderr, ""); assert.deepEqual(result.calls.closed, ["owner", "session"]);
  }
});

await test("accepted terminal success and each provider failure win a simultaneous first signal", async () => {
  const cases: readonly [unknown, number, string | undefined][] = [
    [observed(snapshot(2, "stopped")), 0, undefined],
    [{ ok: false, error: controlError("instance-not-found") }, 3, "instance-not-found"],
    [{ ok: false, error: controlError("instance-conflict") }, 4, "instance-conflict"],
    [{ ok: false, error: controlError("runtime-exited") }, 5, "runtime-exited"],
  ];
  for (const [providerResult, exit, errorCode] of cases) {
    const controller = new AbortController(), value = fixture(); value.setControl("wait", providerResult);
    const result = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"], { fixture: value, signal: controller.signal, onWrite() { controller.abort(); } });
    assert.equal(result.code, exit); assert.equal(result.records.length, 1); assert.equal(result.calls.control.filter((call) => call.startsWith("wait:")).length, 1);
    if (errorCode) assert.equal((result.value.error as Record<string, unknown>).code, errorCode); else assert.equal(((result.value.value as { snapshot: StreamSnapshot }).snapshot.phase), "stopped");
    assert.equal(result.calls.aborts, 1); assert.deepEqual(result.calls.closed, ["owner", "session"]); assert.equal(result.outputListeners, 0);
  }
});

await test("output cause wins EPIPE, close, and EIO against first signal in both orderings", async () => {
  for (const outputFailure of ["EPIPE", "close", "EIO"] as const) for (const order of ["signal-first", "output-first"] as const) {
    const controller = new AbortController(), value = fixture(); value.setControl("wait", observed(snapshot(2, "stopped")));
    if (order === "signal-first") controller.abort();
    const result = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"], {
      fixture: value, signal: controller.signal, outputFailure,
      ...(order === "output-first" ? { onWrite() { controller.abort(); } } : {}),
    });
    assert.equal(result.code, outputFailure === "EIO" ? 5 : 3, `${outputFailure}:${order}`);
    assert.equal(result.records.length, 1); assert.equal(result.calls.control.filter((call) => call.startsWith("wait:")).length, 1);
    assert.equal(result.calls.aborts, 1); assert.deepEqual(result.calls.closed, ["owner", "session"]); assert.equal(result.outputListeners, 0);
    assert.equal(result.stdout.includes("request-cancelled"), false); assert.equal(result.stderr, "");
  }
});

await test("observation output failures never retry or leak their raw cause", async () => {
  for (const [outputFailure, expected] of [["EPIPE", 3], ["close", 3], ["EIO", 5]] as const) {
    const value = fixture();
    const result = await invoke(["stream", "wait", "--stream-id", STREAM, "--after-revision", "1", "--json"], { fixture: value, outputFailure });
    assert.equal(result.code, expected, outputFailure);
    assert.equal(result.stdout.includes("private output cause"), false);
    assert.equal(result.stderr, "");
    assert.equal(result.calls.control.filter((call) => call.startsWith("wait:")).length, 1);
    assert.deepEqual(result.calls.closed, ["owner", "session"]);
  }
});

await test("failed records do not advance or issue a second provider wait", async () => {
  const watch = fixture();
  watch.setControl("wait", [observed(snapshot(2)), observed(snapshot(3, "stopped"))]);
  const failedRecord = await invoke(["stream", "watch", "--stream-id", STREAM, "--after-revision", "1", "--json-seq"], { fixture: watch, outputFailure: "EPIPE" });
  assert.equal(failedRecord.code, 3);
  assert.equal(failedRecord.calls.control.filter((call) => call.startsWith("wait:")).length, 1);
  assert.deepEqual(failedRecord.calls.closed, ["owner", "session"]);
});
await test("removed approve is invalid before owner creation while shutdown remains owner-only", async () => {
  const approve = await invoke(["viewer", "approve", "--stream-id", STREAM, "--code", "01234567"]);
  assert.equal(approve.code, 2);
  assert.deepEqual(approve.calls, { acquire: [], owner: [], control: [], closed: [], prompts: [], aborts: 0 });
  const shutdown = await invoke(["runtime", "shutdown", "--device-ref", ID]);
  assert.deepEqual(shutdown.calls.acquire, []);
  assert.equal(shutdown.calls.owner[2], `shutdown:${JSON.stringify({ deviceRef: DEVICE })}:false`);
});

await test("status is read-only and stored identity lookup maps absent and mismatched values", async () => {
  const status = await invoke(["local-state", "status", "--platform", "android"]);
  assert.deepEqual(status.value, STATUS); assert.deepEqual(status.calls.acquire, []);
  const absentFixture = fixture(); absentFixture.setStatus(UNINITIALIZED);
  const absent = await invoke(["stream", "inspect", "--stream-id", STREAM], { fixture: absentFixture });
  assert.equal(absent.code, 3); assert.equal(((absent.value.error as Record<string, unknown>).code), "instance-not-found"); assert.deepEqual(absent.calls.acquire, []);
  const conflict = await invoke(["runtime", "shutdown", "--device-ref", NEXT]);
  assert.equal(conflict.code, 4); assert.equal(((conflict.value.error as Record<string, unknown>).code), "instance-conflict"); assert.equal(conflict.calls.owner.length, 2);
});

await test("maps recoverable, terminal, unknown, revision conflict and success exit statuses", async () => {
  const cases: readonly [ControlError["code"], number][] = [["instance-not-found", 3], ["instance-conflict", 4], ["deadline-exceeded", 5]];
  for (const [code, exit] of cases) {
    const value = fixture(); value.setControl("inspect", { ok: false, error: controlError(code) });
    assert.equal((await invoke(["stream", "inspect", "--stream-id", STREAM], { fixture: value })).code, exit);
  }
  const revision = fixture(); revision.setControl("stop", { ok: false, error: revisionConflictError(), snapshot: SNAPSHOT });
  const conflict = await invoke(["stream", "stop", "--stream-id", STREAM], { fixture: revision });
  assert.equal(conflict.code, 3); assert.deepEqual((conflict.value as { snapshot: unknown }).snapshot, SNAPSHOT);
});

await test("non-TTY maintenance fails before owner creation and emits no stderr", async () => {
  for (const command of ["reset-control", "rebind-device"] as const) {
    const value = fixture(), result = await invoke(["local-state", command, "--platform", "android", "--device-ref", ID], { fixture: value });
    assert.equal(result.code, 2); assert.equal(result.stderr, "");
    assert.equal((result.value.error as Record<string, unknown>).code, "confirmation-required");
    assert.deepEqual(value.calls.owner, []); assert.deepEqual(value.calls.closed, []);
  }
});

await test("live Runtime blocks maintenance without a prompt", async () => {
  const value = fixture(); value.setStatus(LIVE_STATUS);
  const result = await invoke(["local-state", "reset-control", "--platform", "android", "--device-ref", ID], { fixture: value, tty: true });
  assert.equal(result.code, 4); assert.equal((result.value.error as Record<string, unknown>).code, "runtime-live");
  assert.equal(result.stderr, ""); assert.deepEqual(result.calls.prompts, []);
});

await test("RESET decline, whitespace, case mismatch and EOF are successful zero-mutation results", async () => {
  for (const answer of ["no", " RESET", "reset", "RESET ", undefined]) {
    const value = fixture(), result = await invoke(["local-state", "reset-control", "--platform", "android", "--device-ref", ID], { fixture: value, tty: true, answers: [answer] });
    assert.equal(result.code, 0); assert.equal((result.value.value as Record<string, unknown>).applied, false);
    assert.equal(result.calls.owner.some((call) => call.startsWith("reset:")), false);
    assert.equal(result.stderr, `Reset android device ${ID} at state revision 7? Type RESET to continue: `);
  }
});

await test("confirmed RESET rechecks exact identity/revision/no-live tuple and renders applied result", async () => {
  const controller = new AbortController(), result = await invoke(["local-state", "reset-control", "--platform=android", `--device-ref=${ID}`], { tty: true, answers: ["RESET"], signal: controller.signal });
  assert.equal(result.code, 0);
  assert.equal(result.calls.owner[1], `reset:${JSON.stringify({ platform: "android", expectedDeviceRef: DEVICE, expectedStateRevision: 7 })}:true`);
  assert.deepEqual(result.value.value, { applied: true, platform: "android", previousDeviceRef: DEVICE, deviceRef: DEVICE, previousStateRevision: 7, stateRevision: 8 });
});

await test("confirmed REBIND uses exact prompt and returns the new DeviceRef", async () => {
  const result = await invoke(["local-state", "rebind-device", "--platform", "android", "--device-ref", ID], { tty: true, answers: ["REBIND"] });
  assert.equal(result.stderr, `Rebind android device ${ID} at state revision 7 and create a new DeviceRef? Type REBIND to continue: `);
  assert.deepEqual(result.value.value, { applied: true, platform: "android", previousDeviceRef: DEVICE, deviceRef: NEXT_DEVICE, previousStateRevision: 7, stateRevision: 8 });
  assert.equal(result.calls.owner[1], `rebind:${JSON.stringify({ platform: "android", expectedDeviceRef: DEVICE, expectedStateRevision: 7 })}:false`);
});

await test("maintenance race failures remain safe and do not claim application", async () => {
  const value = fixture(); value.setOwner("reset", { ok: false, error: controlError("instance-conflict") });
  const result = await invoke(["local-state", "reset-control", "--platform", "android", "--device-ref", ID], { fixture: value, tty: true, answers: ["RESET"] });
  assert.equal(result.code, 4); assert.equal((result.value.error as Record<string, unknown>).code, "instance-conflict");
});

await test("coordinated cancellation is forwarded and rendered as an existing safe result", async () => {
  const controller = new AbortController(); controller.abort();
  const value = fixture(); value.setControl("inspect", { ok: false, error: controlError("request-cancelled") });
  const result = await invoke(["stream", "inspect", "--stream-id", STREAM], { fixture: value, signal: controller.signal });
  assert.equal(result.code, 3); assert.equal((result.value.error as Record<string, unknown>).code, "request-cancelled");
  assert.equal(result.calls.owner[0], "status:android:true");
});

await test("malformed and thrown runtime values become privacy-safe state-unknown failures", async () => {
  const canaries = ["/Users/private/device.json", "SERIAL-PRIVATE", "owner-credential", "Error: provider"];
  for (const canary of canaries) {
    const value = fixture(); value.throwAcquire(new Error(canary));
    const result = await invoke(["viewer", "ensure", "--platform", "android"], { fixture: value });
    assert.equal(result.code, 5); assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
    assert.equal(`${result.stdout}${result.stderr}`.includes(canary), false);
  }
  const malformed = fixture(); malformed.setControl("inspect", { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false, serial: "secret" } });
  const result = await invoke(["stream", "inspect", "--stream-id", STREAM], { fixture: malformed });
  assert.equal(result.code, 5); assert.equal(result.stdout.includes("secret"), false);
});

await test("every noninteractive result has one LF, JSON parity, and empty stderr", async () => {
  for (const args of [["local-state", "status", "--platform", "android"], ["viewer", "ensure", "--platform", "android"], ["stream", "inspect", "--stream-id", STREAM]] as const) {
    const pretty = await invoke(args), compact = await invoke([...args, "--json"]);
    assert.equal(pretty.stdout.endsWith("\n"), true); assert.equal(pretty.stdout.endsWith("\n\n"), false);
    assert.equal(compact.stdout.endsWith("\n"), true); assert.equal(compact.stdout.endsWith("\n\n"), false);
    assert.deepEqual(JSON.parse(pretty.stdout), JSON.parse(compact.stdout));
    assert.equal(pretty.stderr, ""); assert.equal(compact.stderr, "");
  }
});
