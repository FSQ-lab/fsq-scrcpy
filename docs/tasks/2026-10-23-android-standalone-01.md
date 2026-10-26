# ANDROID-STANDALONE-01 Task Package

## Authorization and fixed baseline

- **TaskID:** `ANDROID-STANDALONE-01`
- **Original authorization:** `$spec-driven` against the user-confirmed Android streaming Viewer design; the user explicitly requested complete implementation and explicitly confirmed the root plus four-module SPEC delta on 2026-10-23.
- **Repository:** `/Users/qunmi/Documents/FSQ_LAB/FSQ_scrcpy`
- **Branch / HEAD:** `main` / `unborn` (repository has no commits).
- **Initial worktree:** all repository content was untracked user work. It must not be deleted, overwritten outside named ownership, committed, pushed or published.
- **Platform combination:** local macOS arm64 host + one capability-admitted USB Android handheld + one logical stream + one standalone Chrome Viewer.
- **Feature order:** WP1 Contracts → WP2 Capture → WP3 Runtime → WP4 Viewer. No later work package starts before the preceding seam, validation and independent review pass.

Fixed sources (SHA-256 after explicit SPEC confirmation):

| Source | SHA-256 |
| --- | --- |
| `AGENTS.md` | `3e491e53c98c832810ac2b34b2086613643a41d77e3161e2351110593e511335` |
| `SPEC.md` | `3fe5b2511c65092b69d15473b1f34f0ccc96172144194970bb28744565460ae8` |
| `modules/contracts/SPEC.md` | `b89e68ee9ece83e0e668c8f34c345104025d31daad40cfbd382fb4055df61fbb` |
| `modules/capture/SPEC.md` | `9a5f211cf4be505b9e7e8173496c143526734892831609cf656853f123412dda` |
| `modules/runtime/SPEC.md` | `510b0573bcc0aa18f987b439a34061a6838604338899ccec40a3f0c870ffa66a` |
| `modules/viewer/SPEC.md` | `14119311b8a9386acdad98ebd28e86c9d79cab11e02e02a17821006466e921f4` |
| Confirmed design | `e47a875c1d56797b5334d25375e1283863e994e097a31152e9d39ebee49d72f2` |
| Dependency selection | `c5cfc3626e755b9e4c9d491b94620dc4d0ed1fa5cccc9103c34b039c63200718` |

The independent SPEC gate read the complete six-file delta and passed with all `SGR-01..10` closed. Any public-interface or behavior change stops the affected work package and returns to a user-confirmed SPEC delta.

## Selection and toolchain record

- Node.js `24.22.1` and npm `11.19.1`, invoked with `PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`.
- Production: exact `ws@8.22.0` and `openpgp@6.3.2` only. Development: the six exact packages in the approved selection.
- Per the user's company-network instruction, npm follows the machine registry `https://packagefeedproxy.microsoft.io/npm/`; the project does not override it or require the public registry. The lock resolves to the mirror's `ms-feed-25.pkgs.visualstudio.com/1es-public` backing feed.
- `package.json` SHA-256: `8fc5dcac0774bea4e0ca7f82f8bfe4c0efabee263cd9ccf963bef8cfe2e48a10`; `package-lock.json`: `4c831ae51514c4eb2da524e2c51bbbfff969aaf3a76f9c1441d5ad2c6bb29705`; `.npmrc`: `b064fdec6289515f012b8950927d91235deaadbff3742707d134d177ba256500`; `tsconfig.base.json`: `dc6648797b9bafa32e84748bd2aac67958361ed8852919e0e56f962c5a796ad5`.
- Clean development and production-only installs contain exactly the approved eight and two packages respectively. Omitted peers are absent; licenses match; TypeScript is `7.0.2`; esbuild is `0.28.2`; its binary SHA-256 is `10b6243df618d374bb2d5c9cfbe7052e1405f6aa4e53a6164f11a91b9f2e1384`.
- The mirror emits SHA-1 lock SRI for 50 entries and SHA-512 for two. Each of the eight packages actually installed has separately fixed mirror-returned SHA-512 integrity and SHA-256 tarball evidence. A fresh-cache generation reproduced the same lock.
- The configured-mirror `npm audit --omit=dev --json` exited 0 with zero vulnerabilities. The public-registry override failed `ENOTCONN` and is not required. Mapped OSV request/response evidence independently returned HTTP 200 and an empty result for every exact selected coordinate.
- Fixed raw evidence: dependency command capture `/tmp/fsq_scrcpy_dependency_evidence.json`, SHA-256 `ae751e42ada2bf8ca798633dab19d58857d280547f379ab135a65f3854fd8ae1`, 14,207 bytes; mapped OSV evidence `/tmp/fsq_scrcpy_osv_evidence.json`, SHA-256 `b0f299389e288bb369516d3fa8becdca8a484d0d5bb82a33fd1bd09c2bce0e0b`, 2,409 bytes; executable raw license/peer/npm-pack/checksum/fresh-lock probe capture `/tmp/fsq_dependency_raw_probe_capture.json`, SHA-256 `7ae83c62d4646811f71b50e69681ef828e9124f7eb9218deb3b2672e30c5a9d5`, 118,121 bytes, whose fixed script `/tmp/fsq_dependency_raw_probe.py` exits 0 and records every argv/cwd/exit/stdout/stderr plus an identical reproduced lock hash.
- OpenPGP LGPL materials, scrcpy Apache-2.0 attribution/source metadata and separate H.264 commercial legal review remain mandatory gates. This feature makes no commercial support claim and adds no codec implementation.

