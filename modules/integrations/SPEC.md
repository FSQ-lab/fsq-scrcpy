# Module: Integrations

> **Status: CONFIRMED — `ANDROID-CLI-MACOS-03`.**

## Purpose

拥有 `FSQ_scrcpy` 的外层可执行 Adapter：命令语法、交互确认、安全渲染、退出状态及 npm executable packaging。Integrations 只编排 Runtime/Contracts 的公开值与 owner-local seam，不实现流、本机状态或设备绑定状态机。

## Dependencies

- Integrations 可依赖 Runtime、Contracts 与 Node.js 标准库；Runtime/Capture/Viewer 不依赖 Integrations。
- CLI 不得导入 Runtime 的 state 文件类、HTTP owner client、credential/port locator，或 Capture resolver/reveal access。
- 解析固定复用 Node.js 24.22.1 stable `node:util.parseArgs`。不新增 CLI dependency，现有 dependency 与 lock graph 不变。

## `ANDROID-CLI-MACOS-03` Scope

平台组合覆盖本地 macOS arm64 上已验收的 Android Runtime，以及 `IOS-RUNTIME-CLI-MACOS-10` 的外部 owner-managed WDA v16.15.3/fixed loopback source。两者复用同一 CLI、RuntimeControl 和 standalone Chrome Viewer；MCP、Windows、embedded Viewer、远程、多个同平台设备/流/Viewer及支持矩阵条目仍不在范围内。

## Exact Command Surface

```text
fsq-scrcpy viewer ensure (--platform android|ios | --device-ref <uuid>) [--json]
fsq-scrcpy stream inspect --stream-id <uuid> [--after-revision <N>] [--json]
fsq-scrcpy stream wait --stream-id <uuid> --after-revision <N> [--wait-ms <N>] --json
fsq-scrcpy stream watch --stream-id <uuid> [--after-revision <N>] --json-seq
fsq-scrcpy stream stop --stream-id <uuid> [--expected-revision <N>] [--json]
fsq-scrcpy runtime shutdown --device-ref <uuid> [--json]
fsq-scrcpy local-state status --platform android|ios [--json]
fsq-scrcpy local-state reset-control --platform android --device-ref <uuid> [--json]
fsq-scrcpy local-state rebind-device --platform android --device-ref <uuid> [--json]
```

- 只接受上述两段 command path 与长选项；无短别名、额外 positional、`--yes`、`--force`、环境变量配置或隐式平台。`--name value` 与 `--name=value` 等价。
- 先识别精确 command path，再以 `strict:true, allowPositionals:false, allowNegative:false, tokens:true` 解析其余参数；未知、重复、缺失、额外、冲突 option 及 `--` 在任何 filesystem/ADB/socket/spawn I/O 前失败。`tokens` 必须用于拒绝 `parseArgs` 默认 last-wins 的重复项。
- UUID 为 canonical lowercase non-nil v4；revision 为无前导零的正十进制 safe integer。`viewer ensure`与`local-state status`的platform只接受`android|ios`；reset/rebind仍只接受`android`。
- `--device-ref` 是已有完整本机 `DeviceRef.opaqueId` 的比较值；CLI 不自行拼接 namespace、生成或 remap identity。

## Operation Mapping

- owner-local只读status是stored-identity lookup的唯一状态入口：`uninitialized`忽略，failure原样返回，ready提供完整DeviceRef。带`--device-ref <opaqueId>`时在Android/iOS slot中要求唯一匹配，否则instance-conflict或device-ambiguous；无opaqueId时优先选择唯一live identity，否则选择唯一ready identity，多候选fail closed为device-ambiguous。CLI从不拼namespace或调用private locator。
- `viewer ensure --platform android|ios`唯一执行`start-or-attach + same-platform auto selector + ensureViewer`；`--device-ref`先走上述lookup，再以完整DeviceRef执行`start-or-attach + known selector`。成功的`attachment.disposition`表示`started|attached`，不另增start/attach命令。
- inspect/wait/watch/stop先走上述无opaqueId lookup，并只用`acquireRuntime({mode:"attach-only",selector:{kind:"known",deviceRef}})`；这些命令绝不auto、初始化slot、调用resolver、spawn Runtime或重启terminal stream。
- shutdown以opaqueId在两个平台slot中lookup，再调用owner-local`shutdownRuntime({deviceRef})`；owner-local内部由DeviceRef.platform选择state并绑定authenticated current target，CLI不提供target。CLI/session close绝不等于shutdown。
- status严格按显式platform只读：不创建目录/slot、清temp、重建generation、解析设备、启动Runtime或修复状态。
- reset/rebind 只调用 Runtime owner-local maintenance seam；Integrations 不读取、删除或改写私有状态文件。

