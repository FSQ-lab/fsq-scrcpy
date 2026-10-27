// Metadata-only guard; native createImageBitmap remains the sole JPEG decoder.
export function boundedImage(width: number, height: number): boolean {
  return Number.isInteger(width) && Number.isInteger(height) && width >= 1 && height >= 1
    && width <= 4096 && height <= 4096 && width <= Math.floor(8_388_608 / height);
}
export function jpegSize(bytes: Uint8Array): { width: number; height: number } {
  const fail = (): never => { throw new Error("Invalid JPEG"); };
  if (bytes.length < 4 || bytes.length > 8_126_464 || bytes[0] !== 255 || bytes[1] !== 216) return fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = 2, width = 0, height = 0, scan = false, sawScan = false, scanData = false;
  const components = new Set<number>();
  while (at < bytes.length) {
    if (scan && bytes[at] !== 255) { scanData = true; at++; continue; }
    if (bytes[at++] !== 255) return fail();
    while (bytes[at] === 255) at++;
    const marker = bytes[at++];
    if (scan && marker === 0) { scanData = true; continue; }
    if (scan && marker !== undefined && marker >= 0xd0 && marker <= 0xd7) {
      if (!scanData) return fail();
      continue;
    }
    if (scan && !scanData) return fail();
    scan = false;
    if (marker === 0xd9) {
      if (at !== bytes.length || !width || !sawScan) return fail();
      return { width, height };
    }
    if (marker === undefined || marker < 0xc0 || marker === 0xd8
      || (marker >= 0xd0 && marker <= 0xd7) || at + 2 > bytes.length) return fail();
    const length = view.getUint16(at), end = at + length;
    if (length < 2 || end > bytes.length - 2) return fail();
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (width || length < 11) return fail();
      height = view.getUint16(at + 3); width = view.getUint16(at + 5);
      const count = bytes[at + 7]!, precision = bytes[at + 2]!;
      if (!boundedImage(width, height) || ![8, 12, 16].includes(precision)
        || (marker === 0xc0 && precision !== 8) || count < 1 || count > 4 || length !== 8 + count * 3) return fail();
      for (let i = 0; i < count; i++) {
        const entry = at + 8 + i * 3, id = bytes[entry]!, sampling = bytes[entry + 1]!;
        if (components.has(id) || (sampling >> 4) < 1 || (sampling >> 4) > 4
          || (sampling & 15) < 1 || (sampling & 15) > 4 || bytes[entry + 2]! > 3) return fail();
        components.add(id);
      }
    } else if (marker === 0xda) {
      const count = bytes[at + 2]!, selected = new Set<number>();
      if (!width || count < 1 || count > components.size || length !== 6 + count * 2) return fail();
      for (let i = 0; i < count; i++) {
        const id = bytes[at + 3 + i * 2]!;
        if (!components.has(id) || selected.has(id)) return fail();
        selected.add(id);
      }
      scan = sawScan = true; scanData = false;
    }
    at = end;
  }
  return fail();
}
// Fixed gray baseline JPEG: one zero-DC/EOB MCU, coded 1x2, EXIF orientation 6.
// DQT/DHT/SOS and entropy are real JPEG data, not a SOF-only capability placeholder.
export const JPEG_PROBE = Uint8Array.of(
  255,216,255,225,0,34,69,120,105,102,0,0,73,73,42,0,8,0,0,0,1,0,
  18,1,3,0,1,0,0,0,6,0,0,0,0,0,0,0,
  255,219,0,67,0,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,
  255,192,0,11,8,0,2,0,1,1,1,17,0,
  255,196,0,38,0,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  16,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,
  255,218,0,8,1,1,0,0,63,0,63,255,217,
);
