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


## Local RuntimeControl Values v1

本节定义已确认的 `ANDROID-RUNTIME-CONTROL-MACOS-02` 本机cross-process control值；不启用CLI、wait/watch、Windows、iOS或Model Context Protocol。

### Exact values and local/serialized split

- `ControlVersion`恰好为 `{major:1,minor:0}`；与Contracts `contractVersion:2`和FSQV media版本独立。`RuntimeTarget`恰好为 `{instanceId,generation}`，两者都是canonical non-nil RFC4122 variant-1/version-4 UUID。
- `DeviceSelector`恰好为 `{kind:"auto",platform:"android"}` 或 `{kind:"known",deviceRef:DeviceRef}`；额外字段、iOS/未知platform和错误prototype拒绝。auto允许首次生成或复用安全DeviceRef；known从不生成、重映射或修改identity。
- `RuntimeInstance`恰好为 `{controlVersion,instanceId,generation,contractVersion:2,deviceRef,features:[]}`。`RuntimeAttachment`恰好为 `{disposition:"started"|"attached",instance}`；`AcquireRuntimeRequest`恰好为 `{mode:"attach-only"|"start-or-attach",selector}`；serialized `AcquireRuntimeValue`恰好为 `{attachment}`。
- `HelloControlValue`恰好为 `{instance:RuntimeInstance}`。`EnsureViewerValue`恰好为 `{deviceRef,descriptor:ViewerDescriptor,snapshot:StreamSnapshot}`。`InspectControlValue`恰好为 `{snapshot,changes,reset}`。`StopStreamValue`恰好为 `{snapshot}`。owner-only `ApproveViewerValue`恰好为 `{snapshot,approvedAt}`；`approvedAt`是`0..Number.MAX_SAFE_INTEGER`的integer Unix epoch milliseconds。owner-only `ShutdownRuntimeValue`恰好为 `{instanceId,generation}`。
- `ControlWireValue`只包含本节列出的plain serialized values。generic `ControlResult<T extends ControlWireValue>`恰好为 `{ok:true,value:T}|{ok:false,error:ControlError}`。只有stop expectedRevision mismatch使用 `{ok:false,error:RevisionConflictError,snapshot:StreamSnapshot}`；任何其他失败禁止`snapshot`。
- `RuntimeControlSession`、control/owner methods、`AbortSignal`、socket、credential、ViewerGrant、pairingId及provider object不是`ControlWireValue`，不得传给generic serializer。Runtime本地成功acquire类型必须使用独立的`{ok:true,session:RuntimeControlSession}`分支，不能把含方法的session放入serialized `ControlResult`。
- local session的唯一enumerable own property是深冻结`attachment`；control保存于ECMAScript private field并由prototype getter取得。`Object.keys`、ordinary/symbol enumeration只能看见`attachment`；`toValue()`和`toJSON()`恰好返回深冻结`{attachment}`；Node custom inspect恰好显示`{attachment}`。普通`RuntimeControlSession`从不持有或暴露owner control。

### Canonical Control JSON

- control request/response body使用`CanonicalControlJson`：UTF-8、无BOM、无前后空白、无insignificant whitespace、一个top-level object、无duplicate key。只接受ordinary object或null-prototype object；拒绝array作为top level、非finite/coerced/exponent/negative-zero number、错误prototype、accessor、symbol和额外字段。
- encoder等价于对已严格验证且按下列固定key order构造的plain DTO执行ECMAScript `JSON.stringify`，再以UTF-8编码。client发送的bytes经strict parse和相同encoder重新编码后必须逐byte相等；否则为`malformed-control`。`Content-Length`、12KiB changes与16KiB body limit均只计body的实际UTF-8 octets，不计headers。
- 固定nested key order为：`ControlVersion: major,minor`；`RuntimeTarget: instanceId,generation`；`DeviceRef: contractVersion,platform,namespace,opaqueId`；`RuntimeInstance: controlVersion,instanceId,generation,contractVersion,deviceRef,features`；`RuntimeAttachment: disposition,instance`；`ControlError: controlVersion,code,disposition,operationState,safeMessage`；`RevisionConflictError`同顺序并以`code`置于`controlVersion`后。`ViewerDescriptor`、`StreamSnapshot`及其nested `Size`沿用Contracts v2声明的field order；合法optional field缺失时省略，wire request中下文声明为nullable的field必须出现且使用`null`，不得省略。
- top-level result key order恰好为success `ok,value`、ordinary failure `ok,error`、revision conflict `ok,error,snapshot`。array保持语义顺序；`features`在本feature恰好为空数组。
- `InspectControlValue`最多16个`changes`，且canonical `changes` array最多12288 bytes；完整canonical response body最多16384 bytes。任一changes cap超出时不得切prefix，改为`{snapshot:current,changes:[],reset:true}`；该fallback完整response仍超16384 bytes时返回`runtime-overload`。边界值16、12288和16384允许，任一超过1即不允许。

