# Module: Runtime

## Purpose

维护本地流服务、单流生命周期、媒体分发和外部启动/连接 seam。它把 Capture 的编码媒体转换为 Viewer 可消费的本地流，但不拥有设备控制。

## Dependencies

Runtime 可依赖 Capture 和 Contracts，不依赖 Viewer 或 `Appium_connect_agent`。

## Public Interface

当前 standalone v1 使用下方进程内接口；跨进程 launch/attach transport 尚未定义，必须通过后续 SPEC delta 增加。当前接口支持：

- 在已有 Runtime 实例内按 `DeviceRef` 幂等创建或取得唯一流。
- 返回受保护的 Viewer access 和稳定 snapshot。
- revision-based inspect。
- authenticated visible Viewer 租约及无人观看后的自动停止。
- 显式停止、取消、设备断连和进程退出时的确定性清理。

## Non-Responsibilities

- 不拥有 Appium Session 或 Coding Agent 工具定义。
- 不把 MCP 当作逐帧媒体传输。
- 不自动开放远程网络访问，不实现云端 relay。

## Current Invariants

- 第一批为本地 macOS 宿主、单设备、单流。
- 当前 standalone v1 仅使用进程内 module interface；外部 Adapter 拉起/连接由后续跨仓 SPEC delta 定义。
- 视频操控与视频观看互不构成可用性依赖。
- Runtime 与 Viewer 仅绑定 loopback；pairing、capability、Host 和 Origin 策略由下方契约固定。

## Local Runtime Contract v1

### Current standalone module interface

```text
ensureStandaloneViewer(deviceRef, idempotencyKey) -> ViewerAccess + StreamSnapshot
inspect(streamId, afterRevision?) -> current snapshot or ordered changes
stop(streamId, expectedRevision?, reason) -> terminal snapshot
```

This is the Runtime module interface used inside the current process, not a serialized cross-process control protocol. `idempotencyKey` is scoped to one Runtime instance plus operation and DeviceRef; repeating the same key and identical input returns the original result, while reusing it with different input returns `malformed-control`. `ensureStandaloneViewer` creates no second Capture and starts no Capture until an authenticated visible Viewer renews demand. External launch/attach and its transport/version negotiation require a later SPEC delta.

### Loopback security and leases

- Bind loopback only; validate Host and Origin against exact allowlists. The standalone URI is a non-secret pairing page. Pairing codes/grants use at least 128 bits from the OS CSPRNG; Runtime persists only a keyed digest/comparison record and uses constant-time comparison.
- Browser pairing creates a code and bootstrap grant with a 60-second absolute TTL; local owner approval exchanges it once for an HttpOnly, SameSite=Strict media session cookie with a 60-second reconnect TTL, bound to instance/StreamId/audience and revoked on stop/Runtime exit. Secrets are excluded from query strings, ordinary/model output, errors, persisted history, logs, process arguments and telemetry. Unauthenticated, expired, replayed or wrong-audience requests allocate no Capture or large queue.
- Visible authenticated demand renews at least every 2 seconds. Hidden/pagehide/disconnect stops renewal and enters 5-second `grace`. Return within grace keeps the StreamId and enters `syncing`; expiry runs unified stop. Browser close notification is advisory; the server deadline is authoritative.
- Runtime admits one active Viewer. `viewer-limit-reached` is returned before allocating a second Viewer.

### Media protocol v1

WebSocket subprotocol is `fsq-viewer.v1`. Browser-to-Runtime control messages are UTF-8 JSON objects with no additional fields:

- `{ "v": 1, "type": "hello", "streamId": string }`
- `{ "v": 1, "type": "lease-renew", "visible": boolean, "creditFrames": integer 0..4, "creditBytes": integer 0..8388608 }`
- `{ "v": 1, "type": "ack", "sequence": decimal-u64-string }`
- `{ "v": 1, "type": "leave" }`

