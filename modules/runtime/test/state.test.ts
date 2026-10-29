import assert from "node:assert/strict"; import test from "node:test";
import { DEVICE, KEY, ensured, fixture } from "./support/runtime-fixtures.js";
import { StateStore } from "../src/state.js";
const flush=():Promise<void>=>new Promise(resolve=>setImmediate(resolve));
async function waitForWaiters(state:StateStore,count:number):Promise<void>{for(let turn=0;turn<20;turn++){if(state.activeWaitCount()===count)return;await flush();}assert.equal(state.activeWaitCount(),count);}
test("control v2 idempotency binds every identity field and rejects legacy/provider input", async () => {
  const f = fixture(), deviceRef = { ...DEVICE, platform: "ios" as const, namespace: "fsq.devices" };
  const first = await f.state.ensureStandaloneViewer({ deviceRef, idempotencyKey: KEY });
  assert.ok(first.ok);
  if (!first.ok) return;
  assert.equal(first.value.descriptor.contractVersion, 2);
  assert.deepEqual(first.value.snapshot.deviceRef, deviceRef);
  const reordered = { opaqueId: deviceRef.opaqueId, namespace: deviceRef.namespace, platform: deviceRef.platform, contractVersion: deviceRef.contractVersion };
  const repeated = await f.state.ensureStandaloneViewer({ deviceRef: reordered, idempotencyKey: KEY });
  assert.equal(repeated.ok && repeated.value.descriptor, first.value.descriptor);
  for (const change of [{ platform: "android" }, { namespace: "other" }, { opaqueId: "22345678-1234-4234-8234-123456789abc" }, { contractVersion: 1 }, { provider: "wda" }]) {
    const rejected = await f.state.ensureStandaloneViewer({ deviceRef: { ...deviceRef, ...change }, idempotencyKey: KEY });
    assert.equal(rejected.ok ? "" : rejected.error.code, "malformed-control");
  }
});
test("ensure is exact, frozen, idempotent and device-bound", async () => { const f = fixture(), first = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); assert.equal(first.ok, true); if (!first.ok) return; assert.equal(first.value.snapshot.revision, 1); assert.equal(first.value.snapshot.phase, "demand-pending"); assert.ok(Object.isFrozen(first)); assert.ok(Object.isFrozen(first.value)); assert.deepEqual(Object.keys(first.value), ["descriptor", "snapshot"]); assert.equal(first.value.descriptor.streamId, first.value.snapshot.streamId); const repeat = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); assert.equal(repeat.ok && repeat.value.descriptor, first.value.descriptor); });
test("ensure rejects malformed keys and a different key for a live stream", async () => { const f = await ensured(); const malformed = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: "short" }); assert.equal(malformed.ok ? "" : malformed.error.code, "malformed-control"); const other = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: Buffer.alloc(16, 1).toString("base64url") }); assert.equal(other.ok ? "" : other.error.code, "malformed-control"); });
test("concurrent ensure linearizes to one stream", async () => { const f = fixture(), [a,b] = await Promise.all([f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }), f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY })]); assert.ok(a.ok && b.ok); if (a.ok && b.ok) assert.equal(a.value.snapshot.streamId, b.value.snapshot.streamId); });
test("inspect orders revisions and stop has CAS plus frozen terminal idempotency", async () => { const f = await ensured(), stale = await f.state.stop({ streamId: f.snapshot.streamId, expectedRevision: 2, reason: "explicit-stop" }); assert.equal(stale.ok, false); if (!stale.ok) assert.equal("snapshot" in stale ? stale.snapshot.revision : undefined, 1); const stopped = await f.state.stop({ streamId: f.snapshot.streamId, expectedRevision: 1, reason: "explicit-stop" }); assert.ok(stopped.ok); if (!stopped.ok) return; assert.equal(stopped.value.snapshot.phase, "stopped"); assert.equal(stopped.value.snapshot.reason, "explicit-stop"); const inspected = f.state.inspect({ streamId: f.snapshot.streamId, afterRevision: 1 }); assert.ok(inspected.ok); if (inspected.ok) assert.deepEqual(inspected.value.changes.map((x) => x.phase), ["stopping", "stopped"]); const repeated = await f.state.stop({ streamId: f.snapshot.streamId, expectedRevision: 999, reason: "explicit-stop" }); assert.ok(repeated.ok); if (repeated.ok) assert.equal(repeated.value.snapshot, stopped.value.snapshot); const unknown = await f.state.stop({ streamId: "32345678-1234-4234-8234-123456789abc", reason: "explicit-stop" }); assert.equal(unknown.ok ? "" : unknown.error.code, "malformed-control"); });
test("inspect rejects future revisions and resets after retained history", async () => { const f = await ensured(); for (let i = 0; i < 70; i++) f.state.transitionLocked(f.snapshot.streamId, i % 2 ? "demand-pending" : "grace", 0); const reset = f.state.inspect({ streamId: f.snapshot.streamId, afterRevision: 1 }); assert.ok(reset.ok); if (reset.ok) { assert.equal(reset.value.reset, true); assert.deepEqual(reset.value.changes, []); } const future = f.state.inspect({ streamId: f.snapshot.streamId, afterRevision: 999 }); assert.equal(future.ok ? "" : future.error.code, "malformed-control"); });
test("idempotency tombstones cap at 64 then purge only at exact deadline", async () => { const f = fixture(); for (let i = 0; i < 64; i++) { const key = Buffer.alloc(16, i).toString("base64url"), made = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: key }); assert.ok(made.ok); if (!made.ok) return; await f.state.stop({ streamId: made.value.snapshot.streamId, reason: "explicit-stop" }); } const next = Buffer.alloc(16, 200).toString("base64url"), full = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: next }); assert.equal(full.ok ? "" : full.error.code, "runtime-overload"); f.clock.tick(600_000); const admitted = await f.state.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: next }); assert.ok(admitted.ok); });
test("ensure returns the current snapshot and malformed controls never throw", async () => { const f = await ensured(); f.state.transitionLocked(f.snapshot.streamId, "grace", 0); const repeat = await f.auth.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); assert.ok(repeat.ok && repeat.value.snapshot.revision === 2); assert.equal(f.auth.inspect(null).ok, false); assert.equal((await f.auth.stop(null)).ok, false); const bad = fixture(), invalid = new StateStore(0, bad.clock, bad.entropy), rejected = await invalid.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); assert.equal(rejected.ok ? "" : rejected.error.code, "runtime-bind-failed"); });
test("terminal same-key ensure creates a new stream while retaining the old tombstone", async () => { const f=await ensured(), old=f.snapshot.streamId; assert.ok((await f.auth.stop({streamId:old,reason:"explicit-stop"})).ok); const replaced=await f.auth.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY}); assert.ok(replaced.ok);if(!replaced.ok)return;assert.notEqual(replaced.value.snapshot.streamId,old);const oldInspection=f.auth.inspect({streamId:old});assert.ok(oldInspection.ok&&oldInspection.value.snapshot.phase==="stopped");const changed=await f.auth.ensureStandaloneViewer({deviceRef:{...DEVICE,namespace:"other"},idempotencyKey:KEY});assert.equal(changed.ok?"":changed.error.code,"malformed-control"); });
test("same-key ensure waits for terminal flight then creates a new stream",async()=>{const f=await ensured(),old=f.snapshot.streamId;let release!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;});f.state.terminal.register(20,"blocked-cleanup",()=>gate);const stopping=f.state.terminal.request(old,"explicit-stop"),ensuring=f.auth.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY});await flush();let settled=false;void ensuring.then(()=>{settled=true;});await flush();assert.equal(settled,false);release();await stopping;const next=await ensuring;assert.ok(next.ok);if(next.ok)assert.notEqual(next.value.snapshot.streamId,old);});
test("terminal coordinator fences, orders participants and records safe failures", async () => { const f=await ensured(),order:string[]=[]; let release!:()=>void; const blocked=new Promise<void>((resolve)=>{release=resolve;}); f.state.terminal.register(20,"capture",async()=>{order.push("capture");await blocked;}); f.state.terminal.register(25,"fault",()=>{order.push("fault");throw new Error("secret raw cause");}); f.state.terminal.register(30,"transport",()=>{order.push("transport");}); const first=f.state.terminal.request(f.snapshot.streamId,"explicit-stop"),competing=f.state.terminal.request(f.snapshot.streamId,"lease-expired"); assert.equal(first,competing); assert.equal(f.state.terminal.activeFlightCount(),1); await new Promise<void>((resolve)=>setImmediate(resolve)); assert.equal(f.state.terminal.isFenced(f.snapshot.streamId),true); assert.equal(f.state.terminal.activeFlightCount(),1); release(); const terminal=await first; assert.deepEqual(order,["capture","fault","transport"]); assert.equal(terminal.reason,"explicit-stop"); assert.equal(f.state.terminal.activeFlightCount(),0); assert.deepEqual(f.state.terminal.failures(),[{participant:"fault",code:"cleanup-failed"}]); assert.equal(JSON.stringify(f.state.terminal.failures()).includes("secret"),false); });
test("permit lifetime ignores wall-clock jumps and expired ensure re-arms", async () => { const f=await ensured(); const expiresAt=f.descriptor.expiresAt; f.clock.jumpWall(86_400_000); const repeat=await f.auth.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY}); assert.ok(repeat.ok && repeat.value.descriptor.expiresAt===expiresAt); f.clock.tick(30_000); const rearmed=await f.auth.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY}); assert.ok(rearmed.ok && rearmed.value.descriptor.expiresAt>expiresAt); });
test("terminal failure ledger retains at most 64 fixed records", async () => { const f=await ensured(); for (let i=0;i<65;i++) f.state.terminal.register(20+i,`p${String(i).padStart(2,"0")}`,()=>{throw new Error(`raw-${i}`);}); await f.state.terminal.request(f.snapshot.streamId,"explicit-stop"); const failures=f.state.terminal.failures(); assert.equal(failures.length,64); assert.equal(failures[0]?.participant,"p01"); assert.ok(Object.isFrozen(failures)); assert.equal(JSON.stringify(failures).includes("raw-"),false); });
test("completed terminal flights do not accumulate across StateStore purge", async () => { const f=fixture(); let previous:Promise<unknown>|undefined; for (let i=0;i<70;i++) { const made=await f.auth.ensureStandaloneViewer({deviceRef:DEVICE,idempotencyKey:KEY}); assert.ok(made.ok); if (!made.ok) return; const streamId=made.value.snapshot.streamId, flight=f.state.terminal.request(streamId,"explicit-stop"); if (previous) assert.notEqual(flight,previous); await flight; assert.equal(f.state.terminal.activeFlightCount(),0); const repeated=f.state.terminal.request(streamId,"lease-expired"); assert.notEqual(repeated,flight); assert.equal((await repeated).reason,"explicit-stop"); assert.equal(f.state.terminal.activeFlightCount(),0); previous=repeated; f.clock.tick(600_000); } });
test("failed terminal flight is released", async () => { const f=fixture(); await assert.rejects(f.state.terminal.request("32345678-1234-4234-8234-123456789abc","explicit-stop")); assert.equal(f.state.terminal.activeFlightCount(),0); });
test("media transition validates metadata and ordinary plus terminal revisions preserve it",async()=>{const f=await ensured(),id=f.snapshot.streamId;assert.equal(f.snapshot.epoch,undefined);assert.throws(()=>f.state.transitionMediaLocked(id,"syncing",1,{epoch:0,codedSize:{width:1280,height:720},displaySize:{width:1280,height:720}}),/Invalid media state/);assert.throws(()=>f.state.transitionMediaLocked(id,"syncing",1,{epoch:1,codedSize:{width:0,height:720},displaySize:{width:1280,height:720}}),/Invalid media state/);assert.throws(()=>f.state.transitionMediaLocked(id,"syncing",1,{epoch:1,codedSize:{width:1280,height:720},displaySize:{width:1280,height:720},extra:true}),/Invalid media state/);const syncing=f.state.transitionMediaLocked(id,"syncing",1,{epoch:1,codedSize:{width:1280,height:720},displaySize:{width:720,height:1280}});assert.deepEqual({epoch:syncing.epoch,codedSize:syncing.codedSize,displaySize:syncing.displaySize},{epoch:1,codedSize:{width:1280,height:720},displaySize:{width:720,height:1280}});assert.ok(Object.isFrozen(syncing.codedSize));const streaming=f.state.transitionLocked(id,"streaming",1),grace=f.state.transitionLocked(id,"grace",0);for(const snapshot of [streaming,grace])assert.deepEqual([snapshot.epoch,snapshot.codedSize,snapshot.displaySize],[1,{width:1280,height:720},{width:720,height:1280}]);const terminal=await f.state.terminal.request(id,"explicit-stop");assert.deepEqual([terminal.phase,terminal.epoch,terminal.codedSize,terminal.displaySize],["stopped",1,{width:1280,height:720},{width:720,height:1280}]);});

