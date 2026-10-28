import assert from "node:assert/strict";
import { createHash, createHmac, randomUUID } from "node:crypto";
import { Agent, createServer as createHttpServer, request as nodeRequest } from "node:http";
import { chmod, mkdtemp, realpath, rm } from "node:fs/promises";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  CONTROL_ERRORS,
  CONTROL_VERSION,
  controlError,
  controlErrorStatus,
  encodeCanonicalControlJson,
  parseCanonicalControlJson,
  type ControlError,
  type RuntimeTarget,
  type RuntimeControlSession,
} from "../../contracts/src/index.js";
import type { CaptureSession } from "../../capture/src/session.js";
import type { CaptureSource } from "../../capture/src/index.js";
import { LocalRuntimeState, type AndroidRuntimeSlot, type RuntimeGenerationState } from "../src/control-state.js";
import { CONTROL_DEADLINES, OwnerHttpControl, RuntimeControlHost, RuntimeControlProvider, attachControlSession, deriveControlBearer, helloControl, type ControlTimer } from "../src/control.js";
import { createViewerAssetManifest } from "../src/http.js";
import { MutationCancelled } from "../src/state.js";
import { DEVICE, KEY, FakeClock, FakeEntropy, ensured as stateEnsured,fixture as stateFixture } from "./support/runtime-fixtures.js";
import { createRuntimeService } from "../src/index.js";
const BINDING = Object.freeze({ serial: "PRIVATE-SERIAL", adbPath: "/usr/bin/true", cacheRoot: "/tmp/fsq-control-cache", artifactSource: Object.freeze({ mode: "online" as const }) });
class NoDemandSource implements CaptureSource { opens = 0; async open(): Promise<CaptureSession> { this.opens++; throw new Error("Capture must remain lazy"); } }
function manifest() { const entry = Buffer.from("export default 1"), worker = Buffer.from("self.onmessage=()=>0"); return createViewerAssetManifest([{ role: "entry-module", name: "entry.js", sha256: createHash("sha256").update(entry).digest("hex"), mime: "text/javascript; charset=utf-8", bytes: entry }, { role: "worker-module", name: "worker.js", sha256: createHash("sha256").update(worker).digest("hex"), mime: "text/javascript; charset=utf-8", bytes: worker }]); }
async function fixture(clock = new FakeClock(),timer?:ControlTimer) {
  const created = await mkdtemp(join(tmpdir(), "fsq-control-http-")), parent = await realpath(created); await chmod(parent, 0o700); const state = new LocalRuntimeState(join(parent, "state")), initialized = await state.initialize(BINDING, clock.wall()), slot = initialized.slot, source = new NoDemandSource(), service = createRuntimeService({ mediaProfile: "h264-annexb", manifest: manifest(), captureSource: source, clock, entropy: new FakeEntropy() });
  const generation: RuntimeGenerationState = Object.freeze({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, instanceId: randomUUID(), generation: randomUUID(), port: slot.control.port, createdAt: clock.wall(), ready: true }); let shutdowns = 0,host!:RuntimeControlHost;
  host = new RuntimeControlHost({ service, slot, generation, onShutdown: async () => { shutdowns++;await host.close(); },...(timer?{timer}:{}) }); await host.start(); await service.start(); await state.publishGeneration(generation); host.ready();
  return { parent, state, slot, source, service, generation, host, clock, shutdowns: () => shutdowns, async close() { await host.close().catch(() => undefined); await service.close().catch(() => undefined); await rm(parent, { recursive: true, force: true }); } };
}
interface Reply { readonly status: number; readonly headers: import("node:http").IncomingHttpHeaders; readonly body: Uint8Array }
function call(slot: AndroidRuntimeSlot, path: string, value: unknown, authorization: string, headers: Record<string, string> = {}, method = "POST"): Promise<Reply> {
  const body = encodeCanonicalControlJson(value);
  return new Promise((resolve, reject) => { const request = nodeRequest({ host: "127.0.0.1", port: slot.control.port, path, method, headers: { Host: `127.0.0.1:${slot.control.port}`, Authorization: authorization, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.byteLength), ...headers } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })); }); request.on("error", reject); request.end(body); });
}
function browser(origin: string): Record<string, string> { return { Host: new URL(origin).host, Origin: origin, "Sec-Fetch-Site": "same-origin" }; }
function viewerCall(origin: string, path: string, body: unknown): Promise<Reply> { const source = JSON.stringify(body); return new Promise((resolve, reject) => { const request = nodeRequest(new URL(path, origin), { method: "POST", headers: { ...browser(origin), "Content-Type": "application/json; charset=utf-8", "Content-Length": String(Buffer.byteLength(source)) } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })); }); request.on("error", reject); request.end(source); }); }
function openSocket(port: number): Promise<Socket> { return new Promise((resolve, reject) => { const socket = netConnect({ host: "127.0.0.1", port }, () => resolve(socket)); socket.once("error", reject); }); }
function rawRequest(port: number, request: string): Promise<string> { return new Promise((resolve, reject) => { const socket = netConnect({ host: "127.0.0.1", port }, () => socket.end(request)); const chunks: Buffer[] = []; socket.on("data", (chunk) => chunks.push(Buffer.from(chunk))); socket.once("end", () => resolve(Buffer.concat(chunks).toString())); socket.once("error", reject); }); }
async function fakeControlReply(port:number,status:number,headers:Record<string,string>,body:Uint8Array,run:()=>Promise<void>):Promise<void>{const server=createHttpServer((_request,response)=>{response.writeHead(status,headers);response.end(body);});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port,exclusive:true},resolve);});try{await run();}finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}}
async function fakeDuplicateReply(port:number,header:string,body:Uint8Array,run:()=>Promise<void>):Promise<void>{const value=header.toLowerCase()==="content-length"?String(body.byteLength):header.toLowerCase()==="content-type"?"application/json; charset=utf-8":header.toLowerCase()==="cache-control"?"no-store":"nosniff",server=createNetServer(socket=>{socket.once("data",()=>socket.end(`HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n${header}: ${value}\r\nConnection: close\r\n\r\n${Buffer.from(body).toString()}`));});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port,exclusive:true},resolve);});try{await run();}finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}}
async function rawMutation(slot:AndroidRuntimeSlot,path:string,authority:"client"|"owner",value:unknown):Promise<Readonly<{socket:Socket;settled:ReturnType<typeof collectSocket>}>>{const body=new TextDecoder().decode(encodeCanonicalControlJson(value)),socket=await openSocket(slot.control.port),settled=collectSocket(socket),scheme=authority==="client"?"FSQ-Control":"FSQ-Owner";socket.write(`POST ${path} HTTP/1.1\r\nHost: 127.0.0.1:${slot.control.port}\r\nAuthorization: ${scheme} ${deriveControlBearer(slot.control.credential,authority)}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);return Object.freeze({socket,settled});}
function collectSocket(socket:Socket,timeoutMs=1_000):Promise<Readonly<{reply:string;reset:boolean}>>{return new Promise((resolve,reject)=>{const chunks:Buffer[]=[];let done=false;const cleanup=()=>{clearTimeout(timer);socket.off("data",data);socket.off("end",end);socket.off("close",close);socket.off("error",error);},finish=(reset:boolean)=>{if(done)return;done=true;cleanup();resolve({reply:Buffer.concat(chunks).toString(),reset});},data=(chunk:Uint8Array)=>chunks.push(Buffer.from(chunk)),end=()=>finish(false),close=()=>finish(true),error=(cause:NodeJS.ErrnoException)=>{if(cause.code==="ECONNRESET")finish(true);else{if(done)return;done=true;cleanup();reject(cause);}},timer=setTimeout(()=>{if(done)return;done=true;cleanup();socket.destroy();reject(new Error("socket fixture timeout"));},timeoutMs);socket.on("data",data);socket.once("end",end);socket.once("close",close);socket.once("error",error);});}
function readOneResponse(socket:Socket,timeoutMs=1_000):Promise<string>{return new Promise((resolve,reject)=>{let data="",done=false;const cleanup=()=>{clearTimeout(timer);socket.off("data",onData);socket.off("error",onError);},onData=(chunk:Uint8Array)=>{data+=Buffer.from(chunk).toString();const split=data.indexOf("\r\n\r\n");if(split<0)return;const match=/\r\nContent-Length: ([0-9]+)\r\n/i.exec(data.slice(0,split+4));if(!match||Buffer.byteLength(data.slice(split+4))<Number(match[1]))return;done=true;cleanup();resolve(data);},onError=(cause:Error)=>{if(done)return;done=true;cleanup();reject(cause);},timer=setTimeout(()=>{if(done)return;done=true;cleanup();reject(new Error("response fixture timeout"));},timeoutMs);socket.on("data",onData);socket.once("error",onError);});}
function agentCall(slot:AndroidRuntimeSlot,agent:Agent,value:unknown,authorization:string):Promise<Reply>{const body=encodeCanonicalControlJson(value);return new Promise((resolve,reject)=>{const request=nodeRequest({host:"127.0.0.1",port:slot.control.port,path:"/v1/control/hello",method:"POST",agent,headers:{Host:`127.0.0.1:${slot.control.port}`,Authorization:authorization,"Content-Type":"application/json; charset=utf-8","Content-Length":String(body.byteLength)}},response=>{const chunks:Buffer[]=[];response.on("data",chunk=>chunks.push(Buffer.from(chunk)));response.on("end",()=>resolve({status:response.statusCode??0,headers:response.headers,body:Buffer.concat(chunks)}));});request.on("error",reject);request.end(body);});}
type ClientRoute="hello"|"ensure"|"inspect"|"wait"|"stop"|"approve"|"shutdown";
async function invokeClientRoute(route:ClientRoute,slot:AndroidRuntimeSlot,target:RuntimeTarget):Promise<unknown>{const instance={controlVersion:CONTROL_VERSION,instanceId:target.instanceId,generation:target.generation,contractVersion:2 as const,deviceRef:slot.deviceRef,features:Object.freeze(["wait-v1"]as const)};if(route==="hello")return helloControl(slot,target);if(route==="approve"||route==="shutdown"){const owner=new OwnerHttpControl(slot.control.port,target,slot.control.credential);try{return route==="approve"?await owner.approveViewerPairing({streamId:randomUUID(),pairingCode:"ABCDEFGH"}):await owner.shutdownRuntime(target);}finally{await owner.close();}}const attached=await attachControlSession(slot.control.port,{disposition:"attached",instance},slot.control.credential);assert.ok(attached.ok);if(!attached.ok)return attached;try{if(route==="ensure")return await attached.session.control.ensureViewer();if(route==="inspect")return await attached.session.control.inspect({streamId:randomUUID()});if(route==="wait")return await attached.session.control.wait({streamId:randomUUID(),afterRevision:1,waitMs:0});return await attached.session.control.stopStream({streamId:randomUUID()});}finally{await attached.session.close();}}
const decoded = <T>(value: Uint8Array): T => parseCanonicalControlJson(value) as T;
class FakeControlTimer implements ControlTimer{now=0;#next=1;#timers=new Map<number,{at:number;callback:()=>void}>();mono(){return this.now;}set(delay:number,callback:()=>void):object{const id=this.#next++;this.#timers.set(id,{at:this.now+delay,callback});return{id};}clear(handle:object){this.#timers.delete((handle as{id:number}).id);}advance(ms:number){const end=this.now+ms;for(;;){const due=[...this.#timers].filter(([,timer])=>timer.at<=end).sort((left,right)=>left[1].at-right[1].at)[0];if(!due)break;this.now=due[1].at;this.#timers.delete(due[0]);due[1].callback();}this.now=end;}count(){return this.#timers.size;}}
async function awaitTimerCount(timer:FakeControlTimer,expected:number):Promise<void>{for(let turn=0;turn<20;turn++){if(timer.count()===expected)return;await new Promise(resolve=>setImmediate(resolve));}assert.fail(`expected ${expected} registered timers, saw ${timer.count()}`);}
async function awaitAdmission(host:RuntimeControlHost,expected:Readonly<{preauth:number;authenticated:number;inFlight:number;waits?:number}>):Promise<void>{const complete={preauth:expected.preauth,authenticated:expected.authenticated,inFlight:expected.inFlight,waits:expected.waits??0};for(let turn=0;turn<20;turn++){if(JSON.stringify(host.admissionSnapshot())===JSON.stringify(complete))return;await new Promise(resolve=>setImmediate(resolve));}assert.deepEqual(host.admissionSnapshot(),complete);}
async function awaitServerAbort(aborted:Promise<void>):Promise<void>{let timeout:NodeJS.Timeout|undefined;try{await Promise.race([aborted,new Promise<never>((_resolve,reject)=>{timeout=setTimeout(()=>reject(new Error("server cancellation signal timeout")),1_000);})]);}finally{if(timeout)clearTimeout(timeout);}}
await test("control deadline ledger uses exact contract boundaries",()=>{assert.deepEqual(CONTROL_DEADLINES,{connect:1_000,request:5_000,readIdle:2_000,terminate:2_000,readiness:10_000});});


await test("HMAC authority derivation uses exact contexts and parameter order", () => {
  const credential = Buffer.alloc(32, 7).toString("base64url"), root = Buffer.from(credential, "base64url");
  const client = createHmac("sha256", root).update("FSQ-Control/v1/client").digest("base64url"), owner = createHmac("sha256", root).update("FSQ-Control/v1/owner").digest("base64url"); root.fill(0);
  assert.equal(deriveControlBearer(credential, "client"), client);
  assert.equal(deriveControlBearer(credential, "owner"), owner);
  assert.notEqual(client, owner);
  assert.equal(client.length, 43);
  assert.equal(owner.length, 43);
});

await test("authenticated hello returns only the exact ready Runtime identity", async () => {
  const f = await fixture();
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
    const current = await helloControl(f.slot, target);
    assert.ok(current.ok); if (!current.ok) return;
    assert.equal(current.value.instance.controlVersion.major, 1); assert.equal(current.value.instance.controlVersion.minor, 0); assert.equal(current.value.instance.instanceId, target.instanceId); assert.equal(current.value.instance.generation, target.generation); assert.equal(current.value.instance.contractVersion, 2); assert.equal(JSON.stringify(current.value.instance.deviceRef), JSON.stringify(f.slot.deviceRef)); assert.deepEqual(current.value.instance.features, ["wait-v1"]);assert.ok(Object.isFrozen(current.value.instance.features));
    assert.deepEqual(Object.keys(current.value.instance), ["controlVersion", "instanceId", "generation", "contractVersion", "deviceRef", "features"]);
    const missing = await helloControl(f.slot, null);
    assert.ok(missing.ok);
    const wrong = await helloControl(f.slot, { ...target, generation: randomUUID() });
    assert.equal(wrong.ok ? "" : wrong.error.code, "instance-conflict");
    assert.equal(JSON.stringify(current).includes(BINDING.serial), false);
    assert.equal(JSON.stringify(current).includes(f.slot.control.credential), false);
  } finally { await f.close(); }
});

await test("client and owner bearers are non-interchangeable across all routes", async () => {
  const f = await fixture();
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation }, client = deriveControlBearer(f.slot.control.credential, "client"), owner = deriveControlBearer(f.slot.control.credential, "owner");
    const ordinary = await call(f.slot, "/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target }, `FSQ-Control ${client}`);
    assert.equal(ordinary.status, 200);
    const wrongOwner = await call(f.slot, "/v1/runtime/shutdown", { controlVersion: CONTROL_VERSION, target }, `FSQ-Control ${client}`);
    const wrongClient = await call(f.slot, "/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target }, `FSQ-Owner ${owner}`);
    assert.equal(wrongOwner.status, 401);
    assert.equal(wrongClient.status, 401);
    assert.equal(new TextDecoder().decode(wrongOwner.body), '{"error":"unauthorized"}');
    assert.equal(new TextDecoder().decode(wrongClient.body), '{"error":"unauthorized"}');
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("ordinary session serialization excludes bearer and control object", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, { instanceId: f.generation.instanceId, generation: f.generation.generation }); assert.ok(hello.ok); if (!hello.ok) return;
    const attachment = Object.freeze({ disposition: "attached" as const, instance: hello.value.instance }), result = await attachControlSession(f.slot.control.port, attachment, f.slot.control.credential);
    assert.ok(result.ok); if (!result.ok) return;
    assert.deepEqual(Object.keys(result.session), ["attachment"]);
    assert.deepEqual(Object.keys(result.session.control), []);
    assert.equal(JSON.stringify(result.session.control), "{}");
    assert.equal(JSON.stringify(result.session).includes(f.slot.control.credential), false);
    assert.equal(JSON.stringify(result.session).includes(deriveControlBearer(f.slot.control.credential, "client")), false);
    const serialized = JSON.stringify(result.session); for (const privateValue of ["ensureViewer", "inspect", "\"wait\"", "stopStream", "FSQ-Control", "FSQ-Owner", "credential", "viewerGrant", "ownerBearer"]) assert.equal(serialized.includes(privateValue), false);
    await result.session.close();
  } finally { await f.close(); }
});

await test("concurrent ensure is exactly-once and returns the current snapshot", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const results = await Promise.all(Array.from({ length: 20 }, () => attached.session.control.ensureViewer()));
    assert.equal(results.every((value) => value.ok), true);
    const ids = results.flatMap((value) => value.ok ? [value.value.snapshot.streamId] : []);
    assert.equal(new Set(ids).size, 1);
    const streamId = ids[0]!;
    const inspected = await attached.session.control.inspect({ streamId }); assert.ok(inspected.ok); if (!inspected.ok) return;
    const repeated = await attached.session.control.ensureViewer(); assert.ok(repeated.ok); if (!repeated.ok) return;
    assert.equal(repeated.value.snapshot.revision, inspected.value.snapshot.revision);
    assert.equal(repeated.value.snapshot.streamId, streamId);
    assert.equal(repeated.value.descriptor.streamId, streamId);
    assert.deepEqual(Object.keys(repeated.value), ["deviceRef", "descriptor", "snapshot"]);
    assert.equal(JSON.stringify(repeated).includes("viewerGrant"), false);
    assert.equal(JSON.stringify(repeated).includes(BINDING.serial), false);
    assert.equal(f.source.opens, 0);
    await attached.session.close();
  } finally { await f.close(); }
});

await test("inspect and stop preserve revision conflict and terminal idempotency", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const ensured = await attached.session.control.ensureViewer(); assert.ok(ensured.ok); if (!ensured.ok) return;
    const streamId = ensured.value.snapshot.streamId, mismatch = await attached.session.control.stopStream({ streamId, expectedRevision: ensured.value.snapshot.revision + 1 });
    assert.equal(mismatch.ok, false); if (mismatch.ok) return;
    assert.equal(mismatch.error.code, "revision-conflict");
    assert.equal("snapshot" in mismatch, true);
    if ("snapshot" in mismatch) assert.equal(mismatch.snapshot.revision, ensured.value.snapshot.revision);
    const stopped = await attached.session.control.stopStream({ streamId, expectedRevision: ensured.value.snapshot.revision }); assert.ok(stopped.ok); if (!stopped.ok) return;
    assert.equal(stopped.value.snapshot.phase, "stopped");
    assert.equal(stopped.value.snapshot.reason, "explicit-stop");
    const repeated = await attached.session.control.stopStream({ streamId, expectedRevision: Number.MAX_SAFE_INTEGER });
    assert.deepEqual(repeated, stopped);
    const changes = await attached.session.control.inspect({ streamId, afterRevision: 1 }); assert.ok(changes.ok); if (changes.ok) { assert.equal(changes.value.reset, false); assert.equal(changes.value.changes.at(-1)?.phase, "stopped"); }
    await attached.session.close();
  } finally { await f.close(); }
});

await test("terminal stream rotates semantic key and StreamId on next ensure", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const first = await attached.session.control.ensureViewer(); assert.ok(first.ok); if (!first.ok) return;
    await attached.session.control.stopStream({ streamId: first.value.snapshot.streamId });
    const second = await attached.session.control.ensureViewer(); assert.ok(second.ok); if (!second.ok) return;
    assert.notEqual(second.value.snapshot.streamId, first.value.snapshot.streamId);
    assert.equal(second.value.snapshot.phase, "demand-pending");
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("grant expiry returns unauthorized without replacing the active stream", async () => {
  const clock = new FakeClock(), f = await fixture(clock);
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const first = await attached.session.control.ensureViewer(); assert.ok(first.ok); if (!first.ok) return;
    clock.tick(60_000);
    const expired = await attached.session.control.ensureViewer();
    assert.equal(expired.ok ? "" : expired.error.code, "unauthorized");
    const repeated = await attached.session.control.ensureViewer();
    assert.equal(repeated.ok ? "" : repeated.error.code, "unauthorized");
    const inspected = await attached.session.control.inspect({ streamId: first.value.snapshot.streamId });
    assert.equal(inspected.ok, true);
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("owner approval retains pairing identity and grant inside Runtime", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const ensured = await attached.session.control.ensureViewer(); assert.ok(ensured.ok); if (!ensured.ok) return;
    const started = await viewerCall(f.service.origin!, "/v1/pairings", { streamId: ensured.value.snapshot.streamId });
    assert.equal(started.status, 201); const pairing = JSON.parse(new TextDecoder().decode(started.body)) as { pairingId: string; pairingCode: string };
    const owner = new OwnerHttpControl(f.slot.control.port, { instanceId: f.generation.instanceId, generation: f.generation.generation }, f.slot.control.credential);
    const wrong = await owner.approveViewerPairing({ streamId: ensured.value.snapshot.streamId, pairingCode: "ZZZZZZZZ" });
    assert.equal(wrong.ok ? "" : wrong.error.code, "unauthorized");
    const approved = await owner.approveViewerPairing({ streamId: ensured.value.snapshot.streamId, pairingCode: pairing.pairingCode });
    assert.ok(approved.ok); if (approved.ok) { assert.equal(approved.value.snapshot.streamId, ensured.value.snapshot.streamId); assert.equal(typeof approved.value.approvedAt, "number"); assert.deepEqual(Object.keys(approved.value), ["snapshot", "approvedAt"]); }
    const replay = await owner.approveViewerPairing({ streamId: ensured.value.snapshot.streamId, pairingCode: pairing.pairingCode });
    assert.equal(replay.ok ? "" : replay.error.code, "unauthorized");
    const output = JSON.stringify([wrong, approved, replay]);
    assert.equal(output.includes(pairing.pairingId), false);
    assert.equal(output.includes(f.slot.control.credential), false);
    assert.equal(output.includes(BINDING.serial), false);
    await owner.close();
  } finally { await f.close(); }
});

await test("unknown stream, future revision and malformed routes use fixed safe results", async () => {
  const f = await fixture();
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation }, bearer = deriveControlBearer(f.slot.control.credential, "client"), auth = `FSQ-Control ${bearer}`;
    const unknown = await call(f.slot, "/v1/stream/inspect", { controlVersion: CONTROL_VERSION, target, streamId: randomUUID(), afterRevision: null }, auth);
    assert.equal(unknown.status, 400);
    assert.equal(decoded<{ ok: false; error: ControlError }>(unknown.body).error.code, "malformed-control");
    const route = await call(f.slot, "/v1/unknown", { controlVersion: CONTROL_VERSION, target }, auth);
    assert.equal(route.status, 404);
    assert.equal(new TextDecoder().decode(route.body), '{"error":"not-found"}');
    const method = await call(f.slot, "/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target }, auth, {}, "OPTIONS");
    assert.equal(method.status, 405);
    assert.equal(new TextDecoder().decode(method.body), '{"error":"method-not-allowed"}');
    assert.equal(JSON.stringify([unknown, route, method]).includes(BINDING.serial), false);
  } finally { await f.close(); }
});

await test("auth fails before route, body and identity parsing", async () => {
  const f = await fixture();
  try {
    const invalid = `FSQ-Control ${"A".repeat(43)}`;
    const probeTarget = { instanceId: randomUUID(), generation: randomUUID() };
    for (const [path, value, headers] of [
      ["/private-probe", { controlVersion: CONTROL_VERSION, target: probeTarget }, {}],
      ["/v1/control/hello", { controlVersion: { major: 99, minor: 99 }, contractVersion: 1, deviceRef: f.slot.deviceRef, expectedInstance: null }, {}],
      ["/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target: probeTarget }, { Origin: "http://evil.invalid" }],
    ] as const) {
      const response = await call(f.slot, path, value, invalid, headers as Record<string, string>);
      assert.equal(response.status, 401);
      assert.equal(new TextDecoder().decode(response.body), '{"error":"unauthorized"}');
    }
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("canonical framing, proxy headers and duplicate credentials fail closed", async () => {
  const f = await fixture();
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation }, bearer = deriveControlBearer(f.slot.control.credential, "client"), auth = `FSQ-Control ${bearer}`;
    for (const headers of [{ Origin: "http://127.0.0.1" }, { Forwarded: "for=127.0.0.1" }, { Via: "proxy" }, { "X-Forwarded-For": "127.0.0.1" }, { "Proxy-Authorization": "x" }]) {
      const response = await call(f.slot, "/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target }, auth, headers);
      assert.equal(response.status, 400);
    }
    const whitespace = Buffer.from(` {"controlVersion":{"major":1,"minor":0},"target":{"instanceId":"${target.instanceId}","generation":"${target.generation}"}}`);
    const malformed = await new Promise<Reply>((resolve, reject) => { const request = nodeRequest({ host: "127.0.0.1", port: f.slot.control.port, path: "/v1/viewer/ensure", method: "POST", headers: { Host: `127.0.0.1:${f.slot.control.port}`, Authorization: auth, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(whitespace.length) } }, (response) => { const chunks: Buffer[] = []; response.on("data", (chunk) => chunks.push(Buffer.from(chunk))); response.on("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) })); }); request.on("error", reject); request.end(whitespace); });
    assert.equal(malformed.status, 400);
    assert.equal(new TextDecoder().decode(malformed.body), '{"error":"request-rejected"}');
  } finally { await f.close(); }
});

await test("pre-aborted provider operations are not applied", async () => {
  const f = await fixture();
  try {
    const controller = new AbortController(); controller.abort();
    const provider = f.host.provider;
    const target={instanceId:f.generation.instanceId,generation:f.generation.generation};for (const result of [await provider.ensureViewer({ signal: controller.signal }), provider.inspect({ streamId: randomUUID() }, { signal: controller.signal }),await provider.wait({streamId:randomUUID(),afterRevision:1,waitMs:0},{signal:controller.signal}), await provider.stopStream({ streamId: randomUUID() }, { signal: controller.signal }), await provider.approveViewerPairing({ streamId: randomUUID(), pairingCode: "ABCDEFGH" }, { signal: controller.signal }),await provider.shutdownRuntime(target,{signal:controller.signal})]) {
      assert.equal(result.ok ? "" : result.error.code, "request-cancelled");
      if (!result.ok) assert.equal(result.error.operationState, "not-applied");
    }
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("provider is not an authority before ready publication", async () => {
  const f = await fixture();
  try {
    const provider = new RuntimeControlProvider(f.service, f.slot, f.generation, async () => undefined), target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
    const notReady = provider.hello(target); assert.equal(notReady.ok ? "" : notReady.error.code, "runtime-exited");
    const before = await provider.ensureViewer(); assert.equal(before.ok ? "" : before.error.code, "runtime-exited");
    provider.markReady(); assert.equal(provider.hello(target).ok, true);
  } finally { await f.close(); }
});

await test("owner shutdown targets exact generation and does not alias stream stop", async () => {
  const f = await fixture();
  try {
    const target: RuntimeTarget = { instanceId: f.generation.instanceId, generation: f.generation.generation }, owner = new OwnerHttpControl(f.slot.control.port, target, f.slot.control.credential);
    const wrong = await owner.shutdownRuntime({ ...target, generation: randomUUID() });
    assert.equal(wrong.ok ? "" : wrong.error.code, "instance-conflict");
    assert.equal(f.shutdowns(), 0);
    const controller=new AbortController(),stopped = await owner.shutdownRuntime(target,{signal:controller.signal});controller.abort();
    assert.ok(stopped.ok); if (stopped.ok) { assert.deepEqual(Object.keys(stopped.value), ["instanceId", "generation"]); assert.equal(stopped.value.instanceId, target.instanceId); assert.equal(stopped.value.generation, target.generation); }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(f.shutdowns(), 1);
    assert.equal(f.source.opens, 0);
    await owner.close();
  } finally { await f.close(); }
});

await test("fixed errors and responses contain no private/provider/media material", async () => {
  const f = await fixture();
  try {
    assert.deepEqual(Object.keys(f.host), []);
    assert.equal(JSON.stringify(f.host), "{}");
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation }, auth = `FSQ-Control ${deriveControlBearer(f.slot.control.credential, "client")}`, result = await call(f.slot, "/v1/stream/inspect", { controlVersion: CONTROL_VERSION, target, streamId: randomUUID(), afterRevision: null }, auth), output = `${new TextDecoder().decode(result.body)}${JSON.stringify(result.headers)}`;
    for (const privateValue of [BINDING.serial, BINDING.adbPath, BINDING.cacheRoot, f.slot.control.credential, deriveControlBearer(f.slot.control.credential, "client"), deriveControlBearer(f.slot.control.credential, "owner"), "viewerGrant", "pairingId", "cookie", "media"] ) assert.equal(output.includes(privateValue), false);
    assert.deepEqual(Object.keys(controlError("malformed-control")), ["controlVersion", "code", "disposition", "operationState", "safeMessage"]);
  } finally { await f.close(); }
});

await test("raw pre-auth socket cap destroys the ninth connection without parsing", async () => {
  const f = await fixture(); const sockets: Socket[] = [];
  try {
    for (let index = 0; index < 8; index++) sockets.push(await openSocket(f.slot.control.port));
    const ninth = await openSocket(f.slot.control.port), closed = new Promise<void>((resolve) => ninth.once("close", () => resolve()));
    await closed;
    assert.equal(ninth.destroyed, true);
    assert.equal(f.source.opens, 0);
  } finally { for (const socket of sockets) socket.destroy(); await f.close(); }
});

await test("duplicate Host and Authorization share the fixed auth-first 401", async () => {
  const f = await fixture();
  try {
    const bearer = deriveControlBearer(f.slot.control.credential, "client"), body = new TextDecoder().decode(encodeCanonicalControlJson({ controlVersion: CONTROL_VERSION, target: { instanceId: f.generation.instanceId, generation: f.generation.generation } })), authority = `127.0.0.1:${f.slot.control.port}`;
    const requests = [
      `POST /v1/viewer/ensure HTTP/1.1\r\nHost: ${authority}\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      `POST /v1/viewer/ensure HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      `POST /v1/viewer/ensure HTTP/1.1\r\nHost: localhost:${f.slot.control.port}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
    ];
    for (const request of requests) { const response = await rawRequest(f.slot.control.port, request); assert.match(response, /^HTTP\/1\.1 401 /); assert.equal(response.endsWith('{"error":"unauthorized"}'), true); }
    assert.equal(f.source.opens, 0);
  } finally { await f.close(); }
});

