# Module: Capture

## Purpose

维护平台视频源接入与编码媒体获取。第一批只覆盖 macOS 本地宿主通过 USB 连接的 Android 设备。

## Dependencies

Capture 可依赖 Contracts。不得依赖 Runtime、Viewer 或外部 Coding Agent Adapter。

## Public Interface

当前 Android v1 通过下方 `CaptureSource` / `CaptureSession` pull interface 隐藏 scrcpy 和平台细节，并向 Runtime 提供：

- 已确认设备的视频源启动与停止。
- 编码格式及必要的初始化元数据。
- 有界的帧/包输出、错误和结束信号。
- 取消、断连及资源释放语义。

## Non-Responsibilities

- 不拥有 Viewer、MCP App 或浏览器兼容逻辑。
- 不执行 Appium 命令、设备点击、输入、页面结构读取或 Session 管理。
- 不承诺 iOS 或 macOS Capture 已实现。

## Current Invariants

- 第一批只允许一个设备和一个活跃采集流。
- 无活跃 Viewer 租约时不得长期保持无用采集。
- 默认不录制或落盘视频内容。
- Android v1 使用经版本、签名和 SHA-256 核验的 `scrcpy-server v5.0.1` metadata Adapter；兼容身份和媒体边界由下方契约固定。

## Android Capture Interface v1

### Interface

```text
CaptureSource.open({ deviceRef, videoConstraints }, cancellation) -> CaptureSession
CaptureSession.events() -> bounded async pull stream<CaptureEvent>
CaptureSession.stop(reason) -> idempotent completion
CaptureSession.closed() -> exactly one terminal result

CaptureEvent =
  SessionStarted { epoch, codec, codedSize, displaySize, timebase=1_000_000 }
| CodecConfig { epoch, bytes }
| Frame { epoch, sequence, ptsUs, key, bytes }
| SessionEnded { epoch, cause }
| Discontinuity { epoch, reason="shared-overflow", discardThroughCaptureSequence }
| CaptureEnded { cause }
| CaptureFailed { StreamError }
```

Session precedes frames. Each epoch contains exactly one normalized `CodecConfig`, emitted before every dependent frame; observing replacement config without a new epoch is terminal `malformed-media`. Frame PTS is nondecreasing within an epoch and config has no PTS. Rotation ends the old epoch and starts a new monotonically increasing epoch, not whole-stream EOF. Exactly one whole-stream terminal event is emitted. Zero-length, partial, oversized, unknown-codec or illegal-order input is a protocol error.

### `ScrcpyV501CaptureAdapter`

- The only first-batch Adapter uses `scrcpy-server v5.0.1`, commit `a60891aea193d92e7e5c3942700eca63f9d19a5f`, asset SHA-256 `764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536`.
- Audio and control sockets are disabled. Codec, session and frame metadata remain enabled. Runtime and Viewer never receive scrcpy headers or objects.
- `CodecConfig.bytes` is at most 256 KiB; `Frame.bytes` is at most 7.75 MiB (8,126,464 bytes); the Viewer-required config+key concatenation is checked before allocation and is at most 8 MiB (8,388,608 bytes). Exceeding any bound is terminal `malformed-media` with unified cleanup. Capture→Runtime media queue is at most 16 packets or 16 MiB, whichever fills first. The separate non-droppable session/config/state/terminal lane is at most 64 messages or 512 KiB; overflow is terminal `runtime-overload`.
- Artifact verification order is pinned key fingerprints → detached checksum signature → unique asset checksum line → pinned digest → streamed asset digest → atomic private cache. Cache is rehashed before every device push.
- ADB is resolved from explicit configuration before PATH, version is recorded, and bounded checks cover server/device/shell/push and owned tunnel create/remove. The Adapter never kills or replaces the global ADB server.
- Cancellation must interrupt reads and child waits. Stop/EOF/failure share idempotent cleanup for owned sockets, tunnel, device process, pushed artifact and temporary files. In current v1, recoverable media/encoder/socket interruption ends this CaptureSession and becomes terminal for the logical stream after device-state classification; automatic same-StreamId Capture restart requires a later SPEC delta.

## WP2 Exact Capture Contract

### Public input and device resolution

