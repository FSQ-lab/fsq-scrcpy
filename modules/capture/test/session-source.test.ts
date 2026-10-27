import assert from "node:assert/strict";
import test from "node:test";
import { CaptureOpenError, ScrcpyV501CaptureAdapter, validateDeviceRef as captureValidateDeviceRef, validateStreamError as captureValidateStreamError, type CaptureSource } from "../src/index.js";
import { TransportError, type OwnedProcess, type TransportErrorCode } from "../src/adb/index.js";
import type { VerifiedArtifact } from "../src/artifact/index.js";
import type { AdbPort, ReadableTransportSocket, ScrcpyTransport } from "../src/scrcpy/transport.js";
import { validateDeviceRef as sharedValidateDeviceRef, validateStreamError as sharedValidateStreamError } from "../../contracts/src/index.js";
import { PIXEL_HOME, readRotationState, resolveComponent, restorePixelHome, restoreRotationState, ScenarioDeadline, validateDevicePreflight, validateSmokeAlias, waitForPackage, type RotationState } from "./real-device-smoke.js";
const alias = "123e4567-e89b-42d3-a456-426614174000", deviceRef = { contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: alias } as const;
const config = { adbPath: "/adb", cacheRoot: "/cache", deviceRegistry: [{ opaqueId: alias, serial: "SERIAL" }], artifactSource: { mode: "online" } } as const;
class Socket implements ReadableTransportSocket { private release?: () => void; on(): this { return this; } pause(): this { return this; } resume(): this { return this; } read(): Uint8Array | null { return null; } destroy(): this { this.release?.(); return this; } async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> { yield Uint8Array.of(0x68, 0x32, 0x36, 0x34); await new Promise<void>((done) => { this.release = done; }); } }
class Client implements AdbPort { async run(_serial: string | undefined, _args: readonly string[], _timeout: number, _failure: TransportErrorCode): Promise<{ stdout: string; stderr: string }> { return { stdout: "device\n", stderr: "" }; } start(): OwnedProcess { throw new Error("unused"); } }
function hooks(error?: TransportError) { const calls: string[] = [], client = new Client(), socket = new Socket(), transport: ScrcpyTransport = { socket, scid: "1", socketName: "s", remotePath: "r", close: async () => { calls.push("close"); socket.destroy(); return []; } }, artifact = {} as VerifiedArtifact; return { calls, value: { acquire: async () => { calls.push("artifact"); return artifact; }, probe: async (opaqueId: string, registry: readonly unknown[], adbPath?: string) => { calls.push(`probe:${opaqueId}:${registry.length}:${adbPath}`); if (error) throw error; return { client, serial: "SERIAL", version: "adb" }; }, transport: async () => { calls.push("transport"); return transport; } } as NonNullable<ConstructorParameters<typeof ScrcpyV501CaptureAdapter>[1]> };
}
const open = (source: ScrcpyV501CaptureAdapter, value: unknown = { deviceRef }, signal?: AbortSignal) => source.open(value, signal);

await test("validates exact config/request and composes artifact, ADB and transport seams", async () => {
  const fake = hooks(), source: CaptureSource = new ScrcpyV501CaptureAdapter(config, fake.value), capture = await source.open({ deviceRef }); assert.deepEqual(fake.calls, ["artifact", `probe:${alias}:1:/adb`, "transport"]); await capture.stop("explicit-stop"); assert.equal(fake.calls.at(-1), "close");
});

