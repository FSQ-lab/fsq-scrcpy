import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";

interface RunResult { readonly code: number | null; readonly stdout: string; readonly stderr: string }
function run(command: string, args: readonly string[], options: { cwd: string; env?: NodeJS.ProcessEnv }): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env ?? process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }));
  });
}
function npm(args: readonly string[], cwd: string): Promise<RunResult> {
  const cli = process.env.npm_execpath;
  return cli ? run(process.execPath, [cli, ...args], { cwd }) : run("npm", args, { cwd });
}

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
async function readable(path: string): Promise<string | undefined> { try { return await readFile(path, "utf8"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; } }
async function until(read: () => Promise<string | undefined>, accepted: (value: string | undefined) => boolean): Promise<string | undefined> {
  const deadline = performance.now() + 5_000;
  for (;;) { const value = await read(); if (accepted(value)) return value; if (performance.now() >= deadline) throw new Error("Installed CLI signal fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function boundedClose(closed: Promise<number | null>, message: string): Promise<number | null> {
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(message)), 5_000); void closed.then((value) => { clearTimeout(timer); resolve(value); }, (cause: unknown) => { clearTimeout(timer); reject(cause); }); });
}
async function signalInstalled(bin: string, root: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const suffix = signal.toLowerCase(), output = join(root, `${suffix}.stdout`), pidFile = join(root, `${suffix}.pid`), marker = join(root, `${suffix}.marker`);
  const runtime = join(root, "prefix", "node_modules", "fsq-scrcpy", ".build", "runtime", "src");
  await writeFile(join(runtime, "index.js"), "export async function acquireRuntime(){throw new Error('unexpected acquire');}\n");
  await writeFile(join(runtime, "owner.js"), `import {appendFile,writeFile} from "node:fs/promises";\nconst device=Object.freeze({contractVersion:2,platform:"android",namespace:"fsq.android.local",opaqueId:"${DEVICE_ID}"});\nconst status=Object.freeze({ok:true,value:Object.freeze({platform:"android",state:"ready",deviceRef:device,stateRevision:7,runtime:Object.freeze({state:"not-running"})})});\nexport const validateLocalStateStatusResult=value=>value;export const validateResetControlStateResult=value=>value;export const validateRebindDeviceResult=value=>value;\nexport function createRuntimeOwnerLocal(){return Object.freeze({async inspectLocalState(){await writeFile(${JSON.stringify(pidFile)},String(process.pid)+"\\n");return status;},async approveViewerPairing(){throw new Error("unexpected approve");},async shutdownRuntime(){throw new Error("unexpected shutdown");},async resetControlState(){await appendFile(${JSON.stringify(marker)},"mutation\\n");throw new Error("unexpected reset");},async rebindDevice(){await appendFile(${JSON.stringify(marker)},"mutation\\n");throw new Error("unexpected rebind");},async close(){await appendFile(${JSON.stringify(marker)},"close\\n");},async [Symbol.asyncDispose](){await this.close();}});}\n`);
  const command = `exec fsq-scrcpy local-state reset-control --platform android --device-ref ${DEVICE_ID} --json > ${quote(output)}`;
  const pty = join(root, "fsq-pty-helper.py");
  await writeFile(pty, "import errno,os,pty,sys\npid,master=pty.fork()\nif pid==0: os.execvpe('/bin/sh',['/bin/sh','-c',sys.argv[1]],os.environ)\nwhile True:\n try: data=os.read(master,4096)\n except OSError as cause:\n  if cause.errno==errno.EIO: break\n  raise\n if not data: break\n os.write(1,data)\n_,status=os.waitpid(pid,0)\nos.close(master)\ncode=os.waitstatus_to_exitcode(status)\nsys.exit(code if code>=0 else 128-code)\n");
  const child = spawn("/usr/bin/python3", [pty, command], { cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  const terminal: Buffer[] = [], diagnostics: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => terminal.push(chunk)); child.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
  try { await until(async () => Buffer.concat(terminal).toString("utf8"), (value) => value === `Reset android device ${DEVICE_ID} at state revision 7? Type RESET to continue: `); }
  catch (cause) { throw new Error(`Installed ${signal} prompt was not exact: terminal=${JSON.stringify(Buffer.concat(terminal).toString("utf8"))} diagnostics=${JSON.stringify(Buffer.concat(diagnostics).toString("utf8"))}`, { cause }); }
  assert.equal(await readable(marker), undefined, `${signal} mutated before cancellation`);
  const pid = Number((await until(() => readable(pidFile), (value) => /^\d+\n$/.test(value ?? "")))!.trim());
  process.kill(pid, signal);
  const code = await boundedClose(closed, `${signal} did not cleanly settle readline`);
  assert.equal(code, 3, `${signal} helper diagnostics=${JSON.stringify(Buffer.concat(diagnostics).toString("utf8"))} terminal=${JSON.stringify(Buffer.concat(terminal).toString("utf8"))} output=${JSON.stringify(await readable(output))} marker=${JSON.stringify(await readable(marker))}`);
  assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
  assert.equal(Buffer.concat(terminal).toString("utf8"), `Reset android device ${DEVICE_ID} at state revision 7? Type RESET to continue: `);
  assert.deepEqual(JSON.parse((await readFile(output, "utf8")).trim()), { ok: false, error: { controlVersion: { major: 1, minor: 0 }, code: "request-cancelled", disposition: "recoverable", operationState: "not-applied", safeMessage: "The control request was cancelled before it was applied." } });
  assert.equal((await readFile(output, "utf8")).endsWith("\n"), true);
  assert.equal(await readFile(marker, "utf8"), "close\n");
}

async function installWatchFixture(installedRoot: string, log: string): Promise<void> {
  const runtime = join(installedRoot, ".build", "runtime", "src");
  await writeFile(join(runtime, "owner.js"), `
const device = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: "${DEVICE_ID}" });
const status = Object.freeze({ ok: true, value: Object.freeze({ platform: "android", state: "ready", deviceRef: device, stateRevision: 7, runtime: Object.freeze({ state: "not-running" }) }) });
export const validateLocalStateStatusResult = value => value;
export const validateResetControlStateResult = value => value;
export const validateRebindDeviceResult = value => value;
export function createRuntimeOwnerLocal() {
  return Object.freeze({ async inspectLocalState() { return status; }, async close() {}, async [Symbol.asyncDispose]() {} });
}
`);
  await writeFile(join(runtime, "index.js"), `
import { appendFile, writeFile } from "node:fs/promises";
const device = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: "${DEVICE_ID}" });
const stream = "223e4567-e89b-42d3-a456-426614174000";
const target = Object.freeze({ controlVersion: Object.freeze({ major: 1, minor: 0 }), instanceId: "323e4567-e89b-42d3-a456-426614174000", generation: "423e4567-e89b-42d3-a456-426614174000", contractVersion: 2, deviceRef: device, features: Object.freeze(["wait-v1"]) });
const snap = (revision, phase = "demand-pending") => Object.freeze({ streamId: stream, deviceRef: device, revision, phase, ...(phase === "stopped" ? { reason: "explicit-stop" } : {}), activeViewerCount: 0, updatedAt: revision });
const seen = (snapshot, changes = [snapshot], reset = false, timedOut = false) => Object.freeze({ ok: true, value: Object.freeze({ snapshot, changes: Object.freeze(changes), reset, timedOut }) });
const cancelled = Object.freeze({ ok: false, error: Object.freeze({ controlVersion: Object.freeze({ major: 1, minor: 0 }), code: "request-cancelled", disposition: "recoverable", operationState: "not-applied", safeMessage: "The control request was cancelled before it was applied." }) });
export async function acquireRuntime() {
  let calls = 0;
  const control = Object.freeze({
    async inspect() { return seen(snap(1), []); },
    async wait(input, { signal } = {}) {
      await writeFile(${JSON.stringify(`${log}.pid`)}, String(process.pid));
      await appendFile(${JSON.stringify(log)}, JSON.stringify(input) + "\\n");
      if (process.env.FSQ_WATCH_MODE === "cancel") {
        if (signal?.aborted) return cancelled;
        return await new Promise(resolve => {
          const keepAlive = setTimeout(() => resolve(cancelled), 60_000);
          signal.addEventListener("abort", () => { clearTimeout(keepAlive); resolve(cancelled); }, { once: true });
        });
      }
      if (process.env.FSQ_WATCH_MODE === "sequence") {
        calls++;
        if (calls === 1) return seen(snap(input.afterRevision), [], false, true);
        if (calls === 2) return seen(snap(5), [], true, false);
        if (calls === 3) return seen(snap(6));
        return seen(snap(7, "stopped"));
      }
      if (process.env.FSQ_WATCH_MODE === "epipe") await new Promise(resolve => setTimeout(resolve, 25));
      if (process.env.FSQ_WATCH_MODE === "cursor") return seen(snap(input.afterRevision + 1, "stopped"));
      return seen(snap(input.afterRevision + 1));
    },
    async close() { await appendFile(${JSON.stringify(log)}, "close\\n"); },
  });
  return Object.freeze({ ok: true, session: Object.freeze({ attachment: Object.freeze({ disposition: "attached", instance: target }), control, async close() { await control.close(); } }) });
}
`);
}
const sequenceRecords = (value: string): readonly Record<string, unknown>[] => value.split("\u001e").slice(1).map((record) => JSON.parse(record.slice(0, -1)) as Record<string, unknown>);
async function installedSignal(bin: string, root: string, log: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const child = spawn("/bin/sh", ["-c", "exec fsq-scrcpy stream watch --stream-id 223e4567-e89b-42d3-a456-426614174000 --after-revision 1 --json-seq"], { cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FSQ_WATCH_MODE: "cancel" }, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = []; child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, actual) => resolve({ code, signal: actual })); });
  await until(() => readable(log), (value) => value?.includes("afterRevision") === true);
  const pid = Number(await readFile(`${log}.pid`, "utf8"));
  process.kill(pid, signal);
  const closedResult = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`installed watch ${signal} did not settle`)), 5_000); void closed.then((value) => { clearTimeout(timer); resolve(value); }, reject); });
  assert.deepEqual(closedResult, { code: 3, signal: null }, `${signal} log=${JSON.stringify(await readable(log))} stdout=${JSON.stringify(Buffer.concat(output).toString("utf8"))} stderr=${JSON.stringify(Buffer.concat(errors).toString("utf8"))}`);
  const records = sequenceRecords(Buffer.concat(output).toString("utf8"));
  assert.equal(records.length, 1);
  assert.equal((records[0]!.error as Record<string, unknown>).code, "request-cancelled");
  assert.equal(Buffer.concat(errors).toString("utf8"), "");
}
async function installedForce(bin: string, root: string, log: string, first: "SIGINT" | "SIGTERM", second: "SIGINT" | "SIGTERM"): Promise<void> {
  const preload = join(root, `blocked-${first}-${second}.mjs`), blocked = join(root, `blocked-${first}-${second}.marker`);
  await writeFile(preload, `import { appendFileSync } from "node:fs";\nsetInterval(()=>{},60_000);\nprocess.stdout.write=()=>{appendFileSync(${JSON.stringify(blocked)},"write\\n");return false;};\n`);
  await writeFile(log, "");
  const entry = join(root, "prefix", "node_modules", "fsq-scrcpy", ".build", "integrations", "src", "bin.js");
  const child = spawn(process.execPath, [entry, "stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, NODE_OPTIONS: `--import=${preload}`, FSQ_WATCH_MODE: "blocked" }, stdio: ["ignore", "pipe", "pipe"] });
  const output: Buffer[] = [], errors: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, actual) => resolve({ code, signal: actual })); });
  await until(() => readable(blocked), (value) => value === "write\n");
  const pid = Number(await readFile(`${log}.pid`, "utf8"));
  process.kill(pid, first);
  await new Promise((resolve) => setTimeout(resolve, 20));
  process.kill(pid, second);
  const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("second signal did not force termination")), 5_000); void closed.then((value) => { clearTimeout(timer); resolve(value); }, reject); });
  assert.deepEqual(result, { code: null, signal: second });
  assert.equal(Buffer.concat(output).length, 0);
  assert.equal(Buffer.concat(errors).toString("utf8"), "");
}

