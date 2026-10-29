import assert from "node:assert/strict";
import test from "node:test";
import { request, type IncomingHttpHeaders } from "node:http";
import { createRequire } from "node:module";
import { decodeMediaHeader, MEDIA_KIND } from "../../contracts/src/index.js";
import { WdaMjpegCaptureAdapter } from "../../capture/src/index.js";
import { deviceRef, jpeg, loopback, part, RESPONSE, waitFor } from "../../capture/test/wda-fixtures.js";
import { createRuntimeService, type RuntimeServiceOptions } from "../src/index.js";
import { fixture, KEY } from "./support/runtime-fixtures.js";
interface Client {
  on(name: string, handler: (...args: unknown[]) => void): void;
  once(name: string, handler: (...args: unknown[]) => void): void;
  send(data: string): void; ping(): void; close(): void; terminate(): void;
}
// ws has no installed declaration package; this is its existing pinned test-client boundary.
const wsModule = createRequire(import.meta.url)("ws") as {WebSocket: new(url:string, protocol:string, options:object) => Client};
const Client = wsModule.WebSocket;
const call = (origin: string, method: string, path: string, body?: unknown, headers: Record<string,string> = {}): Promise<{status:number;headers:IncomingHttpHeaders;body:string}> => new Promise((resolve,reject) => {
  const text = body === undefined ? undefined : JSON.stringify(body);
  const req = request(new URL(path, origin), {method,headers:{...(text === undefined ? {} : {"Content-Type":"application/json; charset=utf-8","Content-Length":Buffer.byteLength(text)}),...headers}}, res => {
    const chunks: Buffer[] = []; res.on("data", chunk => chunks.push(Buffer.from(chunk)));
    res.on("end", () => resolve({status:res.statusCode!,headers:res.headers,body:Buffer.concat(chunks).toString()}));
  });
  req.on("error", reject); req.end(text);
});
const cookie = (headers: IncomingHttpHeaders) => headers["set-cookie"]![0]!.split(";")[0]!;
async function prepared() {
  const external = await loopback(), {clock,manifest} = fixture();
  const options = {mediaProfile:"mjpeg" as "mjpeg" | "h264-annexb",manifest,captureSource:new WdaMjpegCaptureAdapter({deviceRef,endpoint:external.endpoint}),clock};
  const service = createRuntimeService(options);
  // The trusted option is copied, not read again at bind or HTML generation.
  options.mediaProfile = "h264-annexb";
  try {
    const ensured = await service.ensureStandaloneViewer({deviceRef,idempotencyKey:KEY}); assert.ok(ensured.ok);
    const streamId = ensured.value.snapshot.streamId, origin = service.origin!;
    const browser = (extra: Record<string,string> = {}) => ({Origin:origin,"Sec-Fetch-Site":"same-origin","Sec-Fetch-Mode":"cors","Sec-Fetch-Dest":"empty",...extra});
    const page = await call(origin,"GET",`/viewer/${streamId}`,undefined,{"Sec-Fetch-Site":"none","Sec-Fetch-Mode":"navigate","Sec-Fetch-Dest":"document"});
    assert.equal(page.status,200); assert.equal(page.headers["cache-control"],"no-store");
    assert.match(page.body,/<html data-media-profile="mjpeg">/); assert.equal(page.body.match(/data-media-profile=/g)?.length,1);
    assert.match(String(page.headers["content-security-policy"]),/frame-ancestors 'none'/);
    assert.equal(external.requests.length,0);
    const claimCookie=cookie(page.headers);
    const issued = await call(origin,"POST","/v1/sessions",{streamId},browser({Cookie:claimCookie})); assert.equal(issued.status,204);
    let mediaCookie = cookie(issued.headers);
    const connect = async () => {
      const ws = new Client(origin.replace("http:","ws:")+"/v1/stream","fsq-viewer.v1",{origin,headers:{Cookie:mediaCookie},perMessageDeflate:false});
      const messages: Uint8Array[] = [];
      ws.on("message", data => messages.push(new Uint8Array(data as ArrayBufferLike)));
      await new Promise<void>((resolve,reject) => {ws.once("open",()=>resolve());ws.once("error",reject);});
      return {ws,messages};
    };
    const sessionCall = async (method: "POST" | "DELETE") => {
      const result = await call(origin,method,method==="POST"?"/v1/sessions/refresh":"/v1/sessions/current",method==="POST"?{visible:true}:undefined,browser({Cookie:mediaCookie}));
      if(result.status===204)mediaCookie=cookie(result.headers);
      return result;
    };
    const snapshot = () => { const result = service.inspect({streamId}); assert.ok(result.ok); return result.value.snapshot; };
    return {external,clock,service,streamId,connect,snapshot,sessionCall};
  } catch (error) { await service.close(); await external.close(); throw error; }
}
// Ping/pong is only a network barrier: app messages before it have reached Runtime.
async function send(ws: Client, value: unknown): Promise<void> {
  const pong = new Promise<void>((resolve,reject) => {
    const timer = setTimeout(()=>reject(new Error("Synthetic socket barrier timed out")),5000);
    ws.once("pong",()=>{clearTimeout(timer);resolve();});
  });
  ws.send(JSON.stringify(value)); ws.ping(); await pong;
}
const renew = (ws: Client, visible = true) => send(ws,{v:1,type:"lease-renew",visible,creditFrames:visible?4:0,creditBytes:visible?8_388_608:0});
const hello = (ws: Client, streamId: string) => send(ws,{v:1,type:"hello",streamId});
const ack = (ws: Client, sequence: bigint) => send(ws,{v:1,type:"ack",sequence:String(sequence),paintedSequence:String(sequence)});
const frames = (messages: Uint8Array[]) => messages.filter(message=>decodeMediaHeader(message).kind===MEDIA_KIND.frame);

