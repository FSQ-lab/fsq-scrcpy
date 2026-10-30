import { randomBytes, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { chmod, link, lstat, mkdir, open, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { createServer } from "node:net";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { validateDeviceRef, validateRuntimeTarget, type DeviceRef, type RuntimeTarget } from "../../contracts/src/index.js";
import { resolveSingleAndroidBinding, revealAndroidBinding, type ResolvedAndroidBinding } from "../../capture/src/index.js";

export type RuntimePlatform = "android" | "ios";
interface RuntimeSlotBase {
  readonly stateVersion: 1;
  readonly revision: number;
  readonly deviceRef: DeviceRef;
  readonly control: Readonly<{ port: number; credential: string }>;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface AndroidRuntimeSlot extends RuntimeSlotBase { readonly platform: "android"; readonly binding: ResolvedAndroidBinding }
export interface IosRuntimeSlot extends RuntimeSlotBase { readonly platform: "ios" }
export type RuntimeSlot = AndroidRuntimeSlot | IosRuntimeSlot;
export type RuntimeSlotFor<P extends RuntimePlatform> = P extends "android" ? AndroidRuntimeSlot : IosRuntimeSlot;
export interface RuntimeGenerationState {
  readonly runtimeStateVersion: 1;
  readonly deviceRef: DeviceRef;
  readonly instanceId: string;
  readonly generation: string;
  readonly port: number;
  readonly createdAt: number;
  readonly ready: true;
}
export interface SlotInitializationHooks{afterTempWrite?():void|Promise<void>;afterTempSync?():void|Promise<void>;link?(source:string,destination:string):Promise<void>;afterLink?():void|Promise<void>;afterDirectorySync?():void|Promise<void>;afterTempUnlink?():void|Promise<void>}
export interface GenerationPublicationHooks{afterTempWrite?():void|Promise<void>;afterRename?():void|Promise<void>;afterDirectorySync?():void|Promise<void>}
export type LocalRuntimeStateStage=
  | "slot-temp-write" | "slot-file-sync" | "slot-file-close" | "slot-link" | "slot-directory-sync" | "slot-temp-unlink"
  | "generation-temp-write" | "generation-file-sync" | "generation-file-close" | "generation-rename" | "generation-directory-sync" | "generation-temp-unlink"
  | "replacement-temp-write" | "replacement-file-sync" | "replacement-file-close" | "replacement-generation-delete"
  | "replacement-cas" | "replacement-rename" | "replacement-directory-sync" | "replacement-temp-unlink";
export interface LocalRuntimeStateHooks{stage?(stage:LocalRuntimeStateStage):void|Promise<void>}
export class LocalStateFailure extends Error {
  constructor(readonly code: "device-ambiguous" | "instance-conflict" | "local-state-recovery-required" | "request-cancelled") {
    super(code === "device-ambiguous" ? "Device selection is ambiguous." : code === "instance-conflict" ? "The Runtime identity does not match." : code === "request-cancelled" ? "The control request was cancelled before it was applied." : "Local Runtime state requires owner recovery.");
    this.name = "LocalStateFailure";
  }
}
const B64 = /^[A-Za-z0-9_-]{43}$/;
const TEMP_UUID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const tempPattern = (platform: RuntimePlatform): RegExp => new RegExp(`^\\.${platform}-only\\.${TEMP_UUID}\\.tmp$`);
const canonicalCredential = (value: string): boolean => { if (!B64.test(value)) return false; const bytes = Buffer.from(value, "base64url"); try { return bytes.byteLength === 32 && bytes.toString("base64url") === value; } finally { bytes.fill(0); } };
const fixedRoot = (): string => join(userInfo().homedir, "Library", "Application Support", "FSQ_scrcpy");
const ordinary = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => ordinary(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return !!d?.enumerable && "value" in d; });
const freezeBinding = (value: ResolvedAndroidBinding): ResolvedAndroidBinding => Object.freeze({ serial: value.serial, adbPath: value.adbPath, cacheRoot: value.cacheRoot, artifactSource: Object.freeze({ mode: "online" }) });
const freezeSlot = (value: RuntimeSlot): RuntimeSlot => value.platform === "android"
  ? Object.freeze({ ...value, deviceRef: Object.freeze({ ...value.deviceRef }), binding: freezeBinding(value.binding), control: Object.freeze({ ...value.control }) })
  : Object.freeze({ ...value, deviceRef: Object.freeze({ ...value.deviceRef }), control: Object.freeze({ ...value.control }) });
const canonicalSlot = (value: RuntimeSlot): string => value.platform === "android"
  ? JSON.stringify({ stateVersion: 1, revision: value.revision, platform: "android", deviceRef: { contractVersion: 2, platform: "android", namespace: value.deviceRef.namespace, opaqueId: value.deviceRef.opaqueId }, binding: { serial: value.binding.serial, adbPath: value.binding.adbPath, cacheRoot: value.binding.cacheRoot, artifactSource: { mode: "online" } }, control: { port: value.control.port, credential: value.control.credential }, createdAt: value.createdAt, updatedAt: value.updatedAt })
  : JSON.stringify({ stateVersion: 1, revision: value.revision, platform: "ios", deviceRef: { contractVersion: 2, platform: "ios", namespace: value.deviceRef.namespace, opaqueId: value.deviceRef.opaqueId }, control: { port: value.control.port, credential: value.control.credential }, createdAt: value.createdAt, updatedAt: value.updatedAt });
const canonicalGeneration = (value: RuntimeGenerationState): string => JSON.stringify({ runtimeStateVersion: 1, deviceRef: { contractVersion: 2, platform: value.deviceRef.platform, namespace: value.deviceRef.namespace, opaqueId: value.deviceRef.opaqueId }, instanceId: value.instanceId, generation: value.generation, port: value.port, createdAt: value.createdAt, ready: true });
const sameBinding = (slot: RuntimeSlot, binding: ResolvedAndroidBinding | undefined): boolean => slot.platform === "ios" ? binding === undefined : !!binding && slot.binding.serial === binding.serial && slot.binding.adbPath === binding.adbPath && slot.binding.cacheRoot === binding.cacheRoot && slot.binding.artifactSource.mode === binding.artifactSource.mode;
const sameDevice = (left: DeviceRef, right: DeviceRef): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
const effectiveUid = (): number => { const value = process.geteuid?.(); if (value === undefined) throw new LocalStateFailure("local-state-recovery-required"); return value; };
const checkCancellation=(signal?:AbortSignal):void=>{if(signal?.aborted)throw new LocalStateFailure("request-cancelled");};
interface PathIdentity{readonly dev:number;readonly ino:number}
const sameIdentity=(left:PathIdentity,right:PathIdentity):boolean=>left.dev===right.dev&&left.ino===right.ino;
async function verifyAncestors(path:string):Promise<void>{for(let current=dirname(path);;current=dirname(current)){const state=await lstat(current);if(!state.isDirectory()||state.isSymbolicLink()||((state.mode&0o022)!==0&&(state.mode&0o1000)===0))throw new LocalStateFailure("local-state-recovery-required");if(current===dirname(current))break;}}
async function directoryIdentity(path:string):Promise<PathIdentity>{const state=await lstat(path);if(!state.isDirectory()||state.isSymbolicLink()||state.uid!==effectiveUid()||(state.mode&0o7777)!==0o700)throw new LocalStateFailure("local-state-recovery-required");const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat();if(!sameIdentity(state,opened))throw new LocalStateFailure("local-state-recovery-required");return{dev:opened.dev,ino:opened.ino};}finally{await handle.close();}}
async function readPrivateFile(path:string):Promise<string>{const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.uid!==effectiveUid()||(before.mode&0o777)!==0o600)throw new LocalStateFailure("local-state-recovery-required");const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat();if(!sameIdentity(before,opened))throw new LocalStateFailure("local-state-recovery-required");const source=await handle.readFile("utf8");if(typeof source!=="string")throw new LocalStateFailure("local-state-recovery-required");const after=await handle.stat();if(!sameIdentity(opened,after))throw new LocalStateFailure("local-state-recovery-required");return source;}finally{await handle.close();}}
async function stableDirectory<T>(path:string,operation:()=>Promise<T>,signal?:AbortSignal,expected?:PathIdentity):Promise<T>{await verifyAncestors(path);checkCancellation(signal);const before=await directoryIdentity(path);if(expected&&!sameIdentity(before,expected))throw new LocalStateFailure("local-state-recovery-required");checkCancellation(signal);const result=await operation();checkCancellation(signal);await verifyAncestors(path);checkCancellation(signal);const after=await directoryIdentity(path);checkCancellation(signal);if(!sameIdentity(before,after))throw new LocalStateFailure("local-state-recovery-required");return result;}

