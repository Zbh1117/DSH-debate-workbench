/**
 * dsh-debate-workbench 逻辑自测（不需要 DSH 运行时）。
 *
 * 用假 ctx 捕获工具定义、假 exec 提供工作区，跑通整条备赛链路：
 * 建项目 → 拆题 → 论证树 → 证据卡 → 攻防框 → 五维评估 → 稿件 → 导入导出 → 界面状态。
 *
 * 运行：node tests/logic.test.mjs
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { registerDebateTools } = await import(new URL('../lib/tools.js', import.meta.url))

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-wb-logic-'))
process.env.DSH_HOME = path.join(workspace, '.dsh-home')

// 假的宿主模型服务：验证「内置模型直调」链路（真实宿主里是 deepseek-account/deepseek-flash）
const fakeDecomposeJson = {
  judgeQuestion: 'AI 的发展是否整体增进人类福祉？',
  motionType: '价值比较',
  coreConcepts: [
    { term: '人工智能', literalDefinition: '机器模拟人类认知功能的技术集合', possibleInterpretations: ['弱 AI', '通用 AI'], suggestedDefinition: '以机器学习为核心的自主决策技术', counterDefinition: '具备意识与自主目的的系统' },
  ],
  controversialPoints: [{ issue: '效率红利是否覆盖结构性代价', proView: '总量增加', conView: '分配恶化', keyBattle: '比较口径' }],
  battlefields: [{ battlefield: '就业', whyItMatters: '评委最直观', ourPush: '新岗位', opponentPush: '转换成本', priority: 'high' }],
  comparisonFramework: { overallPlatform: '整体福祉', criteria: [{ dimension: '福祉净变化', ourStandard: '收益大于代价', opponentStandard: '不可逆风险', judgeShortcut: '看谁给出口径' }] },
  hiddenPremises: [{ premise: '技术可控', explanation: '若不可控则弊大于利', howToUse: '防守点' }],
  argumentPaths: [{ side: 'pro', mainClaim: '效率红利 + 治理可控', supportingPoints: ['生产率提升'] }],
  ourSideDetailedRoute: '先立效率，再谈治理。',
  rebuttalTargets: [{ target: '不可逆风险', attackPath: '生存性风险', watchout: '别承认不可控' }],
  prepChecklist: ['证据 5 张'],
}
const fakeLlm = {
  async *stream(options) {
    const system = typeof options?.system === 'string' ? options.system : ''
    if (system.includes('"evidenceCandidates"')) {
      const evidenceCandidates = [
        { type: 'data', claim: '反方称 AI 导致 40% 岗位消失', need: '待核验', searchKeywords: ['AI 就业 岗位 数据'] },
        { type: 'case', claim: '正方引用某国全民基本收入试点', need: '缺失来源', searchKeywords: ['全民基本收入 试点 结果'] },
        { type: 'theory', claim: '比较优势机制：技术提升总量再分配', need: '可入库（理论）', searchKeywords: ['比较优势 技术 就业'] },
      ]
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ evidenceCandidates }) }
      yield { type: 'usage', usage: { inputTokens: 200, outputTokens: 300 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (system.includes('"votes"') && system.includes('"impression"')) {
      const judge = {
        votes: { impression: 'pro', phase: 'pro', decision: 'pro' },
        reasons: {
          impression: '正方整体架构更完整：定义清晰、比较平台成立、价值与论证咬合，反方架构停留在个案。',
          phase: '正方在立论与结辩占优，质询略亏但自由辩论稳住了战场，综合环节表现判正方。',
          decision: '正方核心论证存活 3/5，反方 1/5；反方的结构性失业被效率红利反驳后未能重建，决胜票归正方。',
        },
        architecture: { pro: '效率红利 + 治理可控', con: '结构性代价不可逆', compared: '正方的比较平台更完整' },
        argumentSurvival: [
          { argument: '效率红利扩大总量', side: 'pro', survived: true, afterClash: '反方未给同口径反证' },
          { argument: '治理可控', side: 'pro', survived: true, afterClash: '反方未能证明不可控' },
          { argument: '新岗位会替代旧岗位', side: 'pro', survived: false, afterClash: '被反方转换成本打掉一半' },
          { argument: '结构性失业不可逆', side: 'con', survived: false, afterClash: '被总量口径化解' },
        ],
        decisiveClashes: [
          { clash: '总量 vs 结构', judgedFor: 'pro', why: '反方始终没给出同口径数据' },
          { clash: '技术可控性', judgedFor: 'pro', why: '反方没有证明不可控' },
        ],
        minimalMargin: '决胜票的关键在反方未能重建结构性失业论证。',
      }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(judge) }
      yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 500 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    if (system.includes('phaseReview')) {
      const phaseReview = ['立论', '质询', '自由辩论', '结辩'].map(phase => ({
        phase,
        summary: `${phase}环节双方围绕核心分歧展开，正方在比较平台上更清晰，反方在细节数据上不足。`,
        findings: [
          { at: '01:20', issue: `${phase}中的定义攻防不够主动`, advice: '提前准备定义战的三个追问' },
          { at: '02:40', issue: `${phase}中回应速度偏慢`, advice: '用一句话确认对方口径再反击' },
        ],
        strengths: ['表达清楚'],
        weaknesses: ['数据缺失'],
        drill: '做 10 分钟快问快答训练',
      }))
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ phaseReview }) }
      yield { type: 'usage', usage: { inputTokens: 300, outputTokens: 600 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const isAttackPrompt = system.includes('攻防预判')
    if (isAttackPrompt) {
      // 内置 llm 调用里正文在 messages 中，不在 options.prompt
      const messageText = Array.isArray(options?.messages)
        ? options.messages
            .map(message => (Array.isArray(message?.content) ? message.content.map(block => block?.text ?? '').join('') : ''))
            .join('\n')
        : ''
      const ids = [...messageText.matchAll(/nodeId=([A-Za-z0-9_-]+)/g)].map(match => match[1])
      const attacks = ids.slice(0, 3).map((nodeId, index) => ({
        nodeId,
        type: ['factual', 'logical', 'value'][index % 3],
        content: `测试攻击 ${index + 1}：对方数据口径不成立`,
        threatLevel: index === 0 ? 5 : 3,
        defenseStrategy: index === 0 ? '用同一口径的官方数据反击' : '',
      }))
      yield { type: 'text-delta', index: 0, text: JSON.stringify({ attacks }) }
      yield { type: 'usage', usage: { inputTokens: 120, outputTokens: 240 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(fakeDecomposeJson) }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 200 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
const fakeSpeech = {
  listProviders: () => [{ id: 'fake-sensevoice', languages: ['zh', 'en'] }],
  snapshot: () => ({ providers: [{ id: 'fake-sensevoice' }], selection: { providerId: 'fake-sensevoice' } }),
  resolve(request) {
    return { provider: { id: 'fake-sensevoice' }, audio: request.audio, language: request.language ?? 'zh' }
  },
  async transcribe(spec) {
    return { text: '这是假语音服务的转写内容。', audioSeconds: 2, inferenceSeconds: 0.05 }
  },
}
const fakeAgentDefaultModel = { currentSelection: () => ({ provider: 'fake-provider', model: 'fake-model' }) }
const definitions = registerDebateTools(
  {
    tools: { register() {} },
    logger: { info() {}, warn() {} },
    get(name) {
      if (name === 'llm') return fakeLlm
      if (name === 'agentDefaultModel') return fakeAgentDefaultModel
      if (name === 'speechToText') return fakeSpeech
      return undefined
    },
  },
  { panel: { url: () => 'http://127.0.0.1:65535/debate-workbench/' } },
)

const exec = { agent: { session: { header: { cwd: workspace } } } }
const call = async (name, args) => {
  const definition = definitions.get(name)
  if (definition === undefined) throw new Error(`工具未注册：${name}`)
  const result = await definition.execute(args ?? {}, exec)
  // 宿主工具注册表要求输出是 lossless JSON：undefined/函数/非有限数都会被拒绝。
  if (JSON.stringify(JSON.parse(JSON.stringify(result))) !== JSON.stringify(result)) {
    throw new Error(`工具 ${name} 的返回值不是 lossless JSON`)
  }
  return result
}

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${String(detail).slice(0, 700)}`}`)
}

console.log(`workspace = ${workspace}`)
check('注册 15 个工具', definitions.size === 15, [...definitions.keys()].join(','))

/* 1. 建项目 */
const created = await call('debate_project', { action: 'create', topic: '人工智能的发展利大于弊', side: '正', format: 'chinese' })
const bundleFile = created.bundlePath
check('已写入项目 bundle', fs.existsSync(bundleFile))
check('题目目录位于 .debate/projects 下', String(bundleFile).includes(path.join('.debate', 'projects')), bundleFile)
check('bundle 格式对齐 app', JSON.parse(fs.readFileSync(bundleFile, 'utf8')).format === 'debateweaver-project')
check('初始就绪度很低', created.readiness < 40, created.readiness)

