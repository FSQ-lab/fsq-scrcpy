import assert from "node:assert/strict";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  CONTROL_VERSION,
  controlError,
  type DeviceRef,
  type RuntimeAttachment,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import type { AgentControl, AgentControlSession, EnsureAdapterResult } from "../src/agent-control.js";
import { createMcpServer } from "../src/mcp.js";

const DEVICE_ID = "123e4567-e89b-42d3-a456-426614174000";
const STREAM_ID = "223e4567-e89b-42d3-a456-426614174000";
const INSTANCE_ID = "323e4567-e89b-42d3-a456-426614174000";
const GENERATION_ID = "423e4567-e89b-42d3-a456-426614174000";
const DEVICE: DeviceRef = Object.freeze({
  contractVersion: 2,
  platform: "android",
  namespace: "fsq.android.local",
  opaqueId: DEVICE_ID,
});
const SNAPSHOT: StreamSnapshot = Object.freeze({
  streamId: STREAM_ID,
  deviceRef: DEVICE,
  revision: 1,
  phase: "demand-pending",
  activeViewerCount: 0,
  updatedAt: 1,
});
const ATTACHMENT: RuntimeAttachment = Object.freeze({
  disposition: "attached",
  instance: Object.freeze({
    controlVersion: CONTROL_VERSION,
    instanceId: INSTANCE_ID,
    generation: GENERATION_ID,
    contractVersion: 2,
    deviceRef: DEVICE,
    features: Object.freeze(["wait-v1", "auto-bootstrap-v1"] as const),
  }),
});
const INSPECT = Object.freeze({
  ok: true as const,
  value: Object.freeze({
    snapshot: SNAPSHOT,
    changes: Object.freeze([SNAPSHOT]),
    reset: false,
    timedOut: false,
  }),
});
const ENSURE: EnsureAdapterResult = Object.freeze({
  ok: true,
  value: Object.freeze({
    attachment: ATTACHMENT,
    deviceRef: DEVICE,
    descriptor: Object.freeze({
      contractVersion: 2 as const,
      streamId: STREAM_ID,
      standaloneUri: `http://127.0.0.1:49152/viewer/${STREAM_ID}`,
      presentationModes: Object.freeze(["standalone"] as const),
      expiresAt: 60,
    }),
    snapshot: SNAPSHOT,
  }),
});
interface Calls {
  ensure: unknown[];
  open: unknown[];
  inspect: unknown[];
  wait: unknown[];
  stop: unknown[];
  signals: AbortSignal[];
  closes: number;
}
function fixture(overrides: Partial<AgentControlSession> = {}): { agent: AgentControl; calls: Calls } {
  const calls: Calls = {
    ensure: [],
    open: [],
    inspect: [],
    wait: [],
    stop: [],
    signals: [],
    closes: 0,
  };
  const makeSession = (): AgentControlSession => ({
    async inspect(input, options) {
      calls.inspect.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return INSPECT;
    },
    async wait(input, options) {
      calls.wait.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return INSPECT;
    },
    async stop(input, options) {
      calls.stop.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return { ok: true, value: { snapshot: SNAPSHOT } };
    },
    async close() { calls.closes++; },
    ...overrides,
  });
  return {
    calls,
    agent: {
      async ensure(input, options) {
        calls.ensure.push(input);
        if (options?.signal) calls.signals.push(options.signal);
        return ENSURE;
      },
      async openKnown(input, options) {
        calls.open.push(input);
        if (options?.signal) calls.signals.push(options.signal);
        return makeSession();
      },
    },
  };
}
async function connect(agent: AgentControl, revision = "2025-11-25"): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(agent);
  await server.connect(serverTransport);
  const client = new Client(
    { name: "fsq-contract-test", version: "1.0.0" },
    { supportedProtocolVersions: [revision] },
  );
  await client.connect(clientTransport);
  return {
    client,
    async close() {
      await client.close();
      await server.close();
    },
  };
}
function dto(result: Awaited<ReturnType<Client["callTool"]>>): Record<string, unknown> {
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0]!.type, "text");
  const text = JSON.parse((result.content[0] as { text: string }).text) as Record<string, unknown>;
  assert.deepEqual(text, result.structuredContent);
  return text;
}

