/**
 * dsh-debate-workbench 客户端半边自测（Node 环境，用极简 React 替身）。
 *
 * 验证（在把客户端插件装进 DSH 之前）：
 *   1. client.js 能被 __ModuleLoader__ 注册，factory 返回带 inject 的插件对象；
 *   2. apply 会注册右栏页面类型（sidebarRightTabs.register）、内容/标题槽位、
 *      组合输入框启动按钮，并在 ui.open=true 时调用 sidebarRight.openTab；
 *   3. ui.js 的 createWorkbench 能渲染出工作台（不依赖真实 React 也能跑通渲染函数）。
 *
 * 运行：node tests/client.test.mjs
 */
import fs from 'node:fs'
import vm from 'node:vm'

const clientSource = fs.readFileSync(new URL('../assets/client.js', import.meta.url), 'utf8')

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${String(detail).slice(0, 700)}`}`)
}

/* ---------------- 极简 React 替身 ---------------- */
function createReactStub() {
  let cursor = 0
  const state = []
  function Component(props) {
    this.props = props
    this.state = {}
  }
  Component.prototype.setState = function (next) {
    this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) }
  }
  Component.prototype.render = function () {
    return null
  }
  const React = {
    Component,
    Fragment: Symbol('Fragment'),
    createElement(type, props, ...children) {
      const normalized = children.length <= 1 ? children[0] : children
      return { type, props: { ...(props ?? {}), children: normalized }, $$element: true }
    },
    useState(initial) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = typeof initial === 'function' ? initial() : initial
      return [state[slot], next => { state[slot] = typeof next === 'function' ? next(state[slot]) : next }]
    },
    useRef(initial) {
      const slot = cursor++
      if (!(slot in state)) state[slot] = { current: initial }
      return state[slot]
    },
    useCallback(fn) {
      cursor++
      return fn
    },
    useMemo(fn) {
      cursor++
      return fn()
    },
    useEffect() {
      cursor++
    },
  }
  return {
    React,
    reset() {
      cursor = 0
    },
  }
}

/* ---------------- 最小 DOM 替身 ---------------- */
function createDocumentStub() {
  const elements = new Map()
  return {
    head: { appendChild() {}, append() {} },
    getElementById(id) {
      return elements.get(id) ?? null
    },
    createElement(tag) {
      const element = { tag, style: {}, children: [], appendChild() {} }
      if (tag === 'style') elements.set('dwb-style', element)
      return element
    },
    querySelector() {
      return null
    },
    addEventListener() {},
  }
}

/* ---------------- 1. client.js 加载器 ---------------- */
console.log('client.js 加载器')
const loaded = []
const context = {
  console,
  window: { __ModuleLoader__: { load: registration => loaded.push(registration) } },
  document: createDocumentStub(),
  fetch: () =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          snapshot: { active: true, ui: { open: true } },
          analysis: { scores: {}, gaps: [], readiness: 0 },
          projects: [],
          bundle: {
            project: { title: '测试项目', side: 'pro' },
            argumentTree: { nodes: [], edges: [] },
            evidenceCards: [],
            nodeEvidenceLinks: [],
            attackDefenseBoxes: [],
          },
        }),
      text: () => Promise.resolve(''),
    }),
  setInterval: () => 0,
  clearInterval: () => {},
  setTimeout: () => 0,
  URL: { createObjectURL: () => 'blob:test', revokeObjectURL: () => {} },
  Blob: class {},
  Date,
}
vm.createContext(context)
vm.runInContext(clientSource, context)

check('注册到 __ModuleLoader__', loaded.length === 1, JSON.stringify(loaded.map(item => item.id)))
check('注册 id 为包名', loaded[0]?.id === 'dsh-debate-workbench', loaded[0]?.id)

const reactStub = createReactStub()
const moduleExports = loaded[0].factory(name => {
  if (name === 'react') return reactStub.React
  throw new Error(`未预期的 require：${name}`)
})
check('factory 返回插件对象', typeof moduleExports.apply === 'function' && typeof moduleExports.name === 'string', JSON.stringify(Object.keys(moduleExports)))
check(
  '声明注入 slots/sidebarRight/sidebarRightTabs/shortcuts',
  Array.isArray(moduleExports.inject) &&
    ['slots', 'sidebarRight', 'sidebarRightTabs', 'shortcuts'].every(name => moduleExports.inject.includes(name)),
  JSON.stringify(moduleExports.inject),
)

