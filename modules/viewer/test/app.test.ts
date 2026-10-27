import assert from "node:assert/strict";import test from "node:test";import { MetricsSummary,ViewerApp,type AppAdapters,type MainFrame,type VideoImage,type Reply,type RequestInitLike,type ViewerSurface,type WorkerPort } from "../src/app.js";import type { ViewerState } from "../src/state.js";
import {absoluteMonotonicNow} from "../src/protocol.js";
import {WorkerController,type SocketLike} from "../src/worker.js";
import {jpegSession,jpegWire} from "./bitmap-fixtures.js";
const ID="123e4567-e89b-42d3-a456-426614174000",PAIRING="123e4567-e89b-42d3-a456-426614174001",WALL=1_800_000_000_000,EXPIRY=WALL+10_000,WORKER=`/assets/${"a".repeat(64)}/worker.js`,reply=(status:number,value?:unknown):Reply=>({status,json:async()=>value});
class Frame implements VideoImage{closes=0;constructor(readonly displayWidth=720,readonly displayHeight=1280){}close(){this.closes++;}}
class Bitmap{closes=0;constructor(readonly width=2,readonly height=1){}close(){this.closes++;}}
const frameMessage=(sequence:bigint,fresh:boolean,frame:MainFrame)=>({type:"frame" as const,generation:2,sequence,epoch:1n,fresh,receivedAt:900,decodedAt:950,outputAt:975,frame});
class Port implements WorkerPort{sent:unknown[]=[];terminated=0;handler=(_value:unknown)=>{};failPost=false;postMessage(value:unknown){if(this.failPost)throw new Error("post");this.sent.push(value);}terminate(){this.terminated++;}onMessage(fn:(value:unknown)=>void){this.handler=fn;}emit(value:unknown){this.handler(value);}}
class Surface implements ViewerSurface{ready=()=>true;clears=0;clear(){this.clears++;}states:Array<[ViewerState,string|undefined]>=[];pairings:Array<[string,number]>=[];draws:MainFrame[]=[];metrics:Readonly<Record<string,number|boolean>>[]=[];retry=()=>{};drawResult=true;retryStates:boolean[]=[];pairing(code:string,expires:number){this.pairings.push([code,expires]);}state(state:ViewerState,message?:string){this.states.push([state,message]);}retrying(active:boolean){this.retryStates.push(active);}draw(frame:MainFrame){this.draws.push(frame);return this.drawResult;}metric(sample:Readonly<Record<string,number|boolean>>){this.metrics.push(sample);}onRetry(fn:()=>void){this.retry=fn;}}
class Harness {
 profile:unknown="h264-annexb";wall=WALL;mono=1_000;visible=true;
 requests:Array<{path:string;init:RequestInitLike}>=[];replies:Array<Reply|Error|Promise<Reply>>=[];
 timers:Array<{id:number;at:number;fn:()=>void}>=[];rafs=new Map<number,()=>void>();
 controllers:AbortController[]=[];next=1;port=new Port();surface=new Surface();
 visibility=()=>{};pagehide=()=>{};
 readonly adapters:AppAdapters;
 constructor(){
  const owner=this;
  this.adapters={
   origin:"http://127.0.0.1:43210",pathname:`/viewer/${ID}`,get mediaProfile(){return owner.profile;},
   bitmap:(value):value is Bitmap=>value instanceof Bitmap,foundation:()=>true,
   visible:()=>this.visible,dpr:()=>2,viewport:()=>({width:800,height:800}),
   controller:()=>{const value=new AbortController();this.controllers.push(value);return value;},
   request:async(path,init)=>{
    this.requests.push({path,init});const value=this.replies.shift();
    if(value instanceof Error)throw value;if(!value)throw new Error("missing reply");return await value;
   },
   worker:()=>this.port,surface:this.surface,wallNow:()=>this.wall,monoNow:()=>this.mono,
   timeout:(fn,ms)=>{const id=this.next++;this.timers.push({id,at:this.mono+ms,fn});return id;},
   clearTimeout:id=>{this.timers=this.timers.filter(v=>v.id!==id);},
   raf:fn=>{const id=this.next++;this.rafs.set(id,fn);return id;},cancelRaf:id=>{this.rafs.delete(id as number);},
   onVisibility:fn=>{this.visibility=fn;},onPageHide:fn=>{this.pagehide=fn;},
  };
 }
 advance(ms:number){
  this.wall+=ms;this.mono+=ms;
  for(const timer of this.timers.filter(v=>v.at<=this.mono).sort((a,b)=>a.at-b.at)){
   this.timers=this.timers.filter(v=>v!==timer);timer.fn();
  }
 }
 paint(){for(const[id,fn]of [...this.rafs]){this.rafs.delete(id);fn();}}
}
const flush=()=>new Promise<void>(resolve=>setImmediate(resolve));
const isFrameComplete=(value:unknown):value is {type:"frame-complete";generation:number;sequence:bigint;presented:boolean}=>typeof value==="object"&&value!==null&&"type" in value&&value.type==="frame-complete"&&"generation" in value&&typeof value.generation==="number"&&"sequence" in value&&typeof value.sequence==="bigint"&&"presented" in value&&typeof value.presented==="boolean";
function deferred(){let resolve!:(value:Reply)=>void,reject!:(reason?:unknown)=>void;const promise=new Promise<Reply>((yes,no)=>{resolve=yes;reject=no;});return{promise,resolve,reject};}
async function authorized(h=new Harness()){h.replies.push(reply(201,{pairingId:PAIRING,pairingCode:"ABCDEFGH",expiresAt:EXPIRY}),reply(200,{bootstrapGrant:"AAAAAAAAAAAAAAAAAAAAAA",expiresAt:EXPIRY}),reply(204));const app=new ViewerApp(h.adapters,WORKER);await app.start();return{h,app};}
const metricFrame=(summary:MetricsSummary,sourceFrames:number,receivedAt:number,paintAt:number,fresh=false)=>{summary.update({receivedAt,sourceFrames,outputs:sourceFrames,decodeQueue:2,ownedFrames:1});return summary.update({receivedAt,decodedAt:receivedAt+2,outputAt:receivedAt+5,paintAt,presented:true,fresh});};
const fullEpoch=(summary:MetricsSummary,sourceFrames:number,origin:number)=>{let source=sourceFrames+1,result=metricFrame(summary,source,origin-9,origin,true);for(let window=0;window<6;window++)for(let i=window===0?1:0;i<300;i++){const receivedAt=origin+window*10_000+i*30;result=metricFrame(summary,++source,receivedAt,receivedAt+9);}result=summary.update({receivedAt:origin+60_000,sourceFrames:++source});return{result,source};};