## Feature contract

Start local Runtime → obtain a non-secret pairing page → owner approves exactly one Viewer → visible authenticated Viewer lazily starts one real USB Android Capture → protected standalone Chrome paints fresh read-only video and enters `Live` → hidden/disconnected Viewer stops renewing → five-second grace expires → Capture and every owned resource stop.

Acceptance requires real device and actual browser evidence: device/OS/security patch/encoder, Chrome/macOS versions, ≥720 short edge without crop/stretch/upscale, six 10-second windows each with ≥270 new source frames, presented-frame interval p95 ≤67 ms, first fresh `Live` ≤5 seconds after authorization, rotation resynchronization, truthful non-Live states, five-minute memory/queue bounds, failure/cleanup matrix and no frame persistence/model/MCP transport. Glass-to-glass capture is deferred non-blocking research; this feature makes no end-to-end latency bound or support claim.

Non-goals: MCP App, external launch/attach, multiple Viewers, automatic same-StreamId Capture recovery, audio, control, recording, remote/cloud access, iOS/macOS Capture and support-matrix claims.

Cumulative budgets do not reset: product ≤2690 changed lines, tests ≤3170, docs ≤350. Per-WP maxima are WP1 240/220/50; WP2 total 750/900/100 split 220/260/40, 280/300/30, 250/340/30; WP3 total 900/1100/100 split 320/400/35, 360/450/35, 220/250/30; and WP4 total 800/950/100 split WP4a 320/400/30, WP4b 300/350/35, WP4c 180/200/35. The user explicitly approved these exceptions to the approximate 1200-product-line target because standalone live-view lease remains one inseparable behavior feature; every internal package is serially owned/reviewed and not independently shippable. Baselines/accounting exclusions remain unchanged. Exceeding any subpackage/WP/cumulative maximum stops work for re-splitting or a user-confirmed change.





## WP1 — Contracts

- **Owner:** one `streaming-engineer`; no concurrent product writer.
- **Allowed:** root TypeScript/build configuration; `modules/contracts/src/**`; `modules/contracts/test/**`; package scripts needed to compile/test the owned seam.
- **Forbidden:** Capture, Runtime, Viewer product code; third-party objects in exported types; launch/attach/MCP fields.
- **Goal:** implement only the confirmed immutable values, validation, phases, errors, snapshots, envelope constants and encode/decode/version rules.
- **Acceptance:** exact boundary/round-trip/malformed fixtures for every public value and 40-byte envelope; exported values contain no secret or Runtime-library type. Under `PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`, `npm run verify:contracts` must exit 0; it is frozen as strict `tsc --noEmit`, a real build, and `node --test .build/contracts/test/*.test.js`. The WP1 owner creates `modules/contracts/tsconfig.json`, sources and owned tests against the fixed root scripts/config; a missing test/build target is failure.
- **Stop:** any ambiguity in serialization, error disposition, sequence, sizes or secret boundary.
- **Accepted evidence:** independent full review plus two repair-only rounds closed `WP1-01..05`; `npm run verify:contracts` builds emitted JS and passes 9/9 tests. Final owned hashes: source `012c012abad09e0e0de7aae21a4441bd919d98651383190f0f57758eb2717a93`, tests `79836cb8b4736ae5d74069ed5c5bfd7af2a03879694506939410eba55eef7710` and `a278becea4f0b1a3bce0340c8b97f4975052975dbcbdf3c68164bd749e103257`, tsconfig `9d1d9876726668af1f604b75db52f269ca728be0d6d1b787add265cbe77f0e49`. Counts are product 157, tests 211, support 11, docs 0. This accepts only the WP1 seam; the feature remains Not Done.

