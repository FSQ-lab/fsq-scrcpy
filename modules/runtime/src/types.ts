import type { ControlError, DeviceRef, RuntimeControl, StreamError, StreamId, StreamSnapshot, ViewerDescriptor } from "../../contracts/src/index.js";
export type MediaProfile = "h264-annexb" | "mjpeg";
export type EnsureRequest = Readonly<{ deviceRef: DeviceRef; idempotencyKey: string }>;
export type InspectRequest = Readonly<{ streamId: StreamId; afterRevision?: number }>;
export type WaitRequest = Readonly<{ streamId: StreamId; afterRevision: number; waitMs: number }>;
export type StopRequest = Readonly<{ streamId: StreamId; expectedRevision?: number; reason: "explicit-stop" }>;
export type EnsureResult = Readonly<{ ok: true; value: Readonly<{ descriptor: ViewerDescriptor; snapshot: StreamSnapshot }> }> | Readonly<{ ok: false; error: StreamError }>;
export type InspectResult = Readonly<{ ok: true; value: Readonly<{ snapshot: StreamSnapshot; changes: readonly StreamSnapshot[]; reset: boolean; timedOut: boolean }> }> | Readonly<{ ok: false; error: StreamError }>;
export type StopResult = Readonly<{ ok: true; value: Readonly<{ snapshot: StreamSnapshot }> }> | Readonly<{ ok: false; error: StreamError }> | Readonly<{ ok: false; error: StreamError; snapshot: StreamSnapshot }>;
export type PresentationUnavailableError = Readonly<{ controlVersion: Readonly<{ major: 1; minor: 0 }>; code: "presentation-unavailable"; disposition: "terminal"; operationState: "not-applied"; safeMessage: "Embedded Viewer is unavailable." }>;
export type PrepareEmbeddedValue = Readonly<{ streamId: StreamId; expiresAt: number }>;
export type PrepareEmbeddedResult = Readonly<{ ok: true; value: PrepareEmbeddedValue }> | Readonly<{ ok: false; error: ControlError | PresentationUnavailableError }>;
export interface PresentationRuntimeControl extends RuntimeControl { prepareEmbeddedViewer(input: Readonly<{ streamId: StreamId }>, options?: Readonly<{ signal?: AbortSignal }>): Promise<PrepareEmbeddedResult> }
export type ViewerAssetRole = "entry-module" | "worker-module" | "style";
export interface ViewerAssetEntry { readonly role: ViewerAssetRole; readonly name: string; readonly sha256: string; readonly mime: "text/javascript; charset=utf-8" | "text/css; charset=utf-8" }
export interface ViewerAssetManifest { readonly entries: readonly ViewerAssetEntry[] }
export type ViewerAssetInput = Readonly<ViewerAssetEntry & { bytes: Uint8Array }>;
export interface UpgradeDescriptor { readonly streamId: StreamId; readonly sessionId: string; readonly generation: number; readonly deadline: number; readonly presentation: "standalone" | "embedded" }
export interface HttpRequest { readonly method: string; readonly target: string; readonly rawHeaders: readonly (readonly [string, string])[]; readonly body?: AsyncIterable<Uint8Array>; destroy?(): void }
export interface HttpResponse { readonly status: number; readonly headers: Readonly<Record<string, string | string[]>>; readonly body: Uint8Array }
export const freeze = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