- Adapter protocol version is `1`. `OpenCaptureRequest` is exactly `{ deviceRef, videoConstraints }`; `videoConstraints` is exactly `{ codec:"h264", minShortEdge:720, maxFps:30, bitRate:8000000, noCrop:true, noUpscale:true }`. Any additional key or other value fails closed. The Adapter never crops or upscales; each session is rejected as `quality-target-unmet` if its short edge is below 720.
- Current namespace is exactly `fsq.android.local`. Construction receives an in-process immutable registry of `{ opaqueId: canonical v4 UUID, serial: internal ADB serial }` entries. `open()` requires exactly one matching alias; zero and multiple mappings become `device-not-found` and `device-ambiguous`. The resolved serial must then be the unique authorized online device or fails per the fixed error mapping below. Serial never enters `DeviceRef`, public events, safe errors or ordinary/model output.
- `CaptureAdapterConfig` is exactly `{ adbPath?, cacheRoot, deviceRegistry, artifactSource }`. `adbPath`, when present, and `cacheRoot` are normalized absolute host paths without `..`; `deviceRegistry` is the immutable entry list above. `artifactSource` is exactly `{ mode:"online" }` or `{ mode:"offline", keyFile, checksumFile, signatureFile, serverFile }`, whose four paths obey the same absolute-path rule. Symlink/regular-file checks occur at use time.
- Error mapping is fixed: absent ADB executable is `dependency-unavailable`; unusable ADB version/reverse capability is `adb-incompatible`; unknown alias is `device-not-found`; duplicate alias/serial is `device-ambiguous`; mapped but offline/unauthorized device, device command timeout or bounded-output overflow is `device-unavailable`; artifact read/network/redirect/cache-lock timeout is `artifact-unavailable`; identity/signature/size/digest failure is `artifact-mismatch`; server spawn/connect deadline is `start-timeout`; other spawn failure is `capture-start-failed`. Safe messages expose none of the paths or serials.

### Pinned v5.0.1 launch and wire grammar

- One 31-bit positive random `scid` creates abstract socket `scrcpy_<eight-lowercase-hex>` and remote path `/data/local/tmp/fsq-scrcpy-<eight-lowercase-hex>.jar`. The host listens on `127.0.0.1` before creating only `adb reverse localabstract:<socket> tcp:<port>`; no forward fallback is permitted.
- Host executes, without a host shell, `adb -s <serial> shell CLASSPATH=<remote-path> app_process / com.genymobile.scrcpy.Server 5.0.1 scid=<hex> log_level=warn audio=false control=false video=true video_codec=h264 video_bit_rate=8000000 max_fps=30 downsize_on_error=false cleanup=true send_device_meta=false send_frame_meta=true send_dummy_byte=false send_stream_meta=true`. No unlisted option or fallback server/version is allowed.
- The single accepted socket begins with big-endian codec `u32`: `0x68323634` is H.264, `0` is `codec-disabled`, `1` is `codec-config-error`, and every other value is `unsupported-codec`. No dummy byte or 64-byte device metadata is present.
- Each following header is exactly 12 big-endian bytes. A session header is `{ flags:u32, width:u32, height:u32 }`: `flags` bit 31 is one, bit 0 is `clientResized`, and bits 1..30 are zero; width and height are positive and there is no payload. A media header is `{ ptsAndFlags:u64, payloadBytes:u32 }`: bit 63 is zero, bits 62/61 are config/key, and bits 60..0 are nonnegative `ptsUs`; payload length is checked before allocation/read. Config+key together, zero length, unknown bits, partial header/payload or a declared length beyond the applicable limit is `malformed-media`; a zero-byte read exactly at a header boundary enters device-state classification.

### Normalized events, ordering and bounded storage

