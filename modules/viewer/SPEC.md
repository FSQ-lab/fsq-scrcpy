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
- Viewer uses the protected auto-bootstrap/session flow and never receives a reusable bearer in query strings, ordinary/model output, error messages, persisted history, logs, process arguments or telemetry. Standalone responses keep the exact deny-by-default CSP and `frame-ancestors 'none'`; video is rendered directly from decoded frame/image ownership to Canvas.
- States are `authorizing`, `connecting`, `syncing`, `live`, `paused`, `interrupted`, `disconnected`, `stopped`, `unsupported`, `error`. A cached frame is always overlaid non-Live; `interrupted` remains classification only and resolves terminally without automatic Capture restart.
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
- Entry derives StreamId only from exact `/viewer/<canonical-uuid>` pathname, then uses same-origin credentials、exact JSON `{streamId}` and no referrer to call session creation. A 204 precedes Worker start；401/409 map to fixed authorization/conflict UI。Entry never handles a pairing code、pairingId、grant or readable cookie。
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
- DOM is fixed: one status element, one Canvas and one accessible retry button; no pairing element、frame image or secret-bearing element。Exact states are `authorizing→connecting→syncing→live`, `live↔paused`, and terminal `disconnected|stopped|unsupported|error`; `interrupted` displays non-Live then resolves terminally。Retry starts a new HTML/session/Worker lifecycle but never calls control ensure。

### Visibility, refresh and metrics

