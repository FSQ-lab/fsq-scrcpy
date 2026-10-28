import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp,rm,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CONTROL_VERSION, controlError, type RuntimeControl } from "../../contracts/src/index.js";
import { acquireInternals } from "../src/acquire.js";
import * as runtimePublic from "../src/index.js";

class FakeChild extends EventEmitter {
  connected = true;
  pid: number | undefined = undefined;
  readonly sent: unknown[] = [];
  send(value: unknown, callback?: (cause: Error | null) => void): boolean { this.sent.push(value); callback?.(null); return true; }
  disconnect(): void { this.connected = false; this.emit("disconnect"); }
  unref(): void {}
}

await test("bootstrap ready transfers ownership with exact safe pair", async () => {
  const child = new FakeChild(), waiting = acquireInternals.waitBootstrap(child as never);
  child.emit("message", { type: "candidate", instanceId: "ignored", generation: "ignored" });
  child.emit("message", { type: "ready", instanceId: "123e4567-e89b-42d3-a456-426614174000", generation: "223e4567-e89b-42d3-a456-426614174000" });
  assert.deepEqual(await waiting, { type: "ready", instanceId: "123e4567-e89b-42d3-a456-426614174000", generation: "223e4567-e89b-42d3-a456-426614174000" });
  child.emit("exit", 0);
});

await test("contended child is reaped before loser begins attach", async () => {
  const child = new FakeChild(), waiting = acquireInternals.waitBootstrap(child as never);
  child.emit("message", { type: "contended" });
  let settled = false; void waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("exit", 0);
  assert.deepEqual(await waiting, { type: "contended" });
});

await test("pre-ready cancellation asks child to clean up and waits for reap", async () => {
  const child = new FakeChild(), controller = new AbortController(), waiting = acquireInternals.waitBootstrap(child as never, controller.signal);
  controller.abort();
  assert.deepEqual(child.sent, [{ type: "cancel" }]);
  let settled = false; void waiting.then(() => { settled = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(settled, false);
  child.emit("exit", 0);
  assert.deepEqual(await waiting, { type: "cancel" });
});

await test("delayed ready beats pre-escalation cancellation without killing authority",async()=>{const child=new FakeChild(),controller=new AbortController(),waiting=acquireInternals.waitBootstrap(child as never,controller.signal);controller.abort();child.emit("message",{type:"ready",instanceId:"123e4567-e89b-42d3-a456-426614174000",generation:"223e4567-e89b-42d3-a456-426614174000"});assert.equal((await waiting).type,"ready");assert.deepEqual(child.sent,[{type:"cancel"}]);});

await test("post-ready cancellation cannot kill the persistent child", async () => {
  const child = new FakeChild(), controller = new AbortController(), waiting = acquireInternals.waitBootstrap(child as never, controller.signal);
  child.emit("message", { type: "ready", instanceId: "123e4567-e89b-42d3-a456-426614174000", generation: "223e4567-e89b-42d3-a456-426614174000" });
  const result = await waiting;
  controller.abort();
  assert.equal(result.type, "ready");
  assert.deepEqual(child.sent, []);
  assert.equal(await acquireInternals.sendFrame(child as never,{type:"ready"}),true);
  assert.deepEqual(child.sent,[{type:"ready"}]);
});

await test("child exit without a safe bootstrap frame is runtime-exited evidence", async () => {
  const child = new FakeChild(), waiting = acquireInternals.waitBootstrap(child as never);
  child.emit("message", { type: "ready", instanceId: "malformed" });
  child.emit("message", { type: "private", credential: "secret" });
  child.emit("exit", 1);
  assert.deepEqual(await waiting, { type: "exited" });
});

await test("spawned child error does not settle until exit reaps it",async()=>{const child=new FakeChild();child.pid=123;const waiting=acquireInternals.waitBootstrap(child as never);child.emit("error",new Error("ipc"));let settled=false;void waiting.then(()=>{settled=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(settled,false);child.emit("exit",1);assert.deepEqual(await waiting,{type:"exited"});});

await test("local RuntimeControl shape cannot smuggle owner authority", async () => {
  const calls: string[] = [], control: RuntimeControl = {
    async ensureViewer() { calls.push("ensure"); return { ok: false, error: controlError("instance-not-found") }; },
    async inspect() { calls.push("inspect"); return { ok: false, error: controlError("instance-not-found") }; },
    async stopStream() { calls.push("stop"); return { ok: false, error: controlError("instance-not-found") }; },
    async close() { calls.push("close"); },
  };
  assert.deepEqual(Object.keys(control).sort(), ["close", "ensureViewer", "inspect", "stopStream"]);
  assert.equal("approveViewerPairing" in control, false);
  assert.equal("shutdownRuntime" in control, false);
  assert.equal(JSON.stringify({ controlVersion: CONTROL_VERSION, error: controlError("instance-not-found") }).includes("credential"), false);
  await control.close();
  assert.deepEqual(calls, ["close"]);
});

await test("public Runtime seam excludes owner and host authority factories",()=>{
  for(const name of ["acquireRuntimeOwner","RuntimeControlHost","RuntimeControlProvider","deriveControlBearer","OwnerHttpControl"])assert.equal(Object.hasOwn(runtimePublic,name),false);
  assert.equal(typeof runtimePublic.acquireRuntime,"function");
});

await test("real child harness covers ready ACK contended cancel parent-death and TERM-KILL reap",async()=>{const root=await mkdtemp(join(tmpdir(),"fsq-bootstrap-")),script=join(root,"child.mjs"),id="123e4567-e89b-42d3-a456-426614174000",generation="223e4567-e89b-42d3-a456-426614174000";await writeFile(script,`const mode=process.argv[2];if(mode==='ready'){process.send({type:'ready',instanceId:'${id}',generation:'${generation}'});process.on('message',m=>{if(m.type==='ready')process.exit(0);});}else if(mode==='contended'){process.send({type:'contended'});process.exit(0);}else if(mode==='orphan'){process.on('disconnect',()=>process.exit(0));}else{process.on('message',m=>{if(m.type==='cancel'&&mode==='cancel')process.exit(0);});if(mode==='stubborn')process.on('SIGTERM',()=>{});}setInterval(()=>{},1000);`);try{const ready=fork(script,["ready"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),readyResult=await acquireInternals.waitBootstrap(ready);assert.equal(readyResult.type,"ready");const reaped=new Promise<void>(resolve=>ready.once("exit",()=>resolve()));assert.equal(await acquireInternals.sendFrame(ready,{type:"ready"}),true);await reaped;const loser=fork(script,["contended"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]});assert.equal((await acquireInternals.waitBootstrap(loser)).type,"contended");const cancel=fork(script,["cancel"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),controller=new AbortController(),cancelled=acquireInternals.waitBootstrap(cancel,controller.signal);controller.abort();assert.equal((await cancelled).type,"cancel");const orphan=fork(script,["orphan"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),orphaned=acquireInternals.waitBootstrap(orphan);orphan.disconnect();assert.equal((await orphaned).type,"exited");const stubborn=fork(script,["stubborn"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),hardController=new AbortController(),hard=acquireInternals.waitBootstrap(stubborn,hardController.signal);hardController.abort();assert.equal((await hard).type,"cancel");}finally{await rm(root,{recursive:true,force:true});}});
