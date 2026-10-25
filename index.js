/**
 * dshps — plugin stack root Host half.
 *
 * Mounts the shared Web client bundle (`./client`) and owns the persisted
 * floating-layer UI state: the dshps floating ball, its ring of satellite
 * balls, and the draggable/resizable floating windows.
 *
 * State is plugin-level UI configuration, not secrets: it lives in
 * `$DSH_HOME/dshps/floating-ui.json`, is versioned, validated on every read and
 * write, and written atomically. The Web client reads and writes it through the
 * authenticated `/dshp-shell` RPC channel.
 *
 * The optional authenticated fallback route mirrors `dshp-quota`: some DSH
 * revisions expose the connection service without a usable shared RPC route
 * registry, so the plugin registers its own admitted `<channel>/<endpoint>`
 * POST route in that case.
 */
import { promises as fsp } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join as joinPath } from 'node:path'

const CHANNEL = '/dshp-shell'
const STATE_FILE = 'floating-ui.json'
const STATE_VERSION = 3
const MAX_WINDOWS = 24
const MIN_WIDTH = 240
const MAX_WIDTH = 4000
const MIN_HEIGHT = 140
const MAX_HEIGHT = 4000
const MAX_BODY_BYTES = 256 * 1024
const WINDOW_ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** Default geometry for the windows the client knows today. */
const DEFAULT_WINDOWS = {
  monitor: { open: false, locked: false, collapsed: false, x: 0.62, y: 0.2, w: 380, h: 300, z: 1 },
  audit: { open: false, locked: false, collapsed: false, x: 0.56, y: 0.46, w: 480, h: 320, z: 2 },
  quota: { open: false, locked: false, collapsed: false, x: 0.012, y: 0.68, w: 300, h: 260, z: 3 },
  models: { open: false, locked: false, collapsed: false, x: 0.66, y: 0.44, w: 400, h: 280, z: 4 },
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function homeDirectory() {
  const configured = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return configured.length > 0 ? configured : joinPath(homedir(), '.dsh')
}

function statePaths() {
  const directory = joinPath(homeDirectory(), 'dshps')
  return { directory, file: joinPath(directory, STATE_FILE) }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function defaultState() {
  return {
    version: STATE_VERSION,
    revision: 0,
    enabled: true,
    fabLocked: false,
    fab: { x: 0.94, y: 0.6 },
    satellites: { monitor: true, audit: true, quota: true, models: true },
    windows: clone(DEFAULT_WINDOWS),
    nextZ: 5,
  }
}

function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function ratioOr(value, fallback) {
  return Math.min(1, Math.max(0, numberOr(value, fallback)))
}

function integerOr(value, fallback, min, max) {
  const parsed = Math.round(numberOr(value, fallback))
  return Math.min(max, Math.max(min, parsed))
}

function booleanOr(value, fallback) {
  return typeof value === 'boolean' ? value : fallback
}

/**
 * Normalize one window entry. Unknown window ids are preserved so a newer
 * client can add windows without a Host change; their fields still validate.
 */
function sanitizeWindow(input, fallback) {
  const source = isRecord(input) ? input : {}
  const base = isRecord(fallback) ? fallback : DEFAULT_WINDOWS.monitor
  return {
    open: booleanOr(source.open, base.open === true),
    locked: booleanOr(source.locked, base.locked !== false),
    collapsed: booleanOr(source.collapsed, base.collapsed === true),
    x: ratioOr(source.x, base.x),
    y: ratioOr(source.y, base.y),
    w: integerOr(source.w, base.w, MIN_WIDTH, MAX_WIDTH),
    h: integerOr(source.h, base.h, MIN_HEIGHT, MAX_HEIGHT),
    z: integerOr(source.z, base.z, 0, 100000),
  }
}

/** Validate and normalize a whole state document. Never throws. */
function sanitizeState(input) {
  const source = isRecord(input) ? input : {}
  const defaults = defaultState()
  const windows = {}
  const incomingWindows = isRecord(source.windows) ? source.windows : {}
  const ids = new Set([...Object.keys(DEFAULT_WINDOWS), ...Object.keys(incomingWindows)])
  for (const id of ids) {
    if (!WINDOW_ID_PATTERN.test(id)) continue
    if (Object.keys(windows).length >= MAX_WINDOWS) break
    const fallback = DEFAULT_WINDOWS[id]
    windows[id] = sanitizeWindow(incomingWindows[id], fallback)
  }
  const satellites = {}
  const incomingSatellites = isRecord(source.satellites) ? source.satellites : {}
  for (const [id, value] of Object.entries({ ...defaults.satellites, ...incomingSatellites })) {
    if (!WINDOW_ID_PATTERN.test(id)) continue
    if (Object.keys(satellites).length >= MAX_WINDOWS) break
    satellites[id] = booleanOr(value, true)
  }
  const fabSource = isRecord(source.fab) ? source.fab : {}
  const highestZ = Object.values(windows).reduce((max, window) => Math.max(max, window.z), 0)
  return {
    version: STATE_VERSION,
    revision: Math.max(0, Math.floor(numberOr(source.revision, 0))),
    enabled: booleanOr(source.enabled, true),
    fabLocked: booleanOr(source.fabLocked, false),
    fab: { x: ratioOr(fabSource.x, defaults.fab.x), y: ratioOr(fabSource.y, defaults.fab.y) },
    satellites,
    windows,
    nextZ: Math.max(highestZ + 1, Math.floor(numberOr(source.nextZ, highestZ + 1))),
  }
}

function stateError(code, message, details) {
  return { ok: false, error: { code, message, details: details || {} } }
}

function stateOk(payload) {
  return { ok: true, ...payload }
}

/**
 * Own the floating-layer state file behind one serialized writer.
 * @param ctx - Cordis context (unused services are tolerated).
 */
function createService(ctx) {
  const paths = statePaths()
  let writeChain = Promise.resolve()

  const readFileSafely = async () => {
    try {
      const text = await fsp.readFile(paths.file, 'utf8')
      return { text }
    } catch (error) {
      if (error && error.code === 'ENOENT') return { missing: true }
      return { error }
    }
  }

  const load = async () => {
    const read = await readFileSafely()
    if (read.missing) return { state: defaultState(), warnings: [] }
    if (read.error) {
      return { state: defaultState(), warnings: [`无法读取悬浮层状态文件：${read.error.message || read.error}`] }
    }
    let parsed
    try {
      parsed = JSON.parse(read.text)
    } catch (error) {
      return { state: defaultState(), warnings: [`悬浮层状态文件不是合法 JSON，已回退默认值：${error.message || error}`] }
    }
    const state = sanitizeState(parsed)
    const warnings = []
    const fromVersion = isRecord(parsed) && typeof parsed.version === 'number' ? parsed.version : 1
    if (fromVersion < STATE_VERSION) {
      // v2: the quota overview moved to the bottom-left corner and to the
      // sidebar panel's compact size. v3: windows open unlocked by default and
      // the reset action restores that posture.
      const defaults = defaultState()
      const quota = defaults.windows.quota
      if (state.windows.quota) {
        state.windows.quota = {
          ...state.windows.quota,
          x: quota.x,
          y: quota.y,
          w: quota.w,
          h: quota.h,
        }
      }
      if (fromVersion < 3) {
        for (const window of Object.values(state.windows)) window.locked = false
      }
      warnings.push(`悬浮层状态版本 ${fromVersion} 已升级到 ${STATE_VERSION}。`)
    }
    return { state, warnings }
  }

  const persist = (state) => {
    writeChain = writeChain.then(async () => {
      await fsp.mkdir(dirname(paths.file), { recursive: true })
      const temp = `${paths.file}.tmp-${process.pid}-${Date.now()}`
      await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await fsp.rename(temp, paths.file)
    }, async () => {
      await fsp.mkdir(dirname(paths.file), { recursive: true })
      const temp = `${paths.file}.tmp-${process.pid}-${Date.now()}`
      await fsp.writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await fsp.rename(temp, paths.file)
    })
    return writeChain
  }

  const getState = async () => {
    const loaded = await load()
    return stateOk({
      state: loaded.state,
      revision: loaded.state.revision,
      path: paths.file,
      warnings: loaded.warnings,
    })
  }

  const saveState = async (payload) => {
    const request = isRecord(payload) ? payload : {}
    if (!isRecord(request.state)) return stateError('bad-request', 'save requires a state object', { field: 'state' })
    const expected = typeof request.revision === 'number' ? Math.floor(request.revision) : undefined
    const loaded = await load()
    if (expected !== undefined && expected !== loaded.state.revision) {
      return stateError('state-conflict', '悬浮层状态已在其他窗口更新，请重新加载。', { revision: loaded.state.revision })
    }
    const next = sanitizeState(request.state)
    next.revision = loaded.state.revision + 1
    try {
      await persist(next)
    } catch (error) {
      return stateError('state-write-failed', `无法写入悬浮层状态文件：${error.message || error}`, { path: paths.file })
    }
    return stateOk({ state: next, revision: next.revision, path: paths.file, warnings: [] })
  }

  const resetState = async () => {
    const next = defaultState()
    const loaded = await load()
    next.revision = loaded.state.revision + 1
    try {
      await persist(next)
    } catch (error) {
      return stateError('state-write-failed', `无法写入悬浮层状态文件：${error.message || error}`, { path: paths.file })
    }
    return stateOk({ state: next, revision: next.revision, path: paths.file, warnings: [] })
  }

  const diagnostics = async () => {
    const loaded = await load()
    const state = loaded.state
    return stateOk({
      diag: {
        channel: CHANNEL,
        file: paths.file,
        version: state.version,
        revision: state.revision,
        enabled: state.enabled,
        fabLocked: state.fabLocked,
        satellites: state.satellites,
        windows: Object.fromEntries(Object.entries(state.windows).map(([id, window]) => [id, {
          open: window.open,
          locked: window.locked,
          collapsed: window.collapsed,
          x: window.x,
          y: window.y,
          w: window.w,
          h: window.h,
          z: window.z,
        }])),
        warnings: loaded.warnings,
      },
    })
  }

  return { getState, saveState, resetState, diagnostics, paths: () => ({ ...paths }) }
}

async function dispatch(service, endpoint, payload) {
  try {
    if (endpoint === 'state') return await service.getState()
    if (endpoint === 'save') return await service.saveState(payload)
    if (endpoint === 'reset') return await service.resetState()
    if (endpoint === 'diag') return await service.diagnostics()
    return stateError('bad-request', `unknown endpoint: ${String(endpoint)}`, { endpoint: String(endpoint) })
  } catch (error) {
    return stateError('operation-error', error instanceof Error ? error.message : String(error))
  }
}

/**
 * Authenticated fallback transport for compositions where the shared RPC route
 * registry is unavailable (see the module header).
 */
function registerOwnRpcRoute(ctx, service) {
  const webServer = typeof ctx?.get === 'function' ? ctx.get('webServer') : undefined
  if (!webServer || typeof webServer.register !== 'function') return undefined
  if (typeof ctx?.connection?.admit !== 'function') return undefined
  return webServer.register({
    kind: 'prefix',
    path: CHANNEL,
    handler: async (req, res) => {
      const admission = ctx.connection.admit(req)
      if (isRecord(admission) && 'rejection' in admission) {
        const status = admission.rejection === 403 ? 403 : 401
        res.writeHead(status)
        res.end(status === 401 ? 'unauthorized' : 'forbidden')
        return
      }
      if (req.method !== 'POST') {
        res.writeHead(405)
        res.end('method not allowed')
        return
      }
      const pathname = new URL(req.url || '/', 'http://localhost').pathname
      const endpoint = pathname === CHANNEL ? '' : pathname.startsWith(`${CHANNEL}/`) ? pathname.slice(CHANNEL.length + 1) : ''
      if (!/^[A-Za-z0-9_$.-]+$/.test(endpoint)) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      const contentType = String(req.headers['content-type'] || '').split(';', 1)[0].trim().toLowerCase()
      if (contentType !== 'application/json') {
        res.writeHead(415)
        res.end('content type must be application/json')
        return
      }
      const chunks = []
      let size = 0
      for await (const chunk of req) {
        size += chunk.length
        if (size > MAX_BODY_BYTES) {
          res.writeHead(413)
          res.end('payload too large')
          return
        }
        chunks.push(chunk)
      }
      let message
      try {
        message = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        res.writeHead(400)
        res.end('body is not JSON')
        return
      }
      const rpcId = isRecord(message) && typeof message.rpcId === 'string' ? message.rpcId : 'invalid-request'
      const result = await dispatch(service, endpoint, isRecord(message) ? message.payload : undefined)
      const envelope = {
        type: 'server-response',
        rpcId,
        result: result.ok === true
          ? { ok: true, value: result }
          : { ok: false, error: result.error },
      }
      const body = JSON.stringify(envelope)
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    },
  })
}

export const inject = ['connection']

export function apply(ctx) {
  const service = createService(ctx)
  let disposeRpc
  try {
    const handle = ctx?.connection?.rpc?.handle
    if (typeof handle === 'function') {
      disposeRpc = handle.call(ctx.connection.rpc, CHANNEL, (endpoint, payload) => dispatch(service, endpoint, payload))
    }
  } catch (error) {
    ctx?.logger?.warn?.('dshps: connection.rpc.handle 不可用，改用插件自有路由：%s', error instanceof Error ? error.message : String(error))
  }
  if (typeof disposeRpc !== 'function') {
    try {
      disposeRpc = registerOwnRpcRoute(ctx, service)
    } catch (error) {
      ctx?.logger?.warn?.('dshps: 悬浮层回退 RPC 路由注册失败：%s', error instanceof Error ? error.message : String(error))
    }
  }
  try {
    ctx?.effect?.(() => {
      return () => {
        try {
          if (typeof disposeRpc === 'function') disposeRpc()
        } catch {
          /* already withdrawn */
        }
      }
    }, 'dshps: floating layer rpc channel')
  } catch (error) {
    ctx?.logger?.warn?.('dshps: 悬浮层 RPC 清理注册失败：%s', error instanceof Error ? error.message : String(error))
  }
  ctx?.logger?.info?.('dshps: 已注册悬浮层状态通道 %s（%s）', CHANNEL, service.paths().file)
}

export { sanitizeState, defaultState, STATE_VERSION }

export const name = 'dshps'
