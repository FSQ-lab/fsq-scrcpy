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
| `slow-consumer` | viewer | terminal | stream unchanged or `grace` if last Viewer | none | same media session may reconnect within grace; otherwise authenticated Agent ensure/show Viewer after slot release |
| `viewer-unsupported` | viewer | terminal | stream unchanged or `grace` | none | no on same surface |
| `viewer-limit-reached` | viewer | terminal | existing stream unchanged | none | after existing Viewer leaves |
| `unauthorized` | viewer | terminal | existing stream unchanged | none | authenticated Agent再次ensure并重新展示Viewer |
| `presentation-blocked` | presentation | recoverable | stream unchanged | none | use protected standalone presentation |
| `acceptance-failed` | acceptance | terminal | stream stops normally or `failed` | matching operational reason | no support claim |

`retryAfter` is absent in v1 except where a future minor version defines a bounded recoverable delay; clients must not invent one. Media END reason codes are `1=explicit-stop`, `2=lease-expired`, `3=device-disconnected`, `4=failed`. Final `StreamSnapshot.phase`, `StreamError` and END reason must describe the same terminal cause.

### Compatibility and secret lifetimes

- Media protocol major is `1`; unknown majors fail closed. Minor additions must preserve required fields and semantics. No external launch/attach control protocol is part of the current contract.
- Auto-bootstrap permit与claim/media-session token相互独立；permit恰为30000ms monotonic状态且不序列化，claim/media token为context-bound CSPRNG值并尽可能只存digest。
- Claim和media-session token从不进入公共DTO；media session仍绑定instance/StreamId/audience、具有60秒reconnect TTL，并在stop、Runtime exit或policy violation时撤销。
- The authenticated media session is bound to instance/StreamId/audience, has a 60-second reconnect TTL, and is revoked on stop, Runtime exit or policy violation. Visible-demand renewal occurs at least every 2 seconds; the server-authoritative lease expires 5 seconds after the last valid visible renewal.
- Current v1 allows exactly one active Viewer; a second request fails before claim, lease or queue allocation. Any multi-Viewer or MCP App contract requires a new SPEC delta.
- Only a freshly painted frame permits the Viewer to present `Live`.

## v1 Serialization and Secret-Safety Rules

- JSON values use exact listed keys; validators reject additional keys, non-finite numbers, coercion and prototypes other than an ordinary object or `null` prototype. All current-v1 `retryAfter` fields are rejected because v1 never emits one.
- `namespace` is 1..64 lowercase ASCII characters matching `[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*`. `DeviceRef.opaqueId` and `StreamId` are canonical lowercase, non-nil RFC 4122 variant-1/version-4 UUIDs matching `[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}`; they are application identities, never Android locators.
- `expiresAt` and `updatedAt` are integer Unix epoch milliseconds in `0..Number.MAX_SAFE_INTEGER`. Runtime deadline enforcement still uses a monotonic clock; serialized wall-clock values are descriptive and cannot extend a lease or capability.
- Serialized `Size` is exactly `{ width, height }`, where both values are integers in `1..4294967295`. `revision` is an integer in `1..Number.MAX_SAFE_INTEGER`; optional `epoch` has the same positive range; `activeViewerCount` is exactly `0` or `1`.
- `StreamSnapshot.reason`, when present, is a current error `code`, `explicit-stop` or `lease-expired`. It is absent from nonterminal snapshots except `stream-interrupted` while phase is `interrupted`; terminal phase/reason consistency follows the error table and END mapping.
- `StreamError.safeMessage` is NFC-normalized UTF-8 text of 1..512 bytes with no C0/C1 control, line-separator or paragraph-separator code point. It contains no secret, device locator, path, stack or third-party error object. Current v1 rejects `retryAfter` and any additional key.
- `standaloneUri` is exactly `http://127.0.0.1:<port>/viewer/<streamId>`, where port is decimal `1..65535` with no leading zero and `streamId` is the descriptor's canonical ID. Username, password, query, fragment, percent-encoding, alternate host/path and authorization secrets are forbidden.
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

