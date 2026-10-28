import { parseArgs } from "node:util";

export type CliCommand =
  | Readonly<{ path: "viewer ensure"; json: boolean; platform?: "android"; deviceRef?: string }>
  | Readonly<{ path: "stream inspect"; json: boolean; streamId: string; afterRevision?: number }>
  | Readonly<{ path: "stream stop"; json: boolean; streamId: string; expectedRevision?: number }>
  | Readonly<{ path: "viewer approve"; json: boolean; streamId: string; code: string }>
  | Readonly<{ path: "runtime shutdown"; json: boolean; deviceRef: string }>
  | Readonly<{ path: "local-state status"; json: boolean; platform: "android" }>
  | Readonly<{ path: "local-state reset-control"; json: boolean; platform: "android"; deviceRef: string }>
  | Readonly<{ path: "local-state rebind-device"; json: boolean; platform: "android"; deviceRef: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[1-9][0-9]*$/;
const CODE = /^[0-9A-HJKMNP-TV-Z]{8}$/;
const PATHS = new Set([
  "viewer ensure", "stream inspect", "stream stop", "viewer approve",
  "runtime shutdown", "local-state status", "local-state reset-control", "local-state rebind-device",
]);
const OPTIONS = {
  "viewer ensure": { platform: { type: "string" }, "device-ref": { type: "string" }, json: { type: "boolean" } },
  "stream inspect": { "stream-id": { type: "string" }, "after-revision": { type: "string" }, json: { type: "boolean" } },
  "stream stop": { "stream-id": { type: "string" }, "expected-revision": { type: "string" }, json: { type: "boolean" } },
  "viewer approve": { "stream-id": { type: "string" }, code: { type: "string" }, json: { type: "boolean" } },
  "runtime shutdown": { "device-ref": { type: "string" }, json: { type: "boolean" } },
  "local-state status": { platform: { type: "string" }, json: { type: "boolean" } },
  "local-state reset-control": { platform: { type: "string" }, "device-ref": { type: "string" }, json: { type: "boolean" } },
  "local-state rebind-device": { platform: { type: "string" }, "device-ref": { type: "string" }, json: { type: "boolean" } },
} as const;

type Values = Record<string, string | boolean | undefined>;
const has = (values: Values, name: string): boolean => Object.hasOwn(values, name);
const uuid = (value: unknown): value is string => typeof value === "string" && UUID.test(value);
const revision = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !REVISION.test(value)) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export function compactSyntax(argv: readonly string[]): boolean { return argv.includes("--json"); }

export function parseCommand(argv: readonly string[]): CliCommand | undefined {
  if (argv.length < 2) return;
  const path = `${argv[0]} ${argv[1]}`;
  if (!PATHS.has(path)) return;
  try {
    const parsed = parseArgs({
      args: [...argv.slice(2)], options: OPTIONS[path as keyof typeof OPTIONS],
      strict: true, allowPositionals: false, allowNegative: false, tokens: true,
    });
    const values = parsed.values as Values;
    const seen = new Set<string>();
    for (const token of parsed.tokens) {
      if (token.kind !== "option" || seen.has(token.name)) return;
      seen.add(token.name);
      if (token.name === "json" && token.value !== undefined) return;
    }
    const json = values.json === true;
    if (path === "viewer ensure") {
      const platform = values.platform, deviceRef = values["device-ref"];
      if (has(values, "platform") === has(values, "device-ref")) return;
      if (platform !== undefined && platform !== "android" || deviceRef !== undefined && !uuid(deviceRef)) return;
      return Object.freeze({ path, json, ...(platform ? { platform } : { deviceRef: deviceRef as string }) });
    }
    if (path === "stream inspect" || path === "stream stop") {
      const streamId = values["stream-id"];
      if (!uuid(streamId)) return;
      const option = path === "stream inspect" ? "after-revision" : "expected-revision";
      const raw = values[option], parsedRevision = raw === undefined ? undefined : revision(raw);
      if (raw !== undefined && parsedRevision === undefined) return;
      return Object.freeze({ path, json, streamId, ...(parsedRevision === undefined ? {} : path === "stream inspect" ? { afterRevision: parsedRevision } : { expectedRevision: parsedRevision }) }) as CliCommand;
    }
    if (path === "viewer approve") {
      const streamId = values["stream-id"], code = values.code;
      return uuid(streamId) && typeof code === "string" && CODE.test(code) ? Object.freeze({ path, json, streamId, code }) : undefined;
    }
    if (path === "runtime shutdown") {
      const deviceRef = values["device-ref"];
      return uuid(deviceRef) ? Object.freeze({ path, json, deviceRef }) : undefined;
    }
    const platform = values.platform;
    if (platform !== "android") return;
    if (path === "local-state status") return Object.freeze({ path, json, platform });
    const deviceRef = values["device-ref"];
    if (!uuid(deviceRef)) return;
    if (path === "local-state reset-control") return Object.freeze({ path, json, platform, deviceRef });
    if (path === "local-state rebind-device") return Object.freeze({ path, json, platform, deviceRef });
    return;
  } catch {
    return;
  }
}
