import assert from "node:assert/strict";
import { WdaMjpegCaptureAdapter, type CaptureEvent } from "../src/index.js";
import { deviceRef, jpeg, loopback, part, RESPONSE, waitFor } from "./wda-fixtures.js";

// Synthetic loopback only: no WDA, device, USB forward or browser is accessed.
const external = await loopback();
const cancellation = new AbortController();
try {
  const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: external.endpoint });
  const session = await adapter.open({ deviceRef }, cancellation.signal);
  const source = await external.client();
  const iterator = session.events()[Symbol.asyncIterator]();
  const take = async (kind: CaptureEvent["kind"]): Promise<CaptureEvent> => {
    const result = await iterator.next();
    assert.equal(result.value?.kind, kind);
    return result.value!;
  };
  const first = jpeg(8, 16, 1);
  source.write(Buffer.concat([RESPONSE, part(first)]));
  await take("SessionStarted");
  const frame = await take("Frame");
  assert.ok(frame.kind === "Frame");
  assert.deepEqual(frame.bytes, first);
  assert.equal(frame.key, true);
  source.write(part(jpeg(8, 16, 6)));
  assert.deepEqual(await take("SessionEnded"), { kind: "SessionEnded", epoch: 1, cause: "reconfigured" });
  const changed = await take("SessionStarted");
  assert.ok(changed.kind === "SessionStarted");
  assert.equal(changed.epoch, 2);
  assert.deepEqual(changed.displaySize, { width: 16, height: 8 });
  const rotated = await take("Frame");
  assert.ok(rotated.kind === "Frame");
  assert.ok(rotated.sequence > frame.sequence && rotated.ptsUs >= frame.ptsUs);
  cancellation.abort();
  const closed = await session.closed();
  assert.deepEqual(closed, { status: "ended", cause: "cancelled" });
  assert.equal(await session.stop("explicit-stop"), closed);
  await take("SessionEnded");
  await take("CaptureEnded");
  assert.equal((await iterator.next()).done, true);
  await waitFor(() => external.sockets.size === 0);
  assert.equal(external.server.listening, true);
  // A new explicit attach proves cancellation did not stop the source listener.
  const again = await adapter.open({ deviceRef });
  const nextSource = await external.client();
  nextSource.write(Buffer.concat([RESPONSE, part(first)]));
  const second = again.events()[Symbol.asyncIterator]();
  assert.equal((await second.next()).value?.kind, "SessionStarted");
  assert.equal((await second.next()).value?.kind, "Frame");
  await again.stop("explicit-stop");
  await waitFor(() => external.sockets.size === 0);
  console.log("PASS synthetic actual Adapter: JPEG, epoch change, monotonic timing, cancellation, source survival");
} finally {
  cancellation.abort();
  await external.close();
}
