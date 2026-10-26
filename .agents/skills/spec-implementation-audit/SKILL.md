---
name: spec-implementation-audit
description: "用户显式调用，或已授权 SDD 内由 Tech Lead 委派时，执行 full 或 repair-only 独立只读审查。"
---

# Host Adapter

执行前必须完整读取仓库根 `AGENTS.md`、`SPEC.md` 和 `.github/skills/spec-implementation-audit/SKILL.md`，再遵循源技能全部流程。本入口不授权修复。

审查必须在未参与本批实现或测试编写的新上下文中完成，实际读取并核验固定 SPEC、任务包、完整差异和身份。证据不足或独立性不足时报告 `audit-blocked`；审查者不得编辑、修复、再委派或宣布 Done。