本节定义已确认的本机 cross-process RuntimeControl 值；Android RuntimeControl/wait 基线与 `IOS-RUNTIME-CLI-MACOS-10` 共用同一 ControlVersion 和 wire values。CLI wait/watch 与 iOS Runtime 复用既有值，不增加 route 或 wire 字段；Windows 与 Model Context Protocol 仍未启用。

### Exact values and local/serialized split

- `ControlVersion`恰好为 `{major:1,minor:0}`；与Contracts `contractVersion:2`和FSQV media版本独立。`RuntimeTarget`恰好为 `{instanceId,generation}`，两者都是canonical non-nil RFC4122 variant-1/version-4 UUID。
- `DeviceSelector`恰好为 `{kind:"auto",platform:"android"|"ios"}` 或 `{kind:"known",deviceRef:DeviceRef}`；额外字段、未知platform和错误prototype拒绝。auto允许为所选平台首次生成或复用安全DeviceRef；known接受已验证的 Android/iOS DeviceRef，且从不生成、重映射或修改identity。
- `RuntimeInstance`恰好为 `{controlVersion,instanceId,generation,contractVersion:2,deviceRef,features:["wait-v1","auto-bootstrap-v1","mcp-app-v1"]}`；feature tuple deep-frozen且不接受空/旧/额外/重复/未知/乱序值。`RuntimeAttachment`恰好为 `{disposition:"started"|"attached",instance}`；`AcquireRuntimeRequest`恰好为 `{mode:"attach-only"|"start-or-attach",selector}`；serialized `AcquireRuntimeValue`恰好为 `{attachment}`。
- `HelloControlValue`恰好为 `{instance:RuntimeInstance}`。`EnsureViewerValue`恰好为 `{deviceRef,descriptor:ViewerDescriptor,snapshot:StreamSnapshot}`。`InspectControlValue`恰好为 `{snapshot,changes,reset,timedOut}`。`StopStreamValue`恰好为 `{snapshot}`。owner-only `ShutdownRuntimeValue`恰好为 `{instanceId,generation}`。
- `ControlWireValue`只包含本节列出的plain serialized values。generic `ControlResult<T extends ControlWireValue>`恰好为 `{ok:true,value:T}|{ok:false,error:ControlError}`。只有stop expectedRevision mismatch使用 `{ok:false,error:RevisionConflictError,snapshot:StreamSnapshot}`；任何其他失败禁止`snapshot`。
- `RuntimeControlSession`、control/owner methods、`AbortSignal`、socket、credential、permit、claim/media cookie及provider object不是`ControlWireValue`，不得传给generic serializer。Runtime本地成功acquire类型必须使用独立的`{ok:true,session:RuntimeControlSession}`分支。
- local session的唯一enumerable own property是深冻结`attachment`；control保存于ECMAScript private field并由prototype getter取得。`Object.keys`、ordinary/symbol enumeration只能看见`attachment`；`toValue()`和`toJSON()`恰好返回深冻结`{attachment}`；Node custom inspect恰好显示`{attachment}`。普通`RuntimeControlSession`从不持有或暴露owner control。

### Canonical Control JSON