test("pairing expiry uses wall clock while paint evidence uses monotonic clock",async()=>{const{h,app}=await authorized();assert.equal(app.state,"connecting");assert.deepEqual(h.surface.pairings,[["ABCDEFGH",EXPIRY]]);assert.deepEqual(h.requests.map(v=>[v.path,v.init.method,v.init.credentials,v.init.referrerPolicy,v.init.body]),[["/v1/pairings","POST","same-origin","no-referrer",JSON.stringify({streamId:ID})],[`/v1/pairings/${PAIRING}/redeem`,"POST","same-origin","no-referrer",JSON.stringify({pairingCode:"ABCDEFGH"})],["/v1/sessions","POST","same-origin","no-referrer","{}"]]);assert.match(h.requests[2]!.init.headers!.Authorization!,/^FSQ-Bootstrap [A-Za-z0-9_-]{22}$/);assert.equal(h.requests[2]!.init.keepalive,true);assert.equal(h.requests[2]!.init.signal,undefined);assert.equal(h.requests.some(request=>request.path==="/v1/sessions/current"),false);assert.deepEqual(h.port.sent,[{type:"start",origin:h.adapters.origin,streamId:ID,mediaProfile:"h264-annexb"},{type:"visibility",visible:true}]);h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});h.port.emit(frameMessage(1n,true,new Frame()));h.paint();assert.equal(h.surface.metrics.at(-1)!.paintAt,h.mono);});
test("409 redeem polls at 500ms; pre-approval network retries are bounded at one second",async()=>{const h=new Harness();h.replies.push(new Error("network"),reply(201,{pairingId:PAIRING,pairingCode:"ABCDEFGH",expiresAt:EXPIRY}),reply(409),reply(200,{bootstrapGrant:"AAAAAAAAAAAAAAAAAAAAAA",expiresAt:EXPIRY}),reply(204));const app=new ViewerApp(h.adapters,WORKER),flight=app.start();await flush();assert.equal(h.requests.length,1);h.advance(1_000);await flush();assert.equal(h.requests.length,3);h.advance(500);await flight;assert.equal(h.requests.length,5);assert.equal(app.state,"connecting");});
test("fresh visible paint alone enters Live and every replacement/hidden frame closes once",async()=>{const{h,app}=await authorized();h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});const first=new Frame();h.port.emit(frameMessage(3n,true,first));h.paint();assert.equal(first.closes,1);assert.equal(app.state,"live");assert.deepEqual(h.port.sent.at(-1),{type:"frame-complete",generation:2,sequence:3n,presented:true});assert.deepEqual(h.surface.metrics.at(-1),{receivedAt:900,decodedAt:950,outputAt:975,paintAt:1_000,presented:true,fresh:true});const replaced=new Frame(),latest=new Frame();h.port.emit(frameMessage(4n,false,replaced));h.port.emit(frameMessage(5n,false,latest));assert.equal(replaced.closes,1);h.visible=false;h.visibility();assert.equal(latest.closes,1);assert.equal(app.state,"paused");assert.deepEqual(h.port.sent.slice(-2),[{type:"frame-complete",generation:2,sequence:5n,presented:false},{type:"visibility",visible:false}]);});
test("reset discards old generation, tolerates stale floor and rejects unknown future generation",async()=>{const{h,app}=await authorized();h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});const pending=new Frame();h.port.emit(frameMessage(4n,true,pending));h.port.emit({type:"reset",generation:3,discardThroughSequence:4n,state:"syncing"});assert.equal(pending.closes,1);assert.deepEqual(h.port.sent.slice(-2),[{type:"frame-complete",generation:2,sequence:4n,presented:false},{type:"reset-complete",generation:3,discardThroughSequence:4n}]);const late=new Frame();h.port.emit(frameMessage(4n,true,late));assert.equal(late.closes,1);assert.equal(app.state,"syncing");const future=new Frame();h.port.emit({...frameMessage(5n,true,future),generation:4,epoch:2n});assert.equal(future.closes,1);assert.equal(app.state,"error");});
test("visibility refresh, refresh failure and pagehide are ownership-safe",async()=>{const{h,app}=await authorized();h.replies.push(reply(204));h.advance(30_000);await flush();assert.equal(h.requests.at(-1)!.path,"/v1/sessions/refresh");h.visible=false;h.visibility();const before=h.requests.length;h.advance(30_000);await flush();assert.equal(h.requests.length,before);h.visible=true;h.replies.push(new Error("offline"));h.visibility();h.advance(30_000);await flush();assert.equal(app.state,"disconnected");assert.equal(h.port.terminated,0);h.advance(250);assert.equal(h.port.terminated,1);const second=await authorized();second.h.replies.push(reply(204));second.h.pagehide();assert.deepEqual(second.h.port.sent.slice(-2),[{type:"visibility",visible:false},{type:"dispose"}]);assert.equal(second.h.controllers.some(controller=>controller.signal.aborted),true);second.h.advance(250);assert.equal(second.h.port.terminated,1);});
test("malformed, terminal and stale Worker frames close and complete exactly once",async()=>{const{h,app}=await authorized(),malformed=new Frame(),message={...frameMessage(1n,true,malformed),extra:"secret"};h.port.emit(message);h.port.emit(message);assert.equal(app.state,"error");assert.equal(malformed.closes,1);assert.deepEqual(h.port.sent.filter(isFrameComplete),[{type:"frame-complete",generation:2,sequence:1n,presented:false}]);assert.equal(JSON.stringify(h.surface.states).includes("secret"),false);const stale=new Frame();h.port.emit(frameMessage(2n,true,stale));assert.equal(stale.closes,1);const next=await authorized();next.h.port.emit({type:"error",code:"viewer-unsupported",safeMessage:"This browser cannot decode the stream."});assert.equal(next.app.state,"unsupported");assert.deepEqual(next.h.surface.states.at(-1),["unsupported","This browser cannot decode the stream."]);});
test("failed END transition releases cached frame through interrupted before sticky terminal error",async()=>{const{h,app}=await authorized();h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});const cached=new Frame();h.port.emit(frameMessage(3n,true,cached));const beforeStates=h.surface.states.length,beforeRequests=h.requests.length;h.port.emit({type:"state",state:"interrupted"});assert.equal(app.state,"interrupted");assert.equal(cached.closes,1);assert.deepEqual(h.port.sent.filter(isFrameComplete),[{type:"frame-complete",generation:2,sequence:3n,presented:false}]);h.port.emit({type:"state",state:"error"});assert.equal(app.state,"error");assert.deepEqual(h.surface.states.slice(beforeStates),[["interrupted",undefined],["error",undefined]]);assert.equal(cached.closes,1);assert.equal(h.port.sent.filter(value=>typeof value==="object"&&value!==null&&"type"in value&&value.type==="dispose").length,1);h.port.emit({type:"state",state:"connecting"});assert.equal(app.state,"error");h.advance(30_000);await flush();assert.equal(h.requests.length,beforeRequests);h.advance(250);assert.equal(h.port.terminated,1);});
test("draw throw closes/completes once and becomes fixed rendering error",async()=>{const{h,app}=await authorized();h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});const frame=new Frame();h.surface.draw=()=>{throw new Error("pixels");};h.port.emit(frameMessage(2n,true,frame));h.paint();assert.equal(frame.closes,1);assert.equal(app.state,"error");assert.deepEqual(h.surface.states.at(-1),["error","Rendering failed."]);assert.deepEqual(h.port.sent.filter(isFrameComplete),[{type:"frame-complete",generation:2,sequence:2n,presented:false}]);});
test("retry is single-flight, waits through DELETE 401, then starts exactly one pairing",async()=>{const{h,app}=await authorized(),deletion=deferred();h.replies.push(deletion.promise,reply(201,{pairingId:PAIRING,pairingCode:"ABCDEFGH",expiresAt:EXPIRY}),reply(200,{bootstrapGrant:"AAAAAAAAAAAAAAAAAAAAAA",expiresAt:EXPIRY}),reply(204));const first=app.retry(),second=app.retry();assert.equal(first,second);await flush();assert.equal(h.requests[3]!.path,"/v1/sessions/current");assert.equal(h.requests.length,4);deletion.resolve(reply(401));await first;assert.equal(h.requests.filter(request=>request.path==="/v1/pairings").length,2);assert.deepEqual(h.surface.retryStates,[true,false]);assert.equal(h.port.terminated,0);h.advance(250);assert.equal(h.port.terminated,1);});
test("pagehide during retry DELETE prevents every later pairing and Worker start",async()=>{const{h,app}=await authorized(),deletion=deferred();h.replies.push(deletion.promise);const before=h.requests.length,flight=app.retry();await flush();assert.equal(h.requests.at(-1)!.path,"/v1/sessions/current");app.pageHide();deletion.resolve(reply(401));await flight;await flush();assert.equal(h.requests.length,before+1);assert.equal(h.requests.filter(request=>request.path==="/v1/pairings").length,1);assert.equal(h.port.sent.filter(value=>typeof value==="object"&&value!==null&&"type"in value&&value.type==="start").length,1);});
test("failed dispose post terminates Worker immediately",async()=>{const{h,app}=await authorized();h.replies.push(reply(204));h.port.failPost=true;app.dispose();assert.equal(h.port.terminated,1);});
test("client abort and early DELETE 401 precede late 204, post cleanup, then new pairing",async()=>{const h=new Harness(),session=deferred(),earlyDelete=deferred(),postDelete=deferred();h.replies.push(reply(201,{pairingId:PAIRING,pairingCode:"ABCDEFGH",expiresAt:EXPIRY}),reply(200,{bootstrapGrant:"AAAAAAAAAAAAAAAAAAAAAA",expiresAt:EXPIRY}),session.promise,earlyDelete.promise,postDelete.promise,reply(201,{pairingId:PAIRING,pairingCode:"ABCDEFGH",expiresAt:EXPIRY}),reply(200,{bootstrapGrant:"AAAAAAAAAAAAAAAAAAAAAA",expiresAt:EXPIRY}),reply(204));const app=new ViewerApp(h.adapters,WORKER),initial=app.start();await flush();await flush();const sessionRequest=h.requests.at(-1)!;assert.equal(sessionRequest.path,"/v1/sessions");assert.equal(sessionRequest.init.signal,undefined);assert.equal(sessionRequest.init.keepalive,true);const runSignal=h.requests[0]!.init.signal!,retry=app.retry();assert.equal(runSignal.aborted,true);assert.equal(h.requests.filter(request=>request.path==="/v1/sessions/current").length,1);earlyDelete.resolve(reply(401));await flush();session.resolve(reply(204));await flush();await flush();assert.equal(h.requests.filter(request=>request.path==="/v1/sessions/current").length,2);assert.equal(h.requests.filter(request=>request.path==="/v1/pairings").length,1);assert.equal(h.requests.at(-1)!.init.keepalive,true);postDelete.resolve(reply(204));await initial;await retry;assert.equal(h.requests.filter(request=>request.path==="/v1/pairings").length,2);assert.equal(h.port.sent.filter(value=>typeof value==="object"&&value!==null&&"type"in value&&value.type==="start").length,1);});
test("hidden stale refresh result cannot disconnect or replace the new visibility epoch",async()=>{const{h,app}=await authorized(),refresh=deferred();h.replies.push(refresh.promise);h.advance(30_000);await flush();const signal=h.requests.at(-1)!.init.signal!;h.visible=false;h.visibility();assert.equal(signal.aborted,true);h.visible=true;h.visibility();refresh.resolve(reply(500));await flush();assert.equal(app.state,"syncing");assert.equal(h.timers.some(timer=>timer.at===h.mono+30_000),true);});
test("metrics anchor six complete windows to fresh stable Live after a five-second first Live",()=>{const summary=new MetricsSummary();summary.update({openedAt:0,sourceFrames:0,outputs:0,decodeQueue:0,ownedFrames:0});const{result}=fullEpoch(summary,0,5_000);assert.equal(result.firstLiveMs,5_000);assert.equal(result.presentedFrames,1_800);assert.equal(result.intervalSamples,1_799);assert.equal(result.paintP95Ms,30);assert.equal(result.receivedToDecodedP95Ms,2);assert.equal(result.decodedToOutputP95Ms,3);assert.equal(result.outputToPaintP95Ms,4);assert.equal(result.timingSamples,1_800);assert.equal(result.metricsValid,1);assert.equal(result.metricsComplete,1);assert.equal(result.steadyActive,0);for(let window=0;window<6;window++)assert.deepEqual([result[`window${window}SourceFrames`],result[`window${window}PresentedFrames`]],[300,300]);assert.equal(JSON.stringify(result).includes("receivedAt"),false);});
test("normalized cross-global clocks preserve first Live, stages and six source windows",()=>{const workerOpened=absoluteMonotonicNow({timeOrigin:1_500,now:()=>100}),windowFirstPaint=absoluteMonotonicNow({timeOrigin:1_000,now:()=>700}),summary=new MetricsSummary();summary.update({openedAt:workerOpened,sourceFrames:0,outputs:0,decodeQueue:0,ownedFrames:0});const{result}=fullEpoch(summary,0,windowFirstPaint);assert.equal(result.firstLiveMs,100);assert.equal(result.receivedToDecodedP95Ms,2);assert.equal(result.decodedToOutputP95Ms,3);assert.equal(result.outputToPaintP95Ms,4);assert.equal(result.invalidSamples,0);assert.equal(result.metricsValid,1);assert.equal(result.metricsComplete,1);for(let window=0;window<6;window++)assert.deepEqual([result[`window${window}SourceFrames`],result[`window${window}PresentedFrames`]],[300,300]);});
test("pause invalidates a partial epoch; only a later fresh paint starts a new complete epoch",()=>{const summary=new MetricsSummary();summary.update({openedAt:0,sourceFrames:0});let source=1;metricFrame(summary,source,4_991,5_000,true);for(let i=1;i<=833;i++){const at=5_000+i*30;metricFrame(summary,++source,at-9,at);}let result=summary.state("paused");assert.equal(result.metricsValid,0);assert.equal(result.interruptedEpochs,1);assert.equal(result.presentedFrames,0);assert.equal(result.firstLiveMs,5_000);result=metricFrame(summary,++source,31_000,31_009,false);assert.equal(result.steadyActive,0);assert.equal(result.presentedFrames,0);const complete=fullEpoch(summary,source,40_000);result=complete.result;assert.equal(result.firstLiveMs,5_000);assert.equal(result.steadyEpoch,2);assert.equal(result.interruptedEpochs,1);assert.equal(result.metricsValid,1);assert.equal(result.metricsComplete,1);for(let window=0;window<6;window++)assert.deepEqual([result[`window${window}SourceFrames`],result[`window${window}PresentedFrames`]],[300,300]);});
test("active epoch overflow is explicit, invalidates evidence and remains bounded",()=>{const summary=new MetricsSummary();summary.update({openedAt:0,sourceFrames:0});let result=metricFrame(summary,1,0,9,true);for(let i=1;i<2_100;i++){const at=i*2;result=metricFrame(summary,i+1,at,at+9);}assert.equal(result.intervalSamples,2_048);assert.equal(result.timingSamples,2_048);assert.ok((result.overflowSamples??0)>0);assert.equal(result.metricsValid,0);assert.equal(result.metricsComplete,0);assert.ok(Object.keys(result).length<45);});
test("explicit pairing lifecycle reset accepts a new Worker clock and source baseline",()=>{const summary=new MetricsSummary();summary.update({openedAt:1_000,sourceFrames:0});const first=fullEpoch(summary,0,6_000).result;assert.equal(first.firstLiveMs,5_000);assert.equal(first.metricsComplete,1);const reset=summary.lifecycle();assert.equal(reset.firstLiveMs,0);assert.equal(reset.sourceFrames,0);assert.equal(reset.presentedFrames,0);assert.equal(reset.steadyEpoch,0);assert.equal(reset.interruptedEpochs,0);assert.equal(reset.metricsValid,0);summary.update({openedAt:100,sourceFrames:0});const second=fullEpoch(summary,0,1_100).result;assert.equal(second.firstLiveMs,1_000);assert.equal(second.invalidSamples,0);assert.equal(second.metricsValid,1);assert.equal(second.metricsComplete,1);assert.equal(second.steadyEpoch,1);for(let window=0;window<6;window++)assert.deepEqual([second[`window${window}SourceFrames`],second[`window${window}PresentedFrames`]],[300,300]);});
test("pipeline stage metrics remain bounded numeric DOM evidence and reset per lifecycle",()=>{const summary=new MetricsSummary();let result=summary.update({sourceFrames:0,outputs:0,decodeQueue:0,ownedFrames:0,resetCompletions:1,configChecks:1,configSettled:0,configCheckPending:true});assert.deepEqual([result.resetCompletions,result.configChecks,result.configSettled,result.configCheckPending,result.configSupported],[1,1,0,1,0]);result=summary.update({configChecks:1,configSettled:1,configCheckPending:false,configSupported:true});assert.deepEqual([result.configSettled,result.configCheckPending,result.configSupported],[1,0,1]);result=summary.lifecycle();assert.deepEqual([result.resetCompletions,result.configChecks,result.configSettled,result.configCheckPending,result.configSupported],[0,0,0,0,0]);assert.ok(Object.keys(result).length<50);});
test("false Canvas draw becomes unsupported and releases ownership",async()=>{const{h,app}=await authorized();h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});h.surface.drawResult=false;const frame=new Frame();h.port.emit(frameMessage(1n,true,frame));h.paint();assert.equal(frame.closes,1);assert.equal(app.state,"unsupported");assert.deepEqual(h.port.sent.filter(isFrameComplete),[{type:"frame-complete",generation:2,sequence:1n,presented:false}]);});

