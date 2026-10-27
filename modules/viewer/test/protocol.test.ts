import assert from "node:assert/strict";import test from "node:test";
import { encodeMediaHeader,MAX_FRAME_BYTES } from "../../contracts/src/index.js";import { absoluteMonotonicNow,MediaProtocol,ProtocolError,parseAnnexBConfig } from "../src/protocol.js";
import { boundedImage, jpegSize } from "../src/jpeg.js";
import { jpegSession, jpegWire, JPEG_PROBE } from "./bitmap-fixtures.js";
const CONFIG=Uint8Array.of(0,0,0,1,0x67,0x64,0,0x28,0,0,1,0x68,1),bad=()=>new MediaProtocol(),throws=(run:()=>unknown)=>assert.throws(run,ProtocolError);
function session(width=720):Uint8Array{const p=new Uint8Array(24),v=new DataView(p.buffer);v.setUint32(0,0x68323634);v.setUint32(4,width);v.setUint32(8,1280);v.setUint32(12,width);v.setUint32(16,1280);v.setUint32(20,1_000_000);return p;}
function gap(reason=1,watermark=0n):Uint8Array{const p=new Uint8Array(12),v=new DataView(p.buffer);v.setUint32(0,reason);v.setBigUint64(4,watermark);return p;}
function end(reason=1):Uint8Array{const p=new Uint8Array(4);new DataView(p.buffer).setUint32(0,reason);return p;}
function msg(kind:1|2|3|4|5,sequence:bigint,epoch:bigint,payload:Uint8Array,flags=0,pts=-1n):Uint8Array{const h=encodeMediaHeader({minor:0,kind,flags,payloadBytes:payload.length,sequence,epoch,ptsUs:pts}),r=new Uint8Array(40+payload.length);r.set(h);r.set(payload,40);return r;}

test("absolute monotonic clock aligns distinct globals and rejects invalid values",()=>{assert.equal(absoluteMonotonicNow({timeOrigin:1_000,now:()=>600}),1_600);assert.equal(absoluteMonotonicNow({timeOrigin:1_500,now:()=>100}),1_600);for(const clock of [{timeOrigin:-1,now:()=>1},{timeOrigin:1,now:()=>-1},{timeOrigin:Infinity,now:()=>0},{timeOrigin:0,now:()=>NaN},{timeOrigin:Number.MAX_VALUE,now:()=>Number.MAX_VALUE}])assert.throws(()=>absoluteMonotonicNow(clock),TypeError);});
test("Annex-B accepts exact SPS/PPS and derives lowercase avc1",()=>{assert.equal(parseAnnexBConfig(CONFIG),"avc1.640028");assert.equal(parseAnnexBConfig(Uint8Array.of(0,0,1,0x67,0x42,0x40,0x1e,0,0,0,1,0x68,1)),"avc1.42401e");});
test("Annex-B rejects malformed starts, NAL sets and SPS bytes",()=>{for(const value of [Uint8Array.of(),Uint8Array.of(1,0x67,1,0,1),Uint8Array.of(0,0,1),Uint8Array.of(0,0,1,0x67,0x64,0,0x28),Uint8Array.of(...CONFIG,0,0,1,0x68,1),Uint8Array.of(0,0,1,0x69,1,0,0,1,0x68,1),Uint8Array.of(0,0,1,0xe7,0x64,0,0x28,0,0,1,0x68,1),Uint8Array.of(0,0,1,0x67,0,0,0x28,0,0,1,0x68,1),Uint8Array.of(0,0,1,0x67,0x64,3,0x28,0,0,1,0x68,1),Uint8Array.of(0,0,1,0x67,0x64,0,0,0,0,1,0x68,1)])throws(()=>parseAnnexBConfig(value));});

