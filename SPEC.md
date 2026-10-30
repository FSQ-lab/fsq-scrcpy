# FSQ_scrcpy Project Specification

## Project Specification Ownership

本文件记录项目级已确认事实、全局约束与模块索引。模块细节由对应模块 SPEC 维护；项目计划、优先级、依赖、状态与验收证据由 GitHub Issues 管理，协作规则见 [AGENTS.md](AGENTS.md)。

本项目目标是在设备由测试或 Coding Agent 操作时，向用户提供实时设备画面。它与 `Appium_connect_agent` 协作：对方负责操控和语义观测，本项目负责视频采集、分发和 Viewer。

## Module Table

| Module | Responsibility | Specification |
| --- | --- | --- |
| Contracts | 跨模块共享的设备、视频流与 Viewer 描述契约 | [modules/contracts/SPEC.md](modules/contracts/SPEC.md) |
| Capture | 平台视频源接入及编码流获取 | [modules/capture/SPEC.md](modules/capture/SPEC.md) |
| Runtime | 本地流服务、生命周期、分发及外部启动/连接 seam | [modules/runtime/SPEC.md](modules/runtime/SPEC.md) |
| Viewer | 独立 Web Viewer、MCP App 展示和 URL fallback | [modules/viewer/SPEC.md](modules/viewer/SPEC.md) |
| Integrations | Packaged CLI/MCP Adapters、命令呈现与宿主集成 | [modules/integrations/SPEC.md](modules/integrations/SPEC.md) |

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

The dependency graph additionally permits only `Integrations → Runtime + Contracts`; Capture/Runtime/Viewer do not depend on Integrations.

## Confirmed Product Scope

- 产品最终目标平台包括 Android、iOS 和 macOS；各平台须按独立 feature 和真实验证证据进入支持矩阵。
- 第一批固定为 macOS 本地宿主、USB Android、单设备单流。
- 第一批最低目标为 720p 和 30 FPS；精确定义、测量方法和环境由技术契约及对应 GitHub Issue 记录。当前契约不包含端到端显示延迟目标或支持声明。
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
- 新公共接口、依赖方向、平台支持、性能承诺、远程访问、录制、音频或 Viewer 控制能力必须先记录在对应 GitHub Issue，并在交付中同步更新适用技术契约。
- 默认只绑定本机可达范围；远程或云端 Agent 访问本机视频涉及认证、relay 或网络穿透，当前不在首批范围。
- 视频内容默认不落盘。任何录制、上传、遥测或外部传输都需要独立确认并明确隐私边界。

## Android First-Batch Contract v1

- The first acceptance target is a local macOS arm64 host, one USB Android handheld satisfying the capability policy, one logical video stream and one active standalone Chrome Viewer. The support matrix remains empty until the owning GitHub Issue records complete real-device/browser/performance/cleanup evidence and the current contract names the supported combination.
- Device support is capability-based: one built-in non-foldable primary display, USB debugging, hardware H.264 encoder, sufficient native pixels, and no manufacturer-published security-support EOL reached on the validation date. Exact device/OS/security-patch/encoder versions are validation evidence, not allowlist entries.
- Active decoded video is at least 720 pixels on the short edge, preserves aspect ratio without crop/stretch/upscaling, targets 30 FPS under the confirmed bounded-jitter thresholds, and reaches first Live within 5 seconds after authorization.
- `ANDROID-STANDALONE-01` makes no glass-to-glass latency bound or support claim. External high-speed glass-to-glass measurement is deferred as non-blocking performance research; any future latency commitment or support claim requires a technical-contract update and real evidence in its GitHub Issue.
- Capture uses pinned `scrcpy-server v5.0.1` plus `ScrcpyV501CaptureAdapter`; the atomic compatibility identity is server semantic version + official artifact SHA-256 + Adapter protocol version. Raw stream, full-client embedding and forks are not first-batch paths.
- The server asset is acquired only from the pinned official release, verified by signed checksum material and SHA-256, admitted to a private content-addressed cache, and rehashed before every push. An explicit offline path must pass the same identity checks. No latest/system fallback is allowed.
- ADB is user-installed and admitted by bounded capability checks rather than a version allowlist. FSQ_scrcpy does not download, bundle, redistribute, kill or replace the user's global ADB server.
- H.264 Annex B, versioned binary WebSocket, Chrome WebCodecs in a Web Worker and Canvas are the first media path. FSQ_scrcpy implements and redistributes no codec. MSE/FFmpeg/WebTransport are not first-batch dependencies.
- Runtime 和 Viewer 只绑定 loopback；authenticated ensure auto-bootstrap、session capability、Host 和 Origin 策略由模块契约固定，Viewer URI不携带secret。
- Only an authenticated visible Viewer renews demand. Hidden/pagehide/disconnect starts a 5-second grace; return within grace reuses the StreamId and must Sync to a fresh painted frame. Grace expiry stops the stream. In the current contract, media/encoder/socket interruption ends the stream with a typed terminal/state-unknown result and requires explicit user retry with a new StreamId; bounded same-StreamId restart is reserved for a later SPEC delta. Proven device removal is terminal immediately.
- The current contract freezes shared identities/errors and media protocol v1. External launch/attach control transport and `Appium_connect_agent` integration are not part of the current contract; adding them requires linked cross-repository Issues and synchronized technical-contract updates, and must expose no media/scrcpy internals.
- Runtime prerequisite and exact dependency selection are maintained in [the approved selection record](docs/tasks/2026-10-23-runtime-dependency-selection.md): Node.js 24.22.1 LTS, production `ws@8.22.0` and `openpgp@6.3.2`, and the exact development dependency set recorded there. Actual lock closure and licenses must be verified before implementation.
- Audio, recording, remote/cloud access, multiple devices/streams/Viewers, iOS/macOS Capture, Viewer control, external launch/attach and MCP App implementation are outside the current v1 standalone contract. Each addition requires its own GitHub Issue, technical-contract update and real validation.

