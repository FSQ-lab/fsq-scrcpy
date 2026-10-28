import assert from "node:assert/strict";
import test from "node:test";
import {
  CONTROL_VERSION,
  controlError,
  type DeviceRef,
  type RuntimeAttachment,
  type RuntimeControl,
  type RuntimeControlSession,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import type { RuntimeOwnerLocal } from "../../runtime/src/owner.js";
import { executeCli, type CliIo, type CliRuntimeDependencies } from "../src/cli.js";

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const OTHER_ID = "523e4567-e89b-42d3-a456-426614174000";
const STREAM_ID = "223e4567-e89b-42d3-a456-426614174000";
const INSTANCE_ID = "323e4567-e89b-42d3-a456-426614174000";
const GENERATION = "423e4567-e89b-42d3-a456-426614174000";
const DEVICE: DeviceRef = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: DEVICE_ID });
const OTHER_DEVICE: DeviceRef = Object.freeze({ ...DEVICE, opaqueId: OTHER_ID });
const SNAPSHOT: StreamSnapshot = Object.freeze({ streamId: STREAM_ID, deviceRef: DEVICE, revision: 1, phase: "demand-pending", activeViewerCount: 0, updatedAt: 1 });
const OTHER_SNAPSHOT: StreamSnapshot = Object.freeze({ ...SNAPSHOT, deviceRef: OTHER_DEVICE });
const ATTACHMENT: RuntimeAttachment = Object.freeze({
  disposition: "attached",
  instance: Object.freeze({
    controlVersion: CONTROL_VERSION,
    instanceId: INSTANCE_ID,
    generation: GENERATION,
    contractVersion: 2,
    deviceRef: DEVICE,
    features: Object.freeze(["wait-v1"] as const),
  }),
});
const DESCRIPTOR = Object.freeze({
  contractVersion: 2 as const,
  streamId: STREAM_ID,
  standaloneUri: `http://127.0.0.1:49152/viewer/${STREAM_ID}`,
  presentationModes: Object.freeze(["standalone"] as const),
  expiresAt: 60,
});

interface Harness {
  dependencies: CliRuntimeDependencies;
  readonly touches: string[];
  controlResult: unknown;
  statusResult: unknown;
}
function harness(attachment: unknown = ATTACHMENT): Harness {
  const value: Harness = {
    touches: [],
    controlResult: { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false, timedOut: false } },
    statusResult: { ok: true, value: { platform: "android", state: "ready", deviceRef: DEVICE, stateRevision: 1, runtime: { state: "not-running" } } },
    dependencies: undefined as never,
  };
  const control: RuntimeControl = {
    async ensureViewer() { value.touches.push("ensure"); return value.controlResult as never; },
    async inspect() { value.touches.push("inspect"); return value.controlResult as never; },
    async wait() { throw new Error("CLI must not call wait"); },
    async stopStream() { value.touches.push("stop"); return value.controlResult as never; },
    async close() { value.touches.push("control-close"); },
  };
  const session = {
    attachment: attachment as RuntimeAttachment,
    control,
    async close() { value.touches.push("session-close"); },
  } as unknown as RuntimeControlSession;
  const owner: RuntimeOwnerLocal = {
    async inspectLocalState() { value.touches.push("status"); return value.statusResult as never; },
    async approveViewerPairing() { value.touches.push("approve"); return value.controlResult as never; },
    async shutdownRuntime() { value.touches.push("shutdown"); return value.controlResult as never; },
    async resetControlState() { value.touches.push("reset"); return value.controlResult as never; },
    async rebindDevice() { value.touches.push("rebind"); return value.controlResult as never; },
    async close() { value.touches.push("owner-close"); },
    async [Symbol.asyncDispose]() { await this.close(); },
  };
  value.dependencies = {
    acquireRuntime: (async () => { value.touches.push("acquire"); return { ok: true, session }; }) as CliRuntimeDependencies["acquireRuntime"],
    createRuntimeOwnerLocal: () => { value.touches.push("owner-create"); return owner; },
  };
  return value;
}
async function run(args: readonly string[], value = harness(), tty: readonly [boolean, boolean] = [false, false]): Promise<{ code: number; stdout: string; stderr: string; value: Record<string, unknown>; harness: Harness }> {
  let stdout = "", stderr = "";
  const io: CliIo = {
    stdin: { isTTY: tty[0] },
    stdout: { write(chunk) { stdout += chunk; } },
    stderr: { isTTY: tty[1], write(chunk) { stderr += chunk; } },
    async question(prompt) { stderr += prompt; return undefined; },
  };
  const code = await executeCli(args, io, value.dependencies);
  return { code, stdout, stderr, value: JSON.parse(stdout) as Record<string, unknown>, harness: value };
}

