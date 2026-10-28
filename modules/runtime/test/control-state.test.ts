import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { LocalRuntimeState, LocalStateFailure, controlStateInternals, type AndroidRuntimeSlot, type RuntimeGenerationState } from "../src/control-state.js";

const BINDING = Object.freeze({ serial: "PRIVATE-SERIAL", adbPath: "/usr/bin/true", cacheRoot: "/tmp/fsq-private-cache", artifactSource: Object.freeze({ mode: "online" as const }) });
const OTHER = Object.freeze({ ...BINDING, serial: "OTHER-PRIVATE-SERIAL" });
async function temporary(): Promise<Readonly<{ parent: string; root: string; state: LocalRuntimeState; close(): Promise<void> }>> {
  const created = await mkdtemp(join(tmpdir(), "fsq-control-state-")), parent = await realpath(created); await chmod(parent, 0o700); const root = join(parent, "state"), state = new LocalRuntimeState(root);
  return Object.freeze({ parent, root, state, close: () => rm(parent, { recursive: true, force: true }) });
}
async function initialized(now = 1_800_000_000_000) { const fixture = await temporary(), result = await fixture.state.initialize(BINDING, now); return { ...fixture, ...result }; }
function generation(slot: AndroidRuntimeSlot, instanceId = randomUUID(), value = randomUUID()): RuntimeGenerationState { return Object.freeze({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, instanceId, generation: value, port: slot.control.port, createdAt: 1_800_000_000_001, ready: true }); }

await test("first publication creates exact private directories and canonical slot", async () => {
  const fixture = await initialized();
  try {
    assert.equal(fixture.published, true);
    assert.equal(fixture.slot.stateVersion, 1);
    assert.equal(fixture.slot.revision, 1);
    assert.equal(fixture.slot.platform, "android");
    assert.equal(fixture.slot.deviceRef.platform, "android");
    assert.equal(fixture.slot.deviceRef.namespace, "fsq.android.local");
    assert.match(fixture.slot.deviceRef.opaqueId, /^[0-9a-f-]{36}$/);
    assert.equal(fixture.slot.control.credential.length, 43);
    assert.equal(Buffer.from(fixture.slot.control.credential, "base64url").byteLength, 32);
    assert.ok(fixture.slot.control.port >= 49_152 && fixture.slot.control.port <= 65_535);
    assert.equal(fixture.slot.createdAt, fixture.slot.updatedAt);
    assert.deepEqual(fixture.slot.binding, BINDING);
    assert.equal(Object.isFrozen(fixture.slot), true);
    assert.equal(Object.isFrozen(fixture.slot.deviceRef), true);
    assert.equal(Object.isFrozen(fixture.slot.binding), true);
    assert.equal(Object.isFrozen(fixture.slot.control), true);
    for (const path of [fixture.root, fixture.state.devices, fixture.state.runtime]) assert.equal((await lstat(path)).mode & 0o777, 0o700);
    assert.equal((await lstat(fixture.state.slotPath)).mode & 0o777, 0o600);
    assert.equal(await readFile(fixture.state.slotPath, "utf8"), controlStateInternals.canonicalSlot(fixture.slot));
  } finally { await fixture.close(); }
});

await test("repeat initialization adopts the immutable slot without rotation", async () => {
  const fixture = await initialized();
  try {
    const repeated = await fixture.state.initialize(BINDING, fixture.slot.createdAt + 1000);
    assert.equal(repeated.published, false);
    assert.deepEqual(repeated.slot, fixture.slot);
    assert.equal(repeated.slot.deviceRef.opaqueId, fixture.slot.deviceRef.opaqueId);
    assert.equal(repeated.slot.control.port, fixture.slot.control.port);
    assert.equal(repeated.slot.control.credential, fixture.slot.control.credential);
    assert.equal(repeated.slot.updatedAt, fixture.slot.updatedAt);
  } finally { await fixture.close(); }
});

