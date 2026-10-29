import { createHash } from "node:crypto";
import type { Clock } from "./clock.js"; import { parseStrictJson, exactObject } from "./strict-json.js"; import type { HttpRequest, HttpResponse, UpgradeDescriptor, ViewerAssetInput, ViewerAssetManifest, MediaProfile } from "./types.js"; import { freeze } from "./types.js"; import { revealViewerToken, ViewerAuthorization } from "./auth.js"; import { StateStore } from "./state.js";
const privateAssets = new WeakMap<ViewerAssetManifest, ReadonlyMap<string, Uint8Array>>();
export const HTTP_SERVER_OPTIONS = freeze({ host: "127.0.0.1", port: 0, maxHeaderSize: 8192, maxHeadersCount: 32, headersTimeout: 5000, requestTimeout: 5000, bodyIdleTimeout: 2000, bodyTotalTimeout: 5000 });
export function createViewerAssetManifest(inputs: readonly ViewerAssetInput[]): ViewerAssetManifest { if (!Array.isArray(inputs) || Object.getPrototypeOf(inputs) !== Array.prototype || inputs.length < 2 || inputs.length > 16) throw new TypeError("Invalid asset manifest"); const names = new Set<string>(), roles = new Map<string,number>(), entries = [], bytes = new Map<string,Uint8Array>(); let total = 0; for (const input of inputs) { if (typeof input !== "object" || input === null || ![Object.prototype,null].includes(Object.getPrototypeOf(input)) || Reflect.ownKeys(input).length !== 5) throw new TypeError("Invalid asset manifest"); const descriptors = ["role","name","sha256","mime","bytes"].map((key) => Object.getOwnPropertyDescriptor(input,key)); if (descriptors.some((d) => !d?.enumerable || !("value" in d))) throw new TypeError("Invalid asset manifest"); const role = descriptors[0]!.value as unknown, name = descriptors[1]!.value as unknown, sha256 = descriptors[2]!.value as unknown, mime = descriptors[3]!.value as unknown, payload = descriptors[4]!.value as unknown; if (!(["entry-module","worker-module","style"] as unknown[]).includes(role) || typeof name !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(name) || names.has(name) || typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256) || (role === "style" ? mime !== "text/css; charset=utf-8" : mime !== "text/javascript; charset=utf-8") || !(payload instanceof Uint8Array) || payload.byteLength < 1 || payload.byteLength > 1_048_576) throw new TypeError("Invalid asset manifest"); const copy = payload.slice(); if (createHash("sha256").update(copy).digest("hex") !== sha256 || (total += copy.byteLength) > 2_097_152) throw new TypeError("Invalid asset manifest"); names.add(name); roles.set(role as string,(roles.get(role as string) ?? 0)+1); entries.push(freeze({ role, name, sha256, mime } as const)); bytes.set(`${sha256}/${name}`,copy); } if (roles.get("entry-module") !== 1 || roles.get("worker-module") !== 1 || (roles.get("style") ?? 0) > 14) throw new TypeError("Invalid asset manifest"); const manifest = freeze({ entries: freeze(entries) }) as ViewerAssetManifest; privateAssets.set(manifest,bytes); return manifest; }
const EMPTY = new Uint8Array(), encoder = new TextEncoder();
const json = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value));
const baseHeaders = (csp?: string): Record<string, string> => ({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Permissions-Policy": "camera=(), microphone=(), geolocation=()", ...(csp ? { "Content-Security-Policy": csp } : {}) });
const response = (status: number, headers: Record<string, string | string[]> = {}, body: Uint8Array<ArrayBufferLike> = EMPTY): HttpResponse => freeze({ status, headers: freeze(headers), body });
const rejected = (status: number): HttpResponse => response(status, { ...baseHeaders(), "Content-Type": "application/json; charset=utf-8" }, json({ error: status === 404 ? "not-found" : status === 405 ? "method-not-allowed" : status === 409 ? "conflict" : status === 413 ? "body-too-large" : status === 415 ? "unsupported-media-type" : status === 429 ? "rate-limited" : status === 401 ? "unauthorized" : "request-rejected" }));
const clearAuto = "fsq_auto_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", clearMedia = "fsq_media_v1=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0";
interface Delivery { finish(): Promise<void>; rollback(): Promise<void> }
const deliveries = new WeakMap<HttpResponse, Delivery>();
export function takeHttpDelivery(value: HttpResponse): Delivery | undefined { const delivery=deliveries.get(value); deliveries.delete(value); return delivery; }
const withDelivery = (value: HttpResponse, delivery: Delivery): HttpResponse => { deliveries.set(value, delivery); return value; };
interface Cookies { readonly claim?: string; readonly media?: string }
interface Headers { get(name: string): string | undefined; has(name: string): boolean }
export class LoopbackHttp {
  readonly authority: string; readonly origin: string; #assets: ReadonlyMap<string, Uint8Array>;
  constructor(readonly state: StateStore, readonly auth: ViewerAuthorization, readonly manifest: ViewerAssetManifest, readonly clock: Clock, private readonly mediaProfile: MediaProfile) { if(mediaProfile!=="h264-annexb"&&mediaProfile!=="mjpeg")throw new TypeError("Invalid media profile");this.authority = `127.0.0.1:${state.port}`; this.origin = `http://${this.authority}`; const assets = privateAssets.get(manifest); if (!assets) throw new TypeError("Invalid asset manifest"); this.#assets = assets; }
  async handle(request: HttpRequest): Promise<HttpResponse> {
    const headers=this.headers(request);
    if (!headers || headers.get("host")!==this.authority || !request.target.startsWith("/") || request.target.startsWith("//")) return rejected(400);
    if (request.method==="OPTIONS") return rejected(405);
    const viewer=/^\/viewer\/([0-9a-f-]+)$/.exec(request.target);
    if (request.method==="GET" && viewer) return this.viewer(request,headers,viewer[1]!);
    const asset=/^\/assets\/([0-9a-f]{64})\/([a-z0-9][a-z0-9._-]{0,63})$/.exec(request.target);
    if (request.method==="GET" && asset) return request.body || !this.bodyless(headers) ? rejected(400) : this.asset(headers,`${asset[1]}/${asset[2]}`);
    const known=request.target==="/v1/sessions"||request.target==="/v1/sessions/refresh"||request.target==="/v1/sessions/current";
    if (known && !((request.method==="POST"&&request.target!=="/v1/sessions/current")||(request.method==="DELETE"&&request.target==="/v1/sessions/current"))) return rejected(405);
    if (request.target.startsWith("/assets/") || request.target.startsWith("/v1/pairings")) return rejected(404);
    if (!known) return rejected(["GET","POST","DELETE"].includes(request.method)?404:405);
    if (!this.browser(headers) || headers.get("sec-fetch-mode")!=="cors" || headers.get("sec-fetch-dest")!=="empty" || headers.has("authorization")) return rejected(400);
    const cookies=this.cookies(headers);
    if (!cookies) return rejected(400);
    if (request.method==="POST" && request.target==="/v1/sessions") {
      const body=await this.body(request,headers);
      if (body instanceof ResponseError) return rejected(body.status);
      if (!exactObject(body,["streamId"]) || typeof body.streamId!=="string") return rejected(400);
      if (!cookies.claim) return rejected(401);
      const result=await this.auth.createSession(body.streamId,cookies.claim,cookies.media);
      if (!result.ok) return rejected(result.kind==="conflict"?409:401);
      const reply=response(204,{...baseHeaders(),"Set-Cookie":this.mediaCookie(revealViewerToken(result.value.mediaToken))});
      return withDelivery(reply,{finish:result.value.finish,rollback:result.value.rollback});
    }
    if (request.method==="POST" && request.target==="/v1/sessions/refresh") {
      const body=await this.body(request,headers);
      if (body instanceof ResponseError) return rejected(body.status);
      if (!exactObject(body,["visible"]) || body.visible!==true) return rejected(400);
      if (!cookies.media) return rejected(401);
      const result=await this.auth.refresh(cookies.media);
      return result.ok ? response(204,{...baseHeaders(),"Set-Cookie":[this.mediaCookie(revealViewerToken(result.value)),clearAuto]}) : response(401,{...baseHeaders(),"Content-Type":"application/json; charset=utf-8","Set-Cookie":[clearAuto,clearMedia]},json({error:"unauthorized"}));
    }
    if (request.body || !this.bodyless(headers)) return this.deleteResponse(400,cookies);
    const result=await this.auth.deleteSession(cookies.claim,cookies.media);
    return this.deleteResponse(result.ok?204:401,cookies);
  }
  async validateUpgrade(request: HttpRequest): Promise<Readonly<{ ok: true; descriptor: UpgradeDescriptor }> | Readonly<{ ok: false; status: number }>> { const headers = this.headers(request), key=headers?.get("sec-websocket-key"),extensions=headers?.get("sec-websocket-extensions"),fetchSite=headers?.get("sec-fetch-site"); let canonicalKey=false; if (key && /^[A-Za-z0-9+/]{22}==$/.test(key)) { try { const decoded=Buffer.from(key,"base64"); canonicalKey=decoded.byteLength===16 && decoded.toString("base64")===key; } catch { canonicalKey=false; } } if (!headers || request.body || !this.bodyless(headers) || headers.get("host") !== this.authority || headers.get("origin") !== this.origin || fetchSite!==undefined&&fetchSite!=="same-origin" || headers.get("upgrade")?.toLowerCase() !== "websocket" || headers.get("connection")?.toLowerCase() !== "upgrade" || headers.get("sec-websocket-version") !== "13" || !canonicalKey || extensions!==undefined&&!/^permessage-deflate;[ \t]*client_max_window_bits$/i.test(extensions) || headers.get("sec-websocket-protocol") !== "fsq-viewer.v1" || request.target !== "/v1/stream" || request.method !== "GET") return freeze({ ok: false, status: 400 }); const cookies=this.cookies(headers); if (!cookies?.media) return freeze({ ok: false, status: 401 }); const result = await this.auth.validateUpgrade(cookies.media); return result.ok ? freeze({ ok: true, descriptor: result.value }) : freeze({ ok: false, status: result.kind === "limit" ? 409 : 401 }); }
  private async viewer(request: HttpRequest, h: Headers, streamId: string): Promise<HttpResponse> {
    if (request.body || !this.bodyless(h) || h.has("origin") || h.get("sec-fetch-mode")!=="navigate" || h.get("sec-fetch-dest")!=="document" || h.has("purpose") || h.has("sec-purpose") || !this.state.hasActive(streamId)) return rejected(404);
    const site=h.get("sec-fetch-site"),native=site==="none",linked=["same-origin","same-site","cross-site"].includes(site??"")&&h.get("sec-fetch-user")==="?1";
    if (!native&&!linked) return rejected(400);
    const cookies=this.cookies(h);
    if (!cookies) return rejected(400);
    const decision=await this.auth.navigate(streamId,cookies.claim,cookies.media);
    if (!decision.ok) return rejected(decision.kind==="not-found"?404:decision.kind==="unauthorized"?401:409);
    const tags = this.manifest.entries.filter((e) => e.role !== "worker-module").map((e) => e.role === "style" ? `<link rel="stylesheet" href="/assets/${e.sha256}/${e.name}">` : `<script type="module" src="/assets/${e.sha256}/${e.name}"></script>`).join("");
    const html = encoder.encode(`<!doctype html><html data-media-profile="${this.mediaProfile}"><head><meta charset="utf-8">${tags}</head><body><canvas></canvas></body></html>`), csp = `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self' ws://${this.authority}; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
    const setCookie:string[]=[];
    if(decision.value.clearClaim)setCookie.push(clearAuto);
    if(decision.value.clearMedia)setCookie.push(clearMedia);
    if(decision.value.claimToken)setCookie.push(this.claimCookie(revealViewerToken(decision.value.claimToken)));
    const reply=response(200,{...baseHeaders(csp),"Content-Type":"text/html; charset=utf-8",...(setCookie.length?{"Set-Cookie":setCookie}:{})},html);
    return decision.value.finish&&decision.value.rollback?withDelivery(reply,{finish:decision.value.finish,rollback:decision.value.rollback}):reply;
  }
  private asset(h: Headers, key: string): HttpResponse { const origin = h.get("origin"), entry = this.manifest.entries.find((e) => `${e.sha256}/${e.name}` === key), bytes = this.#assets.get(key); if ((origin && origin !== this.origin) || !entry || !bytes) return rejected(404); return response(200, { "Cache-Control": "public,max-age=31536000,immutable", "X-Content-Type-Options": "nosniff", ETag: entry.sha256, "Content-Type": entry.mime }, bytes.slice()); }
  private browser(h: Headers): boolean { return h.get("origin") === this.origin && h.get("sec-fetch-site") === "same-origin"; }
  private headers(r: HttpRequest): Headers | undefined { if (r.rawHeaders.length > 32) return; let size = 0; const map = new Map<string, string>(); for (const pair of r.rawHeaders) { const name = pair[0].toLowerCase(), value = pair[1]; size += pair[0].length + value.length + 4; if (map.has(name) || /^(forwarded|via|x-forwarded-|proxy-)/.test(name) || /[\r\n]/.test(value)) return; map.set(name, value); } if (size > 8192 || !map.has("host")) return; return { get: (name) => map.get(name), has: (name) => map.has(name) }; }
  private async body(r: HttpRequest, h: Headers): Promise<Readonly<Record<string, unknown>> | ResponseError> { if (h.has("transfer-encoding")) return new ResponseError(400); if (h.get("content-type") !== "application/json; charset=utf-8") return new ResponseError(415); const length = h.get("content-length"); if (!length || !/^(?:0|[1-9][0-9]*)$/.test(length)) return new ResponseError(400); const expected = Number(length); if (expected > 4096) return new ResponseError(413); if (!r.body) return new ResponseError(400); const iterator = r.body[Symbol.asyncIterator](), chunks: Uint8Array[] = []; let read = 0; const started = this.clock.mono(); for (;;) { const remaining = 5_000 - (this.clock.mono() - started); if (remaining <= 0) { r.destroy?.(); return new ResponseError(400); } const next = await this.deadline(iterator.next(), Math.min(2_000, remaining)); if (!next) { r.destroy?.(); return new ResponseError(400); } if (next.done) break; read += next.value.byteLength; if (read > expected || read > 4096) return new ResponseError(read > 4096 ? 413 : 400); chunks.push(next.value); } if (read !== expected) return new ResponseError(400); try { return parseStrictJson(Buffer.concat(chunks)); } catch { return new ResponseError(400); } }
  private deadline<T>(promise: Promise<T>, delay: number): Promise<T | undefined> { return new Promise((resolve, reject) => { const timer = this.clock.set(delay, () => resolve(undefined)); promise.then((value) => { this.clock.clear(timer); resolve(value); }, (reason: unknown) => { this.clock.clear(timer); reject(reason); }); }); }
  private bodyless(h: Headers): boolean { return !h.has("transfer-encoding") && (!h.has("content-length") || h.get("content-length") === "0") && !h.has("content-type"); }
  private cookies(h:Headers):Cookies|undefined { const raw=h.get("cookie"); if(!raw)return freeze({}); const result:{claim?:string;media?:string}={}; for(const part of raw.split("; ")) { const match=/^(fsq_auto_v1|fsq_media_v1)=([A-Za-z0-9_-]{43})$/.exec(part); if(!match)return; const key=match[1]==="fsq_auto_v1"?"claim":"media"; if(result[key])return; const bytes=Buffer.from(match[2]!,"base64url"); if(bytes.length!==32||bytes.toString("base64url")!==match[2])return; result[key]=match[2]!; } return freeze(result); }
  private claimCookie(token:string):string{return `fsq_auto_v1=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=30`;}
  private mediaCookie(token:string):string{return `fsq_media_v1=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=60`;}
  private deleteResponse(status:204|400|401,cookies:Cookies):HttpResponse { const clears:string[]=[]; if(cookies.claim)clears.push(clearAuto); if(cookies.media)clears.push(clearMedia); return response(status,{...baseHeaders(),...(status===204?{}:{"Content-Type":"application/json; charset=utf-8"}),...(clears.length?{"Set-Cookie":clears}:{})},status===204?EMPTY:json({error:status===401?"unauthorized":"request-rejected"})); }
}
class ResponseError { constructor(readonly status: number) {} }