## Safe Results

所有 invocation 只返回由所属模块validator严格验证并冻结的exact typed result。普通control成功/失败直接复用Contracts DTO、`ControlError`与唯一revision-conflict snapshot，不复制或放宽validator。

- ensure success：`{ok:true,value:{attachment,deviceRef,descriptor,snapshot}}`，三个DeviceRef必须完全相同；失败不得带partial attachment/session。
- inspect/stop/shutdown：对应既有exact `ControlResult`；只有stop revision conflict可携带unchanged snapshot。
- status success为`{ok:true,value:{platform:"android"|"ios",state:"uninitialized"}}`，或同platform的`ready{deviceRef,stateRevision,runtime:{state:"not-running"|"live",target?}}` exact value；ready DeviceRef.platform 必须等于status platform。
- reset/rebind success：`{ok:true,value:{applied,platform:"android",previousDeviceRef,deviceRef,previousStateRevision,stateRevision}}`。拒绝确认时`applied:false`且两个identity/revision不变；reset applied时identity不变且revision恰加一；rebind applied时产生新DeviceRef且revision恰加一。
- Integrations-owned `CliError`是exact frozen `{code,disposition:"usage",operationState:"not-applied",safeMessage}`；唯一组合是`invalid-cli-syntax / Invalid command syntax.`与`confirmation-required / Interactive confirmation is required.`。其唯一observable failure wrapper恰为exact frozen`{ok:false,error:CliError}`；CLI validator逐层拒绝额外字段。Runtime-owned non-wire`RuntimeLiveError`由Runtime SPEC定义；其余失败复用既有ControlError。

## Rendering and Exit Status

- 默认输出是同一result的两空格缩进JSON；`--json`是compact JSON，均只有一个末尾LF且decode后deep-equal。除watch外，每个invocation的stdout恰好一个完整typed result；watch严格使用下方RFC7464 records。不得混入banner、prompt或log。
- Syntax failure在raw argv含exact `--json-seq`时按RFC7464输出一个compact CliError record并优先于`--json`；否则含exact `--json`时用compact JSON+LF，均不含时用pretty JSON+LF。unknown command、parse exception、duplicate/conflict、`--`等均确定性framing；syntax与non-TTY confirmation-required stderr为空且不回显raw argv。
- confirmation prompt只写interactive stderr；其他成功/失败stderr为空。prompt最多4096 UTF-8 bytes，不回显raw argv、provider output、异常或私有值。Exit `0`：success，包括confirmed decline的`applied:false`；`2`：CliError；`3`：recoverable或revision-conflict；`4`：terminal；`5`：state-unknown。

## Human Confirmation

- reset/rebind先检查`stdin.isTTY && stderr.isTTY`，否则在任何filesystem/ADB/socket/spawn I/O前返回confirmation-required。interactive时只有初始exact `ready + not-running` status可进入prompt；`live`无prompt返回RuntimeLiveError，`uninitialized`无prompt返回instance-not-found，unknown/corrupt/timeout原样safe failure。随后显示opaqueId与stateRevision并要求单行、大小写敏感、无前后空白的`RESET`/`REBIND`；其他输入或EOF是`applied:false`、exit 0、零mutation。
- exact prompts：`Reset android device <opaqueId> at state revision <N>? Type RESET to continue: ` 与 `Rebind android device <opaqueId> at state revision <N> and create a new DeviceRef? Type REBIND to continue: `。
- 确认后 commit 必须重新验证 expected完整DeviceRef/revision及 no-live 条件；任何竞态均 fail closed。

## Packaging, Privacy and Non-Responsibilities

