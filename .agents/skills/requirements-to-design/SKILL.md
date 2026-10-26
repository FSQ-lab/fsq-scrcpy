---
name: requirements-to-design
description: "仅在用户显式调用 /requirements-to-design 或 $requirements-to-design 时澄清需求并产出经审查设计；不授权 SPEC 或实现修改。"
---

# Host Adapter

执行前必须完整读取仓库根 `AGENTS.md`、`SPEC.md` 和 `.github/skills/requirements-to-design/SKILL.md`，再遵循源技能全部流程。本文件只处理宿主发现与通用子 Agent 适配，不替代源正文。

用户显式调用 `$requirements-to-design <需求>` 或 `/requirements-to-design <需求>` 授权等价；设计确认不授权实现。主会话承担 Tech Lead，需要角色时直接创建叶子上下文并要求其先读取对应角色正文、固定 SPEC 和任务包。无法创建独立设计审查上下文时标记待审，不得自审冒充通过。
