# 辩论备赛 MCP 服务器推荐清单

> 用途：给「辩论工作台」插件接入外部证据检索/网页抓取能力。
> DSH 本身是 **MCP 客户端**（`@deepseek-ai/dsh-mcp-client`），每台服务器一条 profile 配置，
> 工具会以 `mcp__<serverName>__<tool>` 出现在模型工具列表中。
>
> 注意：**MCP 只负责「给模型接外部工具」，不负责调用模型**。内置模型调用见 `debate_ai` 工具。

## 一、推荐组合（按辩论备赛优先级）

| 优先级 | 类别 | 推荐 | 需要 key | 状态 |
| --- | --- | --- | --- | --- |
| P0 | 学术检索 | `arxiv-mcp-server`（arXiv 论文检索/下载） | 否 | 仓库存在，广泛使用 |
| P0 | 中文法规 | `china-law-mcp`（378 部法律 / 2.4 万条条文 + 引用核验） | 否，纯本地 | **已核对**：PyPI / MIT / 离线 |
| P1 | 中文网页搜索 | 博查 Bocha MCP（中文搜索 API） | 是 | 需自行验证服务可用性 |
| P1 | 通用搜索 | Brave Search MCP（官方） | 是 | 官方维护 |
| P1 | 深度检索 | Exa MCP（语义搜索，remote endpoint） | 是 | 官方 remote 部署 |
| P2 | 网页抓取/交互 | Playwright MCP（`@playwright/mcp`，本地浏览器） | 否 | 微软官方 |
| P2 | 文档素材 | Notion MCP（官方）/ Obsidian MCP | 是/本地 | 视素材存放方式 |
| P2 | 学术综合 | `paper-search-mcp`（Semantic Scholar / PubMed / arXiv 多源） | 部分源需 key | 需自行验证 |

> 未标注"已核对"的条目是常见生态项目，接入前请先按各自 README 在本机跑一次 `--help`/stdio 握手，
> 确认包名、协议版本与传输方式后再写入 profile。

## 二、在 DSH 里接入（改 profile 配置）

编辑 `%USERPROFILE%\.dsh\profiles\desktop\cordis.patch.yml`（Windows），追加：

```yaml
# 本地 stdio 服务器：arXiv 检索
- id: mcp-arxiv
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: arxiv
    transport: stdio
    command: uvx
    args: ['arxiv-mcp-server']
    toolCallTimeoutMs: 60000

# 本地 stdio：中国法条 + 引用核验（离线，无 key）
- id: mcp-china-law
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: law
    transport: stdio
    command: uvx
    args: ['china-law-mcp']

# 远端 Streamable HTTP：中文搜索（示例，需替换真实地址与 token）
- id: mcp-bocha
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: bocha
    transport: streamable-http
    url: https://example.invalid/mcp
    headers:
      Authorization: !!js `Bearer ${process.env.BOCHA_API_KEY}`
```

改完后**重启 DSH**。启动日志里如果某台服务器连接失败，harness 仍会启动，只是该服务器的工具不会出现；
把 `failOnStartupError: true` 打开可以让配置错误直接暴露。

## 三、参考：两台 P0 服务器的安装方式（Windows）

如果机器上没有 `uvx` / `npx`，可以用 DSH 自带 Python 建独立 venv 再安装（下面以 Windows PowerShell 为例，
把 `%USERPROFILE%` 换成你的用户目录即可）：

```powershell
# 1) 用 DSH 自带 Python 建 venv（不要装进 DSH 自己的 Python 环境，避免污染）
$py = "$env:USERPROFILE\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe"
& $py -m venv "$env:USERPROFILE\.dsh\mcp-servers\china-law"
& $py -m venv "$env:USERPROFILE\.dsh\mcp-servers\arxiv"

# 2) 装服务器
& "$env:USERPROFILE\.dsh\mcp-servers\china-law\Scripts\python.exe" -m pip install china-law-mcp
& "$env:USERPROFILE\.dsh\mcp-servers\arxiv\Scripts\python.exe" -m pip install arxiv-mcp-server

# 3) 冒烟：直接跑一下，能起来就说明依赖完整（Ctrl+C 退出）
& "$env:USERPROFILE\.dsh\mcp-servers\china-law\Scripts\python.exe" -m china_law_mcp
& "$env:USERPROFILE\.dsh\mcp-servers\arxiv\Scripts\python.exe" -m arxiv_mcp_server
```

然后把这两段写进 profile 的 `cordis.patch.yml`（路径换成你机器上的真实路径）：

```yaml
- id: mcp-china-law
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: law
    transport: stdio
    command: 'C:\Users\<你的用户名>\.dsh\mcp-servers\china-law\Scripts\python.exe'
    args: ['-m', 'china_law_mcp']
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    toolCallTimeoutMs: 60000

- id: mcp-arxiv
  name: '@deepseek-ai/dsh-mcp-client'
  config:
    serverName: arxiv
    transport: stdio
    command: 'C:\Users\<你的用户名>\.dsh\mcp-servers\arxiv\Scripts\python.exe'
    args: ['-m', 'arxiv_mcp_server']
    env: { PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }
    toolCallTimeoutMs: 60000
```

| 服务器 | serverName | 工具 |
| --- | --- | --- |
| china-law-mcp | `law` | search_statutes、get_article、list_laws、verify_citation、check_citations_in_text |
| arxiv-mcp-server | `arxiv` | search_papers、get_abstract、read_paper、download_paper、semantic_search、citation_graph、export_citations、watch_topic 等 16 个 |

验证方式：重启 DSH 后让模型调用 `mcp__law__search_statutes(query="正当防卫的限度")`、
`mcp__arxiv__search_papers(query="large language model reasoning")`，能返回结果即接通。
要临时停用：把对应 `- id:` 两行注释掉或删除整段，重启生效。

> 备选：`paper-search-mcp`（多源学术检索）也可以装在同一个 venv 里，把 `args` 改成
> `['-m', 'paper_search_mcp']`、`serverName` 改成 `papers` 即可切换。

## 四、接入后的典型用法


- 检索类问题交给 MCP：`mcp__arxiv__search_papers`、`mcp__law__search_statutes`、`mcp__bocha__web_search`
- 模型只做**筛选、归纳、攻防化**，不负责"回忆"证据
- 检索到的原始结果 → `debate_library(action=add)` 入公共证据库 → `action=attach` 挂到具体论点
- 法条类证据必须走 `china-law-mcp` 的 `verify_citation` / `check_citations_in_text` 核验，杜绝编造

## 四、安全与成本

- **数据出界**：只有你主动调用的 MCP 服务器会收到查询内容；学术/法规类建议用本地 stdio 服务器
- **密钥**：用 `!!js process.env.XXX` 从环境变量注入，不要把 key 写进 yml 明文
- **成本**：每台服务器独立计费（搜索 API 按次/按量）；建议先只接 P0 两台，观察效果再扩展
- **稳定性**：stdio 服务器启动慢会拖慢首轮工具列表；`dsh-mcp-client` 自带重连与超时，必要时调 `toolCallTimeoutMs`

## 五、不建议走 MCP 的场景

| 场景 | 原因 |
| --- | --- |
| 调用内置模型 | MCP 没有模型概念，用 `debate_ai`（宿主 `llm` 服务） |
| 读写 `.debate/` 数据 | 已有 `debate_*` 工具，直接调用即可 |
| 简单网页读取 | DSH 自带 `web_search` / `web_fetch` 工具，够用就不必加 MCP |
| 让外部客户端用本插件 | 需要把 `debate_*` 包装成 MCP **Server**（当前未实现，可后续做） |
