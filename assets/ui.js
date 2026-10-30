/**
 * 辩论备赛工作台 —— 界面模块（热插拔，运行在 DSH 原生右栏标签页里）。
 *
 * 由 `assets/client.js` 通过 Blob URL 动态 import，导出 `createWorkbench({ React, api })`
 * 返回一个 React 组件。依赖全部由加载器注入（DSH 客户端只开放有限种子模块）。
 *
 * 与上一版的区别：**不再自己实现分栏 / 浮层 / 拖拽比例**。
 * 面板由宿主原生右栏承载（列宽拖拽、标签、全屏都是宿主的），
 * 本组件只负责「论证工作台」内容本身，铺满标签页即可。
 *
 * 交互约定：
 *   - 单击节点选中；双击节点定位到标题输入框
 *   - 拖动节点移动位置（按视图坐标换算）
 *   - 「连线」模式下再点另一个节点即建立父子连线
 *   - 工具栏可新建任意类型节点；侧栏可加子论点、删除子树
 */
const NODE_TYPES = [
  { type: 'stance', label: '立场', color: '#FFD60A', glyph: 'flag', tone: 'argument' },
  { type: 'claim', label: '论点', color: '#0A84FF', glyph: 'dot', tone: 'argument' },
  { type: 'premise', label: '前提', color: '#FF9F0A', glyph: 'diamond', tone: 'argument' },
  { type: 'compare', label: '比较', color: '#FF453A', glyph: 'arrows', tone: 'argument' },
  { type: 'attitude', label: '价值', color: '#BF5AF2', glyph: 'ring', tone: 'argument' },
  { type: 'evidence', label: '证据', color: '#2FD4C8', glyph: 'doc', tone: 'support' },
  { type: 'status', label: '现状', color: '#30D158', glyph: 'bar', tone: 'support' },
  { type: 'crowd', label: '主体', color: '#5AC8FA', glyph: 'crowd', tone: 'support' },
  { type: 'image', label: '图片', color: '#FF8DA1', glyph: 'image', tone: 'support' },
]
const ATTACK_TYPES = [
  { value: 'factual', label: '事实' },
  { value: 'logical', label: '逻辑' },
  { value: 'value', label: '价值' },
]
const TABS = [
  { value: 'tree', label: '论证树' },
  { value: 'topic', label: '拆题' },
  { value: 'evidence', label: '证据卡' },
  { value: 'attack', label: '攻防' },
  { value: 'evaluate', label: '评估' },
  { value: 'manuscript', label: '稿件' },
  { value: 'projects', label: '项目' },
  { value: 'review', label: '复盘' },
]
const NODE_W = 190
const NODE_H = 58
/** 节点尺寸策略：单行时宽度随文字增长；用户可开启「多行换行」，由行数决定高度。 */
const NODE_MIN_W = 150
const NODE_MAX_W = 460
const NODE_WRAP_W = 420
const NODE_LINE_HEIGHT = 16
/** 换行模式默认最多行数（证据/长文本要能整段展示）。 */
const NODE_MAX_LINES = 28
/** 节点开了「精简显示」时的行数上限。 */
const NODE_COMPACT_LINES = 6
const NODE_LABEL_FONT = '12px system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'

let measureContext = null
const measureCache = new Map()
/** 用离屏 canvas 量文字像素宽度（Node 测试环境没有 canvas 时退化为估算）。 */
function measureTextWidth(text, font) {
  const key = font + '\u0000' + text
  const cached = measureCache.get(key)
  if (cached !== undefined) return cached
  let width
  if (measureContext === null && typeof document !== 'undefined' && typeof document.createElement === 'function') {
    try {
      const canvas = document.createElement('canvas')
      measureContext = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : undefined
    } catch (error) {
      measureContext = undefined
    }
  }
  if (measureContext === null || measureContext === undefined) {
    // 估算：CJK 按 12px、ASCII 按 7px
    width = 0
    for (const char of String(text)) width += /[\u2E80-\u9FFF\uF900-\uFAFF\uFF00-\uFFEF]/.test(char) ? 12 : 7
  } else {
    measureContext.font = font
    width = measureContext.measureText(String(text)).width
  }
  if (measureCache.size > 4000) measureCache.clear()
  measureCache.set(key, width)
  return width
}

/** 是否开启「多行换行」（存在 details.wrap 里，兼容 app 的字符串字典）。 */
function isWrapEnabled(node) {
  const value = node?.data?.details?.wrap
  return value === true || value === 'true' || value === '1' || value === 'on'
}

/** 是否开启「精简显示」（details.compact，超长文本只显示 6 行）。 */
function isCompactNode(node) {
  const value = node?.data?.details?.compact
  return value === true || value === 'true' || value === '1' || value === 'on'
}

/** 按像素宽度逐字换行（CJK 友好；保留显式换行符）。 */
function wrapLines(text, maxWidth) {
  const source = String(text ?? '')
  if (source === '') return ['']
  const lines = []
  let current = ''
  for (const char of source) {
    if (char === '\n') {
      lines.push(current)
      current = ''
      continue
    }
    const next = current + char
    if (current !== '' && measureTextWidth(next, NODE_LABEL_FONT) > maxWidth) {
      lines.push(current)
      current = char === ' ' ? '' : char
    } else {
      current = next
    }
  }
  if (current !== '') lines.push(current)
  return lines.length === 0 ? [''] : lines
}

/**
 * 节点实际尺寸与行内容。
 * 返回 { width, height, lines, wrapped }：
 *  - 单行模式：宽度随文字自适应（150–300），超出以「…」收尾，高度固定；
 *  - 换行模式：宽度取舒适值，行数决定高度（最多 6 行）。
 */
function nodeMetrics(node) {
  const label = String(node?.data?.label ?? '')
  const labelWidth = measureTextWidth(label, NODE_LABEL_FONT)
  if (!isWrapEnabled(node)) {
    const width = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(labelWidth) + 42))
    return { width, height: NODE_H, lines: [fitLabel(label, width - 34)], wrapped: false, truncated: measureTextWidth(label, NODE_LABEL_FONT) > width - 34 }
  }
  const naturalWidth = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, Math.ceil(labelWidth) + 42))
  const width = naturalWidth <= NODE_WRAP_W ? naturalWidth : NODE_WRAP_W
  const contentWidth = width - 34
  const limit = isCompactNode(node) ? NODE_COMPACT_LINES : NODE_MAX_LINES
  let lines = wrapLines(label, contentWidth)
  const truncated = lines.length > limit
  if (truncated) {
    lines = lines.slice(0, limit)
    lines[limit - 1] = fitLabel(String(lines[limit - 1]) + '…', contentWidth)
  }
  const height = Math.max(NODE_H, 34 + lines.length * NODE_LINE_HEIGHT + 10)
  return { width, height, lines, wrapped: true, truncated }
}

/**
 * 连线几何：按两个节点的相对位置自适应选边，返回三次贝塞尔路径与端点/中点。
 *  - 横向分离足够大：源右 → 目标左（或反向）
 *  - 否则纵向：源下 → 目标上（或反向）
 *
 * @param {any} from 源节点（取尺寸）
 * @param {any} to 目标节点
 * @param {{x:number,y:number}} fromPos 源节点坐标（拖动时用实时坐标）
 * @param {{x:number,y:number}} toPos 目标节点坐标
 * @returns {{d:string,sx:number,sy:number,ex:number,ey:number,mx:number,my:number}}
 */
function edgeGeometry(from, to, fromPos, toPos) {
  const fromMetrics = nodeMetrics(from)
  const toMetrics = nodeMetrics(to)
  const fromLeft = Number(fromPos.x) || 0
  const fromTop = Number(fromPos.y) || 0
  const toLeft = Number(toPos.x) || 0
  const toTop = Number(toPos.y) || 0
  const fromCx = fromLeft + fromMetrics.width / 2
  const fromCy = fromTop + fromMetrics.height / 2
  const toCx = toLeft + toMetrics.width / 2
  const toCy = toTop + toMetrics.height / 2
  const gapX = Math.abs(toCx - fromCx) - (fromMetrics.width + toMetrics.width) / 2
  const gapY = Math.abs(toCy - fromCy) - (fromMetrics.height + toMetrics.height) / 2

  if (gapX >= 8 || gapY < 8) {
    // 横向走线
    const rightward = toCx >= fromCx
    const sx = rightward ? fromLeft + fromMetrics.width : fromLeft
    const ex = rightward ? toLeft : toLeft + toMetrics.width
    const sy = fromCy
    const ey = toCy
    const span = Math.max(40, Math.abs(ex - sx) * 0.45)
    const c1 = rightward ? sx + span : sx - span
    const c2 = rightward ? ex - span : ex + span
    return {
      d: `M ${sx} ${sy} C ${c1} ${sy}, ${c2} ${ey}, ${ex} ${ey}`,
      sx,
      sy,
      ex,
      ey,
      mx: (sx + ex) / 2,
      my: (sy + ey) / 2,
    }
  }

  // 纵向走线（节点上下叠放）
  const downward = toCy >= fromCy
  const sx = fromCx
  const ex = toCx
  const sy = downward ? fromTop + fromMetrics.height : fromTop
  const ey = downward ? toTop : toTop + toMetrics.height
  const span = Math.max(36, Math.abs(ey - sy) * 0.45)
  const c1 = downward ? sy + span : sy - span
  const c2 = downward ? ey - span : ey + span
  return {
    d: `M ${sx} ${sy} C ${sx} ${c1}, ${ex} ${c2}, ${ex} ${ey}`,
    sx,
    sy,
    ex,
    ey,
    mx: (sx + ex) / 2,
    my: (sy + ey) / 2,
  }
}

/** 在给定像素宽度内把标题裁成「…」结尾。 */
function fitLabel(label, maxWidth) {
  const source = String(label ?? '')
  if (measureTextWidth(source, NODE_LABEL_FONT) <= maxWidth) return source
  let cut = source
  while (cut.length > 1 && measureTextWidth(cut + '…', NODE_LABEL_FONT) > maxWidth) cut = cut.slice(0, -1)
  return cut + '…'
}

/**
 * 注入并**保持同步**样式表（主题跟随 DSH 的 --dsw-* 变量）。
 *
 * 注意：不能「已存在就 return」——界面模块是热插拔的，旧版本注入过的 <style>
 * 会让新版本新增的类（如 .dwb-float）完全没有样式，元素退化成普通块、看不出来。
 * 所以每次都用最新 CSS 覆盖同一个 style 标签。
 */
function ensureStyles(doc) {
  const CSS = `
  .dwb-shell { display:flex; flex-direction:column; height:100%; width:100%; min-height:0;
    overflow:hidden; contain:layout paint; isolation:isolate;
    background: var(--dsw-alias-bg-base, #14161f); color: var(--dsw-alias-label-primary, #e8ebf5);
    font: 12.5px/1.6 system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .dwb-top { display:flex; align-items:center; gap:6px; flex-wrap:wrap; padding:7px 10px; flex:0 0 auto;
    border-bottom:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.18));
    background: var(--dsw-alias-bg-layer-1, #1c1f2b); }
  .dwb-title { font-weight:650; font-size:12.5px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:220px; }
  .dwb-pill { font-size:11px; padding:1px 7px; border-radius:999px;
    border:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.25)); color: var(--dsw-alias-label-secondary, #99a1bd); }
  .dwb-tabbtn { font:inherit; font-size:12px; padding:4px 9px; border-radius:7px; cursor:pointer;
    border:1px solid transparent; background:transparent; color:var(--dsw-alias-label-secondary, #99a1bd); }
  .dwb-tabbtn:hover { background:rgba(124,140,255,0.12); color:var(--dsw-alias-label-primary,#e8ebf5); }
  .dwb-tabbtn[data-active="1"] { background:rgba(124,140,255,0.2); border-color:rgba(124,140,255,0.4); color:#fff; font-weight:600; }
  .dwb-spacer { flex:1 1 auto; }
  .dwb-btn { transition: background 120ms ease-out, border-color 120ms ease-out, transform 120ms ease-out; }
  .dwb-btn:active { transform: translateY(0.5px); }
  .dwb-btn[data-primary="1"] { background: linear-gradient(180deg, rgba(124,140,255,0.95), rgba(104,118,255,0.9));
    border-color: rgba(124,140,255,0.7); color:#fff; box-shadow: 0 2px 8px rgba(90,110,255,0.35); }
  .dwb-btn[data-primary="1"]:hover { filter: brightness(1.06); }
  .dwb-btn { font:inherit; font-size:12px; padding:4px 9px; border-radius:8px; cursor:pointer;
    border:1px solid var(--dsw-alias-border-l2, rgba(150,165,220,0.3));
    background: var(--dsw-alias-bg-layer-1, #1c1f2b); color: var(--dsw-alias-label-primary, #e8ebf5); }
  .dwb-btn:hover { border-color: var(--dsw-alias-brand-primary, #7c8cff); }
  .dwb-btn[data-primary="1"] { background: linear-gradient(135deg, rgba(90,110,240,0.9), rgba(140,80,240,0.9)); color:#fff; border-color:rgba(124,140,255,0.5); font-weight:600; }
  .dwb-btn[data-danger="1"] { border-color:rgba(255,107,129,0.45); color:#ff8497; background:rgba(255,107,129,0.1); }
  .dwb-btn:disabled { opacity:.45; cursor:not-allowed; }
  .dwb-body { flex:1 1 auto; min-height:0; display:flex; }
  .dwb-canvas { flex:1 1 auto; min-width:0; position:relative; overflow:hidden;
    background: radial-gradient(700px 320px at 12% -8%, rgba(90,110,255,0.1), transparent 60%), var(--dsw-alias-bg-base,#14161f); }
  .dwb-side { flex:0 0 300px; border-left:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.18));
    padding:10px; overflow:auto; background: var(--dsw-alias-bg-layer-1, #1c1f2b); }
  .dwb-pane { flex:1 1 auto; min-width:0; padding:10px; overflow:auto; }
  .dwb-field { display:flex; flex-direction:column; gap:3px; margin-bottom:7px; }
  .dwb-field > span { font-size:11px; color:var(--dsw-alias-label-secondary,#99a1bd); }
  .dwb-field input:focus, .dwb-field textarea:focus, .dwb-field select:focus,
  .dwb-input:focus, .dwb-input:focus-visible { outline:none; border-color: var(--dsw-alias-brand-primary, #7c8cff);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--dsw-alias-brand-primary, #7c8cff) 30%, transparent); }
  .dwb-field input, .dwb-field textarea, .dwb-field select, .dwb-input {
    font:inherit; font-size:12px; padding:4px 7px; border-radius:6px;
    border:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.25));
    background: var(--dsw-alias-bg-layer-2, #161926); color:inherit; }
  .dwb-field textarea { min-height:58px; resize:vertical; }
  .dwb-row { display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .dwb-list { display:flex; flex-direction:column; gap:6px; }
  .dwb-item { border:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.2)); border-radius:8px; padding:7px 9px; }
  .dwb-item b { font-weight:600; }
  .dwb-muted { color:var(--dsw-alias-label-secondary,#99a1bd); font-size:11.5px; }
  .dwb-chip { display:inline-flex; align-items:center; gap:4px; font-size:11px; padding:1px 7px;
    border-radius:999px; background:rgba(124,140,255,0.14); color:var(--dsw-alias-label-secondary,#b9c1dd); }
  .dwb-gap { padding:5px 8px; border-radius:7px; font-size:11.5px; border:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.2)); margin-bottom:4px; }
  .dwb-gap[data-level="error"] { border-color:rgba(255,107,129,0.4); background:rgba(255,107,129,0.08); }
  .dwb-gap[data-level="warn"] { border-color:rgba(242,193,78,0.35); background:rgba(242,193,78,0.07); }
  .dwb-bar { height:6px; border-radius:999px; background:rgba(124,140,255,0.16); overflow:hidden; }
  .dwb-bar > i { display:block; height:100%; background:linear-gradient(90deg,#7c8cff,#b07cff); }
  .dwb-dim { display:grid; grid-template-columns:60px 1fr 30px; gap:8px; align-items:center; font-size:11.5px; color:var(--dsw-alias-label-secondary,#99a1bd); margin-bottom:5px; }
.dwb-toolbar { flex:0 0 auto; display:flex; gap:6px; flex-wrap:wrap; align-items:center; padding:7px 10px;
    border-bottom:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.15));
    background: color-mix(in srgb, var(--dsw-alias-bg-layer-1, #1c1f2b) 90%, transparent);
    backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); }
    .dwb-canvas { display:flex; flex-direction:column; }
  .dwb-canvas-area { flex:1 1 auto; min-height:0; position:relative; }
  .dwb-body.dwb-narrow { flex-direction:column; }
  .dwb-body.dwb-narrow .dwb-side { flex:0 0 auto; max-height:48%; border-left:none;
    border-top:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.2)); }
  .dwb-float { position:absolute; top:8px; right:8px; width:332px; max-height:calc(100% - 16px);
    display:flex; flex-direction:column; z-index:5; overflow:hidden; border-radius:14px;
    background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #1c1f2b) 82%, transparent);
    backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%);
    border:1px solid var(--dsw-alias-border-l2, rgba(150,165,220,0.3));
    box-shadow: 0 18px 48px rgba(0,0,0,0.5), inset 0 1px 0 rgba(255,255,255,0.06); }
  .dwb-float[data-narrow="1"] { left:8px; right:8px; width:auto; top:auto; bottom:8px; max-height:44%; }
  .dwb-float[data-collapsed="1"] { max-height:none; width:auto; }
  .dwb-float[data-collapsed="1"] .dwb-float-body { display:none; }
  .dwb-float-head button { flex:0 0 auto; }
  .dwb-float-head { display:flex; align-items:center; justify-content:space-between; gap:6px;
    padding:7px 10px; border-bottom:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.2));
    font-size:11.5px; font-weight:600; letter-spacing:0.02em;
    color: var(--dsw-alias-label-primary,#e8ebf5);
    background: linear-gradient(to bottom, rgba(255,255,255,0.05), transparent); }
  .dwb-float .dwb-side { flex:1 1 auto; min-height:0; overflow:auto; max-height:none;
    border:none; background:transparent; padding:8px; }
.dwb-zoom { position:absolute; left:10px; bottom:10px; display:flex; gap:3px; align-items:center; z-index:4;
    padding:4px; border-radius:11px;
    background: color-mix(in srgb, var(--dsw-alias-bg-overlay, #1c1f2b) 78%, transparent);
    backdrop-filter: blur(14px) saturate(130%); -webkit-backdrop-filter: blur(14px) saturate(130%);
    border:1px solid var(--dsw-alias-border-l2, rgba(150,165,220,0.28));
    box-shadow: 0 6px 20px rgba(0,0,0,0.35); }
    .dwb-zoom .dwb-muted { padding:0 4px; }
  .dwb-node { cursor: pointer; }
  .dwb-node-inner { transition: transform 140ms var(--ds-ease-out, ease-out), filter 140ms ease-out; }
  .dwb-node:hover .dwb-node-inner { transform: translateY(-1px); filter: drop-shadow(0 6px 12px rgba(0,0,0,0.45)); }
  .dwb-node[data-hover="1"] .dwb-node-inner { transform: translateY(-1px); filter: drop-shadow(0 6px 14px rgba(0,0,0,0.5)); }
  .dwb-node[data-selected="1"] .dwb-node-inner { filter: drop-shadow(0 0 10px rgba(124,140,255,0.35)); }
  .dwb-node-title { fill: var(--dsw-alias-label-primary, #e8ebf5); }
  .dwb-node-type { letter-spacing: 0.04em; font-weight: 600; }
  .dwb-node-badge { font-size: 10px; }
  .dwb-node rect { cursor:pointer; }
  .dwb-seg { display:inline-flex; align-items:center; gap:2px; padding:2px; border-radius:10px;
    background: var(--dsw-alias-bg-layer-2, #161926);
    border:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.2)); }
  .dwb-seg .dwb-tabbtn { padding:4px 10px; border-radius:8px; }
  .dwb-seg .dwb-tabbtn[data-active="1"] { background: var(--dsw-alias-bg-base, #14161f);
    border-color: var(--dsw-alias-border-l2, rgba(150,165,220,0.3));
    box-shadow: 0 1px 3px rgba(0,0,0,0.4); color: var(--dsw-alias-label-primary, #e8ebf5); }
  .dwb-btn[data-quiet="1"] { background:transparent; border-color:transparent; color: var(--dsw-alias-label-secondary,#99a1bd); }
  .dwb-btn[data-quiet="1"]:hover { background: rgba(124,140,255,0.12); border-color: var(--dsw-alias-border-l1, rgba(150,165,220,0.2)); color: var(--dsw-alias-label-primary,#e8ebf5); }
  .dwb-float-glass { backdrop-filter: blur(16px) saturate(140%); -webkit-backdrop-filter: blur(16px) saturate(140%); }
  .dwb-node text { pointer-events:none; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
  .dwb-edge-hit { cursor:pointer; }
  .dwb-edge:hover .dwb-edge-line { stroke: rgba(124,140,255,0.85); stroke-width: 2.1; }
  .dwb-edge-line { transition: stroke 150ms ease-out, stroke-width 150ms ease-out; }
  .dwb-edge-selected { animation: dwb-edge-dash 900ms linear infinite; }
  @keyframes dwb-edge-dash { to { stroke-dashoffset: -24; } }
  .dwb-edge-delete { cursor:pointer; }
  .dwb-edge-delete:hover circle { fill: rgba(255,107,129,0.9); }
  .dwb-port { fill: rgba(20,22,31,0.96); stroke: var(--dsw-alias-brand-primary, #7c8cff); stroke-width: 1.6; cursor: crosshair; }
  .dwb-port:hover { fill: var(--dsw-alias-brand-primary, #7c8cff); }
  .dwb-rubber { pointer-events:none; }
  .dwb-foot { flex:0 0 auto; padding:4px 10px; border-top:1px solid var(--dsw-alias-border-l1, rgba(150,165,220,0.15));
    color:var(--dsw-alias-label-secondary,#99a1bd); font-size:11px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .dwb-error { color:#ff8497; }
  .dwb-banner { padding:4px 10px; font-size:11.5px; background:rgba(124,140,255,0.16); color:#b9c1ff; }
  .dwb-pre { white-space:pre-wrap; word-break:break-word; font-size:11.5px; line-height:1.7; margin:0;
    background:var(--dsw-alias-bg-layer-2,#161926); border:1px solid var(--dsw-alias-border-l1,rgba(150,165,220,0.2));
    border-radius:8px; padding:10px; overflow:auto; }
  `
  let style = doc.getElementById('dwb-style')
  if (style === null) {
    style = doc.createElement('style')
    style.id = 'dwb-style'
    doc.head.appendChild(style)
  }
  if (style.textContent !== CSS) style.textContent = CSS
}

