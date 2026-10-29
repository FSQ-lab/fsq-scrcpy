# Project Agent Instructions

## Authorization

- 默认中文沟通。项目写入只由用户显式调用 `/spec-driven <已确认设计路径或直接变更请求>` 或 `$spec-driven ...` 授权；自然语言同意、引用命令、加载配置或模型自动加载不构成授权。
- `/requirements-to-design` 只授权需求澄清和设计文档；`/spec-implementation-audit` 只授权只读审查。已授权 SDD 内的独立审查可由 Tech Lead 按任务包委派。
- 必须读取被调用技能。入口与流程定义见 [SDD](.github/skills/spec-driven/SKILL.md)、[需求到设计](.github/skills/requirements-to-design/SKILL.md) 和 [实现审查](.github/skills/spec-implementation-audit/SKILL.md)。

## Focused iteration

- 每批固定一个宿主、视频源设备、连接方式、必要运行时和一个模块；前序 feature 完成验证及独立审查后才进入后续 feature。
- Feature 按可验证行为拆分，包含目标、非目标、依赖、验收和验证入口；产品代码新增加删除以约 1200 行为拆分目标，测试和文档单列。
- 同时只推进一个实现中的 feature。阻塞时不得绕过门槛开发后续能力。
- SPEC 只维护当前已确认契约；计划、状态、规模、历史决策和验收证据属于设计、任务材料或 evidence 文件。
- 真实设备、浏览器或目标 Agent 不可用时必须报告缺口；模拟通过不代表真实链路或支持矩阵通过。

## SPEC and context ownership

- 根 [SPEC.md](SPEC.md) 只定义项目事实、全局边界和模块索引；模块 SPEC 定义模块职责、接口、依赖和当前约束；本文件与技能定义流程。
- 每次变更先判定 SPEC delta。新增或改变可见行为、公共接口、依赖方向、平台/性能承诺需要 delta 并在实现前由用户确认；恢复既有契约或纯流程配置可给出具体依据后判定 no-delta。
- 新模块必须登记根模块表。跨仓接口变化必须指出另一仓所需契约更新，不得静默修改另一仓或暴露内部实现。
- 普通项目问答只读取本文件和定位问题所需材料。进入工作流后，任务包以路径、标题/行范围和 SHA-256 列出 active SPEC、设计及证据；除任务明确要求，不完整加载历史设计、evidence 或无关模块 SPEC。

## Reuse and selection gate

- 实现 feature 前评估标准库、现有封装、已批准依赖和成熟第三方实现；协议、编解码、浏览器媒体、设备通信及通用基础设施不得未经评估自研。
- 新增、替换、扩大依赖用途或例外自研需要用户明确批准。记录目标版本、用途边界、维护/安全/许可证/平台证据、适配缺口和验证方法；关键版本化证据缺失时停止相关实现。
- 纯流程或文档任务可说明不适用；不得借此改变产品依赖或行为。

## Confirmed cross-project seam

- `FSQ_scrcpy` 负责实时视频采集、流生命周期、分发和 Web Viewer；不负责设备自动化命令、Appium Session 或页面结构语义观测。
- `Appium_connect_agent` 负责设备操控、Session、语义观测及 Coding Agent Adapter；可使用本项目稳定公开接口，但不得依赖内部实现。
- Viewer 首批只读。控制能力、远程访问或新的跨项目 seam 均需新的产品范围和 SPEC delta。

## Team and task gates

- 主会话承担 `tech-lead`，负责授权、SPEC gate、任务包、集成和最终 Done，不作为子角色委派。
- `product-lead`、`architect`、`scrcpy-expert` 只读研究；`streaming-engineer` 负责 Capture/Runtime；`agent-integration-engineer` 负责 Viewer/Agent 集成；`quality-engineer` 负责授权测试或新的独立审查上下文。
- 子角色不得再委派。只并行依赖已满足且文件所有权互斥的任务；简单任务不强制启动团队。
- 每个委派必须使用 [紧凑任务包](.github/skills/spec-driven/references/task-package-template.md)：固定授权、Feature 基线、active inputs 及哈希、所有权、依赖/选型、验收、验证和停止条件。正文引用固定原文，不复制 SPEC、设计、diff 或日志。
- 工程角色只能交付 `pending-review`。参与本批实现或测试编写的上下文不得审查同批变更；接口冲突、身份不符、文件重叠或门槛缺失时停止相关工作。
- 不覆盖用户改动，不自动提交、推送、发布或扩大设备/网络权限。

## Verification and completion

- 使用已确认的现有工具。Bug 修复先复现，再按同一路径确认消失；视频行为必须在实际 Viewer 表面验证；性能证据必须记录环境和测量方法。
- 完整审查针对当前 Feature 基线到交付状态的全部任务差异，而不是无关的累计工作区差异。测试、lint、摘要或文件列表不能替代 active SPEC 与完整任务差异。
- 第一轮为新的独立 full audit；修复后只做 repair-only，最多自动修复两轮。只有 SPEC gate、实现、适用验证和独立审查均通过，Tech Lead 才能判定 Done。
- 用户未要求时不提交、不推送、不发布。