- 当前 private npm package 增加 `bin` 映射到带 `#!/usr/bin/env node` 的构建入口及所需 build/test scripts；`private:true` 保持，不 publish，不改变 dependency/lock graph。验收必须从 pack 产物安装到临时 prefix 后经 PATH 执行，源码脚本不算证明。
- stdout/stderr/prompt/log/argv/status 不得含 control port/authority、root/client/owner credential、Android serial、ADB/cache/artifact path、binding、permit、claim/media cookie、semantic key、PID、raw cause、stack 或媒体。唯一可见 loopback authority 是 Contracts-owned `ViewerDescriptor.standaloneUri`。
- CLI 不安装/管理 ADB，不 kill/替换 global ADB，不发送设备控制命令，不停止 Appium Session、WDA、USB forward 或非 FSQ-owned 进程。stream stop 保持 Runtime；只有显式 owner shutdown 停 Runtime。

## Required Acceptance

Contract tests须覆盖实际pack/install/bin/shebang、全部syntax边界、human/JSON parity、exit映射、TTY拒绝/确认、旧approve语法I/O前拒绝及隐私canary。真实入口须完成 fresh zero-code ensure→Chrome fresh Live/rotation→inspect→stop且Runtime仍活→ensure新StreamId→shutdown，并验证global ADB与设备设置不受影响。

## RuntimeControl Wait Value Migration

本节定义用户已确认的 `ANDROID-CONTROL-WAIT-MACOS-04` clean cutover对既有调用方的窄增量；下方04B在不改变provider值的前提下新增CLI wait/watch。

- `viewer ensure`组合Contracts safe DTO，attachment中的`RuntimeInstance.features`当前为exact `["wait-v1","auto-bootstrap-v1","mcp-app-v1"]`；`stream inspect`原样返回observation且`timedOut:false`。
- Integrations validator/fixture/contract tests一次迁移，证明新tuple与四字段inspect精确、旧/额外feature拒绝；其他命令结果与隐私边界no-delta。

## macOS Android CLI Wait/Watch

本节定义用户已确认的 `ANDROID-CLI-WATCH-MACOS-04B` Integrations delta。范围仅为macOS arm64 + USB Android，依赖accepted Feature03 CLI与Feature04 provider wait；MCP、Windows、iOS、Runtime/Contracts变更及支持声明不在范围内。

### Exact grammar and one-shot wait

```text
fsq-scrcpy stream wait --stream-id <uuid> --after-revision <N> [--wait-ms <N>] --json
fsq-scrcpy stream watch --stream-id <uuid> [--after-revision <N>] --json-seq
```

- `--json`/`--json-seq`分别必需且互斥；waitMs为canonical decimal safe integer `0..30000`，缺省恰为30000；watch不接受wait-ms且每轮固定30000。沿用strict long-option、duplicate/token、UUID/revision及syntax-before-I/O规则，不增加short/env/positional。
- Syntax failure raw argv含exact `--json-seq`时输出一个RFC7464-framed compact CliError record；否则含`--json`时输出现有compact JSON+LF，均不含时沿用pretty JSON。两者同时出现仍invalid且`--json-seq` framing优先；stderr为空、exit2、零product I/O。
- 两命令先走唯一owner-local status lookup，再`acquireRuntime({mode:"attach-only",selector:{kind:"known",deviceRef}})`并持有一个session；禁止auto、resolver、ensure、spawn、stop、shutdown及owner mutation。

### Watch records and cursor

- 未提供after-revision时恰先调用一次`inspect({streamId})`并输出其exact result作为首record；提供cursor时不inspect，首调用即`wait({streamId,afterRevision,waitMs:30000})`。一个invocation至多一个active provider call。
- 每个success或failure整体作为一个record；不得拆changes、添加envelope/sequence/heartbeat/banner/end marker。timeout/reset/multi-change照常输出。只有record完整accepted后cursor才原子更新为`value.snapshot.revision`：timeout保持同revision，reset跳current，changes使用returned current。
- `stopping`不是terminal，完整输出后继续。仅`stopped|device-disconnected|failed`是terminal；terminal success完整输出后exit0。Provider failure完整输出为末record并按既有recoverable/terminal/state-unknown退出3/4/5；禁止reacquire、自动重连、inspect fallback或retry。
- Cursor只是invocation-local safe integer；CLI不保存cursor/history。外部调用方以最后一个完整record的snapshot.revision重启命令，provider决定ordered changes或reset；CLI不宣称自动恢复。

### RFC7464 writer, backpressure and lifecycle

