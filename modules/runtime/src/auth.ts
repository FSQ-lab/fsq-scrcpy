import { channel as diagnosticsChannel } from "node:diagnostics_channel";
import { createHmac, timingSafeEqual } from "node:crypto";
import type { ViewerDescriptor } from "../../contracts/src/index.js";
import type { Clock, Entropy } from "./clock.js";
import type { EnsureResult, InspectResult, StopResult, UpgradeDescriptor } from "./types.js";
import { freeze } from "./types.js";
import { MutationCancelled, StateStore } from "./state.js";

const AUTH_DIAGNOSTICS = diagnosticsChannel("fsq.runtime.session.auth.v1");
type SlotState = "vacant" | "armed" | "claim-delivering" | "claimed" | "session-delivering" | "session-issued" | "connected" | "grace";
class ViewerToken {
  #raw: string;
  constructor(raw:string){this.#raw=raw;Object.freeze(this);}
  static reveal(value:ViewerToken):string{return value.#raw;}
  toString():string{return "[REDACTED]";}
  toJSON():string{return "[REDACTED]";}
  [Symbol.toPrimitive]():string{return "[REDACTED]";}
}
Object.defineProperty(ViewerToken.prototype,Symbol.for("nodejs.util.inspect.custom"),{value:()=>"[REDACTED]"});
export type ViewerTokenHandle = ViewerToken;
export function revealViewerToken(value:ViewerTokenHandle):string{return ViewerToken.reveal(value);}
export interface NavigationDecision { readonly claimToken?: ViewerTokenHandle; readonly clearClaim: boolean; readonly clearMedia: boolean; readonly finish?: () => Promise<void>; readonly rollback?: () => Promise<void> }
type FailureKind = "unauthorized" | "conflict" | "limit" | "not-found";
export type AuthResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; kind: FailureKind }>;
export interface SessionDecision { readonly mediaToken: ViewerTokenHandle; readonly finish: () => Promise<void>; readonly rollback: () => Promise<void> }

interface Slot {
  state: SlotState;
  streamId: string;
  permitDeadline: number;
  claimDigest?: Buffer | undefined;
  sessionDigest?: Buffer | undefined;
  sessionId?: string | undefined;
  sessionDeadline?: number | undefined;
  priorSessionDigest?: Buffer | undefined;
  priorSessionDeadline?: number | undefined;
  priorSessionGeneration?: number | undefined;
  sessionGeneration: number;
  generation: number;
  delivery: number;
  permitTimer?: object | undefined;
  sessionTimer?: object | undefined;
  graceTimer?: object | undefined;
  graceDeadline?: number | undefined;
}

const ok = <T>(value: T): AuthResult<T> => freeze({ ok: true, value });
const no = <T>(kind: FailureKind): AuthResult<T> => freeze({ ok: false, kind });
const uuid = (entropy: Entropy): string => {
  const bytes = entropy.bytes(16).slice();
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = Buffer.from(bytes).toString("hex");
  bytes.fill(0);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export class ViewerAuthorization {
  #slot: Slot | undefined;
  #key: Buffer;
  #nextDelivery = 0;

  constructor(readonly state: StateStore, readonly clock: Clock, readonly entropy: Entropy, readonly demandLost: (streamId: string) => void = () => {}) {
    this.#key = Buffer.from(entropy.bytes(32));
    this.state.terminal.register(10, "auth", ({ streamId }) => this.revoke(streamId));
  }

  async ensureStandaloneViewer(value: unknown, signal?: AbortSignal): Promise<EnsureResult> {
    for(;;){
      let wait:Promise<unknown>|undefined;
      const result=await this.state.mutex.run<EnsureResult>(() => {
        if (signal?.aborted) throw new MutationCancelled();
        const ensured = this.state.ensureLocked(value);
        if (!ensured.ok) return ensured;
        if (!this.state.hasActive(ensured.value.snapshot.streamId)) { wait=this.state.terminal.flight(ensured.value.snapshot.streamId); return ensured; }
        const descriptor = this.armEnsuredStreamLocked(ensured.value.snapshot.streamId);
        return freeze({ ok: true, value: freeze({ descriptor, snapshot: ensured.value.snapshot }) });
      });
      if(wait){await wait;continue;}return result;
    }
  }
  armEnsuredStreamLocked(streamId: string): ViewerDescriptor {
    this.#expire();
    let slot = this.#slot;
    if (slot && slot.streamId !== streamId) {
      this.#release(slot);
      slot = undefined;
    }
    if (!slot) {
      slot = { state: "vacant", streamId, permitDeadline: 0, generation: 0, sessionGeneration: 0, delivery: 0 };
      this.#slot = slot;
    }
    if (slot.state === "vacant") {
      slot.state = "armed";
      slot.permitDeadline = this.clock.mono() + 30_000;
      slot.generation++;
      this.#armPermit(slot);
      this.#event("arm", "accepted", slot);
      return this.state.descriptor(streamId, this.clock.wall() + 30_000);
    }
    return this.state.descriptor(streamId);
  }

  inspect(value: unknown): InspectResult { return this.state.inspect(value); }
  stop(value: unknown): Promise<StopResult> { return this.state.stop(value); }

  async navigate(streamId: string, claimToken?: string, mediaToken?: string): Promise<AuthResult<NavigationDecision>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!this.state.hasActive(streamId)) return no("not-found");
      if (!slot || slot.streamId !== streamId) return no("conflict");
      if (mediaToken && this.#mediaMatches(slot, mediaToken, ["session-issued", "connected", "grace"])) return ok(freeze({ clearClaim: !!claimToken, clearMedia: false }));
      if (claimToken && this.#claimMatches(slot, claimToken) && ["claimed", "session-delivering", "session-issued"].includes(slot.state)) return ok(freeze({ clearClaim: false, clearMedia: false }));
      if (slot.state !== "armed") return no("conflict");
      const token = this.#token();
      const delivery = ++this.#nextDelivery;
      slot.claimDigest = this.#digest(token, this.#claimContext(slot));
      slot.delivery = delivery;
      slot.state = "claim-delivering";
      return ok(freeze({
        claimToken: new ViewerToken(token),
        clearClaim: !!claimToken,
        clearMedia: !!mediaToken,
        finish: () => this.#finishClaim(slot, delivery),
        rollback: () => this.#rollbackClaim(slot, delivery),
      }));
    });
  }