/* 2. 拆题 */
const decomposition = {
  judgeQuestion: '这道题该用整体福祉还是个体权利来判？',
  motionType: '事实判断 + 价值比较',
  coreConcepts: [
    { term: '人工智能', literalDefinition: '机器模拟人类认知功能的技术集合', possibleInterpretations: ['弱 AI', '通用 AI'], suggestedDefinition: '以机器学习为核心的自主决策技术集合', counterDefinition: '具备意识与自主目的的系统' },
    { term: '利大于弊', literalDefinition: '收益超过代价', possibleInterpretations: ['短期', '长期'], suggestedDefinition: '在可预见的时间尺度上人类整体福祉净增加' },
  ],
  controversialPoints: [{ issue: '效率红利是否覆盖结构性代价', proView: '总量增加', conView: '分配恶化', keyBattle: '比较口径' }],
  battlefields: [{ battlefield: '就业', whyItMatters: '评委直觉最直接', ourPush: '新岗位', opponentPush: '转换成本', priority: 'high' }],
  comparisonFramework: {
    overallPlatform: '整体福祉 vs 不可逆风险',
    criteria: [{ dimension: '福祉净变化', ourStandard: '收益大于代价', opponentStandard: '不可逆风险为零', judgeShortcut: '看谁给出可比较的口径' }],
    clashComparisons: [],
  },
  hiddenPremises: [{ premise: '技术可控', explanation: '若不可控则利弊比较失效', howToUse: '反方最强攻击点' }],
  argumentPaths: [
    { side: 'pro', mainClaim: '效率红利 + 治理可控', supportingPoints: ['生产率提升', '门槛降低'] },
    { side: 'con', mainClaim: '失业 + 权力集中', supportingPoints: ['结构失业', '能力垄断'] },
  ],
  rebuttalTargets: [{ target: '不可逆风险', attackPath: '生存性风险', watchout: '别承认风险不可控' }],
  prepChecklist: ['证据 5 张', '攻防 3 类'],
}
const topicSaved = await call('debate_topic', { action: 'save', decomposition })
check('拆题保存', topicSaved.gaps.every(item => item.level !== 'error'), JSON.stringify(topicSaved.gaps))

