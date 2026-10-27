export const MAX_JPEG_BYTES = 8_126_464;
const EMPTY = Buffer.alloc(0);
export class WdaMediaError extends Error {
  constructor() { super("WDA media is malformed"); }
}
const RESPONSE = new Map([
  ["server", "WDA MJPEG Server"], ["connection", "close"], ["max-age", "0"],
  ["expires", "0"], ["cache-control", "no-cache, private"], ["pragma", "no-cache"],
  ["content-type", "multipart/x-mixed-replace; boundary=--BoundaryString"],
]);
function responseHeader(text: string): void {
  const lines = text.slice(0, -4).split("\r\n");
  if (lines.shift() !== "HTTP/1.0 200 OK" || lines.length !== RESPONSE.size) throw new WdaMediaError();
  const seen = new Set<string>();
  for (const line of lines) {
    const match = /^([A-Za-z0-9-]+):[ \t]*([^\r\n]*?)[ \t]*$/.exec(line);
    const name = match?.[1]?.toLowerCase();
    if (!name || match?.[0] !== line || seen.has(name) || RESPONSE.get(name) !== match?.[2]) throw new WdaMediaError();
    seen.add(name);
  }
}
function partLength(text: string): number {
  const match = /^--BoundaryString\r\nContent-type: image\/jpeg\r\nContent-Length: ([1-9][0-9]{0,6})\r\n\r\n$/.exec(text);
  const length = Number(match?.[1]);
  if (!Number.isInteger(length) || length < 4 || length > MAX_JPEG_BYTES) throw new WdaMediaError();
  return length;
}
// Fixed WDA v16.15.3 grammar, not a MIME/HTTP implementation. Only the current
// bounded header/payload state is allocated; TCP chunks are never concatenated.
export async function* parseWda(source: AsyncIterable<Uint8Array>, headers: () => void): AsyncGenerator<Uint8Array> {
  let state: "response" | "part" | "jpeg" | "suffix" = "response";
  let buffer = Buffer.alloc(8192), used = 0;
  let jpeg: Uint8Array | undefined;
  try {
    for await (const chunk of source) {
      let offset = 0;
      while (offset < chunk.byteLength) {
        if (state === "response" || state === "part") {
          if (used === buffer.byteLength) throw new WdaMediaError();
          buffer[used++] = chunk[offset++]!;
          if (used < 4 || buffer.readUInt32BE(used - 4) !== 0x0d0a0d0a) continue;
          const text = buffer.toString("latin1", 0, used);
          if (state === "response") {
            responseHeader(text);
            headers();
            state = "part";
            buffer = Buffer.alloc(1024);
          } else {
            buffer = Buffer.alloc(partLength(text));
            state = "jpeg";
          }
          used = 0;
        } else if (state === "jpeg") {
          const count = Math.min(buffer.byteLength - used, chunk.byteLength - offset);
          buffer.set(chunk.subarray(offset, offset + count), used);
          used += count;
          offset += count;
          if (used !== buffer.byteLength) continue;
          jpeg = buffer;
          buffer = EMPTY;
          used = 0;
          state = "suffix";
        } else {
          if (chunk[offset++] !== (used % 2 === 0 ? 13 : 10)) throw new WdaMediaError();
          if (++used !== 4) continue;
          const complete = jpeg!;
          jpeg = undefined;
          buffer = Buffer.alloc(1024);
          used = 0;
          state = "part";
          yield complete;
        }
      }
    }
    if (used !== 0 || (state !== "part" && state !== "response")) throw new WdaMediaError();
  } finally {
    buffer = EMPTY;
    jpeg = undefined;
  }
}
