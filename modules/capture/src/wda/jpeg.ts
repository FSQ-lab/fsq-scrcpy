import { createRequire } from "node:module";
import { MAX_JPEG_BYTES, WdaMediaError } from "./parser.js";
// exifr's published Input union requires DOM types; Capture uses only its Node memory API.
const exifr = createRequire(import.meta.url)("exifr") as {
  orientation(bytes: Uint8Array): Promise<number | undefined>;
};
export interface JpegMetadata { readonly width: number; readonly height: number; readonly orientation: number }
function exifOrientationTag(bytes: Uint8Array): boolean {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 14) throw new WdaMediaError();
  const little = view.getUint16(6) === 0x4949;
  if ((!little && view.getUint16(6) !== 0x4d4d) || view.getUint16(8, little) !== 42) {
    throw new WdaMediaError();
  }
  const offset = view.getUint32(10, little);
  if (offset < 8 || offset > bytes.length - 12) throw new WdaMediaError();
  const start = 6 + offset, count = view.getUint16(start, little);
  if (count > Math.floor((bytes.length - start - 6) / 12)) throw new WdaMediaError();
  let found = false;
  for (let i = 0; i < count; i++) {
    const entry = start + 2 + i * 12;
    if (view.getUint16(entry, little) !== 0x0112) continue;
    if (found || view.getUint16(entry + 2, little) !== 3 || view.getUint32(entry + 4, little) !== 1) {
      throw new WdaMediaError();
    }
    found = true;
  }
  return found;
}
export async function inspectJpeg(bytes: Uint8Array): Promise<JpegMetadata> {
  try {
    if (bytes.length < 4 || bytes.length > MAX_JPEG_BYTES || bytes[0] !== 255 || bytes[1] !== 216) {
      throw new WdaMediaError();
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let offset = 2, width = 0, height = 0, scan = false, sawScan = false;
    let scanData = false;
    let exif = false, orientationTag = false;
    const components = new Set<number>();
    while (offset < bytes.length) {
      if (scan && bytes[offset] !== 255) {
        scanData = true;
        offset++;
        continue;
      }
      if (bytes[offset++] !== 255) throw new WdaMediaError();
      while (bytes[offset] === 255) offset++;
      const marker = bytes[offset++];
      if (scan && marker === 0) { scanData = true; continue; }
      if (scan && marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
        if (!scanData) throw new WdaMediaError();
        continue;
      }
      if (scan && !scanData) throw new WdaMediaError();
      scan = false;
      if (marker === 0xd9) {
        if (offset !== bytes.length || !width || !sawScan) throw new WdaMediaError();
        const parsed: unknown = orientationTag ? await exifr.orientation(bytes) : undefined;
        if ((orientationTag && parsed === undefined)
          || (parsed !== undefined && (!Number.isInteger(parsed) || Number(parsed) < 1 || Number(parsed) > 8))) {
          throw new WdaMediaError();
        }
        return { width, height, orientation: parsed === undefined ? 1 : Number(parsed) };
      }
      if (marker === undefined || marker < 0xc0 || marker === 0xd8
        || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) {
        throw new WdaMediaError();
      }
      const length = view.getUint16(offset), end = offset + length;
      if (length < 2 || end > bytes.length - 2) throw new WdaMediaError();
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (width || length < 11) throw new WdaMediaError();
        height = view.getUint16(offset + 3);
        width = view.getUint16(offset + 5);
        const count = bytes[offset + 7]!;
        const precision = bytes[offset + 2]!;
        if ((precision !== 8 && precision !== 12 && precision !== 16)
          || (marker === 0xc0 && precision !== 8)
          || count < 1 || count > 4 || length !== 8 + count * 3
          || width < 1 || width > 4096 || height < 1 || height > 4096
          || width > Math.floor(8_388_608 / height)) {
          throw new WdaMediaError();
        }
        for (let i = 0; i < count; i++) {
          const entry = offset + 8 + i * 3;
          const id = bytes[entry]!, sampling = bytes[entry + 1]!;
          if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4
            || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[entry + 2]! > 3) {
            throw new WdaMediaError();
          }
          components.add(id);
        }
      } else if (marker === 0xda) {
        const count = bytes[offset + 2]!;
        if (!width || count < 1 || count > components.size || length !== 6 + count * 2) throw new WdaMediaError();
        const selected = new Set<number>();
        for (let i = 0; i < count; i++) {
          const id = bytes[offset + 3 + i * 2]!;
          if (!components.has(id) || selected.has(id)) throw new WdaMediaError();
          selected.add(id);
        }
        scan = sawScan = true;
        scanData = false;
      } else if (marker === 0xe1) {
        const data = bytes.subarray(offset + 2, end);
        if (data.length >= 4 && data[0] === 69 && data[1] === 120 && data[2] === 105 && data[3] === 102) {
          if (exif || data[4] !== 0 || data[5] !== 0) throw new WdaMediaError();
          exif = true;
          orientationTag = exifOrientationTag(data);
        }
      }
      offset = end;
    }
    throw new WdaMediaError();
  } catch {
    // Never preserve a dependency exception, input bytes or a provider cause.
    throw new WdaMediaError();
  }
}
