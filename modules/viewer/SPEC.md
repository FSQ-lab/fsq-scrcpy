# Module: Viewer

## Purpose

维护用户观看实时设备画面的 Web 界面，以及同一 Viewer 在独立浏览器和支持 MCP Apps 的 Coding Agent 中的呈现。

## Dependencies

Viewer 可依赖 Runtime 和 Contracts，不依赖 Capture 内部实现或 `Appium_connect_agent` 内部模块。

## Public Interface

当前 v1 是下方定义的受保护 standalone Chrome Viewer；MCP App presentation 和其他宿主嵌入需要后续 SPEC delta。当前接口支持：

- 受保护的 standalone Viewer access。
- `bootstrap`、连接、同步、Live、暂停、中断、断连、停止、不支持和错误状态。
- 页面可见性租约，驱动 Runtime 惰性采集生命周期。
- capability-based 浏览器拒绝和明确错误展示。

## Non-Responsibilities

- 首批 Viewer 不发送点击、拖动、按键或其他设备控制。
- 不向模型持续传递视频帧。
- 不拥有 Appium Session、设备发现或采集实现。

## Current Invariants

- 首批最低验收目标为 720p 和 30 FPS；当前 Viewer interface 不包含端到端显示延迟目标或支持声明。
- 后续 presentation surface 必须复用同一 standalone media pipeline，不能维护第二套视频管线。
- 默认不上传、录制或持久化设备画面。
- 支持声明只能基于真实浏览器和真实目标 Agent 验证。

## Standalone Viewer Contract v1

- First acceptance surface is standalone Chrome on macOS. Compatibility is capability-based: H.264 Annex B WebCodecs, Web Worker, binary WebSocket and Canvas. Exact browser/OS versions are validation evidence.
- Viewer uses the protected standalone pairing flow and never receives a reusable bearer in query strings, ordinary/model output, error messages, persisted history, logs, process arguments or telemetry. Standalone responses set `frame-ancestors 'none'` and a deny-by-default CSP: `default-src 'none'; script-src 'self'; style-src 'self'; worker-src 'self'; connect-src 'self' <exact-runtime-ws-origin>; img-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'`. Wildcards, remote CDN, broad schemes, blob/data image sources and inline eval are forbidden; video is rendered directly from `VideoFrame` to Canvas.
- States are `bootstrap`, `connecting`, `syncing`, `live`, `paused`, `interrupted`, `disconnected`, `stopped`, `unsupported`, `error`. A cached frame is always overlaid non-Live. In v1, `interrupted` is classification only and resolves to terminal `disconnected` or `error`; it does not automatically reconnect Capture.
- H.264 uses no `VideoDecoderConfig.description`. Each epoch has exactly one config, at most 256 KiB. Viewer derives exact `avc1.PPCCLL` from same-epoch SPS, verifies support, retains that config, and concatenates config + IDR into one key `EncodedVideoChunk` at most 8 MiB. Replacement config in one epoch, wrong epoch/order or pre-allocation combined-size overflow is rejected as `malformed-media`.
- New epoch clears old config, decode queue and output frames, resets/reconfigures the decoder and waits for config + key. Every `VideoFrame` is explicitly closed.
- Decoder queue is at most 4. Viewer retains at most one pending render frame. It sends cumulative `ack.sequence` only after every covered frame has left decode/render ownership and its `VideoFrame` is closed. On `gap`, it releases all ownership through `discardThroughSequence`, resets synchronization and treats ACK at or below that watermark/previous highest ACK as an idempotent no-op; an ACK above Runtime's highest sent frame closes the Viewer as `malformed-control`.
- Only visible authenticated pages renew demand. Hidden/pagehide/disconnect becomes non-Live and stops renewal. Return within 5-second grace enters `syncing`; a fresh painted frame is required before `live`.
- Authorized connection to first fresh painted `live` frame is at most 5 seconds.
- Active decoded image is portrait at least 720×1280 or landscape at least 1280×720, preserving aspect ratio without crop/stretch/upscaling.
- Steady-state target is 30 FPS: 60-second total at least 1,740 new source frames, each 10-second window at least 270, and presented-frame interval p95 at most 67 ms.
- Current standalone Viewer v1 has no glass-to-glass latency bound or support claim. Synchronized external/high-speed measurement is deferred non-blocking research; adopting a bound later requires a new SPEC delta and real evidence.
- Current v1 allows one active Viewer only. Viewer sends no device control and frames are never persisted, uploaded, placed in telemetry, MCP results or model context.
- MCP App presentation and multiple Viewers are not part of current v1; adding either requires a new SPEC delta and cannot alter the standalone media pipeline.

## WP3 GAP Replay Rule

