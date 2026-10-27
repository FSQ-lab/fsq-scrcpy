import { MAX_PAYLOAD_BYTES, validateStreamId } from "../../contracts/src/index.js";
import { absoluteMonotonicNow,MediaProtocol, ProtocolError, type MediaProfile, type ProtocolEvent, type Session } from "./protocol.js";
import { boundedImage, JPEG_PROBE } from "./jpeg.js";
export type ViewerState="connecting"|"syncing"|"paused"|"disconnected"|"stopped"|"unsupported"|"error";
export interface FrameLike{readonly timestamp:number;close():void} export interface SocketLike{binaryType:string;send(data:string):void;close(code?:number):void;onOpen(fn:()=>void):void;onMessage(fn:(data:unknown)=>void):void;onClose(fn:()=>void):void;onError(fn:()=>void):void}
export interface BitmapLike { readonly width:number; readonly height:number; close():void }
export interface DecoderLike{readonly decodeQueueSize:number;configure(config:DecoderConfigLike):void;decode(chunk:unknown):void;reset():void;close():void}
export interface DecoderConfigLike{readonly codec:string;readonly codedWidth:number;readonly codedHeight:number;readonly optimizeForLatency:true;readonly hardwareAcceleration:"prefer-hardware"}
export interface WorkerAdapters{foundation(profile:MediaProfile):boolean;bitmap(bytes:Uint8Array):Promise<BitmapLike>;connect(url:string,protocol:string):SocketLike;support(config:DecoderConfigLike):Promise<{supported:boolean;config:Pick<DecoderConfigLike,"codec"|"codedWidth"|"codedHeight">}>;decoder(output:(frame:FrameLike)=>void,error:()=>void):DecoderLike;chunk(init:{type:"key"|"delta";timestamp:number;data:Uint8Array}):unknown;post(message:unknown,transfer?:readonly unknown[]):void;now():number;interval(fn:()=>void,ms:number):unknown;clearInterval(token:unknown):void;terminate():void}
interface Meta{generation:number;sequence:bigint;epoch:bigint;ptsUs:number;key:boolean;receivedAt:number;decodedAt:number} interface Owned{generation:number;released:boolean}
const keys=(v:object,want:readonly string[]):boolean=>{if(Object.getPrototypeOf(v)!==Object.prototype&&Object.getPrototypeOf(v)!==null)return false;const got=Reflect.ownKeys(v);return got.length===want.length&&want.every(k=>got.includes(k)&&Object.getOwnPropertyDescriptor(v,k)?.enumerable===true);};
const safeInt=(v:unknown):v is number=>typeof v==="number"&&Number.isSafeInteger(v)&&v>0;
export class WorkerController{
 #socket:SocketLike|undefined;#handled=new WeakSet<SocketLike>();#decoder:DecoderLike|undefined;#protocol=new MediaProtocol();#chain=Promise.resolve();#gate:Promise<void>|undefined;#unfence:(()=>void)|undefined;#resets=new Map<number,bigint>();#generation=0;#visible=false;#started=false;#disposed=false;#opened=false;#ended=false;#fenced=false;#sawSession=false;#reconnects=0;#timer:unknown;#lastLease="";#streamId="";#origin="";#session:Session|undefined;#metas:Meta[]=[];#owned=new Map<bigint,Owned>();#pending:Meta|undefined;#fresh=true;#releasedFloor=0n;#sentAckFloor=0n;#releasedSinceAck=0;#sourceFrames=0;#outputs=0;#openedAt:number|undefined;#resetCompletions=0;#configChecks=0;#configSettled=0;#pendingConfigChecks=0;#configSupported=false;
 #profile:MediaProfile="h264-annexb";#probePending=false;#probeDeadline=0;#probeTimer:unknown;#painted=0n;
 // Queued Session resets may change decoder generation without changing receipt eligibility.
 #visibilityEpoch=0;
 #jpegJob:Meta|undefined;#jpegNext:{event:Extract<ProtocolEvent,{type:"frame"}>;meta:Meta;session:Session}|undefined;
 constructor(readonly a:WorkerAdapters){}
 message(value:unknown):void{if(this.#disposed)return;if(this.#ended){if(typeof value==="object"&&value!==null&&!Array.isArray(value)&&keys(value,["type"])&&(value as Record<string,unknown>).type==="dispose")this.#dispose();return;}if(typeof value!=="object"||value===null||Array.isArray(value))return this.#fault("malformed-control");const v=value as Record<string,unknown>,type=v.type;
  if(type==="start"&&keys(v,["type","origin","streamId","mediaProfile"])&&typeof v.origin==="string"&&typeof v.streamId==="string"&&(v.mediaProfile==="h264-annexb"||v.mediaProfile==="mjpeg"))return this.#start(v.origin,v.streamId,v.mediaProfile);
  if(type==="capability-result"&&keys(v,["type","generation","supported"])&&v.generation===1&&typeof v.supported==="boolean"&&this.#probePending){
   this.#probePending=false;
   if(!v.supported||this.a.now()>=this.#probeDeadline)return this.#unsupported();
   this.a.clearInterval(this.#probeTimer);this.#probeTimer=undefined;this.#connect();return;
  }
  if(type==="visibility"&&keys(v,["type","visible"])&&typeof v.visible==="boolean"&&this.#started)return this.#visibility(v.visible);
  if(type==="frame-complete"&&keys(v,["type","generation","sequence","presented"])&&safeInt(v.generation)&&typeof v.sequence==="bigint"&&v.sequence>0n&&typeof v.presented==="boolean"&&this.#started)return this.#complete(v.generation,v.sequence,v.presented);
  if(type==="reset-complete"&&keys(v,["type","generation","discardThroughSequence"])&&safeInt(v.generation)&&typeof v.discardThroughSequence==="bigint"&&v.discardThroughSequence>=0n&&this.#started)return this.#resetComplete(v.generation,v.discardThroughSequence);
  if(type==="dispose"&&keys(v,["type"])&&this.#started)return this.#dispose();this.#fault("malformed-control");}
 #start(origin:string,streamId:string,profile:MediaProfile):void{
  if(this.#started)return this.#fault("malformed-control");
  const startedAt=this.a.now();
  try{
   validateStreamId(streamId);
   const match=/^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/.exec(origin);
   if(!match||Number(match[1])>65535)throw 0;
   this.#origin=origin;
  }catch{return this.#fault("malformed-control");}
  this.#streamId=streamId;this.#started=true;this.#generation=1;this.#profile=profile;
  this.#probeDeadline=startedAt+5000;
  this.a.post({type:"state",state:"connecting"});
  if(!this.a.foundation(profile))return this.#unsupported();
  if(profile==="h264-annexb"){this.#connect();return;}
  if(this.a.now()>=this.#probeDeadline)return this.#unsupported();
  this.#probeTimer=this.a.interval(()=>this.#unsupported(),Math.max(1,this.#probeDeadline-this.a.now()));
  void this.#probe();
 }
 async #probe():Promise<void>{
  let frame:BitmapLike;
  try{frame=await this.a.bitmap(JPEG_PROBE);}catch{if(!this.#ended&&!this.#disposed)this.#unsupported();return;}
  if(this.#ended||this.#disposed||this.a.now()>=this.#probeDeadline){frame.close();if(!this.#ended&&!this.#disposed)this.#unsupported();return;}
  if(frame.width!==2||frame.height!==1){frame.close();return this.#unsupported();}
  this.#probePending=true;
  try{this.a.post({type:"capability-probe",generation:1,mediaProfile:"mjpeg",frame},[frame]);}
  catch{frame.close();this.#unsupported();}
 }
 #connect():void{this.#opened=false;this.#lastLease="";this.#protocol=new MediaProtocol(this.#profile);this.#releasedFloor=0n;this.#sentAckFloor=0n;this.#releasedSinceAck=0;this.#painted=0n;this.#owned.clear();this.#metas=[];this.#pending=undefined;const url=`ws://${new URL(this.#origin).host}/v1/stream`;let ws:SocketLike;try{ws=this.a.connect(url,"fsq-viewer.v1");}catch{this.#ended=true;this.#cleanup(false);this.a.post({type:"state",state:"disconnected"});return;}this.#socket=ws;ws.binaryType="arraybuffer";ws.onOpen(()=>{if(ws!==this.#socket||this.#disposed)return;this.#opened=true;if(this.#profile!=="mjpeg"&&this.#openedAt===undefined){this.#openedAt=this.a.now();this.#metric({openedAt:this.#openedAt});}ws.send(JSON.stringify({v:1,type:"hello",streamId:this.#streamId}));this.#lease(true);this.#timer=this.a.interval(()=>{if(this.#visible){this.#lease(true);this.#flushAck();}},1000);});ws.onMessage(data=>{if(ws!==this.#socket||this.#ended)return;if(!(data instanceof ArrayBuffer)||data.byteLength>MAX_PAYLOAD_BYTES+40)return this.#fault("malformed-media");const receivedAt=this.a.now(),visibilityEpoch=this.#visibilityEpoch;this.#chain=this.#chain.then(async()=>{while(this.#fenced&&this.#gate)await this.#gate;if(ws!==this.#socket)return;return this.#media(new Uint8Array(data),receivedAt,visibilityEpoch);}).catch(()=>this.#fault("malformed-media"));});ws.onClose(()=>this.#closed(ws));ws.onError(()=>this.#closed(ws));}
 async #media(bytes:Uint8Array,receivedAt:number,visibilityEpoch:number):Promise<void>{
  if(this.#ended)return;
  let e:ProtocolEvent;
  try{e=this.#protocol.accept(bytes);}catch(error){if(error instanceof ProtocolError)return this.#fault("malformed-media");throw error;}
  if(e.type==="session"){
   const firstEpoch=!this.#sawSession;this.#sawSession=true;this.#session=e.session;
   if(e.reset)this.#beginReset(0n,false,firstEpoch);return;
  }
  if(e.type==="config"){await this.#configure(e.codec);return;}
  if(e.type==="gap"){this.#beginReset(e.discardThroughSequence);return;}
  if(e.type==="end"){
   this.#ended=true;
   if(e.reason===4)this.a.post({type:"state",state:"interrupted"});
   this.#cleanup(false,1000);
   this.a.post({type:"state",state:e.reason<=2?"stopped":e.reason===3?"disconnected":"error"});return;
  }
  // Never serialize control/reset behind a non-cancellable native image promise.
  if(this.#profile==="mjpeg"){this.#jpeg(e,receivedAt,visibilityEpoch);return;}
  await this.#decode(e,receivedAt);
 }
 async #configure(codec:string):Promise<void>{if(!this.#session)return this.#fault("malformed-media");const generation=this.#generation,s=this.#session,config:DecoderConfigLike={codec,codedWidth:s.codedWidth,codedHeight:s.codedHeight,optimizeForLatency:true,hardwareAcceleration:"prefer-hardware"};this.#configChecks++;this.#pendingConfigChecks++;this.#metric({});let support;try{support=await this.a.support(config);}catch{this.#settleConfig(false);if(this.#disposed||this.#ended||generation!==this.#generation)return;return this.#unsupported();}const supported=support.supported&&support.config.codec===codec&&support.config.codedWidth===s.codedWidth&&support.config.codedHeight===s.codedHeight;this.#settleConfig(supported);if(this.#disposed||this.#ended||generation!==this.#generation)return;if(!supported)return this.#unsupported();try{this.#decoder?.close();this.#decoder=this.a.decoder(frame=>this.#output(frame,generation),()=>{if(generation===this.#generation)this.#fault("decoder-error");});this.#decoder.configure(config);}catch{return this.#unsupported();}}
 async #decode(e:Extract<ProtocolEvent,{type:"frame"}>,receivedAt:number):Promise<void>{const d=this.#decoder;if(!d||this.#owned.size>=4||d.decodeQueueSize>=4)return this.#fault("malformed-media");let data=e.bytes;if(e.config){if(e.config.byteLength>MAX_PAYLOAD_BYTES-e.bytes.byteLength)return this.#fault("malformed-media");data=new Uint8Array(e.config.byteLength+e.bytes.byteLength);data.set(e.config);data.set(e.bytes,e.config.byteLength);}const meta:Meta={generation:this.#generation,sequence:e.sequence,epoch:e.epoch,ptsUs:e.ptsUs,key:e.key,receivedAt,decodedAt:this.a.now()};this.#metas.push(meta);this.#owned.set(e.sequence,{generation:this.#generation,released:false});this.#sourceFrames++;try{d.decode(this.a.chunk({type:e.key?"key":"delta",timestamp:e.ptsUs,data}));this.#metric({receivedAt});this.#lease();}catch{this.#metas.pop();this.#owned.delete(e.sequence);this.#fault("decoder-error");}}
 #jpeg(event:Extract<ProtocolEvent,{type:"frame"}>,receivedAt:number,visibilityEpoch:number):void{
  const session=this.#session;
  if(!session||this.#owned.size!==0||this.#jpegNext||this.#pending)return this.#fault("malformed-media");
  const meta:Meta={generation:this.#generation,sequence:event.sequence,epoch:event.epoch,ptsUs:event.ptsUs,key:true,receivedAt,decodedAt:this.a.now()};
  this.#owned.set(meta.sequence,{generation:meta.generation,released:false});this.#sourceFrames++;
  if(!this.#visible||visibilityEpoch!==this.#visibilityEpoch){this.#release(meta.sequence,meta.generation);return;}
  if(this.#jpegJob)this.#jpegNext={event,meta,session};else void this.#bitmap(event,meta,session);
 }
 async #bitmap(event:Extract<ProtocolEvent,{type:"frame"}>,meta:Meta,session:Session):Promise<void>{
  this.#jpegJob=meta;
  try{
   const frame=await this.a.bitmap(event.bytes);
   if(this.#ended||this.#disposed||meta.generation!==this.#generation||!this.#visible){
    frame.close();this.#release(meta.sequence,meta.generation);return;
   }
   if(!boundedImage(frame.width,frame.height)||frame.width!==session.displayWidth||frame.height!==session.displayHeight){
    frame.close();return this.#fault("malformed-media");
   }
   this.#outputs++;this.#pending=meta;
   try{
    this.a.post({type:"frame",generation:meta.generation,sequence:meta.sequence,epoch:meta.epoch,fresh:true,
     receivedAt:meta.receivedAt,decodedAt:meta.decodedAt,outputAt:this.a.now(),frame},[frame]);
   }catch{frame.close();this.#pending=undefined;this.#fault("decoder-error");}
   this.#metric({receivedAt:meta.receivedAt});
  }catch{
   if(!this.#ended&&!this.#disposed&&meta.generation===this.#generation)this.#fault("malformed-media");
   else this.#release(meta.sequence,meta.generation);
  }
  finally{
   this.#jpegJob=undefined;const next=this.#jpegNext;this.#jpegNext=undefined;
   if(next&&!this.#ended&&!this.#disposed){
    if(next.meta.generation===this.#generation&&this.#visible)void this.#bitmap(next.event,next.meta,next.session);
    else this.#release(next.meta.sequence,next.meta.generation);
   }
  }
 }
 #output(frame:FrameLike,generation:number):void{if(this.#disposed||this.#fenced||generation!==this.#generation){frame.close();return;}const index=this.#metas.findIndex(meta=>meta.generation===generation&&meta.ptsUs===frame.timestamp),meta=index<0?undefined:this.#metas.splice(index,1)[0];if(!meta){frame.close();return;}this.#outputs++;if(this.#pending){frame.close();this.#release(meta.sequence);this.#metric({});return;}this.#pending=meta;const fresh=meta.key&&this.#fresh,outputAt=this.a.now();this.a.post({type:"frame",generation:meta.generation,sequence:meta.sequence,epoch:meta.epoch,fresh,receivedAt:meta.receivedAt,decodedAt:meta.decodedAt,outputAt,frame},[frame]);this.#metric({});this.#lease();}
 #complete(generation:number,sequence:bigint,presented:boolean):void{
  if(generation>this.#generation)return this.#fault("malformed-control");
  if(sequence<=this.#releasedFloor)return;
  const pending=this.#pending;
  if(!pending||generation!==pending.generation||sequence!==pending.sequence)return this.#fault("malformed-control");
  if(!this.#fenced&&generation===this.#generation&&presented&&this.#visible){
   if(this.#profile==="mjpeg")this.#painted=sequence;
   else if(pending.key&&this.#fresh)this.#fresh=false;
  }
  this.#pending=undefined;this.#release(sequence);this.#lease();
 }
 #release(sequence:bigint,generation?:number):void{
  const owned=this.#owned.get(sequence);
  if(!owned||(generation!==undefined&&owned.generation!==generation))return;
  owned.released=true;
  let floor=this.#releasedFloor,released=0;
  for(const[seq,item]of this.#owned){
   if(!item.released)break;
   this.#owned.delete(seq);if(seq>floor)floor=seq;released++;
  }
  if(floor>this.#releasedFloor){
   this.#releasedFloor=floor;this.#releasedSinceAck+=released;
   if(this.#profile==="mjpeg"||this.#releasedSinceAck>=4)this.#flushAck();
  }
 }
 #flushAck():void{
  if(this.#releasedFloor<=this.#sentAckFloor||this.#releasedSinceAck===0||!this.#opened||this.#ended
   ||(this.#fenced&&this.#profile!=="mjpeg"))return;
  this.#socket?.send(JSON.stringify({v:1,type:"ack",sequence:String(this.#releasedFloor),
   ...(this.#profile==="mjpeg"?{paintedSequence:String(this.#painted)}:{})}));
  this.#sentAckFloor=this.#releasedFloor;this.#releasedSinceAck=0;
 }
 #beginReset(watermark:bigint,after=false,firstEpoch=false):void{
  if(this.#generation>=Number.MAX_SAFE_INTEGER)return this.#fault("malformed-control");
  const initial=firstEpoch&&!after&&this.#sourceFrames===0&&this.#outputs===0&&this.#owned.size===0
   &&this.#pending===undefined&&this.#decoder===undefined&&this.#metas.length===0;
  this.#flushAck();this.#unfence?.();this.#fenced=true;
  this.#gate=new Promise<void>(resolve=>{this.#unfence=resolve;});
  this.#generation++;this.#resets.set(this.#generation,watermark);this.#fresh=true;
  // Runtime already revoked GAP ownership: it must not become a fabricated completion ACK.
  if(this.#profile==="mjpeg"&&watermark>this.#releasedFloor){
   for(const seq of this.#owned.keys())if(seq<=watermark)this.#owned.delete(seq);
   this.#releasedFloor=watermark;this.#sentAckFloor=watermark;this.#releasedSinceAck=0;
  }
  for(const meta of this.#metas)this.#release(meta.sequence);this.#metas=[];
  if(this.#jpegNext){this.#release(this.#jpegNext.meta.sequence,this.#jpegNext.meta.generation);this.#jpegNext=undefined;}
  try{this.#decoder?.close();}catch{}this.#decoder=undefined;
  if(!initial&&this.#profile!=="mjpeg")this.#advertise(0,0);
  this.a.post({type:"reset",generation:this.#generation,discardThroughSequence:watermark,state:"syncing"});
  if(after)this.#reconnects=1;
 }
 #resetComplete(generation:number,watermark:bigint):void{
  const issued=this.#resets.get(generation);
  if(issued!==undefined&&generation<this.#generation){
   if(issued!==watermark)return this.#fault("malformed-control");
   this.#resets.delete(generation);return;
  }
  if(!this.#fenced||generation!==this.#generation||issued===undefined||issued!==watermark)return this.#fault("malformed-control");
  this.#resets.delete(generation);
  let floor=this.#releasedFloor>watermark?this.#releasedFloor:watermark;
  for(const[seq,item]of this.#owned){
   const decoding=this.#jpegJob?.sequence===seq&&this.#jpegJob.generation===item.generation&&seq>watermark;
   if((item.generation<generation||seq<=watermark)&&!decoding){this.#owned.delete(seq);if(seq>floor)floor=seq;}
  }
  this.#releasedFloor=floor;this.#sentAckFloor=floor;this.#releasedSinceAck=0;
  if(this.#pending?.generation!==generation)this.#pending=undefined;
  this.#fenced=false;this.#gate=undefined;this.#unfence?.();this.#unfence=undefined;
  this.#resetCompletions++;this.#metric({});
  if(this.#reconnects===1){this.#reconnects=2;this.#connect();}else this.#lease();
 }
 #visibility(visible:boolean):void{if(!visible)this.#flushAck();const changed=this.#visible!==visible;if(changed)this.#visibilityEpoch++;this.#visible=visible;if(!visible){this.#fresh=true;if(changed&&this.#profile==="mjpeg"&&this.#opened)this.#beginReset(0n);this.a.post({type:"state",state:"paused"});}else this.a.post({type:"state",state:"syncing"});this.#lease();}
 #lease(force=false):void{const jpeg=this.#profile==="mjpeg",available=this.#visible&&(jpeg||this.#owned.size<4&&(this.#decoder?.decodeQueueSize??0)<4);this.#advertise(available?(jpeg?1:4):0,available?MAX_PAYLOAD_BYTES:0,force);}
 #advertise(creditFrames:number,creditBytes:number,force=false):void{
  if(!this.#opened||this.#ended)return;
  const key=`${this.#visible}:${creditFrames}:${creditBytes}`;
  if(!force&&key===this.#lastLease)return;
  // Local startup evidence excludes preflight and hidden connection time; Runtime is authoritative.
  if(this.#profile==="mjpeg"&&this.#visible&&this.#openedAt===undefined){
   this.#openedAt=this.a.now();this.#metric({openedAt:this.#openedAt});
  }
  this.#lastLease=key;
  this.#socket?.send(JSON.stringify({v:1,type:"lease-renew",visible:this.#visible,creditFrames,creditBytes}));
 }
 #closed(ws:SocketLike):void{if(this.#handled.has(ws))return;this.#handled.add(ws);if(ws!==this.#socket||this.#disposed||this.#ended)return;this.#socket=undefined;this.#opened=false;if(this.#timer!==undefined)this.a.clearInterval(this.#timer);if(this.#visible&&this.#reconnects===0){this.#protocol=new MediaProtocol();this.#beginReset(0n,true);}else{this.#ended=true;this.#cleanup(false);this.a.post({type:"state",state:"disconnected"});}}
 #unsupported():void{this.#ended=true;this.#cleanup(false);this.a.post({type:"error",code:"viewer-unsupported",safeMessage:"This browser cannot decode the stream."});this.a.post({type:"state",state:"unsupported"});}
 #settleConfig(supported:boolean):void{this.#configSettled++;if(this.#pendingConfigChecks>0)this.#pendingConfigChecks--;this.#configSupported=supported;if(!this.#disposed)this.#metric({});}
 #metric(sample:Readonly<Record<string,number|boolean>>):void{this.a.post({type:"metrics",sample:{...sample,sourceFrames:this.#sourceFrames,outputs:this.#outputs,decodeQueue:this.#decoder?.decodeQueueSize??0,ownedFrames:this.#owned.size,resetCompletions:this.#resetCompletions,configChecks:this.#configChecks,configSettled:this.#configSettled,configCheckPending:this.#pendingConfigChecks>0,...(this.#configSettled>0?{configSupported:this.#configSupported}:{})}});}
 #fault(code:"malformed-control"|"malformed-media"|"decoder-error"):void{if(this.#ended||this.#disposed)return;this.#ended=true;this.#cleanup(false);this.a.post({type:"error",code:code==="decoder-error"?"codec-config-error":code,safeMessage:code==="decoder-error"?"The video decoder failed.":"The stream was rejected."});this.a.post({type:"state",state:"error"});}
 #cleanup(leave:boolean,code=leave?1000:1008):void{if(this.#timer!==undefined)this.a.clearInterval(this.#timer);if(this.#probeTimer!==undefined)this.a.clearInterval(this.#probeTimer);this.#probePending=false;this.#jpegNext=undefined;this.#gate=undefined;this.#unfence?.();this.#unfence=undefined;const socket=this.#socket;this.#socket=undefined;if(leave&&this.#opened)try{socket?.send(JSON.stringify({v:1,type:"leave"}));}catch{}socket?.close(code);try{this.#decoder?.close();}catch{}this.#decoder=undefined;this.#metas=[];this.#owned.clear();this.#pending=undefined;
 }
 #dispose():void{this.#flushAck();this.#disposed=true;this.#ended=true;this.#cleanup(true);this.a.terminate();}
}

export function workerFoundation(profile:MediaProfile):boolean{
 return typeof WebSocket!=="undefined"&&(profile==="mjpeg"
  ?typeof createImageBitmap==="function"&&typeof ImageBitmap!=="undefined"
  :typeof VideoDecoder!=="undefined"&&typeof EncodedVideoChunk!=="undefined");
}
const scope=globalThis as typeof globalThis&{postMessage?:(message:unknown,transfer?:Transferable[])=>void;onmessage?:((event:MessageEvent)=>void)|null;close?:()=>void};
if(typeof scope.postMessage==="function"){
 const controller=new WorkerController({
  foundation:workerFoundation,
  bitmap:bytes=>createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>],{type:"image/jpeg"}),{imageOrientation:"from-image"}),
  connect(url,protocol){const ws=new WebSocket(url,protocol);return{get binaryType(){return ws.binaryType;},set binaryType(v){ws.binaryType=v as BinaryType;},send:d=>ws.send(d),close:c=>ws.close(c),onOpen:f=>ws.addEventListener("open",f),onMessage:f=>ws.addEventListener("message",e=>f(e.data)),onClose:f=>ws.addEventListener("close",f),onError:f=>ws.addEventListener("error",f)};},support:async c=>{const r=await VideoDecoder.isConfigSupported(c),q=r.config;return{supported:r.supported===true,config:{codec:q?.codec??"",codedWidth:q?.codedWidth??0,codedHeight:q?.codedHeight??0}};},decoder:(output,error)=>new VideoDecoder({output,error}),chunk:i=>new EncodedVideoChunk(i),post:(m,t)=>scope.postMessage!(m,t as Transferable[]),now:()=>absoluteMonotonicNow(performance),interval:(f,m)=>setInterval(f,m),clearInterval:t=>clearInterval(t as number),terminate:()=>scope.close?.()});scope.onmessage=e=>controller.message(e.data);
}