- watch每record严格为UTF-8 `0x1E + compact JSON.stringify(exact result) + 0x0A`，无BOM/额外空白/第二LF；stdout不伪造Content-Type。按Runtime 16384-byte result cap，record最多16386 bytes。依据RFC7464 §2.2（2026-10-28核验，RFC Editor官方文本）；直接编码两control octets，不新增dependency。
- internal writer每次最多拥有一个result和一个encoded record；一次write后无论返回true/false都等待callback成功，false还必须等待drain，之后才能调用下一provider operation。callback/drain任意顺序、同步throw、callback error、error/close及pre-destroyed/pre-ended都用one-shot cleanup；持有invocation error/close listener避免uncaught error。不得继续写入或把highWaterMark当hard cap。
- Writer不拥有fd1，dispose不end/destroy stdout，只移除本invocation listeners。EPIPE/close可能留下RFC允许忽略的不完整尾record；CLI不补写/重发/猜测。consumer EPIPE/close立即abort active wait、close session、stderr空、无final record、exit3；其他stdout failure同样无原异常/stack/stderr或补写，exit5。若末record已完整accepted，其既定exit胜过之后output event。
- 首个SIGINT/SIGTERM经同一first-signal guard abort已有controller并执行上述协调路径。若outer cleanup完成前收到第二个SIGINT或SIGTERM，必须先移除本invocation的两个signal handlers，再把实际收到的第二个signal重新发送给自身，恢复Node/OS default强制终止；此升级路径不承诺structured尾record、exit3或finally cleanup，可能留下RFC7464允许consumer忽略的不完整尾record。正常首信号不abort已经交给stdout的record：active wait取消输出exact request-cancelled末record/exit3；nonterminal success先完整写出，再以aborted signal取得并写cancel末record；terminal/provider failure先线性化则原末record/exit胜且不追加cancel。one-shot只输出provider race的唯一result。
- stdout unavailable与user signal原因必须区分，不能在EPIPE后尝试cancel record。唯一outer finally恰关闭session和writer一次；CLI exit、signal、EPIPE、terminal或provider error都不stop stream/Runtime。

### Privacy and required acceptance

- 所有provider value先经Contracts validator及DeviceRef/StreamId parity检查；malformed/private/extra value走既有safe unexpected路径。serial/path/credential/permit/cookie/PID/raw cause/stack/media不得进入stdout/stderr；非交互stderr恒空。
- Tests必须覆盖：exact parser/default/boundaries与syntax framing；RFC逐byte/Unicode/16386-byte framing；callback+drain backpressure与一个record上限；无/有cursor、timeout/reset/changes/stopping/terminal/error parity；首信号正常协调race；EPIPE/close/other writer failures；session/writer恰一次cleanup及零side effect。另以write=false且永不callback/drain覆盖SIGINT→SIGINT、SIGTERM→SIGTERM及两种cross-signal：首信号不写第二record、不破坏已交付record，第二实际signal使process被signal终止且无stderr/private data/伪造final record。
- 真实入口必须使用npm pack→temporary prefix install→PATH executable，覆盖timeout/change/reset/terminal、正常SIGINT/SIGTERM协调cancel、上述二次signal强制升级、reader在完整record后close的EPIPE、以最后完整revision重新运行的cursor parity、stdout/stderr/privacy，且证明Runtime/stream/client exit无副作用。源码直跑不算packaging证据。

## Host-neutral Local Coding Agent Adapter

本节定义 `MCP-ADAPTER-MACOS-ANDROID-11A`。范围仍为本地 macOS arm64、恰好一台已授权 USB Android、persistent RuntimeControl 与 standalone Chrome Viewer；Windows、iOS、remote、MCP Apps、embedded Viewer、多设备/流/Viewer及支持矩阵条目不在范围内。

### Dependencies and package surface

- Integrations新增生产依赖exact `@modelcontextprotocol/server@2.3.1`与`zod@4.6.7`；新增仅开发/验收依赖exact `@modelcontextprotocol/client@2.3.1`。client及其仅验收传递依赖不得进入private pack产物的运行时依赖面。
- package保持`private:true`，同一包提供`fsq-scrcpy`与带shebang的`fsq-scrcpy-mcp`。不publish；pack/install/PATH child才是可执行入口证据。
- server、client、core、zod及client传递闭包必须在实际lock中完成registry/SRI/provenance、重复版本、advisory、SBOM及tarball LICENSE/NOTICE闭环；任何zod `<4.6.6`禁止Ready。
- Integrations依赖方向仍仅为Runtime + Contracts；Runtime/Contracts/Capture/Viewer不依赖Integrations或MCP SDK。SDK/Zod type不得跨入RuntimeControl或Contracts。