await test("authenticated framing rejects transfer encoding, media type and oversized bodies", async () => {
  const f = await fixture();
  try {
    const bearer = deriveControlBearer(f.slot.control.credential, "client"), authority = `127.0.0.1:${f.slot.control.port}`, prefix = `POST /v1/viewer/ensure HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nConnection: close\r\n`;
    const transfer = await rawRequest(f.slot.control.port, `${prefix}Transfer-Encoding: chunked\r\nContent-Type: application/json; charset=utf-8\r\n\r\n0\r\n\r\n`);
    assert.match(transfer, /^HTTP\/1\.1 400 /);
    const media = await rawRequest(f.slot.control.port, `${prefix}Content-Type: application/json\r\nContent-Length: 2\r\n\r\n{}`);
    assert.match(media, /^HTTP\/1\.1 415 /);
    const large = await rawRequest(f.slot.control.port, `${prefix}Content-Type: application/json; charset=utf-8\r\nContent-Length: 16385\r\n\r\n`);
    assert.match(large, /^HTTP\/1\.1 413 /);
    const missing = await rawRequest(f.slot.control.port, `${prefix}Content-Type: application/json; charset=utf-8\r\n\r\n`);
    assert.match(missing, /^HTTP\/1\.1 400 /);
  } finally { await f.close(); }
});

