# 比赛复盘功能设计（v0.7.0）

> 状态：设计稿（待评审）
> 作者：Zbh1117 + DSH agent
> 目标版本：v0.7.0（复盘 MVP）
> 关联能力：DSH `speechToText` 服务、DSH `skills` 服务、插件内置模型（`lib/ai.js`）

## 1. 目标与范围

### 1.1 要做成什么

在辩论工作台新增「复盘」能力，输入是一场比赛的**录音**和/或**文字转写**，输出是两部分：

1. **判比赛**：以华语辩论评委标准给出胜负判定 + 判票理由（不是简单的一句话结论，必须讲清"为什么判这方赢"）
2. **按环节复盘**：按华语赛制环节（立论 / 质询 / 自由辩论 / 结辩，可选总结陈词）逐环节分析，指出问题与改进方向

并附加：

- 复盘报告可导出 Markdown
- 复盘产生的「高价值数据/案例/机理」与「缺失证据清单」形成**证据候选**，核验后进入公共证据库
- 复盘可一键把改进项转成该题目的备赛待办（`debate_task`）

### 1.2 明确不做 / 边界

- **不做实时转写/实时评审**（只做赛后复盘）
- **不做真实裁判结论**：所有评分与判票标注为「模拟评委意见」，作为训练参考
- **不把比赛中的陈述当证据**：转写里出现的数据/案例必须先核验来源，未核验只作为候选
- **不引入第三方云服务依赖**：转写优先用 DSH 官方语音插件（本地 SenseVoice）；用户想用云 STT 属后续可选能力
- **不破坏 DebateWeaver 兼容**：复盘数据放独立 sidecar 文件，不写入 `ProjectExportBundle`

## 2. 总体流程

```
① 新建复盘
   ├─ 可选：上传录音 → .debate/projects/<id>/recordings/<reviewId>.<ext>
   └─ 可选：导入文字（粘贴 / .txt / .srt / .vtt）
        ↓
② 转写（若只有录音）
   ├─ DSH speechToText 可用 → 按环节切片转写
   ├─ 已有字幕/文本 → 直接使用（srt/vtt 解析时间戳）
   └─ 都不可用 → 提示用户先转写
        ↓
③ 人工校对转写（可编辑，可只改关键段落）
        ↓
④ 选评委视角（每次生成前必选，不设默认）
        ↓
⑤ 生成两部分报告
   ├─ 判比赛：胜负 + 票型/总分 + 判票理由 + 关键交锋裁决
   └─ 环节复盘：每环节表现、失分点、亮点、改进
        ↓
⑥ 产出
   ├─ 展示 + 导出 Markdown
   ├─ 改进项 → debate_task
   └─ 证据候选 → 核验（MCP / web）→ dryRun → 入公共证据库
```

## 3. 数据模型

### 3.1 存储位置

```
.debate/projects/<题目id>/
  reviews/<reviewId>.json          # 复盘记录（可追踪，建议纳入版本管理）
  recordings/<reviewId>.<ext>      # 录音副本（默认 .gitignore 忽略，体积大且敏感）
```

不写入 `project.bundle.json`，保证：
- DebateWeaver 导入导出完全不受影响
- 复盘数据可单独备份/删除

### 3.2 Review 记录 schema