- `epoch` starts at `1` and increments by one for every session header. Frame `sequence` is `bigint`, starts at `1` and strictly increments across the whole CaptureSession without resetting on rotation. Frame `ptsUs` is `bigint` and nondecreasing within an epoch. With no crop, `displaySize` equals `codedSize`.
- `SessionEndCause` is `reconfigured|explicit-stop|cancelled|device-disconnected|failed`. `CaptureEnded.cause` is `explicit-stop|cancelled`; all abnormal completion uses exactly one `CaptureFailed { error }`. `closed()` caches and returns `{ status:"ended", cause }` or `{ status:"failed", error }` for the first terminal-cause winner.
- The public `CaptureEvent` union additionally includes `Discontinuity { epoch, reason:"shared-overflow", discardThroughCaptureSequence }`; that watermark is explicitly a Capture Frame sequence, never a Runtime envelope sequence.
- Every epoch is `SessionStarted → exactly one CodecConfig → first key Frame → later Frames`. A second config in one epoch is terminal, not merged. Before config or the first key, ordinary frames are discarded. Rotation is `SessionEnded{reconfigured} → SessionStarted → CodecConfig → key`. Stop/cancel with an active epoch emits its final `SessionEnded` then one `CaptureEnded`; abnormal completion with an active epoch emits its final `SessionEnded` then one `CaptureFailed`. Before any `SessionStarted`, stop/cancel emits only `CaptureEnded` and abnormal completion only `CaptureFailed`; no epoch is fabricated. No event follows the terminal event.
- Media storage contains at most 16 Frames or 16 MiB. The separate control lane contains at most 64 events or 512 KiB and holds session/config/discontinuity/terminal events. A single monotonically increasing source ordinal merges both lanes; a control barrier prevents a Frame from crossing its session/config/discontinuity/terminal event.
- Media overflow atomically releases queued Frames through their highest Capture sequence, emits `Discontinuity { epoch, reason:"shared-overflow", discardThroughCaptureSequence }`, discards delta frames until the next same-epoch key, and never silently blocks the device/socket indefinitely. Runtime translates the Capture watermark per Viewer to the highest already-assigned frame-envelope sequence whose source Capture sequence is at or below it; that translated value is the Runtime GAP `discardThroughSequence`. Control overflow is terminal `runtime-overload`; absence of config+key for 5 seconds after session/discontinuity is terminal `backpressure-timeout`.

### Artifact acquisition and private cache

- Verification limits are: public key 256 KiB, checksum text 1 MiB, detached signature 256 KiB, server exactly 733,930 bytes with a 1 MiB hard read ceiling. Online acquisition uses HTTPS, connect timeout 10 seconds, read-idle timeout 10 seconds, total timeout 60 seconds and at most three redirects. Allowed hosts are `github.com`, `release-assets.githubusercontent.com`, `objects.githubusercontent.com` and `blog.rom1v.com`; redirects may not downgrade scheme or leave the allowlist.
- Acquisition mode is either online pinned URLs or offline with all four explicit regular files (key, checksum, signature, server); mixing modes is rejected. Offline inputs pass the identical byte limits, signature/fingerprint/checksum/digest flow and are copied into cache before use.
- The cache root and every identity directory are mode `0700`; artifact/metadata files are `0600`. Operations reject symlinks and non-regular inputs, hold an exclusive per-identity lock, write same-directory exclusive temporary files, fsync file and directory, then rename atomically. Verification failure deletes the temporary file; a bad existing cache entry is quarantined or deleted and never pushed. Every push reopens without following symlinks and rechecks exact size and SHA-256.
- Metadata records adapter protocol, server version, source commit, asset URL/name/size/SHA-256, primary and signing-subkey fingerprints, verification time, Apache-2.0 attribution/source and the OpenPGP LGPL boundary. The server binary is private-cache content and is never committed or bundled.

### ADB ownership, deadlines and cleanup

- ADB resolves from explicit configuration, then PATH. `version`, `devices -l` and `get-state` each have 5-second deadlines; shell/tunnel probes and cleanup commands 15 seconds; push, server spawn-to-connect and cache-lock acquisition 30 seconds. Commands use argv with `shell:false`, stdout and stderr each capped at 64 KiB, and an owned process group; only the specified serial in state `device` is admitted.
- Capability checks cover version execution, unique authorized device, shell, push and verified reverse create/remove. Ordinary ADB behavior may connect to or start the user's configured ADB server; the Adapter never explicitly starts, kills, replaces or reconfigures that global server. It signals only child process groups it spawned: interrupt I/O, TERM, wait 2 seconds, KILL if needed, then reap.
- The idempotent cleanup ledger always continues in order: close host socket/listener; terminate/reap owned ADB child; allow bounded device-server stop; remove owned reverse; remove owned remote jar/temp; remove host temp/release cache lock. Cleanup errors are recorded but never skip later steps; the first operational terminal cause remains authoritative. EOF classification runs bounded `get-state`: non-`device` is `device-disconnected`, otherwise `stream-interrupted` and final `failed` in current v1.

