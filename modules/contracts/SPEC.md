# Module: Contracts

## Purpose

维护设备引用、视频流身份、Viewer 描述及跨模块错误语义的唯一共享定义。

本模块只拥有稳定值与契约，不执行设备发现、视频采集、网络监听、进程管理或 UI 渲染。

## Dependencies

Contracts 不依赖其他产品模块。Capture、Runtime 和 Viewer 可依赖 Contracts；禁止反向依赖。

## Public Interface

Public serialized values、错误和状态语义由下方 Contracts v1 定义；Capture、Runtime、Viewer 必须复用这些定义，不能再建立平行类型。

- 外部设备身份与平台类型。
- 一次视频流的稳定身份和生命周期状态。
- Viewer 可用形式，包括独立 URL 与可选的嵌入描述。
- 可恢复、不可恢复及状态不确定的错误。

不得在确认前将 ADB serial、端口、进程 ID、内部路径或第三方对象直接作为跨项目公共契约。

## Current Invariants

- 同一概念只有一个共享定义来源。
- 视频帧不属于控制契约或模型文本输出。
- 外部 Adapter 不依赖本项目内部文件布局或实现类型。

## Public Interface Contract v1

### Serialized values

- `DeviceRef`: `{ contractVersion: 1, platform: "android", namespace: string, opaqueId: string }`. `opaqueId` is an opaque identifier and is never an ADB serial, path, port, PID or third-party object.
- `StreamId`: lowercase UUID string generated once per logical stream. Rotation keeps it; every terminal stream and every explicit retry receives a new ID.
- `ViewerDescriptor`: `{ contractVersion: 1, streamId, standaloneUri, presentationModes: ["standalone"], expiresAt }`. It is non-secret and safe to log. MCP fields are not part of v1.
- `ViewerAccess`: `{ descriptor, viewerGrant }`; `viewerGrant` is secret, audience/stream/instance/expiry-bound and excluded from ordinary serialization, model output, error messages, persisted history, logs, process arguments and telemetry.
- `StreamSnapshot`: `{ streamId, deviceRef, revision, phase, reason?, epoch?, codedSize?, displaySize?, activeViewerCount, updatedAt }`; `revision` strictly increases.
- `StreamError`: `{ code, scope, disposition, safeMessage, retryAfter? }`. `scope` is `service`, `capture`, `stream`, `viewer`, `presentation` or `acceptance`; `disposition` is `recoverable`, `terminal` or `state-unknown`. Additional fields are rejected.

### Stream phases

Phases are `demand-pending`, `starting-capture`, `syncing`, `streaming`, `grace`, `interrupted`, `stopping`, `stopped`, `device-disconnected`, `failed`. In current v1, media/encoder/socket interruption may pass through `interrupted` only while device state is classified, then becomes terminal `failed` or `device-disconnected`; v1 performs no same-StreamId Capture restart.

### Error contract

| Code | Scope | Disposition | Resulting stream phase | Media END | Same-StreamId retry |
| --- | --- | --- | --- | --- | --- |
| `dependency-unavailable` | service | terminal | `failed` if stream allocated | `failed` | no |
| `adb-incompatible` | service | terminal | `failed` if stream allocated | `failed` | no |
| `runtime-bind-failed` | service | terminal | no stream or `failed` | `failed` if connected | no |
| `instance-conflict` | service | terminal | existing stream unchanged | none | no in current v1; external attach requires a later SPEC delta |
| `device-not-found` | capture | terminal | `failed` | `failed` | no |
| `device-ambiguous` | capture | terminal | `failed` | `failed` | no |
| `device-unavailable` | capture | terminal | `failed` | `failed` | no |
| `artifact-unavailable` | capture | terminal | `failed` | `failed` | no |
| `artifact-mismatch` | capture | terminal | `failed` | `failed` | no |
| `version-mismatch` | capture | terminal | `failed` | `failed` | no |
| `capture-start-failed` | capture | terminal | `failed` | `failed` | no |
| `codec-disabled` | capture | terminal | `failed` | `failed` | no |
| `codec-config-error` | capture | terminal | `failed` | `failed` | no |
| `unsupported-codec` | capture | terminal | `failed` | `failed` | no |
| `malformed-media` | stream | terminal | `failed` | `failed` | no |
| `malformed-control` | viewer | terminal | stream unchanged or `grace` if last Viewer | none | new authenticated connection only |
| `start-timeout` | stream | terminal | `failed` | `failed` | no |
| `quality-target-unmet` | acceptance | terminal | `failed` | `failed` | no |
| `backpressure-gap` | stream | recoverable | `syncing` | none | yes, from retained session/config + next key only |
| `backpressure-timeout` | stream | terminal | `failed` | `failed` | no |
| `runtime-overload` | stream | terminal | `failed` | `failed` | no |
| `stream-interrupted` | stream | state-unknown | `interrupted`, then `failed` or `device-disconnected` | final classified reason | no in v1 |
| `device-disconnected` | capture | terminal | `device-disconnected` | `device-disconnected` | no |
| `slow-consumer` | viewer | terminal | stream unchanged or `grace` if last Viewer | none | Viewer may pair again within stream policy |
| `viewer-unsupported` | viewer | terminal | stream unchanged or `grace` | none | no on same surface |
| `viewer-limit-reached` | viewer | terminal | existing stream unchanged | none | after existing Viewer leaves |
| `unauthorized` | viewer | terminal | existing stream unchanged | none | obtain a new pairing grant |
| `presentation-blocked` | presentation | recoverable | stream unchanged | none | use protected standalone presentation |
| `acceptance-failed` | acceptance | terminal | stream stops normally or `failed` | matching operational reason | no support claim |