`lease-renew` credit values are absolute advertised maxima, replace the previous maxima and never add credit; an identical repeat is idempotent. Lease visibility/expiry is independent of media credit. Only `frame` envelopes consume one frame credit and their full header+payload bytes consume byte credit. Runtime sends a frame only when resulting outstanding counts stay within both maxima and the WebSocket queued/pending-send hard cap. `ack.sequence` is cumulative for sent frame envelopes through that sequence and is sent only after Viewer has released every covered frame's decode/render ownership. Runtime tracks `highestAck`, `highestSentFrame` and `discardThrough`: ACK at or below `max(highestAck, discardThrough)` is an idempotent stale/duplicate no-op; ACK above `highestSentFrame` is terminal `malformed-control` for that Viewer; a valid greater ACK releases corresponding outstanding frame/byte counts. `gap` carries a discard watermark, atomically invalidates logical outstanding frames through it and resets logical credit for the new synchronization epoch; ordered older bytes already accepted by WebSocket still count against the pending-send cap until flushed. Session/config/gap/end use the bounded non-media lane, not frame credit.

Each Runtime-to-Viewer binary message is exactly one big-endian envelope. The v1 header is 40 bytes:

| Offset | Field | v1 rule |
| ---: | --- | --- |
| 0 | `magic[4]` | ASCII `FSQV` |
| 4 | `major:u8` | `1` |
| 5 | `minor:u8` | `0` |
| 6 | `kind:u8` | `1=session`, `2=config`, `3=frame`, `4=gap`, `5=end` |
| 7 | `flags:u8` | frame bit 0 = key; all other bits and non-frame flags are zero |
| 8 | `headerBytes:u16` | `40` |
| 10 | `reserved:u16` | zero |
| 12 | `payloadBytes:u32` | at most 8 MiB and exactly the remaining message bytes |
| 16 | `sequence:u64` | starts at 1 and strictly increments per connection |
| 24 | `epoch:u64` | positive for session/config/frame/gap; end uses current epoch or zero before first session |
| 32 | `ptsUs:i64` | frame PTS; `-1` for every other kind |

Payload rules:

- `session`: exactly 24 bytes: codec FourCC `u32` (`0x68323634` for H.264), coded width/height `u32`, display width/height `u32`, timebase `u32` fixed to `1_000_000`.
- `config`: raw same-epoch Annex B codec config bytes, exactly once per epoch and at most 256 KiB.
- `frame`: one complete Annex B access unit, at most 7.75 MiB (8,126,464 bytes); key flag mirrors the normalized Capture event. Config+key concatenation is checked before allocation and is at most 8 MiB.
- `gap`: exactly 12 bytes: reason `u32` (`1=shared-overflow`, `2=viewer-overflow`, `3=transport-resync`) plus `discardThroughSequence:u64`, the highest frame-envelope sequence whose decode continuity and outstanding logical credit are invalidated. Viewer releases queued/decode/render ownership through that watermark before accepting the replayed session/config/key sequence.
- `end`: exactly 4-byte `u32` reason (`1=explicit-stop`, `2=lease-expired`, `3=device-disconnected`, `4=failed`). Detailed typed errors remain on the Runtime state/error interface.

Unknown major/kind, unknown flag, nonzero reserved, illegal epoch/PTS/order, replacement config in one epoch, length mismatch or payload over limit fails closed as `malformed-media`. Minor additions cannot reinterpret these fields.

- Runtime retains one bounded current-epoch `session + config` snapshot. Missing retained config when recovery begins is terminal `runtime-overload`.
- Shared Capture→Runtime overflow starts a 5-second deadline at overflow detection, marks every current Viewer discontinuous, releases queued media, discards deltas to the next keyframe, sends `gap`, replays session/config and admits that key. No same-epoch config+key by deadline is terminal `backpressure-timeout` for the stream and sends END `failed`.
- Per-Viewer outstanding media is at most 4 frames or 8 MiB. Viewer/WebSocket queued plus pending-send bytes are also capped at 8 MiB. Per-Viewer overflow starts a 5-second deadline when `gap` is enqueued; no recoverable key by deadline closes that Viewer as `slow-consumer`, after which the visible lease follows the normal 5-second grace.
- The separate session/config/state/terminal lane is at most 64 messages or 512 KiB. It is not dropped or coalesced except ordinary state snapshots by revision; overflow is terminal `runtime-overload`. Terminalization selects one cause, fences and quiesces producers, then sends exactly one final `end`; no media follows it.

