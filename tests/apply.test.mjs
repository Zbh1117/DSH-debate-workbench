/**
 * dsh-debate-workbench 启动自测：验证 `apply(ctx)` 在假宿主下的装配，
 * 以及 webServer / systemPrompt 缺失时的降级行为。
 *
 * 运行：node tests/apply.test.mjs
 */
const { apply, inject, name } = await import(new URL('../lib/index.js', import.meta.url))

let failures = 0
function check(label, condition, detail) {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures += 1
  console.log(`  FAIL ${label}${detail === undefined ? '' : `\n       ${String(detail).slice(0, 600)}`}`)
}

function makeCtx(options = {}) {
  const tools = new Map()
  const routes = []
  const sections = []
  const ctx = {
    tools: { register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) } },
    webServer: options.webServer,
    systemPrompt: options.systemPrompt ?? { section(section) { sections.push(section); return () => {} } },
    effect(callback) {
      const dispose = callback(() => {})
      return typeof dispose === 'function' ? dispose : () => {}
    },
    on() {
      return () => {}
    },
    inject(deps, callback) {
      const inner = { ...ctx }
      for (const dep of deps) if (inner[dep] === undefined) return undefined
      callback(inner)
      return undefined
    },
    logger: { info() {}, warn() {}, error() {} },
  }
  return { ctx, tools, routes, sections }
}

const fakeWebServer = { host: '127.0.0.1', port: 19387, register() { return () => {} } }

console.log(`plugin = ${name}，inject = ${JSON.stringify(inject)}`)
check('导出 name / inject / apply', typeof name === 'string' && Array.isArray(inject) && typeof apply === 'function')

const normal = makeCtx({ webServer: fakeWebServer })
apply(normal.ctx)
check('注册 15 个工具', normal.tools.size === 15, [...normal.tools.keys()].join(','))
check('注入系统提示段', normal.sections.length === 1 && normal.sections[0].name === 'debate-workbench:workflow', JSON.stringify(normal.sections.map(item => item.name)))
check('系统提示包含关键工具名', normal.sections[0].text.includes('debate_project') && normal.sections[0].text.includes('debate_workbench'))

const headless = makeCtx({ webServer: undefined })
let headlessThrew = false
try {
  apply(headless.ctx)
} catch (error) {
  headlessThrew = true
  console.log(`       ${String(error)}`)
}
check('headless 下不抛错', headlessThrew === false)
check('headless 下工具仍注册', headless.tools.size === 15)

const noPrompt = makeCtx({ webServer: fakeWebServer, systemPrompt: undefined })
let promptThrew = false
try {
  apply(noPrompt.ctx)
} catch {
  promptThrew = true
}
check('systemPrompt 缺失时降级', promptThrew === false && noPrompt.tools.size === 15)

const broken = makeCtx({
  webServer: {
    host: '127.0.0.1',
    port: 1,
    register() {
      throw new Error('route collision')
    },
  },
})
let brokenThrew = false
try {
  apply(broken.ctx)
} catch {
  brokenThrew = true
}
check('API 挂载失败不影响加载', brokenThrew === false && broken.tools.size === 15)

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`)
if (failures > 0) process.exitCode = 1
