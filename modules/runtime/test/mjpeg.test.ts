import assert from "node:assert/strict";
import test from "node:test";
import { decodeMediaHeader, MAX_FRAME_BYTES } from "../../contracts/src/index.js";
import type { CaptureEvent } from "../../capture/src/session.js";
import { MediaChannel, MediaRuntime } from "../src/media.js";
import { MjpegFreshness } from "../src/freshness.js";
import type { WsAdapter } from "../src/ws.js";
import { FakeClock } from "./support/runtime-fixtures.js";
class Socket implements WsAdapter {
  bufferedAmount = 0;
  hold = false;
  sent: (readonly Uint8Array[])[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  closes: number[] = [];
  send(parts: readonly Uint8Array[], callback: (error?: Error) => void): void { this.sent.push(parts); if (this.hold) this.callbacks.push(callback); else callback(); }
  close(code: number): void { this.closes.push(code); }
  terminate(): void {}
  onMessage(): void {}
  onClose(): void {}
  onError(): void {}
  complete(): void { const callback = this.callbacks.shift(); assert.ok(callback); callback(); }
  headers() { return this.sent.map(parts => { const bytes = new Uint8Array(parts[0]!.length + parts[1]!.length); bytes.set(parts[0]!); bytes.set(parts[1]!, 40); return decodeMediaHeader(bytes); }); }
}
const session = (epoch = 1): Extract<CaptureEvent, {kind: "SessionStarted"}> => ({kind:"SessionStarted",epoch,codec:"mjpeg",timestampOrigin:"host-arrival",timebase:1_000_000,codedSize:{width:8,height:16},displaySize:{width:8,height:16}});
const frame = (sequence: bigint, size = 4, epoch = 1): Extract<CaptureEvent, {kind: "Frame"}> => ({kind:"Frame",sequence,epoch,ptsUs:sequence,key:true,bytes:new Uint8Array(size)});
function fixture() {
  const ws = new Socket(), clock = new FakeClock(), faults: string[] = [], phases: string[] = [];
  const channel = new MediaChannel(ws, clock, reason => faults.push(reason));
  const runtime = new MediaRuntime(channel, {phase: phase => phases.push(phase), terminal: reason => faults.push(reason)}, "mjpeg");
  channel.visibility(true); channel.setCredit(4, 8_388_608); runtime.event(session());
  return {ws,clock,channel,runtime,faults,phases};
}
test("JPEG assignment waits for both callback and ACK in either order; replacement is unsequenced", () => {
  for (const ackFirst of [true, false]) {
    const f = fixture(); f.ws.hold = true;
    const first = frame(1n), replaced = frame(2n), latest = frame(3n);
    f.runtime.event(first); f.runtime.event(replaced); f.runtime.event(latest);
    assert.equal(f.channel.stats().outstandingFrames, 1);
    assert.equal(f.channel.stagingStats().bytes, 44);
    assert.equal(f.channel.stagingStats().drops, 1);
    const seq = f.channel.stats().highestSentFrame;
    if (ackFirst) assert.equal(f.channel.ackPaint(seq, seq), true); else f.ws.complete();
    assert.equal(f.ws.sent.length, 2);
    if (ackFirst) f.ws.complete(); else assert.equal(f.channel.ackPaint(seq, seq), true);
    assert.deepEqual(f.ws.headers().map(h => h.sequence), [1n, 2n, 3n]);
    assert.equal(f.ws.sent[1]![1], first.bytes);
    assert.equal(f.ws.sent[2]![1], latest.bytes);
    assert.equal(f.channel.stats().outstandingFrames, 1);
    assert.equal(f.channel.stagingStats().bytes, 0);
    f.channel.close(); f.ws.complete();
    assert.equal(f.channel.stagingStats().ownedBytes, 0);
    assert.deepEqual(f.faults, []);
  }
});
test("assigned and staging share a unique byte cap before and after the callback", () => {
  const f = fixture(); f.ws.hold = true;
  f.runtime.event(frame(1n, MAX_FRAME_BYTES));
  const assigned = MAX_FRAME_BYTES + 40;
  assert.equal(f.channel.stagingStats().ownedBytes, assigned);
  f.ws.bufferedAmount = assigned;
  f.runtime.event(frame(2n, MAX_FRAME_BYTES));
  assert.equal(f.channel.stagingStats().bytes, 0);
  assert.equal(f.channel.stagingStats().drops, 1);
  f.ws.complete(); f.ws.bufferedAmount = 0;
  assert.equal(f.channel.stagingStats().ownedBytes, assigned);
  f.ws.bufferedAmount=100_000;
  assert.equal(f.channel.stagingStats().ownedBytes,assigned+100_000);
  f.ws.bufferedAmount=0;
  const remaining = 8_388_608 - 65_536 - assigned;
  f.runtime.event(frame(3n, remaining - 40));
  assert.equal(f.channel.stagingStats().ownedBytes, 8_388_608 - 65_536);
  f.runtime.event(frame(4n, MAX_FRAME_BYTES));
  assert.equal(f.channel.stagingStats().ownedBytes, 8_388_608 - 65_536);
  assert.equal(f.channel.stagingStats().bytes, remaining);
  assert.equal(f.channel.stats().highestSentFrame, 2n);
  assert.equal(f.channel.ackPaint(2n, 0n), true);
  assert.equal(f.channel.stats().highestSentFrame, 3n);
  assert.equal(f.channel.stats().pendingSendBytes, remaining);
  f.channel.close(); assert.equal(f.channel.stagingStats().ownedBytes, 0);
});
test("dual ACK validation is atomic and never retroactively paints a released JPEG", () => {
  const f = fixture(); f.runtime.event(frame(1n)); f.runtime.event(frame(2n));
  const before = f.channel.stats(), sent = f.ws.sent.length;
  for (const [release, paint] of [[2n, 3n], [2n, 1n], [1n, 0n], [3n, 0n]]) {
    assert.equal(f.channel.ackPaint(release!, paint!), false);
    assert.deepEqual(f.channel.stats(), before); assert.equal(f.ws.sent.length, sent);
  }
  assert.equal(f.channel.ackPaint(2n, 0n), true);
  assert.equal(f.channel.ackPaint(2n, 2n), false);
  assert.equal(f.channel.ackPaint(3n, 3n), true);
  assert.equal(f.channel.ackPaint(3n, 3n), true);
  assert.equal(f.channel.ackPaint(2n, 2n), false);
  assert.equal(f.channel.ackPaint(0n, 0n), false);
  assert.equal(f.channel.stagingStats().proofs, 0);
});
test("reason3 retains in-flight proof but discards staging and requires a higher JPEG epoch", () => {
  const f = fixture(), painted: (number | undefined)[] = [];
  f.channel.onAck(epoch => { painted.push(epoch); return true; });
  f.ws.hold = true; f.runtime.event(frame(1n)); f.runtime.event(frame(2n));
  f.runtime.event({kind:"SessionEnded",epoch:1,cause:"reconfigured"});
  f.runtime.event(session(2)); f.runtime.event(frame(3n, 4, 2));
  assert.equal(f.channel.stagingStats().proofs, 1);
  assert.equal(f.channel.ackPaint(2n, 2n), true);
  assert.deepEqual(painted, [undefined]);
  while (f.ws.callbacks.length) f.ws.complete();
  assert.deepEqual(f.ws.headers().map(h => [h.minor, h.kind, h.epoch]), [[1,1,1n],[1,3,1n],[1,4,1n],[1,1,2n],[1,3,2n]]);
  assert.equal(new DataView(f.ws.sent[2]![1]!.buffer).getBigUint64(4), 2n);
  assert.equal(f.channel.ackPaint(5n, 5n), true);
  assert.deepEqual(painted, [undefined, 2]);
  assert.deepEqual(f.faults, []);
});
test("proof capacity is bounded across GAPs and reclaimed by cumulative ACK", () => {
  for (const reclaim of [false, true]) {
    const f = fixture();
    for (let epoch = 1; epoch <= 1024; epoch++) {
      if (epoch > 1) f.channel.sendSession(session(epoch));
      assert.equal(f.channel.sendFrame(frame(BigInt(epoch), 4, epoch)), true);
      f.channel.gap(3, undefined, "backpressure-timeout"); f.channel.recovered();
    }
    assert.equal(f.channel.stagingStats().proofs, 1024);
    const last = f.channel.stats().highestSentFrame;
    if (reclaim) { assert.equal(f.channel.ackPaint(last, 0n), true); assert.equal(f.channel.stagingStats().proofs, 0); }
    f.channel.sendSession(session(1025));
    const count = f.ws.sent.length;
    assert.equal(f.channel.sendFrame(frame(1025n, 4, 1025)), reclaim);
    assert.equal(f.ws.sent.length, count + (reclaim ? 1 : 0));
    assert.deepEqual(f.faults, reclaim ? [] : ["runtime-overload"]);
  }
});
test("visibility fences assigned and staging paint without rejecting legitimate ownership reconciliation", () => {
  const f = fixture(), paints: (number | undefined)[] = [];
  f.channel.onAck(epoch => { paints.push(epoch); return true; });
  f.runtime.event(frame(1n)); f.runtime.event(frame(2n));
  f.channel.visibility(false); f.channel.visibility(true);
  assert.equal(f.channel.stagingStats().bytes, 0);
  assert.equal(f.channel.ackPaint(2n, 2n), true);
  assert.deepEqual(paints, [undefined]);
  f.runtime.event(frame(3n)); assert.equal(f.channel.ackPaint(3n, 3n), true);
  assert.deepEqual(paints, [undefined, 1]);
});
test("MJPEG rejects Config, delta, timestamp regression, wrong codec and unannounced epoch", () => {
  const bad: CaptureEvent[] = [
    {kind:"CodecConfig",epoch:1,bytes:Uint8Array.of(1)}, {...frame(1n),key:false}, {...frame(1n),ptsUs:-1n},
    {...session(2),codec:"h264-annexb",timestampOrigin:"source"}, session(2), {...session(2),codedSize:{width:4097,height:1}},
  ];
  for (const event of bad) { const f = fixture(); f.runtime.event(event); assert.deepEqual(f.faults, ["malformed-media"]); }
  const f = fixture(); f.runtime.event(frame(2n)); f.runtime.event(frame(1n)); assert.deepEqual(f.faults, ["malformed-media"]);
});
test("first paint starts at demand, never Session; delayed ACK timers cannot resurrect", () => {
  const clock = new FakeClock(), phases: string[] = [], reasons: string[] = [];
  const fresh = new MjpegFreshness(clock, phase => phases.push(phase), reason => reasons.push(reason));
  fresh.session(session()); clock.tick(20_000); assert.deepEqual(reasons, []);
  fresh.visibility(true); clock.advanceWithoutTimers(5_000);
  assert.equal(fresh.ack(1), false); assert.deepEqual(reasons, ["start-timeout"]);
  assert.equal(phases.includes("streaming"), false); assert.equal(fresh.ack(1), false);
});
test("fresh paint has exact 2s/12s deadlines, recovery and grace suspension", () => {
  const clock = new FakeClock(), phases: string[] = [], reasons: string[] = [];
  const fresh = new MjpegFreshness(clock, phase => phases.push(phase), reason => reasons.push(reason));
  fresh.session(session()); fresh.visibility(true); assert.equal(fresh.ack(1), true);
  clock.tick(1_999); assert.equal(phases.at(-1), "streaming");
  clock.tick(1); assert.equal(phases.at(-1), "interrupted");
  clock.tick(9_999); assert.equal(fresh.ack(1), true); assert.deepEqual(phases.slice(-2), ["syncing", "streaming"]);
  fresh.visibility(false); clock.tick(30_000); assert.deepEqual(reasons, []);
  fresh.visibility(true); fresh.session(session(2)); assert.equal(fresh.ack(1), true);
  clock.advanceWithoutTimers(11_999); assert.equal(fresh.ack(undefined), true); assert.deepEqual(reasons, []);
  clock.advanceWithoutTimers(1); assert.equal(fresh.ack(2), false); assert.deepEqual(reasons, ["stream-interrupted"]);
});
test("one END is final even with staged data, delayed callback and late ACK", async () => {
  const f = fixture(); f.ws.hold = true; f.runtime.event(frame(1n)); f.runtime.event(frame(2n));
  const end = f.channel.end(4, 1); f.runtime.event(frame(3n));
  while (f.ws.callbacks.length) f.ws.complete(); await end;
  await f.channel.end(4, 1); f.runtime.event(frame(4n)); f.channel.ackPaint(2n, 2n);
  assert.deepEqual(f.ws.headers().map(h => h.kind), [1,3,5]);
  assert.equal(f.channel.stagingStats().ownedBytes, 0); assert.deepEqual(f.ws.closes, [1000]);
});

test("epoch churn and repeated or old proof never extend the 12s no-paint anchor", () => {
  const f=fixture(), reasons:string[]=[], phases:string[]=[];
  const fresh=new MjpegFreshness(f.clock,p=>phases.push(p),reason=>{reasons.push(reason);f.channel.fence();});
  fresh.session(session());fresh.visibility(true);f.channel.onAck(epoch=>fresh.ack(epoch));
  f.runtime.event(frame(1n));assert.equal(f.channel.ackPaint(2n,2n),true);
  for(let epoch=2;epoch<=12;epoch++){
    f.clock.advanceWithoutTimers(1000);fresh.session(session(epoch));
    assert.equal(f.channel.ackPaint(2n,2n),true);
    assert.deepEqual(reasons,[]);
  }
  f.clock.advanceWithoutTimers(1000);assert.equal(f.channel.ackPaint(2n,2n),true);
  assert.deepEqual(reasons,["stream-interrupted"]);assert.equal(phases.at(-1),"syncing");
});

test("expired startup and fresh-paint deadlines win before delayed hide/show can erase them", () => {
  for(const painted of [false,true]){
    const clock=new FakeClock(),phases:string[]=[],reasons:string[]=[];
    const fresh=new MjpegFreshness(clock,phase=>phases.push(phase),reason=>reasons.push(reason));
    fresh.session(session());fresh.visibility(true);if(painted)assert.equal(fresh.ack(1),true);
    clock.advanceWithoutTimers(painted?12_000:5_000);
    fresh.visibility(false);fresh.visibility(true);
    assert.deepEqual(reasons,[painted?"stream-interrupted":"start-timeout"]);
    const before=phases.slice();assert.equal(fresh.ack(1),false);clock.tick(0);
    assert.deepEqual(phases,before);assert.equal(reasons.length,1);
  }
});
