import { createHook } from "node:async_hooks";
import { createRequire } from "node:module";
import process from "node:process";
import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  createIosWdaCaptureSource,
  resolveSingleIosWdaBinding,
  WdaMjpegCaptureAdapter,
  type IosWdaBindingAccess,
} from "../src/index.js";
import {
  createIosWdaCaptureSource as directCreate,
  resolveSingleIosWdaBinding as directResolve,
} from "../src/wda/binding.js";
import { deviceRef } from "./wda-fixtures.js";

const INVALID_OPTIONS = "Invalid iOS WDA binding options";
const INVALID_SOURCE = "Invalid iOS WDA capture source input";
const fixedTypeError = (message: string) => (error: unknown): boolean =>
  error instanceof TypeError && error.message === message;

function create(input: unknown): ReturnType<typeof createIosWdaCaptureSource> {
  return (createIosWdaCaptureSource as (value: unknown) => ReturnType<typeof createIosWdaCaptureSource>)(input);
}

await test("exports the fixed iOS logical-slot resolver and Capture-owned factory", () => {
  assert.equal(resolveSingleIosWdaBinding, directResolve);
  assert.equal(createIosWdaCaptureSource, directCreate);
  assert.throws(
    () => (resolveSingleIosWdaBinding as (...args: unknown[]) => IosWdaBindingAccess)(undefined),
    fixedTypeError(INVALID_OPTIONS),
  );
  assert.throws(
    () => (resolveSingleIosWdaBinding as (...args: unknown[]) => IosWdaBindingAccess)({}),
    fixedTypeError(INVALID_OPTIONS),
  );
});

await test("returns distinct opaque wrappers for one exact frozen logical-slot snapshot", () => {
  const first = resolveSingleIosWdaBinding();
  const second = resolveSingleIosWdaBinding();
  const snapshot = {
    bindingVersion: 1,
    platform: "ios",
    provider: "wda-mjpeg-v16.15.3",
    slot: "loopback-9100",
  };
  assert.notEqual(first, second);
  assert.deepEqual(first.snapshot, snapshot);
  assert.equal(first.snapshot, second.snapshot);
  assert.equal(Object.isFrozen(first), true);
  assert.equal(Object.isFrozen(first.snapshot), true);
  assert.deepEqual(Reflect.ownKeys(first), ["snapshot"]);
  assert.deepEqual(Object.getOwnPropertySymbols(first), []);
  assert.deepEqual(JSON.parse(JSON.stringify(first)), { snapshot });
  assert.deepEqual(Reflect.ownKeys(first.snapshot), ["bindingVersion", "platform", "provider", "slot"]);
});

await test("ordinary coercion is redacted and disabled custom inspection exposes only the safe snapshot", () => {
  const access = resolveSingleIosWdaBinding();
  assert.equal(String(access), "[REDACTED]");
  assert.equal(`${access}`, "[REDACTED]");
  assert.equal(Number.isNaN(Number(access)), true);
  assert.equal(inspect(access), "[REDACTED]");
  const safe = inspect(access, { customInspect: false });
  assert.match(safe, /bindingVersion: 1/);
  assert.match(safe, /slot: 'loopback-9100'/);
  for (const privateValue of ["http://", "127.0.0.1", "UDID", "Session ID"]) {
    assert.equal(safe.includes(privateValue), false);
  }
});

await test("rejects non-exact factory input, forged access and non-iOS identities before source creation", () => {
  const access = resolveSingleIosWdaBinding();
  const hidden = Object.defineProperty({}, "access", { value: access, enumerable: false });
  const getter = Object.defineProperties({}, {
    access: { get: () => access, enumerable: true },
    deviceRef: { value: deviceRef, enumerable: true },
  });
  const reversed = { deviceRef, access };
  const forged = { snapshot: access.snapshot };
  const prototypeOnly = Object.create(Object.getPrototypeOf(access));
  const invalid: unknown[] = [
    null,
    [],
    {},
    hidden,
    getter,
    reversed,
    { access, deviceRef, extra: true },
    { access: forged, deviceRef },
    { access: prototypeOnly, deviceRef },
    { access: JSON.parse(JSON.stringify(access)), deviceRef },
    { access, deviceRef: { ...deviceRef, platform: "android" } },
    { access, deviceRef: { ...deviceRef, contractVersion: 1 } },
    { access, deviceRef: { ...deviceRef, provider: "wda" } },
  ];
  for (const value of invalid) assert.throws(() => create(value), fixedTypeError(INVALID_SOURCE));
});