  async createSession(streamId: string, claimToken: string, mediaToken?: string): Promise<AuthResult<SessionDecision>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!slot || slot.streamId !== streamId || !this.state.hasActive(streamId)) return no("unauthorized");
      if (slot.state === "session-issued") {
        if (mediaToken && this.#mediaMatches(slot, mediaToken, ["session-issued"]) && this.#claimMatches(slot,claimToken,true)) return ok(freeze({ mediaToken:new ViewerToken(mediaToken), finish: async () => {}, rollback: async () => {} }));
        if (!this.#claimMatches(slot,claimToken)) return no("unauthorized");
        slot.priorSessionDigest=slot.sessionDigest && Buffer.from(slot.sessionDigest);slot.priorSessionDeadline=slot.sessionDeadline;slot.priorSessionGeneration=slot.sessionGeneration;
      } else {
        if (!this.#claimMatches(slot, claimToken)) return no("unauthorized");
        if (slot.state === "session-delivering") return no("conflict");
        if (slot.state !== "claimed") return no("conflict");
      }
      const token = this.#rotateSession(slot);
      const delivery = ++this.#nextDelivery;
      slot.delivery = delivery;
      slot.state = "session-delivering";
      return ok(freeze({
        mediaToken: new ViewerToken(token),
        finish: () => this.#finishSession(slot, delivery),
        rollback: () => this.#rollbackSession(slot, delivery),
      }));
    });
  }

  async refresh(token: string): Promise<AuthResult<ViewerTokenHandle>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!slot || !this.#mediaMatches(slot, token, ["session-issued", "connected", "grace"])) return no("unauthorized");
      const rotated = this.#rotateSession(slot);
      this.#armSession(slot);
      this.#event("refresh", "accepted", slot);
      return ok(new ViewerToken(rotated));
    });
  }

  async deleteSession(claimToken?: string, mediaToken?: string): Promise<AuthResult<undefined>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!slot) return no("unauthorized");
      const preconnect = !!claimToken && this.#claimMatches(slot, claimToken) && ["claimed", "session-delivering", "session-issued"].includes(slot.state);
      const postconnect = !!mediaToken && this.#mediaMatches(slot, mediaToken, ["connected", "grace"]);
      if (!preconnect && !postconnect) return no("unauthorized");
      if (preconnect) this.#vacate(slot);
      else {
        slot.sessionDigest=undefined;
        if(slot.sessionTimer)this.clock.clear(slot.sessionTimer);
        slot.sessionTimer=undefined;
        this.#beginGrace(slot);
      }
      return ok(undefined);
    });
  }

  async validateUpgrade(token: string): Promise<AuthResult<UpgradeDescriptor>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!slot || !this.state.hasActive(slot.streamId) || !this.#mediaMatches(slot, token, ["session-issued", "grace"]) || !slot.sessionId || slot.sessionDeadline === undefined) return no(slot?.state === "connected" ? "limit" : "unauthorized");
      return ok(freeze({ streamId: slot.streamId, sessionId: slot.sessionId, generation: slot.sessionGeneration, deadline: slot.sessionDeadline }));
    });
  }

  async validateConnection(descriptor: UpgradeDescriptor): Promise<AuthResult<undefined>> {
    return this.state.mutex.run(() => this.#checkConnection(descriptor));
  }

  async connect(descriptor: UpgradeDescriptor): Promise<AuthResult<undefined>> {
    return this.state.mutex.run(() => {
      const checked = this.#checkConnection(descriptor);
      if (!checked.ok) return checked;
      const slot = this.#slot!;
      slot.claimDigest = undefined;
      slot.state = "connected";
      if (slot.graceDeadline === undefined) this.state.transitionLocked(slot.streamId, "syncing", 1);
      return ok(undefined);
    });
  }

  async resumeVisible(sessionId: string, activate: () => boolean = () => true): Promise<AuthResult<undefined>> {
    return this.state.mutex.run(() => {
      this.#expire();
      const slot = this.#slot;
      if (!slot || !["connected", "grace"].includes(slot.state) || slot.sessionId !== sessionId || !slot.sessionDigest || !this.state.hasActive(slot.streamId) || this.#graceExpired(slot)) return no("unauthorized");
      if (!activate()) return ok(undefined);
      const returning = slot.graceDeadline !== undefined;
      if (slot.graceTimer) this.clock.clear(slot.graceTimer);
      slot.graceTimer = undefined;
      delete slot.graceDeadline;
      slot.state = "connected";
      if (returning) this.state.transitionLocked(slot.streamId, "syncing", 1);
      return ok(undefined);
    });
  }

  hasVisibleDemand(streamId: string): boolean {
    const slot = this.#slot;
    if (slot?.streamId===streamId && slot.sessionDeadline!==undefined && this.clock.mono()>=slot.sessionDeadline) { void this.state.mutex.run(()=>this.#expire()); return false; }
    return !!slot && slot.streamId === streamId && slot.state === "connected" && !!slot.sessionDigest && slot.sessionDeadline !== undefined && slot.graceDeadline === undefined;
  }

  async disconnect(): Promise<void> {
    await this.state.mutex.run(() => { this.#expire(); const slot = this.#slot; if (slot?.state === "connected") this.#beginGrace(slot); });
  }

  revoke(streamId: string): void {
    this.demandLost(streamId);
    const slot = this.#slot;
    if (slot?.streamId === streamId) this.#release(slot);
  }

  async #finishClaim(slot: Slot, delivery: number): Promise<void> {
    await this.state.mutex.run(() => {
      if (this.#slot !== slot || slot.delivery !== delivery || slot.state !== "claim-delivering") return;
      if (this.clock.mono() >= slot.permitDeadline || !this.state.hasActive(slot.streamId)) return this.#vacate(slot);
      slot.state = "claimed";
    });
  }

  async #rollbackClaim(slot: Slot, delivery: number): Promise<void> {
    await this.state.mutex.run(() => {
      if (this.#slot !== slot || slot.delivery !== delivery || slot.state !== "claim-delivering") return;
      slot.claimDigest = undefined;
      slot.state = this.clock.mono() < slot.permitDeadline && this.state.hasActive(slot.streamId) ? "armed" : "vacant";
    });
  }

  async #finishSession(slot: Slot, delivery: number): Promise<void> {
    await this.state.mutex.run(() => {
      if (this.#slot !== slot || slot.delivery !== delivery || slot.state !== "session-delivering") return;
      if (this.clock.mono() >= slot.permitDeadline || !this.state.hasActive(slot.streamId)) return this.#vacate(slot);
      slot.priorSessionDigest=undefined;
      slot.priorSessionDeadline=undefined;
      slot.priorSessionGeneration=undefined;
      slot.state = "session-issued";
      this.#armSession(slot);
    });
  }

  async #rollbackSession(slot: Slot, delivery: number): Promise<void> {
    await this.state.mutex.run(() => {
      if (this.#slot !== slot || slot.delivery !== delivery || slot.state !== "session-delivering") return;
      if (this.clock.mono() >= slot.permitDeadline || !this.state.hasActive(slot.streamId)) return this.#vacate(slot);
      if (slot.priorSessionDigest && slot.priorSessionDeadline !== undefined && slot.priorSessionGeneration !== undefined) {
        slot.sessionDigest=slot.priorSessionDigest;
        slot.sessionDeadline=slot.priorSessionDeadline;
        slot.sessionGeneration=slot.priorSessionGeneration;
        slot.priorSessionDigest=undefined;
        slot.priorSessionDeadline=undefined;
        slot.priorSessionGeneration=undefined;
        slot.state="session-issued";
        this.#armSession(slot);
      } else {
        slot.sessionDigest=undefined;
        slot.sessionId=undefined;
        slot.sessionDeadline=undefined;
        slot.state="claimed";
      }
    });
  }

  #checkConnection(descriptor: UpgradeDescriptor): AuthResult<undefined> {
    this.#expire();
    const slot = this.#slot;
    if (!slot || !slot.sessionId || slot.sessionDeadline === undefined || descriptor.streamId !== slot.streamId || descriptor.sessionId !== slot.sessionId || descriptor.generation !== slot.sessionGeneration || descriptor.deadline !== slot.sessionDeadline || !this.state.hasActive(slot.streamId) || !["session-issued", "grace"].includes(slot.state) || this.#graceExpired(slot)) return no(slot?.state === "connected" ? "limit" : "unauthorized");
    return ok(undefined);
  }

  #rotateSession(slot: Slot): string {
    const token = this.#token();
    slot.sessionGeneration++;
    slot.sessionId ??= uuid(this.entropy);
    slot.sessionDeadline = this.clock.mono() + 60_000;
    slot.sessionDigest = this.#digest(token, this.#sessionContext(slot));
    return token;
  }

  #claimMatches(slot: Slot, token: string, ignorePermit=false): boolean {
    if (!slot.claimDigest || !ignorePermit && this.clock.mono() >= slot.permitDeadline) return false;
    return this.#compare(slot.claimDigest, this.#digest(token, this.#claimContext(slot)));
  }

  #mediaMatches(slot: Slot, token: string, states: readonly SlotState[]): boolean {
    if (!states.includes(slot.state) || !slot.sessionDigest || !slot.sessionId || slot.sessionDeadline === undefined || this.clock.mono() >= slot.sessionDeadline) return false;
    return this.#compare(slot.sessionDigest, this.#digest(token, this.#sessionContext(slot)));
  }

  #armPermit(slot: Slot): void {
    if (slot.permitTimer) this.clock.clear(slot.permitTimer);
    const deadline = slot.permitDeadline;
    const generation = slot.generation;
    slot.permitTimer = this.clock.set(Math.max(0, deadline - this.clock.mono()), () => {
      void this.state.mutex.run(() => {
        if (this.#slot !== slot || slot.generation !== generation || slot.permitDeadline !== deadline) return;
        if (this.clock.mono() < deadline) return this.#armPermit(slot);
        if (["armed", "claim-delivering", "claimed", "session-delivering"].includes(slot.state)) this.#vacate(slot);
      });
    });
  }

  #armSession(slot: Slot): void {
    if (slot.sessionTimer) this.clock.clear(slot.sessionTimer);
    const deadline = slot.sessionDeadline!;
    const generation = slot.sessionGeneration;
    slot.sessionTimer = this.clock.set(Math.max(0, deadline - this.clock.mono()), () => {
      void this.state.mutex.run(() => {
        if (this.#slot !== slot || slot.sessionGeneration !== generation || slot.sessionDeadline !== deadline) return;
        if (this.clock.mono() < deadline) return this.#armSession(slot);
        slot.sessionDigest = undefined;
        slot.sessionTimer = undefined;
        if (slot.state === "connected" || slot.state === "grace") this.#beginGrace(slot);
        else if (slot.state === "session-issued") this.#vacate(slot);
      });
    });
  }

  #beginGrace(slot: Slot): void {
    this.demandLost(slot.streamId);
    if (slot.state !== "grace") {
      slot.state = "grace";
      if (this.state.hasActive(slot.streamId)) this.state.transitionLocked(slot.streamId, "grace", 0);
    }
    slot.graceDeadline ??= this.clock.mono() + 5_000;
    if (!slot.graceTimer) this.#armGrace(slot);
  }

  #armGrace(slot: Slot): void {
    const deadline = slot.graceDeadline!;
    const timer = this.clock.set(Math.max(0, deadline - this.clock.mono()), () => {
      if (slot.graceTimer !== timer || this.#slot !== slot || slot.graceDeadline !== deadline) return;
      slot.graceTimer = undefined;
      if (!this.#graceExpired(slot)) this.#armGrace(slot);
    });
    slot.graceTimer = timer;
  }

  #graceExpired(slot: Slot): boolean {
    if (slot.graceDeadline === undefined || this.clock.mono() < slot.graceDeadline) return false;
    this.demandLost(slot.streamId);
    void this.state.terminal.request(slot.streamId, "lease-expired");
    return true;
  }

  #expire(): void {
    const slot = this.#slot;
    if (!slot) return;
    const now = this.clock.mono();
    if (now >= slot.permitDeadline && ["armed", "claim-delivering", "claimed", "session-delivering"].includes(slot.state)) { this.#vacate(slot); return; }
    if (slot.sessionDeadline === undefined || now < slot.sessionDeadline) return;
    slot.sessionDigest=undefined;
    if (slot.sessionTimer) this.clock.clear(slot.sessionTimer);
    slot.sessionTimer=undefined;
    if (slot.state === "connected" || slot.state === "grace") this.#beginGrace(slot);
    else if (slot.state === "session-issued") this.#vacate(slot);
  }

  #vacate(slot: Slot): void {
    this.demandLost(slot.streamId);
    for (const timer of [slot.permitTimer, slot.sessionTimer, slot.graceTimer]) if (timer) this.clock.clear(timer);
    slot.permitTimer = undefined;
    slot.priorSessionGeneration = undefined;
    slot.sessionTimer = undefined;
    slot.graceTimer = undefined;
    slot.claimDigest = undefined;
    slot.sessionDigest = undefined;
    slot.sessionId = undefined;
    slot.sessionDeadline = undefined;
    slot.priorSessionDigest = undefined;
    slot.priorSessionDeadline = undefined;
    delete slot.graceDeadline;
    slot.state = "vacant";
    slot.delivery = 0;
  }

  #release(slot: Slot): void {
    this.#vacate(slot);
    if (this.#slot === slot) this.#slot = undefined;
  }

  #token(): string {
    const raw = this.entropy.bytes(32);
    const token = Buffer.from(raw).toString("base64url");
    raw.fill(0);
    return token;
  }

  #claimContext(slot: Slot): string { return `FSQ-Auto/v1:${slot.streamId}:${slot.permitDeadline}:${slot.generation}`; }
  #sessionContext(slot: Slot): string { return `FSQ-Media/v1:${slot.streamId}:${slot.sessionId}:${slot.sessionDeadline}:${slot.generation}`; }
  #digest(raw: string, context: string): Buffer { return createHmac("sha256", this.#key).update(context).update("\0").update(raw).digest(); }
  #compare(left: Buffer, right: Buffer): boolean { return left.length === right.length && timingSafeEqual(left, right); }
  #event(operation: string, outcome: string, slot: Slot): void {
    if (AUTH_DIAGNOSTICS.hasSubscribers) AUTH_DIAGNOSTICS.publish(freeze({ operation, outcome, state: slot.state, generation: slot.generation }));
  }
}
