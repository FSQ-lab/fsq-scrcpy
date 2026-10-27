import assert from "node:assert/strict";
import test from "node:test";
import { inspectJpeg } from "../src/wda/jpeg.js";
import { MAX_JPEG_BYTES, parseWda, WdaMediaError } from "../src/wda/parser.js";
import { chunks, exif, jpeg, part, RESPONSE, segment } from "./wda-fixtures.js";

async function parse(bytes: Uint8Array, cuts: readonly number[] = []): Promise<Uint8Array[]> {
  const frames: Uint8Array[] = [];
  for await (const frame of parseWda(chunks(bytes, cuts), () => undefined)) frames.push(frame);
  return frames;
}
const image = jpeg();
const wire = Buffer.concat([RESPONSE, part(image)]);
await test("pinned WDA grammar survives every split and byte-at-a-time fragmentation", async () => {
  for (let cut = 0; cut <= wire.length; cut++) {
    const frames = await parse(wire, [cut]);
    assert.equal(frames.length, 1);
    assert.deepEqual(frames[0], image);
  }
  assert.deepEqual(await parse(wire, Array.from({ length: wire.length }, (_, i) => i)), [image]);
  assert.deepEqual(await parse(Buffer.concat([wire, part(image)])), [image, image]);
});
await test("HTTP names are case insensitive and only surrounding OWS is normalized", async () => {
  const response = RESPONSE.toString().replace("Server: WDA MJPEG Server", "sErVeR:\t WDA MJPEG Server \t");
  assert.equal((await parse(Buffer.concat([Buffer.from(response), part(image)]))).length, 1);
});
await test("rejects wrong status/version/reason, missing, repeated, extra and folded headers", async () => {
  const response = RESPONSE.toString();
  const variants = [
    response.replace("HTTP/1.0", "HTTP/1.1"), response.replace("200 OK", "302 Found"),
    response.replace("200 OK", "200 Fine"), response.replace("Server: WDA MJPEG Server\r\n", ""),
    response.replace("Server: WDA MJPEG Server", "Server: Other"),
    response.replace("Server: WDA MJPEG Server", "Server: WDA MJPEG Server\r\nserver: WDA MJPEG Server"),
    response.replace("Server: WDA MJPEG Server", "Server: WDA\r\n MJPEG Server"),
    response.replace("Pragma: no-cache", "Pragma: no-cache\r\nContent-Length: 0"),
    response.replace("Pragma: no-cache", "Pragma: no-cache\r\nTransfer-Encoding: chunked"),
    response.replace("--BoundaryString", "BoundaryString"), response.replaceAll("\r\n", "\n"),
    response.replace("Connection: close", "Connection: keep-alive"),
    response.replace("Max-Age: 0", "Max-Age: 00"), response.replace("Pragma: no-cache", "Pragma : no-cache"),
    response.replace("Server: WDA MJPEG Server", "Server: WDA MJPEG Server\0"),
    response.replace("Server: WDA MJPEG Server", "Server: WDA MJPEG Server\n"),
  ];
  for (const header of variants) await assert.rejects(parse(Buffer.concat([Buffer.from(header), part(image)])), WdaMediaError);
});
await test("rejects every missing HTTP field and every extra/repeated part field", async () => {
  for (const line of RESPONSE.toString().split("\r\n").slice(1, -2)) {
    const header = RESPONSE.toString().replace(`${line}\r\n`, "");
    await assert.rejects(parse(Buffer.concat([Buffer.from(header), part(image)])), WdaMediaError);
  }
  const original = part(image).toString("latin1");
  for (const header of [
    original.replace("Content-type: image/jpeg\r\n", ""),
    original.replace(/Content-Length: [0-9]+\r\n/, ""),
    original.replace("Content-type: image/jpeg", "Content-type: image/png"),
    original.replace("Content-type: image/jpeg", "Content-type: image/jpeg\r\nX-Extra: yes"),
    original.replace("Content-type: image/jpeg", "Content-type: image/jpeg\r\nContent-type: image/jpeg"),
    original.replace("Content-Length:", `Content-Length: ${image.length}\r\nContent-Length:`),
    original.replace("--BoundaryString", "----BoundaryString"),
    original.replace("\r\n\r\n", "\n\n"), original.slice(0, -1), `${original.slice(0, -4)}\r\nX\n`,
  ]) await assert.rejects(parse(Buffer.concat([RESPONSE, Buffer.from(header, "latin1")])), WdaMediaError);
});
await test("length limits are canonical and validated before payload input/allocation", async () => {
  for (const length of ["0", "-1", "+4", "04", "4.0", "4e1", " 4", "4 ", "NaN", String(MAX_JPEG_BYTES + 1), "99999999999999999999"]) {
    const header = part(Buffer.alloc(0), length).subarray(0, -4);
    await assert.rejects(parse(Buffer.concat([RESPONSE, header])), WdaMediaError);
  }
  await assert.rejects(parse(Buffer.concat([RESPONSE, part(image, String(image.length - 1))])), WdaMediaError);
  await assert.rejects(parse(Buffer.concat([RESPONSE, part(image, String(image.length + 1))])), WdaMediaError);
  const maximum = Buffer.alloc(MAX_JPEG_BYTES);
  const frames = await parse(Buffer.concat([RESPONSE, part(maximum)]));
  assert.equal(frames[0]?.length, MAX_JPEG_BYTES);
});
await test("bounds response/part state and rejects partial EOF at every non-boundary byte", async () => {
  await assert.rejects(parse(Buffer.from(`HTTP/1.0 200 OK\r\nServer: ${"x".repeat(8192)}`)), WdaMediaError);
  await assert.rejects(parse(Buffer.concat([RESPONSE, Buffer.from(`--BoundaryString\r\n${"x".repeat(1024)}`)])), WdaMediaError);
  for (let end = 1; end < wire.length; end++) {
    if (end === RESPONSE.length) continue;
    await assert.rejects(parse(wire.subarray(0, end)), WdaMediaError);
  }
  assert.deepEqual(await parse(RESPONSE), []);
});
await test("validates real synthetic JPEG dimensions and exifr orientation 1..8 in both byte orders", async () => {
  assert.deepEqual(await inspectJpeg(image), { width: 8, height: 16, orientation: 1 });
  for (let orientation = 1; orientation <= 8; orientation++) {
    assert.deepEqual(await inspectJpeg(jpeg(8, 16, orientation)), { width: 8, height: 16, orientation });
    const big = Buffer.concat([image.subarray(0, 2), exif(orientation, false), image.subarray(2)]);
    assert.equal((await inspectJpeg(big)).orientation, orientation);
  }
  assert.equal((await inspectJpeg(jpeg(4096, 2048))).width, 4096);
});
await test("rejects illegal JPEG side/area, SOI/EOI, partial segments and duplicate SOF", async () => {
  const badSof = segment(0xc0, Buffer.from([8, 0, 16, 0, 8, 1, 1, 0x11, 0]));
  const variants = [
    Buffer.alloc(0), Buffer.from([255, 216, 255, 217]), image.subarray(1), image.subarray(0, -1),
    Buffer.concat([image, Buffer.from([0])]), jpeg(0, 16), jpeg(8, 0), jpeg(4097, 8), jpeg(8, 4097), jpeg(4096, 2049),
    Buffer.concat([image.subarray(0, 2), badSof, image.subarray(2)]),
    Buffer.concat([image.subarray(0, 2), Buffer.from([255, 0xe0, 0xff, 0xff]), image.subarray(2)]),
    Buffer.concat([image.subarray(0, 2), Buffer.from([255, 0xe0, 0, 1]), image.subarray(2)]),
    Buffer.concat([image.subarray(0, -3), image.subarray(-2)]), // SOS without entropy
  ];
  for (const bytes of variants) await assert.rejects(inspectJpeg(bytes), WdaMediaError);
  for (let end = 0; end < image.length; end++) await assert.rejects(inspectJpeg(image.subarray(0, end)), WdaMediaError);
});
await test("rejects malformed EXIF rather than silently defaulting dependency failures", async () => {
  for (const orientation of [0, 9, 65535]) await assert.rejects(inspectJpeg(jpeg(8, 16, orientation)), WdaMediaError);
  const invalid = [segment(0xe1, Buffer.from("Exif\0\0")), exif(1), exif(1), exif(1), exif(1)];
  invalid[1]![12] = 0; // TIFF magic
  invalid[2]!.writeUInt32LE(0xfffffff0, 14); // IFD0 offset
  invalid[3]!.writeUInt16LE(65535, 18); // IFD0 count
  invalid[4]!.writeUInt16LE(4, 22); // orientation type
  for (const app of invalid) {
    await assert.rejects(inspectJpeg(Buffer.concat([image.subarray(0, 2), app, image.subarray(2)])), WdaMediaError);
  }
  await assert.rejects(inspectJpeg(Buffer.concat([image.subarray(0, 2), exif(1), exif(1), image.subarray(2)])), WdaMediaError);
});
await test("valid EXIF without orientation defaults to one; duplicate orientation is malformed", async () => {
  const missing = exif(1);
  missing.writeUInt16LE(0, 18);
  missing.writeUInt32LE(0, 20);
  const bytes = Buffer.concat([image.subarray(0, 2), missing, image.subarray(2)]);
  assert.equal((await inspectJpeg(bytes)).orientation, 1);
  const duplicated = Buffer.alloc(44);
  exif(1).subarray(4, 30).copy(duplicated);
  duplicated.writeUInt16LE(2, 14);
  duplicated.copy(duplicated, 28, 16, 28);
  const invalid = Buffer.concat([image.subarray(0, 2), segment(0xe1, duplicated), image.subarray(2)]);
  await assert.rejects(inspectJpeg(invalid), WdaMediaError);
});
