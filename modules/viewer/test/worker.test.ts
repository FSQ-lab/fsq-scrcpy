import assert from "node:assert/strict";import test from "node:test";import { encodeMediaHeader,MAX_CONFIG_BYTES,MAX_FRAME_BYTES } from "../../contracts/src/index.js";import { WorkerController,type DecoderConfigLike,type DecoderLike,type FrameLike,type SocketLike,type WorkerAdapters } from "../src/worker.js";
import { workerFoundation } from "../src/worker.js";
import { TestBitmap, bitmapResult, jpegSession, jpegWire } from "./bitmap-fixtures.js";
const ID="123e4567-e89b-42d3-a456-426614174000",CONFIG=Uint8Array.of(0,0,0,1,0x67,0x64,0,0x28,0,0,1,0x68,1);
const tick=()=>new Promise<void>(resolve=>setImmediate(resolve));
function payloadSession(){const p=new Uint8Array(24),v=new DataView(p.buffer);v.setUint32(0,0x68323634);v.setUint32(4,720);v.setUint32(8,1280);v.setUint32(12,720);v.setUint32(16,1280);v.setUint32(20,1_000_000);return p;}
function payloadGap(watermark:bigint,reason=1){const p=new Uint8Array(12),v=new DataView(p.buffer);v.setUint32(0,reason);v.setBigUint64(4,watermark);return p;}
function wire(kind:1|2|3|4|5,seq:bigint,epoch:bigint,payload:Uint8Array,flags=0,pts=-1n){const h=encodeMediaHeader({minor:0,kind,flags,payloadBytes:payload.length,sequence:seq,epoch,ptsUs:pts}),b=new Uint8Array(40+payload.length);b.set(h);b.set(payload,40);return b.buffer;}
class Socket implements SocketLike{binaryType="";sent:string[]=[];closes:number[]=[];#open=()=>{};#message=(_:unknown)=>{};#close=()=>{};#error=()=>{};send(v:string){this.sent.push(v);}close(v=1000){this.closes.push(v);}onOpen(f:()=>void){this.#open=f;}onMessage(f:(v:unknown)=>void){this.#message=f;}onClose(f:()=>void){this.#close=f;}onError(f:()=>void){this.#error=f;}open(){this.#open();}message(v:unknown){this.#message(v);}closed(){this.#close();}error(){this.#error();}}
class Decoder implements DecoderLike{decodeQueueSize=0;configs:DecoderConfigLike[]=[];chunks:Array<{type:string;timestamp:number;data:Uint8Array}>=[];resets=0;closes=0;constructor(readonly output:(f:FrameLike)=>void,readonly fail:()=>void){}configure(c:DecoderConfigLike){this.configs.push(c);}decode(c:unknown){this.chunks.push(c as {type:string;timestamp:number;data:Uint8Array});}reset(){this.resets++;}close(){this.closes++;}emit(frame:Frame){this.output(frame);}error(){this.fail();}}
class Frame implements FrameLike{closes=0;constructor(readonly timestamp:number){}close(){this.closes++;}}
function fixture(supported=true,supporter?:(config:DecoderConfigLike)=>Promise<{supported:boolean;config:DecoderConfigLike}>){const sockets:Socket[]=[],posts:Array<{message:any;transfer?:readonly unknown[]}>=[],chunks:Array<{type:"key"|"delta";timestamp:number;data:Uint8Array}>=[],timers=new Set<()=>void>();let decoder:Decoder|undefined,terminated=0;const adapters:WorkerAdapters={foundation:()=>true,bitmap:async()=>{throw new Error("Unexpected JPEG decode");},connect(){const s=new Socket();sockets.push(s);return s;},support(config){return supporter?supporter(config):Promise.resolve({supported,config});},decoder(output,error){return decoder=new Decoder(output,error);},chunk(init){chunks.push(init);return init;},post(message,transfer){posts.push({message,...(transfer?{transfer}:{})});},now:()=>123,interval(fn){timers.add(fn);return fn;},clearInterval(token){timers.delete(token as()=>void);},terminate(){terminated++;}},controller=new WorkerController(adapters);return{adapters,controller,sockets,posts,chunks,timers,get decoder(){return decoder!;},get terminated(){return terminated;}};}
function start(f:ReturnType<typeof fixture>){f.controller.message({ type: "start", origin: "http://127.0.0.1:43210", streamId: ID, mediaProfile: "h264-annexb", presentation: "standalone" });f.controller.message({type:"visibility",visible:true});const ws=f.sockets[0]!;ws.open();return ws;}
async function configured(f:ReturnType<typeof fixture>){const ws=start(f);ws.message(wire(1,1n,1n,payloadSession()));await tick();const reset=f.posts.find(p=>p.message.type==="reset")!.message;f.controller.message({type:"reset-complete",generation:reset.generation,discardThroughSequence:0n});ws.message(wire(2,2n,1n,CONFIG));await tick();return ws;}
const parsed=(s:Socket)=>s.sent.map(v=>JSON.parse(v) as Record<string,unknown>);
async function deliver(f:ReturnType<typeof fixture>,ws:Socket,index:number){const sequence=BigInt(3+index),pts=index+1;ws.message(wire(3,sequence,1n,Uint8Array.of(index&255),index===0?1:0,BigInt(pts)));await tick();const frame=new Frame(pts);f.decoder.emit(frame);frame.close();f.controller.message({type:"frame-complete",generation:2,sequence,presented:true});return sequence;}

test("start derives exact loopback WebSocket, hello, openedAt and visible absolute lease",()=>{const f=fixture(),ws=start(f);assert.equal(f.sockets.length,1);assert.deepEqual(parsed(ws).slice(0,2),[{v:1,type:"hello",streamId:ID},{v:1,type:"lease-renew",visible:true,creditFrames:4,creditBytes:8388608}]);assert.equal(ws.binaryType,"arraybuffer");assert.deepEqual(f.posts.find(p=>p.message.type==="metrics")!.message,{type:"metrics",sample:{openedAt:123,sourceFrames:0,outputs:0,decodeQueue:0,ownedFrames:0,resetCompletions:0,configChecks:0,configSettled:0,configCheckPending:false}});});
test("main control schemas, duplicate start and text media fail closed safely",()=>{for(const act of [(f:ReturnType<typeof fixture>)=>f.controller.message({ type: "start", origin: "http://localhost:1", streamId: ID, mediaProfile: "h264-annexb", presentation: "standalone" }),(f:ReturnType<typeof fixture>)=>{start(f);f.controller.message({type:"visibility",visible:true,x:1});},(f:ReturnType<typeof fixture>)=>{const ws=start(f);ws.message("frame");}]){const f=fixture();act(f);assert.ok(f.posts.some(p=>p.message.code==="malformed-control"||p.message.code==="malformed-media"));assert.equal(JSON.stringify(f.posts).includes(ID),false);}});
test("config support, decoder config and associated frame timings are exact",async()=>{const f=fixture(),ws=await configured(f);assert.deepEqual(f.decoder.configs,[{codec:"avc1.640028",codedWidth:720,codedHeight:1280,optimizeForLatency:true,hardwareAcceleration:"prefer-hardware"}]);ws.message(wire(3,3n,1n,Uint8Array.of(9,8),1,77n));await tick();assert.deepEqual(f.chunks[0],{type:"key",timestamp:77,data:Uint8Array.of(...CONFIG,9,8)});const source=f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message;assert.deepEqual(source.sample,{receivedAt:123,sourceFrames:1,outputs:0,decodeQueue:0,ownedFrames:1,resetCompletions:1,configChecks:1,configSettled:1,configCheckPending:false,configSupported:true});const frame=new Frame(77);f.decoder.emit(frame);const output=f.posts.find(p=>p.message.type==="frame")!.message;assert.deepEqual({receivedAt:output.receivedAt,decodedAt:output.decodedAt,outputAt:output.outputAt},{receivedAt:123,decodedAt:123,outputAt:123});assert.equal(JSON.stringify(source).includes(ID),false);});
test("initial Session preserves credit while Config and key remain gated until reset completion",async()=>{const f=fixture(),ws=start(f),before=parsed(ws).length;ws.message(wire(1,1n,1n,payloadSession()));ws.message(wire(2,2n,1n,CONFIG));ws.message(wire(3,3n,1n,Uint8Array.of(1),1,9n));await tick();assert.equal(parsed(ws).slice(before).some(v=>v.type==="lease-renew"&&v.creditFrames===0),false);assert.equal(f.chunks.length,0);assert.equal(f.posts.filter(p=>p.message.type==="frame").length,0);f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});await tick();await tick();assert.equal(f.chunks.length,1);assert.equal(f.chunks[0]!.timestamp,9);const frame=new Frame(9);f.decoder.emit(frame);assert.equal(f.posts.filter(p=>p.message.type==="frame").length,1);});
test("pre-media reconnect preserves credit for the first accepted epoch only",async()=>{const f=fixture(),first=start(f);first.closed();const reconnect=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;f.controller.message({type:"reset-complete",generation:reconnect.generation,discardThroughSequence:0n});const second=f.sockets[1]!;second.open();assert.deepEqual(parsed(second).slice(0,2),[{v:1,type:"hello",streamId:ID},{v:1,type:"lease-renew",visible:true,creditFrames:4,creditBytes:8388608}]);const before=parsed(second).length;second.message(wire(1,1n,1n,payloadSession()));second.message(wire(2,2n,1n,CONFIG));second.message(wire(3,3n,1n,Uint8Array.of(1),1,9n));await tick();assert.equal(parsed(second).slice(before).some(v=>v.type==="lease-renew"&&v.creditFrames===0),false);assert.equal(f.chunks.length,0);const epoch=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;f.controller.message({type:"reset-complete",generation:epoch.generation,discardThroughSequence:0n});await tick();await tick();assert.equal(f.chunks.length,1);const frame=new Frame(9);f.decoder.emit(frame);assert.equal(f.posts.filter(p=>p.message.type==="frame").length,1);});
test("reconnect after an accepted Session revokes credit for the replacement Session",async()=>{const f=fixture(),first=await configured(f);first.closed();const reconnect=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;f.controller.message({type:"reset-complete",generation:reconnect.generation,discardThroughSequence:0n});const second=f.sockets[1]!;second.open();const before=parsed(second).length;second.message(wire(1,1n,1n,payloadSession()));await tick();assert.ok(parsed(second).slice(before).some(v=>v.type==="lease-renew"&&v.creditFrames===0&&v.creditBytes===0));});
test("unsupported support result settles safe stage flags before terminal cleanup",async()=>{const f=fixture(false),ws=start(f);ws.message(wire(1,1n,1n,payloadSession()));await tick();f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});ws.message(wire(2,2n,1n,CONFIG));await tick();assert.ok(f.posts.some(p=>p.message.code==="viewer-unsupported"));assert.equal(f.decoder,undefined);assert.deepEqual(f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message.sample,{sourceFrames:0,outputs:0,decodeQueue:0,ownedFrames:0,resetCompletions:1,configChecks:1,configSettled:1,configCheckPending:false,configSupported:false});});
test("hanging config support exposes reset completion and pending check without consuming frames",async()=>{let resolve!:(value:{supported:boolean;config:DecoderConfigLike})=>void;const support=new Promise<{supported:boolean;config:DecoderConfigLike}>(yes=>{resolve=yes;}),f=fixture(true,()=>support),ws=start(f);ws.message(wire(1,1n,1n,payloadSession()));await tick();f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});assert.equal(f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message.sample.resetCompletions,1);ws.message(wire(2,2n,1n,CONFIG));ws.message(wire(3,3n,1n,Uint8Array.of(1),1,9n));await tick();let sample=f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message.sample;assert.deepEqual([sample.configChecks,sample.configSettled,sample.configCheckPending,sample.sourceFrames],[1,0,true,0]);assert.equal(f.chunks.length,0);resolve({supported:true,config:{codec:"avc1.640028",codedWidth:720,codedHeight:1280,optimizeForLatency:true,hardwareAcceleration:"prefer-hardware"}});await tick();await tick();sample=f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message.sample;assert.deepEqual([sample.configChecks,sample.configSettled,sample.configCheckPending,sample.configSupported,sample.sourceFrames],[1,1,false,true,1]);assert.equal(f.chunks.length,1);});
test("stale config rejection settles safe flags without terminal effect",async()=>{let rejectSupport!:(reason?:unknown)=>void;const support=new Promise<{supported:boolean;config:DecoderConfigLike}>((_,reject)=>{rejectSupport=reject;}),f=fixture(true,()=>support),ws=start(f);ws.message(wire(1,1n,1n,payloadSession()));await tick();f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});ws.message(wire(2,2n,1n,CONFIG));await tick();ws.error();rejectSupport(new Error("stale"));await tick();assert.equal(f.posts.some(p=>p.message.code==="viewer-unsupported"),false);assert.equal(f.posts.filter(p=>p.message.type==="reset").length,2);const sample=f.posts.filter(p=>p.message.type==="metrics").at(-1)!.message.sample;assert.deepEqual([sample.configChecks,sample.configSettled,sample.configCheckPending,sample.configSupported],[1,1,false,false]);});
test("frame transfer, discarded fresh retry, presented completion and later key freshness",async()=>{const f=fixture(),ws=await configured(f);ws.message(wire(3,3n,1n,Uint8Array.of(1),1,10n));await tick();const first=new Frame(10);f.decoder.emit(first);const one=f.posts.find(p=>p.message.type==="frame")!;assert.equal(one.message.fresh,true);assert.deepEqual(one.transfer,[first]);first.close();f.controller.message({type:"frame-complete",generation:2,sequence:3n,presented:false});assert.equal(parsed(ws).some(v=>v.type==="ack"),false);ws.message(wire(3,4n,1n,Uint8Array.of(2),1,11n));await tick();const second=new Frame(11);f.decoder.emit(second);assert.equal(f.posts.filter(p=>p.message.type==="frame").at(-1)!.message.fresh,true);second.close();f.controller.message({type:"frame-complete",generation:2,sequence:4n,presented:true});ws.message(wire(3,5n,1n,Uint8Array.of(3),1,12n));await tick();const third=new Frame(12);f.decoder.emit(third);assert.equal(f.posts.filter(p=>p.message.type==="frame").at(-1)!.message.fresh,false);assert.deepEqual([first.closes,second.closes],[1,1]);});
test("one pending transfer closes replacement output and lease tick flushes cumulative tail ACK",async()=>{const f=fixture(),ws=await configured(f);ws.message(wire(3,3n,1n,Uint8Array.of(1),1,10n));ws.message(wire(3,4n,1n,Uint8Array.of(2),0,11n));await tick();const first=new Frame(10),replacement=new Frame(11);f.decoder.emit(first);f.decoder.emit(replacement);assert.equal(replacement.closes,1);assert.equal(parsed(ws).some(v=>v.type==="ack"),false);first.close();f.controller.message({type:"frame-complete",generation:2,sequence:3n,presented:true});assert.equal(parsed(ws).some(v=>v.type==="ack"),false);for(const timer of f.timers)timer();assert.ok(parsed(ws).some(v=>v.type==="ack"&&v.sequence==="4"));});
test("300 frames coalesce to cumulative ACK batches of four below Runtime rate cap",async()=>{const f=fixture(),ws=await configured(f);for(let i=0;i<300;i++)await deliver(f,ws,i);const acks=parsed(ws).filter(value=>value.type==="ack");assert.equal(acks.length,75);assert.ok(acks.length<=128);assert.deepEqual(acks.slice(0,3).map(value=>value.sequence),["6","10","14"]);assert.equal(acks.at(-1)!.sequence,"302");for(let i=1;i<acks.length;i++)assert.equal(BigInt(acks[i]!.sequence as string)-BigInt(acks[i-1]!.sequence as string),4n);});
test("lease tick, hidden transition and leave flush one-to-three released frame tails",async()=>{const ticked=fixture(),tickWs=await configured(ticked);for(let i=0;i<3;i++)await deliver(ticked,tickWs,i);assert.equal(parsed(tickWs).some(value=>value.type==="ack"),false);for(const timer of ticked.timers)timer();assert.ok(parsed(tickWs).some(value=>value.type==="ack"&&value.sequence==="5"));const hidden=fixture(),hiddenWs=await configured(hidden);for(let i=0;i<3;i++)await deliver(hidden,hiddenWs,i);hidden.controller.message({type:"visibility",visible:false});assert.ok(parsed(hiddenWs).some(value=>value.type==="ack"&&value.sequence==="5"));const leaving=fixture(),leaveWs=await configured(leaving);for(let i=0;i<3;i++)await deliver(leaving,leaveWs,i);leaving.controller.message({type:"dispose"});const controls=parsed(leaveWs),ack=controls.findIndex(value=>value.type==="ack"&&value.sequence==="5"),leave=controls.findIndex(value=>value.type==="leave");assert.ok(ack>=0&&leave>ack);});
test("fenced and reconnected generations never send old tail ACK on replacement socket",async()=>{const f=fixture(),first=await configured(f);for(let i=0;i<3;i++)await deliver(f,first,i);first.closed();const reset=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;f.controller.message({type:"reset-complete",generation:reset.generation,discardThroughSequence:0n});const second=f.sockets[1]!;second.open();assert.equal(parsed(second).some(value=>value.type==="ack"),false);});
test("GAP after prior ownership advertises zero credit before replay",async()=>{const f=fixture(),ws=await configured(f),oldDecoder=f.decoder;ws.message(wire(3,3n,1n,Uint8Array.of(1),1,10n));await tick();const pending=new Frame(10);oldDecoder.emit(pending);const before=parsed(ws).length;ws.message(wire(4,4n,1n,payloadGap(3n)));await tick();const sent=parsed(ws).slice(before),reset=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;assert.ok(sent.some(v=>v.type==="lease-renew"&&v.creditFrames===0&&v.creditBytes===0));assert.deepEqual([reset.generation,reset.discardThroughSequence],[3,3n]);pending.close();f.controller.message({type:"frame-complete",generation:2,sequence:3n,presented:false});f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:3n});ws.message(wire(1,5n,1n,payloadSession()));ws.message(wire(2,6n,1n,CONFIG));ws.message(wire(3,7n,1n,Uint8Array.of(2),1,10n));await tick();const late=new Frame(10);oldDecoder.emit(late);assert.equal(late.closes,1);const current=new Frame(10);f.decoder.emit(current);assert.equal(f.posts.filter(p=>p.message.type==="frame").at(-1)!.message.sequence,7n);assert.equal(oldDecoder.closes,1);});
test("transport-resync accepts only higher epoch and rebuilds decoder in reset generation",async()=>{const f=fixture(),ws=await configured(f),old=f.decoder;ws.message(wire(4,3n,1n,payloadGap(0n,3)));await tick();const reset=f.posts.filter(p=>p.message.type==="reset").at(-1)!.message;f.controller.message({type:"reset-complete",generation:reset.generation,discardThroughSequence:0n});ws.message(wire(1,4n,2n,payloadSession()));ws.message(wire(2,5n,2n,CONFIG));ws.message(wire(3,6n,2n,Uint8Array.of(4),1,33n));await tick();assert.notEqual(f.decoder,old);assert.equal(old.closes,1);const frame=new Frame(33);f.decoder.emit(frame);assert.deepEqual([f.posts.filter(p=>p.message.type==="frame").at(-1)!.message.epoch,f.chunks.at(-1)!.data],[2n,Uint8Array.of(...CONFIG,4)]);});
test("visibility, queue cap and interval advertise bounded credit without payload data",async()=>{const f=fixture(),ws=await configured(f);f.decoder.decodeQueueSize=4;f.controller.message({type:"visibility",visible:true});assert.deepEqual(parsed(ws).at(-1),{v:1,type:"lease-renew",visible:true,creditFrames:0,creditBytes:0});const zeroCount=parsed(ws).filter(v=>v.type==="lease-renew").length;f.controller.message({type:"visibility",visible:true});assert.equal(parsed(ws).filter(v=>v.type==="lease-renew").length,zeroCount);for(const timer of f.timers)timer();assert.equal(parsed(ws).filter(v=>v.type==="lease-renew").length,zeroCount+1);f.controller.message({type:"visibility",visible:false});assert.deepEqual(parsed(ws).at(-1),{v:1,type:"lease-renew",visible:false,creditFrames:0,creditBytes:0});const hiddenCount=ws.sent.length;for(const timer of f.timers)timer();assert.equal(ws.sent.length,hiddenCount);assert.ok(f.posts.every(p=>p.message.type!=="metrics"||!("data" in p.message.sample)));});
test("exact 8 MiB config+IDR allocation succeeds; overflow is rejected before allocation",async()=>{const f=fixture(),ws=start(f),config=new Uint8Array(MAX_CONFIG_BYTES);config.set(CONFIG);ws.message(wire(1,1n,1n,payloadSession()));await tick();f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});ws.message(wire(2,2n,1n,config));await tick();ws.message(wire(3,3n,1n,new Uint8Array(MAX_FRAME_BYTES),1,1n));await tick();assert.equal(f.chunks[0]!.data.byteLength,8388608);});
test("END closes normally, ignores later controls and permits dispose without posts",async()=>{const f=fixture(),ws=await configured(f),payload=new Uint8Array(4);new DataView(payload.buffer).setUint32(0,1);ws.message(wire(5,3n,1n,payload));await tick();assert.equal(ws.closes.at(-1),1000);assert.ok(f.posts.some(p=>p.message.type==="state"&&p.message.state==="stopped"));assert.equal(f.decoder.closes,1);const count=f.posts.length;f.controller.message({type:"visibility",visible:false});assert.equal(f.posts.length,count);f.controller.message({type:"dispose"});assert.equal(f.posts.length,count);assert.equal(f.terminated,1);});
test("failed END exposes interrupted before terminal error while other reason mappings stay unchanged",async()=>{for(const[reason,states]of [[2,["stopped"]],[3,["disconnected"]],[4,["interrupted","error"]]]as const){const f=fixture(),ws=await configured(f),payload=new Uint8Array(4),before=f.posts.length;new DataView(payload.buffer).setUint32(0,reason);ws.message(wire(5,3n,1n,payload));await tick();assert.deepEqual(f.posts.slice(before).filter(p=>p.message.type==="state").map(p=>p.message.state),states);assert.equal(ws.closes.at(-1),1000);assert.equal(f.decoder.closes,1);ws.closed();assert.equal(f.sockets.length,1);assert.equal(f.posts.slice(before).some(p=>p.message.type==="reset"),false);}});
test("decoder error, reset mismatch, reconnect sequence reset and dispose flush cleanly",async()=>{const errored=fixture();await configured(errored);errored.decoder.error();assert.ok(errored.posts.some(p=>p.message.code==="codec-config-error"));assert.equal(errored.decoder.closes,1);const wrong=fixture(),wrongWs=start(wrong);wrongWs.message(wire(1,1n,1n,payloadSession()));await tick();wrong.controller.message({type:"reset-complete",generation:99,discardThroughSequence:0n});assert.ok(wrong.posts.some(p=>p.message.code==="malformed-control"));const re=fixture(),first=start(re);first.closed();const reconnectReset=re.posts.find(p=>p.message.type==="reset")!.message;re.controller.message({type:"reset-complete",generation:reconnectReset.generation,discardThroughSequence:0n});const second=re.sockets[1]!;second.open();assert.equal(parsed(second).at(0)!.type,"hello");second.message(wire(1,1n,1n,payloadSession()));await tick();re.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});second.message(wire(2,2n,1n,CONFIG));second.message(wire(3,3n,1n,Uint8Array.of(1),1,1n));await tick();const frame=new Frame(1);re.decoder.emit(frame);frame.close();re.controller.message({type:"frame-complete",generation:3,sequence:3n,presented:true});assert.equal(parsed(second).some(v=>v.type==="ack"),false);re.controller.message({type:"dispose"});assert.ok(parsed(second).some(v=>v.type==="ack"&&v.sequence==="3"));assert.ok(parsed(second).some(v=>v.type==="leave"));assert.equal(re.terminated,1);});
test("socket error plus close is idempotent and superseded reset completion is harmless",async()=>{const f=fixture(),ws=start(f);ws.message(wire(1,1n,1n,payloadSession()));await tick();ws.error();ws.closed();const resets=f.posts.filter(p=>p.message.type==="reset");assert.equal(resets.length,2);f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});assert.equal(f.posts.some(p=>p.message.code==="malformed-control"),false);f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});assert.equal(f.sockets.length,2);assert.equal(f.posts.filter(p=>p.message.type==="state"&&p.message.state==="disconnected").length,0);});