await test("client bearer is released from ordinary control enumeration and inspect", async () => {
  const f = await fixture();
  try {
    const hello = await helloControl(f.slot, null); assert.ok(hello.ok); if (!hello.ok) return;
    const attached = await attachControlSession(f.slot.control.port, { disposition: "attached", instance: hello.value.instance }, f.slot.control.credential); assert.ok(attached.ok); if (!attached.ok) return;
    const control = attached.session.control, bearer = deriveControlBearer(f.slot.control.credential, "client");
    assert.deepEqual(Reflect.ownKeys(control), []);
    assert.equal(String(control).includes(bearer), false);
    assert.equal(JSON.stringify(control).includes(bearer), false);
    await attached.session.close();
    const closed = await control.ensureViewer(); assert.equal(closed.ok ? "" : closed.error.code, "runtime-exited");
  } finally { await f.close(); }
});

await test("provider normalizer enforces count changes-byte and full-response boundaries without prefixes",async()=>{
  const f=await fixture();
  try{
    const ensured=await f.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    let observation:unknown;
    const fakeService={inspectControl:()=>observation,ensureControlViewer:()=>Promise.resolve({ok:false as const,error:{code:"malformed-control"}}),stopControl:()=>Promise.resolve({ok:false as const,error:{code:"malformed-control"}}),approveControlPairing:()=>Promise.resolve({ok:false as const,error:{code:"unauthorized"}}),close:()=>Promise.resolve()};
    const provider=new RuntimeControlProvider(fakeService as never,f.slot,f.generation,async()=>undefined);provider.markReady();
    const observe=()=>provider.inspect({streamId:ensured.value.snapshot.streamId});

    for(const count of [16,17]){
      const changes=Array.from({length:count},(_,index)=>Object.freeze({...ensured.value.snapshot,revision:index+1})),snapshot=changes.at(-1)!;
      observation={ok:true,value:{snapshot,changes,reset:false,timedOut:false}};
      const result=observe();assert.ok(result.ok);if(result.ok){assert.equal(result.value.reset,count===17);assert.equal(result.value.changes.length,count===17?0:16);}
    }

    const changeAt=(bytes:number)=>{const blank={...ensured.value.snapshot,reason:""},base=encodeCanonicalControlJson([blank]).byteLength,change={...blank,reason:"x".repeat(bytes-base)};assert.equal(encodeCanonicalControlJson([change]).byteLength,bytes);return change;};
    for(const bytes of [12_288,12_289]){
      const changes=[changeAt(bytes)];observation={ok:true,value:{snapshot:ensured.value.snapshot,changes,reset:false,timedOut:false}};
      const result=observe();assert.ok(result.ok);if(result.ok){assert.equal(result.value.reset,bytes===12_289);assert.equal(result.value.changes.length,bytes===12_289?0:1);}
    }

    const fullAt=(bytes:number)=>{const blank={...ensured.value.snapshot,reason:""},base=encodeCanonicalControlJson({ok:true,value:{snapshot:blank,changes:[],reset:false,timedOut:false}}).byteLength,snapshot={...blank,reason:"x".repeat(bytes-base)};assert.equal(encodeCanonicalControlJson({ok:true,value:{snapshot,changes:[],reset:false,timedOut:false}}).byteLength,bytes);return snapshot;};
    observation={ok:true,value:{snapshot:fullAt(16_384),changes:[],reset:false,timedOut:false}};const exact=observe();assert.ok(exact.ok);if(exact.ok)assert.equal(exact.value.reset,false);
    observation={ok:true,value:{snapshot:fullAt(16_385),changes:[],reset:false,timedOut:false}};const fallback=observe();assert.ok(fallback.ok);if(fallback.ok)assert.equal(fallback.value.reset,true);
    observation={ok:true,value:{snapshot:fullAt(16_386),changes:[],reset:false,timedOut:false}};const overload=observe();assert.equal(overload.ok?"":overload.error.code,"runtime-overload");
    const timeoutAt=(bytes:number)=>{const blank={...ensured.value.snapshot,reason:""},base=encodeCanonicalControlJson({ok:true,value:{snapshot:blank,changes:[],reset:false,timedOut:true}}).byteLength,snapshot={...blank,reason:"x".repeat(bytes-base)};assert.equal(encodeCanonicalControlJson({ok:true,value:{snapshot,changes:[],reset:false,timedOut:true}}).byteLength,bytes);return snapshot;};
    observation={ok:true,value:{snapshot:timeoutAt(16_385),changes:[],reset:false,timedOut:true}};const timeoutOverload=observe();assert.equal(timeoutOverload.ok?"":timeoutOverload.error.code,"runtime-overload");
    observation={ok:true,value:{snapshot:{...fullAt(16_400),phase:"stopped"},changes:[],reset:false,timedOut:false}};const terminalOverload=observe();assert.equal(terminalOverload.ok?"":terminalOverload.error.code,"runtime-overload");
  }finally{await f.close();}
});

