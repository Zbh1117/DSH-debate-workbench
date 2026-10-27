# Changelog

本项目遵循语义化版本（`MAJOR.MINOR.PATCH`）。插件与 DSH 宿主版本解耦：插件版本独立发布，兼容性在 README 中标注。

## 0.7.0-beta.2（未发布 · 复盘体验增强）

- **M4A/MP3 录音支持**：界面选择音频后自动在浏览器解码并转成 16kHz 单声道 PCM16 WAV 再上传/转写（30 分钟以内），不再要求用户先手工转 WAV；宿主对非 WAV 给出明确转换提示。
- **对话联动**：输入框旁新增「讨论复盘」按钮（`conversation.composer.dock` 槽位），一键把「读取最新复盘 + 评委视角讨论」提示词填入输入框（不自动发送），可在当前对话里直接让模型展开讨论。
- 测试：新增讨论入口注册与 M4A 转写提示断言，四套共 171 项全绿。
## 0.7.0-beta.1（未发布 · 复盘 M5 界面里程碑）

- 新增「复盘」标签页（第 8 个标签）：复盘列表、新建（录音上传 / 字幕文件或粘贴）、转写编辑与保存、评委视角与模式选择、一键生成判比赛/环节复盘/证据候选（后台任务 + 状态轮询）、导出 Markdown。
- 新增复盘 HTTP API：`/reviews`、`/review`、`/review-md`、`/review-audio`（流式上传录音）、`/review-job`（长任务 + 状态查询）。
- 界面与服务端跑通三票制判比赛展示（印象/环节/决胜票、架构比较、论证留存度、关键交锋）与环节复盘展示。
- 测试：新增复盘 API/界面渲染断言，四套自测共 169 项全绿。
## 0.7.0-alpha.2（未发布 · 复盘 M3/M4 里程碑）

- 转写：ction=import_transcript 支持 .srt/.vtt/纯文本解析（保留时间戳、可打环节标签）；ction=transcribe 接入 DSH 内置 speechToText（本地 SenseVoice），按 ~110 秒切片转写（要求 16kHz 单声道 PCM16 WAV），未启用语音插件时给出启用指引。
- AI：nalyze_judge（三票制：印象/环节/决胜；视角必选；输出判票理由/架构比较/论证留存度/关键交锋/最小致胜差异）、nalyze_phases（按环节复盘）、evidence_candidates（待核验证据候选，不自动入库）。
- 内置「辩论赛评委」skill（debate-judge），启动时注册到 DSH skills，可被项目 .dsh/skills/ 同名 skill 覆盖。
- 测试：新增 WAV/字幕/转写/三票制/环节复盘/证据候选断言，四套自测共 159 项全绿。
## 0.7.0-alpha.1（未发布 · 复盘 M1/M2 里程碑）

- 新增 `debate_review` 工具（复盘 sidecar 数据层 + 工具层）：`create / list / read / update / delete / export`。
- 复盘数据存于题目目录 `reviews/`（可版本管理）与 `recordings/`（录音，默认 gitignore 忽略），**不写入 `ProjectExportBundle`**，不影响 DebateWeaver 互通。
- 判比赛采用**三票制**设计：印象票（整体架构比较）/ 环节票（按环节表现）/ 决胜票（论证留存度）；JSON 结构与 Markdown 渲染已就绪，AI 生成在 M4。
- 设计文档 `docs/review-design.md`：判比赛 + 环节复盘、转写三条路线、评委 skill、证据候选流程、M1–M6 任务拆解与验收清单。

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