test("session/config enforce first-key order",()=>{const p=new MediaProtocol();assert.equal(p.accept(msg(1,1n,1n,session())).type,"session");assert.equal(p.accept(msg(2,2n,1n,CONFIG)).type,"config");throws(()=>p.accept(msg(3,3n,1n,Uint8Array.of(1),0,3n)));});
test("first synchronization key carries config once and later IDR does not",()=>{const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));const key=p.accept(msg(3,3n,1n,Uint8Array.of(5),1,BigInt(Number.MAX_SAFE_INTEGER))),later=p.accept(msg(3,4n,1n,Uint8Array.of(6),1,BigInt(Number.MAX_SAFE_INTEGER)));assert.equal(key.type,"frame");if(key.type==="frame")assert.deepEqual([key.ptsUs,key.key,key.config],[Number.MAX_SAFE_INTEGER,true,CONFIG]);assert.equal(later.type,"frame");if(later.type==="frame")assert.equal(later.config,undefined);});
test("unsafe, negative, wrong epoch, duplicate config and sequence faults close",()=>{for(const act of [(p:MediaProtocol)=>p.accept(msg(3,3n,1n,Uint8Array.of(1),1,-1n)),(p:MediaProtocol)=>p.accept(msg(3,3n,1n,Uint8Array.of(1),1,BigInt(Number.MAX_SAFE_INTEGER)+1n)),(p:MediaProtocol)=>p.accept(msg(3,3n,2n,Uint8Array.of(1),1,0n)),(p:MediaProtocol)=>p.accept(msg(2,3n,1n,CONFIG)),(p:MediaProtocol)=>p.accept(msg(3,4n,1n,Uint8Array.of(1),1,0n))]){const p=bad();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));throws(()=>act(p));}});

test("GAP reasons 1/2 require identical same-epoch session/config replay",()=>{for(const reason of [1,2]){const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));const g=p.accept(msg(4,3n,1n,gap(reason,0n)));assert.deepEqual(g,{type:"gap",epoch:1n,reason,discardThroughSequence:0n});assert.equal(p.accept(msg(1,4n,1n,session())).type,"session");assert.equal(p.accept(msg(2,5n,1n,CONFIG)).type,"config");assert.equal(p.accept(msg(3,6n,1n,Uint8Array.of(9),1,0n)).type,"frame");}});
test("GAP replay watermark, order, changed config and wrong higher epoch are terminal",()=>{const setup=()=>{const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));p.accept(msg(3,3n,1n,Uint8Array.of(1),1,0n));p.accept(msg(4,4n,1n,gap(1,3n)));return p;};throws(()=>setup().accept(msg(2,5n,1n,CONFIG)));throws(()=>setup().accept(msg(1,5n,2n,session())));const p=setup();p.accept(msg(1,5n,1n,session()));throws(()=>p.accept(msg(2,6n,1n,Uint8Array.of(...CONFIG.slice(0,-1),2))));const future=new MediaProtocol();future.accept(msg(1,1n,1n,session()));throws(()=>future.accept(msg(4,2n,1n,gap(1,1n))));});
test("transport-resync reason 3 requires strictly higher epoch session, new config and key",()=>{const setup=()=>{const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));p.accept(msg(4,3n,1n,gap(3,0n)));return p;};const same=setup();throws(()=>same.accept(msg(1,4n,1n,session())));const configFirst=setup();throws(()=>configFirst.accept(msg(2,4n,1n,CONFIG)));const frameFirst=setup();throws(()=>frameFirst.accept(msg(3,4n,1n,Uint8Array.of(1),1,0n)));const valid=setup();assert.equal(valid.accept(msg(1,4n,2n,session())).type,"session");assert.equal(valid.accept(msg(2,5n,2n,CONFIG)).type,"config");assert.equal(valid.accept(msg(3,6n,2n,Uint8Array.of(1),1,0n)).type,"frame");});
test("transport resync preserves per-connection GAP watermark across epoch rotation",()=>{const setup=()=>{const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));p.accept(msg(3,3n,1n,Uint8Array.of(1),1,0n));p.accept(msg(4,4n,1n,gap(3,3n)));p.accept(msg(1,5n,2n,session()));p.accept(msg(2,6n,2n,CONFIG));p.accept(msg(3,7n,2n,Uint8Array.of(2),1,1n));return p;};throws(()=>setup().accept(msg(4,8n,2n,gap(1,2n))));const valid=setup();assert.deepEqual(valid.accept(msg(4,8n,2n,gap(1,7n))),{type:"gap",epoch:2n,reason:1,discardThroughSequence:7n});const fresh=new MediaProtocol();assert.equal(fresh.discardThrough,0n);fresh.accept(msg(1,1n,1n,session()));fresh.accept(msg(2,2n,1n,CONFIG));assert.equal(fresh.accept(msg(4,3n,1n,gap(3,0n))).type,"gap");});