## iOS WDA Standalone Contract

本节及模块 SPEC 中同名契约定义 `IOS-WDA-STANDALONE-01`。本节的适用范围优先于上文仅 Android/control v1 的限制，Android 媒体与质量契约不变。

- 平台组合：macOS arm64 本地宿主、一个 USB iPhone、外部已运行的 WDA v16.15.3、外部已建立的 loopback USB forward、单流及一个 standalone Chrome Viewer。支持矩阵保持为空。
- WDA-first；非 WDA Adapter、Agent launch/attach、MCP App、其他平台和 `IOS-WDA-LIFECYCLE-02` 不属于本次实现范围。
- FSQ attach-only，不安装、签名、启动、停止或配置 WDA，不建立或管理 USB forward，不发送 WebDriver/Settings 命令，不管理 Appium Session，不修改 `Appium_connect_agent`。观察与自动化生命周期独立。
- Contracts control v2 全仓 clean cutover，支持 provider-neutral `android|ios` 身份；不保留 v1 alias、validator 或升级 shim。外部跨进程控制协议仍未定义。
- iOS 唯一数值媒体目标：健康且已准备的源，从首次有效 authenticated visible demand 到当前 epoch 首次 fresh painted ACK ≤5 秒。没有分辨率、FPS 或 glass-to-glass 延迟承诺。
- MJPEG 2 秒无新鲜 paint 离开 Live；12 秒无新鲜 paint 终止。无同 StreamId source restart。关闭 FSQ 只释放其拥有的资源，WDA、forward 和自动化不受影响。
- 生产依赖新增精确 `exifr@7.1.3`，仅内存 JPEG EXIF orientation；有界 WDA 专用 multipart/JPEG SOF 解析为已批准自研例外。实际包/API、完整性、许可证和 lock closure 必须在实现前核验并记录于对应 GitHub Issue。
- 帧只在内存；WDA endpoint、UDID、Session ID、provider locator/error 不进入公共契约、日志、模型输出或 Viewer URL。浏览器只连接受保护 FSQ origin。
- 详细契约由四个模块 SPEC 的同名契约定义；既有 loopback、auto-bootstrap/session capability、Host/Origin、CSP、五秒 Viewer grace、first-cause terminalization 和 Android 约束保持有效。

## macOS Android Automatic Binding Contract

本节只覆盖 `ANDROID-AUTO-BINDING-MACOS-01`。RuntimeControl、持久本机状态、CLI、Windows、iOS binding 与 Model Context Protocol 均不由本节预建。