await test("all repeated long options and short aliases fail before any runtime seam", async () => {
  const cases = [
    ["viewer", "ensure", "--platform", "android", "--platform=android"],
    ["viewer", "ensure", "--device-ref", DEVICE_ID, `--device-ref=${DEVICE_ID}`],
    ["stream", "inspect", "--stream-id", STREAM_ID, "--stream-id", STREAM_ID],
    ["stream", "inspect", "--stream-id", STREAM_ID, "--after-revision", "1", "--after-revision=2"],
    ["stream", "stop", "--stream-id", STREAM_ID, "--expected-revision", "1", "--expected-revision=2"],
    ["viewer", "approve", "--stream-id", STREAM_ID, "--code", "01234567", "--code=01234567"],
    ["runtime", "shutdown", "--device-ref", DEVICE_ID, "--json", "--json"],
    ["local-state", "status", "--platform", "android", "-j"],
  ];
  for (const args of cases) {
    const result = await run(args);
    assert.equal(result.code, 2, args.join(" "));
    assert.deepEqual(result.harness.touches, []);
    assert.equal((result.value.error as Record<string, unknown>).code, "invalid-cli-syntax");
  }
});

await test("canonical v4 UUID validation rejects nil, version, variant, case, and suffix forms", async () => {
  const invalid = [
    "00000000-0000-0000-0000-000000000000",
    "123e4567-e89b-12d3-a456-426614174000",
    "123e4567-e89b-42d3-7456-426614174000",
    DEVICE_ID.toUpperCase(),
    `${DEVICE_ID}0`,
  ];
  for (const id of invalid) {
    const result = await run(["stream", "inspect", "--stream-id", id]);
    assert.equal(result.code, 2, id);
    assert.deepEqual(result.harness.touches, []);
  }
});

await test("revision grammar admits the safe maximum and rejects every noncanonical numeric form", async () => {
  const accepted = await run(["stream", "inspect", "--stream-id", STREAM_ID, "--after-revision", `${Number.MAX_SAFE_INTEGER}`]);
  assert.equal(accepted.code, 0);
  assert.deepEqual(accepted.harness.touches.slice(0, 3), ["owner-create", "status", "acquire"]);
  for (const revision of ["0", "00", "01", "+1", "-1", "1.0", "1e1", " 1", "9007199254740992"]) {
    const result = await run(["stream", "stop", "--stream-id", STREAM_ID, "--expected-revision", revision]);
    assert.equal(result.code, 2, revision);
    assert.deepEqual(result.harness.touches, []);
  }
});

await test("pairing code accepts only the eight-character uppercase Crockford alphabet", async () => {
  const valid = harness();
  valid.controlResult = { ok: true, value: { snapshot: SNAPSHOT, approvedAt: 1 } };
  assert.equal((await run(["viewer", "approve", "--stream-id", STREAM_ID, "--code", "0AHJKNPZ"], valid)).code, 0);
  for (const code of ["0123456", "012345678", "0123456i", "0123456I", "0123456L", "0123456O", "0123456U", "0123456-"]) {
    const result = await run(["viewer", "approve", "--stream-id", STREAM_ID, "--code", code]);
    assert.equal(result.code, 2, code);
    assert.deepEqual(result.harness.touches, []);
  }
});

await test("half-TTY maintenance never creates the owner seam or writes a prompt", async () => {
  for (const tty of [[true, false], [false, true]] as const) {
    const result = await run(["local-state", "reset-control", "--platform", "android", "--device-ref", DEVICE_ID], harness(), tty);
    assert.equal(result.code, 2);
    assert.equal(result.stderr, "");
    assert.deepEqual(result.harness.touches, []);
    assert.equal((result.value.error as Record<string, unknown>).code, "confirmation-required");
  }
});

