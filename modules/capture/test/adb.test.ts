import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ADB_DEADLINES, AdbClient, TransportError, adbInternals, admitDevice, probeAdb, resolveAdbPath } from "../src/adb/index.js";

class FakeStream extends EventEmitter {}
class FakeChild extends EventEmitter { pid = 42; stdout = new FakeStream(); stderr = new FakeStream(); }
type Hooks = NonNullable<Parameters<typeof adbInternals.runProcess>[4]>;
function fakeProcess(responder?: (child: FakeChild, args: readonly string[]) => void) {
  const child = new FakeChild(), calls: { file: string; args: readonly string[]; options: unknown }[] = [], signals: string[] = [], timers: { ms: number; callback: () => void; cleared: boolean }[] = [];
  const hooks = { spawn: (file: string, args: readonly string[], options: unknown) => { calls.push({ file, args, options }); queueMicrotask(() => responder?.(child, args)); return child; }, signal: (_pid: number, signal: string) => { signals.push(signal); }, setTimer: (ms: number, callback: () => void) => { const timer = { ms, callback, cleared: false }; timers.push(timer); return timer; }, clearTimer: (value: unknown) => { (value as { cleared: boolean }).cleared = true; } } as unknown as Hooks;
  return { child, calls, signals, timers, hooks };
}
async function temporary(): Promise<string> { return await mkdtemp(join(tmpdir(), "fsq-adb-")); }
async function fails(run: () => Promise<unknown>, code: string): Promise<void> { await assert.rejects(run, (error: unknown) => error instanceof TransportError && error.code === code && !error.message.includes("/") && !error.message.includes("SERIAL")); }

await test("canonicalizes valid explicit and PATH symlinks and rejects unsafe targets", async (context) => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true })); const explicitTarget = join(root, "explicit-target"), pathTarget = join(root, "path-target"), explicitLink = join(root, "explicit-adb"), pathDir = join(root, "path"); await mkdir(pathDir); await writeFile(explicitTarget, "#!/bin/sh\n"); await writeFile(pathTarget, "#!/bin/sh\n"); await chmod(explicitTarget, 0o700); await chmod(pathTarget, 0o700); await symlink(explicitTarget, explicitLink); await symlink(pathTarget, join(pathDir, "adb"));
  assert.equal(await resolveAdbPath(explicitLink, pathDir), await realpath(explicitTarget)); assert.equal(await resolveAdbPath(undefined, pathDir), await realpath(pathTarget)); await chmod(explicitTarget, 0o600); await fails(() => resolveAdbPath(explicitLink, pathDir), "dependency-unavailable"); const dangling = join(root, "dangling"), cycleA = join(root, "cycle-a"), cycleB = join(root, "cycle-b"); await symlink(join(root, "missing"), dangling); await symlink(cycleB, cycleA); await symlink(cycleA, cycleB); await fails(() => resolveAdbPath(dangling, pathDir), "dependency-unavailable"); await fails(() => resolveAdbPath(cycleA, pathDir), "dependency-unavailable");
});

await test("classifies exact alias and authorized online device without leaking serial", () => {
  const registry = [{ opaqueId: "alias", serial: "SERIAL" }]; assert.equal(admitDevice("alias", registry, "List of devices attached\nSERIAL device usb:1\n"), "SERIAL");
  assert.throws(() => admitDevice("missing", registry, "List of devices attached\n"), (error: unknown) => error instanceof TransportError && error.code === "device-not-found");
  assert.throws(() => admitDevice("alias", [...registry, ...registry], "List of devices attached\nSERIAL device\n"), (error: unknown) => error instanceof TransportError && error.code === "device-ambiguous");
  for (const output of ["List of devices attached\nSERIAL unauthorized\n", "List of devices attached\nSERIAL offline\n", "List of devices attached\nSERIAL device\nOTHER device\n"]) assert.throws(() => admitDevice("alias", [...registry, { opaqueId: "other", serial: "OTHER" }], output), (error: unknown) => error instanceof TransportError && error.code === "device-unavailable" && !error.message.includes("SERIAL"));
});

await test("runs bounded commands with shell false in an owned process group", async () => {
  const fake = fakeProcess((child) => { child.stdout.emit("data", Buffer.from("ok")); child.stderr.emit("data", Buffer.from("warn")); child.emit("close", 0); }); const result = await adbInternals.runProcess("/adb", ["version"], 5_000, "adb-incompatible", fake.hooks); assert.deepEqual(result, { stdout: "ok", stderr: "warn" }); assert.deepEqual(fake.calls[0]?.args, ["version"]); assert.deepEqual(fake.calls[0]?.options, { shell: false, detached: true, stdio: ["ignore", "pipe", "pipe"] }); assert.deepEqual(fake.signals, []);
});

await test("bounds output and performs TERM then two-second KILL before rejection", async () => {
  const fake = fakeProcess(), pending = adbInternals.runProcess("/adb", ["devices"], 5_000, "device-unavailable", fake.hooks); fake.child.stdout.emit("data", Buffer.alloc(adbInternals.outputLimit + 1)); assert.deepEqual(fake.signals, ["SIGTERM"]); fake.timers.find((timer) => timer.ms === ADB_DEADLINES.terminate)!.callback(); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]); fake.child.emit("close", 1); await fails(() => pending, "device-unavailable");
});

