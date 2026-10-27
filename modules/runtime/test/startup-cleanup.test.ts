import test from "node:test";
import { execFile } from "node:child_process";

// Natural child exit proves no live transport survives failed startup/close.
test("failed startup returns the typed error and the owner process exits after close", async () => {
  const runtime = new URL("../src/index.js", import.meta.url).href;
  const capture = new URL("../../capture/src/index.js", import.meta.url).href;
  const code = `
    import assert from "node:assert/strict";
    import { createRuntimeService } from ${JSON.stringify(runtime)};
    import { WdaMjpegCaptureAdapter } from ${JSON.stringify(capture)};
    const deviceRef = { contractVersion:2, platform:"ios", namespace:"fsq.ios.local", opaqueId:"123e4567-e89b-42d3-a456-426614174000" };
    const service = createRuntimeService({ mediaProfile:"mjpeg", manifest:{entries:[]}, captureSource:new WdaMjpegCaptureAdapter({ deviceRef, endpoint:"http://127.0.0.1:9/" }) });
    try {
      const result = await service.ensureStandaloneViewer({ deviceRef, idempotencyKey:"AAAAAAAAAAAAAAAAAAAAAA" });
      assert.equal(result.ok, false);
      assert.equal(result.error.code, "runtime-bind-failed");
    } finally { await service.close(); }
  `;
  await new Promise<void>((resolve, reject) => {
    execFile(process.execPath, ["--input-type=module", "-e", code], { timeout: 5000 }, error => error ? reject(error) : resolve());
  });
});