test("wait registration and first publication are atomic with a frozen first result",async()=>{
  const f=await ensured(),id=f.snapshot.streamId;
  const waiting=f.state.wait({streamId:id,afterRevision:1,waitMs:30_000});
  await waitForWaiters(f.state,1);
  await f.state.mutex.run(()=>{
    f.state.transitionLocked(id,"starting-capture",1);
    f.state.transitionLocked(id,"syncing",1);
  });
  const result=await waiting;
  assert.ok(result.ok);
  if(!result.ok)return;
  assert.equal(result.value.snapshot.revision,2);
  assert.deepEqual(result.value.changes.map(change=>change.revision),[2]);
  assert.equal(result.value.timedOut,false);
  assert.ok(Object.isFrozen(result.value));
  assert.equal(f.state.activeWaitCount(),0);
});

test("wait immediately serves retained history reset future zero-timeout and terminal precedence",async()=>{
  const f=await ensured(),id=f.snapshot.streamId;
  for(let index=0;index<70;index++)f.state.transitionLocked(id,index%2===0?"grace":"demand-pending",0);
  const retained=await f.state.wait({streamId:id,afterRevision:70,waitMs:30_000});
  assert.ok(retained.ok);
  if(retained.ok){assert.deepEqual(retained.value.changes.map(change=>change.revision),[71]);assert.equal(retained.value.reset,false);assert.equal(retained.value.timedOut,false);}
  const reset=await f.state.wait({streamId:id,afterRevision:1,waitMs:30_000});
  assert.ok(reset.ok);
  if(reset.ok)assert.deepEqual({changes:reset.value.changes,reset:reset.value.reset,timedOut:reset.value.timedOut},{changes:[],reset:true,timedOut:false});
  const future=await f.state.wait({streamId:id,afterRevision:999,waitMs:30_000});
  assert.equal(future.ok?"":future.error.code,"malformed-control");
  const timeout=await f.state.wait({streamId:id,afterRevision:71,waitMs:0});
  assert.ok(timeout.ok);
  if(timeout.ok)assert.deepEqual({changes:timeout.value.changes,reset:timeout.value.reset,timedOut:timeout.value.timedOut},{changes:[],reset:false,timedOut:true});
  const terminal=await f.state.stop({streamId:id,reason:"explicit-stop"});
  assert.ok(terminal.ok);
  if(!terminal.ok)return;
  const completed=await f.state.wait({streamId:id,afterRevision:terminal.value.snapshot.revision,waitMs:0});
  assert.ok(completed.ok);
  if(completed.ok)assert.equal(completed.value.timedOut,false);
  assert.equal(f.state.activeWaitCount(),0);
});