await test("stop waiting on the shared mutex observes cancellation before linearization",async()=>{
  const state=await stateEnsured();let release!:()=>void;const gate=new Promise<void>((resolve)=>{release=resolve;}),held=state.state.mutex.run(()=>gate),controller=new AbortController(),stopping=state.state.stop({streamId:state.snapshot.streamId,reason:"explicit-stop"},controller.signal);controller.abort();release();await held;await assert.rejects(stopping,MutationCancelled);const inspected=state.state.inspect({streamId:state.snapshot.streamId});assert.ok(inspected.ok);if(inspected.ok)assert.equal(inspected.value.snapshot.phase,"demand-pending");
});

await test("approve waiting on the shared mutex observes cancellation before attempts mutate",async()=>{const state=await stateEnsured(),pairing=await state.auth.startPairing(state.snapshot.streamId);assert.ok(pairing.ok);if(!pairing.ok)return;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),held=state.state.mutex.run(()=>gate),controller=new AbortController(),approval=state.auth.approvePairing({streamId:state.snapshot.streamId,pairingId:pairing.value.pairingId,pairingCode:"ZZZZZZZZ",viewerGrant:state.access.viewerGrant},controller.signal);controller.abort();release();await held;await assert.rejects(approval,MutationCancelled);const correct=await state.auth.approvePairing({streamId:state.snapshot.streamId,pairingId:pairing.value.pairingId,pairingCode:pairing.value.pairingCode,viewerGrant:state.access.viewerGrant});assert.ok(correct.ok);});

await test("stop and approve linearization wins over later cancellation exactly once", async () => {
  const stopped = await stateEnsured(), stopController = new AbortController();
  const firstStop = await stopped.state.stop({ streamId: stopped.snapshot.streamId, reason: "explicit-stop" }, stopController.signal);
  stopController.abort();
  assert.ok(firstStop.ok);
  const repeatedStop = await stopped.state.stop({ streamId: stopped.snapshot.streamId, reason: "explicit-stop" });
  assert.ok(repeatedStop.ok);
  if (firstStop.ok && repeatedStop.ok) assert.deepEqual(repeatedStop.value.snapshot, firstStop.value.snapshot);

  const approved = await stateEnsured(), pairing = await approved.auth.startPairing(approved.snapshot.streamId);
  assert.ok(pairing.ok);
  if (!pairing.ok) return;
  const approveController = new AbortController();
  const firstApprove = await approved.auth.approvePairing({ streamId: approved.snapshot.streamId, pairingId: pairing.value.pairingId, pairingCode: pairing.value.pairingCode, viewerGrant: approved.access.viewerGrant }, approveController.signal);
  approveController.abort();
  assert.ok(firstApprove.ok);
  const replay = await approved.auth.approvePairing({ streamId: approved.snapshot.streamId, pairingId: pairing.value.pairingId, pairingCode: pairing.value.pairingCode, viewerGrant: approved.access.viewerGrant });
  assert.equal(replay.ok, false);
});