`retryAfter` is absent in v1 except where a future minor version defines a bounded recoverable delay; clients must not invent one. Media END reason codes are `1=explicit-stop`, `2=lease-expired`, `3=device-disconnected`, `4=failed`. Final `StreamSnapshot.phase`, `StreamError` and END reason must describe the same terminal cause.

### Compatibility and secret lifetimes

- Media protocol major is `1`; unknown majors fail closed. Minor additions must preserve required fields and semantics. No external launch/attach control protocol is part of the current contract.
- Browser-visible pairing code is exactly eight uppercase Crockford Base32 characters excluding `I`, `L`, `O` and `U`, generated independently from CSPRNG output. It is a human comparison value, not a bearer: bound to one pending pairing/instance/StreamId/browser session, limited to five failed comparisons, single-use and expired after 60 seconds.
- ViewerGrant, bootstrap grant and media-session tokens are independent unpadded base64url values with at least 128 CSPRNG bits, stored only as context-bound constant-time comparison material and revoked on stop, Runtime exit or policy violation.
- The authenticated media session is bound to instance/StreamId/audience, has a 60-second reconnect TTL, and is revoked on stop, Runtime exit or policy violation. Visible-demand renewal occurs at least every 2 seconds; the server-authoritative lease expires 5 seconds after the last valid visible renewal.
- Current v1 allows exactly one active Viewer; a second request fails before grant, lease or queue allocation. Any multi-Viewer or MCP contract requires a new SPEC delta.
- Only a freshly painted frame permits the Viewer to present `Live`.

## v1 Serialization and Secret-Safety Rules

- JSON values use exact listed keys; validators reject additional keys, non-finite numbers, coercion and prototypes other than an ordinary object or `null` prototype. All current-v1 `retryAfter` fields are rejected because v1 never emits one.
- `namespace` is 1..64 lowercase ASCII characters matching `[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*`. `DeviceRef.opaqueId` and `StreamId` are canonical lowercase, non-nil RFC 4122 variant-1/version-4 UUIDs matching `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`; they are application identities, never Android locators.
- `expiresAt` and `updatedAt` are integer Unix epoch milliseconds in `0..Number.MAX_SAFE_INTEGER`. Runtime deadline enforcement still uses a monotonic clock; serialized wall-clock values are descriptive and cannot extend a lease or capability.
- Serialized `Size` is exactly `{ width, height }`, where both values are integers in `1..4294967295`. `revision` is an integer in `1..Number.MAX_SAFE_INTEGER`; optional `epoch` has the same positive range; `activeViewerCount` is exactly `0` or `1`.
- `StreamSnapshot.reason`, when present, is a current error `code`, `explicit-stop` or `lease-expired`. It is absent from nonterminal snapshots except `stream-interrupted` while phase is `interrupted`; terminal phase/reason consistency follows the error table and END mapping.
- `StreamError.safeMessage` is NFC-normalized UTF-8 text of 1..512 bytes with no C0/C1 control, line-separator or paragraph-separator code point. It contains no secret, device locator, path, stack or third-party error object. Current v1 rejects `retryAfter` and any additional key.
- `standaloneUri` is exactly `http://127.0.0.1:<port>/viewer/<streamId>`, where port is decimal `1..65535` with no leading zero and `streamId` is the descriptor's canonical ID. Username, password, query, fragment, percent-encoding, alternate host/path and pairing secrets are forbidden.
- A Viewer grant's wire value is unpadded base64url ASCII, 22..2048 characters, created from at least 128 CSPRNG bits. The Contracts factory stores the raw immutable string only in an ECMAScript private field of a frozen grant wrapper; ordinary property/symbol enumeration cannot reach it. String/default primitive conversion, `toJSON()` and `Symbol.for("nodejs.util.inspect.custom")` return `[REDACTED]`; only an explicitly named reveal operation at the protected owner boundary returns the raw value. The factory returns a frozen `ViewerAccess`: its deeply frozen `descriptor` is enumerable, its frozen grant wrapper is readable but non-enumerable/non-writable/non-configurable, `toJSON()` returns exactly `{ descriptor }`, and the Node inspect hook shows the descriptor plus a redacted grant.
- Media header `sequence`, `epoch` and `ptsUs` are represented as `bigint`; fixed-width number fields remain integers in their specified unsigned ranges. The current decoder accepts only major `1`, minor `0`, `headerBytes=40` and known kinds/flags. An unknown minor fails closed today. A future minor decoder may accept earlier minors, but no minor may reinterpret an existing field, kind or required semantic.

