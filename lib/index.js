/**
 * 辩论备赛工作台（dsh-debate-workbench）—— 插件入口（Host 半）。
 *
 * 当前阶段只注册 Host 能力：
 *   - 11 个 `debate_*` 工具（多题目：数据落在工作区 `.debate/projects/<id>/project.bundle.json`，
 *     公共证据库落在 `.debate/shared/evidence.json`，每题待办落在题目目录 tasks.json）
 *   - `/debate-api/*` HTTP API（供客户端工作台与调试页使用）
 *   - `/debate-workbench/` 只读调试页
 *   - 一段系统提示，说明备赛工作流
 *
 * 客户端工作台（DSH 中间栏上下分拆的论证树界面）在后续阶段以 `dsh.client`
 * 半边接入；本文件届时会增加 client 入口声明，Host 侧逻辑不变。
 *
 * @module dsh-debate-workbench
 */

import { mountDebateApi } from './api.js'
import { JUDGE_SKILL_CONTENT, JUDGE_SKILL_DESCRIPTION, JUDGE_SKILL_NAME, JUDGE_SKILL_WHEN_TO_USE } from './judge-skill.js'
import { registerDebateTools } from './tools.js'

/** 插件名。 */
export const name = 'debate-workbench'

/** 依赖：工具注册表是硬依赖；Web 服务器与系统提示按可用性追加挂载。 */
export const inject = ['tools']

/** 系统提示里的备赛工作流约束。 */
const WORKFLOW_GUIDE = [
  '## 辩论备赛工作流（debate-workbench 插件已启用）',
  '当用户在做辩论备赛（拆题、立论、找证据、质询、模攻防、复盘）时，用 debate_* 工具把数据写进结构化项目，而不是只在对话里写散文。数据格式与 DebateWeaver 的 ProjectExportBundle 完全一致。',
  '1. 先 `debate_project(action=list)` 看有哪些题目、哪道是当前激活题；没有题目就用 `debate_project(action=create, topic=..., side=...)` 新建，切换用 `debate_project(action=switch, project=题目id或关键词)`。同一工作区可以同时准备多个题目，每个题目有独立目录。',
  '2. 拆题 → `debate_topic(action=save)`；论证树 → `debate_tree(action=add_node)` 从 stance 立场节点往下展开，再用 `action=auto_layout` 排版。',
  '3. 证据 → `debate_evidence(action=add)` 入库，`action=link` 挂到具体论点节点；没有挂载的证据等于没有。',
  '4. 攻防 → `debate_attack(action=add_attack)`：每个论点至少预判 事实/逻辑/价值 三类攻击，威胁度 ≥4 必须写防守策略。',
  '5. 评估 → `debate_evaluate(action=analyze)` 拿确定性五维分与缺口；`action=questions` 生成苏格拉底追问。',
  '6. 稿件 → `debate_manuscript(action=compose, kind=opening|closing|rebuttal)`，稿中〔待补〕要继续补，不要当终稿。',
  '7. 用户想「看着树改」时 → `debate_workbench(action=open)` 展开界面（顶栏可切换题目）；与 app 互通 → `debate_bundle(action=export|import)`。',
  '8. 备赛待办 → `debate_task(action=add|list|complete, project=...)`；跨题总览 → `debate_task(action=overview)`。',
  '9. 跨题复用的证据先入公共库 → `debate_library(action=add|search)`，再 `action=attach` 引用到具体题目（可同时挂节点）。',
  '10. 所有工具都支持 `project` 参数：传题目 id 或关键词即可读写指定题目，无需切换激活题（并行备赛多个题目时用它隔离数据）。',
  '11. 需要模型辅助时用 `debate_ai`：action=status 查当前模型路由；action=decompose 生成拆题候选（**只返回候选，不自动落库**）；用户确认后 action=apply 才写入。模型默认走宿主内置模型，不需要另配 API key。',
  '12. 模型生成的证据、数据、年份、机构一律视为「待核验候选」：没有可核验来源就改用机制与比较论证，绝不把模型编造的内容写进证据卡。',
  '13. **自动化备赛模式**（用户说「自动…」「帮我搭树/补攻防/把检索结果入库」时）：先 \`debate_context(action=digest)\` 看现状与缺口 → 用 \`debate_ai\` 生成拆题/攻防候选（或直接用 MCP 检索结果）→ 用 \`debate_plan(action=build_tree|fill_attacks)\` 或 \`debate_evidence(action=import)\` 以 dryRun 生成变更计划 → **先把计划摘要（将新增/修改/跳过的条目）发给用户确认** → 用户确认后同参数 apply=true 执行 → 再 \`debate_context(action=digest)\` 复核就绪度与缺口变化并汇报。',
  '14. 证据入库硬规则：\`debate_evidence(action=import)\` 要求 source 或 url 必填、按「标题+url」去重；只有 MCP/网页检索到的原始结果可以入库，模型二次归纳的结论不得当证据。MCP 工具以 \`mcp__<server>__<tool>\` 命名（如 mcp__law__search_statutes、mcp__arxiv__search_papers），检索结果整理后用 import 批量入库并挂到对应节点。',
  '15. 比赛复盘（sidecar 数据，不写入 ProjectExportBundle）：`debate_review(action=create, title=..., audioPath=... 或 transcriptText=...)` 新建 → 有录音用 `action=transcribe`（DSH 内置语音服务，需 16kHz 单声道 PCM16 WAV，按 ~110 秒切片）或 `action=import_transcript` 导入 .srt/.vtt/纯文本 → `action=analyze_judge, perspective=white-paper|argument|technical|value|situational` 判比赛（**三票制**：印象票=整体架构比较、环节票=按环节表现、决胜票=论证留存度；三票各自给理由，不用打分表算总分）→ `action=analyze_phases` 按环节复盘 → `action=evidence_candidates` 提取待核验证据候选（不自动入库）→ `action=export` 导出 Markdown。评委视角每次生成前必选。',
  '硬约束：证据必须可核验，没有确切来源时用机制与比较论证，绝不编造数据、年份、机构或论文标题。',
].join('\n')

