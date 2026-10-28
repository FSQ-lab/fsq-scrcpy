import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspect } from "node:util";
import test from "node:test";
import { ArtifactError, type VerifiedArtifact } from "../src/artifact/index.js";
import {
  bindingInternals,
  resolveSingleAndroidBinding,
  revealAndroidBinding,
  type AndroidBindingAccess,
  type AndroidBindingErrorCode,
  type AndroidBindingResult,
} from "../src/android/binding.js";
import {
  resolveSingleAndroidBinding as exportedResolve,
  revealAndroidBinding as exportedReveal,
} from "../src/index.js";

type Hooks = Parameters<typeof bindingInternals.resolve>[1];
type CommandCall = Readonly<{
  serial: string | undefined;
  args: readonly string[];
  timeout: number;
  failure: AndroidBindingErrorCode;
  signal: AbortSignal | undefined;
}>;

type Fixture = Readonly<{
  hooks: Hooks;
  commands: CommandCall[];
  paths: string[];
  prepared: string[];
  acquisitions: Readonly<{ root: string; source: unknown; signal: AbortSignal | undefined }>[];
}>;

const ARTIFACT = {} as VerifiedArtifact;
const VERSION = "Android Debug Bridge version 1.0.41\n";
const DEVICES = "List of devices attached\nSERIAL-PRIVATE device usb:1 product:test\n";
const CACHE_ROOT = "/Users/owner/Library/Caches/FSQ_scrcpy";

function fixture(
  overrides: Partial<Hooks> = {},
  output: Readonly<{ version?: string; devices?: string; state?: string }> = {},
): Fixture {
  const commands: CommandCall[] = [];
  const paths: string[] = [];
  const prepared: string[] = [];
  const acquisitions: { root: string; source: unknown; signal: AbortSignal | undefined }[] = [];
  const hooks: Hooks = {
    path: () => "/first:/second",
    now: () => 1_798_000_000_123,
    homedir: () => "/Users/owner",
    realpath: async (path) => {
      paths.push(path);
      if (path === "/first/adb") throw new Error("missing private path");
      return "/canonical/platform-tools/adb";
    },
    lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false }),
    access: async () => undefined,
    createAdb: () => ({
      run: async (serial, args, timeout, failure, signal) => {
        commands.push({ serial, args, timeout, failure, signal });
        if (args[0] === "version") return { stdout: output.version ?? VERSION, stderr: "private version stderr" };
        if (args[0] === "devices") return { stdout: output.devices ?? DEVICES, stderr: "private devices stderr" };
        return { stdout: output.state ?? "device\n", stderr: "private state stderr" };
      },
    }),
    prepareCacheRoot: async (path) => {
      prepared.push(path);
    },
    acquire: async (root, source, signal) => {
      acquisitions.push({ root, source, signal });
      return ARTIFACT;
    },
    ...overrides,
  };
  return { hooks, commands, paths, prepared, acquisitions };
}

async function success(run: Promise<AndroidBindingResult>): Promise<AndroidBindingAccess> {
  const result = await run;
  assert.equal(result.ok, true);
  if (!result.ok) throw new Error("expected binding success");
  assert.deepEqual(Object.keys(result), ["ok", "value"]);
  assert.deepEqual(Object.keys(result.value), ["access"]);
  return result.value.access;
}

async function fails(
  run: Promise<AndroidBindingResult>,
  code: AndroidBindingErrorCode,
  forbidden: readonly string[] = ["SERIAL-PRIVATE", "/canonical", "/Users/owner"],
): Promise<void> {
  const result = await run;
  assert.equal(result.ok, false);
  if (result.ok) throw new Error("expected binding failure");
  assert.deepEqual(result, {
    ok: false,
    error: { code, safeMessage: bindingInternals.safeMessages[code] },
  });
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.error), true);
  const ordinary = `${JSON.stringify(result)} ${inspect(result)}`;
  for (const privateValue of forbidden) assert.equal(ordinary.includes(privateValue), false);
}