### Runtime implementation baseline

Node.js 24.22.1 LTS is the external prerequisite. Production direct dependencies are exact `ws@8.22.0` and `openpgp@6.3.2` under the approved usage and license boundaries. Viewer/build/test dependencies and lock policy are fixed by the selection record. No Runtime library type crosses the public seam.

## WP2 Capture-Watermark Interop

- Capture Frame `sequence` and `Discontinuity.discardThroughCaptureSequence` are source-session identifiers and never appear directly as Viewer ACK/GAP envelope sequences. Runtime initializes each Viewer's `discardThrough` to `0` and records the Capture sequence on every emitted frame-envelope assignment. On Discontinuity it maps the Capture watermark to that Viewer's highest assigned frame-envelope sequence whose source sequence is at or below the watermark; only an envelope value is serialized as GAP `discardThroughSequence`. If no newly mapped frame exists, Runtime serializes and keeps the previous `discardThrough` and releases no additional frame credit, so the first such GAP naturally writes `0`. Otherwise it advances monotonically to `max(previous discardThrough, translated)` and serializes that value. The existing stale-ACK, logical-credit release and replay semantics then apply to the serialized envelope watermark.

## WP3 Exact Runtime Contract

### In-process API, revision and linearization

- Public types reuse Contracts and expose no `ws`, HTTP or Capture implementation object. Exact results are: `EnsureResult = {ok:true,value:{access:ViewerAccess,snapshot:StreamSnapshot}} | {ok:false,error:StreamError}`; `ApproveResult = {ok:true,value:{snapshot:StreamSnapshot,approvedAt:number}} | {ok:false,error:StreamError}`; `InspectResult = {ok:true,value:{snapshot:StreamSnapshot,changes:readonly StreamSnapshot[],reset:boolean}} | {ok:false,error:StreamError}`; `StopResult = {ok:true,value:{snapshot:StreamSnapshot}} | {ok:false,error:StreamError} | {ok:false,error:StreamError,snapshot:StreamSnapshot}` where only a known-stream expectedRevision mismatch carries snapshot. Signatures are `ensureStandaloneViewer({deviceRef,idempotencyKey}):Promise<EnsureResult>`, `approvePairing({streamId,pairingId,pairingCode,viewerGrant}):Promise<ApproveResult>`, `inspect({streamId,afterRevision?}):InspectResult`, and `stop({streamId,expectedRevision?,reason:"explicit-stop"}):Promise<StopResult>`. Top-level requests/results and ordinary nested records are frozen exact plain/null-prototype data; the nested ViewerAccess intentionally retains its confirmed secret-safe class/factory representation. `approvedAt` is integer Unix epoch milliseconds `0..Number.MAX_SAFE_INTEGER`.
- Operation errors are fixed: ensure returns only `malformed-control`, `runtime-bind-failed` or `runtime-overload`; it does not start Capture and cannot return Capture/device errors. Approve returns `unauthorized`, `malformed-control` or `viewer-limit-reached`; inspect returns `malformed-control`; stop returns snapshot-bearing `malformed-control` only for a known nonterminal revision mismatch and snapshot-less `malformed-control` for unknown StreamId. Operational terminal failure is represented by successful StopResult containing the frozen final snapshot. HTTP maps malformed JSON/control to 400, unauthorized/expired/replay to 401, unknown stream/route to 404, state conflict/viewer limit to 409, body too large to 413, media type to 415 and rate excess to 429; safe bodies never distinguish unknown versus unauthorized protected resources.
- `idempotencyKey` is unpadded base64url, 22..128 characters. Canonical input bytes are UTF-8 over fixed field order `contractVersion,platform,namespace,opaqueId` with u16 length prefixes, never generic JSON. Runtime retains at most 64 records and never expires or evicts the record bound to a nonterminal stream. Before a new ensure it purges terminal records only after exactly `max(createdAt+10 minutes, terminalPublishedAt+60 seconds)`; if 64 retained records remain it returns `runtime-overload`. ViewerAccess is returnable only during its 60-second owner-grant lifetime; afterward same key/input returns fixed `unauthorized`, never the expired secret, while different input remains `malformed-control`. A different ensure key is `malformed-control` while the stream is nonterminal; after terminal publication a new key may create a new StreamId.
- Each mutating operation has one mutex-protected linearization point. `revision` starts at `1` for `demand-pending` and increases by one per externally observable snapshot. Inspect without `afterRevision` returns `{snapshot,changes:[],reset:false}`; equal/current revision returns no changes; newer-than-current is `malformed-control`. Runtime retains at most 64 ordered changes/512 KiB; an older evicted revision returns `{snapshot,changes:[],reset:true}`. Ordinary consecutive snapshots may coalesce before observation; terminal/stopping changes never coalesce.
- Stop on an unknown StreamId is `malformed-control`. A nonterminal `expectedRevision` mismatch returns `malformed-control` plus the unchanged current snapshot. The first valid stop linearizes terminalization; repeated stop after terminal returns the same frozen terminal snapshot regardless of expectedRevision. Concurrent ensure/stop obey mutex order and never create two Capture sessions.