### Shared AgentControl seam

CLI与MCP共用一个Integrations-internal `AgentControl`，它唯一拥有acquire mapping、Contracts validator、DeviceRef/StreamId parity、下述exact safe unexpected mapping及session close-once：

```text
ensure(input,{signal}) -> EnsureAdapterResult
openKnown({deviceRef},{signal}) -> AgentControlSession
AgentControlSession.inspect(input,{signal}) -> ControlResult<InspectControlValue>
AgentControlSession.wait(input,{signal}) -> ControlResult<InspectControlValue>
AgentControlSession.stop(input,{signal}) -> StopStreamResult
AgentControlSession.close() -> Promise<void>
```

- `ensure`恰执行一次start-or-attach acquire及一次ensureViewer。`openKnown`恰执行一次attach-only acquire并返回仅含validated inspect/wait/stop与idempotent close的session。
- 每个MCP call最多一个session，并在唯一finally中close一次；不得缓存产品状态、cursor或自动retry/reacquire。
- 既有CLI owner-local lookup仍在AgentControl外；CLI watch继续一次lookup、一次openKnown并在整个inspect/wait loop持有同一session，保持Feature04B no-reacquire契约。
- Runtime shutdown、status、reset/rebind继续走既有owner-local CLI路径，永不进入AgentControl或MCP tools。
- AgentControl与四个MCP handler对malformed/extra/private/accessor provider output、identity parity mismatch及任何未分类异常统一返回exact frozen `{ok:false,error:{controlVersion:{major:1,minor:0},code:"runtime-exited",disposition:"state-unknown",operationState:"unknown",safeMessage:"The Runtime exited before its result was known."}}`。CLI与MCP不得选择其他ControlError tuple或泄漏cause/stack。

### Exact MCP tools

`fsq-scrcpy-mcp`恰注册以下四个raw tool；所有input为strict plain object、`additionalProperties:false`、无coercion，DeviceRef必须是完整exact Android DeviceRef：

| Tool | Exact input | Mapping |
| --- | --- | --- |
| `fsq_viewer_ensure` | `{selector:{kind:"auto",platform:"android"}|{kind:"known",deviceRef}}` | `AgentControl.ensure` |
| `fsq_stream_inspect` | `{deviceRef,streamId,afterRevision?}` | one `openKnown` then inspect |
| `fsq_stream_wait` | `{deviceRef,streamId,afterRevision,waitMs?}` | one `openKnown` then wait |
| `fsq_stream_stop` | `{deviceRef,streamId,expectedRevision?}` | one `openKnown` then stop |

- UUID/revision沿用Contracts exact validator。MCP waitMs为safe integer `0..25000`，缺省恰为25000；不改变Runtime/CLI既有`0..30000`契约。
- ensure success恰为`{ok:true,value:{attachment,deviceRef,descriptor,snapshot}}`且所有identity一致；failure恰为generic ControlError result。inspect/wait原样返回exact `ControlResult<InspectControlValue>`；stop原样返回`StopStreamResult`，仅revision-conflict可附snapshot。
- 每个到达handler的结果先经AgentControl/Contracts严格验证为一个frozen safe值`R`，再同时返回`structuredContent:R`和一个`text` block，其内容恰为compact `JSON.stringify(R)`；两者decode后deep-equal。禁止image/audio/resource/media content。
- success不设置`isError`；expected ControlError/revision-conflict设置`isError:true`。SDK high-level registerTool对unknown/disabled tool返回protocol error，对invalid arguments返回`isError:true` tool error。任何产品/validator/未知异常必须在handler内使用AgentControl的exact runtime-exited result；raw `Error.message`到达SDK catch是隐私缺陷。
- modern SDK顶层`resultType:"complete"`及`_meta["io.modelcontextprotocol/serverInfo"]`是允许的标准wire metadata，不属于`R`；禁止Host-specific metadata或产品别名/envelope。

