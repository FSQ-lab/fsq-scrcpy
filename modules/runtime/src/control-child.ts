import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateDeviceRef, type DeviceRef } from "../../contracts/src/index.js";
import { ScrcpyV501CaptureAdapter, createIosWdaCaptureSource, resolveSingleIosWdaBinding, type CaptureSource } from "../../capture/src/index.js";
import { LocalRuntimeState, type RuntimeGenerationState } from "./control-state.js";
import { RuntimeControlHost } from "./control.js";
import { createViewerAssetManifest } from "./http.js";
import { createRuntimeService } from "./index.js";

interface ParentFrame { readonly type: "cancel" | "ready" }
const send = (value: Readonly<Record<string, string>>): void => { if (process.connected) process.send?.(value); };
const finishProcess = (code: number): void => { if (process.connected) process.disconnect(); process.exitCode = code; };
async function manifest() { const root = join(dirname(fileURLToPath(import.meta.url)), "../../../modules/viewer/dist"), specs = [{ role: "entry-module" as const, name: "entry.js", mime: "text/javascript; charset=utf-8" as const }, { role: "worker-module" as const, name: "worker.js", mime: "text/javascript; charset=utf-8" as const }, { role: "style" as const, name: "style.css", mime: "text/css; charset=utf-8" as const }], inputs = []; for (const spec of specs) { const bytes = await readFile(join(root, spec.name)); inputs.push({ ...spec, sha256: createHash("sha256").update(bytes).digest("hex"), bytes }); } return createViewerAssetManifest(inputs); }
const sameSlot = (left: import("./control-state.js").RuntimeSlot | undefined, right: import("./control-state.js").RuntimeSlot): boolean => !!left && left.revision === right.revision && JSON.stringify(left.deviceRef) === JSON.stringify(right.deviceRef) && left.control.port === right.control.port && left.control.credential === right.control.credential;
async function main(): Promise<void> {
  let deviceRef: DeviceRef; try { if (process.argv.length !== 3) throw 0; deviceRef = validateDeviceRef(JSON.parse(process.argv[2]!)); } catch { finishProcess(1); return; }
  const state = new LocalRuntimeState(undefined, {}, deviceRef.platform); await state.prepare(); const slot = await state.readSlot(); if (!slot || JSON.stringify(slot.deviceRef) !== JSON.stringify(deviceRef)) { finishProcess(1); return; }
  const instanceId = randomUUID(), generation = randomUUID(), record: RuntimeGenerationState = Object.freeze({ runtimeStateVersion: 1, deviceRef: slot.deviceRef, instanceId, generation, port: slot.control.port, createdAt: Date.now(), ready: true }); let published = false, transferred = false, cancelled = false, controlBound=false,host: RuntimeControlHost | undefined, service: ReturnType<typeof createRuntimeService> | undefined;
  const cleanup = async (): Promise<void> => { await service?.close().catch(() => undefined); await state.deleteGeneration(record,controlBound).catch(() => false); await host?.close().catch(() => undefined); };
  const parent = (frame: unknown): void => { if (typeof frame !== "object" || frame === null) return; const type=(frame as ParentFrame).type;if(type==="cancel"&&!published){cancelled=true;void cleanup().finally(()=>process.exit(0));}else if(type==="ready"&&published&&!transferred){transferred=true;process.off("message",parent);process.off("disconnect",disconnect);if(process.connected)process.disconnect();} };
  const disconnect = (): void => { if (!transferred) { cancelled = true; void cleanup().finally(() => process.exit(0)); } };
  process.on("message", parent); process.once("disconnect", disconnect); send({ type: "candidate", instanceId, generation });
  try {
    host = new RuntimeControlHost({ slot, generation: record, onShutdown: async () => { await state.deleteGeneration(record,true); await host?.close(); setImmediate(() => process.exit(0)); } });
    try { await host.start();controlBound=true; } catch (cause) { if ((cause as NodeJS.ErrnoException).code === "EADDRINUSE") { send({ type: "contended" }); await cleanup(); finishProcess(0); return; } throw cause; }
    if (!sameSlot(await state.readSlot(), slot)) { send({ type: "contended" }); await cleanup(); finishProcess(0); return; }
    if (cancelled || !process.connected) { await cleanup(); return; }
    const source: CaptureSource = slot.platform === "android"
      ? new ScrcpyV501CaptureAdapter({ adbPath: slot.binding.adbPath, cacheRoot: slot.binding.cacheRoot, deviceRegistry: [{ opaqueId: slot.deviceRef.opaqueId, serial: slot.binding.serial }], artifactSource: slot.binding.artifactSource })
      : createIosWdaCaptureSource({ access: resolveSingleIosWdaBinding(), deviceRef: slot.deviceRef });
    service = createRuntimeService({ mediaProfile: slot.platform === "android" ? "h264-annexb" : "mjpeg", manifest: await manifest(), captureSource: source }); host.activate(service);
    if (cancelled || !process.connected) { await cleanup(); return; } await service.start(); if (cancelled || !process.connected || !sameSlot(await state.readSlot(), slot)) { await cleanup(); return; } await state.publishGeneration(record); if (cancelled || !process.connected || !sameSlot(await state.readSlot(), slot)) { await cleanup(); return; }
    host.ready(); published = true; send({ type: "ready", instanceId, generation });
  } catch { await cleanup(); finishProcess(1); }
}
await main();