/**
 * 插件主函数。
 *
 * @param {any} ctx cordis 上下文（保证已注入 tools）
 */
export function apply(ctx, config) {
  const panel = { url: () => undefined }
  const pluginConfig = config !== null && typeof config === 'object' ? config : {}
  const tools = registerDebateTools(ctx, { panel, config: pluginConfig })

  // 诊断引用：API 里的 /client-graph 与 /client-report 用它们读客户端模块图、写宿主日志。
  const refs = {
    clientModules: () => undefined,
    logger: () => ctx.logger,
  }
  ctx.inject(['clientModules'], inner => {
    refs.clientModules = () => inner.clientModules
  })

  ctx.inject(['webServer'], inner => {
    try {
      const mounted = mountDebateApi(inner, inner.webServer, tools, refs)
      panel.url = mounted.url
    } catch (error) {
      ctx.logger?.warn?.(`[debate-workbench] API 挂载失败，仅启用工具：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  // 注册内置「辩论赛评委」skill（用户可在项目 .dsh/skills/ 放同名 skill 覆盖）。
  ctx.inject(['skills'], inner => {
    try {
      const skills = inner.skills
      if (skills === undefined || typeof skills.register !== 'function') return
      inner.effect(() =>
        skills.register({
          name: JUDGE_SKILL_NAME,
          description: JUDGE_SKILL_DESCRIPTION,
          whenToUse: JUDGE_SKILL_WHEN_TO_USE,
          content: JUDGE_SKILL_CONTENT,
          invocation: { modelInvocable: true, userInvocable: true },
        }),
      )
      ctx.logger?.info?.(`[debate-workbench] 已注册 skill：${JUDGE_SKILL_NAME}`)
    } catch (error) {
      ctx.logger?.warn?.(`[debate-workbench] skill 注册失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.inject(['systemPrompt'], inner => {
    try {
      inner.systemPrompt.section({ name: 'debate-workbench:workflow', order: 880, text: WORKFLOW_GUIDE })
    } catch (error) {
      ctx.logger?.warn?.(`[debate-workbench] 系统提示注入失败：${error instanceof Error ? error.message : String(error)}`)
    }
  })

  ctx.logger?.info?.('[debate-workbench] 已加载：15 个备赛工具（多题目 + 待办 + 公共证据库 + 模型辅助 + 批量编排 + 比赛复盘）+ HTTP API')
}