### Dual-era stdio lifecycle and bounds

- Server使用`serveStdio(factory,{legacy:"serve",transport,onerror})`；transport是`StdioServerTransport(process.stdin,process.stdout,{maxBufferSize:65536})`，每个`McpServer`使用`maxToolInputElements:16`。
- 同一个factory服务legacy `2024-10-07`、`2024-11-05`、`2025-03-26`、`2025-06-18`、`2025-11-25`与modern `2026-07-28`。factory忽略era/Host identity，所有时代注册相同工具/schema/handler。
- 每个legacy连接必须以请求的exact revision完成initialize→initialized并pin一个fresh legacy instance。modern可由带合法per-request `_meta`的direct request或server/discover打开；repeated discover保持同一optimistic modern instance，首次non-discover enveloped request将其pin，modern连接禁止initialize。
- direct modern构造并pin一个modern instance；discover→modern沿用其optimistic instance；discover后fallback到legacy必须先close/discard probe instance，再构造fresh legacy instance。factory construction与tools/list执行零filesystem、ADB、socket、Runtime、session或output I/O，任何probe/fallback构造副作用都是缺陷。
- handler只把`ctx.mcpReq.signal`原样传给AgentControl。stdio `notifications/cancelled`必须引用原pending request ID并只abort该handler；unknown/already-complete ID忽略。cancel后不发送response，late value丢弃，session close一次，stream/Runtime不变。EOF abort该connection全部in-flight handler并遵循相同资源边界。
- Adapter不直接写stdout且不建无界queue。stdout只能由SDK写newline-delimited JSON-RPC；正常stderr为空。startup fatal/onerror只允许fixed、secret-safe、至多128 UTF-8 bytes的句子，禁止cause/stack/argv/private value。
- 首个SIGINT/SIGTERM协调close server handle与active invocation scopes一次；cleanup完成前第二个实际signal移除handlers并把该signal重发给自身，恢复默认强制终止。强制路径不承诺尾response。
- 适用Host或验收client的单次总调用预算至少45000ms。client disconnect、cancel、EOF、process exit或session close均不等于stream stop/Runtime shutdown。

### CLI JSON fallback and Host admission

- 现有CLI command grammar/result/exit不变。无MCP Coding Agent的cooperative fallback只使用viewer ensure、stream inspect、显式`--wait-ms 0..25000`的stream wait及stream stop的`--json`路径；不解析human/stderr/internal file，不把watch/json-seq包装成Agent protocol。
- CLI fallback没有tool discovery、structuredContent、connection lifecycle或标准per-request cancellation；它不是server-enforced least authority，同账号恶意进程仍属既有threat-model out-of-scope。
- response loss恢复固定为：lost ensure以同selector重试ensure；lost inspect重查同StreamId；lost wait重查或从最后完整revision继续；lost stop只inspect原StreamId。FSQ Adapter自身不retry。
- active verified Coding Agent Host register初始恰为`[]`。协议/真实产品链验收不生成Host entry，也不生成平台支持声明。
- 未来每个MCP/CLI Host必须固定exact tuple：Host product/version/build或commit、OS/arch、MCP mode/revision或CLI mode、installed FSQ package与executable hash、effective timeout、result-consumption path、cancel/signal与reconnect/replay policy、tool namespace/config、Chrome及device/OS/security-patch/encoder证据、验收日期。
- Host parity gate的product churn必须为零：不得修改FSQ product TS、tool schema/name/result/error、bin、dependency/lock、Runtime/Contracts/Capture/Viewer；允许隔离的acceptance harness与evidence。需要branch、alias、shim、custom env/flag、新command/result、cancellation proxy或dependency时gate失败并要求新Feature/SPEC delta。
- 每个gate必须真实覆盖installed executable启动、对应handshake、四工具及invalid/error/privacy、显式0/25000 wait、cancel或CLI signal、EOF/restart/replay、response-loss恢复、zero-code Viewer/rotation、stop/new StreamId、owner cleanup、global ADB与设备设置存活。
- verified entry恰记录上述identity tuple、gate ID、evidence location与date。任何新Host build/version默认unverified；FSQ/SDK/Host/platform的contract-affecting变化将entry置为`revalidation-required`；隐私、取消/deadline、重复副作用、安全或不可复现失败撤销active entry但保留dated history。
- FSQ不要求任何第三方Host修复/发布，不依赖其commit/version，也不增加专属branch/shim/flag/result/cancellation proxy。外部快照观察只留在feature/gate evidence，不进入SPEC。
- official client/harness是11A验收仪器，不是Coding Agent Host；verified Host register仍为空。11A acceptance恰为全部列明legacy revision和modern pin的installed official-client suite、byte-level installed-process lifecycle/bounds/privacy、现有CLI与全模块自动回归及独立完整差异审查。
- 11A不拥有最终Viewer授权流程；下方已确认11B在不改变Adapter接口的前提下提供auto-bootstrap。

