import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  controlError,
  validateAcquireRuntimeRequest,
  type AcquireRuntimeRequest,
  type ControlError,
  type RuntimeAttachment,
  type RuntimeInstance,
  type RuntimeTarget,
} from "../../contracts/src/index.js";
import { LocalRuntimeState, LocalStateFailure, resolveAutomaticSlot, type RuntimeSlot, type RuntimeGenerationState } from "./control-state.js";
import { CONTROL_DEADLINES, attachControlSession, helloControl, type AcquireRuntimeLocalResult } from "./control.js";

export interface AcquireRuntimeOptions { readonly signal?: AbortSignal }
interface BootstrapFrame { readonly type: "candidate" | "contended" | "ready" | "cancel"; readonly instanceId?: string; readonly generation?: string }
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const sendFrame=(child:ChildProcess,frame:BootstrapFrame):Promise<boolean>=>new Promise((resolve)=>{if(!child.connected){resolve(false);return;}child.send(frame,(cause)=>resolve(!cause));});
const failure = (code: ControlError["code"]): Readonly<{ ok: false; error: ControlError }> => frozen({ ok: false, error: controlError(code) });
const sameDevice = (a: RuntimeSlot["deviceRef"], b: RuntimeSlot["deviceRef"]): boolean => a.contractVersion === b.contractVersion && a.platform === b.platform && a.namespace === b.namespace && a.opaqueId === b.opaqueId;
const sameAuthority = (a: RuntimeSlot, b: RuntimeSlot): boolean => a.revision === b.revision && sameDevice(a.deviceRef, b.deviceRef) && a.control.port === b.control.port && a.control.credential === b.control.credential;
function options(value: unknown): AcquireRuntimeOptions { if (value === undefined) return frozen({}); if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).some((key) => key !== "signal") || (Object.hasOwn(value, "signal") && !((value as AcquireRuntimeOptions).signal instanceof AbortSignal))) throw new TypeError("Invalid Runtime acquire options"); return value as AcquireRuntimeOptions; }
function mapFailure(cause: unknown): ControlError["code"] { if (cause instanceof LocalStateFailure) return cause.code; if (typeof cause === "object" && cause !== null && "code" in cause && typeof cause.code === "string" && ["dependency-unavailable", "adb-incompatible", "device-not-found", "device-ambiguous", "device-unavailable", "artifact-unavailable", "artifact-mismatch"].includes(cause.code)) return cause.code as ControlError["code"]; return "local-state-recovery-required"; }
function attachment(disposition: "started" | "attached", instance: RuntimeInstance): RuntimeAttachment { return frozen({ disposition, instance }); }
interface StartDependencies {
  readonly spawn: (slot: RuntimeSlot) => ChildProcess;
  readonly bootstrap: typeof waitBootstrap;
  readonly hello: typeof helloControl;
  readonly attach: typeof attach;
  readonly now: () => number;
  readonly sleep: (milliseconds: number) => Promise<void>;
}
const startDependencies: StartDependencies = Object.freeze({
  spawn: (slot: RuntimeSlot) => fork(fileURLToPath(new URL("./control-child.js", import.meta.url)), [JSON.stringify(slot.deviceRef)], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"], env: {}, execArgv: [] }),
  bootstrap: waitBootstrap,
  hello: helloControl,
  attach,
  now: () => performance.now(),
  sleep: (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds)),
});
async function slotFor(request: AcquireRuntimeRequest, signal?: AbortSignal): Promise<Readonly<{ state: LocalRuntimeState<"android" | "ios">; slot: RuntimeSlot }>> {
  if (request.selector.kind === "auto") { const result = await resolveAutomaticSlot(request.selector.platform, signal); return frozen({ state: result.state, slot: result.slot }); }
  const state = new LocalRuntimeState(undefined, {}, request.selector.deviceRef.platform); await state.prepare(signal); const slot = await state.readSlot(); if (!slot) throw Object.assign(new Error("missing"), { controlCode: "instance-not-found" }); if (!sameDevice(slot.deviceRef, request.selector.deviceRef)) throw Object.assign(new Error("conflict"), { controlCode: "instance-conflict" }); return frozen({ state, slot });
}
async function attach(slot: RuntimeSlot, disposition: "started" | "attached", instance: RuntimeInstance, signal?: AbortSignal): Promise<AcquireRuntimeLocalResult> { return attachControlSession(slot.control.port, attachment(disposition, instance), slot.control.credential, signal); }