- Outside recovery, a second config in one epoch remains terminal `malformed-media`. A valid GAP is the sole exception: Viewer first releases ownership through the envelope watermark, resets decoder/synchronization and marks current-epoch session/config absent; it then accepts exactly one replayed retained session and one replayed identical config followed by the next key. Missing, changed or duplicate replay config is terminal. This exception does not create a new Capture epoch and cannot be triggered without an authenticated Runtime GAP.

## WP4 Exact Viewer Contract

### Content-addressed build and bootstrap

- `build.mjs` uses exact approved esbuild to produce one ESM document entry named `entry.js`, one ESM Worker named `worker.js` and one stylesheet named `style.css`, with no splitting, dynamic remote import, inline source, eval, CDN or runtime-generated code. Content address is the Runtime URL hash segment, not the basename; bytes/hash/MIME/role feed the confirmed manifest. A repeated clean build is byte-identical; generated source maps and unlisted files fail the build.
- Entry derives StreamId only from exact `/viewer/<canonical-uuid>` pathname. It uses same-origin `credentials:"same-origin"`, exact JSON content type/bodies and no referrer to call pairing start, renders the returned eight-character code/expiry, and retries redeem every 500 ms only while 409 and before expiry. 401/404/expiry becomes `error`; network failure is bounded to three one-second retries only before owner approval, then explicit user retry creates a new pairing. Bootstrap grant exists in one local variable, is immediately consumed by session POST, then cleared; it never enters DOM, URL, storage, console or error text.
- After session 204, entry starts the Worker from the manifest's exact content-addressed worker URL and supplies only `origin` plus StreamId. Worker derives WebSocket URL exactly as `ws://<same 127.0.0.1 authority>/v1/stream`; arbitrary wsUrl, alternate authority/path/query/fragment are impossible. Cookie is browser-managed and never read by JavaScript. All fetch non-2xx responses map through fixed safe UI errors; app does not infer stream existence.

### Main/Worker protocol and ownership

- Main→Worker messages are exact: `{type:"start",origin,streamId}`, `{type:"visibility",visible}`, `{type:"frame-complete",generation,sequence,presented}`, `{type:"reset-complete",generation,discardThroughSequence}`, and `{type:"dispose"}`. Worker→Main messages are exact: `{type:"state",state}`, `{type:"reset",generation,discardThroughSequence,state:"syncing"}`, `{type:"frame",generation,sequence,epoch,fresh,frame:VideoFrame}`, `{type:"metrics",sample}`, and `{type:"error",code,safeMessage}`. Generation is a positive safe integer incremented on start, epoch change, GAP and reconnect reset. Additional keys, wrong types/order, duplicate start or post-dispose messages terminate Worker/app as `malformed-control`.
- Start transfers no secret. Each binary WebSocket message is copied into one transferred ArrayBuffer owned by Worker. Worker transfers each VideoFrame to Main exactly once and relinquishes it; Main alone closes transferred frames. Main sends exactly one frame-complete after closing every received frame: `presented:true` only after successful visible draw, `false` for replacement, hidden, reset, dispose or error discard. Reset makes Main synchronously leave Live, complete/close pending frames through watermark, discard every older generation, then send matching reset-complete; Worker fences decoder input, increments generation and resets decoder before posting reset, and late old-generation output is closed. Worker accepts no replay/decode until exact reset-complete. Dispose completes/closes frames before dispose and no message follows final state.

### Binary parser, epoch and GAP rules

- Worker accepts binary WebSocket messages only, each exactly one 40-byte-envelope plus declared payload, with total at most 8 MiB+40. It validates every fixed field, known kind/flag, exact payload length/bounds and strictly increasing per-connection envelope sequence starting at `1`; text media, partial/combined/trailing bytes and sequence gaps/regressions are `malformed-media`.
- Session payload is exactly codec H.264, positive coded/display sizes and timebase 1,000,000. New epoch must exceed prior epoch, clears old decoder/config/frames and enters `syncing`. Config is exactly once before dependent frames. Frame epoch/PTS/key/order follows Runtime; non-key before readiness is rejected. END is exactly once, maps four reasons to terminal UI, closes decoder/socket, and any later message is rejected.
- Highest received Frame-envelope sequence and ACK floor initialize to `0`. GAP is valid only after a session and has reason 1..3 plus monotonic watermark `0..highestFrame`; therefore a pre-frame GAP with watermark `0` is valid and releases no frame ownership. Worker fences/resets decoder and posts reset as above; Main closes render/transferred ownership through watermark and immediately shows syncing/non-Live. After matching reset-complete, Worker accepts exactly one same-epoch replayed identical session/config before next key; missing/changed/duplicate replay is terminal. Stale painted/ACK at or below floor is ignored; future/unknown generation or sequence is `malformed-control`.

### Annex-B AVC and decoder

