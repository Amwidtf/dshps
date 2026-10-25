/**
 * Local harness for the dshp-quota Host half: builds a mock Cordis context plus a
 * scripted fetch, then exercises provider discovery, vendor adapters, caching,
 * failure classification and secret hygiene. Run: node tools/test-host.mjs
 */
import assert from 'node:assert/strict'
import { apply, Config, inject, name } from '../plugins/dshp-quota/host.js'
import * as net from '../plugins/dshp-net/host.js'
import * as models from '../plugins/dshp-models/host.js'
import * as shell from '../index.js'
import * as workflow from '../plugins/dshp-workflow/host.js'

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

// ---------------------------------------------------------------------------
// dshp-net: pure routing / .env / proxy helpers
// ---------------------------------------------------------------------------

await test('dshp-net parses and redacts proxy URLs', () => {
  assert.deepEqual(net.parseProxyUrl('http://127.0.0.1:7890'), { scheme: 'http', host: '127.0.0.1', port: 7890, ok: true })
  assert.equal(net.parseProxyUrl('https://proxy.example.test:8443').scheme, 'https')
  assert.equal(net.parseProxyUrl('socks5://127.0.0.1:1080').ok, false)
  assert.equal(net.parseProxyUrl('not a url').ok, false)
  const redacted = net.redactProxyUrl('http://dshps:very-secret-token@127.0.0.1:17890')
  assert.ok(redacted.includes('***'), 'password masked')
  assert.ok(!redacted.includes('very-secret-token'), 'secret removed')
})

await test('dshp-net port fallback candidates keep the configured port first', () => {
  assert.deepEqual(net.portCandidates(0), [0])
  const defaultPorts = net.portCandidates(17890)
  assert.equal(defaultPorts[0], 17890, 'configured port tried first')
  assert.equal(defaultPorts[1], 17891, 'next port is the first fallback')
  assert.equal(defaultPorts[defaultPorts.length - 1], 0, 'ephemeral port is the last resort')
  assert.equal(net.portCandidates(65535)[0], 65535)
  assert.ok(net.portCandidates(65535).every((port) => port === 0 || port <= 65535))
})

await test('dshp-net merges .env lines without touching unrelated entries', () => {
  const merged = net.mergeEnvFile('FOO=1\nHTTP_PROXY=http://old.example.test:1\n# keep me\n', {
    HTTP_PROXY: 'http://127.0.0.1:17890',
    HTTPS_PROXY: 'http://127.0.0.1:17890',
    ALL_PROXY: null,
  })
  assert.ok(merged.includes('FOO=1'), 'unrelated key preserved')
  assert.ok(merged.includes('# keep me'), 'comment preserved')
  assert.ok(merged.includes('HTTP_PROXY=http://127.0.0.1:17890'), 'proxy replaced')
  assert.ok(merged.includes('HTTPS_PROXY=http://127.0.0.1:17890'), 'https proxy added')
  assert.ok(!merged.includes('old.example.test'), 'old proxy removed')
  assert.ok(!merged.includes('ALL_PROXY'), 'null removes the line')
})

await test('dshp-net routes exact hosts, wildcard domains and the default', () => {
  const table = {
    defaultProxy: 'direct',
    entries: [
      { provider: 'openai', hosts: ['api.openai.com'], domains: ['*.openai.com'], proxy: 'proxy-a' },
      { provider: 'kimi', hosts: ['api.kimi.com'], domains: [], proxy: 'proxy-b' },
    ],
  }
  assert.deepEqual(net.matchRoute(table, 'api.openai.com'), { proxy: 'proxy-a', provider: 'openai' })
  assert.deepEqual(net.matchRoute(table, 'auth.openai.com'), { proxy: 'proxy-a', provider: 'openai' })
  assert.deepEqual(net.matchRoute(table, 'api.kimi.com'), { proxy: 'proxy-b', provider: 'kimi' })
  assert.deepEqual(net.matchRoute(table, 'unmapped.example.test'), { proxy: 'direct', provider: null })
  assert.equal(net.formatBytes(512), '512 B')
  assert.ok(net.formatBytes(1536).includes('1.5 KB'))
  assert.ok(net.formatBytes(2 * 1024 * 1024).includes('2'))
})

// ---------------------------------------------------------------------------
// dshp-models: official OAuth helpers + RPC smoke (no network)
// ---------------------------------------------------------------------------