### Standalone pairing, owner approval and session cookie

- The exact surface is HTTP `GET /viewer/<streamId>`, `GET /assets/<lowercase-sha256>/<basename>`, `POST /v1/pairings`, `POST /v1/pairings/<pairingId>/redeem`, `POST /v1/sessions`, `POST /v1/sessions/refresh`, `DELETE /v1/sessions/current`; and WebSocket upgrade `GET /v1/stream` only with `fsq-viewer.v1`. Runtime receives one frozen exact `ViewerAssetManifest { entries }`: entries is an array of 2..16 frozen exact `{role,name,sha256,mime}` records backed by private copied bytes that are never exposed or frozen as TypedArrays. `role` is `entry-module`, `worker-module` or `style`; there is exactly one entry-module, exactly one worker-module and at most 14 styles. Module roles require `text/javascript; charset=utf-8`; style requires `text/css; charset=utf-8`. Name is unique and matches `[a-z0-9][a-z0-9._-]{0,63}` with no slash; SHA-256 is lowercase hex and matches private bytes; each payload is nonempty and at most 1 MiB; total bytes are at most 2 MiB. Raw request-target exactly matches a listed route/path and contains no percent escape/query/fragment. Runtime freezes records/map, accepts no filesystem path and exposes no private bytes. HTML inserts only entry-module as `<script type="module">` and styles as links; worker-module remains a self-hosted URL and is never a document script. Other methods/routes and additional keys are 404/405 without allocation.
- Node HTTP server uses `maxHeaderSize=8192`, at most 32 headers, `headersTimeout=5000` and request timeout 5000 ms. Every body route requires one canonical `Content-Type: application/json; charset=utf-8`, one decimal Content-Length and no Transfer-Encoding. Content-Length and bytes read are each at most 4096 and must match exactly. Body read has a two-second idle timeout and five-second total timeout from accepted headers; timeout destroys the request and returns no reusable connection. Missing/duplicate/invalid length, chunked input, premature EOF and body on a bodyless route fail before parse/allocation. The same strict duplicate-key/single-object UTF-8 parser as WebSocket control is used.
- Pairing start atomically reserves the one Viewer slot and returns 201 `{pairingId,pairingCode,expiresAt}`. `pairingId` is a lowercase v4 UUID; `pairingCode` is the confirmed eight-character Crockford human code, allows five failed comparisons, and is not a bearer. Bootstrap grant is an independent 128-bit unpadded base64url bearer. Runtime stores only process-keyed HMAC-SHA-256 digests with instance/stream/browser-session/audience/expiry context. Pairing and bootstrap each expire absolutely after 60 seconds and are single-use.
- Trusted in-process `approvePairing` verifies the Contracts ViewerGrant via explicit reveal, constant-time context digest, exact pending identity/code/attempt count and expiry, then returns only `{snapshot,approvedAt}` and marks that pending pairing approved. Before approval redeem returns 409; wrong/expired/replayed inputs share one 401 body. Approved redeem atomically consumes the human code and returns 200 `{bootstrapGrant,expiresAt}` with `Cache-Control: no-store`; session creation accepts no cookie, atomically consumes Authorization grant, and returns 204 with only the media cookie.
- Cookie is `fsq_media_v1=<opaque>` with `HttpOnly; SameSite=Strict; Path=/; Max-Age=60`; `Secure` is omitted because current transport is exact loopback HTTP. Session creation/refresh success is 204 with no body and one Set-Cookie; refresh requires the current exact cookie, exact Origin/fetch headers and `{visible:true}`, rotates the token/digest, invalidates the old token and restarts only the 60-second reconnect TTL. HTTP refresh never renews the five-second visible-demand lease; only authenticated WebSocket `lease-renew visible:true` does. DELETE requires the cookie, returns 204 plus Max-Age=0, revokes slot/session and starts normal demand/grace handling. Stop, Runtime exit, policy violation or TTL expiry revokes all related material and zeroes raw temporary buffers.
### Loopback authority, browser headers and upgrade