await test("four tools map exact arguments, wait default, original signals, and close-once", async () => {
  const value = fixture();
  const connection = await connect(value.agent);
  const ensured = await connection.client.callTool({
    name: "fsq_viewer_ensure",
    arguments: { selector: { kind: "known", deviceRef: DEVICE } },
  });
  const inspected = await connection.client.callTool({
    name: "fsq_stream_inspect",
    arguments: { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 1 },
  });
  const waited = await connection.client.callTool({
    name: "fsq_stream_wait",
    arguments: { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 1 },
  });
  const stopped = await connection.client.callTool({
    name: "fsq_stream_stop",
    arguments: { deviceRef: DEVICE, streamId: STREAM_ID, expectedRevision: 1 },
  });
  assert.deepEqual(dto(ensured), ENSURE);
  assert.deepEqual(dto(inspected), INSPECT);
  assert.deepEqual(dto(waited), INSPECT);
  assert.deepEqual(dto(stopped), { ok: true, value: { snapshot: SNAPSHOT } });
  for (const result of [ensured, inspected, waited, stopped]) {
    assert.equal(Object.hasOwn(result, "isError"), false);
  }
  assert.deepEqual(value.calls.ensure, [{ selector: { kind: "known", deviceRef: DEVICE } }]);
  assert.deepEqual(value.calls.open, [
    { deviceRef: DEVICE },
    { deviceRef: DEVICE },
    { deviceRef: DEVICE },
  ]);
  assert.deepEqual(value.calls.inspect, [{ streamId: STREAM_ID, afterRevision: 1 }]);
  assert.deepEqual(value.calls.wait, [{ streamId: STREAM_ID, afterRevision: 1, waitMs: 25_000 }]);
  assert.deepEqual(value.calls.stop, [{ streamId: STREAM_ID, expectedRevision: 1 }]);
  assert.equal(value.calls.closes, 3);
  assert.equal(value.calls.signals.length, 7);
  for (const signal of value.calls.signals) assert.equal(signal instanceof AbortSignal, true);
  await connection.close();
});

await test("MCP wait accepts the exact endpoints and rejects values outside 0..25000", async () => {
  for (const waitMs of [0, 25_000]) {
    const value = fixture();
    const connection = await connect(value.agent);
    const result = await connection.client.callTool({
      name: "fsq_stream_wait",
      arguments: { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 1, waitMs },
    });
    assert.equal(result.isError, undefined);
    assert.deepEqual(value.calls.wait, [{ streamId: STREAM_ID, afterRevision: 1, waitMs }]);
    await connection.close();
  }
  for (const waitMs of [-0, -1, 25_001, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
    const value = fixture();
    const connection = await connect(value.agent);
    const result = await connection.client.callTool({
      name: "fsq_stream_wait",
      arguments: { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 1, waitMs },
    });
    assert.equal(result.isError, true);
    assert.equal(value.calls.open.length, 0);
    await connection.close();
  }
});

await test("strict schemas reject aliases, coercion, extra fields, wrong identities, and element overflow", async () => {
  const invalid: readonly Record<string, unknown>[] = [
    {},
    { deviceRef: DEVICE_ID, streamId: STREAM_ID },
    { deviceRef: { ...DEVICE, platform: "ios" }, streamId: STREAM_ID },
    { deviceRef: { ...DEVICE, privateCredential: "secret" }, streamId: STREAM_ID },
    { deviceRef: DEVICE, streamId: STREAM_ID.toUpperCase() },
    { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: "1" },
    { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 0 },
    { deviceRef: DEVICE, streamId: STREAM_ID, extra: true },
    { deviceRef: DEVICE, streamId: STREAM_ID, nested: Array.from({ length: 17 }, () => 1) },
  ];
  for (const args of invalid) {
    const value = fixture();
    const connection = await connect(value.agent);
    const result = await connection.client.callTool({ name: "fsq_stream_inspect", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(value.calls.open.length, 0);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await connection.close();
  }
});

await test("a direct handler exception becomes only the fixed safe projection", async () => {
  const value = fixture();
  value.agent.ensure = async () => { throw new Error("owner credential secret /Users/private stack"); };
  const connection = await connect(value.agent);
  const result = await connection.client.callTool({ name: "fsq_viewer_ensure", arguments: { selector: { kind: "auto", platform: "android" } } });
  assert.equal(result.isError, true);
  assert.deepEqual(dto(result), { ok: false, error: controlError("runtime-exited") });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  await connection.close();
});
