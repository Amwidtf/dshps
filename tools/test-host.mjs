/**
 * Local harness for the dshp-quota Host half: builds a mock Cordis context plus a
 * scripted fetch, then exercises provider discovery, vendor adapters, caching,
 * failure classification and secret hygiene. Run: node tools/test-host.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../plugins/dshp-quota/host.js'

// Never touch the real profile DPAPI token file during tests.
process.env.DSHPS_DISABLE_TOKEN_FILE = '1'

let passed = 0
let failed = 0
const failures = []

async function test(label, fn) {
  try {
    await fn()
    passed++
    console.log(`PASS  ${label}`)
  } catch (error) {
    failed++
    failures.push({ label, error })
    console.log(`FAIL  ${label}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function makeResponse(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function makeCtx({ rows = [], descriptors = [], catalog = [], routes = [], credentials = {}, account, fetchImpl, settingsMutate, config = { team: { zhipu: { organization: 'org-test', project: 'proj-test' } } } }) {
  const calls = []
  let handler
  const ctx = {
    connection: {
      rpc: {
        handle(channel, fn) {
          handler = { channel, fn }
          return () => {}
        },
      },
    },
    credentials: {
      async resolve(ref) {
        return typeof ref === 'string' && ref in credentials ? { value: credentials[ref] } : undefined
      },
      async readRecord() { return undefined },
    },
    settings: {
      describe: () => descriptors,
      ...(settingsMutate ? { mutate: settingsMutate } : {}),
    },
    llm: {
      listConfigurableProviders: () => catalog,
      listProviders: () => routes,
    },
    configEditor: { configuration: () => rows },
    deepseekAccount: account,
    get(service) { return this[service] },
    effect(fn) { fn() },
    logger: { info() {} },
  }
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), headers: options?.headers ?? {}, method: options?.method ?? 'GET' })
    return fetchImpl(String(url), options)
  }
  apply(ctx, config)
  assert.ok(handler, 'rpc channel registered')
  assert.equal(handler.channel, '/dshp-quota')
  return {
    calls,
    async snapshot(force = false) {
      return handler.fn('snapshot', { force }, undefined)
    },
    async diag() {
      return handler.fn('diag', {}, undefined)
    },
    async call(endpoint, payload) {
      return handler.fn(endpoint, payload, undefined)
    },
  }
}

function piAiRow(id = 'llm-pi-ai') {
  return { entry: { options: { id, name: '@deepseek-ai/dsh-llm-pi-ai' } }, inherited: {}, override: {} }
}

function descriptor(ns, providers) {
  return { ns, value: { providers } }
}

const SAMPLE_PROVIDERS = {
  'deepseek': { apiKeyEnv: 'DEEPSEEK_API_KEY', baseURL: 'https://api.deepseek.com/v1' },
  'minimax-cn': { apiKeyEnv: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.cn/v1' },
  'kimi-for-coding': { apiKeyEnv: 'KIMI_CODE_KEY', baseURL: 'https://api.kimi.com/coding' },
  'zai-coding': { apiKeyEnv: 'ZHIPU_CODING_KEY', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  'moonshot-cn': { apiKeyEnv: 'MOONSHOT_API_KEY', baseURL: 'https://api.moonshot.cn/v1' },
}

const CREDS = {
  DEEPSEEK_API_KEY: 'test-deepseek-secret',
  MINIMAX_API_KEY: 'test-minimax-secret',
  KIMI_CODE_KEY: 'test-kimi-secret',
  ZHIPU_CODING_KEY: 'zhipu-id.secret-secret-value',
  MOONSHOT_API_KEY: 'test-moonshot-secret',
}

function fixtureFetch(url, options) {
  if (url === 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken') {
    return makeResponse({ data: { accessToken: 'access-token-refreshed', refreshToken: 'refresh-token-rotated', expires_in: 900 } })
  }
  if (url === 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscriptionStats') {
    return makeResponse({
      data: {
        subscriptionBalance: {
          feature: 'FEATURE_OMNI',
          type: 'SUBSCRIPTION',
          amountUsedRatio: 0.1612,
          kimiCodeUsedRatio: 0.05,
          expireTime: '2026-08-01T00:00:00Z',
        },
      },
    })
  }
  if (url === 'https://www.kimi.com/apiv2/kimi.gateway.membership.v2.MembershipService/GetSubscription') {
    return makeResponse({ data: { subscription: { goods: { membershipLevel: 'LEVEL_INTERMEDIATE', title: 'Allegretto' } } } })
  }
  if (url === 'https://api.deepseek.com/user/balance') {
    return makeResponse({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' }] })
  }
  if (url === 'https://www.minimax.cn/v1/token_plan/remains') {
    return makeResponse({
      model_remains: [{
        model_name: 'general',
        start_time: 1000,
        end_time: 1000 + 5 * 3_600_000,
        current_interval_status: 1,
        current_interval_remaining_percent: 92,
        current_weekly_status: 1,
        current_weekly_remaining_percent: 67,
        weekly_end_time: Date.now() + 3 * 86_400_000,
      }],
      base_resp: { status_code: 0, status_msg: 'success' },
    })
  }
  if (url === 'https://api.kimi.com/coding/v1/usages') {
    return makeResponse({
      usage: { limit: '100', remaining: '74', resetTime: '2026-10-25T00:00:00Z' },
      limits: [{ window: { duration: 300, timeUnit: 'TIME_UNIT_MINUTE' }, detail: { limit: '100', remaining: '85', used: '15', resetTime: '2026-10-18T20:00:00Z' } }],
      user: { membership: { level: 'LEVEL_INTERMEDIATE' } },
      parallel: { limit: '30' },
      booster_wallet: {
        monthlyChargeLimit: { currency: 'CNY', priceInCents: '10000' },
        monthlyUsed: { currency: 'CNY', priceInCents: '2500' },
      },
    })
  }
  if (url.startsWith('https://open.bigmodel.cn/api/monitor/usage/quota/limit')) {
    return makeResponse({
      code: 200,
      success: true,
      data: {
        limits: [
          { type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 150, remaining: 850, percentage: 15, nextResetTime: Date.now() + 3_600_000 },
          { type: 'TOKENS_LIMIT', unit: 6, number: 1, usage: 66000, currentValue: 22000, remaining: 44000, percentage: 33, nextResetTime: Date.now() + 86_400_000 },
          { type: 'TIME_LIMIT', unit: 5, number: 1, usage: 4000, currentValue: 1828, remaining: 2172, percentage: 45 },
        ],
      },
    })
  }
  if (url === 'https://open.bigmodel.cn/api/biz/subscription/list') {
    return makeResponse({ code: 200, success: true, data: [{ productName: 'GLM Coding Max', status: 'VALID', inCurrentPeriod: true, nextRenewTime: '2026-11-01' }] })
  }
  if (url === 'https://open.bigmodel.cn/api/biz/account/query-customer-account-report') {
    return makeResponse(401, { message: 'coding key cannot read cash report' })
  }
  if (url === 'https://api.moonshot.cn/v1/users/me/balance') {
    return makeResponse({ code: 0, data: { available_balance: 49.58894, voucher_balance: 46.58893, cash_balance: 3.00001 }, scode: '0x0', status: true })
  }
  return makeResponse(404, { message: `unexpected url ${url}` })
}

function fullCtx() {
  return makeCtx({
    rows: [
      piAiRow(),
      { entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: {}, override: {} },
    ],
    descriptors: [descriptor('llm-pi-ai', SAMPLE_PROVIDERS)],
    catalog: [
      { provider: 'deepseek', settingsNs: 'llm-pi-ai', defaultBaseURL: 'https://api.deepseek.com' },
      { provider: 'minimax-cn', settingsNs: 'llm-pi-ai', defaultBaseURL: 'https://api.minimax.cn' },
    ],
    routes: [{ provider: 'deepseek' }],
    credentials: CREDS,
    account: {
      async getState() { return { status: 'credential-stored' } },
      async getBalance() {
        return {
          status: 'ready',
          value: [{ currency: 'CNY', balance: '20.50' }],
          bonusWallets: [{ currency: 'CNY', balance: '5.00' }],
        }
      },
    },
    fetchImpl: fixtureFetch,
  })
}

await test('module exports a host plugin shape', () => {
  assert.equal(name, 'dshp-quota')
  assert.ok(Array.isArray(inject))
  assert.ok(inject.includes('connection'))
  assert.ok(inject.includes('credentials'))
  assert.equal(typeof apply, 'function')
  const schema = Config.toJSON()
  const root = schema.refs[schema.uid]
  const zhipu = schema.refs[schema.refs[root.dict.team].dict.zhipu]
  assert.equal(zhipu.meta.volatile, true, 'team config must be live-editable')
  assert.ok(zhipu.dict.organization, 'team.zhipu.organization exposed')
  assert.equal(schema.refs[root.dict.refreshIntervalSeconds].meta.volatile, true)
})

await test('discovers all four vendors from configured providers + account, all queries succeed', async () => {
  const client = fullCtx()
  const result = await client.snapshot()
  assert.equal(result.ok, true, JSON.stringify(result.error))
  const providers = result.snapshot.providers
  assert.equal(providers.length, 7, `expected 7 sources, got ${providers.map((p) => p.id).join(',')}`)
  const byId = new Map(providers.map((provider) => [provider.id, provider]))

  const account = byId.get('deepseek-account')
  assert.equal(account.status, 'ok')
  assert.equal(account.balances[0].available, 20.5)
  assert.equal(account.balances[1].granted, 5)

  const official = byId.get('deepseek-official')
  assert.equal(official.status, 'ok')
  assert.equal(official.vendor, 'deepseek')
  assert.equal(official.balances[0].total, 110)
  assert.equal(official.balances[0].granted, 10)

  const minimax = byId.get('pi-ai:minimax-cn')
  assert.equal(minimax.status, 'ok')
  assert.equal(minimax.vendor, 'minimax')
  assert.equal(minimax.windows.length, 2)
  assert.equal(minimax.windows[0].remainingPercent, 92)
  assert.equal(minimax.windows[1].remainingPercent, 67)

  const kimiCode = byId.get('pi-ai:kimi-for-coding')
  assert.equal(kimiCode.status, 'ok')
  assert.equal(kimiCode.vendor, 'kimi-code')
  assert.equal(kimiCode.plan.name, 'Kimi Code Intermediate')
  assert.ok(kimiCode.windows.some((entry) => entry.label === '5 小时'))
  const monthly = kimiCode.windows.find((entry) => entry.key === 'monthly')
  assert.equal(monthly, undefined, 'booster wallet must not be reported as the monthly allowance')
  const booster = kimiCode.windows.find((entry) => entry.key === 'booster')
  assert.ok(booster, 'booster wallet is exposed separately')
  assert.equal(booster.label, '加速包')
  assert.equal(kimiCode.totalUsage.unavailable, 'need-token', 'total usage needs a web token')

  // Panel order follows the configured provider order (no vendor re-sort).
  assert.deepEqual(providers.map((provider) => provider.id), [
    'pi-ai:deepseek',
    'pi-ai:minimax-cn',
    'pi-ai:kimi-for-coding',
    'pi-ai:zai-coding',
    'pi-ai:moonshot-cn',
    'deepseek-official',
    'deepseek-account',
  ])

  const zhipu = byId.get('pi-ai:zai-coding')
  assert.equal(zhipu.status, 'ok')
  assert.equal(zhipu.vendor, 'zhipu')
  assert.equal(zhipu.team.isTeam, true, 'team context should be detected')
  assert.equal(zhipu.plan.name, 'GLM Coding Max')
  assert.ok(zhipu.windows.some((entry) => entry.usedPercent === 15))

  const kimi = byId.get('pi-ai:moonshot-cn')
  assert.equal(kimi.status, 'ok')
  assert.equal(kimi.vendor, 'kimi')
  assert.equal(kimi.balances[0].available, 49.58894)
  assert.equal(kimi.balances[0].currency, 'CNY')

  // team / org headers reached the GLM quota endpoint
  const glmCall = client.calls.find((call) => call.url.startsWith('https://open.bigmodel.cn/api/monitor/usage/quota/limit'))
  assert.ok(glmCall, 'glm quota queried')
  assert.equal(glmCall.headers['bigmodel-organization'], 'org-test')
  assert.equal(glmCall.headers['bigmodel-project'], 'proj-test')
  assert.ok(glmCall.url.includes('type=2'), 'team type query')
})

await test('never serializes a secret into the snapshot', async () => {
  const client = fullCtx()
  const result = await client.snapshot()
  const text = JSON.stringify(result)
  for (const secret of Object.values(CREDS)) assert.ok(!text.includes(secret), `snapshot leaked ${secret.slice(0, 8)}…`)
  for (const secret of ['test-deepseek-secret', 'zhipu-id.secret-secret-value']) assert.ok(!text.includes(secret))
  const diag = await client.diag()
  const diagText = JSON.stringify(diag)
  for (const secret of Object.values(CREDS)) assert.ok(!diagText.includes(secret), 'diagnostics leaked a secret')
})

await test('caches for the TTL and honors force refresh', async () => {
  const client = fullCtx()
  const first = await client.snapshot(false)
  const callsAfterFirst = client.calls.length
  assert.ok(callsAfterFirst > 0)
  const second = await client.snapshot(false)
  assert.equal(second.cache, 'hit')
  assert.equal(client.calls.length, callsAfterFirst, 'cache hit must not hit the network')
  const third = await client.snapshot(true)
  assert.notEqual(third.cache, 'hit')
  assert.ok(client.calls.length > callsAfterFirst, 'force refresh queries again')
})

await test('missing credentials produce need-config without network calls', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'minimax-cn': { baseURL: 'https://api.minimax.cn/v1' } })],
    credentials: {},
    fetchImpl: fixtureFetch,
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'need-config')
  assert.equal(provider.hasKey, false)
  assert.equal(client.calls.length, 0)
})

await test('unknown hosts are never queried with the key', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'acme-gateway': { baseURL: 'https://gateway.internal.example/v1', apiKeyEnv: 'ACME_KEY' } })],
    credentials: { ACME_KEY: 'test-acme-secret' },
    fetchImpl: fixtureFetch,
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'unsupported')
  assert.equal(client.calls.length, 0, 'no request may leave to an unknown host')
})

await test('401 is classified as auth and exposes no key', async () => {
  const client = makeCtx({
    rows: [{ entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: {}, override: {} }],
    credentials: { DEEPSEEK_API_KEY: 'test-bad' },
    fetchImpl: () => makeResponse({ error: { message: 'invalid key' } }, 401),
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers.find((entry) => entry.id === 'deepseek-official')
  assert.equal(provider.status, 'error')
  assert.equal(provider.error.category, 'auth')
  assert.ok(!JSON.stringify(result).includes('test-bad'))
})

await test('MiniMax business error 2062 is reported as no active plan', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'minimax-cn': { apiKeyEnv: 'MINIMAX_API_KEY', baseURL: 'https://api.minimax.cn/v1' } })],
    credentials: { MINIMAX_API_KEY: 'test-api-payg' },
    fetchImpl: (url) => url.includes('/v1/token_plan/remains') || url.includes('/coding_plan/remains')
      ? makeResponse({ base_resp: { status_code: 2062, status_msg: 'no active token plan' } })
      : makeResponse(404, {}),
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.vendor, 'minimax')
  assert.equal(provider.error.category, 'no-plan')
  assert.equal(provider.status, 'ok', 'a key without a subscription plan is not an error state')
})

await test('GLM standard API key without a Coding Plan reports cash balance', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'zai-standard': { apiKeyEnv: 'ZHIPU_CODING_KEY', baseURL: 'https://open.bigmodel.cn/api/paas/v4' } })],
    credentials: { ZHIPU_CODING_KEY: 'zhipu-key' },
    config: {},
    fetchImpl: (url) => {
      if (url.includes('/api/monitor/usage/quota/limit')) return makeResponse({ code: 500, msg: '当前用户不存在coding plan', success: false })
      if (url.includes('/api/biz/subscription/list')) return makeResponse({ code: 200, success: true, data: [] })
      if (url.includes('/api/biz/account/query-customer-account-report')) {
        return makeResponse({ code: 200, success: true, data: { balance: 12.5, availableBalance: 12.5, rechargeAmount: 10, giveAmount: 2.5, totalSpendAmount: 1, frozenBalance: 0 } })
      }
      return makeResponse(404, {})
    },
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'ok')
  assert.equal(provider.kind, 'balance')
  assert.equal(provider.balances[0].available, 12.5)
  assert.match(provider.note, /未检测到 Coding Plan/)
})

await test('GLM coding-plan route never shows the standard cash balance', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'zai-coding': { apiKeyEnv: 'ZHIPU_CODING_KEY', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } })],
    credentials: { ZHIPU_CODING_KEY: 'zhipu-key' },
    config: { team: { zhipu: { organization: 'org', project: 'proj', type: 2 } } },
    fetchImpl: (url) => {
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return makeResponse({ code: 200, success: true, data: { limits: [{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 35000, currentValue: 0, remaining: 35000, percentage: 0 }] } })
      }
      if (url.includes('/api/biz/subscription/list')) return makeResponse({ code: 200, success: true, data: [] })
      if (url.includes('/api/biz/account/query-customer-account-report')) {
        return makeResponse({ code: 200, success: true, data: { balance: 0, availableBalance: 0 } })
      }
      return makeResponse(404, {})
    },
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'ok')
  assert.equal(provider.kind, 'quota')
  assert.equal(provider.balances.length, 0, 'cash balance must not appear on a coding route')
  assert.ok(provider.windows.some((entry) => entry.label === '5 小时额度'))
})

await test('GLM coding route without a plan reports no-plan instead of an error', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'zai-coding': { apiKeyEnv: 'ZHIPU_CODING_KEY', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } })],
    credentials: { ZHIPU_CODING_KEY: 'zhipu-key' },
    config: {},
    fetchImpl: (url) => {
      if (url.includes('/api/monitor/usage/quota/limit')) return makeResponse({ code: 500, msg: '当前用户不存在coding plan', success: false })
      if (url.includes('/api/biz/subscription/list')) return makeResponse({ code: 200, success: true, data: [] })
      return makeResponse(404, {})
    },
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'ok')
  assert.equal(provider.error.category, 'no-plan')
  assert.equal(provider.balances.length, 0)
  assert.match(provider.error.message, /未检测到 Coding Plan/)
})

await test('GLM empty team response falls back to personal quotas without claiming team', async () => {
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', { 'zai-coding': { apiKeyEnv: 'ZHIPU_CODING_KEY', baseURL: 'https://open.bigmodel.cn/api/coding/paas/v4' } })],
    credentials: { ZHIPU_CODING_KEY: 'zhipu-key' },
    config: { team: { zhipu: { organization: 'org-test', project: '' } } },
    fetchImpl: (url) => {
      if (url.includes('/api/monitor/usage/quota/limit') && url.includes('type=2')) return makeResponse({ code: 200, success: true, data: {} })
      if (url.includes('/api/monitor/usage/quota/limit')) {
        return makeResponse({
          code: 200,
          success: true,
          data: { limits: [{ type: 'TOKENS_LIMIT', unit: 3, number: 5, usage: 1000, currentValue: 150, remaining: 850, percentage: 15 }] },
        })
      }
      if (url.includes('/api/biz/subscription/list')) return makeResponse({ code: 200, success: true, data: [] })
      return makeResponse(404, {})
    },
  })
  const result = await client.snapshot()
  const provider = result.snapshot.providers[0]
  assert.equal(provider.status, 'ok')
  assert.notEqual(provider.team.isTeam, true)
  assert.ok(provider.windows.some((entry) => entry.usedPercent === 15))
  assert.match(provider.note, /团队上下文未返回额度/)
})

await test('refresh interval comes from live plugin config', async () => {
  const client = makeCtx({
    rows: [{ entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: {}, override: {} }],
    credentials: { DEEPSEEK_API_KEY: 'test-deepseek' },
    config: { refreshIntervalSeconds: 120 },
    fetchImpl: fixtureFetch,
  })
  const result = await client.snapshot()
  assert.equal(result.snapshot.ttlMs, 120_000)
  const diag = await client.diag()
  assert.equal(diag.diag.refreshIntervalSeconds, 120)
})

await test('Kimi total usage is queried from the web membership endpoint with a token', async () => {
  process.env.KIMI_WEB_TOKEN = 'Bearer test-web-token'
  try {
    const client = makeCtx({
      rows: [piAiRow()],
      descriptors: [descriptor('llm-pi-ai', { 'kimi-coding': { apiKeyEnv: 'KIMI_CODE_KEY', baseURL: 'https://api.kimi.com/coding' } })],
      credentials: { KIMI_CODE_KEY: 'test-kimi' },
      config: {},
      fetchImpl: fixtureFetch,
    })
    const result = await client.snapshot()
    const provider = result.snapshot.providers[0]
    assert.equal(provider.vendor, 'kimi-code')
    assert.ok(provider.totalUsage, 'total usage attached')
    assert.ok(Math.abs(provider.totalUsage.totalPct - 16.12) < 1e-9)
    assert.equal(provider.totalUsage.codePct, 5)
    assert.ok(Math.abs(provider.totalUsage.kimiPct - 11.12) < 1e-9)
    assert.equal(provider.plan.name, 'Allegretto', 'membership title becomes the plan name')
    const webCall = client.calls.find((call) => call.url.includes('GetSubscriptionStats'))
    assert.ok(webCall, 'web membership stats queried')
    assert.equal(webCall.method, 'POST')
    assert.ok(String(webCall.headers.Authorization).startsWith('Bearer access-token-refreshed'))
    assert.ok(client.calls.some((call) => call.url.includes('AuthService/RefreshToken')), 'refresh_token exchanged')
  } finally {
    delete process.env.KIMI_WEB_TOKEN
  }
})

await test('Kimi web token can be set and cleared in memory only', async () => {
  const client = makeCtx({ rows: [piAiRow()], descriptors: [descriptor('llm-pi-ai', {})], credentials: {}, fetchImpl: fixtureFetch })
  const before = await client.call('kimi-token', {})
  assert.equal(before.kimiTokenSet, false)
  const set = await client.call('kimi-token', { token: 'kimi-auth=abc.def.ghi; other=1' })
  assert.equal(set.ok, true)
  assert.equal(set.kimiTokenSet, true)
  const diag = await client.diag()
  assert.equal(diag.diag.kimiTokenSet, true)
  const rejected = await client.call('kimi-token', { token: '   ' })
  assert.equal(rejected.ok, false)
  const cleared = await client.call('kimi-token', { clear: true })
  assert.equal(cleared.kimiTokenSet, false)
  const text = JSON.stringify(await client.diag())
  assert.ok(!text.includes('abc.def.ghi'), 'token never appears in diagnostics')
})

await test('settings document and write endpoints work without remote namespaces', async () => {
  const stored = { team: { zhipu: { organization: '', project: '', type: 2 } }, refreshIntervalSeconds: 60 }
  const mutate = async (ns, ops) => {
    assert.equal(ns, 'dshp-quota')
    for (const op of ops) {
      assert.equal(op.op, 'set')
      if (op.path.join('.') === 'refreshIntervalSeconds') stored.refreshIntervalSeconds = op.value
    }
  }
  const client = makeCtx({
    rows: [piAiRow()],
    descriptors: [descriptor('llm-pi-ai', {}), { ns: 'dshp-quota', value: stored, revision: 7 }],
    credentials: {},
    settingsMutate: mutate,
    fetchImpl: fixtureFetch,
  })
  const read = await client.call('settings', {})
  assert.equal(read.ok, true)
  assert.equal(read.settings.available, true)
  assert.equal(read.settings.revision, 7)
  const written = await client.call('settings-write', { ops: [{ op: 'set', path: ['refreshIntervalSeconds'], value: 90 }], revision: 7 })
  assert.equal(written.ok, true)
  assert.equal(written.settings.value.refreshIntervalSeconds, 90)
})

await test('diagnostics list discovered sources without values', async () => {
  const client = fullCtx()
  const diag = await client.diag()
  assert.equal(diag.ok, true)
  assert.ok(Array.isArray(diag.diag.sources))
  assert.ok(diag.diag.sources.length >= 6)
  const source = diag.diag.sources.find((entry) => entry.id === 'pi-ai:minimax-cn')
  assert.equal(source.baseHost, 'api.minimax.cn')
  assert.equal(source.detected.vendor, 'minimax')
})

await test('stale snapshot survives a failing refresh', async () => {
  let fail = false
  const client = makeCtx({
    rows: [{ entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: {}, override: {} }],
    credentials: { DEEPSEEK_API_KEY: 'test-deepseek' },
    fetchImpl: (url) => fail ? Promise.reject(new Error('boom')) : fixtureFetch(url),
  })
  const first = await client.snapshot()
  assert.equal(first.ok, true)
  fail = true
  const second = await client.snapshot(true)
  assert.equal(second.ok, true)
  assert.equal(second.snapshot.providers[0].status, 'error')
  const third = await client.snapshot(false)
  assert.equal(third.ok, true)
  assert.ok(third.snapshot, 'previous successful snapshot retained')
})

await test('fallback webserver route speaks the Connection envelope and admits requests', async () => {
  const { Readable } = await import('node:stream')
  let route
  const ctx = {
    connection: {
      rpc: { handle() { throw new Error('cannot get property "webServer" without inject') } },
      admit() { return { peer: { id: 'peer-test' } } },
    },
    webServer: { register(next) { route = next; return () => {} } },
    credentials: {
      async resolve(ref) { return ref === 'DEEPSEEK_API_KEY' ? { value: 'test-deepseek' } : undefined },
      async readRecord() { return undefined },
    },
    settings: { describe: () => [] },
    llm: { listConfigurableProviders: () => [], listProviders: () => [] },
    configEditor: {
      configuration: () => [{ entry: { options: { id: 'llm-deepseek', name: '@deepseek-ai/dsh-llm-deepseek-api-key' } }, inherited: {}, override: {} }],
    },
    get(service) { return this[service] },
    effect(fn) { fn() },
    logger: { info() {}, warn() {} },
  }
  globalThis.fetch = async (url) => fixtureFetch(String(url))
  apply(ctx, {})
  assert.ok(route, 'fallback route registered')
  assert.equal(route.kind, 'prefix')
  assert.equal(route.path, '/dshp-quota')

  const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-1', method: 'snapshot', payload: {} })
  const req = Object.assign(Readable.from([Buffer.from(body)]), {
    method: 'POST',
    url: '/dshp-quota/snapshot',
    headers: { 'content-type': 'application/json' },
  })
  const res = {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body = chunk ?? '' },
  }
  await route.handler(req, res)
  assert.equal(res.status, 200)
  const envelope = JSON.parse(res.body)
  assert.equal(envelope.type, 'server-response')
  assert.equal(envelope.rpcId, 'rpc-1')
  assert.equal(envelope.result.ok, true)
  assert.equal(envelope.result.value.ok, true)
  assert.equal(envelope.result.value.snapshot.providers[0].vendor, 'deepseek')
  assert.ok(!res.body.includes('test-deepseek'), 'response must not leak the key')
})

await test('fallback route rejects an unauthenticated request', async () => {
  const { Readable } = await import('node:stream')
  let route
  const ctx = {
    connection: {
      rpc: { handle() { throw new Error('no rpc') } },
      admit() { return { rejection: 401 } },
    },
    webServer: { register(next) { route = next; return () => {} } },
    credentials: {},
    settings: { describe: () => [] },
    llm: { listConfigurableProviders: () => [], listProviders: () => [] },
    configEditor: { configuration: () => [] },
    get(service) { return this[service] },
    effect(fn) { fn() },
    logger: { info() {}, warn() {} },
  }
  apply(ctx, {})
  const req = Object.assign(Readable.from([Buffer.from('{}')]), {
    method: 'POST',
    url: '/dshp-quota/snapshot',
    headers: { 'content-type': 'application/json' },
  })
  const res = {
    status: 0,
    body: '',
    writeHead(status) { this.status = status },
    end(chunk) { this.body = chunk ?? '' },
  }
  await route.handler(req, res)
  assert.equal(res.status, 401)
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.error(`\n${failure.label}\n${failure.error?.stack || failure.error}`)
  process.exit(1)
}


