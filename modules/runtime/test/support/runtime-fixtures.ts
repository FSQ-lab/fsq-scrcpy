import { createHash } from "node:crypto";
import type { Clock, Entropy } from "../../src/clock.js";
import { StateStore } from "../../src/state.js";
import { revealViewerToken, ViewerAuthorization } from "../../src/auth.js";
import { createViewerAssetManifest, LoopbackHttp } from "../../src/http.js";
import type { HttpRequest } from "../../src/types.js";
export class FakeClock implements Clock {
  wallNow = 1_800_000_000_000; monoNow = 10_000; #next = 1; #timers = new Map<number,{ at:number; callback:()=>void }>();
  wall(): number { return this.wallNow; } mono(): number { return this.monoNow; }
  set(delay: number, callback: () => void): object { const id = this.#next++; this.#timers.set(id,{ at:this.monoNow+delay,callback }); return { id }; }
  clear(handle: object): void { this.#timers.delete((handle as {id:number}).id); }
  tick(ms: number): void { const end=this.monoNow+ms, wallEnd=this.wallNow+ms; for (;;) { const due=[...this.#timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0]; if (!due) break; this.wallNow+=due[1].at-this.monoNow; this.monoNow=due[1].at; this.#timers.delete(due[0]); due[1].callback(); } this.monoNow=end; this.wallNow=wallEnd; }
  fireNextTimerEarly(): void { const next=[...this.#timers].sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0]; if (!next || next[1].at<=this.monoNow) throw new Error("no future timer"); const early=next[1].at-1; this.wallNow+=early-this.monoNow; this.monoNow=early; this.#timers.delete(next[0]); next[1].callback(); }
  jumpWall(ms: number): void { this.wallNow += ms; }
  advanceWithoutTimers(ms: number): void { this.monoNow += ms; this.wallNow += ms; }
}
export class FakeEntropy implements Entropy { #state = 0x9e3779b9; bytes(length: number): Uint8Array { const bytes = new Uint8Array(length); for (let i = 0; i < length; i++) { this.#state ^= this.#state << 13; this.#state ^= this.#state >>> 17; this.#state ^= this.#state << 5; bytes[i] = this.#state & 255; } return bytes; } }
export const DEVICE = Object.freeze({ contractVersion: 2 as const, platform: "android" as const, namespace: "fsq.android.local", opaqueId: "12345678-1234-4234-8234-123456789abc" });
export const KEY = "AAAAAAAAAAAAAAAAAAAAAA";
export function fixture() { const clock=new FakeClock(), entropy=new FakeEntropy(), state=new StateStore(43210,clock,entropy), auth=new ViewerAuthorization(state,clock,entropy), asset=new TextEncoder().encode("export default 1"), worker=new TextEncoder().encode("self.onmessage=()=>0"), sha256=createHash("sha256").update(asset).digest("hex"), workerSha=createHash("sha256").update(worker).digest("hex"), manifest=createViewerAssetManifest([{ role:"entry-module",name:"app.js",sha256,mime:"text/javascript; charset=utf-8",bytes:asset },{ role:"worker-module",name:"worker.js",sha256:workerSha,mime:"text/javascript; charset=utf-8",bytes:worker }]), http=new LoopbackHttp(state,auth,manifest,clock,"h264-annexb"); return { clock,entropy,state,auth,http,manifest,sha256,workerSha,asset,worker }; }
export async function ensured(f = fixture()) { const result = await f.auth.ensureStandaloneViewer({ deviceRef: DEVICE, idempotencyKey: KEY }); if (!result.ok) throw new Error(result.error.code); return { ...f, descriptor: result.value.descriptor, snapshot: result.value.snapshot }; }
export const body = (value: string): AsyncIterable<Uint8Array> => ({ async *[Symbol.asyncIterator]() { yield new TextEncoder().encode(value); } });
export const hangingBody = (): AsyncIterable<Uint8Array> => ({ [Symbol.asyncIterator]() { return { next: () => new Promise<IteratorResult<Uint8Array>>(() => undefined) }; } });
export function request(method: string, target: string, value?: string, extra: readonly (readonly [string,string])[] = []): HttpRequest { const base: [string,string][] = [["Host", "127.0.0.1:43210"], ["Origin", "http://127.0.0.1:43210"], ["Sec-Fetch-Site", "same-origin"], ["Sec-Fetch-Mode", "cors"], ["Sec-Fetch-Dest", "empty"]]; if (value !== undefined) base.push(["Content-Type", "application/json; charset=utf-8"], ["Content-Length", String(Buffer.byteLength(value))]); return { method, target, rawHeaders: [...base, ...extra], ...(value === undefined ? {} : { body: body(value) }) }; }
export function cookieToken(header: string | readonly string[], name="fsq_media_v1"): string { const values=typeof header==="string"?[header]:header; for(const value of values){const match=new RegExp(`^${name}=([^;]+)`).exec(value);if(match)return match[1]!;}throw new Error("missing cookie"); }
export async function sessionFixture() { const f=await ensured(), navigation=await f.auth.navigate(f.snapshot.streamId); if(!navigation.ok||!navigation.value.claimToken||!navigation.value.finish)throw new Error("navigation"); const claimToken=revealViewerToken(navigation.value.claimToken);await navigation.value.finish(); const session=await f.auth.createSession(f.snapshot.streamId,claimToken); if (!session.ok) throw new Error(session.kind); const token=revealViewerToken(session.value.mediaToken);await session.value.finish(); return { ...f,claimToken,token }; }