```jsonc
{
  "id": "review-<timestamp>-<rand>",
  "projectId": "p-xxx",
  "title": "对XX大学模辩",
  "date": "2026-10-23",
  "opponent": "XX大学",
  "format": "chinese",               // chinese | british | australian | custom
  "ourSide": "pro",                  // 供判定"我方是否获胜"
  "source": {
    "kind": "audio+transcript",      // audio | transcript | audio+transcript
    "audio": {
      "file": "recordings/review-xxx.m4a",
      "ext": "m4a",
      "bytes": 12345678,
      "durationSec": 2400            // 转写后回填
    },
    "transcriptOrigin": "dsl-stt | subtitle | manual"
  },
  "rubric": {
    "preset": "chinese-default",     // 评分表预设，可在 skill 中覆盖
    "weights": { "立论": 25, "质询": 20, "自由辩论": 25, "结辩": 15, "整体": 15 }
  },
  "phases": ["立论", "质询", "自由辩论", "结辩"],
  "transcript": {
    "text": "完整转写文本",
    "segments": [
      { "start": 0, "end": 180, "phase": "立论", "speaker": "我方一辩", "text": "..." }
    ],
    "provider": "sensevoice",
    "audioSeconds": 2380,
    "inferenceSeconds": 95
  },
  "judge": {
    "perspective": "white-paper",    // white-paper | argument | technical | value | situational
    "mode": "votes",                 // votes（默认，三票制）| score（可选，分数辅助）
    "winner": "pro",                 // pro | con
    "voteCount": "3:0",              // 三票汇总
    "votes": { "impression": "pro", "phase": "pro", "decision": "pro" },
    "reasons": {
      "impression": "整体架构比较：我方框架更完整……",
      "phase": "环节票：立论+3、质询-1、自由辩-4、结辩+1，综合判……",
      "decision": "决胜票：交锋后我方核心论证存活 3/5，对方 1/5……"
    },
    "architecture": { "pro": "我方架构……", "con": "对方架构……", "compared": "比较结论……" },
    "argumentSurvival": [
      { "argument": "AI 提升生产率，扩大可分配总量", "side": "pro", "survived": true, "afterClash": "对方未给出同口径反证" },
      { "argument": "AI 导致结构性失业", "side": "con", "survived": false, "afterClash": "被‘岗位替代≠总量失业’打掉" }
    ],
    "decisiveClashes": [
      { "clash": "就业总量 vs 结构", "judgedFor": "pro", "why": "反方未能给出同口径数据" }
    ],
    "scores": { "pro": null, "con": null },   // 可选，仅 score 模式填充
    "disclaimer": "模拟评委意见，非真实裁判结论"
  },
  "phaseReview": [
    {
      "phase": "立论",
      "scores": { "pro": 24, "con": 20 },
      "summary": "...",
      "findings": [
        { "at": "03:12", "issue": "定义过宽，未回应对方口径", "advice": "..." }
      ],
      "strengths": [],
      "weaknesses": []
    }
  ],
  "overall": {
    "verdict": "赢在框架，输在自由辩",
    "strengths": ["框架清晰", "价值升华到位"],
    "weaknesses": ["自由辩回应慢", "数据缺失"],
    "actionItems": ["补 3 张就业数据", "准备结构 vs 总量的防守"]
  },
  "evidenceCandidates": [
    {
      "id": "cand-xxx",
      "type": "data",                // data | case | theory
      "claim": "对方引用'AI 导致 40% 岗位消失'",
      "status": "pending",           // pending | verified | rejected
      "searchKeywords": ["AI 就业 岗位消失 数据"],
      "verification": { "url": "", "source": "", "note": "" }
    }
  ],
  "ai": { "provider": "deepseek-account", "model": "deepseek-flash", "skill": "debate-judge" },
  "createdAt": "...",
  "updatedAt": "..."
}
```

## 4. 判比赛设计（第一部分）

### 4.1 核心原则：三票制，不比打分表

**不走「按评分表逐项打分再算总分」的路子**，而是模拟真实评委的三种独立判断，各投一票、各给理由：

| 票 | 名称 | 判什么 | 依据 |
| --- | --- | --- | --- |
| 第 1 票 | **印象票** | 整体架构比较 | 双方立论的框架完整度、比较平台是否成立、价值与论证的匹配度；不给分项，直接判断哪方架构更站得住 |
| 第 2 票 | **环节票** | 按环节表现累计 | 立论 / 质询 / 自由辩论 / 结辩 各环节谁占优；**通用权重模板只作为环节内比较的参考依据**，不用于直接算总分 |
| 第 3 票 | **决胜票** | 论证留存度 | 交锋结束后，双方核心论证还剩下多少站得住（argument survival）——被有效回应/打掉的论证算"不存活"，活到最后的论证更多的一方得票 |

三票独立判定，最后汇总为 `3:0 / 2:1`；接近的比赛必须指出"最小致胜差异"（决定性的一票在哪里）。