/** #RRGGBB + 透明度 → rgba()，用于类型色的浅底/描边。 */
function hexToRgba(hex, alpha) {
  const value = String(hex ?? '').replace('#', '')
  if (value.length !== 6) return 'rgba(124,140,255,' + alpha + ')'
  const r = parseInt(value.slice(0, 2), 16)
  const g = parseInt(value.slice(2, 4), 16)
  const b = parseInt(value.slice(4, 6), 16)
  return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + alpha + ')'
}

/** 读 DSH 主题变量（拿不到时用兜底色）。 */
function themeColor(name, fallback) {
  try {
    if (typeof document !== 'undefined' && typeof getComputedStyle === 'function') {
      const value = getComputedStyle(document.documentElement).getPropertyValue(name)
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
  } catch (error) {
    /* 取不到就用兜底 */
  }
  return fallback
}

/**
 * 类型造型徽标：形状 + 颜色双编码，色弱也能区分；统一画在一个 12×12 的框里。
 * @returns {Array} SVG 子元素
 */
function renderGlyph(h, kind, color, x, y) {
  const cx = x + 6
  const cy = y + 6
  switch (kind) {
    case 'flag':
      return [
        h('path', { key: 'pole', d: 'M ' + (x + 2) + ' ' + (y + 1) + ' L ' + (x + 2) + ' ' + (y + 11), stroke: color, strokeWidth: 1.4, strokeLinecap: 'round' }),
        h('path', { key: 'flag', d: 'M ' + (x + 2.6) + ' ' + (y + 1.6) + ' L ' + (x + 10.5) + ' ' + (y + 3.8) + ' L ' + (x + 2.6) + ' ' + (y + 6.2) + ' Z', fill: color }),
      ]
    case 'diamond':
      return [h('path', { key: 'd', d: 'M ' + cx + ' ' + (y + 1) + ' L ' + (x + 11) + ' ' + cy + ' L ' + cx + ' ' + (y + 11) + ' L ' + (x + 1) + ' ' + cy + ' Z', fill: color })]
    case 'ring':
      return [h('circle', { key: 'r', cx, cy, r: 4, fill: 'none', stroke: color, strokeWidth: 1.8 })]
    case 'arrows':
      return [
        h('path', { key: 'l', d: 'M ' + (x + 1) + ' ' + cy + ' L ' + (x + 5) + ' ' + (cy - 3.5) + ' L ' + (x + 5) + ' ' + (cy + 3.5) + ' Z', fill: color }),
        h('path', { key: 'r', d: 'M ' + (x + 11) + ' ' + cy + ' L ' + (x + 7) + ' ' + (cy - 3.5) + ' L ' + (x + 7) + ' ' + (cy + 3.5) + ' Z', fill: color }),
      ]
    case 'doc':
      return [
        h('rect', { key: 'b', x: x + 2, y: y + 1, width: 8, height: 10, rx: 1.6, fill: 'none', stroke: color, strokeWidth: 1.3 }),
        h('path', { key: 'l1', d: 'M ' + (x + 4) + ' ' + (y + 4.5) + ' L ' + (x + 8) + ' ' + (y + 4.5), stroke: color, strokeWidth: 1.1 }),
        h('path', { key: 'l2', d: 'M ' + (x + 4) + ' ' + (y + 7) + ' L ' + (x + 8) + ' ' + (y + 7), stroke: color, strokeWidth: 1.1 }),
      ]
    case 'bar':
      return [h('rect', { key: 'b', x: x + 1, y: cy - 1.4, width: 10, height: 2.8, rx: 1.4, fill: color })]
    case 'crowd':
      return [
        h('circle', { key: 'c1', cx: x + 4.2, cy: cy - 1, r: 2.5, fill: color }),
        h('circle', { key: 'c2', cx: x + 8, cy: cy + 1.4, r: 2.1, fill: hexToRgba(color.startsWith('#') ? color : '#7c8cff', 0.6) }),
      ]
    case 'image':
      return [
        h('rect', { key: 'b', x: x + 1.5, y: y + 2, width: 9, height: 8, rx: 1.5, fill: 'none', stroke: color, strokeWidth: 1.3 }),
        h('circle', { key: 's', cx: x + 4.4, cy: y + 4.8, r: 1.1, fill: color }),
        h('path', { key: 'm', d: 'M ' + (x + 2.5) + ' ' + (y + 9) + ' L ' + (x + 5.4) + ' ' + (y + 6.2) + ' L ' + (x + 7.4) + ' ' + (y + 8) + ' L ' + (x + 8.6) + ' ' + (y + 6.6) + ' L ' + (x + 10) + ' ' + (y + 9) + ' Z', fill: color }),
      ]
    default:
      return [h('circle', { key: 'dot', cx, cy, r: 3.4, fill: color })]
  }
}

/**
 * 纯逻辑导出：节点尺寸 / 连线几何。生产环境不依赖它，只用于离线测试与调试。
 * （界面模块是热插拔的，额外导出不会影响加载流程。）
 */
export const __internals = {
  nodeMetrics,
  edgeGeometry,
  wrapLines,
  isWrapEnabled,
  isCompactNode,
  NODE_MAX_LINES,
  NODE_COMPACT_LINES,
  NODE_MAX_W,
  NODE_WRAP_W,
}

export function createWorkbench({ React, api }) {
  const h = React.createElement
  ensureStyles(document)

  const typeConfig = type => NODE_TYPES.find(item => item.type === type) ?? NODE_TYPES[4]

  return function Workbench() {
    const [tab, setTab] = React.useState('tree')
    const [state, setState] = React.useState(null)
    const [bundle, setBundle] = React.useState(null)
    const [analysis, setAnalysis] = React.useState(null)
    const [selectedId, setSelectedId] = React.useState(null)
    const [busy, setBusy] = React.useState(false)
    const [error, setError] = React.useState(null)
    const [notice, setNotice] = React.useState(null)
    const [syncedAt, setSyncedAt] = React.useState(null)
    const [linkSource, setLinkSource] = React.useState(null)
    const [selectedEdgeId, setSelectedEdgeId] = React.useState(null)
    // 从节点端口拖拽连线时的临时状态：{ sourceId, fromRight, anchor, pointer }
    const [linkDrag, setLinkDrag] = React.useState(null)
    const [hoveredId, setHoveredId] = React.useState(null)
    // 多题目：所有题目摘要 / 当前题待办 / 公共证据库
    const [projectsDetail, setProjectsDetail] = React.useState([])
    const [tasks, setTasks] = React.useState([])
    const [libraryCards, setLibraryCards] = React.useState([])
    const [evidenceMode, setEvidenceMode] = React.useState('mine')
    // 拆题页 + AI 候选（模型只出候选，人工确认后才写入）
    const [aiStatus, setAiStatus] = React.useState(null)
    const [aiCandidate, setAiCandidate] = React.useState(null)
    const [aiHint, setAiHint] = React.useState('')
    const [aiBusy, setAiBusy] = React.useState(false)
    const [reviews, setReviews] = React.useState([])
    const [reviewSelectedId, setReviewSelectedId] = React.useState(null)
    const [reviewDetail, setReviewDetail] = React.useState(null)
    const [reviewTranscriptEdit, setReviewTranscriptEdit] = React.useState('')
    const [reviewJob, setReviewJob] = React.useState(null)
    const [reviewPerspective, setReviewPerspective] = React.useState('white-paper')
    const [reviewMode, setReviewMode] = React.useState('votes')
    const [reviewSubtitle, setReviewSubtitle] = React.useState('')
    const [reviewDraft, setReviewDraft] = React.useState({ title: '', date: '', opponent: '', ourSide: 'pro', audioFile: null })
    const brandColor = themeColor('--dsw-alias-brand-primary', '#7c8cff')
    /**
     * 界面模块是热更新的，而 Host 插件代码要重启 App 才换。
     * 如果宿主还是旧版（没有 /projects 等接口），这里要把话说清楚，
     * 否则下拉/新建题目/公共库会静默失败，看起来像「点了没反应」。
     */
    const hostReady = typeof api.projects === 'function' && typeof api.projectAction === 'function' && typeof api.library === 'function'
    const hostHint = '宿主端还没有加载多题目接口：请**完全退出 DSH 再重新启动**（界面已更新，但宿主代码需要重启才能换）。'
    const [drag, setDrag] = React.useState(null)
    const dragRef = React.useRef(null)
    dragRef.current = drag
    const [search, setSearch] = React.useState('')
    const [preview, setPreview] = React.useState('')
    const [questions, setQuestions] = React.useState([])
    const [draft, setDraft] = React.useState({
      label: '',
      description: '',
      nodeType: '',
      newNodeType: 'claim',
      newNodeLabel: '',
      evidenceTitle: '',
      evidenceText: '',
      evidenceSource: '',
      evidenceType: 'data',
      evidenceCred: '3',
      attackType: 'factual',
      attackContent: '',
      attackThreat: 3,
      attackDefense: '',
      manuscriptKind: 'opening',
      projectTopic: '',
      projectSide: 'pro',
      projectFormat: 'chinese',
      taskTitle: '',
      taskDeadline: '',
    })
    const svgRef = React.useRef(null)
    const titleRef = React.useRef(null)
    const rootRef = React.useRef(null)
    const [narrow, setNarrow] = React.useState(false)
    const [editorCollapsed, setEditorCollapsed] = React.useState(false)

    // 右栏默认宽度不大：窄的时候把「侧栏」移到画布下方，否则两列会把画布挤到 0 宽。
    React.useEffect(() => {
      const measure = () => {
        const node = rootRef.current
        const width = node === null ? window.innerWidth : node.getBoundingClientRect().width
        setNarrow(width > 0 && width < 620)
      }
      measure()
      let observer
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(measure)
        if (rootRef.current !== null) observer.observe(rootRef.current)
      }
      window.addEventListener('resize', measure)
      return () => {
        window.removeEventListener('resize', measure)
        if (observer !== undefined) observer.disconnect()
      }
    }, [])

    const bodyClass = () => (narrow ? 'dwb-body dwb-narrow' : 'dwb-body')

    /* ---------- 数据同步 ---------- */
    const reload = React.useCallback(async () => {
      try {
        const [statePayload, bundlePayload] = await Promise.all([api.state(), api.bundle()])
        setState(statePayload)
        setAnalysis(statePayload.analysis ?? null)
        setBundle(bundlePayload.bundle ?? null)
        setError(null)
        setSyncedAt(new Date().toLocaleTimeString())
      } catch (problem) {
        setError(String(problem.message ?? problem))
      }
    }, [])

    /** 拉取题目摘要与当前题待办（项目页 / 顶栏切换器用）。 */
    const refreshProjects = React.useCallback(async () => {
      if (!hostReady) return
      try {
        const payload = await api.projects()
        setProjectsDetail(Array.isArray(payload.projects) ? payload.projects : [])
        const activeId = payload.activeProjectId ?? undefined
        const tasksPayload = await api.tasks(activeId)
        setTasks(Array.isArray(tasksPayload.tasks) ? tasksPayload.tasks : [])
      } catch (problem) {
        setError(String(problem?.message ?? problem))
      }
    }, [])

    const switchToProject = React.useCallback(
      async id => {
        if (typeof id !== 'string' || id === '') return
        if (!hostReady) {
          setError('宿主端尚未加载多题目接口：请完全退出 DSH 后重新启动')
          return
        }
        if (id === (state?.activeProjectId ?? null)) return
        setBusy(true)
        try {
          await api.projectAction({ action: 'switch', project: id })
          setSelectedId(null)
          setNotice('已切换题目')
          await reload()
          await refreshProjects()
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy(false)
        }
      },
      [state],
    )

    /* ---------- 复盘音频：任意浏览器可解码音频（m4a/mp3/ogg…）→ 16kHz 单声道 PCM16 WAV ---------- */
    const readFileHead = async file => {
      try {
        return new Uint8Array(await file.slice(0, 64).arrayBuffer())
      } catch (error) {
        return new Uint8Array()
      }
    }
    const isCanonicalWavFile = async file => {
      const head = await readFileHead(file)
      if (head.length < 44) return false
      const ascii = index => String.fromCharCode(head[index], head[index + 1], head[index + 2], head[index + 3])
      if (ascii(0) !== 'RIFF' || ascii(8) !== 'WAVE') return false
      const view = new DataView(head.buffer, head.byteOffset, head.byteLength)
      let offset = 12
      while (offset + 8 <= head.length) {
        const id = ascii(offset)
        const size = view.getUint32(offset + 4, true)
        const body = offset + 8
        if (id === 'fmt ' && body + 16 <= head.length) {
          const code = view.getUint16(body, true)
          const channels = view.getUint16(body + 2, true)
          const sampleRate = view.getUint32(body + 4, true)
          const bits = view.getUint16(body + 14, true)
          return code === 1 && channels === 1 && sampleRate === 16000 && bits === 16
        }
        offset = body + size + (size % 2)
      }
      return false
    }
    const encodePcm16Wav = samples => {
      const dataBytes = samples.length * 2
      const buffer = new ArrayBuffer(44 + dataBytes)
      const view = new DataView(buffer)
      const writeText = (offset, text) => {
        for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index))
      }
      writeText(0, 'RIFF')
      view.setUint32(4, 36 + dataBytes, true)
      writeText(8, 'WAVE')
      writeText(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, 16000, true)
      view.setUint32(28, 32000, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      writeText(36, 'data')
      view.setUint32(40, dataBytes, true)
      for (let index = 0; index < samples.length; index += 1) {
        const value = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(44 + index * 2, value < 0 ? value * 0x8000 : value * 0x7fff, true)
      }
      return buffer
    }
    const convertAudioToWav16k = async file => {
      const AudioContextCtor = typeof window === 'undefined' ? undefined : window.AudioContext ?? window.webkitAudioContext
      const OfflineContextCtor = typeof window === 'undefined' ? undefined : window.OfflineAudioContext ?? window.webkitOfflineAudioContext
      if (typeof AudioContextCtor !== 'function' || typeof OfflineContextCtor !== 'function') {
        throw new Error('当前环境不支持浏览器音频转换：请提供 16kHz 单声道 PCM16 WAV，或改用字幕/文本导入')
      }
      const buffer = await file.arrayBuffer()
      // MP4/M4A：先读 moov/mvhd 里的时长，超限直接拒绝（避免完整解码时内存爆掉）。
      const probeMp4Duration = (view, bytes) => {
        const readType = offset => String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7])
        const total = bytes.byteLength
        let offset = 0
        while (offset + 8 <= total) {
          let size = view.getUint32(offset, false)
          if (size === 1 && offset + 16 <= total) {
            const high = view.getUint32(offset + 8, false)
            const low = view.getUint32(offset + 12, false)
            size = high * 4294967296 + low
          } else if (size === 0) {
            size = total - offset
          }
          if (size < 8) return undefined
          if (readType(offset) === 'moov') {
            let inner = offset + 8
            const end = Math.min(total, offset + size)
            while (inner + 8 <= end) {
              const innerSize = view.getUint32(inner, false)
              if (innerSize < 8) return undefined
              if (readType(inner) === 'mvhd') {
                const version = view.getUint8(inner + 8)
                if (version === 0) {
                  const timescale = view.getUint32(inner + 20, false)
                  const duration = view.getUint32(inner + 24, false)
                  return timescale > 0 ? duration / timescale : undefined
                }
                const timescale = view.getUint32(inner + 28, false)
                const high = view.getUint32(inner + 32, false)
                const low = view.getUint32(inner + 36, false)
                return timescale > 0 ? (high * 4294967296 + low) / timescale : undefined
              }
              inner += innerSize
            }
            return undefined
          }
          offset += size
        }
        return undefined
      }
      const probe = probeMp4Duration(new DataView(buffer), new Uint8Array(buffer))
      if (probe !== undefined && probe > 25 * 60) {
        throw new Error('音频约 ' + Math.round(probe / 60) + ' 分钟，超过界面转换建议上限（25 分钟）：请先转成 16kHz WAV 并分段上传，或使用字幕导入')
      }
      if (file.size > 80 * 1024 * 1024) {
        throw new Error('压缩音频超过 80 MB，界面转换可能内存不足：请先转成 16kHz WAV 并分段')
      }
      const context = new AudioContextCtor()
      let decoded
      try {
        decoded = await context.decodeAudioData(buffer)
      } catch (error) {
        throw new Error('浏览器无法解码这个音频（可能需要先转成 WAV）：' + String((error && error.message) || error))
      } finally {
        try {
          context.close()
        } catch (error) {
          /* ignore */
        }
      }
      if (decoded.duration > 30 * 60) {
        throw new Error('音频约 ' + Math.round(decoded.duration / 60) + ' 分钟，超过界面转换上限 30 分钟：请先转成 16kHz WAV 并分段，或分段导入')
      }
      const frames = Math.max(1, Math.floor(decoded.duration * 16000))
      const offline = new OfflineContextCtor(1, frames, 16000)
      const source = offline.createBufferSource()
      source.buffer = decoded
      source.connect(offline.destination)
      source.start(0)
      const rendered = await offline.startRendering()
      const samples = rendered.getChannelData(0)
      const name = String(file.name || 'audio').replace(/\.[^.]+$/, '') + '.16k.wav'
      return new File([encodePcm16Wav(samples)], name, { type: 'audio/wav' })
    }

    /* ---------- 复盘数据 ---------- */
    /** 拉取复盘列表 + 选中项详情。 */
    const reloadReviews = React.useCallback(
      async preferredId => {
        if (!hostReady) return
        try {
          const listed = await api.reviews(state?.activeProjectId ?? undefined)
          const list = Array.isArray(listed.reviews) ? listed.reviews : []
          setReviews(list)
          const wanted = typeof preferredId === 'string' && preferredId !== '' ? preferredId : reviewSelectedId
          const nextId = list.some(item => item.id === wanted) ? wanted : list[0]?.id
          if (typeof nextId === 'string' && nextId !== '') {
            setReviewSelectedId(nextId)
            setReviewDetail(await api.review(nextId, state?.activeProjectId ?? undefined))
          } else {
            setReviewSelectedId(null)
            setReviewDetail(null)
          }
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      },
      [hostReady, reviewSelectedId, state?.activeProjectId],
    )

    /** 选中一条复盘。 */
    const selectReview = React.useCallback(
      async id => {
        if (typeof id !== 'string' || id === '') return
        setReviewSelectedId(id)
        try {
          setReviewDetail(await api.review(id, state?.activeProjectId ?? undefined))
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      },
      [state?.activeProjectId],
    )

    /** 新建复盘（可选录音 + 字幕/文本）。 */
    const createReview = React.useCallback(async () => {
      const title = reviewDraft.title.trim()
      if (title === '') {
        setError('请先填复盘标题')
        return
      }
      setBusy(true)
      try {
        setError(null)
        const created = await api.tool('debate_review', {
          action: 'create',
          title,
          date: reviewDraft.date.trim() === '' ? undefined : reviewDraft.date.trim(),
          opponent: reviewDraft.opponent.trim(),
          ourSide: reviewDraft.ourSide,
        })
        const reviewId = created?.result?.reviewId
        if (typeof reviewId !== 'string' || reviewId === '') throw new Error('创建复盘没有返回 id')
        const file = reviewDraft.audioFile
        if (file !== null && file !== undefined) {
          const name = String(file.name ?? '')
          const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : 'wav'
          let uploadFile = file
          let uploadExt = ext
          const canonical = await isCanonicalWavFile(file)
          if (!canonical) {
            setNotice('正在把音频转成 16kHz WAV（M4A/MP3 自动转换，长音频需要一点时间）…')
            uploadFile = await convertAudioToWav16k(file)
            uploadExt = 'wav'
          }
          await api.reviewAudio(reviewId, uploadExt, uploadFile, state?.activeProjectId ?? undefined)
        }
        if (reviewSubtitle.trim() !== '') {
          await api.tool('debate_review', { action: 'import_transcript', reviewId, text: reviewSubtitle })
        }
        setReviewDraft(current => ({ ...current, title: '', opponent: '', date: '', audioFile: null }))
        setReviewSubtitle('')
        await reloadReviews(reviewId)
        setNotice('复盘已创建')
      } catch (problem) {
        setError(String(problem?.message ?? problem))
      } finally {
        setBusy(false)
      }
    }, [reviewDraft, reviewSubtitle, reloadReviews, state?.activeProjectId])

    /** 保存人工修订后的转写。 */
    const saveReviewTranscript = React.useCallback(async () => {
      if (reviewDetail?.review?.id === undefined) return
      setBusy(true)
      try {
        await api.tool('debate_review', { action: 'update', reviewId: reviewDetail.review.id, transcriptText: reviewTranscriptEdit })
        await reloadReviews()
        setNotice('转写已保存')
        setError(null)
      } catch (problem) {
        setError(String(problem?.message ?? problem))
      } finally {
        setBusy(false)
      }
    }, [reviewDetail, reviewTranscriptEdit, reloadReviews])

    /** 启动复盘长任务（转写 / 判比赛 / 环节复盘 / 证据候选）。 */
    const startReviewJobAction = React.useCallback(
      async (kind, extra) => {
        if (reviewDetail?.review?.id === undefined) return
        try {
          setError(null)
          const payload = await api.reviewJob({
            kind,
            reviewId: reviewDetail.review.id,
            project: state?.activeProjectId ?? undefined,
            perspective: reviewPerspective,
            mode: reviewMode,
            ...(extra === undefined ? {} : extra),
          })
          setReviewJob(payload.job ?? null)
          setNotice('任务已开始，完成后自动刷新')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      },
      [reviewDetail, reviewPerspective, reviewMode, state?.activeProjectId],
    )

    /** 删除当前复盘。 */
    const deleteReview = React.useCallback(async () => {
      if (reviewDetail?.review?.id === undefined) return
      if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm('删除这条复盘（含录音）？') !== true) return
      try {
        await api.tool('debate_review', { action: 'delete', reviewId: reviewDetail.review.id })
        await reloadReviews('')
        setNotice('复盘已删除')
      } catch (problem) {
        setError(String(problem?.message ?? problem))
      }
    }, [reviewDetail, reloadReviews])

    React.useEffect(() => {
      reload()
      // 轮询只为「模型改完数据后界面跟上」。编辑中不刷新：否则每 2.5 秒一次 setBundle
      // 会把草稿/焦点冲掉，节点切换也会一顿一顿的。
      const tick = () => {
        if (typeof document !== 'undefined' && document.hidden === true) return
        if (dragRef.current !== null) return
        const root = rootRef.current
        const active = typeof document === 'undefined' ? null : document.activeElement
        if (root !== null && active !== null && active !== undefined && root.contains(active)) {
          const tag = String(active.tagName || '').toLowerCase()
          if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        }
        reload()
      }
      const handle = setInterval(tick, 5000)
      return () => clearInterval(handle)
    }, [reload])

    // 打开「项目」页时刷新题目与待办；每轮同步后也刷新，保证就绪度/待办数最新。
    React.useEffect(() => {
      if (tab === 'projects' && hostReady) refreshProjects()
    }, [tab, syncedAt, refreshProjects, hostReady])

    // 拆题页：查询当前模型路由（可用性 / provider / model）
    React.useEffect(() => {
      if (tab !== 'topic') return
      api
        .tool('debate_ai', { action: 'status' })
        .then(payload => setAiStatus(payload.result?.status ?? null))
        .catch(problem => setAiStatus({ available: false, reason: String(problem?.message ?? problem), hint: '' }))
    }, [tab, syncedAt])

    // 公共证据库按需加载
    React.useEffect(() => {
      if (tab !== 'evidence' || evidenceMode !== 'shared') return
      if (!hostReady) return
      api
        .library()
        .then(payload => setLibraryCards(Array.isArray(payload.cards) ? payload.cards : []))
        .catch(problem => setError(String(problem?.message ?? problem)))
    }, [tab, evidenceMode, syncedAt])

    // 复盘页：进入时拉列表与详情
    React.useEffect(() => {
      if (tab !== 'review' || !hostReady) return
      reloadReviews()
    }, [tab, hostReady, state?.activeProjectId])

    // 复盘详情变化时同步转写编辑框
    React.useEffect(() => {
      setReviewTranscriptEdit(reviewDetail?.review?.transcript?.text ?? '')
    }, [reviewDetail])

    // 复盘长任务轮询
    React.useEffect(() => {
      if (reviewJob === null || reviewJob.state !== 'running') return
      const handle = setInterval(async () => {
        try {
          const payload = await api.reviewJobStatus(reviewJob.id)
          const job = payload?.job
          if (job === undefined || job === null) return
          setReviewJob(job)
          if (job.state === 'done') {
            setNotice(job.message)
            reloadReviews()
          } else if (job.state === 'error') {
            setError(job.message)
          }
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        }
      }, 1500)
      return () => clearInterval(handle)
    }, [reviewJob, reloadReviews])

    const run = React.useCallback(
      async (name, args, message) => {
        setBusy(true)
        try {
          await api.tool(name, args)
          await reload()
          if (message !== undefined) setNotice(message)
          setError(null)
        } catch (problem) {
          const message = String(problem.message ?? problem)
          setError(message)
          if (typeof api.report === 'function') api.report('tool-failed', name + ': ' + message)
        } finally {
          setBusy(false)
        }
      },
      [reload],
    )

    const nodes = bundle?.argumentTree?.nodes ?? []
    const edges = bundle?.argumentTree?.edges ?? []
    const cards = bundle?.evidenceCards ?? []
    const links = bundle?.nodeEvidenceLinks ?? []
    const boxes = bundle?.attackDefenseBoxes ?? []
    const selected = nodes.find(node => node.id === selectedId) ?? null
    const selectedLinks = selected === null ? [] : links.filter(link => link.nodeId === selected.id)
    const selectedBox = selected === null ? undefined : boxes.find(box => box.nodeId === selected.id)

    /* ---------- 画布几何 ---------- */
    const bounds = (() => {
      if (nodes.length === 0) return { minX: 0, minY: 0, width: 900, height: 520 }
      const xs = nodes.map(node => Number(node.position?.x) || 0)
      const ys = nodes.map(node => Number(node.position?.y) || 0)
      const minX = Math.min(...xs) - 40
      const minY = Math.min(...ys) - 40
      const widths = nodes.map(node => nodeMetrics(node).width)
      const heights = nodes.map(node => nodeMetrics(node).height)
      const maxX = Math.max(...nodes.map((node, index) => xs[index] + widths[index])) + 40
      const maxY = Math.max(...nodes.map((node, index) => ys[index] + heights[index])) + 40
      return { minX, minY, width: Math.max(320, maxX - minX), height: Math.max(200, maxY - minY) }
    })()

    /* ---------- 视图（缩放 / 平移） ---------- */
    const [view, setView] = React.useState({ x: 0, y: 0, k: 1 })
    const [size, setSize] = React.useState({ w: 900, h: 520 })
    const canvasRef = React.useRef(null)

    React.useEffect(() => {
      const measure = () => {
        const node = canvasRef.current
        if (node === null) return
        const rect = node.getBoundingClientRect()
        setSize({ w: Math.max(200, Math.round(rect.width)), h: Math.max(160, Math.round(rect.height)) })
      }
      measure()
      let observer
      if (typeof ResizeObserver === 'function') {
        observer = new ResizeObserver(measure)
        if (canvasRef.current !== null) observer.observe(canvasRef.current)
      }
      window.addEventListener('resize', measure)
      return () => {
        window.removeEventListener('resize', measure)
        if (observer !== undefined) observer.disconnect()
      }
    }, [])

    const fitView = React.useCallback(() => {
      const width = size.w
      const height = size.h
      const scale = Math.min((width - 56) / bounds.width, (height - 56) / bounds.height)
      const k = Number.isFinite(scale) && scale > 0 ? Math.min(2, Math.max(0.12, scale)) : 1
      setView({
        x: (width - bounds.width * k) / 2 - bounds.minX * k,
        y: (height - bounds.height * k) / 2 - bounds.minY * k,
        k,
      })
    }, [size.w, size.h, bounds.minX, bounds.minY, bounds.width, bounds.height])

    React.useEffect(() => {
      fitView()
    }, [bundle?.project?.id, size.w, size.h])

    /** 把某个节点平移进可视区（新加节点后调用，免得「加了但看不见」）。 */
    const ensureVisible = node => {
      const x = Number(node.position?.x) || 0
      const y = Number(node.position?.y) || 0
      const metrics = nodeMetrics(node)
      setView(current => {
        const left = current.x + x * current.k
        const top = current.y + y * current.k
        const right = left + metrics.width * current.k
        const bottom = top + metrics.height * current.k
        const padding = 28
        let dx = 0
        let dy = 0
        if (left < padding) dx = padding - left
        else if (right > size.w - padding) dx = size.w - padding - right
        if (top < padding) dy = padding - top
        else if (bottom > size.h - padding) dy = size.h - padding - bottom
        if (dx === 0 && dy === 0) return current
        return { ...current, x: current.x + dx, y: current.y + dy }
      })
    }

    // 滚轮缩放用原生非被动监听：否则 preventDefault 无效，缩放时外层会跟着滚。
    const zoomRef = React.useRef(null)
    React.useEffect(() => {
      const node = canvasRef.current
      if (node === null) return undefined
      const onWheel = event => {
        event.preventDefault()
        if (zoomRef.current === null) return
        const rect = node.getBoundingClientRect()
        zoomRef.current(Math.exp(-event.deltaY * 0.0015), { x: event.clientX - rect.left, y: event.clientY - rect.top })
      }
      node.addEventListener('wheel', onWheel, { passive: false })
      return () => node.removeEventListener('wheel', onWheel)
    }, [])

    const zoomBy = (factor, anchor) => {
      setView(current => {
        const k = Math.min(3, Math.max(0.08, current.k * factor))
        const ratio = k / current.k
        const cx = anchor === undefined ? size.w / 2 : anchor.x
        const cy = anchor === undefined ? size.h / 2 : anchor.y
        return { k, x: cx - (cx - current.x) * ratio, y: cy - (cy - current.y) * ratio }
      })
    }

    // 供手势回调读取最新视图（避免闭包里的旧 view）。
    const viewRef = React.useRef(view)
    viewRef.current = view
    // 供原生滚轮监听读取最新缩放函数（监听只注册一次，不随重渲染重挂）。
    zoomRef.current = zoomBy

    // 诊断探针：选中节点后确认编辑窗到底有没有出现在可视区域（桌面壳里看不到 DevTools）。
    React.useEffect(() => {
      if (selected === null) return undefined
      const timer = setTimeout(() => {
        try {
          const area = document.querySelector('.dwb-canvas-area')
          const areaRect = area === null ? null : area.getBoundingClientRect()
          const element = document.querySelector('.dwb-float')
          if (element === null) {
            if (typeof api.report === 'function') api.report('float-missing', 'selected=' + selectedId)
            return
          }
          const rect = element.getBoundingClientRect()
          const style = window.getComputedStyle(element)
          if (typeof api.report === 'function') {
            api.report('float-rect', JSON.stringify({
              selected: selectedId,
              count: document.querySelectorAll('.dwb-float').length,
              rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
              area: areaRect === null ? null : { x: Math.round(areaRect.x), y: Math.round(areaRect.y), w: Math.round(areaRect.width), h: Math.round(areaRect.height) },
              display: style.display,
              position: style.position,
              visibility: style.visibility,
              opacity: style.opacity,
              zIndex: style.zIndex,
              viewport: { w: window.innerWidth, h: window.innerHeight },
            }))
          }
        } catch (error) {
          if (typeof api.report === 'function') api.report('float-probe-failed', String(error))
        }
      }, 150)
      return () => clearTimeout(timer)
    }, [selectedId])

    const selectNode = id => {
      setSelectedId(id)
      setSelectedEdgeId(null)
      if (id === null || id === undefined) {
        setNotice(undefined)
        return
      }
      const node = nodes.find(item => item.id === id)
      if (node !== undefined) setNotice('已选中：' + (node.data?.label ?? id))
    }

    // 选中变化时把节点内容种进编辑草稿：输入框完全由草稿驱动，
    // 「类型 + 标题 + 说明」可以一起改，也能清空，不会被节点数据回填覆盖。
    React.useEffect(() => {
      if (selectedId === null) {
        setDraft(current => (current.label === '' && current.description === '' && current.nodeType === '' ? current : { ...current, label: '', description: '', nodeType: '' }))
        return
      }
      const node = nodes.find(item => item.id === selectedId)
      if (node === undefined) return
      setDraft(current => ({ ...current, label: node.data?.label ?? '', description: node.data?.description ?? '', nodeType: node.type }))
      setEditorCollapsed(false)
    }, [selectedId, selected?.type, selected?.data?.label, selected?.data?.description])

    // Esc 关闭编辑窗（在输入框里按 Esc 不生效，避免打断输入）。
    React.useEffect(() => {
      const onKeyDown = event => {
        if (event.key !== 'Escape') return
        if (selectedId === null && selectedEdgeId === null) return
        const target = event.target
        const tag = target !== null && target !== undefined ? String(target.tagName || '').toLowerCase() : ''
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        setSelectedId(null)
        setSelectedEdgeId(null)
        setLinkDrag(null)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [selectedId, selectedEdgeId])

    // Delete / Backspace 删除选中的连线（节点保留）
    React.useEffect(() => {
      if (selectedEdgeId === null) return undefined
      const onKeyDown = event => {
        if (event.key !== 'Delete' && event.key !== 'Backspace') return
        const target = event.target
        const tag = target !== null && target !== undefined ? String(target.tagName || '').toLowerCase() : ''
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        event.preventDefault()
        removeEdge(selectedEdgeId)
      }
      window.addEventListener('keydown', onKeyDown)
      return () => window.removeEventListener('keydown', onKeyDown)
    }, [selectedEdgeId])

    const onNodeClick = node => {
      if (linkSource !== null && linkSource !== node.id) {
        const source = linkSource
        setLinkSource(null)
        run('debate_tree', { action: 'connect', source, target: node.id }, '已连线')
        return
      }
      selectNode(node.id)
    }

    const onNodePointerDown = (event, node) => {
      if (linkSource !== null) return
      event.stopPropagation()
      selectNode(node.id)
      const startX = event.clientX
      const startY = event.clientY
      const originX = Number(node.position?.x) || 0
      const originY = Number(node.position?.y) || 0
      let moved = false
      const move = e => {
        const scale = view.k > 0 ? view.k : 1
        const dx = (e.clientX - startX) / scale
        const dy = (e.clientY - startY) / scale
        // 5px 阈值：手抖不算拖动，否则「点一下换节点」会顺手把节点挪走。
        if (moved !== true && Math.abs(dx) < 5 && Math.abs(dy) < 5) return
        moved = true
        setDrag({ id: node.id, x: Math.round(originX + dx), y: Math.round(originY + dy) })
      }
      const finish = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        setDrag(current => {
          if (current !== null && current.id === node.id && moved) {
            api
              .tool('debate_tree', { action: 'move_node', nodeId: node.id, position: { x: current.x, y: current.y } })
              .then(() => reload())
              .catch(problem => setError(String(problem?.message ?? problem)))
          }
          return null
        })
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }

    const addNode = async () => {
      const label = draft.newNodeLabel.trim()
      if (label === '') {
        setNotice('先填节点标题再添加')
        return
      }
      // 坐标一定有：选中节点时放它的右下方，否则放整棵树最右（宿主也会兜底自动落点）。
      const anchor = selected
      const args = { action: 'add_node', node: { type: draft.newNodeType, label } }
      if (anchor !== null) {
        args.source = anchor.id
        args.position = { x: (Number(anchor.position?.x) || 0) + 320, y: (Number(anchor.position?.y) || 0) + 160 }
      }
      setBusy(true)
      try {
        const payload = await api.tool('debate_tree', args)
        const created = payload.result?.node
        setDraft(current => ({ ...current, newNodeLabel: '' }))
        await reload()
        if (created !== undefined) {
          setSelectedId(created.id)
          ensureVisible(created)
        }
        setNotice(`已添加节点「${label}」${anchor === null ? '' : `（挂在「${anchor.data?.label ?? ''}」下）`}`)
        setError(null)
      } catch (problem) {
        const message = String(problem.message ?? problem)
        setError(message)
        if (typeof api.report === 'function') api.report('tool-failed', 'debate_tree add_node: ' + message)
      } finally {
        setBusy(false)
      }
    }

    /** 「加子论点」：建完立刻选中，方便继续改类型/标题（否则用户找不到新节点）。 */
    const addChildNode = async () => {
      if (selected === null) return
      setBusy(true)
      try {
        const payload = await api.tool('debate_tree', {
          action: 'add_node',
          node: { type: 'claim', label: '新子论点' },
          source: selected.id,
          position: { x: (Number(selected.position?.x) || 0) + 320, y: (Number(selected.position?.y) || 0) + 160 },
        })
        const created = payload.result?.node
        await reload()
        if (created !== undefined) {
          setSelectedId(created.id)
          ensureVisible(created)
        }
        setNotice('已加子论点：直接改类型与标题，再点「保存」')
        setError(null)
      } catch (problem) {
        setError(String(problem.message ?? problem))
      } finally {
        setBusy(false)
      }
    }

    /* ---------- 连线：端口拖拽 / 删除 ---------- */

    /** 屏幕坐标 → 模型坐标（考虑画布偏移与缩放）。 */
    const screenToModel = (clientX, clientY) => {
      const node = canvasRef.current
      const rect = node === null ? { left: 0, top: 0 } : node.getBoundingClientRect()
      const k = view.k > 0 ? view.k : 1
      return { x: (clientX - rect.left - view.x) / k, y: (clientY - rect.top - view.y) / k }
    }

    /**
     * 从节点端口按下开始连线：拖到任意节点的任意位置松手即可建立连线。
     * 右侧端口 = 以本节点为源；左侧端口 = 以本节点为目标（反向连线）。
     */
    const startLinkDrag = (event, node, fromRight) => {
      event.stopPropagation()
      if (event.button !== undefined && event.button !== 0) return
      const metrics = nodeMetrics(node)
      const position = { x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0 }
      const anchor = {
        x: fromRight ? position.x + metrics.width : position.x,
        y: position.y + metrics.height / 2,
      }
      setSelectedId(null)
      setSelectedEdgeId(null)
      setLinkDrag({ sourceId: node.id, fromRight, anchor, pointer: anchor })
      const move = e => {
        const pointer = screenToModel(e.clientX, e.clientY)
        setLinkDrag(current => (current === null ? current : { ...current, pointer }))
      }
      const finish = e => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', finish)
        window.removeEventListener('pointercancel', finish)
        const element = typeof document === 'undefined' ? null : document.elementFromPoint(e.clientX, e.clientY)
        const hit = element !== null && element !== undefined && typeof element.closest === 'function' ? element.closest('[data-node-id]') : null
        const targetId = hit === null ? '' : String(hit.getAttribute('data-node-id') ?? '')
        setLinkDrag(null)
        if (targetId === '' || targetId === node.id) return
        const source = fromRight ? node.id : targetId
        const target = fromRight ? targetId : node.id
        api
          .tool('debate_tree', { action: 'connect', source, target })
          .then(() => {
            setNotice('已连线（可点击连线删除，节点不受影响）')
            setError(null)
            return reload()
          })
          .catch(problem => setError(String(problem?.message ?? problem)))
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', finish)
      window.addEventListener('pointercancel', finish)
    }

    /** 删除一条连线（只删边，不动节点）。 */
    const removeEdge = edgeId => {
      setSelectedEdgeId(null)
      run('debate_tree', { action: 'disconnect', edgeId }, '连线已删除（节点保留）')
    }

    /* ---------- 论证树 ---------- */
    const startPan = event => {
      if (event.button !== 0) return
      const target = event.target
      if (target !== null && typeof target.closest === 'function' && target.closest('[data-node-id], .dwb-float, .dwb-zoom, .dwb-edge, .dwb-port') !== null) return
      const startX = event.clientX
      const startY = event.clientY
      const origin = view
      let moved = false
      const move = e => {
        // SVG 用像素尺寸绘制（1 unit = 1px），平移直接用指针位移。
        const dx = e.clientX - startX
        const dy = e.clientY - startY
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true
        setView({ ...origin, x: origin.x + dx, y: origin.y + dy })
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        if (!moved) return
        // 树被拖出可视区时自动复位，避免「找不到工作区」。
        const current = viewRef.current
        const left = current.x + bounds.minX * current.k
        const right = current.x + (bounds.minX + bounds.width) * current.k
        const top = current.y + bounds.minY * current.k
        const bottom = current.y + (bounds.minY + bounds.height) * current.k
        const outside = right < 0 || left > size.w || bottom < 0 || top > size.h
        if (outside) {
          fitView()
          setNotice('已自动定位回论证树')
        } else {
          setNotice(undefined)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
    }

    const renderTree = () => {
      // 编辑窗默认靠右；若选中的节点在画布右半边，就翻到左侧，避免挡住子树。
      const selectedScreenX =
        selected === null ? 0 : view.x + (Number(selected.position?.x) || 0) * view.k + nodeMetrics(selected).width * view.k
      const floatOnLeft = selected !== null && selectedScreenX > size.w * 0.55
      return h(
        'div',
        { className: 'dwb-body' },
        h(
          'div',
          { className: 'dwb-canvas' },
          h(
            'div',
            { className: 'dwb-toolbar' },
            h(
              'select',
              {
                className: 'dwb-input',
                value: draft.newNodeType,
                onChange: event => setDraft(current => ({ ...current, newNodeType: event.target.value })),
              },
              NODE_TYPES.map(item => h('option', { key: item.type, value: item.type }, item.label)),
            ),
            h('input', {
              className: 'dwb-input',
              style: { width: 132 },
              placeholder: '新节点标题',
              value: draft.newNodeLabel,
              onChange: event => setDraft(current => ({ ...current, newNodeLabel: event.target.value })),
              onKeyDown: event => {
                if (event.key !== 'Enter' || event.isComposing === true) return
                addNode()
              },
            }),
            h('button', { type: 'button', className: 'dwb-btn', 'data-primary': '1', disabled: busy, onClick: addNode },
              selected === null ? '添加节点' : '加为子节点'),
            selected === null || !isWrapEnabled(selected)
              ? null
              : h(
                  'button',
                  {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-quiet': '1',
                    disabled: busy,
                    title: isCompactNode(selected) ? '展开：完整显示这段长文本' : '收起：只显示 6 行',
                    onClick: () =>
                      run(
                        'debate_tree',
                        { action: 'update_node', nodeId: selected.id, patch: { details: { compact: isCompactNode(selected) ? 'false' : 'true' } } },
                        isCompactNode(selected) ? '已展开完整文本' : '已收起为精简显示',
                      ),
                  },
                  isCompactNode(selected) ? '展开全文' : '收起长文',
                ),
            selectedEdgeId === null
              ? null
              : h('button', {
                  type: 'button',
                  className: 'dwb-btn',
                  'data-danger': '1',
                  disabled: busy,
                  onClick: () => removeEdge(selectedEdgeId),
                }, '删除连线'),
            linkSource === null
              ? null
              : h('button', { type: 'button', className: 'dwb-btn', 'data-danger': '1', onClick: () => setLinkSource(null) }, '取消连线'),
          ),
          h(
            'div',
            {
              className: 'dwb-canvas-area',
              ref: canvasRef,
              onPointerDown: startPan,
              onClick: event => {
                const target = event.target
                const closest = selector =>
                  target !== null && typeof target.closest === 'function' ? target.closest(selector) : null
                // 浮窗、缩放条、工具栏内部的点击不算「点空白」，否则会立刻取消选中。
                if (closest('[data-node-id]') !== null) return
                if (closest('.dwb-float, .dwb-zoom, .dwb-toolbar') !== null) return
                selectNode(null)
                setSelectedEdgeId(null)
                if (linkSource !== null) setLinkSource(null)
              },
              onDoubleClick: event => {
                const target = event.target
                const closest = selector =>
                  target !== null && typeof target.closest === 'function' ? target.closest(selector) : null
                if (closest('.dwb-float, .dwb-zoom, .dwb-toolbar') !== null) return
                if (closest('[data-node-id]') !== null) return
                fitView()
                setNotice('已重新定位论证树')
              },
              onWheel: event => {
                // React 的 wheel 是被动监听，这里只拦冒泡；真正的缩放走 canvasRef 上的原生监听。
                event.stopPropagation()
              },
              style: {
                cursor: 'grab',
                backgroundColor: 'var(--dsw-alias-bg-base, #14161f)',
                backgroundImage:
                  'radial-gradient(circle, rgba(148,163,220,0.17) 1px, transparent 1.5px), radial-gradient(760px 440px at 14% -12%, rgba(96,116,255,0.10), transparent 62%)',
                backgroundSize: `${Math.max(10, 24 * view.k)}px ${Math.max(10, 24 * view.k)}px, 100% 100%`,
                backgroundPosition: `${view.x}px ${view.y}px, 0 0`,
                backgroundRepeat: 'repeat, no-repeat',
              },
            },
            nodes.length === 0
              ? h('div', { className: 'dwb-muted', style: { padding: 18 } }, '论证树是空的：先添加一个「立场」节点，再往下展开论点。')
              : h(
                  'svg',
                  {
                    ref: svgRef,
                    viewBox: `0 0 ${size.w} ${size.h}`,
                    width: size.w,
                    height: size.h,
                    preserveAspectRatio: 'xMidYMid meet',
                    style: { width: '100%', height: '100%', display: 'block' },
                    onPointerDownCapture: event => {
                      const target = event.target
                      const hit = target !== null && typeof target.closest === 'function' ? target.closest('[data-node-id]') : null
                      if (hit === null) return
                      const id = hit.getAttribute('data-node-id')
                      if (typeof id === 'string' && id !== '') selectNode(id)
                    },
                  },
                  h(
                    'defs',
                    null,
                    h(
                      'marker',
                      { id: 'dwb-arrow', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse' },
                      h('path', { d: 'M 0.8 1 L 7 4 L 0.8 7 L 2.2 4 Z', fill: 'rgba(150,165,220,0.55)' }),
                    ),
                    h(
                      'marker',
                      { id: 'dwb-arrow-hot', viewBox: '0 0 8 8', refX: 7, refY: 4, markerWidth: 6.5, markerHeight: 6.5, orient: 'auto-start-reverse' },
                      h('path', { d: 'M 0.8 1 L 7 4 L 0.8 7 L 2.2 4 Z', fill: brandColor }),
                    ),
                  ),
                  h(
                    'g',
                    { transform: `translate(${view.x}, ${view.y}) scale(${view.k})` },
                    edges.map(edge => {
                      const from = nodes.find(item => item.id === edge.source)
                      const to = nodes.find(item => item.id === edge.target)
                      if (from === undefined || to === undefined) return null
                      const fromPosition =
                        drag !== null && drag.id === from.id
                          ? { x: drag.x, y: drag.y }
                          : { x: Number(from.position?.x) || 0, y: Number(from.position?.y) || 0 }
                      const toPosition =
                        drag !== null && drag.id === to.id
                          ? { x: drag.x, y: drag.y }
                          : { x: Number(to.position?.x) || 0, y: Number(to.position?.y) || 0 }
                      const geometry = edgeGeometry(from, to, fromPosition, toPosition)
                      const touching = selectedId !== null && (edge.source === selectedId || edge.target === selectedId)
                      const selectedEdge = edge.id === selectedEdgeId
                      const strong = selectedEdge || touching
                      const stroke = selectedEdge ? brandColor : touching ? hexToRgba(brandColor, 0.82) : 'rgba(150,165,220,0.30)'
                      const width = selectedEdge ? 2.6 : touching ? 2 : 1.5
                      return h(
                        'g',
                        { key: edge.id, className: 'dwb-edge', 'data-edge-id': edge.id },
                        // 透明加粗命中区：细线也好点中
                        h('path', {
                          d: geometry.d,
                          fill: 'none',
                          stroke: 'rgba(0,0,0,0)',
                          strokeWidth: 20,
                          strokeLinecap: 'round',
                          className: 'dwb-edge-hit',
                          onPointerDown: event => event.stopPropagation(),
                          onClick: event => {
                            event.stopPropagation()
                            setSelectedId(null)
                            setSelectedEdgeId(edge.id)
                            setNotice(`已选中连线：「${from.data?.label ?? ''}」→「${to.data?.label ?? ''}」｜Delete 删除，节点保留`)
                          },
                        }),
                        selectedEdge
                          ? h('path', {
                              d: geometry.d,
                              fill: 'none',
                              stroke: hexToRgba(brandColor, 0.20),
                              strokeWidth: width + 7,
                              strokeLinecap: 'round',
                            })
                          : null,
                        h('path', {
                          d: geometry.d,
                          fill: 'none',
                          stroke,
                          strokeWidth: width,
                          strokeLinecap: 'round',
                          strokeDasharray: selectedEdge ? '7 5' : undefined,
                          markerEnd: strong ? 'url(#dwb-arrow-hot)' : 'url(#dwb-arrow)',
                          className: selectedEdge ? 'dwb-edge-line dwb-edge-selected' : 'dwb-edge-line',
                        }),
                        // 起点圆点：强调方向
                        h('circle', {
                          cx: geometry.sx,
                          cy: geometry.sy,
                          r: selectedEdge ? 3.6 : 2.6,
                          fill: strong ? brandColor : 'rgba(150,165,220,0.45)',
                          className: 'dwb-rubber',
                        }),
                        selectedEdge
                          ? h(
                              'g',
                              {
                                className: 'dwb-edge-delete',
                                transform: `translate(${geometry.mx}, ${geometry.my})`,
                                onPointerDown: event => event.stopPropagation(),
                                onClick: event => {
                                  event.stopPropagation()
                                  removeEdge(edge.id)
                                },
                              },
                              h('circle', { r: 10, fill: 'rgba(24,27,38,0.94)', stroke: 'rgba(255,107,129,0.75)', strokeWidth: 1.2 }),
                              h('path', { d: 'M -3.6 -3.6 L 3.6 3.6 M 3.6 -3.6 L -3.6 3.6', stroke: '#ff8497', strokeWidth: 1.8, strokeLinecap: 'round' }),
                              h('title', null, '删除这条连线（节点保留）'),
                            )
                          : null,
                      )
                    }),
                    linkDrag === null
                      ? null
                      : h('path', {
                          className: 'dwb-rubber',
                          d: `M ${linkDrag.anchor.x} ${linkDrag.anchor.y} L ${linkDrag.pointer.x} ${linkDrag.pointer.y}`,
                          fill: 'none',
                          stroke: brandColor,
                          strokeWidth: 1.8,
                          strokeDasharray: '5 4',
                          strokeLinecap: 'round',
                        }),
                    nodes.map(node => {
                      const dragging = drag !== null && drag.id === node.id
                      const position = dragging ? { x: drag.x, y: drag.y } : { x: Number(node.position?.x) || 0, y: Number(node.position?.y) || 0 }
                      const config = typeConfig(node.type)
                      const support = (config.tone ?? 'argument') === 'support'
                      const color = config.color ?? '#7c8cff'
                      const active = node.id === selectedId
                      const hovered = node.id === hoveredId
                      const isLinkSource = node.id === linkSource
                      const linkedCount = links.filter(link => link.nodeId === node.id).length
                      const attackCount = (boxes.find(box => box.nodeId === node.id)?.attacks ?? []).length
                      const metrics = nodeMetrics(node)
                      const strokeColor = isLinkSource ? '#ff8497' : active ? brandColor : hexToRgba(color, support ? 0.32 : 0.44)
                      return h(
                        'g',
                        {
                          key: node.id,
                          className: 'dwb-node',
                          'data-node-id': node.id,
                          'data-hover': hovered ? '1' : '0',
                          'data-selected': active ? '1' : '0',
                          transform: `translate(${position.x}, ${position.y})`,
                          tabIndex: 0,
                          role: 'button',
                          'aria-label': `节点：${node.data?.label ?? ''}`,
                          onKeyDown: event => {
                            if (event.key !== 'Enter' && event.key !== ' ') return
                            event.preventDefault()
                            selectNode(node.id)
                          },
                          onPointerDown: event => onNodePointerDown(event, node),
                          onPointerEnter: () => setHoveredId(node.id),
                          onPointerLeave: () => setHoveredId(current => (current === node.id ? null : current)),
                          onClick: event => {
                            event.stopPropagation()
                            onNodeClick(node)
                          },
                        },
                        h('title', null, node.data?.label ?? ''),
                        h(
                          'g',
                          { className: 'dwb-node-inner' },
                          h('rect', {
                            width: metrics.width,
                            height: metrics.height,
                            rx: 12,
                            fill: hexToRgba(color, support ? 0.07 : 0.11),
                            stroke: strokeColor,
                            strokeWidth: active || isLinkSource ? 2 : 1.2,
                            strokeDasharray: support && !active && !isLinkSource ? '5 4' : undefined,
                          }),
                          h('g', { transform: 'translate(14, 11)' }, renderGlyph(h, config.glyph, color, 0, 0)),
                          h('text', { x: 32, y: 20.5, fill: color, fontSize: 10, className: 'dwb-node-type' }, config.label),
                          metrics.truncated === true
                            ? h(
                                'text',
                                { x: metrics.width - 12, y: metrics.height - 6, fill: 'rgba(242,193,78,0.85)', fontSize: 10, textAnchor: 'end' },
                                '⋯ 全文见编辑窗',
                              )
                            : null,
                          linkedCount > 0
                            ? h(
                                'text',
                                { x: metrics.width - 12, y: 20.5, fill: 'rgba(232,235,245,0.7)', fontSize: 10, textAnchor: 'end' },
                                `📎${linkedCount}`,
                              )
                            : null,
                          attackCount > 0
                            ? h(
                                'text',
                                { x: metrics.width - 12, y: 20.5, fill: 'rgba(242,193,78,0.9)', fontSize: 10, textAnchor: 'end' },
                                '⚔',
                              )
                            : null,
                          h(
                            'text',
                            { x: 16, y: 40, fontSize: 12, className: 'dwb-node-title' },
                            metrics.lines.map((line, index) =>
                              h('tspan', { key: index, x: 16, dy: index === 0 ? 0 : NODE_LINE_HEIGHT }, line),
                            ),
                          ),
                        ),
                        // 连线端口画在节点内容之上：悬停/选中节点时出现。
                        // 右端口 = 本节点为源，左端口 = 本节点为目标（反向连线）。
                        hovered || active || linkDrag !== null
                          ? h(
                              'g',
                              { className: 'dwb-ports' },
                              h('circle', {
                                className: 'dwb-port',
                                cx: metrics.width,
                                cy: metrics.height / 2,
                                r: 5.5,
                                onPointerDown: event => startLinkDrag(event, node, true),
                              }),
                              h('circle', {
                                className: 'dwb-port',
                                cx: 0,
                                cy: metrics.height / 2,
                                r: 5.5,
                                onPointerDown: event => startLinkDrag(event, node, false),
                              }),
                              h('title', null, '拖到任意节点建立连线'),
                            )
                          : null,
                      )
                    }),
                  ),
                ),
            h(
              'div',
              { className: 'dwb-zoom' },
              h('button', { type: 'button', className: 'dwb-btn', title: '放大', onClick: () => zoomBy(1.25) }, '＋'),
              h('button', { type: 'button', className: 'dwb-btn', title: '缩小', onClick: () => zoomBy(1 / 1.25) }, '－'),
              h('button', { type: 'button', className: 'dwb-btn', title: '适应画布', onClick: fitView }, '适应'),
              h('span', { className: 'dwb-muted' }, `${Math.round(view.k * 100)}%`),
            ),
            selected === null
              ? null
              : h(
                  'div',
                  {
                    className: 'dwb-float',
                    'data-narrow': narrow ? '1' : '0',
                    'data-collapsed': editorCollapsed ? '1' : '0',
                    style: narrow ? undefined : floatOnLeft ? { left: 8, right: 'auto' } : { right: 8, left: 'auto' },
                    onPointerDown: event => event.stopPropagation(),
                    onPointerUp: event => event.stopPropagation(),
                    onClick: event => event.stopPropagation(),
                    onDoubleClick: event => event.stopPropagation(),
                    onWheel: event => event.stopPropagation(),
                  },
                  h(
                    'div',
                    { className: 'dwb-float-head' },
                    h('span', null, '节点编辑'),
                    h(
                      'div',
                      { style: { display: 'flex', gap: 4 } },
                      h(
                        'button',
                        {
                          type: 'button',
                          className: 'dwb-btn',
                          title: editorCollapsed ? '展开编辑窗' : '收起编辑窗（收起后能点画布上的其他节点）',
                          onClick: () => setEditorCollapsed(current => current !== true),
                        },
                        editorCollapsed ? '展开' : '收起',
                      ),
                      h('button', { type: 'button', className: 'dwb-btn', onClick: () => selectNode(null) }, '关闭'),
                    ),
                  ),
                  h('div', { className: 'dwb-float-body' }, renderNodeSidebar()),
                ),
          ),
        ),
      )
    }

    /* ---------- 顶部 ---------- */
    const top = () =>
      h(
        'div',
        { className: 'dwb-top' },
        h(
          'select',
          {
            className: 'dwb-input',
            title: hostReady ? '切换题目（多题目并行备赛）' : hostHint,
            disabled: !hostReady,
            style: { maxWidth: 190 },
            value: state?.activeProjectId ?? '',
            onChange: event => switchToProject(event.target.value),
          },
          (Array.isArray(state?.projects) && state.projects.length > 0 ? state.projects : [{ id: '', topic: '暂无题目' }]).map(item =>
            h('option', { key: item.id === '' ? 'none' : item.id, value: item.id }, item.topic),
          ),
        ),
        h(
          'button',
          { type: 'button', className: 'dwb-btn', 'data-quiet': '1', title: '管理题目与备赛待办', onClick: () => setTab('projects') },
          '＋题目',
        ),
        h('span', { className: 'dwb-pill' }, `${bundle?.project?.side === 'pro' ? '正方' : '反方'} · 就绪度 ${Number(analysis?.readiness ?? 0)}`),
        h('span', { className: 'dwb-spacer' }),
        h(
          'div',
          { className: 'dwb-seg' },
          TABS.map(item =>
            h(
              'button',
              {
                key: item.value,
                type: 'button',
                className: 'dwb-tabbtn',
                'data-active': tab === item.value ? '1' : '0',
                onClick: () => setTab(item.value),
              },
              item.label,
            ),
          ),
        ),
        h('button', { type: 'button', className: 'dwb-btn', 'data-quiet': '1', title: '把论证树重新居中显示（也可双击画布空白处）', onClick: () => { fitView(); setNotice('已重新定位论证树') } }, '定位'),
        h('button', { type: 'button', className: 'dwb-btn', 'data-quiet': '1', title: '重新加载数据', onClick: () => reload() }, '刷新'),
        h(
          'button',
          {
            type: 'button',
            className: 'dwb-btn',
            'data-quiet': '1',
            title: '按层级重新排列节点',
            onClick: async () => {
              await run('debate_tree', { action: 'auto_layout' }, '已自动排版')
              fitView()
            },
          },
          '自动排版',
        ),
      )

    /* ---------- 节点侧栏 ---------- */
    const saveNode = async () => {
      if (selected === null) return
      const label = String(draft.label ?? '').trim()
      if (label === '') {
        setNotice('标题不能为空：填好标题再保存')
        return
      }
      const type = draft.nodeType === '' ? selected.type : draft.nodeType
      setBusy(true)
      try {
        const payload = await api.tool('debate_tree', {
          action: 'update_node',
          nodeId: selected.id,
          patch: { type, label, description: String(draft.description ?? '') },
        })
        const updated = payload.result?.node
        if (updated !== undefined) {
          setDraft(current => ({
            ...current,
            label: updated.data?.label ?? label,
            description: updated.data?.description ?? '',
            nodeType: updated.type,
          }))
        }
        await reload()
        setNotice('节点已保存')
        setError(null)
      } catch (problem) {
        setError(String(problem.message ?? problem))
      } finally {
        setBusy(false)
      }
    }

    const renderNodeSidebar = () =>
      h(
        'div',
        { className: 'dwb-side' },
        selected === null
          ? h('div', { className: 'dwb-muted' }, '点选一个节点开始编辑；拖动节点可移动；点「连线」再点另一个节点可建立父子关系。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 8 } },
                h('span', { className: 'dwb-chip' }, typeConfig(selected.type).label),
                h('span', { className: 'dwb-muted' }, selected.id.slice(-8)),
              ),
              h(
                'label',
                { className: 'dwb-field' },
                h('span', null, '标题'),
                h('input', {
                  ref: titleRef,
                  value: draft.label,
                  onChange: event => setDraft(current => ({ ...current, label: event.target.value })),
                  onKeyDown: event => {
                    if (event.key !== 'Enter' || event.isComposing === true) return
                    saveNode()
                  },
                }),
              ),
              h(
                'label',
                { className: 'dwb-field' },
                h('span', null, '推理过程 / 说明'),
                h('textarea', {
                  value: draft.description,
                  placeholder: '论点是机制、立场是一句话主张、前提是假设内容…',
                  onChange: event => setDraft(current => ({ ...current, description: event.target.value })),
                }),
              ),
              h(
                'label',
                {
                  className: 'dwb-field',
                  style: { flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' },
                },
                h('input', {
                  type: 'checkbox',
                  checked: isWrapEnabled(selected),
                  onChange: event => {
                    const on = event.target.checked === true
                    run(
                      'debate_tree',
                      { action: 'update_node', nodeId: selected.id, patch: { details: { wrap: on ? 'true' : 'false' } } },
                      on ? '已开启多行换行（节点高度自适应，最多 ' + NODE_MAX_LINES + ' 行）' : '已关闭多行换行',
                    )
                  },
                }),
                h('span', null, `多行换行（长文本自动加高节点，最多 ${NODE_MAX_LINES} 行 / 宽 ${NODE_MAX_W}px）`),
              ),
              isWrapEnabled(selected)
                ? h(
                    'label',
                    {
                      className: 'dwb-field',
                      style: { flexDirection: 'row', alignItems: 'center', gap: 6, cursor: 'pointer' },
                    },
                    h('input', {
                      type: 'checkbox',
                      checked: isCompactNode(selected),
                      onChange: event => {
                        const on = event.target.checked === true
                        run(
                          'debate_tree',
                          { action: 'update_node', nodeId: selected.id, patch: { details: { compact: on ? 'true' : 'false' } } },
                          on ? '已切到精简显示（最多 6 行）' : '已切到完整显示（最多 ' + NODE_MAX_LINES + ' 行）',
                        )
                      },
                    }),
                    h('span', null, `精简显示（只显示 ${NODE_COMPACT_LINES} 行，画布更清爽）`),
                  )
                : null,
              nodeMetrics(selected).truncated
                ? h(
                    'div',
                    { className: 'dwb-muted', style: { marginBottom: 7 } },
                    '主标题被截断（单行模式上限 ' + NODE_MAX_W + 'px）。要完整展示：勾上「多行换行」，再把「精简显示」取消。',
                  )
                : null,
              h(
                'label',
                { className: 'dwb-field' },
                h('span', null, '节点类型'),
                h(
                  'select',
                  {
                    value: draft.nodeType === '' ? selected.type : draft.nodeType,
                    onChange: event => setDraft(current => ({ ...current, nodeType: event.target.value })),
                  },
                  NODE_TYPES.map(item => h('option', { key: item.type, value: item.type }, item.label)),
                ),
              ),
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 10 } },
                h('button', { type: 'button', className: 'dwb-btn', 'data-primary': '1', disabled: busy, onClick: saveNode }, '保存'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dwb-btn',
                    disabled: busy,
                    onClick: addChildNode,
                  },
                  '加子论点',
                ),
                h('button', { type: 'button', className: 'dwb-btn', disabled: busy, onClick: () => setLinkSource(selected.id) }, '连线'),
                h(
                  'button',
                  {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-danger': '1',
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm('删除该节点及其整个子树？')) {
                        run('debate_tree', { action: 'remove_node', nodeId: selected.id }, '节点已删除')
                        setSelectedId(null)
                      }
                    },
                  },
                  '删除',
                ),
              ),
              h('div', { className: 'dwb-muted', style: { margin: '6px 0 4px' } }, `关联证据（${selectedLinks.length}）`),
              h(
                'div',
                { className: 'dwb-list', style: { marginBottom: 10 } },
                selectedLinks.length === 0
                  ? h('div', { className: 'dwb-muted' }, '还没挂证据，去「证据卡」标签页挂载。')
                  : selectedLinks.map(link => {
                      const card = cards.find(item => item.id === link.evidenceCardId)
                      return h(
                        'div',
                        { key: link.id, className: 'dwb-item' },
                        h('b', null, card?.title ?? '（卡片已删除）'),
                        h('div', { className: 'dwb-muted' }, card ? `${card.type}｜可信度 ${card.credibility}/5` : ''),
                        h(
                          'button',
                          {
                            type: 'button',
                            className: 'dwb-btn',
                            'data-danger': '1',
                            style: { marginTop: 4 },
                            onClick: () => run('debate_evidence', { action: 'unlink', linkId: link.id }, '已取消挂载'),
                          },
                          '取消挂载',
                        ),
                      )
                    }),
              ),
              h('div', { className: 'dwb-muted', style: { margin: '6px 0 4px' } }, `攻防（${selectedBox?.attacks?.length ?? 0} 条）`),
              h(
                'div',
                { className: 'dwb-list' },
                (selectedBox?.attacks ?? []).length === 0
                  ? h('div', { className: 'dwb-muted' }, '还没有攻击预判，去「攻防」标签页补。')
                  : (selectedBox?.attacks ?? []).map(attack =>
                      h(
                        'div',
                        { key: attack.id, className: 'dwb-item' },
                        h('b', null, `${ATTACK_TYPES.find(item => item.value === attack.type)?.label ?? attack.type}｜威胁 ${attack.threatLevel}/5`),
                        h('div', null, attack.content),
                        h('div', { className: 'dwb-muted' }, attack.defenseStrategy ? `防守：${attack.defenseStrategy}` : '⚠ 还没写防守'),
                      ),
                    ),
              ),
            ),
      )

    /* ---------- 拆题 ---------- */
    const renderTopicTab = () => {
      const decomposition = Array.isArray(bundle?.decompositionResults) ? bundle.decompositionResults[0] : undefined
      const section = (title, rows) =>
        rows.length === 0
          ? null
          : h(
              'div',
              { className: 'dwb-item', style: { marginBottom: 6 } },
              h('b', null, title),
              h(
                'div',
                { className: 'dwb-list', style: { marginTop: 4 } },
                rows.map((row, index) => h('div', { key: index, className: 'dwb-muted' }, row)),
              ),
            )
      const stringify = value => (typeof value === 'string' ? value : '')
      const requestDecompose = async () => {
        setAiBusy(true)
        setError(null)
        try {
          const payload = await api.tool('debate_ai', { action: 'decompose', hint: aiHint.trim() === '' ? undefined : aiHint.trim() })
          const result = payload.result ?? {}
          setAiCandidate(result.candidate ?? null)
          if (result.route !== undefined) setAiStatus({ ...(aiStatus ?? {}), available: true, ...result.route })
          setNotice('已生成拆题候选：右侧预览确认后再应用')
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setAiBusy(false)
        }
      }
      const applyCandidate = async () => {
        if (aiCandidate === null) return
        setAiBusy(true)
        setError(null)
        try {
          await api.tool('debate_ai', { action: 'apply', candidate: aiCandidate })
          setAiCandidate(null)
          setNotice('拆题候选已写入')
          await reload()
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setAiBusy(false)
        }
      }

      const conceptRows = (decomposition?.coreConcepts ?? []).map(
        item => `${stringify(item.term)}：${stringify(item.suggestedDefinition) || stringify(item.literalDefinition) || '（待补定义）'}`,
      )
      const pointRows = (decomposition?.controversialPoints ?? []).map(
        item => `${stringify(item.issue)}｜我方：${stringify(item.proView) || '待补'}｜对方：${stringify(item.conView) || '待补'}`,
      )
      const fieldRows = (decomposition?.battlefields ?? []).map(
        item => `[${stringify(item.priority) || 'medium'}] ${stringify(item.battlefield)}：${stringify(item.whyItMatters)}`,
      )
      const criteriaRows = [
        ...(decomposition?.comparisonFramework?.overallPlatform
          ? [`比较平台：${decomposition.comparisonFramework.overallPlatform}`]
          : []),
        ...(decomposition?.comparisonFramework?.criteria ?? []).map(
          item => `${stringify(item.dimension)}｜我方：${stringify(item.ourStandard)}｜对方：${stringify(item.opponentStandard)}`,
        ),
      ]
      const premiseRows = (decomposition?.hiddenPremises ?? []).map(item => `${stringify(item.premise)}：${stringify(item.explanation)}`)
      const pathRows = (decomposition?.argumentPaths ?? []).map(
        item => `[${item.side === 'con' ? '反方' : '正方'}] ${stringify(item.mainClaim)}（支撑 ${(item.supportingPoints ?? []).length} 点）`,
      )
      const rebuttalRows = (decomposition?.rebuttalTargets ?? []).map(item => `${stringify(item.target)} → ${stringify(item.attackPath)}`)
      const checklistRows = (decomposition?.prepChecklist ?? []).map(item => `☐ ${stringify(item)}`)

      const routeText =
        aiStatus === null
          ? '检查模型…'
          : aiStatus.available === false
            ? `不可用：${aiStatus.reason ?? '未知原因'}`
            : `${aiStatus.mode === 'openai-compatible' ? '外接' : '内置'} · ${aiStatus.provider ?? ''}/${aiStatus.model ?? ''}`

      return h(
        'div',
        { className: bodyClass() },
        h(
          'div',
          { className: 'dwb-pane' },
          h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '拆题结果'),
          decomposition === undefined
            ? h(
                'div',
                { className: 'dwb-muted', style: { marginBottom: 8 } },
                '还没有拆题结果。手动填可以用 debate_topic(action=save)；也可以点右侧「生成拆题候选」，确认后一键写入。',
              )
            : h(
                'div',
                null,
                decomposition.judgeQuestion ? h('div', { className: 'dwb-item', style: { marginBottom: 6 } }, h('b', null, '评委问题'), h('div', { className: 'dwb-muted' }, decomposition.judgeQuestion)) : null,
                decomposition.motionType ? h('div', { className: 'dwb-muted', style: { marginBottom: 6 } }, `辩题类型：${decomposition.motionType}`) : null,
                section('核心概念', conceptRows),
                section('争议点', pointRows),
                section('战场', fieldRows),
                section('比较框架', criteriaRows),
                section('隐藏前提', premiseRows),
                section('论证路径', pathRows),
                section('反驳目标', rebuttalRows),
                section('备赛清单', checklistRows),
              ),
        ),
        h(
          'div',
          { className: 'dwb-side', style: { flexBasis: 320 } },
          h('div', { style: { fontWeight: 650, marginBottom: 4 } }, 'AI 拆题助手'),
          h('div', { className: 'dwb-muted', style: { marginBottom: 8 } }, `模型路由：${routeText}`),
          h('label', { className: 'dwb-field' }, h('span', null, '补充要求（可选）'),
            h('input', {
              value: aiHint,
              placeholder: '如：重点做价值比较 / 注意政策辩可行性',
              onChange: event => setAiHint(event.target.value),
            }),
          ),
          h(
            'div',
            { className: 'dwb-row', style: { marginBottom: 8 } },
            h(
              'button',
              {
                type: 'button',
                className: 'dwb-btn',
                'data-primary': '1',
                disabled: aiBusy || (aiStatus !== null && aiStatus.available === false),
                onClick: requestDecompose,
              },
              aiBusy ? '生成中…' : '生成拆题候选',
            ),
            aiCandidate === null ? null : h('button', { type: 'button', className: 'dwb-btn', 'data-quiet': '1', onClick: () => setAiCandidate(null) }, '丢弃候选'),
          ),
          aiCandidate === null
            ? h('div', { className: 'dwb-muted' }, '生成结果只做候选展示，点「应用为拆题结果」才会写入。证据类内容不在此生成，避免编造。')
            : h(
                'div',
                null,
                h('div', { className: 'dwb-row', style: { marginBottom: 6 } },
                  h('b', null, '候选预览'),
                  h('span', { className: 'dwb-chip' }, '未落库'),
                ),
                h('pre', { className: 'dwb-pre', style: { maxHeight: 260 } }, JSON.stringify(aiCandidate, null, 2)),
                h('div', { className: 'dwb-row', style: { marginTop: 8 } },
                  h('button', { type: 'button', className: 'dwb-btn', 'data-primary': '1', disabled: aiBusy, onClick: applyCandidate }, '应用为拆题结果'),
                  h('button', { type: 'button', className: 'dwb-btn', 'data-quiet': '1', disabled: aiBusy, onClick: () => setAiCandidate(null) }, '丢弃'),
                ),
              ),
        ),
      )
    }

    /* ---------- 项目 / 待办 ---------- */
    /* ---------- 复盘标签页 ---------- */
    const reviewPerspectiveOptions = [
      ['white-paper', '白纸评委'],
      ['argument', '论点裁'],
      ['technical', '技术裁'],
      ['value', '价值裁'],
      ['situational', '情境裁'],
    ]
    const reviewSideText = side => (side === 'con' ? '反方' : '正方')
    const reviewJobLabel = kind => ({ transcribe: '录音转写', judge: '判比赛', phases: '环节复盘', evidence: '证据候选' }[kind] ?? kind)

    const renderReviewTab = () => {
      if (!hostReady) {
        return h(
          'div',
          { className: bodyClass() },
          h('div', { className: 'dwb-pane' }, h('div', { className: 'dwb-banner', style: { borderRadius: 8, padding: '10px 12px' } }, hostHint)),
        )
      }
      const detail = reviewDetail?.review ?? null
      const jobRunning = reviewJob !== null && reviewJob.state === 'running'
      const actionButton = (label, onClick, primary) =>
        h(
          'button',
          { type: 'button', className: 'dwb-btn', disabled: busy || jobRunning, 'data-primary': primary ? '1' : undefined, onClick },
          label,
        )

      const listPane = h(
        'div',
        { className: 'dwb-pane', style: { flex: '0 0 min(280px, 100%)', minWidth: 220 } },
        h('div', { style: { fontWeight: 650, marginBottom: 4 } }, '复盘记录'),
        h('div', { className: 'dwb-muted', style: { marginBottom: 8 } }, '录音 + 转写 → 三票制判比赛 + 按环节复盘'),
        h(
          'div',
          { className: 'dwb-list' },
          reviews.length === 0 ? h('div', { className: 'dwb-muted' }, '还没有复盘。下面新建一条。') : null,
          reviews.map(item =>
            h(
              'div',
              {
                key: item.id,
                className: 'dwb-item',
                style: item.id === reviewSelectedId ? { borderColor: 'rgba(124,140,255,0.55)', cursor: 'pointer' } : { cursor: 'pointer' },
                onClick: () => selectReview(item.id),
              },
              h(
                'div',
                { className: 'dwb-row' },
                h('b', null, item.title),
                h('span', { className: 'dwb-chip' }, reviewSideText(item.ourSide)),
              ),
              h('div', { className: 'dwb-muted' }, item.date + (item.opponent === '' ? '' : ' · ' + item.opponent) + (item.winner === undefined ? ' · 未判' : ' · ' + reviewSideText(item.winner) + '胜 ' + (item.voteCount ?? ''))),
              h('div', { className: 'dwb-muted' }, (item.hasTranscript ? '已转写' : '无转写') + ' · ' + (item.hasJudge ? '已判' : '未判') + ' · 环节 ' + (item.phaseCount ?? 0) + ' · 候选 ' + (item.evidenceCandidates ?? 0) + (item.hasAudio ? ' · 有录音' : '')),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dwb-item', style: { marginTop: 10 } },
          h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '新建复盘'),
          h('input', {
            className: 'dwb-input',
            style: { width: '100%', marginBottom: 6 },
            placeholder: '标题（如：对XX大学模辩）',
            value: reviewDraft.title,
            onChange: event => setReviewDraft(current => ({ ...current, title: event.target.value })),
          }),
          h(
            'div',
            { className: 'dwb-row', style: { marginBottom: 6 } },
            h('input', {
              className: 'dwb-input',
              style: { flex: '1 1 110px' },
              placeholder: '日期 2030-01-01',
              value: reviewDraft.date,
              onChange: event => setReviewDraft(current => ({ ...current, date: event.target.value })),
            }),
            h(
              'select',
              { className: 'dwb-input', style: { flex: '0 0 78px' }, value: reviewDraft.ourSide, onChange: event => setReviewDraft(current => ({ ...current, ourSide: event.target.value })) },
              h('option', { value: 'pro' }, '正方'),
              h('option', { value: 'con' }, '反方'),
            ),
          ),
          h('input', {
            className: 'dwb-input',
            style: { width: '100%', marginBottom: 6 },
            placeholder: '对手（可选）',
            value: reviewDraft.opponent,
            onChange: event => setReviewDraft(current => ({ ...current, opponent: event.target.value })),
          }),
          h('div', { className: 'dwb-muted', style: { marginBottom: 4 } }, '录音（可选，M4A/MP3 会自动转成 16kHz WAV，转换上限 30 分钟）'),
          h('input', {
            type: 'file',
            accept: '.wav,.m4a,.mp3,.ogg,.webm,.flac,.aac,audio/*',
            style: { marginBottom: 6, fontSize: 11 },
            onChange: event => setReviewDraft(current => ({ ...current, audioFile: event.target.files && event.target.files[0] ? event.target.files[0] : null })),
          }),
          h('div', { className: 'dwb-muted', style: { marginBottom: 4 } }, '字幕/转写文本（.srt/.vtt/.txt 或直接粘贴）'),
          h('input', {
            type: 'file',
            accept: '.srt,.vtt,.txt',
            style: { marginBottom: 6, fontSize: 11 },
            onChange: event => {
              const picked = event.target.files && event.target.files[0]
              if (!picked) return
              picked.text().then(text => setReviewSubtitle(text)).catch(problem => setError(String(problem?.message ?? problem)))
            },
          }),
          h('textarea', {
            className: 'dwb-input',
            style: { width: '100%', minHeight: 64, marginBottom: 6, fontSize: 11 },
            placeholder: '字幕或转写文本',
            value: reviewSubtitle,
            onChange: event => setReviewSubtitle(event.target.value),
          }),
          actionButton('创建复盘', createReview, true),
        ),
      )

      const judge = detail?.judge
      const judgeView =
        judge === undefined || judge === null
          ? null
          : h(
              'div',
              { className: 'dwb-item', style: { marginTop: 10 } },
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 6 } },
                h('b', null, '判比赛'),
                h('span', { className: 'dwb-chip' }, (reviewPerspectiveOptions.find(item => item[0] === judge.perspective) ?? [])[1] ?? judge.perspective ?? ''),
                h('span', { className: 'dwb-chip' }, reviewSideText(judge.winner) + '胜 ' + (judge.voteCount ?? '')),
                h('span', { className: 'dwb-muted' }, judge.disclaimer ?? ''),
              ),
              h(
                'div',
                null,
                ['impression', 'phase', 'decision'].map(key =>
                  h(
                    'div',
                    { key, style: { marginBottom: 4 } },
                    h('b', null, (key === 'impression' ? '印象票：' : key === 'phase' ? '环节票：' : '决胜票：') + reviewSideText(judge.votes?.[key]) + ' '),
                    h('span', null, judge.reasons?.[key] ?? ''),
                  ),
                ),
              ),
              detail.judge.minimalMargin ? h('div', { className: 'dwb-muted', style: { marginTop: 4 } }, '最小致胜差异：' + judge.minimalMargin) : null,
              Array.isArray(judge.argumentSurvival) && judge.argumentSurvival.length > 0
                ? h(
                    'div',
                    { style: { marginTop: 6 } },
                    h('div', { style: { fontWeight: 600 } }, '论证留存度'),
                    judge.argumentSurvival.map((item, index) =>
                      h('div', { key: 'survival-' + index, className: 'dwb-muted' }, '[' + reviewSideText(item.side) + '] ' + item.argument + '：' + (item.survived === true ? '存活' : '被打掉') + (item.afterClash ? '（' + item.afterClash + '）' : '')),
                    ),
                  )
                : null,
              Array.isArray(judge.decisiveClashes) && judge.decisiveClashes.length > 0
                ? h(
                    'div',
                    { style: { marginTop: 6 } },
                    h('div', { style: { fontWeight: 600 } }, '关键交锋'),
                    judge.decisiveClashes.map((item, index) =>
                      h('div', { key: 'clash-' + index, className: 'dwb-muted' }, item.clash + ' → 判 ' + reviewSideText(item.judgedFor) + '（' + item.why + '）'),
                    ),
                  )
                : null,
            )

      const phaseReview = Array.isArray(detail?.phaseReview) ? detail.phaseReview : []
      const phaseView =
        phaseReview.length === 0
          ? null
          : h(
              'div',
              { className: 'dwb-item', style: { marginTop: 10 } },
              h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '环节复盘'),
              phaseReview.map(phase =>
                h(
                  'div',
                  { key: phase.phase, style: { marginBottom: 8 } },
                  h('div', { className: 'dwb-row' }, h('b', null, phase.phase), h('span', { className: 'dwb-muted' }, phase.scores === undefined ? '' : '我方 ' + (phase.scores.pro ?? '-') + ' / 对方 ' + (phase.scores.con ?? '-'))),
                  phase.summary ? h('div', { className: 'dwb-muted' }, phase.summary) : null,
                  (phase.findings ?? []).map((finding, index) =>
                    h('div', { key: 'finding-' + index, style: { fontSize: 11, marginTop: 2 } }, (finding.at ? '[' + finding.at + '] ' : '') + '问题：' + finding.issue + (finding.advice ? '；建议：' + finding.advice : '')),
                  ),
                  phase.drill ? h('div', { className: 'dwb-muted', style: { fontSize: 11 } }, '训练建议：' + phase.drill) : null,
                ),
              ),
            )

      const candidates = Array.isArray(detail?.evidenceCandidates) ? detail.evidenceCandidates : []
      const candidateView =
        candidates.length === 0
          ? null
          : h(
              'div',
              { className: 'dwb-item', style: { marginTop: 10 } },
              h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '证据候选（pending，未入库）'),
              candidates.map(candidate =>
                h('div', { key: candidate.id, className: 'dwb-muted', style: { fontSize: 11 } }, '[' + candidate.type + '][' + candidate.status + '] ' + candidate.claim + (candidate.need ? '（' + candidate.need + '）' : '')),
              ),
            )

      const detailPane = h(
        'div',
        { className: 'dwb-pane', style: { flex: '1 1 auto', minWidth: 300 } },
        detail === null
          ? h('div', { className: 'dwb-muted' }, '左侧选择或新建一条复盘。')
          : h(
              'div',
              null,
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 6 } },
                h('b', { style: { fontSize: 14 } }, detail.title),
                h('span', { className: 'dwb-chip' }, reviewSideText(detail.ourSide)),
                h('span', { className: 'dwb-muted' }, detail.date + (detail.opponent === '' ? '' : ' · ' + detail.opponent)),
                h('span', { className: 'dwb-spacer' }),
                h('a', { className: 'dwb-btn', href: api.reviewMarkdownUrl(detail.id, state?.activeProjectId ?? undefined), download: '' }, '导出 Markdown'),
                actionButton('删除', deleteReview),
              ),
              h('div', { className: 'dwb-muted', style: { marginBottom: 8 } }, detail.source?.audio ? '录音：' + detail.source.audio.file + '（' + Math.round((detail.source.audio.bytes ?? 0) / 1024) + ' KB）' : '无录音（可导入字幕/文本）'),
              h('div', { style: { fontWeight: 600, marginBottom: 4 } }, '转写'),
              h('textarea', {
                className: 'dwb-input',
                style: { width: '100%', minHeight: 110, marginBottom: 6, fontSize: 12 },
                value: reviewTranscriptEdit,
                onChange: event => setReviewTranscriptEdit(event.target.value),
              }),
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 10 } },
                actionButton('保存转写', saveReviewTranscript),
                actionButton('一键转写', () => startReviewJobAction('transcribe')),
                h('span', { className: 'dwb-muted' }, Array.isArray(detail.transcript?.segments) && detail.transcript.segments.length > 0 ? '已解析 ' + detail.transcript.segments.length + ' 段' : ''),
              ),
              h(
                'div',
                { className: 'dwb-row', style: { marginBottom: 8 } },
                h(
                  'select',
                  { className: 'dwb-input', style: { flex: '0 0 108px' }, value: reviewPerspective, onChange: event => setReviewPerspective(event.target.value) },
                  reviewPerspectiveOptions.map(item => h('option', { key: item[0], value: item[0] }, item[1])),
                ),
                h(
                  'select',
                  { className: 'dwb-input', style: { flex: '0 0 92px' }, value: reviewMode, onChange: event => setReviewMode(event.target.value) },
                  h('option', { value: 'votes' }, '三票制'),
                  h('option', { value: 'score' }, '分数辅助'),
                ),
                actionButton('生成判比赛', () => startReviewJobAction('judge'), true),
                actionButton('生成环节复盘', () => startReviewJobAction('phases')),
                actionButton('提取证据候选', () => startReviewJobAction('evidence')),
              ),
              reviewJob === null
                ? null
                : h('div', { className: 'dwb-banner', style: { borderRadius: 8, padding: '8px 10px', marginBottom: 8, whiteSpace: 'pre-wrap', fontSize: 11 } }, reviewJobLabel(reviewJob.kind) + '：' + (reviewJob.state === 'running' ? '执行中…' : reviewJob.state === 'done' ? '完成' : '失败') + ' — ' + String(reviewJob.message ?? '')),
              judgeView,
              phaseView,
              candidateView,
            ),
      )

      return h(
        'div',
        { className: bodyClass() },
        h('div', { style: { display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: narrow ? 'wrap' : 'nowrap', minHeight: 0 } }, listPane, detailPane),
      )
    }

    const renderProjectsTab = () => {
      if (!hostReady) {
        return h(
          'div',
          { className: bodyClass() },
          h('div', { className: 'dwb-pane' }, h('div', { className: 'dwb-banner', style: { borderRadius: 8, padding: '10px 12px' } }, hostHint)),
        )
      }
      const projectList = projectsDetail.length > 0 ? projectsDetail : Array.isArray(state?.projects) ? state.projects : []
      const active = projectList.find(item => item.active === true) ?? projectList.find(item => item.id === state?.activeProjectId)
      const doneCount = tasks.filter(task => task.status === 'done').length
      const projectAction = async (body, message) => {
        setBusy(true)
        try {
          await api.projectAction(body)
          if (message !== undefined) setNotice(message)
          await reload()
          await refreshProjects()
        } catch (problem) {
          setError(String(problem?.message ?? problem))
        } finally {
          setBusy(false)
        }
      }
      return h(
        'div',
        { className: bodyClass() },
        h(
          'div',
          { className: 'dwb-pane' },
          h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '题目管理'),
          h('div', { className: 'dwb-muted', style: { marginBottom: 8 } }, '同一工作区可并行准备多个题目；每个题目有独立目录（bundle / 待办 / 稿件），切换后所有面板跟随。'),
          h(
            'div',
            { className: 'dwb-item', style: { marginBottom: 10 } },
            h(
              'div',
              { className: 'dwb-row' },
              h('input', {
                className: 'dwb-input',
                style: { flex: '1 1 240px' },
                placeholder: '新题目辩题（如：人工智能的发展利大于弊）',
                value: draft.projectTopic,
                onChange: event => setDraft(current => ({ ...current, projectTopic: event.target.value })),
              }),
              h('select', {
                className: 'dwb-input',
                value: draft.projectSide,
                onChange: event => setDraft(current => ({ ...current, projectSide: event.target.value })),
              }, h('option', { value: 'pro' }, '正方'), h('option', { value: 'con' }, '反方')),
              h('select', {
                className: 'dwb-input',
                value: draft.projectFormat,
                onChange: event => setDraft(current => ({ ...current, projectFormat: event.target.value })),
              }, h('option', { value: 'chinese' }, '华语'), h('option', { value: 'british' }, '英式'), h('option', { value: 'australian' }, '澳式')),
              h('button', {
                type: 'button',
                className: 'dwb-btn',
                'data-primary': '1',
                disabled: busy || draft.projectTopic.trim() === '',
                onClick: async () => {
                  const topic = draft.projectTopic.trim()
                  setDraft(current => ({ ...current, projectTopic: '' }))
                  await projectAction({ action: 'create', topic, side: draft.projectSide, format: draft.projectFormat }, '题目已创建并切换')
                },
              }, '新建题目'),
            ),
            h('div', { className: 'dwb-muted', style: { marginTop: 6 } }, `当前题目：${active?.topic ?? '（无）'}`),
          ),
          h(
            'div',
            { className: 'dwb-list' },
            projectList.length === 0 ? h('div', { className: 'dwb-muted' }, '还没有题目。') : null,
            projectList.map(item =>
              h(
                'div',
                { key: item.id, className: 'dwb-item', style: item.active ? { borderColor: 'rgba(124,140,255,0.55)' } : undefined },
                h(
                  'div',
                  { className: 'dwb-row' },
                  h('b', null, item.topic),
                  h('span', { className: 'dwb-chip' }, item.side === 'pro' ? '正方' : '反方'),
                  h('span', { className: 'dwb-muted' }, `节点 ${item.stats?.nodes ?? 0} · 证据 ${item.stats?.evidence ?? 0} · 就绪度 ${item.readiness ?? 0}`),
                  item.active ? h('span', { className: 'dwb-chip' }, '当前') : null,
                  h('span', { className: 'dwb-spacer' }),
                  item.active
                    ? null
                    : h('button', { type: 'button', className: 'dwb-btn', disabled: busy, onClick: () => switchToProject(item.id) }, '切换'),
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-quiet': '1',
                    disabled: busy,
                    onClick: () => {
                      const name = window.prompt('重命名题目', item.topic)
                      if (typeof name === 'string' && name.trim() !== '' && name.trim() !== item.topic) {
                        projectAction({ action: 'rename', project: item.id, topic: name.trim() }, '题目已重命名')
                      }
                    },
                  }, '重命名'),
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-danger': '1',
                    disabled: busy,
                    onClick: () => {
                      if (window.confirm(`删除题目「${item.topic}」？（数据目录保留，可找回）`)) {
                        projectAction({ action: 'delete', project: item.id }, '已删除题目')
                      }
                    },
                  }, '删除'),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'dwb-row', style: { marginTop: 14, marginBottom: 6 } },
            h('b', null, '当前题目备赛待办'),
            h('span', { className: 'dwb-muted' }, `未完成 ${tasks.length - doneCount}/${tasks.length}　（保存在题目目录 tasks.json）`),
          ),
          h(
            'div',
            { className: 'dwb-row', style: { marginBottom: 6 } },
            h('input', {
              className: 'dwb-input',
              style: { flex: '1 1 200px' },
              placeholder: '待办标题（如：补 3 张就业数据证据）',
              value: draft.taskTitle,
              onChange: event => setDraft(current => ({ ...current, taskTitle: event.target.value })),
            }),
            h('input', {
              className: 'dwb-input',
              style: { width: 124 },
              placeholder: '截止 YYYY-MM-DD',
              value: draft.taskDeadline,
              onChange: event => setDraft(current => ({ ...current, taskDeadline: event.target.value })),
            }),
            h('button', {
              type: 'button',
              className: 'dwb-btn',
              'data-primary': '1',
              disabled: busy || draft.taskTitle.trim() === '',
              onClick: async () => {
                try {
                  await api.taskAction({ action: 'add', title: draft.taskTitle.trim(), deadline: draft.taskDeadline.trim() || undefined })
                  setDraft(current => ({ ...current, taskTitle: '', taskDeadline: '' }))
                  await refreshProjects()
                } catch (problem) {
                  setError(String(problem?.message ?? problem))
                }
              },
            }, '添加待办'),
          ),
          h(
            'div',
            { className: 'dwb-list' },
            tasks.length === 0 ? h('div', { className: 'dwb-muted' }, '暂无待办。拆题后在「评估」页看缺口，把要补的事项记在这里。') : null,
            tasks.map(taskItem =>
              h(
                'div',
                { key: taskItem.id, className: 'dwb-item', style: taskItem.status === 'done' ? { opacity: 0.55 } : undefined },
                h(
                  'div',
                  { className: 'dwb-row' },
                  h('input', {
                    type: 'checkbox',
                    checked: taskItem.status === 'done',
                    onChange: async event => {
                      try {
                        await api.taskAction(
                          event.target.checked
                            ? { action: 'complete', taskId: taskItem.id }
                            : { action: 'update', taskId: taskItem.id, status: 'todo' },
                        )
                        await refreshProjects()
                      } catch (problem) {
                        setError(String(problem?.message ?? problem))
                      }
                    },
                  }),
                  h('span', { style: taskItem.status === 'done' ? { textDecoration: 'line-through' } : undefined }, taskItem.title),
                  taskItem.deadline ? h('span', { className: 'dwb-chip' }, `截止 ${taskItem.deadline}`) : null,
                  taskItem.nodeId ? h('span', { className: 'dwb-muted' }, taskItem.nodeId) : null,
                  h('span', { className: 'dwb-spacer' }),
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-quiet': '1',
                    onClick: async () => {
                      try {
                        await api.taskAction({ action: 'delete', taskId: taskItem.id })
                        await refreshProjects()
                      } catch (problem) {
                        setError(String(problem?.message ?? problem))
                      }
                    },
                  }, '删除'),
                ),
              ),
            ),
          ),
        ),
        h(
          'div',
          { className: 'dwb-side', style: { flexBasis: 300 } },
          h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '跨题总览'),
          h('div', { className: 'dwb-muted', style: { marginBottom: 8 } }, '按就绪度与未完成待办排；点题目切换。'),
          h(
            'div',
            { className: 'dwb-list' },
            projectList
              .slice()
              .sort((a, b) => Number(b.readiness ?? 0) - Number(a.readiness ?? 0))
              .map(item =>
                h(
                  'div',
                  { key: item.id, className: 'dwb-item', style: { cursor: 'pointer' }, onClick: () => switchToProject(item.id) },
                  h(
                    'div',
                    { className: 'dwb-row' },
                    h('b', null, item.topic),
                    item.active ? h('span', { className: 'dwb-chip' }, '当前') : null,
                  ),
                  h('div', { className: 'dwb-muted' }, `就绪度 ${item.readiness ?? 0}/100 · 未完成待办 ${item.taskCounts?.open ?? 0}${item.taskCounts?.nextDeadline ? ` · 最近截止 ${item.taskCounts.nextDeadline}` : ''}`),
                  h('div', { className: 'dwb-bar', style: { marginTop: 4 } }, h('i', { style: { width: `${Math.max(2, Number(item.readiness ?? 0))}%` } })),
                ),
              ),
          ),
        ),
      )
    }

    /* ---------- 证据卡 ---------- */
    const renderEvidence = () => {
      const keyword = search.trim().toLowerCase()
      const filtered =
        keyword === ''
          ? cards
          : cards.filter(card =>
              [card.title, card.content, card.originalText, card.source, ...(card.tags ?? [])]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(keyword),
            )
      const sharedKeyword = search.trim().toLowerCase()
      const filteredShared =
        sharedKeyword === ''
          ? libraryCards
          : libraryCards.filter(card =>
              [card.title, card.content, card.originalText, card.source, ...(card.tags ?? [])]
                .filter(Boolean)
                .join(' ')
                .toLowerCase()
                .includes(sharedKeyword),
            )
      return h(
        'div',
        { className: bodyClass() },
        h(
          'div',
          { className: 'dwb-pane' },
          h(
            'div',
            { className: 'dwb-seg', style: { marginBottom: 8 } },
            h(
              'button',
              { type: 'button', className: 'dwb-tabbtn', 'data-active': evidenceMode === 'mine' ? '1' : '0', onClick: () => setEvidenceMode('mine') },
              `本题证据 ${cards.length}`,
            ),
            h(
              'button',
              { type: 'button', className: 'dwb-tabbtn', 'data-active': evidenceMode === 'shared' ? '1' : '0', onClick: () => setEvidenceMode('shared') },
              `公共库 ${libraryCards.length}`,
            ),
          ),
          h('input', {
            className: 'dwb-input',
            style: { width: '100%', marginBottom: 8 },
            placeholder: evidenceMode === 'shared' ? '搜索公共证据库（标题 / 原文 / 来源 / 标签）' : '搜索证据（标题 / 原文 / 来源 / 标签）',
            value: search,
            onChange: event => setSearch(event.target.value),
          }),
          evidenceMode === 'shared'
            ? h(
                'div',
                { className: 'dwb-list' },
                hostReady ? null : h('div', { className: 'dwb-banner', style: { borderRadius: 8, padding: '8px 10px', marginBottom: 6 } }, hostHint),
                filteredShared.length === 0 && hostReady ? h('div', { className: 'dwb-muted' }, '公共库还是空的：用 debate_library(action=add) 入库，或在本页把本题证据「存入公共库」。') : null,
                filteredShared.map(card =>
                  h(
                    'div',
                    { key: card.id, className: 'dwb-item' },
                    h('b', null, card.title),
                    h('span', { className: 'dwb-chip', style: { marginLeft: 6 } }, `${card.type}｜可信度 ${card.credibility}/5`),
                    card.content ? h('div', { style: { marginTop: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' } }, card.content) : null,
                    card.originalText
                      ? h(
                          'div',
                          { className: expandedCards[card.id] === true ? 'dwb-quote' : 'dwb-quote dwb-clamp' },
                          `「${card.originalText}」`,
                        )
                      : null,
                    card.originalText && String(card.originalText).length > 90
                      ? h(
                          'button',
                          {
                            type: 'button',
                            className: 'dwb-btn',
                            'data-quiet': '1',
                            style: { marginTop: 2, padding: '1px 6px' },
                            onClick: () => toggleCardExpanded(card.id),
                          },
                          expandedCards[card.id] === true ? '收起原文' : '展开原文',
                        )
                      : null,
                    (card.tags ?? []).length > 0
                      ? h('div', null, (card.tags ?? []).map(tag => h('span', { key: tag, className: 'dwb-tag' }, tag)))
                      : null,
                    card.source ? h('div', { className: 'dwb-muted' }, `来源：${card.source}${card.year ? ` ${card.year}` : ''}`) : null,
                    h(
                      'div',
                      { className: 'dwb-row', style: { marginTop: 4 } },
                      h('button', {
                        type: 'button',
                        className: 'dwb-btn',
                        'data-primary': '1',
                        disabled: busy,
                        onClick: () => run('debate_library', { action: 'attach', cardId: card.id, nodeId: selectedId ?? undefined }, '已引用到本题'),
                      }, '引用到本题'),
                      h('button', {
                        type: 'button',
                        className: 'dwb-btn',
                        'data-danger': '1',
                        disabled: busy,
                        onClick: () => {
                          if (window.confirm('从公共库删除这张证据？（已引用到题目的副本不受影响）')) {
                            api.libraryAction({ action: 'delete', cardId: card.id }).then(() => api.library()).then(payload => setLibraryCards(payload.cards ?? [])).catch(problem => setError(String(problem?.message ?? problem)))
                          }
                        },
                      }, '删除'),
                    ),
                  ),
                ),
              )
            : null,
          evidenceMode === 'mine'
            ? h(
            'div',
            { className: 'dwb-list' },
            filtered.length === 0 ? h('div', { className: 'dwb-muted' }, '没有证据卡。') : null,
            filtered.map(card =>
              h('div', { key: card.id, className: 'dwb-item' },
                h('b', null, card.title),
                h('span', { className: 'dwb-chip', style: { marginLeft: 6 } }, `${card.type}｜可信度 ${card.credibility}/5`),
                card.originalText ? h('div', { className: 'dwb-muted' }, `「${card.originalText}」`) : null,
                card.source ? h('div', { className: 'dwb-muted' }, `来源：${card.source}${card.year ? ` ${card.year}` : ''}`) : null,
                h('div', { className: 'dwb-row', style: { marginTop: 4 } },
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    disabled: busy || selected === null,
                    onClick: () => run('debate_evidence', { action: 'link', nodeId: selected.id, cardId: card.id }, '已挂到选中节点'),
                  }, selected === null ? '先在树里选节点' : '挂到选中节点'),
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-quiet': '1',
                    title: '把这张证据放进公共证据库，供其它题目复用',
                    disabled: busy,
                    onClick: () => {
                      api
                        .libraryAction({ action: 'add', cards: [card] })
                        .then(() => api.library())
                        .then(payload => {
                          setLibraryCards(Array.isArray(payload.cards) ? payload.cards : [])
                          setNotice('已存入公共证据库')
                        })
                        .catch(problem => setError(String(problem?.message ?? problem)))
                    },
                  }, '存入公共库'),
                  h('button', {
                    type: 'button',
                    className: 'dwb-btn',
                    'data-danger': '1',
                    onClick: () => {
                      if (window.confirm('删除这张证据卡？')) run('debate_evidence', { action: 'delete', ids: [card.id] }, '已删除')
                    },
                  }, '删除'),
                ),
              ),
            ),
          )
            : null,
        ),
        evidenceMode === 'shared'
          ? null
          : h(
          'div',
          { className: 'dwb-side', style: { flexBasis: 270 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '新建证据卡'),
          h('label', { className: 'dwb-field' }, h('span', null, '标题'),
            h('input', { value: draft.evidenceTitle, onChange: event => setDraft(current => ({ ...current, evidenceTitle: event.target.value })) }),
          ),
          h('label', { className: 'dwb-field' }, h('span', null, '可引用原文 / 数据'),
            h('textarea', { value: draft.evidenceText, onChange: event => setDraft(current => ({ ...current, evidenceText: event.target.value })) }),
          ),
          h('label', { className: 'dwb-field' }, h('span', null, '来源'),
            h('input', { value: draft.evidenceSource, onChange: event => setDraft(current => ({ ...current, evidenceSource: event.target.value })) }),
          ),
          h('div', { className: 'dwb-row' },
            h('label', { className: 'dwb-field', style: { flex: 1 } }, h('span', null, '类型'),
              h('select', { value: draft.evidenceType, onChange: event => setDraft(current => ({ ...current, evidenceType: event.target.value })) },
                h('option', { value: 'data' }, '数据'), h('option', { value: 'case' }, '案例'), h('option', { value: 'theory' }, '机理')),
            ),
            h('label', { className: 'dwb-field', style: { flex: 1 } }, h('span', null, '可信度'),
              h('select', { value: draft.evidenceCred, onChange: event => setDraft(current => ({ ...current, evidenceCred: event.target.value })) },
                [1, 2, 3, 4, 5].map(value => h('option', { key: value, value: String(value) }, String(value)))),
            ),
          ),
          h('button', {
            type: 'button',
            className: 'dwb-btn',
            'data-primary': '1',
            disabled: busy || draft.evidenceTitle.trim() === '' || draft.evidenceText.trim() === '',
            onClick: async () => {
              await run('debate_evidence', {
                action: 'add',
                cards: [{
                  title: draft.evidenceTitle.trim(),
                  originalText: draft.evidenceText.trim(),
                  content: draft.evidenceText.trim(),
                  source: draft.evidenceSource.trim(),
                  type: draft.evidenceType,
                  credibility: Number(draft.evidenceCred),
                  applicableSide: bundle?.project?.side ?? 'both',
                }],
              }, '证据卡已新建')
              setDraft(current => ({ ...current, evidenceTitle: '', evidenceText: '', evidenceSource: '' }))
            },
          }, '新建证据卡'),
        ),
      )
    }

    /* ---------- 攻防 ---------- */
    const renderAttack = () =>
      h(
        'div',
        { className: bodyClass() },
        h(
          'div',
          { className: 'dwb-pane' },
          selected === null
            ? h('div', { className: 'dwb-muted' }, '先在「论证树」里选一个论点节点。')
            : h(
                'div',
                { className: 'dwb-list' },
                (selectedBox?.attacks ?? []).length === 0 ? h('div', { className: 'dwb-muted' }, '这个节点还没有攻击预判。至少覆盖事实 / 逻辑 / 价值三类。') : null,
                (selectedBox?.attacks ?? []).map(attack =>
                  h('div', { key: attack.id, className: 'dwb-item' },
                    h('b', null, `${ATTACK_TYPES.find(item => item.value === attack.type)?.label ?? attack.type}｜威胁 ${attack.threatLevel}/5`),
                    h('div', null, attack.content),
                    h('div', { className: 'dwb-muted', style: { marginTop: 4, marginBottom: 2 } },
                      attack.threatLevel >= 4 && !attack.defenseStrategy ? '⚠ 高威胁攻击必须有防守策略' : '防守策略'),
                    h('textarea', {
                      defaultValue: attack.defenseStrategy ?? '',
                      placeholder: '写清楚「对方这么说，我方怎么答」',
                      style: {
                        width: '100%',
                        minHeight: 46,
                        font: 'inherit',
                        fontSize: 12,
                        borderRadius: 6,
                        border: '1px solid rgba(150,165,220,0.25)',
                        background: 'var(--dsw-alias-bg-layer-2, #161926)',
                        color: 'inherit',
                        padding: 5,
                      },
                      onBlur: event =>
                        run('debate_attack', { action: 'update_attack', nodeId: selected.id, attackId: attack.id, attack: { defenseStrategy: event.target.value } }, '防守策略已保存'),
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dwb-btn',
                      'data-danger': '1',
                      style: { marginTop: 4 },
                      onClick: () => run('debate_attack', { action: 'remove_attack', nodeId: selected.id, attackId: attack.id }, '已删除攻击'),
                    }, '删除'),
                  ),
                ),
              ),
        ),
        h(
          'div',
          { className: 'dwb-side', style: { flexBasis: 260 } },
          h('div', { style: { fontWeight: 600, marginBottom: 6 } }, '新增攻击路径'),
          h('label', { className: 'dwb-field' }, h('span', null, '类型'),
            h('select', { value: draft.attackType, onChange: event => setDraft(current => ({ ...current, attackType: event.target.value })) },
              ATTACK_TYPES.map(item => h('option', { key: item.value, value: item.value }, item.label))),
          ),
          h('label', { className: 'dwb-field' }, h('span', null, '对方会怎么打'),
            h('textarea', { value: draft.attackContent, onChange: event => setDraft(current => ({ ...current, attackContent: event.target.value })) }),
          ),
          h('label', { className: 'dwb-field' }, h('span', null, `威胁度：${draft.attackThreat}`),
            h('input', { type: 'range', min: 1, max: 5, value: draft.attackThreat, onChange: event => setDraft(current => ({ ...current, attackThreat: Number(event.target.value) })) }),
          ),
          h('label', { className: 'dwb-field' }, h('span', null, '防守策略（高威胁必填）'),
            h('textarea', { value: draft.attackDefense, onChange: event => setDraft(current => ({ ...current, attackDefense: event.target.value })) }),
          ),
          h('button', {
            type: 'button',
            className: 'dwb-btn',
            'data-primary': '1',
            disabled: busy || selected === null || draft.attackContent.trim() === '',
            onClick: async () => {
              await run('debate_attack', {
                action: 'add_attack',
                nodeId: selected.id,
                attack: {
                  type: draft.attackType,
                  content: draft.attackContent.trim(),
                  threatLevel: draft.attackThreat,
                  defenseStrategy: draft.attackDefense.trim(),
                },
              }, '攻击路径已添加')
              setDraft(current => ({ ...current, attackContent: '', attackDefense: '' }))
            },
          }, '添加攻击'),
        ),
      )

    /* ---------- 评估 ---------- */
    const renderEvaluate = () => {
      const scores = analysis?.scores ?? {}
      const dimensions = [
        ['逻辑性', scores.logic],
        ['证据力', scores.evidence],
        ['说服力', scores.persuasiveness],
        ['创新性', scores.innovation],
        ['抗反驳', scores.counterResilience],
      ]
      const gaps = (analysis?.gaps ?? []).filter(item => item.level !== 'info')
      return h(
        'div',
        { className: 'dwb-pane' },
        h(
          'div',
          { className: 'dwb-row', style: { alignItems: 'flex-start', gap: 20 } },
          h(
            'div',
            { style: { width: 250 } },
            dimensions.map(([label, value]) =>
              h('div', { key: label, className: 'dwb-dim' },
                h('span', null, label),
                h('div', { className: 'dwb-bar' }, h('i', { style: { width: `${Number(value ?? 0)}%` } })),
                h('span', null, String(Number(value ?? 0))),
              ),
            ),
            h('div', { className: 'dwb-muted', style: { marginTop: 8 } }, `综合 ${Number(scores.overall ?? 0)}/100 · 阻塞缺口 ${Number(analysis?.blocking ?? 0)} 项`),
            h('button', {
              type: 'button',
              className: 'dwb-btn',
              style: { marginTop: 8 },
              disabled: busy,
              onClick: async () => {
                try {
                  const payload = await api.tool('debate_evaluate', { action: 'questions' })
                  setQuestions((payload.result?.questions ?? []).slice(0, 5).map(item => item.question))
                } catch (problem) {
                  setError(String(problem.message ?? problem))
                }
              },
            }, '生成苏格拉底追问'),
            questions.length === 0
              ? null
              : h('div', { style: { marginTop: 8 } },
                  h('div', { className: 'dwb-muted' }, '追问候选：'),
                  questions.map((question, index) => h('div', { key: index, className: 'dwb-gap' }, `${index + 1}. ${question}`)),
                ),
          ),
          h(
            'div',
            { style: { flex: 1, minWidth: 0 } },
            h('div', { className: 'dwb-muted', style: { marginBottom: 4 } }, '最该补的缺口'),
            gaps.length === 0
              ? h('div', { className: 'dwb-muted' }, '没有必须补或建议补的缺口。')
              : gaps.slice(0, 10).map((item, index) => h('div', { key: `${item.code}-${index}`, className: 'dwb-gap', 'data-level': item.level }, item.message)),
          ),
        ),
      )
    }

    /* ---------- 稿件 ---------- */
    const renderManuscript = () =>
      h(
        'div',
        { className: 'dwb-pane', style: { display: 'flex', flexDirection: 'column', gap: 8 } },
        h(
          'div',
          { className: 'dwb-row' },
          h('select', { className: 'dwb-input', value: draft.manuscriptKind, onChange: event => setDraft(current => ({ ...current, manuscriptKind: event.target.value })) },
            h('option', { value: 'opening' }, '一辩稿'), h('option', { value: 'closing' }, '结辩稿'), h('option', { value: 'rebuttal' }, '驳论清单')),
          h('button', {
            type: 'button',
            className: 'dwb-btn',
            'data-primary': '1',
            disabled: busy,
            onClick: async () => {
              try {
                const payload = await api.tool('debate_manuscript', { action: 'compose', kind: draft.manuscriptKind, save: false })
                setPreview(payload.result?.content ?? '')
              } catch (problem) {
                setError(String(problem.message ?? problem))
              }
            },
          }, '生成预览'),
          h('button', {
            type: 'button',
            className: 'dwb-btn',
            disabled: busy,
            onClick: () => run('debate_manuscript', { action: 'compose', kind: draft.manuscriptKind }, '稿件已保存进项目'),
          }, '生成并保存'),
          h('a', { className: 'dwb-btn', href: api.exportUrl(), download: '' }, '导出 bundle'),
        ),
        preview === ''
          ? h('div', { className: 'dwb-muted' }, '点「生成预览」按当前论证树组装稿件；〔待补〕处需要继续补写。')
          : h('pre', { className: 'dwb-pre' }, preview),
      )

    const content =
      tab === 'tree'
        ? renderTree()
        : tab === 'topic'
          ? renderTopicTab()
          : tab === 'evidence'
          ? renderEvidence()
          : tab === 'attack'
            ? renderAttack()
            : tab === 'evaluate'
              ? renderEvaluate()
              : tab === 'review'
                ? renderReviewTab()
                : tab === 'projects'
                  ? renderProjectsTab()
                  : renderManuscript()

    if (state !== null && state.snapshot !== undefined && state.snapshot.active !== true) {
      return h(
        'div',
        { className: 'dwb-shell', style: { padding: 20 } },
        h('div', { style: { fontWeight: 650, marginBottom: 6 } }, '还没有激活的辩论项目'),
        h('div', { className: 'dwb-muted' }, '在对话里说「开始备赛：<辩题>，我方持正」，让模型调用 debate_project(action=create) 建立项目；之后这个面板会自动加载项目数据。'),
      )
    }

    return h(
      'div',
      { className: 'dwb-shell', ref: rootRef },
      top(),
      hostReady
        ? null
        : h(
            'div',
            { className: 'dwb-banner', style: { background: 'rgba(255,159,10,0.18)', color: '#ffd08a' } },
            '界面已更新，但宿主端还是旧版本：题目切换 / 新建题目 / 公共库要**完全退出 DSH 重启**后才可用。',
          ),
      linkSource === null
        ? null
        : h(
            'div',
            { className: 'dwb-banner' },
            '连线模式：点击任意节点建立「来源 → 目标」连线（可以跨层级，只要不成环）；点空白处取消。也可以直接从节点左右端口拖拽连线。',
          ),
      content,
      h(
        'div',
        { className: 'dwb-foot' },
        h('span', null, `节点 ${nodes.length} · 证据 ${cards.length} 张 · 同步 ${syncedAt ?? '—'}`),
        error === null ? null : h('span', { className: 'dwb-error' }, `错误：${error}`),
        notice === null ? null : h('span', null, notice),
        busy ? h('span', null, '处理中…') : null,
      ),
    )
  }
}
