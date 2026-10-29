import { createHmac, timingSafeEqual } from "node:crypto";
import { Agent, request as httpRequest, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { createServer } from "node:http";
import type { Socket } from "node:net";
import {
  CONTROL_VERSION,
  RuntimeControlSession,
  controlError,
  controlErrorStatus,
  encodeCanonicalControlJson,
  parseCanonicalControlJson,
  revisionConflictError,
  validateControlVersion,
  validateDeviceRef,
  validateControlResult,
  validateEnsureViewerValue,
  validateHelloControlValue,
  validateInspectControlValue,
  validateShutdownRuntimeValue,
  validateStopStreamValue,
  validateRuntimeTarget,
  validateWaitControlRequest,
  validateWaitControlWireRequest,
  type ControlError,
  type ControlErrorCode,
  type ControlResult,
  type EnsureViewerValue,
  type HelloControlValue,
  type InspectControlValue,
  type RevisionConflictError,
  type RuntimeAttachment,
  type RuntimeControl,
  type RuntimeInstance,
  type RuntimeTarget,
  type ShutdownRuntimeValue,
  type StopStreamResult,
  type StopStreamValue,
  type WaitControlRequest,
} from "../../contracts/src/index.js";
import type { AndroidRuntimeSlot, RuntimeGenerationState } from "./control-state.js";
import { MutationCancelled } from "./state.js";import type { RuntimeService } from "./index.js";

export interface RuntimeOwnerControl extends AsyncDisposable {
  shutdownRuntime(input: RuntimeTarget, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ShutdownRuntimeValue>>;
  close(): Promise<void>;
}
export type AcquireRuntimeLocalResult = Readonly<{ ok: true; session: RuntimeControlSession }> | Readonly<{ ok: false; error: ControlError }>;
export interface ControlTimer{mono():number;set(delay:number,callback:()=>void):object;clear(handle:object):void}
export interface RuntimeControlHostOptions {
  readonly service?: RuntimeService;readonly slot: AndroidRuntimeSlot;readonly generation: RuntimeGenerationState;readonly onShutdown: () => Promise<void>;readonly timer?:ControlTimer;
}
const ROUTES = Object.freeze({
  "/v1/control/hello": "client", "/v1/viewer/ensure": "client", "/v1/stream/inspect": "client", "/v1/stream/wait": "client", "/v1/stream/stop": "client", "/v1/runtime/shutdown": "owner",
} as const);
type Route = keyof typeof ROUTES;
export const CONTROL_DEADLINES=Object.freeze({connect:1_000,request:5_000,readIdle:2_000,terminate:2_000,readiness:10_000}as const);
const SYSTEM_CONTROL_TIMER:ControlTimer=Object.freeze({mono:():number=>performance.now(),set:(delay:number,callback:()=>void):object=>setTimeout(callback,delay),clear:(handle:object):void=>clearTimeout(handle as NodeJS.Timeout)});
export function armControlDeadline(timer:ControlTimer,delay:number,callback:()=>void):Readonly<{clear():void}>{let active=true;const handle=timer.set(delay,()=>{if(!active)return;active=false;callback();});return Object.freeze({clear(){if(!active)return;active=false;timer.clear(handle);}});}
type ArmedDeadline=ReturnType<typeof armControlDeadline>;
const B64 = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ordinary = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => ordinary(value) && Reflect.ownKeys(value).length === keys.length && keys.every((key) => { const d = Object.getOwnPropertyDescriptor(value, key); return !!d?.enumerable && "value" in d; });
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const fail = (code: ControlErrorCode): Readonly<{ ok: false; error: ControlError }> => frozen({ ok: false, error: controlError(code) });
const ok = <T extends EnsureViewerValue | InspectControlValue | StopStreamValue | ShutdownRuntimeValue | HelloControlValue>(value: T): Readonly<{ ok: true; value: T }> => frozen({ ok: true, value });
const safeTarget = (value: unknown): RuntimeTarget | undefined => { try { return validateRuntimeTarget(value); } catch { return; } };
const deviceEqual = (left: ReturnType<typeof validateDeviceRef>, right: ReturnType<typeof validateDeviceRef>): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
const targetEqual = (a: RuntimeTarget, b: RuntimeTarget): boolean => a.instanceId === b.instanceId && a.generation === b.generation;
const derive = (credential: string, context: "client" | "owner"): Buffer => { const root = Buffer.from(credential, "base64url"); try { return createHmac("sha256", root).update(`FSQ-Control/v1/${context}`).digest(); } finally { root.fill(0); } };
export function deriveControlBearer(credential: string, context: "client" | "owner"): string { const bytes = derive(credential, context); try { return bytes.toString("base64url"); } finally { bytes.fill(0); } }
const MUTATING_ROUTES:ReadonlySet<Route>=new Set(["/v1/viewer/ensure","/v1/stream/stop","/v1/runtime/shutdown"]);
function captureError(code: string): ControlErrorCode { return (["malformed-control", "runtime-overload"] as string[]).includes(code) ? code as ControlErrorCode : "runtime-exited"; }
function cancelled(signal: AbortSignal | undefined): Readonly<{ ok: false; error: ControlError }> | undefined { return signal?.aborted ? fail("request-cancelled") : undefined; }
const signalOptions=(signal?:AbortSignal):Readonly<{signal?:AbortSignal}>|undefined=>signal?{signal}:undefined;
const waitReady = (ready: Promise<void>, milliseconds: number,timer:ControlTimer): Promise<void> => new Promise((resolve) => { const deadline=armControlDeadline(timer,milliseconds,resolve); ready.then(() => { deadline.clear(); resolve(); }); });
const ROUTE_ERRORS:Readonly<Record<Route,ReadonlySet<ControlErrorCode>>>=Object.freeze({"/v1/control/hello":new Set<ControlErrorCode>(["control-version-mismatch","instance-conflict","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"]),"/v1/viewer/ensure":new Set<ControlErrorCode>(["instance-conflict","control-version-mismatch","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"]),"/v1/stream/inspect":new Set<ControlErrorCode>(["instance-conflict","control-version-mismatch","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"]),"/v1/stream/wait":new Set<ControlErrorCode>(["instance-conflict","control-version-mismatch","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"]),"/v1/stream/stop":new Set<ControlErrorCode>(["instance-conflict","control-version-mismatch","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"]),"/v1/runtime/shutdown":new Set<ControlErrorCode>(["instance-conflict","control-version-mismatch","malformed-control","runtime-exited","runtime-overload","deadline-exceeded"])});
function helloFeatureMismatch(value:unknown):boolean{
  if(!ordinary(value)||value.ok!==true||!ordinary(value.value)||!ordinary(value.value.instance))return false;
  try{validateControlResult({...value,value:{...value.value,instance:{...value.value.instance,features:["wait-v1","auto-bootstrap-v1"]}}});return true;}catch{return false;}
}
function responseHeader(response:IncomingMessage,name:string):string{const values:string[]=[];for(let index=0;index<response.rawHeaders.length;index+=2)if(response.rawHeaders[index]!.toLowerCase()===name)values.push(response.rawHeaders[index+1]??"");if(values.length!==1)throw new TypeError("Invalid control response");return values[0]!;}
function decodeRouteResponse(route:Route,response:IncomingMessage,bytes:Uint8Array):ReturnType<typeof validateControlResult>{const contentType=responseHeader(response,"content-type"),length=responseHeader(response,"content-length"),cache=responseHeader(response,"cache-control"),nosniff=responseHeader(response,"x-content-type-options");if(contentType!=="application/json; charset=utf-8"||!/^(?:0|[1-9][0-9]*)$/.test(length)||Number(length)!==bytes.byteLength||cache!=="no-store"||nosniff!=="nosniff")throw new TypeError("Invalid control response");const parsed=parseCanonicalControlJson(bytes);let result:ReturnType<typeof validateControlResult>;try{result=validateControlResult(parsed);}catch{if(route==="/v1/control/hello"&&response.statusCode===200&&helloFeatureMismatch(parsed))return fail("control-version-mismatch");throw new TypeError("Invalid control response");}if(result.ok){if(response.statusCode!==200)throw new TypeError("Invalid control response");if(route==="/v1/control/hello")validateHelloControlValue(result.value);else if(route==="/v1/viewer/ensure")validateEnsureViewerValue(result.value);else if(route==="/v1/stream/inspect"||route==="/v1/stream/wait")validateInspectControlValue(result.value);else if(route==="/v1/stream/stop")validateStopStreamValue(result.value);else validateShutdownRuntimeValue(result.value);return result;}if(result.error.code==="revision-conflict"){if(route!=="/v1/stream/stop"||response.statusCode!==409||!("snapshot"in result))throw new TypeError("Invalid control response");return result;}if(!ROUTE_ERRORS[route].has(result.error.code)||response.statusCode!==controlErrorStatus(result.error)||"snapshot"in result)throw new TypeError("Invalid control response");return result;}

export class RuntimeControlProvider {
  readonly instance: RuntimeInstance;
  #service: RuntimeService; #shutdown: () => Promise<void>; #shuttingDown = false; #ready = false;
  constructor(service: RuntimeService, slot: AndroidRuntimeSlot, generation: RuntimeGenerationState, shutdown: () => Promise<void>) {
    this.#service = service; this.#shutdown = shutdown;
    this.instance = frozen({ controlVersion: CONTROL_VERSION, instanceId: generation.instanceId, generation: generation.generation, contractVersion: 2, deviceRef: slot.deviceRef, features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const) });
  }
  markReady(): void { this.#ready = true; }
  hello(expected: RuntimeTarget | null): ControlResult<HelloControlValue> { if (!this.#ready || this.#shuttingDown) return fail("runtime-exited"); if (expected && !targetEqual(expected, this.instance)) return fail("instance-conflict"); return ok(frozen({ instance: this.instance })); }
  async ensureViewer(options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<EnsureViewerValue>> { const aborted = cancelled(options?.signal); if (aborted) return aborted; if (!this.#ready || this.#shuttingDown) return fail("runtime-exited"); try { const result = await this.#service.ensureControlViewer(this.instance.deviceRef,options?.signal); if (!result.ok) return fail(captureError(result.error.code)); return ok(frozen({ deviceRef: result.value.snapshot.deviceRef, descriptor: result.value.descriptor, snapshot: result.value.snapshot })); } catch(cause) { if(cause instanceof MutationCancelled)return fail("request-cancelled"); throw cause; } }
  #observation(result:ReturnType<RuntimeService["inspectControl"]>):ControlResult<InspectControlValue>{
    if(!result.ok)return fail(result.error.code==="runtime-overload"?"runtime-overload":"malformed-control");
    const source=result.value;
    const fallback=()=>ok(frozen({snapshot:source.snapshot,changes:Object.freeze([]),reset:true,timedOut:false}));
    let normalized=source.changes.length>16||encodeCanonicalControlJson(source.changes).byteLength>12_288
      ?fallback()
      :ok(frozen({snapshot:source.snapshot,changes:source.changes,reset:source.reset,timedOut:source.timedOut}));
    let bytes=encodeCanonicalControlJson(normalized).byteLength;
    if(bytes>16_384){
      const emptyTerminal=source.changes.length===0&&["stopped","device-disconnected","failed"].includes(source.snapshot.phase);
      if(source.timedOut||emptyTerminal)return fail("runtime-overload");
      normalized=fallback();
      bytes=encodeCanonicalControlJson(normalized).byteLength;
    }
    return bytes<=16_384?normalized:fail("runtime-overload");
  }
  inspect(input: Readonly<{ streamId: string; afterRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): ControlResult<InspectControlValue> { const aborted=cancelled(options?.signal);if(aborted)return aborted;return this.#observation(this.#service.inspectControl(input)); }
  async wait(input:WaitControlRequest,options?:Readonly<{signal?:AbortSignal}>):Promise<ControlResult<InspectControlValue>>{
    const aborted=cancelled(options?.signal);
    if(aborted)return aborted;
    try{return this.#observation(await this.#service.waitControl(input,options?.signal));}
    catch(cause){if(cause instanceof MutationCancelled)return fail("request-cancelled");throw cause;}
  }
  async stopStream(input: Readonly<{ streamId: string; expectedRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<StopStreamResult> { const aborted = cancelled(options?.signal); if (aborted) return aborted; if (this.#shuttingDown) return fail("runtime-exited"); try { const result = await this.#service.stopControl({ ...input, reason: "explicit-stop" },options?.signal); if (result.ok) return ok(frozen({ snapshot: result.value.snapshot })); if ("snapshot" in result) return frozen({ ok: false, error: revisionConflictError(), snapshot: result.snapshot }); return fail("malformed-control"); } catch(cause) { if(cause instanceof MutationCancelled)return fail("request-cancelled"); throw cause; } }
  async shutdownRuntime(input: RuntimeTarget, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ShutdownRuntimeValue>> { const aborted = cancelled(options?.signal); if (aborted) return aborted; if (!targetEqual(input, this.instance)) return fail("instance-conflict"); if (!this.#shuttingDown) { if(options?.signal?.aborted)return fail("request-cancelled");this.#shuttingDown = true; await this.#service.close(); } return ok(frozen({ instanceId: this.instance.instanceId, generation: this.instance.generation })); }
  completeShutdown():Promise<void>{return this.#shutdown();}
}
export interface ControlAdmissionSnapshot{readonly preauth:number;readonly authenticated:number;readonly inFlight:number;readonly waits:number}

interface SocketState { authenticated?: "client" | "owner"; requests: number; inFlight: boolean; preauth: boolean;headerTimer?:ArmedDeadline }
export class RuntimeControlHost {
  #provider: RuntimeControlProvider | undefined; #slot: AndroidRuntimeSlot | undefined; #generation: RuntimeGenerationState | undefined; #shutdown: (() => Promise<void>) | undefined; #server: HttpServer | undefined; #sockets = new Map<Socket, SocketState>(); #authenticated = 0; #inFlight = 0; #waits=0; #client: Buffer; #owner: Buffer; #port: number; #ready = false; #readyPromise: Promise<void>; #resolveReady!: () => void;#timer:ControlTimer;
  constructor(options: RuntimeControlHostOptions) { this.#timer=options.timer??SYSTEM_CONTROL_TIMER;this.#readyPromise = new Promise((resolve) => { this.#resolveReady = resolve; }); this.#slot = options.slot; this.#generation = options.generation; this.#shutdown = options.onShutdown; this.#client = derive(options.slot.control.credential, "client"); this.#owner = derive(options.slot.control.credential, "owner"); this.#port = options.slot.control.port; if (options.service) this.activate(options.service); }
  get provider(): RuntimeControlProvider { if (!this.#provider) throw new TypeError("Runtime control provider is not ready"); return this.#provider; }
  activate(service: RuntimeService): void { if (this.#provider || !this.#slot || !this.#generation || !this.#shutdown) throw new TypeError("Runtime control provider is already active"); this.#provider = new RuntimeControlProvider(service, this.#slot, this.#generation, this.#shutdown); this.#slot = undefined; this.#generation = undefined; this.#shutdown = undefined; }
  async start(): Promise<this> {
    if(this.#server)return this;const server=createServer({maxHeaderSize:8192,headersTimeout:CONTROL_DEADLINES.request,requestTimeout:CONTROL_DEADLINES.request},(request,response)=>{void this.#handle(request,response);});server.maxHeadersCount=32;server.keepAliveTimeout=CONTROL_DEADLINES.request;
    server.on("connection",socket=>{if([...this.#sockets.values()].filter(state=>state.preauth).length>=8){socket.destroy();return;}const state:SocketState={requests:0,inFlight:false,preauth:true};this.#sockets.set(socket,state);this.#armHeader(socket,state);socket.once("close",()=>{state.headerTimer?.clear();if(state.authenticated)this.#authenticated--;this.#sockets.delete(socket);});});
    server.on("clientError",(cause:NodeJS.ErrnoException,socket)=>{if(cause.code==="ERR_HTTP_REQUEST_TIMEOUT"&&socket.writable&&!socket.destroyed){const body='{"error":"request-timeout"}';socket.end(`HTTP/1.1 408 Request Timeout\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n${body}`);}else socket.destroy();});
    this.#server=server;await new Promise<void>((resolve,reject)=>{server.once("error",reject);server.listen({host:"127.0.0.1",port:this.#port,exclusive:true},resolve);});return this;
  }
  async close(): Promise<void> { const server = this.#server; this.#server = undefined; this.#resolveReady(); this.#client.fill(0); this.#owner.fill(0); this.#slot = undefined; this.#generation = undefined; this.#shutdown = undefined; this.#provider = undefined; for (const [socket,state] of this.#sockets){state.headerTimer?.clear();socket.destroy();} this.#sockets.clear(); if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve())); }
  ready(): void { this.provider.markReady(); this.#ready = true; this.#resolveReady(); }
  admissionSnapshot():ControlAdmissionSnapshot{return Object.freeze({preauth:[...this.#sockets.values()].filter(state=>state.preauth).length,authenticated:this.#authenticated,inFlight:this.#inFlight,waits:this.#waits});}
  #armHeader(socket:Socket,state:SocketState):void{state.headerTimer?.clear();state.headerTimer=armControlDeadline(this.#timer,CONTROL_DEADLINES.request,()=>{if(!state.preauth&&state.inFlight||socket.destroyed)return;const body='{"error":"request-timeout"}';socket.end(`HTTP/1.1 408 Request Timeout\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nCache-Control: no-store\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n${body}`);});}
  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const socket = request.socket as Socket, state = this.#sockets.get(socket); if (!state) return this.#transport(response, 429, "runtime-overload", true);state.headerTimer?.clear();delete state.headerTimer;
    const authority = this.#authenticate(request); if (!authority) return this.#transport(response, 401, "unauthorized", true);
    if (!state.authenticated) { if (this.#authenticated >= 8) return this.#transport(response, 429, "runtime-overload", true); state.authenticated = authority; state.preauth = false; this.#authenticated++; } else if (state.authenticated !== authority) return this.#transport(response, 401, "unauthorized", true);
    if (++state.requests > 64 || state.inFlight || this.#inFlight >= 8) return this.#transport(response, 429, "runtime-overload", true); state.inFlight = true; this.#inFlight++;
    const cancellation=new AbortController(),cancel=()=>cancellation.abort();request.once("aborted",cancel);response.once("close",cancel);socket.once("close",cancel);
    try {
      const route = request.url as Route; if (request.method !== "POST") return this.#transport(response, 405, "method-not-allowed"); if (!Object.hasOwn(ROUTES, route)) return this.#transport(response, 404, "not-found"); if (ROUTES[route] !== authority) return this.#transport(response, 401, "unauthorized", true); if (this.#forbiddenHeaders(request)) return this.#transport(response, 400, "request-rejected", true);
      const body = await this.#body(request,response); if (!body.ok) {if(body.written)return;return this.#transport(response, body.status, body.error, body.close);} const result = await this.#dispatch(route, body.value,cancellation.signal); const bytes = encodeCanonicalControlJson(result); if (bytes.byteLength > 16_384) return this.#application(response, fail("runtime-overload")); const status=controlErrorStatusResult(result);if(route==="/v1/runtime/shutdown"&&result.ok){try{await this.#writeFinished(response,status,bytes);}finally{await this.#provider?.completeShutdown();}return;}return this.#write(response,status,bytes);
    } finally { request.off("aborted",cancel);response.off("close",cancel);socket.off("close",cancel);state.inFlight = false; this.#inFlight--;if(response.shouldKeepAlive&&response.getHeader("connection")!=="close"&&!socket.destroyed&&!response.destroyed&&state.authenticated)this.#armHeader(socket,state); }
  }
  #authenticate(request: IncomingMessage): "client" | "owner" | undefined {
    const raw = request.rawHeaders, values = (name: string) => { const result: string[] = []; for (let i = 0; i < raw.length; i += 2) if (raw[i]!.toLowerCase() === name) result.push(raw[i + 1] ?? ""); return result; }, hosts = values("host"), auth = values("authorization"); if (hosts.length !== 1 || auth.length !== 1 || hosts[0] !== `127.0.0.1:${this.#port}`) return;
    const match = /^(FSQ-Control|FSQ-Owner) ([A-Za-z0-9_-]{43})$/.exec(auth[0]!); let candidate = Buffer.alloc(32); if (match && B64.test(match[2]!)) { const decoded = Buffer.from(match[2]!, "base64url"); if (decoded.length === 32 && decoded.toString("base64url") === match[2]) { candidate.fill(0); candidate = decoded; } }
    const client = timingSafeEqual(candidate, this.#client), owner = timingSafeEqual(candidate, this.#owner); candidate.fill(0); return match?.[1] === "FSQ-Control" && client ? "client" : match?.[1] === "FSQ-Owner" && owner ? "owner" : undefined;
  }
  #forbiddenHeaders(request: IncomingMessage): boolean { if (request.rawHeaders.length / 2 > 32 || !request.url?.startsWith("/") || request.url.startsWith("//") || /[%?#]/.test(request.url)) return true; const seen = new Set<string>(); for (let index = 0; index < request.rawHeaders.length; index += 2) { const name = request.rawHeaders[index]!.toLowerCase(), value = request.rawHeaders[index + 1] ?? ""; if (seen.has(name) || /[\r\n]/.test(value) || name === "origin" || name === "forwarded" || name === "via" || name.startsWith("x-forwarded-") || name.startsWith("proxy-")) return true; seen.add(name); } return false; }
  async #body(request: IncomingMessage,response:ServerResponse): Promise<Readonly<{ ok: true; value: unknown }> | Readonly<{ ok: false; status: number; error: string; close: boolean;written?:boolean }>> {
    const values = (name: string): string[] => request.rawHeaders.flatMap((value, index) => index % 2 === 0 && value.toLowerCase() === name ? [request.rawHeaders[index + 1] ?? ""] : []);
    if (values("transfer-encoding").length) return frozen({ ok: false, status: 400, error: "request-rejected", close: true });
    if (values("content-type").length !== 1 || values("content-type")[0] !== "application/json; charset=utf-8") return frozen({ ok: false, status: 415, error: "unsupported-media-type", close: true });
    const lengths = values("content-length"); if (lengths.length !== 1 || !/^(?:0|[1-9][0-9]*)$/.test(lengths[0]!)) return frozen({ ok: false, status: 400, error: "request-rejected", close: true }); const expected = Number(lengths[0]); if (expected > 16_384) return frozen({ ok: false, status: 413, error: "body-too-large", close: true });
    type BodyResult=Readonly<{ok:true;value:unknown}>|Readonly<{ok:false;status:number;error:string;close:boolean;written?:boolean}>;let idle:ArmedDeadline|undefined,total:ArmedDeadline|undefined,expired=false,resolveTimeout!:(value:BodyResult)=>void;
    const onTimeout=async():Promise<void>=>{if(expired)return;expired=true;idle?.clear();total?.clear();try{await this.#writeFinished(response,408,Buffer.from('{"error":"request-timeout"}'),true);}finally{request.destroy();resolveTimeout(frozen({ok:false,status:408,error:"request-timeout",close:true,written:true}));}};const timed=new Promise<BodyResult>((resolve)=>{resolveTimeout=resolve;idle=armControlDeadline(this.#timer,CONTROL_DEADLINES.readIdle,()=>{void onTimeout();});total=armControlDeadline(this.#timer,CONTROL_DEADLINES.request,()=>{void onTimeout();});});
    const read=(async():Promise<BodyResult>=>{const chunks:Buffer[]=[];let count=0;try{for await(const chunk of request){if(expired)continue;idle?.clear();idle=armControlDeadline(this.#timer,CONTROL_DEADLINES.readIdle,()=>{void onTimeout();});const bytes=Buffer.from(chunk as Uint8Array);count+=bytes.length;if(count>expected)throw new TypeError("length");chunks.push(bytes);}if(expired)return frozen({ok:false,status:408,error:"request-timeout",close:true,written:true});if(count!==expected)throw new TypeError("length");return frozen({ok:true,value:parseCanonicalControlJson(Buffer.concat(chunks),16_384)});}catch{return frozen({ok:false,status:expired?408:400,error:expired?"request-timeout":"request-rejected",close:true,...(expired?{written:true}:{})});}})();const result=await Promise.race([read,timed]);idle?.clear();total?.clear();if(!result.ok&&result.written)await read;return result;
  }
  async #dispatch(route: Route, body: unknown,signal?:AbortSignal): Promise<ControlResult<HelloControlValue | EnsureViewerValue | InspectControlValue | StopStreamValue | ShutdownRuntimeValue> | StopStreamResult> {
    if (!ordinary(body)) return fail("malformed-control");
    try { validateControlVersion(body.controlVersion); } catch { return fail("control-version-mismatch"); }
    if (route === "/v1/control/hello" && !this.#ready) await waitReady(this.#readyPromise, 4_500,this.#timer);
    const provider = this.#provider; if (!provider) return fail("runtime-exited");
    if (route === "/v1/control/hello") {
      if (!exact(body, ["controlVersion", "contractVersion", "deviceRef", "expectedInstance"]) || body.contractVersion !== 2) return fail("control-version-mismatch");
      try { const device = validateDeviceRef(body.deviceRef); if (!deviceEqual(device, provider.instance.deviceRef)) return fail("instance-conflict"); } catch { return fail("malformed-control"); }
      let expected: RuntimeTarget | null; if (body.expectedInstance === null) expected = null; else { const parsed = safeTarget(body.expectedInstance); if (!parsed) return fail("malformed-control"); expected = parsed; } return provider.hello(expected);
    }
    const target = safeTarget(body.target); if (!target) return fail("malformed-control"); if (!targetEqual(target, provider.instance)) return fail("instance-conflict");
    if (route === "/v1/viewer/ensure") return exact(body, ["controlVersion", "target"]) ? provider.ensureViewer(signalOptions(signal)) : fail("malformed-control");
    if (route === "/v1/stream/inspect") { if (!exact(body, ["controlVersion", "target", "streamId", "afterRevision"]) || !UUID.test(String(body.streamId)) || (body.afterRevision !== null && (!Number.isSafeInteger(body.afterRevision) || (body.afterRevision as number) < 1))) return fail("malformed-control"); return provider.inspect({ streamId: body.streamId as string, ...(body.afterRevision === null ? {} : { afterRevision: body.afterRevision as number }) },signalOptions(signal)); }
    if(route==="/v1/stream/wait"){
      let input:ReturnType<typeof validateWaitControlWireRequest>;
      try{input=validateWaitControlWireRequest(body);}catch{return fail("malformed-control");}
      if(this.#waits>=4)return fail("runtime-overload");
      this.#waits++;
      let expired=false;
      const operation=new AbortController(),abort=()=>operation.abort();
      if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});
      const deadline=armControlDeadline(this.#timer,input.waitMs+CONTROL_DEADLINES.request,()=>{
        expired=true;
        operation.abort();
      });
      try{
        const result=await provider.wait({streamId:input.streamId,afterRevision:input.afterRevision,waitMs:input.waitMs},signalOptions(operation.signal));
        return expired?fail("deadline-exceeded"):result;
      }finally{
        deadline.clear();
        signal?.removeEventListener("abort",abort);
        this.#waits--;
      }
    }
    if (route === "/v1/stream/stop") { if (!exact(body, ["controlVersion", "target", "streamId", "expectedRevision"]) || !UUID.test(String(body.streamId)) || (body.expectedRevision !== null && (!Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1))) return fail("malformed-control"); return provider.stopStream({ streamId: body.streamId as string, ...(body.expectedRevision === null ? {} : { expectedRevision: body.expectedRevision as number }) },signalOptions(signal)); }
    return exact(body, ["controlVersion", "target"]) ? provider.shutdownRuntime(target,signalOptions(signal)) : fail("malformed-control");
  }
  #application(response: ServerResponse, result: Readonly<{ ok: false; error: ControlError }>): void { this.#write(response, controlErrorStatus(result.error), encodeCanonicalControlJson(result)); }
  #transport(response: ServerResponse, status: number, error: string, close = false): void { const bytes = Buffer.from(JSON.stringify({ error })); this.#write(response, status, bytes, close); }
  #write(response: ServerResponse, status: number, body: Uint8Array, close = false): void { if(response.destroyed||response.writableEnded)return;response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.byteLength), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(close ? { Connection: "close" } : {}) }); response.end(body); }
  #writeFinished(response:ServerResponse,status:number,body:Uint8Array,close=false):Promise<void>{if(response.writableFinished||response.destroyed)return Promise.resolve();return new Promise((resolve,reject)=>{let done=false;const cleanup=()=>{response.off("finish",finish);response.off("close",lost);response.off("error",lost);},finish=()=>{if(done)return;done=true;cleanup();resolve();},lost=()=>{if(done)return;done=true;cleanup();resolve();};response.on("finish",finish);response.on("close",lost);response.on("error",lost);try{this.#write(response,status,body,close);if(response.destroyed)lost();else if(response.writableFinished)finish();}catch(cause){cleanup();reject(cause);}});}
}
function controlErrorStatusResult(result: { readonly ok: boolean; readonly error?: ControlError | RevisionConflictError }): number { return result.ok ? 200 : result.error ? controlErrorStatus(result.error) : 500; }
class HttpRuntimeControl implements RuntimeControl {
  #closed = false; #port: number; #target: RuntimeTarget; #bearer: string; readonly #agent = new Agent({ keepAlive: true, maxSockets: 8 });#timer:ControlTimer;#activeWait:Promise<ControlResult<InspectControlValue>>|undefined;#waitAbort:AbortController|undefined;
  constructor(port: number, target: RuntimeTarget, bearer: string,timer:ControlTimer=SYSTEM_CONTROL_TIMER) { this.#port = port; this.#target = frozen({ ...target }); this.#bearer = bearer;this.#timer=timer; }
  get target(): RuntimeTarget { return this.#target; }
  ensureViewer(options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<EnsureViewerValue>> { return this.call("/v1/viewer/ensure", { controlVersion: CONTROL_VERSION, target: this.#target }, options) as Promise<ControlResult<EnsureViewerValue>>; }
  inspect(input: Readonly<{ streamId: string; afterRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<InspectControlValue>> { return this.call("/v1/stream/inspect", { controlVersion: CONTROL_VERSION, target: this.#target, streamId: input.streamId, afterRevision: input.afterRevision ?? null }, options) as Promise<ControlResult<InspectControlValue>>; }
  wait(input:WaitControlRequest,options?:Readonly<{signal?:AbortSignal}>):Promise<ControlResult<InspectControlValue>>{
    if(this.#closed)return Promise.resolve(fail("runtime-exited"));
    let checked:ReturnType<typeof validateWaitControlRequest>;
    try{checked=validateWaitControlRequest(input);}catch{return Promise.resolve(fail("malformed-control"));}
    if(this.#activeWait)return Promise.resolve(fail("runtime-overload"));
    const controller=new AbortController(),abort=()=>controller.abort();
    this.#waitAbort=controller;
    if(options?.signal?.aborted)abort();else options?.signal?.addEventListener("abort",abort,{once:true});
    const pending=this.call("/v1/stream/wait",{
      controlVersion:CONTROL_VERSION,
      target:this.#target,
      streamId:checked.streamId,
      afterRevision:checked.afterRevision,
      waitMs:checked.waitMs,
    },{signal:controller.signal}) as Promise<ControlResult<InspectControlValue>>;
    this.#activeWait=pending;
    const cleanup=()=>{
      options?.signal?.removeEventListener("abort",abort);
      if(this.#activeWait===pending){this.#activeWait=undefined;this.#waitAbort=undefined;}
    };
    void pending.then(cleanup,cleanup);
    return pending;
  }
  stopStream(input: Readonly<{ streamId: string; expectedRevision?: number }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<StopStreamResult> { return this.call("/v1/stream/stop", { controlVersion: CONTROL_VERSION, target: this.#target, streamId: input.streamId, expectedRevision: input.expectedRevision ?? null }, options) as Promise<StopStreamResult>; }
  async close(): Promise<void> {
    if(this.#closed){await this.#activeWait;return;}
    this.#closed=true;
    this.#waitAbort?.abort();
    await this.#activeWait;
    this.#bearer="";
    this.#agent.destroy();
  }
  async call(path: Route, value: unknown, options?: Readonly<{ signal?: AbortSignal }>, owner = false): Promise<unknown> {
    if (this.#closed) return fail("runtime-exited");
    if (options?.signal?.aborted) return fail("request-cancelled");
    const body = encodeCanonicalControlJson(value),waitBudget=path==="/v1/stream/wait"&&ordinary(value)&&Number.isSafeInteger(value.waitMs)&&(value.waitMs as number)>=0&&(value.waitMs as number)<=30_000?(value.waitMs as number)+CONTROL_DEADLINES.request:CONTROL_DEADLINES.request;
    return new Promise((resolve) => {
      let settled = false, applied = false, responseStarted = false, connectTimer: ArmedDeadline | undefined, totalTimer: ArmedDeadline | undefined;
      let request!: ReturnType<typeof httpRequest>, abort: () => void = () => undefined;
      const finish = (result: unknown): void => { if (settled) return; settled = true; totalTimer?.clear();connectTimer?.clear();options?.signal?.removeEventListener("abort", abort); resolve(result); };
      abort = (): void => { request.destroy(); finish(fail(path==="/v1/stream/wait"||!applied ? "request-cancelled" : "deadline-exceeded")); };
      request = httpRequest({ host: "127.0.0.1", port: this.#port, path, method: "POST", agent: this.#agent, headers: { Host: `127.0.0.1:${this.#port}`, Authorization: `${owner ? "FSQ-Owner" : "FSQ-Control"} ${this.#bearer}`, "Content-Type": "application/json; charset=utf-8", "Content-Length": String(body.byteLength) } }, (response) => {
        responseStarted = true; applied = true; connectTimer?.clear();
        void collect(response,this.#timer).then((bytes) => { try { finish(decodeRouteResponse(path,response,bytes)); } catch { finish(fail(path === "/v1/control/hello" ? "local-state-recovery-required" : "runtime-exited")); } }, () => finish(fail(path === "/v1/control/hello" ? "local-state-recovery-required" : path==="/v1/stream/wait"?"deadline-exceeded":"runtime-exited")));
      });
      request.on("socket", (socket) => { const connected=()=>{if(settled)return;connectTimer?.clear();if(!totalTimer)totalTimer=armControlDeadline(this.#timer,waitBudget,()=>{request.destroy();finish(fail("deadline-exceeded"));});};if(!socket.connecting){connected();return;}connectTimer=armControlDeadline(this.#timer,CONTROL_DEADLINES.connect,()=>{request.destroy();finish(fail("deadline-exceeded"));});socket.once("connect",connected); });
      request.on("error", (cause: NodeJS.ErrnoException) => { if (responseStarted) return; if(cause.code?.startsWith("HPE_")){finish(fail(path==="/v1/control/hello"?"local-state-recovery-required":"runtime-exited"));return;}if(applied&&(MUTATING_ROUTES.has(path)||path==="/v1/stream/wait")){finish(fail("deadline-exceeded"));return;}finish(fail(path === "/v1/control/hello" && cause.code === "ECONNREFUSED" ? "instance-not-found" : "runtime-exited")); });
      options?.signal?.addEventListener("abort",abort,{once:true});if(options?.signal?.aborted){abort();return;}request.end(body, () => { applied = true; });
    });
  }
}
async function collect(response: IncomingMessage,timer:ControlTimer): Promise<Uint8Array> { const chunks: Buffer[] = []; let bytes = 0, timedOut = false,idle:object|undefined; const arm=()=>{if(idle)timer.clear(idle);idle=timer.set(CONTROL_DEADLINES.readIdle,()=>{timedOut=true;response.destroy();});};arm();try { for await (const chunk of response) {arm();const value=Buffer.from(chunk as Uint8Array);bytes+=value.length;if(bytes>16_384){response.destroy();throw new Error("overload");}chunks.push(value);}if(timedOut)throw new Error("timeout");return Buffer.concat(chunks);}finally{if(idle)timer.clear(idle);} }
export async function helloControl(slot: AndroidRuntimeSlot, expected: RuntimeTarget | null, signal?: AbortSignal,timer:ControlTimer=SYSTEM_CONTROL_TIMER): Promise<ControlResult<HelloControlValue>> {
  const target = expected ?? { instanceId: "00000000-0000-4000-8000-000000000000", generation: "00000000-0000-4000-8000-000000000000" },client = new HttpRuntimeControl(slot.control.port, target, deriveControlBearer(slot.control.credential, "client"),timer);
  try { return await client.call("/v1/control/hello", { controlVersion: CONTROL_VERSION, contractVersion: 2, deviceRef: slot.deviceRef, expectedInstance: expected }, signal ? { signal } : undefined) as ControlResult<HelloControlValue>; } finally { await client.close(); }
}
export async function attachControlSession(port: number, attachment: RuntimeAttachment, credential: string, signal?: AbortSignal,timer:ControlTimer=SYSTEM_CONTROL_TIMER): Promise<AcquireRuntimeLocalResult> { if (signal?.aborted) return fail("request-cancelled"); const client = new HttpRuntimeControl(port, { instanceId: attachment.instance.instanceId, generation: attachment.instance.generation }, deriveControlBearer(credential, "client"),timer); return frozen({ ok: true, session: new RuntimeControlSession(attachment, client) }); }
export class OwnerHttpControl implements RuntimeOwnerControl {
  readonly #client: HttpRuntimeControl;
  constructor(port: number, target: RuntimeTarget, credential: string,timer:ControlTimer=SYSTEM_CONTROL_TIMER) { this.#client = new HttpRuntimeControl(port, target, deriveControlBearer(credential, "owner"),timer); }
  shutdownRuntime(input: RuntimeTarget, options?: Readonly<{ signal?: AbortSignal }>): Promise<ControlResult<ShutdownRuntimeValue>> { return this.#client.call("/v1/runtime/shutdown", { controlVersion: CONTROL_VERSION, target: input }, options, true) as Promise<ControlResult<ShutdownRuntimeValue>>; }
  close(): Promise<void> { return this.#client.close(); }
  [Symbol.asyncDispose](): Promise<void> { return this.close(); }
}