test("wait uses one monotonic deadline and rearms an early timer",async()=>{
  const early=await ensured(),id=early.snapshot.streamId,pending=early.state.wait({streamId:id,afterRevision:1,waitMs:30_000});
  await waitForWaiters(early.state,1);
  early.clock.jumpWall(86_400_000);
  early.clock.fireNextTimerEarly();
  await flush();
  assert.equal(early.clock.mono(),39_999);
  assert.equal(early.state.activeWaitCount(),1);
  early.clock.tick(1);
  await flush();
  const timed=await pending;
  assert.ok(timed.ok);
  if(timed.ok)assert.equal(timed.value.timedOut,true);
  assert.equal(early.state.activeWaitCount(),0);

  for(const elapsed of [29_999,30_000]){
    const f=await ensured(),wait=f.state.wait({streamId:f.snapshot.streamId,afterRevision:1,waitMs:30_000});
    await waitForWaiters(f.state,1);
    f.clock.advanceWithoutTimers(elapsed);
    if(elapsed===29_999){f.state.transitionLocked(f.snapshot.streamId,"grace",0);const changed=await wait;assert.ok(changed.ok&&changed.value.timedOut===false);}
    else{f.state.transitionLocked(f.snapshot.streamId,"grace",0);const exact=await wait;assert.ok(exact.ok&&exact.value.timedOut===true);if(exact.ok)assert.deepEqual([exact.value.snapshot.revision,exact.value.snapshot.phase],[1,"demand-pending"]);}
    assert.equal(f.state.activeWaitCount(),0);
  }
});

