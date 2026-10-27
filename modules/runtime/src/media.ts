import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { END_REASON,MEDIA_KIND,MAX_CONFIG_BYTES,MAX_FRAME_BYTES,encodeMediaHeader,validateSize,type SnapshotReason } from "../../contracts/src/index.js";
import type { CaptureEvent } from "../../capture/src/session.js"; import type { Clock } from "./clock.js"; import type { TerminalCoordinator,TerminalContext } from "./state.js"; import type { WsAdapter } from "./ws.js";
const TOTAL=8_388_608,RESERVE=65_536,CONTROL_BYTES=524_288,ACCOUNTING=diagnosticsChannel("fsq.runtime.media.accounting.v1"); type FaultCode="malformed-media"|"runtime-overload"|"backpressure-timeout"|"slow-consumer";
interface Queued { readonly parts:readonly Uint8Array[]; readonly bytes:number; readonly control:boolean; readonly frameSequence?:bigint; readonly done?:(error?:Error)=>void; readonly required?:boolean }
interface Outstanding { readonly bytes:number; readonly captureSequence:bigint; readonly payload?:Uint8Array }
interface Pending { readonly bytes:number; readonly control:boolean; readonly frameSequence?:bigint; readonly done?:(error?:Error)=>void; readonly required:boolean }
export interface MediaStats { readonly mediaApplicationQueueBytes:number; readonly controlApplicationQueueBytes:number; readonly pendingSendBytes:number; readonly transportPressure:number; readonly outstandingFrames:number; readonly outstandingBytes:number; readonly highestAck:bigint; readonly highestSentFrame:bigint; readonly discardThrough:bigint }
const message=(minor:0|1,kind:number,sequence:bigint,epoch:bigint,ptsUs:bigint,payload:Uint8Array,flags=0):readonly Uint8Array[]=>Object.freeze([encodeMediaHeader({minor,kind:kind as 1|2|3|4|5,flags,payloadBytes:payload.byteLength,sequence,epoch,ptsUs}),payload]);
const sessionPayload=(e:Extract<CaptureEvent,{kind:"SessionStarted"}>):Uint8Array=>{const b=new Uint8Array(24),v=new DataView(b.buffer);v.setUint32(0,e.codec==="mjpeg"?0x6d6a7067:0x68323634);v.setUint32(4,e.codedSize.width);v.setUint32(8,e.codedSize.height);v.setUint32(12,e.displaySize.width);v.setUint32(16,e.displaySize.height);v.setUint32(20,1_000_000);return b;};
export class MediaChannel {
 #queue:Queued[]=[];#next=1n;#pendingBytes=0;#pending=new Set<Pending>();#requiredPending=0;#mediaApp=0;#controlApp=0;#controlCount=0;#controlOwned=0;#outstanding=new Map<bigint,Outstanding>();#outstandingBytes=0;#highestAck=0n;#lastAckCapture=0n;#highestSent=0n;#discard=0n;#creditFrames=0;#creditBytes=0;#fenced=false;#ended=false;#recovery=false;#replay=false;#epoch=0;#recoveryTimer:object|undefined;#sentSessionEpoch=0;#sentConfigEpoch=0;#recoveryHook:()=>void=()=>{};
 #minor:0|1=0;#staging:Extract<CaptureEvent,{kind:"Frame"}>|undefined;#proofs=new Map<bigint,{epoch:number;sent:boolean}>();#painted=0n;#visible=false;#visibleFloor=0n;#drops=0;
 #ackHook:(epoch:number|undefined)=>boolean=()=>true;
 #outputMinor:0|1;
 get minor():0|1{return this.#minor;}
 fence():void{this.#fenced=true;this.#dropMedia(this.#highestSent);}
 onAck(hook:(epoch:number|undefined)=>boolean):void{this.#ackHook=hook;}
 visibility(visible:boolean):void{if(visible!==this.#visible){this.#staging=undefined;this.#visibleFloor=this.#next-1n;this.#visible=visible;this.#notify();}}
 stagingStats():Readonly<{bytes:number;drops:number;proofs:number;ownedBytes:number}>{return Object.freeze({bytes:this.#staging?40+this.#staging.bytes.byteLength:0,drops:this.#drops,proofs:this.#proofs.size,ownedBytes:this.#owned()});}
 stageFrame(event:Extract<CaptureEvent,{kind:"Frame"}>):void{
  if(this.#fenced||!this.#visible)return;
  const old=this.#staging?40+this.#staging.bytes.byteLength:0,size=40+event.bytes.byteLength;
  if(this.#owned()-old+size>TOTAL-RESERVE){this.#drops++;return;}
  if(this.#staging)this.#drops++;
  this.#staging=event;this.#notify();this.#admitStaging();
 }
 #admitStaging():void{
  const event=this.#staging;
  for(const pending of this.#pending)if(!pending.control)return;
  if(!event||this.#fenced||this.#requiredPending||this.#outstanding.size||this.#creditFrames<1||40+event.bytes.byteLength>this.#creditBytes)return;
  this.#staging=undefined;this.sendFrame(event);
 }
 ackPaint(sequence:bigint,painted:bigint):boolean{
  if(this.#fenced)return true;
  if(painted<this.#painted||painted>sequence)return false;
  const release=this.#proofs.get(sequence),paint=this.#proofs.get(painted);
  if(sequence!==0n&&sequence!==this.#highestAck&&!release?.sent)return false;
  if(painted!==this.#painted&&(!paint?.sent||painted<=this.#highestAck))return false;
  const eligible=painted>this.#painted&&this.#visible&&painted>this.#visibleFloor&&paint?.epoch===this.#epoch;
  if(!this.#ackHook(eligible?paint!.epoch:undefined))return true;
  this.#painted=painted;
  if(sequence>this.#highestAck){this.#highestAck=sequence;for(const[seq,e]of this.#outstanding)if(seq<=sequence){this.#outstanding.delete(seq);this.#outstandingBytes-=e.bytes;}for(const seq of this.#proofs.keys())if(seq<=sequence)this.#proofs.delete(seq);}
  this.#notify();this.#flush();return true;
 }
 constructor(readonly ws:WsAdapter,readonly clock:Clock,readonly fault:(code:FaultCode)=>void,minor:0|1=0){this.#outputMinor=minor;}
 onRecovery(hook:()=>void):void{this.#recoveryHook=hook;}
 stats():MediaStats{return Object.freeze({mediaApplicationQueueBytes:this.#mediaApp,controlApplicationQueueBytes:this.#controlApp,pendingSendBytes:this.#pendingBytes,transportPressure:Math.max(this.#pendingBytes,this.ws.bufferedAmount),outstandingFrames:this.#outstanding.size,outstandingBytes:this.#outstandingBytes,highestAck:this.#highestAck,highestSentFrame:this.#highestSent,discardThrough:this.#discard});}
 setCredit(frames:number,bytes:number):void{this.#creditFrames=frames;this.#creditBytes=bytes;this.#notify();this.#flush();}
 sendSession(e:Extract<CaptureEvent,{kind:"SessionStarted"}>,replay=false):boolean{if(this.#fenced||(!replay&&this.#sentSessionEpoch===e.epoch))return false;this.#outputMinor=this.#minor=e.codec==="mjpeg"?1:0;const sent=this.#control(MEDIA_KIND.session,BigInt(e.epoch),sessionPayload(e),undefined,true);if(sent){this.#sentSessionEpoch=e.epoch;this.#epoch=e.epoch;}return sent;}
 sendConfig(e:Extract<CaptureEvent,{kind:"CodecConfig"}>,replay=false):boolean{if(e.bytes.byteLength<1||e.bytes.byteLength>MAX_CONFIG_BYTES||this.#fenced||(!replay&&this.#sentConfigEpoch===e.epoch))return false;const sent=this.#control(MEDIA_KIND.config,BigInt(e.epoch),e.bytes,undefined,true);if(sent)this.#sentConfigEpoch=e.epoch;return sent;}
 sendFrame(e:Extract<CaptureEvent,{kind:"Frame"}>,done?:Queued["done"]):boolean{
  const size=40+e.bytes.byteLength,hadFrames=this.#highestSent>0n||this.#outstanding.size>0;
  if(this.#fenced||e.bytes.byteLength<1||e.bytes.byteLength>MAX_FRAME_BYTES)return false;
  if(this.#minor===1)for(const pending of this.#pending)if(!pending.control)return false;
  if(this.#minor===1&&this.#proofs.size>=1024){this.#fenced=true;this.fault("runtime-overload");return false;}
  if(this.#outstanding.size>=(this.#minor===1?1:4)||this.#outstandingBytes+size>TOTAL||this.#outstanding.size>=this.#creditFrames||this.#outstandingBytes+size>this.#creditBytes||this.#owned()+size>TOTAL-RESERVE){if(hadFrames&&this.#minor===0)this.gap(2,undefined,"slow-consumer");return false;}
  const sequence=this.#next++,parts=message(this.#minor,MEDIA_KIND.frame,sequence,BigInt(e.epoch),e.ptsUs,e.bytes,e.key?1:0);
  this.#queue.push({parts,bytes:size,control:false,frameSequence:sequence,...(done?{done}:{})});this.#mediaApp+=size;
  this.#outstanding.set(sequence,{bytes:size,captureSequence:e.sequence,...(this.#minor===1?{payload:e.bytes}:{})});this.#outstandingBytes+=size;
  if(this.#minor===1)this.#proofs.set(sequence,{epoch:e.epoch,sent:false});
  this.#notify();this.#flush();return true;
 }
 ack(sequence:bigint):"ok"|"stale"|"future"{const floor=this.#highestAck>this.#discard?this.#highestAck:this.#discard;if(sequence<=floor)return"stale";if(sequence>this.#highestSent)return"future";this.#highestAck=sequence;for(const[key,value]of this.#outstanding)if(key<=sequence){this.#outstanding.delete(key);this.#outstandingBytes-=value.bytes;if(value.captureSequence>this.#lastAckCapture)this.#lastAckCapture=value.captureSequence;}this.#notify();this.#flush();return"ok";}
 gap(reason:1|2|3,watermark:bigint|undefined,timeout:FaultCode):void{if(this.#fenced||this.#recovery)return;this.#staging=undefined;if(reason===3)this.#visibleFloor=this.#next-1n;this.#recovery=true;this.#replay=reason!==3;this.#recoveryHook();let mapped=this.#discard;if(watermark!==undefined){if(watermark>=this.#lastAckCapture&&this.#highestAck>mapped)mapped=this.#highestAck;for(const[seq,e]of this.#outstanding)if(e.captureSequence<=watermark&&seq<=this.#highestSent&&seq>mapped)mapped=seq;}else if(this.#highestSent>mapped)mapped=this.#highestSent;this.#discard=mapped;this.#dropMedia(mapped);const payload=new Uint8Array(12),v=new DataView(payload.buffer);v.setUint32(0,reason);v.setBigUint64(4,mapped);if(!this.#control(MEDIA_KIND.gap,BigInt(this.#epoch),payload,undefined,true))return;if(this.#minor===0&&!this.#recoveryTimer)this.#recoveryTimer=this.clock.set(5_000,()=>this.fault(timeout));}
 needsReplay():boolean{return this.#replay;} isRecovering():boolean{return this.#recovery;}
 recovered():void{if(this.#recoveryTimer)this.clock.clear(this.#recoveryTimer);this.#recoveryTimer=undefined;this.#recovery=false;this.#replay=false;}
 async end(reason:number,epoch:number):Promise<void>{if(this.#ended)return;this.#ended=true;this.#fenced=true;if(this.#recoveryTimer)this.clock.clear(this.#recoveryTimer);this.#dropMedia(this.#highestSent);const payload=new Uint8Array(4);new DataView(payload.buffer).setUint32(0,reason);await new Promise<void>((resolve)=>{let settled=false;const finish=(error?:Error)=>{if(settled)return;settled=true;this.clock.clear(timer);if(error){this.ws.close(1011);this.#forceSettle(error);this.ws.terminate();}else this.ws.close(1000);resolve();},timer=this.clock.set(1_000,()=>finish(new Error("timeout")));if(!this.#control(MEDIA_KIND.end,BigInt(epoch),payload,finish))finish(new Error("capacity"));});}
 close():void{this.#fenced=true;this.#staging=undefined;this.#proofs.clear();if(this.#recoveryTimer)this.clock.clear(this.#recoveryTimer);this.#queue=[];this.#mediaApp=this.#controlApp=0;this.#outstanding.clear();this.#outstandingBytes=0;this.#notify();this.#forceSettle(new Error("closed"));this.#controlOwned=this.#controlCount=this.#requiredPending=0;this.#notify();}
 #dropMedia(mapped:bigint):void{this.#staging=undefined;this.#queue=this.#queue.filter((e)=>{if(e.control)return true;this.#mediaApp-=e.bytes;if(e.frameSequence!==undefined){const owned=this.#outstanding.get(e.frameSequence);if(owned){this.#outstanding.delete(e.frameSequence);this.#outstandingBytes-=owned.bytes;}}return false;});for(const[seq,e]of this.#outstanding)if(seq<=mapped){this.#outstanding.delete(seq);this.#outstandingBytes-=e.bytes;}this.#notify();}
 #control(kind:number,epoch:bigint,payload:Uint8Array,done?:Queued["done"],required=false):boolean{const size=40+payload.byteLength,isEnd=kind===MEDIA_KIND.end,limit=isEnd?64:63,bytesLimit=isEnd?CONTROL_BYTES:CONTROL_BYTES-44;if((this.#fenced&&!isEnd)||this.#controlCount>=limit||this.#controlOwned+size>bytesLimit||this.#owned()+size>TOTAL){if(required)this.#fenced=true;if(!isEnd)this.fault("runtime-overload");return false;}const parts=message(this.#outputMinor,kind,this.#next++,epoch,-1n,payload);this.#queue.push({parts,bytes:size,control:true,required,...(done?{done}:{})});this.#controlApp+=size;this.#controlOwned+=size;this.#controlCount++;this.#notify();this.#flush();return true;}
 #owned():number{
  let logical=0;
  // After callback, ACK still retains the JPEG but no longer overlaps pending send.
  // Unrelated buffered transport bytes must remain additive to that logical owner.
  if(this.#minor===1)for(const[seq,e]of this.#outstanding){let represented=false;for(const q of this.#queue)if(q.frameSequence===seq)represented=true;for(const p of this.#pending)if(p.frameSequence===seq)represented=true;if(!represented)logical+=e.bytes;}
  return (this.#staging?40+this.#staging.bytes.byteLength:0)+this.#mediaApp+this.#controlApp+logical+Math.max(this.#pendingBytes,this.ws.bufferedAmount);
 }
 #flush():void{while(this.#queue.length&&this.#requiredPending===0){const e=this.#queue[0]!;if(!e.control&&(this.#outstanding.size>this.#creditFrames||this.#outstandingBytes>this.#creditBytes))return;this.#queue.shift();if(e.control)this.#controlApp-=e.bytes;else{this.#mediaApp-=e.bytes;this.#highestSent=e.frameSequence!;const proof=this.#proofs.get(e.frameSequence!);if(proof)proof.sent=true;}const token:Pending={bytes:e.bytes,control:e.control,required:e.required===true,...(e.frameSequence===undefined?{}:{frameSequence:e.frameSequence}),...(e.done?{done:e.done}:{})};this.#pending.add(token);this.#pendingBytes+=e.bytes;if(token.required)this.#requiredPending++;this.#notify();this.ws.send(e.parts,(error)=>this.#settle(token,error));}this.#admitStaging();}
 #settle(token:Pending,error?:Error):void{if(!this.#pending.delete(token))return;const active=!this.#fenced;this.#pendingBytes-=token.bytes;if(token.required)this.#requiredPending--;if(token.control){this.#controlOwned-=token.bytes;this.#controlCount--;}this.#notify();if(error&&token.required)this.#requiredFailure();if(error&&active)this.fence();token.done?.(error);if(error&&!token.done&&active)this.fault("runtime-overload");this.#flush();}
 #requiredFailure():void{this.#fenced=true;this.#staging=undefined;for(const e of this.#queue){if(e.control){this.#controlApp-=e.bytes;this.#controlOwned-=e.bytes;this.#controlCount--;}else this.#mediaApp-=e.bytes;}this.#queue=[];this.#outstanding.clear();this.#outstandingBytes=0;this.#notify();}
 #forceSettle(error:Error):void{for(const token of [...this.#pending])this.#settle(token,error);}
 #notify():void{if(ACCOUNTING.hasSubscribers)ACCOUNTING.publish(this.stats());}
}
export interface MediaRuntimeHooks{readonly phase:(phase:"syncing"|"streaming",event:Extract<CaptureEvent,{kind:"SessionStarted"}>)=>void;readonly terminal:(reason:SnapshotReason)=>void}
export class MediaRuntime{
 #session:Extract<CaptureEvent,{kind:"SessionStarted"}>|undefined;#config:Extract<CaptureEvent,{kind:"CodecConfig"}>|undefined;#ready=false;#epoch=0;
 #sequence=0n;#pts=-1n;#awaitSession=false;
 #bad():void{this.channel.fence();this.channel.fault("malformed-media");}
 constructor(readonly channel:MediaChannel,readonly hooks:MediaRuntimeHooks,readonly profile:"h264-annexb"|"mjpeg"="h264-annexb"){channel.onRecovery(()=>{if(this.#session){this.#ready=false;this.hooks.phase("syncing",this.#session);}});}
 registerTerminal(c:TerminalCoordinator):void{c.register(30,"media",(context)=>this.terminal(context));}
 async terminal(c:TerminalContext):Promise<void>{const reason=c.reason==="explicit-stop"?END_REASON.explicitStop:c.reason==="lease-expired"?END_REASON.leaseExpired:c.reason==="device-disconnected"?END_REASON.deviceDisconnected:END_REASON.failed;await this.channel.end(reason,this.#epoch);}
 event(e:CaptureEvent):void{
  const jpeg=this.profile==="mjpeg";
  if(e.kind==="SessionStarted"){
   if(!Number.isSafeInteger(e.epoch)||e.epoch<=this.#epoch||e.codec!==this.profile||e.timebase!==1_000_000||e.timestampOrigin!==(jpeg?"host-arrival":"source")||jpeg&&this.#session&&!this.#awaitSession)return this.#bad();
   try{validateSize(e.codedSize);validateSize(e.displaySize);}catch{return this.#bad();}
   const {width:w,height:h}=e.codedSize,{width:dw,height:dh}=e.displaySize;
   if(jpeg&&(w>4096||h>4096||w>Math.floor(8_388_608/h)||!(dw===w&&dh===h||dw===h&&dh===w)))return this.#bad();
   this.#session=e;this.#config=undefined;this.#ready=false;this.#epoch=e.epoch;this.#pts=-1n;this.#awaitSession=false;
   const sent=this.channel.sendSession(e);if(sent||jpeg)this.hooks.phase("syncing",e);return;
  }
  if(e.kind==="CodecConfig"){
   if(jpeg||!this.#session||e.epoch!==this.#epoch||this.#config||e.bytes.byteLength<1||e.bytes.byteLength>MAX_CONFIG_BYTES)return this.#bad();
   if(this.channel.sendConfig(e))this.#config=e;return;
  }
  if(e.kind==="Frame"){
   if(!this.#session||this.#awaitSession||e.epoch!==this.#epoch||e.bytes.byteLength<1||e.bytes.byteLength>MAX_FRAME_BYTES||typeof e.sequence!=="bigint"||e.sequence<=this.#sequence||typeof e.ptsUs!=="bigint"||e.ptsUs<0n||e.ptsUs<this.#pts||e.ptsUs>(1n<<63n)-1n||jpeg&&e.key!==true)return this.#bad();
   this.#sequence=e.sequence;this.#pts=e.ptsUs;
   if(jpeg){this.channel.recovered();this.channel.stageFrame(e);return;}
   if(!this.#config||(!this.#ready&&!e.key)||this.channel.isRecovering()&&!e.key)return;
   if(e.key&&this.channel.needsReplay()&&(!this.channel.sendSession(this.#session,true)||!this.channel.sendConfig(this.#config,true)))return;
   const session=this.#session;
   this.channel.sendFrame(e,e.key?(error)=>{if(error)return this.channel.fault("runtime-overload");if(e.epoch!==this.#epoch)return;this.#ready=true;this.channel.recovered();this.hooks.phase("streaming",session);}:undefined);return;
  }
  if(e.kind==="Discontinuity"){
   if(jpeg||e.epoch!==this.#epoch)return this.#bad();
   if(!this.#session||!this.#config)return this.channel.fault("runtime-overload");
   return this.channel.gap(1,e.discardThroughCaptureSequence,"backpressure-timeout");
  }
  if(e.kind==="SessionEnded"&&e.cause==="reconfigured"){
   if(e.epoch!==this.#epoch||this.#awaitSession)return this.#bad();
   this.#awaitSession=true;return this.channel.gap(3,undefined,"backpressure-timeout");
  }
  if(e.kind==="CaptureEnded")return this.hooks.terminal("explicit-stop");
  if(e.kind==="CaptureFailed")return this.hooks.terminal(e.error.code);
 }
}