- MCP/CLI/stdout/stderr/transcript/URL/log/state不得含frame、screenshot、JPEG/H.264、serial、path、provider locator、root/client/owner credential、ViewerGrant、pairingId、cookie、semantic key、PID、raw cause或stack；唯一可见loopback authority仍是safe `ViewerDescriptor.standaloneUri`。
- exact dev dependency `@modelcontextprotocol/client@2.3.1`必须以unwrapped base `StdioClientTransport`启动fresh pack/install中的absolute MCP bin。每个legacy client只宣告一个listed revision并完成exact negotiation；modern client exact pin `2026-07-28`且禁止fallback，并在session child上覆盖repeated discover及raw standard metadata observation。
- official client suite覆盖exact四工具list/call/schema、success/expected failure/invalid arguments/unknown tool、user abort、request timeout、original-ID cancel、no-late-response、EOF/restart及client/session close-once。另有byte-level installed-process检查非法stdout、自然EOF、65536 buffer、backpressure/EPIPE和signal，不能用client通过代替。
- 一个evidence manifest必须用exact pack hash、lock hash、installed bin、协议revision与safe timing关联wire、official-client、byte-level installed-process、CLI及全模块自动回归证据；fixture或不同制品不得拼接替代。11A不形成真实Agent Host、最终Viewer用户流程、设备媒体质量或支持矩阵声明，Feature验收后verified Host register仍为空。

## Agent Auto-Bootstrap Integration Clean Cut

本节定义 `AGENT-AUTO-VIEWER-BOOTSTRAP-MACOS-ANDROID-11B` 的 Integrations迁移；MCP Adapter仍为已接受11A基线，接口no-delta。

- 四个MCP tool name/schema/result、dual projection、legacy五revision、modern pin、stdio lifecycle/cancel/EOF和Host-neutral边界完全不变。`fsq_viewer_ensure`沿用同一AgentControl ensure；Runtime内部自动arm，AgentControl不接触permit/cookie或新增字段。
- CLI-only Agent `viewer ensure ... --json`获得相同zero-code行为。clean-cut删除`viewer approve --code` grammar、mapping、prompt/result/tests和Runtime owner-local approve seam；任何旧approve形式在product I/O前deterministic `invalid-cli-syntax`。
- status、shutdown、reset/rebind、inspect/wait/watch/stop行为不变；owner authority仍只用于shutdown/maintenance，MCP/ordinaryCLI不新增owner、device control或Appium authority。
- Runtime/fixture feature tuple同步迁移为exact `['wait-v1','auto-bootstrap-v1','mcp-app-v1']`；旧tuple fail closed。MCP/CLI output、URL、stderr、log、argv/env不得含permit、claim/media cookie、grant、pairing code/id或Runtime locator。
- installed package验收以同一pack/bin分别执行CLI、一个listed legacy和exact modern链：ensure后无需approve即能由本机用户打开真实Chrome并达fresh Live；覆盖fresh/reattach、response-loss same StreamId、TTL/race/rollback、refresh/grace、stop/new StreamId、Runtime restart和cleanup。official-client自动证据继续不生成verified Host entry。
- Capture、dependency/lock及11A SDK选择no-delta；若package/lock变化停止并重新进入依赖批准门槛。
## VS Code MCP App Presentation Adapter

本节定义 `ANDROID-MCP-VIEWER-04` 的 Integrations delta；目标只为Root固定的exact VS Code tuple。

### Dependency, capability and unchanged model tools

