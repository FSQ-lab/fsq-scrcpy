import { createHash as nodeHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";
import { createViewerAssetManifest, HTTP_SERVER_OPTIONS, takeHttpDelivery } from "../src/http.js";
import { body, cookieToken, ensured, hangingBody, request } from "./support/runtime-fixtures.js";

const hash = (bytes: Uint8Array): string => nodeHash("sha256").update(bytes).digest("hex");
const nativeHeaders = (authority: string): readonly (readonly [string,string])[] => [["Host",authority],["Sec-Fetch-Site","none"],["Sec-Fetch-Mode","navigate"],["Sec-Fetch-Dest","document"]];

async function claim() {
  const fixture = await ensured();
  const reply = await fixture.http.handle({ method:"GET", target:`/viewer/${fixture.snapshot.streamId}`, rawHeaders:nativeHeaders(fixture.http.authority) });
  assert.equal(reply.status,200);
  const delivery=takeHttpDelivery(reply);
  assert.ok(delivery);
  await delivery!.finish();
  return { ...fixture, claim:cookieToken(reply.headers["Set-Cookie"]!,"fsq_auto_v1") };
}

async function issued() {
  const fixture=await claim();
  const reply=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}`]]));
  assert.equal(reply.status,204);
  const delivery=takeHttpDelivery(reply);
  assert.ok(delivery);
  await delivery!.finish();
  return { ...fixture, media:cookieToken(reply.headers["Set-Cookie"]!) };
}
const embeddedOrigin=`vscode-webview://${"a".repeat(52)}`;
const embeddedRequest=(method:string,target:string,value?:string,extra:readonly(readonly[string,string])[]=[])=>( {method,target,rawHeaders:[["Host","127.0.0.1:43210"],["Origin",embeddedOrigin],["Sec-Fetch-Site","cross-site"],["Sec-Fetch-Mode","cors"],["Sec-Fetch-Dest","empty"],...(value===undefined?[]:[["Content-Type","application/json; charset=utf-8"],["Content-Length",String(Buffer.byteLength(value))]]),...extra] as readonly(readonly[string,string])[],...(value===undefined?{}:{body:body(value)})} );

test("viewer claim is transactional and HTML remains secret-free",async()=>{
  const fixture=await ensured();
  const first=await fixture.http.handle({method:"GET",target:`/viewer/${fixture.snapshot.streamId}`,rawHeaders:nativeHeaders(fixture.http.authority)});
  assert.equal(first.status,200);
  const claimToken=cookieToken(first.headers["Set-Cookie"]!,"fsq_auto_v1");
  assert.equal(new TextDecoder().decode(first.body).includes(claimToken),false);
  assert.match(String(first.headers["Content-Security-Policy"]),/frame-ancestors 'none'/);
  const other=await fixture.http.handle({method:"GET",target:`/viewer/${fixture.snapshot.streamId}`,rawHeaders:nativeHeaders(fixture.http.authority)});
  assert.equal(other.status,409);
  await takeHttpDelivery(first)!.rollback();
  const replacement=await fixture.http.handle({method:"GET",target:`/viewer/${fixture.snapshot.streamId}`,rawHeaders:nativeHeaders(fixture.http.authority)});
  assert.equal(replacement.status,200);
});

test("native and activated link navigation pass exact Fetch Metadata policy",async()=>{
  const native=await ensured();
  assert.equal((await native.http.handle({method:"GET",target:`/viewer/${native.snapshot.streamId}`,rawHeaders:nativeHeaders(native.http.authority)})).status,200);
  for(const site of ["same-origin","same-site","cross-site"]){
    const linked=await ensured();
    const headers:[[string,string],[string,string],[string,string],[string,string],[string,string]]=[["Host",linked.http.authority],["Sec-Fetch-Site",site],["Sec-Fetch-User","?1"],["Sec-Fetch-Mode","navigate"],["Sec-Fetch-Dest","document"]];
    assert.equal((await linked.http.handle({method:"GET",target:`/viewer/${linked.snapshot.streamId}`,rawHeaders:headers})).status,200);
  }
  for(const extra of [["Sec-Fetch-Site","cross-site"],["Sec-Fetch-Dest","iframe"],["Purpose","prefetch"],["Sec-Purpose","prerender"]] as const){
    const denied=await ensured();
    const headers=nativeHeaders(denied.http.authority).filter(([name])=>name.toLowerCase()!==extra[0].toLowerCase()).concat([extra]);
    assert.notEqual((await denied.http.handle({method:"GET",target:`/viewer/${denied.snapshot.streamId}`,rawHeaders:headers})).status,200);
  }
});

test("session POST requires exact body, claim cookie and browser headers",async()=>{
  const fixture=await claim();
  const valid=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}`]]));
  assert.equal(valid.status,204);
  assert.equal(cookieToken(valid.headers["Set-Cookie"]!).length,43);
  for(const invalid of [
    request("POST","/v1/sessions","{}",[["Cookie",`fsq_auto_v1=${fixture.claim}`]]),
    request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId,extra:true}),[["Cookie",`fsq_auto_v1=${fixture.claim}`]]),
    request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId})),
    request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}`],["Authorization","secret"]]),
  ]) assert.notEqual((await fixture.http.handle(invalid)).status,204);
});
test("embedded preflight and zero-body POST bind exactly one prepared origin before upgrade",async()=>{const fixture=await ensured();assert.ok((await fixture.auth.prepareEmbedded(fixture.snapshot.streamId)).ok);const preflight=await fixture.http.handle(embeddedRequest("OPTIONS","/v1/app-sessions",undefined,[["Access-Control-Request-Method","POST"]]));assert.equal(preflight.status,204);assert.equal(preflight.headers["Access-Control-Allow-Origin"],embeddedOrigin);const bound=await fixture.http.handle(embeddedRequest("POST","/v1/app-sessions"));assert.equal(bound.status,204);assert.equal(bound.headers["Access-Control-Allow-Origin"],embeddedOrigin);assert.equal(bound.headers["Set-Cookie"],undefined);const upgrade=await fixture.http.validateUpgrade({method:"GET",target:"/v1/stream",rawHeaders:[["Host",fixture.http.authority],["Origin",embeddedOrigin],["Sec-Fetch-Site","cross-site"],["Sec-Fetch-Mode","websocket"],["Sec-Fetch-Dest","empty"],["Upgrade","websocket"],["Connection","upgrade"],["Sec-WebSocket-Version","13"],["Sec-WebSocket-Key","AAAAAAAAAAAAAAAAAAAAAA=="],["Sec-WebSocket-Protocol","fsq-viewer.v1"]]});assert.ok(upgrade.ok);const second=await ensured();assert.equal((await second.http.handle(embeddedRequest("POST","/v1/app-sessions"))).status,409);});

