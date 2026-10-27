import { encodeMediaHeader, type MediaKind } from "../../contracts/src/index.js";
import { JPEG_PROBE } from "../src/jpeg.js";
export { JPEG_PROBE };
export class TestBitmap {
  closes = 0;
  constructor(readonly width = 2, readonly height = 1) {}
  close(): void { this.closes++; }
}
export function bitmapResult() {
  let resolve!: (value: TestBitmap) => void, reject!: () => void;
  const promise = new Promise<TestBitmap>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
export function jpegSession(width = 1, height = 2, displayWidth = height, displayHeight = width): Uint8Array {
  const bytes = new Uint8Array(24), view = new DataView(bytes.buffer);
  [0x6d6a7067, width, height, displayWidth, displayHeight, 1_000_000]
    .forEach((value, index) => view.setUint32(index * 4, value));
  return bytes;
}
export function jpegWire(kind: MediaKind, sequence: bigint, epoch: bigint, payload: Uint8Array = JPEG_PROBE): Uint8Array<ArrayBuffer> {
  const header = encodeMediaHeader({ minor: 1, kind, flags: kind === 3 ? 1 : 0,
    payloadBytes: payload.length, sequence, epoch, ptsUs: kind === 3 ? sequence : -1n });
  const bytes = new Uint8Array(40 + payload.length);
  bytes.set(header); bytes.set(payload, 40);
  return bytes;
}