- Runtime binds only `127.0.0.1` on an OS-selected ephemeral port. The sole authority and origin are `127.0.0.1:<selected-port>` and `http://127.0.0.1:<selected-port>`; `localhost`, IPv6, alternate ports and absolute-form proxy targets are rejected. Exactly one canonical Host is required. Duplicate Host/Origin/Cookie/Authorization headers, any `Forwarded`, `Via` or `X-Forwarded-*`, and any proxy-auth header are rejected before body read/allocation.
- Top-level Viewer GET is the only route permitting missing Origin and then requires `Sec-Fetch-Site: none`, `Sec-Fetch-Mode: navigate`, `Sec-Fetch-Dest: document`. Every browser API request requires exact Origin plus `Sec-Fetch-Site: same-origin`; WebSocket upgrade requires exact Host/Origin, valid cookie and exactly one subprotocol token `fsq-viewer.v1`. OPTIONS is 405; no CORS allow header is emitted.
- Viewer responses include `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy: camera=(), microphone=(), geolocation=()` and the confirmed CSP/frame-ancestors policy. Error bodies are fixed safe JSON and contain no authority input, bearer, pairing code or internal path.
- Asset responses require exact same authority, no Origin or exact same Origin, and return the manifest MIME, immutable ETag equal to SHA-256, `Cache-Control: public,max-age=31536000,immutable`, nosniff and the exact bytes. Viewer HTML remains no-store and references no inline script/style. A missing/mismatched manifest entry is 404 without reading arbitrary disk.

### Single-Viewer state machine

- Viewer slot states are `free → pairing-pending → approved → session-issued → connected → grace → free/revoked`. Pairing start owns the slot; a second start/session identity returns `viewer-limit-reached` before new secret/queue allocation. Pending/approved/bootstrap expiry releases the slot if no session exists.
- One session cookie identifies the slot, not a tab. A second WebSocket while the first is active is rejected. During grace, the same unexpired rotated session may reconnect: Runtime fences/closes the old socket, releases its unsent/decode-credit ownership through the current discard watermark, creates fresh per-connection sequence/credit state, and enters `syncing`. Different session/cookie cannot take over. Malformed/slow socket loss enters grace; explicit DELETE, TTL/policy revocation or grace expiry frees the slot and stops demand.

### Strict WebSocket control