const jpegStart=(f:ReturnType<typeof fixture>,visible=true)=>{
 f.controller.message({ type: "start", origin: "http://127.0.0.1:43210", streamId: ID, mediaProfile: "mjpeg", presentation: "standalone" });
 f.controller.message({type:"visibility",visible});
};
async function jpegReady(){
 const f=fixture();f.adapters.bitmap=async()=>new TestBitmap();jpegStart(f);await tick();
 const probe=f.posts.find(p=>p.message.type==="capability-probe")!.message;probe.frame.close();
 f.controller.message({type:"capability-result",generation:1,supported:true});const ws=f.sockets[0]!;ws.open();
 ws.message(jpegWire(1,1n,1n,jpegSession()).buffer);await tick();
 f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});return{f,ws};
}
const bitmapPosts=(f:ReturnType<typeof fixture>)=>f.posts.filter(p=>p.message.type==="frame");
const jpegAcks=(ws:Socket)=>parsed(ws).filter(v=>v.type==="ack");
test("target foundation permits AVC-only or JPEG-only APIs independently",()=>{
 const names=["WebSocket","VideoDecoder","EncodedVideoChunk","createImageBitmap","ImageBitmap"];
 const saved=names.map(name=>Object.getOwnPropertyDescriptor(globalThis,name));
 try{
  for(const name of names)Object.defineProperty(globalThis,name,{value:undefined,configurable:true});
  Object.defineProperty(globalThis,"WebSocket",{value:class{},configurable:true});
  for(const name of ["VideoDecoder","EncodedVideoChunk"])Object.defineProperty(globalThis,name,{value:class{},configurable:true});
  assert.equal(workerFoundation("h264-annexb"),true);assert.equal(workerFoundation("mjpeg"),false);
  for(const name of ["VideoDecoder","EncodedVideoChunk"])Object.defineProperty(globalThis,name,{value:undefined,configurable:true});
  Object.defineProperty(globalThis,"ImageBitmap",{value:class{},configurable:true});
  Object.defineProperty(globalThis,"createImageBitmap",{value:()=>{},configurable:true});
  assert.equal(workerFoundation("mjpeg"),true);assert.equal(workerFoundation("h264-annexb"),false);
 }finally{names.forEach((name,index)=>{const descriptor=saved[index];if(descriptor)Object.defineProperty(globalThis,name,descriptor);else Reflect.deleteProperty(globalThis,name);});}
});
test("JPEG preflight transfers once with zero sockets/metrics until Canvas result; hidden success has zero demand",async()=>{
 const f=fixture(),probe=new TestBitmap(),flight=bitmapResult();f.adapters.bitmap=()=>flight.promise;
 jpegStart(f);assert.equal(f.sockets.length,0);f.controller.message({type:"visibility",visible:false});
 flight.resolve(probe);await tick();const message=f.posts.find(p=>p.message.type==="capability-probe")!;
 assert.deepEqual(message.message,{type:"capability-probe",generation:1,mediaProfile:"mjpeg",frame:probe});
 assert.deepEqual(message.transfer,[probe]);assert.equal(probe.closes,0);assert.equal(f.sockets.length,0);
 assert.equal(f.posts.some(p=>p.message.type==="metrics"||p.message.type==="frame"),false);
 probe.close();f.controller.message({type:"capability-result",generation:1,supported:true});const ws=f.sockets[0]!;ws.open();
 assert.deepEqual(parsed(ws).slice(0,2),[{v:1,type:"hello",streamId:ID},{v:1,type:"lease-renew",visible:false,creditFrames:0,creditBytes:0}]);
 assert.equal(probe.closes,1);
});
test("preflight timeout and deadline recheck fence native late output without a socket",async()=>{
 for(const timerFires of [true,false]){
  const f=fixture(),flight=bitmapResult(),late=new TestBitmap();let now=0;
  f.adapters.now=()=>now;f.adapters.bitmap=()=>flight.promise;jpegStart(f);now=5000;
  if(timerFires)for(const timer of [...f.timers])timer();
  flight.resolve(late);await tick();assert.equal(late.closes,1);assert.equal(f.sockets.length,0);
  assert.equal(f.posts.some(p=>p.message.code==="viewer-unsupported"),true);assert.equal(f.timers.size,0);
 }
 const f=fixture(),probe=new TestBitmap();let now=0;f.adapters.now=()=>now;f.adapters.bitmap=async()=>probe;
 jpegStart(f);await tick();probe.close();now=5000;f.controller.message({type:"capability-result",generation:1,supported:true});
 assert.equal(f.sockets.length,0);assert.equal(probe.closes,1);
});
test("unsupported foundation, bad probe dimensions, decode rejection and failed transfer release sender resources",async()=>{
 for(const fault of ["foundation","size","reject","transfer"]){
  const f=fixture(),probe=new TestBitmap(fault==="size"?1:2,1);f.adapters.bitmap=async()=>{if(fault==="reject")throw new Error("Native failure");return probe;};
  if(fault==="foundation")f.adapters.foundation=()=>false;
  if(fault==="transfer"){const post=f.adapters.post;f.adapters.post=(value,transfer)=>{if(transfer)throw new Error("Transfer failure");post(value);};}
  jpegStart(f);await tick();assert.equal(f.sockets.length,0);assert.equal(f.posts.some(p=>p.message.code==="viewer-unsupported"),true);
  assert.equal(probe.closes,fault==="size"||fault==="transfer"?1:0);
 }
});
test("unexpected/extra/duplicate result is malformed-control and cannot open an extra socket",async()=>{
 for(const value of [{type:"capability-result",generation:1,supported:true},{type:"start",origin:"http://127.0.0.1:43210",streamId:ID}]){
  const f=fixture();f.controller.message(value);assert.equal(f.sockets.length,0);assert.equal(f.posts.some(p=>p.message.code==="malformed-control"),true);
 }
 const {f,ws}=await jpegReady();f.controller.message({type:"capability-result",generation:1,supported:true});
 assert.equal(f.sockets.length,1);assert.equal(ws.closes.at(-1),1008);assert.equal(f.posts.some(p=>p.message.code==="malformed-control"),true);
 const extra=fixture();extra.adapters.bitmap=async()=>new TestBitmap();jpegStart(extra);await tick();
 extra.controller.message({type:"capability-result",generation:1,supported:true,extra:1});assert.equal(extra.sockets.length,0);
});
test("each JPEG completion sends immediate combined release/paint ACK and no free-slot lease spam",async()=>{
 const {f,ws}=await jpegReady(),before=parsed(ws).filter(v=>v.type==="lease-renew").length;
 for(let i=0;i<20;i++){
  const sequence=BigInt(i+2);ws.message(jpegWire(3,sequence,1n).buffer);await tick();
  const output=bitmapPosts(f).at(-1)!;assert.equal(output.message.sequence,sequence);assert.equal(output.message.fresh,true);
  assert.deepEqual(output.transfer,[output.message.frame]);assert.equal(output.message.frame.closes,0);
  output.message.frame.close();f.controller.message({type:"frame-complete",generation:2,sequence,presented:i!==1});
  assert.equal(jpegAcks(ws).length,i+1);assert.deepEqual(jpegAcks(ws).at(-1),{v:1,type:"ack",sequence:String(sequence),paintedSequence:String(i===1?2:sequence)});
 }
 assert.equal(parsed(ws).filter(v=>v.type==="lease-renew").length,before);
 assert.equal(f.decoder,undefined);assert.deepEqual(f.chunks,[]);
});
test("native bitmap mismatch/pixel overflow closes before transfer and fails media safely",async()=>{
 for(const [width,height]of [[1,2],[4097,1],[4096,4096]]){
  const {f,ws}=await jpegReady(),image=new TestBitmap(width,height);f.adapters.bitmap=async()=>image;
  ws.message(jpegWire(3,2n,1n).buffer);await tick();assert.equal(image.closes,1);assert.equal(bitmapPosts(f).length,0);
  assert.equal(f.posts.some(p=>p.message.code==="malformed-media"),true);
 }
});
test("GAP/new Session fences a hanging decode, queues one new input, and END does not wait on native promise",async()=>{
 const {f,ws}=await jpegReady(),old=bitmapResult(),next=bitmapResult();let calls=0;
 f.adapters.bitmap=()=>++calls===1?old.promise:next.promise;
 ws.message(jpegWire(3,2n,1n).buffer);await tick();assert.equal(calls,1);
 ws.message(jpegWire(4,3n,1n,payloadGap(2n,3)).buffer);await tick();
 assert.equal(f.posts.filter(p=>p.message.type==="reset").at(-1)!.message.generation,3);
 f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:2n});
 ws.message(jpegWire(1,4n,2n,jpegSession()).buffer);ws.message(jpegWire(3,5n,2n).buffer);await tick();assert.equal(calls,1);
 const stale=new TestBitmap();old.resolve(stale);await tick();assert.equal(stale.closes,1);assert.equal(calls,2);assert.equal(bitmapPosts(f).length,0);
 const end=new Uint8Array(4);new DataView(end.buffer).setUint32(0,1);ws.message(jpegWire(5,6n,2n,end).buffer);await tick();
 assert.equal(ws.closes.at(-1),1000);assert.equal(f.posts.at(-1)!.message.state,"stopped");
 const late=new TestBitmap();next.resolve(late);await tick();assert.equal(late.closes,1);assert.equal(bitmapPosts(f).length,0);assert.deepEqual(jpegAcks(ws),[]);
});
test("hide leaves decode owned until close; return/reset cannot start a second native decode",async()=>{
 const {f,ws}=await jpegReady(),flight=bitmapResult();let calls=0;f.adapters.bitmap=()=>{calls++;return flight.promise;};
 ws.message(jpegWire(3,2n,1n).buffer);await tick();f.controller.message({type:"visibility",visible:false});
 assert.equal(f.posts.at(-1)!.message.state,"paused");f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});
 f.controller.message({type:"visibility",visible:true});assert.deepEqual(jpegAcks(ws),[]);assert.equal(calls,1);
 const late=new TestBitmap();flight.resolve(late);await tick();assert.equal(late.closes,1);assert.equal(bitmapPosts(f).length,0);
 assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"}]);
});
test("discard while hidden immediately ACKs once; GAP completion never fabricates paint/duplicate ACK",async()=>{
 const {f,ws}=await jpegReady();ws.message(jpegWire(3,2n,1n).buffer);await tick();const image=bitmapPosts(f).at(-1)!.message.frame;
 f.controller.message({type:"visibility",visible:false});image.close();f.controller.message({type:"frame-complete",generation:2,sequence:2n,presented:false});
 assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"}]);
 f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});f.controller.message({type:"visibility",visible:true});
 ws.message(jpegWire(4,3n,1n,payloadGap(2n,3)).buffer);await tick();f.controller.message({type:"reset-complete",generation:4,discardThroughSequence:2n});
 assert.equal(jpegAcks(ws).length,1);assert.equal(image.closes,1);
});
test("dispose during probe or media decode closes late image and never transfers/resurrects",async()=>{
 for(const phase of ["probe","media"]){
  const setup=phase==="media"?await jpegReady():{f:fixture(),ws:undefined},f=setup.f,flight=bitmapResult();
  f.adapters.bitmap=()=>flight.promise;if(phase==="probe")jpegStart(f);else setup.ws!.message(jpegWire(3,2n,1n).buffer);
  await tick();const before=bitmapPosts(f).length;f.controller.message({type:"dispose"});const late=new TestBitmap();flight.resolve(late);await tick();
  assert.equal(late.closes,1);assert.equal(bitmapPosts(f).length,before);assert.equal(f.terminated,1);assert.equal(f.timers.size,0);
 }
});

