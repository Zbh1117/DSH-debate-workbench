/**
 * dsh-debate-workbench HTTP API 自测。
 *
 * 用真实 node:http 模拟 DSH webServer 的 prefix 路由，验证：
 * 调试页、UI 状态、项目数据、工具转发（POST /tool）、bundle 下载、错误映射。
 *
 * 运行：node tests/api.test.mjs
 */
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'

const { mountDebateApi } = await import(new URL('../lib/api.js', import.meta.url))
const { registerDebateTools } = await import(new URL('../lib/tools.js', import.meta.url))

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'debate-wb-api-'))
process.env.DSH_HOME = path.join(workspace, '.dsh-home')

const definitions = registerDebateTools({ tools: { register() {} }, logger: { info() {}, warn() {} } }, {})

const routes = []
const fakeWebServer = {
  host: '127.0.0.1',
  port: 0,
  register(route) {
    routes.push(route)
    return () => {}
  },
}
const ctx = {
  effect: fn => fn?.(() => {}) ?? (() => {}),
  on() {
    return () => {}
  },
  logger: { info() {}, warn() {} },
}
const fakeGraph = {
  rev: 'rev-1',
  entries: [
    { id: 'dsh-debate-workbench', kind: 'client' },
    { id: 'other-plugin', kind: 'client' },
  ],
  batches: [{ url: '/plugins/batch-1.js' }],
}
const refs = {
  clientModules: () => ({ graph: () => fakeGraph }),
  logger: () => ({ info() {}, warn() {} }),
}
const page = mountDebateApi(ctx, fakeWebServer, definitions, refs)

function match(pathname) {
  let best
  for (const route of routes) {
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue
    if (best === undefined || route.path.length > best.path.length) best = route
  }
  return best
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  const route = match(url.pathname)
  if (route === undefined) {
    res.writeHead(404)
    res.end('no route')
    return
  }
  route.handler(req, res).catch(error => {
    res.writeHead(500)
    res.end(String(error))
  })
})
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}`
fakeWebServer.port = server.address().port

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${String(detail).slice(0, 700)}`}`)
}

const get = async pathname => {
  const response = await fetch(`${base}${pathname}`)
  return { status: response.status, contentType: response.headers.get('content-type'), body: await response.text() }
}
const post = async (pathname, body) => {
  const response = await fetch(`${base}${pathname}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: response.status, json: await response.json().catch(() => undefined) }
}

console.log(`base = ${base}`)

/* 1. 调试页 */
const pageResponse = await get(`${new URL(page.url()).pathname}`)
check('调试页可访问', pageResponse.status === 200 && pageResponse.body.includes('辩论备赛工作台'), pageResponse.status)

/* 2. 没有项目时的状态 */
const emptyState = JSON.parse((await get('/debate-api/state')).body)
check('无项目时 state.active=false', emptyState.ok === true && emptyState.snapshot.active === false, JSON.stringify(emptyState).slice(0, 200))

/* 3. 用 API 建项目（走 /tool 转发） */
const created = await post('/debate-api/tool', { name: 'debate_project', args: { action: 'create', topic: '人工智能的发展利大于弊', side: '正', workspace } })
check('tool 转发建项目成功', created.status === 200 && created.json.ok === true && created.json.result.project.title.includes('人工智能'), JSON.stringify(created.json).slice(0, 200))
check('创建后返回分析', typeof created.json.analysis.readiness === 'number' && typeof created.json.analysis.scores.logic === 'number')

