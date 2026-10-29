import { acquireRuntime } from "../src/index.js";

const safe = (value: unknown): void => { process.stdout.write(`${JSON.stringify(value)}\n`); };
async function main(): Promise<void> {
  if (process.argv.length !== 2) { safe({ ok: false, error: { code: "malformed-control" } }); process.exitCode = 1; return; }
  const acquired = await acquireRuntime({ mode: "start-or-attach", selector: { kind: "auto", platform: "android" } });
  if (!acquired.ok) { safe({ ok: false, error: acquired.error }); process.exitCode = 1; return; }
  try {
    const ensured = await acquired.session.control.ensureViewer();
    if (!ensured.ok) { safe({ ok: false, attachment: acquired.session.attachment, error: ensured.error }); process.exitCode = 1; return; }
    safe({ ok: true, attachment: acquired.session.attachment, deviceRef: ensured.value.deviceRef, descriptor: ensured.value.descriptor, snapshot: ensured.value.snapshot });
  } finally { await acquired.session.close(); }
}
await main();