## WP2 — Capture

- **Owner:** one `streaming-engineer`, only after WP1 review passes.
- **Allowed:** only the exact WP2a/WP2b/WP2c paths and package scripts listed below; each file has one serial owner.
- **Forbidden:** Runtime transport/auth, Viewer, external Adapter, forked/full scrcpy client or raw-stream fallback.
- **Goal:** implement the confirmed pull session over pinned verified `scrcpy-server v5.0.1`, capability-tested user ADB, bounded packet normalization, epoch/config/key/frame order and idempotent cleanup.
- **Acceptance:** signature/checksum/cache positive and negative fixtures; real USB device produces normalized events and rotation epoch; wrong version, bad CSD/order/size, timeout, cancellation, SIGTERM and owned-resource cleanup paths pass. Device-disconnect classification has deterministic fixtures; physical unplug remains the separately reported manual real-device gate. Cache metadata and third-party materials satisfy the selected Apache/OpenPGP boundaries.
- **Fixed validation:** under `PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`, `npm run verify:capture` must exit 0 for strict typecheck/build/owned tests, then `npm run smoke:capture` must exercise the named real device and exit 0. Current evidence device is USB Pixel 6 `1C171FDF6002TU`; ADB is `/opt/homebrew/bin/adb` version `37.0.1-15733141`. The owner must record exact OS/build/security patch/encoder, actual event order and cleanup; no support claim follows from one device.
- **Stop:** server identity mismatch, unsupported protocol/codec/profile, unbounded queue/read, unavailable real device or any need to expose scrcpy details.

### WP2 ownership and smoke inputs

- WP2a alone owns `modules/capture/src/artifact/**`, matching `modules/capture/test/artifact*.test.ts`, `modules/capture/THIRD_PARTY_NOTICES.txt` and `modules/capture/tsconfig.artifact.json`. WP2b alone owns `modules/capture/src/adb/**`, `modules/capture/src/scrcpy/transport.ts`, matching `adb*.test.ts`/`transport*.test.ts` and `modules/capture/tsconfig.transport.json`. WP2c alone owns `modules/capture/src/index.ts`, `modules/capture/src/scrcpy/parser.ts`, `modules/capture/src/session.ts`, remaining `modules/capture/test/{parser,session}*.test.ts`, `real-device-smoke.ts` and `modules/capture/tsconfig.json`. No other setup/acquisition path is allowed.
- Under the fixed Node PATH, WP2a must pass `npm run verify:capture:artifact`; WP2b must pass `npm run verify:capture:transport`; WP2c must pass `npm run verify:capture` and then the real `npm run smoke:capture`. Each command builds emitted JS and runs only its owned tests; its exact raw output and full diff are independently reviewed before the next subpackage.
- WP2a cache tests must enforce the confirmed trusted-root policy, stable symlink/non-regular/tamper/error mapping, push-time rehash and generic path-free errors. Malicious same-uid filesystem interference/races are explicitly outside v1 and must not be claimed as covered; adding them requires a native-helper selection gate.
- `smoke:capture` has a 60-second hard deadline and requires explicit `FSQ_ADB`, `FSQ_ANDROID_SERIAL`, canonical `FSQ_DEVICE_ALIAS`, private `FSQ_CAPTURE_CACHE_DIR`, and all four offline paths `FSQ_SCRCPY_KEY_FILE`, `FSQ_SCRCPY_CHECKSUM_FILE`, `FSQ_SCRCPY_SIGNATURE_FILE`, `FSQ_SCRCPY_SERVER_FILE`. Missing, mixed, symlinked or mismatched inputs fail before device writes.
- For the authorized Pixel smoke only, the user explicitly permits the script to save all relevant state, launch the system Settings Activity, temporarily set and finally restore `accelerometer_rotation`, `user_rotation`, `wm user-rotation` and `wm set-ignore-orientation-request`, then return HOME and verify NexusLauncher focus. Stable bounded polling must prove every policy/setting and foreground restoration; any mismatch fails. It does not force-stop an app or alter global ADB, app data, account state or any other device setting. Physical unplug remains a separately reported manual real-device gate.
- Stdout is exactly one JSON evidence object: ADB path/version, serial-safe device model/OS/build/security patch/encoder, artifact identity, ordered event kinds/epoch/sequence/PTS/config/key, rotation restoration, and every cleanup-ledger action/result. Logs use stderr and never include the internal serial in ordinary public events/errors. Any resource residue, missing config/key/rotation or input mismatch exits nonzero.