test("reconnect sequence reuse cannot let an old native result release the new connection image",async()=>{
 const {f,ws}=await jpegReady(),old=bitmapResult(),current=bitmapResult();let calls=0;
 f.adapters.bitmap=()=>++calls===1?old.promise:current.promise;
 ws.message(jpegWire(3,2n,1n).buffer);await tick();ws.closed();
 f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});
 const next=f.sockets[1]!;next.open();next.message(jpegWire(1,1n,1n,jpegSession()).buffer);await tick();
 f.controller.message({type:"reset-complete",generation:4,discardThroughSequence:0n});next.message(jpegWire(3,2n,1n).buffer);await tick();
 assert.equal(calls,1);const late=new TestBitmap();old.resolve(late);await tick();assert.equal(late.closes,1);assert.deepEqual(jpegAcks(next),[]);
 const image=new TestBitmap();current.resolve(image);await tick();const output=bitmapPosts(f).at(-1)!.message;
 assert.deepEqual([output.generation,output.sequence],[4,2n]);image.close();f.controller.message({type:"frame-complete",generation:4,sequence:2n,presented:true});
 assert.deepEqual(jpegAcks(next),[{v:1,type:"ack",sequence:"2",paintedSequence:"2"}]);
});
test("a second assigned JPEG before completion fails without starting another native decode",async()=>{
 const {f,ws}=await jpegReady(),flight=bitmapResult();let calls=0;f.adapters.bitmap=()=>{calls++;return flight.promise;};
 ws.message(jpegWire(3,2n,1n).buffer);ws.message(jpegWire(3,3n,1n).buffer);await tick();
 assert.equal(calls,1);assert.equal(f.posts.some(p=>p.message.code==="malformed-media"),true);
 const late=new TestBitmap();flight.resolve(late);await tick();assert.equal(late.closes,1);assert.equal(bitmapPosts(f).length,0);
});