await test('dshp-models helpers match the official ChatGPT OAuth flow', () => {
  assert.equal(models.isUuid('123e4567-e89b-12d3-a456-426614174000'), true)
  assert.equal(models.isUuid('not-a-uuid'), false)
  assert.equal(models.normalizeCallbackPort('1455'), 1455)
  assert.equal(models.normalizeCallbackPort(80), 1455)
  assert.equal(models.normalizeCallbackPort(70000), 1455)
  assert.equal(models.pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  const url = new URL(models.buildAuthorizeUrl({
    deviceId: '123e4567-e89b-12d3-a456-426614174000',
    agentName: 'dshps-test',
    callbackPort: 1455,
    state: 'state-test',
    nonce: 'nonce-test',
    challenge: 'challenge-test',
  }))
  assert.equal(url.origin, 'https://auth.openai.com')
  assert.equal(url.pathname, '/api/accounts/authorize')
  assert.equal(url.searchParams.get('client_id'), 'dynamic_agent_client')
  assert.equal(url.searchParams.get('agent_name_hint'), 'dshps-test')
  assert.equal(url.searchParams.get('ext_agent_host_id'), 'urn:uuid:123e4567-e89b-12d3-a456-426614174000')
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:1455/auth/callback')
  assert.equal(url.searchParams.get('resource'), 'https://api.openai.com/v1')
  assert.equal(url.searchParams.get('code_challenge_method'), 'S256')
  assert.ok(url.searchParams.get('scope').includes('chatgpt.tokens.use.direct'))
  assert.deepEqual(
    models.parseCallbackUrl('http://127.0.0.1:1455/auth/callback?code=code-test&state=state-test&client_id=oaiapp_test', 'state-test'),
    { code: 'code-test', clientId: 'oaiapp_test' },
  )
  assert.throws(() => models.parseCallbackUrl('http://127.0.0.1:1455/auth/callback?code=code-test&state=other&client_id=oaiapp_test', 'state-test'))
  const credential = models.buildCredential({
    access: 'access-test',
    refresh: 'refresh-test',
    scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
    expiresIn: 3600,
    clientId: 'oaiapp_test',
  })
  assert.equal(credential.type, 'oauth')
  assert.equal(credential.clientId, 'oaiapp_test')
  assert.ok(Array.isArray(credential.scopes) && credential.scopes.includes('chatgpt.tokens.use.direct'))
  assert.ok(typeof credential.expires === 'number' && credential.expires > Date.now())
  assert.throws(() => models.buildCredential({ access: 'a', refresh: 'r', scope: 'openid', expiresIn: 10, clientId: 'c' }))
})

function makeModelsCtx({ grant, flows, mutateCalls } = {}) {
  let handler
  const deleted = []
  const ctx = {
    connection: { rpc: { handle(channel, fn) { handler = { channel, fn }; return () => {} } } },
    settings: {
      describe: () => [
        { ns: 'dshp-models', revision: 5, value: { chatgpt: { deviceId: '', agentName: 'dshps', callbackPort: 1455 } } },
        { ns: 'llm-pi-ai', revision: 8, value: { providers: { openai: {} } } },
      ],
      async mutate(ns, ops, revision) {
        if (mutateCalls) mutateCalls.push({ ns, ops, revision })
      },
    },
    credentials: {
      async readRecord(key) { return key === 'llm-pi-ai/openai' ? grant : undefined },
      async describeRecord(key) { return { configured: Boolean(grant) && key === 'llm-pi-ai/openai', kind: grant ? 'grant' : undefined } },
      async modifyRecord() { return undefined },
      async deleteRecord(key) { deleted.push(key) },
    },
    llm: {
      listConfigurableProviders: () => [{
        provider: 'openai',
        displayName: 'OpenAI',
        settingsNs: 'llm-pi-ai',
        settingsPath: ['providers', 'openai'],
        defaultBaseURL: 'https://api.openai.com/v1',
        nativeAuth: { env: ['OPENAI_API_KEY'], oauth: true },
      }],
    },
    authorization: flows === undefined ? undefined : { list: () => flows, begin: async () => ({ status: 'authorized' }), cancel() {} },
    get(service) { return this[service] },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  models.apply(ctx, { chatgpt: { deviceId: '', agentName: 'dshps', callbackPort: 1455 } })
  assert.ok(handler, 'dshp-models rpc channel registered')
  assert.equal(handler.channel, '/dshp-models')
  return { deleted, call: (endpoint, payload) => handler.fn(endpoint, payload, undefined) }
}

await test('dshp-models snapshot reports a stored OAuth grant without leaking tokens', async () => {
  const grant = {
    kind: 'grant',
    payload: {
      type: 'oauth',
      access: 'test-access-token',
      refresh: 'test-refresh-token',
      expires: Date.now() + 3_600_000,
      clientId: 'oaiapp_test',
      scopes: ['chatgpt.tokens.use.direct'],
    },
  }
  const ctx = makeModelsCtx({ grant })
  const envelope = await ctx.call('snapshot', {})
  assert.equal(envelope.ok, true)
  assert.equal(envelope.value.ok, true)
  const snapshot = envelope.value.snapshot
  assert.equal(snapshot.chatgpt.signedIn, true)
  assert.equal(snapshot.chatgpt.recordKind, 'grant')
  assert.equal(snapshot.chatgpt.routeConfigured, true)
  assert.equal(snapshot.chatgpt.routeHasKeyOverride, false)
  assert.ok(snapshot.chatgpt.expiresInMs > 0)
  const serialized = JSON.stringify(envelope)
  assert.ok(!serialized.includes('test-access-token'), 'access token never serialized')
  assert.ok(!serialized.includes('test-refresh-token'), 'refresh token never serialized')
})

await test('dshp-models lists authorization flows and rejects flow start without the seam', async () => {
  const flows = [{ key: 'llm-pi-ai/openai-codex', label: 'ChatGPT (Codex)', methods: [{ id: 'oauth', label: 'Sign in with ChatGPT' }], inFlight: false }]
  const ctx = makeModelsCtx({ flows })
  const envelope = await ctx.call('snapshot', {})
  assert.equal(envelope.value.snapshot.flows.length, 1)
  assert.equal(envelope.value.snapshot.flows[0].key, 'llm-pi-ai/openai-codex')
  const noSeam = makeModelsCtx({})
  const started = await noSeam.call('flow-start', { key: 'llm-pi-ai/openai-codex' })
  assert.equal(started.ok, false)
})

await test('dshp-models logout deletes the OAuth credential record', async () => {
  const ctx = makeModelsCtx({})
  const envelope = await ctx.call('chatgpt-logout', {})
  assert.equal(envelope.ok, true)
  assert.deepEqual(ctx.deleted, ['llm-pi-ai/openai'])
})

await test('dshp-net RPC applies and reverts the .env bootstrap in a temporary DSH_HOME', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-net-test-'))
  const previousHome = process.env.DSH_HOME
  const previousDisable = process.env.DSHPS_DISABLE_ROUTER
  process.env.DSH_HOME = dir
  process.env.DSHPS_DISABLE_ROUTER = '1'
  try {
    let handler
    const records = new Map()
    const mutateCalls = []
    const ctx = {
      connection: { rpc: { handle(channel, fn) { handler = { channel, fn }; return () => {} } } },
      settings: {
        describe: () => [{ ns: 'dshp-net', revision: 4, value: {} }],
        async mutate(ns, ops, revision) { mutateCalls.push({ ns, ops, revision }) },
      },
      credentials: {
        async readRecord(key) { return records.get(key) },
        async modifyRecord(key, mutate) {
          const next = await mutate(records.get(key))
          if (next === undefined) records.delete(key)
          else records.set(key, next)
          return records.get(key)
        },
        async deleteRecord(key) { records.delete(key) },
        async describeRecord(key) { return { configured: records.has(key), kind: records.get(key)?.kind } },
      },
      llm: { listConfigurableProviders: () => [], listProviders: () => [] },
      get(service) { return this[service] },
      effect() {},
      logger: { info() {}, warn() {} },
    }
    net.apply(ctx, {
      port: 17990,
      defaultProxy: 'direct',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 100, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    assert.ok(handler, 'dshp-net rpc channel registered')
    assert.equal(handler.channel, '/dshp-net')
    const snap = await handler.fn('snapshot', {}, undefined)
    assert.equal(snap.ok, true)
    assert.equal(snap.value.ok, true)
    assert.equal(snap.value.snapshot.router.running, false)
    assert.ok(Array.isArray(snap.value.snapshot.config.proxies))

    const written = await handler.fn('config-write', {
      config: {
        defaultProxy: 'direct',
        proxies: [{ id: 'proxy-a', label: 'A', url: 'http://127.0.0.1:7890', enabled: true }],
        providers: { openai: { proxy: 'direct', domains: ['auth.openai.com'] } },
      },
    }, undefined)
    assert.equal(written.ok, true)
    assert.ok(written.value.snapshot.config.proxies.some((proxy) => proxy.id === 'proxy-a'))
    assert.equal(mutateCalls.length > 0 && mutateCalls[0].ns, 'dshp-net')

    const applied = await handler.fn('env-apply', {}, undefined)
    assert.equal(applied.ok, true)
    const envText = await readFile(join(dir, '.env'), 'utf8')
    assert.ok(envText.includes('HTTP_PROXY=http://dshps:'), 'router proxy written to .env')
    assert.ok(envText.includes('127.0.0.1:17990'), 'router port written')
    const token = records.get('dshp-net/router-token')?.key
    assert.ok(typeof token === 'string' && token.length >= 32, 'router token persisted in the credential store')
    assert.ok(!JSON.stringify(applied).includes(token), 'router token never echoed')

    const reverted = await handler.fn('env-revert', {}, undefined)
    assert.equal(reverted.ok, true)
    const after = await readFile(join(dir, '.env'), 'utf8').catch(() => '')
    assert.ok(!after.includes('HTTP_PROXY=http://dshps:'), 'managed line removed on revert')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDisable === undefined) delete process.env.DSHPS_DISABLE_ROUTER
    else process.env.DSHPS_DISABLE_ROUTER = previousDisable
    await rm(dir, { recursive: true, force: true })
  }
})

await test('dshp-net falls back to the next free port when the configured port is occupied', async () => {
  const http = await import('node:http')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-net-port-'))
  const previousHome = process.env.DSH_HOME
  const previousDisable = process.env.DSHPS_DISABLE_ROUTER
  process.env.DSH_HOME = dir
  delete process.env.DSHPS_DISABLE_ROUTER
  const blocker = http.createServer((req, res) => res.end('occupied'))
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const occupied = blocker.address().port
  try {
    let handler
    const records = new Map()
    const rows = [{ ns: 'dshp-net', revision: 1, value: {} }]
    const ctx = {
      connection: { rpc: { handle(channel, fn) { handler = { channel, fn }; return () => {} } } },
      settings: {
        describe: () => rows,
        async mutate(ns, ops) {
          const row = rows.find((entry) => entry.ns === ns)
          for (const operation of ops) {
            if (operation.op !== 'set') continue
            const path = Array.isArray(operation.path) ? operation.path : []
            let target = row.value
            for (const key of path.slice(0, -1)) {
              if (!target[key] || typeof target[key] !== 'object') target[key] = {}
              target = target[key]
            }
            if (path.length > 0) target[path[path.length - 1]] = operation.value
          }
          row.revision += 1
        },
      },
      credentials: {
        async readRecord(key) { return records.get(key) },
        async modifyRecord(key, mutate) {
          const next = await mutate(records.get(key))
          if (next === undefined) records.delete(key)
          else records.set(key, next)
          return records.get(key)
        },
        async deleteRecord(key) { records.delete(key) },
        async describeRecord(key) { return { configured: records.has(key), kind: records.get(key)?.kind } },
      },
      llm: { listConfigurableProviders: () => [], listProviders: () => [] },
      get(service) { return this[service] },
      effect() {},
      logger: { info() {}, warn() {} },
    }
    net.apply(ctx, {
      port: occupied,
      defaultProxy: 'direct',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 10, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    const waitForRouter = async () => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const result = await handler.fn('snapshot', {}, undefined)
        if (result?.value?.snapshot?.router?.running === true) return result
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
      throw new Error('gateway did not start')
    }
    const snap = await waitForRouter()
    const router = snap.value.snapshot.router
    assert.equal(router.running, true, 'gateway started despite the occupied port')
    assert.equal(router.configPort, occupied)
    assert.notEqual(router.port, occupied, 'a different port was chosen')
    assert.ok(router.portFallback, 'fallback metadata is exposed before .env apply')
    assert.equal(router.portFallback.configuredPort, occupied)
    assert.equal(router.portFallback.actualPort, router.port)
    assert.equal(router.restartRequired, false, 'fallback does not look like a config change')

    const applied = await handler.fn('env-apply', {}, undefined)
    assert.equal(applied.ok, true)
    assert.equal(applied.value.adoptedPort, router.port, 'env apply adopts the fallback port as the configured port')
    assert.equal(applied.value.adoptedFrom, occupied)
    const snapAfter = await handler.fn('snapshot', {}, undefined)
    const routerAfter = snapAfter.value.snapshot.router
    assert.equal(routerAfter.configPort, router.port, 'configured port now matches the running port')
    assert.equal(routerAfter.portFallback, null, 'fallback state is cleared after adoption')
    const envText = await readFile(join(dir, '.env'), 'utf8')
    assert.ok(envText.includes(`127.0.0.1:${router.port}`), '.env uses the adopted port')
    const warningCodes = Array.isArray(snapAfter.value.snapshot.env?.warningCodes) ? snapAfter.value.snapshot.env.warningCodes : []
    assert.ok(warningCodes.some((entry) => entry.code === 'restart-required'), 'adoption still requires a DSH restart')
    assert.ok(!warningCodes.some((entry) => entry.code === 'port-fallback'), 'fallback warning is gone after adoption')
    await handler.fn('env-revert', {}, undefined)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDisable === undefined) delete process.env.DSHPS_DISABLE_ROUTER
    else process.env.DSHPS_DISABLE_ROUTER = previousDisable
    await new Promise((resolve) => blocker.close(resolve))
    await rm(dir, { recursive: true, force: true })
  }
})

await test('dshp-net config-write persists proxies and provider routing on the settings row', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-net-save-'))
  const previousHome = process.env.DSH_HOME
  const previousDisable = process.env.DSHPS_DISABLE_ROUTER
  process.env.DSH_HOME = dir
  process.env.DSHPS_DISABLE_ROUTER = '1'
  const rows = [{ ns: 'dshp-net', revision: 1, value: {} }]
  const makeCtx = (handlerRef) => ({
    connection: { rpc: { handle(channel, fn) { handlerRef.handler = fn; return () => {} } } },
    settings: {
      describe: () => rows,
      async mutate(ns, ops) {
        const row = rows.find((entry) => entry.ns === ns)
        for (const operation of ops) {
          if (operation.op !== 'set') continue
          const path = Array.isArray(operation.path) ? operation.path : []
          let target = row.value
          for (const key of path.slice(0, -1)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {}
            target = target[key]
          }
          if (path.length > 0) target[path[path.length - 1]] = operation.value
        }
        row.revision += 1
      },
    },
    credentials: {
      async readRecord() { return undefined },
      async modifyRecord() { return undefined },
      async deleteRecord() {},
      async describeRecord() { return { configured: false } },
    },
    llm: { listConfigurableProviders: () => [], listProviders: () => [] },
    get(service) { return this[service] },
    effect() {},
    logger: { info() {}, warn() {} },
  })
  try {
    const first = {}
    net.apply(makeCtx(first), {
      port: 17992,
      defaultProxy: 'proxy-work',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 10, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    const written = await first.handler('config-write', {
      config: {
        defaultProxy: 'proxy-work',
        proxies: [{
          id: 'proxy-work',
          label: '公司代理',
          url: 'http://127.0.0.1:7890',
          username: '',
          enabled: true,
        }],
        providers: { openai: { proxy: 'proxy-work', domains: ['auth.openai.com'] } },
      },
    }, undefined)
    assert.equal(written.ok, true)
    assert.equal(rows[0].value.defaultProxy, 'proxy-work')
    assert.equal(rows[0].value.proxies['proxy-work'].label, '公司代理')
    assert.deepEqual(rows[0].value.providers.openai, { proxy: 'proxy-work', domains: ['auth.openai.com'] })

    // A fresh service instance reading the same settings row (i.e. after a
    // plugin reload / DSH restart) must show the saved proxy and routing.
    const second = {}
    net.apply(makeCtx(second), {
      port: 17992,
      defaultProxy: 'direct',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 10, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    const snap = await second.handler('snapshot', {}, undefined)
    assert.equal(snap.ok, true)
    const proxy = snap.value.snapshot.config.proxies.find((entry) => entry.id === 'proxy-work')
    assert.ok(proxy, 'saved proxy survives a fresh service instance')
    assert.equal(proxy.label, '公司代理')
    const openaiRule = snap.value.snapshot.config.providers.find((entry) => entry.id === 'openai')
    assert.ok(openaiRule, 'provider rule is present')
    assert.equal(openaiRule.proxy, 'proxy-work')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDisable === undefined) delete process.env.DSHPS_DISABLE_ROUTER
    else process.env.DSHPS_DISABLE_ROUTER = previousDisable
    await rm(dir, { recursive: true, force: true })
  }
})

await test('dshp-net port save rewrites the managed .env and reports restart', async () => {
  const http = await import('node:http')
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-net-port-save-'))
  const previousHome = process.env.DSH_HOME
  const previousDisable = process.env.DSHPS_DISABLE_ROUTER
  process.env.DSH_HOME = dir
  delete process.env.DSHPS_DISABLE_ROUTER
  const probe = http.createServer()
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const initialPort = probe.address().port
  await new Promise((resolve) => probe.close(resolve))
  const rows = [{ ns: 'dshp-net', revision: 1, value: { port: initialPort } }]
  let handler
  const ctx = {
    connection: { rpc: { handle(channel, fn) { handler = fn; return () => {} } } },
    settings: {
      describe: () => rows,
      async mutate(ns, ops) {
        const row = rows.find((entry) => entry.ns === ns)
        for (const operation of ops) {
          if (operation.op !== 'set') continue
          const path = Array.isArray(operation.path) ? operation.path : []
          let target = row.value
          for (const key of path.slice(0, -1)) {
            if (!target[key] || typeof target[key] !== 'object') target[key] = {}
            target = target[key]
          }
          if (path.length > 0) target[path[path.length - 1]] = operation.value
        }
        row.revision += 1
      },
    },
    credentials: {
      async readRecord() { return undefined },
      async modifyRecord() { return undefined },
      async deleteRecord() {},
      async describeRecord() { return { configured: false } },
    },
    llm: { listConfigurableProviders: () => [], listProviders: () => [] },
    get(service) { return this[service] },
    effect() {},
    logger: { info() {}, warn() {} },
  }
  try {
    net.apply(ctx, {
      port: initialPort,
      defaultProxy: 'direct',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 10, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    const applied = await handler('env-apply', {}, undefined)
    assert.equal(applied.ok, true)
    const before = await readFile(join(dir, '.env'), 'utf8')
    assert.ok(before.includes(`127.0.0.1:${initialPort}`))

    const changed = await handler('config-write', {
      config: { defaultProxy: 'direct', port: 37890, proxies: [], providers: {} },
    }, undefined)
    assert.equal(changed.ok, true)
    assert.equal(changed.value.portChanged, true)
    assert.equal(changed.value.envRewritten, true, 'a managed .env is rewritten for the new port')
    assert.equal(rows[0].value.port, 37890, 'settings row stores the new port')
    const after = await readFile(join(dir, '.env'), 'utf8')
    assert.ok(after.includes('127.0.0.1:37890'), '.env points at the new port')
    assert.ok(!after.includes(`127.0.0.1:${initialPort}`), 'old managed URL is replaced')
    assert.equal(changed.value.snapshot.config.port, 37890)
    assert.equal(changed.value.snapshot.router.restartRequired, true, 'port changes require a restart')
    assert.equal(changed.value.snapshot.env.pendingRestart, true, 'env is written but the process still uses the old port')

    const same = await handler('config-write', {
      config: { defaultProxy: 'direct', port: 37890, proxies: [], providers: {} },
    }, undefined)
    assert.equal(same.value.portChanged, false, 'an unchanged port is not reported as a change')
    assert.equal(same.value.envRewritten, undefined, 'no redundant .env rewrite')

    const invalid = await handler('config-write', {
      config: { defaultProxy: 'direct', port: 80, proxies: [], providers: {} },
    }, undefined)
    assert.equal(invalid.ok, false, 'invalid ports are rejected')
    assert.equal(invalid.error.code, 'bad-request')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDisable === undefined) delete process.env.DSHPS_DISABLE_ROUTER
    else process.env.DSHPS_DISABLE_ROUTER = previousDisable
    await rm(dir, { recursive: true, force: true })
  }
})

await test('dshp-net falls back to its own authenticated RPC route', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-net-rpc-'))
  const previousHome = process.env.DSH_HOME
  const previousDisable = process.env.DSHPS_DISABLE_ROUTER
  process.env.DSH_HOME = dir
  process.env.DSHPS_DISABLE_ROUTER = '1'
  try {
    let route
    const ctx = {
      connection: {
        rpc: { handle() { throw new Error('rpc registry unavailable') } },
        admit() { return { peer: { id: 'peer-test' } } },
      },
      webServer: { register(next) { route = next; return () => {} } },
      settings: { describe: () => [], async mutate() {} },
      credentials: {
        async readRecord() { return undefined },
        async modifyRecord() { return undefined },
        async deleteRecord() {},
      },
      llm: { listConfigurableProviders: () => [] },
      get(service) { return this[service] },
      effect(fn) { fn() },
      logger: { info() {}, warn() {} },
    }
    net.apply(ctx, {
      port: 17991,
      defaultProxy: 'direct',
      proxies: {},
      providers: {},
      monitor: { enabled: false, maxLogs: 50, healthIntervalSeconds: 0, healthUrl: 'https://example.test/' },
    })
    assert.ok(route, 'fallback route registered')
    assert.equal(route.kind, 'prefix')
    assert.equal(route.path, '/dshp-net')
    const body = JSON.stringify({ type: 'client-request', rpcId: 'rpc-net', method: 'snapshot', payload: {} })
    const request = Object.assign(Readable.from([Buffer.from(body)]), {
      method: 'POST',
      url: '/dshp-net/snapshot',
      headers: { 'content-type': 'application/json' },
    })
    const response = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(chunk) { this.body = chunk ?? '' },
    }
    await route.handler(request, response)
    assert.equal(response.status, 200)
    const envelope = JSON.parse(response.body)
    assert.equal(envelope.result.ok, true)
    const result = envelope.result.value
    const payload = result && result.ok === true && result.value && result.value.ok === true ? result.value : result
    assert.equal(payload.ok, true)
    assert.ok(payload.snapshot.router)
    assert.ok(Array.isArray(payload.snapshot.config.proxies))
    // The same route refuses an unauthenticated caller.
    ctx.connection.admit = () => ({ rejection: 401 })
    const denied = {
      status: 0,
      body: '',
      writeHead(status) { this.status = status },
      end(chunk) { this.body = chunk ?? '' },
    }
    await route.handler(Object.assign(Readable.from([Buffer.from(body)]), {
      method: 'POST',
      url: '/dshp-net/snapshot',
      headers: { 'content-type': 'application/json' },
    }), denied)
    assert.equal(denied.status, 401)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    if (previousDisable === undefined) delete process.env.DSHPS_DISABLE_ROUTER
    else process.env.DSHPS_DISABLE_ROUTER = previousDisable
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// dshps root: floating-layer state service
// ---------------------------------------------------------------------------

await test('dshps floating state sanitizes and clamps persisted geometry', () => {
  const defaults = shell.defaultState()
  assert.equal(defaults.version, shell.STATE_VERSION)
  assert.equal(defaults.enabled, true)
  assert.equal(defaults.windows.monitor.locked, false)
  const sanitized = shell.sanitizeState({
    version: 99,
    revision: -3,
    enabled: 'yes',
    fabLocked: true,
    fab: { x: -2, y: 5 },
    satellites: { monitor: false, bad: 'nope' },
    windows: {
      monitor: { open: true, collapsed: 'x', x: 2, y: -1, w: 10, h: 999999, z: -4 },
      unknown: { open: true, x: 0.5, y: 0.5, w: 300, h: 200 },
      'Bad Id': { open: true },
    },
  })
  assert.equal(sanitized.version, shell.STATE_VERSION)
  assert.equal(sanitized.enabled, true)
  assert.equal(sanitized.fabLocked, true)
  assert.equal(sanitized.fab.x, 0)
  assert.equal(sanitized.fab.y, 1)
  assert.equal(sanitized.satellites.monitor, false)
  assert.equal(sanitized.satellites.audit, true)
  assert.equal(sanitized.windows.monitor.open, true)
  assert.equal(sanitized.windows.monitor.locked, false)
  assert.equal(sanitized.windows.monitor.w, 240)
  assert.equal(sanitized.windows.monitor.h, 4000)
  assert.equal(sanitized.windows.monitor.x, 1)
  assert.equal(sanitized.windows.monitor.z, 0)
  assert.ok(sanitized.windows.unknown, 'unknown window ids preserved')
  assert.equal(sanitized.windows['Bad Id'], undefined)
  assert.ok(sanitized.nextZ > sanitized.windows.unknown.z)
})

await test('dshps floating-state RPC persists, detects conflicts and resets', async () => {
  const { mkdtemp, readFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const { Readable } = await import('node:stream')
  const dir = await mkdtemp(join(tmpdir(), 'dshps-shell-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = dir
  try {
    let route
    const ctx = {
      connection: {
        rpc: { handle() { throw new Error('shared rpc registry unavailable') } },
        admit() { return { peer: { id: 'peer-test' } } },
      },
      webServer: { register(next) { route = next; return () => {} } },
      get(service) { return this[service] },
      effect(fn) { fn() },
      logger: { info() {}, warn() {} },
    }
    shell.apply(ctx)
    assert.ok(route, 'floating-layer fallback route registered')
    assert.equal(route.path, '/dshp-shell')
    const call = async (endpoint, payload) => {
      const body = JSON.stringify({ type: 'client-request', rpcId: `rpc-${endpoint}`, method: endpoint, payload })
      const request = Object.assign(Readable.from([Buffer.from(body)]), {
        method: 'POST',
        url: `/dshp-shell/${endpoint}`,
        headers: { 'content-type': 'application/json' },
      })
      const response = {
        status: 0,
        body: '',
        writeHead(status) { this.status = status },
        end(chunk) { this.body = chunk ?? '' },
      }
      await route.handler(request, response)
      assert.equal(response.status, 200)
      const parsed = JSON.parse(response.body)
      return parsed.result.ok === true ? parsed.result.value : parsed.result
    }
    const initial = await call('state', {})
    assert.equal(initial.ok, true)
    assert.equal(initial.state.windows.monitor.open, false)
    assert.equal(initial.revision, 0)
    const stale = JSON.parse(JSON.stringify(initial.state))
    stale.fab = { x: 0.5, y: 0.4 }
    stale.windows.monitor = { ...stale.windows.monitor, open: true, x: 0.3, y: 0.2, w: 360, h: 260 }
    const saved = await call('save', { state: stale, revision: initial.revision })
    assert.equal(saved.ok, true)
    assert.equal(saved.revision, 1)
    assert.equal(saved.state.windows.monitor.open, true)
    const fileText = await readFile(join(dir, 'dshps', 'floating-ui.json'), 'utf8')
    const persisted = JSON.parse(fileText)
    assert.equal(persisted.fab.x, 0.5)
    assert.equal(persisted.windows.monitor.w, 360)
    const conflict = await call('save', { state: stale, revision: initial.revision })
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'state-conflict')
    const reset = await call('reset', {})
    assert.equal(reset.ok, true)
    assert.equal(reset.state.windows.monitor.open, false)
    assert.equal(reset.state.enabled, true)
    assert.ok(reset.revision > saved.revision)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// dshp-workflow Host plugin
// ---------------------------------------------------------------------------

function makeWorkflowCtx({ cwd, settingsValue = {}, settingsMutate, subagentResult, shellResult }) {
  const captured = {}
  const ctx = {
    connection: {
      rpc: {
        handle(channel, dispatch) {
          captured.channel = channel
          captured.rawDispatch = dispatch
          captured.dispatch = async (endpoint, payload, signal) => {
            const result = await dispatch(endpoint, payload, signal, { id: 'peer-test' })
            return result.ok === true ? result.value : result
          }
          return () => {}
        },
      },
      admit() { return { peer: { id: 'peer-test' } } },
    },
    settings: {
      describe: () => [{ ns: 'dshp-workflow', revision: 3, value: settingsValue }],
      mutate: settingsMutate || (async () => {}),
    },
    subagents: {
      async startActivation(spec) {
        captured.activation = spec
        const result = subagentResult || {
          stopReason: 'completed',
          output: [{ type: 'text', text: `child:${String(spec.request.prompt[0].text).slice(0, 24)}` }],
          structured: spec.request.outputSchema ? { ok: true } : undefined,
        }
        return {
          childId: 'child-test',
          result: Promise.resolve(result),
          dispose: async () => {},
        }
      },
    },
    shell: {
      resolve(request) { return { ...request, workdir: request.workdir || cwd } },
      async execute(spec) {
        captured.shell = spec
        return {
          async result() {
            return shellResult || {
              exitCode: 0,
              signal: null,
              timedOut: false,
              aborted: false,
              stdout: { text: 'shell-ok' },
              stderr: { text: '' },
              sandbox: { mode: 'workspace-write', denied: false },
            }
          },
        }
      },
    },
    sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: cwd }) },
    fs: {
      async resolve(pathLike) {
        const text = String(pathLike)
        return { targetKey: text, displayPath: text.startsWith(cwd) ? text : `${cwd}/${text}` }
      },
      contains() { return true },
      processPath(target) { return target.displayPath },
      async readText() { return 'file-content' },
      async listDir() { return [] },
      async stat() { return undefined },
    },
    workingDirectory: { defaultDirectory: cwd, get: () => cwd },
    sessions: { get: (id) => ({ id }) },
    tools: {
      register(definition) {
        captured.tool = definition
        return () => {}
      },
    },
    commands: {
      register(definition) {
        captured.command = definition
        return () => {}
      },
    },
    systemPrompt: {
      section(section) {
        captured.section = section
        return () => {}
      },
    },
    webServer: { register() { return () => {} } },
    get(service) { return this[service] },
    effect(fn) { fn() },
    logger: { info() {}, warn() {} },
  }
  return { ctx, captured }
}

async function withWorkflowHome(fn) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const home = await mkdtemp(join(tmpdir(), 'dshps-workflow-home-'))
  const cwd = await mkdtemp(join(tmpdir(), 'dshps-workflow-cwd-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn({ home, cwd })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(home, { recursive: true, force: true })
    await rm(cwd, { recursive: true, force: true })
  }
}

await test('dshp-workflow plugin exposes config, RPC, tool, command and prompt sections', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    workflow.apply(ctx, {})
    assert.equal(captured.channel, '/dshp-workflow')
    assert.equal(typeof captured.dispatch, 'function')
    const envelope = await captured.rawDispatch('snapshot', {}, undefined, { id: 'peer-test' })
    assert.equal(envelope.ok, true)
    assert.ok(envelope.value && typeof envelope.value === 'object', 'shared RPC returns { ok, value }')
    assert.equal(captured.tool.name, 'workflow_plus')
    assert.equal(captured.tool.parameters.type, 'object')
    assert.equal(captured.command.name, 'workflow')
    assert.equal(captured.section.name, 'dshp-workflow')
    assert.ok(Array.isArray(workflow.inject))
    assert.ok(workflow.inject.includes('subagents'))
    assert.ok(workflow.Config)
    assert.equal(workflow.name, 'dshp-workflow')
  })
})

await test('dshp-workflow RPC settings document and revision-checked writes', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const writes = []
    const settingsMutate = async (ns, ops, revision) => { writes.push({ ns, ops, revision }) }
    const { ctx, captured } = makeWorkflowCtx({ cwd, settingsMutate })
    workflow.apply(ctx, {})
    const doc = await captured.dispatch('settings', {}, undefined)
    assert.equal(doc.ok, true)
    assert.equal(doc.available, true)
    assert.equal(doc.revision, 3)
    assert.equal(doc.value.toolName, 'workflow_plus')
    const written = await captured.dispatch('settings-write', {
      ops: [{ op: 'set', path: ['maxConcurrentAgents'], value: 999 }],
      revision: 3,
    }, undefined)
    assert.equal(written.ok, true)
    assert.equal(writes.length, 1)
    assert.equal(writes[0].ns, 'dshp-workflow')
    assert.equal(writes[0].ops[0].value, 32, 'numeric settings are clamped')
    const rejected = await captured.dispatch('settings-write', {
      ops: [{ op: 'set', path: ['notAField'], value: true }],
      revision: 3,
    }, undefined)
    assert.equal(rejected.ok, false)
    assert.equal(rejected.error.code, 'bad-request')
    const conflictSettings = async () => { throw new Error('settings conflict: stale revision') }
    const second = makeWorkflowCtx({ cwd, settingsMutate: conflictSettings })
    workflow.apply(second.ctx, {})
    const conflict = await second.captured.dispatch('settings-write', {
      ops: [{ op: 'set', path: ['enabled'], value: false }],
    }, undefined)
    assert.equal(conflict.ok, false)
    assert.equal(conflict.error.code, 'settings-conflict')
  })
})

await test('dshp-workflow library RPC saves, lists, reads and deletes workflows', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    workflow.apply(ctx, {})
    const text = '/* @dshp-workflow {"name":"Saved smoke","description":"saved smoke" } */\nreturn 1'
    const saved = await captured.dispatch('workflow-save', { id: 'saved-smoke', scope: 'global', text }, undefined)
    assert.equal(saved.ok, true)
    const listed = await captured.dispatch('workflows-list', { scope: 'global' }, undefined)
    assert.equal(listed.ok, true)
    assert.equal(listed.workflows.length, 1)
    assert.equal(listed.workflows[0].id, 'saved-smoke')
    assert.deepEqual(listed.workflows[0].capabilities, ['orchestrate'])
    const read = await captured.dispatch('workflow-read', { id: 'saved-smoke', scope: 'global' }, undefined)
    assert.equal(read.ok, true)
    assert.match(read.document, /Saved smoke/)
    const deleted = await captured.dispatch('workflow-delete', { id: 'saved-smoke', scope: 'global' }, undefined)
    assert.equal(deleted.ok, true)
    assert.equal((await captured.dispatch('workflows-list', {}, undefined)).workflows.length, 0)
  })
})