await test("HTTP stop and approve force cancellation-before-linearization and success-before-cancellation", async () => {
  for (const cancellationWins of [true, false]) {
    const f = await fixture();
    try {
      const ensured = await f.host.provider.ensureViewer();
      assert.ok(ensured.ok);
      if (!ensured.ok) continue;
      const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
      const original = f.service.stopControl.bind(f.service);
      let enter!: () => void, release!: () => void, aborted!:Promise<void>,applications = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      f.service.stopControl = async (value, signal) => {
        assert.ok(signal);
        aborted=signal.aborted?Promise.resolve():new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
        enter();
        await gate;
        if (signal.aborted) throw new MutationCancelled();
        applications++;
        return original(value, signal);
      };
      const request = await rawMutation(f.slot, "/v1/stream/stop", "client", { controlVersion: CONTROL_VERSION, target, streamId: ensured.value.snapshot.streamId, expectedRevision: null });
      await entered;
      if (cancellationWins) {
        request.socket.destroy();
        await request.settled;
        await awaitServerAbort(aborted);
        release();
      } else {
        release();
        assert.match((await request.settled).reply, /^HTTP\/1\.1 200 /);
      }
      await awaitAdmission(f.host, { preauth: 0, authenticated: 0, inFlight: 0 });
      assert.equal(applications, cancellationWins ? 0 : 1);
      const inspected = f.host.provider.inspect({ streamId: ensured.value.snapshot.streamId });
      assert.ok(inspected.ok);
      if (inspected.ok) assert.equal(inspected.value.snapshot.phase, cancellationWins ? "demand-pending" : "stopped");
      f.service.stopControl = original;
    } finally { await f.close(); }
  }

  for (const cancellationWins of [true, false]) {
    const f = await fixture();
    try {
      const ensured = await f.host.provider.ensureViewer();
      assert.ok(ensured.ok);
      if (!ensured.ok) continue;
      const pairingReply = await viewerCall(f.service.origin!, "/v1/pairings", { streamId: ensured.value.snapshot.streamId });
      const pairing = JSON.parse(new TextDecoder().decode(pairingReply.body)) as { pairingCode: string };
      const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
      const original = f.service.approveControlPairing.bind(f.service);
      let enter!: () => void, release!: () => void, aborted!:Promise<void>,applications = 0;
      const entered = new Promise<void>(resolve => { enter = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
      f.service.approveControlPairing = async (streamId, pairingCode, signal) => {
        assert.ok(signal);
        aborted=signal.aborted?Promise.resolve():new Promise<void>(resolve=>signal.addEventListener("abort",()=>resolve(),{once:true}));
        enter();
        await gate;
        if (signal.aborted) throw new MutationCancelled();
        applications++;
        return original(streamId, pairingCode, signal);
      };
      const request = await rawMutation(f.slot, "/v1/viewer/approve", "owner", { controlVersion: CONTROL_VERSION, target, streamId: ensured.value.snapshot.streamId, pairingCode: pairing.pairingCode });
      await entered;
      if (cancellationWins) {
        request.socket.destroy();
        await request.settled;
        await awaitServerAbort(aborted);
        release();
      } else {
        release();
        assert.match((await request.settled).reply, /^HTTP\/1\.1 200 /);
      }
      await awaitAdmission(f.host, { preauth: 0, authenticated: 0, inFlight: 0 });
      assert.equal(applications, cancellationWins ? 0 : 1);
      f.service.approveControlPairing = original;
      const owner = new OwnerHttpControl(f.slot.control.port, target, f.slot.control.credential);
      try {
        const replay = await owner.approveViewerPairing({ streamId: ensured.value.snapshot.streamId, pairingCode: pairing.pairingCode });
        assert.equal(replay.ok, cancellationWins);
      } finally { await owner.close(); }
    } finally { await f.close(); }
  }
});

await test("ensure waiting on the shared mutex observes cancellation before identity publication",async()=>{const state=stateFixture();let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),held=state.state.mutex.run(()=>gate),controller=new AbortController(),ensuring=state.state.runControl(controller.signal,()=>state.state.ensureLocked({deviceRef:DEVICE,idempotencyKey:KEY}));controller.abort();release();await held;await assert.rejects(ensuring,MutationCancelled);const retry=await state.state.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY});assert.ok(retry.ok);});

await test("owner approve after grant deadline cannot retain or replace the expired grant",async()=>{
  const clock=new FakeClock(),f=await fixture(clock);try{const ensured=await f.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;const started=await viewerCall(f.service.origin!,"/v1/pairings",{streamId:ensured.value.snapshot.streamId});const pairing=JSON.parse(new TextDecoder().decode(started.body))as{pairingCode:string};clock.tick(60_000);const owner=new OwnerHttpControl(f.slot.control.port,{instanceId:f.generation.instanceId,generation:f.generation.generation},f.slot.control.credential);try{const approved=await owner.approveViewerPairing({streamId:ensured.value.snapshot.streamId,pairingCode:pairing.pairingCode});assert.equal(approved.ok?"":approved.error.code,"unauthorized");const repeated=await f.host.provider.ensureViewer();assert.equal(repeated.ok?"":repeated.error.code,"unauthorized");}finally{await owner.close();}}finally{await f.close();}
});

await test("closed owner capabilities release keep-alive resources and fail deterministically",async()=>{
  const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation};for(let index=0;index<9;index++){const owner=new OwnerHttpControl(f.slot.control.port,target,f.slot.control.credential);const result=await owner.approveViewerPairing({streamId:randomUUID(),pairingCode:"ABCDEFGH"});assert.equal(result.ok?"":result.error.code,"unauthorized");await owner.close();const closed=await owner.approveViewerPairing({streamId:randomUUID(),pairingCode:"ABCDEFGH"});assert.equal(closed.ok?"":closed.error.code,"runtime-exited");}}finally{await f.close();}
});

await test("hello client rejects canonical success from another route and invalid response metadata",async()=>{
  const f=await fixture();try{const instance=f.host.provider.instance,expected={instanceId:instance.instanceId,generation:instance.generation},ensured=await f.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;await f.host.close();const wrong=encodeCanonicalControlJson({ok:true,value:{snapshot:ensured.value.snapshot}}),hello=encodeCanonicalControlJson({ok:true,value:{instance}}),base=(body:Uint8Array):Record<string,string>=>({"Content-Type":"application/json; charset=utf-8","Content-Length":String(body.byteLength),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});await fakeControlReply(f.slot.control.port,200,base(wrong),wrong,async()=>{const result=await helloControl(f.slot,expected);assert.equal(result.ok?"":result.error.code,"local-state-recovery-required");});await fakeControlReply(f.slot.control.port,201,base(hello),hello,async()=>{const result=await helloControl(f.slot,expected);assert.equal(result.ok?"":result.error.code,"local-state-recovery-required");});const missing=base(hello);delete missing["X-Content-Type-Options"];await fakeControlReply(f.slot.control.port,200,missing,hello,async()=>{const result=await helloControl(f.slot,expected);assert.equal(result.ok?"":result.error.code,"local-state-recovery-required");});}finally{await f.close();}
});


await test("the sixty-fifth request on one authenticated socket is rejected and closed",async()=>{
  const f=await fixture(),agent=new Agent({keepAlive:true,maxSockets:1});try{const value={controlVersion:CONTROL_VERSION,contractVersion:2,deviceRef:f.slot.deviceRef,expectedInstance:{instanceId:f.generation.instanceId,generation:f.generation.generation}},auth=`FSQ-Control ${deriveControlBearer(f.slot.control.credential,"client")}`;for(let index=1;index<=65;index++){const response=await agentCall(f.slot,agent,value,auth);assert.equal(response.status,index===65?429:200);}}finally{agent.destroy();await f.close();}
});

await test("stop and ensure expose only mutex-ordered old or new streams",async()=>{
  const f=await fixture();try{const first=await f.host.provider.ensureViewer();assert.ok(first.ok);if(!first.ok)return;const stopping=f.host.provider.stopStream({streamId:first.value.snapshot.streamId}),ensuring=f.host.provider.ensureViewer(),[stopped,next]=await Promise.all([stopping,ensuring]);assert.ok(stopped.ok);assert.ok(next.ok);if(next.ok){assert.notEqual(next.value.snapshot.streamId,first.value.snapshot.streamId);assert.equal(next.value.snapshot.phase,"demand-pending");}assert.equal(f.source.opens,0);}finally{await f.close();}
});

await test("owner approve response loss is state-unknown and never replayed",async()=>{
  const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation};await f.host.close();let requests=0;const server=createHttpServer((request)=>{requests++;request.socket.destroy();});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:f.slot.control.port,exclusive:true},resolve);});try{const owner=new OwnerHttpControl(f.slot.control.port,target,f.slot.control.credential);try{const result=await owner.approveViewerPairing({streamId:randomUUID(),pairingCode:"ABCDEFGH"});assert.equal(result.ok?"":result.error.code,"deadline-exceeded");if(!result.ok)assert.equal(result.error.operationState,"unknown");assert.equal(requests,1);}finally{await owner.close();}}finally{await new Promise<void>((resolve)=>server.close(()=>resolve()));}}finally{await f.close();}
});

