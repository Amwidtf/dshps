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

test('client bundle registers the quota footer, the floating layer and the dshps settings section', () => {
  assert.ok(Array.isArray(bundle.inject))
  const footer = findSlot('dshp-quota')
  const floating = findSlot('dshps-floating')
  const settings = findSlot('dshps')
  assert.ok(footer, 'quota footer panel registered')
  assert.equal(footer.options.name, 'sidebar.footer.action')
  assert.ok(floating, 'floating layer registered')
  assert.equal(floating.options.name, 'shell.overlay')
  assert.equal(findSlot('dshp-net'), undefined, 'the old sidebar net icon is gone')
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
  seedHooks(['quota', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('settingsTitle'), 'page heading')
  assert.ok(text.includes('settingsQuotaTitle'), 'quota card')
  assert.ok(text.includes('settingsStatus'), 'diagnostic status line')
  assert.ok(text.includes('tabQuota') && text.includes('tabNet') && text.includes('tabModels') && text.includes('floatTab'), 'section tabs')
})

test('settings page collapses its config sections by default', () => {
  seedHooks(['quota', 'ready', null, 7, null, { organization: 'org-1', project: 'proj-1', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('settingsGlmTeam'), 'GLM section header')
  assert.ok(text.includes('kimiTokenTitle'), 'Kimi section header')
  assert.ok(text.includes('settingsDetected'), 'detected-providers section header')
  assert.ok(!text.includes('settingsOrg'), 'GLM fields stay collapsed by default')
  assert.ok(!text.includes('settingsSave'), 'section actions stay collapsed by default')
  assert.ok(text.includes('rev 7'), 'revision shown in the status line')
})

test('net env warnings are localized from Host warning codes', () => {
  const api = bundle.__test
  const translate = (key) => {
    if (key === 'netWarnPortFallback') return '端口 {configured} → {actual}'
    if (key === 'netWarnNoProxy') return '绕过：{hosts}'
    return key
  }
  const texts = api.netEnvWarningTexts({
    warning: 'raw English fallback',
    warningCodes: [
      { code: 'port-fallback', params: { configured: 17890, actual: 17891 } },
      { code: 'restart-required' },
      { code: 'no-proxy-bypass', params: { hosts: ['api.example.test'] } },
    ],
  }, translate)
  assert.equal(texts.length, 3)
  assert.ok(texts[0].includes('17890') && texts[0].includes('17891'), 'port fallback is localized with params')
  assert.equal(texts[1], 'netWarnRestart')
  assert.ok(texts[2].includes('api.example.test'), 'NO_PROXY hosts are localized')
  const fallback = api.netEnvWarningTexts({ warning: 'raw English fallback' }, translate)
  assert.equal(fallback.length, 1)
  assert.equal(fallback[0], 'raw English fallback')
})

test('settings page renders the network tab content', () => {
  seedHooks(['net', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('netTitle'), 'network heading')
  assert.ok(text.includes('netProxies'), 'proxy list card')
  assert.ok(text.includes('netMonitor'), 'monitor card')
})

test('proxy routing shows each proxy with its provider tags and the direct summary', () => {
  const api = bundle.__test
  const config = {
    defaultProxy: 'proxy-work',
    port: 17890,
    proxies: [
      { id: 'proxy-work', label: '公司代理', url: 'http://127.0.0.1:7890', username: '', password: '', enabled: true },
      { id: 'proxy-home', label: '家庭代理', url: 'http://127.0.0.1:7891', username: '', password: '', enabled: true },
    ],
    providers: {
      openai: { proxy: 'proxy-work', domains: ['auth.openai.com'] },
      anthropic: { proxy: 'proxy-home', domains: [] },
    },
  }
  const providerItems = [
    { id: 'openai', label: 'OpenAI', detail: 'api.openai.com' },
    { id: 'anthropic', label: 'Anthropic', detail: 'api.anthropic.com' },
    { id: 'deepseek', label: 'DeepSeek', detail: 'api.deepseek.com' },
  ]
  seedHooks(['', '', true, ''])
  const element = FakeReact.createElement(api.ProxyRoutingCard, {
    t,
    config,
    providerItems,
    runtimeProxies: [{ id: 'proxy-work', health: { ok: true, ms: 42 } }],
    busy: false,
    testing: '',
    onMutate() {},
    onAddProxy() { return 'proxy-new' },
    onUpdateProxy() {},
    onRemoveProxy() {},
    onSetProvider() {},
    onTestProxy() {},
    onSave() {},
    dirty: true,
  })
  const text = renderNode(element, t)
  assert.ok(text.includes('公司代理'), 'first proxy name tag')
  assert.ok(text.includes('家庭代理'), 'second proxy name tag')
  assert.ok(text.includes('netProxyDefaultBadge'), 'default-egress badge')
  assert.ok(text.includes('netListenPort'), 'editable listen port')
  assert.ok(text.includes('netProxyOk'), 'proxy health badge')
  assert.ok(text.includes('OpenAI') && text.includes('Anthropic'), 'assigned provider tags')
  assert.ok(text.includes('netRouteAdd'), 'add-provider action per proxy')
  assert.ok(text.includes('netSave') && text.includes('netUnsaved'), 'in-card save action and unsaved marker')
  assert.ok(text.includes('netDirectProviders'), 'direct-provider summary')
  assert.ok(text.includes('deepseek') || text.includes('DeepSeek'), 'direct provider listed')
})

test('settings page renders the sign-in tab content', () => {
  seedHooks(['models', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('modelsTitle'), 'sign-in heading')
  assert.ok(text.includes('modelsChatgpt'), 'chatgpt card')
  assert.ok(text.includes('modelsFlows'), 'flows card')
})

function floatingState(overrides = {}) {
  const windows = {
    monitor: { open: false, locked: true, collapsed: false, x: 0.6, y: 0.2, w: 380, h: 300, z: 1 },
    audit: { open: false, locked: true, collapsed: false, x: 0.52, y: 0.5, w: 480, h: 320, z: 2 },
    quota: { open: false, locked: true, collapsed: false, x: 0.72, y: 0.16, w: 380, h: 320, z: 3 },
    models: { open: false, locked: true, collapsed: false, x: 0.66, y: 0.46, w: 400, h: 280, z: 4 },
  }
  return JSON.parse(JSON.stringify({
    version: 1,
    revision: 0,
    enabled: true,
    fabLocked: false,
    fab: { x: 0.94, y: 0.6 },
    satellites: { monitor: true, audit: true, quota: true, models: true },
    windows,
    nextZ: 5,
    ...overrides,
  }))
}

function floatingSnapshot(state) {
  return { state, revision: state.revision || 0, loading: false, saving: false, error: null, warnings: [] }
}

function renderFloating(state, { expanded = false } = {}) {
  const store = bundle.__test.store
  store.__setForTest(state)
  const slot = findSlot('dshps-floating')
  assert.ok(slot, 'floating layer slot')
  seedHooks([floatingSnapshot(state), undefined, { w: 1280, h: 900 }, expanded, null, { current: null }, { current: null }, { current: false }, undefined, undefined])
  return renderNode(slot.component({}), t)
}

test('floating layer geometry helpers clamp to the viewport and collapse to the title bar', () => {
  const api = bundle.__test
  const viewport = { w: 1280, h: 900 }
  const clamped = api.clampGeometry({ left: -40, top: 1200, w: 400, h: 300 }, viewport, false)
  assert.equal(clamped.left, 0)
  assert.equal(clamped.top, 600, 'bottom edge can never pass the page bottom')
  const collapsed = api.clampGeometry({ left: 300, top: 880, w: 400, h: 300 }, viewport, true)
  assert.equal(collapsed.top, 900 - 34, 'a collapsed window keeps its title bar visible')
  const geometry = api.geometryFromWindow({ x: 0.5, y: 0.5, w: 400, h: 300, collapsed: false }, viewport)
  assert.ok(geometry.left >= 0 && geometry.top >= 0)
  assert.ok(geometry.left + geometry.w <= viewport.w)
  assert.ok(geometry.top + geometry.h <= viewport.h)
  const assertSatLayout = (positions, count, label) => {
    assert.equal(positions.length, count, `${label}: count`)
    const unique = new Set(positions.map((position) => `${Math.round(position.left)}:${Math.round(position.top)}`))
    assert.ok(unique.size >= Math.min(count, 3), `${label}: positions are distinct`)
    for (const position of positions) {
      assert.ok(position.left >= 0 && position.left + 38 <= viewport.w, `${label}: inside width`)
      assert.ok(position.top >= 0 && position.top + 38 <= viewport.h, `${label}: inside height`)
    }
    for (let index = 0; index < positions.length; index += 1) {
      for (let other = index + 1; other < positions.length; other += 1) {
        const distance = Math.hypot(positions[index].left - positions[other].left, positions[index].top - positions[other].top)
        assert.ok(distance >= 37, `${label}: satellites ${index}/${other} do not overlap (${distance.toFixed(1)}px)`)
      }
    }
  }
  assertSatLayout(api.ringLayout({ left: 1000, top: 500 }, 4, viewport), 4, 'right edge')
  assertSatLayout(api.ringLayout({ left: 8, top: 8 }, 4, viewport), 4, 'top-left corner')
  assertSatLayout(api.ringLayout({ left: 8, top: 8 }, 12, viewport), 12, 'top-left corner, 12 satellites')
  assertSatLayout(api.ringLayout({ left: 1100, top: 400 }, 16, viewport), 16, 'crowded right edge, 16 satellites')
  assertSatLayout(api.ringLayout({ left: 620, top: 430 }, 8, viewport), 8, 'centered, 8 satellites')

  // The available angle is chosen from the FAB's distance to the edges, not
  // from the page center: 360° open, 180° against one edge, 90° in a corner.
  const topEdge = api.ringLayout({ left: 600, top: 8 }, 5, viewport)
  assert.ok(topEdge.every((position) => position.top > 8), 'top edge opens downward')
  const topEdgeRadii = topEdge.map((position) => Math.hypot(position.left + 19 - (600 + 24), position.top + 19 - (8 + 24)))
  assert.ok(Math.max(...topEdgeRadii) - Math.min(...topEdgeRadii) < 1.5, 'a few satellites share one clean arc')
  const corner4 = api.ringLayout({ left: 8, top: 8 }, 4, viewport)
  const corner4Radii = corner4.map((position) => Math.hypot(position.left + 19 - 32, position.top + 19 - 32))
  assert.ok(Math.max(...corner4Radii) - Math.min(...corner4Radii) < 1.5, 'corner satellites stay on one arc')
  assert.ok(corner4Radii.every((radius) => radius > 80), 'the corner arc grows so the balls do not touch')
  const leftEdge = api.ringLayout({ left: 8, top: 400 }, 5, viewport)
  assert.ok(leftEdge.every((position) => position.left > 8), 'left edge opens to the right')
  const corner = api.ringLayout({ left: 8, top: 8 }, 12, viewport)
  assert.ok(corner.every((position) => position.left > 8 && position.top > 8), 'top-left corner opens down-right')
  const cornerFar = corner.filter((position) => Math.hypot(position.left + 19 - 32, position.top + 19 - 32) > 150)
  assert.ok(cornerFar.length > 0, 'a dozen satellites use multiple rings')
  const bottomRight = api.ringLayout({ left: viewport.w - 56, top: viewport.h - 56 }, 4, viewport)
  const bottomRightCenter = { x: viewport.w - 56 + 24, y: viewport.h - 56 + 24 }
  assert.ok(bottomRight.every((position) => position.left + 19 <= bottomRightCenter.x && position.top + 19 <= bottomRightCenter.y), 'bottom-right corner opens up-left')
  const tiny = api.ringLayout({ left: 8, top: 8 }, 12, { w: 240, h: 160 })
  assert.equal(tiny.length, 12)
  assert.ok(tiny.every((position) => position.left >= 0 && position.top >= 0 && position.left + 38 <= 240 && position.top + 38 <= 160), 'tiny viewport falls back to an inside grid')
})

test('floating ball renders and its ring shows the configured satellite balls', () => {
  const closed = renderFloating(floatingState())
  assert.ok(closed.includes('floatFabLabel'), 'floating ball rendered')
  assert.ok(closed.includes('floatLock'), 'hover lock control rendered')
  assert.ok(closed.includes('floatHideFab'), 'hover close control rendered')
  const expanded = renderFloating(floatingState(), { expanded: true })
  for (const key of ['floatMonitorTitle', 'floatAuditTitle', 'floatQuotaTitle', 'floatModelsTitle']) {
    assert.ok(expanded.includes(key), `satellite ${key} rendered`)
  }
  const onlyMonitor = renderFloating(floatingState({ satellites: { monitor: true, audit: false, quota: false, models: false } }), { expanded: true })
  assert.ok(onlyMonitor.includes('floatMonitorTitle'))
  assert.ok(!onlyMonitor.includes('floatAuditTitle'), 'hidden satellite not rendered')
})

test('a floating window renders its title and collapse hides the body while keeping the title', () => {
  const open = floatingState()
  open.windows.monitor.open = true
  open.windows.monitor.collapsed = false
  const expandedText = renderFloating(open)
  assert.ok(expandedText.includes('floatMonitorTitle'), 'window title rendered')
  assert.ok(expandedText.includes('loading'), 'monitor body rendered')
  const collapsed = floatingState()
  collapsed.windows.monitor.open = true
  collapsed.windows.monitor.collapsed = true
  const collapsedText = renderFloating(collapsed)
  assert.ok(collapsedText.includes('floatMonitorTitle'), 'collapsed window keeps the title')
  assert.ok(!collapsedText.includes('loading'), 'collapsed window hides the body')
})

test('settings floating tab renders the ball switch, satellite switches and reset', () => {
  const store = bundle.__test.store
  store.__setForTest(floatingState())
  seedHooks(['float', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null, undefined])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {}, store })
  const text = renderNode(element, t)
  assert.ok(text.includes('floatEnabled'), 'floating ball switch')
  assert.ok(text.includes('floatFabLock'), 'fab lock switch')
  assert.ok(text.includes('floatSatellites'), 'satellite section')
  assert.ok(text.includes('floatResetAction'), 'reset action')
  for (const key of ['floatMonitorTitle', 'floatAuditTitle', 'floatQuotaTitle', 'floatModelsTitle']) {
    assert.ok(text.includes(key), `satellite switch ${key}`)
  }
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

// ---- dshp-workflow settings tab -------------------------------------------
const workflow = bundle.__test.workflow

const WORKFLOW_SNAPSHOT_PAYLOAD = {
  ok: true,
  settings: {
    enabled: true,
    toolName: 'workflow_plus',
    autoTrigger: 'suggest',
    subagentProvider: 'spawn',
    childPreset: 'read-only',
    maxConcurrentAgents: 6,
    maxAgentsPerRun: 32,
    maxItemsPerCall: 64,
    maxRunSeconds: 900,
    maxWorldRuns: 8,
    maxReportItems: 16,
    allowObserve: true,
    allowExecute: false,
    allowAdHocExecute: false,
    allowAdHocScripts: false,
    executeAllowlist: ['review-changed@abc'],
    allowedCommands: ['git', 'node'],
    blockedCommands: ['rm'],
    sandboxMode: 'read-only',
    runRetentionDays: 14,
    maxSavedWorkflows: 50,
  },
  revision: 7,
  workflows: [
    { id: 'review-changed', scope: 'global', name: 'Review changed files', description: 'Review every changed file.', capabilities: ['orchestrate', 'observe'], updatedAt: 1760000000000, bytes: 512 },
    { id: 'test-two', scope: 'global', name: 'Test two', description: '', capabilities: ['orchestrate'], updatedAt: 1760100000000, bytes: 128 },
  ],
  runs: [
    { id: 'run-2', workflowId: 'review-changed', name: 'Review changed files', status: 'completed', startedAt: 1760200000000, endedAt: 1760200060000, agentsStarted: 3, usage: { agents: 3, worldRuns: 0, durationMs: 60000 } },
    { id: 'run-1', workflowId: 'test-two', name: 'Test two', status: 'running', startedAt: 1760300000000, agentsStarted: 1, usage: { agents: 1 } },
  ],
  activeRuns: ['run-1'],
  providers: [
    { id: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, agentPreset: true, outputSchema: true, depthLimit: true } },
    { id: 'codex', inheritsParentContext: false, capabilities: { agentOptions: true, agentPreset: false, outputSchema: true, depthLimit: false } },
  ],
  presets: [
    { id: 'standard', name: 'Standard', description: 'Default coding agent' },
    { id: 'read-only', name: 'Read only', description: 'No write tools' },
  ],
}

const WORKFLOW_RUN_PAYLOAD = {
  ok: true,
  run: {
    id: 'run-1',
    workflowId: 'test-two',
    name: 'Test two',
    status: 'error',
    stopReason: 'error',
    startedAt: 1760300000000,
    endedAt: 1760300030000,
    agents: [
      { label: 'agent-one', status: 'completed', cached: true, provider: 'spawn', model: 'test-model' },
      { label: 'agent-two', status: 'failed', cached: false, provider: 'spawn', model: 'test-model' },
    ],
    phases: ['Collect changed files', 'Review'],
    logs: ['run started', 'agent-one done'],
    reports: [{ conclusion: 'test-finding' }],
    artifacts: [{ id: 'art-1', name: 'report.md', kind: 'markdown' }],
    usage: { agents: 2, worldRuns: 1, durationMs: 30000 },
    error: { code: 'WF_LIMIT', message: 'too many report items' },
  },
}

function renderWorkflowModel(model, actions = {}) {
  return renderNode(workflow.View({ t, model, actions }), t)
}

test('the dshps settings tab strip exposes the workflow tab', () => {
  seedHooks(['quota', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  for (const key of ['tabQuota', 'tabNet', 'tabModels', 'tabWorkflow', 'floatTab']) {
    assert.ok(text.includes(key), `tab ${key} rendered`)
  }
  assert.ok(text.indexOf('tabModels') < text.indexOf('tabWorkflow'), 'workflow tab sits after sign-in')
})

test('the settings page renders the workflow tab loading state', () => {
  seedHooks(['wf', 'loading', null, undefined, null, { organization: '', project: '', type: 2, refreshIntervalSeconds: 60 }, false, null, '', false, false, null])
  const settings = findSlot('dshps')
  const element = settings.component({ t, rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) }, close() {} })
  const text = renderNode(element, t)
  assert.ok(text.includes('wfTitle'), 'workflow heading')
  assert.ok(text.includes('wfLoading'), 'loading hint')
  assert.ok(!text.includes('wfLibraryTitle'), 'library stays hidden while loading')
})

test('workflow tab renders the engine, limits and safety sections from a snapshot payload', () => {
  const snapshot = workflow.snapshotModel(WORKFLOW_SNAPSHOT_PAYLOAD)
  assert.equal(snapshot.settings.available, true)
  assert.equal(snapshot.settings.revision, 7)
  assert.equal(snapshot.activeRuns.length, 1)
  const model = workflow.viewModel({
    phase: 'ready',
    settingsDocument: snapshot.settings,
    workflows: snapshot.workflows,
    runs: snapshot.runs,
    activeRuns: snapshot.activeRuns,
    providers: snapshot.providers,
    presets: snapshot.presets,
  })
  assert.equal(model.settings.toolName, 'workflow_plus')
  assert.equal(model.settings.maxRunSeconds, 900)
  assert.equal(model.settings.sandboxMode, 'read-only')
  assert.equal(model.settings.allowedCommands.join(','), 'git,node')
  assert.equal(snapshot.providers.length, 2)
  assert.equal(snapshot.providers[0].id, 'spawn')
  assert.equal(snapshot.presets[1].id, 'read-only')
  assert.equal(workflow.formatDuration(90000), '1m 30s')
  const text = renderWorkflowModel(model)
  for (const key of [
    'wfEngineTitle', 'wfEngineHint', 'wfEnabled', 'wfToolName', 'wfAutoTrigger', 'wfSubagentProvider',
    'wfLimitsTitle', 'wfLimitsHint', 'wfMaxConcurrentAgents', 'wfMaxAgentsPerRun', 'wfMaxItemsPerCall',
    'wfMaxRunSeconds', 'wfMaxWorldRuns', 'wfMaxReportItems', 'wfRunRetentionDays', 'wfMaxSavedWorkflows',
    'wfSafetyTitle', 'wfSafetyHint', 'wfAllowObserve', 'wfAllowExecute', 'wfAllowAdHocExecute',
    'wfExecuteAllowlist', 'wfAllowedCommands', 'wfBlockedCommands', 'wfSandboxMode',
    'wfSave', 'wfReload',
  ]) {
    assert.ok(text.includes(key), `section field ${key} rendered`)
  }
  assert.ok((text.match(/\?/g) || []).length >= 20, 'every configurable field exposes a hover tip')
  assert.ok(text.includes('wfAutoTriggerSuggest'), 'auto trigger selection shown')
  assert.ok(text.includes('wfSandboxReadOnly'), 'sandbox selection shown')
  assert.ok(text.includes('wfSourceTitle'), 'provider/preset source note shown')
  assert.ok(text.includes('wfEngineDefaultsHint'), 'one compact engine defaults hint')
  assert.ok(text.includes('wfProviderSpawn'), 'provider picker uses the live provider list')
  assert.ok(text.includes('Read only（read-only）'), 'preset picker shows the selected live preset')
})

test('workflow library cards render from a mocked workflows-list payload', () => {
  const cards = workflow.workflowCards({ ok: true, workflows: WORKFLOW_SNAPSHOT_PAYLOAD.workflows })
  assert.equal(cards.length, 2)
  assert.equal(cards[0].id, 'review-changed')
  const snapshot = workflow.snapshotModel(WORKFLOW_SNAPSHOT_PAYLOAD)
  const model = workflow.viewModel({ phase: 'ready', settingsDocument: snapshot.settings, workflows: cards, runs: [] })
  const text = renderWorkflowModel(model)
  assert.ok(text.includes('Review changed files'), 'first workflow name')
  assert.ok(text.includes('review-changed'), 'first workflow id')
  assert.ok(text.includes('test-two'), 'second workflow id')
  assert.ok(text.includes('wfCapabilityOrchestrate') && text.includes('wfCapabilityObserve'), 'capability chips in Chinese with the raw term')
  assert.ok(text.includes('wfScopeGlobal'), 'scope badge')
  assert.ok(text.includes('wfShow') && text.includes('wfDelete'), 'library actions')
  assert.ok(text.includes('wfUpdatedAt'), 'updated timestamp label')
  assert.ok(!text.includes('wfDocument'), 'no document preview until requested')
  assert.ok(!text.includes('wfLibraryEmpty'), 'cards replace the empty state')
  const emptyModel = workflow.viewModel({ phase: 'ready', settingsDocument: snapshot.settings, workflows: [], runs: [] })
  assert.ok(renderWorkflowModel(emptyModel).includes('wfLibraryEmpty'), 'library empty state')
  const previewModel = workflow.viewModel({
    phase: 'ready',
    settingsDocument: snapshot.settings,
    workflows: cards,
    runs: [],
    workflowView: { ok: true, document: '/* @dshp-workflow {}\n*/\nreturn 1', meta: { id: 'review-changed', name: 'Review changed files', description: 'Review every changed file.', capabilities: ['orchestrate'] } },
  })
  const previewText = renderWorkflowModel(previewModel)
  assert.ok(previewText.includes('wfDocument'), 'document preview heading')
  assert.ok(previewText.includes('return 1'), 'document body rendered')
  assert.ok(previewText.includes('wfHide'), 'preview toggle label')
})

test('workflow run list and run detail render from mocked runs-list/run-read payloads', () => {
  const rows = workflow.runRows({ ok: true, runs: WORKFLOW_SNAPSHOT_PAYLOAD.runs }, WORKFLOW_SNAPSHOT_PAYLOAD.activeRuns)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].id, 'run-1', 'newest run first')
  assert.equal(rows[0].active, true)
  const detail = workflow.runDetail(WORKFLOW_RUN_PAYLOAD)
  assert.equal(detail.name, 'Test two')
  assert.equal(detail.cachedAgents, 1)
  assert.equal(detail.agentsTotal, 2)
  assert.equal(detail.reportsTotal, 1)
  assert.equal(detail.errorText, 'WF_LIMIT: too many report items')
  const snapshot = workflow.snapshotModel(WORKFLOW_SNAPSHOT_PAYLOAD)
  const model = workflow.viewModel({
    phase: 'ready',
    settingsDocument: snapshot.settings,
    workflows: [],
    runs: rows,
    activeRuns: ['run-1'],
    selectedRunId: 'run-1',
    runDetail: WORKFLOW_RUN_PAYLOAD,
    artifact: { ok: true, artifact: { name: 'report.md', kind: 'markdown', content: '# test report' } },
  })
  const text = renderWorkflowModel(model)
  for (const key of [
    'wfRunsTitle', 'wfRunsHint', 'wfActiveRuns', 'wfRunDetail', 'wfStatusRunning', 'wfStatusError',
    'wfAgentsStarted', 'wfCached', 'wfDuration', 'wfStopReason', 'wfPhases', 'wfLogs', 'wfReports',
    'wfAgentsTitle', 'wfArtifacts', 'wfUsage', 'wfRunError',
  ]) {
    assert.ok(text.includes(key), `run detail ${key} rendered`)
  }
  assert.ok(text.includes('Review changed files'), 'run list name')
  assert.ok(text.includes('Collect changed files'), 'phase rendered')
  assert.ok(text.includes('agent-one done'), 'log rendered')
  assert.ok(text.includes('WF_LIMIT'), 'error code rendered')
  assert.ok(text.includes('report.md'), 'artifact rendered')
  assert.ok(text.includes('# test report'), 'artifact content rendered')
  assert.ok(!text.includes('wfCancelRun'), 'no cancel action for a finished run')
  assert.ok(!text.includes('wfRunsEmpty'), 'runs list replaces the empty state')

  const runningRun = { ok: true, run: { ...WORKFLOW_RUN_PAYLOAD.run, status: 'running', stopReason: '', endedAt: undefined, error: null } }
  assert.equal(workflow.runDetail(runningRun).active, true)
  const runningModel = workflow.viewModel({ phase: 'ready', settingsDocument: snapshot.settings, runs: rows, selectedRunId: 'run-1', runDetail: runningRun })
  assert.ok(renderWorkflowModel(runningModel).includes('wfCancelRun'), 'cancel action for an active run')
})

test('workflow tab renders unavailable, error, loading and empty states', () => {
  const unavailableDocument = workflow.settingsDocument({ ok: true, available: false, ns: 'dshp-workflow', revision: 3, value: {} })
  assert.equal(unavailableDocument.available, false)
  const unavailableText = renderWorkflowModel(workflow.viewModel({ phase: 'unavailable', error: 'workflow rpc offline', settingsDocument: unavailableDocument }))
  assert.ok(unavailableText.includes('wfTitle'), 'heading stays visible')
  assert.ok(unavailableText.includes('workflow rpc offline'), 'unavailable detail shown')
  assert.ok(!unavailableText.includes('wfSave'), 'no settings form when unavailable')

  const loadingText = renderWorkflowModel(workflow.viewModel({ phase: 'loading' }))
  assert.ok(loadingText.includes('wfLoading'), 'loading state')
  assert.ok(!loadingText.includes('wfRunsTitle'), 'runs stay hidden while loading')

  const errorText = renderWorkflowModel(workflow.viewModel({ phase: 'error', error: 'boom-load' }))
  assert.ok(errorText.includes('boom-load'), 'error detail shown')

  const emptyText = renderWorkflowModel(workflow.viewModel({ phase: 'ready', settingsDocument: { available: true, revision: 1, value: {} }, workflows: [], runs: [] }))
  assert.ok(emptyText.includes('wfLibraryEmpty'), 'library empty state')
  assert.ok(emptyText.includes('wfRunsEmpty'), 'runs empty state')
  assert.ok(emptyText.includes('wfRunSelect'), 'run detail placeholder')
})

test('workflow tab container renders the unavailable state from seeded state', () => {
  seedHooks([null, null, 'unavailable', 'workflow plugin missing', [], [], [], false, null, '', null, false, null, null, null, false, ''])
  const element = FakeReact.createElement(workflow.Settings, { rpc: { call: async () => ({ ok: false, error: { message: 'offline' } }) } })
  const text = renderNode(element, t)
  assert.ok(text.includes('wfTitle'), 'heading rendered by the container')
  assert.ok(text.includes('workflow plugin missing'), 'seeded error shown by the container')
})

test('zh and en dictionaries stay in sync and every workflow key is defined', () => {
  const zhStart = source.indexOf('const ZH = {')
  const enStart = source.indexOf('const EN = {')
  const groupStart = source.indexOf('const GROUP_LABEL = {')
  assert.ok(zhStart >= 0 && enStart > zhStart && groupStart > enStart, 'dictionary markers found')
  const keysOf = (slice) => {
    const keys = []
    const pattern = /^ {6}([A-Za-z][A-Za-z0-9_]*):/gm
    let match
    while ((match = pattern.exec(slice))) keys.push(match[1])
    return keys
  }
  const zh = keysOf(source.slice(zhStart, enStart))
  const en = keysOf(source.slice(enStart, groupStart))
  assert.ok(zh.length > 250, 'zh dictionary parsed')
  assert.deepEqual(zh, en)
  const used = new Set()
  const usedPattern = /'(tabWorkflow|wf[A-Za-z0-9_]+)'/g
  let match
  while ((match = usedPattern.exec(source))) used.add(match[1])
  assert.ok(used.size > 80, 'workflow keys referenced by the bundle')
  const zhKeys = new Set(zh)
  const enKeys = new Set(en)
  for (const key of used) {
    assert.ok(zhKeys.has(key), `zh dictionary is missing ${key}`)
    assert.ok(enKeys.has(key), `en dictionary is missing ${key}`)
  }
})

// ---- workflow RPC contract (async) ---------------------------------------
const asyncTests = []
function testAsync(label, fn) {
  asyncTests.push({ label, fn })
}

testAsync('workflow RPC replies normalize across Host envelope shapes and endpoints', async () => {
  const calls = []
  const rpc = {
    call: async (channel, endpoint, body) => {
      calls.push({ channel, endpoint, body })
      if (endpoint === 'snapshot') return { ok: true, value: { ok: true, ...WORKFLOW_SNAPSHOT_PAYLOAD } }
      if (endpoint === 'settings') return { ok: true, value: { ok: true, available: true, ns: 'dshp-workflow', revision: 8, value: WORKFLOW_SNAPSHOT_PAYLOAD.settings } }
      if (endpoint === 'settings-write') return { ok: true, value: { ok: true, available: true, ns: 'dshp-workflow', revision: 9, value: WORKFLOW_SNAPSHOT_PAYLOAD.settings } }
      if (endpoint === 'workflows-list') return { ok: true, value: { ok: true, workflows: WORKFLOW_SNAPSHOT_PAYLOAD.workflows } }
      if (endpoint === 'workflow-read') return { ok: true, value: { ok: true, document: '/* @dshp-workflow */\nreturn 1', meta: { id: 'review-changed', name: 'Review changed files' } } }
      if (endpoint === 'workflow-delete') return { ok: true, value: { ok: true } }
      if (endpoint === 'runs-list') return { ok: true, value: { ok: true, runs: WORKFLOW_SNAPSHOT_PAYLOAD.runs } }
      if (endpoint === 'run-read') return { ok: true, value: { ok: true, run: WORKFLOW_RUN_PAYLOAD.run } }
      if (endpoint === 'run-cancel') return { ok: true, value: { ok: true } }
      if (endpoint === 'artifact-read') return { ok: true, value: { ok: true, artifact: { name: 'report.md', kind: 'markdown', content: '# fetched artifact' } } }
      return { ok: false, error: { code: 'unknown-endpoint', message: `unknown ${endpoint}` } }
    },
  }

  const snapshotResult = await workflow.invoke(rpc, 'snapshot', {})
  assert.equal(snapshotResult.ok, true)
  assert.equal(calls[0].channel, '/dshp-workflow')
  assert.equal(Object.keys(calls[0].body).length, 0)
  const snapshot = workflow.snapshotModel(snapshotResult.value)
  assert.equal(snapshot.settings.available, true)
  assert.equal(snapshot.settings.revision, 7)
  assert.equal(snapshot.settings.value.toolName, 'workflow_plus')
  assert.equal(snapshot.workflows.length, 2)
  assert.equal(snapshot.runs.length, 2)
  assert.equal(snapshot.activeRuns.join(','), 'run-1')

  const settingsDoc = workflow.settingsDocument((await workflow.invoke(rpc, 'settings', {})).value)
  assert.equal(settingsDoc.revision, 8)
  const writtenDoc = workflow.settingsDocument((await workflow.invoke(rpc, 'settings-write', { ops: [], revision: 8 })).value)
  assert.equal(writtenDoc.revision, 9)

  const cards = workflow.workflowCards((await workflow.invoke(rpc, 'workflows-list', { scope: 'global' })).value)
  assert.equal(cards.length, 2)
  const read = workflow.workflowView((await workflow.invoke(rpc, 'workflow-read', { id: 'review-changed', scope: 'global' })).value)
  assert.equal(read.name, 'Review changed files')
  const deleted = await workflow.invoke(rpc, 'workflow-delete', { id: 'test-two', scope: 'global' })
  assert.equal(deleted.ok, true)
  assert.equal(Object.keys(deleted.value).length, 0)

  const rows = workflow.runRows((await workflow.invoke(rpc, 'runs-list', { limit: 50 })).value, ['run-1'])
  assert.equal(rows[0].id, 'run-1')
  const detail = workflow.runDetail((await workflow.invoke(rpc, 'run-read', { runId: 'run-1' })).value)
  assert.equal(detail.cachedAgents, 1)
  const cancelled = await workflow.invoke(rpc, 'run-cancel', { runId: 'run-1' })
  assert.equal(cancelled.ok, true)
  const artifact = workflow.artifactView((await workflow.invoke(rpc, 'artifact-read', { runId: 'run-1', artifactId: 'art-1' })).value)
  assert.equal(artifact.content, '# fetched artifact')
  const artifactCall = calls.find((call) => call.endpoint === 'artifact-read')
  assert.equal(artifactCall.body.runId, 'run-1')
  assert.equal(artifactCall.body.artifactId, 'art-1')

  const failed = await workflow.invoke(rpc, 'unknown-endpoint', {})
  assert.equal(failed.ok, false)
  assert.equal(failed.error.code, 'unknown-endpoint')
  const missing = await workflow.invoke(undefined, 'snapshot', {})
  assert.equal(missing.ok, false)
  assert.equal(missing.error.code, 'rpc-unavailable')
  const thrown = await workflow.invoke({ call: async () => { throw new Error('socket closed') } }, 'snapshot', {})
  assert.equal(thrown.ok, false)
  assert.equal(thrown.error.code, 'rpc-error')
  assert.ok(thrown.error.message.includes('socket closed'))
})

for (const { label, fn } of asyncTests) {
  try {
    await fn()
    passed++
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed++
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) process.exit(1)