await test("concurrent first initialization has one hard-link winner", async () => {
  const fixture = await temporary();
  try {
    const results = await Promise.all(Array.from({ length: 12 }, () => fixture.state.initialize(BINDING, 1_800_000_000_000)));
    assert.equal(results.filter((value) => value.published).length, 1);
    assert.equal(new Set(results.map((value) => value.slot.deviceRef.opaqueId)).size, 1);
    assert.equal(new Set(results.map((value) => value.slot.control.credential)).size, 1);
    assert.equal(new Set(results.map((value) => value.slot.control.port)).size, 1);
    const names = await readdir(fixture.state.devices);
    assert.deepEqual(names, ["android-only.json"]);
  } finally { await fixture.close(); }
});

await test("a different private binding never silently remaps identity", async () => {
  const fixture = await initialized();
  try {
    await assert.rejects(fixture.state.initialize(OTHER, fixture.slot.createdAt), (cause: unknown) => cause instanceof LocalStateFailure && cause.code === "device-ambiguous" && !cause.message.includes(BINDING.serial));
    const current = await fixture.state.readSlot();
    assert.deepEqual(current, fixture.slot);
  } finally { await fixture.close(); }
});

await test("invalid persistent final is fail-closed and is never overwritten", async () => {
  const fixture = await temporary();
  try {
    await fixture.state.prepare();
    const corrupt = "{\"stateVersion\":1}";
    await writeFile(fixture.state.slotPath, corrupt, { mode: 0o600 });
    await assert.rejects(fixture.state.readSlot(), (cause: unknown) => cause instanceof LocalStateFailure && cause.code === "local-state-recovery-required");
    await assert.rejects(fixture.state.initialize(BINDING, 1), (cause: unknown) => cause instanceof LocalStateFailure && cause.code === "local-state-recovery-required");
    assert.equal(await readFile(fixture.state.slotPath, "utf8"), corrupt);
  } finally { await fixture.close(); }
});

await test("slot parser rejects noncanonical order, extra fields and wrong root bytes", async () => {
  const fixture = await initialized();
  try {
    const original = JSON.parse(await readFile(fixture.state.slotPath, "utf8")) as Record<string, unknown>;
    const variants = [
      JSON.stringify({ revision: 1, ...original }),
      JSON.stringify({ ...original, privateExtra: true }),
      JSON.stringify({ ...original, control: { ...(original.control as object), credential: "A".repeat(42) } }),
      `${JSON.stringify(original)}\n`,
      JSON.stringify({ ...original, deviceRef: { ...(original.deviceRef as object), opaqueId: randomUUID().toUpperCase() } }),
      JSON.stringify({ ...original, binding: { ...(original.binding as object), adbPath: "relative/adb" } }),
    ];
    for (const source of variants) {
      await writeFile(fixture.state.slotPath, source, { mode: 0o600 });
      await assert.rejects(fixture.state.readSlot(), LocalStateFailure);
    }
  } finally { await fixture.close(); }
});

await test("slot file permission and symlink substitutions are rejected", async () => {
  const fixture = await initialized();
  try {
    await chmod(fixture.state.slotPath, 0o644);
    await assert.rejects(fixture.state.readSlot(), LocalStateFailure);
    await chmod(fixture.state.slotPath, 0o600);
    const source = await readFile(fixture.state.slotPath);
    const target = join(fixture.parent, "target"); await writeFile(target, source, { mode: 0o600 });
    await rm(fixture.state.slotPath); await symlink(target, fixture.state.slotPath);
    await assert.rejects(fixture.state.readSlot(), LocalStateFailure);
  } finally { await fixture.close(); }
});

await test("insecure existing state directories fail before state access", async () => {
  const fixture = await temporary();
  try {
    await mkdir(fixture.root, { mode: 0o755 }); await chmod(fixture.root, 0o755);
    await assert.rejects(fixture.state.prepare(), LocalStateFailure);
    await chmod(fixture.root, 0o700); await fixture.state.prepare();
    await chmod(fixture.state.devices, 0o755);
    await assert.rejects(fixture.state.prepare(), LocalStateFailure);
  } finally { await fixture.close(); }
});