- Browser messages must be text UTF-8, at most 4096 bytes. One connection permits at most 128 ACK messages plus 32 non-ACK control messages in any rolling 10 seconds; excess closes 1008/429 semantics. This sustains cumulative ACK at 30 FPS with four-frame credit while bounding abuse. A strict single-object parser rejects duplicate keys, invalid Unicode, non-integer/coerced numbers, exponent forms, additional keys, arrays/prototypes and trailing bytes. Binary/control application data is rejected.
- `hello` is required within 5 seconds, must be first and occur once, and its StreamId must match cookie/session. Only then may `lease-renew`, `ack` or `leave` occur. `visible:false` immediately stops visible renewal and advertises no demand but does not itself close. Credit values are absolute; lowering below outstanding is valid and sends nothing new until outstanding falls within both limits. Zero credit sends no Frame but control/terminal events remain deliverable.
- ACK uses canonical decimal u64 without leading zero except `0`. Existing stale/future rules apply. `leave` closes normally, stops renewal and forbids later messages. Oversize closes 1009; auth/order/schema/rate/stream violations close 1008 with `malformed-control`; internal terminal transport failure closes 1011. Viewer ownership/lease/grace release runs on every close path.

### Per-Viewer send accounting and `ws` adapter

- `perMessageDeflate=false`. Runtime owns a mockable adapter exposing `send(data,callback)`, `bufferedAmount`, `close(code)`, and message/close/error hooks; no `ws` type crosses the Runtime seam.
- Application queue bytes count each complete 40-byte header plus payload exactly once until handed to `send`. `pendingSendBytes` counts those bytes from `send` call until its callback. Because `ws.bufferedAmount` may represent the same accepted bytes, transport pressure is `max(pendingSendBytes, ws.bufferedAmount)`, not their sum. Total ownership is `mediaApplicationQueueBytes + controlApplicationQueueBytes + transportPressure` and remains capped at 8 MiB. At least 64 KiB is always reserved for GAP/END/control; ordinary media admission requires `mediaApplicationQueueBytes + controlApplicationQueueBytes + transportPressure + candidateFrameBytes <= 8 MiB - 64 KiB`, which still admits the maximum confirmed Frame when other queues are empty. Control messages also obey the 64-message/512-KiB logical lane and total cap.
- Moving an envelope to send atomically decrements its application queue and increments pending; callback decrements pending and releases transport ownership, while ACK/GAP separately releases logical Frame ownership. Admission is checked before encoding/copying payload or calling send. Media-cap failure first releases queued unsent Frames, then enqueues the small GAP from reserved capacity and starts recovery; it never calls send for the rejected Frame. Terminalization similarly releases queued unsent media/logical credit, but accepted pending bytes remain owned until send callback or forced socket close; END uses the reserve and its one-second deadline.

### Capture translation, retained ownership and revisions

- Runtime accepts ownership of Capture event `Uint8Array` buffers; Capture never mutates them afterward. Runtime retains at most the current epoch SessionStarted value plus one CodecConfig, and releases each Frame after ACK/GAP/terminal send ownership ends. It allocates no second payload copy except the bounded config+key concatenation performed by Viewer.
- `SessionStarted` replaces retained session, clears prior config/key readiness, publishes `syncing`, and emits the 24-byte session envelope once for every currently connected Viewer that has not received that epoch. `CodecConfig` for the current epoch is retained and emitted once; wrong/replacement epoch is `malformed-media`. The first current-epoch key emits only any session/config still missing for that Viewer, then the key, and publishes `streaming`; it never duplicates already-sent config. Deltas before readiness are rejected/discarded by Capture and never synthesized.
- `SessionEnded{reconfigured}` invalidates outstanding old-epoch Frames by a Runtime-generated GAP reason `transport-resync`, then the next SessionStarted/config/key establish the new epoch; it does not emit END. Capture `Discontinuity` maps through the confirmed per-Viewer watermark and emits GAP reason `shared-overflow`. GAP is the explicit same-epoch decoder reset exception: after GAP the Viewer may accept exactly one replay of the retained session/config before the next key, and Runtime marks those replay flags consumed. Its five-second timer begins when GAP is enqueued.
- Each emitted envelope receives the next per-connection sequence starting at `1`; state revision and envelope sequence are independent. Session/config/gap/end use PTS `-1`; Frame preserves Capture PTS/key. Snapshot epoch/size update with SessionStarted. ACK of the first freshly painted key permits Viewer Live but Runtime `streaming` begins when that key is accepted for send.
- `CaptureEnded{explicit-stop|cancelled}` maps END explicit-stop. `device-disconnected` maps snapshot/END device-disconnected. Other CaptureFailed codes map through the Contracts table to failed, except `stream-interrupted` publishes interrupted during bounded device classification then failed. `backpressure-timeout` and `runtime-overload` map failed. No Capture implementation object or ADB/scrcpy detail enters snapshot/error/media payload.