await test("times out, kills the owned process group, and waits for reap", async () => {
  const fake = fakeProcess(), pending = adbInternals.runProcess("/adb", ["shell", "true"], 15_000, "device-unavailable", fake.hooks); fake.timers.find((timer) => timer.ms === 15_000)!.callback(); assert.deepEqual(fake.signals, ["SIGTERM"]); fake.timers.find((timer) => timer.ms === 2_000)!.callback(); fake.child.emit("close", null); await fails(() => pending, "device-unavailable"); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]);
});

await test("probes version, devices, get-state and shell with fixed deadlines and argv", async (context) => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true })); const adb = join(root, "adb"); await writeFile(adb, "#!/bin/sh\n"); await chmod(adb, 0o700); const fake = fakeProcess((child, args) => { if (args[0] === "version") child.stdout.emit("data", Buffer.from("Android Debug Bridge version 1.0.41\n")); else if (args[0] === "devices") child.stdout.emit("data", Buffer.from("List of devices attached\nSERIAL device usb:1\n")); else if (args[2] === "get-state") child.stdout.emit("data", Buffer.from("device\n")); child.emit("close", 0); }); const admitted = await probeAdb("alias", [{ opaqueId: "alias", serial: "SERIAL" }], adb, undefined, fake.hooks); assert.equal(admitted.version, "Android Debug Bridge version 1.0.41"); assert.deepEqual(fake.calls.map((call) => call.args), [["version"], ["devices", "-l"], ["-s", "SERIAL", "get-state"], ["-s", "SERIAL", "shell", "true"]]); assert.deepEqual(fake.timers.map((timer) => timer.ms), [5_000, 5_000, 5_000, 15_000]);
});
await test("rejects a non-device get-state as safe device-unavailable", async (context) => {
  const root = await temporary(); context.after(() => rm(root, { recursive: true, force: true })); const adb = join(root, "adb"); await writeFile(adb, "#!/bin/sh\n"); await chmod(adb, 0o700); const fake = fakeProcess((child, args) => { if (args[0] === "version") child.stdout.emit("data", Buffer.from("Android Debug Bridge version 1.0.41\n")); else if (args[0] === "devices") child.stdout.emit("data", Buffer.from("List of devices attached\nSERIAL device\n")); else if (args[2] === "get-state") child.stdout.emit("data", Buffer.from("offline\n")); child.emit("close", 0); }); await fails(() => probeAdb("alias", [{ opaqueId: "alias", serial: "SERIAL" }], adb, undefined, fake.hooks), "device-unavailable"); assert.equal(fake.calls.at(-1)?.args[2], "get-state"); assert.equal(fake.timers.at(-1)?.ms, 5_000);
});
await test("server output and process errors cache one TERM/KILL and settle only after reap", async () => {
  for (const kind of ["overflow", "invalid", "error"] as const) { const fake = fakeProcess(), client = new AdbClient("/adb", fake.hooks), owned = client.start("SERIAL", ["shell", "server"]); let settled = false; const closed = owned.closed.catch((error: unknown) => { settled = true; throw error; }); if (kind === "overflow") fake.child.stdout.emit("data", Buffer.alloc(adbInternals.outputLimit + 1)); else if (kind === "invalid") fake.child.stderr.emit("data", "not-bytes"); else fake.child.emit("error", new Error("spawn")); await Promise.resolve(); assert.equal(settled, false); assert.deepEqual(fake.signals, ["SIGTERM"]); if (kind !== "overflow") fake.child.stdout.emit("data", Buffer.alloc(adbInternals.outputLimit + 1)); assert.deepEqual(fake.signals, ["SIGTERM"]); fake.timers.find((timer) => timer.ms === 2_000)!.callback(); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]); fake.child.emit("close", 1); await fails(() => closed, "capture-start-failed"); await owned.stop(); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]); }
});

await test("owned server stop is idempotent and waits through TERM to KILL and reap", async () => {
  const fake = fakeProcess(), client = new AdbClient("/adb", fake.hooks), owned = client.start("SERIAL", ["shell", "server"]), stopping = owned.stop(); await Promise.resolve(); assert.deepEqual(fake.signals, ["SIGTERM"]); fake.timers.find((timer) => timer.ms === 2_000)!.callback(); fake.child.emit("close", null); await stopping; await owned.stop(); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]); assert.deepEqual(fake.calls[0]?.args, ["-s", "SERIAL", "shell", "server"]);
});

await test("cancellation terminates and reaps active commands and prevents pre-aborted spawn", async () => {
  const fake = fakeProcess(), controller = new AbortController(), pending = adbInternals.runProcess("/adb", ["shell", "true"], 15_000, "device-unavailable", fake.hooks, controller.signal); controller.abort(); assert.deepEqual(fake.signals, ["SIGTERM"]); fake.timers.find((timer) => timer.ms === ADB_DEADLINES.terminate)!.callback(); assert.deepEqual(fake.signals, ["SIGTERM", "SIGKILL"]); fake.child.emit("close", null); await fails(() => pending, "device-unavailable"); const before = fake.calls.length, already = new AbortController(); already.abort(); await fails(() => adbInternals.runProcess("/adb", ["version"], 5_000, "adb-incompatible", fake.hooks, already.signal), "adb-incompatible"); assert.equal(fake.calls.length, before);
});