- 平台组合为本地 macOS arm64、恰好一台已通过USB连接并授权的Android设备及现有 `ScrcpyV501CaptureAdapter`；当前Android真实Capture/Viewer/rotation/performance/grace/cleanup回归已通过，但支持矩阵保持为空。
- Capture模块新增零手工配置的owner-private Android binding resolver：从当前进程PATH解析既有Android Debug Bridge，要求设备列表恰好一行且state=`device`，复用固定在线scrcpy-server v5.0.1私有缓存策略，并返回不普通序列化的私有binding access。
- resolver不生成公共 `DeviceRef`、不启动Capture、push/reverse/shell/server或Viewer，不保存设备映射，不建立监听器。Runtime后续feature才负责把私有binding与自动本机状态组合。
- Android serial、路径、artifact locator/client对象不进入Contracts、安全snapshot、普通结果、日志、模型上下文、URL或遥测。详细interface、错误、限制、取消与验收由Capture同名contract拥有。
- Runtime/Contracts/Viewer对本feature no-delta；后续feature只能经另行确认的SPEC delta消费该owner-private access。

## macOS iOS WDA Automatic Binding Contract

- 本节只覆盖 `IOS-AUTO-BINDING-MACOS-09`：本地 macOS arm64、外部 owner 已将 WDA v16.15.3 MJPEG 固定转发到 loopback slot `127.0.0.1:9100`，以及一个 Capture-owned owner-private binding resolver。支持矩阵保持为空。
- resolver 表示当前 macOS 账户的单一 iOS logical video slot，不识别或证明物理 iPhone。外部 owner 将 forward 指向另一台 iPhone 时 slot identity 保持；自动化与视频目标的物理一致性属于后续跨项目 integration 验收。
- FSQ 不检查 USB device、UDID、WDA/Appium Session identity 或 forward ownership；不安装、签名、启动、停止、配置或修复 WDA；不创建、检查或管理 forward；不发送 WebDriver、Settings 或设备控制命令。
- resolution 不执行 filesystem、process、environment、socket、HTTP、DNS、proxy、USB 或 Capture-source I/O；不创建 DeviceRef、不打开 WDA MJPEG、不启动 Runtime/Viewer、不持久化状态、不暴露 endpoint。WDA/forward availability 仍由已验收 iOS standalone contract 的 demand-time Capture 行为判定。
- 仅 Capture 变化。Contracts、Runtime、Viewer、Integrations no-delta；CLI、MCP、RuntimeControl、Appium integration、多 slot、second-source detection、physical identity 与 platform/support claim 均不在范围内。

## macOS Android RuntimeControl v1

本节最初定义 `ANDROID-RUNTIME-CONTROL-MACOS-02`；下方已确认的`ANDROID-CONTROL-WAIT-MACOS-04`只扩展ordinary provider wait。CLI wait/watch、Windows、iOS RuntimeControl与Model Context Protocol仍未启用。

- 平台组合为本地macOS arm64、`ANDROID-AUTO-BINDING-MACOS-01`已验收的恰好一台USB Android设备、一个persistent Runtime/stream/Viewer。Runtime客户端退出不停止Runtime；只有持有独立owner authority且显式请求shutdown才停止进程。
- 新增独立于Viewer origin、绑定exact `127.0.0.1`的HTTP/1.1 JSON control listener，以及一个深的provider-neutral RuntimeControl client/provider seam；control面不传媒体、不接触Capture/Viewer内部对象。
- `selector:auto/android`通过Capture owner-private resolver原子生成或复用安全DeviceRef和私有本机状态；`selector:known`只连接既有identity。并发首次启动只有一个crash-durable persistent slot、一个control listener和一个Runtime generation成为authority。
- stable root credential只存在owner-private slot；Runtime以HMAC-SHA-256派生不可互换的client与owner bearer。普通attached session只有ensure/inspect/wait/stop authority；Runtime shutdown与maintenance使用独立owner authority。
- Agent-safe结果只含Contracts-owned control值、`ViewerDescriptor`与`StreamSnapshot`；Android serial、路径、artifact locator、root/client/owner credential、permit、claim/media cookie、PID和原异常不进入普通结果、日志、URL、模型上下文或遥测。
- 当前支持acquire/start-or-attach、ensure、inspect、bounded wait、stop stream和owner Runtime shutdown；不支持远程、多个设备/流/Viewer或MCP App。
- Contracts/Runtime同名契约固定wire schema、canonical bytes、认证顺序、semantic ensure key/permit生命周期、错误tuple/deadline、crash-durable filesystem状态、spawn/bind/ready/attach与ABA规则。Capture行为no-delta。

## macOS Android CLI v1

本节定义用户已确认的 `ANDROID-CLI-MACOS-03` SPEC delta。

