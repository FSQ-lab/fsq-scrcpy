import assert from "node:assert/strict";
import test from "node:test";
const MAX_CONFIG_BYTES = 262_144, MAX_FRAME_BYTES = 8_126_464;
import { ParserError, parseScrcpy, type ParsedPacket } from "../src/scrcpy/parser.js";
import type { ReadableTransportSocket } from "../src/scrcpy/transport.js";

const codec = (value = 0x68323634): Uint8Array => { const bytes = new Uint8Array(4); new DataView(bytes.buffer).setUint32(0, value); return bytes; };
const session = (width = 1080, height = 1920, flags = 0x80000000): Uint8Array => { const bytes = new Uint8Array(12), view = new DataView(bytes.buffer); view.setUint32(0, flags); view.setUint32(4, width); view.setUint32(8, height); return bytes; };
const media = (payload: Uint8Array, options: { config?: boolean; key?: boolean; pts?: bigint; declared?: number } = {}): Uint8Array => { const header = new Uint8Array(12), view = new DataView(header.buffer); let flags = options.pts ?? 0n; if (options.config) flags |= 1n << 62n; if (options.key) flags |= 1n << 61n; view.setBigUint64(0, flags); view.setUint32(8, options.declared ?? payload.byteLength); return Buffer.concat([header, payload]); };
class Input implements ReadableTransportSocket { constructor(private readonly chunks: readonly Uint8Array[]) {} on(): this { return this; } pause(): this { return this; } resume(): this { return this; } read(): Uint8Array | null { return null; } destroy(): this { return this; } async *[Symbol.asyncIterator](): AsyncIterator<Uint8Array> { yield* this.chunks; } }
async function packets(chunks: readonly Uint8Array[]): Promise<ParsedPacket[]> { const output: ParsedPacket[] = []; for await (const packet of parseScrcpy(new Input(chunks))) output.push(packet); return output; }
async function malformed(chunks: readonly Uint8Array[], code = "malformed-media"): Promise<void> { await assert.rejects(async () => packets(chunks), (error: unknown) => error instanceof ParserError && error.code === code); }

await test("parses fragmented codec, sessions, config and key/delta frames", async () => {
  const config = media(Uint8Array.of(1, 2), { config: true }), key = media(Uint8Array.of(3), { key: true, pts: 10n }), delta = media(Uint8Array.of(4, 5), { pts: 11n }), bytes = Buffer.concat([codec(), session(), config, key, delta, session(1920, 1080, 0x80000001)]), chunks = Array.from(bytes, (value) => Uint8Array.of(value)); const result = await packets(chunks); assert.deepEqual(result.map((packet) => packet.kind), ["session", "config", "frame", "frame", "session"]); assert.deepEqual(result[0], { kind: "session", width: 1080, height: 1920, resized: false }); assert.deepEqual(result[2], { kind: "frame", ptsUs: 10n, key: true, bytes: Uint8Array.of(3) }); assert.deepEqual(result[4], { kind: "session", width: 1920, height: 1080, resized: true });
});

await test("maps exact codec sentinels and rejects every other codec", async () => {
  await malformed([codec(0)], "codec-disabled"); await malformed([codec(1)], "codec-config-error"); for (const value of [2, 0x61763031]) await malformed([codec(value)], "unsupported-codec");
});

await test("rejects illegal session and media header fields before payload allocation", async () => {
  for (const bad of [session(0, 1), session(1, 0), session(1, 1, 0x80000002)]) await malformed([Buffer.concat([codec(), bad])]);
  await malformed([Buffer.concat([codec(), session(), media(Uint8Array.of(1), { config: true, key: true })])]); await malformed([Buffer.concat([codec(), session(), media(Uint8Array.of(1), { config: true, pts: 1n })])]); await malformed([Buffer.concat([codec(), session(), media(new Uint8Array(), { declared: 0 })])]);
  await malformed([Buffer.concat([codec(), session(), media(new Uint8Array(), { config: true, declared: MAX_CONFIG_BYTES + 1 })])]); await malformed([Buffer.concat([codec(), session(), media(new Uint8Array(), { declared: MAX_FRAME_BYTES + 1 })])]);
});

await test("distinguishes clean header-boundary EOF from partial codec/header/payload", async () => {
  assert.deepEqual(await packets([codec()]), []); assert.deepEqual((await packets([Buffer.concat([codec(), session()])])).map((packet) => packet.kind), ["session"]); await malformed([codec().subarray(0, 3)]); await malformed([Buffer.concat([codec(), session().subarray(0, 11)])]); await malformed([Buffer.concat([codec(), session(), media(Uint8Array.of(1, 2), { declared: 3 })])]);
});

await test("rejects empty chunks and bounded-reader overfill", async () => {
  await malformed([new Uint8Array()]); await malformed([Buffer.concat([codec(), new Uint8Array(MAX_FRAME_BYTES + 1024)])]);
});