test("actual WDA Adapter plus protected Runtime synthetic TCP smoke: paint, stale, recovery, epoch, reconnect, terminal cleanup", async () => {
  const f = await prepared(); let ws: Client | undefined;
  try {
    const first = await f.connect(); ws = first.ws; await hello(ws,f.streamId);
    assert.equal(f.external.requests.length,0); await renew(ws);
    const source = await f.external.client(), image = jpeg(8,16,1);
    source.write(Buffer.concat([RESPONSE,part(image)])); await waitFor(()=>frames(first.messages).length===1);
    const headers = first.messages.map(decodeMediaHeader);
    assert.deepEqual(headers.map(h=>[h.minor,h.kind]),[[1,1],[1,3]]);
    assert.equal(new DataView(first.messages[0]!.buffer,first.messages[0]!.byteOffset+40).getUint32(0),0x6d6a7067);
    assert.deepEqual(Buffer.from(frames(first.messages)[0]!.subarray(40)),image);
    assert.equal(f.snapshot().phase,"syncing");
    await ack(ws,headers[1]!.sequence); await waitFor(()=>f.snapshot().phase==="streaming");
    for(let i=0;i<2;i++){await renew(ws);f.clock.tick(1000);}
    await waitFor(()=>f.snapshot().phase==="interrupted"); assert.equal(f.snapshot().reason,"stream-interrupted");
    source.write(part(image)); await waitFor(()=>frames(first.messages).length===2);
    await ack(ws,decodeMediaHeader(frames(first.messages)[1]!).sequence); await waitFor(()=>f.snapshot().phase==="streaming");
    source.write(part(image)); await waitFor(()=>frames(first.messages).length===3);
    const old = decodeMediaHeader(frames(first.messages)[2]!).sequence;
    await renew(ws,false); await waitFor(()=>f.snapshot().phase==="grace");
    source.write(part(jpeg(8,16,6)));
    await waitFor(()=>first.messages.some(message=>{const h=decodeMediaHeader(message);return h.kind===1&&h.epoch===2n;}));
    assert.equal(f.snapshot().phase,"grace");assert.equal(f.snapshot().activeViewerCount,0);f.clock.tick(4000);
    await renew(ws); await waitFor(()=>f.snapshot().phase==="syncing"); await ack(ws,old);
    assert.equal(f.snapshot().phase,"syncing");
    source.write(part(jpeg(8,16,6))); await waitFor(()=>frames(first.messages).length===4);
    const rotated = decodeMediaHeader(frames(first.messages)[3]!); assert.equal(rotated.epoch,2n);
    assert.deepEqual(first.messages.slice(-3).map(message=>decodeMediaHeader(message).kind),[4,1,3]);
    await ack(ws,rotated.sequence); await waitFor(()=>f.snapshot().phase==="streaming");
    ws.close(); await waitFor(()=>f.snapshot().phase==="grace");
    const second = await f.connect(); ws = second.ws; await hello(ws,f.streamId); await renew(ws);
    source.write(part(jpeg(8,16,6))); await waitFor(()=>frames(second.messages).length===1);
    await ack(ws,decodeMediaHeader(frames(second.messages)[0]!).sequence); await waitFor(()=>f.snapshot().phase==="streaming");
    assert.equal(f.external.requests.length,1); assert.equal(source.destroyed,false);
    for(let i=0;i<12;i++){await renew(ws);f.clock.tick(1000);}
    await waitFor(()=>f.snapshot().phase==="failed");
    const final = f.snapshot(); assert.equal(final.reason,"stream-interrupted"); assert.ok(Object.isFrozen(final));
    await waitFor(()=>second.messages.some(message=>decodeMediaHeader(message).kind===MEDIA_KIND.end));
    assert.equal(second.messages.filter(message=>decodeMediaHeader(message).kind===MEDIA_KIND.end).length,1);
    assert.equal(decodeMediaHeader(second.messages.at(-1)!).kind,MEDIA_KIND.end);
    await waitFor(()=>f.external.sockets.size===0); assert.equal(f.external.server.listening,true);
    const stopped = await f.service.stop({streamId:f.streamId,reason:"explicit-stop"}); assert.ok(stopped.ok); assert.equal(stopped.value.snapshot,final);
  } finally { ws?.terminate(); await f.service.close(); await f.external.close(); }
});
test("late painted ACK at exactly startup 5s loses to the authoritative deadline even before timer callbacks", async () => {
  const f = await prepared(); let ws: Client | undefined;
  try {
    const connected = await f.connect(); ws = connected.ws; await hello(ws,f.streamId); await renew(ws);
    const source = await f.external.client(); source.write(Buffer.concat([RESPONSE,part(jpeg())]));
    await waitFor(()=>frames(connected.messages).length===1);
    f.clock.advanceWithoutTimers(5000);
    ws.send(JSON.stringify({v:1,type:"ack",sequence:"2",paintedSequence:"2"}));
    await waitFor(()=>f.snapshot().phase==="failed"); assert.equal(f.snapshot().reason,"start-timeout");
    await waitFor(()=>connected.messages.some(message=>decodeMediaHeader(message).kind===5));
    assert.deepEqual(connected.messages.map(message=>decodeMediaHeader(message).kind),[1,3,5]);
    await waitFor(()=>f.external.sockets.size===0);
  } finally { ws?.terminate(); await f.service.close(); await f.external.close(); }
});
test("missing and invalid profile fail locally before reading source or manifest", () => {
  let touched=0;
  for(const mediaProfile of [undefined,null,"", "ios", "mjpeg\" injected"]) {
    const options={mediaProfile,get captureSource(){touched++;throw new Error("must not allocate");},get manifest(){touched++;throw new Error("must not bind");}};
    assert.throws(()=>createRuntimeService(options as unknown as RuntimeServiceOptions),{name:"TypeError",message:"Invalid media profile"});
  }
  assert.equal(touched,0);
});