- control request/response body使用`CanonicalControlJson`：UTF-8、无BOM、无前后空白、无insignificant whitespace、一个top-level object、无duplicate key。只接受ordinary object或null-prototype object；拒绝array作为top level、非finite/coerced/exponent/negative-zero number、错误prototype、accessor、symbol和额外字段。
- encoder等价于对已严格验证且按下列固定key order构造的plain DTO执行ECMAScript `JSON.stringify`，再以UTF-8编码。client发送的bytes经strict parse和相同encoder重新编码后必须逐byte相等；否则为`malformed-control`。`Content-Length`、12KiB changes与16KiB body limit均只计body的实际UTF-8 octets，不计headers。
- 固定nested key order为：`ControlVersion: major,minor`；`RuntimeTarget: instanceId,generation`；`DeviceRef: contractVersion,platform,namespace,opaqueId`；`RuntimeInstance: controlVersion,instanceId,generation,contractVersion,deviceRef,features`；`RuntimeAttachment: disposition,instance`；`ControlError: controlVersion,code,disposition,operationState,safeMessage`；`RevisionConflictError`同顺序并以`code`置于`controlVersion`后。`ViewerDescriptor`、`StreamSnapshot`及其nested `Size`沿用Contracts v2声明的field order；合法optional field缺失时省略，wire request中下文声明为nullable的field必须出现且使用`null`，不得省略。
- top-level result key order恰好为success `ok,value`、ordinary failure `ok,error`、revision conflict `ok,error,snapshot`。array保持语义顺序；`features`恰好为`["wait-v1","auto-bootstrap-v1","mcp-app-v1"]`；InspectControlValue固定order为`snapshot,changes,reset,timedOut`。
- Inspect/wait normalizer最多16个`changes`，canonical `changes` array最多12288 bytes，完整canonical response body最多16384 bytes。任一cap超出不得切prefix，改为`{snapshot:current,changes:[],reset:true,timedOut:false}`；fallback仍超16384时返回runtime-overload。边界值16、12288和16384允许，任一超过1即不允许。

### Exact control errors

`ControlError`恰好为 `{controlVersion,code,disposition,operationState,safeMessage}`；validator必须按下表接受唯一tuple和唯一message，拒绝任何其他组合、额外字段、raw cause或stack。HTTP列是authenticated route的映射；`local`表示只由local acquire/client cancellation产生。

| code | disposition | operationState | safeMessage | HTTP | 精确适用条件 |
| --- | --- | --- | --- | ---: | --- |
| `instance-not-found` | `recoverable` | `not-applied` | `No matching Runtime is available.` | 404 | attach-only无listener，或known slot不存在 |
| `instance-conflict` | `terminal` | `not-applied` | `The Runtime identity does not match.` | 409 | authenticated DeviceRef/target/full generation不匹配 |
| `control-version-mismatch` | `terminal` | `not-applied` | `The RuntimeControl version is incompatible.` | 409 | control major/minor或Contracts version不兼容 |
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
- Capture resolver七个fixed errors逐code、逐safeMessage映射，不包装原异常。现有in-process ensure只映射`malformed-control|runtime-overload`；inspect unknown stream/afterRevision非法映射`malformed-control`；stop expectedRevision mismatch唯一映射`revision-conflict`。Runtime control startup bind失败按是否存在可协调listener映射`instance-conflict|runtime-exited|local-state-recovery-required`。
- 所有值沿用Contracts v2 canonical UUID/time/size/string安全规则；control值不得含provider、serial、endpoint、path、PID、root/client/owner credential、permit、claim/media cookie、media或Appium Session字段。

## RuntimeControl Bounded Wait v1

本节bounded-wait值与当前`features:["wait-v1","auto-bootstrap-v1","mcp-app-v1"]`及四字段inspect/wait共同构成active契约。

### Exact values and feature cutover

