# Module: Integrations

> **Status: CONFIRMED — `ANDROID-CLI-MACOS-03`.**

## Purpose

拥有 `FSQ_scrcpy` 的外层可执行 Adapter：命令语法、交互确认、安全渲染、退出状态及 npm executable packaging。Integrations 只编排 Runtime/Contracts 的公开值与 owner-local seam，不实现流、本机状态或设备绑定状态机。

## Dependencies

- Integrations 可依赖 Runtime、Contracts 与 Node.js 标准库；Runtime/Capture/Viewer 不依赖 Integrations。
- CLI 不得导入 Runtime 的 state 文件类、HTTP owner client、credential/port locator，或 Capture resolver/reveal access。
- 解析固定复用 Node.js 24.22.1 stable `node:util.parseArgs`。不新增 CLI dependency，现有 dependency 与 lock graph 不变。

## `ANDROID-CLI-MACOS-03` Scope

平台组合固定为本地 macOS arm64、恰好一台已授权 USB Android、persistent RuntimeControl 和 standalone Chrome Viewer。`ANDROID-CLI-MACOS-03`建立基础CLI；下方`ANDROID-CLI-WATCH-MACOS-04B`新增provider wait映射。Model Context Protocol、Windows、iOS、embedded Viewer、远程、多个设备/流/Viewer及支持矩阵条目仍不在范围内。

## Exact Command Surface

```text
fsq-scrcpy viewer ensure (--platform android | --device-ref <uuid>) [--json]
fsq-scrcpy stream inspect --stream-id <uuid> [--after-revision <N>] [--json]
fsq-scrcpy stream wait --stream-id <uuid> --after-revision <N> [--wait-ms <N>] --json
fsq-scrcpy stream watch --stream-id <uuid> [--after-revision <N>] --json-seq
fsq-scrcpy stream stop --stream-id <uuid> [--expected-revision <N>] [--json]
fsq-scrcpy viewer approve --stream-id <uuid> --code <PAIRING_CODE> [--json]
fsq-scrcpy runtime shutdown --device-ref <uuid> [--json]
fsq-scrcpy local-state status --platform android [--json]
fsq-scrcpy local-state reset-control --platform android --device-ref <uuid> [--json]
fsq-scrcpy local-state rebind-device --platform android --device-ref <uuid> [--json]
```

- 只接受上述两段 command path 与长选项；无短别名、额外 positional、`--yes`、`--force`、环境变量配置或隐式平台。`--name value` 与 `--name=value` 等价。
- 先识别精确 command path，再以 `strict:true, allowPositionals:false, allowNegative:false, tokens:true` 解析其余参数；未知、重复、缺失、额外、冲突 option 及 `--` 在任何 filesystem/ADB/socket/spawn I/O 前失败。`tokens` 必须用于拒绝 `parseArgs` 默认 last-wins 的重复项。
- UUID 为 canonical lowercase non-nil v4；revision 为无前导零的正十进制 safe integer；pairing code 恰好匹配 `[0-9A-HJKMNP-TV-Z]{8}`；本 feature 的 platform 只接受 `android`。
- `--device-ref` 是已有完整本机 `DeviceRef.opaqueId` 的比较值；CLI 不自行拼接 namespace、生成或 remap identity。

## Operation Mapping

- owner-local只读status是所有stored-identity命令的唯一lookup：`uninitialized`映射instance-not-found，failure原样返回，ready提供完整DeviceRef；带`--device-ref <opaqueId>`时必须与该完整DeviceRef.opaqueId相等，否则instance-conflict。CLI从不拼namespace或调用private locator。
- `viewer ensure --platform android`唯一执行`start-or-attach + auto selector + ensureViewer`；`--device-ref`先走上述lookup，再以完整DeviceRef执行`start-or-attach + known selector`。成功的`attachment.disposition`表示`started|attached`，不另增start/attach命令。
- inspect/wait/watch/stop/approve先走上述无opaqueId lookup。inspect/wait/watch/stop只用`acquireRuntime({mode:"attach-only",selector:{kind:"known",deviceRef}})`；approve调用owner-local`approveViewerPairing({deviceRef,streamId,pairingCode})`。这些命令绝不auto、初始化slot、调用resolver、spawn Runtime或重启terminal stream；wait/watch的single-session loop由下方契约进一步限定。
- shutdown先以其opaqueId走上述lookup，再调用owner-local`shutdownRuntime({deviceRef})`；owner-local内部绑定authenticated current target，CLI不提供target。CLI/session close绝不等于shutdown。
- status 严格只读：不创建目录/slot、清 temp、重建 generation、解析设备、启动 Runtime 或修复状态。
- reset/rebind 只调用 Runtime owner-local maintenance seam；Integrations 不读取、删除或改写私有状态文件。

