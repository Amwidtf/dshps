/**
 * Local render harness for the dshps Web client bundle.
 *
 * Loads client.js in a VM with a fake `window.__ModuleLoader__`, a fake React
 * (element objects + hook stubs, effects not run), then renders the registered
 * footer panel, the dshps settings page and its error boundary to plain strings.
 * This catches render-time exceptions without a browser.
 *
 * Run: node tools/test-client.mjs
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

let passed = 0
let failed = 0

function test(label, fn) {
  try {
    fn()
    passed++
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---- fake React -----------------------------------------------------------
const Fragment = Symbol('Fragment')
const EMPTY = Symbol('empty')
let currentStates = []
let hookIndex = 0
let pendingSeed
function resetHooks() { hookIndex = 0 }
function seedHooks(seeds) { pendingSeed = seeds }
const FakeReact = {
  Fragment,
  Component: class Component {
    constructor(props) { this.props = props; this.state = {} }
    setState(next) { this.state = { ...this.state, ...(typeof next === 'function' ? next(this.state) : next) } }
  },
  createElement(type, props, ...children) {
    const normalized = { ...(props || {}) }
    const kids = children.length <= 1 ? children[0] : children
    if (kids !== undefined) normalized.children = kids
    return { type, props: normalized }
  },
  useState(initial) {
    const index = hookIndex++
    if (!(index in currentStates)) currentStates[index] = typeof initial === 'function' ? initial() : initial
    return [currentStates[index], (value) => { currentStates[index] = typeof value === 'function' ? value(currentStates[index]) : value }]
  },
  useEffect() { hookIndex++ },
  useMemo(fn) { return fn() },
  useRef(initial) { const index = hookIndex++; if (!(index in currentStates)) currentStates[index] = { current: initial }; return currentStates[index] },
}
FakeReact.Component.prototype.isReactComponent = true

// ---- renderer -------------------------------------------------------------
function enterComponent() {
  currentStates = pendingSeed ? [...pendingSeed] : []
  pendingSeed = undefined
  resetHooks()
}

function renderNode(node, t) {
  if (node === null || node === undefined || node === false || node === true || node === EMPTY) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map((child) => renderNode(child, t)).join('')
  if (typeof node !== 'object' || node.type === undefined) return ''
  const { type, props } = node
  if (typeof type === 'function') {
    if (type.prototype && type.prototype.isReactComponent) {
      const instance = new type(props)
      instance.props = props
      return renderNode(instance.render(), t)
    }
    enterComponent()
    return renderNode(type({ ...props, t }), t)
  }
  return renderNode(props?.children, t)
}

// ---- load the bundle ------------------------------------------------------
const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
let registration
const sandbox = {
  window: {
    __ModuleLoader__: { load(reg) { registration = reg } },
    innerWidth: 1280,
    innerHeight: 900,
    addEventListener() {},
    removeEventListener() {},
    setTimeout() { return 0 },
    clearTimeout() {},
    setInterval() { return 0 },
  },
  document: { hidden: false, addEventListener() {}, removeEventListener() {} },
  console,
  Date,
  Math,
  JSON,
  Number,
  String,
  Object,
  Array,
  Set,
  Map,
  Promise,
  Intl,
  URL,
}
sandbox.globalThis = sandbox
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: 'client.js' })

assert.ok(registration, 'module loader registration captured')
const bundle = registration.factory((name) => {
  if (name === 'react') return FakeReact
  throw new Error(`unexpected require(${name})`)
})

const slots = []
const ctx = {
  effect(fn) { fn() },
  locale: { register() { return () => {} }, bind() { return (key) => key } },
  get(key) { return key === 'connection' ? { rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) } } : undefined },
  slots: {
    inject(name, callback) { callback(); return () => {} },
    register(options, component) { slots.push({ options, component }); return () => {} },
  },
}
bundle.apply(ctx)

const SHORT_LABELS = { short5h: '5h', shortWeek: '周', shortMonth: '月', overview: '总览' }
const t = (key) => SHORT_LABELS[key] || key
const findSlot = (id) => slots.find((slot) => slot.options.id === id)

test('client bundle registers the footer panel and the dshps settings section', () => {
  assert.ok(Array.isArray(bundle.inject))
  const footer = findSlot('dshp-quota')
  const settings = findSlot('dshps')
  assert.ok(footer, 'footer panel registered')
  assert.equal(footer.options.name, 'sidebar.footer.action')
  assert.ok(settings, 'settings section registered')
  assert.equal(settings.options.name, 'settings.section')
})

test('footer panel renders compact rows from a snapshot', () => {
  const footer = findSlot('dshp-quota')
  const snapshot = {
    generatedAt: Date.now(),
    ttlMs: 60000,
    providers: [
      { id: 'pi-ai:kimi-coding', vendor: 'kimi-code', label: 'kimi-coding', status: 'ok', kind: 'quota', plan: { name: 'Kimi Code' }, windows: [{ key: 'weekly', label: '每周', remainingPercent: 97 }], balances: [], team: { isTeam: 'unknown' }, totalUsage: { totalPct: 16.12, kimiPct: 11.12, codePct: 5, resetsAt: Date.now() + 86400000 } },
      { id: 'pi-ai:minimax-cn', vendor: 'minimax', label: 'minimax-cn', status: 'ok', kind: 'quota', windows: [{ key: 'interval', label: '文本 5 小时', remainingPercent: 100 }], balances: [] },
      { id: 'pi-ai:zai-coding-cn', vendor: 'zhipu', label: 'zai-coding-cn', status: 'ok', kind: 'balance', balances: [{ currency: 'CNY', available: 12.5 }] },
      { id: 'deepseek-official', vendor: 'deepseek', label: 'DeepSeek API', status: 'ok', kind: 'balance', balances: [{ currency: 'CNY', available: 508.5 }] },
    ],
  }
  seedHooks([snapshot, false, null, false])
  const element = footer.component({ wide: true, t, rpc: { call: async () => ({ ok: true, value: { ok: true, snapshot } }) } })
  const text = renderNode(element, t)
  assert.ok(text.includes('Kimi'), 'kimi row')
  assert.ok(text.includes('MiniMax'), 'minimax row')
  assert.ok(text.includes('智谱 GLM'), 'zhipu row')
  assert.ok(text.includes('DeepSeek'), 'deepseek row')
  assert.ok(text.includes('5h'), '5h remaining shown')
  assert.ok(text.includes('周'), 'weekly remaining shown')
  assert.ok(text.includes('月'), 'monthly remaining shown')
})

test('provider detail renders the total usage block (not the booster as monthly)', () => {
  const footer = findSlot('dshp-quota')
  const snapshot = {
    generatedAt: Date.now(),
    ttlMs: 60000,
    providers: [
      {
        id: 'pi-ai:kimi-coding',
        vendor: 'kimi-code',
        label: 'kimi-coding',
        status: 'ok',
        kind: 'quota',
        plan: { name: 'Kimi Code' },
        windows: [{ key: 'booster', label: '加速包', limit: 100, used: 0, money: 'CNY' }],
        balances: [],
        totalUsage: { totalPct: 16.12, kimiPct: 11.12, codePct: 5, resetsAt: Date.now() + 86400000 },
      },
    ],
  }
  seedHooks([snapshot, false, null, true, { left: 8, bottom: 8 }, 1])
  const element = footer.component({ wide: true, t, rpc: { call: async () => ({ ok: true, value: { ok: true, snapshot } }) } })
  const text = renderNode(element, t)
  assert.ok(text.includes('totalUsage'), 'total usage block rendered')
  assert.ok(text.includes('16.12%') || text.includes('16.12'), 'total percentage rendered')
})

test('popover opens on the overview page by default', () => {
  const footer = findSlot('dshp-quota')
  const snapshot = {
    generatedAt: Date.now(),
    ttlMs: 60000,
    providers: [
      { id: 'pi-ai:kimi-coding', vendor: 'kimi-code', label: 'kimi-coding', status: 'ok', plan: { name: 'Allegretto' }, windows: [{ key: 'weekly', label: '每周', remainingPercent: 97 }, { key: 'interval', label: '5 小时', remainingPercent: 100 }], totalUsage: { totalPct: 16.12, kimiPct: 11.12, codePct: 5 } },
      { id: 'pi-ai:zai-coding-cn', vendor: 'zhipu', label: 'zai-coding-cn', status: 'ok', windows: [{ key: 'interval', label: '5 小时额度', usedPercent: 1 }, { key: 'weekly', label: '每周额度', usedPercent: 1 }] },
    ],
  }
  seedHooks([snapshot, false, null, true, { left: 8, bottom: 8 }, 0])
  const element = footer.component({ wide: true, t, rpc: { call: async () => ({ ok: true, value: { ok: true, snapshot } }) } })
  const text = renderNode(element, t)
  assert.ok(text.includes('overview'), 'overview tab is first')
  assert.ok(text.includes('总览'), 'overview label')
  assert.ok(text.includes('Allegretto'), 'overview rows show plans')
  assert.ok(text.includes('5h 100%'), 'overview rows show window metrics')
})

test('settings page renders headings and a status line', () => {
  seedHooks(['loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('settingsTitle'), 'page heading')
  assert.ok(text.includes('settingsQuotaTitle'), 'quota card')
  assert.ok(text.includes('settingsStatus'), 'diagnostic status line')
})

test('settings page renders the GLM team fields in the ready phase', () => {
  seedHooks(['ready', null, 7, null, { organization: 'org-1', project: 'proj-1', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('settingsOrg'), 'organisation field label')
  assert.ok(text.includes('settingsProject'), 'project field label')
  assert.ok(text.includes('settingsSave'), 'save button')
  assert.ok(text.includes('rev 7'), 'revision shown in the status line')
})

test('page boundary renders an error instead of a blank page', () => {
  const settings = findSlot('dshps')
  const boundaryElement = settings.component({ t, rpc: undefined, close() {} })
  const boundaryType = boundaryElement.type
  const instance = new boundaryType({ t, children: null })
  instance.state = { error: new Error('boom-render') }
  const text = renderNode(instance.render(), t)
  assert.ok(text.includes('settingsPageError'), 'boundary fallback shown')
  assert.ok(text.includes('boom-render'), 'error message shown')
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
