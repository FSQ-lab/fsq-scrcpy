import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, realpath, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { LocalRuntimeState } from "../src/control-state.js";

const fixture = fileURLToPath(new URL("./control-state-crash-fixture.js", import.meta.url));
const binding = Object.freeze({ serial: "PRIVATE-SERIAL", adbPath: "/usr/bin/true", cacheRoot: "/tmp/fsq-private-cache", artifactSource: Object.freeze({ mode: "online" as const }) });

async function root(): Promise<Readonly<{ parent: string; path: string }>> {
  const made = await mkdtemp(join(tmpdir(), "fsq-crash-")), parent = await realpath(made);
  await chmod(parent, 0o700);
  return { parent, path: join(parent, "state") };
}

function child(path: string, point: string, code?: string): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const process = spawn(globalThis.process.execPath, [fixture, path, point], { stdio: "ignore", env: { ...(code ? { FSQ_LINK_ERROR: code } : {}) } });
    process.once("error", reject);
    process.once("exit", resolve);
  });
}

await test("actual process crashes recover every slot filesystem stage", async () => {
  for (const point of ["slot-temp-write", "slot-file-sync", "slot-file-close", "slot-link", "slot-directory-sync", "slot-temp-unlink"]) {
    const value = await root();
    try {
      assert.equal(await child(value.path, point), 91);
      const state = new LocalRuntimeState(value.path), recovered = (await state.initialize(binding, 1_800_000_000_000)).slot;
      assert.ok(recovered);
      assert.deepEqual(await readdir(state.devices), ["android-only.json"]);
    } finally { await rm(value.parent, { recursive: true, force: true }); }
  }
});

await test("actual process crashes recover every generation filesystem stage", async () => {
  for (const point of ["generation-temp-write", "generation-file-sync", "generation-file-close", "generation-rename", "generation-directory-sync", "generation-temp-unlink"]) {
    const value = await root();
    try {
      assert.equal(await child(value.path, point), 91);
      const state = new LocalRuntimeState(value.path);
      await state.prepare();
      const slot = (await state.readSlot())!, recovered = await state.readGeneration(slot);
      if (["generation-rename", "generation-directory-sync", "generation-temp-unlink"].includes(point)) {
        assert.equal(recovered?.instanceId, "123e4567-e89b-42d3-a456-426614174000");
        assert.equal(recovered?.generation, "223e4567-e89b-42d3-a456-426614174000");
      } else assert.equal(recovered, undefined);
      for (let index = 0; index < 3; index++) await writeFile(join(state.runtime, `.${slot.deviceRef.opaqueId}.${randomUUID()}.tmp`), "secret", { mode: 0o600 });
      await state.publishGeneration(Object.freeze({ runtimeStateVersion: 1 as const, deviceRef: slot.deviceRef, instanceId: randomUUID(), generation: randomUUID(), port: slot.control.port, createdAt: 1_800_000_000_002, ready: true as const }));
      assert.deepEqual(await readdir(state.runtime), [`${slot.deviceRef.opaqueId}.json`]);
    } finally { await rm(value.parent, { recursive: true, force: true }); }
  }
});

await test("actual link faults recover EEXIST ENOENT EXDEV EPERM EOPNOTSUPP and stale secrets", async () => {
  for (const code of ["EEXIST", "ENOENT", "EXDEV", "EPERM", "EOPNOTSUPP"]) {
    const value = await root();
    try {
      const status = await child(value.path, "slot-link-error", code), state = new LocalRuntimeState(value.path);
      await state.prepare();
      if (code === "EEXIST" || code === "ENOENT") assert.equal(status, 0); else assert.equal(status, 92);
      for (let index = 0; index < 3; index++) await writeFile(join(state.devices, `.android-only.${randomUUID()}.tmp`), "secret", { mode: 0o600 });
      const slot = (await state.initialize(binding, 1_800_000_000_000)).slot;
      assert.ok(slot);
      assert.deepEqual(await readdir(state.devices), ["android-only.json"]);
    } finally { await rm(value.parent, { recursive: true, force: true }); }
  }
});

await test("actual process crashes reconcile every replacement write sync close CAS and rename stage", async () => {
  const points = [
    "replacement-generation-delete",
    "replacement-temp-write",
    "replacement-file-sync",
    "replacement-file-close",
    "replacement-cas",
    "replacement-rename",
    "replacement-directory-sync",
  ];
  for (const point of points) {
    const value = await root();
    try {
      assert.equal(await child(value.path, point), 91);
      const state = new LocalRuntimeState(value.path);
      assert.equal(await state.openExisting(), true);
      const visible = (await state.readSlot())!;
      assert.equal(visible.revision, point === "replacement-rename" || point === "replacement-directory-sync" ? 2 : 1);
      const next = await state.replaceSlot(visible, undefined, binding, visible.deviceRef, 1_800_000_000_003);
      assert.equal(next.slot.revision, visible.revision + 1);
      assert.equal(await state.readGeneration(next.slot), undefined);
      assert.deepEqual(await readdir(state.devices), ["android-only.json"]);
    } finally { await rm(value.parent, { recursive: true, force: true }); }
  }
});