### Exact control errors

`ControlError`恰好为 `{controlVersion,code,disposition,operationState,safeMessage}`；validator必须按下表接受唯一tuple和唯一message，拒绝任何其他组合、额外字段、raw cause或stack。HTTP列是authenticated route的映射；`local`表示只由local acquire/client cancellation产生。

| code | disposition | operationState | safeMessage | HTTP | 精确适用条件 |
| --- | --- | --- | --- | ---: | --- |
| `instance-not-found` | `recoverable` | `not-applied` | `No matching Runtime is available.` | 404 | attach-only无listener，或known slot不存在 |
| `instance-conflict` | `terminal` | `not-applied` | `The Runtime identity does not match.` | 409 | authenticated DeviceRef/target/full generation不匹配 |
| `control-version-mismatch` | `terminal` | `not-applied` | `The RuntimeControl version is incompatible.` | 409 | control major/minor或Contracts version不兼容 |
| `unauthorized` | `terminal` | `not-applied` | `Authorization failed.` | 401 | ensure owner grant已过期；approve pending/code/grant无效。wire bearer失败使用固定transport 401，不产生identity-bearing body |
| `malformed-control` | `terminal` | `not-applied` | `The control request is invalid.` | 400 | canonical/schema/value/unknown stream/非法revision失败 |
| `deadline-exceeded` | `state-unknown` | `unknown` | `The control operation deadline was exceeded; its outcome is unknown.` | 504/local | dispatch、readiness或mutation可能已线性化后，response budget或cancel先结束本地等待 |
| `request-cancelled` | `recoverable` | `not-applied` | `The control request was cancelled before it was applied.` | local | 能证明spawn/readiness/mutation线性化前取消获胜 |
| `runtime-exited` | `state-unknown` | `unknown` | `The Runtime exited before its result was known.` | 503 | spawn后child/authority/connection异常终止且无法协调结果 |
| `runtime-overload` | `recoverable` | `not-applied` | `The Runtime control plane is at capacity.` | 429 | socket/request/history/response/internal admission cap |
| `dependency-unavailable` | `terminal` | `not-applied` | `Required dependency is unavailable.` | 503 | Capture resolver同名failure |
| `adb-incompatible` | `terminal` | `not-applied` | `ADB is incompatible.` | 503 | Capture resolver同名failure |
| `device-not-found` | `terminal` | `not-applied` | `Device was not found.` | 404 | Capture resolver同名failure |
| `device-ambiguous` | `terminal` | `not-applied` | `Device selection is ambiguous.` | 409 | Capture resolver同名failure或published binding不同 |
| `device-unavailable` | `terminal` | `not-applied` | `Device is unavailable.` | 503 | Capture resolver同名failure |
| `artifact-unavailable` | `terminal` | `not-applied` | `Artifact is unavailable.` | 503 | Capture resolver同名failure |
| `artifact-mismatch` | `terminal` | `not-applied` | `Artifact verification failed.` | 412 | Capture resolver同名failure |
| `local-state-recovery-required` | `terminal` | `not-applied` | `Local Runtime state requires owner recovery.` | 409 | persistent corruption、credential/state不一致或occupied port ownership不确定 |

- `RevisionConflictError`恰好为 `{controlVersion,code:"revision-conflict",disposition:"recoverable",operationState:"not-applied",safeMessage:"The expected revision does not match."}`，HTTP 409且必须携带unchanged current snapshot；任何其他error禁止snapshot。
- Capture resolver七个fixed errors逐code、逐safeMessage映射，不包装原异常。现有in-process ensure的`malformed-control|runtime-overload|unauthorized`同名映射；inspect unknown stream/afterRevision非法映射`malformed-control`；stop expectedRevision mismatch唯一映射`revision-conflict`。Runtime control startup bind失败不向union新增`runtime-bind-failed`，而按是否存在可协调listener映射`instance-conflict|runtime-exited|local-state-recovery-required`。
- 所有值沿用Contracts v2 canonical UUID/time/size/string安全规则；control值不得含provider、serial、endpoint、path、PID、root/client/owner credential、ViewerGrant、pairingId、cookie、media或Appium Session字段。