## WP3 — Runtime

- **Owner:** one `streaming-engineer`, only after WP2 review passes.
- **Allowed:** `modules/runtime/src/**`, `modules/runtime/test/**`, package scripts for local Runtime.
- **Forbidden:** external launch/attach, MCP, second Viewer, remote bind or automatic Capture restart.
- **Goal:** implement the confirmed in-process service, loopback pairing/capability, Host/Origin policy, visible lease, single Viewer, binary WebSocket, credit/ACK/GAP, bounded lanes and exactly-one-END termination.
- **Acceptance:** auth and secret-leak probes; wrong Host/Origin/replay/expiry/second Viewer; backpressure deadlines; pending-send accounting; stale/future ACK; lease/grace; terminal ordering; child-process cancellation and process-group cleanup; real Capture integration.
- **Fixed validation:** under `PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin`, `npm run verify:runtime` must strict-typecheck, build emitted JS and pass only Runtime-owned tests; `npm run smoke:runtime` must use the same explicit Pixel/ADB/cache/four offline artifact inputs as Capture, bind only `127.0.0.1` on an ephemeral port, complete owner approval plus authenticated visible demand through a Node WebSocket client, receive session/config/key, exercise credit/ACK/lease/leave, then prove exactly one END, Capture stop and all cleanup. Stdout is one serial-free JSON evidence object; any secret, queue or resource residue fails.
- **Stop:** remote exposure, reusable secret disclosure, hidden queue growth or public seam change.

### WP3 ownership and smoke contract

- WP3a alone owns shared `modules/runtime/src/{types,strict-json,clock,state,auth,http}.ts`, shared test support `modules/runtime/test/support/runtime-fixtures.ts`, matching `modules/runtime/test/{state,auth,http,strict-json}*.test.ts` and `modules/runtime/tsconfig.lifecycle.json`; it must pass `npm run verify:runtime:lifecycle`. `types.ts` owns RuntimeResult/request types and ViewerAssetManifest, `strict-json.ts` the one HTTP/WS parser, and `clock.ts` the clock/mutex/timer hooks. These are read-only to later subpackages; any required change stops back at WP3a review. WP3b alone owns `modules/runtime/src/{media,viewer,ws}.ts` including WsAdapter, matching `modules/runtime/test/{media,viewer,ws}*.test.ts` and `modules/runtime/tsconfig.media.json`; it must pass `npm run verify:runtime:media`. WP3c alone owns composition `modules/runtime/src/index.ts`, `modules/runtime/test/integration*.test.ts`, `real-runtime-smoke.ts` and `modules/runtime/tsconfig.json`; it must pass `npm run verify:runtime` then `npm run smoke:runtime`. No other Runtime product/test path is allowed.
- `smoke:runtime` has a 90-second monotonic hard deadline with 15 seconds reserved for terminalization/device restoration/cleanup. It requires the same explicit ADB, canonical alias, trusted cache and four offline artifact paths as final Capture smoke. It starts Runtime on `127.0.0.1:0`, uses only the exact public GET/pairing/redeem/session/refresh routes and in-process `approvePairing`, and drives a Node WebSocket with exact Host, Origin, cookie and `fsq-viewer.v1`.
- The smoke sequence is pairing start → owner approve → redeem → session cookie → WebSocket hello → visible lease with credit → real session/config/key → ACK → refresh → leave/stop. It also runs safe negative probes for wrong Host/Origin/subprotocol, replay, second Viewer and secret redaction before real Capture allocation where applicable.
- Stdout is exactly one serial- and secret-free JSON object containing HTTP status sequence, snapshot revisions/phases, pairing/replay/redaction booleans, envelope kinds/sequences/epochs without media bytes, credit/ACK/GAP counters, application/pending/buffered peak bytes, unique END/close result, Capture/Runtime cleanup ledger and device-policy restoration. Stderr may contain only fixed safe diagnostics. Any bearer/code/cookie, queue excess, media after END or resource residue fails.