### Unified terminalization

- Stop request, grace/lease expiry, proven disconnect, Capture failure, Runtime overload and transport failure compete for one atomic first-cause winner; after the winner no later cleanup error changes public cause. The winner revokes pairing/grants/cookie/lease, publishes `stopping`, fences Capture and send producers, and prevents every later media enqueue.
- Runtime calls idempotent Capture stop when applicable, awaits its cached `closed()` result, records but does not replace the winner on mismatch/cleanup error, releases queued-unsent application media and logical ownership, and retains every accepted pending-send byte until callback or forced close. It then enqueues at most one END if an authenticated socket exists; END bypasses Frame credit, consumes control/total capacity from the 64-KiB reserve and remains pending-owned until callback/close.
- END send has a one-second callback deadline. Success closes 1000; timeout/send error destroys/closes 1011. No media/control envelope follows END. Runtime then closes HTTP/WS resources, continues all cleanup, and publishes exactly one frozen terminal snapshot as the final revision; inspect cannot observe terminal before producer fencing and Capture reconciliation complete.

## iOS WDA Standalone Contract

本节为 MJPEG 对既有 H.264 retained-config、send-time streaming、ACK 与恢复规则的 codec-specific 增量；既有鉴权、租约和统一终止规则保持有效。

- composition root 显式配置唯一 CaptureSource；open 仅传 DeviceRef/cancellation，不传平台策略。Control values 与 idempotency canonical bytes 全部使用 v2。
- MJPEG 使用 FSQV minor 1，无 Config；拒绝非 key、非法 codec/epoch/order/size。只保留当前 Session，H.264 继续保留 Session+Config。
- 每 Viewer 最多一个未分配序列的 MJPEG staging slot、一个 assigned outstanding Frame。仅 staging 可 latest-wins；分配序列后不可替换，callback 与 ACK/GAP/terminal ownership 按既有路径释放。普通 replacement 不产生 GAP，不消耗 sequence/credit。
- staging、assigned logical Frame references、application/control queues、pending send 与 WebSocket transport pressure 纳入同一 8 MiB ownership 上限，保留 64 KiB control reserve。沿用 transport pressure=max(pendingSendBytes,bufferedAmount)，重叠所有权不得漏计。替换原子检查 `owned-oldStaging+candidate`；超媒体 ceiling 立即释放 candidate 并计 drop，不保留两份，不分配 sequence/credit。admission 原子移走 slot 后只调用一次 sendFrame。最大 assigned Frame 可使 staging 无容量，此时丢弃输入。
- reconfiguration 先丢旧 staging，再 reason-3 GAP 覆盖被撤销的最高 assigned 旧 Frame sequence 并释放 watermark 内所有权；之后只接受更高 epoch Session→key JPEG。H.264 Session→Config→key 不变；END 后无媒体。
- Minor-1 exact ACK 验证 sequence/paintedSequence，跟踪已发送 Frame sequence→epoch；未知、未来、回退 paint 拒绝，重复幂等，仅当前 epoch advancement 刷新 paint 时间。release ACK 不证明 Live。
- 首次有效 authenticated hello 后 `lease-renew visible:true` 线性化时启动五秒 first-paint deadline。仅当前 epoch painted ACK 成功；deadline 到达以 start-timeout 赢得统一终止，fence Capture、END failed、最终 snapshot；晚 ACK 不复活。
- MJPEG streaming 只在有效当前 epoch painted ACK 后发布。最近 paint 后恰好 2 秒同步退出 streaming，发布 interrupted/stream-interrupted；12 秒前新 paint 经 syncing 回 streaming；12 秒到达 terminal failed/stream-interrupted，关闭 FSQ source，重试必须新 StreamId。source HTTP idle 也是 12 秒，不得更早。
- grace 暂停 freshness timer，页面已非 Live；五秒 grace 内返回进入 syncing 并重启 12 秒 fresh-paint deadline；首次启动仍受五秒约束。epoch change 同步退出 Live，旧 epoch ACK 不恢复。
- EOF/reset 不证明设备拔除；stream-interrupted→failed。first-cause、producer fencing、一次 END/final snapshot、callback/ACK 释放、grants/leases 清理继续适用，不停止外部自动化。