await test("exports only the production resolver and reveal identities through Capture", () => {
  assert.equal(exportedResolve, resolveSingleAndroidBinding);
  assert.equal(exportedReveal, revealAndroidBinding);
  assert.deepEqual(Object.keys(bindingInternals.safeMessages), [
    "dependency-unavailable",
    "adb-incompatible",
    "device-not-found",
    "device-ambiguous",
    "device-unavailable",
    "artifact-unavailable",
    "artifact-mismatch",
  ]);
});

await test("validates the exact options shape synchronously before PATH, time, pre-abort, or I/O", () => {
  let touched = 0; const signal = AbortSignal.abort(), base = fixture({ path: () => { touched += 1; throw new Error("must not read PATH"); }, now: () => { touched += 1; return 0; } });
  const hidden = {}, getter = {}, symbol = { [Symbol("private")]: true }, custom = Object.create({ inherited: true }) as { signal?: AbortSignal }, revoked = Proxy.revocable({}, {});
  Object.defineProperty(hidden, "signal", { value: signal, enumerable: false }); Object.defineProperty(getter, "signal", { get: () => signal, enumerable: true }); custom.signal = signal; revoked.revoke();
  const invalid: unknown[] = [null, [], new Date(), custom, { signal: undefined }, { signal: {} }, { signal, extra: true }, hidden, getter, symbol, revoked.proxy];
  for (const value of invalid) assert.throws(() => bindingInternals.resolve(value, base.hooks), (error: unknown) => error instanceof TypeError && error.message === "Invalid Android binding options");
  assert.throws(() => (resolveSingleAndroidBinding as (value: unknown) => Promise<AndroidBindingResult>)({ extra: true }), (error: unknown) => error instanceof TypeError && error.message === "Invalid Android binding options");
  assert.equal(touched, 0);
});

await test("accepts absent, empty, null-prototype, and native AbortSignal option values", async () => {
  await success(bindingInternals.resolve(undefined, fixture().hooks));
  await success(bindingInternals.resolve({}, fixture().hooks));
  await success(bindingInternals.resolve(Object.create(null), fixture().hooks));
  const controller = new AbortController();
  const nullOptions = Object.assign(Object.create(null) as { signal: AbortSignal }, { signal: controller.signal });
  await success(bindingInternals.resolve(nullOptions, fixture().hooks));
});

await test("returns pre-abort as safe device-unavailable without filesystem or child work", async () => {
  const controller = new AbortController();
  controller.abort();
  let filesystem = 0;
  const value = fixture({
    realpath: async () => {
      filesystem += 1;
      return "/never";
    },
  });
  await fails(bindingInternals.resolve({ signal: controller.signal }, value.hooks), "device-unavailable");
  assert.equal(filesystem, 0);
  assert.deepEqual(value.commands, []);
  assert.deepEqual(value.prepared, []);
});

await test("snapshots PATH and observedAt once before the first await", async () => {
  let currentPath = "/initial";
  let now = 10;
  const seen: string[] = [];
  const value = fixture({
    path: () => currentPath,
    now: () => now,
    realpath: async (path) => {
      seen.push(path);
      currentPath = "/mutated";
      now = 20;
      return "/canonical/adb";
    },
  });
  const access = await success(bindingInternals.resolve({}, value.hooks));
  assert.deepEqual(seen, ["/initial/adb"]);
  assert.equal(access.snapshot.observedAt, 10);
});

await test("accepts only safe-integer nonnegative observedAt boundaries before filesystem or child I/O", async () => {
  for (const observedAt of [0, Number.MAX_SAFE_INTEGER]) assert.equal((await success(bindingInternals.resolve({}, fixture({ now: () => observedAt }).hooks))).snapshot.observedAt, observedAt);
  for (const observedAt of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    const value = fixture({ now: () => observedAt }); await fails(bindingInternals.resolve({}, value.hooks), "device-unavailable");
    assert.deepEqual([value.paths, value.commands, value.prepared, value.acquisitions], [[], [], [], []]);
  }
});