- 新增生产依赖exact `@modelcontextprotocol/ext-apps@2.0.3`与Root固定integrity；server/client/zod版本保持，React peer不安装。package metadata为MIT；distributed LICENSE为Apache-2.0/MIT transition且非spec文档含CC-BY-4.0。lock与实际bundled files必须完成registry/SRI/provenance/advisory/SBOM/LICENSE/NOTICE闭环后才能Ready。
- 四个模型可见tool name/input schema、safe`content`/`structuredContent` result、`isError`、legacy revisions、modern pin、cancel/EOF/signal和CLI JSON fallback不变。`fsq_viewer_ensure`仅增加标准`_meta.ui.resourceUri='ui://fsq-scrcpy/viewer-v1'`与`visibility:['model']`；其他三工具无UI metadata，App侧`tools/call fsq_viewer_ensure`必须由Host拒绝。
- 每个McpServer初始化后用official`getUiCapability`读取`capabilities.extensions['io.modelcontextprotocol/ui'].mimeTypes`，只要求exact包含`text/html;profile=mcp-app`。App↔Host UI handshake由ext-apps 2.0.3 pin到`2026-01-26`；VS Code product/build是验收identity而非capability字段。无extension/MIME的legacy或modern client不prepare，ensure原样返回standalone URL。
- `CallToolResult._meta`不得含credential、permit、cookie、Origin、Runtime locator或media；raw stdio仍满足既有privacy断言。标准UI linkage metadata只在tools/list，ordinary safe result`R` byte-for-byte不变。

### Deep presentation seam and resource ownership

- Integrations-internal`AgentPresentation`深模块在一个acquire/session内执行existing ensure、strict safe validation及可选`prepareEmbeddedViewer`，返回`{result:R,presentation?:{streamId,origin,expiresAt}}`；presentation值全为safe既有identity/origin且只驱动resource/CSP，不并入R。CLI继续用既有AgentControl；inspect/wait/stop不进入此seam。
- capability absent时不prepare且Host保持ordinary tool text。capability present但prepare返回任一fixed failure时仍返回R且presentation缺失；随后的resource read返回无外联fallback shell，不把presentation failure替换成模型可见error。pre-linearization cancel不prepare；post-ensure cancel/prepare response loss沿用各自state-unknown并允许same ensure/prepare重试，不滑动deadline。
- 每个server实例最多保留一个不可授权的current resource projection。`resources/read`始终返回bounded App shell：prepare success已linearize时附exact Runtime CSP；early read、无projection或prepare failure时返回empty-domain fallback shell并且该document不再升级为embedded。exact VS Code正常顺序仍须证明tool-result-before-read；并发ensure替换projection时，App以自身tool result校验StreamId/origin，stale/mismatched shell无授权力且只能fallback。
- `AgentPresentation`不复制deadline/terminal/claim状态；Runtime`ViewerAuthorization`是唯一authority。server close/EOF只清projection且不stop stream；stale/expired projection即使生成HTML，任何bind仍由Runtime权威拒绝。resource read不访问ADB/Capture、不延长deadline。
- resource使用official`registerAppResource`，tool使用`registerAppTool`；HTML/worker均来自现有Viewer build manifest并校验name/hash/MIME/byte cap，禁止动态模板注入、文件路径或任意asset读取。资源响应不含DeviceRef、credential、provider或媒体。

### Exact Host and acceptance

- target Host exact为VS Code Stable 1.144.0 arm64 build`2c33b50b16c472efe58357d1d2a8a5414bc23fbf`、macOS 26.7.1 build25G241、local stdio MCP、Apps`2026-01-26`。它是Feature验收目标而非已验证entry；通过前verified Host register仍为空。
- installed pack验收覆盖MIME capability、UI handshake、model-only visibility与App call拒绝、tool-result-before-resource-read、early/prepare-failure fallback shell、resource CSP、ensure embedded UI、unsupported/LNA/connect/App内fallback、invalid/unknown tool、0/25000 wait、cancel/EOF/restart/response loss、single-Viewer race、rotation/visibility/grace/socket-close terminal/stop/new StreamId/owner cleanup及raw stdout/stderr/transcript/privacy。
- Host或Android真实表面不可用时记录external evidence gap并保持Issue open；fixture、official client或Chrome standalone不能替代VS Code embedded UI。通过后只登记上述exact tuple；任何VS Code build、Apps protocol、SDK、Runtime feature tuple或security behavior变化置为`revalidation-required`。