await test("all seven clients fail closed for wrong-route DTO status headers and body lengths",async()=>{
  const f=await fixture();
  try{
    const target={instanceId:f.generation.instanceId,generation:f.generation.generation},instance=f.host.provider.instance,snapshot=await f.host.provider.ensureViewer();
    assert.ok(snapshot.ok);if(!snapshot.ok)return;
    await f.host.close();
    const hello=encodeCanonicalControlJson({ok:true,value:{instance}}),stop=encodeCanonicalControlJson({ok:true,value:{snapshot:snapshot.value.snapshot}}),routes:ClientRoute[]=["hello","ensure","inspect","wait","stop","approve","shutdown"];
    const base=(body:Uint8Array):Record<string,string>=>({"Content-Type":"application/json; charset=utf-8","Content-Length":String(body.byteLength),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    for(const route of routes){
      const wrong=route==="hello"?stop:hello,invalid=route==="hello"?"local-state-recovery-required":"runtime-exited";
      const cases:ReadonlyArray<readonly[number,Record<string,string>,Uint8Array,boolean]>=[
        [200,base(wrong),wrong,false],
        [201,base(hello),hello,false],
        [200,{...base(hello),"Content-Length":String(hello.byteLength+1)},hello,true],
        [200,((headers)=>{delete headers["Cache-Control"];return headers;})(base(hello)),hello,false],
        [200,base(hello),hello.slice(0,-1),true],
        [200,base(Buffer.concat([hello,Buffer.from(" ")])),Buffer.concat([hello,Buffer.from(" ")]),false],
      ];
      for(const [status,headers,body,responseLoss] of cases)await fakeControlReply(f.slot.control.port,status,headers,body,async()=>{
        const result=await invokeClientRoute(route,f.slot,target)as{ok:boolean;error?:ControlError};
        assert.equal(result.ok?"":result.error?.code,route==="wait"&&responseLoss?"deadline-exceeded":invalid);
      });
    }
  }finally{await f.close();}
});

await test("six operation clients enforce exact per-route error membership", async () => {
  const f = await fixture();
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
    await f.host.close();
    const memberships: Readonly<Record<Exclude<ClientRoute, "hello">, ReadonlySet<string>>> = {
      ensure: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "unauthorized", "deadline-exceeded"]),
      inspect: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "deadline-exceeded"]),
      wait: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "deadline-exceeded"]),
      stop: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "deadline-exceeded"]),
      approve: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "unauthorized", "deadline-exceeded"]),
      shutdown: new Set(["instance-conflict", "control-version-mismatch", "malformed-control", "runtime-exited", "runtime-overload", "deadline-exceeded"]),
    };
    for (const route of Object.keys(memberships) as (Exclude<ClientRoute, "hello">)[]) {
      for (const code of Object.keys(CONTROL_ERRORS) as (keyof typeof CONTROL_ERRORS)[]) {
        const error = controlError(code), body = encodeCanonicalControlJson({ ok: false, error });
        const headers = { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.byteLength), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        await fakeControlReply(f.slot.control.port, controlErrorStatus(error), headers, body, async () => {
          const result = await invokeClientRoute(route, f.slot, target) as { ok: boolean; error?: ControlError };
          assert.equal(result.ok, false);
          assert.equal(result.error?.code, memberships[route].has(code) ? code : "runtime-exited");
        });
      }
    }
  } finally { await f.close(); }
});

await test("shutdown completes owned cleanup when requester disconnects during service close",async()=>{
  const base=await fixture();await base.host.close();await base.service.close();const target={instanceId:randomUUID(),generation:randomUUID()},generation:RuntimeGenerationState=Object.freeze({runtimeStateVersion:1,deviceRef:base.slot.deviceRef,...target,port:base.slot.control.port,createdAt:base.slot.createdAt,ready:true});let release!:()=>void,closeStarted!:()=>void,shutdown!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{closeStarted=resolve;}),cleaned=new Promise<void>(resolve=>{shutdown=resolve;}),service={async close(){closeStarted();await gate;}};let host!:RuntimeControlHost;host=new RuntimeControlHost({service:service as never,slot:base.slot,generation,onShutdown:async()=>{shutdown();await host.close();}});await host.start();host.ready();try{const owner=deriveControlBearer(base.slot.control.credential,"owner"),body=new TextDecoder().decode(encodeCanonicalControlJson({controlVersion:CONTROL_VERSION,target})),socket=netConnect({host:"127.0.0.1",port:base.slot.control.port},()=>socket.write(`POST /v1/runtime/shutdown HTTP/1.1\r\nHost: 127.0.0.1:${base.slot.control.port}\r\nAuthorization: FSQ-Owner ${owner}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`));await started;socket.destroy();release();await cleaned;}finally{release();await host.close().catch(()=>undefined);await base.close();}
});

await test("completed ensure returns the old stream before a later stop",async()=>{
  const f=await fixture();try{const first=await f.host.provider.ensureViewer();assert.ok(first.ok);if(!first.ok)return;const same=await f.host.provider.ensureViewer();assert.ok(same.ok);if(same.ok)assert.equal(same.value.snapshot.streamId,first.value.snapshot.streamId);const stopped=await f.host.provider.stopStream({streamId:first.value.snapshot.streamId});assert.ok(stopped.ok);assert.equal(f.source.opens,0);}finally{await f.close();}
});

await test("the ninth authenticated in-flight request is rejected before body allocation",async()=>{const f=await fixture(),sockets:Socket[]=[];try{const bearer=deriveControlBearer(f.slot.control.credential,"client"),authority=`127.0.0.1:${f.slot.control.port}`,prefix=`POST /v1/control/hello HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\n\r\n`;for(let index=0;index<8;index++){const socket=await openSocket(f.slot.control.port);socket.write(prefix);sockets.push(socket);}await new Promise(resolve=>setImmediate(resolve));const target={instanceId:f.generation.instanceId,generation:f.generation.generation},request={controlVersion:CONTROL_VERSION,contractVersion:2,deviceRef:f.slot.deviceRef,expectedInstance:target},auth=`FSQ-Control ${bearer}`,reply=await call(f.slot,"/v1/control/hello",request,auth);assert.equal(reply.status,429);for(const socket of sockets.splice(0))socket.destroy();await new Promise(resolve=>setImmediate(resolve));assert.equal((await call(f.slot,"/v1/control/hello",request,auth)).status,200);}finally{for(const socket of sockets)socket.destroy();await f.close();}});

await test("all seven clients reject every duplicate mandatory response header",async()=>{const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation},instance=f.host.provider.instance;await f.host.close();const body=encodeCanonicalControlJson({ok:true,value:{instance}}),routes:ClientRoute[]=["hello","ensure","inspect","wait","stop","approve","shutdown"];for(const route of routes)for(const header of ["Content-Type","Content-Length","Cache-Control","X-Content-Type-Options"])await fakeDuplicateReply(f.slot.control.port,header,body,async()=>{const result=await invokeClientRoute(route,f.slot,target)as{ok:boolean;error?:ControlError};assert.equal(result.ok?"":result.error?.code,route==="hello"?"local-state-recovery-required":"runtime-exited");});}finally{await f.close();}});

await test("header timeout returns fixed 408 and releases preauth admission",async()=>{const f=await fixture();try{const reply=await new Promise<string>((resolve,reject)=>{const socket=netConnect({host:"127.0.0.1",port:f.slot.control.port},()=>socket.write("POST /v1/control/hello HTTP/1.1\r\n")),chunks:Buffer[]=[];socket.on("data",chunk=>chunks.push(Buffer.from(chunk)));socket.on("end",()=>resolve(Buffer.concat(chunks).toString()));socket.on("error",reject);});assert.match(reply,/^HTTP\/1\.1 408 /);const target={instanceId:f.generation.instanceId,generation:f.generation.generation},auth=`FSQ-Control ${deriveControlBearer(f.slot.control.credential,"client")}`;assert.equal((await call(f.slot,"/v1/control/hello",{controlVersion:CONTROL_VERSION,contractVersion:2,deviceRef:f.slot.deviceRef,expectedInstance:target},auth)).status,200);}finally{await f.close();}});

await test("body total deadline wins despite sub-idle chunks",async()=>{const f=await fixture();try{const bearer=deriveControlBearer(f.slot.control.credential,"client"),reply=await new Promise<string>((resolve,reject)=>{const chunks:Buffer[]=[];let timer:NodeJS.Timeout|undefined;const socket=netConnect({host:"127.0.0.1",port:f.slot.control.port},()=>{socket.write(`POST /v1/control/hello HTTP/1.1\r\nHost: 127.0.0.1:${f.slot.control.port}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 10\r\nConnection: close\r\n\r\n`);timer=setInterval(()=>socket.write("x"),1_000);});socket.on("data",chunk=>chunks.push(Buffer.from(chunk)));socket.on("end",()=>{if(timer)clearInterval(timer);resolve(Buffer.concat(chunks).toString());});socket.on("error",cause=>{if(timer)clearInterval(timer);reject(cause);});});assert.match(reply,/^HTTP\/1\.1 408 /);}finally{await f.close();}});

await test("post-connect response total deadline is independent of connect budget",async()=>{const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation};await f.host.close();const sockets=new Set<Socket>(),server=createNetServer(socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));socket.once("data",()=>undefined);});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:f.slot.control.port,exclusive:true},resolve);});try{const result=await helloControl(f.slot,target);assert.equal(result.ok?"":result.error.code,"deadline-exceeded");}finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}}finally{await f.close();}});


await test("deterministic client connect deadline covers 999 1000 and 1001ms",async()=>{
  const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation};for(const elapsed of [999,1_000,1_001]){const timer=new FakeControlTimer(),pending=helloControl(f.slot,target,undefined,timer);await new Promise<void>(resolve=>process.nextTick(resolve));timer.advance(elapsed);const result=await pending;if(elapsed===999)assert.ok(result.ok);else assert.equal(result.ok?"":result.error.code,"deadline-exceeded");assert.equal(timer.count(),0);}}finally{await f.close();}
});

await test("deterministic post-connect total covers 4999 5000 and 5001ms",async()=>{
  const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation};await f.host.close();for(const elapsed of [4_999,5_000,5_001]){const timer=new FakeControlTimer(),sockets=new Set<Socket>();let accept!:()=>void;const accepted=new Promise<void>(resolve=>{accept=resolve;}),server=createNetServer(socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));socket.once("data",accept);});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:f.slot.control.port,exclusive:true},resolve);});const pending=helloControl(f.slot,target,undefined,timer);await accepted;await awaitTimerCount(timer,1);timer.advance(elapsed);if(elapsed===4_999){let settled=false;void pending.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);timer.advance(1);}const result=await pending;assert.equal(result.ok?"":result.error.code,"deadline-exceeded");assert.equal(timer.count(),0);for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}}finally{await f.close();}
});

