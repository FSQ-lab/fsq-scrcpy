import type { CaptureEvent } from "../../capture/src/session.js";
import type { SnapshotReason } from "../../contracts/src/index.js";
import type { Clock } from "./clock.js";
type Session = Extract<CaptureEvent, { kind: "SessionStarted" }>;
export class MjpegFreshness {
  #session: Session | undefined;
  #first: number | undefined;
  #baseline = 0;
  #painted = false;
  #visible = false;
  #live = false;
  #fenced = false;
  #timer: object | undefined;
  constructor(readonly clock: Clock, readonly phase: (phase: "syncing" | "streaming" | "interrupted", session: Session) => void, readonly terminal: (reason: SnapshotReason) => void) {}
  session(session: Session): void {
    this.#session = session;
    this.#live = false;
    if (this.#visible && !this.#fenced) this.phase("syncing", session);
  }
  visibility(visible: boolean): void {
    if (this.#fenced || !this.check() || visible === this.#visible) return;
    this.#visible = visible;
    this.#live = false;
    this.#clear();
    if (!visible) return;
    const now = this.clock.mono();
    this.#first ??= now + 5_000;
    if (this.#painted) this.#baseline = now;
    if (!this.check()) return;
    if (this.#session) this.phase("syncing", this.#session);
    this.#schedule();
  }
  ack(epoch: number | undefined): boolean {
    if (!this.check()) return false;
    if (epoch === undefined || !this.#visible || epoch !== this.#session?.epoch) return true;
    const session = this.#session;
    if (!this.#live) this.phase("syncing", session);
    this.#painted = true;
    this.#baseline = this.clock.mono();
    this.#live = true;
    this.phase("streaming", session);
    this.#schedule();
    return true;
  }
  check(): boolean {
    if (this.#fenced) return false;
    if (!this.#visible || this.#first === undefined) return true;
    const now = this.clock.mono();
    if (!this.#painted && now >= this.#first || this.#painted && now >= this.#baseline + 12_000) {
      const reason = this.#painted ? "stream-interrupted" : "start-timeout";
      this.close();
      this.terminal(reason);
      return false;
    }
    if (this.#live && now >= this.#baseline + 2_000) {
      this.#live = false;
      if (this.#session) this.phase("interrupted", this.#session);
    }
    return true;
  }
  close(): void { this.#fenced = true; this.#live = false; this.#clear(); }
  #clear(): void { if (this.#timer) this.clock.clear(this.#timer); this.#timer = undefined; }
  #schedule(): void {
    this.#clear();
    if (this.#fenced || !this.#visible || this.#first === undefined) return;
    const deadline = this.#painted ? this.#baseline + (this.#live ? 2_000 : 12_000) : this.#first;
    this.#timer = this.clock.set(Math.max(0, deadline - this.clock.mono()), () => {
      this.#timer = undefined;
      if (this.check()) this.#schedule();
    });
  }
}
