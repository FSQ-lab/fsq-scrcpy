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
