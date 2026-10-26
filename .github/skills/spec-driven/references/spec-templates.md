# SPEC Templates

SPEC 描述当前已确认的事实与契约。规划、候选方案、任务清单和历史日志不属于 SPEC。首次引导允许如实声明“尚未建立”，不得虚构架构。

## Root SPEC

```markdown
# {project} Project Specification

## Project Specification Ownership
项目级与模块级 SPEC 的职责边界。

## Module Table
已确认模块、职责及模块 SPEC 的相对链接。

## Architecture Diagram
已确认模块、依赖方向及关键 seam；无架构时明确声明。

## Development Rules
当前技术约束和跨模块不变量，不复制开发工作流。
```

## Module SPEC

```markdown
# Module: {name}

## Purpose
当前职责与不承担的职责。

## Dependencies
实际依赖和允许的依赖方向。

## Public Interface
公开入口、输入输出、错误、生命周期和性能约定。

## Internal Structure
当前内部结构和职责分解，不罗列不存在的文件。
```

按实际需要增加 `Error Handling`、`Verification Scope`、`Current Invariants`、`Data and State Flow` 或 `Frontend Architecture`。技术栈未确认前不得添加语言或框架专属章节。