await test("generation state publishes atomically and reads exact target", async () => {
  const fixture = await initialized();
  try {
    const value = generation(fixture.slot);
    assert.equal(await fixture.state.readGeneration(fixture.slot), undefined);
    await fixture.state.publishGeneration(value);
    const restored = await fixture.state.readGeneration(fixture.slot);
    assert.deepEqual(restored, value);
    assert.equal(Object.isFrozen(restored), true);
    assert.equal((await lstat(fixture.state.generationPath(fixture.slot.deviceRef))).mode & 0o777, 0o600);
    assert.equal(await readFile(fixture.state.generationPath(fixture.slot.deviceRef), "utf8"), controlStateInternals.canonicalGeneration(value));
  } finally { await fixture.close(); }
});

await test("generation publication replaces stale state without exposing credential", async () => {
  const fixture = await initialized();
  try {
    const first = generation(fixture.slot), second = generation(fixture.slot);
    await fixture.state.publishGeneration(first); await fixture.state.publishGeneration(second);
    assert.deepEqual(await fixture.state.readGeneration(fixture.slot), second);
    const source = await readFile(fixture.state.generationPath(fixture.slot.deviceRef), "utf8");
    assert.equal(source.includes(fixture.slot.control.credential), false);
    assert.equal(source.includes(BINDING.serial), false);
    assert.equal(source.includes(BINDING.adbPath), false);
    assert.equal(source.includes("pid"), false);
  } finally { await fixture.close(); }
});

await test("compare-delete prevents an old generation from deleting a new one", async () => {
  const fixture = await initialized();
  try {
    const old = generation(fixture.slot), current = generation(fixture.slot);
    await fixture.state.publishGeneration(old); await fixture.state.publishGeneration(current);
    assert.equal(await fixture.state.deleteGeneration(old), false);
    assert.deepEqual(await fixture.state.readGeneration(fixture.slot), current);
    assert.equal(await fixture.state.deleteGeneration(current), true);
    assert.equal(await fixture.state.readGeneration(fixture.slot), undefined);
    assert.equal(await fixture.state.deleteGeneration(current), false);
  } finally { await fixture.close(); }
});

await test("generation validator rejects partial, wrong-device, wrong-port and ready false", async () => {
  const fixture = await initialized();
  try {
    const valid = generation(fixture.slot), path = fixture.state.generationPath(fixture.slot.deviceRef);
    const base = JSON.parse(controlStateInternals.canonicalGeneration(valid)) as Record<string, unknown>;
    for (const value of [
      { runtimeStateVersion: 1 },
      { ...base, deviceRef: { ...fixture.slot.deviceRef, opaqueId: randomUUID() } },
      { ...base, port: fixture.slot.control.port === 65535 ? 65534 : fixture.slot.control.port + 1 },
      { ...base, ready: false },
      { ...base, credential: fixture.slot.control.credential },
      { ...base, instanceId: "not-a-uuid" },
    ]) {
      await writeFile(path, JSON.stringify(value), { mode: 0o600 });
      await assert.rejects(fixture.state.readGeneration(fixture.slot), LocalStateFailure);
    }
  } finally { await fixture.close(); }
});

await test("partial generation cleanup is port-reserved and path constrained", async () => {
  const fixture = await initialized();
  try {
    const path=fixture.state.generationPath(fixture.slot.deviceRef),unrelated = join(fixture.state.runtime, "unrelated");await writeFile(path,'{"partial":true}',{mode:0o600}); await writeFile(unrelated, "keep", { mode: 0o600 });
    assert.equal(await fixture.state.removePartialGeneration(fixture.slot),true);
    assert.equal(await fixture.state.readGeneration(fixture.slot), undefined);
    assert.equal(await readFile(unrelated, "utf8"), "keep");
  } finally { await fixture.close(); }
});

await test("stale candidate sweep is name, owner, mode and type constrained", async () => {
  const fixture = await initialized();
  try {
    const stale = join(fixture.state.devices, `.android-only.${randomUUID()}.tmp`), wrongMode = join(fixture.state.devices, `.android-only.${randomUUID()}.tmp`), unrelated = join(fixture.state.devices, "keep.tmp"), directory = join(fixture.state.devices, `.android-only.${randomUUID()}.tmp`);
    await writeFile(stale, "secret", { mode: 0o600 }); await writeFile(wrongMode, "keep", { mode: 0o644 }); await chmod(wrongMode, 0o644); await writeFile(unrelated, "keep", { mode: 0o600 }); await mkdir(directory, { mode: 0o700 });
    await fixture.state.sweepTemps();
    const names = await readdir(fixture.state.devices);
    assert.equal(names.includes(stale.split("/").at(-1)!), false);
    assert.equal(names.includes(wrongMode.split("/").at(-1)!), true);
    assert.equal(names.includes("keep.tmp"), true);
    assert.equal(names.includes(directory.split("/").at(-1)!), true);
  } finally { await fixture.close(); }
});