- `ControlVersion`保持exact `{major:1,minor:0}`。`RuntimeInstance.features`当前为deep-frozen exact tuple `["wait-v1","auto-bootstrap-v1","mcp-app-v1"]`；旧tuple、空、额外、重复、未知或乱序全部拒绝，不保留alias/shim/fallback。新client对旧Runtime返回`control-version-mismatch`，不得轮询降级、kill或替换；owner显式shutdown/restart是唯一cutover路径。
- `InspectControlValue` clean cutover为exact `{snapshot,changes,reset,timedOut}`，固定key order同此顺序。inspect成功总是`timedOut:false`；wait的change/reset/terminal成功也为false。`reset:true`要求`changes=[] && timedOut:false`；`timedOut:true`要求`changes=[] && reset:false`；非空changes要求两者均false。
- ordinary `RuntimeControl`在inspect与stopStream之间新增`wait({streamId,afterRevision,waitMs},{signal?}) -> Promise<ControlResult<InspectControlValue>>`。input为exact plain readonly三字段；afterRevision为正safe integer，waitMs为`0..30000` safe integer；拒绝negative-zero、coercion、fraction、额外字段。AbortSignal仍仅local且不序列化；session enumeration/JSON/inspect及owner authority边界不变。

### Canonical wire and observation

- 新增client-authority `POST /v1/stream/wait`；request exact `{controlVersion,target,streamId,afterRevision,waitMs}`且五字段全部必需，canonical order同此顺序。成功HTTP 200使用四字段InspectControlValue；允许既有`instance-conflict|control-version-mismatch|malformed-control|runtime-exited|runtime-overload|deadline-exceeded`，local cancel为`request-cancelled`且不新增wire error。wait只读，不属于mutating routes。
- `afterRevision < current`时，cursor可由共享history完整恢复则立即返回全部`revision>afterRevision` snapshots；cursor早于`firstRetainedRevision-1`则立即返回current、空changes、`reset:true,timedOut:false`。等于`firstRetainedRevision-1`仍可完整增量。future cursor、unknown StreamId或非法值为malformed-control且零wait资源。
- `afterRevision == current`且非terminal：waitMs=0立即返回current、空changes、`reset:false,timedOut:true`；waitMs>0才注册。current已是`stopped|device-disconnected|failed`时terminal优先于zero timeout，立即返回空changes、`reset:false,timedOut:false`。
- 等待期间首个observable snapshot publication冻结结果：返回共享history中截至该publication的全部新revision，严格递增且最后一项等于returned current snapshot；之后publication不并入。若首项是stopping，调用方以新cursor再次wait取得final terminal。普通coalescing不变，wait不制造revision或server-side cursor。
- Inspect/wait共用一个cap normalizer：最多16 changes，canonical changes array最多12288 UTF-8 bytes，完整canonical ControlResult最多16384 bytes；边界值允许。任一changes/full-result cap超出时不得切prefix，改为whole current snapshot、空changes、`reset:true,timedOut:false`；fallback仍超16384则runtime-overload。timeout/terminal空changes结果自身超hard cap也runtime-overload。
- 所有现有auth-first、Host/framing/header/request-body、no-store、privacy及canonical nested order保持。ControlWireValue仍只含safe DTO，不含waiter、timer、signal、socket、cursor state或provider对象。

### Required contract verification

- Clean cutover覆盖`["wait-v1","auto-bootstrap-v1","mcp-app-v1"]`与旧/额外feature拒绝、四字段exact validator/canonical round-trip、wait request order、0/30000及非法边界、current/older/future/reset/terminal/timeout互斥、16/17 changes、12288/16384±1 bytes和无prefix fallback。
- RuntimeControlSession必须证明wait仅在control prototype、serialized session仍只有attachment、close/cancel只结束wait且不改变stream/Runtime。Integrations调用方输出exact新feature tuple与四字段inspect；Capture/Viewer serialized产品面无额外字段。

## Agent Auto-Bootstrap Contract

本节定义 `AGENT-AUTO-VIEWER-BOOTSTRAP-MACOS-ANDROID-11B` 的 Contracts clean cut，并与Root/Runtime/Viewer/Integrations同名条款共同构成active契约。

### Exact retained values and feature tuple