await test("strict operation validators reject legacy and additional fields", async () => {
  const malformed: readonly [readonly string[], unknown][] = [
    [["stream", "inspect", "--stream-id", STREAM_ID], { ok: true, value: { snapshot: SNAPSHOT } }],
    [["stream", "inspect", "--stream-id", STREAM_ID], { ok: true, value: { snapshot: SNAPSHOT, changes: [], reset: false } }],
    [["stream", "stop", "--stream-id", STREAM_ID], { ok: true, value: { snapshot: SNAPSHOT, extra: true } }],
    [["viewer", "approve", "--stream-id", STREAM_ID, "--code", "01234567"], { ok: true, value: { snapshot: SNAPSHOT, approvedAt: 1, pairingId: "private" } }],
    [["runtime", "shutdown", "--device-ref", DEVICE_ID], { ok: true, value: { instanceId: INSTANCE_ID, generation: GENERATION, port: 49152 } }],
  ];
  for (const [args, resultValue] of malformed) {
    const value = harness();
    value.controlResult = resultValue;
    const result = await run(args, value);
    assert.equal(result.code, 5, args.join(" "));
    assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
    assert.equal(result.stdout.includes("private"), false);
    assert.equal(result.stdout.includes("49152"), false);
  }
});
await test("viewer ensure rejects legacy and extra Runtime feature tuples", async () => {
  for (const features of [[], ["wait-v1", "extra"]]) {
    const attachment = { ...ATTACHMENT, instance: { ...ATTACHMENT.instance, features } };
    const result = await run(["viewer", "ensure", "--platform", "android"], harness(attachment));
    assert.equal(result.code, 5);
    assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
    assert.equal(result.stdout.includes("extra"), false);
  }
});

await test("ensure rejects disagreement among attachment, deviceRef, and snapshot without partial success", async () => {
  const value = harness();
  value.controlResult = { ok: true, value: { deviceRef: OTHER_DEVICE, descriptor: DESCRIPTOR, snapshot: OTHER_SNAPSHOT } };
  const result = await run(["viewer", "ensure", "--platform", "android"], value);
  assert.equal(result.code, 5);
  assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
  assert.equal(result.stdout.includes(OTHER_ID), false);
  assert.deepEqual(result.harness.touches, ["acquire", "ensure", "session-close"]);
});

await test("malformed status and owner errors are converted without exposing their cause", async () => {
  const value = harness();
  value.statusResult = { ok: true, value: { platform: "android", state: "ready", deviceRef: DEVICE, stateRevision: 1, runtime: { state: "not-running" }, credential: "owner-private" } };
  const result = await run(["local-state", "status", "--platform", "android"], value);
  assert.equal(result.code, 5);
  assert.equal((result.value.error as Record<string, unknown>).code, "runtime-exited");
  assert.equal(result.stdout.includes("owner-private"), false);
  assert.deepEqual(result.harness.touches, ["owner-create", "status", "owner-close"]);
});

await test("an abort while waiting for RESET returns request-cancelled instead of a decline", async () => {
  const value = harness(), controller = new AbortController();
  let stdout = "", stderr = "";
  const io: CliIo = {
    stdin: { isTTY: true },
    stdout: { write(chunk) { stdout += chunk; } },
    stderr: { isTTY: true, write(chunk) { stderr += chunk; } },
    async question(prompt) {
      stderr += prompt;
      controller.abort();
      return undefined;
    },
  };
  const code = await executeCli(["local-state", "reset-control", "--platform", "android", "--device-ref", DEVICE_ID], io, value.dependencies, controller.signal);
  const result = JSON.parse(stdout) as Record<string, unknown>;
  assert.equal(code, 3);
  assert.equal((result.error as Record<string, unknown>).code, "request-cancelled");
  assert.equal(stderr.startsWith(`Reset android device ${DEVICE_ID}`), true);
  assert.equal(value.touches.includes("reset"), false);
});

await test("owner-local safe failures retain their exact tuple and exit mapping", async () => {
  for (const [code, exit] of [["instance-not-found", 3], ["instance-conflict", 4], ["deadline-exceeded", 5]] as const) {
    const value = harness();
    value.statusResult = { ok: false, error: controlError(code) };
    const result = await run(["stream", "inspect", "--stream-id", STREAM_ID], value);
    assert.equal(result.code, exit);
    assert.deepEqual(result.value, { ok: false, error: controlError(code) });
    assert.equal(result.stderr, "");
    assert.deepEqual(result.harness.touches, ["owner-create", "status", "owner-close"]);
  }
});