await test('dshp-workflow refuses ad-hoc scripts by default', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    workflow.apply(ctx, {})
    await assert.rejects(
      captured.tool.execute({
        script: 'return 1',
        meta: { name: 'ad hoc', description: 'ad hoc' },
      }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
      (error) => error.code === 'ad-hoc-disabled',
    )
    await assert.rejects(
      captured.tool.execute({
        name: 'project-flow',
        scope: 'project',
      }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
      (error) => error.code === 'project-workflow-gated',
    )
  })
})

await test('dshp-workflow tool runs an orchestrate workflow and records the run', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    workflow.apply(ctx, { allowAdHocScripts: true, childPreset: 'read-only' })
    const result = await captured.tool.execute({
      script: 'phase("collect")\nconst a = await agent("hello", { preset: "write-all" })\nreport({ a })\nreturn { a }',
      meta: { name: 'tool smoke', description: 'tool smoke' },
      args: { n: 1 },
    }, { agent: { id: 'session-test' }, signal: new AbortController().signal })
    assert.equal(result.status, 'completed')
    assert.equal(result.stopReason, 'completed')
    assert.equal(result.value.a.startsWith('child:'), true)
    assert.equal(result.usage.agents, 1)
    assert.equal(captured.activation.request.agentPreset, 'read-only', 'configured childPreset wins over the script')
    const runs = await captured.dispatch('runs-list', { limit: 10 }, undefined)
    assert.equal(runs.ok, true)
    assert.equal(runs.runs.length, 1)
    const detail = await captured.dispatch('run-read', { runId: runs.runs[0].id }, undefined)
    assert.equal(detail.ok, true)
    assert.equal(detail.run.status, 'completed')
    assert.equal(detail.run.phases.length, 1)
    assert.equal(detail.run.agents.length, 1)
    assert.equal(detail.run.agents[0].cached, false)
  })
})

