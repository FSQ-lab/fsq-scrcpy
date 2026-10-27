import { createServer, type Socket } from "node:net";
import { once } from "node:events";
import { setImmediate as turn } from "node:timers/promises";

// Literal source grammar from FBMjpegServer.m at the pinned WDA commit.
export const RESPONSE = Buffer.from([
  "HTTP/1.0 200 OK", "Server: WDA MJPEG Server", "Connection: close",
  "Max-Age: 0", "Expires: 0", "Cache-Control: no-cache, private",
  "Pragma: no-cache", "Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString", "", "",
].join("\r\n"));
export const deviceRef = { contractVersion: 2, platform: "ios", namespace: "fsq.ios.local", opaqueId: "123e4567-e89b-42d3-a456-426614174000" } as const;
export function segment(marker: number, data: Uint8Array): Buffer {
  const header = Buffer.from([255, marker, 0, 0]);
  header.writeUInt16BE(data.length + 2, 2);
  return Buffer.concat([header, data]);
}
export function exif(value: number, little = true): Buffer {
  const data = Buffer.alloc(32);
  data.write("Exif\0\0", 0, "latin1");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  view.setUint16(6, little ? 0x4949 : 0x4d4d);
  view.setUint16(8, 42, little);
  view.setUint32(10, 8, little);
  view.setUint16(14, 1, little);
  view.setUint16(16, 0x0112, little);
  view.setUint16(18, 3, little);
  view.setUint32(20, 1, little);
  view.setUint16(24, value, little);
  return segment(0xe1, data);
}
// Encodes a constant gray, one-component baseline JPEG. Each MCU consists of
// the one-bit zero DC difference and one-bit AC EOB, not a pixel fixture.
export function jpeg(width = 8, height = 16, orientation?: number): Buffer {
  const quant = segment(0xdb, Buffer.from([0, ...Array<number>(64).fill(1)]));
  const huffman = segment(0xc4, Buffer.from([
    0, 1, ...Array<number>(15).fill(0), 0,
    16, 1, ...Array<number>(15).fill(0), 0,
  ]));
  const sof = Buffer.from([8, 0, 0, 0, 0, 1, 1, 0x11, 0]);
  sof.writeUInt16BE(height, 1);
  sof.writeUInt16BE(width, 3);
  const bits = Math.ceil(width / 8) * Math.ceil(height / 8) * 2;
  const entropy = Buffer.alloc(Math.ceil(bits / 8));
  if (bits % 8) entropy[entropy.length - 1] = (1 << (8 - bits % 8)) - 1;
  return Buffer.concat([
    Buffer.from([255, 216]), ...(orientation === undefined ? [] : [exif(orientation)]),
    quant, segment(0xc0, sof), huffman, segment(0xda, Buffer.from([1, 1, 0, 0, 63, 0])),
    entropy, Buffer.from([255, 217]),
  ]);
}
export function part(bytes: Uint8Array, length = String(bytes.length)): Buffer {
  return Buffer.concat([
    Buffer.from(`--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: ${length}\r\n\r\n`),
    bytes, Buffer.from("\r\n\r\n"),
  ]);
}
export async function* chunks(bytes: Uint8Array, cuts: readonly number[]): AsyncGenerator<Uint8Array> {
  let offset = 0;
  for (const end of cuts) { yield bytes.subarray(offset, end); offset = end; }
  yield bytes.subarray(offset);
}
export async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = process.hrtime.bigint() + 5_000_000_000n;
  while (!predicate()) {
    if (process.hrtime.bigint() >= deadline) throw new Error("Synthetic source condition timed out");
    await turn();
  }
}
export async function loopback() {
  const sockets = new Set<Socket>(), requests: string[] = [], waiting: Socket[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.once("close", () => sockets.delete(socket));
    let request = "";
    const receive = (data: Buffer): void => {
      request += data.toString("ascii");
      if (request.length > 1024) throw new Error("Synthetic request exceeded bound");
      if (!request.endsWith("\r\n\r\n")) return;
      socket.removeListener("data", receive);
      requests.push(request);
      waiting.push(socket);
    };
    socket.on("data", receive);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Synthetic listener failed");
  return {
    endpoint: `http://127.0.0.1:${address.port}/`, requests, server, sockets,
    async client(): Promise<Socket> { await waitFor(() => waiting.length > 0); return waiting.shift()!; },
    async close(): Promise<void> {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
}