## Private-Cache Threat Model

- The v1 private cache protects against other OS users only under a trusted-root precondition: `cacheRoot` is a real, non-symlink directory owned by the effective uid with mode `0700`; every existing ancestor is a real non-symlink directory and is not group/other-writable, except a sticky directory such as `/tmp`. Identity directories are `0700` and files `0600`. Every file open uses `O_NOFOLLOW`; the identity directory is opened with `O_NOFOLLOW`; device/inode identity is checked before and after each pathname operation and again before use. A stable replacement, content/metadata tamper or observed inode mismatch is `artifact-mismatch`; an absent/unreadable path or other acquisition I/O failure remains `artifact-unavailable`.
- Any malicious process already running as the same macOS uid is outside current v1, including ancestor/final-component replacement races and in-place mutation, truncation or rewrite between verification and path-based `adb push`. Node.js 24 exposes no `openat`/`renameat`/`unlinkat` or descriptor-relative child operation, and `/dev/fd/<directory-fd>/<child>` is not supported on the target host. No same-uid interference-resistance claim is made. Bringing it into scope requires a separately selected native helper/addon and packaging/security review. SHA-256 is still rechecked immediately before every device push; stable or observed tamper fails closed.

## iOS WDA Standalone Contract

本节替代仅 Android、concrete CaptureSource/CaptureSession 及 videoConstraints 输入限制；Android wire、质量、artifact、ADB 和 cleanup 契约不变。

- `CaptureSource`、`CaptureSession` 为平台中立接口：`open({deviceRef}, cancellation?:AbortSignal):Promise<CaptureSession>`；session 提供 bounded `events()`、并发安全幂等 `stop("explicit-stop"|"cancelled")` 和资源释放后返回同一缓存结果的 `closed()`。删除 VideoConstraints 及兼容 overload。
- Concrete 为 `ScrcpyV501CaptureAdapter` 和 `WdaMjpegCaptureAdapter`。策略在构造时固定，Runtime 无 platform/codec open 分支；无 base class、fallback 或 plugin registry。Android 固定原 H.264/720/30/8-Mbps/no-crop/no-upscale 策略。
- WDA binding 私有复制并冻结完整 v2 iOS DeviceRef 与 endpoint；open 严格匹配四个身份字段。Android 同样匹配完整配置身份。provider locator 不序列化。
- WDA 外部身份固定 tag v16.15.3、commit `02cb92f0e93c8b021443bcbb8eeb80932c113220`；FSQ 不下载、执行或管理 WDA/forward，不发送任何自动化或 Settings 命令。
- endpoint 仅接受字面 `http://127.0.0.1:<port>/`，port 1..65535 无前导零；不接受 DNS、IPv6、userinfo、query、fragment、其他路径、redirect 或 proxy 环境。连接与 response-header deadline 各 5 秒，read-idle 12 秒；取消中断连接和读取，无重试。
- 接受且仅接受 HTTP/1.0 200 OK 及每项恰好一次的响应头：`Server: WDA MJPEG Server`、`Connection: close`、`Max-Age: 0`、`Expires: 0`、`Cache-Control: no-cache, private`、`Pragma: no-cache`、`Content-Type: multipart/x-mixed-replace; boundary=--BoundaryString`。名称大小写不敏感，值仅有界 OWS normalization；拒绝额外/重复/折叠头。
- 每 part 精确 `--BoundaryString\r\nContent-type: image/jpeg\r\nContent-Length: <canonical decimal>\r\n\r\n<JPEG>\r\n\r\n`，不接受额外头；任意 TCP fragmentation 不改变结果。响应头 ≤8 KiB，part header ≤1 KiB，JPEG ≤8,126,464 bytes；按当前状态所需字节限制 buffer，长度先校验后分配，禁止无界 EOI 搜索。
- JPEG 要求 SOI/EOI、有界合法 SOF，width/height 各 1..4096，且 `width<=floor(8388608/height)`。`exifr@7.1.3` 仅从内存 Uint8Array 解析 orientation，不读取 URL/path，不解码像素。非法/截断/越界输入 fail closed 为 malformed-media。
- SessionStarted 增加 codec `h264-annexb|mjpeg` 与 timestampOrigin `source|host-arrival`。H.264 保留 config/key grammar；MJPEG 无 Config，每 Frame 完整独立 JPEG、key=true，PTS 在完整接收并验证后取 source-session 起点以来单调微秒。
- coded size 或 EXIF orientation 改变：SessionEnded reconfigured→严格递增 epoch SessionStarted→JPEG。display size 遵循 orientation；序列跨 session 严格增加、epoch 内 PTS 非负不回退。
- WDA 最多保留一个 parsed 未交付 JPEG，后者替换前者并记录 drop，不产生 decoder GAP。控制/terminal 有界且不可丢；恰好一次 whole-stream terminal，之后无事件。
- stop/cancel 关闭 FSQ socket、清空 parser/队列并等待 producer 退出；不触及外部 WDA、forward 或 Session。安全错误使用固定 stage，不暴露 endpoint 或原始 provider error。

