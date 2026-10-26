# FSQ_scrcpy Project Specification

## Project Specification Ownership

本文件记录项目级已确认事实、全局约束与模块索引。模块细节由对应模块 SPEC 维护；开发流程由 [AGENTS.md](AGENTS.md) 和相关技能定义。

本项目目标是在设备由测试或 Coding Agent 操作时，向用户提供实时设备画面。它与 `Appium_connect_agent` 协作：对方负责操控和语义观测，本项目负责视频采集、分发和 Viewer。

## Module Table

| Module | Responsibility | Specification |
| --- | --- | --- |
| Contracts | 跨模块共享的设备、视频流与 Viewer 描述契约 | [modules/contracts/SPEC.md](modules/contracts/SPEC.md) |
| Capture | 平台视频源接入及编码流获取 | [modules/capture/SPEC.md](modules/capture/SPEC.md) |
| Runtime | 本地流服务、生命周期、分发及外部启动/连接 seam | [modules/runtime/SPEC.md](modules/runtime/SPEC.md) |
| Viewer | 独立 Web Viewer、MCP App 展示和 URL fallback | [modules/viewer/SPEC.md](modules/viewer/SPEC.md) |

## Architecture Diagram

```text
USB device
    │
    ▼
Capture
    │ encoded video / platform metadata
    ▼
Runtime
    ├── stream lifecycle and status
    ├── local distribution endpoint
    └── stable external interface
             │
             ├──────────────► standalone Web Viewer
             │
             └──────────────► MCP App Viewer
                                      │
                         unsupported host falls back to Viewer URL

Appium_connect_agent Adapter ───────► Runtime public interface
```

依赖方向为 `Capture → Contracts`、`Runtime → Capture + Contracts`、`Viewer → Runtime + Contracts`。外部 Adapter 只依赖公开接口；本项目不依赖 `Appium_connect_agent` 内部实现。

## Confirmed Product Scope

- 产品最终目标平台包括 Android、iOS 和 macOS；各平台须按独立 feature 和真实验证证据进入支持矩阵。
- 第一批固定为 macOS 本地宿主、USB Android、单设备单流。
- 第一批最低目标为 720p 和 30 FPS；精确定义、测量方法和环境须在设计与验收中确认。当前 Feature 不包含端到端显示延迟目标或支持声明。
- Viewer 首批为只读观看面，不发送设备控制命令。
- 支持 MCP Apps 的 Coding Agent 可内嵌 Viewer；其他宿主必须获得可打开的 Viewer URL。
- 视频帧不得进入模型文本上下文，MCP 不作为逐帧媒体传输通道。
- 采集按 Viewer 需求惰性启动；存在活跃 Viewer 时续租，无观看者后自动停止。设备操控不依赖 Viewer 在线。
- 本地流服务既可独立启动，也可由外部 Adapter 按需拉起或连接已有实例。

## Cross-project Responsibilities

- `FSQ_scrcpy` 拥有视频采集、视频流生命周期、分发和 Viewer。
- `Appium_connect_agent` 拥有 Appium Session、设备操作、截图/页面结构等语义观测，以及 Coding Agent Adapter。
- `DeviceRef`、`StreamId`、Viewer 描述及状态/错误语义由 Contracts v1 统一拥有；当前 standalone v1 不包含跨仓 launch/attach transport。该 transport 与 Appium consumer 需要后续同步 SPEC delta。

## Development Rules