await test("maps observedAt provider failure to fixed device-unavailable before I/O", async () => {
  const value = fixture({ now: () => { throw new Error("private clock detail"); } }); await fails(bindingInternals.resolve({}, value.hooks), "device-unavailable"); assert.deepEqual([value.paths, value.commands], [[], []]);
});

await test("ignores empty and relative PATH entries, canonicalizes a final symlink, and stops at the first executable", async () => {
  const candidates: string[] = [];
  const stats: string[] = [];
  const executions: string[] = [];
  const value = fixture({
    path: () => ":relative:/missing:/linked:/later:/linked",
    realpath: async (path) => {
      candidates.push(path);
      if (path === "/missing/adb") throw new Error("missing");
      if (path === "/linked/adb") return "/real/platform-tools/adb";
      return "/must-not-be-read";
    },
    lstat: async (path) => {
      stats.push(path);
      return { isFile: () => true, isSymbolicLink: () => false };
    },
    access: async (path, mode) => {
      executions.push(`${path}:${mode}`);
    },
  });
  const access = await success(bindingInternals.resolve({}, value.hooks));
  assert.deepEqual(candidates, ["/missing/adb", "/linked/adb"]);
  assert.deepEqual(stats, ["/real/platform-tools/adb"]);
  assert.equal(executions.length, 1);
  assert.equal(revealAndroidBinding(access).adbPath, "/real/platform-tools/adb");
});

await test("skips directories, canonical symlinks, and non-executable targets before selecting a later candidate", async () => {
  const value = fixture({
    path: () => "/directory:/symlink:/denied:/good",
    realpath: async (path) => `${path}-canonical`,
    lstat: async (path) => ({
      isFile: () => !path.startsWith("/directory"),
      isSymbolicLink: () => path.startsWith("/symlink"),
    }),
    access: async (path) => {
      if (path.startsWith("/denied")) throw new Error("EACCES /private/path");
    },
  });
  const access = await success(bindingInternals.resolve({}, value.hooks));
  assert.equal(revealAndroidBinding(access).adbPath, "/good/adb-canonical");
});

await test("maps no valid absolute executable to dependency-unavailable", async () => {
  const value = fixture({
    path: () => ":relative:/missing:/denied",
    realpath: async (path) => {
      if (path.startsWith("/missing")) throw new Error(path);
      return path;
    },
    access: async () => {
      throw new Error("not executable");
    },
  });
  await fails(bindingInternals.resolve({}, value.hooks), "dependency-unavailable");
  assert.deepEqual(value.commands, []);
});

await test("checks cancellation after every S0 filesystem await and performs no later I/O", async () => {
  for (const stage of ["realpath", "lstat", "access"] as const) {
    const controller = new AbortController();
    let calls = 0;
    const value = fixture({
      path: () => "/only:/later",
      realpath: async (path) => {
        calls += 1;
        if (stage === "realpath") controller.abort();
        return path;
      },
      lstat: async () => {
        calls += 1;
        if (stage === "lstat") controller.abort();
        return { isFile: () => true, isSymbolicLink: () => false };
      },
      access: async () => {
        calls += 1;
        if (stage === "access") controller.abort();
      },
    });
    await fails(bindingInternals.resolve({ signal: controller.signal }, value.hooks), "device-unavailable");
    assert.equal(calls, stage === "realpath" ? 1 : stage === "lstat" ? 2 : 3);
    assert.deepEqual(value.commands, []);
  }
});

await test("uses only version, devices -l, and selected-serial get-state with five-second deadlines", async () => {
  const value = fixture();
  const access = await success(bindingInternals.resolve({}, value.hooks));
  assert.deepEqual(value.commands.map(({ serial, args, timeout, failure }) => ({ serial, args, timeout, failure })), [
    { serial: undefined, args: ["version"], timeout: 5_000, failure: "adb-incompatible" },
    { serial: undefined, args: ["devices", "-l"], timeout: 5_000, failure: "device-unavailable" },
    { serial: "SERIAL-PRIVATE", args: ["get-state"], timeout: 5_000, failure: "device-unavailable" },
  ]);
  const commandText = value.commands.flatMap((call) => call.args).join(" ");
  for (const forbidden of ["shell", "push", "reverse", "forward", "start-server", "kill-server"])
    assert.equal(commandText.includes(forbidden), false);
  assert.equal(revealAndroidBinding(access).serial, "SERIAL-PRIVATE");
});