/* 4. 加节点 + 证据 + 攻防 */
const node = await post('/debate-api/tool', { name: 'debate_tree', args: { action: 'add_node', node: { type: 'stance', label: '我方立场' }, workspace } })
const nodeId = node.json.result.node.id
check('加节点返回 id', typeof nodeId === 'string' && nodeId.startsWith('node-'), nodeId)
const claim = await post('/debate-api/tool', { name: 'debate_tree', args: { action: 'add_node', node: { type: 'claim', label: '效率提升' }, source: nodeId, workspace } })
const claimId = claim.json.result.node.id
const card = await post('/debate-api/tool', { name: 'debate_evidence', args: { action: 'add', cards: [{ title: '数据卡', content: '产出提升 12%', type: 'data', credibility: 4, source: '示例' }], workspace } })
const cardId = card.json.result.cards[0].id
const link = await post('/debate-api/tool', { name: 'debate_evidence', args: { action: 'link', nodeId: claimId, cardId, workspace } })
check('证据可挂载', link.json.ok === true && link.json.result.link.nodeId === claimId)
const attack = await post('/debate-api/tool', { name: 'debate_attack', args: { action: 'add_attack', nodeId: claimId, attack: { type: 'factual', content: '只是相关性', threatLevel: 4, defenseStrategy: '补机制' }, workspace } })
check('攻防可写入', attack.json.ok === true && attack.json.result.attack.threatLevel === 4)

/* 5. 状态 / 数据 / 导出 */
const state = JSON.parse((await get('/debate-api/state')).body)
check('state 返回项目与分析', state.snapshot.active === true && state.project.title.includes('人工智能') && state.analysis.stats.tree.total === 2, JSON.stringify(state.snapshot).slice(0, 200))
const bundleResponse = await get(`/debate-api/bundle?workspace=${encodeURIComponent(workspace)}`)
const bundlePayload = JSON.parse(bundleResponse.body)
check('bundle 接口返回完整数据', bundlePayload.ok === true && bundlePayload.bundle.argumentTree.nodes.length === 2)
const exported = await get('/debate-api/export')
check('export 返回附件', exported.status === 200 && /attachment/.test(exported.contentType ?? '') === false && exported.body.includes('debateweaver-project'), exported.contentType)
const exportJson = JSON.parse(exported.body)
check('导出 JSON 合法', exportJson.format === 'debateweaver-project' && exportJson.evidenceCards.length === 1)

/* 6. UI 状态接口 */
const ui = await post('/debate-api/ui', { workspace, open: true, orientation: 'horizontal', ratio: 0.4, tab: 'tree', selectedNodeId: claimId })
check('UI 状态可写', ui.json.ok === true && ui.json.ui.orientation === 'horizontal' && Math.abs(ui.json.ui.ratio - 0.4) < 1e-6, JSON.stringify(ui.json.ui))
const uiRead = JSON.parse((await get('/debate-api/ui')).body)
check('UI 状态可读', uiRead.snapshot.ui.open === true && uiRead.snapshot.ui.selectedNodeId === claimId, JSON.stringify(uiRead.snapshot.ui))

/* 7. 错误映射 */
const unknownTool = await post('/debate-api/tool', { name: 'nope', args: { workspace } })
check('未知工具 404', unknownTool.status === 404, unknownTool.status)
const badWorkspace = await post('/debate-api/tool', { name: 'debate_project', args: { action: 'status', workspace: path.join(workspace, 'nope') } })
check('无项目工作区 400', badWorkspace.status === 400, JSON.stringify(badWorkspace))
const badBody = await fetch(`${base}/debate-api/tool`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json' })
check('非法 JSON 被拒绝', badBody.status === 500, badBody.status)

/* 8. 静态资源缺失 */
const missing = await get('/debate-workbench/nope.css')
check('未知静态资源 404', missing.status === 404, missing.status)

/* 9. 诊断端点 */
const graph = JSON.parse((await get('/debate-api/client-graph')).body)
check('client-graph 报告包含本插件', graph.ok === true && graph.available === true && graph.included === true && graph.mine.length === 1, JSON.stringify(graph).slice(0, 300))
const reportResponse = await post('/debate-api/client-report', { stage: 'test', message: '来自测试的客户端错误上报' })
check('client-report 可接收', reportResponse.status === 200 && reportResponse.json.ok === true && reportResponse.json.stage === 'test', JSON.stringify(reportResponse.json))
const reports = JSON.parse((await get('/debate-api/client-reports')).body)
check('client-reports 可回读', reports.ok === true && reports.reports.length === 1 && reports.reports[0].stage === 'test', JSON.stringify(reports).slice(0, 300))

server.close()
console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exitCode = 1