await test("a hard-linked final is adopted after a simulated publication crash", async () => {
  const fixture = await initialized();
  try {
    const source = await readFile(fixture.state.slotPath), candidate = join(fixture.state.devices, `.android-only.${randomUUID()}.tmp`), secondRoot = join(fixture.parent, "other"), second = new LocalRuntimeState(secondRoot);
    await writeFile(candidate, source, { mode: 0o600 });
    assert.equal((await lstat(candidate)).nlink, 1);
    const adopted = await fixture.state.initialize(BINDING, fixture.slot.createdAt);
    assert.equal(adopted.published, false);
    assert.deepEqual(adopted.slot, fixture.slot);
    await fixture.state.sweepTemps();
    assert.equal((await readdir(fixture.state.devices)).includes(candidate.split("/").at(-1)!), false);
    await second.prepare();
    const temp = join(second.devices, `.android-only.${randomUUID()}.tmp`); await writeFile(temp, source, { mode: 0o600 }); await link(temp, second.slotPath);
    const crashAdopt = await second.initialize(BINDING, fixture.slot.createdAt);
    assert.equal(crashAdopt.published, false);
    assert.deepEqual(crashAdopt.slot.deviceRef, fixture.slot.deviceRef);
  } finally { await fixture.close(); }
});

await test("private canonical state never appears in ordinary slot JSON projections", async () => {
  const fixture = await initialized();
  try {
    const safe = JSON.stringify({ deviceRef: fixture.slot.deviceRef, port: fixture.slot.control.port });
    for (const secret of [BINDING.serial, BINDING.adbPath, BINDING.cacheRoot, fixture.slot.control.credential]) assert.equal(safe.includes(secret), false);
    assert.equal(JSON.stringify({ code: "local-state-recovery-required", safeMessage: new LocalStateFailure("local-state-recovery-required").message }).includes(fixture.root), false);
  } finally { await fixture.close(); }
});

await test("generation publication sweeps only matching private stale temps", async () => {
  const fixture = await initialized();
  try {
    const value = generation(fixture.slot), matching = join(fixture.state.runtime, `.${fixture.slot.deviceRef.opaqueId}.${randomUUID()}.tmp`), otherDevice = join(fixture.state.runtime, `.${randomUUID()}.${randomUUID()}.tmp`), wrongMode = join(fixture.state.runtime, `.${fixture.slot.deviceRef.opaqueId}.${randomUUID()}.tmp`), directory = join(fixture.state.runtime, `.${fixture.slot.deviceRef.opaqueId}.${randomUUID()}.tmp`);
    await writeFile(matching, "private", { mode: 0o600 });
    await writeFile(otherDevice, "keep", { mode: 0o600 });
    await writeFile(wrongMode, "keep", { mode: 0o644 }); await chmod(wrongMode, 0o644);
    await mkdir(directory, { mode: 0o700 });
    await fixture.state.publishGeneration(value);
    const names = await readdir(fixture.state.runtime);
    assert.equal(names.includes(matching.split("/").at(-1)!), false);
    assert.equal(names.includes(otherDevice.split("/").at(-1)!), true);
    assert.equal(names.includes(wrongMode.split("/").at(-1)!), true);
    assert.equal(names.includes(directory.split("/").at(-1)!), true);
    assert.equal(names.includes(`${fixture.slot.deviceRef.opaqueId}.json`), true);
  } finally { await fixture.close(); }
});

