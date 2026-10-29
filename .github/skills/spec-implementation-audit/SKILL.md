---
name: spec-implementation-audit
description: "Use for an independent audit explicitly invoked via /spec-implementation-audit or $spec-implementation-audit, or delegated within authorized SDD, of confirmed SPEC against complete implementation diffs; supports full and repair-only modes. 独立规格实现审查。"
argument-hint: "<task-package-and-diff-manifest> [full|repair-only]"
user-invocable: true
disable-model-invocation: true
---

# SPEC Implementation Audit

遵循根 [AGENTS.md](../../../AGENTS.md)。本流程只读，不修复、不编辑测试或实现、不执行未经授权的设备操作。用户可显式调用 `/spec-implementation-audit <任务包与差异清单> [full|repair-only]` 或 `$spec-implementation-audit ...`；已授权 SDD 中也可由 Tech Lead 明确委派。

## Required inputs

- TaskID、用户授权原文、范围和验收标准。
- Feature 基线身份：已验收 commit/tree，或允许路径的不可变 pre-task snapshot manifest；后者还须包含初始全局状态和用户改动身份。
- `activeInputs`：每个适用根/模块 SPEC、确认设计或证据的路径、标题/行范围、SHA-256 和字节数；不得用复制正文代替固定原文。
- 仓库/分支/HEAD 或 `unborn`、允许和禁止修改的文件、当前平台组合、模块、FeatureID、依赖验收和规模预算。
- 复用/选型记录、具体用户确认、目标版本和用途、官方资料、许可证及适配/验证证据；不适用须说明。
- Feature 基线到交付状态的完整任务差异；每份包含 URI、SHA-256、字节数、差异数量和路径清单。pre-task snapshot 模式还须证明初始用户路径未被任务改变。
- 实际验证命令、原始结果 artifact、环境、设备/浏览器/Agent 版本及未运行项。
- 审查模式；`repair-only` 还需上轮问题、审查身份和完整修复增量。

## Audit

1. 核对独立性：审查上下文不得参与同批实现或测试编写。独立性不足立即 `audit-blocked`。
2. 核对 Feature 基线、activeInputs 和差异产物的哈希、字节数、路径覆盖及当前身份。证据截断、遗漏、过期，或混入其他 Feature/用户改动时为 `audit-blocked`。
3. `full`：读取全部 Feature 差异及 activeInputs 指定原文，建立路径与条款对应表，审查需求覆盖、接口、依赖、生命周期、并发、错误、超时/取消、资源清理、隐私、安全、兼容性和回归。只在直接影响无法判断时补读相邻上下文，不默认加载历史 evidence 或无关模块 SPEC。
4. 测试、lint、开发者摘要或文件列表只能辅助，不能代替 active SPEC 和完整 Feature 差异。
5. `repair-only`：逐项核实既有问题是否关闭，阅读完整修复增量及其直接影响；不得借复审重开无关全面审查。
6. 每个 finding 必须给出 ID、严重程度、文件/位置、依据、证据、实际与期望、影响及修复验收条件。区分确认缺陷、疑问和环境阻塞。
7. 核对 feature 是否为可独立验证的行为，范围是否聚焦当前平台和模块，依赖是否已验收，是否混入后续 feature；核对约 1200 行规模口径和拆分依据。
8. 区分当前 feature 通过与模块/平台整体验收。模拟、单元测试或单一浏览器通过不能替代已承诺真实链路。
9. 核对复用和选型门槛：实际依赖、版本、用途、自研范围及许可证是否符合用户批准，资料是否对应目标版本并覆盖所依赖行为。越界为 finding，关键证据缺失为 `audit-blocked`。
10. 性能声明必须核对真实设备、分辨率、帧率、端到端延迟定义、测量方法和结果；主观观察不能支持性能通过。

## Output

- `audit_mode`: `full` 或 `repair-only`。
- `status`: `pass`、`findings` 或 `audit-blocked`。
- 已核对的 SPEC、设计、差异身份、完整范围和排除理由。
- 复用/选型与版本化证据结论。
- 问题表：ID、严重程度、位置、依据、证据、影响、修复验收条件。
- 复审逐项状态、验证缺口和剩余风险。
- 当前 feature 与模块/平台整体验收分别给出结论。

审查者不宣告项目 Done、不自行修复或批准范围变化。Tech Lead 汇总结果并按主流程处理。