- Entry sends current visibility immediately and on visibilitychange; hidden or pagehide sets paused, sends visibility false with credit zero, stops cookie refresh and removes Live before asynchronous work. Visible entry refreshes cookie every 30 seconds via exact session refresh, sends visibility true and resumes/reconnects within Runtime grace; Live requires a newly painted fresh key/frame after return. Worker sends hello then an immediate absolute lease-renew. While visible and decode+transfer ownership is below 4 it advertises `creditFrames:4, creditBytes:8388608`; at ownership/decode cap it immediately advertises `0,0`; it renews visible demand every one second and sends changes immediately. Hidden always advertises `visible:false,0,0`. Refresh/reconnect failure becomes disconnected without automatic Capture restart. Pagehide/dispose sends leave best-effort then closes Worker.
- Metrics define a source frame as a unique accepted Runtime Frame envelope and a presented frame as a successful Canvas draw followed by frame close. Worker/Main record monotonic receive/decode/output/paint timestamps, queue counts and first-Live from authenticated WS open to first fresh paint. Metrics contain no pixels, payload, device locator, StreamId, cookie or grant.
- Automated browser evidence uses mounted `xd://browser` with executable `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, verified present on the target macOS host, against the real loopback surface. Main records accessibility/DOM state, network/CSP/console, WebCodecs support, six 10-second windows, presented interval p95 and five-minute queue/memory observation; no subagent/browser fallback is accepted. External glass-to-glass capture is optional non-blocking research and does not establish a latency bound or support claim.

## WP4 Transport-Resync Rule

- GAP reasons `1=shared-overflow` and `2=viewer-overflow` use the confirmed same-epoch replayed identical session/config followed by key. GAP reason `3=transport-resync` instead terminates old-epoch readiness: after reset/reset-complete, the next accepted media envelope must be one SessionStarted with an epoch strictly greater than the old epoch, followed by exactly one new config and a key. Same-epoch replay after reason 3, higher-epoch session after reasons 1/2, or any intervening frame/config is terminal `malformed-media`. Both paths keep the GAP envelope watermark/ownership release and generation fencing rules.

## iOS WDA Standalone Contract

本节增加同一 standalone Worker/Main/Canvas 管线的 MJPEG codec 分支；Android H.264 minor 0、质量和 decoder 契约不变，WDA 不适用 Android 720p/30-FPS 门槛。

- Viewer 同时接受 H.264 minor 0、MJPEG minor 1；MJPEG config/non-key/非法 epoch 拒绝。浏览器永不接收 WDA endpoint，不使用直连 img、transcoding、object URL、存储或第二 Viewer。
- Worker JPEG 路径为完整 JPEG→内存 Blob(image/jpeg)→`createImageBitmap(...,{imageOrientation:"from-image"})`→transfer ImageBitmap→Main Canvas draw→close→frame-complete/ACK。探测 Worker createImageBitmap、transferable ImageBitmap 和 Canvas；不支持为 viewer-unsupported，禁止开始或续租 demand。
- decode 前校验 JPEG side≤4096、area≤8,388,608 及完整性；解码后验证 orientation-correct bitmap 与 Session display size 一致，否则 close 并 malformed-media。Canvas backing size 等于实际 display size，CSS 保持比例，不裁切、拉伸或上采样。
- Worker 最多一个 decoding image 与一个 transferred-not-completed image，Main 最多一个 render image；每个逻辑四字节像素 image ≤32 MiB。所有 draw/discard/replacement/reset/hide/terminal/error 路径 close；异步旧 generation 输出也 close，不恢复 Live。
- Main/Worker frame union 增加 ImageBitmap；generation、reset handshake、exact frame-complete 与所有权规则不变。MJPEG reason 3 释放 watermark 后只接受更高 epoch Session→key JPEG；不接 Config。H.264 GAP grammar 原样保留。
- 成功 visible paint 并 close 后才推进 paintedSequence；release-only 仅推进累计 sequence。Minor 1 每次新 paint 立即发送 exact `{v:1,type:"ack",sequence,paintedSequence}`，初始 paint=0，单调≤sequence；minor 0 ACK 不变。
- 新 epoch/reset/hide 同步去除 Live；fresh paint 才恢复。两秒无当前 epoch paint 显示 interrupted/non-Live，十二秒失败；同 CaptureSession 在期限内可恢复。首 paint 五秒期限由 Runtime 从首次有效 visible demand 权威计时，非 HTTP activity、source arrival 或旧图证明。
- hidden/pagehide 清空 decode/render 并停止 demand；grace 内返回 syncing，fresh paint 才 Live；五秒后 Runtime 关闭 FSQ source。WDA、forward 和自动化不由 Viewer 管理。
- 只记录无像素、无 locator 的尺寸/orientation/drop/arrival/startup 证据，不宣称 FPS、分辨率或延迟支持；支持矩阵须另经真实设备和浏览器证据确认。

## ACK/profile Contract

本节覆盖目标能力探测、Main/Worker start及minor1完成ACK条款，不新增第二媒体管线或控制面。

- Main从既有受保护HTML根属性读取精确mediaProfile枚举；缺失/未知或生产Canvas2D context不可用即unsupported，不启动Worker/demand。Main→Worker start恰好为`{type:"start",origin,streamId,mediaProfile}`，保留origin/UUID/single-start校验。H.264只要求其原有Worker/binary WebSocket/VideoDecoder/EncodedVideoChunk及Main Canvas基础能力，不新增JPEG或raw-VideoFrame构造要求；实际AVC支持仍由后续真实SPS/config核验。
- MJPEG要求Worker createImageBitmap、可转移ImageBitmap、Main ImageBitmap类型校验及实际Canvas绘制。Worker对一个固定≤4KiB、coded1×2/EXIF orientation6的合成JPEG以`imageOrientation:"from-image"`解码，预期bitmap2×1；它不是source Frame、source metric、paintedSequence或Live证明，不含用户内容。
- Worker→Main probe恰好为`{type:"capability-probe",generation:1,mediaProfile:"mjpeg",frame:ImageBitmap}`，bitmap只转移一次。Main只接受当前Worker的单个待决启动probe，验证资源类型/2×1尺寸，通过唯一生产bitmap/Canvas路径绘制、清除探测像素并在finally关闭，不进入Live/metrics。Main→Worker result恰好为`{type:"capability-result",generation:1,supported:boolean}`，只接受一次待决结果；这不是第二Viewer或source传输。
- 总preflight deadline为Worker接受start后的5000单调毫秒，成功处理时也重查deadline。MJPEG成功前不得连接WebSocket、发送hello或visible renewal；H.264基础检查成功后沿用正常连接。失败/超时为viewer-unsupported，首次成功之前Capture.open/visible-renewal均为0。非预期/重复probe/result为malformed-control，不得创建额外socket或复活已结束Worker。
- 探测中visibility只更新desired flag；tiny synthetic probe可在hidden完成但不进入Live，成功的hidden连接不产生visible demand。pagehide/dispose则fence。转移失败由sender关闭未转移bitmap；成功转移后Main为唯一关闭者，含旧Worker/generation、非法消息、pagehide/dispose和draw error。迟到decode由Worker关闭且不再转移；超时/unsupported释放全部已知probe资源并dispose Worker，不保留图片/object URL/source socket。
- 每次minor1 draw或discard完成且图像关闭后，立即发送一条合并ACK；成功当前可见generation的paint推进release/paint，discard只推进release。不能先release再补paint、等待四帧或tick；GAP不制造paint或冗余ACK。旧epoch/旧可见周期完成不能令当前表面Live；minor0的精确ACK、四帧累计和tail flush保持原样。
- preflight的5000ms仅为基础能力资源期限，不保证所有真实内容均可解码，也不替代First Live计时。首个有效authenticated visible renewal才启动权威五秒fresh-paint deadline；原2秒stale、12秒终止、grace及ImageBitmap全路径清理要求不变。

## Agent Auto-Bootstrap Viewer

本节定义 `AGENT-AUTO-VIEWER-BOOTSTRAP-MACOS-ANDROID-11B` 的 Viewer clean cut。Worker、H.264/MJPEG、Canvas、paint/ACK、visibility、freshness和metrics管线no-delta。

### Entry authorization and session

- 页面状态改为 `authorizing→connecting→syncing→live`、`live↔paused`、`interrupted`及既有terminal states。所有non-Live状态以遮罩覆盖cached frame；hidden/pagehide立即Paused/grace，返回先Syncing且必须fresh paint才Live。
- DOM clean-cut删除pairing code/expiry、owner approval提示和redeem polling；固定表面只保留status、Canvas和accessible retry。不得显示、读写或持久化claim/media cookie或任何secret。
- eligible HTML由Runtime提交HttpOnly claim cookie。Entry随后以same-origin credentials和exact body`{streamId}` POST `/v1/sessions`；204成功后才启动existing Worker并进入Connecting。Entry不发送Authorization、pairingId、code或grant，JavaScript不能读取cookie。
- session 401显示固定“authorization expired”并要求Agent再次展示Viewer；409显示固定“Viewer already open elsewhere”。browser retry只重试当前HTML/session规则，不调用control ensure、不延长permit、不自动抢占Viewer。
- committed response loss、reload、provisional media cookie和stale claim清理由Runtime cookie contract拥有；Entry对204保持幂等，不从响应、URL或DOM推断credential/state。

### Navigation, cleanup and unchanged media boundary

- native direct open与explicit user-activated link均由Runtime exact Fetch Metadata gate决定；iframe、prefetch/prerender或无activation非native导航不可启动Entry/Worker/demand。
- pagehide先同步撤销可见性、停止refresh/renewal、fence旧generation并关闭所有VideoFrame/ImageBitmap和Worker；它不发送HTTP DELETE，WebSocket关闭由Runtime权威进入5秒grace，避免旧document迟到cleanup携带新cookie撤销下一导航。显式retry、error与非pagehide dispose仍按Runtime state-appropriate cookie规则DELETE；401 cleanup不复活旧Worker。
- Worker start/protocol、content-addressed assets/CSP、WebSocket、H.264/MJPEG decode、Canvas ownership、First Live、2秒stale/12秒终止、5秒grace、quality/rotation和无frame进入模型/日志规则全部保持。
- 验收必须证明无pairing DOM/code/poll/grant、session 204先于Worker、401/409 fixed UI、Authorizing/Connecting/Syncing/Live/Paused/Interrupted transitions，以及两个media profile全量回归；真实画面只由本机用户查看。
## VS Code MCP App Presentation

本节定义 `ANDROID-MCP-VIEWER-04` 的 Viewer delta。presentation增加一个Adapter，但媒体实现保持唯一。

- MCP resource URI exact `ui://fsq-scrcpy/viewer-v1`，MIME exact `text/html;profile=mcp-app`。resource HTML是bounded self-contained Main/App bundle，使用official `@modelcontextprotocol/ext-apps@2.0.3` `App`/`PostMessageTransport`；不得自研Host postMessage transport、使用CDN、inline eval、remote frame或第二decode/render实现。
- `resources/read`始终返回同一bounded App shell。current prepared presentation存在时，content `_meta.ui.csp`只声明其safe Runtime origin：`connectDomains` exact含`http`/`ws` origin，`resourceDomains` exact含`http` origin；无presentation、early read或prepare failure时四类domain/permission均空，shell只能显示tool result并调用Host `ui/open-link`。不得wildcard、`localhost`、IPv6或任意端口模式，`prefersBorder:true`固定。
- App在connect前安装tool-result、tool-cancelled、host-context/teardown handler；只接受当前`fsq_viewer_ensure`的exact safe result，校验StreamId、descriptor origin、snapshot/device parity。它不读取`_meta` credential；不存在embedded token/cookie/capability。
- Apps-capable ensure成功后，App用`credentials:omit`、`cache:no-store`、`referrerPolicy:no-referrer`向exact Runtime origin发送zero-byte`POST /v1/app-sessions`。network/response loss在原`expiresAt`前只幂等重试同Origin bind；204后才启动现有Worker。CSP、LNA permission、bind或WS失败保持non-Live、释放全部ownership，并由用户点击button通过`ui/open-link`打开同一safe standalone URI，绝不自动ensure或延长permit。
- Main→Worker start增加exact presentation enum`standalone|embedded`；standalone session/cookie path不变，embedded跳过`POST /v1/sessions`并直接用bound Origin打开同一WebSocket。之后H.264/MJPEG、protocol、decoder/ImageBitmap、Canvas、frame-complete/ACK、freshness、metrics及terminal UI完全共用；embedded关闭socket后禁止Worker reconnect。
- embedded visible恰为`document.visibilityState==='visible' && IntersectionObserver(root=document viewport).isIntersecting && !teardown`。任一false立即non-Live、清pending frame并发送visible=false；全部恢复true才visible=true并等待fresh paint。`pagehide`、MCP Apps resource teardown、Worker/document error均dispose socket并terminal；新document/remount不得恢复旧stream。exact VS Code若在collapse、切tab或隐藏chat时不能可靠触发上述信号，则Host验收失败。
- 同Origin并发App只由Runtime首个WebSocket判胜，败者显示fixed viewer-in-use且不影响赢家。App UI只含status、Canvas、显式`Stop viewing`与standalone fallback button，不发送设备控制、message/sampling/model update，不把frame/metrics/private value写入Host context。`Stop viewing`必须幂等地立即dispose Worker、发送既有WebSocket `leave`、显示Stopped并best-effort调用official `App.requestTeardown()`；Host未卸载文档或拒绝teardown不影响Runtime释放唯一Viewer/stream，随后authenticated ensure创建新StreamId。
- unsupported Host不渲染App并保留普通tool text URL；Apps-capable但无prepared presentation、early read或prepare failure渲染无外联fallback shell；App已启动后的CSP/LNA/bind/WS失败使用同一`ui/open-link` button。transport级resource load或Host renderer失败没有可执行App，直接使exact Host gate失败，不伪称已有fallback。
- 验收覆盖resource MIME/CSP/size、SDK handshake顺序、tool-result-before-resource-read、early/failure fallback shell、bind前零Worker/demand、LNA拒绝、Origin change、single Viewer、visibility/intersection/teardown、socket-close no-reconnect、两种media profile全量回归及exact VS Code真实内嵌表面。
