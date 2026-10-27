# dsh-debate-workbench · 辩论备赛工作台

[![npm version](https://img.shields.io/npm/v/dsh-debate-workbench.svg)](https://www.npmjs.com/package/dsh-debate-workbench)
[![license](https://img.shields.io/npm/l/dsh-debate-workbench.svg)](LICENSE)

把 DeepSeek Harness（DSH）变成**辩论备赛工作区**：DSH 右侧栏里有一个原生「辩论工作台」标签页，与对话左右并排；模型通过 15 个 `debate_*` 工具直接读写同一份结构化数据。数据模型与 DebateWeaver 的 `ProjectExportBundle` 一致，可双向导入导出。

## 功能

### 模型工具（15 个）

| 分组 | 工具 | 能力 |
| --- | --- | --- |
| 项目 | `debate_project` | 多题目：`create` / `list` / `switch` / `rename` / `archive` / `delete` / `open` / `status` / `read` |
| 拆题 | `debate_topic` | 拆题结果（概念/争议点/战场/比较框架/隐藏前提/论证路径/反驳靶点/备赛清单），`save` 带缺口校验 |
| 论证树 | `debate_tree` | 9 类节点增删改、连线/断线（环检测）、拖动坐标、`auto_layout`、`read` 大纲 |
| 证据 | `debate_evidence` | 增删改查、检索、挂载；`import` 批量入库+挂载（来源必填、标题+url 去重、默认 dryRun） |
| 攻防 | `debate_attack` | 攻击路径（事实/逻辑/价值）+ 威胁度 1–5 + 防守策略；威胁度 ≥4 无防守 = error |
| 评估 | `debate_evaluate` | 确定性五维评分（逻辑/证据/说服/创新/抗反驳）+ 缺口 + 建议；`questions` 苏格拉底追问 |
| 稿件 | `debate_manuscript` | 一辩稿 / 结辩稿 / 驳论清单组装 + 整案 Markdown 归档 |
| 互通 | `debate_bundle` | `export` / `import` / `validate` / `json` |
| 界面 | `debate_workbench` | `open` / `close` / `toggle` / `state` / `set` |
| 待办 | `debate_task` | 每题待办 + 跨题总览（未完成数/最近截止） |
| 资源 | `debate_library` | 公共证据库（跨题复用）：`add` / `search` / `update` / `delete` / `attach` |
| 模型 | `debate_ai` | `status` / `decompose`（拆题候选）/ `attacks`（攻防候选）/ `apply`（确认后落库） |
| 编排 | `debate_context` | 只读上下文：`digest` 摘要 / `outline` 树大纲 / `search_evidence` 跨库检索 |
| 编排 | `debate_plan` | 批量编排：`build_tree`（按拆题搭树）/ `fill_attacks`（批量写攻防），默认 dryRun |
| 复盘 | `debate_review` | 比赛复盘（sidecar）：`create` / `list` / `read` / `update` / `delete` / `export` / `import_transcript` / `transcribe` / `analyze_judge`（三票制）/ `analyze_phases` / `evidence_candidates` |

### 界面（原生右栏，8 个标签页）

- **论证树**：点阵网格画布、滚轮缩放、拖拽平移、选中浮窗编辑（标题/说明/类型/加子论点/连线/删除/挂证据/攻防摘要）、自动排版与定位复位
- **拆题**：拆题结构只读展示 + AI 拆题助手（候选预览 → 确认后应用）
- **证据卡**：本题证据 / 公共库双模式；搜索、新建、挂节点、存入公共库、引用到本题
- **攻防**：按节点列攻击与防守，就地编辑
- **评估**：五维进度条 + 就绪度 + 最该补的缺口
- **稿件**：生成预览 / 保存 / 导出
- **项目**：新建/切换/重命名/删除题目、每题待办、跨题总览
- **复盘**：复盘列表 + 新建（录音上传/字幕粘贴）、转写（一键转写或导入 .srt/.vtt/文本）、选评委视角生成判比赛（三票制）与环节复盘、证据候选、导出 Markdown

### 多题目

一个工作区可以同时准备多道题，互不干扰；所有工具都支持 `project` 参数，可在不切换激活题的情况下并行读写指定题目。

## 安装

### 方式零：DSH 桌面版内置安装（推荐，无需命令行）

前提：已安装 DSH 桌面版（自带「插件」面板与插件管理器）。

1. 打开侧栏 **「插件」** 面板（标题「插件」，说明「安装、启用和配置插件」）
2. 点 **「添加插件」**
3. 在「包名或地址」里输入：
   ```
   dsh-debate-workbench
   ```
   （也支持带版本 `dsh-debate-workbench@0.6.0`、GitHub 仓库地址或本地目录路径；安装源会自动在 npmjs / npmmirror 之间选择，失败可切换国内镜像）
4. 等待 pnpm 安装完成（包零依赖，很快）
5. **重启 DSH**（面板会提示"更改将在下次启动生效"）
6. 重启后右栏出现「辩论工作台」标签页；也可以按 `Ctrl+Shift+D` 打开

> 同一面板也装了官方插件；卸载/升级都在这里：**卸载后重新「添加插件」新版本**（面板没有单独的版本选择器）。
>
> 命令行的等价写法（DSH 自带 CLI，二选一；profile 名按你的安装填，桌面版通常为 `desktop`，Web 版为 `web`）：
>
> ```bash
> dsh plugin --profile web add dsh-debate-workbench
> dsh plugin add dsh-debate-workbench
> ```
>
> **大陆用户提示**：直接用 npm 包名安装即可。DSH 插件管理器会自动在 npmjs 与 npmmirror（淘宝镜像）之间选择最快源，
> npmmirror 会自动同步本包（发布后几分钟内），**无需做任何额外上传**；本包零依赖，只下载一个 tarball，安装通常 1 秒内完成。
> 若对话框提示网络失败，可切换/手动选择「国内镜像」后重试。**不建议用 GitHub 地址安装**（大陆访问 GitHub 可能不稳定），
> 需要源码请用 npm 安装后的 `node_modules/dsh-debate-workbench`，或等镜像同步。

### 插件市场收录信息（供审核/用户评估）

- **一句话价值**：在 DSH 右侧栏获得一个与对话联动的辩论备赛工作台——论证树、拆题、证据库、攻防、五维评估、稿件全部结构化，模型可用 15 个工具直接读写。
- **能力分类**：工具与能力（同时含界面与体验）
- **安装命令**：`dsh plugin --profile web add dsh-debate-workbench`（profile 名按实际填，桌面版为 `desktop`）
- **兼容性**：在 DSH `0.2.0-rc.2` 桌面版验证；Windows / macOS / Linux（纯 Node + 浏览器端插件，无原生依赖）
- **许可证**：MIT
- **权限与外部服务**：
  - 读写当前工作区的 `.debate/` 目录（题目、证据、待办、界面状态），不触碰其它文件
  - 模型辅助功能调用**宿主内置模型**（DSH 的 `llm` 服务），不额外请求第三方 API、不需要用户填 key
  - 可选 MCP 外部检索由用户在 DSH profile 自行配置，插件本身不联网
- **已知限制**：客户端右栏 API 变更需适配；Host 代码/客户端加载器改动后需重启 DSH；未实现连线鼠标绘制、证据评分编辑、模辩对战

### 方式一：npm + 工具安装

```bash
npm i dsh-debate-workbench
```

然后在 DSH 里安装 bundle（把包名或本地路径传给 `plugin_manager`）：

```
plugin_manager install_bundle target=dsh-debate-workbench
```

### 方式二：源码

```bash
git clone https://github.com/Zbh1117/DSH-debate-workbench.git
```

```
plugin_manager install_bundle target=file:<仓库绝对路径>
```

装完**重启一次 DSH**（Host 代码与客户端加载器需要重新加载）。之后改界面 `assets/ui.js` 会自动热更新，不必再重启。

> 兼容性：在 DSH `0.2.0-rc.2`（桌面版）上开发验证；依赖宿主公开的 `tools` / `slots` / `sidebarRight` / `sidebarRightTabs` / `webServer` / `systemPrompt` / `llm` 服务。

## 快速开始

对话里直接说，或让模型调用工具：

```
debate_project(action=create, topic="人工智能的发展利大于弊", side=正)
debate_topic(action=save, decomposition={...})
debate_tree(action=add_node, node={type:"stance", label:"我方立场：..."})
debate_workbench(action=open)   # 打开右栏工作台
```

更省事的方式是「自动化备赛模式」：

> 用户：帮我用拆题结果把论证树搭起来，再给每个论点补三类攻防。

模型流程：`debate_context(digest)` 看现状 → `debate_ai(decompose/attacks)` 出候选 → `debate_plan(build_tree / fill_attacks, dryRun)` 给计划 → **你确认后** `apply=true` 执行 → 复核就绪度变化。

## 数据落盘

```
<workspace>/.debate/
  projects.index.json              # 题目索引 + 当前激活题目
  projects/<题目id>/
    project.bundle.json            # ProjectExportBundle（唯一事实来源，可直接给 DebateWeaver）
    tasks.json                     # 每题备赛待办
    reviews/<reviewId>.json        # 比赛复盘（判比赛三票 + 环节复盘 + 证据候选，独立 sidecar）
    recordings/<reviewId>.<ext>    # 复盘录音（默认 gitignore 忽略，本地保存）
  shared/evidence.json             # 公共证据库（跨题共享）
  ui.json                          # 界面状态
  export/                          # 导出副本
$DSH_HOME/debate-workbench.json    # 跨工作区指针：激活题目 + 已知工作区
```

写入统一「临时文件 + rename」；`ui.json` 浅合并。工具默认操作**当前激活工作区**（与右栏界面一致），可用 `workspace` 参数显式指定其它工作区。

## 比赛复盘（判比赛 + 环节复盘）

输入是**比赛录音**或**转写文本**，输出两部分：

1. **判比赛**：三票制——印象票（整体架构比较）、环节票（按环节表现）、决胜票（论证留存度）；三票各自给判票理由，并给出关键交锋裁决、整体架构比较、最小致胜差异。**评委视角（白纸/论点裁/技术裁/价值裁/情境裁）每次生成前必选**，不设默认。
2. **按环节复盘**：立论 / 质询 / 自由辩论 / 结辩逐环节分析：问题（有字幕时间戳就带时间戳）、建议、亮点、短板、训练建议。

转写/输入三条路：
- **一键转写**：使用 DSH 官方「语音输入」插件（本地 SenseVoice，需在插件面板启用并下载模型）。底层只接受 **16kHz 单声道 PCM16 WAV**，插件按 ~110 秒自动切片转写；**M4A/MP3/OGG 等常见录音在界面选择后会自动转成 16kHz WAV**（浏览器内解码，最长 30 分钟；更长的音频建议先转 WAV 再分段）
- **字幕导入**：粘贴或导入 .srt/.vtt（腾讯会议/飞书妙记/讯飞听见导出），保留时间戳
- **纯文本**：直接粘贴转写稿

证据：复盘会提取「待核验证据候选」（比赛中的陈述**不会**直接入证据库），核验来源后用 `debate_evidence(import)` 入库。

**和模型讨论复盘**：输入框旁有「讨论复盘」按钮，点一下会把「读取最新复盘 + 评委视角讨论判票理由/改进/训练」的提示词**填入输入框（不自动发送）**，你确认后按发送即可在对话里继续讨论；也可以在对话中直接说「读一下 review-xxx，我们讨论判票理由」。

## AI 能力

- 默认直调**宿主内置模型**（`llm` 服务 + `agentDefaultModel`，例如 `deepseek-account/deepseek-flash`），**不需要额外 API key**
- 可选外接 OpenAI 兼容接口：在 profile 里给本插件加配置

  ```yaml
  - id: debate-workbench
    name: dsh-debate-workbench
    config:
      ai:
        provider: openai-compatible
        baseUrl: https://api.example.com
        model: your-model
        apiKey: !!js process.env.MY_KEY
  ```

- 模型只出**候选**：`decompose` / `attacks` 不落库，确认后 `debate_ai(apply)` 或 `debate_plan(apply=true)` 才写入
- 硬约束：模型不得编造证据/数据/年份/机构/法条；证据卡必须有真实来源

## MCP 外部证据检索

外部检索走 DSH 的 MCP 客户端（`@deepseek-ai/dsh-mcp-client`），不内置到插件。配置方式、推荐服务器清单（中国法条 `china-law-mcp`、arXiv 等）见 [docs/mcp-servers.md](docs/mcp-servers.md)。

## 与 DebateWeaver 互通

`debate_bundle(action=export)` 导出的 JSON 可直接在 DebateWeaver 导入；`action=import` 读取 app 导出的 bundle。往返编辑保留未知字段，不丢数据。

## 开发与测试

```powershell
npm test   # = 下面四套
node tests/apply.test.mjs    # 启动装配与降级（8）
node tests/logic.test.mjs    # 工具全链路：多题目/拆题/树/证据/攻防/评估/稿件/导入导出/AI/编排/复盘（100）
node tests/api.test.mjs      # HTTP API 全流程（28）
node tests/client.test.mjs   # 客户端加载器 + 界面渲染，React 替身（33）
```

四套测试都不需要 DSH 运行时、不改 profile，共 **169 项**。

## 已知限制

- **客户端右栏 API 依赖宿主**：`sidebarRightTabs` / `sidebarRight` 是 DSH 官方插件同款接口，DSH 升级若改动需适配
- **Host/客户端改动需要重启**：只有 `assets/ui.js` 支持热更新
- 宿主若没有 `llm` 服务，AI 功能会提示不可用，其余功能不受影响
- **复盘转写依赖官方语音插件**：未启用「语音输入」时只能导入字幕/文本；底层只接受 16kHz WAV，界面会把 M4A/MP3 自动转换（受浏览器解码与内存限制，界面转换上限 30 分钟；更长音频需先转 WAV 并分段）
- 长录音转写是本地 CPU 推理（按 110 秒切片串行），40–60 分钟比赛需要几分钟；转写在界面里以后台任务方式运行，可看到状态
- 复盘只分析音频/文本，不做视频画面分析
- 尚未实现：连线鼠标绘制、证据卡评分编辑、模辩对战、与 DebateWeaver 的实时 API 对接（目前文件级互通）

## 目录结构

```
lib/            Host 半：工具、存储、校验、评估、Markdown、AI、HTTP API
assets/         客户端半：client.js（加载器）+ ui.js（界面，热更新）+ debug.html
tests/          四套离线自测
docs/           MCP 服务器接入指南
example/        演示项目（可直接打开）
cordis.patch.yml  bundle patch：安装时向 profile 插入插件行
```

## 许可证

[MIT](LICENSE) © 2026 Zbh1117
