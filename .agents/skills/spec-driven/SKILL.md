---
name: spec-driven
description: "仅在用户显式调用 /spec-driven 或 $spec-driven 时执行 FSQ_scrcpy SDD：SPEC 门槛、限定实现、验证与独立差异审查。"
---

# Host Adapter

执行前必须完整读取仓库根 `AGENTS.md`、`SPEC.md`、`.github/agents/tech-lead.agent.md` 和 `.github/skills/spec-driven/SKILL.md`，再遵循源技能全部流程。本文件不替代源正文。

用户显式调用 `$spec-driven <已确认设计路径或直接变更请求>` 或 `/spec-driven ...` 是产品开发唯一写入授权。主会话承担 Tech Lead，先完成基线、SPEC gate 和 Ready，再直接委派叶角色；禁止委派 Tech Lead 子角色或让叶角色嵌套委派。

宿主未原生发现具名角色时，可创建通用新上下文，要求其完整读取对应 `.github/agents/<role>.agent.md`、宿主适配配置及固定任务包。不得声称回退已经加载原生角色或形成权限隔离。首次独立审查必须使用未参与实现/测试的新上下文；不可用时报告 `audit-blocked`。