await test("generation temp cleanup and compare-delete never follow symlinks", async () => {
  const fixture = await initialized();
  try {
    const value = generation(fixture.slot), target = join(fixture.parent, "outside"), temp = join(fixture.state.runtime, `.${fixture.slot.deviceRef.opaqueId}.${randomUUID()}.tmp`);
    await writeFile(target, "outside", { mode: 0o600 }); await symlink(target, temp);
    await fixture.state.publishGeneration(value);
    assert.equal(await readFile(target, "utf8"), "outside");
    assert.equal((await lstat(temp)).isSymbolicLink(), true);
    assert.equal(await fixture.state.deleteGeneration({ ...value, generation: randomUUID() }), false);
    assert.deepEqual(await fixture.state.readGeneration(fixture.slot), value);
  } finally { await fixture.close(); }
});

await test("writable non-sticky ancestor is rejected without weakening leaf mode",async()=>{
  const fixture=await temporary();try{await chmod(fixture.parent,0o777);await assert.rejects(fixture.state.prepare(),LocalStateFailure);}finally{await chmod(fixture.parent,0o700).catch(()=>undefined);await fixture.close();}
});

await test("partial cleanup cannot unlink while a new authority owns the stable port",async()=>{
  const fixture=await initialized();let listener:import("node:net").Server|undefined;try{const path=fixture.state.generationPath(fixture.slot.deviceRef);await writeFile(path,'{"partial":true}',{mode:0o600});const{createServer}=await import("node:net");listener=createServer();await new Promise<void>((resolve,reject)=>{listener!.once("error",reject);listener!.listen({host:"127.0.0.1",port:fixture.slot.control.port,exclusive:true},resolve);});assert.equal(await fixture.state.removePartialGeneration(fixture.slot),false);assert.equal(await readFile(path,"utf8"),'{"partial":true}');}finally{if(listener?.listening)await new Promise<void>((resolve)=>listener!.close(()=>resolve()));await fixture.close();}
});

await test("slot initialization cancellation before publication leaves no final",async()=>{
  const fixture=await temporary();try{const controller=new AbortController();controller.abort();await assert.rejects(fixture.state.initialize(BINDING,1_800_000_000_000,controller.signal),(cause:unknown)=>cause instanceof LocalStateFailure&&cause.code==="request-cancelled");await fixture.state.prepare();assert.equal(await fixture.state.readSlot(),undefined);}finally{await fixture.close();}
});

await test("old shutdown cleanup cannot delete a newly published generation",async()=>{const fixture=await initialized();try{const old=generation(fixture.slot),next=generation(fixture.slot);await fixture.state.publishGeneration(old);await fixture.state.publishGeneration(next);assert.equal(await fixture.state.deleteGeneration(old,true),false);assert.deepEqual(await fixture.state.readGeneration(fixture.slot),next);}finally{await fixture.close();}});

await test("cancellation after temp write cleans unsynced candidate",async()=>{const fixture=await temporary();try{const controller=new AbortController();await assert.rejects(fixture.state.initialize(BINDING,1_800_000_000_000,controller.signal,{afterTempWrite(){controller.abort();}}),(cause:unknown)=>cause instanceof LocalStateFailure&&cause.code==="request-cancelled");assert.equal(await fixture.state.readSlot(),undefined);assert.deepEqual(await readdir(fixture.state.devices),[]);}finally{await fixture.close();}});

await test("cancellation after temp sync removes candidate before publication",async()=>{const fixture=await temporary();try{const controller=new AbortController();await assert.rejects(fixture.state.initialize(BINDING,1_800_000_000_000,controller.signal,{afterTempSync(){controller.abort();}}),(cause:unknown)=>cause instanceof LocalStateFailure&&cause.code==="request-cancelled");assert.equal(await fixture.state.readSlot(),undefined);assert.deepEqual(await readdir(fixture.state.devices),[]);}finally{await fixture.close();}});

await test("cancellation after durable link preserves winner and removes secret temp",async()=>{const fixture=await temporary();try{const controller=new AbortController();await assert.rejects(fixture.state.initialize(BINDING,1_800_000_000_000,controller.signal,{afterLink(){controller.abort();}}),(cause:unknown)=>cause instanceof LocalStateFailure&&cause.code==="request-cancelled");const slot=await fixture.state.readSlot();assert.ok(slot);assert.deepEqual(await readdir(fixture.state.devices),["android-only.json"]);}finally{await fixture.close();}});

