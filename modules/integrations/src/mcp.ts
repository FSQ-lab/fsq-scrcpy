import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod/v4";
import type { DeviceRef } from "../../contracts/src/index.js";
import {
  createAgentControl,
  createAgentPresentation,
  runtimeExitedResult,
  type AgentControl,
  type AgentControlSession,
  type AgentPresentation,
} from "./agent-control.js";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const APP_URI="ui://fsq-scrcpy/viewer-v1";
const UI_MIME="text/html;profile=mcp-app";
const APP_SHA256="0693d4118c5edd49f77b3c4754ed6dc7e7d940ee2d334f2c262b6314c5fc3652",APP_BYTES=560637;
export function validateViewerAppResource(bytes:Uint8Array):string{if(bytes.byteLength!==APP_BYTES||createHash("sha256").update(bytes).digest("hex")!==APP_SHA256)throw new Error("Invalid packaged Viewer App resource");const text=new TextDecoder("utf-8",{fatal:true}).decode(bytes);if(Buffer.byteLength(text,"utf8")!==APP_BYTES)throw new Error("Invalid packaged Viewer App resource");return text;}
const loadViewerAppResource=():string=>validateViewerAppResource(readFileSync(new URL("../../../modules/viewer/dist/index.html",import.meta.url)));
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
type Presentation=Readonly<{streamId:string;origin:string;expiresAt:number}>;

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

export function createMcpServer(agent: AgentControl = createAgentControl(),presenter:AgentPresentation=createAgentPresentation()): McpServer {
  const server = new McpServer({ name: "fsq-scrcpy", version: "0.0.0" }, { maxToolInputElements: 16 }),appHtml=loadViewerAppResource();
  let presentation:Presentation|undefined,projectionVersion=0;
  server.registerTool(MCP_TOOL_NAMES[0],{inputSchema:MCP_INPUT_SCHEMAS.ensure,_meta:{ui:{resourceUri:APP_URI,visibility:["model"]},"ui/resourceUri":APP_URI}},async(input,context)=>{
    const extension=server.server.getClientCapabilities()?.extensions?.["io.modelcontextprotocol/ui"] as {mimeTypes?:unknown}|undefined,version=++projectionVersion,prepareEmbedded=Array.isArray(extension?.mimeTypes)&&extension.mimeTypes.includes(UI_MIME);presentation=undefined;try{const transaction=await presenter.ensure({selector:input.selector,prepareEmbedded},{signal:context.mcpReq.signal}),result=transaction.result,prepared=transaction.prepared;if(result.ok&&prepared?.ok&&version===projectionVersion&&prepareEmbedded){const uri=new URL(result.value.descriptor.standaloneUri);presentation=Object.freeze({streamId:prepared.value.streamId,origin:uri.origin,expiresAt:prepared.value.expiresAt});}return project(result as unknown as SafeResult);}catch{return project(runtimeExitedResult() as unknown as SafeResult);}
  });
  server.registerResource("FSQ Device Viewer",APP_URI,{mimeType:UI_MIME,description:"Read-only live device video",_meta:{ui:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}}}},async()=>{const current=presentation,ui=current?{prefersBorder:true,csp:{connectDomains:[current.origin,current.origin.replace(/^http:/,"ws:")],resourceDomains:[current.origin]}}:{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}};return{contents:[{uri:APP_URI,mimeType:UI_MIME,text:appHtml,_meta:{ui}}]};});
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