test("new epochs strictly increase and clear readiness",()=>{const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));p.accept(msg(2,2n,1n,CONFIG));p.accept(msg(3,3n,1n,Uint8Array.of(1),1,0n));assert.equal(p.accept(msg(1,4n,2n,session())).type,"session");p.accept(msg(2,5n,2n,CONFIG));throws(()=>p.accept(msg(3,6n,2n,Uint8Array.of(1),0,1n)));const q=new MediaProtocol();q.accept(msg(1,1n,2n,session()));throws(()=>q.accept(msg(1,2n,2n,session())));});
test("END is unique, current-epoch and terminal",()=>{const before=new MediaProtocol();assert.deepEqual(before.accept(msg(5,1n,0n,end(2))),{type:"end",reason:2});throws(()=>before.accept(msg(5,2n,0n,end(2))));for(const reason of [0,5])throws(()=>bad().accept(msg(5,1n,0n,end(reason))));const p=new MediaProtocol();p.accept(msg(1,1n,1n,session()));throws(()=>p.accept(msg(5,2n,0n,end(1))));});
test("envelope rejects text-equivalent, gaps, trailing bytes, illegal header and over-limit frame",()=>{throws(()=>bad().accept(new TextEncoder().encode("binary")));throws(()=>bad().accept(msg(1,2n,1n,session())));const trailing=new Uint8Array(msg(1,1n,1n,session()).length+1);trailing.set(msg(1,1n,1n,session()));throws(()=>bad().accept(trailing));const reserved=msg(1,1n,1n,session());new DataView(reserved.buffer).setUint16(10,1);throws(()=>bad().accept(reserved));assert.throws(()=>msg(3,1n,1n,new Uint8Array(MAX_FRAME_BYTES+1),1,0n));});