await test("unsupported hard-link failures leave neither final nor secret temp",async()=>{for(const code of ["EXDEV","EPERM","EOPNOTSUPP"]){const fixture=await temporary();try{await assert.rejects(fixture.state.initialize(BINDING,1_800_000_000_000,undefined,{link:async()=>{throw Object.assign(new Error(code),{code});}}),(cause:unknown)=>cause instanceof LocalStateFailure&&cause.code==="local-state-recovery-required");assert.equal(await fixture.state.readSlot(),undefined);assert.deepEqual(await readdir(fixture.state.devices),[]);}finally{await fixture.close();}}});

await test("symlink ancestor is rejected before private child creation",async()=>{const fixture=await temporary();try{const real=join(fixture.parent,"real"),alias=join(fixture.parent,"alias");await mkdir(real,{mode:0o700});await symlink(real,alias);const state=new LocalRuntimeState(join(alias,"state"));await assert.rejects(state.prepare(),LocalStateFailure);}finally{await fixture.close();}});

await test("slot publication recovers canonical winner after directory-sync and temp-unlink faults",async()=>{for(const hook of ["afterDirectorySync","afterTempUnlink"]as const){const fixture=await temporary();try{const result=await fixture.state.initialize(BINDING,1_800_000_000_000,undefined,{[hook](){throw new Error(hook);}});assert.ok(await fixture.state.readSlot());assert.deepEqual(await readdir(fixture.state.devices),["android-only.json"]);assert.equal(result.slot.deviceRef.opaqueId,(await fixture.state.readSlot())!.deviceRef.opaqueId);}finally{await fixture.close();}}});

await test("generation rename and directory-sync faults leave one readable canonical final",async()=>{for(const hook of ["afterRename","afterDirectorySync"]as const){const fixture=await initialized();try{const value=generation(fixture.slot);await assert.rejects(fixture.state.publishGeneration(value,{[hook](){throw new Error(hook);}}));assert.deepEqual(await fixture.state.readGeneration(fixture.slot),value);assert.deepEqual(await readdir(fixture.state.runtime),[`${fixture.slot.deviceRef.opaqueId}.json`]);}finally{await fixture.close();}}});

await test("validated directory replacement is rejected by pinned inode identity",async()=>{const fixture=await initialized();try{const moved=`${fixture.state.devices}-old`;await rename(fixture.state.devices,moved);await mkdir(fixture.state.devices,{mode:0o700});await assert.rejects(fixture.state.readSlot(),LocalStateFailure);}finally{await fixture.close();}});


await test("EEXIST loser adopts winner and ENOENT retries a fresh candidate",async()=>{for(const mode of ["EEXIST","ENOENT"]as const){const fixture=await temporary();let calls=0;try{const result=await fixture.state.initialize(BINDING,1_800_000_000_000,undefined,{link:async(source,destination)=>{calls++;if(calls===1){if(mode==="EEXIST")await link(source,destination);throw Object.assign(new Error(mode),{code:mode});}await link(source,destination);}});assert.ok(result.slot);assert.equal(calls,mode==="EEXIST"?1:2);assert.deepEqual(await readdir(fixture.state.devices),["android-only.json"]);}finally{await fixture.close();}}});

await test("slot parser accepts canonical positive revisions and rejects zero overflow and time regression", async () => {
  const fixture = await initialized();
  try {
    const base = JSON.parse(controlStateInternals.canonicalSlot(fixture.slot)) as Record<string, unknown>;
    const revisionTwo = { ...base, revision: 2, updatedAt: fixture.slot.updatedAt + 1 };
    const canonical = JSON.stringify(revisionTwo);
    assert.equal(controlStateInternals.parseSlot(canonical).revision, 2);
    for (const invalid of [
      { ...revisionTwo, revision: 0 },
      { ...revisionTwo, revision: Number.MAX_SAFE_INTEGER + 1 },
      { ...revisionTwo, updatedAt: fixture.slot.createdAt - 1 },
    ]) assert.throws(() => controlStateInternals.parseSlot(JSON.stringify(invalid)), LocalStateFailure);
  } finally { await fixture.close(); }
});

