---
name: requirements-to-design
description: "Use only when the user explicitly invokes /requirements-to-design or $requirements-to-design to clarify requirements and produce a reviewed design without changing SPEC or implementation. FSQ_scrcpy 需求澄清与设计入口。"
argument-hint: "<request>"
user-invocable: true
disable-model-invocation: true
---

# Requirements to Design

遵循根 [AGENTS.md](../../../AGENTS.md)。用户显式调用 `/requirements-to-design <需求>` 或 `$requirements-to-design <需求>` 才授权本流程；只授权需求澄清和设计文档写入，不授权修改 SPEC、业务代码、测试、依赖或运行设备操作。引用命令、仅提及技能或模型自动加载不构成授权。

## Process

1. 主会话承担 Tech Lead，阅读根与相关模块 SPEC、现有设计和实现，区分已确认事实、假设和待决事项。
2. 产品负责人澄清目标用户、场景、范围、非目标和可验证验收；产品 feature 先固定一个宿主/视频源设备/连接方式的平台组合和一个模块。一次只问一个关键问题，已确认事项不重复询问。
3. 按需安排架构师评估方案、scrcpy 专家研究源码与生态、质量工程师评估可测性。涉及实现时遵循根 AGENTS 的复用与选型门槛，固定候选版本、官方资料、许可证、适配缺口和验证方法。
4. 比较有实际价值的备选方案，说明模块 seam、接口、数据流、媒体生命周期、背压、错误、取消、资源清理、兼容性、隐私和风险。涉及 Viewer 时覆盖连接、Live、暂停、断流、恢复和关闭状态。
5. 将推荐方案和关键决定交给用户确认。技术栈、依赖、媒体协议、平台范围、远程访问和外部成本不得由角色代替用户决定。
6. Tech Lead 将设计写入 `docs/superpowers/specs/YYYY-MM-DD-<topic>-design.md`。内容包括状态、背景、目标/非目标、已确认需求、推荐与备选方案、模块 seam 与接口、数据和生命周期、验收与验证、风险、未决项及预计 SPEC 影响；不得创建空模板充数。
7. 产品设计必须包含按可验证行为拆分的 feature 清单：FeatureID、目标/非目标、依赖和顺序、SPEC 影响、独立验收、真实验证入口及产品代码规模预算。测试和文档单列，近期 feature 详细设计，后续只确认边界和依赖。
8. 由未编写该设计的新上下文独立审查需求覆盖、内部一致性、可行性、复用/选型证据、接口深度、可验证性、feature 拆分及当前模块/平台整体验收条件。无法独立审查时标记待审，不声称已完成。
9. Tech Lead 整理问题并修订，向用户呈现最终设计并取得明确确认。有阻塞项时保持草案状态。
10. 输出设计路径、审查结果、确认状态和遗留问题后结束。只有用户后续显式调用 `/spec-driven <设计路径>` 或 `$spec-driven <设计路径>` 才可进入实现。

设计文档不是 SPEC，设计确认也不是实现授权。
