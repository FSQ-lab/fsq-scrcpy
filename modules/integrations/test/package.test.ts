import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
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
const STREAM_ID = "223e4567-e89b-42d3-a456-426614174000";
const quote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;
async function readable(path: string): Promise<string | undefined> { try { return await readFile(path, "utf8"); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; } }
async function until(read: () => Promise<string | undefined>, accepted: (value: string | undefined) => boolean): Promise<string | undefined> {
  const deadline = performance.now() + 5_000;
  for (;;) { const value = await read(); if (accepted(value)) return value; if (performance.now() >= deadline) throw new Error("Installed process fixture timed out"); await new Promise((resolve) => setTimeout(resolve, 10)); }
}
async function boundedClose(closed: Promise<number | null>, message: string): Promise<number | null> {
  return await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(message)), 5_000); void closed.then((value) => { clearTimeout(timer); resolve(value); }, (cause: unknown) => { clearTimeout(timer); reject(cause); }); });
}
async function installFixtureLoader(root: string): Promise<void> {
  await writeFile(join(root, "runtime-loader.mjs"), `import {readFile} from "node:fs/promises";
export async function load(url,context,nextLoad){
 const fixture=url.endsWith("/.build/runtime/src/index.js")?process.env.FSQ_RUNTIME_INDEX:url.endsWith("/.build/runtime/src/owner.js")?process.env.FSQ_RUNTIME_OWNER:undefined;
 return fixture?{format:"module",shortCircuit:true,source:await readFile(fixture,"utf8")}:nextLoad(url,context);
}
`);
  await writeFile(join(root, "runtime-register.mjs"), `import {register} from "node:module";register("./runtime-loader.mjs",import.meta.url);\n`);
}
function fixtureEnv(root: string, index?: string, owner?: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const preload = `--import=${pathToFileURL(join(root, "runtime-register.mjs")).href}`;
  return { ...process.env, NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "), ...(index ? { FSQ_RUNTIME_INDEX: index } : {}), ...(owner ? { FSQ_RUNTIME_OWNER: owner } : {}), ...extra };
}
async function treeHash(root: string): Promise<string> {
  const files: string[] = [];
  const walk = async (relative: string): Promise<void> => {
    for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
      const path = join(relative, entry.name);
      if (entry.isDirectory()) await walk(path); else if (entry.isFile() || entry.isSymbolicLink()) files.push(path);
    }
  };
  await walk("");
  const hash = createHash("sha256");
  for (const path of files.sort()) hash.update(path).update("\0").update(await readFile(join(root, path))).update("\0");
  return hash.digest("hex");
}
async function installMcpFixture(root: string): Promise<{ index: string; log: string }> {
  const index = join(root, "mcp-runtime.mjs"), log = join(root, "mcp-runtime.log");
  await writeFile(log, "");
  await writeFile(index, `import {appendFileSync} from "node:fs";
const log=process.env.FSQ_FIXTURE_LOG,note=value=>appendFileSync(log,value+"\\n"),device=Object.freeze({contractVersion:2,platform:"android",namespace:"fsq.android.local",opaqueId:"${DEVICE_ID}"}),streamId="${STREAM_ID}";
note("load:"+process.pid);process.once("exit",()=>note("exit:"+process.pid));
const snap=(revision=1)=>Object.freeze({streamId,deviceRef:device,revision,phase:"demand-pending",activeViewerCount:0,updatedAt:revision});
const observed=(revision=1)=>({ok:true,value:{snapshot:snap(revision),changes:[snap(revision)],reset:false,timedOut:false}}),revisionError={controlVersion:{major:1,minor:0},code:"revision-conflict",disposition:"recoverable",operationState:"not-applied",safeMessage:"The expected revision does not match."};
const attachment=Object.freeze({disposition:"attached",instance:Object.freeze({controlVersion:Object.freeze({major:1,minor:0}),instanceId:"323e4567-e89b-42d3-a456-426614174000",generation:"423e4567-e89b-42d3-a456-426614174000",contractVersion:2,deviceRef:device,features:Object.freeze(["wait-v1","auto-bootstrap-v1"])})});
const control={
 async ensureViewer(){return {ok:true,value:{deviceRef:device,descriptor:{contractVersion:2,streamId,standaloneUri:"http://127.0.0.1:49152/viewer/"+streamId,presentationModes:["standalone"],expiresAt:60},snapshot:snap()}};},
 async inspect(){return observed();},
 async wait(input,{signal}={}){note("wait:"+input.afterRevision);if(input.afterRevision>=90){await new Promise(resolve=>signal?.aborted?resolve():signal?.addEventListener("abort",resolve,{once:true}));note("abort:"+input.afterRevision);await new Promise(resolve=>setTimeout(resolve,15));note("late:"+input.afterRevision);return observed(input.afterRevision);}return observed();},
 async stopStream(input){return input.expectedRevision===9?{ok:false,error:revisionError,snapshot:snap()}:{ok:true,value:{snapshot:snap()}};},async close(){}
};
export async function acquireRuntime(request){let rejectClose=false;const sessionControl={...control,async inspect(input){rejectClose=input.afterRevision===77;return control.inspect(input);}};note("acquire:"+request.mode);return {ok:true,session:{attachment,control:sessionControl,async close(){note("session-close");if(rejectClose)throw new Error("owner credential secret");if(process.env.FSQ_MCP_HANG_CLOSE==="1"){setInterval(()=>{},1000);await new Promise(()=>{});}}}};}
`);
  return { index, log };
}
const UUID_PATTERN = "^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$";
const UUID_SCHEMA = { type: "string", pattern: UUID_PATTERN };
const REVISION_SCHEMA = { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const DEVICE_SCHEMA = { type: "object", properties: { contractVersion: { type: "number", const: 2 }, platform: { type: "string", const: "android" }, namespace: { type: "string", minLength: 1, maxLength: 64, pattern: "^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$" }, opaqueId: UUID_SCHEMA }, required: ["contractVersion", "platform", "namespace", "opaqueId"], additionalProperties: false };
const EXPECTED_TOOLS = [
  { name: "fsq_viewer_ensure", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { selector: { oneOf: [{ type: "object", properties: { kind: { type: "string", const: "auto" }, platform: { type: "string", const: "android" } }, required: ["kind", "platform"], additionalProperties: false }, { type: "object", properties: { kind: { type: "string", const: "known" }, deviceRef: DEVICE_SCHEMA }, required: ["kind", "deviceRef"], additionalProperties: false }] } }, required: ["selector"], additionalProperties: false } },
  { name: "fsq_stream_inspect", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { deviceRef: DEVICE_SCHEMA, streamId: UUID_SCHEMA, afterRevision: REVISION_SCHEMA }, required: ["deviceRef", "streamId"], additionalProperties: false } },
  { name: "fsq_stream_wait", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { deviceRef: DEVICE_SCHEMA, streamId: UUID_SCHEMA, afterRevision: REVISION_SCHEMA, waitMs: { type: "integer", minimum: 0, maximum: 25_000, default: 25_000 } }, required: ["deviceRef", "streamId", "afterRevision"], additionalProperties: false } },
  { name: "fsq_stream_stop", inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: { deviceRef: DEVICE_SCHEMA, streamId: UUID_SCHEMA, expectedRevision: REVISION_SCHEMA }, required: ["deviceRef", "streamId"], additionalProperties: false } },
];
const deviceRef = { contractVersion: 2 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId: DEVICE_ID };
const requests = [
  { name: "fsq_viewer_ensure", arguments: { selector: { kind: "auto", platform: "android" } } },
  { name: "fsq_stream_inspect", arguments: { deviceRef, streamId: STREAM_ID } },
  { name: "fsq_stream_wait", arguments: { deviceRef, streamId: STREAM_ID, afterRevision: 1, waitMs: 0 } },
  { name: "fsq_stream_stop", arguments: { deviceRef, streamId: STREAM_ID } },
];
function projected(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(result.content.length, 1);
  const value = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
  assert.deepEqual(value, result.structuredContent);
  return value;
}
async function officialMcp(bin: string, root: string, fixture: { index: string; log: string }): Promise<void> {
  const revisions = ["2024-10-07", "2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"];
  for (const revision of revisions) {
    await writeFile(fixture.log, "");
    const modern = revision === "2026-07-28", diagnostics: Buffer[] = [], wire: unknown[] = [], sent: Record<string, unknown>[] = [];
    const transport = new StdioClientTransport({ command: join(bin, "fsq-scrcpy-mcp"), cwd: root, env: fixtureEnv(root, fixture.index, undefined, { FSQ_FIXTURE_LOG: fixture.log }) as Record<string, string>, stderr: "pipe" });
    assert.equal(Object.getPrototypeOf(transport), StdioClientTransport.prototype);
    transport.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk));
    transport.onmessage = (message) => wire.push(structuredClone(message));
    let transportCloses = 0;
    transport.onclose = () => { transportCloses++; };
    const send = transport.send.bind(transport);
    transport.send = async (message) => { sent.push(structuredClone(message) as Record<string, unknown>); await send(message); };
    const client = new Client({ name: "installed-contract", version: "1.0.0" }, { supportedProtocolVersions: [revision], versionNegotiation: { mode: modern ? { pin: revision } : "legacy" } });
    await client.connect(transport);
    assert.equal(client.getNegotiatedProtocolVersion(), revision);
    assert.equal(client.getProtocolEra(), modern ? "modern" : "legacy");
    assert.deepEqual((await client.listTools(undefined, { cacheMode: "refresh" })).tools, EXPECTED_TOOLS);
    if (modern) {
      const discovered = await client.discover();
      assert.deepEqual(await client.discover(), discovered);
      assert.deepEqual(discovered._meta?.["io.modelcontextprotocol/serverInfo"], { name: "fsq-scrcpy", version: "0.0.0" });
    }
    assert.equal((await readFile(fixture.log, "utf8")).includes("acquire:"), false);
    for (const request of requests) {
      const result = await client.callTool(request, { timeout: 45_000 });
      assert.equal(result.isError, undefined);
      assert.equal(projected(result).ok, true);
      if (modern) {
        const call = sent.findLast((value) => value.method === "tools/call" && (value.params as { name?: string } | undefined)?.name === request.name)!;
        const raw = wire.findLast((value) => (value as { id?: unknown }).id === call.id) as { result: Record<string, unknown> };
        assert.equal(raw.result.resultType, "complete");
        assert.deepEqual((raw.result._meta as Record<string, unknown>)["io.modelcontextprotocol/serverInfo"], { name: "fsq-scrcpy", version: "0.0.0" });
      }
    }
    const failed = await client.callTool({ name: "fsq_stream_stop", arguments: { deviceRef, streamId: STREAM_ID, expectedRevision: 9 } }, { timeout: 45_000 });
    assert.equal(failed.isError, true);
    assert.deepEqual(projected(failed), { ok: false, error: { controlVersion: { major: 1, minor: 0 }, code: "revision-conflict", disposition: "recoverable", operationState: "not-applied", safeMessage: "The expected revision does not match." }, snapshot: { streamId: STREAM_ID, deviceRef, revision: 1, phase: "demand-pending", activeViewerCount: 0, updatedAt: 1 } });
    const cleanup = await client.callTool({ name: "fsq_stream_inspect", arguments: { deviceRef, streamId: STREAM_ID, afterRevision: 77 } }, { timeout: 45_000 });
    assert.equal(cleanup.isError, true);
    assert.deepEqual(projected(cleanup), { ok: false, error: { controlVersion: { major: 1, minor: 0 }, code: "runtime-exited", disposition: "state-unknown", operationState: "unknown", safeMessage: "The Runtime exited before its result was known." } });
    assert.equal(JSON.stringify(cleanup).includes("secret"), false);
    const beforeInvalid = await readFile(fixture.log, "utf8");
    const invalid = await client.request({ method: "tools/call", params: { name: "fsq_stream_inspect", arguments: { deviceRef, streamId: STREAM_ID, extra: true } } });
    assert.equal(invalid.isError, true);
    await assert.rejects(client.callTool({ name: "fsq_owner_shutdown", arguments: {} }));
    assert.equal(await readFile(fixture.log, "utf8"), beforeInvalid);
    for (const [afterRevision, mode] of [[90, "abort"], [91, "timeout"]] as const) {
      const controller = new AbortController(), pending = client.callTool({ name: "fsq_stream_wait", arguments: { deviceRef, streamId: STREAM_ID, afterRevision, waitMs: 25_000 } }, mode === "abort" ? { signal: controller.signal, timeout: 45_000 } : { timeout: 100 });
      await until(() => readable(fixture.log), (value) => value?.includes(`wait:${afterRevision}\n`) === true);
      if (mode === "abort") controller.abort();
      await assert.rejects(pending);
      await until(() => readable(fixture.log), (value) => value?.includes(`late:${afterRevision}\n`) === true);
      const call = sent.findLast((value) => value.method === "tools/call" && ((value.params as { arguments?: { afterRevision?: number } }).arguments?.afterRevision === afterRevision))!;
      const cancel = sent.findLast((value) => value.method === "notifications/cancelled" && (value.params as { requestId?: unknown }).requestId === call.id);
      assert.ok(cancel, `${revision} ${mode} did not cancel the original request ID`);
      assert.equal((await client.listTools(undefined, { cacheMode: "refresh" })).tools.length, 4);
      assert.equal(wire.some((value) => (value as { id?: unknown }).id === call.id), false);
    }
    const eofPending = client.callTool({ name: "fsq_stream_wait", arguments: { deviceRef, streamId: STREAM_ID, afterRevision: 92, waitMs: 25_000 } }, { timeout: 45_000 });
    const eofRejected = assert.rejects(eofPending);
    await until(() => readable(fixture.log), (value) => value?.includes("wait:92\n") === true);
    await client.close();
    await eofRejected;
    await client.close();
    assert.equal(transportCloses, 1);
    await until(() => readable(fixture.log), (value) => value?.split("\n").filter((line) => line === "session-close").length === 9);
    const restartTransport = new StdioClientTransport({ command: join(bin, "fsq-scrcpy-mcp"), cwd: root, env: fixtureEnv(root, fixture.index, undefined, { FSQ_FIXTURE_LOG: fixture.log }) as Record<string, string>, stderr: "pipe" });
    restartTransport.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk));
    const restarted = new Client({ name: "installed-restart", version: "1.0.0" }, { supportedProtocolVersions: [revision], versionNegotiation: { mode: modern ? { pin: revision } : "legacy" } });
    await restarted.connect(restartTransport);
    assert.equal(projected(await restarted.callTool(requests[1]!, { timeout: 45_000 })).ok, true);
    await restarted.close();
    await until(() => readable(fixture.log), (value) => value?.split("\n").filter((line) => line === "session-close").length === 10);
    assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
  }
  await writeFile(fixture.log, "");
  const legacyTransport = new StdioClientTransport({ command: join(bin, "fsq-scrcpy-mcp"), cwd: root, env: fixtureEnv(root, fixture.index, undefined, { FSQ_FIXTURE_LOG: fixture.log }) as Record<string, string>, stderr: "pipe" }), messages: Record<string, unknown>[] = [], diagnostics: Buffer[] = [];
  legacyTransport.onmessage = (message) => messages.push(message as Record<string, unknown>); legacyTransport.stderr?.on("data", (chunk: Buffer) => diagnostics.push(chunk));
  await legacyTransport.start(); const send = async (message: Parameters<StdioClientTransport["send"]>[0], count: number): Promise<void> => { await legacyTransport.send(message); await until(async () => String(messages.length), (value) => Number(value) === count); };
  const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientInfo": { name: "raw-fallback", version: "1.0.0" }, "io.modelcontextprotocol/clientCapabilities": {} };
  await send({ jsonrpc: "2.0", id: 1, method: "server/discover", params: { _meta: meta } }, 1); assert.deepEqual((messages[0]!.result as { supportedVersions: string[] }).supportedVersions, ["2026-07-28"]);
  assert.equal((await readFile(fixture.log, "utf8")).includes("acquire:"), false);
  await send({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "raw-fallback", version: "1.0.0" } } }, 2); const initialized = messages[1]!.result as Record<string, unknown>; assert.equal(initialized.protocolVersion, "2025-11-25"); assert.equal(Object.hasOwn(initialized, "resultType"), false);
  await legacyTransport.send({ jsonrpc: "2.0", method: "notifications/initialized" }); await send({ jsonrpc: "2.0", id: 3, method: "tools/list", params: {} }, 3); assert.deepEqual((messages[2]!.result as { tools: unknown[] }).tools, EXPECTED_TOOLS); assert.equal((await readFile(fixture.log, "utf8")).includes("acquire:"), false);
  await send({ jsonrpc: "2.0", id: 4, method: "tools/call", params: requests[1] }, 4); assert.deepEqual(messages.map((message) => message.id), [1, 2, 3, 4]); assert.equal(((messages[3]!.result as { structuredContent: { ok: boolean } }).structuredContent.ok), true); assert.equal((await readFile(fixture.log, "utf8")).split("\n").filter((line) => line === "session-close").length, 1);
  await legacyTransport.close(); assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
}
function sizedRequest(size: number, id: number): Buffer {
  const base = JSON.stringify({ jsonrpc: "2.0", id, method: "" }) + "\n";
  const value = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method: "x".repeat(size - Buffer.byteLength(base)) }) + "\n");
  assert.equal(value.length, size);
  return value;
}
async function byteLevelMcp(bin: string, root: string, env: NodeJS.ProcessEnv): Promise<void> {
  const absolute = join(bin, "fsq-scrcpy-mcp"), launch = (extra: NodeJS.ProcessEnv = {}) => spawn(absolute, [], { cwd: root, env: { ...env, ...extra }, stdio: ["pipe", "pipe", "pipe"] });
  const initialize = `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "byte-test", version: "1.0.0" } } })}\n`;
  const fixtureLog = join(root, "mcp-runtime.log");
  const eof = launch(), eofOut: Buffer[] = [], eofErr: Buffer[] = [];
  eof.stdout.on("data", (chunk: Buffer) => eofOut.push(chunk)); eof.stderr.on("data", (chunk: Buffer) => eofErr.push(chunk)); eof.stdin.end();
  assert.equal(await boundedClose(new Promise((resolve, reject) => { eof.once("error", reject); eof.once("close", resolve); }), "MCP natural EOF did not exit"), 0);
  assert.equal(Buffer.concat(eofOut).toString("utf8"), ""); assert.equal(Buffer.concat(eofErr).toString("utf8"), "");
  for (const size of [65_536, 65_537]) for (const split of [false, true]) {
    const child = launch(), output: Buffer[] = [], errors: Buffer[] = [];
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => errors.push(chunk));
    child.stdin.write(initialize);
    await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.split("\n").filter(Boolean).length === 1);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.split("\n").filter(Boolean).length === 2);
    const message = sizedRequest(size, 3);
    if (split) { child.stdin.write(message.subarray(0, 32_768)); await new Promise((resolve) => setImmediate(resolve)); child.stdin.write(message.subarray(32_768)); } else child.stdin.write(message);
    if (size === 65_536) {
      await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.split("\n").filter(Boolean).length === 3);
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list", params: {} })}\n`);
      await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.split("\n").filter(Boolean).length === 4);
      const response = JSON.parse(Buffer.concat(output).toString("utf8").trim().split("\n")[3]!) as { id: number; result: { tools: unknown[] } };
      assert.equal(response.id, 4); assert.equal(response.result.tools.length, 4); child.stdin.end();
      assert.equal(await boundedClose(closed, "MCP exact 64KiB connection did not remain usable"), 0);
      assert.equal(Buffer.concat(errors).toString("utf8"), "");
    } else {
      await until(async () => Buffer.concat(errors).toString("utf8"), (value) => value === "MCP transport failed.\n"); assert.equal(Buffer.concat(output).toString("utf8").split("\n").filter(Boolean).length, 2);
      child.stdin.end(); assert.equal(await boundedClose(closed, "MCP 65537-byte EOF did not settle"), 0);
      assert.equal(Buffer.concat(errors).toString("utf8"), "MCP transport failed.\n");
    }
  }
  await writeFile(fixtureLog, "");
  const activeEof = launch(), activeOutput: Buffer[] = [], activeErrors: Buffer[] = [];
  activeEof.stdout.on("data", (chunk: Buffer) => activeOutput.push(chunk)); activeEof.stderr.on("data", (chunk: Buffer) => activeErrors.push(chunk)); activeEof.stdin.write(initialize);
  await until(async () => Buffer.concat(activeOutput).toString("utf8"), (value) => value?.endsWith("\n") === true);
  activeEof.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fsq_stream_wait", arguments: { deviceRef, streamId: STREAM_ID, afterRevision: 92 } } })}\n`);
  await until(() => readable(fixtureLog), (value) => value?.includes("wait:92\n") === true); activeEof.stdin.end();
  assert.equal(await boundedClose(new Promise((resolve, reject) => { activeEof.once("error", reject); activeEof.once("close", resolve); }), "MCP in-flight EOF did not exit"), 0);
  assert.equal(Buffer.concat(activeOutput).toString("utf8").split("\n").filter(Boolean).length, 1); assert.equal(Buffer.concat(activeErrors).toString("utf8"), "");
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    const child = launch(), output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => errors.push(chunk)); child.stdin.write(initialize);
    await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.endsWith("\n") === true); child.kill(signal);
    assert.equal(await boundedClose(new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }), `MCP ${signal} did not coordinate close`), 0);
    assert.equal(Buffer.concat(errors).toString("utf8"), ""); assert.doesNotThrow(() => JSON.parse(Buffer.concat(output).toString("utf8").trim()));
  }
  for (const [first, second] of [["SIGINT", "SIGINT"], ["SIGTERM", "SIGTERM"], ["SIGINT", "SIGTERM"], ["SIGTERM", "SIGINT"]] as const) {
    await writeFile(fixtureLog, "");
    const child = launch({ FSQ_MCP_HANG_CLOSE: "1" }), output: Buffer[] = [], errors: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => output.push(chunk)); child.stderr.on("data", (chunk: Buffer) => errors.push(chunk)); child.stdin.write(initialize);
    await until(async () => Buffer.concat(output).toString("utf8"), (value) => value?.endsWith("\n") === true);
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "fsq_stream_wait", arguments: { deviceRef, streamId: STREAM_ID, afterRevision: 92 } } })}\n`);
    await until(() => readable(fixtureLog), (value) => value?.includes("wait:92\n") === true);
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => { child.once("error", reject); child.once("close", (code, signal) => resolve({ code, signal })); });
    child.kill(first); await new Promise((resolve) => setTimeout(resolve, 20)); child.kill(second);
    assert.deepEqual(await Promise.race([closed, new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error("MCP second signal did not terminate")), 5_000))]), { code: null, signal: second });
    assert.equal(Buffer.concat(output).toString("utf8").split("\n").filter(Boolean).length, 1); assert.equal(Buffer.concat(errors).toString("utf8"), "");
  }
  const epipe = launch(), epipeOutput: Buffer[] = [], epipeErrors: Buffer[] = [];
  const epipeClosed = new Promise<number | null>((resolve, reject) => { epipe.once("error", reject); epipe.once("close", resolve); });
  epipe.stdout.on("data", (chunk: Buffer) => epipeOutput.push(chunk)); epipe.stderr.on("data", (chunk: Buffer) => epipeErrors.push(chunk)); epipe.stdin.write(initialize);
  await until(async () => Buffer.concat(epipeOutput).toString("utf8"), (value) => value?.endsWith("\n") === true); epipe.stdout.destroy();
  epipe.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  await until(async () => Buffer.concat(epipeErrors).toString("utf8"), (value) => value === "MCP transport failed.\n"); epipe.stdin.end(); await boundedClose(epipeClosed, "MCP EPIPE did not close");
  const pressure = launch(), pressureOutput: Buffer[] = [], pressureErrors: Buffer[] = [];
  pressure.stderr.on("data", (chunk: Buffer) => pressureErrors.push(chunk)); pressure.stdin.write(initialize); pressure.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  for (let id = 2; id <= 257; id++) pressure.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list", params: {} })}\n`);
  await new Promise((resolve) => setTimeout(resolve, 20)); pressure.stdout.on("data", (chunk: Buffer) => pressureOutput.push(chunk));
  await until(async () => Buffer.concat(pressureOutput).toString("utf8"), (value) => value?.split("\n").filter(Boolean).length === 257); pressure.stdin.end();
  assert.equal(await boundedClose(new Promise((resolve, reject) => { pressure.once("error", reject); pressure.once("close", resolve); }), "MCP backpressure did not drain"), 0); assert.equal(Buffer.concat(pressureErrors).toString("utf8"), "");
}
async function signalInstalled(bin: string, root: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const suffix = signal.toLowerCase(), output = join(root, `${suffix}.stdout`), pidFile = join(root, `${suffix}.pid`), marker = join(root, `${suffix}.marker`);
  const index = join(root, `${suffix}-runtime.mjs`), owner = join(root, `${suffix}-owner.mjs`);
  await writeFile(index, "export async function acquireRuntime(){throw new Error('unexpected acquire');}\n");
  await writeFile(owner, `import {appendFile,writeFile} from "node:fs/promises";\nconst device=Object.freeze({contractVersion:2,platform:"android",namespace:"fsq.android.local",opaqueId:"${DEVICE_ID}"});\nconst status=Object.freeze({ok:true,value:Object.freeze({platform:"android",state:"ready",deviceRef:device,stateRevision:7,runtime:Object.freeze({state:"not-running"})})});\nexport const validateLocalStateStatusResult=value=>value;export const validateResetControlStateResult=value=>value;export const validateRebindDeviceResult=value=>value;\nexport function createRuntimeOwnerLocal(){return Object.freeze({async inspectLocalState(){await writeFile(${JSON.stringify(pidFile)},String(process.pid)+"\\n");return status;},async shutdownRuntime(){throw new Error("unexpected shutdown");},async resetControlState(){await appendFile(${JSON.stringify(marker)},"mutation\\n");throw new Error("unexpected reset");},async rebindDevice(){await appendFile(${JSON.stringify(marker)},"mutation\\n");throw new Error("unexpected rebind");},async close(){await appendFile(${JSON.stringify(marker)},"close\\n");},async [Symbol.asyncDispose](){await this.close();}});}\n`);
  const command = `exec fsq-scrcpy local-state reset-control --platform android --device-ref ${DEVICE_ID} --json > ${quote(output)}`;
  const pty = join(root, "fsq-pty-helper.py");
  await writeFile(pty, "import errno,os,pty,sys\npid,master=pty.fork()\nif pid==0: os.execvpe('/bin/sh',['/bin/sh','-c',sys.argv[1]],os.environ)\nwhile True:\n try: data=os.read(master,4096)\n except OSError as cause:\n  if cause.errno==errno.EIO: break\n  raise\n if not data: break\n os.write(1,data)\n_,status=os.waitpid(pid,0)\nos.close(master)\ncode=os.waitstatus_to_exitcode(status)\nsys.exit(code if code>=0 else 128-code)\n");
  const child = spawn("/usr/bin/python3", [pty, command], { cwd: root, env: fixtureEnv(root, index, owner, { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}` }), shell: false, stdio: ["ignore", "pipe", "pipe"] });
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

async function installWatchFixture(root: string, log: string): Promise<{ index: string; owner: string }> {
  const index = join(root, "watch-runtime.mjs"), owner = join(root, "watch-owner.mjs");
  await writeFile(owner, `
const device = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: "${DEVICE_ID}" });
const status = Object.freeze({ ok: true, value: Object.freeze({ platform: "android", state: "ready", deviceRef: device, stateRevision: 7, runtime: Object.freeze({ state: "not-running" }) }) });
export const validateLocalStateStatusResult = value => value;
export const validateResetControlStateResult = value => value;
export const validateRebindDeviceResult = value => value;
export function createRuntimeOwnerLocal() {
  return Object.freeze({ async inspectLocalState(input) { return input.platform === "ios" ? Object.freeze({ ok: true, value: Object.freeze({ platform: "ios", state: "uninitialized" }) }) : status; }, async close() {}, async [Symbol.asyncDispose]() {} });
}
`);
  await writeFile(index, `
import { appendFile, writeFile } from "node:fs/promises";
const device = Object.freeze({ contractVersion: 2, platform: "android", namespace: "fsq.android.local", opaqueId: "${DEVICE_ID}" });
const stream = "223e4567-e89b-42d3-a456-426614174000";
const target = Object.freeze({ controlVersion: Object.freeze({ major: 1, minor: 0 }), instanceId: "323e4567-e89b-42d3-a456-426614174000", generation: "423e4567-e89b-42d3-a456-426614174000", contractVersion: 2, deviceRef: device, features: Object.freeze(["wait-v1", "auto-bootstrap-v1"]) });
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
  return { index, owner };
}
const sequenceRecords = (value: string): readonly Record<string, unknown>[] => value.split("\u001e").slice(1).map((record) => JSON.parse(record.slice(0, -1)) as Record<string, unknown>);
async function installedSignal(bin: string, root: string, log: string, signal: "SIGINT" | "SIGTERM"): Promise<void> {
  const child = spawn("/bin/sh", ["-c", "exec fsq-scrcpy stream watch --stream-id 223e4567-e89b-42d3-a456-426614174000 --after-revision 1 --json-seq"], { cwd: root, env: fixtureEnv(root, join(root, "watch-runtime.mjs"), join(root, "watch-owner.mjs"), { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FSQ_WATCH_MODE: "cancel" }), stdio: ["ignore", "pipe", "pipe"] });
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
  const environment = fixtureEnv(root, join(root, "watch-runtime.mjs"), join(root, "watch-owner.mjs"), { PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, FSQ_WATCH_MODE: "blocked" });
  environment.NODE_OPTIONS = `${environment.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`.trim();
  const child = spawn(process.execPath, [entry, "stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] });
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
  await installFixtureLoader(root);
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
    ".build/integrations/src/mcp-bin.js",
    ".build/integrations/src/mcp.js",
    ".build/integrations/src/agent-control.js",
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
  assert.deepEqual(metadata.bin, { "fsq-scrcpy": ".build/integrations/src/bin.js", "fsq-scrcpy-mcp": ".build/integrations/src/mcp-bin.js" });
  for (const entryName of ["bin.js", "mcp-bin.js"]) assert.equal((await readFile(join(packageRoot, ".build", "integrations", "src", entryName), "utf8")).startsWith("#!/usr/bin/env node\n"), true);
  assert.equal(await readable(join(prefix, "node_modules", "@modelcontextprotocol", "client", "package.json")), undefined);
  assert.notEqual(await readable(join(prefix, "node_modules", "@modelcontextprotocol", "server", "package.json")), undefined);
  const installedHash = await treeHash(packageRoot);

  const bin = join(prefix, "node_modules", ".bin"), env = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`, PRIVATE_CANARY: "/Users/private/device.json" };
  const invoked = await run("fsq-scrcpy", ["unknown", "command", "--json"], { cwd: root, env });
  assert.equal(invoked.code, 2);
  assert.equal(invoked.stderr, "");
  assert.deepEqual(JSON.parse(invoked.stdout), { ok: false, error: { code: "invalid-cli-syntax", disposition: "usage", operationState: "not-applied", safeMessage: "Invalid command syntax." } });
  assert.equal(invoked.stdout.endsWith("\n"), true);
  assert.equal(invoked.stdout.includes("\n  \""), false);
  assert.equal(invoked.stdout.includes("PRIVATE_CANARY"), false);
  assert.equal(invoked.stdout.includes("/Users/private"), false);

  const mcpFixture = await installMcpFixture(root);
  await officialMcp(bin, root, mcpFixture);
  await writeFile(mcpFixture.log, "");
  await byteLevelMcp(bin, root, fixtureEnv(root, mcpFixture.index, undefined, { FSQ_FIXTURE_LOG: mcpFixture.log }));
  const watchLog = join(root, "watch.log"), watchFixture = await installWatchFixture(root, watchLog);
  const watchEnv = fixtureEnv(root, watchFixture.index, watchFixture.owner, env);
  for (const cursor of [7, 8]) {
    await writeFile(watchLog, "");
    const watched = await run("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", String(cursor), "--json-seq"], { cwd: root, env: { ...watchEnv, FSQ_WATCH_MODE: "cursor" } });
    assert.equal(watched.code, 0); assert.equal(watched.stderr, ""); const records = sequenceRecords(watched.stdout); assert.equal(records.length, 1); assert.equal(((records[0]!.value as { snapshot: { revision: number } }).snapshot.revision), cursor + 1);
    assert.equal((await readFile(watchLog, "utf8")).includes(`"afterRevision":${cursor}`), true);
  }
  await writeFile(watchLog, "");
  const sequence = await run("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: { ...watchEnv, FSQ_WATCH_MODE: "sequence" } });
  assert.equal(sequence.code, 0);
  assert.equal(sequence.stderr, "");
  const sequenceValues = sequenceRecords(sequence.stdout).map((record) => record.value as { snapshot: { revision: number }; reset: boolean; timedOut: boolean });
  assert.deepEqual(sequenceValues.map((value) => [value.snapshot.revision, value.reset, value.timedOut]), [[1, false, true], [5, true, false], [6, false, false], [7, false, false]]);
  assert.equal(`${sequence.stdout}${sequence.stderr}`.includes("/Users/private"), false);

  await writeFile(watchLog, "");
  const waited = await run("fsq-scrcpy", ["stream", "wait", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "7", "--json"], { cwd: root, env: { ...watchEnv, FSQ_WATCH_MODE: "cursor" } });
  assert.equal(waited.code, 0);
  assert.equal(waited.stderr, "");
  assert.equal(((JSON.parse(waited.stdout) as { value: { snapshot: { revision: number } } }).value.snapshot.revision), 8);
  assert.equal((await readFile(watchLog, "utf8")).includes('"waitMs":30000'), true);
  await writeFile(watchLog, ""); await installedSignal(bin, root, watchLog, "SIGINT"); await writeFile(watchLog, ""); await installedSignal(bin, root, watchLog, "SIGTERM");
  for (const [first, second] of [["SIGINT", "SIGINT"], ["SIGTERM", "SIGTERM"], ["SIGINT", "SIGTERM"], ["SIGTERM", "SIGINT"]] as const) await installedForce(bin, root, watchLog, first, second);

  await writeFile(watchLog, "");
  const epipe = spawn("fsq-scrcpy", ["stream", "watch", "--stream-id", "223e4567-e89b-42d3-a456-426614174000", "--after-revision", "1", "--json-seq"], { cwd: root, env: { ...watchEnv, FSQ_WATCH_MODE: "epipe" }, stdio: ["ignore", "pipe", "pipe"] });
  let firstRecord = Buffer.alloc(0); const diagnostics: Buffer[] = []; epipe.stderr.on("data", (chunk: Buffer) => diagnostics.push(chunk)); epipe.stdout.on("data", (chunk: Buffer) => { firstRecord = Buffer.concat([firstRecord, chunk]); if (firstRecord.includes(0x0a)) epipe.stdout.destroy(); });
  const epipeClosed = new Promise<number | null>((resolve, reject) => { epipe.once("error", reject); epipe.once("close", resolve); });
  assert.equal(await boundedClose(epipeClosed, "installed watch did not classify EPIPE"), 3); assert.equal(sequenceRecords(firstRecord.subarray(0, firstRecord.indexOf(0x0a) + 1).toString("utf8")).length, 1); assert.equal(Buffer.concat(diagnostics).toString("utf8"), "");
  await signalInstalled(bin, root, "SIGINT");
  await signalInstalled(bin, root, "SIGTERM");
  assert.equal(await treeHash(packageRoot), installedHash);
});