/* 3. 论证树 */
const stance = await call('debate_tree', { action: 'add_node', node: { type: 'stance', label: '我方立场：AI 利大于弊' } })
const stanceId = stance.node.id
const c1 = await call('debate_tree', { action: 'add_node', node: { type: 'claim', label: 'AI 提升生产率', description: '自动化替代重复劳动 → 单位产出上升' }, source: stanceId })
const c2 = await call('debate_tree', { action: 'add_node', node: { type: 'claim', label: 'AI 降低服务门槛' }, source: stanceId })
const evNode = await call('debate_tree', { action: 'add_node', node: { type: 'evidence', label: '制造业产出数据' }, source: c1.node.id })
const premise = await call('debate_tree', { action: 'add_node', node: { type: 'premise', label: '技术可治理', details: { attackable: '可挑战' } }, source: stanceId })
const value = await call('debate_tree', { action: 'add_node', node: { type: 'attitude', label: '扩展人的选择自由' }, source: stanceId })
check('添加 6 个节点', (await call('debate_project', { action: 'read' })).bundle.argumentTree.nodes.length === 6)

const moved = await call('debate_tree', { action: 'move_node', nodeId: c1.node.id, position: { x: 300, y: 130 } })
check('节点可移动', moved.node.position.x === 300)
const layout = await call('debate_tree', { action: 'auto_layout', options: { columnGap: 280, rowGap: 120 } })
check('自动布局', layout.nodes === 6 && layout.columns >= 3, JSON.stringify(layout))
const treeRead = await call('debate_tree', { action: 'read' })
check('树大纲包含节点', treeRead.markdown.includes('AI 提升生产率') && treeRead.markdown.includes('立场'), treeRead.markdown.slice(0, 200))

/* 4. 证据卡 */
const added = await call('debate_evidence', {
  action: 'add',
  cards: [
    { title: '制造业自动化观察', content: '采用自动化产线的企业单位工时产出提升 12%', originalText: '单位工时产出平均提升 12%', type: 'data', credibility: 4, source: '示例研究院', year: '2024', tags: ['生产率'], applicableSide: 'pro', counterWarning: '相关性不等于因果' },
    { title: '开源模型扩散', content: '下载量与推理成本变化', originalText: '推理成本下降两个数量级', type: 'case', credibility: 3, source: '示例数据组', tags: ['扩散'], applicableSide: 'pro' },
  ],
})
check('证据入库 2 张', added.cards.length === 2)
const cardId = added.cards[0].id
const searched = await call('debate_evidence', { action: 'search', query: '生产率' })
check('证据检索命中', searched.matched === 1, searched.matched)
const linked = await call('debate_evidence', { action: 'link', nodeId: c1.node.id, cardId, note: '核心数据' })
check('证据挂到节点', linked.link.nodeId === c1.node.id)
check('证据 useCount 增加', (await call('debate_evidence', { action: 'read', id: cardId })).card.useCount === 1)
const listLinked = await call('debate_evidence', { action: 'list_linked', nodeId: c1.node.id })
check('list_linked 返回挂载', listLinked.links.length === 1)