## WP4 — Viewer and cumulative closure

- **Owner:** one `agent-integration-engineer`, only after WP3 review passes.
- **Allowed:** `modules/viewer/src/**`, `modules/viewer/test/**`, Viewer build script and generated distributable assets required by Runtime.
- **Forbidden:** framework/CDN/blob/data/eval, device control, MCP presentation, second media pipeline or frame persistence.
- **Goal:** implement the protected standalone page, Worker parser/decoder, Canvas rendering, state overlay, visibility lease and ownership-safe ACK.
- **Acceptance:** strict CSP; capability rejection; malformed protocol/media closure; config+IDR and epoch reset; every `VideoFrame` closed; actual Chrome reaches `Live`; final close drives five-second Capture cleanup; all feature performance and failure evidence passes.
- **Fixed ownership/validation:** WP4 alone owns `modules/viewer/src/{app,worker,protocol,state,assets}.ts`, `style.css`, `modules/viewer/test/**`, `modules/viewer/build.mjs`, `modules/viewer/tsconfig.json` and generated `modules/viewer/dist/**`; no Runtime/Capture/Contracts source change is allowed. Under the fixed Node PATH, `npm run verify:viewer` must strict-typecheck, produce content-addressed entry-module/worker-module/style assets plus exact manifest, build emitted tests and pass them. Main then starts the real integrated Runtime/Capture/Viewer server with the accepted Pixel/material inputs through `hub`, drives standalone Chrome through the browser tool, performs the public pairing/owner-approval flow, and observes Connecting→Syncing→Live, rotation resync, hidden/grace return and final close cleanup on the actual surface.
- Browser evidence must record exact Chrome/macOS/device/encoder, capability probe and codec string, first-Live time, six 10-second displayed-source-frame windows, presented interval p95, five-minute queue/memory observation, every non-Live overlay and resource cleanup. CSP/network/console violations, any unclosed VideoFrame, missing/duplicate config, stale Live, persisted frame/secret, target miss or resource residue fails. Glass-to-glass capture is optional non-blocking research and is not used for a latency or support claim.

### WP4 exact ownership

- WP4a alone owns `modules/viewer/src/{protocol,worker,assets}.ts`, matching tests, `build.mjs`, `tsconfig.protocol.json` and its protocol-only generated `dist/worker.js`; `verify:viewer:protocol` needs no WP4b file. WP4b alone owns `src/{app,state}.ts`, `style.css`, matching app/state/render tests, `tsconfig.app.json` and the complete generated `dist/{entry.js,worker.js,style.css}` during its deterministic full build; `verify:viewer:app` freezes those outputs. WP4c alone owns `test/{integration,real-viewer-server}*.ts`, final `tsconfig.json` and may only reproduce/verify—not alter—the accepted full dist. It passes `verify:viewer`. Shared WP4a sources and accepted WP4b dist are read-only to later stages; any change returns to the owning review.
- Main owns external browser automation and evidence; product/subagents do not patch or bypass it. The executable route is mounted Main device `xd://browser` launching `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome` with `--headless=new --no-first-run --disable-background-timer-throttling --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-features=CalculateNativeWinOcclusion`. A real open/run/close probe observed `Chrome/155.0.8059.85`. On 2026-10-26 the user explicitly approved removing the previously fixed `--disable-gpu`: real Chrome with that flag reported `configSupported=0` and could not reach `Live`, while the GPU-enabled route reported `configSupported=1` and painted real H.264. Actual browser validation uses the public pairing flow; if unavailable then WP4c is `audit-blocked`, with no manual/subagent fallback. Server is a shared long-running `hub` process. Synchronized glass-to-glass capture is optional non-blocking research; the separately user-operated physical-unplug gate passed and is recorded in the fixed evidence.
- **Stop:** browser cannot satisfy capability/CSP, real media fails, a confirmed startup/frame target fails or any retained frame/secret is observed.