### 4.2 印象票：整体架构比较

评委在听完全场后，先形成整体印象。判断要素：

1. **比较平台**：这道题到底在比什么，双方是否在同一平台对话
2. **架构完整度**：立论框架是否自洽、论据层级是否清晰、价值与论证是否咬合
3. **负担分配**：谁承担了更重的举证责任、是否完成
4. 不给分项分，**只给"哪方架构更强 + 为什么"**

### 4.3 环节票：通用模板仅作环节内比较依据

| 环节 | 参考权重 | 观察点 |
| --- | --- | --- |
| 立论 | 25 | 定义、标准、框架、核心论点、价值铺垫 |
| 质询 | 20 | 问题设计、回答质量、是否达成共识/逼出矛盾 |
| 自由辩论 | 25 | 交锋效率、回应速度、战场转移、逻辑闭环 |
| 结辩 | 15 | 收束、比较、价值升华、回应对方最强点 |
| 整体 | 15 | 团队配合、表达、风度、时间管理 |

> 权重仅用于**环节票内部谁占优**的判断参考（`rubric.weights` 可配置），**不用于算总分、不用于直接决定胜负**。不同赛事规则不同，可在评委 skill 覆盖。

### 4.4 决胜票：论证留存度（argument survival）

这是三票制里最有信息量的一票。做法：

1. 抽取双方各 3–5 条**核心论证**（不是所有话）
2. 逐条追踪：经过质询/自由辩后，这条论证是否被有效回应/打掉
3. 输出 `argumentSurvival[]`：`{ argument, side, survived, afterClash }`
4. 决胜票判给"存活论证更多、且核心论证仍成立"的一方；如果双方都大量被打掉，则判给"核心论证保存更完整"的一方

### 4.5 判票理由结构（强制）

每一票都必须给出理由；整体必须包含：

1. **比较平台**：这题评委到底在比什么
2. **双方最强论点**：各自最有力的 1–2 个论证
3. **关键交锋裁决**：至少 2 个关键 clash，说明谁赢、为什么
4. **胜负归因**：判某方获胜的核心原因（不能只说"整体更好"）
5. **最小致胜差异**：如果接近，指出决定性的那一票/一分在哪里
6. **引用转写**：理由必须能指向转写中的具体内容（有时间戳更好）

### 4.6 输出模式

- `mode=votes`（**默认**）：三票制，输出 `votes / voteCount / reasons.impression|phase|decision / architecture / argumentSurvival / decisiveClashes`
- `mode=score`（可选并列）：各环节分数 + 总分 + 胜负，`scores` 字段填充；分数仅作辅助展示与趋势对比
- 两种模式共用 `judge` 结构，`mode` 字段标识；**结算方式并列可选，不设唯一默认分数制**
- 每次生成前**必须选择评委视角**（白纸/论点裁/技术裁/价值裁/情境裁），视角会影响三票判法

## 5. 环节复盘设计（第二部分）

每个环节输出：

| 字段 | 含义 |
| --- | --- |
| `phase` | 环节名（立论/质询/自由辩论/结辩/总结） |
| `scores` | 双方该环节得分（按 rubric 权重） |
| `summary` | 该环节发生了什么、胜负手 |
| `findings` | 具体问题：`{ at?, issue, advice }`（`at` 来自字幕时间戳或环节内估算位置） |
| `strengths` / `weaknesses` | 亮点 / 短板 |
| `drill` | 该环节的针对性训练建议（可转待办） |

**没有时间戳时**：`at` 退化为「环节内相对位置」（如"立论后半段"），不伪造秒数。

## 6. 转写与录音

### 6.1 三条转写路线（同版本支持）

| 路线 | 触发条件 | 说明 |
| --- | --- | --- |
| **DSH 内置 STT** | `ctx.get('speechToText')` 存在 | 官方语音插件启用后可用；本地 SenseVoice，零 API key；**按环节切片转写**（默认每段 3–5 分钟），避免长音频内存/耗时问题 |
| **字幕导入** | 用户导入 `.srt/.vtt` | 解析时间戳与分句；这是获得精确时间轴的主途径（腾讯会议/飞书妙记/讯飞听见等可导出） |
| **纯文本导入** | 用户粘贴文本 | 最轻量兜底；无时间戳 |