- 平台组合固定为本地 macOS arm64、恰好一台已授权 USB Android、已验收 RuntimeControl 与 standalone Chrome Viewer。新增 private npm package 内的 `fsq-scrcpy` executable，不发布、不建立支持矩阵条目。
- CLI 提供automatic/known Viewer ensure、attach-only inspect/stop、owner Runtime shutdown、只读 local-state status 及人工确认的 reset-control/rebind-device；旧`viewer approve`语法在产品I/O前固定失败。Windows、iOS 与 embedded Viewer 不在范围内。
- Integrations 只拥有 strict `node:util.parseArgs` 语法、TTY确认、human/JSON rendering、exit status 与 executable packaging；Runtime 深模块继续拥有身份、authority、process及本机状态。Contracts/Capture/Viewer no-delta，不新增control HTTP route或依赖。
- 现设计中“Runtime interface unchanged”仅适用于HTTP wire与ordinary RuntimeControl；owner recovery使用Runtime同名narrow owner-local maintenance seam，禁止CLI直接读取私有文件或取得serial/path/port/credential/binding。
- 普通client退出不停止stream/Runtime；stream stop保持Runtime监听；仅显式owner shutdown停止Runtime。所有输出沿用safe DTO，媒体与provider/authority私有值禁止进入stdout、stderr、prompt、argv、日志或模型上下文。
- Exact command/result/confirmation/packaging/privacy与真实验收由 [Integrations SPEC](modules/integrations/SPEC.md) 定义；Runtime slot replacement、并发、crash/cancel/ABA由Runtime同名delta定义。

## macOS Android RuntimeControl Bounded Wait

本节定义用户已确认的 `ANDROID-CONTROL-WAIT-MACOS-04` provider契约；下方`ANDROID-CLI-WATCH-MACOS-04B`只新增CLI映射，不改变Runtime wait。

- 平台组合仍为本地macOS arm64、恰好一台USB Android及一个persistent Runtime/stream；新增provider-neutral bounded long-poll `wait`，调用方按revision恢复，不保存server-side cursor或per-client history。
- ordinary client支持`wait`；下方`fsq-scrcpy stream wait/watch`只消费该seam。Capture/Viewer no-delta；既有viewer ensure/stream inspect继续透传Contracts exact值。
- Contracts clean cutover把`RuntimeInstance.features`固定为`["wait-v1","auto-bootstrap-v1"]`，扩展同一个observation value并保留bounded wait route；不升ControlVersion、不新增error/dependency/媒体或支持矩阵声明。
- Runtime用既有StateStore mutex/history/monotonic Clock实现原子注册、change/terminal/timeout/cancel线性化；最多8 authenticated connections/in-flight、4 concurrent waits、每local client及socket一个wait，所有完成路径恰好一次释放listener/timer/admission。
- Exact provider值、canonical bytes、caps、deadline、close/cancel与验收由Contracts/Runtime同名delta定义；CLI framing/lifecycle由下方Integrations契约定义。

## macOS Android CLI Wait/Watch

本节定义用户已确认的 `ANDROID-CLI-WATCH-MACOS-04B` SPEC delta；它只新增CLI wait/watch，不改变Runtime provider契约。

- 平台组合仍为本地macOS arm64、USB Android、accepted `wait-v1` Runtime。Integrations新增attach-only one-shot `stream wait`与resumable `stream watch`；不auto/spawn/ensure/stop或修改设备、stream、Runtime及owner state。
- one-shot输出一个exact compact JSON result；watch按RFC7464输出完整provider result records并只在完整record后推进invocation-local cursor。无persistent/server cursor、自动重连、retry/history queue、daemon或subscription。
- Contracts/Runtime/Capture/Viewer、依赖、package/lock、媒体与支持矩阵no-delta；Root只激活CLI surface。Exact grammar/framing/backpressure/signal/EPIPE/exit/privacy及真实验收由Integrations同名delta定义。

## Host-neutral Local Coding Agent Adapter

本节定义 `MCP-ADAPTER-MACOS-ANDROID-11A`。平台组合仍为本地 macOS arm64、恰好一台已授权 USB Android、一个 persistent Runtime/stream 和 standalone Chrome Viewer；不新增平台支持矩阵条目。