## Safe Results

所有 invocation 只返回由所属模块validator严格验证并冻结的exact typed result。普通control成功/失败直接复用Contracts DTO、`ControlError`与唯一revision-conflict snapshot，不复制或放宽validator。

- ensure success：`{ok:true,value:{attachment,deviceRef,descriptor,snapshot}}`，三个DeviceRef必须完全相同；失败不得带partial attachment/session。
- inspect/stop/approve/shutdown：对应既有exact `ControlResult`；只有stop revision conflict可携带unchanged snapshot。
- status success为`{ok:true,value:{platform:"android",state:"uninitialized"}}`，或`{ok:true,value:{platform:"android",state:"ready",deviceRef,stateRevision,runtime:{state:"not-running"}}}`，或同一ready value且runtime为`{state:"live",target:{instanceId,generation}}`。
- reset/rebind success：`{ok:true,value:{applied,platform:"android",previousDeviceRef,deviceRef,previousStateRevision,stateRevision}}`。拒绝确认时`applied:false`且两个identity/revision不变；reset applied时identity不变且revision恰加一；rebind applied时产生新DeviceRef且revision恰加一。
- Integrations-owned `CliError`是exact frozen `{code,disposition:"usage",operationState:"not-applied",safeMessage}`；唯一组合是`invalid-cli-syntax / Invalid command syntax.`与`confirmation-required / Interactive confirmation is required.`。其唯一observable failure wrapper恰为exact frozen`{ok:false,error:CliError}`；CLI validator逐层拒绝额外字段。Runtime-owned non-wire`RuntimeLiveError`由Runtime SPEC定义；其余失败复用既有ControlError。

## Rendering and Exit Status

- 默认输出是同一result的两空格缩进JSON；`--json`是compact JSON，均只有一个末尾LF且decode后deep-equal。除watch外，每个invocation的stdout恰好一个完整typed result；watch严格使用下方RFC7464 records。不得混入banner、prompt或log。
- Syntax failure在raw argv含exact `--json-seq`时按RFC7464输出一个compact CliError record并优先于`--json`；否则含exact `--json`时用compact JSON+LF，均不含时用pretty JSON+LF。unknown command、parse exception、duplicate/conflict、`--`等均确定性framing；syntax与non-TTY confirmation-required stderr为空且不回显raw argv。
- confirmation prompt只写interactive stderr；其他成功/失败stderr为空。prompt最多4096 UTF-8 bytes，不回显raw argv、pairing code、provider output、异常或私有值。Exit `0`：success，包括confirmed decline的`applied:false`；`2`：CliError；`3`：recoverable或revision-conflict；`4`：terminal；`5`：state-unknown。OS强制终止不承诺结构化输出；可协调的取消必须返回既有safe result。

## Human Confirmation

- approve 不增加 prompt；用户给出的八字符 code 沿用既有 comparison/TTL/attempt 规则，错误/过期/重放统一 unauthorized，且不回显。
- reset/rebind先检查`stdin.isTTY && stderr.isTTY`，否则在任何filesystem/ADB/socket/spawn I/O前返回confirmation-required。interactive时只有初始exact `ready + not-running` status可进入prompt；`live`无prompt返回RuntimeLiveError，`uninitialized`无prompt返回instance-not-found，unknown/corrupt/timeout原样safe failure。随后显示opaqueId与stateRevision并要求单行、大小写敏感、无前后空白的`RESET`/`REBIND`；其他输入或EOF是`applied:false`、exit 0、零mutation。
- exact prompts：`Reset android device <opaqueId> at state revision <N>? Type RESET to continue: ` 与 `Rebind android device <opaqueId> at state revision <N> and create a new DeviceRef? Type REBIND to continue: `。
- 确认后 commit 必须重新验证 expected完整DeviceRef/revision及 no-live 条件；任何竞态均 fail closed。

## Packaging, Privacy and Non-Responsibilities

- 当前 private npm package 增加 `bin` 映射到带 `#!/usr/bin/env node` 的构建入口及所需 build/test scripts；`private:true` 保持，不 publish，不改变 dependency/lock graph。验收必须从 pack 产物安装到临时 prefix 后经 PATH 执行，源码脚本不算证明。
- stdout/stderr/prompt/log/argv/status 不得含 control port/authority、root/client/owner credential、Android serial、ADB/cache/artifact path、binding、ViewerGrant、pairingId、cookie、semantic key、PID、raw cause、stack 或媒体。唯一可见 loopback authority 是 Contracts-owned `ViewerDescriptor.standaloneUri`。
- CLI 不安装/管理 ADB，不 kill/替换 global ADB，不发送设备控制命令，不停止 Appium Session、WDA、USB forward 或非 FSQ-owned 进程。stream stop 保持 Runtime；只有显式 owner shutdown 停 Runtime。