## Automatic Single Android Binding v1

本节定义 `ANDROID-AUTO-BINDING-MACOS-01` 的macOS owner-private binding解析；不修改CaptureSource、创建DeviceRef、持久化设备状态、启动Capture或建立Agent/CLI/RuntimeControl行为。

### Interface and exact values

- Capture模块入口固定为 `resolveSingleAndroidBinding(options?) -> Promise<AndroidBindingResult>` 与 `revealAndroidBinding(access) -> ResolvedAndroidBinding`。`options`缺省或恰好为 `{signal?:AbortSignal}`；shape先于signal状态与任何I/O校验，额外字段、错误类型或非原生AbortSignal同步抛固定 `TypeError("Invalid Android binding options")`。shape合法且signal已aborted才按下文返回device-unavailable。构造纯值零I/O。
- `AndroidBindingResult` 恰好为 `{ok:true,value:{access}} | {ok:false,error}`。error恰好为 `{code,safeMessage}`，禁止额外字段；code/safeMessage固定复用：`dependency-unavailable`/`Required dependency is unavailable`、`adb-incompatible`/`ADB is incompatible`、`device-not-found`/`Device was not found`、`device-ambiguous`/`Device selection is ambiguous`、`device-unavailable`/`Device is unavailable`、`artifact-unavailable`/`Artifact is unavailable`、`artifact-mismatch`/`Artifact verification failed`。不抛原始provider/I/O错误。
- `AndroidBindingSnapshot` 恰好为深冻结 `{bindingVersion:1,platform:"android",provider:"scrcpy-v5.0.1",adbVersion,artifactVersion:"5.0.1",artifactSha256:"764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536",observedAt}`；adbVersion恰好为下文grammar捕获并规范化的`<major>.<minor>.<patch>`，最多17 ASCII bytes；observedAt是0..Number.MAX_SAFE_INTEGER integer Unix epoch milliseconds，采样值不满足该范围时在任何异步I/O前返回device-unavailable。snapshot不含DeviceRef、serial、路径、端口、client或artifact path。
- `AndroidBindingAccess`为含ECMAScript private fields的冻结wrapper；唯一enumerable own property是snapshot；`toJSON()`恰好返回 `{snapshot}`；普通/symbol枚举只能看到snapshot；字符串/default primitive与Node inspect为 `[REDACTED]`。唯一私密出口 `revealAndroidBinding(access)` 只接受本模块工厂创建的access，返回深冻结 `ResolvedAndroidBinding={serial,adbPath,cacheRoot,artifactSource:{mode:"online"}}`；foreign/forged值同步抛固定 `TypeError("Invalid Android binding access")`，无I/O或provider细节。Integrations、Agent、Contracts与普通输出不得取得或调用。

### Fixed zero-configuration policy