## iOS WDA Standalone Contract

本节替代上文 control v1、仅 Android 和仅 media minor 0 的限制；未列变更的严格序列化、安全与 Android 行为不变。

- Control clean cutover 为 v2：`DeviceRef={contractVersion:2,platform:"android"|"ios",namespace,opaqueId}`；ViewerDescriptor 及所有携带 control version 的共享值、validator、Runtime canonical bytes 和调用方同步迁移。不保留 v1 shim。StreamSnapshot 继续复用同一 DeviceRef。
- namespace 与 canonical v4 UUID 规则不变；身份不含 provider、UDID、endpoint、端口、Session ID 或路径。更换 Adapter 不改变逻辑设备身份。额外字段、v1 和未知 platform 拒绝。
- 不新增 WDA 专用公共错误。初次连接失败为 `dependency-unavailable`；非法 HTTP、multipart、JPEG 或像素限制为 `malformed-media`；source EOF/reset 为 `stream-interrupted` 后 failed，不推断 device-disconnected。首次 paint 超时为 `start-timeout`。
- MJPEG 的 `stream-interrupted` 允许同 CaptureSession 在 2 秒 stale 后恢复；12 秒无当前 epoch 新 paint 则 failed。此规则不是 Capture restart，Android interruption 语义不变。
- FSQV H.264 major 1/minor 0 字节不变；MJPEG 使用 major 1/minor 1、相同 40 字节 envelope 与序列字段、FourCC `mjpg=0x6d6a7067`、timebase 1,000,000。未知版本 fail closed。
- MJPEG Session 保留 coded/display size；Config 禁止；Frame 是一个完整 JPEG，key=1，PTS 是 host-arrival elapsed microseconds。End reason/order 不变。
- MJPEG reason-3 GAP 释放旧 epoch watermark 后，只接受严格更高 epoch Session→key JPEG，不含 Config。reason 1/2 不用于普通 MJPEG replacement。H.264 replay grammar 不变。
- Minor-1 ACK 精确为 `{v:1,type:"ack",sequence:<decimal-u64>,paintedSequence:<decimal-u64>}`。paintedSequence 初始 0，单调且 ≤sequence，必须对应当前 stream 已发送 Frame；重复幂等，未来、未知、回退值拒绝。只有当前 epoch advancement 证明 freshness；release-only 不算 paint。Minor 0 ACK 原样保留。

## ACK/profile Contract

本节覆盖相应 ACK 语义，不改变 control v2、媒体 envelope 或 H.264 minor0。

- Minor1 ACK 恰好为 `{v:1,type:"ack",sequence:<canonical-u64-string>,paintedSequence:<canonical-u64-string>}`；两个值均为十进制字符串0..18446744073709551615，除0外无前导零。Minor0 保持其精确三字段 ACK。
- 新增 release/paint 水位必须标识该连接实际已发送的 Frame，不能用 Session/GAP 序列代替；paint≤release，初始paint=0且不可回退。已作 release-only 完成的图像不能事后补 paint；旧 release 也不得跳过 paint 校验。
- 当前已接受 paint 的重复幂等，但不刷新 freshness/租约；在 paint 已推进后重放较旧 paint 属于回退，不承诺任意历史 ACK 可重放。已知旧 epoch/旧可见周期 ACK 可清理既有所有权，但不能恢复 Live 或刷新当前 freshness。
- 一次 draw 或 discard 完成并关闭图像后立即发送一条合并 minor1 ACK：paint 推进两水位，discard 只推进 release。不能拆成先 release 后补 paint，也不能等待四帧或 lease tick。媒体模式/额度由 Runtime 接受的 Session 决定，不由客户端字段选择。