async function secureDirectory(path: string, create: boolean,signal?:AbortSignal): Promise<void> {
  let created = false, validated = false;
  try {
    const parent = dirname(path), canonicalParent = await realpath(parent);checkCancellation(signal); await verifyAncestors(path);checkCancellation(signal);
    if (canonicalParent !== parent) throw new LocalStateFailure("local-state-recovery-required");
    const parentState = await lstat(parent);checkCancellation(signal);
    if (parentState.isSymbolicLink() || !parentState.isDirectory()) throw new LocalStateFailure("local-state-recovery-required");
    if (create) { try { await mkdir(path, { mode: 0o700 }); created = true;checkCancellation(signal); } catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "EEXIST") throw cause; } }
    if (created) {await chmod(path, 0o700);checkCancellation(signal);}
    await directoryIdentity(path);checkCancellation(signal); validated = true;
  } finally { if (created && !validated) await rmdir(path).catch(() => undefined); }
}
async function syncDirectory(path: string): Promise<void> { const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { await handle.sync(); } finally { await handle.close(); } }
async function safeUnlink(path: string): Promise<boolean> { try { await unlink(path);return true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT")return false;throw cause; } }
async function lstatExisting(path:string):Promise<Stats|undefined>{try{return await lstat(path);}catch(cause){if((cause as NodeJS.ErrnoException).code==="ENOENT")return;throw cause;}}
async function writeExclusive(path: string, bytes: Uint8Array,signal?:AbortSignal,afterWrite?:()=>void|Promise<void>,afterSync?:()=>void|Promise<void>,afterClose?:()=>void|Promise<void>): Promise<void> { const handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try {checkCancellation(signal); await handle.writeFile(bytes);await afterWrite?.();checkCancellation(signal); await handle.sync();await afterSync?.();checkCancellation(signal); } finally { await handle.close();await afterClose?.(); } }
async function cleanupTemp(directory:string,path:string,expected:PathIdentity|undefined,afterUnlink?:()=>void|Promise<void>):Promise<void>{await stableDirectory(directory,async()=>{const removed=await safeUnlink(path);if(removed)await afterUnlink?.();await syncDirectory(directory);},undefined,expected);}
interface PortReservation { readonly port: number; close(): Promise<void> }
async function reservePort(excluded?: number): Promise<PortReservation> {
  for (let attempt = 0; attempt < 32; attempt++) {
    const port = 49_152 + randomBytes(2).readUInt16BE() % 16_384;
    if (port === excluded) continue;
    const server = createServer();
    server.on("connection", (socket) => socket.destroy());
    server.unref();
    const listening = await new Promise<boolean>((done) => {
      server.once("error", () => done(false));
      server.listen({ host: "127.0.0.1", port, exclusive: true }, () => done(true));
    });
    if (!listening) continue;
    let closed = false;
    return Object.freeze({ port, close: async () => { if (closed) return; closed = true; await new Promise<void>((resolveClose) => server.close(() => resolveClose())); } });
  }
  throw new LocalStateFailure("local-state-recovery-required");
}
async function candidatePort(): Promise<number> { const reserved = await reservePort(); try { return reserved.port; } finally { await reserved.close(); } }

function parseSlot(source: string, expectedPlatform: RuntimePlatform = "android"): RuntimeSlot {
  let value: unknown; try { value = JSON.parse(source); } catch { throw new LocalStateFailure("local-state-recovery-required"); }
  const keys = expectedPlatform === "android"
    ? ["stateVersion", "revision", "platform", "deviceRef", "binding", "control", "createdAt", "updatedAt"]
    : ["stateVersion", "revision", "platform", "deviceRef", "control", "createdAt", "updatedAt"];
  if (!exact(value, keys) || value.stateVersion !== 1 || !Number.isSafeInteger(value.revision) || (value.revision as number) < 1 || value.platform !== expectedPlatform) throw new LocalStateFailure("local-state-recovery-required");
  const control = value.control;
  if (!exact(control, ["port", "credential"]) || !Number.isInteger(control.port) || (control.port as number) < 49_152 || (control.port as number) > 65_535 || typeof control.credential !== "string" || !canonicalCredential(control.credential) || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0 || !Number.isSafeInteger(value.updatedAt) || (value.updatedAt as number) < (value.createdAt as number)) throw new LocalStateFailure("local-state-recovery-required");
  let deviceRef: DeviceRef; try { deviceRef = validateDeviceRef(value.deviceRef); } catch { throw new LocalStateFailure("local-state-recovery-required"); }
  if (deviceRef.platform !== expectedPlatform) throw new LocalStateFailure("local-state-recovery-required");
  let slot: RuntimeSlot;
  if (expectedPlatform === "android") {
    const binding = value.binding;
    if (!exact(binding, ["serial", "adbPath", "cacheRoot", "artifactSource"]) || typeof binding.serial !== "string" || binding.serial.length < 1 || binding.serial.length > 256 || /[^\x21-\x7e]/.test(binding.serial) || typeof binding.adbPath !== "string" || resolve(binding.adbPath) !== binding.adbPath || typeof binding.cacheRoot !== "string" || resolve(binding.cacheRoot) !== binding.cacheRoot || !exact(binding.artifactSource, ["mode"]) || binding.artifactSource.mode !== "online") throw new LocalStateFailure("local-state-recovery-required");
    slot = freezeSlot({ stateVersion: 1, revision: value.revision as number, platform: "android", deviceRef, binding: binding as unknown as ResolvedAndroidBinding, control: control as { port: number; credential: string }, createdAt: value.createdAt as number, updatedAt: value.updatedAt as number });
  } else {
    if (deviceRef.namespace !== "fsq.ios.local" || value.revision !== 1 || value.createdAt !== value.updatedAt) throw new LocalStateFailure("local-state-recovery-required");
    slot = freezeSlot({ stateVersion: 1, revision: 1, platform: "ios", deviceRef, control: control as { port: number; credential: string }, createdAt: value.createdAt as number, updatedAt: value.updatedAt as number });
  }
  if (canonicalSlot(slot) !== source) throw new LocalStateFailure("local-state-recovery-required"); return slot;
}
function parseGeneration(source: string, slot: Readonly<{ deviceRef: DeviceRef; control: Readonly<{ port: number }> }>): RuntimeGenerationState {
  let value: unknown; try { value = JSON.parse(source); } catch { throw new LocalStateFailure("local-state-recovery-required"); }
  if (!exact(value, ["runtimeStateVersion", "deviceRef", "instanceId", "generation", "port", "createdAt", "ready"]) || value.runtimeStateVersion !== 1 || value.ready !== true || value.port !== slot.control.port || !Number.isSafeInteger(value.createdAt) || (value.createdAt as number) < 0) throw new LocalStateFailure("local-state-recovery-required");
  let deviceRef: DeviceRef, target: RuntimeTarget; try { deviceRef = validateDeviceRef(value.deviceRef); target = validateRuntimeTarget({ instanceId: value.instanceId, generation: value.generation }); } catch { throw new LocalStateFailure("local-state-recovery-required"); }
  if (JSON.stringify(deviceRef) !== JSON.stringify(slot.deviceRef)) throw new LocalStateFailure("local-state-recovery-required"); const result = Object.freeze({ runtimeStateVersion: 1 as const, deviceRef: Object.freeze({ ...deviceRef }), ...target, port: slot.control.port, createdAt: value.createdAt as number, ready: true as const }); if (canonicalGeneration(result) !== source) throw new LocalStateFailure("local-state-recovery-required"); return result;
}
export class LocalRuntimeState<P extends RuntimePlatform = "android"> {
  readonly root: string; readonly devices: string; readonly runtime: string; readonly slotPath: string;#rootIdentity:PathIdentity|undefined;#devicesIdentity:PathIdentity|undefined;#runtimeIdentity:PathIdentity|undefined;
  constructor(root = fixedRoot(),readonly hooks:LocalRuntimeStateHooks={},readonly platform:P="android" as P) { this.root = root; this.devices = join(root, "devices"); this.runtime = join(root, "runtime"); this.slotPath = join(this.devices, `${platform}-only.json`); }
  #stage(stage:LocalRuntimeStateStage):Promise<void>{return Promise.resolve(this.hooks.stage?.(stage));}
  async prepare(signal?:AbortSignal): Promise<void> { await secureDirectory(this.root, true,signal);checkCancellation(signal);await secureDirectory(this.devices,true,signal);checkCancellation(signal);await secureDirectory(this.runtime,true,signal);checkCancellation(signal);const root=await directoryIdentity(this.root),devices=await directoryIdentity(this.devices),runtime=await directoryIdentity(this.runtime);if(this.#rootIdentity&&!sameIdentity(root,this.#rootIdentity)||this.#devicesIdentity&&!sameIdentity(devices,this.#devicesIdentity)||this.#runtimeIdentity&&!sameIdentity(runtime,this.#runtimeIdentity))throw new LocalStateFailure("local-state-recovery-required");this.#rootIdentity??=root;this.#devicesIdentity??=devices;this.#runtimeIdentity??=runtime; }
  async openExisting(): Promise<boolean> {
    const root = await lstatExisting(this.root);
    if (!root) return false;
    await secureDirectory(this.root, false);
    await secureDirectory(this.devices, false);
    await secureDirectory(this.runtime, false);
    const rootIdentity = await directoryIdentity(this.root), devicesIdentity = await directoryIdentity(this.devices), runtimeIdentity = await directoryIdentity(this.runtime);
    if (this.#rootIdentity && !sameIdentity(rootIdentity, this.#rootIdentity) || this.#devicesIdentity && !sameIdentity(devicesIdentity, this.#devicesIdentity) || this.#runtimeIdentity && !sameIdentity(runtimeIdentity, this.#runtimeIdentity)) throw new LocalStateFailure("local-state-recovery-required");
    this.#rootIdentity ??= rootIdentity;
    this.#devicesIdentity ??= devicesIdentity;
    this.#runtimeIdentity ??= runtimeIdentity;
    return true;
  }
  async readSlot(): Promise<RuntimeSlotFor<P> | undefined> { try { return parseSlot(await stableDirectory(this.devices,()=>readPrivateFile(this.slotPath),undefined,this.#devicesIdentity),this.platform) as RuntimeSlotFor<P>; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; } }
  async initialize(binding: P extends "android" ? ResolvedAndroidBinding : undefined, now: number,signal?:AbortSignal,hooks:SlotInitializationHooks={}): Promise<Readonly<{ slot: RuntimeSlotFor<P>; published: boolean }>> {
    if (this.platform === "android" ? !binding : binding !== undefined) throw new LocalStateFailure("local-state-recovery-required");
    if (!Number.isSafeInteger(now) || now < 0) throw new LocalStateFailure("local-state-recovery-required");checkCancellation(signal); await this.prepare(signal);checkCancellation(signal); const existing = await this.readSlot();checkCancellation(signal); if (existing) { if (!sameBinding(existing, binding)) throw new LocalStateFailure("device-ambiguous");await this.sweepTemps();checkCancellation(signal); return Object.freeze({ slot: existing, published: false }); }
    for (;;) {
      let temp:string|undefined;
      try {
        checkCancellation(signal);const credentialBytes=randomBytes(32),credential=credentialBytes.toString("base64url");credentialBytes.fill(0);const deviceRef=Object.freeze({contractVersion:2 as const,platform:this.platform,namespace:`fsq.${this.platform}.local`,opaqueId:randomUUID()});const base={stateVersion:1 as const,revision:1,deviceRef,control:Object.freeze({port:await candidatePort(),credential}),createdAt:now,updatedAt:now};const slot=(this.platform==="android"?freezeSlot({...base,platform:"android",binding:freezeBinding(binding as ResolvedAndroidBinding)}):freezeSlot({...base,platform:"ios"})) as RuntimeSlotFor<P>;checkCancellation(signal);temp=join(this.devices,`.${this.platform}-only.${randomUUID()}.tmp`);await stableDirectory(this.devices,()=>writeExclusive(temp!,Buffer.from(canonicalSlot(slot)),signal,async()=>{await hooks.afterTempWrite?.();await this.#stage("slot-temp-write");},async()=>{await hooks.afterTempSync?.();await this.#stage("slot-file-sync");},()=>this.#stage("slot-file-close")),signal,this.#devicesIdentity);checkCancellation(signal);
        try{await stableDirectory(this.devices,async()=>{checkCancellation(signal);await (hooks.link??link)(temp!,this.slotPath);await hooks.afterLink?.();await this.#stage("slot-link");await syncDirectory(this.devices);await hooks.afterDirectorySync?.();await this.#stage("slot-directory-sync");},signal,this.#devicesIdentity);await stableDirectory(this.devices,async()=>{if(await safeUnlink(temp!)){await hooks.afterTempUnlink?.();await this.#stage("slot-temp-unlink");}await syncDirectory(this.devices);},undefined,this.#devicesIdentity);temp=undefined;await this.sweepTemps();checkCancellation(signal);return Object.freeze({slot,published:true});}
        catch(cause){const code=(cause as NodeJS.ErrnoException).code,winner=await this.readSlot();if(winner){if(!sameBinding(winner,binding))throw new LocalStateFailure("device-ambiguous");await this.sweepTemps();checkCancellation(signal);return Object.freeze({slot:winner,published:false});}if(code==="ENOENT")continue;throw cause instanceof LocalStateFailure?cause:new LocalStateFailure("local-state-recovery-required");}
      } finally {if(temp)await cleanupTemp(this.devices,temp,this.#devicesIdentity,()=>this.#stage("slot-temp-unlink"));}
    }
  }
  async sweepTemps(): Promise<void> { const pattern=tempPattern(this.platform);await stableDirectory(this.devices,async()=>{for (const name of await readdir(this.devices)) if (pattern.test(name)) { const path = join(this.devices, name), info = await lstatExisting(path); if (info?.isFile() && !info.isSymbolicLink() && info.uid === effectiveUid() && (info.mode & 0o777) === 0o600&&await safeUnlink(path))await this.#stage("slot-temp-unlink"); } await syncDirectory(this.devices);},undefined,this.#devicesIdentity); }
  generationPath(deviceRef: DeviceRef): string { return join(this.runtime, `${deviceRef.opaqueId}.json`); }
  async readGeneration(slot: RuntimeSlotFor<P>): Promise<RuntimeGenerationState | undefined> { try { return parseGeneration(await stableDirectory(this.runtime,()=>readPrivateFile(this.generationPath(slot.deviceRef)),undefined,this.#runtimeIdentity),slot); } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "ENOENT") return; throw cause; } }
  async publishGeneration(value: RuntimeGenerationState,hooks:GenerationPublicationHooks={}): Promise<void> { await this.prepare(); const final = this.generationPath(value.deviceRef), temp = join(this.runtime, `.${value.deviceRef.opaqueId}.${randomUUID()}.tmp`); await stableDirectory(this.runtime,()=>writeExclusive(temp,Buffer.from(canonicalGeneration(value)),undefined,async()=>{await hooks.afterTempWrite?.();await this.#stage("generation-temp-write");},()=>this.#stage("generation-file-sync"),()=>this.#stage("generation-file-close")),undefined,this.#runtimeIdentity);try { await stableDirectory(this.runtime,async()=>{await rename(temp,final);await hooks.afterRename?.();await this.#stage("generation-rename");await syncDirectory(this.runtime);await hooks.afterDirectorySync?.();await this.#stage("generation-directory-sync");},undefined,this.#runtimeIdentity); await this.sweepGenerationTemps(value.deviceRef); } finally { await cleanupTemp(this.runtime,temp,this.#runtimeIdentity,()=>this.#stage("generation-temp-unlink")); } }
  async deleteGeneration(expected: RuntimeGenerationState,authorityLive=false): Promise<boolean> { const path = this.generationPath(expected.deviceRef);let server:ReturnType<typeof createServer>|undefined;try{if(!authorityLive){server=createServer();await new Promise<void>((resolve,reject)=>{server!.once("error",reject);server!.listen({host:"127.0.0.1",port:expected.port,exclusive:true},resolve);});}const source=await stableDirectory(this.runtime,()=>readPrivateFile(path),undefined,this.#runtimeIdentity);const current=parseGeneration(source,{deviceRef:expected.deviceRef,control:{port:expected.port}}as AndroidRuntimeSlot);if(current.instanceId!==expected.instanceId||current.generation!==expected.generation||current.port!==expected.port||!sameDevice(current.deviceRef,expected.deviceRef))return false;await stableDirectory(this.runtime,async()=>{const latest=await readPrivateFile(path);const verified=parseGeneration(latest,{deviceRef:expected.deviceRef,control:{port:expected.port}}as AndroidRuntimeSlot);if(verified.instanceId!==expected.instanceId||verified.generation!==expected.generation)throw new LocalStateFailure("local-state-recovery-required");await safeUnlink(path);await syncDirectory(this.runtime);},undefined,this.#runtimeIdentity);return true;}catch{return false;}finally{if(server?.listening)await new Promise<void>((resolve)=>server!.close(()=>resolve()));}}
  async removePartialGeneration(slot: RuntimeSlotFor<P>): Promise<boolean> { const path=this.generationPath(slot.deviceRef);let server:ReturnType<typeof createServer>|undefined;try{server=createServer();await new Promise<void>((resolve,reject)=>{server!.once("error",reject);server!.listen({host:"127.0.0.1",port:slot.control.port,exclusive:true},resolve);});return await stableDirectory(this.runtime,async()=>{const before=await lstat(path);if(!before.isFile()||before.isSymbolicLink()||before.uid!==effectiveUid()||(before.mode&0o777)!==0o600)return false;const handle=await open(path,constants.O_RDONLY|constants.O_NOFOLLOW);try{const opened=await handle.stat();if(!sameIdentity(opened,before))return false;const current=await lstat(path);if(!sameIdentity(current,opened))return false;await safeUnlink(path);await syncDirectory(this.runtime);return true;}finally{await handle.close();}},undefined,this.#runtimeIdentity);}catch(cause){if((cause as NodeJS.ErrnoException).code==="ENOENT")return true;return false;}finally{if(server?.listening)await new Promise<void>((resolve)=>server!.close(()=>resolve()));}}
  async sweepGenerationTemps(deviceRef: DeviceRef): Promise<void> { const pattern = new RegExp(`^\\.${deviceRef.opaqueId}\\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\\.tmp$`); await stableDirectory(this.runtime,async()=>{for (const name of await readdir(this.runtime)) if (pattern.test(name)) { const path = join(this.runtime, name), info = await lstatExisting(path); if (info?.isFile() && !info.isSymbolicLink() && info.uid === effectiveUid() && (info.mode & 0o777) === 0o600&&await safeUnlink(path))await this.#stage("generation-temp-unlink"); } await syncDirectory(this.runtime);},undefined,this.#runtimeIdentity); }
  async replaceSlot(expected: AndroidRuntimeSlot, expectedGeneration: RuntimeGenerationState | undefined, binding: ResolvedAndroidBinding, deviceRef: DeviceRef, now: number, signal?: AbortSignal): Promise<Readonly<{ previous: AndroidRuntimeSlot; slot: AndroidRuntimeSlot }>> {
    if (this.platform !== "android") throw new LocalStateFailure("local-state-recovery-required");
    if (!Number.isSafeInteger(now) || now < expected.createdAt || expected.revision >= Number.MAX_SAFE_INTEGER) throw new LocalStateFailure("local-state-recovery-required");
    let checkedDevice: DeviceRef;
    try { checkedDevice = validateDeviceRef(deviceRef); } catch { throw new LocalStateFailure("local-state-recovery-required"); }
    if (checkedDevice.platform !== "android") throw new LocalStateFailure("local-state-recovery-required");
    checkCancellation(signal);
    await this.prepare(signal);
    const source = canonicalSlot(expected), current = await this.readSlot();
    if (!current || current.platform !== "android" || canonicalSlot(current) !== source) throw new LocalStateFailure("instance-conflict");
    let oldPort: ReturnType<typeof createServer> | undefined, freshPort: PortReservation | undefined, temp: string | undefined, committed = false;
    try {
      oldPort = createServer();
      oldPort.on("connection", (socket) => socket.destroy());
      await new Promise<void>((resolveListen, rejectListen) => { oldPort!.once("error", rejectListen); oldPort!.listen({ host: "127.0.0.1", port: expected.control.port, exclusive: true }, resolveListen); });
      checkCancellation(signal);
      freshPort = await reservePort(expected.control.port);
      checkCancellation(signal);
      const compared = await this.readSlot();
      if (!compared || compared.platform !== "android" || canonicalSlot(compared) !== source) throw new LocalStateFailure("instance-conflict");
      const generation = await (this as unknown as LocalRuntimeState<"android">).readGeneration(expected);
      if ((!generation) !== (!expectedGeneration) || generation && expectedGeneration && canonicalGeneration(generation) !== canonicalGeneration(expectedGeneration)) throw new LocalStateFailure("instance-conflict");
      if (generation && expectedGeneration) {
        const generationPath = this.generationPath(expected.deviceRef), generationSource = canonicalGeneration(expectedGeneration);
        await stableDirectory(this.runtime, async () => {
          if (await readPrivateFile(generationPath) !== generationSource) throw new LocalStateFailure("instance-conflict");
          await safeUnlink(generationPath);
          await syncDirectory(this.runtime);
          await this.#stage("replacement-generation-delete");
        }, signal, this.#runtimeIdentity);
      }
      await this.sweepGenerationTemps(expected.deviceRef);
      checkCancellation(signal);
      const credentialBytes = randomBytes(32), credential = credentialBytes.toString("base64url"); credentialBytes.fill(0);
      const slot = freezeSlot({ stateVersion: 1, revision: expected.revision + 1, platform: "android", deviceRef: checkedDevice, binding: freezeBinding(binding), control: Object.freeze({ port: freshPort.port, credential }), createdAt: expected.createdAt, updatedAt: now }) as AndroidRuntimeSlot;
      temp = join(this.devices, `.android-only.${randomUUID()}.tmp`);
      await stableDirectory(this.devices, () => writeExclusive(temp!, Buffer.from(canonicalSlot(slot)), signal, () => this.#stage("replacement-temp-write"), () => this.#stage("replacement-file-sync"), () => this.#stage("replacement-file-close")), signal, this.#devicesIdentity);
      checkCancellation(signal);
      await stableDirectory(this.devices, async () => {
        if (await readPrivateFile(this.slotPath) !== source) throw new LocalStateFailure("instance-conflict");
        await this.#stage("replacement-cas");
        checkCancellation(signal);
        await rename(temp!, this.slotPath);
        committed = true;
        await this.#stage("replacement-rename");
        await syncDirectory(this.devices);
        await this.#stage("replacement-directory-sync");
      }, undefined, this.#devicesIdentity);
      temp = undefined;
      await this.sweepTemps();
      return Object.freeze({ previous: expected, slot });
    } catch (cause) {
      if (committed) {
        const applied = await this.readSlot();
        if (applied?.platform === "android" && applied.revision === expected.revision + 1) { await syncDirectory(this.devices); await this.sweepTemps(); return Object.freeze({ previous: expected, slot: applied as AndroidRuntimeSlot }); }
      }
      throw cause instanceof LocalStateFailure ? cause : new LocalStateFailure("local-state-recovery-required");
    } finally {
      if (temp) await cleanupTemp(this.devices, temp, this.#devicesIdentity, () => this.#stage("replacement-temp-unlink"));
      await freshPort?.close();
      if (oldPort?.listening) await new Promise<void>((resolveClose) => oldPort!.close(() => resolveClose()));
    }
  }
}

export async function resolveAutomaticSlot(platform: RuntimePlatform, signal?: AbortSignal): Promise<Readonly<{ state: LocalRuntimeState<RuntimePlatform>; slot: RuntimeSlot; published: boolean }>> {
  const state = new LocalRuntimeState(undefined, {}, platform); await state.prepare(signal);checkCancellation(signal);
  if (platform === "ios") return Object.freeze({ state, ...await state.initialize(undefined, Date.now(), signal) });
  const resolved = await resolveSingleAndroidBinding(signal ? { signal } : undefined); if (!resolved.ok) throw resolved.error;checkCancellation(signal); const binding = revealAndroidBinding(resolved.value.access), result = await state.initialize(binding, Date.now(),signal); return Object.freeze({ state, ...result });
}
export const controlStateInternals = Object.freeze({ fixedRoot, canonicalSlot, canonicalGeneration, parseSlot, parseGeneration, candidatePort, reservePort });