const probeMessage=(frame:unknown)=>({type:"capability-probe",generation:1,mediaProfile:"mjpeg",frame});
async function jpegAuthorized(){const h=new Harness();h.profile="mjpeg";return authorized(h);}
test("missing profile, target foundation and unavailable Canvas reject before pairing or Worker",async()=>{
 for(const profile of [undefined,"jpeg",null]){
  const h=new Harness();h.profile=profile;const app=new ViewerApp(h.adapters,WORKER);await app.start();
  assert.equal(app.state,"unsupported");assert.deepEqual(h.requests,[]);assert.deepEqual(h.port.sent,[]);
 }
 const h=new Harness();h.surface.ready=()=>false;const app=new ViewerApp(h.adapters,WORKER);await app.start();
 assert.equal(app.state,"unsupported");assert.deepEqual(h.requests,[]);
});
test("MJPEG probe draws through production surface, clears/closes, never paints or becomes Live",async()=>{
 const {h,app}=await jpegAuthorized(),probe=new Bitmap();h.visible=false;h.visibility();
 h.port.emit(probeMessage(probe));assert.deepEqual(h.surface.draws,[probe]);assert.equal(probe.closes,1);
 assert.equal(h.surface.clears,1);assert.equal(app.state,"paused");assert.deepEqual(h.surface.metrics,[]);
 assert.deepEqual(h.port.sent.at(-1),{type:"capability-result",generation:1,supported:true});
 assert.deepEqual(h.port.sent.filter(isFrameComplete),[]);
});
test("probe type/size/draw failure closes once and unsupported sends exactly one false result",async()=>{
 for(const outcome of ["size","type","false","throw"]){
  const {h,app}=await jpegAuthorized(),probe=outcome==="type"?new Frame():new Bitmap(outcome==="size"?1:2,1);
  if(outcome==="false")h.surface.drawResult=false;
  if(outcome==="throw")h.surface.draw=()=>{throw new Error("Private draw error");};
  h.port.emit(probeMessage(probe));assert.equal(probe.closes,1);assert.equal(app.state,"unsupported");
  assert.equal(h.surface.clears,1);assert.deepEqual(h.port.sent.filter((v:any)=>v.type==="capability-result"),[{type:"capability-result",generation:1,supported:false}]);
  assert.deepEqual(h.surface.metrics,[]);
 }
});
test("duplicate/malformed probes and stale Worker/disposed messages close without Live or resurrection",async()=>{
 const {h,app}=await jpegAuthorized();h.port.emit(probeMessage(new Bitmap()));
 const duplicate=new Bitmap();h.port.emit(probeMessage(duplicate));assert.equal(app.state,"error");assert.equal(duplicate.closes,1);
 const next=await jpegAuthorized(),bad=new Bitmap();next.h.port.emit({...probeMessage(bad),extra:true});
 assert.equal(next.app.state,"error");assert.equal(bad.closes,1);
 const stale=await jpegAuthorized(),old=new Port(),late=new Bitmap();stale.app.workerMessage(probeMessage(late),old);
 assert.equal(late.closes,1);assert.equal(stale.app.state,"connecting");assert.deepEqual(old.sent,[]);
 stale.app.dispose();const after=new Bitmap();stale.h.port.emit(probeMessage(after));assert.equal(after.closes,1);
 assert.equal(stale.h.port.sent.some((v:any)=>v.type==="capability-result"),false);
});
test("MJPEG draw/close precedes one completion; stale at 2s and same-Session fresh paint restores Live",async()=>{
 const {h,app}=await jpegAuthorized();h.port.emit(probeMessage(new Bitmap()));
 h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});
 const frame=new Bitmap(1280,720),order:string[]=[];
 h.surface.draw=value=>{order.push("draw");assert.equal(value,frame);return true;};
 frame.close=()=>{order.push("close");frame.closes++;};
 const post=h.port.postMessage.bind(h.port);h.port.postMessage=value=>{if(isFrameComplete(value))order.push("complete");post(value);};
 h.port.emit(frameMessage(2n,true,frame));h.paint();assert.deepEqual(order,["draw","close","complete"]);
 assert.equal(app.state,"live");h.advance(1999);assert.equal(app.state,"live");h.advance(1);assert.equal(app.state,"interrupted");
 h.surface.draw=()=>true;const recovered=new Bitmap();h.port.emit(frameMessage(3n,true,recovered));h.paint();
 assert.equal(app.state,"live");assert.equal(recovered.closes,1);
 h.port.emit({type:"reset",generation:3,discardThroughSequence:3n,state:"syncing"});assert.equal(app.state,"syncing");
 h.advance(2000);assert.equal(app.state,"syncing");
});
test("hide fences queued transfers even across quick return; only reset generation may restore Live",async()=>{
 const {h,app}=await jpegAuthorized();h.port.emit(probeMessage(new Bitmap()));
 h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});
 const pending=new Bitmap();h.port.emit(frameMessage(2n,true,pending));h.visible=false;h.visibility();
 assert.equal(pending.closes,1);assert.equal(app.state,"paused");h.visible=true;h.visibility();
 const old=new Bitmap();h.port.emit(frameMessage(3n,true,old));h.paint();assert.equal(old.closes,1);assert.equal(app.state,"syncing");
 h.port.emit({type:"reset",generation:3,discardThroughSequence:0n,state:"syncing"});
 const fresh=new Bitmap();h.port.emit({...frameMessage(4n,true,fresh),generation:3});h.paint();assert.equal(app.state,"live");
 assert.deepEqual(h.port.sent.filter(isFrameComplete).map(v=>v.presented),[false,false,true]);
});
test("JPEG render error, replacement, hidden input and terminal close all Main bitmap ownership",async()=>{
 const {h,app}=await jpegAuthorized();h.port.emit(probeMessage(new Bitmap()));
 h.port.emit({type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"});
 const first=new Bitmap(),second=new Bitmap();h.port.emit(frameMessage(2n,true,first));h.port.emit(frameMessage(3n,true,second));
 assert.equal(first.closes,1);h.surface.draw=()=>{throw new Error("Private pixels");};h.paint();
 assert.equal(second.closes,1);assert.equal(app.state,"error");
 const terminal=new Bitmap();h.port.emit(frameMessage(4n,true,terminal));assert.equal(terminal.closes,1);
 assert.equal(h.port.sent.filter(isFrameComplete).every(v=>!v.presented),true);
});

test("failed target foundation and throwing Canvas initialization are unsupported before any pairing",async()=>{
 for(const failure of ["foundation","context"]){
  const h=new Harness();h.profile="mjpeg";
  if(failure==="foundation")h.adapters.foundation=()=>false;
  else h.surface.ready=()=>{throw new Error("Context unavailable");};
  const app=new ViewerApp(h.adapters,WORKER);await app.start();assert.equal(app.state,"unsupported");
  assert.deepEqual(h.requests,[]);assert.deepEqual(h.port.sent,[]);
 }
});

test("preflight cannot accept source reset, source metrics or a source image before capability success",async()=>{
 const image=new Bitmap();
 for(const message of [{type:"reset",generation:2,discardThroughSequence:0n,state:"syncing"},
  {type:"metrics",sample:{sourceFrames:1}},frameMessage(1n,true,image)]){
  const {h,app}=await jpegAuthorized();h.port.emit(message);assert.equal(app.state,"error");
  assert.deepEqual(h.surface.metrics,[]);assert.deepEqual(h.surface.draws,[]);
 }
 assert.equal(image.closes,1);
});

test("queued pre-hide JPEG cannot restore Main Live after old and current reset completions",async()=>{
 const h=new Harness();h.profile="mjpeg";
 const controls:Record<string,unknown>[]=[],resetCompletions:unknown[]=[],images:Bitmap[]=[];
 const timers=new Set<()=>void>();let receive=(_value:unknown)=>{},open=()=>{};
 const socket:SocketLike={binaryType:"",send:value=>{controls.push(JSON.parse(value) as Record<string,unknown>);},
  close:()=>{},onOpen:fn=>{open=fn;},onMessage:fn=>{receive=fn;},onClose:()=>{},onError:()=>{}};
 const controller=new WorkerController({foundation:()=>true,bitmap:async()=>{const image=new Bitmap();images.push(image);return image;},
  connect:()=>socket,support:async()=>{throw new Error("Unexpected AVC support check");},
  decoder:()=>{throw new Error("Unexpected AVC decoder");},chunk:()=>{throw new Error("Unexpected AVC chunk");},
  post:value=>h.port.emit(value),now:()=>h.mono,interval:fn=>{timers.add(fn);return fn;},
  clearInterval:token=>{timers.delete(token as()=>void);},terminate:()=>{}});
 const post=h.port.postMessage.bind(h.port);
 h.port.postMessage=value=>{
  post(value);
  if(typeof value==="object"&&value!==null&&"type"in value&&value.type==="reset-complete")resetCompletions.push(value);
  else controller.message(value);
 };
 const {app}=await authorized(h);await flush();open();
 const probe=images[0]!;assert.equal(probe.closes,1);assert.deepEqual(h.surface.draws,[probe]);
 receive(jpegWire(1,1n,1n,jpegSession()).buffer);await flush();
 receive(jpegWire(3,2n,1n).buffer);await flush();assert.equal(images.length,1);
 h.visible=false;h.visibility();assert.equal(app.state,"paused");h.visible=true;h.visibility();
 assert.deepEqual(resetCompletions,[{type:"reset-complete",generation:2,discardThroughSequence:0n},
  {type:"reset-complete",generation:3,discardThroughSequence:0n}]);
 for(const completion of resetCompletions)controller.message(completion);
 await flush();h.paint();
 assert.equal(images.length,1);assert.deepEqual(h.surface.draws,[probe]);assert.equal(app.state,"syncing");
 assert.equal(h.surface.states.some(([state])=>state==="live"),false);assert.deepEqual(h.port.sent.filter(isFrameComplete),[]);
 assert.deepEqual(controls.filter(value=>value.type==="ack"),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"}]);
 receive(jpegWire(3,3n,1n).buffer);await flush();const fresh=images[1]!;
 assert.equal(fresh.closes,0);assert.equal(app.state,"syncing");h.paint();
 assert.deepEqual(h.surface.draws,[probe,fresh]);assert.equal(fresh.closes,1);assert.equal(app.state,"live");
 assert.deepEqual(h.port.sent.filter(isFrameComplete),[{type:"frame-complete",generation:3,sequence:3n,presented:true}]);
 assert.deepEqual(controls.filter(value=>value.type==="ack"),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"},
  {v:1,type:"ack",sequence:"3",paintedSequence:"3"}]);
 h.replies.push(reply(204));app.dispose();assert.equal(timers.size,0);
});