- Config Annex-B parser accepts 3- or 4-byte start codes, rejects zero-length NALs and requires exactly one SPS type 7 and one PPS type 8 with forbidden-zero bit clear; any other type or duplicate is `malformed-media`. SPS requires NAL header followed by nonzero profile_idc, compatibility byte and nonzero level_idc; compatibility low two reserved bits must be zero. Structural/truncation/reserved-bit/profile-zero/level-zero failures are `malformed-media`. Codec string is lowercase `avc1.` plus profile/compatibility/level as six lowercase hex digits. A structurally valid codec rejected by `isConfigSupported` is `viewer-unsupported`.
- Worker calls `VideoDecoder.isConfigSupported` then configures exactly `{codec,codedWidth,codedHeight,optimizeForLatency:true,hardwareAcceleration:"prefer-hardware"}` with no description. Returned config must preserve codec/sizes and supported=true. Unsupported/rejected configuration enters `unsupported`; decoder error callback enters terminal `error` and releases all ownership.
- Config and first IDR combined size is checked with integer overflow and ≤8 MiB before one allocation. Worker creates one key EncodedVideoChunk from `config || IDR`; later chunks contain frame bytes only. `ptsUs` must be nonnegative and ≤Number.MAX_SAFE_INTEGER before conversion to exact microsecond timestamp; overflow/negative is `malformed-media`. Duration is omitted. Decode queue is capped at 4, advertised credit is reduced before cap, and no chunk is silently dropped or retained after reset.

### Rendering, ACK and UI state

- Worker retains at most one transferred-not-painted frame. Main retains at most one render frame and draws it on the next requestAnimationFrame directly to Canvas. Canvas backing width/height equal frame display size; CSS preserves aspect ratio and uses `min(device-pixel-size, available viewport)` so it may downscale but never upscale/crop/stretch. Background is black and DPR changes do not alter source aspect.
- Main closes every VideoFrame in `finally` after draw or discard and emits one frame-complete. Each generation starts with `freshEligible=true`; the next decoded key output is `fresh:true`, while deltas are always false. A current-generation `fresh:true,presented:true` completion consumes eligibility and atomically enters Live. A `presented:false` completion releases ownership but does not consume eligibility, so the next same-generation decoded key is fresh again; this repeats until one fresh key is presented or generation resets. Worker releases ownership and may advance cumulative ACK for both outcomes. Main rejects/completes late generation or sequence at/below reset floor. GAP reset, terminal or visibility false synchronously removes Live. Canvas remains cached under mandatory non-Live overlay outside Live.
- DOM is fixed: pairing code/expiry, one status element, one Canvas and one accessible retry button; no frame image or secret-bearing element. Exact states are `bootstrap→connecting→syncing→live`, `live↔paused`, and terminal `disconnected|stopped|unsupported|error`; `interrupted` immediately displays non-Live and then resolves terminal. Worker state messages drive all non-Live states; reset drives syncing; only Main paint drives live. Error text is fixed safe code/message only. Retry performs a full new pairing/session/Worker lifecycle.

### Visibility, refresh and metrics

- Entry sends current visibility immediately and on visibilitychange; hidden or pagehide sets paused, sends visibility false with credit zero, stops cookie refresh and removes Live before asynchronous work. Visible entry refreshes cookie every 30 seconds via exact session refresh, sends visibility true and resumes/reconnects within Runtime grace; Live requires a newly painted fresh key/frame after return. Worker sends hello then an immediate absolute lease-renew. While visible and decode+transfer ownership is below 4 it advertises `creditFrames:4, creditBytes:8388608`; at ownership/decode cap it immediately advertises `0,0`; it renews visible demand every one second and sends changes immediately. Hidden always advertises `visible:false,0,0`. Refresh/reconnect failure becomes disconnected without automatic Capture restart. Pagehide/dispose sends leave best-effort then closes Worker.
- Metrics define a source frame as a unique accepted Runtime Frame envelope and a presented frame as a successful Canvas draw followed by frame close. Worker/Main record monotonic receive/decode/output/paint timestamps, queue counts and first-Live from authenticated WS open to first fresh paint. Metrics contain no pixels, payload, device locator, StreamId, cookie or grant.
- Automated browser evidence uses mounted `xd://browser` with executable `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, verified present on the target macOS host, against the real loopback surface. Main records accessibility/DOM state, network/CSP/console, WebCodecs support, six 10-second windows, presented interval p95 and five-minute queue/memory observation; no subagent/browser fallback is accepted. External glass-to-glass capture is optional non-blocking research and does not establish a latency bound or support claim.

## WP4 Transport-Resync Rule

- GAP reasons `1=shared-overflow` and `2=viewer-overflow` use the confirmed same-epoch replayed identical session/config followed by key. GAP reason `3=transport-resync` instead terminates old-epoch readiness: after reset/reset-complete, the next accepted media envelope must be one SessionStarted with an epoch strictly greater than the old epoch, followed by exactly one new config and a key. Same-epoch replay after reason 3, higher-epoch session after reasons 1/2, or any intervening frame/config is terminal `malformed-media`. Both paths keep the GAP envelope watermark/ownership release and generation fencing rules.