- 操作开始时只快照当前进程PATH；不读取 `FSQ_*`、`ADB_*`、HOME覆盖、cwd配置或调用方路径。按Node path delimiter拆分；空或非绝对PATH entry直接忽略且永不按cwd解析。对每个absolute entry拼接basename `adb` 后调用realpath；directory/final symlink允许解析到canonical target，但canonical target必须是普通非符号链接文件并通过`X_OK`。首个有效canonical realpath固定为private adbPath；后续重复/其他candidate不再选择。零有效候选为dependency-unavailable，不扫描默认安装目录。
- 固定cacheRoot由Node `os.userInfo().homedir`加 `Library/Caches/FSQ_scrcpy` 得到；创建/验证0700、当前有效uid、非符号链接及既有Private-Cache Threat Model祖先规则。artifactSource固定 `{mode:"online"}`，复用现有签名/checksum/SHA-256/lock/cache实现；不提供offline/custom输入。
- 对选定adbPath执行5秒bounded `adb version`与 `adb devices -l`，stdout/stderr各64KiB。version stdout按LF或CRLF分行；第一行必须完全匹配 `^Android Debug Bridge version (0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})\.(0|[1-9][0-9]{0,4})$`，三个值均≤65535。snapshot adbVersion恰好为捕获十进制值以句点连接的canonical `major.minor.patch`；后续行允许存在但不解析、不存储、不输出。非ASCII、替换字符、额外prefix/suffix、首行不匹配或值越界均为adb-incompatible。
- devices输出使用既有bounded parser规则，但resolver按原始非空设备行计数：0行为device-not-found；超过1行为device-ambiguous，即使只有一行state=device也不自动选它；恰好1行但state不是`device`为device-unavailable；恰好1行state=`device`时serial必须非空、最多256 ASCII且不含空白/C0/C1，否则adb-incompatible。serial仅进入private access。
- resolver随后执行该serial的既有5秒 `get-state`；结果必须exact `device`，否则device-unavailable。不得执行shell、push、reverse、forward、start-server/kill-server、设备设置或其他命令；普通Android Debug Bridge client如上游行为所需可连接/启动用户全局server，但resolver从不取得其ownership。

### Lifecycle, cancellation and privacy

- 单调阶段固定为：S0 options/PATH与pre-abort；S1 `adb version`→`devices -l`→`get-state`；S2 fixed online artifact acquire/verify及其lock release；S3 access wrapper同步创建。每次await返回后先检查AbortSignal再解释值/推进阶段。S3 wrapper创建是唯一success linearization point。
- shape合法后的pre-abort，以及S0 PATH realpath/lstat/access任一await后或S1任一点在S3前观察到abort，停止后续候选/probe，取消并等待已创建的owned Android Debug Bridge child（如有）后返回device-unavailable；不可取消的单次filesystem await完成后立即检查signal且不得继续I/O。进入S2前再次检查signal，S2任一点在artifact完成/lock release后推进前观察到abort，完成artifact cleanup后返回artifact-unavailable。若promise先以固定业务错误settle且紧邻检查时signal未abort，保留该业务错误。S3后late abort不改变success/access。
- cleanup失败不返回partial access：S1清理失败仍固定device-unavailable，S2清理失败固定artifact-unavailable；原cleanup/provider错误不外泄。只有Android Debug Bridge与artifact两侧成功、lock/child/file资源全释放且最后signal检查通过才同步创建access。
- 同时调用不创建产品级全局mutex；Android Debug Bridge只读probe可并发，artifact复用既有per-identity bounded lock。每个调用独立snapshot PATH/observedAt；不缓存serial、access或失败。所有临时stdout/stderr、devices原文、serial、路径、未采用private DTO及内部错误在结束路径释放且不写普通日志；safe result、JSON、inspect、exception、模型输出及全仓搜索不得包含serial/路径/artifact path。

### Verification and real acceptance

- 验证必须覆盖options shape先于pre-abort、固定TypeError、invalid reveal、PATH空/相对/重复/无效/目录与final symlink canonicalization/不可执行、version LF/CRLF/first-line完整grammar/额外行/非ASCII/值界/64KiB、devices 0/1/2行及authorized/offline/unauthorized、serial值域、get-state mismatch、artifact online成功/签名与cache失败、S0/S1/S2/S3边界取消和cleanup优先级、late abort、并发artifact lock、wrapper/reveal唯一私密出口及全量序列化/日志脱敏。
- fake Android Debug Bridge断言命令集合恰好为version、devices -l、目标serial get-state；任何shell/push/reverse/kill-server调用使测试失败。resolver完成后无owned child/lock/socket残留。
- 真实macOS arm64/USB Android验收记录Android Debug Bridge与artifact安全版本信息、恰好一台authorized设备、resolver成功与重复成功、零普通locator泄漏，并证明调用前后没有新增reverse、remote artifact、Capture session、Viewer或设备设置变化。该验收不替代已完成的Android standalone回归，也不形成Agent/Windows/platform支持声明。