test("grace expiry stops only FSQ observation and source EOF is never physical disconnect", async () => {
  for (const hidden of [true,false]) {
    const f=await prepared();let ws:Client|undefined;
    try {
      const connected=await f.connect();ws=connected.ws;await hello(ws,f.streamId);await renew(ws);
      const source=await f.external.client();source.write(Buffer.concat([RESPONSE,part(jpeg())]));
      await waitFor(()=>frames(connected.messages).length===1);await ack(ws,2n);
      if(hidden){await renew(ws,false);await waitFor(()=>f.snapshot().phase==="grace");f.clock.tick(5000);}else source.end();
      await waitFor(()=>["stopped","failed"].includes(f.snapshot().phase));
      assert.equal(f.snapshot().phase,hidden?"stopped":"failed");
      assert.equal(f.snapshot().reason,hidden?"lease-expired":"stream-interrupted");
      await waitFor(()=>f.external.sockets.size===0);assert.equal(f.external.server.listening,true);
    } finally {ws?.terminate();await f.service.close();await f.external.close();}
  }
});

test("hello-only reconnects and HTTP refresh preserve the original no-demand deadline, including delayed timers", async () => {
  for (const delayed of [false,true]) {
    const f=await prepared();let ws:Client|undefined;
    try {
      const first=await f.connect();ws=first.ws;await hello(ws,f.streamId);await renew(ws);
      const source=await f.external.client();source.write(Buffer.concat([RESPONSE,part(jpeg())]));
      await waitFor(()=>frames(first.messages).length===1);await ack(ws,2n);
      ws.close();await waitFor(()=>f.snapshot().phase==="grace");
      for(let i=0;i<2;i++){
        f.clock.tick(1000);const next=await f.connect();ws=next.ws;await hello(ws,f.streamId);
        assert.equal((await f.sessionCall("POST")).status,204);
        assert.equal(f.snapshot().phase,"grace");assert.equal(f.snapshot().activeViewerCount,0);
        if(i===0){const closed=new Promise<void>(resolve=>ws!.once("close",()=>resolve()));ws.close();await closed;}
      }
      f.clock.tick(2999);assert.equal(source.destroyed,false);assert.equal(f.external.requests.length,1);
      if(delayed){f.clock.advanceWithoutTimers(1);ws.send(JSON.stringify({v:1,type:"lease-renew",visible:true,creditFrames:4,creditBytes:8_388_608}));}
      else f.clock.tick(1);
      await waitFor(()=>f.snapshot().phase==="stopped");assert.equal(f.snapshot().reason,"lease-expired");
      await waitFor(()=>f.external.sockets.size===0);assert.equal(f.external.requests.length,1);assert.equal(f.external.server.listening,true);
    } finally {ws?.terminate();await f.service.close();await f.external.close();}
  }
});