test("JPEG local first-Live evidence excludes preflight and hidden WebSocket time",async()=>{
 const f=fixture();let now=0;f.adapters.now=()=>now;f.adapters.bitmap=async()=>new TestBitmap();jpegStart(f,false);await tick();
 now=4000;f.posts.find(p=>p.message.type==="capability-probe")!.message.frame.close();
 f.controller.message({type:"capability-result",generation:1,supported:true});f.sockets[0]!.open();
 assert.equal(f.posts.some(p=>p.message.type==="metrics"),false);now=9000;f.controller.message({type:"visibility",visible:true});
 assert.equal(f.posts.find(p=>p.message.type==="metrics")!.message.sample.openedAt,9000);
 assert.equal(parsed(f.sockets[0]!).filter(v=>v.type==="lease-renew"&&v.visible===true).length,1);
});

test("back-to-back JPEG Session and Frame stay eligible through reset with unchanged visibility",async()=>{
 const f=fixture();let calls=0;f.adapters.bitmap=async()=>{calls++;return new TestBitmap();};jpegStart(f);await tick();
 f.posts.find(p=>p.message.type==="capability-probe")!.message.frame.close();
 f.controller.message({type:"capability-result",generation:1,supported:true});const ws=f.sockets[0]!;ws.open();
 // Both receipts precede Session processing, so decoder generation legitimately changes in between.
 ws.message(jpegWire(1,1n,1n,jpegSession()).buffer);ws.message(jpegWire(3,2n,1n).buffer);await tick();
 assert.equal(calls,1);assert.deepEqual(bitmapPosts(f),[]);assert.deepEqual(jpegAcks(ws),[]);
 f.controller.message({type:"visibility",visible:true});
 f.controller.message({type:"reset-complete",generation:2,discardThroughSequence:0n});await tick();
 const output=bitmapPosts(f).at(-1)!.message;
 assert.deepEqual([output.generation,output.sequence,output.fresh],[2,2n,true]);assert.equal(calls,2);
 output.frame.close();f.controller.message({type:"frame-complete",generation:2,sequence:2n,presented:true});
 assert.equal(output.frame.closes,1);assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"2"}]);
});