test("wait wakes separately for stopping and final terminal publications",async()=>{
  const f=await ensured(),id=f.snapshot.streamId;
  let release!:()=>void;
  const gate=new Promise<void>(resolve=>{release=resolve;});
  f.state.terminal.register(20,"wait-terminal-gate",()=>gate);
  const stoppingWait=f.state.wait({streamId:id,afterRevision:1,waitMs:30_000});
  await waitForWaiters(f.state,1);
  const terminal=f.state.terminal.request(id,"explicit-stop");
  const stopping=await stoppingWait;
  assert.ok(stopping.ok);
  if(!stopping.ok)return;
  assert.equal(stopping.value.snapshot.phase,"stopping");
  const finalWait=f.state.wait({streamId:id,afterRevision:stopping.value.snapshot.revision,waitMs:30_000});
  await waitForWaiters(f.state,1);
  release();
  const [finalSnapshot,final]=await Promise.all([terminal,finalWait]);
  assert.ok(final.ok);
  if(final.ok){assert.equal(final.value.snapshot,finalSnapshot);assert.equal(final.value.snapshot.phase,"stopped");assert.equal(final.value.timedOut,false);}
  assert.equal(f.state.activeWaitCount(),0);
});

test("StateStore enforces four waits before any fifth allocation and releases every cancellation",async()=>{
  const f=await ensured(),controllers=Array.from({length:4},()=>new AbortController());
  const waits=controllers.map(controller=>f.state.wait({streamId:f.snapshot.streamId,afterRevision:1,waitMs:30_000},controller.signal));
  await waitForWaiters(f.state,4);
  const fifth=await f.state.wait({streamId:f.snapshot.streamId,afterRevision:1,waitMs:30_000});
  assert.equal(fifth.ok?"":fifth.error.code,"runtime-overload");
  assert.equal(f.state.activeWaitCount(),4);
  for(const controller of controllers)controller.abort();
  const settled=await Promise.allSettled(waits);
  assert.ok(settled.every(result=>result.status==="rejected"&&result.reason instanceof Error&&result.reason.name==="MutationCancelled"));
  assert.equal(f.state.activeWaitCount(),0);
});

