import {
  controlError,
  validateControlError,
  validateControlResult,
  validateEnsureViewerValue,
  validateInspectControlValue,
  validateRuntimeAttachment,
  validateStopStreamValue,
  validateStreamId,
  type ControlError,
  type ControlResult,
  type DeviceRef,
  type DeviceSelector,
  type EnsureViewerValue,
  type InspectControlValue,
  type RuntimeAttachment,
  type RuntimeControl,
  RuntimeControlSession,
  type StopStreamResult,
} from "../../contracts/src/index.js";
import { acquireRuntime } from "../../runtime/src/index.js";
import type { PrepareEmbeddedResult, PresentationRuntimeControl } from "../../runtime/src/types.js";
export type EnsureAdapterResult = Readonly<{
  ok: true;
  value: Readonly<{ attachment: RuntimeAttachment } & EnsureViewerValue>;
}> | Readonly<{ ok: false; error: ControlError }>;
export interface AgentControlOptions { readonly signal?: AbortSignal }
export interface AgentControlSession {
  inspect(input: Readonly<{ streamId: string; afterRevision?: number }>, options?: AgentControlOptions): Promise<ControlResult<InspectControlValue>>;
  wait(input: Readonly<{ streamId: string; afterRevision: number; waitMs: number }>, options?: AgentControlOptions): Promise<ControlResult<InspectControlValue>>;
  stop(input: Readonly<{ streamId: string; expectedRevision?: number }>, options?: AgentControlOptions): Promise<StopStreamResult>;
  prepareEmbedded(input: Readonly<{ streamId: string }>, options?: AgentControlOptions): Promise<PrepareEmbeddedResult>;
  close(): Promise<void>;
}
export interface AgentControl {
  ensure(input: Readonly<{ selector: DeviceSelector }>, options?: AgentControlOptions): Promise<EnsureAdapterResult>;
  openKnown(input: Readonly<{ deviceRef: DeviceRef }>, options?: AgentControlOptions): Promise<AgentControlSession>;
}
export interface AgentControlDependencies { readonly acquireRuntime: typeof acquireRuntime }

