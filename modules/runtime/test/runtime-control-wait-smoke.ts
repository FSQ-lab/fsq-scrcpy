import { acquireRuntime } from "../src/index.js";

const safe = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
const nextTurn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

async function main(): Promise<void> {
  const acquired = await acquireRuntime({ mode: "start-or-attach", selector: { kind: "auto", platform: "android" } });
  if (!acquired.ok) { safe(acquired); process.exitCode = 1; return; }
  let session = acquired.session;
  try {
    const ensured = await session.control.ensureViewer();
    if (!ensured.ok) { safe(ensured); process.exitCode = 1; return; }
    const streamId = ensured.value.snapshot.streamId, initialRevision = ensured.value.snapshot.revision;
    const timeout = await session.control.wait({ streamId, afterRevision: initialRevision, waitMs: 0 });
    const controller = new AbortController(), cancelling = session.control.wait({ streamId, afterRevision: initialRevision, waitMs: 30_000 }, { signal: controller.signal });
    await nextTurn(); controller.abort(); const cancelled = await cancelling;
    const closing = session.control.wait({ streamId, afterRevision: initialRevision, waitMs: 30_000 });
    await nextTurn(); await session.close(); const closed = await closing;

    const reattached = await acquireRuntime({ mode: "attach-only", selector: { kind: "known", deviceRef: ensured.value.deviceRef } });
    if (!reattached.ok) { safe(reattached); process.exitCode = 1; return; }
    session = reattached.session;
    const firstChange = session.control.wait({ streamId, afterRevision: initialRevision, waitMs: 30_000 });
    const stopped = session.control.stopStream({ streamId });
    const changed = await firstChange, terminalized = await stopped;
    if (!changed.ok || !terminalized.ok) { safe(!changed.ok ? changed : terminalized); process.exitCode = 1; return; }
    const terminal = await session.control.wait({ streamId, afterRevision: changed.value.snapshot.revision, waitMs: 30_000 });
    const inspected = await session.control.inspect({ streamId, afterRevision: initialRevision });
    safe({ ok: true, attachment: reattached.session.attachment, timeout, cancelled, closed, changed, terminal, inspected, stopped: terminalized });
  } finally {
    await session.close();
  }
}

await main();