await test("rejects the complete iOS DeviceRef descriptor and identity boundary with fixed private-safe errors", () => {
  const access = resolveSingleIosWdaBinding();
  const inherited = Object.create(deviceRef);
  const hidden = { ...deviceRef };
  Object.defineProperty(hidden, "namespace", { value: deviceRef.namespace, enumerable: false });
  const getter = { ...deviceRef };
  Object.defineProperty(getter, "opaqueId", { get: () => "PRIVATE-LOCATOR", enumerable: true });
  const symbol = { ...deviceRef, [Symbol("PRIVATE-LOCATOR")]: true };
  const malformed: unknown[] = [
    inherited,
    hidden,
    getter,
    symbol,
    { platform: deviceRef.platform, namespace: deviceRef.namespace, opaqueId: deviceRef.opaqueId },
    { contractVersion: 2, namespace: deviceRef.namespace, opaqueId: deviceRef.opaqueId },
    { contractVersion: 2, platform: deviceRef.platform, opaqueId: deviceRef.opaqueId },
    { contractVersion: 2, platform: deviceRef.platform, namespace: deviceRef.namespace },
    { ...deviceRef, namespace: "" },
    { ...deviceRef, namespace: "PRIVATE-LOCATOR" },
    { ...deviceRef, opaqueId: "PRIVATE-LOCATOR" },
    { ...deviceRef, opaqueId: "00000000-0000-0000-0000-000000000000" },
    { ...deviceRef, extra: "PRIVATE-LOCATOR" },
  ];
  for (const deviceRefValue of malformed) {
    let thrown: unknown;
    try { create({ access, deviceRef: deviceRefValue }); } catch (error) { thrown = error; }
    assert.equal(fixedTypeError(INVALID_SOURCE)(thrown), true);
    const ordinary = `${String(thrown)} ${inspect(thrown)} ${JSON.stringify(thrown)}`;
    assert.equal(ordinary.includes("PRIVATE-LOCATOR"), false);
    assert.equal(ordinary.includes("127.0.0.1"), false);
  }
});

await test("resolution and valid or invalid source construction touch no sync, async, environment or Capture-open seam", (context) => {
  const require = createRequire(import.meta.url);
  const fs = require("node:fs") as typeof import("node:fs");
  const child = require("node:child_process") as typeof import("node:child_process");
  const dns = require("node:dns") as typeof import("node:dns");
  const http = require("node:http") as typeof import("node:http");
  const https = require("node:https") as typeof import("node:https");
  const net = require("node:net") as typeof import("node:net");
  const calls: string[] = [];
  const deny = (name: string) => (..._args: unknown[]): never => { calls.push(name); throw new Error(`${name} must not run`); };
  const patch = (object: object, name: string, label = name): void => {
    context.mock.method(object as { [key: string]: (...args: unknown[]) => unknown }, name, deny(label));
  };
  for (const name of ["readFileSync", "openSync", "statSync", "existsSync", "readFile", "open", "stat"]) patch(fs, name, `fs.${name}`);
  for (const name of ["readFile", "open", "stat"]) patch(fs.promises, name, `fs.promises.${name}`);
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) patch(child, name, `child.${name}`);
  patch(dns, "lookup", "dns.lookup");
  for (const name of ["request", "get"]) { patch(http, name, `http.${name}`); patch(https, name, `https.${name}`); }
  patch(net.Socket.prototype, "connect", "Socket.connect");
  patch(WdaMjpegCaptureAdapter.prototype, "open", "CaptureSource.open");
  const resources: string[] = [];
  const hook = createHook({ init: (_id, type) => resources.push(type) });
  const originalEnv = process.env;
  const environmentReads: PropertyKey[] = [];
  process.env = new Proxy(originalEnv, {
    get: (target, key, receiver) => { environmentReads.push(key); return Reflect.get(target, key, receiver); },
  });
  try {
    hook.enable();
    const access = resolveSingleIosWdaBinding();
    const source = createIosWdaCaptureSource({ access, deviceRef });
    assert.equal(source instanceof WdaMjpegCaptureAdapter, true);
    assert.throws(() => create({ access, deviceRef: { ...deviceRef, extra: true } }), fixedTypeError(INVALID_SOURCE));
  } finally {
    hook.disable();
    process.env = originalEnv;
  }
  const forbidden = ["FSREQCALLBACK", "FSREQPROMISE", "GETADDRINFOREQWRAP", "PROCESSWRAP", "TCPWRAP", "TCPCONNECTWRAP"];
  assert.deepEqual(resources.filter((type) => forbidden.includes(type)), []);
  assert.deepEqual(environmentReads, []);
  assert.deepEqual(calls, []);
});
await test("constructs the existing WDA CaptureSource without opening its fixed external source", () => {
  const access = resolveSingleIosWdaBinding();
  const input = Object.assign(Object.create(null) as { access: IosWdaBindingAccess; deviceRef: typeof deviceRef }, { access, deviceRef });
  const source = createIosWdaCaptureSource(input);
  assert.equal(source instanceof WdaMjpegCaptureAdapter, true);
  assert.deepEqual(Reflect.ownKeys(input), ["access", "deviceRef"]);
  assert.equal(JSON.stringify(access).includes("127.0.0.1"), false);
  assert.equal(inspect(source).includes("127.0.0.1"), false);
});

await test("factory defensively copies the DeviceRef before later Capture open identity checks", async () => {
  const mutable = { ...deviceRef, namespace: String(deviceRef.namespace) };
  const source = createIosWdaCaptureSource({ access: resolveSingleIosWdaBinding(), deviceRef: mutable });
  mutable.namespace = "changed.private";
  let thrown: unknown;
  try { await source.open({ deviceRef: mutable }); } catch (error) { thrown = error; }
  assert.equal(typeof thrown, "object");
  assert.equal((thrown as { error?: { code?: unknown } }).error?.code, "capture-start-failed");
});
