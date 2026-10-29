---
name: spec-driven
description: "Use only when the user explicitly invokes /spec-driven or $spec-driven to implement a FSQ_scrcpy change through SPEC confirmation, bounded implementation, verification, and independent diff audit. 项目开发唯一写入入口。"
argument-hint: "<confirmed-design-document-path | direct-project-change-request>"
user-invocable: true
disable-model-invocation: true
---

# Spec-Driven Development

## Entry

遵循根 [AGENTS.md](../../../AGENTS.md)。只有用户显式调用 `/spec-driven <已确认设计文档路径或直接变更请求>` 或 `$spec-driven <已确认设计文档路径或直接变更请求>` 才允许产品写入。引用命令、仅提及技能、模型自动加载或一般同意不构成授权；子任务只继承任务包中可核验的原始授权范围。

主会话承担 Tech Lead。产品 feature 实现前必须有充分澄清的当前单平台组合、单模块范围、经独立审查并由用户确认的设计与 feature 拆分。小型流程/文档变更或恢复已确认契约的缺陷修复可使用完整任务包，不强制造新设计文档；仍须 SPEC 判定、验证与独立审查。

## 1. Intake and baseline

1. 核实用户请求、授权边界、目标和非目标；重大方案或范围不明确时先澄清。
2. 普通项目任务只读取根规则和定位问题所需材料。进入本流程后，先读根 SPEC 的所有权/模块索引，再按任务包 `activeInputs` 的路径、标题或行范围读取适用模块契约、确认设计和证据；除跨模块影响无法判定外，不完整加载无关 SPEC、历史设计或 evidence。
3. 记录仓库、分支、HEAD 或 `unborn`、初始工作区状态和用户已有改动，不得自动制造提交。
4. 为当前 Feature 固定独立基线：优先使用前一已验收 Git commit/tree；必须保留脏工作区时，创建任务允许路径的不可变 pre-task 内容/缺失标记、SHA-256 和初始全局状态清单。无法区分任务改动与用户改动时停止澄清。
5. 固定平台组合、模块、FeatureID、前序验收依据、规模统计基线和整体验收条件；一次只推进一个实现中的 feature。
6. 按根 AGENTS 固定复用/选型评估、具体用户批准、版本与用途边界、官方资料、许可证及适配/验证要求。缺少批准或关键证据时不得进入实现。

## 2. SPEC gate

- 新增能力、模块、公共接口、依赖方向、平台承诺、性能承诺或改变可见行为：需要 SPEC delta。
- 仅恢复 SPEC 已明确规定的行为且不改变契约：可判定 no-delta，但必须给出具体条款、失败行为和证据。
- 仅修改流程配置而不改变产品事实：可判定流程类 no-delta，引用 SPEC 的流程所有权并说明缺口。
- 需要 delta 时由 Tech Lead 汇总并编辑 SPEC，展示变化、影响和待确认项；用户确认前禁止实现。确认后移除待确认标记。
- 新建或维护 SPEC 使用 [结构模板](./references/spec-templates.md)，只写实际适用内容。

## 3. Ready and implementation

1. Tech Lead 按 [紧凑任务包模板](./references/task-package-template.md) 生成完整任务包。正文只记录决定和 URI/路径、标题或行范围、SHA-256、字节数；不得复制 SPEC、设计、diff 或原始日志。授权、Feature 基线、active inputs、依赖与选型批准、文件所有权、验证入口和规模预算齐备后才能判定 Ready。
2. 将媒体采集/运行时实现交给 `streaming-engineer`，Viewer/MCP Apps/Adapter 体验交给 `agent-integration-engineer`，测试编写可交给 `quality-engineer`。子角色不得再委派。
3. 工程师只修改许可文件，保持已确认接口。发现库/API 不符、需要新依赖、扩大自研或改变契约时停止相关实现，返回 Tech Lead 处理门槛。
4. 同步直接相关文档，核对实际依赖版本与公共入口，执行覆盖变更的最小验证。媒体行为必须在实际表面运行验证；不能执行时说明原因和影响。
5. 工程师交付 `pending-review`，包含实际改动、命令与结果、未验证项和阻塞，不自报 Done。
6. 按起始基线统计累计产品代码新增行加删除行，目标约 1200 行以内；测试、文档和排除项单列。明显超出先重新拆分。
7. 当前 feature 完成以下差异证据、验证与独立审查后，才可进入下一个已授权 feature。

## 4. Complete feature diff evidence

由 Tech Lead 或任务内工程师将审查证据保存在会话临时区，不作为产品文件提交。

- 前一已验收 Git commit/tree 为基线时，生成该基线到当前交付状态的完整二进制差异，并单列属于交付的未跟踪文件。
- 使用已批准的 pre-task snapshot 基线时，对每个允许路径生成 baseline 内容/缺失标记到当前内容/缺失标记的完整差异；同时比较初始与当前工作区路径清单，并核验所有初始用户改动路径的内容身份，证明任务没有吸收或覆盖用户改动。
- `unborn` 仓库分别固定索引与工作区层，不伪造 HEAD。不得为生成证据而暂存用户文件。
- 每份产物记录绝对路径或内部 URI、SHA-256、字节数、差异数量和完整路径清单，覆盖修改、新增、删除、重命名、二进制及属于交付的忽略文件。
- `full` 的“完整”是当前 Feature 基线到交付状态的全部任务差异，不是其他已验收 Feature 或用户改动的累计 HEAD diff。证据可按文件分块读取，但不得用截断输出、diff stat 或开发者摘要代替完整差异。
- 审查开始后任务路径或身份变化必须重新生成证据；旧结论不得套用到新差异。

## 5. Independent audit and repair

1. 将固定任务包、其中列出的 active SPEC/设计 selectors、验证证据和完整 Feature 差异交给未参与本批实现或测试编写的新质量工程师上下文，按 `spec-implementation-audit` 执行；历史材料仅在任务包列为依据时读取。
2. 第一轮 `audit_mode=full`；证据缺失、截断或身份不一致时为 `audit-blocked`。
3. 有 findings 时按文件所有权合并分派修复，不逐条开启无边界循环。修复后重新验证并生成修复差异。
4. 后续为 `repair-only`，只核对既有问题、修复增量及其直接回归。
5. 最多自动修复两轮；仍有问题或范围争议时停止并交由用户决定。

## 6. Done and report

只有当前 feature 的 SPEC gate、实现、适用验证和独立审查均通过，Tech Lead 才可判定该 feature Done。全部 feature 通过后，还须完成当前平台/模块约定整体验收和适用真实链路，才能判定本批完成。

最终报告包含授权和 SPEC 决策、平台/模块/FeatureID、改动范围、产品/测试/文档规模、验证命令与结果、审查轮次和结论、整体验收状态、未解决问题与环境限制。用户未要求时不提交、不推送、不发布。