await test("replacement continuously reserves both old and fresh ports through CAS", async () => {
  const fixture = await temporary(); let state!: LocalRuntimeState, slot!: AndroidRuntimeSlot, checked = false;
  const unavailable = async (port: number): Promise<boolean> => {
    const server = createServer();
    try {
      await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen({ host: "127.0.0.1", port, exclusive: true }, resolve); });
      return false;
    } catch (cause) { return (cause as NodeJS.ErrnoException).code === "EADDRINUSE"; }
    finally { if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
  };
  try {
    state = new LocalRuntimeState(fixture.root, { async stage(stage) {
      if (stage !== "replacement-cas") return;
      const candidateName = (await readdir(state.devices)).find((name) => name.endsWith(".tmp"));
      assert.ok(candidateName);
      const candidate = controlStateInternals.parseSlot(await readFile(join(state.devices, candidateName!), "utf8"));
      assert.equal(await unavailable(slot.control.port), true);
      assert.equal(await unavailable(candidate.control.port), true);
      assert.notEqual(candidate.control.port, slot.control.port);
      checked = true;
    } });
    slot = (await state.initialize(BINDING, 1_800_000_000_000)).slot;
    const replaced = await state.replaceSlot(slot, undefined, BINDING, slot.deviceRef, 1_800_000_000_001);
    assert.equal(checked, true);
    assert.equal(replaced.slot.revision, 2);
  } finally { await fixture.close(); }
});

await test("replacement compare-deletes only a strict valid exact generation", async () => {
  const fixture = await initialized();
  try {
    const record = generation(fixture.slot), path = fixture.state.generationPath(fixture.slot.deviceRef);
    await fixture.state.publishGeneration(record);
    await writeFile(path, JSON.stringify({ ...record, generation: randomUUID() }));
    await assert.rejects(fixture.state.replaceSlot(fixture.slot, record, BINDING, fixture.slot.deviceRef, fixture.slot.createdAt + 1), LocalStateFailure);
    assert.equal((await fixture.state.readSlot())!.revision, 1);
    assert.ok(await readFile(path, "utf8"));
  } finally { await fixture.close(); }
});

await test("replacement CAS rejects stale slot bytes and cannot delete a later generation", async () => {
  const fixture = await initialized();
  try {
    const first = await fixture.state.replaceSlot(fixture.slot, undefined, BINDING, fixture.slot.deviceRef, fixture.slot.createdAt + 1);
    const later = generation(first.slot); await fixture.state.publishGeneration(later);
    await assert.rejects(fixture.state.replaceSlot(fixture.slot, undefined, OTHER, Object.freeze({ ...fixture.slot.deviceRef, opaqueId: randomUUID() }), fixture.slot.createdAt + 2), (cause: unknown) => cause instanceof LocalStateFailure && cause.code === "instance-conflict");
    assert.deepEqual(await fixture.state.readGeneration(first.slot), later);
    assert.deepEqual(await fixture.state.readSlot(), first.slot);
  } finally { await fixture.close(); }
});

await test("replacement removes only matching stale generation and slot temps after proving the old port free", async () => {
  const fixture = await initialized();
  try {
    for (let index = 0; index < 3; index++) {
      await writeFile(join(fixture.state.runtime, `.${fixture.slot.deviceRef.opaqueId}.${randomUUID()}.tmp`), "secret", { mode: 0o600 });
      await writeFile(join(fixture.state.devices, `.android-only.${randomUUID()}.tmp`), "secret", { mode: 0o600 });
    }
    const other = join(fixture.state.runtime, `.${randomUUID()}.${randomUUID()}.tmp`); await writeFile(other, "keep", { mode: 0o600 });
    const replaced = await fixture.state.replaceSlot(fixture.slot, undefined, BINDING, fixture.slot.deviceRef, fixture.slot.createdAt + 1);
    assert.deepEqual(await readdir(fixture.state.devices), ["android-only.json"]);
    assert.deepEqual(await readdir(fixture.state.runtime), [other.split("/").at(-1)!]);
    assert.equal(replaced.slot.revision, 2);
  } finally { await fixture.close(); }
});