await test('dshp-workflow cancellation disposes a published child activation', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    let disposals = 0
    ctx.subagents.startActivation = async () => ({
      childId: 'child-hang',
      result: new Promise(() => {}),
      dispose: async () => { disposals += 1 },
    })
    workflow.apply(ctx, { allowAdHocScripts: true })
    const controller = new AbortController()
    const pending = captured.tool.execute({
      script: 'await agent("hang forever")\nreturn 1',
      meta: { name: 'cancel smoke', description: 'cancel smoke' },
    }, { agent: { id: 'session-test' }, signal: controller.signal })
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50))
    controller.abort()
    const result = await pending
    assert.equal(result.stopReason, 'cancelled')
    assert.ok(disposals >= 1, 'published activation is disposed on abort')
  })
})

await test('dshp-workflow execute capability is gated, allowlisted and command-checked', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const denied = makeWorkflowCtx({ cwd })
    workflow.apply(denied.ctx, { allowAdHocScripts: true })
    await assert.rejects(
      denied.captured.tool.execute({
        script: 'return await world.run("git", ["status"])',
        meta: { name: 'exec smoke', description: 'exec smoke', capabilities: ['execute'] },
      }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
      (error) => error.code === 'WF_CAPABILITY_DENIED',
    )
    const allowed = makeWorkflowCtx({ cwd })
    workflow.apply(allowed.ctx, {
      allowExecute: true,
      allowAdHocExecute: true,
      allowAdHocScripts: true,
      allowedCommands: ['git'],
    })
    const ok = await allowed.captured.tool.execute({
      script: 'const r = await world.run("git", ["status"])\nreturn { exitCode: r.exitCode }',
      meta: { name: 'exec smoke', description: 'exec smoke', capabilities: ['execute'] },
    }, { agent: { id: 'session-test' }, signal: new AbortController().signal })
    assert.equal(ok.status, 'completed')
    assert.equal(ok.value.exitCode, 0)
    if (process.platform === 'win32') {
      assert.ok(String(allowed.captured.shell.command).startsWith('& '), 'pwsh commands use the call operator')
    }
    const blocked = await allowed.captured.tool.execute({
      script: 'return await world.run("rm", ["-rf", "x"])',
      meta: { name: 'exec blocked', description: 'exec blocked', capabilities: ['execute'] },
    }, { agent: { id: 'session-test' }, signal: new AbortController().signal })
    assert.equal(blocked.stopReason, 'error')
    assert.equal(blocked.error.code, 'WF_COMMAND_DENIED')
  })
})