- 第一批实现基线为 Node.js 24.22.1 LTS、严格 TypeScript 7.0.2、`ws@8.22.0`、`openpgp@6.3.2`、framework-free Viewer 与 Node 内建测试；精确用途、开发依赖、许可证和 lock 门槛由已批准选型记录维护。
- 第一批不得因最终三平台目标而同时实现 iOS 或 macOS Capture。
- 不将 iPhone-use 的 MCP JPEG 轮询实现视为本项目传输契约；它仅作为 MCP App 生命周期和 iOS 采集研究参考。
- 新公共接口、依赖方向、平台支持、性能承诺、远程访问、录制、音频或 Viewer 控制能力必须经过 SPEC gate 和用户确认。
- 默认只绑定本机可达范围；远程或云端 Agent 访问本机视频涉及认证、relay 或网络穿透，当前不在首批范围。
- 视频内容默认不落盘。任何录制、上传、遥测或外部传输都需要独立确认并明确隐私边界。

## Android First-Batch Contract v1

- The first acceptance target is a local macOS arm64 host, one USB Android handheld satisfying the capability policy, one logical video stream and one active standalone Chrome Viewer. The support matrix remains empty until all real-device/browser/performance/cleanup evidence passes independent review and a later SPEC delta names a supported combination.
- Device support is capability-based: one built-in non-foldable primary display, USB debugging, hardware H.264 encoder, sufficient native pixels, and no manufacturer-published security-support EOL reached on the validation date. Exact device/OS/security-patch/encoder versions are validation evidence, not allowlist entries.
- Active decoded video is at least 720 pixels on the short edge, preserves aspect ratio without crop/stretch/upscaling, targets 30 FPS under the confirmed bounded-jitter thresholds, and reaches first Live within 5 seconds after authorization.
- `ANDROID-STANDALONE-01` makes no glass-to-glass latency bound or support claim. External high-speed glass-to-glass measurement is deferred as non-blocking performance research; any future latency commitment or support claim requires a new SPEC delta and real evidence.
- Capture uses pinned `scrcpy-server v5.0.1` plus `ScrcpyV501CaptureAdapter`; the atomic compatibility identity is server semantic version + official artifact SHA-256 + Adapter protocol version. Raw stream, full-client embedding and forks are not first-batch paths.
- The server asset is acquired only from the pinned official release, verified by signed checksum material and SHA-256, admitted to a private content-addressed cache, and rehashed before every push. An explicit offline path must pass the same identity checks. No latest/system fallback is allowed.
- ADB is user-installed and admitted by bounded capability checks rather than a version allowlist. FSQ_scrcpy does not download, bundle, redistribute, kill or replace the user's global ADB server.
- H.264 Annex B, versioned binary WebSocket, Chrome WebCodecs in a Web Worker and Canvas are the first media path. FSQ_scrcpy implements and redistributes no codec. MSE/FFmpeg/WebTransport are not first-batch dependencies.
- Runtime and Viewer bind only loopback, require owner-approved pairing plus short-lived per-stream capabilities, and never expose reusable secrets in model text, URL queries, logs, process arguments or telemetry.
- Only an authenticated visible Viewer renews demand. Hidden/pagehide/disconnect starts a 5-second grace; return within grace reuses the StreamId and must Sync to a fresh painted frame. Grace expiry stops the stream. In the current contract, media/encoder/socket interruption ends the stream with a typed terminal/state-unknown result and requires explicit user retry with a new StreamId; bounded same-StreamId restart is reserved for a later SPEC delta. Proven device removal is terminal immediately.
- The current contract freezes shared identities/errors and media protocol v1. External launch/attach control transport and `Appium_connect_agent` integration are not part of the current contract; adding them requires a later cross-repository SPEC delta and must expose no media/scrcpy internals.
- Runtime prerequisite and exact dependency selection are maintained in [the approved selection record](docs/tasks/2026-10-23-runtime-dependency-selection.md): Node.js 24.22.1 LTS, production `ws@8.22.0` and `openpgp@6.3.2`, and the exact development dependency set recorded there. Actual lock closure and licenses must be verified before implementation Ready.
- Audio, recording, remote/cloud access, multiple devices/streams/Viewers, iOS/macOS Capture, Viewer control, external launch/attach and MCP App implementation are outside the current v1 standalone contract. Each addition requires its own SPEC delta and real validation.

