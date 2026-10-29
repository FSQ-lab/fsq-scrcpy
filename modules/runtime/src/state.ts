import { validateDeviceRef, validateSize, validateStreamId, type DeviceRef, type Size, type SnapshotReason, type StreamError, type StreamErrorCode, type StreamPhase, type StreamSnapshot, type ViewerDescriptor } from "../../contracts/src/index.js";
import type { Clock, Entropy } from "./clock.js"; import { Mutex } from "./clock.js";
import type { EnsureResult, InspectResult, StopResult, WaitRequest } from "./types.js"; import { freeze } from "./types.js";
const KEY = /^[A-Za-z0-9_-]{22,128}$/;
const validKey = (value: string): boolean => KEY.test(value) && value.length % 4 !== 1 && Buffer.from(value, "base64url").toString("base64url") === value;
const messages: Partial<Record<StreamErrorCode, string>> = { "malformed-control": "The request is invalid.", "runtime-bind-failed": "The local service could not start.", "runtime-overload": "The local service is at capacity.", unauthorized: "Authorization failed." };
export const error = (code: keyof typeof messages): StreamError => freeze({ code, scope: code === "runtime-bind-failed" ? "service" : code === "runtime-overload" ? "stream" : "viewer", disposition: "terminal", safeMessage: messages[code]! } as StreamError);
const exact = (v: unknown, keys: readonly string[]): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v)) && Reflect.ownKeys(v).length === keys.length && keys.every((k) => { const d = Object.getOwnPropertyDescriptor(v, k); return !!d?.enumerable && "value" in d; });
const uuid = (entropy: Entropy): string => { const b = entropy.bytes(16).slice(); b[6] = (b[6]! & 15) | 64; b[8] = (b[8]! & 63) | 128; const h = Buffer.from(b).toString("hex"); b.fill(0); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };
const canonical = (d: DeviceRef): Buffer => { const fields = [String(d.contractVersion), d.platform, d.namespace, d.opaqueId], parts: Buffer[] = []; for (const field of fields) { const bytes = Buffer.from(field), length = Buffer.alloc(2); length.writeUInt16BE(bytes.length); parts.push(length, bytes); } return Buffer.concat(parts); };
interface RecordState { key: string; input: Buffer; createdMono: number; descriptor: ViewerDescriptor; initial: StreamSnapshot; snapshot: StreamSnapshot; history: StreamSnapshot[]; terminalMono: number | undefined; fenced: boolean }
interface MediaState { readonly epoch:number; readonly codedSize:Size; readonly displaySize:Size }
export interface TerminalContext { readonly streamId: string; readonly reason: SnapshotReason; readonly stopping: StreamSnapshot }
export type TerminalParticipant = (context: TerminalContext) => void | Promise<void>;
export interface TerminalFailure { readonly participant: string; readonly code: "cleanup-failed" }
interface Flight { readonly promise: Promise<StreamSnapshot>; readonly resolve: (snapshot: StreamSnapshot) => void; readonly reject: (reason: unknown) => void; readonly reason: SnapshotReason }
interface Waiter {
  readonly record:RecordState;
  readonly afterRevision:number;
  readonly deadline:number;
  readonly signal?:AbortSignal;
  readonly resolve:(result:InspectResult)=>void;
  readonly reject:(reason:unknown)=>void;
  abort:()=>void;
  timer?:object;
  active:boolean;
}
export class MutationCancelled extends Error { constructor() { super("Control mutation cancelled"); this.name = "MutationCancelled"; } }
export class TerminalCoordinator {
  #participants: { order:number; name:string; run:TerminalParticipant }[]=[]; #flights=new Map<string,Flight>(); #failures:TerminalFailure[]=[];
  constructor(private readonly state: StateStore) {}
  register(order: number, name: string, run: TerminalParticipant): void { if (!Number.isInteger(order) || !/^[a-z][a-z0-9-]{0,31}$/.test(name) || this.#participants.some((p)=>p.name===name)) throw new TypeError("Invalid terminal participant"); this.#participants.push({order,name,run}); this.#participants.sort((a,b)=>a.order-b.order || a.name.localeCompare(b.name)); }
  request(streamId: string, reason: SnapshotReason): Promise<StreamSnapshot> { const existing = this.#flights.get(streamId); if (existing) return existing.promise; let resolve!: (snapshot: StreamSnapshot) => void, reject!: (reason: unknown) => void; const promise = new Promise<StreamSnapshot>((yes,no) => { resolve = yes; reject = no; }), flight = { promise, resolve, reject, reason }; this.#flights.set(streamId, flight); void this.#run(streamId, flight); return promise; }
  isFenced(streamId: string): boolean { return this.state.isFenced(streamId); }
  failures(): readonly TerminalFailure[] { return freeze(this.#failures.slice()); }
  flight(streamId: string): Promise<StreamSnapshot> | undefined { return this.#flights.get(streamId)?.promise; }
  activeFlightCount(): number { return this.#flights.size; }
  async #run(streamId: string, flight: Flight): Promise<void> { try { const begun=await this.state.mutex.run(()=>this.state.beginTerminal(streamId)); if (begun.done) { flight.resolve(begun.snapshot); return; } const context=freeze({streamId,reason:flight.reason,stopping:begun.snapshot}); for (const participant of this.#participants) { try { await participant.run(context); } catch { if (this.#failures.length===64) this.#failures.shift(); this.#failures.push(freeze({participant:participant.name,code:"cleanup-failed"})); } } flight.resolve(await this.state.mutex.run(()=>this.state.finishTerminal(streamId,flight.reason))); } catch (cause) { flight.reject(cause); } finally { if (this.#flights.get(streamId)===flight) this.#flights.delete(streamId); } }
}
export class StateStore {
  readonly mutex: Mutex; readonly terminal: TerminalCoordinator; #records = new Map<string, RecordState>(); #current: RecordState | undefined; #waiters=new Set<Waiter>();
  constructor(readonly port: number, readonly clock: Clock, readonly entropy: Entropy, mutex = new Mutex()) { this.mutex = mutex; this.terminal = new TerminalCoordinator(this); }
  ensureStandaloneViewer(value: unknown): Promise<EnsureResult> { return this.mutex.run(()=>this.ensureLocked(value)); }
  runControl<T>(signal:AbortSignal|undefined,operation:()=>T|Promise<T>):Promise<T>{return this.mutex.run(()=>{if(signal?.aborted)throw new MutationCancelled();return operation();});}
  ensureLocked(value: unknown): EnsureResult { if (!exact(value,["deviceRef","idempotencyKey"]) || typeof value.idempotencyKey !== "string" || !validKey(value.idempotencyKey)) return freeze({ok:false,error:error("malformed-control")}); if (this.port<1 || this.port>65535) return freeze({ok:false,error:error("runtime-bind-failed")}); let device:DeviceRef; try { device=freeze({...validateDeviceRef(value.deviceRef)}); } catch { return freeze({ok:false,error:error("malformed-control")}); } const mono=this.clock.mono(); this.#purge(mono); const input=canonical(device), prior=this.#records.get(value.idempotencyKey); if (prior) { if (!prior.input.equals(input)) return freeze({ok:false,error:error("malformed-control")}); if(prior.terminalMono===undefined)return freeze({ok:true,value:freeze({descriptor:prior.descriptor,snapshot:prior.snapshot})}); if(this.#records.size>=64)return freeze({ok:false,error:error("runtime-overload")}); this.#records.delete(value.idempotencyKey);prior.key=`\0${prior.snapshot.streamId}`;this.#records.set(prior.key,prior); } if (this.#current && this.#current.terminalMono===undefined) return freeze({ok:false,error:error("malformed-control")}); if (this.#records.size>=64) return freeze({ok:false,error:error("runtime-overload")}); const streamId=uuid(this.entropy), descriptor=this.descriptor(streamId,this.clock.wall()+30_000), snapshot=this.make(streamId,device,1,"demand-pending",0), record:RecordState={key:value.idempotencyKey,input,createdMono:mono,descriptor,initial:snapshot,snapshot,history:[snapshot],terminalMono:undefined,fenced:false}; this.#records.set(record.key,record); this.#current=record; return freeze({ok:true,value:freeze({descriptor,snapshot})}); }
  inspect(value: unknown): InspectResult { const afterKey=typeof value==="object"&&value!==null&&Object.hasOwn(value,"afterRevision"); if(!exact(value,afterKey?["streamId","afterRevision"]:["streamId"]))return freeze({ok:false,error:error("malformed-control")});try{validateStreamId(value.streamId);}catch{return freeze({ok:false,error:error("malformed-control")});}const record=this.#find(value.streamId);if(!record||(afterKey&&(!Number.isSafeInteger(value.afterRevision)||(value.afterRevision as number)<1||(value.afterRevision as number)>record.snapshot.revision)))return freeze({ok:false,error:error("malformed-control")});return this.#observe(record,value.afterRevision as number|undefined); }
  async wait(value:unknown,signal?:AbortSignal):Promise<InspectResult>{
    let pending:Promise<InspectResult>|undefined;
    const immediate=await this.mutex.run<InspectResult|undefined>(()=>{
      if(!exact(value,["streamId","afterRevision","waitMs"])||
        !Number.isSafeInteger(value.afterRevision)||(value.afterRevision as number)<1||
        !Number.isSafeInteger(value.waitMs)||(value.waitMs as number)<0||
        (value.waitMs as number)>30_000||Object.is(value.waitMs,-0))
        return freeze({ok:false,error:error("malformed-control")});
      try{validateStreamId(value.streamId);}catch{return freeze({ok:false,error:error("malformed-control")});}
      const input=value as unknown as WaitRequest,record=this.#find(input.streamId);
      if(!record||input.afterRevision>record.snapshot.revision)return freeze({ok:false,error:error("malformed-control")});
      if(signal?.aborted)throw new MutationCancelled();
      if(input.afterRevision<record.snapshot.revision||record.terminalMono!==undefined)return this.#observe(record,input.afterRevision);
      if(input.waitMs===0)return this.#timeout(record);
      if(this.#waiters.size>=4)return freeze({ok:false,error:error("runtime-overload")});
      pending=new Promise<InspectResult>((resolve,reject)=>{
        const waiter:Waiter={record,afterRevision:input.afterRevision,deadline:this.clock.mono()+input.waitMs,...(signal?{signal}:{}),resolve,reject,abort:()=>{},active:true};
        waiter.abort=()=>{void this.mutex.run(()=>this.#cancel(waiter));};
        waiter.timer=this.clock.set(input.waitMs,()=>{
          delete waiter.timer;
          void this.mutex.run(()=>this.#expire(waiter));
        });
        signal?.addEventListener("abort",waiter.abort,{once:true});
        this.#waiters.add(waiter);
      });
      return undefined;
    });
    return immediate??pending!;
  }
  activeWaitCount():number{return this.#waiters.size;}
  async stop(value: unknown, signal?: AbortSignal): Promise<StopResult> { const revisionKey = typeof value === "object" && value !== null && Object.hasOwn(value, "expectedRevision"); if (!exact(value, revisionKey ? ["streamId", "expectedRevision", "reason"] : ["streamId", "reason"]) || value.reason !== "explicit-stop") return freeze({ ok: false, error: error("malformed-control") }); let terminal: Promise<StreamSnapshot> | undefined; const immediate = await this.runControl<StopResult | undefined>(signal,() => { const record = this.#find(value.streamId); if (!record) return freeze({ ok: false, error: error("malformed-control") }); if (record.terminalMono !== undefined) return freeze({ ok: true, value: freeze({ snapshot: record.snapshot }) }); if (revisionKey && value.expectedRevision !== record.snapshot.revision) return freeze({ ok: false, error: error("malformed-control"), snapshot: record.snapshot }); terminal=this.terminal.request(record.snapshot.streamId,"explicit-stop"); return undefined; }); if (immediate) return immediate; return freeze({ok:true,value:freeze({snapshot:await terminal!})}); }
  transitionLocked(streamId: string, phase: StreamPhase, active: 0 | 1): StreamSnapshot { const r = this.#find(streamId); if (!r || r.terminalMono !== undefined || r.fenced) throw new TypeError("Invalid stream state"); return this.publish(r, phase, active, phase === "interrupted" ? "stream-interrupted" : undefined); }
  transitionMediaLocked(streamId:string,phase:StreamPhase,active:0|1,value:unknown):StreamSnapshot { if (!exact(value,["epoch","codedSize","displaySize"]) || !Number.isSafeInteger(value.epoch) || (value.epoch as number)<1) throw new TypeError("Invalid media state"); let codedSize:Size,displaySize:Size; try { codedSize=freeze({...validateSize(value.codedSize)}); displaySize=freeze({...validateSize(value.displaySize)}); } catch { throw new TypeError("Invalid media state"); } const r=this.#find(streamId); if (!r || r.terminalMono!==undefined || r.fenced) throw new TypeError("Invalid stream state"); return this.publish(r,phase,active,undefined,freeze({epoch:value.epoch as number,codedSize,displaySize})); }
  beginTerminal(streamId: string): { done: boolean; snapshot: StreamSnapshot } { const r = this.#find(streamId); if (!r) throw new TypeError("Invalid stream state"); if (r.terminalMono !== undefined) return { done: true, snapshot: r.snapshot }; r.fenced = true; return { done: false, snapshot: this.publish(r, "stopping", 0) }; }
  finishTerminal(streamId: string, reason: SnapshotReason): StreamSnapshot { const r = this.#find(streamId); if (!r || !r.fenced) throw new TypeError("Invalid stream state"); if (r.terminalMono !== undefined) return r.snapshot; const phase = reason === "device-disconnected" ? "device-disconnected" : reason === "explicit-stop" || reason === "lease-expired" ? "stopped" : "failed"; r.snapshot = this.publish(r, phase, 0, reason); r.terminalMono = this.clock.mono(); return r.snapshot; }
  descriptor(streamId: string, expiresAt?: number): ViewerDescriptor { const r=this.#find(streamId); if (!r && expiresAt===undefined) throw new TypeError("Invalid stream state"); if (expiresAt!==undefined) { const descriptor=freeze({contractVersion:2 as const,streamId,standaloneUri:`http://127.0.0.1:${this.port}/viewer/${streamId}`,presentationModes:freeze(["standalone"] as const),expiresAt}); if (!r) return descriptor; r.descriptor=descriptor; } return r!.descriptor; }
  hasActive(streamId: unknown): boolean { const r = this.#find(streamId); return !!r && r.terminalMono === undefined && !r.fenced; } isFenced(streamId: string): boolean { return this.#find(streamId)?.fenced === true; }
  #purge(mono: number): void { for (const [key,r] of this.#records) if (r.terminalMono !== undefined && mono >= Math.max(r.createdMono + 600_000, r.terminalMono + 60_000)) this.#records.delete(key); }
  #find(streamId: unknown): RecordState | undefined { return typeof streamId === "string" ? [...this.#records.values()].find((r) => r.snapshot.streamId === streamId) : undefined; }
  private make(streamId:string,deviceRef:DeviceRef,revision:number,phase:StreamPhase,activeViewerCount:0|1,reason?:SnapshotReason,media?:MediaState|StreamSnapshot):StreamSnapshot { const epoch=media?.epoch,codedSize=media?.codedSize,displaySize=media?.displaySize; return freeze({streamId,deviceRef,revision,phase,...(reason===undefined?{}:{reason}),...(epoch===undefined?{}:{epoch}),...(codedSize===undefined?{}:{codedSize}),...(displaySize===undefined?{}:{displaySize}),activeViewerCount,updatedAt:this.clock.wall()}); }
  #observe(record:RecordState,after:number|undefined):InspectResult{
    if(after===undefined||after===record.snapshot.revision)
      return freeze({ok:true,value:freeze({snapshot:record.snapshot,changes:freeze([] as StreamSnapshot[]),reset:false,timedOut:false})});
    const first=record.history[0]!.revision,reset=after<first-1;
    return freeze({ok:true,value:freeze({snapshot:record.snapshot,changes:reset?freeze([] as StreamSnapshot[]):freeze(record.history.filter(snapshot=>snapshot.revision>after)),reset,timedOut:false})});
  }
  #timeout(record:RecordState):InspectResult{
    return freeze({ok:true,value:freeze({snapshot:record.snapshot,changes:freeze([] as StreamSnapshot[]),reset:false,timedOut:true})});
  }
  #dispose(waiter:Waiter):boolean{
    if(!waiter.active)return false;
    waiter.active=false;
    this.#waiters.delete(waiter);
    if(waiter.timer!==undefined){this.clock.clear(waiter.timer);delete waiter.timer;}
    waiter.signal?.removeEventListener("abort",waiter.abort);
    return true;
  }
  #settle(waiter:Waiter,result:InspectResult):void{
    if(this.#dispose(waiter))waiter.resolve(result);
  }
  #expire(waiter:Waiter):void{
    if(!waiter.active)return;
    const remaining=waiter.deadline-this.clock.mono();
    if(remaining>0){
      waiter.timer=this.clock.set(remaining,()=>{
        delete waiter.timer;
        void this.mutex.run(()=>this.#expire(waiter));
      });
      return;
    }
    this.#settle(waiter,this.#timeout(waiter.record));
  }
  #cancel(waiter:Waiter):void{
    if(!waiter.active)return;
    if(this.clock.mono()>=waiter.deadline){this.#settle(waiter,this.#timeout(waiter.record));return;}
    if(this.#dispose(waiter))waiter.reject(new MutationCancelled());
  }
  #expireBeforePublication(record:RecordState):void{
    const now=this.clock.mono();
    for(const waiter of this.#waiters){
      if(waiter.record===record&&now>=waiter.deadline)this.#settle(waiter,this.#timeout(record));
    }
  }
  #wake(record:RecordState):void{
    for(const waiter of this.#waiters){
      if(waiter.record===record)this.#settle(waiter,this.#observe(record,waiter.afterRevision));
    }
  }
  private publish(r:RecordState,phase:StreamPhase,active:0|1,reason?:SnapshotReason,media:MediaState|StreamSnapshot=r.snapshot):StreamSnapshot {
    this.#expireBeforePublication(r);
    r.snapshot=this.make(r.snapshot.streamId,r.snapshot.deviceRef,r.snapshot.revision+1,phase,active,reason,media);
    r.history.push(r.snapshot);
    while(r.history.length>64||Buffer.byteLength(JSON.stringify(r.history))>524_288)r.history.shift();
    this.#wake(r);
    return r.snapshot;
  }
}