- `ViewerDescriptor` serialized shape、canonical key order及URI规则不变；`expiresAt`改为当前 auto-bootstrap permit 的wall-clock描述，不能延长30000ms monotonic deadline，也不是bearer。
- serialized `EnsureViewerValue`仍恰为 `{deviceRef,descriptor,snapshot}`，因此 AgentControl、MCP四工具和CLI ensure result shape不变。
- `RuntimeInstance.features`当前clean cut为deep-frozen exact tuple `['wait-v1','auto-bootstrap-v1','mcp-app-v1']`。旧tuple、空、缺失、额外、重复、未知或乱序tuple均为`control-version-mismatch`；不保留feature alias、fallback或upgrade shim。
- `DeviceRef`、StreamId、StreamSnapshot、ViewerDescriptor、ControlVersion、RuntimeTarget、RuntimeAttachment、Inspect/Wait/Stop/Shutdown values及媒体契约no-delta。

### Removed authority and error surface

- `ViewerGrant`、`ViewerAccess`、`ApproveViewerValue` 及其factory、reveal、validator、canonical order、generic union和export已删除。任何local或serialized成功ensure不得包含grant/access wrapper。
- application `ControlError` code `unauthorized` 的tuple、validator、canonical encoder和route allow-set已删除；ControlError其他tuple与`RevisionConflictError`不变。浏览器/transport固定HTTP 401及`StreamError unauthorized`继续存在。
- 保留的 `StreamError unauthorized`仍为viewer/terminal且不授予owner authority；Same-StreamId恢复恰为authenticated Agent再次ensure并重新展示Viewer，不生成pairing surface。
- owner-only `ShutdownRuntimeValue`保留；owner approve value不存在。ControlWireValue、local session和ordinary RuntimeControl不得携带permit、claim/media cookie、digest或ViewerAuthorization object。
- Runtime in-process `EnsureResult`恰为 `{ok:true,value:{descriptor:ViewerDescriptor,snapshot:StreamSnapshot}}|{ok:false,error:StreamError}`；控制面外部 `EnsureViewerValue` 仍保持safe shape。

### Verification

- Contracts验收覆盖exact feature tuple/canonical round-trip与旧tuple拒绝；removed exports/types/validators不可导入或反射；ensure/descriptor shape不变且不含secret；ControlError unauthorized拒绝而browser/StreamError unauthorized继续有效。
- 所有生产调用方、fixture和测试必须同批迁移；任何兼容re-export、deprecated alias、optional旧字段或双validator均失败。
## MCP App Viewer Contract

本节定义 `ANDROID-MCP-VIEWER-04` 的共享值边界。

- `RuntimeInstance.features` clean cut为deep-frozen exact tuple `['wait-v1','auto-bootstrap-v1','mcp-app-v1']`。旧二项tuple、空/缺失/额外/重复/未知/乱序全部为`control-version-mismatch`，不保留alias、fallback或upgrade shim。
- `DeviceRef`、ViewerDescriptor、StreamSnapshot、EnsureViewerValue、Inspect/Wait/Stop、四个MCP input/output schema、compact text mirror与canonical order no-delta。模型可见success/failure不增加embedded、Host、Origin、CSP、resource URI、permit、cookie、capability或presentation字段。
- MCP Apps标准`_meta.ui.resourceUri`与`resources/read`是presentation metadata，不属于Contracts DTO；其值不得进入Contracts validator/canonical encoder。`CallToolResult._meta`同样不得携带credential、cookie、permit、authority或媒体。
- Runtime的embedded prepare/bind是Runtime-owned受保护本机接口，不加入`ControlWireValue`、ordinary `ControlResult` generic union或公共跨项目契约。它可复用真正适用的既有ControlError，并拥有不导出的fixed `PresentationUnavailableError`；所有成功值必须secret-free。Browser Origin只在Runtime授权状态内保存，不进入snapshot、error、history或普通序列化。
- Contracts验收覆盖新exact feature tuple/canonical round-trip与旧tuple拒绝，并证明所有既有safe DTO byte-for-byte不变、无presentation/private字段；Capture与跨项目`Appium_connect_agent` seam no-delta。