/* 5. 攻防框 */
const atk1 = await call('debate_attack', { action: 'add_attack', nodeId: c1.node.id, attack: { type: 'factual', content: '数据只是相关性', threatLevel: 4, defenseStrategy: '补充机制证据 + 说明样本' } })
check('高威胁攻击 + 防守', atk1.attack.threatLevel === 4)
const atk2 = await call('debate_attack', { action: 'add_attack', nodeId: c1.node.id, attack: { type: 'logical', content: '总量增加不等于分配改善', threatLevel: 5 } })
check('无防守攻击被标记风险', /还没写防守策略/.test(atk2.text), atk2.text)
const atk3 = await call('debate_attack', { action: 'add_attack', nodeId: c1.node.id, attack: { type: 'value', content: '效率不是价值', threatLevel: 2, defenseStrategy: '效率是手段，服务于福祉' } })
const updatedAttack = await call('debate_attack', { action: 'update_attack', nodeId: c1.node.id, attackId: atk2.attack.id, attack: { defenseStrategy: '再分配是制度问题，总量增加是前提' } })
check('攻击可补防守', /再分配/.test(updatedAttack.attack.defenseStrategy))
const notes = await call('debate_attack', { action: 'set_notes', nodeId: c1.node.id, mockNotes: '模辩里被追问三次', summary: '最危险的是分配问题' })
check('攻防笔记', /模辩/.test(notes.box.mockNotes))

/* 6. 评估 */
const analysis = await call('debate_evaluate', { action: 'analyze' })
check('五维分数在 0–100', Object.values(analysis.scores).every(value => value >= 0 && value <= 100), JSON.stringify(analysis.scores))
check('结构缺口能报出叶子论点', analysis.gaps.some(item => item.code === 'T_CLAIM_LEAF'), JSON.stringify(analysis.gaps.map(item => item.code)))
const questions = await call('debate_evaluate', { action: 'questions' })
check('苏格拉底追问非空', questions.questions.length > 0, questions.questions.length)
const savedEval = await call('debate_evaluate', {
  action: 'save',
  evaluation: { logic: 78, evidence: 72, persuasiveness: 70, innovation: 65, counterResilience: 74, suggestions: ['补证据卡'], priorityFixes: [{ problem: '分配问题', whyItLoses: '被打穿', fixNow: '写防守' }], judgeQuestions: ['总量增加能证明福祉增加吗'] },
})
check('评估记录保存', savedEval.evaluation.overall > 0 && savedEval.evaluation.suggestions.length === 1, savedEval.evaluation.overall)

/* 7. 稿件 */
const opening = await call('debate_manuscript', { action: 'compose', kind: 'opening' })
check('一辩稿含节点与引用', opening.content.includes('AI 提升生产率') && opening.content.includes('制造业自动化观察'), opening.content.slice(0, 300))
check('稿件已保存', (await call('debate_manuscript', { action: 'list' })).manuscripts.length === 1)
const closing = await call('debate_manuscript', { action: 'compose', kind: 'closing', save: false })
check('结辩稿生成', /价值升华/.test(closing.content))
const rebuttal = await call('debate_manuscript', { action: 'compose', kind: 'rebuttal', save: false })
check('驳论清单生成', /对方可能立论/.test(rebuttal.content))
const archive = await call('debate_manuscript', { action: 'markdown' })
check('整案归档落盘', fs.existsSync(archive.path))

/* 8. 界面状态 */
const opened = await call('debate_workbench', { action: 'open' })
check('工作台可展开', opened.ui.open === true)
const setUi = await call('debate_workbench', { action: 'set', orientation: 'horizontal', ratio: 0.42, tab: 'evidence' })
check('分屏设置生效', setUi.ui.orientation === 'horizontal' && Math.abs(setUi.ui.ratio - 0.42) < 1e-6 && setUi.ui.tab === 'evidence', JSON.stringify(setUi.ui))
const state = await call('debate_workbench', { action: 'state' })
check('状态可读', state.snapshot.active === true && state.snapshot.project.title === '人工智能的发展利大于弊', JSON.stringify(state.snapshot))
const closed = await call('debate_workbench', { action: 'close' })
check('工作台可收起', closed.ui.open === false)

/* 9. 互通与校验 */
const validation = await call('debate_bundle', { action: 'validate' })
check('数据一致性通过', validation.ok === true, JSON.stringify(validation.errors))
const exported = await call('debate_bundle', { action: 'export', path: 'exported-bundle.json' })
check('bundle 可导出', fs.existsSync(exported.path))
const exportedJson = JSON.parse(fs.readFileSync(exported.path, 'utf8'))
check('导出内容对齐 app 格式', exportedJson.format === 'debateweaver-project' && exportedJson.version === 1 && Array.isArray(exportedJson.evidenceCards))

// 模拟从 app 导入：删掉本地项目数据后重新导入（导出文件在 .debate 之外，不会被删）
fs.rmSync(path.join(workspace, '.debate'), { recursive: true, force: true })
const imported = await call('debate_bundle', { action: 'import', path: exported.path })
check('可从 bundle 导入', imported.project.title === '人工智能的发展利大于弊')
const afterImport = await call('debate_project', { action: 'read' })
check('导入后节点完整', afterImport.bundle.argumentTree.nodes.length === 6)
check('导入后稿件完整', afterImport.bundle.manuscripts.length === 1)

