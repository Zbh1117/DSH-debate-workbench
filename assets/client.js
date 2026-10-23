/**
 * 辩论备赛工作台 —— DSH 客户端半边（原生右栏集成）。
 *
 * 集成方式与 DSH 核心插件（Plan / Deliverables）完全同构：
 *   1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` 注册右栏页面类型，
 *      并往右侧栏「开始」页贡献一个引导入口（第四项）；
 *   2. `sidebar.right.pane.tab` / `.title` 槽位（key = 类型 id）放内容与标题；
 *   3. `ctx.shortcuts.register(...)` 注册全局快捷键打开它；
 *   4. `ctx.sidebarRight.openTab(kind)` 实际打开，或由 openNonce 变化自动打开。
 *
 * 界面本体在 `/debate-workbench/ui.js`，由本加载器按内容哈希动态 import（Blob URL），
 * 因此界面迭代不需要重启 App。
 *
 * 失败处理：全程 try/catch + 错误边界 + 上报 `/debate-api/client-report`。
 */
;(function () {
  var PACKAGE_ID = 'dsh-debate-workbench'
  var TAB_ID = PACKAGE_ID + '/tab'
  var TAB_KIND = 'debate-workbench'
  var SHORTCUT_ID = 'debate-workbench.open'
  var API_BASE = '/debate-api'
  var UI_BASE = '/debate-workbench'
  var POLL_MS = 2000
  var VERSION_MS = 3000

  /** 把客户端错误送回宿主（桌面壳没有 DevTools 时唯一的可见通道）。 */
  function report(stage, message) {
    try {
      fetch(API_BASE + '/client-report', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ stage: String(stage), message: String(message) }),
      }).catch(function () {})
    } catch (error) {
      /* 上报失败绝不能成为新的故障源 */
    }
  }

  try {
    var loader = window.__ModuleLoader__
    if (loader === undefined || typeof loader.load !== 'function') {
      report('boot', '__ModuleLoader__ 不可用')
      return
    }

    loader.load({
      id: PACKAGE_ID,
      factory: function (require) {
        report('factory', '客户端插件 factory 开始执行')
        var React = require('react')
        var h = React.createElement

        // 引导入口图标：种子模块里有合适的 artwork 就用，取不到则留空（宿主有默认占位图形）。
        var guideIcon
        try {
          var primitives = require('@deepseek-ai/dsh-client-ui-primitives')
          guideIcon =
            primitives.IconBranchOutlineArtwork ??
            primitives.IconChecklistOutlineArtwork ??
            primitives.IconChatLinesOutlineArtwork ??
            undefined
        } catch (error) {
          guideIcon = undefined
        }

        function request(path, options) {
          return fetch(API_BASE + path, {
            headers: { 'content-type': 'application/json' },
            cache: 'no-store',
            ...options,
          }).then(function (response) {
            return response
              .json()
              .catch(function () {
                return { ok: false, error: 'HTTP ' + response.status }
              })
              .then(function (payload) {
                if (!response.ok || payload.ok === false) throw new Error(payload.error || 'HTTP ' + response.status)
                return payload
              })
          })
        }

        var api = {
          ui: function (patch) {
            return request('/ui', { method: 'POST', body: JSON.stringify(patch || {}) })
          },
          state: function () {
            return request('/state')
          },
          bundle: function () {
            return request('/bundle')
          },
          tool: function (name, args) {
            return request('/tool', { method: 'POST', body: JSON.stringify({ name, args: args || {} }) })
          },
          report: report,
          projects: function () {
            return request('/projects')
          },
          projectAction: function (body) {
            return request('/project', { method: 'POST', body: JSON.stringify(body || {}) })
          },
          tasks: function (project) {
            return request('/tasks' + (typeof project === 'string' && project !== '' ? '?project=' + encodeURIComponent(project) : ''))
          },
          taskAction: function (body) {
            return request('/task', { method: 'POST', body: JSON.stringify(body || {}) })
          },
          library: function () {
            return request('/library')
          },
          libraryAction: function (body) {
            return request('/library', { method: 'POST', body: JSON.stringify(body || {}) })
          },
          exportUrl: function () {
            return API_BASE + '/export'
          },
        }

        /* ---------- 界面模块热加载 ---------- */
        var uiComponent = null
        var uiVersion = null
        var uiLoading = null

        function loadUi(version) {
          if (uiLoading !== null && uiVersion === version) return uiLoading
          uiVersion = version
          var url = UI_BASE + '/ui.js?v=' + encodeURIComponent(version || '0')
          uiLoading = fetch(url, { cache: 'no-store' })
            .then(function (response) {
              if (!response.ok) throw new Error('加载 ui.js 失败：HTTP ' + response.status)
              return response.text()
            })
            .then(function (text) {
              var blobUrl = URL.createObjectURL(new Blob([text], { type: 'text/javascript' }))
              return import(blobUrl).then(
                function (mod) {
                  URL.revokeObjectURL(blobUrl)
                  if (typeof mod.createWorkbench !== 'function') throw new Error('ui.js 没有导出 createWorkbench')
                  uiComponent = mod.createWorkbench({ React: React, api: api })
                  report('ui-loaded', 'version=' + version + ' bytes=' + text.length)
                  return uiComponent
                },
                function (error) {
                  URL.revokeObjectURL(blobUrl)
                  uiLoading = null
                  throw error
                },
              )
            })
          return uiLoading
        }

        /* ---------- 错误边界 ---------- */
        function makeBoundary() {
          function Boundary(props) {
            React.Component.call(this, props)
            this.state = { failed: false, message: '' }
          }
          Boundary.prototype = Object.create(React.Component.prototype)
          Boundary.prototype.constructor = Boundary
          Boundary.getDerivedStateFromError = function (error) {
            report('render', (error && error.message) || String(error))
            return { failed: true, message: (error && error.message) || String(error) }
          }
          Boundary.prototype.componentDidCatch = function (error) {
            report('render-catch', (error && error.stack) || String(error))
          }
          Boundary.prototype.render = function () {
            if (this.state.failed) {
              return h(
                'div',
                { style: { padding: 16, color: 'var(--dsw-alias-state-error-primary, #ff8497)', font: '12.5px/1.6 system-ui, sans-serif' } },
                '辩论工作台界面出错：' + this.state.message,
              )
            }
            return this.props.children
          }
          return Boundary
        }

        var Boundary = makeBoundary()

        /* ---------- 右栏 tab 内容 ---------- */
        function WorkbenchTabBody() {
          var [status, setStatus] = React.useState({ phase: 'loading', error: null })

          React.useEffect(function () {
            var stopped = false
            var sync = function () {
              fetch(UI_BASE + '/version.json', { cache: 'no-store' })
                .then(function (response) {
                  return response.json()
                })
                .then(function (payload) {
                  if (stopped || !payload || payload.ok !== true) return
                  var version = payload.version || '0'
                  if (uiComponent !== null && uiVersion === version) {
                    setStatus({ phase: 'ready', error: null })
                    return
                  }
                  loadUi(version)
                    .then(function () {
                      if (!stopped) setStatus({ phase: 'ready', error: null })
                    })
                    .catch(function (error) {
                      if (stopped) return
                      var message = (error && error.message) || String(error)
                      report('ui-failed', message)
                      setStatus({ phase: 'failed', error: message })
                    })
                })
                .catch(function () {})
            }
            sync()
            var handle = setInterval(sync, VERSION_MS)
            return function () {
              stopped = true
              clearInterval(handle)
            }
          }, [])

          if (status.phase === 'ready' && uiComponent !== null) {
            return h(Boundary, null, h(uiComponent, { api: api }))
          }
          if (status.phase === 'failed') {
            return h(
              'div',
              { style: { padding: 16, color: 'var(--dsw-alias-state-error-primary, #ff8497)', font: '12.5px/1.6 system-ui, sans-serif' } },
              '界面加载失败：' + status.error,
            )
          }
          return h(
            'div',
            { style: { padding: 16, color: 'var(--dsw-alias-label-secondary, #99a1bd)', font: '12.5px/1.6 system-ui, sans-serif' } },
            '辩论工作台加载中…',
          )
        }

        /* ---------- 右栏 tab 标题 ---------- */
        function WorkbenchTabTitle() {
          return h('span', null, '辩论工作台')
        }

        /* ---------- 插件装配 ---------- */
        function apply(ctx) {
          var disposers = []
          var push = function (disposer) {
            if (typeof disposer === 'function') disposers.push(disposer)
          }

          var openNow = function (source) {
            try {
              ctx.sidebarRight.openTab(TAB_KIND)
              report('tab-opened', 'kind=' + TAB_KIND + ' via=' + source)
            } catch (error) {
              report('tab-open-failed', source + ': ' + ((error && error.message) || String(error)))
            }
          }

          try {
            // 1) 注册右栏页面类型 + 「开始」页引导入口（第四项）
            var guideEntry = {
              id: PACKAGE_ID + '/entry',
              commandId: SHORTCUT_ID,
              order: 40,
              title: function () {
                return '辩论工作台'
              },
              description: function () {
                return '论证树 · 证据卡 · 攻防 · 五维评估'
              },
            }
            if (guideIcon !== undefined) guideEntry.icon = guideIcon
            push(
              ctx.effect(function () {
                return ctx.sidebarRightTabs.register({
                  id: TAB_ID,
                  kind: TAB_KIND,
                  title: function () {
                    return '辩论工作台'
                  },
                  guide: [guideEntry],
                })
              }, 'debate-workbench: tab type'),
            )

            // 2) 内容与标题槽位（key = 类型 id）—— 放在快捷键之前，
            //    这样即使快捷键注册失败也不会连带丢掉界面。
            push(
              ctx.slots.inject('sidebar.right.pane.tab', function () {
                return ctx.slots.register({ name: 'sidebar.right.pane.tab', key: TAB_ID }, WorkbenchTabBody)
              }),
            )
            push(
              ctx.slots.inject('sidebar.right.pane.tab.title', function () {
                return ctx.slots.register({ name: 'sidebar.right.pane.tab.title', key: TAB_ID }, WorkbenchTabTitle)
              }),
            )

            // 3) 全局快捷键（与引导入口的按键提示共用 commandId）。
            //    注意 Web 平台的组合键有白名单限制（web:linux 尤其严格），
            //    这里只声明各平台允许的组合，且失败不影响插件其余部分。
            try {
              var binding = { code: 'KeyD', modifiers: ['primary', 'shift'] }
              push(
                ctx.effect(function () {
                  return ctx.shortcuts.register({
                    id: SHORTCUT_ID,
                    label: function () {
                      return '打开辩论工作台'
                    },
                    aliases: ['debate', 'debate workbench', '辩论工作台', '论证树'],
                    defaults: {
                      'desktop:macos': binding,
                      'desktop:windows': binding,
                      'desktop:linux': binding,
                      'web:macos': binding,
                      'web:windows': binding,
                    },
                    regions: ['page', 'editable', 'terminal'],
                    modals: [],
                    resolve: function () {
                      return {
                        status: 'handled',
                        run: function () {
                          openNow('shortcut')
                        },
                      }
                    },
                  })
                }, 'debate-workbench: shortcut'),
              )
            } catch (error) {
              report('shortcut-failed', (error && error.message) || String(error))
            }

            // 4) 跟随工具状态打开右栏页面：判定用 openNonce（每次 action=open 自增），
            //    所以标签页被手动关掉后再 open 一次也能重开；只有成功才推进 lastNonce。
            var lastNonce = -1
            var lastFailureAt = 0
            var reportFailure = function (stage, message) {
              var nowMs = Date.now()
              if (nowMs - lastFailureAt < 30000) return
              lastFailureAt = nowMs
              report(stage, message)
            }
            var poll = function () {
              api
                .state()
                .then(function (payload) {
                  var snapshot = payload.snapshot || { active: false }
                  var ui = snapshot.ui || {}
                  var nonce = typeof ui.openNonce === 'number' ? ui.openNonce : 0
                  var shouldOpen = snapshot.active === true && ui.open === true
                  if (!shouldOpen) {
                    lastNonce = nonce
                    return
                  }
                  if (nonce === lastNonce) return
                  try {
                    ctx.sidebarRight.openTab(TAB_KIND)
                    lastNonce = nonce
                    report('tab-opened', 'kind=' + TAB_KIND + ' nonce=' + nonce)
                  } catch (error) {
                    reportFailure('tab-open-failed', (error && error.message) || String(error))
                  }
                })
                .catch(function (problem) {
                  reportFailure('state-failed', (problem && problem.message) || String(problem))
                })
            }
            poll()
            var timer = setInterval(poll, POLL_MS)
            push(function () {
              clearInterval(timer)
            })

            report('registered', 'tab kind=' + TAB_KIND + ' id=' + TAB_ID + ' shortcut=' + SHORTCUT_ID)
          } catch (error) {
            report('apply-failed', (error && error.stack) || String(error))
          }
          return function () {
            for (var i = disposers.length - 1; i >= 0; i -= 1) {
              try {
                disposers[i]()
              } catch (error) {
                /* 卸载阶段忽略 */
              }
            }
          }
        }

        return {
          name: 'debate-workbench-client',
          inject: ['slots', 'sidebarRight', 'sidebarRightTabs', 'shortcuts'],
          apply: apply,
        }
      },
    })
  } catch (error) {
    report('boot-failed', (error && error.message) || String(error))
    console.warn('[debate-workbench] 客户端加载器初始化失败', error)
  }
})()
