const MAX_CONFIG_BYTES = 262_144, MAX_FRAME_BYTES = 8_126_464;
import type { ReadableTransportSocket } from "./transport.js";

export type ParsedPacket = { readonly kind: "session"; readonly width: number; readonly height: number; readonly resized: boolean } | { readonly kind: "config"; readonly bytes: Uint8Array } | { readonly kind: "frame"; readonly ptsUs: bigint; readonly key: boolean; readonly bytes: Uint8Array };
export type ParserErrorCode = "codec-disabled" | "codec-config-error" | "unsupported-codec" | "malformed-media";
export class ParserError extends Error { constructor(readonly code: ParserErrorCode) { super(code); this.name = "ParserError"; } }
const malformed = (): never => { throw new ParserError("malformed-media"); };
const H264 = 0x68323634, HEADER = 12, MAX_BUFFER = MAX_FRAME_BYTES + HEADER;

class Reader {
  private readonly iterator: AsyncIterator<Uint8Array>; private chunks: Uint8Array[] = []; private bytes = 0;
  constructor(stream: AsyncIterable<Uint8Array>) { this.iterator = stream[Symbol.asyncIterator](); }
  async read(size: number): Promise<Uint8Array | undefined> { while (this.bytes < size) { const next = await this.iterator.next(); if (next.done) { if (this.bytes === 0) return undefined; malformed(); } if (!(next.value instanceof Uint8Array) || next.value.byteLength === 0 || this.bytes + next.value.byteLength > MAX_BUFFER) malformed(); this.chunks.push(next.value); this.bytes += next.value.byteLength; } const output = new Uint8Array(size); let offset = 0; while (offset < size) { const chunk = this.chunks[0]!; const take = Math.min(chunk.byteLength, size - offset); output.set(chunk.subarray(0, take), offset); offset += take; this.bytes -= take; if (take === chunk.byteLength) this.chunks.shift(); else this.chunks[0] = chunk.subarray(take); } return output; }
}
const view = (bytes: Uint8Array): DataView => new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
export async function* parseScrcpy(stream: ReadableTransportSocket): AsyncGenerator<ParsedPacket, void> {
  const reader = new Reader(stream), codecBytes = await reader.read(4); if (!codecBytes) malformed(); const codec = view(codecBytes!).getUint32(0); if (codec === 0) throw new ParserError("codec-disabled"); if (codec === 1) throw new ParserError("codec-config-error"); if (codec !== H264) throw new ParserError("unsupported-codec");
  for (;;) { const header = await reader.read(HEADER); if (!header) return; const data = view(header), first = data.getUint32(0); if ((first & 0x80000000) !== 0) { if ((first & 0x7ffffffe) !== 0) malformed(); const width = data.getUint32(4), height = data.getUint32(8); if (width === 0 || height === 0) malformed(); yield { kind: "session", width, height, resized: (first & 1) === 1 }; continue; }
    const flags = data.getBigUint64(0), size = data.getUint32(8), config = (flags & (1n << 62n)) !== 0n, key = (flags & (1n << 61n)) !== 0n, ptsUs = flags & ((1n << 61n) - 1n); if ((flags & (1n << 63n)) !== 0n || (config && key) || (config && ptsUs !== 0n) || size === 0 || size > (config ? MAX_CONFIG_BYTES : MAX_FRAME_BYTES)) malformed(); const bytes = await reader.read(size); if (!bytes) malformed(); yield config ? { kind: "config", bytes: bytes! } : { kind: "frame", ptsUs, key, bytes: bytes! }; }
}