await test("canonicalizes exact LF/CRLF ADB semantic versions and ignores later ASCII lines", async () => {
  const cases = [
    ["Android Debug Bridge version 0.0.0\n", "0.0.0"],
    ["Android Debug Bridge version 1.0.41\r\nVersion 36.0.0-13206524\r\n", "1.0.41"],
    ["Android Debug Bridge version 65535.65535.65535\nInstalled as /private/path\n", "65535.65535.65535"],
  ] as const;
  for (const [stdout, expected] of cases) {
    const access = await success(bindingInternals.resolve({}, fixture({}, { version: stdout }).hooks));
    assert.equal(access.snapshot.adbVersion, expected);
    assert.equal(JSON.stringify(access).includes("Installed as"), false);
  }
});

await test("rejects malformed, non-ASCII, noncanonical, out-of-range, and overflowed ADB version output", async () => {
  const invalid = [
    "",
    "prefix Android Debug Bridge version 1.0.41\n",
    "Android Debug Bridge version 1.0.41 suffix\n",
    "Android Debug Bridge version 01.0.41\n",
    "Android Debug Bridge version 1.00.41\n",
    "Android Debug Bridge version 65536.0.0\n",
    "Android Debug Bridge version 123456.0.0\n",
    "Android Debug Bridge version 1.0\n",
    "Android Debug Bridge version 1.0.41\rtrailing\n",
    "Android Debug Bridge version 1.0.41\nnon-ascii-é\n",
    "Android Debug Bridge version 1.0.41\ufffd\n",
  ];
  for (const stdout of invalid) {
    const value = fixture({}, { version: stdout });
    await fails(bindingInternals.resolve({}, value.hooks), "adb-incompatible");
    assert.equal(value.commands.length, 1);
  }
  const overflow = fixture({
    createAdb: () => ({
      run: async () => {
        throw new Error(`bounded stdout ${Buffer.alloc(64 * 1024 + 1).byteLength}`);
      },
    }),
  });
  await fails(bindingInternals.resolve({}, overflow.hooks), "adb-incompatible");
});

await test("classifies raw nonempty device-row cardinality before state selection", async () => {
  const cases = [
    ["List of devices attached\n", "device-not-found"],
    ["List of devices attached\r\n\r\n", "device-not-found"],
    ["List of devices attached\nSERIAL-PRIVATE offline\n", "device-unavailable"],
    ["List of devices attached\nSERIAL-PRIVATE unauthorized usb:1\n", "device-unavailable"],
    ["List of devices attached\n   \n", "device-unavailable"],
    ["List of devices attached\nSERIAL-PRIVATE device\nSECOND offline\n", "device-ambiguous"],
    ["List of devices attached\nSERIAL-PRIVATE offline\nSECOND device\n", "device-ambiguous"],
  ] as const;
  for (const [devices, code] of cases) {
    const value = fixture({}, { devices });
    await fails(bindingInternals.resolve({}, value.hooks), code);
    assert.equal(value.commands.some((call) => call.args[0] === "get-state"), false);
  }
});

await test("admits only a nonempty printable ASCII serial of at most 256 bytes", async () => {
  const maximum = "S".repeat(256);
  const accepted = fixture({}, { devices: `List of devices attached\n${maximum} device usb:1\n` });
  const access = await success(bindingInternals.resolve({}, accepted.hooks));
  assert.equal(revealAndroidBinding(access).serial, maximum);
  const invalid = ["S".repeat(257), "bad\u0001serial", "bad\u007fserial", "bad\u0080serial", "sérial"];
  for (const serial of invalid) {
    const value = fixture({}, { devices: `List of devices attached\n${serial} device\n` });
    await fails(bindingInternals.resolve({}, value.hooks), "adb-incompatible", [serial]);
    assert.equal(value.commands.length, 2);
  }
});

