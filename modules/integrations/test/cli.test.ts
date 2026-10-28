import assert from "node:assert/strict";
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
const ATTACHMENT: RuntimeAttachment = Object.freeze({ disposition: "attached", instance: Object.freeze({ controlVersion: CONTROL_VERSION, instanceId: INSTANCE, generation: GENERATION, contractVersion: 2, deviceRef: DEVICE, features: Object.freeze(["wait-v1"] as const) }) });
const STATUS = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "android" as const, state: "ready" as const, deviceRef: DEVICE, stateRevision: 7, runtime: Object.freeze({ state: "not-running" as const }) }) });
const LIVE_STATUS = Object.freeze({ ok: true as const, value: Object.freeze({ ...STATUS.value, runtime: Object.freeze({ state: "live" as const, target: Object.freeze({ instanceId: INSTANCE, generation: GENERATION }) }) }) });
const UNINITIALIZED = Object.freeze({ ok: true as const, value: Object.freeze({ platform: "android" as const, state: "uninitialized" as const }) });
const DESCRIPTOR = Object.freeze({ contractVersion: 2 as const, streamId: STREAM, standaloneUri: `http://127.0.0.1:49152/viewer/${STREAM}`, presentationModes: Object.freeze(["standalone"] as const), expiresAt: 60 });