test("hidden encoded receipt releases once after return; GAP adds no ACK and a new epoch image can paint",async()=>{
 const {f,ws}=await jpegReady();let calls=0;f.adapters.bitmap=async()=>{calls++;return new TestBitmap();};
 f.controller.message({type:"visibility",visible:false});ws.message(jpegWire(3,2n,1n).buffer);
 f.controller.message({type:"visibility",visible:true});
 f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});await tick();
 assert.equal(calls,0);assert.deepEqual(bitmapPosts(f),[]);
 assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"}]);
 ws.message(jpegWire(4,3n,1n,payloadGap(2n,3)).buffer);await tick();
 f.controller.message({type:"reset-complete",generation:4,discardThroughSequence:2n});
 assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"}]);
 ws.message(jpegWire(1,4n,2n,jpegSession()).buffer);ws.message(jpegWire(3,5n,2n).buffer);await tick();
 const output=bitmapPosts(f).at(-1)!.message;assert.deepEqual([output.generation,output.epoch,output.sequence],[4,2n,5n]);
 assert.equal(calls,1);output.frame.close();f.controller.message({type:"frame-complete",generation:4,sequence:5n,presented:true});
 assert.deepEqual(jpegAcks(ws),[{v:1,type:"ack",sequence:"2",paintedSequence:"0"},{v:1,type:"ack",sequence:"5",paintedSequence:"5"}]);
});

test("visibility-ineligible encoded input still rejects malformed sequence, epoch and JPEG before release",async()=>{
 for(const fault of ["sequence","epoch","jpeg"]){
  const {f,ws}=await jpegReady();let calls=0;f.adapters.bitmap=async()=>{calls++;return new TestBitmap();};
  ws.message(jpegWire(3,fault==="sequence"?3n:2n,fault==="epoch"?2n:1n,
   fault==="jpeg"?Uint8Array.of(0xff,0xd8,0xff,0xd9):undefined).buffer);
  f.controller.message({type:"visibility",visible:false});f.controller.message({type:"visibility",visible:true});
  f.controller.message({type:"reset-complete",generation:3,discardThroughSequence:0n});await tick();
  assert.equal(calls,0);assert.deepEqual(bitmapPosts(f),[]);assert.deepEqual(jpegAcks(ws),[]);
  assert.equal(f.posts.some(p=>p.message.code==="malformed-media"),true);assert.equal(ws.closes.at(-1),1008);
 }
});
