# Codex adapter

本目录让 Codex 复用根 `AGENTS.md`、`.github/agents/` 和 `.github/skills/` 定义的 FSQ_scrcpy SDD。源角色与源技能是职责和流程的唯一来源；本目录只负责发现和调用适配。

## Entry

在项目根的新 Codex 会话中使用：

```text
$requirements-to-design <需求>
$spec-driven <已确认设计路径或直接变更请求>
$spec-implementation-audit <任务包与差异清单> full
```

对应 `/...` 形式授权等价。仅提及技能、加载配置或自然语言一般同意不构成授权。

主会话承担 Tech Lead，直接分配六个叶角色；最多三个并发，且只对依赖已满足、文件所有权互斥的任务并行。每个角色开工前读取根规则、对应 `.github/agents/<role>.agent.md` 和固定任务包，核验身份后只读取任务包 `activeInputs` 指定的原文 selector。

若当前 Codex 版本无法原生选择自定义角色，可创建新的通用子上下文并在任务中要求读取 `.codex/agents/<role>.toml` 和源角色正文。不得声称这种回退已加载原生角色或形成权限隔离。独立审查必须是未参与实现/测试的新上下文；不可用时报告 `audit-blocked`。

创建或修改配置不会改变已经启动的聊天；需要时从项目根新开会话并实际验证角色和技能发现。