## Required Acceptance

Contract tests须覆盖实际pack/install/bin/shebang、全部syntax边界、human/JSON parity、exit映射、TTY拒绝/确认、stdout/stderr界线与隐私canary。真实macOS Android入口须完成 fresh ensure→Chrome pairing→fresh Live/rotation→inspect→stop且Runtime仍活→ensure新StreamId→shutdown，并验证 client exit不停止Runtime、reset/rebind的live/unknown/corrupt/stale/decline/race均零mutation，confirmed reset保留DeviceRef，confirmed rebind生成新DeviceRef，global ADB与设备设置不受影响。通过仍不建立平台支持条目。

## RuntimeControl Wait Value Migration

本节定义用户已确认的 `ANDROID-CONTROL-WAIT-MACOS-04` clean cutover对既有调用方的窄增量；下方04B在不改变provider值的前提下新增CLI wait/watch。

- `viewer ensure`继续原样组合Contracts safe DTO，attachment中的`RuntimeInstance.features`为exact `["wait-v1"]`；`stream inspect`继续原样返回observation且`timedOut:false`。下方wait/watch复用同一validator，不增加DTO。
- Integrations validator/fixture/contract tests必须一次性迁移，证明pretty/compact decode后deep-equal、新tuple与四字段inspect精确、旧/额外feature及三字段inspect拒绝；其他命令结果与隐私边界no-delta。

## macOS Android CLI Wait/Watch

本节定义用户已确认的 `ANDROID-CLI-WATCH-MACOS-04B` Integrations delta。范围仅为macOS arm64 + USB Android，依赖accepted Feature03 CLI与Feature04 provider wait；MCP、Windows、iOS、Runtime/Contracts变更及支持声明不在范围内。

### Exact grammar and one-shot wait

```text
fsq-scrcpy stream wait --stream-id <uuid> --after-revision <N> [--wait-ms <N>] --json
fsq-scrcpy stream watch --stream-id <uuid> [--after-revision <N>] --json-seq
```

- `--json`/`--json-seq`分别必需且互斥；waitMs为canonical decimal safe integer `0..30000`，缺省恰为30000；watch不接受wait-ms且每轮固定30000。沿用strict long-option、duplicate/token、UUID/revision及syntax-before-I/O规则，不增加short/env/positional。
- Syntax failure raw argv含exact `--json-seq`时输出一个RFC7464-framed compact CliError record；否则含`--json`时输出现有compact JSON+LF，均不含时沿用pretty JSON。两者同时出现仍invalid且`--json-seq` framing优先；stderr为空、exit2、零product I/O。
- 两命令先走唯一owner-local status lookup，再`acquireRuntime({mode:"attach-only",selector:{kind:"known",deviceRef}})`并持有一个session；禁止auto、resolver、ensure、spawn、stop、approve、shutdown及owner mutation。wait恰调用一次`control.wait`，无inspect/retry，验证identity/exact result后输出一个compact JSON+LF并关闭session。

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

- 所有provider value先经Contracts validator及DeviceRef/StreamId parity检查；malformed/private/extra value走既有safe unexpected路径。serial/path/credential/grant/pairingId/PID/raw cause/stack/media不得进入stdout/stderr；非交互stderr恒空。
- Tests必须覆盖：exact parser/default/boundaries与syntax framing；RFC逐byte/Unicode/16386-byte framing；callback+drain backpressure与一个record上限；无/有cursor、timeout/reset/changes/stopping/terminal/error parity；首信号正常协调race；EPIPE/close/other writer failures；session/writer恰一次cleanup及零side effect。另以write=false且永不callback/drain覆盖SIGINT→SIGINT、SIGTERM→SIGTERM及两种cross-signal：首信号不写第二record、不破坏已交付record，第二实际signal使process被signal终止且无stderr/private data/伪造final record。
- 真实入口必须使用npm pack→temporary prefix install→PATH executable，覆盖timeout/change/reset/terminal、正常SIGINT/SIGTERM协调cancel、上述二次signal强制升级、reader在完整record后close的EPIPE、以最后完整revision重新运行的cursor parity、stdout/stderr/privacy，且证明Runtime/stream/client exit无副作用。源码直跑不算packaging证据。
