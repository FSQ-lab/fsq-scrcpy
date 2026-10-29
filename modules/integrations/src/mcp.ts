import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { DeviceRef } from "../../contracts/src/index.js";
import {
  createAgentControl,
  runtimeExitedResult,
  type AgentControl,
  type AgentControlSession,
} from "./agent-control.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NAMESPACE = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const uuid = z.string().regex(UUID);
const revision = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const waitMilliseconds = z.number().int().min(0).max(25_000).refine((value) => !Object.is(value, -0)).default(25_000);
const deviceRef = z.strictObject({
  contractVersion: z.literal(2),
  platform: z.literal("android"),
  namespace: z.string().min(1).max(64).regex(NAMESPACE),
  opaqueId: uuid,
});
const selector = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auto"), platform: z.literal("android") }),
  z.strictObject({ kind: z.literal("known"), deviceRef }),
]);

export const MCP_TOOL_NAMES = Object.freeze([
  "fsq_viewer_ensure",
  "fsq_stream_inspect",
  "fsq_stream_wait",
  "fsq_stream_stop",
] as const);
export const MCP_INPUT_SCHEMAS = Object.freeze({
  ensure: z.strictObject({ selector }),
  inspect: z.strictObject({ deviceRef, streamId: uuid, afterRevision: revision.optional() }),
  wait: z.strictObject({ deviceRef, streamId: uuid, afterRevision: revision, waitMs: waitMilliseconds }),
  stop: z.strictObject({ deviceRef, streamId: uuid, expectedRevision: revision.optional() }),
});

type SafeResult = Readonly<{ ok: boolean }> & Record<string, unknown>;
const project = (result: SafeResult): CallToolResult => Object.freeze({
  content: Object.freeze([{ type: "text" as const, text: JSON.stringify(result) }]),
  structuredContent: result,
  ...(result.ok ? {} : { isError: true }),
}) as CallToolResult;
async function withKnown(
  agent: AgentControl,
  input: Readonly<{ deviceRef: DeviceRef }>,
  signal: AbortSignal,
  operation: (session: AgentControlSession) => Promise<SafeResult>,
): Promise<CallToolResult> {
  let session: AgentControlSession | undefined;
  let result: SafeResult;
  try {
    session = await agent.openKnown({ deviceRef: input.deviceRef }, { signal });
    result = await operation(session);
  } catch {
    result = runtimeExitedResult() as unknown as SafeResult;
  } finally {
    try { await session?.close(); }
    catch { result = runtimeExitedResult() as unknown as SafeResult; }
  }
  return project(result);
}

export function createMcpServer(agent: AgentControl = createAgentControl()): McpServer {
  const server = new McpServer({ name: "fsq-scrcpy", version: "0.0.0" }, { maxToolInputElements: 16 });
  server.registerTool(MCP_TOOL_NAMES[0], { inputSchema: MCP_INPUT_SCHEMAS.ensure }, async (input, context) => {
    try { return project(await agent.ensure(input, { signal: context.mcpReq.signal }) as unknown as SafeResult); }
    catch { return project(runtimeExitedResult() as unknown as SafeResult); }
  });
  server.registerTool(MCP_TOOL_NAMES[1], { inputSchema: MCP_INPUT_SCHEMAS.inspect }, (input, context) => withKnown(
    agent,
    input,
    context.mcpReq.signal,
    (session) => session.inspect(
      { streamId: input.streamId, ...(input.afterRevision === undefined ? {} : { afterRevision: input.afterRevision }) },
      { signal: context.mcpReq.signal },
    ) as unknown as Promise<SafeResult>,
  ));
  server.registerTool(MCP_TOOL_NAMES[2], { inputSchema: MCP_INPUT_SCHEMAS.wait }, (input, context) => withKnown(
    agent,
    input,
    context.mcpReq.signal,
    (session) => session.wait(
      { streamId: input.streamId, afterRevision: input.afterRevision, waitMs: input.waitMs },
      { signal: context.mcpReq.signal },
    ) as unknown as Promise<SafeResult>,
  ));
  server.registerTool(MCP_TOOL_NAMES[3], { inputSchema: MCP_INPUT_SCHEMAS.stop }, (input, context) => withKnown(
    agent,
    input,
    context.mcpReq.signal,
    (session) => session.stop(
      { streamId: input.streamId, ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }) },
      { signal: context.mcpReq.signal },
    ) as unknown as Promise<SafeResult>,
  ));
  return server;
}