/* 10. 多题目：独立目录 / 切换 / 隔离 / 待办 / 公共证据库 */
const prepared = await call('debate_project', { action: 'create', topic: '短视频的流行利大于弊', side: '反', format: 'chinese' })
check('可创建第二个题目', prepared.project.title === '短视频的流行利大于弊' && fs.existsSync(prepared.bundlePath), prepared.bundlePath)
const indexFile = path.join(workspace, '.debate', 'projects.index.json')
check('题目索引已写入', fs.existsSync(indexFile))
const listed = await call('debate_project', { action: 'list' })
check('列表含两个题目', listed.text.includes('人工智能的发展利大于弊') && listed.text.includes('短视频的流行利大于弊'), listed.text)
check('当前激活为第二个题目', listed.activeProjectId === prepared.project.id, listed.activeProjectId)

// 在第二个题目里加节点：不影响第一个题目
const secondNode = await call('debate_tree', { action: 'add_node', node: { type: 'stance', label: '反方立场：短视频弊大于利' } })
check('第二题目可写节点', typeof secondNode.node.id === 'string')
const firstAgain = await call('debate_project', { action: 'read', project: '人工智能的发展利大于弊' })
check('按题目名跨题读取', firstAgain.bundle.project.title === '人工智能的发展利大于弊' && firstAgain.bundle.argumentTree.nodes.length === 6, firstAgain.bundle.argumentTree.nodes.length)
const secondAgain = await call('debate_project', { action: 'read' })
check('激活题目仍是第二个', secondAgain.bundle.project.title === '短视频的流行利大于弊' && secondAgain.bundle.argumentTree.nodes.length === 1)

// 切换回第一个题目
const switched = await call('debate_project', { action: 'switch', project: '人工智能' })
check('可切换题目', switched.project.title === '人工智能的发展利大于弊' && switched.readiness > 0, switched.text)
const afterSwitch = await call('debate_project', { action: 'read' })
check('切换后读到第一个题目', afterSwitch.bundle.argumentTree.nodes.length === 6)

// 待办：注意按 project 指定题目操作，不切换激活题
const task = await call('debate_task', { action: 'add', project: '短视频', title: '补 3 张屏幕时间数据', deadline: '2030-01-01' })
check('待办可添加', task.task.title === '补 3 张屏幕时间数据')
const taskList = await call('debate_task', { action: 'list', project: '短视频' })
check('待办可列出', taskList.tasks.length === 1 && taskList.tasks[0].deadline === '2030-01-01', JSON.stringify(taskList.tasks))
const completed = await call('debate_task', { action: 'complete', project: '短视频', taskId: task.task.id })
check('待办可完成', completed.task.status === 'done')
const overview = await call('debate_task', { action: 'overview' })
check('跨题总览含两个题目', overview.rows.length === 2 && /短视频/.test(overview.text) && /人工智能/.test(overview.text), overview.text)
check('待办不影响题目数据', (await call('debate_project', { action: 'read' })).bundle.argumentTree.nodes.length === 6)

// 公共证据库：入库 + 检索 + 引用到题目
const shared = await call('debate_library', {
  action: 'add',
  cards: [{ title: '屏幕时间与青少年心理健康（机制）', content: '长期屏幕时间与睡眠、注意力下降存在相关性', type: 'theory', credibility: 3, applicableSide: 'con', tags: ['短视频', '注意力'] }],
})
check('公共证据可入库', shared.total === 1 && typeof shared.cards[0].id === 'string')
const found = await call('debate_library', { action: 'search', query: '注意力' })
check('公共证据可检索', found.cards.length === 1 && found.cards[0].title.includes('屏幕时间'))
const attached = await call('debate_library', { action: 'attach', cardId: shared.cards[0].id, project: '短视频' })
check('公共证据可引用到题目', attached.readiness >= 0 && attached.card.sharedId === shared.cards[0].id, JSON.stringify(attached.card))
const attachedBundle = await call('debate_project', { action: 'read', project: '短视频' })
check('引用后题目内有共享标记', attachedBundle.bundle.evidenceCards.some(card => card.sharedId === shared.cards[0].id))
check('引用不改变激活题目', (await call('debate_project', { action: 'read' })).bundle.project.title === '人工智能的发展利大于弊')

/* 11. 模型辅助：内置模型直调，候选默认不落库 */
const aiStatusResult = await call('debate_ai', { action: 'status' })
check('AI 状态可读', aiStatusResult.status.available === true && aiStatusResult.status.model === 'fake-model', JSON.stringify(aiStatusResult.status))
const aiCandidateResult = await call('debate_ai', { action: 'decompose', hint: '重点做价值比较' })
check(
  '拆题候选可生成',
  aiCandidateResult.applied === false && aiCandidateResult.candidate.coreConcepts.length >= 1 && aiCandidateResult.candidate.controversialPoints.length >= 1,
  JSON.stringify(aiCandidateResult.candidate).slice(0, 300),
)
const beforeApply = await call('debate_project', { action: 'read' })
check('候选未自动落库', beforeApply.bundle.decompositionResults?.[0]?.source !== 'debate_ai', String(beforeApply.bundle.decompositionResults?.[0]?.source))
const appliedAi = await call('debate_ai', { action: 'apply', candidate: aiCandidateResult.candidate })
check('候选可应用', appliedAi.applied === true && appliedAi.decomposition.source === 'debate_ai', JSON.stringify({ applied: appliedAi.applied, source: appliedAi.decomposition?.source }))
const afterApply = await call('debate_project', { action: 'read' })
check('应用后写入拆题结构', (afterApply.bundle.decompositionResults?.[0]?.coreConcepts ?? []).length >= 1 && afterApply.bundle.decompositionResults[0].judgeQuestion.includes('福祉'))
check('模型辅助不产生证据卡', afterApply.bundle.evidenceCards.every(card => card.sharedId !== undefined || card.title !== '人工智能'))