await test("requires canonical get-state device output and rejects every mismatch safely", async () => {
  for (const state of ["device", "device\n", "device\r\n"])
    await success(bindingInternals.resolve({}, fixture({}, { state }).hooks));
  for (const state of ["", "offline\n", "unauthorized\n", " device\n", "device \n", "device\nextra\n"])
    await fails(bindingInternals.resolve({}, fixture({}, { state }).hooks), "device-unavailable");
});

await test("checks cancellation after every S1 child wait and never advances to another command", async () => {
  for (const target of ["version", "devices", "get-state"] as const) {
    const controller = new AbortController();
    let value!: Fixture;
    value = fixture({
      createAdb: () => ({
        run: async (serial, args, timeout, failure, signal) => {
          value.commands.push({ serial, args, timeout, failure, signal });
          const result = args[0] === "version"
            ? { stdout: VERSION, stderr: "" }
            : args[0] === "devices"
              ? { stdout: DEVICES, stderr: "" }
              : { stdout: "device\n", stderr: "" };
          if (args[0] === target) controller.abort();
          return result;
        },
      }),
    });
    await fails(bindingInternals.resolve({ signal: controller.signal }, value.hooks), "device-unavailable");
    assert.equal(value.commands.at(-1)?.args[0], target);
    assert.equal(value.commands.length, target === "version" ? 1 : target === "devices" ? 2 : 3);
    assert.deepEqual(value.prepared, []);
  }
});

await test("S1 cancellation wins over provider failure only after the owned command settles", async () => {
  const controller = new AbortController();
  let settled = false;
  const value = fixture({
    createAdb: () => ({
      run: async () => {
        controller.abort();
        await Promise.resolve();
        settled = true;
        throw new Error("private child cleanup failure");
      },
    }),
  });
  await fails(bindingInternals.resolve({ signal: controller.signal }, value.hooks), "device-unavailable");
  assert.equal(settled, true);
});

await test("builds only the fixed macOS cache root and fixed online artifact source", async () => {
  const controller = new AbortController();
  const value = fixture();
  const access = await success(bindingInternals.resolve({ signal: controller.signal }, value.hooks));
  assert.deepEqual(value.prepared, [CACHE_ROOT]);
  assert.equal(value.acquisitions.length, 1);
  assert.deepEqual(value.acquisitions[0], { root: CACHE_ROOT, source: { mode: "online" }, signal: controller.signal });
  assert.deepEqual(revealAndroidBinding(access).artifactSource, { mode: "online" });
});

await test("creates and validates the real private cache root under a restrictive umask", async (context) => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "fsq-binding-cache-")), cacheRoot = join(base, "cache"); context.after(() => rm(base, { recursive: true, force: true }));
  const previous = process.umask(0o777); try { await bindingInternals.prepareCacheRoot(cacheRoot); } finally { process.umask(previous); }
  const created = await lstat(cacheRoot); assert.equal(created.isDirectory(), true); assert.equal(created.isSymbolicLink(), false); assert.equal(created.uid, process.geteuid?.()); assert.equal(created.mode & 0o7777, 0o700);
  await bindingInternals.prepareCacheRoot(cacheRoot); assert.equal((await lstat(cacheRoot)).mode & 0o7777, 0o700);
});

await test("rejects unsafe existing cache directories and links without replacing or deleting them", async (context) => {
  const base = await mkdtemp(join(await realpath(tmpdir()), "fsq-binding-cache-unsafe-")), loose = join(base, "loose"); context.after(() => rm(base, { recursive: true, force: true })); await mkdir(loose, { mode: 0o700 }); await chmod(loose, 0o750);
  const safeFailure = (error: unknown): boolean => error instanceof Error && error.message === "Artifact is unavailable" && !error.message.includes(base);
  await assert.rejects(bindingInternals.prepareCacheRoot(loose), safeFailure); assert.equal((await lstat(loose)).isDirectory(), true); assert.equal((await lstat(loose)).mode & 0o7777, 0o750);
  const target = join(base, "target"), linked = join(base, "linked"); await mkdir(target, { mode: 0o700 }); await symlink(target, linked); await assert.rejects(bindingInternals.prepareCacheRoot(linked), safeFailure); assert.equal((await lstat(linked)).isSymbolicLink(), true);
});

