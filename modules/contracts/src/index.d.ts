export declare const CONTRACT_VERSION: 2;
export declare const STREAM_PHASES: readonly ["demand-pending", "starting-capture", "syncing", "streaming", "grace", "interrupted", "stopping", "stopped", "device-disconnected", "failed"];
export type StreamPhase = (typeof STREAM_PHASES)[number];
export type StreamId = string;
export interface DeviceRef {
    readonly contractVersion: 2;
    readonly platform: "android" | "ios";
    readonly namespace: string;
    readonly opaqueId: string;
}
export interface Size {
    readonly width: number;
    readonly height: number;
}
export interface ViewerDescriptor {
    readonly contractVersion: 2;
    readonly streamId: StreamId;
    readonly standaloneUri: string;
    readonly presentationModes: readonly ["standalone"];
    readonly expiresAt: number;
}
declare const ERRORS: {
    readonly "dependency-unavailable": readonly ["service", "terminal", "failed"];
    readonly "adb-incompatible": readonly ["service", "terminal", "failed"];
    readonly "runtime-bind-failed": readonly ["service", "terminal", "failed"];
    readonly "instance-conflict": readonly ["service", "terminal", null];
    readonly "device-not-found": readonly ["capture", "terminal", "failed"];
    readonly "device-ambiguous": readonly ["capture", "terminal", "failed"];
    readonly "device-unavailable": readonly ["capture", "terminal", "failed"];
    readonly "artifact-unavailable": readonly ["capture", "terminal", "failed"];
    readonly "artifact-mismatch": readonly ["capture", "terminal", "failed"];
    readonly "version-mismatch": readonly ["capture", "terminal", "failed"];
    readonly "capture-start-failed": readonly ["capture", "terminal", "failed"];
    readonly "codec-disabled": readonly ["capture", "terminal", "failed"];
    readonly "codec-config-error": readonly ["capture", "terminal", "failed"];
    readonly "unsupported-codec": readonly ["capture", "terminal", "failed"];
    readonly "malformed-media": readonly ["stream", "terminal", "failed"];
    readonly "malformed-control": readonly ["viewer", "terminal", null];
    readonly "start-timeout": readonly ["stream", "terminal", "failed"];
    readonly "quality-target-unmet": readonly ["acceptance", "terminal", "failed"];
    readonly "backpressure-gap": readonly ["stream", "recoverable", null];
    readonly "backpressure-timeout": readonly ["stream", "terminal", "failed"];
    readonly "runtime-overload": readonly ["stream", "terminal", "failed"];
    readonly "stream-interrupted": readonly ["stream", "state-unknown", "interrupted"];
    readonly "device-disconnected": readonly ["capture", "terminal", "device-disconnected"];
    readonly "slow-consumer": readonly ["viewer", "terminal", null];
    readonly "viewer-unsupported": readonly ["viewer", "terminal", null];
    readonly "viewer-limit-reached": readonly ["viewer", "terminal", null];
    readonly unauthorized: readonly ["viewer", "terminal", null];
    readonly "presentation-blocked": readonly ["presentation", "recoverable", null];
    readonly "acceptance-failed": readonly ["acceptance", "terminal", "either"];
};
export type StreamErrorCode = keyof typeof ERRORS;
export type ErrorScope = "service" | "capture" | "stream" | "viewer" | "presentation" | "acceptance";
export type ErrorDisposition = "recoverable" | "terminal" | "state-unknown";
export interface StreamError {
    readonly code: StreamErrorCode;
    readonly scope: ErrorScope;
    readonly disposition: ErrorDisposition;
    readonly safeMessage: string;
}
export type SnapshotReason = StreamErrorCode | "explicit-stop" | "lease-expired";
export interface StreamSnapshot {
    readonly streamId: StreamId;
    readonly deviceRef: DeviceRef;
    readonly revision: number;
    readonly phase: StreamPhase;
    readonly reason?: SnapshotReason;
    readonly epoch?: number;
    readonly codedSize?: Size;
    readonly displaySize?: Size;
    readonly activeViewerCount: 0 | 1;
    readonly updatedAt: number;
}
export declare class ContractValidationError extends TypeError {
    readonly valueName: string;
    readonly code = "invalid-contract-value";
    constructor(valueName: string);
}
export declare function validateStreamId(value: unknown): StreamId;
export declare function validateDeviceRef(value: unknown): DeviceRef;
export declare function validateSize(value: unknown): Size;
export declare function validateViewerDescriptor(value: unknown): ViewerDescriptor;
export declare function validateStreamError(value: unknown): StreamError;
export declare function validateStreamSnapshot(value: unknown): StreamSnapshot;
declare class Grant {
    #private;
    constructor(raw: string);
    static reveal(grant: Grant): string;
    toString(): string;
    toJSON(): string;
    [Symbol.toPrimitive](): string;
}
export type ViewerGrant = Grant;
export interface ViewerAccess {
    readonly descriptor: ViewerDescriptor;
    readonly viewerGrant: ViewerGrant;
    toJSON(): {
        descriptor: ViewerDescriptor;
    };
}
export declare function createViewerAccess(descriptorValue: unknown, rawGrant: unknown): ViewerAccess;
export declare function revealViewerGrant(grant: ViewerGrant): string;
export declare const MEDIA_MAJOR: 1, MEDIA_HEADER_BYTES: 40;
export declare const MAX_PAYLOAD_BYTES: 8388608, MAX_CONFIG_BYTES: 262144, MAX_FRAME_BYTES: 8126464;
export declare const MEDIA_KIND: Readonly<{
    readonly session: 1;
    readonly config: 2;
    readonly frame: 3;
    readonly gap: 4;
    readonly end: 5;
}>;
export declare const END_REASON: Readonly<{
    readonly explicitStop: 1;
    readonly leaseExpired: 2;
    readonly deviceDisconnected: 3;
    readonly failed: 4;
}>;
export type MediaKind = (typeof MEDIA_KIND)[keyof typeof MEDIA_KIND];
export interface MediaHeader {
    readonly minor: 0 | 1;
    readonly kind: MediaKind;
    readonly flags: number;
    readonly payloadBytes: number;
    readonly sequence: bigint;
    readonly epoch: bigint;
    readonly ptsUs: bigint;
}
export declare function encodeMediaHeader(header: MediaHeader): Uint8Array;
export declare function decodeMediaHeader(message: Uint8Array): MediaHeader;
export {};