await test("rejects non-exact config and request, legacy constraints and mismatched identities before side effects", async () => {
  for (const value of [{ ...config, extra: true }, { ...config, cacheRoot: "relative" }, { ...config, adbPath: "adb" }, { ...config, deviceRegistry: [{ opaqueId: "bad", serial: "S" }] }, { ...config, deviceRegistry: [{ opaqueId: alias, serial: "" }] }, Object.create(config)]) assert.throws(() => new ScrcpyV501CaptureAdapter(value), CaptureOpenError);
  const fake = hooks(), source = new ScrcpyV501CaptureAdapter(config, fake.value);
  const badRequests: unknown[] = [
    {}, { deviceRef: { ...deviceRef, opaqueId: "bad" } },
    { deviceRef, videoConstraints: { codec: "h264", minShortEdge: 720, maxFps: 30, bitRate: 8_000_000, noCrop: true, noUpscale: true } },
    { deviceRef: { ...deviceRef, contractVersion: 1 } },
    { deviceRef: { ...deviceRef, namespace: "other" } },
    { deviceRef: { ...deviceRef, platform: "ios" } },
    { deviceRef: { ...deviceRef, platform: "wda" } },
    { deviceRef: { ...deviceRef, provider: "scrcpy" } },
    { deviceRef, extra: true }, Object.create({ deviceRef })
  ];
  for (const value of badRequests) await assert.rejects(() => open(source, value), CaptureOpenError);
  assert.deepEqual(fake.calls, []);
});

await test("maps setup failures safely and honors pre-aborted cancellation", async () => {
  const failed = hooks(new TransportError("device-not-found")), source = new ScrcpyV501CaptureAdapter(config, failed.value); await assert.rejects(() => open(source), (error: unknown) => error instanceof CaptureOpenError && error.error.code === "device-not-found" && !error.message.includes("SERIAL") && !error.message.includes("/")); const controller = new AbortController(); controller.abort(); const untouched = hooks(); await assert.rejects(() => open(new ScrcpyV501CaptureAdapter(config, untouched.value), undefined, controller.signal), CaptureOpenError); assert.deepEqual(untouched.calls, []);
});

await test("re-exports the accepted Contracts validators and propagates cancellation before later setup effects", async () => {
  assert.equal(captureValidateDeviceRef, sharedValidateDeviceRef); assert.equal(captureValidateStreamError, sharedValidateStreamError); assert.equal(captureValidateDeviceRef(deviceRef), deviceRef); const calls: string[] = []; assert.throws(() => validateSmokeAlias("not-canonical")); assert.equal(calls.length, 0);
  const controller = new AbortController(), base = hooks(), value = { ...base.value, acquire: async (_root: string, _source: unknown, signal?: AbortSignal) => { calls.push("artifact"); assert.equal(signal, controller.signal); controller.abort(); return {} as VerifiedArtifact; }, probe: async () => { calls.push("probe"); throw new Error("unreachable"); } } as NonNullable<ConstructorParameters<typeof ScrcpyV501CaptureAdapter>[1]>; await assert.rejects(() => open(new ScrcpyV501CaptureAdapter(config, value), undefined, controller.signal), CaptureOpenError); assert.deepEqual(calls, ["artifact"]);
});

await test("reserves cleanup time inside one monotonic scenario deadline", () => {
  let now = 100; const deadline = new ScenarioDeadline({ now: () => now }, 60_000, 12_000); assert.equal(deadline.timeout(90_000), 48_000); now += 47_999; assert.equal(deadline.timeout(1_000), 1); assert.equal(deadline.timeout(90_000, true), 12_001); now++; assert.throws(() => deadline.timeout(1), /Scenario deadline exceeded/); now += 12_000; assert.throws(() => deadline.timeout(1, true), /Cleanup deadline exceeded/);
});


await test("admits one lit unlocked non-foldable hardware-H264 display and rejects foldable state", () => {
  const value = { internalDisplays: "1\n", deviceStates: "Supported states: [DEFAULT]", screen: "mScreenState=ON\n", keyguard: "mDreamingLockscreen=false\n", encoder: "Encoder \"c2.qti.avc.encoder\" supports" }; assert.doesNotThrow(() => validateDevicePreflight(value)); assert.throws(() => validateDevicePreflight({ ...value, deviceStates: "DeviceState{name='HALF_OPENED'}" }), /Foldable/); assert.throws(() => validateDevicePreflight({ ...value, encoder: "Encoder \"c2.android.avc.encoder\" supports" }), /Hardware/);
});