/* 12. 编排工具：上下文 / 搭树 / 攻防 / 证据导入 / 攻防候选 */
const digest = await call('debate_context', { action: 'digest' })
check('上下文摘要可读', typeof digest.digest.readiness === 'number' && digest.digest.tree.nodes >= 1, JSON.stringify(digest.digest.tree))
const outlineOnly = await call('debate_context', { action: 'outline' })
check('树大纲可读', Array.isArray(outlineOnly.outline) && outlineOnly.outline.length >= 1)
const evidenceSearch = await call('debate_context', { action: 'search_evidence', query: '就业' })
check('跨库证据检索', Array.isArray(evidenceSearch.projectHits) && Array.isArray(evidenceSearch.sharedHits))

const planDry = await call('debate_plan', { action: 'build_tree', apply: false })
check('搭树计划 dryRun', planDry.apply === false && Array.isArray(planDry.nodes), JSON.stringify(planDry.nodes).slice(0, 300))
const nodesBefore = (await call('debate_project', { action: 'read' })).bundle.argumentTree.nodes.length
const planApplied = await call('debate_plan', { action: 'build_tree', apply: true })
check('搭树计划可执行', planApplied.apply === true && planApplied.nodes >= nodesBefore, JSON.stringify({ created: planApplied.created, nodes: planApplied.nodes }))
const treeAfterPlan = (await call('debate_project', { action: 'read' })).bundle
const claimNode = treeAfterPlan.argumentTree.nodes.find(node => node.type === 'claim')
check('搭树后有可用论点节点', claimNode !== undefined, JSON.stringify(treeAfterPlan.argumentTree.nodes.map(node => node.type)))

const attackDry = await call('debate_plan', {
  action: 'fill_attacks',
  apply: false,
  attacks: [
    { nodeId: claimNode.id, type: 'factual', content: '对方数据口径不成立', threatLevel: 5 },
    { nodeId: claimNode.id, type: 'logical', content: '因果链断裂', threatLevel: 3 },
  ],
})
check('攻防 dryRun 拒绝缺防守的高威胁', attackDry.wouldAppend === 1 && attackDry.errors.length === 1, JSON.stringify({ plan: attackDry.plan, errors: attackDry.errors }))
const attackApplied = await call('debate_plan', {
  action: 'fill_attacks',
  apply: true,
  attacks: [{ nodeId: claimNode.id, type: 'value', content: '价值排序不当', threatLevel: 4, defenseStrategy: '用更高位阶价值回应' }],
})
check('攻防可写入', attackApplied.applied !== false && attackApplied.appended === 1, JSON.stringify(attackApplied))

const importDry = await call('debate_evidence', {
  action: 'import',
  cards: [
    { title: '无来源证据', type: 'data', credibility: 3 },
    { title: '可核验证据 A', source: '国家统计局', url: 'https://example.com/a', type: 'data', credibility: 4, nodeIds: [claimNode.id] },
  ],
})
check('证据导入 dryRun 校验来源', importDry.apply === false && importDry.wouldCreate === 1 && importDry.skipped.length === 1, JSON.stringify({ wouldCreate: importDry.wouldCreate, skipped: importDry.skipped }))
const importApplied = await call('debate_evidence', {
  action: 'import',
  apply: true,
  cards: [{ title: '可核验证据 A', source: '国家统计局', url: 'https://example.com/a', type: 'data', credibility: 4, nodeIds: [claimNode.id] }],
})
check('证据导入写入并挂载', importApplied.apply === true && importApplied.created === 1 && importApplied.linked === 1, JSON.stringify(importApplied))
const importAgain = await call('debate_evidence', { action: 'import', apply: true, cards: [{ title: '可核验证据 A', source: '国家统计局', url: 'https://example.com/a', type: 'data', credibility: 4 }] })
check('重复导入被去重', importAgain.created === 0 && importAgain.skipped.length === 1)

const attackCandidate = await call('debate_ai', { action: 'attacks', nodeIds: [claimNode.id] })
check('攻防候选可生成', attackCandidate.applied === false && attackCandidate.attacks.length >= 1 && attackCandidate.attacks.every(item => item.threatLevel < 4 || item.defenseStrategy !== ''), JSON.stringify(attackCandidate.attacks))

