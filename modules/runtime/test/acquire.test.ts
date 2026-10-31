import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { CONTROL_VERSION, controlError, type AcquireRuntimeRequest, type RuntimeControl, type RuntimeInstance } from "../../contracts/src/index.js";
import { acquireInternals } from "../src/acquire.js";
import * as runtimePublic from "../src/index.js";
import { LocalRuntimeState, type AndroidRuntimeSlot, type RuntimeGenerationState, type RuntimeSlot } from "../src/control-state.js";
import { ownerTestInternals, type RuntimeOwnerLocal } from "../src/owner.js";

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
    async wait() { calls.push("wait"); return { ok: false, error: controlError("instance-not-found") }; },
    async stopStream() { calls.push("stop"); return { ok: false, error: controlError("instance-not-found") }; },
    async close() { calls.push("close"); },
  };
  assert.deepEqual(Object.keys(control).sort(), ["close", "ensureViewer", "inspect", "stopStream", "wait"]);
  assert.equal("approveViewerPairing" in control, false);
  assert.equal("shutdownRuntime" in control, false);
  assert.equal(JSON.stringify({ controlVersion: CONTROL_VERSION, error: controlError("instance-not-found") }).includes("credential"), false);
  await control.close();
  assert.deepEqual(calls, ["close"]);
});