const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
const deepFreeze = <T>(value: T): T => {
  if (typeof value !== "object" || value === null) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && "value" in descriptor) deepFreeze(descriptor.value);
  }
  return Object.isFrozen(value) ? value : Object.freeze(value);
};
const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value)) || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return descriptor?.enumerable === true && "value" in descriptor; });
};
const sameDevice = (left: DeviceRef, right: DeviceRef): boolean => left.contractVersion === right.contractVersion && left.platform === right.platform && left.namespace === right.namespace && left.opaqueId === right.opaqueId;
export const runtimeExitedResult = (): Readonly<{ ok: false; error: ControlError }> => freeze({ ok: false, error: controlError("runtime-exited") });
const options = (value?: AgentControlOptions): Readonly<{ signal: AbortSignal }> | undefined => value?.signal ? freeze({ signal: value.signal }) : undefined;
type RecognizedSession = Readonly<{ session: RuntimeControlSession; close: () => Promise<void>; control?: RuntimeControl }>;
function recognizeSession(value: unknown): RecognizedSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return;
  const prototype = Object.getPrototypeOf(value), attachment = Object.getOwnPropertyDescriptor(value, "attachment");
  if (!attachment?.enumerable || !("value" in attachment)) return;
  let close: unknown, control: unknown;
  if (prototype === RuntimeControlSession.prototype) {
    close = Object.getOwnPropertyDescriptor(RuntimeControlSession.prototype, "close")?.value;
    try { control = Reflect.get(value, "control", value); } catch {}
  } else if (prototype === Object.prototype || prototype === null) {
    const closeDescriptor = Object.getOwnPropertyDescriptor(value, "close"), controlDescriptor = Object.getOwnPropertyDescriptor(value, "control");
    if (!closeDescriptor || !("value" in closeDescriptor)) return;
    close = closeDescriptor.value;
    if (controlDescriptor?.enumerable && "value" in controlDescriptor) control = controlDescriptor.value;
  } else return;
  if (typeof close !== "function") return;
  let closing: Promise<void> | undefined;
  return freeze({ session: value as RuntimeControlSession, close: () => closing ??= Promise.resolve().then(() => Reflect.apply(close as () => unknown, value, [])).then(() => undefined), ...(typeof control === "object" && control !== null ? { control: control as RuntimeControl } : {}) });
}
function rawSession(value: unknown): RecognizedSession | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return;
  const ok = Object.getOwnPropertyDescriptor(value, "ok"), session = Object.getOwnPropertyDescriptor(value, "session");
  return ok?.enumerable && "value" in ok && ok.value === true && session?.enumerable && "value" in session ? recognizeSession(session.value) : undefined;
}
function checkedAcquire(value: unknown): Readonly<{ ok: true; session: RuntimeControlSession }> | Readonly<{ ok: false; error: ControlError }> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError("Invalid acquire result");
  const ok = Object.getOwnPropertyDescriptor(value, "ok");
  if (!ok?.enumerable || !("value" in ok) || typeof ok.value !== "boolean") throw new TypeError("Invalid acquire result");
  const branch = ok.value ? "session" : "error";
  if (!exact(value, ["ok", branch])) throw new TypeError("Invalid acquire result");
  if (!ok.value) return freeze({ ok: false, error: deepFreeze(validateControlError((value as { error: unknown }).error)) });
  const recognized = rawSession(value), attachment = recognized && Object.getOwnPropertyDescriptor(recognized.session, "attachment");
  if (!recognized?.control || !attachment || !("value" in attachment)) throw new TypeError("Invalid acquire result");
  validateRuntimeAttachment(attachment.value);
  return freeze({ ok: true, session: recognized.session });
}
function checkedResult(value: unknown, validator: (input: unknown) => unknown, deviceRef: DeviceRef, streamId?: string, revisionConflict = false): ControlResult<InspectControlValue> | StopStreamResult {
  const result = validateControlResult(value);
  if (result.ok) validator(result.value);
  else if (Object.hasOwn(result, "snapshot") && !revisionConflict) throw new TypeError("Invalid operation result");
  const success = result.ok ? result.value as { snapshot: { streamId: string; deviceRef: DeviceRef }; changes?: readonly { streamId: string; deviceRef: DeviceRef }[] } : undefined;
  const snapshots = success ? [success.snapshot, ...(success.changes ?? [])] : Object.hasOwn(result, "snapshot") ? [(result as { snapshot: { streamId: string; deviceRef: DeviceRef } }).snapshot] : [];
  if (streamId && snapshots.some((snapshot) => snapshot.streamId !== streamId || !sameDevice(snapshot.deviceRef, deviceRef))) throw new TypeError("Invalid stream identity");
  return deepFreeze(result) as ControlResult<InspectControlValue> | StopStreamResult;
}
const presentationControl=(value:RuntimeControl|undefined):PresentationRuntimeControl|undefined=>typeof (value as RuntimeControl&Partial<PresentationRuntimeControl>|undefined)?.prepareEmbeddedViewer==="function"?value as RuntimeControl&PresentationRuntimeControl:undefined;
function checkedPrepare(value:unknown,streamId:string):PrepareEmbeddedResult{if(typeof value!=="object"||value===null||Array.isArray(value))throw new TypeError("Invalid presentation result");const ok=Object.getOwnPropertyDescriptor(value,"ok");if(!ok?.enumerable||!("value" in ok)||typeof ok.value!=="boolean")throw new TypeError("Invalid presentation result");if(ok.value){if(!exact(value,["ok","value"]))throw new TypeError("Invalid presentation result");const prepared=(value as {value:unknown}).value;if(!exact(prepared,["streamId","expiresAt"]))throw new TypeError("Invalid presentation result");validateStreamId(prepared.streamId);if(prepared.streamId!==streamId||!Number.isSafeInteger(prepared.expiresAt)||Number(prepared.expiresAt)<0)throw new TypeError("Invalid presentation result");return deepFreeze(value) as PrepareEmbeddedResult;}if(!exact(value,["ok","error"]))throw new TypeError("Invalid presentation result");const error=(value as {error:unknown}).error;try{validateControlError(error);}catch{if(!exact(error,["controlVersion","code","disposition","operationState","safeMessage"])||!exact(error.controlVersion,["major","minor"])||error.controlVersion.major!==1||error.controlVersion.minor!==0||error.code!=="presentation-unavailable"||error.disposition!=="terminal"||error.operationState!=="not-applied"||error.safeMessage!=="Embedded Viewer is unavailable.")throw new TypeError("Invalid presentation result");}return deepFreeze(value) as PrepareEmbeddedResult;}
class Session implements AgentControlSession {
  #state: Readonly<{ control?: RuntimeControl; deviceRef: DeviceRef; close: () => Promise<void>; unavailable?: Readonly<{ ok: false; error: ControlError }> }>;
  constructor(control: RuntimeControl | undefined, deviceRef: DeviceRef, close: () => Promise<void>, unavailable?: Readonly<{ ok: false; error: ControlError }>) {
    this.#state = freeze({ ...(control ? { control } : {}), deviceRef, close, ...(unavailable ? { unavailable } : {}) });
  }
  async inspect(input: Readonly<{ streamId: string; afterRevision?: number }>, value?: AgentControlOptions): Promise<ControlResult<InspectControlValue>> {
    if (this.#state.unavailable) return this.#state.unavailable;
    try {
      return checkedResult(await this.#state.control!.inspect(input, options(value)), validateInspectControlValue, this.#state.deviceRef, input.streamId) as ControlResult<InspectControlValue>;
    } catch {
      return runtimeExitedResult();
    }
  }
  async wait(input: Readonly<{ streamId: string; afterRevision: number; waitMs: number }>, value?: AgentControlOptions): Promise<ControlResult<InspectControlValue>> {
    if (this.#state.unavailable) return this.#state.unavailable;
    try {
      return checkedResult(await this.#state.control!.wait(input, options(value)), validateInspectControlValue, this.#state.deviceRef, input.streamId) as ControlResult<InspectControlValue>;
    } catch {
      return runtimeExitedResult();
    }
  }
  async stop(input: Readonly<{ streamId: string; expectedRevision?: number }>, value?: AgentControlOptions): Promise<StopStreamResult> {
    if (this.#state.unavailable) return this.#state.unavailable;
    try {
      return checkedResult(await this.#state.control!.stopStream(input, options(value)), validateStopStreamValue, this.#state.deviceRef, input.streamId, true) as StopStreamResult;
    } catch {
      return runtimeExitedResult();
    }
  }
  async prepareEmbedded(input:Readonly<{streamId:string}>,value?:AgentControlOptions):Promise<PrepareEmbeddedResult>{
    if(this.#state.unavailable)return this.#state.unavailable;
    const control=presentationControl(this.#state.control);if(!control)return runtimeExitedResult();
    try{return checkedPrepare(await control.prepareEmbeddedViewer(input,options(value)),input.streamId);}catch{return runtimeExitedResult();}
  }
  close(): Promise<void> { return this.#state.close(); }
}
export type AgentPresentationResult=Readonly<{result:EnsureAdapterResult;prepared?:PrepareEmbeddedResult}>;
export interface AgentPresentation{ensure(input:Readonly<{selector:DeviceSelector;prepareEmbedded:boolean}>,options?:AgentControlOptions):Promise<AgentPresentationResult>}
async function ensureCore(dependencies:AgentControlDependencies,input:Readonly<{selector:DeviceSelector}>,value:AgentControlOptions|undefined,prepare:boolean):Promise<AgentPresentationResult>{let recognized:RecognizedSession|undefined,result:EnsureAdapterResult=runtimeExitedResult(),prepared:PrepareEmbeddedResult|undefined;try{const raw=await dependencies.acquireRuntime({mode:"start-or-attach",selector:input.selector},options(value));recognized=rawSession(raw);const acquired=checkedAcquire(raw);if(!acquired.ok)result=acquired;else{if(input.selector.kind==="known"&&!sameDevice(acquired.session.attachment.instance.deviceRef,input.selector.deviceRef))throw new TypeError("Invalid acquired identity");const ensuredResult=validateControlResult(await acquired.session.control.ensureViewer(options(value)));if(!ensuredResult.ok){if(Object.hasOwn(ensuredResult,"snapshot"))throw new TypeError("Invalid ensure result");result=deepFreeze(ensuredResult) as Readonly<{ok:false;error:ControlError}>;}else{const ensured=validateEnsureViewerValue(ensuredResult.value),attachment=acquired.session.attachment;if(!sameDevice(attachment.instance.deviceRef,ensured.deviceRef))throw new TypeError("Invalid ensure identity");result=deepFreeze({ok:true as const,value:{attachment,deviceRef:ensured.deviceRef,descriptor:ensured.descriptor,snapshot:ensured.snapshot}});if(prepare){const control=presentationControl(acquired.session.control);if(control)prepared=checkedPrepare(await control.prepareEmbeddedViewer({streamId:ensured.snapshot.streamId},options(value)),ensured.snapshot.streamId);}}}}catch{result=runtimeExitedResult();prepared=undefined;}try{await recognized?.close();}catch{return freeze({result:runtimeExitedResult()});}return freeze({result,...(prepared?{prepared}:{})});}
export function createAgentPresentation(dependencies:AgentControlDependencies={acquireRuntime}):AgentPresentation{return freeze({ensure:(input,value)=>ensureCore(dependencies,input,value,input.prepareEmbedded)});}
export function createAgentControl(dependencies: AgentControlDependencies = { acquireRuntime }): AgentControl {
  return freeze({
    async ensure(input: Readonly<{ selector: DeviceSelector }>, value?: AgentControlOptions): Promise<EnsureAdapterResult> {
      return (await ensureCore(dependencies,input,value,false)).result;
    },
    async openKnown(input: Readonly<{ deviceRef: DeviceRef }>, value?: AgentControlOptions): Promise<AgentControlSession> {
      let recognized: RecognizedSession | undefined;
      try {
        const raw = await dependencies.acquireRuntime({ mode: "attach-only", selector: { kind: "known", deviceRef: input.deviceRef } }, options(value));
        recognized = rawSession(raw);
        const acquired = checkedAcquire(raw);
        if (!acquired.ok) return freeze(new Session(undefined, input.deviceRef, async () => undefined, acquired));
        if (!sameDevice(acquired.session.attachment.instance.deviceRef, input.deviceRef)) throw new TypeError("Invalid acquired identity");
        const session = freeze(new Session(acquired.session.control, input.deviceRef, recognized!.close));
        recognized = undefined;
        return session;
      } catch {}
      try { await recognized?.close(); } catch {}
      return freeze(new Session(undefined, input.deviceRef, async () => undefined, runtimeExitedResult()));
    },
  });
}
