import { inspect } from "node:util";
import { validateDeviceRef, type DeviceRef } from "../../../contracts/src/index.js";
import type { CaptureSource } from "../index.js";
import { WdaMjpegCaptureAdapter } from "./adapter.js";

export type IosWdaBindingSnapshot = Readonly<{
  bindingVersion: 1;
  platform: "ios";
  provider: "wda-mjpeg-v16.15.3";
  slot: "loopback-9100";
}>;

export type IosWdaCaptureSourceInput = Readonly<{
  access: IosWdaBindingAccess;
  deviceRef: DeviceRef;
}>;

const REDACTED = "[REDACTED]";
const ENDPOINT = "http://127.0.0.1:9100/";
const SNAPSHOT: IosWdaBindingSnapshot = Object.freeze({
  bindingVersion: 1,
  platform: "ios",
  provider: "wda-mjpeg-v16.15.3",
  slot: "loopback-9100",
});

let ownsAccess!: (value: unknown) => value is BindingAccess;

class BindingAccess {
  readonly snapshot = SNAPSHOT;
  readonly #brand = true;

  constructor() {
    Object.freeze(this);
  }

  toJSON(): Readonly<{ snapshot: IosWdaBindingSnapshot }> {
    return { snapshot: this.snapshot };
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }

  static {
    ownsAccess = (value: unknown): value is BindingAccess =>
      (typeof value === "object" || typeof value === "function") && value !== null && #brand in value;
  }
}

export type IosWdaBindingAccess = BindingAccess;

function invalid(message: string): never {
  throw new TypeError(message);
}

function exactInput(value: unknown): value is Record<"access" | "deviceRef", unknown> {
  if (typeof value !== "object" || value === null || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 2 || keys[0] !== "access" || keys[1] !== "deviceRef") return false;
  return keys.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && "value" in descriptor;
  });
}

export function resolveSingleIosWdaBinding(): IosWdaBindingAccess;
export function resolveSingleIosWdaBinding(...args: readonly unknown[]): IosWdaBindingAccess {
  if (args.length !== 0) return invalid("Invalid iOS WDA binding options");
  return new BindingAccess();
}

export function createIosWdaCaptureSource(input: IosWdaCaptureSourceInput): CaptureSource;
export function createIosWdaCaptureSource(input: unknown): CaptureSource {
  if (!exactInput(input) || !ownsAccess(input.access)) return invalid("Invalid iOS WDA capture source input");
  let deviceRef: DeviceRef;
  try {
    deviceRef = validateDeviceRef(input.deviceRef);
  } catch {
    return invalid("Invalid iOS WDA capture source input");
  }
  if (deviceRef.platform !== "ios") return invalid("Invalid iOS WDA capture source input");
  return new WdaMjpegCaptureAdapter({ deviceRef: Object.freeze({ ...deviceRef }), endpoint: ENDPOINT });
}