await test("acquire final attachment fences stale slot revision and authority", () => {
  const deviceRef = Object.freeze({ contractVersion: 2 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId: randomUUID() });
  const base: AndroidRuntimeSlot = Object.freeze({ stateVersion: 1, revision: 1, platform: "android", deviceRef, binding: Object.freeze({ serial: "PRIVATE", adbPath: "/usr/bin/true", cacheRoot: "/tmp/private", artifactSource: Object.freeze({ mode: "online" as const }) }), control: Object.freeze({ port: 50_000, credential: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }), createdAt: 1, updatedAt: 1 });
  assert.equal(acquireInternals.sameAuthority(base, base), true);
  assert.equal(acquireInternals.sameAuthority(base, Object.freeze({ ...base, revision: 2, updatedAt: 2 })), false);
  assert.equal(acquireInternals.sameAuthority(base, Object.freeze({ ...base, control: Object.freeze({ port: 50_001, credential: base.control.credential }) })), false);
  assert.equal(acquireInternals.sameAuthority(base, Object.freeze({ ...base, control: Object.freeze({ port: base.control.port, credential: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB" }) })), false);
});

const RACE_BINDING = Object.freeze({ serial: "PRIVATE", adbPath: "/usr/bin/true", cacheRoot: "/tmp/private", artifactSource: Object.freeze({ mode: "online" as const }) });
async function raceState(): Promise<Readonly<{ parent: string; state: LocalRuntimeState; slot: AndroidRuntimeSlot; close(): Promise<void> }>> {
  const created = await mkdtemp(join(tmpdir(), "fsq-acquire-race-")), parent = await realpath(created);
  await chmod(parent, 0o700);
  const state = new LocalRuntimeState(join(parent, "state")), slot = (await state.initialize(RACE_BINDING, 1_800_000_000_000)).slot;
  return Object.freeze({ parent, state, slot, close: () => rm(parent, { recursive: true, force: true }) });
}
function instance(slot: RuntimeSlot, target: Readonly<{ instanceId: string; generation: string }>): RuntimeInstance {
  return Object.freeze({ controlVersion: CONTROL_VERSION, ...target, contractVersion: 2, deviceRef: slot.deviceRef, features: Object.freeze(["wait-v1", "auto-bootstrap-v1", "mcp-app-v1"] as const) });
}

await test("start-or-attach adopts reset authority, respawns, and old cleanup cannot delete the new generation", async () => {
  const fixture = await raceState();
  const oldGeneration: RuntimeGenerationState = Object.freeze({
    runtimeStateVersion: 1,
    deviceRef: fixture.slot.deviceRef,
    instanceId: randomUUID(),
    generation: randomUUID(),
    port: fixture.slot.control.port,
    createdAt: fixture.slot.createdAt + 1,
    ready: true,
  });
  await fixture.state.publishGeneration(oldGeneration);
  const owner: RuntimeOwnerLocal = ownerTestInternals.create({
    state: () => fixture.state,
    hello: async () => Object.freeze({ ok: false, error: controlError("instance-not-found") }),
    now: () => fixture.slot.createdAt + 2,
  });
  const children: FakeChild[] = [];
  const spawned: RuntimeSlot[] = [];
  let bootstraps = 0;
  let helloSlot: RuntimeSlot | undefined;
  let newGeneration: RuntimeGenerationState | undefined;
  let oldCleanup = true;
  const request: AcquireRuntimeRequest = Object.freeze({ mode: "start-or-attach", selector: Object.freeze({ kind: "known", deviceRef: fixture.slot.deviceRef }) });
  try {
    const result = await acquireInternals.startAndAttach(fixture.state, fixture.slot, request, undefined, Number.POSITIVE_INFINITY, {
      spawn(slot) {
        assert.equal(children.some((entry) => entry.connected), false);
        spawned.push(slot);
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      async bootstrap(child) {
        bootstraps++;
        if (bootstraps === 1) {
          const reset = await owner.resetControlState({ platform: "android", expectedDeviceRef: fixture.slot.deviceRef, expectedStateRevision: 1 });
          assert.ok(reset.ok);
          (child as unknown as FakeChild).disconnect();
          return Object.freeze({ type: "contended" as const });
        }
        const slot = (await fixture.state.readSlot())!;
        const target = Object.freeze({ instanceId: randomUUID(), generation: randomUUID() });
        newGeneration = Object.freeze({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, ...target, port: slot.control.port, createdAt: slot.updatedAt + 1, ready: true });
        await fixture.state.publishGeneration(newGeneration);
        oldCleanup = await fixture.state.deleteGeneration(oldGeneration, true);
        return Object.freeze({ type: "ready" as const, ...target });
      },
      async hello(slot, expected) {
        helloSlot = slot;
        assert.deepEqual(expected, newGeneration && { instanceId: newGeneration.instanceId, generation: newGeneration.generation });
        return Object.freeze({ ok: true as const, value: Object.freeze({ instance: instance(slot, expected!) }) });
      },
      async attach(_slot, disposition, value) {
        return Object.freeze({ ok: true as const, session: Object.freeze({ attachment: Object.freeze({ disposition, instance: value }) }) }) as never;
      },
      now: () => 0,
      sleep: async () => undefined,
    });
    assert.ok(result.ok);
    if (result.ok) assert.equal(result.session.attachment.disposition, "started");
    assert.deepEqual(spawned.map((slot) => slot.revision), [1, 2]);
    assert.equal(helloSlot?.revision, 2);
    assert.equal(oldCleanup, false);
    assert.deepEqual(await fixture.state.readGeneration((await fixture.state.readSlot())!), newGeneration);
  } finally {
    for (const child of children) child.disconnect();
    await owner.close();
    await fixture.close();
  }
});

await test("fresh restart receives only the remaining original readiness budget", async () => {
  const fixture = await raceState();
  const owner = ownerTestInternals.create({
    state: () => fixture.state,
    hello: async () => Object.freeze({ ok: false, error: controlError("instance-not-found") }),
    now: () => fixture.slot.createdAt + 1,
  });
  const children: FakeChild[] = [];
  const budgets: number[] = [];
  let now = 0;
  let bootstraps = 0;
  const request: AcquireRuntimeRequest = Object.freeze({ mode: "start-or-attach", selector: Object.freeze({ kind: "known", deviceRef: fixture.slot.deviceRef }) });
  try {
    const result = await acquireInternals.startAndAttach(fixture.state, fixture.slot, request, undefined, undefined, {
      spawn() {
        assert.equal(children.some((entry) => entry.connected), false);
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      async bootstrap(child, _signal, _reconcile, readinessBudget) {
        assert.equal(typeof readinessBudget, "number");
        budgets.push(readinessBudget!);
        bootstraps++;
        if (bootstraps === 1) {
          now = 9_999;
          const reset = await owner.resetControlState({ platform: "android", expectedDeviceRef: fixture.slot.deviceRef, expectedStateRevision: 1 });
          assert.ok(reset.ok);
          (child as unknown as FakeChild).disconnect();
          return Object.freeze({ type: "contended" as const });
        }
        now = 10_000;
        (child as unknown as FakeChild).disconnect();
        return Object.freeze({ type: "deadline" as const });
      },
      async hello() { throw new Error("deadline path must not hello"); },
      async attach() { throw new Error("deadline path must not attach"); },
      now: () => now,
      sleep: async () => undefined,
    });
    assert.equal(result.ok ? "" : result.error.code, "deadline-exceeded");
    assert.deepEqual(budgets, [10_000, 1]);
    assert.equal(children.length, 2);
  } finally {
    for (const child of children) child.disconnect();
    await owner.close();
    await fixture.close();
  }
});

await test("start-or-attach fences old known identity when rebind wins before contended child exits", async () => {
  const fixture = await raceState();
  const children: FakeChild[] = [];
  const reboundId = randomUUID();
  const owner = ownerTestInternals.create({
    state: () => fixture.state,
    hello: async () => Object.freeze({ ok: false, error: controlError("instance-not-found") }),
    resolveBinding: async () => RACE_BINDING,
    now: () => fixture.slot.createdAt + 1,
    uuid: () => reboundId,
  });
  let spawns = 0;
  const request: AcquireRuntimeRequest = Object.freeze({ mode: "start-or-attach", selector: Object.freeze({ kind: "known", deviceRef: fixture.slot.deviceRef }) });
  try {
    const result = await acquireInternals.startAndAttach(fixture.state, fixture.slot, request, undefined, Number.POSITIVE_INFINITY, {
      spawn() {
        spawns++;
        assert.equal(children.some((entry) => entry.connected), false);
        const child = new FakeChild();
        children.push(child);
        return child as never;
      },
      async bootstrap(child) {
        const rebound = await owner.rebindDevice({ platform: "android", expectedDeviceRef: fixture.slot.deviceRef, expectedStateRevision: 1 });
        assert.ok(rebound.ok);
        (child as unknown as FakeChild).disconnect();
        return Object.freeze({ type: "contended" as const });
      },
      async hello() { throw new Error("old known rebind must not hello"); },
      async attach() { throw new Error("old known rebind must not attach"); },
      now: () => 0,
      sleep: async () => undefined,
    });
    assert.equal(result.ok ? "" : result.error.code, "instance-conflict");
    assert.equal(spawns, 1);
    assert.equal((await fixture.state.readSlot())!.deviceRef.opaqueId, reboundId);
  } finally {
    for (const child of children) child.disconnect();
    await owner.close();
    await fixture.close();
  }
});

await test("public Runtime seam excludes owner and host authority factories",()=>{
  for(const name of ["acquireRuntimeOwner","RuntimeControlHost","RuntimeControlProvider","deriveControlBearer","OwnerHttpControl"])assert.equal(Object.hasOwn(runtimePublic,name),false);
  assert.equal(typeof runtimePublic.acquireRuntime,"function");
});

await test("real child harness covers ready ACK contended cancel parent-death and TERM-KILL reap",async()=>{const root=await mkdtemp(join(tmpdir(),"fsq-bootstrap-")),script=join(root,"child.mjs"),id="123e4567-e89b-42d3-a456-426614174000",generation="223e4567-e89b-42d3-a456-426614174000";await writeFile(script,`const mode=process.argv[2];if(mode==='ready'){process.send({type:'ready',instanceId:'${id}',generation:'${generation}'});process.on('message',m=>{if(m.type==='ready')process.exit(0);});}else if(mode==='contended'){process.send({type:'contended'});process.exit(0);}else if(mode==='orphan'){process.on('disconnect',()=>process.exit(0));}else{process.on('message',m=>{if(m.type==='cancel'&&mode==='cancel')process.exit(0);});if(mode==='stubborn')process.on('SIGTERM',()=>{});}setInterval(()=>{},1000);`);try{const ready=fork(script,["ready"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),readyResult=await acquireInternals.waitBootstrap(ready);assert.equal(readyResult.type,"ready");const reaped=new Promise<void>(resolve=>ready.once("exit",()=>resolve()));assert.equal(await acquireInternals.sendFrame(ready,{type:"ready"}),true);await reaped;const loser=fork(script,["contended"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]});assert.equal((await acquireInternals.waitBootstrap(loser)).type,"contended");const cancel=fork(script,["cancel"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),controller=new AbortController(),cancelled=acquireInternals.waitBootstrap(cancel,controller.signal);controller.abort();assert.equal((await cancelled).type,"cancel");const orphan=fork(script,["orphan"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),orphaned=acquireInternals.waitBootstrap(orphan);orphan.disconnect();assert.equal((await orphaned).type,"exited");const stubborn=fork(script,["stubborn"],{detached:true,stdio:["ignore","ignore","ignore","ipc"]}),hardController=new AbortController(),hard=acquireInternals.waitBootstrap(stubborn,hardController.signal);hardController.abort();assert.equal((await hard).type,"cancel");}finally{await rm(root,{recursive:true,force:true});}});
