import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import { Socket } from "node:net";
import { CaptureOpenError, WdaMjpegCaptureAdapter, type CaptureEvent, type CaptureSession } from "../src/index.js";
import { deviceRef, jpeg, loopback, part, RESPONSE, waitFor } from "./wda-fixtures.js";

async function next(iterator: AsyncIterator<CaptureEvent>, kind: CaptureEvent["kind"]): Promise<CaptureEvent> {
  const result = await iterator.next();
  assert.equal(result.value?.kind, kind);
  return result.value!;
}
async function drain(session: CaptureSession): Promise<CaptureEvent[]> {
  const events: CaptureEvent[] = [];
  for await (const event of session.events()) events.push(event);
  return events;
}
await test("strict complete copied binding and endpoint policy reject without connecting", async () => {
  const source = await loopback();
  try {
    const valid = { deviceRef, endpoint: source.endpoint };
    for (const endpoint of [
      "http://localhost:1/", "http://[::1]:1/", "http://127.0.0.1:0/", "http://127.0.0.1:65536/",
      "http://127.0.0.1:01/", "http://127.0.0.1/", "https://127.0.0.1:1/", "http://127.0.0.1:1",
      "http://127.0.0.1:1/path", "http://127.0.0.1:1/?x", "http://127.0.0.1:1/#x", "http://a@127.0.0.1:1/",
      "http://2130706433:1/", "http://127.0.0.1:1/\n",
    ]) assert.throws(() => new WdaMjpegCaptureAdapter({ ...valid, endpoint }), CaptureOpenError);
    const accessor = Object.defineProperty({}, "endpoint", { enumerable: true, get: () => { throw new Error("Must not invoke getter"); } });
    for (const value of [{ ...valid, extra: true }, Object.create(valid), accessor, { ...valid, deviceRef: { ...deviceRef, platform: "android" } }]) {
      assert.throws(() => new WdaMjpegCaptureAdapter(value), CaptureOpenError);
    }
    const mutable = { ...deviceRef, namespace: String(deviceRef.namespace) };
    const binding = { deviceRef: mutable, endpoint: source.endpoint };
    const adapter = new WdaMjpegCaptureAdapter(binding);
    mutable.namespace = "different.domain";
    binding.endpoint = "http://127.0.0.1:1/";
    for (const request of [
      {}, { deviceRef, extra: true }, { deviceRef, videoConstraints: {} }, Object.create({ deviceRef }),
      ...[{ contractVersion: 1 }, { platform: "android" }, { namespace: "other.domain" }, { opaqueId: "123e4567-e89b-42d3-a456-426614174001" }, { provider: "wda" }].map((delta) => ({ deviceRef: { ...deviceRef, ...delta } })),
    ]) await assert.rejects(adapter.open(request), CaptureOpenError);
    const cancelled = new AbortController();
    cancelled.abort("PRIVATE_PROVIDER_REASON");
    await assert.rejects(adapter.open({ deviceRef }, cancelled.signal), CaptureOpenError);
    assert.equal(source.sockets.size, 0);
    const session = await adapter.open({ deviceRef });
    await source.client();
    await session.stop("explicit-stop");
  } finally { await source.close(); }
});
await test("real loopback adapter emits JPEG, orientation epochs, monotonic PTS/sequence and no Config", async () => {
  const source = await loopback(), cancellation = new AbortController();
  try {
    const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint });
    const session = await adapter.open({ deviceRef }, cancellation.signal), client = await source.client();
    const iterator = session.events()[Symbol.asyncIterator]();
    const first = jpeg(8, 16, 1);
    for (const byte of Buffer.concat([RESPONSE, part(first)])) client.write(Buffer.from([byte]));
    const start = await next(iterator, "SessionStarted");
    assert.deepEqual(start, { kind: "SessionStarted", epoch: 1, codec: "mjpeg", codedSize: { width: 8, height: 16 }, displaySize: { width: 8, height: 16 }, timebase: 1_000_000, timestampOrigin: "host-arrival" });
    const frame1 = await next(iterator, "Frame");
    assert.ok(frame1.kind === "Frame");
    assert.equal(frame1.sequence, 1n);
    assert.equal(frame1.key, true);
    assert.ok(frame1.ptsUs >= 0n);
    assert.deepEqual(frame1.bytes, first);
    for (const [width, height, orientation, epoch] of [[8, 16, 6, 2], [8, 16, 8, 3], [16, 16, 8, 4]] as const) {
      client.write(part(jpeg(width, height, orientation)));
      assert.deepEqual(await next(iterator, "SessionEnded"), { kind: "SessionEnded", epoch: epoch - 1, cause: "reconfigured" });
      const started = await next(iterator, "SessionStarted");
      assert.ok(started.kind === "SessionStarted");
      assert.equal(started.epoch, epoch);
      assert.deepEqual(started.displaySize, { width: height, height: width });
      const frame = await next(iterator, "Frame");
      assert.ok(frame.kind === "Frame");
      assert.equal(frame.sequence, BigInt(epoch));
      assert.ok(frame.ptsUs >= frame1.ptsUs);
    }
    cancellation.abort("PRIVATE_PROVIDER_REASON");
    const closed = await session.closed();
    assert.deepEqual(closed, { status: "ended", cause: "cancelled" });
    assert.equal(await session.stop("explicit-stop"), closed);
    assert.equal(await session.closed(), closed);
    assert.deepEqual(await next(iterator, "SessionEnded"), { kind: "SessionEnded", epoch: 4, cause: "cancelled" });
    await next(iterator, "CaptureEnded");
    assert.equal((await iterator.next()).done, true);
    await waitFor(() => source.sockets.size === 0);
    assert.equal(source.server.listening, true);
    assert.equal(source.requests.length, 1);
    assert.match(source.requests[0]!, /^GET \/ HTTP\/1\.0\r\nHost: 127\.0\.0\.1:[1-9][0-9]*\r\nConnection: close\r\n\r\n$/);
    const probe = new Socket();
    const connected = new Promise<void>((resolve) => probe.once("connect", resolve));
    probe.connect({ port: Number(new URL(source.endpoint).port), host: "127.0.0.1" });
    await connected;
    probe.destroy();
  } finally { await source.close(); }
});
await test("one pending JPEG is latest-wins with drop evidence and no decoder GAP", async () => {
  const source = await loopback();
  try {
    const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
    const client = await source.client(), image = jpeg();
    client.write(Buffer.concat([RESPONSE, ...Array.from({ length: 25 }, () => part(image))]));
    await waitFor(() => session.droppedFrames === 24n);
    const iterator = session.events()[Symbol.asyncIterator]();
    await next(iterator, "SessionStarted");
    const frame = await next(iterator, "Frame");
    assert.ok(frame.kind === "Frame");
    assert.equal(frame.sequence, 25n);
    assert.deepEqual(frame.bytes, image);
    await session.stop("explicit-stop");
    await next(iterator, "SessionEnded");
    await next(iterator, "CaptureEnded");
    assert.equal((await iterator.next()).done, true);
  } finally { await source.close(); }
});
await test("bounded nondroppable controls overload without losing ordering or terminal", async () => {
  const source = await loopback();
  try {
    const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
    const client = await source.client();
    client.write(Buffer.concat([RESPONSE, ...Array.from({ length: 40 }, (_, i) => part(jpeg(8 + i, 16)))]));
    const result = await session.closed();
    assert.ok(result.status === "failed");
    assert.equal(result.error.code, "runtime-overload");
    const events = await drain(session);
    assert.ok(events.length <= 64);
    assert.equal(events.filter((event) => event.kind === "CaptureFailed").length, 1);
    assert.equal(events.at(-1)?.kind, "CaptureFailed");
    assert.ok(!events.some((event) => event.kind === "Frame" || event.kind === "Discontinuity"));
    await waitFor(() => source.sockets.size === 0);
  } finally { await source.close(); }
});
await test("concurrent stop/cancel clears partial reads, caches the first cause and allows later explicit open", async () => {
  const source = await loopback();
  try {
    const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint });
    const opening = adapter.open({ deviceRef });
    await assert.rejects(adapter.open({ deviceRef }), CaptureOpenError);
    const session = await opening, client = await source.client();
    client.write(Buffer.concat([RESPONSE, part(jpeg()).subarray(0, -10)]));
    const stopped = session.stop("explicit-stop"), cancelled = session.stop("cancelled");
    assert.equal(stopped, cancelled);
    const result = await stopped;
    assert.equal(result, await session.closed());
    assert.deepEqual(result, { status: "ended", cause: "explicit-stop" });
    assert.deepEqual(await drain(session), [{ kind: "CaptureEnded", cause: "explicit-stop" }]);
    await waitFor(() => source.sockets.size === 0);
    const reopened = await adapter.open({ deviceRef });
    await source.client();
    await reopened.stop("cancelled");
    assert.equal(source.requests.length, 2);
  } finally { await source.close(); }
});
await test("source EOF/reset never claims device-disconnected and errors/inspect never reveal locators", async () => {
  for (const reset of [false, true]) {
    const source = await loopback();
    try {
      const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint });
      const session = await adapter.open({ deviceRef }), client = await source.client();
      const iterator = session.events()[Symbol.asyncIterator]();
      client.write(Buffer.concat([RESPONSE, part(jpeg())]));
      await next(iterator, "SessionStarted");
      await next(iterator, "Frame");
      if (reset) client.destroy(); else client.end();
      const result = await session.closed();
      assert.ok(result.status === "failed");
      assert.equal(result.error.code, "stream-interrupted");
      const safe = JSON.stringify([adapter, session, result]) + inspect(adapter, { showHidden: true, depth: 10 }) + inspect(session, { showHidden: true, depth: 10 });
      assert.ok(!safe.includes(source.endpoint));
      assert.ok(!safe.includes("127.0.0.1"));
      assert.ok(!safe.includes("PRIVATE_PROVIDER_REASON"));
      await next(iterator, "SessionEnded");
      await next(iterator, "CaptureFailed");
      assert.equal((await iterator.next()).done, true);
      assert.equal(await session.stop("cancelled"), result);
    } finally { await source.close(); }
  }
});
await test("malformed response and JPEG fail closed once, with safe errors and no retry", async () => {
  for (const wire of [Buffer.from("HTTP/1.0 302 Found\r\nLocation: PRIVATE_PROVIDER_REASON\r\n\r\n"), Buffer.concat([RESPONSE, part(Buffer.from([255, 216, 255, 217]))])]) {
    const source = await loopback();
    try {
      const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
      (await source.client()).write(wire);
      const closed = await session.closed();
      assert.ok(closed.status === "failed");
      assert.equal(closed.error.code, "malformed-media");
      assert.ok(!JSON.stringify(closed).includes("PRIVATE_PROVIDER_REASON"));
      assert.equal((await drain(session)).at(-1)?.kind, "CaptureFailed");
      assert.equal(source.requests.length, 1);
      await waitFor(() => source.sockets.size === 0);
    } finally { await source.close(); }
  }
});
await test("cancel during connection/header wait releases the local socket only", async () => {
  const source = await loopback();
  try {
    const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint });
    const controller = new AbortController(), opening = adapter.open({ deviceRef }, controller.signal);
    controller.abort("PRIVATE_PROVIDER_REASON");
    await assert.rejects(opening, (cause: unknown) => cause instanceof CaptureOpenError && !inspect(cause).includes("PRIVATE_PROVIDER_REASON"));
    await waitFor(() => source.sockets.size === 0);
    const headers = new AbortController(), session = await adapter.open({ deviceRef }, headers.signal);
    await source.client();
    headers.abort();
    assert.deepEqual(await session.closed(), { status: "ended", cause: "cancelled" });
    assert.deepEqual(await drain(session), [{ kind: "CaptureEnded", cause: "cancelled" }]);
    assert.equal(source.server.listening, true);
  } finally { await source.close(); }
});
await test("initial connection failure is a sanitized dependency error", async () => {
  const source = await loopback(), endpoint = source.endpoint;
  await source.close();
  const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint });
  await assert.rejects(adapter.open({ deviceRef }), (cause: unknown) => cause instanceof CaptureOpenError && cause.error.code === "dependency-unavailable" && !inspect(cause).includes(endpoint));
});
await test("header has a five-second absolute deadline, media read idle is twelve seconds", async (t) => {
  const source = await loopback();
  try {
    const adapter = new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint });
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const headerWait = await adapter.open({ deviceRef });
    (await source.client()).write(Buffer.from("H"));
    t.mock.timers.tick(4999);
    let settled = false;
    void headerWait.closed().then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false);
    t.mock.timers.tick(1);
    const headerFailure = await headerWait.closed();
    assert.ok(headerFailure.status === "failed");
    assert.equal(headerFailure.error.code, "stream-interrupted");
    const session = await adapter.open({ deviceRef }), client = await source.client();
    // Complete valid input switches the absolute header timer to read-idle.
    client.write(Buffer.concat([RESPONSE, part(jpeg())]));
    const iterator = session.events()[Symbol.asyncIterator]();
    await next(iterator, "SessionStarted");
    await next(iterator, "Frame");
    t.mock.timers.tick(11_999);
    client.write(part(jpeg()));
    await next(iterator, "Frame");
    t.mock.timers.tick(11_999);
    const winning = session.stop("explicit-stop");
    assert.deepEqual(await winning, { status: "ended", cause: "explicit-stop" });
    // Keep one fake clock across sessions so every timer has the same owner.
    const idle = await adapter.open({ deviceRef }), idleClient = await source.client();
    idleClient.write(RESPONSE);
    idleClient.write(part(jpeg()));
    const idleIterator = idle.events()[Symbol.asyncIterator]();
    await next(idleIterator, "SessionStarted");
    await next(idleIterator, "Frame");
    t.mock.timers.tick(12_000);
    const result = await idle.closed();
    assert.ok(result.status === "failed");
    assert.equal(result.error.code, "stream-interrupted");
  } finally { t.mock.timers.reset(); await source.close(); }
});
await test("a replaced old-epoch JPEG cannot cross reconfiguration controls", async () => {
  const source = await loopback();
  try {
    const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
    (await source.client()).write(Buffer.concat([RESPONSE, part(jpeg(8, 16, 1)), part(jpeg(8, 16, 6))]));
    await waitFor(() => session.droppedFrames === 1n);
    const iterator = session.events()[Symbol.asyncIterator]();
    await next(iterator, "SessionStarted");
    await next(iterator, "SessionEnded");
    const started = await next(iterator, "SessionStarted");
    assert.ok(started.kind === "SessionStarted");
    assert.equal(started.epoch, 2);
    const frame = await next(iterator, "Frame");
    assert.ok(frame.kind === "Frame");
    assert.equal(frame.epoch, 2);
    assert.equal(frame.sequence, 2n);
    await session.stop("explicit-stop");
  } finally { await source.close(); }
});
await test("proxy environment cannot change the direct source socket", async () => {
  const source = await loopback();
  const keys = ["HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = "http://127.0.0.1:1/";
    const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
    await source.client();
    await session.stop("explicit-stop");
    assert.equal(source.requests.length, 1);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    await source.close();
  }
});
await test("partial EOF is malformed and never emits a fabricated epoch", async () => {
  const source = await loopback();
  try {
    const session = await new WdaMjpegCaptureAdapter({ deviceRef, endpoint: source.endpoint }).open({ deviceRef });
    (await source.client()).end(Buffer.concat([RESPONSE, part(jpeg()).subarray(0, -8)]));
    const result = await session.closed();
    assert.ok(result.status === "failed");
    assert.equal(result.error.code, "malformed-media");
    assert.deepEqual(await drain(session), [{ kind: "CaptureFailed", error: result.error }]);
  } finally { await source.close(); }
});