/* 13. 工作区一致性：工具默认跟随「激活工作区」而不是 Agent cwd */
const otherWorkspace = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-wb-other-'))
const otherExec = { agent: { session: { header: { cwd: otherWorkspace } } } }
const libraryAddResult = await definitions.get('debate_library').execute(
  { action: 'add', cards: [{ title: '工作区一致性测试证据', source: '测试来源', type: 'theory' }] },
  otherExec,
)
check(
  '公共证据库返回值带 workspace',
  typeof libraryAddResult.workspace === 'string' && path.resolve(libraryAddResult.workspace) === path.resolve(workspace),
  JSON.stringify({ got: libraryAddResult.workspace, expected: workspace }),
)
check(
  '工具默认写入激活工作区（而非 Agent cwd）',
  fs.existsSync(path.join(workspace, '.debate', 'shared', 'evidence.json')) && !fs.existsSync(path.join(otherWorkspace, '.debate', 'shared', 'evidence.json')),
  JSON.stringify({ otherWorkspace }),
)

/* 14. 比赛复盘（M1/M2）：sidecar 数据 + 工具层 */
const reviewAudio = path.join(workspace, 'fake-match.m4a')
fs.writeFileSync(reviewAudio, Buffer.alloc(2048, 7))
const reviewCreated = await call('debate_review', {
  action: 'create',
  title: '对XX大学模辩',
  date: '2030-01-02',
  opponent: 'XX大学',
  ourSide: 'pro',
  audioPath: reviewAudio,
  transcriptText: '正方立论：AI 提升生产率。反方质询：结构性失业如何解释？',
})
check('复盘可创建', typeof reviewCreated.reviewId === 'string' && reviewCreated.review.hasTranscript === true, JSON.stringify(reviewCreated.review))
const reviewId = reviewCreated.reviewId
const activeBundle = (await call('debate_project', { action: 'read' })).bundle
const recordingAbs = path.join(workspace, '.debate', 'projects', activeBundle.project.id, 'recordings', `${reviewId}.m4a`)
check('录音已复制进题目目录', fs.existsSync(recordingAbs) && fs.statSync(recordingAbs).size === 2048, recordingAbs)

const reviewList = await call('debate_review', { action: 'list' })
check('复盘列表可读', Array.isArray(reviewList.reviews) && reviewList.reviews.some(item => item.id === reviewId), JSON.stringify(reviewList.reviews))
const reviewRead = await call('debate_review', { action: 'read', reviewId })
check('复盘可读取且含转写', reviewRead.review.transcript.text.includes('结构性失业'), reviewRead.review.transcript.text)

const reviewUpdated = await call('debate_review', {
  action: 'update',
  reviewId,
  patch: {
    judge: {
      perspective: 'white-paper',
      mode: 'votes',
      winner: 'pro',
      voteCount: '3:0',
      votes: { impression: 'pro', phase: 'pro', decision: 'pro' },
      reasons: { impression: '架构更完整', phase: '立论+3 / 质询-1', decision: '核心论证存活 3/5' },
      argumentSurvival: [{ argument: '效率红利', side: 'pro', survived: true, afterClash: '未被有效回应' }],
      decisiveClashes: [{ clash: '就业', judgedFor: 'pro', why: '反方无同口径数据' }],
    },
    overall: { verdict: '赢在架构', actionItems: ['补就业数据'] },
  },
})
check('复盘可更新判比赛（三票制）', reviewUpdated.review.winner === 'pro' && reviewUpdated.review.voteCount === '3:0', JSON.stringify(reviewUpdated.review))

const reviewExported = await call('debate_review', { action: 'export', reviewId })
check(
  '复盘可导出 Markdown',
  fs.existsSync(reviewExported.path) && reviewExported.markdown.includes('印象票') && reviewExported.markdown.includes('对XX大学模辩'),
  reviewExported.path,
)
const bundleAfterReview = (await call('debate_project', { action: 'read' })).bundle
check(
  '复盘不写入 ProjectExportBundle',
  !('reviews' in bundleAfterReview) && !JSON.stringify(bundleAfterReview).includes('对XX大学模辩'),
  JSON.stringify(Object.keys(bundleAfterReview)),
)

const reviewDeleted = await call('debate_review', { action: 'delete', reviewId })
check('复盘可删除且清理录音', reviewDeleted.audioRemoved === true && !fs.existsSync(recordingAbs), JSON.stringify(reviewDeleted))