## ACK/profile Contract

本节覆盖上文相应 ACK 限额/校验、Runtime 构造及 Viewer bootstrap 条款，既有安全/租约和5s/2s/12s目标不变。

- 连接在接受 MJPEG minor1 Session 后允许1024 ACK/rolling10s；minor0及尚未绑定模式的冷启动保持128，non-ACK保持32、文本保持4096字节。窗口为 `(now-10000,now]`；所有重复/零值/release-only/旧 epoch ACK均计数，超额1008；额度改变不清空既有窗口，客户端不能通过添加paint字段选额。冷启动不开放minor1四字段 ACK。1024为控制面滥用上限，不是FPS承诺或合法突发永不被关的保证。
- 完整双水位作无副作用校验后，才能原子提交 ACK/paint、释放credit/bytes及允许下次发送；非法paint不得先调用会释放/flush的旧ack路径。只有当前epoch且当前可见周期合格的新paint advancement更新freshness；ACK本身不续租。新可见周期丢弃旧staging并记录既有assigned序列界线，界线内旧ACK只清理、不恢复Live，返回后需新鲜Frame paint。
- 每连接最多1024条尚未被累计ACK确认的已发送Frame证明记录，只含sequence/epoch/发送状态等有界元数据，不持有JPEG。正常ACK回收，GAP撤销但未确认的记录留待在途ACK核对；仅最近接受paint的标量保留用于重复校验。新Frame分配sequence前检查容量，满额走runtime-overload统一终止，不能静默遗忘证明。连接fence后旧记录不能作用于新连接。
- 下一张MJPEG的assignment必须同时等待前一张callback与ACK/GAP/terminal所有权释放；至多一staging、一assigned、连续envelope序列、8MiB去重总所有权和64KiB control reserve不变。schema/order/rate/未知paint关闭Viewer1008，oversize1009，内部transport1011；既有grace/first-cause路径不变，不伪装成source断线或设备拔除。
- 在ACK线性化处重新检查单调deadline；达到5秒启动或12秒freshness终止界线后，晚ACK不能因timer callback延迟而复活流。grace内不刷新可见freshness；epoch/可见周期变化清除Live资格。END/final snapshot仍恰好一次，之后不再admit媒体。
- `RuntimeServiceOptions.mediaProfile`必填且仅为`"h264-annexb"|"mjpeg"`，在构造时私有复制为不可变配置；缺失/非法值在bind或Capture分配前抛出固定本地`TypeError("Invalid media profile")`。不新增序列化错误、兼容默认值、platform推断、source registry或fallback；所有当前构造调用方同步迁移。composition root负责选取匹配的固定CaptureSource，Runtime对不匹配的首个或后续Session codec以malformed-media终止。
- 既有no-store Viewer HTML根元素恰好提供一个经枚举验证的`data-media-profile="h264-annexb"`或`data-media-profile="mjpeg"`属性，供Main在demand前读取。不进入DeviceRef、ViewerDescriptor、URL、bearer或provider locator；既有route/manifest/CSP/Host/Origin/pairing边界不变。精确Main/Worker preflight协议由Viewer同名delta拥有。