await test("checks S2 cache-root cancellation after every await and removes only a new unvalidated directory", async () => {
  type CacheHooks = NonNullable<Parameters<typeof bindingInternals.prepareCacheRoot>[2]>;
  for (const stage of ["realpath", "parent-lstat", "mkdir", "chmod", "final-lstat"] as const) {
    const controller = new AbortController(), events: string[] = []; let lstatCalls = 0;
    const hooks: CacheHooks = {
      realpath: async (path) => { events.push("realpath"); if (stage === "realpath") controller.abort(); return path; },
      lstat: async () => { const label = ++lstatCalls === 1 ? "parent-lstat" : "final-lstat"; events.push(label); if (stage === label) controller.abort(); return { isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o40700 }; },
      mkdir: async () => { events.push("mkdir"); if (stage === "mkdir") controller.abort(); }, chmod: async (_path, mode) => { events.push(`chmod:${mode.toString(8)}`); if (stage === "chmod") controller.abort(); }, rmdir: async () => { events.push("cleanup-rmdir"); }, euid: () => 501,
    };
    await assert.rejects(bindingInternals.prepareCacheRoot("/safe/cache", controller.signal, hooks), (error: unknown) => error instanceof Error && error.message === "Artifact is unavailable");
    const expected = stage === "realpath" ? ["realpath"] : stage === "parent-lstat" ? ["realpath", "parent-lstat"] : stage === "mkdir" ? ["realpath", "parent-lstat", "mkdir", "cleanup-rmdir"] : stage === "chmod" ? ["realpath", "parent-lstat", "mkdir", "chmod:700", "cleanup-rmdir"] : ["realpath", "parent-lstat", "mkdir", "chmod:700", "final-lstat", "cleanup-rmdir"];
    assert.deepEqual(events, expected);
  }
});

await test("rolls back a newly created cache root that fails final identity validation", async () => {
  const events: string[] = [], hooks: NonNullable<Parameters<typeof bindingInternals.prepareCacheRoot>[2]> = { realpath: async (path) => path, lstat: async (path) => ({ isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: path === "/safe/cache" ? 0o40750 : 0o40700 }), mkdir: async () => { events.push("mkdir"); }, chmod: async () => { events.push("chmod"); }, rmdir: async () => { events.push("cleanup-rmdir"); }, euid: () => 501 };
  await assert.rejects(bindingInternals.prepareCacheRoot("/safe/cache", undefined, hooks), (error: unknown) => error instanceof Error && error.message === "Artifact is unavailable"); assert.deepEqual(events, ["mkdir", "chmod", "cleanup-rmdir"]);
});

await test("never removes an EEXIST cache root when cancellation follows the mkdir boundary", async () => {
  const controller = new AbortController(), events: string[] = [], exists = Object.assign(new Error("exists private path"), { code: "EEXIST" });
  const hooks: NonNullable<Parameters<typeof bindingInternals.prepareCacheRoot>[2]> = { realpath: async (path) => { events.push("realpath"); return path; }, lstat: async () => { events.push("parent-lstat"); return { isDirectory: () => true, isSymbolicLink: () => false, uid: 501, mode: 0o40700 }; }, mkdir: async () => { events.push("mkdir"); controller.abort(); throw exists; }, chmod: async () => { events.push("chmod"); }, rmdir: async () => { events.push("cleanup-rmdir"); }, euid: () => 501 };
  await assert.rejects(bindingInternals.prepareCacheRoot("/safe/cache", controller.signal, hooks)); assert.deepEqual(events, ["realpath", "parent-lstat", "mkdir"]);
});

