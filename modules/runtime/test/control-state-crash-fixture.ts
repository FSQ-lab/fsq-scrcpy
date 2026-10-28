import { chmod, link, mkdir, writeFile } from "node:fs/promises";
import { LocalRuntimeState, type SlotInitializationHooks } from "../src/control-state.js";

const [root, point] = process.argv.slice(2);
const binding = Object.freeze({ serial: "PRIVATE-SERIAL", adbPath: "/usr/bin/true", cacheRoot: "/tmp/fsq-private-cache", artifactSource: Object.freeze({ mode: "online" as const }) });
if (!root || !point) process.exit(2);
await mkdir(root, { recursive: true, mode: 0o700 });
await chmod(root, 0o700);
const crash = (): never => process.exit(91);
const state = new LocalRuntimeState(root, { stage(stage) { if (!process.env.FSQ_LINK_ERROR && stage === point) crash(); } });

if (point === "slot-link-error") {
  let calls = 0;
  const hooks: SlotInitializationHooks = {
    link: async (source, destination) => {
      calls++;
      const code = process.env.FSQ_LINK_ERROR;
      if (code === "EEXIST") {
        await link(source, destination);
        throw Object.assign(new Error(code), { code });
      }
      if (code === "ENOENT" && calls === 1) throw Object.assign(new Error(code), { code });
      if (code && code !== "ENOENT") throw Object.assign(new Error(code), { code });
      await link(source, destination);
    },
  };
  try {
    await state.initialize(binding, 1_800_000_000_000, undefined, hooks);
    process.exit(0);
  } catch { process.exit(92); }
}
if (point.startsWith("replacement-")) {
  const slot = (await state.initialize(binding, 1_800_000_000_000)).slot;
  const generation = Object.freeze({ runtimeStateVersion: 1 as const, deviceRef: slot.deviceRef, instanceId: "123e4567-e89b-42d3-a456-426614174000", generation: "223e4567-e89b-42d3-a456-426614174000", port: slot.control.port, createdAt: 1_800_000_000_001, ready: true as const });
  await state.publishGeneration(generation);
  await state.replaceSlot(slot, generation, binding, slot.deviceRef, 1_800_000_000_002);
  process.exit(0);
}


const slot = (await state.initialize(binding, 1_800_000_000_000)).slot;
const value = Object.freeze({ runtimeStateVersion: 1 as const, deviceRef: slot.deviceRef, instanceId: "123e4567-e89b-42d3-a456-426614174000", generation: "223e4567-e89b-42d3-a456-426614174000", port: slot.control.port, createdAt: 1_800_000_000_001, ready: true as const });
if (point === "generation-temp-unlink") await writeFile(`${state.runtime}/.${slot.deviceRef.opaqueId}.323e4567-e89b-42d3-a456-426614174000.tmp`, "stale", { mode: 0o600 });
await state.publishGeneration(value);
process.exit(0);