test("session response rollback invalidates provisional media and retry succeeds",async()=>{
  const fixture=await claim();
  const first=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}`]]));
  const media=cookieToken(first.headers["Set-Cookie"]!);
  await takeHttpDelivery(first)!.rollback();
  const stale=await fixture.http.validateUpgrade({method:"GET",target:"/v1/stream",rawHeaders:[["Host",fixture.http.authority],["Origin",fixture.http.origin],["Sec-Fetch-Site","same-origin"],["Cookie",`fsq_media_v1=${media}`],["Upgrade","websocket"],["Connection","upgrade"],["Sec-WebSocket-Version","13"],["Sec-WebSocket-Key","AAAAAAAAAAAAAAAAAAAAAA=="],["Sec-WebSocket-Protocol","fsq-viewer.v1"]]});
  assert.equal(stale.ok,false);
  const retry=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}; fsq_media_v1=${media}`]]));
  assert.equal(retry.status,204);
});

test("committed session retry with claim and media is idempotent 204",async()=>{
  const fixture=await issued();
  const retry=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${fixture.claim}; fsq_media_v1=${fixture.media}`]]));
  assert.equal(retry.status,204);
  assert.equal(cookieToken(retry.headers["Set-Cookie"]!),fixture.media);
});

test("duplicate, unknown and malformed cookies fail before allocation",async()=>{
  const fixture=await claim();
  for(const cookie of [
    `fsq_auto_v1=${fixture.claim}; fsq_auto_v1=${fixture.claim}`,
    `unknown=${fixture.claim}`,
    "fsq_auto_v1=short",
    `fsq_auto_v1=${fixture.claim};unknown=x`,
  ]){
    const reply=await fixture.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:fixture.snapshot.streamId}),[["Cookie",cookie]]));
    assert.equal(reply.status,400);
  }
});

test("refresh rotates media, clears stale claim, and never renews visible demand",async()=>{
  const fixture=await issued();
  const reply=await fixture.http.handle(request("POST","/v1/sessions/refresh",JSON.stringify({visible:true}),[["Cookie",`fsq_auto_v1=${fixture.claim}; fsq_media_v1=${fixture.media}`]]));
  assert.equal(reply.status,204);
  assert.notEqual(cookieToken(reply.headers["Set-Cookie"]!),fixture.media);
  assert.ok((reply.headers["Set-Cookie"] as string[]).some(value=>value.startsWith("fsq_auto_v1=;")));
  assert.equal(fixture.auth.hasVisibleDemand(fixture.snapshot.streamId),false);
});

test("DELETE applies state-appropriate cookies and clears both names",async()=>{
  const fixture=await issued();
  const success=await fixture.http.handle(request("DELETE","/v1/sessions/current",undefined,[["Cookie",`fsq_auto_v1=${fixture.claim}; fsq_media_v1=${fixture.media}`]]));
  assert.equal(success.status,204);
  assert.deepEqual(success.headers["Set-Cookie"],["fsq_auto_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0","fsq_media_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0"]);
  const stale=await fixture.http.handle(request("DELETE","/v1/sessions/current",undefined,[["Cookie",`fsq_media_v1=${fixture.media}`]]));
  assert.equal(stale.status,401);
});


test("newly armed stream replaces stale claim and clears old media before session",async()=>{
  const old=await issued();
  assert.ok((await old.auth.stop({streamId:old.snapshot.streamId,reason:"explicit-stop"})).ok);
  const next=await old.auth.ensureStandaloneViewer({deviceRef:old.snapshot.deviceRef,idempotencyKey:"AQEBAQEBAQEBAQEBAQEBAQ"});
  assert.ok(next.ok);if(!next.ok)return;
  const page=await old.http.handle({method:"GET",target:`/viewer/${next.value.snapshot.streamId}`,rawHeaders:[...nativeHeaders(old.http.authority),["Cookie",`fsq_auto_v1=${old.claim}; fsq_media_v1=${old.media}`]]});
  assert.equal(page.status,200);
  const cookies=page.headers["Set-Cookie"] as string[];
  assert.equal(cookies.filter(value=>value.startsWith("fsq_auto_v1=")).length,2);
  assert.equal(cookies[0],"fsq_auto_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  assert.equal(cookies[1],"fsq_media_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");
  assert.match(cookies[2]!,/^fsq_auto_v1=[A-Za-z0-9_-]{43};/);
  const claimToken=cookieToken(cookies,"fsq_auto_v1");
  await takeHttpDelivery(page)!.finish();
  const session=await old.http.handle(request("POST","/v1/sessions",JSON.stringify({streamId:next.value.snapshot.streamId}),[["Cookie",`fsq_auto_v1=${claimToken}`]]));
  assert.equal(session.status,204);
});

test("provisional stale claim is cleared before replacement claim",async()=>{
  const f=await ensured(),first=await f.http.handle({method:"GET",target:`/viewer/${f.snapshot.streamId}`,rawHeaders:nativeHeaders(f.http.authority)}),stale=cookieToken(first.headers["Set-Cookie"]!,"fsq_auto_v1");
  await takeHttpDelivery(first)!.rollback();
  const replacement=await f.http.handle({method:"GET",target:`/viewer/${f.snapshot.streamId}`,rawHeaders:[...nativeHeaders(f.http.authority),["Cookie",`fsq_auto_v1=${stale}`]]}),cookies=replacement.headers["Set-Cookie"] as string[];
  assert.equal(cookies[0],"fsq_auto_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0");assert.match(cookies[1]!,/^fsq_auto_v1=[A-Za-z0-9_-]{43};/);
  await takeHttpDelivery(replacement)!.finish();
});
test("pairing and redeem routes are absent for every method",async()=>{
  const fixture=await ensured();
  for(const target of ["/v1/pairings","/v1/pairings/12345678-1234-4234-8234-123456789abc/redeem"]){
    for(const method of ["GET","POST","DELETE"]) assert.equal((await fixture.http.handle({method,target,rawHeaders:[["Host",fixture.http.authority]]})).status,404);
  }
});

test("asset manifest and immutable serving retain bounded exact behavior",async()=>{
  const bytes=new TextEncoder().encode("x"),sha=hash(bytes);
  assert.throws(()=>createViewerAssetManifest([{role:"entry-module",name:"app.js",sha256:sha,mime:"text/javascript; charset=utf-8",bytes}]));
  const fixture=await ensured();
  const asset=await fixture.http.handle({method:"GET",target:`/assets/${fixture.sha256}/app.js`,rawHeaders:[["Host",fixture.http.authority]]});
  assert.equal(asset.status,200);
  assert.deepEqual(asset.body,fixture.asset);
  assert.equal(HTTP_SERVER_OPTIONS.maxHeaderSize,8192);
});

test("body framing, size and read deadlines remain bounded",async()=>{
  const fixture=await claim();
  const path="/v1/sessions";
  const wrongType={...request("POST",path,"{}"),rawHeaders:[["Host",fixture.http.authority],["Origin",fixture.http.origin],["Sec-Fetch-Site","same-origin"],["Sec-Fetch-Mode","cors"],["Sec-Fetch-Dest","empty"],["Content-Type","application/json"],["Content-Length","2"]] as const};
  assert.equal((await fixture.http.handle(wrongType)).status,415);
  const slow={method:"POST",target:path,rawHeaders:[["Host",fixture.http.authority],["Origin",fixture.http.origin],["Sec-Fetch-Site","same-origin"],["Sec-Fetch-Mode","cors"],["Sec-Fetch-Dest","empty"],["Content-Type","application/json; charset=utf-8"],["Content-Length","2"]] as const,body:hangingBody()};
  const pending=fixture.http.handle(slow);fixture.clock.tick(2_000);assert.equal((await pending).status,400);
  const oversized={method:"POST",target:path,rawHeaders:[["Host",fixture.http.authority],["Origin",fixture.http.origin],["Sec-Fetch-Site","same-origin"],["Sec-Fetch-Mode","cors"],["Sec-Fetch-Dest","empty"],["Content-Type","application/json; charset=utf-8"],["Content-Length","4097"]] as const,body:body("x")};
  assert.equal((await fixture.http.handle(oversized)).status,413);
});