- 同一 private npm package 提供现有 `fsq-scrcpy` 与新的 `fsq-scrcpy-mcp`。后者是 Host-neutral 本地 stdio MCP Server；产品代码不读取或分支于 Coding Agent Host 名称、版本或结果消费方式。
- MCP 只暴露 Viewer ensure、stream inspect、bounded wait 和 stream stop；复用既有 RuntimeControl/Contracts safe DTO。Runtime shutdown、reset/rebind与maintenance仍仅属于人工 owner CLI；Viewer授权由authenticated ensure在Runtime内部完成。
- stdio MCP 协议兼容范围固定为 legacy revisions `2024-10-07`、`2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`及 modern `2026-07-28`。协议兼容证据不产生任何具体 Coding Agent Host 支持声明。
- MCP wait固定为`0..25000ms`、缺省25000ms；适用Host或验收客户端总调用预算必须至少45000ms。取消、EOF或客户端退出只释放该调用/session，不stop stream或Runtime。
- 每个MCP结果同时提供同一个validated safe DTO的`structuredContent`与compact JSON text mirror；禁止image/resource/media。现代协议的标准result metadata不进入产品DTO。
- 现有`fsq-scrcpy --json`四个ordinary操作是无MCP Host的cooperative fallback，不新增wrapper、daemon、私有shell协议或owner authority。
- 生产依赖固定`@modelcontextprotocol/server@2.3.1`与`zod@4.6.7`；验收开发依赖固定`@modelcontextprotocol/client@2.3.1`。实际lock、完整性、provenance、安全、SBOM和许可证闭环必须在实现前核验并记录于对应 GitHub Issue。
- active verified Coding Agent Host register初始为空。任何后续MCP或CLI Host必须固定exact identity，并在独立 GitHub Issue 完成no-product-churn parity验收；否则不得产生Host兼容或支持声明。
- `FSQ_scrcpy`不依赖或修改任何第三方 Coding Agent Host；任何Host fix、release、version或commit都不是交付前置，并且不得为Host增加专属branch、shim、flag、result shape或cancellation proxy。
- Contracts、Runtime、Capture和Viewer行为no-delta；媒体、provider locator、authority、credential及其他私有值继续禁止进入MCP、CLI、模型上下文、日志或文件。
- 本Feature的当前契约止于Host-neutral MCP Adapter、installed dual-era stdio协议、四工具与CLI/全模块自动回归；它不建立具体Host支持声明。
- 最终Viewer链由下方已确认的Runtime-owned 11B契约拥有；11A接口保持no-delta。

## Authenticated Agent Viewer Auto-Bootstrap

本节定义 `AGENT-AUTO-VIEWER-BOOTSTRAP-MACOS-ANDROID-11B`。平台固定为本地 macOS arm64、恰好一台已授权 USB Android、persistent Runtime/stream 和 standalone Chrome；Capture no-delta，不增加 Host 或平台支持矩阵条目。

- 已认证 Agent 调用现有 ensure 即代表用户本次观看意图。Runtime 为当前 generation/StreamId 原子建立一个 30000ms monotonic、single-use auto-bootstrap permit；Agent、MCP、CLI、ViewerDescriptor URI、日志、argv、env 和持久化状态均不含 permit、cookie、grant、pairing code、pairingId 或 Runtime locator。
- 第一个满足 exact top-level navigation policy 的浏览器在 permit 内获 claim；这是已接受的同一 OS 用户、已知 URI first-browser residual，不保证跨 UID claimant isolation。iframe、prefetch、prerender 和无显式用户激活的非native导航拒绝。
- 正常用户路径无 pairing code、pairing UI、owner approve 或 CLI approve。Runtime pairing/redeem/bootstrap-grant route、owner approve control route及其共享类型、Viewer UI/轮询和CLI grammar一次 clean cut删除，不保留alias、shim或deprecated path。
- ViewerAuthorization 是 Runtime 唯一授权状态模块；复用既有 StateStore mutex、single-Viewer slot、session cookie、visible lease、5秒 grace、fresh-paint Live、媒体/ACK/Canvas管线和统一终止。Capture仍只由 authenticated visible demand惰性打开。
- MCP四工具、schema、result、dual-era stdio和AgentControl接口no-delta；`fsq_viewer_ensure`只通过既有ensure语义自动arm。CLI `viewer ensure --json`相同行为；`viewer approve`在产品I/O前成为deterministic invalid syntax。
- `RuntimeInstance.features` clean cut为exact `['wait-v1','auto-bootstrap-v1']`；旧/缺失/重复/额外/乱序feature fail closed。Contracts、Runtime、Viewer、Integrations完整细节由各模块同名active条款共同定义。
- 30秒permit、delivery rollback、TTL/cancel/response-loss/first-browser race、refresh/grace/restart/stop/new StreamId、privacy和legacy/modern installed真实链路是验收边界。verified Host register保持空；通过不生成最终Host或平台支持声明。
- 本节与四个模块同名条款已原子激活；被替代的owner-approved pairing契约已clean cut移除，五模块不得部分回退。