const tabTypes = []
const slotRegistrations = []
const shortcuts = []
const openTabs = []
const fakeCtx = {
  effect(callback) {
    const disposer = callback()
    return typeof disposer === 'function' ? disposer : () => {}
  },
  slots: {
    inject(key, callback) {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    },
    register(options, component) {
      slotRegistrations.push({ options, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition)
      return () => {}
    },
  },
  shortcuts: {
    register(definition) {
      shortcuts.push(definition)
      return () => {}
    },
  },
  sidebarRight: {
    openTab(kind) {
      openTabs.push(kind)
    },
  },
}
moduleExports.apply(fakeCtx)
await new Promise(resolve => setTimeout(resolve, 20))

check('注册了右栏页面类型', tabTypes.length === 1 && tabTypes[0].kind === 'debate-workbench', JSON.stringify(tabTypes))
check('页面类型 id 稳定', tabTypes[0]?.id === 'dsh-debate-workbench/tab', tabTypes[0]?.id)
check('标题函数返回中文名', tabTypes[0]?.title?.() === '辩论工作台', tabTypes[0]?.title?.())
const bodySlot = slotRegistrations.find(item => item.options.name === 'sidebar.right.pane.tab')
const titleSlot = slotRegistrations.find(item => item.options.name === 'sidebar.right.pane.tab.title')
const launcherSlot = slotRegistrations.find(item => item.options.name === 'conversation.input.left')
const footerSlot = slotRegistrations.find(item => item.options.name === 'sidebar.footer.action')
check('注册右栏内容槽位（key=类型 id）', bodySlot !== undefined && bodySlot.options.key === 'dsh-debate-workbench/tab', JSON.stringify(bodySlot?.options))
check('注册右栏标题槽位', titleSlot !== undefined && titleSlot.options.key === 'dsh-debate-workbench/tab', JSON.stringify(titleSlot?.options))
const dockSlot = slotRegistrations.find(item => item.options.name === 'conversation.composer.dock')
check('注册对话输入框旁的讨论入口', dockSlot !== undefined && dockSlot.options.id === 'dsh-debate-workbench/discuss', JSON.stringify(dockSlot?.options))
check('不再占用输入框/侧栏底部槽位', launcherSlot === undefined && footerSlot === undefined, JSON.stringify(slotRegistrations.map(item => item.options.name)))

const guideEntries = Array.isArray(tabTypes[0]?.guide) ? tabTypes[0].guide : []
check('「开始」页贡献一个引导入口', guideEntries.length === 1, JSON.stringify(tabTypes[0]?.guide))
check('引导入口标题/描述正确', guideEntries[0]?.title?.() === '辩论工作台' && String(guideEntries[0]?.description?.() ?? '').includes('论证树'), JSON.stringify(guideEntries[0]))
check('引导入口排序为第四项', guideEntries[0]?.order === 40, guideEntries[0]?.order)
check('引导入口绑定 commandId', guideEntries[0]?.commandId === 'debate-workbench.open', guideEntries[0]?.commandId)

check('注册了全局快捷键', shortcuts.length === 1 && shortcuts[0].id === 'debate-workbench.open', JSON.stringify(shortcuts.map(item => item.id)))
check('快捷键有默认按键（Ctrl+Shift+D）', shortcuts[0]?.defaults?.['desktop:windows']?.code === 'KeyD', JSON.stringify(shortcuts[0]?.defaults?.['desktop:windows']))
check('Web 平台不声明受限组合（web:linux）', shortcuts[0]?.defaults?.['web:linux'] === undefined, JSON.stringify(Object.keys(shortcuts[0]?.defaults ?? {})))
const resolution = shortcuts[0]?.resolve?.()
check('快捷键 resolve 返回 handled', resolution?.status === 'handled', JSON.stringify(resolution?.status))
const beforeShortcut = openTabs.length
resolution?.run?.()
check('快捷键实际打开右栏', openTabs.length === beforeShortcut + 1 && openTabs[openTabs.length - 1] === 'debate-workbench', JSON.stringify(openTabs))
check('ui.open=true 时自动打开右栏', openTabs.includes('debate-workbench'), JSON.stringify(openTabs))

reactStub.reset()
const bodyElement = bodySlot.component({})
check('tab 内容组件可渲染', bodyElement !== null && bodyElement.$$element === true, typeof bodyElement)
reactStub.reset()
const titleElement = titleSlot.component({})
check('tab 标题组件可渲染', titleElement !== null && titleElement.$$element === true, typeof titleElement)
/* 启动按钮已并入「开始」页引导入口，不再单独渲染 */

/* ---------------- 1b. 快捷键注册失败时的隔离 ---------------- */
const isolatedSlots = []
const isolatedTypes = []
const throwingCtx = {
  effect(callback) {
    try {
      const disposer = callback()
      return typeof disposer === 'function' ? disposer : () => {}
    } catch (error) {
      return () => {}
    }
  },
  slots: {
    inject(key, callback) {
      try {
        const disposer = callback()
        return typeof disposer === 'function' ? disposer : () => {}
      } catch (error) {
        return () => {}
      }
    },
    register(options, component) {
      isolatedSlots.push({ options, component })
      return () => {}
    },
  },
  sidebarRightTabs: {
    register(definition) {
      isolatedTypes.push(definition)
      return () => {}
    },
  },
  sidebarRight: { openTab() {} },
  shortcuts: {
    register() {
      throw new Error('Unsupported Web shortcut: test')
    },
  },
}
moduleExports.apply(throwingCtx)
check('快捷键失败不影响页面类型注册', isolatedTypes.length === 1, JSON.stringify(isolatedTypes.map(item => item.kind)))
check(
  '快捷键失败不影响内容槽位注册',
  isolatedSlots.some(item => item.options.name === 'sidebar.right.pane.tab' && item.options.key === 'dsh-debate-workbench/tab'),
  JSON.stringify(isolatedSlots.map(item => item.options.name)),
)

/* ---------------- 2. ui.js 界面模块 ---------------- */
console.log('\nui.js 界面模块')
globalThis.document = createDocumentStub()
globalThis.window = { innerHeight: 900, innerWidth: 1400, addEventListener() {}, removeEventListener() {}, confirm: () => false }
const uiModule = await import(new URL('../assets/ui.js', import.meta.url))
check('导出 createWorkbench', typeof uiModule.createWorkbench === 'function')

const api = {
  state: () =>
    Promise.resolve({
      snapshot: { active: true, ui: { open: true } },
      project: { title: '人工智能的发展利大于弊', side: 'pro' },
      analysis: {
        readiness: 77,
        blocking: 1,
        scores: { logic: 90, evidence: 55, persuasiveness: 80, innovation: 70, counterResilience: 75, overall: 74 },
        gaps: [],
        notes: {},
        suggestions: [],
        stats: {},
      },
    }),
  bundle: () =>
    Promise.resolve({
      bundle: {
        project: { title: '人工智能的发展利大于弊', side: 'pro' },
        argumentTree: {
          nodes: [
            { id: 'node-1', type: 'stance', position: { x: 0, y: 0 }, data: { label: '我方立场' } },
            { id: 'node-2', type: 'claim', position: { x: 260, y: 0 }, data: { label: '提升效率', description: '机制链' } },
          ],
          edges: [{ id: 'edge-1', source: 'node-1', target: 'node-2' }],
        },
        evidenceCards: [{ id: 'card-1', title: '数据卡', type: 'data', credibility: 4, originalText: '产出提升 12%', source: '示例' }],
        nodeEvidenceLinks: [{ id: 'link-1', nodeId: 'node-2', evidenceCardId: 'card-1' }],
        attackDefenseBoxes: [
          { id: 'box-1', nodeId: 'node-2', attacks: [{ id: 'a-1', type: 'factual', content: '只是相关性', threatLevel: 4, defenseStrategy: '补机制' }] },
        ],
      },
    }),
  tool: () => Promise.resolve({ ok: true, result: {} }),
  ui: () => Promise.resolve({ ok: true }),
  projects: () => Promise.resolve({ projects: [], activeProjectId: null }),
  projectAction: () => Promise.resolve({ ok: true }),
  library: () => Promise.resolve({ cards: [] }),
  reviews: () => Promise.resolve({ reviews: [] }),
  review: () => Promise.resolve({ review: null }),
  reviewAudio: () => Promise.resolve({ ok: true }),
  reviewJob: () => Promise.resolve({ job: { id: 'job-1', state: 'running' } }),
  reviewJobStatus: () => Promise.resolve({ job: { id: 'job-1', state: 'done', message: '完成' } }),
  reviewMarkdownUrl: () => '/debate-api/review-md?id=x',
  exportUrl: () => '/debate-api/export',
}
const stub = createReactStub()
const Workbench = uiModule.createWorkbench({ React: stub.React, api })
check('返回组件函数', typeof Workbench === 'function')

stub.reset()
const element = Workbench({})
check('渲染出工作台根节点', element !== null && element.$$element === true, typeof element)
check('根节点带 dwb-shell', element?.props?.className === 'dwb-shell', element?.props?.className)
const children = Array.isArray(element?.props?.children) ? element.props.children : [element?.props?.children]
const topBar = children.find(child => child?.props?.className === 'dwb-top')
check('顶部工具栏存在', topBar !== undefined, JSON.stringify(children.map(child => child?.props?.className)))
const topChildrenRaw = Array.isArray(topBar?.props?.children) ? topBar.props.children : [topBar?.props?.children]
const topChildren = topChildrenRaw.flatMap(child => (Array.isArray(child) ? child : [child])).filter(Boolean)
const segTabs = topChildren
  .filter(child => child?.props?.className === 'dwb-seg')
  .flatMap(seg => (Array.isArray(seg.props.children) ? seg.props.children : [seg.props.children]))
  .filter(Boolean)
check('顶部含 8 个标签按钮（分段控件内）', segTabs.filter(child => child?.props?.className === 'dwb-tabbtn').length === 8, JSON.stringify(segTabs.map(child => child?.props?.className)))
// 切到「复盘」标签页：应能渲染出复盘面板（效果钩子在替身里不执行，只验证渲染路径）
const reviewTabButton = segTabs.find(child => child?.props?.className === 'dwb-tabbtn' && child?.props?.children === '复盘')
check('存在「复盘」标签按钮', reviewTabButton !== undefined, JSON.stringify(segTabs.map(child => child?.props?.children)))
reviewTabButton?.props?.onClick?.()
stub.reset()
const reviewElement = Workbench({})
const reviewText = JSON.stringify(reviewElement)
check('复盘标签页可渲染', reviewText.includes('复盘记录') && reviewText.includes('新建复盘') && reviewText.includes('创建复盘') && reviewText.includes('还没有复盘'), reviewText.slice(0, 300))

/* ---- 长文本节点 / 连线几何（直接测 ui.js 导出的纯函数） ---- */
const internals = uiModule.__internals
const longSentence = '证据：某研究机构 2024 年对 1200 家制造业企业做了三年追踪，发现引入自动化产线后单位工时产出平均提升 12%，但同时一线操作岗位减少 9%，技能结构向设备维护与数据分析迁移。'
// 拼到足够长（> 1000 字），确保在 420px 宽下超过 6 行
const longLabel = longSentence.repeat(10)
const longMetrics = internals.nodeMetrics({ type: 'evidence', data: { label: longLabel, details: { wrap: 'true' } } })
check('换行上限已放宽（> 6 行）', internals.NODE_MAX_LINES > 6, String(internals.NODE_MAX_LINES))
check('长文本节点按多行渲染', longMetrics.lines.length > 6, String(longMetrics.lines.length))
check('长文本节点高度随行数增长', longMetrics.height > 100, String(longMetrics.height))
check('长文本节点没有被截断', longMetrics.truncated === false, String(longMetrics.truncated))
check('节点最大宽度已放宽到 >= 420', internals.NODE_MAX_W >= 420, String(internals.NODE_MAX_W))
const compactMetrics = internals.nodeMetrics({ type: 'evidence', data: { label: longLabel, details: { wrap: 'true', compact: 'true' } } })
check('精简显示限制在 6 行并标记截断', compactMetrics.lines.length === internals.NODE_COMPACT_LINES && compactMetrics.truncated === true, JSON.stringify({ lines: compactMetrics.lines.length, truncated: compactMetrics.truncated }))
check('超长单行标题会被标记截断', internals.nodeMetrics({ type: 'evidence', data: { label: longLabel } }).truncated === true, '')

const edgeNode = { type: 'claim', data: { label: 'x' } }
const rightward = internals.edgeGeometry(edgeNode, edgeNode, { x: 0, y: 0 }, { x: 520, y: 0 })
const leftward = internals.edgeGeometry(edgeNode, edgeNode, { x: 520, y: 0 }, { x: 0, y: 0 })
const vertical = internals.edgeGeometry(edgeNode, edgeNode, { x: 0, y: 0 }, { x: 0, y: 300 })
const numbers = value => (String(value).match(/-?\d+(\.\d+)?/g) ?? []).map(Number)
check('连线路径无 NaN', [rightward, leftward, vertical].every(item => numbers(item.d).every(Number.isFinite) && numbers(item.d).length >= 8), JSON.stringify([rightward.d, vertical.d]))
check('右向连线从源右边缘出发', Math.abs(rightward.sx - internals.nodeMetrics(edgeNode).width) < 0.01, JSON.stringify({ sx: rightward.sx, vy: rightward.sy }))
check('左向连线改用左边缘（自适应）', leftward.sx === 520 && leftward.ex === internals.nodeMetrics(edgeNode).width, JSON.stringify({ sx: leftward.sx, ex: leftward.ex, width: internals.nodeMetrics(edgeNode).width }))
check('上下叠放改为纵向走线', Math.abs(vertical.sx - vertical.ex) < 60 && vertical.ey > vertical.sy, JSON.stringify({ sx: vertical.sx, sy: vertical.sy, ex: vertical.ex, ey: vertical.ey }))
check('连线中点在两端之间', rightward.mx > rightward.sx && rightward.mx < rightward.ex, JSON.stringify({ mx: rightward.mx }))

const foot = children.find(child => child?.props?.className === 'dwb-foot')
check('底部状态栏存在', foot !== undefined)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exitCode = 1
