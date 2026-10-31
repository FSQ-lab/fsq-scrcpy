import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import test from "node:test";
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import {
  CONTROL_VERSION,
  controlError,
  type DeviceRef,
  type RuntimeAttachment,
  type StreamSnapshot,
} from "../../contracts/src/index.js";
import type { AgentControl, AgentControlSession, AgentPresentation, AgentPresentationResult, EnsureAdapterResult } from "../src/agent-control.js";
import { createMcpServer,validateViewerAppResource } from "../src/mcp.js";

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
const IOS_DEVICE: DeviceRef = Object.freeze({
  contractVersion: 2,
  platform: "ios",
  namespace: "fsq.ios.local",
  opaqueId: "523e4567-e89b-42d3-a456-426614174000",
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
    features: Object.freeze(["wait-v1", "auto-bootstrap-v1", "mcp-app-v1"] as const),
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
const IOS_SNAPSHOT: StreamSnapshot = Object.freeze({ ...SNAPSHOT, deviceRef: IOS_DEVICE });
const IOS_ATTACHMENT: RuntimeAttachment = Object.freeze({ ...ATTACHMENT, instance: Object.freeze({ ...ATTACHMENT.instance, deviceRef: IOS_DEVICE }) });
const IOS_INSPECT = Object.freeze({ ...INSPECT, value: Object.freeze({ ...INSPECT.value, snapshot: IOS_SNAPSHOT, changes: Object.freeze([IOS_SNAPSHOT]) }) });
const IOS_ENSURE: EnsureAdapterResult = Object.freeze({ ok: true, value: Object.freeze({ ...ENSURE.value, attachment: IOS_ATTACHMENT, deviceRef: IOS_DEVICE, snapshot: IOS_SNAPSHOT }) });
const ensureAt=(streamId:string,port:number):EnsureAdapterResult=>Object.freeze({ok:true as const,value:Object.freeze({attachment:ATTACHMENT,deviceRef:DEVICE,descriptor:Object.freeze({...ENSURE.value.descriptor,streamId,standaloneUri:`http://127.0.0.1:${port}/viewer/${streamId}`}),snapshot:Object.freeze({...SNAPSHOT,streamId})})});
interface Calls {
  ensure: unknown[];
  open: unknown[];
  inspect: unknown[];
  wait: unknown[];
  prepare: unknown[];
  stop: unknown[];
  signals: AbortSignal[];
  closes: number;
}
interface FixtureValues { readonly ensure: EnsureAdapterResult; readonly inspect: Awaited<ReturnType<AgentControlSession["inspect"]>>; readonly snapshot: StreamSnapshot }
function fixture(overrides: Partial<AgentControlSession> = {}, values: FixtureValues = { ensure: ENSURE, inspect: INSPECT, snapshot: SNAPSHOT }): { agent: AgentControl; presenter:AgentPresentation; calls: Calls } {
  const calls: Calls = {
    ensure: [],
    open: [],
    inspect: [],
    wait: [],
    prepare: [],
    stop: [],
    signals: [],
    closes: 0,
  };
  const makeSession = (): AgentControlSession => ({
    async inspect(input, options) {
      calls.inspect.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return values.inspect;
    },
    async wait(input, options) {
      calls.wait.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return values.inspect;
    },
    async prepareEmbedded(input,options){calls.prepare.push(input);if(options?.signal)calls.signals.push(options.signal);return Object.freeze({ok:true as const,value:Object.freeze({streamId:STREAM_ID,expiresAt:60})});},
    async stop(input, options) {
      calls.stop.push(input);
      if (options?.signal) calls.signals.push(options.signal);
      return { ok: true, value: { snapshot: values.snapshot } };
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
        return values.ensure;
      },
      async openKnown(input, options) {
        calls.open.push(input);
        if (options?.signal) calls.signals.push(options.signal);
        return makeSession();
      },
    },
    presenter:{async ensure(input,options){calls.ensure.push({selector:input.selector});if(options?.signal)calls.signals.push(options.signal);if(input.prepareEmbedded)calls.prepare.push({streamId:STREAM_ID});calls.closes++;return Object.freeze({result:values.ensure,...(input.prepareEmbedded?{prepared:Object.freeze({ok:true as const,value:Object.freeze({streamId:STREAM_ID,expiresAt:60})})}:{})});}},
  };
}
async function connect(agent: AgentControl,presenter:AgentPresentation, revision = "2025-11-25",apps=false): Promise<{
  client: Client;
  close(): Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer(agent,presenter);
  await server.connect(serverTransport);
  const client = new Client(
    { name: "fsq-contract-test", version: "1.0.0" },
    { supportedProtocolVersions: [revision],...(apps?{capabilities:{extensions:{"io.modelcontextprotocol/ui":{mimeTypes:["text/html;profile=mcp-app"]}}}}:{}) },
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
test("packaged MCP App resource is private and integrity pinned",()=>{const bytes=readFileSync(new URL("../../../modules/viewer/dist/index.html",import.meta.url)),text=validateViewerAppResource(bytes);assert.equal(text.includes("<canvas"),true);const tampered=Buffer.from(bytes),last=tampered.length-1;tampered[last]=tampered[last]!^1;assert.throws(()=>validateViewerAppResource(tampered),/Invalid packaged Viewer App resource/);});


await test("four tools map exact arguments, wait default, original signals, and close-once", async () => {
  const value = fixture();
  const connection = await connect(value.agent,value.presenter);
  const listed=await connection.client.listTools(),ensureTool=listed.tools.find(tool=>tool.name==="fsq_viewer_ensure");assert.equal(listed.tools.length,4);assert.deepEqual(ensureTool?._meta?.ui,{resourceUri:"ui://fsq-scrcpy/viewer-v1",visibility:["model"]});const resources=await connection.client.listResources();assert.deepEqual(resources.resources.map(resource=>resource.uri),["ui://fsq-scrcpy/viewer-v1"]);const resource=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.equal(resource.contents[0]?.mimeType,"text/html;profile=mcp-app");assert.equal("text" in resource.contents[0]!&&resource.contents[0].text.includes("<canvas"),true);assert.deepEqual(resource.contents[0]?._meta?.ui,{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}});
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
  assert.deepEqual(value.calls.prepare,[]);
  assert.equal(value.calls.closes, 4);
  assert.equal(value.calls.signals.length, 7);
  for (const signal of value.calls.signals) assert.equal(signal instanceof AbortSignal, true);
  await connection.close();
});


await test("a pending ensure clears old projection and out-of-order completion cannot replace the newest projection",async()=>{const value=fixture(),connection=await connect(value.agent,value.presenter,"2025-11-25",true),selector={kind:"known" as const,deviceRef:DEVICE};await connection.client.callTool({name:"fsq_viewer_ensure",arguments:{selector}});const projected=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.deepEqual(projected.contents[0]?._meta?.ui,{prefersBorder:true,csp:{connectDomains:["http://127.0.0.1:49152","ws://127.0.0.1:49152"],resourceDomains:["http://127.0.0.1:49152"]}});const resolvers:Array<(value:AgentPresentationResult)=>void>=[];value.presenter.ensure=async()=>new Promise(resolve=>resolvers.push(resolve));const first=connection.client.callTool({name:"fsq_viewer_ensure",arguments:{selector}});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(resolvers.length,1);const whilePending=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.deepEqual(whilePending.contents[0]?._meta?.ui,{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}});const second=connection.client.callTool({name:"fsq_viewer_ensure",arguments:{selector}});await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(resolvers.length,2);const firstStream="523e4567-e89b-42d3-a456-426614174000",secondStream="623e4567-e89b-42d3-a456-426614174000",firstResult=ensureAt(firstStream,49153),secondResult=ensureAt(secondStream,49154);resolvers[1]!({result:secondResult,prepared:{ok:true,value:{streamId:secondStream,expiresAt:60}}});await second;const newest=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.deepEqual(newest.contents[0]?._meta?.ui,{prefersBorder:true,csp:{connectDomains:["http://127.0.0.1:49154","ws://127.0.0.1:49154"],resourceDomains:["http://127.0.0.1:49154"]}});resolvers[0]!({result:firstResult,prepared:{ok:true,value:{streamId:firstStream,expiresAt:60}}});await first;const afterOld=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.deepEqual(afterOld.contents[0]?._meta?.ui,newest.contents[0]?._meta?.ui);await connection.close();});
await test("Apps capability prepares one private presentation and publishes exact Runtime CSP",async()=>{const value=fixture(),connection=await connect(value.agent,value.presenter,"2025-11-25",true);const ensured=await connection.client.callTool({name:"fsq_viewer_ensure",arguments:{selector:{kind:"known",deviceRef:DEVICE}}});assert.deepEqual(dto(ensured),ENSURE);assert.deepEqual(value.calls.prepare,[{streamId:STREAM_ID}]);assert.deepEqual(value.calls.open,[]);assert.equal(value.calls.closes,1);const resource=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"}),ui=resource.contents[0]?._meta?.ui;assert.deepEqual(ui,{prefersBorder:true,csp:{connectDomains:["http://127.0.0.1:49152","ws://127.0.0.1:49152"],resourceDomains:["http://127.0.0.1:49152"]}});await connection.close();});
await test("iOS uses the same four tools and remains standalone fallback with Apps capability",async()=>{const value=fixture({}, {ensure:IOS_ENSURE,inspect:IOS_INSPECT,snapshot:IOS_SNAPSHOT}),connection=await connect(value.agent,value.presenter,"2025-11-25",true);const ensured=await connection.client.callTool({name:"fsq_viewer_ensure",arguments:{selector:{kind:"auto",platform:"ios"}}});assert.deepEqual(dto(ensured),IOS_ENSURE);assert.deepEqual(value.calls.ensure,[{selector:{kind:"auto",platform:"ios"}}]);assert.deepEqual(value.calls.prepare,[]);const resource=await connection.client.readResource({uri:"ui://fsq-scrcpy/viewer-v1"});assert.deepEqual(resource.contents[0]?._meta?.ui,{prefersBorder:true,csp:{connectDomains:[],resourceDomains:[]}});const inspected=await connection.client.callTool({name:"fsq_stream_inspect",arguments:{deviceRef:IOS_DEVICE,streamId:STREAM_ID,afterRevision:1}}),waited=await connection.client.callTool({name:"fsq_stream_wait",arguments:{deviceRef:IOS_DEVICE,streamId:STREAM_ID,afterRevision:1,waitMs:0}}),stopped=await connection.client.callTool({name:"fsq_stream_stop",arguments:{deviceRef:IOS_DEVICE,streamId:STREAM_ID,expectedRevision:1}});assert.deepEqual(dto(inspected),IOS_INSPECT);assert.deepEqual(dto(waited),IOS_INSPECT);assert.deepEqual(dto(stopped),{ok:true,value:{snapshot:IOS_SNAPSHOT}});assert.deepEqual(value.calls.open,[{deviceRef:IOS_DEVICE},{deviceRef:IOS_DEVICE},{deviceRef:IOS_DEVICE}]);assert.deepEqual(value.calls.wait,[{streamId:STREAM_ID,afterRevision:1,waitMs:0}]);await connection.close();});

await test("MCP wait accepts the exact endpoints and rejects values outside 0..25000", async () => {
  for (const waitMs of [0, 25_000]) {
    const value = fixture();
    const connection = await connect(value.agent,value.presenter);
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
    const connection = await connect(value.agent,value.presenter);
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
    { deviceRef: { ...DEVICE, platform: "windows" }, streamId: STREAM_ID },
    { deviceRef: { ...DEVICE, privateCredential: "secret" }, streamId: STREAM_ID },
    { deviceRef: DEVICE, streamId: STREAM_ID.toUpperCase() },
    { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: "1" },
    { deviceRef: DEVICE, streamId: STREAM_ID, afterRevision: 0 },
    { deviceRef: DEVICE, streamId: STREAM_ID, extra: true },
    { deviceRef: DEVICE, streamId: STREAM_ID, nested: Array.from({ length: 17 }, () => 1) },
  ];
  for (const args of invalid) {
    const value = fixture();
    const connection = await connect(value.agent,value.presenter);
    const result = await connection.client.callTool({ name: "fsq_stream_inspect", arguments: args });
    assert.equal(result.isError, true);
    assert.equal(value.calls.open.length, 0);
    assert.equal(JSON.stringify(result).includes("secret"), false);
    await connection.close();
  }
});

await test("a direct handler exception becomes only the fixed safe projection", async () => {
  const value = fixture();
  value.presenter.ensure = async () => { throw new Error("owner credential secret /Users/private stack"); };
  const connection = await connect(value.agent,value.presenter);
  const result = await connection.client.callTool({ name: "fsq_viewer_ensure", arguments: { selector: { kind: "auto", platform: "android" } } });
  assert.equal(result.isError, true);
  assert.deepEqual(dto(result), { ok: false, error: controlError("runtime-exited") });
  assert.equal(JSON.stringify(result).includes("secret"), false);
  await connection.close();
});