### 6.2 录音归档

- 界面选择音频文件 → 通过插件 HTTP API **流式写入** `recordings/`（不经过 JSON 编码，避免大文件）
- 支持格式：m4a / mp3 / wav / ogg（按 `speechToText` provider 支持范围校验，不支持时提示转换）
- 录音默认 `.gitignore` 忽略；复盘 JSON 只记录相对路径与大小/时长
- 隐私：录音仅存本地；若用户选择云 STT，UI 必须显式提示"音频将发送至第三方"

### 6.2.1 压缩音频（M4A/MP3）自动转换

- DSH 内置 SenseVoice provider 只接受 16kHz 单声道 PCM16 WAV，因此**非 WAV 录音在界面端转换**：
  - 浏览器 `decodeAudioData` 解码（Chromium 支持 M4A/AAC、MP3、OGG 等；Electron 自带解码器）
  - `OfflineAudioContext(1, frames, 16000)` 重采样为 16kHz 单声道
  - 编码为 PCM16 WAV 后上传（宿主只保存 WAV，原文件不入库）
- 限制：界面转换上限 30 分钟音频（解码后的浮点缓冲占用内存）；更长的录音建议先用外部工具转 16kHz WAV 并按环节切分
- 宿主侧兜底：若录音不是 WAV（旧数据/命令行上传），`action=transcribe` 会给出明确提示（界面重新上传自动转换 / 先转 WAV / 改用字幕导入）

### 6.4 与对话联动

- 客户端在 `conversation.composer.dock` 槽位注册「讨论复盘」入口：读取最新复盘，把讨论提示词通过 `inputActions.setDraft`/`insertText` 填入输入框（不自动发送），用户确认后发送
- 对话中模型也可以直接 `debate_review(action=read)` 读取复盘数据展开讨论；复盘 JSON 是唯一事实来源

### 6.3 转写失败/降级

- `speechToText` 不可用 → 复盘页提示"启用 DSH 官方语音插件后可用自动转写"，文本/字幕导入不受影响
- 转写超时/失败 → 保留音频，允许重试或改用手动文本
- 转写结果进入可编辑文本域，用户修正后再生成报告

## 7. 评委 Skill 设计

### 7.1 形态

- 随插件分发：`skills/debate-judge/SKILL.md`
- 插件启动时通过 `ctx.skills.register()` 注册为 runtime skill（modelInvocable + userInvocable）
- 用户可在项目 `.dsh/skills/debate-judge/SKILL.md` 写自己的版本覆盖（DSH skill 规则：project 层优先）
- 复盘生成时，插件还会把 skill 正文作为 AI 调用的 system prompt 注入（保证不依赖模型自觉加载）

### 7.2 SKILL 内容大纲

1. 角色：华语辩论赛资深评委/教练
2. 判准框架（立论/论证/交锋/价值/表达/团队）
3. 评分表与权重（默认模板 + 如何覆盖）
4. 五种评委视角的定义与判法差异（白纸/论点裁/技术裁/价值裁/情境裁）
5. 判票理由写作规范（必须包含比较平台、最强论点、交锋裁决、胜负归因、最小致胜差异）
6. 环节复盘模板（每环节：目标 → 表现 → 失分点 → 改进）
7. 评分锚点（各分数段特征，避免"所有队都 80 分"）
8. 禁止项：不评价选手人格/外貌；不编造引用与数据；必须标注"模拟评委意见"；转写缺失处不得脑补
9. 与确定性五维评估的关系（以插件算分为锚，解释模型评分）

### 7.3 视角定义（每次生成前必选）

| 视角 | 关注点 |
| --- | --- |
| 白纸评委 `white-paper` | 只听场上说了什么，不预设背景，最接近真实评审体验 |
| 论点裁 `argument` | 立论完整性与交锋逻辑，重论证结构 |
| 技术裁 `technical` | 质询技术、逻辑漏洞、定义攻防 |
| 价值裁 `value` | 价值框架、比较标准、升华 |
| 情境裁 `situational` | 结合赛制节奏与场上局势（如落后时的搏杀是否成立） |