/* 15. 复盘转写与 AI（M3/M4） */
const makeWav = seconds => {
  const dataBytes = Math.round(seconds * 16000 * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(dataBytes, 40)
  return Buffer.concat([header, Buffer.alloc(dataBytes, 0)])
}
const wavFile = path.join(workspace, 'match.wav')
fs.writeFileSync(wavFile, makeWav(2))
const sttReview = await call('debate_review', { action: 'create', title: '对YY大学模辩', date: '2030-02-03', ourSide: 'pro', audioPath: wavFile })
check('复盘可附带规范 WAV 录音', sttReview.review.audio?.ext === 'wav' && sttReview.review.audio.bytes > 64000, JSON.stringify(sttReview.review.audio))

const sttDone = await call('debate_review', { action: 'transcribe', reviewId: sttReview.reviewId, phaseBoundaries: [{ phase: '立论', start: 0, end: 2 }] })
check('录音可转写（假语音服务）', sttDone.chunks >= 1 && sttDone.provider === 'fake-sensevoice' && sttDone.chars > 0, JSON.stringify(sttDone))
const sttRead = await call('debate_review', { action: 'read', reviewId: sttReview.reviewId })
check('转写结果写入 transcript 且带环节标签', sttRead.review.transcript.text.includes('假语音') && sttRead.review.transcript.segments.some(segment => segment.phase === '立论'), JSON.stringify(sttRead.review.transcript.segments))

const srtText = ['1', '00:00:01,000 --> 00:00:03,500', '正方一辩：AI 提升生产率。', '', '2', '00:00:04,000 --> 00:00:06,000', '反方质询：结构性失业怎么解释？'].join('\n')
const srtReview = await call('debate_review', { action: 'create', title: '字幕导入测试', date: '2030-02-04' })
const importedTranscript = await call('debate_review', { action: 'import_transcript', reviewId: srtReview.reviewId, text: srtText, phaseBoundaries: [{ phase: '立论', start: 0, end: 3.6 }] })
check('SRT 可解析并导入（含时间戳）', importedTranscript.format === 'srt' && importedTranscript.segmentCount === 2 && importedTranscript.phaseTagged === 1, JSON.stringify(importedTranscript))
const srtRead = await call('debate_review', { action: 'read', reviewId: srtReview.reviewId })
check('SRT 时间戳写入 segments', srtRead.review.transcript.segments[0]?.start === 1 && String(srtRead.review.transcript.text).includes('结构性失业'), JSON.stringify(srtRead.review.transcript.segments[0]))

let missingPerspective = false
try {
  await call('debate_review', { action: 'analyze_judge', reviewId: sttReview.reviewId })
} catch (error) {
  missingPerspective = String(error).includes('perspective')
}
check('analyze_judge 必须选择评委视角', missingPerspective === true)

const judged = await call('debate_review', { action: 'analyze_judge', reviewId: sttReview.reviewId, perspective: 'white-paper', mode: 'votes' })
check('判比赛生成（三票制）', judged.winner === 'pro' && judged.voteCount === '3:0' && Object.values(judged.votes).every(side => side === 'pro'), JSON.stringify(judged.votes))
const judgedRead = await call('debate_review', { action: 'read', reviewId: sttReview.reviewId })
check('判票理由与论证留存度已写入', judgedRead.review.judge.reasons.decision.length > 20 && judgedRead.review.judge.argumentSurvival.length >= 4 && judgedRead.review.judge.decisiveClashes.length >= 2, JSON.stringify({ survival: judgedRead.review.judge.argumentSurvival.length, clashes: judgedRead.review.judge.decisiveClashes.length }))

const phased = await call('debate_review', { action: 'analyze_phases', reviewId: sttReview.reviewId })
check('环节复盘生成', phased.phases.length === 4 && phased.phases.includes('自由辩论'), JSON.stringify(phased.phases))
const phasedRead = await call('debate_review', { action: 'read', reviewId: sttReview.reviewId })
check('每个环节至少 2 条问题', phasedRead.review.phaseReview.every(phase => phase.findings.length >= 2), JSON.stringify(phasedRead.review.phaseReview.map(phase => phase.findings.length)))

const candidates = await call('debate_review', { action: 'evidence_candidates', reviewId: sttReview.reviewId })
check('证据候选提取（全部 pending）', candidates.candidates.length >= 2 && candidates.candidates.every(item => item.status === 'pending'), JSON.stringify(candidates.candidates))
const finalRead = await call('debate_review', { action: 'read', reviewId: sttReview.reviewId })
check('证据候选未入库（公共库不增加）', (await call('debate_library', { action: 'list' })).cards.every(card => !String(card.title ?? '').includes('反方称 AI 导致')), '')
const exportedReview = await call('debate_review', { action: 'export', reviewId: sttReview.reviewId })
check('复盘 Markdown 含三票与环节复盘', exportedReview.markdown.includes('印象票') && exportedReview.markdown.includes('环节票') && exportedReview.markdown.includes('决胜票') && exportedReview.markdown.includes('环节复盘'), exportedReview.path.slice(-60))
check('判比赛免责声明写入', String(finalRead.review.judge.disclaimer).includes('模拟评委'), finalRead.review.judge.disclaimer)

const cleanupStt = await call('debate_review', { action: 'delete', reviewId: sttReview.reviewId })
const cleanupSrt = await call('debate_review', { action: 'delete', reviewId: srtReview.reviewId })
check('复盘清理（含录音）', cleanupStt.audioRemoved === true && cleanupSrt.audioRemoved === false, JSON.stringify({ stt: cleanupStt, srt: cleanupSrt }))

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
console.log(`产物目录：${path.join(workspace, '.debate')}`)
if (failures > 0) process.exitCode = 1