await test('dshp-workflow binds execute authorization to the workflow content hash', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const text = '/* @dshp-workflow {"name":"exec saved","description":"exec saved","capabilities":["execute"]} */\nreturn await world.run("git", ["status"])'
    const first = makeWorkflowCtx({ cwd })
    workflow.apply(first.ctx, { allowAdHocScripts: true })
    const saved = await first.captured.dispatch('workflow-save', { id: 'exec-saved', scope: 'global', text }, undefined)
    assert.equal(saved.ok, true)
    const listed = await first.captured.dispatch('workflows-list', {}, undefined)
    assert.equal(listed.ok, true)
    const hash = listed.workflows.find((entry) => entry.id === 'exec-saved')?.hash
    assert.match(hash, /^[0-9a-f]{64}$/)

    const noGrant = makeWorkflowCtx({ cwd })
    workflow.apply(noGrant.ctx, { allowExecute: true, allowedCommands: ['git'] })
    await assert.rejects(
      noGrant.captured.tool.execute({
        name: 'exec-saved',
      }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
      (error) => error.code === 'execute-not-allowed' && String(error.message).includes(`exec-saved@${hash}`),
    )

    const granted = makeWorkflowCtx({ cwd })
    workflow.apply(granted.ctx, {
      allowExecute: true,
      allowedCommands: ['git'],
      executeAllowlist: [`exec-saved@${hash}`],
    })
    const ok = await granted.captured.tool.execute({
      name: 'exec-saved',
    }, { agent: { id: 'session-test' }, signal: new AbortController().signal })
    assert.equal(ok.status, 'completed')
    assert.equal(ok.value.exitCode, 0)

    const tampered = '/* @dshp-workflow {"name":"exec saved","description":"changed","capabilities":["execute"]} */\nreturn await world.run("git", ["status"])'
    const overwrite = await first.captured.dispatch('workflow-save', { id: 'exec-saved', scope: 'global', text: tampered }, undefined)
    assert.equal(overwrite.ok, true)
    await assert.rejects(
      granted.captured.tool.execute({
        name: 'exec-saved',
      }, { agent: { id: 'session-test' }, signal: new AbortController().signal }),
      (error) => error.code === 'execute-not-allowed',
    )
  })
})

await test('dshp-workflow /workflow command lists and reports runs', async () => {
  await withWorkflowHome(async ({ cwd }) => {
    const { ctx, captured } = makeWorkflowCtx({ cwd })
    workflow.apply(ctx, {})
    const help = await captured.command.handler({ agent: { id: 'session-test' }, rawInput: 'help', attachments: [], signal: new AbortController().signal })
    assert.equal(help.kind, 'success')
    assert.match(help.text, /run <id>/)
    const list = await captured.command.handler({ agent: { id: 'session-test' }, rawInput: 'list', attachments: [], signal: new AbortController().signal })
    assert.equal(list.kind, 'success')
    assert.match(list.text, /没有 global 工作流|没有/)
  })
})

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) {
  for (const failure of failures) console.error(`\n${failure.label}\n${failure.error?.stack || failure.error}`)
  process.exit(1)
}


