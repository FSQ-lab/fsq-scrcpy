import { parseArgs } from "node:util";

export type CliCommand =
  | Readonly<{ path: "viewer ensure"; json: boolean; platform?: "android" | "ios"; deviceRef?: string }>
  | Readonly<{ path: "stream inspect"; json: boolean; streamId: string; afterRevision?: number }>
  | Readonly<{ path: "stream wait"; json: true; streamId: string; afterRevision: number; waitMs: number }>
  | Readonly<{ path: "stream watch"; jsonSeq: true; streamId: string; afterRevision?: number }>
  | Readonly<{ path: "stream stop"; json: boolean; streamId: string; expectedRevision?: number }>
  | Readonly<{ path: "runtime shutdown"; json: boolean; deviceRef: string }>
  | Readonly<{ path: "local-state status"; json: boolean; platform: "android" | "ios" }>
  | Readonly<{ path: "local-state reset-control"; json: boolean; platform: "android"; deviceRef: string }>
  | Readonly<{ path: "local-state rebind-device"; json: boolean; platform: "android"; deviceRef: string }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REVISION = /^[1-9][0-9]*$/;
const PATHS = new Set([
  "viewer ensure", "stream inspect", "stream wait", "stream watch", "stream stop",
  "runtime shutdown", "local-state status", "local-state reset-control", "local-state rebind-device",
]);
const OPTIONS = {
  "viewer ensure": { platform: { type: "string" }, "device-ref": { type: "string" }, json: { type: "boolean" } },
  "stream inspect": { "stream-id": { type: "string" }, "after-revision": { type: "string" }, json: { type: "boolean" } },
  "stream wait": { "stream-id": { type: "string" }, "after-revision": { type: "string" }, "wait-ms": { type: "string" }, json: { type: "boolean" }, "json-seq": { type: "boolean" } },
  "stream watch": { "stream-id": { type: "string" }, "after-revision": { type: "string" }, json: { type: "boolean" }, "json-seq": { type: "boolean" } },
  "stream stop": { "stream-id": { type: "string" }, "expected-revision": { type: "string" }, json: { type: "boolean" } },
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
const waitMs = (value: unknown): number | undefined => {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) return;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 30_000 ? parsed : undefined;
};

export function syntaxMode(argv: readonly string[]): "sequence" | "compact" | "pretty" { return argv.includes("--json-seq") ? "sequence" : argv.includes("--json") ? "compact" : "pretty"; }

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
      if ((token.name === "json" || token.name === "json-seq") && token.value !== undefined) return;
    }
    const json = values.json === true;
    if (path === "stream wait" || path === "stream watch") {
      const streamId = values["stream-id"], after = revision(values["after-revision"]), jsonSeq = values["json-seq"] === true;
      if (!uuid(streamId) || values["after-revision"] !== undefined && after === undefined || json === jsonSeq) return;
      if (path === "stream watch") return jsonSeq ? Object.freeze({ path, jsonSeq, streamId, ...(after === undefined ? {} : { afterRevision: after }) }) : undefined;
      const rawWait = values["wait-ms"], duration = rawWait === undefined ? 30_000 : waitMs(rawWait);
      return json && after !== undefined && duration !== undefined ? Object.freeze({ path, json, streamId, afterRevision: after, waitMs: duration }) : undefined;
    }
    if (path === "viewer ensure") {
      const platform = values.platform, deviceRef = values["device-ref"];
      if (has(values, "platform") === has(values, "device-ref")) return;
      if (platform !== undefined && platform !== "android" && platform !== "ios" || deviceRef !== undefined && !uuid(deviceRef)) return;
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
    if (path === "runtime shutdown") {
      const deviceRef = values["device-ref"];
      return uuid(deviceRef) ? Object.freeze({ path, json, deviceRef }) : undefined;
    }
    const platform = values.platform;
    if (platform !== "android" && platform !== "ios") return;
    if (path === "local-state status") return Object.freeze({ path, json, platform });
    if (platform !== "android") return;
    const deviceRef = values["device-ref"];
    if (!uuid(deviceRef)) return;
    if (path === "local-state reset-control") return Object.freeze({ path, json, platform, deviceRef });
    if (path === "local-state rebind-device") return Object.freeze({ path, json, platform, deviceRef });
    return;
  } catch {
    return;
  }
}