test("DELETE and session TTL synchronously fence old paint, epoch and invalid visible renewal", async () => {
  for (const loss of ["delete","ttl","delayed-ttl"]) {
    const f=await prepared();let ws:Client|undefined;
    try {
      const connected=await f.connect();ws=connected.ws;await hello(ws,f.streamId);await renew(ws);
      const source=await f.external.client();source.write(Buffer.concat([RESPONSE,part(jpeg())]));
      await waitFor(()=>frames(connected.messages).length===1);await ack(ws,2n);
      if(loss!=="delete")for(let i=0;i<59;i++){
        f.clock.tick(1000);await renew(ws);source.write(part(jpeg()));
        await waitFor(()=>frames(connected.messages).length===i+2);await ack(ws,decodeMediaHeader(frames(connected.messages).at(-1)!).sequence);
      }
      const count=frames(connected.messages).length;source.write(part(jpeg()));
      await waitFor(()=>frames(connected.messages).length===count+1);
      const old=decodeMediaHeader(frames(connected.messages).at(-1)!).sequence,revision=f.snapshot().revision;
      if(loss==="delete")assert.equal((await f.sessionCall("DELETE")).status,204);
      else if(loss==="ttl")f.clock.tick(1000);
      else f.clock.advanceWithoutTimers(1000);
      if(loss!=="delayed-ttl"){
        await waitFor(()=>f.snapshot().phase==="grace");await ack(ws,old);
        source.write(part(jpeg(8,16,6)));
        await new Promise<void>(resolve=>setImmediate(resolve));
        assert.equal(connected.messages.some(message=>{const h=decodeMediaHeader(message);return h.kind===1&&h.epoch===2n;}),false);assert.equal(f.snapshot().phase,"grace");assert.equal(f.snapshot().activeViewerCount,0);
      }
      const closed=new Promise<void>(resolve=>ws!.once("close",()=>resolve()));
      ws.send(JSON.stringify({v:1,type:"lease-renew",visible:true,creditFrames:4,creditBytes:8_388_608}));
      ws.send(JSON.stringify({v:1,type:"ack",sequence:String(old),paintedSequence:String(old)}));
      await closed;
      await waitFor(()=>f.snapshot().phase==="grace");
      const inspected=f.service.inspect({streamId:f.streamId,afterRevision:revision});assert.ok(inspected.ok);
      assert.ok(inspected.value.changes.every(snapshot=>snapshot.phase==="grace"&&snapshot.activeViewerCount===0));
      f.clock.tick(4999);assert.equal(f.snapshot().phase,"grace");f.clock.tick(1);
      await waitFor(()=>f.snapshot().phase==="stopped");assert.equal(f.snapshot().reason,"lease-expired");
      await waitFor(()=>f.external.sockets.size===0);assert.equal(f.external.requests.length,1);
    } finally {ws?.terminate();await f.service.close();await f.external.close();}
  }
});