test("minor1 Session/key JPEG uses shared strict envelope and a no-copy bounded payload view",()=>{
 const p=new MediaProtocol("mjpeg"),session=p.accept(jpegWire(1,1n,1n,jpegSession()));
 assert.equal(session.type,"session");if(session.type==="session")assert.equal(session.session.codec,"mjpeg");
 const wire=jpegWire(3,2n,1n),image=p.accept(wire);assert.equal(image.type,"frame");
 if(image.type==="frame"){assert.equal(image.bytes.buffer,wire.buffer);assert.equal(image.bytes.byteOffset,40);assert.equal(image.config,undefined);}
 assert.deepEqual(jpegSize(JPEG_PROBE),{width:1,height:2});
});
test("minor/codec mismatch, JPEG Config/non-key, wrong epoch/PTS, trailing bytes and sequence fail closed",()=>{
 const setup=()=>{const p=new MediaProtocol();p.accept(jpegWire(1,1n,1n,jpegSession()));return p;};
 for(const [minor,payload]of [[0,jpegSession()],[1,session()]]as const){const bytes=msg(1,1n,1n,payload);bytes[5]=minor;throws(()=>bad().accept(bytes));}
 const config=msg(2,2n,1n,CONFIG);config[5]=1;throws(()=>setup().accept(config));
 const nonkey=jpegWire(3,2n,1n);nonkey[7]=0;throws(()=>setup().accept(nonkey));
 throws(()=>setup().accept(jpegWire(3,2n,2n)));throws(()=>setup().accept(jpegWire(3,3n,1n)));
 const trailing=new Uint8Array(jpegWire(3,2n,1n).length+1);trailing.set(jpegWire(3,2n,1n));throws(()=>setup().accept(trailing));
 const mixed=jpegWire(3,2n,1n);mixed[5]=0;throws(()=>setup().accept(mixed));
 const unknown=jpegWire(1,1n,1n,jpegSession());unknown[5]=2;throws(()=>bad().accept(unknown));
 const regression=setup();regression.accept(jpegWire(3,2n,1n));const old=jpegWire(3,3n,1n);new DataView(old.buffer).setBigInt64(32,1n);throws(()=>regression.accept(old));
 const negative=jpegWire(3,2n,1n);new DataView(negative.buffer).setBigInt64(32,-1n);throws(()=>setup().accept(negative));
 throws(()=>new MediaProtocol("h264-annexb").accept(jpegWire(1,1n,1n,jpegSession())));
});
test("MJPEG reason3 requires strictly higher Session then key with no replay Config; reasons1/2 rejected",()=>{
 const setup=()=>{const p=new MediaProtocol();p.accept(jpegWire(1,1n,1n,jpegSession()));p.accept(jpegWire(3,2n,1n));return p;};
 for(const reason of [1,2])throws(()=>setup().accept(jpegWire(4,3n,1n,gap(reason,2n))));
 const reset=()=>{const p=setup();p.accept(jpegWire(4,3n,1n,gap(3,2n)));return p;};
 throws(()=>reset().accept(jpegWire(1,4n,1n,jpegSession())));throws(()=>reset().accept(jpegWire(3,4n,2n)));
 const valid=reset();valid.accept(jpegWire(1,4n,2n,jpegSession()));assert.equal(valid.accept(jpegWire(3,5n,2n)).type,"frame");
 assert.deepEqual(valid.accept(jpegWire(5,6n,2n,end())),{type:"end",reason:1});throws(()=>valid.accept(jpegWire(3,7n,2n)));
 const future=setup();throws(()=>future.accept(jpegWire(4,3n,1n,gap(3,3n))));
});
test("JPEG guard enforces complete scan, bounded SOF, exact encoded cap and Session dimensions before native decode",()=>{
 const dimensions=(width:number,height:number)=>{const bytes=JPEG_PROBE.slice(),sof=bytes.findIndex((value,index)=>value===255&&bytes[index+1]===192),view=new DataView(bytes.buffer);view.setUint16(sof+5,height);view.setUint16(sof+7,width);return bytes;};
 for(const [width,height]of [[0,2],[4097,1],[1,4097],[4096,2049]])assert.throws(()=>jpegSize(dimensions(width!,height!)));
 assert.deepEqual(jpegSize(dimensions(4096,2048)),{width:4096,height:2048});
 for(const value of [JPEG_PROBE.subarray(0,-1),Uint8Array.of(...JPEG_PROBE,0),Uint8Array.of(255,216,255,217)])assert.throws(()=>jpegSize(value));
 assert.equal(boundedImage(Number.MAX_SAFE_INTEGER,Number.MAX_SAFE_INTEGER),false);assert.equal(boundedImage(4096,2048),true);
 const p=new MediaProtocol();p.accept(jpegWire(1,1n,1n,jpegSession(2,1)));throws(()=>p.accept(jpegWire(3,2n,1n)));
 throws(()=>bad().accept(jpegWire(1,1n,1n,jpegSession(4096,2049))));
 const large=new Uint8Array(MAX_FRAME_BYTES);large.set(JPEG_PROBE.subarray(0,-2));large.set([255,217],large.length-2);
 assert.deepEqual(jpegSize(large),{width:1,height:2});assert.throws(()=>jpegSize(new Uint8Array(MAX_FRAME_BYTES+1)));
 const accepted=new MediaProtocol();accepted.accept(jpegWire(1,1n,1n,jpegSession()));assert.equal(accepted.accept(jpegWire(3,2n,1n,large)).type,"frame");
});
