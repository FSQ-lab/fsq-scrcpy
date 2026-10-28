import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { OutputWriter, type RecordStream } from "../src/output.js";

class Sink extends EventEmitter implements RecordStream {
  readonly chunks: Buffer[] = [];
  readonly actions: string[] = [];
  destroyed = false;
  writableEnded = false;
  returned = true;
  callback: ((error?: Error | null) => void) | undefined;
  throwCause: unknown;
  write(chunk: Uint8Array, callback: (error?: Error | null) => void): boolean {
    this.actions.push("write"); this.chunks.push(Buffer.from(chunk)); this.callback = callback;
    if (this.throwCause) throw this.throwCause;
    return this.returned;
  }
  finish(error?: Error): void { this.actions.push("callback"); this.callback?.(error); }
  drain(): void { this.actions.push("drain"); this.emit("drain"); }
}
const error = (code: string): Error & { code: string } => Object.assign(new Error("private cause"), { code });
async function settled(value: Promise<unknown>): Promise<boolean> {
  return await Promise.race([value.then(() => true, () => true), new Promise<false>((resolve) => setImmediate(() => resolve(false)))]);
}

await test("RFC7464 framing is byte-exact for Unicode and writer never owns stdout", async () => {
  const sink = new Sink(), writer = new OutputWriter(sink, () => assert.fail("unexpected abort"));
  const pending = writer.write({ text: "设备é" }, true);
  assert.deepEqual(sink.chunks[0], Buffer.concat([Buffer.from([0x1e]), Buffer.from('{"text":"设备é"}'), Buffer.from([0x0a])]));
  assert.equal(await settled(pending), false);
  sink.finish(); await pending; writer.dispose(); writer.dispose();
  assert.equal(sink.listenerCount("error"), 0); assert.equal(sink.listenerCount("close"), 0);
  assert.equal(Object.hasOwn(sink, "end"), false); assert.equal(Object.hasOwn(sink, "destroy"), false);
});

await test("backpressure requires both callback and drain in either order", async () => {
  for (const order of ["callback-first", "drain-first"] as const) {
    const sink = new Sink(); sink.returned = false;
    const writer = new OutputWriter(sink, () => assert.fail("unexpected abort"));
    const pending = writer.write({ ok: true }, true);
    if (order === "callback-first") { sink.finish(); assert.equal(await settled(pending), false); sink.drain(); }
    else { sink.drain(); assert.equal(await settled(pending), false); sink.finish(); }
    await pending;
    assert.deepEqual(sink.actions, order === "callback-first" ? ["write", "callback", "drain"] : ["write", "drain", "callback"]);
    writer.dispose();
  }
});

await test("true writes still wait for callback and one writer owns at most one record", async () => {
  const sink = new Sink(); let aborts = 0;
  const writer = new OutputWriter(sink, () => { aborts++; });
  const first = writer.write({ revision: 1 }, true);
  assert.equal(await settled(first), false);
  const firstRejected = assert.rejects(first);
  await assert.rejects(writer.write({ revision: 2 }, true));
  await firstRejected;
  assert.equal(sink.chunks.length, 1); assert.equal(aborts, 1); assert.equal(writer.failure?.exitStatus, 5);
  writer.dispose();
});

await test("the exact 16386-byte record is accepted and one byte more fails closed", async () => {
  const exact = new Sink(), accepted = new OutputWriter(exact, () => undefined);
  const pending = accepted.write({ x: "a".repeat(16_376) }, true);
  assert.equal(exact.chunks[0]!.byteLength, 16_386); exact.finish(); await pending; accepted.dispose();
  const oversized = new Sink(); let aborted = 0; const rejected = new OutputWriter(oversized, () => { aborted++; });
  await assert.rejects(rejected.write({ x: "a".repeat(16_377) }, true));
  assert.equal(rejected.failure?.exitStatus, 5); assert.equal(oversized.chunks.length, 0); assert.equal(aborted, 1); rejected.dispose();
});

await test("EPIPE, close, other errors, callback failures, and unavailable streams classify exactly", async () => {
  for (const [kind, expected] of [["epipe-throw", 3], ["epipe-callback", 3], ["epipe-event", 3], ["close", 3], ["other-throw", 5], ["other-callback", 5], ["other-event", 5]] as const) {
    const sink = new Sink(); let aborts = 0; const writer = new OutputWriter(sink, () => { aborts++; });
    if (kind.endsWith("throw")) sink.throwCause = error(kind.startsWith("epipe") ? "EPIPE" : "EIO");
    const pending = writer.write({ private: "not rendered twice" }, true);
    if (kind.endsWith("callback")) sink.finish(error(kind.startsWith("epipe") ? "EPIPE" : "EIO"));
    else if (kind.endsWith("event")) sink.emit("error", error(kind.startsWith("epipe") ? "EPIPE" : "EIO"));
    else if (kind === "close") sink.emit("close");
    await assert.rejects(pending);
    assert.equal(writer.failure?.exitStatus, expected, kind); assert.equal(aborts, 1, kind); assert.equal(sink.chunks.length, 1, kind);
    writer.dispose();
  }
  for (const property of ["destroyed", "writableEnded"] as const) {
    const sink = new Sink(); sink[property] = true; let aborts = 0; const writer = new OutputWriter(sink, () => { aborts++; });
    assert.equal(writer.failure?.exitStatus, 3); assert.equal(aborts, 1); await assert.rejects(writer.write({}, true)); writer.dispose();
  }
});