await test("packed private package installs a shebang executable invoked through PATH", async (context) => {
  const project = process.cwd(), root = await mkdtemp(join(tmpdir(), "fsq-cli-pack-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packed = await npm(["pack", "--json", "--pack-destination", root], project);
  assert.equal(packed.code, 0, packed.stderr);
  const report = JSON.parse(packed.stdout) as readonly [{ filename: string; files: readonly { path: string }[] }];
  assert.equal(report.length, 1);
  const paths = report[0]!.files.map((entry) => entry.path);
  for (const required of [
    ".build/integrations/src/bin.js",
    ".build/integrations/src/cli.js",
    ".build/integrations/src/output.js",
    ".build/runtime/src/owner.js",
    ".build/runtime/src/control-child.js",
    ".build/contracts/src/index.js",
    ".build/capture/src/index.js",
    "modules/viewer/dist/entry.js",
    "modules/viewer/dist/worker.js",
    "modules/viewer/dist/style.css",
  ]) assert.equal(paths.includes(required), true, required);
  assert.equal(paths.some((path) => path.includes("/test/")), false);

  const prefix = join(root, "prefix"), tarball = join(root, report[0]!.filename);
  const installed = await npm(["install", "--prefix", prefix, "--ignore-scripts", "--no-audit", "--no-fund", tarball], project);
  assert.equal(installed.code, 0, installed.stderr);
  const packageRoot = join(prefix, "node_modules", "fsq-scrcpy");
  const metadata = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as Record<string, unknown>;
  assert.equal(metadata.private, true);
  assert.deepEqual(metadata.bin, { "fsq-scrcpy": ".build/integrations/src/bin.js" });
  const entry = await readFile(join(packageRoot, ".build", "integrations", "src", "bin.js"), "utf8");
  assert.equal(entry.startsWith("#!/usr/bin/env node\n"), true);

  const bin = join(prefix, "node_modules", ".bin"), env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PRIVATE_CANARY: "/Users/private/device.json" };
  const invoked = await run("fsq-scrcpy", ["unknown", "command", "--json"], { cwd: root, env });
  assert.equal(invoked.code, 2);
  assert.equal(invoked.stderr, "");
  assert.deepEqual(JSON.parse(invoked.stdout), { ok: false, error: { code: "invalid-cli-syntax", disposition: "usage", operationState: "not-applied", safeMessage: "Invalid command syntax." } });
  assert.equal(invoked.stdout.endsWith("\n"), true);
  assert.equal(invoked.stdout.includes("\n  \""), false);
  assert.equal(invoked.stdout.includes("PRIVATE_CANARY"), false);
  assert.equal(invoked.stdout.includes("/Users/private"), false);

  const watchLog = join(root, "watch.log"); await installWatchFixture(packageRoot, watchLog);
  for (const cursor of [7, 8]) {
    await writeFile(watchLog, "");
    const watched = await run("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", String(cursor), "--json-seq"], { cwd: root, env: { ...env, FSQ_WATCH_MODE: "cursor" } });
    assert.equal(watched.code, 0); assert.equal(watched.stderr, ""); const records = sequenceRecords(watched.stdout); assert.equal(records.length, 1); assert.equal(((records[0]!.value as { snapshot: { revision: number } }).snapshot.revision), cursor + 1);
    assert.equal((await readFile(watchLog, "utf8")).includes(`"afterRevision":${cursor}`), true);
  }
  await writeFile(watchLog, "");
  const sequence = await run("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: { ...env, FSQ_WATCH_MODE: "sequence" } });
  assert.equal(sequence.code, 0);
  assert.equal(sequence.stderr, "");
  const sequenceValues = sequenceRecords(sequence.stdout).map((record) => record.value as { snapshot: { revision: number }; reset: boolean; timedOut: boolean });
  assert.deepEqual(sequenceValues.map((value) => [value.snapshot.revision, value.reset, value.timedOut]), [[1, false, true], [5, true, false], [6, false, false], [7, false, false]]);
  assert.equal(`${sequence.stdout}${sequence.stderr}`.includes("/Users/private"), false);

  await writeFile(watchLog, "");
  const waited = await run("fsq-scrcpy", ["stream", "wait", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "7", "--json"], { cwd: root, env: { ...env, FSQ_WATCH_MODE: "cursor" } });
  assert.equal(waited.code, 0);
  assert.equal(waited.stderr, "");
  assert.equal(((JSON.parse(waited.stdout) as { value: { snapshot: { revision: number } } }).value.snapshot.revision), 8);
  assert.equal((await readFile(watchLog, "utf8")).includes('"waitMs":30000'), true);
  await writeFile(watchLog, ""); await installedSignal(bin, root, watchLog, "SIGINT"); await writeFile(watchLog, ""); await installedSignal(bin, root, watchLog, "SIGTERM");
  for (const [first, second] of [["SIGINT", "SIGINT"], ["SIGTERM", "SIGTERM"], ["SIGINT", "SIGTERM"], ["SIGTERM", "SIGINT"]] as const) await installedForce(bin, root, watchLog, first, second);

  await writeFile(watchLog, "");
  const epipe = spawn("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: { ...env, FSQ_WATCH_MODE: "epipe" }, stdio: ["ignore", "pipe", "pipe"] });
  let firstRecord = Buffer.alloc(0); const diagnostics: Buffer[] = []; epipe.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk)); epipe.stdout.on("data", (chunk: Buffer) => { firstRecord = Buffer.concat([firstRecord, chunk]); if (firstRecord.includes(0x0a)) epipe.stdout.destroy(); });
  const epipeClosed = new Promise<number | null>((resolve, reject) => { epipe.once("error", reject); epipe.once("close", resolve); });
  assert.equal(await boundedClose(epipeClosed, "installed watch did not classify EPIPE"), 3); assert.equal(sequenceRecords(firstRecord.subarray(0, firstRecord.indexOf(0x0a) + 1).toString("utf8")).length, 1); assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
  await signalInstalled(bin, root, "SIGINT");
  await signalInstalled(bin, root, "SIGTERM");
});