export async function acquireRuntime(input: AcquireRuntimeRequest, value?: AcquireRuntimeOptions): Promise<AcquireRuntimeLocalResult> {
  let request: AcquireRuntimeRequest, configured: AcquireRuntimeOptions; try { request = validateAcquireRuntimeRequest(input); configured = options(value); } catch { return failure("malformed-control"); }
  if (configured.signal?.aborted) return failure("request-cancelled");
  let state: LocalRuntimeState<"android" | "ios">, slot: RuntimeSlot; try { ({ state, slot } = await slotFor(request, configured.signal)); } catch (cause) { const direct = typeof cause === "object" && cause !== null && "controlCode" in cause ? cause.controlCode as ControlError["code"] : mapFailure(cause); return failure(direct); }
  if (configured.signal?.aborted) return failure("request-cancelled");
  let generation: RuntimeGenerationState | undefined, partial = false; try { generation = await state.readGeneration(slot); } catch { partial = true; }
  const expected = generation ? { instanceId: generation.instanceId, generation: generation.generation } : null, readyDeadline = performance.now() + CONTROL_DEADLINES.readiness; let live: Awaited<ReturnType<typeof helloControl>>;
  for (;;) { live = await helloControl(slot, expected, configured.signal); if (live.ok || live.error.code !== "runtime-exited" || performance.now() >= readyDeadline || configured.signal?.aborted) break; await new Promise((resolve) => setTimeout(resolve, 50)); }
  if (live.ok) {
    const fresh = await state.readSlot().catch(() => undefined);
    if (!fresh) return failure("local-state-recovery-required");
    if (request.selector.kind === "known" && !sameDevice(fresh.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
    if (!sameAuthority(slot, fresh)) return acquireRuntime(input, configured);
    if (generation && (live.value.instance.instanceId !== generation.instanceId || live.value.instance.generation !== generation.generation)) return failure("local-state-recovery-required");
    if (!generation) {
      const rebuilt: RuntimeGenerationState = frozen({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, instanceId: live.value.instance.instanceId, generation: live.value.instance.generation, port: slot.control.port, createdAt: Date.now(), ready: true });
      try { await state.publishGeneration(rebuilt); } catch { return failure("local-state-recovery-required"); }
    }
    return attach(slot, "attached", live.value.instance, configured.signal);
  }
  if (live.error.code !== "instance-not-found" && live.error.code !== "runtime-exited") {
    if (["request-cancelled", "deadline-exceeded", "control-version-mismatch"].includes(live.error.code)) return failure(live.error.code);
    return failure("local-state-recovery-required");
  }
  const refreshed = await state.readSlot().catch(() => undefined);
  if (!refreshed) return failure("local-state-recovery-required");
  if (request.selector.kind === "known" && !sameDevice(refreshed.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
  if (!sameAuthority(slot, refreshed)) return acquireRuntime(input, configured);
  if (live.error.code === "runtime-exited") return failure("runtime-exited");
  if (request.mode === "attach-only") return failure("instance-not-found");
  if (generation) { if(!await state.deleteGeneration(generation))return failure("local-state-recovery-required"); } else if (partial) { if(!await state.removePartialGeneration(slot))return failure("local-state-recovery-required"); }
  return startAndAttach(state, slot, request, configured.signal);
}
async function startAndAttach(state: LocalRuntimeState<"android" | "ios">, initialSlot: RuntimeSlot, request: AcquireRuntimeRequest, signal?: AbortSignal, until: number | undefined = undefined, dependencies: StartDependencies = startDependencies): Promise<AcquireRuntimeLocalResult> {
  if (signal?.aborted) return failure("request-cancelled");
  const deadline = until ?? dependencies.now() + CONTROL_DEADLINES.readiness;
  const remaining = deadline - dependencies.now();
  if (remaining <= 0) return failure("deadline-exceeded");
  let slot = initialSlot;
  let child: ChildProcess; try { child = dependencies.spawn(slot); } catch { return failure("runtime-exited"); }
  const outcome = await dependencies.bootstrap(child, signal,async()=>{const result=await dependencies.hello(slot,null);return result.ok?{instanceId:result.value.instance.instanceId,generation:result.value.instance.generation}:undefined;},remaining);
  if (outcome.type === "cancel") return failure("request-cancelled");
  if (outcome.type === "deadline") return failure("deadline-exceeded");
  if(outcome.type==="ready"){const acknowledged=await sendFrame(child,{type:"ready"});if(child.connected)child.disconnect();child.unref();if(!acknowledged)return failure("runtime-exited");}
  if (outcome.type === "exited" || outcome.type === "contended") {
    const fresh = await state.readSlot().catch(() => undefined);
    if (!fresh) return failure("local-state-recovery-required");
    if (!sameAuthority(initialSlot, fresh)) {
      if (request.selector.kind === "known" && !sameDevice(fresh.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
      if (dependencies.now() >= deadline) return failure("deadline-exceeded");
      return startAndAttach(state, fresh, request, signal, deadline, dependencies);
    }
    if (outcome.type === "exited") return failure("runtime-exited");
  }
  for (;;) {
    if (signal?.aborted && outcome.type !== "ready") return failure("request-cancelled");
    const fresh = await state.readSlot().catch(() => undefined);
    if (!fresh) return failure("local-state-recovery-required");
    if (request.selector.kind === "known" && !sameDevice(fresh.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
    slot = fresh;
    const expected: RuntimeTarget | null = outcome.type === "ready" && outcome.instanceId && outcome.generation ? { instanceId: outcome.instanceId, generation: outcome.generation } : null;
    const operationSignal = outcome.type === "ready" ? undefined : signal;
    const result = await dependencies.hello(slot, expected, operationSignal);
    if (result.ok) {
      const latest = await state.readSlot().catch(() => undefined);
      if (!latest) return failure("local-state-recovery-required");
      if (request.selector.kind === "known" && !sameDevice(latest.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
      if (!sameAuthority(slot, latest)) { slot = latest; continue; }
      const disposition = expected && result.value.instance.instanceId === expected.instanceId && result.value.instance.generation === expected.generation ? "started" : "attached";
      if (child.connected) child.disconnect(); child.unref();
      return dependencies.attach(slot, disposition, result.value.instance, operationSignal);
    }
    if (result.error.code !== "instance-not-found" && result.error.code !== "runtime-exited") return failure("local-state-recovery-required");
    const latest = await state.readSlot().catch(() => undefined);
    if (!latest) return failure("local-state-recovery-required");
    if (request.selector.kind === "known" && !sameDevice(latest.deviceRef, request.selector.deviceRef)) return failure("instance-conflict");
    if (outcome.type === "contended" && !sameAuthority(initialSlot, latest)) {
      if (dependencies.now() >= deadline) return failure("deadline-exceeded");
      return startAndAttach(state, latest, request, signal, deadline, dependencies);
    }
    if (dependencies.now() >= deadline) return failure("deadline-exceeded");
    await dependencies.sleep(50);
  }
}
function waitBootstrap(child: ChildProcess, signal?: AbortSignal,reconcile?:()=>Promise<RuntimeTarget|undefined>,readinessBudget:number=CONTROL_DEADLINES.readiness): Promise<Readonly<{ type: "ready" | "contended" | "cancel" | "deadline" | "exited"; instanceId?: string; generation?: string }>> {
  return new Promise((resolve) => {
    let done=false,ready=false,cancelling=false,contended=false,timedOut=false,termTimer:NodeJS.Timeout|undefined,killTimer:NodeJS.Timeout|undefined;
    const signalGroup=(name:NodeJS.Signals):void=>{if(child.pid!==undefined){try{process.kill(-child.pid,name);}catch{/* reaped */}}};
    const finish=(value:Readonly<{type:"ready"|"contended"|"cancel"|"deadline"|"exited";instanceId?:string;generation?:string}>):void=>{if(done)return;done=true;clearTimeout(deadline);if(termTimer)clearTimeout(termTimer);if(killTimer)clearTimeout(killTimer);signal?.removeEventListener("abort",abort);resolve(value);};
    const reconcileBeforeSignal=async(kind:"cancel"|"deadline"):Promise<void>=>{const authority=await reconcile?.().catch(()=>undefined);if(authority){ready=true;finish(frozen({type:"ready",...authority}));return;}if(kind==="deadline")timedOut=true;signalGroup("SIGTERM");killTimer=setTimeout(()=>signalGroup("SIGKILL"),CONTROL_DEADLINES.terminate);};
    const abort=():void=>{if(ready||cancelling)return;cancelling=true;child.send?.({type:"cancel"} satisfies BootstrapFrame);termTimer=setTimeout(()=>{void reconcileBeforeSignal("cancel");},CONTROL_DEADLINES.terminate);};
    const deadline=setTimeout(()=>{void reconcileBeforeSignal("deadline");},Math.max(0,readinessBudget));
    child.on("message",(message:unknown)=>{if(typeof message!=="object"||message===null||!("type"in message))return;const frame=message as BootstrapFrame;if(frame.type==="ready"&&typeof frame.instanceId==="string"&&typeof frame.generation==="string"){ready=true;finish(frozen({type:"ready",instanceId:frame.instanceId,generation:frame.generation}));}else if(frame.type==="contended")contended=true;});
    child.once("error",()=>{if(child.pid===undefined)finish(frozen({type:cancelling?"cancel":"exited"}));});
    child.once("exit",()=>finish(frozen({type:ready?"ready":cancelling?"cancel":timedOut?"deadline":contended?"contended":"exited"})));
    signal?.addEventListener("abort",abort,{once:true});
  });
}

export const acquireInternals = Object.freeze({ slotFor, startAndAttach, waitBootstrap, sendFrame, sameAuthority });
