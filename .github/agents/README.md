# FSQ_scrcpy Agent Team

目标：让用户在设备由测试或 Coding Agent 操作时，通过独立 Web Viewer 或 Coding Agent 内嵌界面观看实时画面。

## Roles

| Agent | Responsibility | Boundary |
| --- | --- | --- |
| [tech-lead](tech-lead.agent.md) | SDD、SPEC gate、任务包、集成和最终验收 | 主会话；按授权写入和委派 |
| [product-lead](product-lead.agent.md) | 用户场景、范围和验收 | 只读研究 |
| [architect](architect.agent.md) | 模块 seam、接口和生命周期 | 只读研究 |
| [scrcpy-expert](scrcpy-expert.agent.md) | scrcpy/ADB/编码/浏览器媒体生态研究 | 只读研究 |
| [streaming-engineer](streaming-engineer.agent.md) | Capture、Runtime、分发与性能 | 限定实现，`pending-review` |
| [agent-integration-engineer](agent-integration-engineer.agent.md) | Web Viewer、MCP Apps、URL fallback 与 Adapter UX | 限定实现，`pending-review` |
| [quality-engineer](quality-engineer.agent.md) | 测试、验收或新上下文独立审查 | 测试任务可写；审查只读 |

工具字段限制能力类别；文字边界和文件所有权不是操作系统沙箱，仍须由宿主权限和任务包共同落实。

## Workflow

```text
用户目标
  → requirements-to-design（可选）
  → 设计独立审查与用户确认
  → spec-driven
  → SPEC gate
  → 单 feature 实现与验证
  → full 独立审查
  → 必要的 repair-only 复审
  → Tech Lead 汇总验收
```

显式入口：

- `/requirements-to-design <需求>` 或 `$requirements-to-design <需求>`
- `/spec-driven <设计路径或变更请求>` 或 `$spec-driven <设计路径或变更请求>`
- `/spec-implementation-audit <任务包与差异清单> [full|repair-only]` 或 `$spec-implementation-audit ...`

主会话承担 Tech Lead，不再创建 Tech Lead 子角色。叶角色不嵌套委派。并行任务必须依赖已满足且文件所有权互不冲突。宿主未原生加载角色时可用新的通用子上下文读取对应角色正文和完整任务包，但不得声称原生角色或权限隔离已经生效。