## Validation and review protocol

Use only the fixed Node 24 PATH. WP1's exact command is `PATH=/opt/homebrew/opt/node@24/bin:/usr/bin:/bin npm run verify:contracts`; later packages must freeze their equally specific scripts before their own delegation. Each package also runs its named real seam scenario, then freezes full raw command output, manifest and diff for a new independent read-only `quality-engineer`. The implementation owner returns only `pending-review`; Tech Lead alone records package acceptance. After WP4, run one cumulative real Viewer closure and one independent full feature review. No commit, push, publish or support-matrix update is authorized.

## Current decision owners and blockers

- Tech Lead: package ownership, integration, budgets and Done decision.
- User: any SPEC/scope/dependency change and unavailable-device policy.
- Legal owner/user: on 2026-10-26 the user explicitly confirmed both the OpenPGP `openpgp@6.3.2` LGPL-3.0+ compliance disposition and the H.264 target commercial/distribution-use disposition as approved.
- WP1, complete WP2, complete WP3 and complete WP4 implementation are independently accepted. After the independent full cumulative audit and two repair-only rounds, findings `AF-01..03` are closed; final Capture verification passes 60/60 (`artifact://1659`), final Runtime verification passes 84/84 (`artifact://1629`) and final Viewer verification passes 72/72 (`artifact://1611`). WP4 remains within product/tests/docs counts 161/150/0. Final key Viewer hashes are app `fd257a305733de8504426b7e45195e3dcfe390838da42bcff7d57ed973b1e5bd`, protocol `251dfc7a1578598e7cc56cd10b9dc31724092f9f27c8d21fcc5bfc39db13ff5b`, worker `2b46ac4c7d22028a73298e17b4a1b4a62110235768c886e366175e5a1ed755f2`, real integration `6d0b2c3fc8edd2078287b5e6f459c3011107c719b6f7c19b52445f8063c7388c`, real server `3644c8bd3c0e73179031160b55c3869735a67d921a0a495314135ec333ea2cb4`, generated entry `a314908d888720fb31c703fe5e9babf85c71fd9e17d35d564c4bff26d3e70dd6`, worker `9cb51509c92c51f52ff58f6619b01c9aaf57e69255f7f7699182ef69e0ecd8b1` and style `31cd45066c1db257a2023bac3263f5f63b6a6396f2523c035843f84ba60568b0`.
- Automated real Pixel/Chrome closure passes: `Live` in 590 ms; actual codec `avc1.640033`; 1080×2400 portrait and 2400×1080 landscape fresh-paint resync; source-frame windows 293/299/300/301/299/301; presented windows 293/299/300/300/300/301; presented interval p95 50.70 ms; metrics complete/valid with zero overflow/invalid samples; five-minute endpoint remained `Live` with queue 0, one owned frame and heap falling from 3,272,467 to 1,937,999 bytes; final browser close published stopped/lease-expired revision 19 and the fixture exited 0. CSP was deny-by-default with exact loopback WS origin, no console/page errors occurred and no frame, screenshot, payload, serial or secret was persisted. Post-audit fragmented-message revalidation reached `Live` in 727 ms with codec `avc1.640033` and cleaned up at revision 10. The physical USB unplug rerun passes after independently reviewed `REAL-UNPLUG-01/02`: Viewer became `Disconnected`, Runtime published `device-disconnected` revision 9 with no active Viewer, service exited 0, and post-reconnect Runtime smoke `artifact://1671` proved no reverse/remote-artifact residue plus restored rotation/foreground. Fixed sanitized evidence, including legal approvals and the confirmed no-glass-latency-claim scope, is `/tmp/fsq_wp4_real_browser_evidence.json`, SHA-256 `1d38b563bf8d162e2bb205fe03f9f07183d9a79b69dd1d8dcf17f68abd611095`, 6,888 bytes.
- `ANDROID-STANDALONE-01` is **Done**. Physical unplug, legal dispositions, implementation verification, real-device/browser closure and independent cumulative audit are closed. Glass-to-glass capture is deferred non-blocking research; this feature makes no glass-to-glass latency bound or support claim. No support-matrix claim is made; naming a supported combination requires a later SPEC delta.
