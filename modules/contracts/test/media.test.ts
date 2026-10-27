import assert from "node:assert/strict";
import test from "node:test";
import {
  ContractValidationError, MEDIA_HEADER_BYTES, MEDIA_KIND, MAX_CONFIG_BYTES, MAX_FRAME_BYTES,
  MAX_PAYLOAD_BYTES, decodeMediaHeader, encodeMediaHeader, type MediaHeader
} from "../src/index.js";

const frame: MediaHeader = { minor: 0, kind: MEDIA_KIND.frame, flags: 1, payloadBytes: 3, sequence: 1n, epoch: 2n, ptsUs: 3n };
const invalid = (run: () => unknown) => assert.throws(run, ContractValidationError);
const message = (header: MediaHeader): Uint8Array => {
  const encoded = encodeMediaHeader(header);
  const result = new Uint8Array(MEDIA_HEADER_BYTES + header.payloadBytes);
  result.set(encoded);
  return result;
};

test("40-byte big-endian header has exact bytes and round trips", () => {
  const encoded = encodeMediaHeader(frame);
  assert.equal(Buffer.from(encoded).toString("hex"), "46535156010003010028000000000003000000000000000100000000000000020000000000000003");
  assert.deepEqual(decodeMediaHeader(message(frame)), frame);
  const validKinds: MediaHeader[] = [
    { minor: 0, kind: 1, flags: 0, payloadBytes: 24, sequence: 1n, epoch: 1n, ptsUs: -1n },
    { minor: 0, kind: 2, flags: 0, payloadBytes: MAX_CONFIG_BYTES, sequence: 2n, epoch: 1n, ptsUs: -1n },
    { minor: 0, kind: 3, flags: 0, payloadBytes: 1, sequence: 3n, epoch: 1n, ptsUs: -(1n << 63n) },
    { minor: 0, kind: 3, flags: 1, payloadBytes: MAX_FRAME_BYTES, sequence: 4n, epoch: 1n, ptsUs: (1n << 63n) - 1n },
    { minor: 0, kind: 4, flags: 0, payloadBytes: 12, sequence: (1n << 64n) - 1n, epoch: (1n << 64n) - 1n, ptsUs: -1n },
    { minor: 0, kind: 5, flags: 0, payloadBytes: 4, sequence: 5n, epoch: 0n, ptsUs: -1n }
  ];
  for (const header of validKinds) assert.deepEqual(decodeMediaHeader(message(header)), header);
});

test("decoder fails closed for every fixed field and length violation", () => {
  const base = message(frame);
  const mutate = (offset: number, value: number): Uint8Array => { const copy = base.slice(); copy[offset] = value; return copy; };
  const cases = [
    mutate(0, 0), mutate(1, 0), mutate(2, 0), mutate(3, 0), mutate(4, 2), mutate(5, 2), mutate(6, 0), mutate(7, 2),
    mutate(8, 1), mutate(9, 0), mutate(10, 1), mutate(11, 1), mutate(15, 4), mutate(23, 0), mutate(31, 0)
  ];
  for (const bytes of cases) invalid(() => decodeMediaHeader(bytes));
  invalid(() => decodeMediaHeader(base.subarray(0, 39)));
  invalid(() => decodeMediaHeader(base.subarray(0, base.length - 1)));
  invalid(() => decodeMediaHeader(new Uint8Array([...base, 0])));
  const nonFrameFlag = message({ minor: 0, kind: 1, flags: 0, payloadBytes: 24, sequence: 1n, epoch: 1n, ptsUs: -1n });
  nonFrameFlag[7] = 1;
  invalid(() => decodeMediaHeader(nonFrameFlag));
  const nonFramePts = message({ minor: 0, kind: 5, flags: 0, payloadBytes: 4, sequence: 1n, epoch: 0n, ptsUs: -1n });
  nonFramePts[39] = 0;
  invalid(() => decodeMediaHeader(nonFramePts));
});

test("encoder rejects kind payload, flag and integer hard bounds", () => {
  const changed = (patch: Partial<MediaHeader>): MediaHeader => ({ ...frame, ...patch });
  const cases: MediaHeader[] = [
    changed({ kind: 0 as MediaHeader["kind"] }), changed({ flags: 2 }), changed({ flags: 0.5 }),
    changed({ payloadBytes: 0 }), changed({ payloadBytes: 1.5 }), changed({ payloadBytes: MAX_FRAME_BYTES + 1 }),
    changed({ payloadBytes: MAX_PAYLOAD_BYTES + 1 }),
    changed({ sequence: 0n }), changed({ sequence: 1n << 64n }), changed({ epoch: 0n }),
    changed({ epoch: 1n << 64n }), changed({ ptsUs: -(1n << 63n) - 1n }), changed({ ptsUs: 1n << 63n }),
    { minor: 0, kind: 1, flags: 0, payloadBytes: 23, sequence: 1n, epoch: 1n, ptsUs: -1n },
    { minor: 0, kind: 2, flags: 0, payloadBytes: MAX_CONFIG_BYTES + 1, sequence: 1n, epoch: 1n, ptsUs: -1n },
    { minor: 0, kind: 4, flags: 0, payloadBytes: 11, sequence: 1n, epoch: 1n, ptsUs: -1n },
    { minor: 0, kind: 5, flags: 0, payloadBytes: 5, sequence: 1n, epoch: 0n, ptsUs: -1n }
  ];
  for (const header of cases) invalid(() => encodeMediaHeader(header));
});

test("minor1 retains the envelope and rejects Config, delta JPEG and negative PTS", () => {
  const jpeg: MediaHeader = { ...frame, minor: 1 };
  assert.equal(Buffer.from(encodeMediaHeader(jpeg)).toString("hex"), "46535156010103010028000000000003000000000000000100000000000000020000000000000003");
  assert.deepEqual(decodeMediaHeader(message(jpeg)), jpeg);
  for (const patch of [{kind:2 as const}, {flags:0}, {ptsUs:-1n}, {minor:2 as 1}]) invalid(() => encodeMediaHeader({...jpeg,...patch}));
});