await test("deterministic Host header deadline covers 4999 5000 and 5001ms",async()=>{
  for(const elapsed of [4_999,5_000,5_001]){const timer=new FakeControlTimer(),f=await fixture(new FakeClock(),timer);try{const socket=await openSocket(f.slot.control.port),collected=collectSocket(socket);await awaitTimerCount(timer,1);timer.advance(elapsed);if(elapsed===4_999)socket.write(`POST /v1/control/hello HTTP/1.1\r\nHost: 127.0.0.1:${f.slot.control.port}\r\nAuthorization: FSQ-Control ${deriveControlBearer(f.slot.control.credential,"client")}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);await new Promise(resolve=>setImmediate(resolve));const result=await collected;if(elapsed===4_999){assert.equal(result.reset,false);assert.equal(/^HTTP\/1\.1 408 /.test(result.reply),false);}else assert.ok(result.reset||/^HTTP\/1\.1 408 /.test(result.reply));assert.equal(timer.count(),0);socket.destroy();}finally{await f.close();}}
});

await test("deterministic Host body idle covers 1999 2000 and 2001ms",async()=>{
  for(const elapsed of [1_999,2_000,2_001]){const timer=new FakeControlTimer(),f=await fixture(new FakeClock(),timer);try{const bearer=deriveControlBearer(f.slot.control.credential,"client"),socket=await openSocket(f.slot.control.port),collected=collectSocket(socket);socket.write(`POST /v1/control/hello HTTP/1.1\r\nHost: 127.0.0.1:${f.slot.control.port}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{`);await awaitTimerCount(timer,2);timer.advance(elapsed);if(elapsed===1_999)socket.write("}");await new Promise(resolve=>setImmediate(resolve));const result=await collected;if(elapsed===1_999){assert.equal(result.reset,false);assert.equal(/^HTTP\/1\.1 408 /.test(result.reply),false);}else assert.ok(result.reset||/^HTTP\/1\.1 408 /.test(result.reply));assert.equal(timer.count(),0);socket.destroy();}finally{await f.close();}}
});
await test("deterministic client response read-idle covers 1999 2000 and 2001ms",async()=>{
  const f=await fixture();try{const target={instanceId:f.generation.instanceId,generation:f.generation.generation},instance=f.host.provider.instance;await f.host.close();const body=encodeCanonicalControlJson({ok:true,value:{instance}});for(const elapsed of [1_999,2_000,2_001]){const timer=new FakeControlTimer();let peer!:Socket,release!:()=>void,peerDone!:Promise<void>;const partial=new Promise<void>(resolve=>{release=resolve;}),server=createNetServer(socket=>{peer=socket;peerDone=new Promise<void>((resolve,reject)=>{let done=false;const cleanup=()=>{socket.off("close",close);socket.off("error",error);},finish=()=>{if(done)return;done=true;cleanup();resolve();},close=()=>finish(),error=(cause:NodeJS.ErrnoException)=>{if(cause.code==="ECONNRESET")finish();else{if(done)return;done=true;cleanup();reject(cause);}};socket.once("close",close);socket.once("error",error);});socket.once("data",()=>{socket.write(`HTTP/1.1 200 OK\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${body.byteLength}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\n\r\n`);socket.write(body.slice(0,-1));release();});});await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:f.slot.control.port,exclusive:true},resolve);});const pending=helloControl(f.slot,target,undefined,timer);await partial;await awaitTimerCount(timer,2);timer.advance(elapsed);if(elapsed===1_999)peer.end(body.slice(-1));await new Promise(resolve=>setImmediate(resolve));const result=await Promise.race([pending,new Promise<never>((_resolve,reject)=>setTimeout(()=>reject(new Error("client fixture timeout")),1_000))]);if(elapsed===1_999)assert.ok(result.ok);else assert.equal(result.ok?"":result.error.code,"local-state-recovery-required");assert.equal(timer.count(),0);if(!peer.destroyed)peer.destroy();await peerDone;await new Promise<void>(resolve=>server.close(()=>resolve()));}}finally{await f.close();}
});

await test("auth failure premature EOF pipeline body timeout and clientError release every admission counter", async () => {
  const timer = new FakeControlTimer(), f = await fixture(new FakeClock(), timer), zero = { preauth: 0, authenticated: 0, inFlight: 0 };
  try {
    const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
    const body = new TextDecoder().decode(encodeCanonicalControlJson({ controlVersion: CONTROL_VERSION, contractVersion: 2, deviceRef: f.slot.deviceRef, expectedInstance: target }));
    const authority = `127.0.0.1:${f.slot.control.port}`, bearer = deriveControlBearer(f.slot.control.credential, "client");
    const request = `POST /v1/control/hello HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`;
    const failed = await call(f.slot, "/v1/control/hello", { controlVersion: CONTROL_VERSION, contractVersion: 2, deviceRef: f.slot.deviceRef, expectedInstance: target }, `FSQ-Control ${"A".repeat(43)}`);
    assert.equal(failed.status, 401);
    await awaitAdmission(f.host, zero);

    const premature = `POST /v1/control/hello HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n`;
    for (const raw of [premature, `${request.replace("Connection: close\r\n", "")}${request}`, "BROKEN\r\n\r\n"]) {
      const socket = await openSocket(f.slot.control.port), settled = collectSocket(socket);
      socket.end(raw);
      await settled;
      await awaitAdmission(f.host, zero);
    }

    const socket = await openSocket(f.slot.control.port), settled = collectSocket(socket);
    socket.write(`POST /v1/control/hello HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${bearer}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{`);
    await awaitTimerCount(timer, 2);
    timer.advance(2_000);
    await settled;
    await awaitAdmission(f.host, zero);
    assert.equal(timer.count(), 0);
  } finally { await f.close(); }
});

await test("authenticated keep-alive re-arms the next-header deadline at 4999 5000 and 5001ms", async () => {
  for (const elapsed of [4_999, 5_000, 5_001]) {
    const timer = new FakeControlTimer(), f = await fixture(new FakeClock(), timer);
    try {
      const target = { instanceId: f.generation.instanceId, generation: f.generation.generation };
      const body = new TextDecoder().decode(encodeCanonicalControlJson({ controlVersion: CONTROL_VERSION, contractVersion: 2, deviceRef: f.slot.deviceRef, expectedInstance: target }));
      const authority = `127.0.0.1:${f.slot.control.port}`;
      const request = `POST /v1/control/hello HTTP/1.1\r\nHost: ${authority}\r\nAuthorization: FSQ-Control ${deriveControlBearer(f.slot.control.credential, "client")}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
      const socket = await openSocket(f.slot.control.port), first = readOneResponse(socket);
      socket.write(request);
      assert.match(await first, /^HTTP\/1\.1 200 /);
      await awaitAdmission(f.host, { preauth: 0, authenticated: 1, inFlight: 0 });
      await awaitTimerCount(timer, 1);
      const second = collectSocket(socket);
      timer.advance(elapsed);
      if (elapsed === 4_999) socket.write(request.replace("\r\n\r\n", "\r\nConnection: close\r\n\r\n"));
      const result = await second;
      if (elapsed === 4_999) {
        assert.equal(result.reset, false);
        assert.equal(/^HTTP\/1\.1 408 /.test(result.reply), false);
      } else assert.ok(result.reset || /^HTTP\/1\.1 408 /.test(result.reply));
      await awaitAdmission(f.host, { preauth: 0, authenticated: 0, inFlight: 0 });
      assert.equal(timer.count(), 0);
    } finally { await f.close(); }
  }
});

await test("temporary control client proves timeout cancellation session-close and no stream side effect",async()=>{
  const f=await fixture();
  try{
    const hello=await helloControl(f.slot,null);assert.ok(hello.ok);if(!hello.ok)return;
    const attached=await attachControlSession(f.slot.control.port,{disposition:"attached",instance:hello.value.instance},f.slot.control.credential);assert.ok(attached.ok);if(!attached.ok)return;
    const ensured=await attached.session.control.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const streamId=ensured.value.snapshot.streamId,revision=ensured.value.snapshot.revision;
    const inspected=await attached.session.control.inspect({streamId});assert.ok(inspected.ok);if(inspected.ok)assert.equal(inspected.value.timedOut,false);
    const timeout=await attached.session.control.wait({streamId,afterRevision:revision,waitMs:0});assert.ok(timeout.ok);if(timeout.ok)assert.deepEqual({changes:timeout.value.changes,reset:timeout.value.reset,timedOut:timeout.value.timedOut},{changes:[],reset:false,timedOut:true});

    const controller=new AbortController(),cancelled=attached.session.control.wait({streamId,afterRevision:revision,waitMs:30_000},{signal:controller.signal});
    await awaitAdmission(f.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    controller.abort();
    const cancelledResult=await cancelled;
    assert.equal(cancelledResult.ok?"":cancelledResult.error.code,"request-cancelled");
    await awaitAdmission(f.host,{preauth:0,authenticated:0,inFlight:0,waits:0});

    const closing=attached.session.control.wait({streamId,afterRevision:revision,waitMs:30_000});
    await awaitAdmission(f.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    await attached.session.close();
    const closedResult=await closing;
    assert.equal(closedResult.ok?"":closedResult.error.code,"request-cancelled");
    await awaitAdmission(f.host,{preauth:0,authenticated:0,inFlight:0,waits:0});
    const after=f.host.provider.inspect({streamId});assert.ok(after.ok);if(after.ok){assert.equal(after.value.snapshot.revision,revision);assert.equal(after.value.snapshot.phase,"demand-pending");}
    assert.equal(f.source.opens,0);
    const closed=await attached.session.control.wait({streamId,afterRevision:revision,waitMs:0});assert.equal(closed.ok?"":closed.error.code,"runtime-exited");
  }finally{await f.close();}
});

await test("temporary control client freezes stopping then reconnects from the cursor to terminal",async()=>{
  const f=await fixture();
  try{
    const hello=await helloControl(f.slot,null);assert.ok(hello.ok);if(!hello.ok)return;
    const first=await attachControlSession(f.slot.control.port,{disposition:"attached",instance:hello.value.instance},f.slot.control.credential);assert.ok(first.ok);if(!first.ok)return;
    const ensured=await first.session.control.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const waiting=first.session.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000});
    await awaitAdmission(f.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    const stopped=f.host.provider.stopStream({streamId:ensured.value.snapshot.streamId});
    const firstChange=await waiting;assert.ok(firstChange.ok);if(!firstChange.ok)return;
    assert.equal(firstChange.value.snapshot.phase,"stopping");
    assert.deepEqual(firstChange.value.changes.at(-1),firstChange.value.snapshot);
    assert.equal(firstChange.value.timedOut,false);
    assert.ok((await stopped).ok);
    await first.session.close();

    const second=await attachControlSession(f.slot.control.port,{disposition:"attached",instance:hello.value.instance},f.slot.control.credential);assert.ok(second.ok);if(!second.ok)return;
    const final=await second.session.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:firstChange.value.snapshot.revision,waitMs:30_000});
    assert.ok(final.ok);if(final.ok){assert.equal(final.value.snapshot.phase,"stopped");assert.deepEqual(final.value.changes.at(-1),final.value.snapshot);assert.equal(final.value.timedOut,false);}
    await second.session.close();
    assert.equal(f.source.opens,0);
  }finally{await f.close();}
});

await test("Host and StateStore admit four waits and reject the fifth before allocation",async()=>{
  const f=await fixture(),sessions:RuntimeControlSession[]=[],controllers:AbortController[]=[];
  try{
    const hello=await helloControl(f.slot,null);assert.ok(hello.ok);if(!hello.ok)return;
    for(let index=0;index<5;index++){const attached=await attachControlSession(f.slot.control.port,{disposition:"attached",instance:hello.value.instance},f.slot.control.credential);assert.ok(attached.ok);if(attached.ok)sessions.push(attached.session);}
    const ensured=await sessions[0]!.control.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const waits:ReturnType<RuntimeControlSession["control"]["wait"]>[]=[];
    for(let index=0;index<4;index++){
      const controller=new AbortController();controllers.push(controller);
      waits.push(sessions[index]!.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000},{signal:controller.signal}));
      await awaitAdmission(f.host,{preauth:0,authenticated:index+1,inFlight:index+1,waits:index+1});
    }
    const fifth=await sessions[4]!.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000});
    assert.equal(fifth.ok?"":fifth.error.code,"runtime-overload");
    assert.equal(f.host.admissionSnapshot().waits,4);
    for(const controller of controllers)controller.abort();
    const results=await Promise.all(waits);assert.ok(results.every(result=>!result.ok&&result.error.code==="request-cancelled"));
    for(const session of sessions)await session.close();
    await awaitAdmission(f.host,{preauth:0,authenticated:0,inFlight:0,waits:0});
  }finally{for(const controller of controllers)controller.abort();for(const session of sessions)await session.close().catch(()=>undefined);await f.close();}
});

