# FSQ_scrcpy Agent Team

目标：让用户在设备由测试或 Coding Agent 操作时，通过独立 Web Viewer 或 Coding Agent 内嵌界面观看实时画面。

## Roles

| Agent | Responsibility | Boundary |
| --- | --- | --- |
| [tech-lead](tech-lead.agent.md) | Issue 分解、技术契约、集成和最终验收 | 主会话；协调交付 |
| [product-lead](product-lead.agent.md) | 用户场景、范围和验收 | 只读研究 |
| [architect](architect.agent.md) | 模块 seam、接口和生命周期 | 只读研究 |
| [scrcpy-expert](scrcpy-expert.agent.md) | scrcpy/ADB/编码/浏览器媒体生态研究 | 只读研究 |
| [streaming-engineer](streaming-engineer.agent.md) | Capture、Runtime、分发与性能 | Issue 限定实现 |
| [agent-integration-engineer](agent-integration-engineer.agent.md) | Web Viewer、MCP Apps、URL fallback 与 Adapter UX | Issue 限定实现 |
| [quality-engineer](quality-engineer.agent.md) | 测试、验收或高风险独立审查 | 测试任务可写；审查只读 |

工具字段限制能力类别；文字边界和文件所有权不是操作系统沙箱，仍须由宿主权限和 Issue 范围共同落实。

## Workflow

```text
用户目标或缺陷
  → 创建/补全 GitHub Issue
  → 设置优先级、依赖、范围和验收标准
  → 实现并同步适用技术契约
  → 执行自动化与真实表面验证
  → 按风险审查
  → 在 Issue 记录证据并关闭
```

GitHub Issues 是计划、状态、任务和验收证据的唯一入口。SPEC 只保存当前技术契约；不再使用项目级 slash workflow、SPEC gate 或紧凑任务包。

主会话承担 Tech Lead，不创建 Tech Lead 子角色。叶角色不嵌套委派。并行任务必须依赖已满足且文件所有权互不冲突；每个委派引用 Issue 并明确范围、验收和验证。