## 8. 证据候选与入库

### 8.1 从复盘提取

生成报告时额外输出 `evidenceCandidates`：

- **对方引用但可疑**：数据/案例/机理（标记"待核验"）
- **我方缺失**：复盘指出的证据缺口（标记"需补充"）
- **可复用机理**：比赛中有效的论证机制（标记"可入库（理论）"）

### 8.2 核验流程（防幻觉硬规则）

```
复盘候选（pending）
   ↓ 模型用 MCP（法条/arXiv）或 web_search 检索真实来源
   ↓ debate_evidence(action=import, dryRun) 显示将写入的卡片
   ↓ 用户确认 → apply=true 入公共证据库（记录 source/url）
   ↓ 无来源 → 丢弃或标记"仅赛场素材，不作证据"
```

不允许：把转写里出现的数字直接当证据入库。

## 9. 工具与 API

### 9.1 新工具 `debate_review`

| action | 参数 | 行为 |
| --- | --- | --- |
| `create` | title/date/opponent/format/ourSide/audioPath?/transcript? | 新建复盘，归档录音（若有），返回 reviewId |
| `list` | — | 列出该题目的复盘（摘要） |
| `read` | reviewId | 读取完整复盘记录 |
| `transcribe` | reviewId、phaseBoundaries?、language? | 调 DSH STT 转写（可按环节切片）；覆盖写 transcript |
| `import_transcript` | reviewId、text 或字幕内容（srt/vtt） | 导入/替换转写文本，解析时间戳 |
| `analyze_judge` | reviewId、perspective、mode(score/vote) | 生成判比赛结果 |
| `analyze_phases` | reviewId、phases? | 生成环节复盘 |
| `update` | reviewId、patch | 人工修订（转写/评分/评语） |
| `export` | reviewId、format(md) | 导出 Markdown |
| `evidence_candidates` | reviewId | 提取证据候选 |
| `delete` | reviewId、purgeAudio? | 删除复盘（可选删录音） |

约束：
- `analyze_*` 默认只生成并保存到 review JSON，不改 bundle；**不自动写待办/证据库**
- 所有 AI 生成结果保存 `ai` 字段（provider/model/skill）便于回溯
- 模型输出必须通过 JSON schema 校验，失败重试一次后报错

### 9.2 HTTP API 扩展

| 方法 | 路径 | 用途 |
| --- | --- | --- |
| POST | `/debate-api/review-audio?reviewId=&ext=` | 流式上传录音（原始字节，非 JSON） |
| GET | `/debate-api/reviews?project=` | 复盘列表（界面用） |
| GET | `/debate-api/review?id=` | 单条复盘 |
| POST | `/debate-api/review-transcribe` | 触发转写（长任务，返回任务 id） |
| GET | `/debate-api/review-transcribe/status?id=` | 轮询转写进度 |

> 转写是长任务：Host 侧串行队列 + 进度事件，界面轮询；避免阻塞工具调用。

## 10. 界面设计（「复盘」标签页）

```
[复盘列表]  [新建复盘]
┌──────────────────────────────────────────────┐
│ 新建复盘：标题 / 日期 / 对手 / 我方持方 / 赛制     │
│ 录音：[选择文件] 或 路径输入（可选）              │
│ 转写：① 上传字幕(.srt/.vtt) ② 粘贴文本 ③ 一键转写 │
│ 转写状态：未转写 / 转写中(进度) / 已转写(可编辑)   │
└──────────────────────────────────────────────┘
┌─ 判比赛 ──────────────────────────────────────┐
│ 评委视角：[白纸评委 ▼]（必选） 模式：[分数制 ▼]   │
│ [生成判比赛] →  胜负：我方胜 · 82:76            │
│ 判票理由：…（可展开）关键交锋裁决：…             │
└──────────────────────────────────────────────┘
┌─ 环节复盘 ────────────────────────────────────┐
│ 立论 24:20 ▸ 质询 18:19 ▸ 自由辩 20:23 ▸ 结辩… │
│ 每环节：问题（时间戳）/ 亮点 / 待改进             │
└──────────────────────────────────────────────┘
┌─ 产出 ────────────────────────────────────────┐
│ [导出 Markdown] [改进转待办] [证据候选（3）]      │
└──────────────────────────────────────────────┘
```