await test("maps cache preparation and online acquisition failures to fixed artifact errors", async () => {
  const prepare = fixture({
    prepareCacheRoot: async () => {
      throw new Error("/Users/owner/private/cache");
    },
  });
  await fails(bindingInternals.resolve({}, prepare.hooks), "artifact-unavailable");
  assert.deepEqual(prepare.acquisitions, []);

  const unavailable = fixture({
    acquire: async () => {
      throw new ArtifactError("artifact-unavailable", "private network URL");
    },
  });
  await fails(bindingInternals.resolve({}, unavailable.hooks), "artifact-unavailable");

  const mismatch = fixture({
    acquire: async () => {
      throw new ArtifactError("artifact-mismatch", "private cache path");
    },
  });
  await fails(bindingInternals.resolve({}, mismatch.hooks), "artifact-mismatch");
});

await test("S2 cancellation waits for artifact cleanup and overrides mismatch or cleanup details", async () => {
  for (const point of ["prepare", "acquire"] as const) {
    const controller = new AbortController();
    let cleanupFinished = false;
    const value = fixture({
      prepareCacheRoot: async () => {
        if (point === "prepare") controller.abort();
      },
      acquire: async () => {
        controller.abort();
        await Promise.resolve();
        cleanupFinished = true;
        if (point === "acquire") throw new ArtifactError("artifact-mismatch", "private path");
        return ARTIFACT;
      },
    });
    await fails(bindingInternals.resolve({ signal: controller.signal }, value.hooks), "artifact-unavailable");
    assert.equal(cleanupFinished, point === "acquire");
  }
});

await test("preserves an already-settled artifact mismatch when the adjacent abort check is clear", async () => {
  const value = fixture({
    acquire: async () => {
      throw new ArtifactError("artifact-mismatch", "private signer detail");
    },
  });
  await fails(bindingInternals.resolve({ signal: new AbortController().signal }, value.hooks), "artifact-mismatch");
});

await test("allows independent calls to reach the shared artifact seam concurrently without a product mutex", async () => {
  let entered = 0, both!: () => void, release!: () => void; const bothEntered = new Promise<void>((done) => { both = done; }), released = new Promise<void>((done) => { release = done; });
  const value = fixture({ acquire: async () => { entered += 1; if (entered === 2) both(); await released; return ARTIFACT; } });
  const first = bindingInternals.resolve({}, value.hooks), second = bindingInternals.resolve({}, value.hooks); await bothEntered; assert.equal(entered, 2); release();
  const accesses = await Promise.all([success(first), success(second)]); assert.notEqual(accesses[0], accesses[1]); assert.equal(revealAndroidBinding(accesses[0]!).serial, "SERIAL-PRIVATE");
});

await test("creates an exact deeply frozen safe snapshot and a deeply frozen private reveal value", async () => {
  const access = await success(bindingInternals.resolve({}, fixture().hooks)); assert.deepEqual(access.snapshot, { bindingVersion: 1, platform: "android", provider: "scrcpy-v5.0.1", adbVersion: "1.0.41", artifactVersion: "5.0.1", artifactSha256: "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536", observedAt: 1_798_000_000_123 });
  assert.equal(Object.isFrozen(access), true); assert.equal(Object.isFrozen(access.snapshot), true); const privateValue = revealAndroidBinding(access);
  assert.deepEqual(privateValue, { serial: "SERIAL-PRIVATE", adbPath: "/canonical/platform-tools/adb", cacheRoot: CACHE_ROOT, artifactSource: { mode: "online" } }); assert.equal(Object.isFrozen(privateValue), true); assert.equal(Object.isFrozen(privateValue.artifactSource), true); assert.equal(revealAndroidBinding(access), privateValue);
});

await test("exposes snapshot as the wrapper's only enumerable or symbol-visible own property", async () => {
  const access = await success(bindingInternals.resolve({}, fixture().hooks));
  assert.deepEqual(Object.keys(access), ["snapshot"]);
  assert.deepEqual(Reflect.ownKeys(access), ["snapshot"]);
  assert.deepEqual(Object.getOwnPropertySymbols(access), []);
  assert.deepEqual({ ...access }, { snapshot: access.snapshot });
  assert.equal(Object.prototype.propertyIsEnumerable.call(access, "snapshot"), true);
  assert.equal(Object.prototype.hasOwnProperty.call(access, "toJSON"), false);
  assert.equal(Object.prototype.hasOwnProperty.call(access, Symbol.toPrimitive), false);
});

