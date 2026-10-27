export const CONTRACT_VERSION = 2;
export const STREAM_PHASES = Object.freeze(["demand-pending", "starting-capture", "syncing", "streaming", "grace", "interrupted", "stopping", "stopped", "device-disconnected", "failed"]);
const ERRORS = {
    "dependency-unavailable": ["service", "terminal", "failed"], "adb-incompatible": ["service", "terminal", "failed"],
    "runtime-bind-failed": ["service", "terminal", "failed"], "instance-conflict": ["service", "terminal", null],
    "device-not-found": ["capture", "terminal", "failed"], "device-ambiguous": ["capture", "terminal", "failed"],
    "device-unavailable": ["capture", "terminal", "failed"], "artifact-unavailable": ["capture", "terminal", "failed"],
    "artifact-mismatch": ["capture", "terminal", "failed"], "version-mismatch": ["capture", "terminal", "failed"],
    "capture-start-failed": ["capture", "terminal", "failed"], "codec-disabled": ["capture", "terminal", "failed"],
    "codec-config-error": ["capture", "terminal", "failed"], "unsupported-codec": ["capture", "terminal", "failed"],
    "malformed-media": ["stream", "terminal", "failed"], "malformed-control": ["viewer", "terminal", null],
    "start-timeout": ["stream", "terminal", "failed"], "quality-target-unmet": ["acceptance", "terminal", "failed"],
    "backpressure-gap": ["stream", "recoverable", null], "backpressure-timeout": ["stream", "terminal", "failed"],
    "runtime-overload": ["stream", "terminal", "failed"], "stream-interrupted": ["stream", "state-unknown", "interrupted"],
    "device-disconnected": ["capture", "terminal", "device-disconnected"], "slow-consumer": ["viewer", "terminal", null],
    "viewer-unsupported": ["viewer", "terminal", null], "viewer-limit-reached": ["viewer", "terminal", null],
    "unauthorized": ["viewer", "terminal", null], "presentation-blocked": ["presentation", "recoverable", null],
    "acceptance-failed": ["acceptance", "terminal", "either"]
};
export class ContractValidationError extends TypeError {
    valueName;
    code = "invalid-contract-value";
    constructor(valueName) {
        super(`Invalid ${valueName}`);
        this.valueName = valueName;
        this.name = "ContractValidationError";
    }
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const DEVICE_KEYS = ["contractVersion", "platform", "namespace", "opaqueId"];
const DESCRIPTOR_KEYS = ["contractVersion", "streamId", "standaloneUri", "presentationModes", "expiresAt"];
const SNAPSHOT_KEYS = ["streamId", "deviceRef", "revision", "phase", "reason", "epoch", "codedSize", "displaySize", "activeViewerCount", "updatedAt"];
const ERROR_KEYS = ["code", "scope", "disposition", "safeMessage"];
const SIZE_KEYS = ["width", "height"];
const fail = (name) => { throw new ContractValidationError(name); };
const exact = (value, allowed, required = allowed.length) => {
    if (typeof value !== "object" || value === null || Array.isArray(value))
        fail("object");
    const object = value, prototype = Object.getPrototypeOf(object);
    if (prototype !== Object.prototype && prototype !== null)
        fail("object");
    for (const key of Reflect.ownKeys(object)) {
        if (typeof key !== "string" || !allowed.includes(key))
            fail("object");
        const descriptor = Object.getOwnPropertyDescriptor(object, key);
        if (!descriptor?.enumerable || !("value" in descriptor))
            fail("object");
    }
    if (allowed.slice(0, required).some((key) => !Object.hasOwn(object, key)))
        fail("object");
    return object;
};
const integer = (value, min, max, name) => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max ? value : fail(name);
const validatePresentationModes = (value) => {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
        fail("ViewerDescriptor");
    const array = value, keys = Reflect.ownKeys(array), item = Object.getOwnPropertyDescriptor(array, "0"), length = Object.getOwnPropertyDescriptor(array, "length");
    if (keys.length !== 2 || !keys.includes("0") || !keys.includes("length") || !item?.enumerable || !("value" in item) || item.value !== "standalone" || !length || length.enumerable || length.configurable || !("value" in length) || length.value !== 1)
        fail("ViewerDescriptor");
};
export function validateStreamId(value) { return typeof value === "string" && UUID.test(value) ? value : fail("StreamId"); }
export function validateDeviceRef(value) {
    const v = exact(value, DEVICE_KEYS);
    if (v.contractVersion !== CONTRACT_VERSION || (v.platform !== "android" && v.platform !== "ios") || typeof v.namespace !== "string" || v.namespace.length > 64 || !NAMESPACE.test(v.namespace))
        fail("DeviceRef");
    validateStreamId(v.opaqueId);
    return value;
}
export function validateSize(value) {
    const v = exact(value, SIZE_KEYS);
    integer(v.width, 1, 0xffffffff, "Size");
    integer(v.height, 1, 0xffffffff, "Size");
    return value;
}
export function validateViewerDescriptor(value) {
    const v = exact(value, DESCRIPTOR_KEYS);
    const streamId = validateStreamId(v.streamId);
    if (v.contractVersion !== CONTRACT_VERSION)
        fail("ViewerDescriptor");
    validatePresentationModes(v.presentationModes);
    integer(v.expiresAt, 0, Number.MAX_SAFE_INTEGER, "ViewerDescriptor");
    if (typeof v.standaloneUri !== "string")
        fail("ViewerDescriptor");
    const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})\/viewer\/([0-9a-f-]+)$/.exec(v.standaloneUri);
    if (!match || Number(match[1]) > 65535 || match[2] !== streamId)
        fail("ViewerDescriptor");
    return value;
}
export function validateStreamError(value) {
    const v = exact(value, ERROR_KEYS);
    if (typeof v.code !== "string" || !Object.hasOwn(ERRORS, v.code))
        fail("StreamError");
    const expected = ERRORS[v.code];
    if (v.scope !== expected[0] || v.disposition !== expected[1] || typeof v.safeMessage !== "string" || !v.safeMessage.isWellFormed() || v.safeMessage.normalize("NFC") !== v.safeMessage || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(v.safeMessage))
        fail("StreamError");
    const messageBytes = new TextEncoder().encode(v.safeMessage).length;
    if (messageBytes < 1 || messageBytes > 512)
        fail("StreamError");
    return value;
}
export function validateStreamSnapshot(value) {
    const v = exact(value, SNAPSHOT_KEYS, 4);
    validateStreamId(v.streamId);
    validateDeviceRef(v.deviceRef);
    if (!Object.hasOwn(v, "activeViewerCount") || !Object.hasOwn(v, "updatedAt"))
        fail("StreamSnapshot");
    integer(v.revision, 1, Number.MAX_SAFE_INTEGER, "StreamSnapshot");
    integer(v.updatedAt, 0, Number.MAX_SAFE_INTEGER, "StreamSnapshot");
    if (!STREAM_PHASES.includes(v.phase) || (v.activeViewerCount !== 0 && v.activeViewerCount !== 1))
        fail("StreamSnapshot");
    if (Object.hasOwn(v, "epoch"))
        integer(v.epoch, 1, Number.MAX_SAFE_INTEGER, "StreamSnapshot");
    if (Object.hasOwn(v, "codedSize"))
        validateSize(v.codedSize);
    if (Object.hasOwn(v, "displaySize"))
        validateSize(v.displaySize);
    const hasReason = Object.hasOwn(v, "reason"), reason = v.reason;
    if (v.phase === "interrupted" ? reason !== "stream-interrupted" : v.phase === "device-disconnected" ? reason !== "device-disconnected" : v.phase === "stopped" ? reason !== "explicit-stop" && reason !== "lease-expired" && reason !== "acceptance-failed" : v.phase === "failed" ? typeof reason !== "string" || !Object.hasOwn(ERRORS, reason) || !["failed", "either", "interrupted"].includes(ERRORS[reason][2] ?? "") : hasReason)
        fail("StreamSnapshot");
    return value;
}
const GRANT = /^[A-Za-z0-9_-]{22,2048}$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
class Grant {
    #raw;
    constructor(raw) { this.#raw = raw; Object.freeze(this); }
    static reveal(grant) { return grant.#raw; }
    toString() { return "[REDACTED]"; }
    toJSON() { return "[REDACTED]"; }
    [Symbol.toPrimitive]() { return "[REDACTED]"; }
}
Object.defineProperty(Grant.prototype, Symbol.for("nodejs.util.inspect.custom"), { value: () => "[REDACTED]" });
export function createViewerAccess(descriptorValue, rawGrant) {
    const source = validateViewerDescriptor(descriptorValue);
    if (typeof rawGrant !== "string" || !GRANT.test(rawGrant) || rawGrant.length % 4 === 1)
        fail("ViewerGrant");
    const grant = rawGrant, remainder = grant.length % 4, tail = ALPHABET.indexOf(grant.at(-1) ?? "");
    if ((remainder === 2 && (tail & 15) !== 0) || (remainder === 3 && (tail & 3) !== 0))
        fail("ViewerGrant");
    const descriptor = Object.freeze({ ...source, presentationModes: Object.freeze(["standalone"]) });
    const access = Object.defineProperties({ descriptor }, {
        viewerGrant: { value: new Grant(grant), enumerable: false },
        toJSON: { value: () => ({ descriptor }), enumerable: false },
        [Symbol.for("nodejs.util.inspect.custom")]: { value: () => ({ descriptor, viewerGrant: "[REDACTED]" }), enumerable: false }
    });
    return Object.freeze(access);
}
export function revealViewerGrant(grant) { return Grant.reveal(grant); }
export const MEDIA_MAJOR = 1, MEDIA_HEADER_BYTES = 40;
export const MAX_PAYLOAD_BYTES = 8_388_608, MAX_CONFIG_BYTES = 262_144, MAX_FRAME_BYTES = 8_126_464;
export const MEDIA_KIND = Object.freeze({ session: 1, config: 2, frame: 3, gap: 4, end: 5 });
export const END_REASON = Object.freeze({ explicitStop: 1, leaseExpired: 2, deviceDisconnected: 3, failed: 4 });
const U64_MAX = (1n << 64n) - 1n, I64_MIN = -(1n << 63n), I64_MAX = (1n << 63n) - 1n;
const validateHeader = (h) => {
    if (h.minor !== 0 && h.minor !== 1 || h.minor === 1 && (h.kind === 2 || h.kind === 3 && (h.flags !== 1 || h.ptsUs < 0n)))
        fail("MediaHeader");
    if (![1, 2, 3, 4, 5].includes(h.kind) || !Number.isInteger(h.flags) || (h.kind === 3 ? h.flags < 0 || h.flags > 1 : h.flags !== 0) || !Number.isInteger(h.payloadBytes) || h.payloadBytes < 0 || h.payloadBytes > MAX_PAYLOAD_BYTES)
        fail("MediaHeader");
    if ((h.kind === 1 && h.payloadBytes !== 24) || (h.kind === 2 && (h.payloadBytes < 1 || h.payloadBytes > MAX_CONFIG_BYTES)) || (h.kind === 3 && (h.payloadBytes < 1 || h.payloadBytes > MAX_FRAME_BYTES)) || (h.kind === 4 && h.payloadBytes !== 12) || (h.kind === 5 && h.payloadBytes !== 4))
        fail("MediaHeader");
    if (typeof h.sequence !== "bigint" || h.sequence < 1n || h.sequence > U64_MAX || typeof h.epoch !== "bigint" || h.epoch < 0n || h.epoch > U64_MAX || (h.kind !== 5 && h.epoch === 0n) || typeof h.ptsUs !== "bigint" || h.ptsUs < I64_MIN || h.ptsUs > I64_MAX || (h.kind !== 3 && h.ptsUs !== -1n))
        fail("MediaHeader");
};
export function encodeMediaHeader(header) {
    validateHeader(header);
    const bytes = new Uint8Array(MEDIA_HEADER_BYTES), view = new DataView(bytes.buffer);
    bytes.set([0x46, 0x53, 0x51, 0x56]);
    view.setUint8(4, MEDIA_MAJOR);
    view.setUint8(5, header.minor);
    view.setUint8(6, header.kind);
    view.setUint8(7, header.flags);
    view.setUint16(8, MEDIA_HEADER_BYTES);
    view.setUint32(12, header.payloadBytes);
    view.setBigUint64(16, header.sequence);
    view.setBigUint64(24, header.epoch);
    view.setBigInt64(32, header.ptsUs);
    return bytes;
}
export function decodeMediaHeader(message) {
    if (!(message instanceof Uint8Array) || message.byteLength < MEDIA_HEADER_BYTES)
        fail("MediaHeader");
    const view = new DataView(message.buffer, message.byteOffset, MEDIA_HEADER_BYTES);
    if (view.getUint32(0) !== 0x46535156 || view.getUint8(4) !== MEDIA_MAJOR || view.getUint8(5) > 1 || view.getUint16(8) !== MEDIA_HEADER_BYTES || view.getUint16(10) !== 0)
        fail("MediaHeader");
    const header = { minor: view.getUint8(5), kind: view.getUint8(6), flags: view.getUint8(7), payloadBytes: view.getUint32(12), sequence: view.getBigUint64(16), epoch: view.getBigUint64(24), ptsUs: view.getBigInt64(32) };
    validateHeader(header);
    if (message.byteLength !== MEDIA_HEADER_BYTES + header.payloadBytes)
        fail("MediaHeader");
    return header;
}
//# sourceMappingURL=index.js.map