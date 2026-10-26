import { createHash } from "node:crypto";
import type { Clock, Entropy } from "../../src/clock.js";
import { StateStore } from "../../src/state.js";
import { RuntimeLifecycle } from "../../src/auth.js";
import { createViewerAssetManifest, LoopbackHttp } from "../../src/http.js";
import type { HttpRequest } from "../../src/types.js";
export class FakeClock implements Clock {
  wallNow = 1_800_000_000_000; monoNow = 10_000; #next = 1; #timers = new Map<number,{ at:number; callback:()=>void }>();
  wall(): number { return this.wallNow; } mono(): number { return this.monoNow; }
  set(delay: number, callback: () => void): object { const id = this.#next++; this.#timers.set(id,{ at:this.monoNow+delay,callback }); return { id }; }
  clear(handle: object): void { this.#timers.delete((handle as {id:number}).id); }
  tick(ms: number): void { const end=this.monoNow+ms, wallEnd=this.wallNow+ms; for (;;) { const due=[...this.#timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if (!due) break; this.wallNow+=due[1].at-this.monoNow; this.monoNow=due[1].at; this.#timers.delete(due[0]); due[1].callback(); } this.monoNow=end; this.wallNow=wallEnd; }
  jumpWall(ms: number): void { this.wallNow += ms; }
  advanceWithoutTimers(ms: number): void { this.monoNow += ms; this.wallNow += ms; }
}
export class FakeEntropy implements Entropy { #state = 0x9e3779b9; bytes(length: number): Uint8Array { const bytes = new Uint8Array(length); for (let i = 0; i < length; i++) { this.#state ^= this.#state << 13; this.#state ^= this.#state >>> 17; this.#state ^= this.#state << 5; bytes[i] = this.#state & 255; } return bytes; } }
export const DEVICE = Object.freeze({ contractVersion: 1 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId: "12345678-1234-4234-8234-123456789abc" });
export const KEY = "AAAAAAAAAAAAAAAAAAAAAA";
export function fixture() { const clock=new FakeClock(), entropy=new FakeEntropy(), state=new StateStore(43210,clock,entropy), auth=new RuntimeLifecycle(state,clock,entropy), asset=new TextEncoder().encode("export default 1"), worker=new TextEncoder().encode("self.onmessage=()=>0"), sha256=createHash("sha256").update(asset).digest("hex"), workerSha=createHash("sha256").update(worker).digest("hex"), manifest=createViewerAssetManifest([{ role:"entry-module",name:"app.js",sha256,mime:"text/javascript; charset=utf-8",bytes:asset },{ role:"worker-module",name:"worker.js",sha256:workerSha,mime:"text/javascript; charset=utf-8",bytes:worker }]), http=new LoopbackHttp(state,auth,manifest,clock); return { clock,entropy,state,auth,http,manifest,sha256,workerSha,asset,worker }; }
export async function ensured(f = fixture()) { const result = await f.auth.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); if (!result.ok) throw new Error(result.error.code); return { ...f, access: result.value.access, snapshot: result.value.snapshot }; }
export const body = (value: string): AsyncIterable<Uint8Array> => ({ async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(value); } });
export const hangingBody = (): AsyncIterable<Uint8Array> => ({ [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }; } });
export function request(method: string, target: string, value?: string, extra: readonly (readonly [string,string])[] = []): HttpRequest { const base: [string,string][] = [["Host", "127.0.0.1:43210"], ["Origin", "http://127.0.0.1:43210"], ["Sec-Fetch-Site", "same-origin"]]; if (value !== undefined) base.push(["Content-Type", "application/json; charset=utf-8"], ["Content-Length", String(Buffer.byteLength(value))]); return { method, target, rawHeaders: [...base, ...extra], ...(value === undefined ? {} : { body: body(value) }) }; }
export function cookieToken(header: string): string { const match = /^fsq_media_v1=([^;]+)/.exec(header); if (!match) throw new Error("missing cookie"); return match[1]!; }
export function pairingCookieToken(header: string): string { const match=/^fsq_pairing_v1=([^;]+)/.exec(header); if (!match) throw new Error("missing pairing cookie"); return match[1]!; }
export async function sessionFixture() { const f=await ensured(), pairing=await f.auth.startPairing(f.snapshot.streamId); if (!pairing.ok) throw new Error(pairing.kind); const approved=await f.auth.approvePairing({ streamId:f.snapshot.streamId,pairingId:pairing.value.pairingId,pairingCode:pairing.value.pairingCode,viewerGrant:f.access.viewerGrant }); if (!approved.ok) throw new Error(approved.error.code); const redeemed=await f.auth.redeem(pairing.value.pairingId,pairing.value.pairingCode,pairing.value.browserToken); if (!redeemed.ok) throw new Error(redeemed.kind); const session=await f.auth.createSession(redeemed.value.bootstrapGrant); if (!session.ok) throw new Error(session.kind); return { ...f,pairing:pairing.value,token:session.value }; }
