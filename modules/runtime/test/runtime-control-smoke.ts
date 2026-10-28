import { acquireRuntime } from "../src/index.js";
import { LocalRuntimeState } from "../src/control-state.js";
import { OwnerHttpControl } from "../src/control.js";

const safe = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
async function main(): Promise<void> {
  const pairingCode = process.argv[2];
  if (process.argv.length > 3 || (pairingCode !== undefined && !/^[0-9A-HJKMNP-TV-Z]{8}$/.test(pairingCode))) { safe({ ok: false, error: { code: "malformed-control" } }); process.exitCode = 1; return; }
  const acquired = await acquireRuntime({ mode: "start-or-attach", selector: { kind: "auto", platform: "android" } });
  if (!acquired.ok) { safe({ ok: false, error: acquired.error }); process.exitCode = 1; return; }
  try {
    const ensured = await acquired.session.control.ensureViewer();
    if (!ensured.ok) { safe({ ok: false, attachment: acquired.session.attachment, error: ensured.error }); process.exitCode = 1; return; }
    if (pairingCode !== undefined) {
      const target={ instanceId: acquired.session.attachment.instance.instanceId, generation: acquired.session.attachment.instance.generation },state=new LocalRuntimeState();await state.prepare();const slot=await state.readSlot(),generation=slot&&await state.readGeneration(slot);
      if (!slot||!generation||generation.instanceId!==target.instanceId||generation.generation!==target.generation) { safe({ ok: false, attachment: acquired.session.attachment, error: {code:"instance-conflict"} }); process.exitCode = 1; return; }
      const owner = new OwnerHttpControl(slot.control.port,target,slot.control.credential);
      try { const approved = await owner.approveViewerPairing({ streamId: ensured.value.snapshot.streamId, pairingCode }); safe(approved.ok ? { ok: true, attachment: acquired.session.attachment, deviceRef: ensured.value.deviceRef, descriptor: ensured.value.descriptor, snapshot: approved.value.snapshot, approvedAt: approved.value.approvedAt } : { ok: false, attachment: acquired.session.attachment, error: approved.error }); if (!approved.ok) process.exitCode = 1; }
      finally { await owner.close(); }
      return;
    }
    safe({ ok: true, attachment: acquired.session.attachment, deviceRef: ensured.value.deviceRef, descriptor: ensured.value.descriptor, snapshot: ensured.value.snapshot });
  } finally { await acquired.session.close(); }
}
await main();