await test("one local client rejects a second wait before opening another socket",async()=>{
  const f=await fixture();
  try{
    const hello=await helloControl(f.slot,null);assert.ok(hello.ok);if(!hello.ok)return;
    const attached=await attachControlSession(f.slot.control.port,{disposition:"attached",instance:hello.value.instance},f.slot.control.credential);assert.ok(attached.ok);if(!attached.ok)return;
    const ensured=await attached.session.control.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const controller=new AbortController(),first=attached.session.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000},{signal:controller.signal});
    await awaitAdmission(f.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    const second=await attached.session.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000});
    assert.equal(second.ok?"":second.error.code,"runtime-overload");
    assert.deepEqual(f.host.admissionSnapshot(),{preauth:0,authenticated:1,inFlight:1,waits:1});
    controller.abort();await first;await attached.session.close();
    await awaitAdmission(f.host,{preauth:0,authenticated:0,inFlight:0,waits:0});
  }finally{await f.close();}
});

await test("authenticated legacy feature identity fails as control-version-mismatch without fallback",async()=>{
  const f=await fixture();
  try{
    const target={instanceId:f.generation.instanceId,generation:f.generation.generation},base=(body:Uint8Array):Record<string,string>=>({"Content-Type":"application/json; charset=utf-8","Content-Length":String(body.byteLength),"Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    await f.host.close();
    const cases:ReadonlyArray<readonly[number,readonly unknown[],string]>=[
      [200,[],"control-version-mismatch"],
      [409,[],"local-state-recovery-required"],
      [200,["watch-v1"],"local-state-recovery-required"],
      [200,["wait-v1","watch-v1"],"local-state-recovery-required"],
    ];
    for(const [status,features,expected] of cases){
      const body=encodeCanonicalControlJson({ok:true,value:{instance:{controlVersion:CONTROL_VERSION,instanceId:f.generation.instanceId,generation:f.generation.generation,contractVersion:2,deviceRef:f.slot.deviceRef,features}}});
      await fakeControlReply(f.slot.control.port,status,base(body),body,async()=>{
        const result=await helloControl(f.slot,target);
        assert.equal(result.ok?"":result.error.code,expected);
      });
    }
  }finally{await f.close();}
});

await test("wait request dispatch is exact and invalid requests allocate no wait",async()=>{
  const f=await fixture();
  try{
    const ensured=await f.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const target={instanceId:f.generation.instanceId,generation:f.generation.generation},auth=`FSQ-Control ${deriveControlBearer(f.slot.control.credential,"client")}`,base={controlVersion:CONTROL_VERSION,target,streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:0};
    const extraBody=JSON.stringify({...base,extra:true}),extraReply=await rawRequest(f.slot.control.port,`POST /v1/stream/wait HTTP/1.1\r\nHost: 127.0.0.1:${f.slot.control.port}\r\nAuthorization: ${auth}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(extraBody)}\r\nConnection: close\r\n\r\n${extraBody}`);
    assert.match(extraReply,/^HTTP\/1\.1 400 /);assert.equal(f.host.admissionSnapshot().waits,0);
    for(const request of [{...base,waitMs:30_001},{...base,afterRevision:0}]){
      const reply=await call(f.slot,"/v1/stream/wait",request,auth);assert.equal(reply.status,400);assert.equal(f.host.admissionSnapshot().waits,0);
    }
  }finally{await f.close();}
});

await test("wait post-connect deadline is exactly waitMs plus five seconds",async()=>{
  const f=await fixture();
  try{
    const instance=f.host.provider.instance;await f.host.close();
    let accept!:()=>void;const accepted=new Promise<void>(resolve=>{accept=resolve;}),sockets=new Set<Socket>(),server=createNetServer(socket=>{sockets.add(socket);socket.once("close",()=>sockets.delete(socket));socket.once("data",accept);});
    await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:f.slot.control.port,exclusive:true},resolve);});
    try{
      const timer=new FakeControlTimer(),attached=await attachControlSession(f.slot.control.port,{disposition:"attached",instance},f.slot.control.credential,undefined,timer);assert.ok(attached.ok);if(!attached.ok)return;
      const pending=attached.session.control.wait({streamId:randomUUID(),afterRevision:1,waitMs:30_000});
      await accepted;await awaitTimerCount(timer,1);timer.advance(34_999);
      let settled=false;void pending.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);
      timer.advance(1);const result=await pending;assert.equal(result.ok?"":result.error.code,"deadline-exceeded");assert.equal(timer.count(),0);await attached.session.close();
    }finally{for(const socket of sockets)socket.destroy();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  }finally{await f.close();}
});

await test("Host hard ceiling is exactly validated waitMs plus five seconds",async()=>{
  const timer=new FakeControlTimer(),f=await fixture(new FakeClock(),timer);
  try{
    const ensured=await f.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const original=f.service.waitControl.bind(f.service);
    let entered!:()=>void;
    const started=new Promise<void>(resolve=>{entered=resolve;});
    f.service.waitControl=(_input,signal)=>new Promise<never>((_resolve,reject)=>{
      entered();
      if(signal?.aborted)reject(new MutationCancelled());
      else signal?.addEventListener("abort",()=>reject(new MutationCancelled()),{once:true});
    });
    const target={instanceId:f.generation.instanceId,generation:f.generation.generation},auth=`FSQ-Control ${deriveControlBearer(f.slot.control.credential,"client")}`;
    const pending=call(f.slot,"/v1/stream/wait",{controlVersion:CONTROL_VERSION,target,streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000},auth,{Connection:"close"});
    await started;await awaitAdmission(f.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    timer.advance(34_999);let settled=false;void pending.then(()=>{settled=true;});await Promise.resolve();assert.equal(settled,false);
    timer.advance(1);const reply=await pending;assert.equal(reply.status,504);const result=decoded<{ok:false;error:ControlError}>(reply.body);assert.equal(result.error.code,"deadline-exceeded");
    f.service.waitControl=original;
    await awaitAdmission(f.host,{preauth:0,authenticated:0,inFlight:0,waits:0});
  }finally{await f.close();}
});

await test("peer socket and Host close each detach only their pending wait",async()=>{
  const peerFixture=await fixture();
  try{
    const ensured=await peerFixture.host.provider.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const target={instanceId:peerFixture.generation.instanceId,generation:peerFixture.generation.generation},request=await rawMutation(peerFixture.slot,"/v1/stream/wait","client",{controlVersion:CONTROL_VERSION,target,streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000});
    await awaitAdmission(peerFixture.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    request.socket.destroy();await request.settled;
    await awaitAdmission(peerFixture.host,{preauth:0,authenticated:0,inFlight:0,waits:0});
    const unchanged=peerFixture.host.provider.inspect({streamId:ensured.value.snapshot.streamId});assert.ok(unchanged.ok);if(unchanged.ok)assert.equal(unchanged.value.snapshot.revision,ensured.value.snapshot.revision);
  }finally{await peerFixture.close();}

  const hostFixture=await fixture();
  try{
    const hello=await helloControl(hostFixture.slot,null);assert.ok(hello.ok);if(!hello.ok)return;
    const attached=await attachControlSession(hostFixture.slot.control.port,{disposition:"attached",instance:hello.value.instance},hostFixture.slot.control.credential);assert.ok(attached.ok);if(!attached.ok)return;
    const ensured=await attached.session.control.ensureViewer();assert.ok(ensured.ok);if(!ensured.ok)return;
    const waiting=attached.session.control.wait({streamId:ensured.value.snapshot.streamId,afterRevision:ensured.value.snapshot.revision,waitMs:30_000});
    await awaitAdmission(hostFixture.host,{preauth:0,authenticated:1,inFlight:1,waits:1});
    await hostFixture.host.close();
    const lost=await waiting;assert.equal(lost.ok?"":lost.error.code,"deadline-exceeded");
    assert.deepEqual(hostFixture.host.admissionSnapshot(),{preauth:0,authenticated:0,inFlight:0,waits:0});
    await attached.session.close();
    assert.equal(hostFixture.source.opens,0);
  }finally{await hostFixture.close();}
});