## 11. 任务拆解（逐步实现）

| 阶段 | 交付物 | 验收标准 | 依赖 |
| --- | --- | --- | --- |
| **M1 数据层** | `lib/review.js`：review schema、读写、列表、校验、录音路径管理 | 单测：创建/读取/列表/删除/损坏 JSON 处理；不进 bundle | — |
| **M2 工具层** | `debate_review`：create/list/read/update/delete/export（不含 AI/转写） | 工具测试：CRUD + Markdown 导出 + lossless JSON；UI 可读列表 | M1 |
| **M3 转写层** | 音频流式上传 API、字幕解析（srt/vtt）、DSH STT 接入（切片） | 测试：srt/vtt 解析正确；假 speechToText 服务可转写；无服务时降级提示 | M1 |
| **M4 AI 层** | 评委 skill 注册 + `analyze_judge` / `analyze_phases` + 证据候选 | 假 llm 测试：视角必选、JSON schema 校验、判票理由字段齐全、无来源不入库 | M2/M3 |
| **M5 界面** | 「复盘」标签页（列表/新建/转写状态/生成/展示/导出） | 手动验收：上传录音→转写→选视角→出报告→导出 | M4 |
| **M6 收尾** | README/CHANGELOG、自测全绿、版本 0.7.0、npm 发布、镜像校验 | `npm test` 全绿；发布后 npmmirror 已同步 | M5 |

预计顺序实施，每一步单独可测；M5 完成后交给你验证。

## 12. 风险与验收清单

### 12.1 风险

1. STT provider 依赖官方语音插件（实验性），未启用时自动降级 → 不能阻塞其它功能
2. 长音频转写耗时/内存 → 按环节切片 + 后台任务 + 进度提示
3. 转写质量影响复盘 → 必须支持人工修正后再分析
4. 模型判分不稳定 → 用确定性五维作锚 + 评分锚点 + 视角固定 + JSON 校验
5. 隐私 → 录音本地、云 STT 显式确认、复盘文件可单独删除
6. 兼容性 → 复盘数据独立 sidecar，不改 ProjectExportBundle

### 12.2 用户验收步骤（M5 后）

1. 新建复盘 → 上传一段 3 分钟录音
2. 启用 DSH 官方语音插件后点「转写」→ 文本出现且可编辑
3. 或导入一份 .srt 字幕 → 时间戳正确显示
4. 选「白纸评委」→ 生成判比赛 → 检查：胜负、判票理由≥3 条且引用转写
5. 生成环节复盘 → 四个环节都有问题与建议
6. 导出 Markdown → 打开检查结构
7. 证据候选 → 选一条，让模型核验后入库（dryRun 确认）

## 13. 已确认的关键决策（原待确认项已定）

1. **判比赛采用三票制**（印象票 / 环节票 / 决胜票），**不以打分表为核心**；通用环节权重仅作「环节票」内比较依据，`rubric.weights` 可配置、可在评委 skill 覆盖
2. **模式并列可选**：`mode=votes`（三票制，默认）与 `mode=score`（分数制，辅助展示）
3. 判票理由必须包含：比较平台、双方最强论点、关键交锋裁决、胜负归因、最小致胜差异，并引用转写内容
4. 评委视角**每次生成前必选**（白纸/论点裁/技术裁/价值裁/情境裁），不设默认
5. 复盘界面放在新「复盘」tab（第 8 个标签页）
6. 录音归档目录 `.debate/projects/<id>/recordings/`，默认 gitignore 忽略；复盘 JSON 进 `reviews/`（可版本管理）
7. 转写：DSH 内置 STT（按环节切片）+ .srt/.vtt 字幕导入 + 纯文本粘贴，同版本支持
8. 证据候选：复盘提取 → 模型用 MCP/web 核验 → dryRun 确认 → 入公共证据库；比赛中的陈述未经核验不得当证据