test("cancel publication and exact deadline races have one mutex-ordered winner",async()=>{
  const cancelled=await ensured(),cancelController=new AbortController(),cancelWait=cancelled.state.wait({streamId:cancelled.snapshot.streamId,afterRevision:1,waitMs:100},cancelController.signal);
  await waitForWaiters(cancelled.state,1);
  cancelController.abort();
  await cancelled.state.mutex.run(()=>cancelled.state.transitionLocked(cancelled.snapshot.streamId,"grace",0));
  await assert.rejects(cancelWait,{name:"MutationCancelled"});
  assert.equal(cancelled.state.activeWaitCount(),0);

  const published=await ensured(),publishController=new AbortController(),publishWait=published.state.wait({streamId:published.snapshot.streamId,afterRevision:1,waitMs:100},publishController.signal);
  await waitForWaiters(published.state,1);
  await published.state.mutex.run(()=>published.state.transitionLocked(published.snapshot.streamId,"grace",0));
  publishController.abort();
  const changed=await publishWait;
  assert.ok(changed.ok&&changed.value.timedOut===false);
  assert.equal(published.state.activeWaitCount(),0);

  const deadline=await ensured(),deadlineController=new AbortController(),deadlineWait=deadline.state.wait({streamId:deadline.snapshot.streamId,afterRevision:1,waitMs:100},deadlineController.signal);
  await waitForWaiters(deadline.state,1);
  deadline.clock.advanceWithoutTimers(100);
  deadlineController.abort();
  const exact=await deadlineWait;
  assert.ok(exact.ok&&exact.value.timedOut===true);
  assert.equal(deadline.state.activeWaitCount(),0);
});

test("reconnect wait uses only the shared history cursor and validates exact input",async()=>{
  const f=await ensured(),id=f.snapshot.streamId;
  f.state.transitionLocked(id,"starting-capture",1);
  f.state.transitionLocked(id,"syncing",1);
  const reconnected=await f.state.wait({streamId:id,afterRevision:1,waitMs:30_000});
  assert.ok(reconnected.ok);
  if(reconnected.ok)assert.deepEqual(reconnected.value.changes.map(change=>change.revision),[2,3]);
  for(const input of [
    {streamId:id,afterRevision:1,waitMs:-0},
    {streamId:id,afterRevision:1,waitMs:30_001},
    {streamId:id,afterRevision:1,waitMs:1,extra:true},
    {streamId:id,afterRevision:1.5,waitMs:1},
  ]){
    const rejected=await f.state.wait(input);
    assert.equal(rejected.ok?"":rejected.error.code,"malformed-control");
  }
  assert.equal(f.state.activeWaitCount(),0);
});
