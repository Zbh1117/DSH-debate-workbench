# Changelog

本项目遵循语义化版本（`MAJOR.MINOR.PATCH`）。插件与 DSH 宿主版本解耦：插件版本独立发布，兼容性在 README 中标注。

## 0.6.0

- **修复**：工具默认工作区改为「全局指针里的激活工作区」优先，解决「工具写入 A 工作区、右栏界面读取 B 工作区」的数据错位（公共证据库为空的问题即由此引起）；`debate_library` 返回值新增 `workspace` / `libraryPath` 便于诊断。
- 新增回归测试：工具默认跟随激活工作区。

## 0.5.0

- 新增 `debate_context`（digest / outline / search_evidence）：低成本上下文摘要与跨库证据检索。
- 新增 `debate_plan`（build_tree / fill_attacks）：批量编排，默认 dryRun，`apply=true` 才写入。
- `debate_evidence` 新增 `import`：批量入库 + 挂载，来源必填、标题+url 去重、默认 dryRun。
- `debate_ai` 新增 `attacks`：批量生成三类攻防候选（仅候选，不落库）。
- 系统提示加入「自动化备赛模式」：digest → 候选 → dryRun 计划 → 用户确认 → 执行 → 复核。
- 修复共享证据 attach 时关联字段名错误（`evidenceCardId`），此前挂载实际无效。
- MCP P0 接入文档：`docs/mcp-servers.md`（中国法条、arXiv）。

## 0.4.0

- 新增模型能力层 `lib/ai.js`：默认直调宿主 `llm` 服务（跟随 `agentDefaultModel`，无需额外 API key），预留 OpenAI 兼容外接。
- 新增 `debate_ai`（status / decompose / apply）与界面「拆题」页：AI 生成拆题候选，人工确认后写入。
- 模型生成内容硬约束：不得编造证据/数据/年份/机构；候选默认不落库。

## 0.3.x

- 多题目：每题独立目录 `.debate/projects/<id>/`，新增题目索引、切换/重命名/归档/删除。
- 新增 `debate_task`（每题待办 + 跨题总览）与 `debate_library`（公共证据库，跨题复用）。
- 界面新增「项目」页与顶栏题目切换器；证据卡页支持「本题 / 公共库」。
- 修复题目目录缺少 `.debate/` 前缀的问题。

## 0.2.0

- 视觉重做：9 类节点全新色板 + 造型徽标、点阵网格画布、连线箭头与选中高亮、磨砂浮窗、分段控件。
- 论证树画布支持滚轮缩放 / 拖拽平移 / 定位复位；节点编辑改为选中后浮窗。
- 节点标题支持按像素裁剪与可选多行换行（自动宽高）。

## 0.1.x

- 首个可用版本：9 个 `debate_*` 工具、原生右栏工作台（论证树 / 证据卡 / 攻防 / 评估 / 稿件）、
  DebateWeaver `ProjectExportBundle` 双向互通、确定性五维评估与缺口检查、HTTP API 与调试页、
  四项离线自测（apply / logic / api / client）。
