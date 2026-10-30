# Project Agent Instructions

## Communication and work authorization

- 默认中文沟通。GitHub Issues 是项目计划、优先级、依赖、任务状态和验收证据的唯一管理入口。
- 非平凡项目写入必须关联一个 open Issue；用户直接提出的新工作应先创建或补全 Issue，再在其范围内实施。Issue 本身不授权破坏性操作、提交、推送、发布、安装依赖或扩大设备/网络权限，这些仍需用户明确要求。
- Issue 必须包含目标、非目标、依赖、验收标准、验证入口和隐私/安全边界。状态、历史决策、进度和验收证据写入 Issue，不写入 SPEC。

## Focused iteration

- 每个 Issue 固定可验证行为；涉及平台时明确宿主、视频源设备、连接方式、必要运行时和负责模块。
- 依赖未完成的 Issue 保持 blocked，不绕过依赖推进后续能力。同时只推进一个相互依赖链上的实现 Issue；文件所有权互斥的独立 Issue 可并行。
- 产品代码新增加删除以约 1200 行为拆分参考，测试和文档单列；超过时优先按可独立验收行为拆分，而不是压缩代码或降低验证。
- 真实设备、浏览器或目标 Agent 不可用时必须在 Issue 报告缺口；模拟通过不代表真实链路或支持矩阵通过。

## Technical contract ownership

- 根 [SPEC.md](SPEC.md) 只定义项目事实、全局边界和模块索引；模块 SPEC 定义模块职责、接口、依赖和当前约束。SPEC 不管理计划、状态、优先级或验收历史。
- 新增或改变可见行为、公共接口、依赖方向、平台或性能承诺时，在同一 Issue 和实现中同步更新适用 SPEC；不设置独立 SPEC gate。
- 新模块必须登记根模块表。跨仓接口变化必须在双方仓库建立关联 Issue 并同步技术契约，不得静默修改另一仓或暴露内部实现。

## Reuse and dependencies

- 实现前评估标准库、现有封装、已批准依赖和成熟第三方实现；协议、编解码、浏览器媒体、设备通信及通用基础设施不得未经评估自研。
- 新增、替换、扩大依赖用途或例外自研必须在 Issue 记录目标版本、用途边界、维护/安全/许可证/平台证据、适配缺口和验证方法，并取得用户明确批准。
- 纯流程或文档任务不得借机改变产品依赖或行为。

## Confirmed cross-project seam

- `FSQ_scrcpy` 负责实时视频采集、流生命周期、分发和 Web Viewer；不负责设备自动化命令、Appium Session 或页面结构语义观测。
- `Appium_connect_agent` 负责设备操控、Session、语义观测及 Coding Agent Adapter；可使用本项目稳定公开接口，但不得依赖内部实现。
- Viewer 首批只读。控制能力、远程访问或新的跨项目 seam 需要独立 Issue 和技术契约更新。

## Team and review

- 主会话负责 Issue 分解、依赖、集成和最终交付；按任务选择 `product-lead`、`architect`、`scrcpy-expert`、`streaming-engineer`、`agent-integration-engineer` 或 `quality-engineer`。
- 子角色不得再委派。委派内容必须引用 Issue，明确文件所有权、验收标准、验证入口和停止条件；不要求紧凑任务包或固定哈希清单。
- 审查按风险选择：公共接口、安全边界、依赖、并发、媒体生命周期和跨仓契约应安排独立审查；普通局部变更可由主会话直接复核。独立审查不再是所有变更的强制完成门槛。
- 不覆盖用户改动，不自动提交、推送或发布。

## Verification and completion

- Bug 修复先复现，再按同一路径确认消失；视频行为必须在实际 Viewer 表面验证；性能证据必须记录环境和测量方法。
- 永久功能或接口变更执行覆盖变更契约的测试；真实设备、浏览器或 Host 验收不能由 fixture、类型检查或摘要替代。
- 只有 Issue 的验收标准和适用验证全部满足，才能关闭。关闭说明记录提交/PR、命令与结果、真实环境、未覆盖范围和后续 Issue；有阻塞时保持 open 并标明 blocker。
- 用户未要求时不提交、不推送、不发布。