type Calls = { acquire: unknown[]; owner: string[]; control: string[]; closed: string[]; prompts: string[] };
interface Fixture { runtime: CliRuntimeDependencies; calls: Calls; setStatus(value: unknown): void; setControl(name: "ensure" | "inspect" | "stop", value: unknown): void; setOwner(name: "approve" | "shutdown" | "reset" | "rebind", value: unknown): void; throwAcquire(cause: unknown): void }
function fixture(): Fixture {
  const calls: Calls = { acquire: [], owner: [], control: [], closed: [], prompts: [] };
  let status: unknown = STATUS, acquireCause: unknown;
  const values: Record<string, unknown> = {
    ensure: { ok: true, value: { deviceRef: DEVICE, descriptor: DESCRIPTOR, snapshot: SNAPSHOT } },
    inspect: { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false } },
    stop: { ok: true, value: { snapshot: SNAPSHOT } },
    approve: { ok: true, value: { snapshot: SNAPSHOT, approvedAt: 2 } },
    shutdown: { ok: true, value: { instanceId: INSTANCE, generation: GENERATION } },
    reset: { ok: true, value: { platform: "android", deviceRef: DEVICE, previousStateRevision: 7, stateRevision: 8 } },
    rebind: { ok: true, value: { platform: "android", previousDeviceRef: DEVICE, deviceRef: NEXT_DEVICE, previousStateRevision: 7, stateRevision: 8 } },
  };
  const control: RuntimeControl = {
    async ensureViewer(options) { calls.control.push(`ensure:${Boolean(options?.signal)}`); return values.ensure as never; },
    async inspect(input, options) { calls.control.push(`inspect:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.inspect as never; },
    async wait() { throw new Error("CLI must not call wait"); },
    async stopStream(input, options) { calls.control.push(`stop:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.stop as never; },
    async close() { calls.closed.push("control"); },
  };
  const session = { attachment: ATTACHMENT, control, async close() { calls.closed.push("session"); } } as unknown as RuntimeControlSession;
  const owner: RuntimeOwnerLocal = {
    async inspectLocalState(_input, options) { calls.owner.push(`status:${Boolean(options?.signal)}`); return status as never; },
    async approveViewerPairing(input, options) { calls.owner.push(`approve:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.approve as never; },
    async shutdownRuntime(input, options) { calls.owner.push(`shutdown:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.shutdown as never; },
    async resetControlState(input, options) { calls.owner.push(`reset:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.reset as never; },
    async rebindDevice(input, options) { calls.owner.push(`rebind:${JSON.stringify(input)}:${Boolean(options?.signal)}`); return values.rebind as never; },
    async close() { calls.closed.push("owner"); },
    async [Symbol.asyncDispose]() { await this.close(); },
  };
  let runtime: CliRuntimeDependencies = {
    acquireRuntime: (async (request, options) => { calls.acquire.push({ request, signal: Boolean(options?.signal) }); if (acquireCause) throw acquireCause; return { ok: true, session }; }) as CliRuntimeDependencies["acquireRuntime"],
    createRuntimeOwnerLocal: () => owner,
  };
  return {
    get runtime() { return runtime; }, calls,
    setStatus(value) { status = value; },
    setControl(name, value) { values[name] = value; },
    setOwner(name, value) { values[name] = value; },
    throwAcquire(cause) { acquireCause = cause; runtime = { ...runtime }; },
  };
}
interface Invocation { code: number; stdout: string; stderr: string; value: Record<string, unknown>; calls: Calls }
async function invoke(args: readonly string[], options: { tty?: boolean; answers?: readonly (string | undefined)[]; fixture?: Fixture; signal?: AbortSignal } = {}): Promise<Invocation> {
  const value = options.fixture ?? fixture(), output: string[] = [], errors: string[] = [], answers = [...(options.answers ?? [])];
  const io: CliIo = {
    stdin: { isTTY: options.tty ?? false },
    stdout: { write(chunk) { output.push(chunk); } },
    stderr: { isTTY: options.tty ?? false, write(chunk) { errors.push(chunk); } },
    async question(prompt) { value.calls.prompts.push(prompt); errors.push(prompt); return answers.shift(); },
  };
  const code = await executeCli(args, io, value.runtime, options.signal);
  assert.equal(output.length, 1);
  return { code, stdout: output[0]!, stderr: errors.join(""), value: JSON.parse(output[0]!) as Record<string, unknown>, calls: value.calls };
}

await test("rejects every malformed grammar before product I/O with deterministic render mode", async () => {
  const invalid = [
    [], ["viewer"], ["viewer", "unknown"], ["--json", "viewer", "ensure"],
    ["viewer", "ensure"], ["viewer", "ensure", "--platform", "ios"],
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
    ["viewer", "approve", "--stream-id", STREAM, "--code", "ILOU1234"],
    ["runtime", "shutdown", "--device-ref", ID.toUpperCase()],
    ["local-state", "status", "--platform", "android", "--unknown"],
    ["local-state", "reset-control", "--platform", "android"],
    ["local-state", "rebind-device", "--platform", "android", "--device-ref", ID, "--force"],
    ["stream", "wait", "--stream-id", STREAM, "--after-revision", "1"],
    ["stream", "watch", "--stream-id", STREAM],
  ];
  for (const args of invalid) {
    const value = fixture(), result = await invoke(args, { fixture: value });
    assert.equal(result.code, 2, args.join(" "));
    assert.deepEqual(result.value, { ok: false, error: { code: "invalid-cli-syntax", disposition: "usage", operationState: "not-applied", safeMessage: "Invalid command syntax." } });
    assert.equal(result.stderr, "");
    assert.deepEqual(value.calls, { acquire: [], owner: [], control: [], closed: [], prompts: [] });
  }
  const compact = await invoke(["nonsense", "command", "--json"]);
  assert.equal(compact.stdout.includes("\n  \""), false);
  const malformedEquals = await invoke(["nonsense", "command", "--json=true"]);
  assert.equal(malformedEquals.stdout.includes("\n  \""), true);
});

await test("maps auto and known ensure to the only allowed selectors and safe combined result", async () => {
  const auto = await invoke(["viewer", "ensure", "--platform=android"]);
  assert.equal(auto.code, 0); assert.equal(auto.stderr, "");
  assert.deepEqual(auto.calls.owner, []);
  assert.deepEqual(auto.calls.acquire[0], { request: { mode: "start-or-attach", selector: { kind: "auto", platform: "android" } }, signal: false });
  assert.deepEqual((auto.value.value as Record<string, unknown>).attachment, ATTACHMENT);
  assert.deepEqual((((auto.value.value as Record<string, unknown>).attachment as RuntimeAttachment).instance.features), ["wait-v1"]);
  const known = await invoke(["viewer", "ensure", "--device-ref", ID, "--json"]);
  assert.equal(known.stdout.includes("\n  \""), false);
  assert.deepEqual(known.value, auto.value);
  assert.deepEqual(known.calls.owner, ["status:false"]);
  assert.deepEqual(known.calls.acquire[0], { request: { mode: "start-or-attach", selector: { kind: "known", deviceRef: DEVICE } }, signal: false });
  assert.deepEqual(known.calls.closed.sort(), ["owner", "session"]);
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
  assert.deepEqual(stop.calls.owner, ["status:false"]);
});

await test("maps approve and shutdown only through owner-local lookup", async () => {
  const approve = await invoke(["viewer", "approve", "--stream-id", STREAM, "--code", "01234567"]);
  assert.deepEqual(approve.calls.acquire, []);
  assert.equal(approve.calls.owner[1], `approve:${JSON.stringify({ deviceRef: DEVICE, streamId: STREAM, pairingCode: "01234567" })}:false`);
  const shutdown = await invoke(["runtime", "shutdown", "--device-ref", ID]);
  assert.deepEqual(shutdown.calls.acquire, []);
  assert.equal(shutdown.calls.owner[1], `shutdown:${JSON.stringify({ deviceRef: DEVICE })}:false`);
});

await test("status is read-only and stored identity lookup maps absent and mismatched values", async () => {
  const status = await invoke(["local-state", "status", "--platform", "android"]);
  assert.deepEqual(status.value, STATUS); assert.deepEqual(status.calls.acquire, []);
  const absentFixture = fixture(); absentFixture.setStatus(UNINITIALIZED);
  const absent = await invoke(["stream", "inspect", "--stream-id", STREAM], { fixture: absentFixture });
  assert.equal(absent.code, 3); assert.equal(((absent.value.error as Record<string, unknown>).code), "instance-not-found"); assert.deepEqual(absent.calls.acquire, []);
  const conflict = await invoke(["runtime", "shutdown", "--device-ref", NEXT]);
  assert.equal(conflict.code, 4); assert.equal(((conflict.value.error as Record<string, unknown>).code), "instance-conflict"); assert.equal(conflict.calls.owner.length, 1);
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
  assert.equal(result.calls.owner[0], "status:true");
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