await test("redacts string, default primitive, Node inspect, and ordinary JSON serialization", async () => {
  const access = await success(bindingInternals.resolve({}, fixture().hooks));
  assert.equal(access.toString(), "[REDACTED]");
  assert.equal(String(access), "[REDACTED]");
  assert.equal(`${access}`, "[REDACTED]");
  assert.equal((access as unknown as string) + "", "[REDACTED]");
  assert.equal(inspect(access), "[REDACTED]");
  assert.deepEqual(access.toJSON(), { snapshot: access.snapshot });
  const json = JSON.stringify(access);
  assert.equal(json, JSON.stringify({ snapshot: access.snapshot }));
  for (const forbidden of ["SERIAL-PRIVATE", "/canonical", CACHE_ROOT, "mode"])
    assert.equal(json.includes(forbidden), false);
});

await test("rejects every foreign, forged, inherited, and proxied reveal value synchronously", async () => {
  const access = await success(bindingInternals.resolve({}, fixture().hooks));
  const forged = Object.freeze({ snapshot: access.snapshot });
  const inherited = Object.create(access) as AndroidBindingAccess;
  const proxied = new Proxy(access, {});
  const invalid: unknown[] = [undefined, null, 0, "", {}, forged, inherited, proxied, () => undefined];
  for (const value of invalid) {
    assert.throws(
      () => revealAndroidBinding(value as AndroidBindingAccess),
      (error: unknown) => error instanceof TypeError && error.message === "Invalid Android binding access",
    );
  }
});

await test("keeps the private-field reveal closure unreachable through constructor reflection", async () => {
  const access = await success(bindingInternals.resolve({}, fixture().hooks)), Constructor = access.constructor, privateValue = revealAndroidBinding(access);
  assert.equal(Object.getPrototypeOf(access).constructor, Constructor); assert.equal((Constructor as unknown as { reveal?: unknown }).reveal, undefined); assert.equal(Reflect.ownKeys(Constructor).includes("reveal"), false);
  for (const token of [{}, Object.freeze({}), Symbol("forged"), undefined]) for (const newTarget of [Constructor, function Forged() {}]) assert.throws(() => Reflect.construct(Constructor, [token, access.snapshot, privateValue], newTarget), (error: unknown) => error instanceof TypeError && error.message === "Invalid Android binding access");
  const forged = Object.create(Object.getPrototypeOf(access)) as AndroidBindingAccess; assert.throws(() => revealAndroidBinding(forged), (error: unknown) => error instanceof TypeError && error.message === "Invalid Android binding access");
});

await test("linearizes success at S3 access creation so a later abort cannot replace it", async () => {
  const controller = new AbortController();
  let created: AndroidBindingAccess | undefined;
  const value = fixture({
    afterAccess: (access) => {
      created = access;
      controller.abort();
    },
  });
  const access = await success(bindingInternals.resolve({ signal: controller.signal }, value.hooks));
  assert.equal(access, created);
  assert.equal(controller.signal.aborted, true);
  assert.equal(revealAndroidBinding(access).serial, "SERIAL-PRIVATE");
});

await test("does not retain provider artifact DTOs or emit serial, paths, stderr, or artifact locators", async () => {
  const privateArtifact = {
    identity: { assetUrl: "https://private.invalid/artifact" },
    path: "/private/artifact/path",
    metadata: { source: "private-provider-source" },
  } as unknown as VerifiedArtifact;
  const value = fixture({ acquire: async () => privateArtifact });
  const access = await success(bindingInternals.resolve({}, value.hooks));
  const ordinary = [JSON.stringify(access), inspect(access), String(access), JSON.stringify(access.snapshot)].join(" ");
  for (const forbidden of [
    "SERIAL-PRIVATE",
    "/canonical/platform-tools/adb",
    CACHE_ROOT,
    "/private/artifact/path",
    "private-provider-source",
    "private version stderr",
    "private devices stderr",
    "private state stderr",
  ]) assert.equal(ordinary.includes(forbidden), false);
});