await test("restores HOME and requires stable fixed Pixel NexusLauncher focus", async () => {
  let now = 0; const calls: string[] = []; await restorePixelHome(async (args) => { calls.push(args.join(" ")); return args.join(" ").includes("mCurrentFocus") ? `mCurrentFocus=Window{1 u0 ${PIXEL_HOME}}\n` : ""; }, { now: () => now, sleep: async (ms) => { now += ms; } }); assert.equal(calls[0], "shell input keyevent KEYCODE_HOME"); assert.ok(now >= 500); let failedNow = 0; await assert.rejects(() => restorePixelHome(async (args) => args.join(" ").includes("mCurrentFocus") ? "mCurrentFocus=Window{1 u0 other.app/.Main}\n" : "", { now: () => failedNow, sleep: async (ms) => { failedNow += ms; } }), /Foreground restoration failed/);
});

await test("extracts one settings component from metadata lines and stable-polls its package", async () => {
  assert.equal(resolveComponent("priority=1 preferredOrder=0 match=0x108000\ncom.android.settings/.homepage.SettingsHomepageActivity\n"), "com.android.settings/.homepage.SettingsHomepageActivity"); for (const output of ["metadata only\n", "a.b/.One\nc.d/.Two\n"]) assert.throws(() => resolveComponent(output), /Rotation surface unavailable/); let now = 0, reads = 0; await waitForPackage(async () => { reads++; return reads === 3 ? "mCurrentFocus=Window{1 u0 other/.Main}\n" : "mCurrentFocus=Window{1 u0 com.android.settings/.Settings}\n"; }, "com.android.settings", { now: () => now, sleep: async (ms) => { now += ms; } }); assert.ok(now >= 800);
});
await test("restores rotation policy first and waits through an asynchronous policy race", async () => {
  const original: RotationState = { policy: { mode: "free" }, userRotation: "0", accelerometer: "1", ignoreOrientationRequest: false }, calls: string[] = []; let now = 0, policyReads = 0;
  const command = async (args: readonly string[]): Promise<string> => { const call = args.join(" "); calls.push(call); if (call === "shell wm user-rotation") return ++policyReads === 6 ? "lock 1\n" : "free\n"; if (call.endsWith("settings get system user_rotation")) return "0\n"; if (call.endsWith("settings get system accelerometer_rotation")) return "1\n"; if (call === "shell wm get-ignore-orientation-request") return "ignoreOrientationRequest false for displayId=0\n"; return ""; };
  await restoreRotationState(command, original, { now: () => now, sleep: async (ms) => { now += ms; } });
  assert.deepEqual(calls.slice(0, 4), ["shell wm user-rotation free", "shell settings put system user_rotation 0", "shell settings put system accelerometer_rotation 1", "shell wm set-ignore-orientation-request false"]); assert.ok(policyReads >= 17); assert.ok(now >= 1_600);
});

await test("parses a locked rotation policy and fails bounded restoration without stable agreement", async () => {
  const locked = await readRotationState(async (args) => args.join(" ") === "shell wm user-rotation" ? "lock 3\n" : args.join(" ") === "shell wm get-ignore-orientation-request" ? "ignoreOrientationRequest true for displayId=0\n" : args.at(-1) === "user_rotation" ? "3\n" : "0\n"); assert.deepEqual(locked, { policy: { mode: "lock", rotation: "3" }, userRotation: "3", accelerometer: "0", ignoreOrientationRequest: true }); let now = 0;
  await assert.rejects(() => restoreRotationState(async (args) => args.join(" ") === "shell wm user-rotation" ? "free\n" : args.join(" ") === "shell wm get-ignore-orientation-request" ? "ignoreOrientationRequest false for displayId=0\n" : args.includes("get") ? args.at(-1) === "user_rotation" ? "0\n" : "1\n" : "", locked, { now: () => now, sleep: async (ms) => { now += ms; } }), /Rotation restore verification failed/); assert.ok(now >= 5_000 && now <= 5_100);
});
