/**
 * dshps — shared Web client bundle.
 *
 * Registers:
 *  - `dshp-quota` panel in `sidebar.footer.action` (the additive row directly
 *    above the sidebar user/settings area);
 *  - the dshps settings section (`settings.section`) where plugin options such as
 *    the GLM team organisation/project live.
 *
 * The panel reads data from the matching Host plugin through the authenticated
 * Connection RPC channel; API keys never enter this browser context.
 */
window.__ModuleLoader__.load({
  id: 'dshps',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useMemo, useRef, useState } = React

    const NS = 'dshp-quota'
    const CHANNEL = '/dshp-quota'
    const QUOTA_NS = 'dshp-quota'
    const DEFAULT_POLL_MS = 60_000

    const ZH = {
      title: '额度余额',
      openDetails: '展开额度与订阅详情',
      close: '收起',
      refresh: '刷新',
      refreshing: '刷新中…',
      loading: '查询中…',
      loadFailed: '连接失败',
      updatedAt: '更新于',
      never: '尚未获取',
      empty: '未配置可查询的供应商',
      emptyHint: '在「设置 → 模型」中添加供应商后会自动出现',
      unconfigured: '未配置',
      notConfigured: '需配置 Key',
      unavailable: '暂不可查',
      remaining: '剩余',
      used: '已用',
      balance: '余额',
      total: '总额',
      available: '可用',
      granted: '赠送',
      toppedUp: '充值',
      cash: '现金',
      voucher: '代金券',
      frozen: '冻结',
      usedAmount: '已消费',
      plan: '套餐',
      renewal: '续费',
      team: '团队',
      teamYes: '团队版',
      reset: '重置',
      noPlan: '未检测到额度',
      usedUp: '已用完',
      quotaOnly: '额度',
      balanceOnly: '余额',
      mixed: '余额与额度',
      totalUsage: '总使用量',
      totalUsageKimi: 'Kimi',
      totalUsageCode: 'Code',
      totalUsageNeedToken: '总使用量需要网页 refresh_token，可在 设置 → DSH 插件栈 填写',
      totalUsageAuth: '网页登录态失效，请在设置页更新 Kimi token',
      totalUsageReset: '重置',
      kimiTokenTitle: 'Kimi 总使用量（网页 refresh_token）',
      kimiTokenHint: '「总使用量」需要网页 refresh_token（约 90 天，自动续期）。在 kimi.com 控制台按 F12 → Network，找 RefreshToken 请求，复制请求体里的 refresh_token；不要粘贴 15 分钟过期的 access token。token 用 DPAPI 加密存本机，不进项目。',
      kimiTokenLabel: '网页 refresh_token',
      kimiTokenApply: '应用',
      kimiTokenClear: '清除',
      kimiTokenApplied: '已保存',
      kimiTokenCleared: '已清除',
      kimiTokenInvalid: 'token 无法识别',
      kimiTokenActive: '已设置',
      kimiTokenInactive: '未设置',
      note: '说明',
      supported: '支持',
      details: '详情',
      scrollHint: '滚轮切换',
      short5h: '5h',
      shortWeek: '周',
      shortMonth: '月',
      overview: '总览',
      errorAuth: '凭据无效或站点不匹配',
      errorNeedConfig: '缺少 API Key',
      errorNetwork: '网络请求失败',
      errorHttp: '上游服务返回错误',
      errorGone: '查询接口暂不可用',
      errorUnsupported: '暂不支持该供应商',
      errorParse: '响应格式无法识别',
      errorNoPlan: '未检测到套餐',
      errorNeedContext: '需配置团队参数',
      errorShortAuth: '鉴权失败',
      errorShortNoPlan: '无套餐',
      errorShortNeedContext: '需配置团队',
      errorShortOther: '查询失败',
      settingsTitle: 'DSH 插件栈',
      settingsDescription: 'dshps 插件配置。',
      settingsQuotaTitle: '额度余额（dshp-quota）',
      settingsQuotaDescription: '供应商与 Key 沿用「设置 → 模型」，这里只填查询参数。',
      settingsDetected: '已检测供应商',
      settingsDetectedEmpty: '未检测到供应商，请先到「设置 → 模型」配置。',
      settingsGlmTeam: '智谱 GLM 团队版',
      settingsGlmTeamHint: '团队版 Coding Plan 需要组织与项目 ID；个人账号留空。只用于额度查询，不影响模型请求。',
      settingsOrg: '组织 ID（bigmodel-organization）',
      settingsProject: '项目 ID（bigmodel-project）',
      settingsType: 'type 参数（团队版通常为 2）',
      settingsRefresh: '自动刷新',
      settingsRefreshHint: '刷新间隔（秒），15–3600。',
      settingsSave: '保存',
      settingsSaving: '保存中…',
      settingsSaved: '已保存',
      settingsReload: '重新读取',
      settingsUnavailable: '设置服务不可用。',
      settingsNoRpc: 'RPC 不可用',
      settingsStatus: '状态',
      settingsPageError: '设置页出错',
      settingsMissing: '配置未加载，请稍后重试。',
      settingsConflict: '配置已被其他窗口修改，已重新读取。',
      settingsOrderHint: '顺序跟随「设置 → 模型」。',
      settingsPluginList: '插件配置',
    }

    const EN = {
      title: 'Balance',
      openDetails: 'Show balance and subscription details',
      close: 'Collapse',
      refresh: 'Refresh',
      refreshing: 'Refreshing…',
      loading: 'Querying…',
      loadFailed: 'Connection failed',
      updatedAt: 'Updated',
      never: 'not yet',
      empty: 'No queryable provider configured',
      emptyHint: 'Add providers under Settings → Models and they appear here',
      unconfigured: 'Not configured',
      notConfigured: 'Add a key in Settings',
      unavailable: 'Unavailable',
      remaining: 'Left',
      used: 'Used',
      balance: 'Balance',
      total: 'Total',
      available: 'Available',
      granted: 'Granted',
      toppedUp: 'Topped up',
      cash: 'Cash',
      voucher: 'Voucher',
      frozen: 'Frozen',
      usedAmount: 'Spent',
      plan: 'Plan',
      renewal: 'Renews',
      team: 'Team',
      teamYes: 'Team',
      reset: 'resets',
      noPlan: 'No quota found',
      usedUp: 'Used up',
      quotaOnly: 'Quota',
      balanceOnly: 'Balance',
      mixed: 'Balance + quota',
      totalUsage: 'Total usage',
      totalUsageKimi: 'Kimi',
      totalUsageCode: 'Code',
      totalUsageNeedToken: 'Total usage needs the web refresh_token; set it under Settings → DSH Plugin Stack',
      totalUsageAuth: 'Web session expired; update the Kimi token in Settings',
      totalUsageReset: 'resets',
      kimiTokenTitle: 'Kimi total usage (web refresh_token)',
      kimiTokenHint: 'Total usage needs the web refresh_token (≈90 days, auto-renewed). Open the kimi.com console, F12 → Network, find the RefreshToken request and copy refresh_token from its body. Do not paste the 15-minute access token. The token is DPAPI-encrypted locally and never enters the project.',
      kimiTokenLabel: 'Web refresh_token',
      kimiTokenApply: 'Apply',
      kimiTokenClear: 'Clear',
      kimiTokenApplied: 'Saved',
      kimiTokenCleared: 'Cleared',
      kimiTokenInvalid: 'Unrecognized token',
      kimiTokenActive: 'set',
      kimiTokenInactive: 'not set',
      note: 'Note',
      supported: 'Supported',
      details: 'Details',
      scrollHint: 'Scroll to switch',
      short5h: '5h',
      shortWeek: 'Week',
      shortMonth: 'Month',
      overview: 'Overview',
      errorAuth: 'Invalid credential or wrong site',
      errorNeedConfig: 'Missing API key',
      errorNetwork: 'Network request failed',
      errorHttp: 'Upstream service error',
      errorGone: 'Endpoint unavailable',
      errorUnsupported: 'Vendor is not supported',
      errorParse: 'Unrecognized response',
      errorNoPlan: 'No plan detected',
      errorNeedContext: 'Team settings required',
      errorShortAuth: 'Auth failed',
      errorShortNoPlan: 'No plan',
      errorShortNeedContext: 'Needs team config',
      errorShortOther: 'Query failed',
      settingsTitle: 'DSH Plugin Stack',
      settingsDescription: 'dshps plugin settings.',
      settingsQuotaTitle: 'Balance & Quota (dshp-quota)',
      settingsQuotaDescription: 'Providers and keys come from Settings → Models; only query options live here.',
      settingsDetected: 'Detected providers',
      settingsDetectedEmpty: 'No provider detected; configure one under Settings → Models.',
      settingsGlmTeam: 'Zhipu GLM team plan',
      settingsGlmTeamHint: 'The team Coding Plan needs organisation and project IDs; leave empty for a personal account. Used only for quota queries.',
      settingsOrg: 'Organisation ID (bigmodel-organization)',
      settingsProject: 'Project ID (bigmodel-project)',
      settingsType: 'type parameter (usually 2 for team)',
      settingsRefresh: 'Auto refresh',
      settingsRefreshHint: 'Interval in seconds (15–3600).',
      settingsSave: 'Save',
      settingsSaving: 'Saving…',
      settingsSaved: 'Saved',
      settingsReload: 'Reload',
      settingsUnavailable: 'Settings service unavailable.',
      settingsNoRpc: 'RPC unavailable',
      settingsStatus: 'Status',
      settingsPageError: 'Settings page error',
      settingsMissing: 'Configuration not loaded yet.',
      settingsConflict: 'Configuration changed elsewhere; reloaded.',
      settingsOrderHint: 'Order follows Settings → Models.',
      settingsPluginList: 'Plugin configuration',
    }

    const GROUP_LABEL = {
      deepseek: 'DeepSeek',
      minimax: 'MiniMax',
      zhipu: '智谱 GLM',
      kimi: 'Kimi',
    }

    const VENDOR_COLOR = {
      deepseek: '#5b6cff',
      minimax: '#ef5b5b',
      zhipu: '#0f9be0',
      kimi: '#8b5cf6',
      unknown: '#6b7280',
    }

    const CSS = `
.dshp-q-root{position:relative;flex:1 1 auto;min-width:0;font-size:12px;line-height:1.3;color:var(--dsw-alias-label-primary);}
.dshp-q-root[data-wide="false"]{flex:0 0 auto;}
.dshp-q-summary{display:flex;flex-direction:column;gap:4px;width:100%;min-width:0;padding:6px 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:inherit;font:inherit;text-align:left;cursor:pointer;}
.dshp-q-summary:hover{border-color:var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);}
.dshp-q-summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px;}
.dshp-q-head{display:flex;align-items:center;gap:6px;min-width:0;}
.dshp-q-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshp-q-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-idle-primary);flex:none;}
.dshp-q-dot[data-status="ok"]{background:var(--dsw-alias-state-success-primary);}
.dshp-q-dot[data-status="warn"]{background:var(--dsw-alias-state-warn-primary);}
.dshp-q-dot[data-status="error"]{background:var(--dsw-alias-state-error-primary);}
.dshp-q-time{margin-left:auto;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;}
.dshp-q-body{display:flex;flex-direction:column;gap:2px;min-width:0;}
.dshp-q-row{display:flex;align-items:center;gap:6px;min-width:0;height:17px;}
.dshp-q-vdot{width:7px;height:7px;border-radius:2px;flex:none;}
.dshp-q-name{flex:0 1 auto;min-width:0;color:var(--dsw-alias-label-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshp-q-plan{flex:none;max-width:74px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:10px;line-height:14px;padding:0 4px;border-radius:4px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshp-q-value{margin-left:auto;flex:none;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap;}
.dshp-q-value[data-muted="true"]{font-weight:400;color:var(--dsw-alias-label-secondary);}
.dshp-q-more{color:var(--dsw-alias-label-secondary);font-size:11px;}
.dshp-q-iconbtn{display:inline-flex;align-items:center;justify-content:center;width:30px;height:30px;padding:0;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,8px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer;position:relative;}
.dshp-q-iconbtn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dshp-q-iconbtn .dshp-q-dot{position:absolute;top:4px;right:4px;}
.dshp-q-pop{position:fixed;z-index:80;width:330px;max-height:min(76vh,600px);overflow:auto;box-sizing:border-box;padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;background:var(--dsw-alias-bg-overlay);box-shadow:0 14px 38px rgba(0,0,0,.24);color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.45;}
.dshp-q-pop-head{display:flex;align-items:center;gap:8px;margin-bottom:10px;}
.dshp-q-pop-title{font-size:13px;font-weight:600;margin-right:auto;}
.dshp-q-btn{height:24px;padding:0 9px;border-radius:var(--dsw-radius-sm,6px);border:1px solid var(--dsw-alias-border-l1);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;cursor:pointer;white-space:nowrap;}
.dshp-q-btn:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dshp-q-btn:disabled{opacity:.5;cursor:default;}
.dshp-q-tabs{display:flex;gap:4px;padding:3px;margin-bottom:10px;border-radius:9px;background:var(--dsw-alias-bg-layer-2);overflow-x:auto;scrollbar-width:none;}
.dshp-q-tabs::-webkit-scrollbar{display:none;}
.dshp-q-tab{display:inline-flex;align-items:center;gap:5px;flex:none;height:25px;padding:0 9px;border:none;border-radius:7px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-weight:500;cursor:pointer;white-space:nowrap;}
.dshp-q-tab:hover{color:var(--dsw-alias-label-primary);}
.dshp-q-tab[data-active="true"]{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.12);}
.dshp-q-tab .dshp-q-dot{width:5px;height:5px;}
.dshp-q-card{padding:2px 0;}
.dshp-q-card + .dshp-q-card{margin-top:8px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1);}
.dshp-q-card-head{display:flex;align-items:center;gap:6px;margin-bottom:6px;min-width:0;}
.dshp-q-card-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshp-q-kind{flex:none;font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dshp-q-team{flex:none;font-size:10px;line-height:15px;padding:0 5px;border-radius:999px;color:#fff;background:var(--dsw-alias-brand-primary);}
.dshp-q-planline{display:flex;align-items:center;gap:6px;margin:4px 0 6px;flex-wrap:wrap;}
.dshp-q-planname{font-weight:600;}
.dshp-q-kv{display:flex;gap:6px;justify-content:space-between;padding:1px 0;color:var(--dsw-alias-label-secondary);}
.dshp-q-kv b{color:var(--dsw-alias-label-primary);font-weight:600;font-variant-numeric:tabular-nums;}
.dshp-q-win{margin-top:8px;}
.dshp-q-total{margin-top:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);}
.dshp-q-win-head{display:flex;gap:6px;align-items:baseline;min-width:0;}
.dshp-q-win-label{color:var(--dsw-alias-label-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshp-q-win-value{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;white-space:nowrap;}
.dshp-q-win-value[data-low="true"]{color:var(--dsw-alias-state-warn-primary);}
.dshp-q-bar{height:5px;margin-top:4px;border-radius:3px;background:var(--dsw-alias-bg-layer-2);overflow:hidden;}
.dshp-q-bar i{display:block;height:100%;border-radius:3px;background:var(--dsw-alias-brand-primary);}
.dshp-q-bar[data-low="true"] i{background:var(--dsw-alias-state-warn-primary);}
.dshp-q-meta{margin-top:3px;color:var(--dsw-alias-label-secondary);font-size:11px;}
.dshp-q-error{margin-top:5px;color:var(--dsw-alias-state-error-primary);font-size:11px;word-break:break-word;}
.dshp-q-note{margin-top:5px;color:var(--dsw-alias-label-secondary);font-size:11px;word-break:break-word;}
.dshp-q-empty{color:var(--dsw-alias-label-secondary);padding:2px 0;}
.dshp-q-pop-foot{margin-top:10px;padding-top:9px;border-top:1px solid var(--dsw-alias-border-l1);display:flex;gap:6px;flex-wrap:wrap;color:var(--dsw-alias-label-secondary);font-size:11px;align-items:center;}
.dshp-q-chip{padding:0 6px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;line-height:17px;}
.dshp-q-chip[data-off="true"]{opacity:.5;border-style:dashed;}
.dshp-set{display:flex;flex-direction:column;gap:14px;color:var(--dsw-alias-label-primary);font-size:13px;}
.dshp-set-head h2{margin:0 0 4px;font-size:16px;font-weight:650;}
.dshp-set-head p,.dshp-set-hint{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;}
.dshp-set-card{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:14px 16px;background:var(--dsw-alias-bg-layer-1);}
.dshp-set-card h3{margin:0 0 4px;font-size:13px;font-weight:650;}
.dshp-set-sub{margin:0 0 10px;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.55;}
.dshp-set-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:10px 14px;}
.dshp-set-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dshp-set-label{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dshp-set input[type="text"],.dshp-set input[type="number"]{height:30px;padding:0 9px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
.dshp-set input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.dshp-set-actions{display:flex;align-items:center;gap:10px;margin-top:12px;}
.dshp-set-primary{height:30px;padding:0 16px;border:none;border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:12px;font-weight:600;cursor:pointer;}
.dshp-set-primary:disabled{opacity:.55;cursor:default;}
.dshp-set-secondary{height:30px;padding:0 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
.dshp-set-status{font-size:12px;color:var(--dsw-alias-state-success-primary);}
.dshp-set-status[data-error="true"]{color:var(--dsw-alias-state-error-primary);}
.dshp-set-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}
.dshp-set-chip{display:inline-flex;align-items:center;gap:5px;padding:2px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:999px;font-size:11px;color:var(--dsw-alias-label-secondary);}
.dshp-set-chip b{color:var(--dsw-alias-label-primary);font-weight:600;}
.dshp-set-divider{height:1px;background:var(--dsw-alias-border-l1);margin:12px 0;}
.dshp-set-meta{margin:12px 0 0;color:var(--dsw-alias-label-secondary);font-size:11px;opacity:.8;}
@media (prefers-reduced-motion:no-preference){.dshp-q-pop{transition:opacity .12s ease}}
/* readability overrides */
.dshp-q-root{font-size:12.5px;}
.dshp-q-summary{padding:8px 9px;gap:5px;background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);}
.dshp-q-title{font-size:12.5px;}
.dshp-q-row{height:19px;font-size:12.5px;}
.dshp-q-name{color:var(--dsw-alias-label-primary);opacity:.85;}
.dshp-q-value{font-size:12.5px;}
.dshp-q-plan{font-size:10.5px;line-height:15px;max-width:86px;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);}
.dshp-q-pop{width:352px;font-size:13px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dshp-q-pop-title{font-size:14px;}
.dshp-q-btn{height:26px;padding:0 10px;font-size:12px;border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dshp-q-tabs{background:var(--dsw-alias-bg-layer-2);}
.dshp-q-tab{height:28px;font-size:12px;}
.dshp-q-tabs{flex-wrap:wrap;row-gap:4px;overflow:visible;}
.dshp-q-tab{height:26px;padding:0 8px;gap:4px;font-size:11.5px;max-width:100%;}
.dshp-q-tab .dshp-q-dot{width:5px;height:5px;}
.dshp-q-card-name{font-size:13px;}
.dshp-q-kind{font-size:10.5px;line-height:16px;color:var(--dsw-alias-label-secondary);border-color:var(--dsw-alias-border-l2);}
.dshp-q-planname{font-size:13px;}
.dshp-q-kv{font-size:12.5px;padding:2px 0;}
.dshp-q-win-label{font-size:12.5px;}
.dshp-q-win-value{font-size:12.5px;}
.dshp-q-meta{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dshp-q-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dshp-q-error{font-size:11.5px;}
.dshp-q-bar{height:6px;}
.dshp-q-pop-foot{font-size:11.5px;}
.dshp-q-chip{line-height:18px;border-color:var(--dsw-alias-border-l2);}
.dshp-q-total{border-top-color:var(--dsw-alias-border-l2);}
.dshp-q-team{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);}
.dshp-q-bar i{background:var(--dsw-alias-state-success-primary);}
.dshp-q-bar[data-low="true"] i{background:var(--dsw-alias-state-warn-primary);}
.dshp-set{font-size:13px;color:var(--dsw-alias-label-primary);}
.dshp-set-head h2{font-size:15px;}
.dshp-set-head p,.dshp-set-sub,.dshp-set-hint{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshp-set-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l2);padding:16px 18px;}
.dshp-set-card h3{font-size:14px;}
.dshp-set-grid{gap:12px 16px;}
.dshp-set-label{font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshp-set input[type="text"],.dshp-set input[type="number"],.dshp-set input[type="password"]{height:34px;font-size:13px;background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);}
.dshp-set input[type="password"]{height:34px;padding:0 9px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);font:inherit;font-size:13px;}
.dshp-set-primary,.dshp-set-secondary{height:30px;font-size:12.5px;}
.dshp-set-primary{background:var(--dsw-alias-bg-layer-1) !important;color:var(--dsw-alias-label-primary) !important;border:1px solid var(--dsw-alias-brand-primary);font-weight:600;}
.dshp-set-primary:hover{background:var(--dsw-alias-bg-layer-2) !important;}
.dshp-set-primary:disabled{opacity:.55;}
.dshp-set-secondary{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l2);}
.dshp-set-label{color:var(--dsw-alias-label-primary);opacity:.8;font-size:12.5px;}
.dshp-set-head p,.dshp-set-sub,.dshp-set-hint{color:var(--dsw-alias-label-secondary);font-size:12.5px;}
.dshp-set input[type="text"],.dshp-set input[type="number"],.dshp-set input[type="password"]{background:var(--dsw-alias-bg-base) !important;border-color:var(--dsw-alias-border-l2) !important;color:var(--dsw-alias-label-primary) !important;font-size:13px;}
.dshp-set-chip{color:var(--dsw-alias-label-primary);}
.dshp-set-chip b{font-weight:600;}
.dshp-set-status{font-size:12px;}
.dshp-set-card h3{color:var(--dsw-alias-label-primary);}
.dshp-set-chip{border-color:var(--dsw-alias-border-l2);line-height:20px;}
.dshp-set-meta[data-hidden="true"]{display:none;}
.dshp-q-row{height:auto;min-height:21px;flex-wrap:wrap;row-gap:2px;padding:2px 0;}
.dshp-q-metrics{margin-left:auto;display:flex;gap:8px;flex:none;font-variant-numeric:tabular-nums;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshp-q-metric{white-space:nowrap;}
.dshp-q-metric[data-low="true"]{color:var(--dsw-alias-state-warn-primary);font-weight:600;}
.dshp-q-overview{display:flex;flex-direction:column;gap:2px;padding:8px 2px 4px;}
.dshp-q-ovrow{display:flex;align-items:center;gap:8px;width:100%;padding:8px 7px;border:1px solid transparent;border-radius:var(--dsw-radius-sm,6px);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;cursor:pointer;text-align:left;}
.dshp-q-ovrow:hover{background:var(--dsw-alias-bg-layer-2);border-color:var(--dsw-alias-border-l1);}
.dshp-q-ovname{font-weight:600;}
.dshp-q-ovdot{display:inline-flex;align-items:center;justify-content:center;width:13px;font-size:12px;color:var(--dsw-alias-label-primary);opacity:.8;}
`

    // ------------------------------------------------------------------
    // formatting helpers
    // ------------------------------------------------------------------

    function isRecord(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    function currencySymbol(currency) {
      if (currency === 'CNY') return '¥'
      if (currency === 'USD') return '$'
      return typeof currency === 'string' && currency.length > 0 ? `${currency} ` : ''
    }

    function formatAmount(value) {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
      if (Number.isInteger(value)) return String(value)
      const abs = Math.abs(value)
      const digits = abs >= 100 ? 1 : 2
      return value.toFixed(digits)
    }

    const TIER_LABEL = {
      LEVEL_BASIC: 'Basic',
      LEVEL_INTERMEDIATE: 'Intermediate',
      LEVEL_ADVANCED: 'Advanced',
      LEVEL_PRO: 'Pro',
      BASIC: 'Basic',
      INTERMEDIATE: 'Intermediate',
      ADVANCED: 'Advanced',
      PRO: 'Pro',
    }

    function formatTier(tier) {
      if (typeof tier !== 'string' || tier.length === 0) return ''
      if (TIER_LABEL[tier]) return TIER_LABEL[tier]
      const lower = tier.toLowerCase()
      if (['max', 'pro', 'lite', 'air', 'plus'].includes(lower)) return lower.charAt(0).toUpperCase() + lower.slice(1)
      return tier.replace(/^LEVEL_/, '')
    }

    function formatMoney(balance) {
      if (!isRecord(balance)) return '—'
      const amount = balance.available ?? balance.total
      if (typeof amount !== 'number') return '—'
      return `${currencySymbol(balance.currency)}${formatAmount(amount)}`
    }

    function formatTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      const date = new Date(timestamp)
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${hh}:${mm}`
    }

    function formatDate(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      const date = new Date(timestamp)
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      return `${month}-${day}`
    }

    function formatDateTime(timestamp) {
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) return ''
      const date = new Date(timestamp)
      const year = date.getFullYear()
      const month = String(date.getMonth() + 1).padStart(2, '0')
      const day = String(date.getDate()).padStart(2, '0')
      const hh = String(date.getHours()).padStart(2, '0')
      const mm = String(date.getMinutes()).padStart(2, '0')
      return `${year}-${month}-${day} ${hh}:${mm}`
    }

    /** Full reset timestamp (local date + time), plus a compact countdown. */
    function formatReset(timestamp, t) {
      const full = formatDateTime(timestamp)
      if (full.length === 0) return ''
      let minutes = Math.max(0, Math.round((timestamp - Date.now()) / 60_000))
      let countdown = ''
      if (minutes > 0) {
        const days = Math.floor(minutes / 1440)
        minutes -= days * 1440
        const hours = Math.floor(minutes / 60)
        minutes -= hours * 60
        const parts = []
        if (days > 0) parts.push(`${days}d`)
        if (hours > 0) parts.push(`${hours}h`)
        if (days === 0 && minutes > 0) parts.push(`${minutes}m`)
        countdown = parts.join(' ')
      }
      return countdown.length > 0 ? `${t('reset')} ${full} (${countdown})` : `${t('reset')} ${full}`
    }

    function windowRemainingPercent(entry) {
      if (!isRecord(entry)) return undefined
      if (typeof entry.remainingPercent === 'number') return entry.remainingPercent
      if (typeof entry.usedPercent === 'number') return 100 - entry.usedPercent
      if (typeof entry.limit === 'number' && entry.limit > 0 && typeof entry.remaining === 'number') return (entry.remaining / entry.limit) * 100
      return undefined
    }

    /** Compact window bucket: 5h / week / month. */
    function windowCategory(entry) {
      if (!isRecord(entry)) return undefined
      const key = typeof entry.key === 'string' ? entry.key : ''
      const label = typeof entry.label === 'string' ? entry.label : ''
      if (key === 'booster' || key === 'package' || key === 'parallel' || key === 'tools') return undefined
      if (key === 'weekly' || label.includes('每周') || /week/i.test(label)) return 'week'
      if (key === 'interval' || label.includes('小时') || /hour/i.test(label)) return '5h'
      if (key === 'monthly' || label.includes('月')) return 'month'
      return undefined
    }

    /** Remaining 5h / week / month values for the compact rows. */
    function compactMetrics(group) {
      const values = new Map()
      for (const provider of group.providers) {
        if (isRecord(provider.totalUsage) && typeof provider.totalUsage.totalPct === 'number' && !values.has('month')) {
          values.set('month', Math.max(0, 100 - provider.totalUsage.totalPct))
        }
        const windows = Array.isArray(provider.windows) ? provider.windows : []
        for (const entry of windows) {
          const category = windowCategory(entry)
          if (!category || values.has(category)) continue
          if (group.key === 'minimax' && typeof entry.label === 'string' && entry.label.includes('视频')) continue
          const remaining = windowRemainingPercent(entry)
          if (remaining === undefined) continue
          values.set(category, remaining)
        }
      }
      return ['5h', 'week', 'month'].filter((key) => values.has(key)).map((key) => ({ key, remaining: values.get(key) }))
    }

    function windowUsedPercent(entry) {
      if (!isRecord(entry)) return undefined
      if (typeof entry.usedPercent === 'number') return entry.usedPercent
      if (typeof entry.remainingPercent === 'number') return 100 - entry.remainingPercent
      return undefined
    }

    function vendorKeyOf(provider) {
      return provider.vendor === 'kimi-code' ? 'kimi' : provider.vendor
    }

    function groupProviders(providers) {
      const groups = []
      const index = new Map()
      for (const provider of Array.isArray(providers) ? providers : []) {
        const key = vendorKeyOf(provider) || 'unknown'
        let group = index.get(key)
        if (!group) {
          group = { key, label: GROUP_LABEL[key] || provider.vendorLabel || key, providers: [] }
          index.set(key, group)
          groups.push(group)
        }
        group.providers.push(provider)
      }
      return groups
    }

    function groupPlan(group) {
      for (const provider of group.providers) {
        if (isRecord(provider.plan) && typeof provider.plan.name === 'string' && provider.plan.name.length > 0) return provider.plan
      }
      return undefined
    }

    function groupTeam(group) {
      return group.providers.some((provider) => isRecord(provider.team) && provider.team.isTeam === true)
    }

    function groupStatus(group) {
      const statuses = group.providers.map((provider) => provider.status)
      if (statuses.includes('ok')) return 'ok'
      if (statuses.includes('need-config')) return 'warn'
      if (statuses.every((status) => status === 'error' || status === 'unsupported')) return 'error'
      return 'idle'
    }

    function errorShort(error, t) {
      if (!isRecord(error)) return t('errorShortOther')
      if (error.category === 'auth') return t('errorShortAuth')
      if (error.category === 'no-plan') return t('errorShortNoPlan')
      if (error.category === 'need-context') return t('errorShortNeedContext')
      return t('errorShortOther')
    }

    function errorText(error, t) {
      if (!isRecord(error)) return ''
      const category = error.category
      if (category === 'auth') return t('errorAuth')
      if (category === 'need-config') return t('errorNeedConfig')
      if (category === 'network') return t('errorNetwork')
      if (category === 'endpoint-gone') return t('errorGone')
      if (category === 'unsupported') return t('errorUnsupported')
      if (category === 'parse') return t('errorParse')
      if (category === 'no-plan') return t('errorNoPlan')
      if (category === 'need-context') return t('errorNeedContext')
      return typeof error.message === 'string' ? error.message : t('errorHttp')
    }

    function primaryValue(provider, t) {
      if (!isRecord(provider)) return '—'
      if (provider.status === 'need-config') return t('notConfigured')
      const balances = Array.isArray(provider.balances) ? provider.balances : []
      if (balances.length > 0) return balances.map(formatMoney).join(' / ')
      const totalUsage = isRecord(provider.totalUsage) ? provider.totalUsage : undefined
      if (totalUsage && typeof totalUsage.totalPct === 'number') {
        return `${t('totalUsage')} ${formatAmount(totalUsage.totalPct)}%`
      }
      const windows = Array.isArray(provider.windows) ? provider.windows : []
      const window = windows.find((entry) => windowRemainingPercent(entry) !== undefined)
      if (window) {
        const remaining = Math.round(windowRemainingPercent(window))
        return remaining <= 0 ? t('usedUp') : `${t('remaining')} ${remaining}%`
      }
      if (isRecord(provider.error) && provider.error.category === 'no-plan') return t('noPlan')
      if (provider.plan && provider.plan.name) return provider.plan.name
      if (isRecord(provider.error)) return `! ${errorShort(provider.error, t)}`
      return '—'
    }

    function groupValue(group, t) {
      for (const provider of group.providers) {
        if (provider.status !== 'ok') continue
        const value = primaryValue(provider, t)
        if (value && value !== '—') return value
      }
      const first = group.providers[0]
      if (first && first.status === 'need-config') return t('notConfigured')
      if (first && isRecord(first.error)) return errorShort(first.error, t)
      return '—'
    }

    function snapshotStatus(data) {
      if (!isRecord(data)) return 'idle'
      const providers = Array.isArray(data.providers) ? data.providers : []
      if (providers.length === 0) return 'empty'
      if (providers.some((provider) => provider.status === 'ok')) return 'ok'
      if (providers.some((provider) => provider.status === 'need-config')) return 'warn'
      return 'error'
    }

    // ------------------------------------------------------------------
    // slider/quota components
    // ------------------------------------------------------------------

    function VendorDot({ vendor, size = 7 }) {
      const color = VENDOR_COLOR[vendor] || VENDOR_COLOR.unknown
      return h('span', { className: 'dshp-q-vdot', style: { width: size, height: size, background: color }, 'aria-hidden': true })
    }

    function WindowLine({ entry, t }) {
      const remaining = windowRemainingPercent(entry)
      const used = windowUsedPercent(entry)
      const money = typeof entry.money === 'string' && entry.money.length > 0 ? entry.money : undefined
      const label = typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : t('quotaOnly')
      let right
      let barValue
      let low = false
      if (money) {
        const symbol = currencySymbol(money)
        const usedAmount = typeof entry.used === 'number' ? entry.used : undefined
        const limitAmount = typeof entry.limit === 'number' ? entry.limit : undefined
        right = usedAmount !== undefined && limitAmount !== undefined
          ? `${t('used')} ${symbol}${formatAmount(usedAmount)} / ${symbol}${formatAmount(limitAmount)}`
          : (remaining !== undefined ? `${t('remaining')} ${Math.round(remaining)}%` : '—')
        barValue = used !== undefined ? Math.min(100, Math.max(0, used)) : 0
        low = remaining !== undefined && remaining < 10
      } else {
        right = remaining !== undefined ? `${remaining <= 0 ? t('usedUp') : `${t('remaining')} ${Math.round(remaining)}%`}` : used !== undefined ? `${t('used')} ${Math.round(used)}%` : '—'
        barValue = remaining !== undefined ? Math.min(100, Math.max(0, remaining)) : 100
        low = remaining !== undefined && remaining < 10
      }
      const meta = []
      if (!money && typeof entry.used === 'number' && typeof entry.limit === 'number') meta.push(`${formatAmount(entry.used)} / ${formatAmount(entry.limit)}`)
      else if (!money && typeof entry.remaining === 'number' && remaining === undefined) meta.push(`${t('remaining')} ${formatAmount(entry.remaining)}`)
      const reset = formatReset(entry.resetsAt, t)
      if (reset) meta.push(reset)
      return h('div', { className: 'dshp-q-win' },
        h('div', { className: 'dshp-q-win-head' },
          h('span', { className: 'dshp-q-win-label' }, label),
          h('span', { className: 'dshp-q-win-value', 'data-low': low ? 'true' : 'false' }, right),
        ),
        h('div', { className: 'dshp-q-bar', 'data-low': low ? 'true' : 'false' }, h('i', { style: { width: `${barValue}%` } })),
        meta.length > 0 ? h('div', { className: 'dshp-q-meta' }, meta.join(' · ')) : null,
        Array.isArray(entry.details) && entry.details.length > 0
          ? h('div', { className: 'dshp-q-meta' }, entry.details.slice(0, 4).map((detail) => `${detail.name}: ${formatAmount(detail.usage)}`).join(' · '))
          : null,
      )
    }

    function BalanceLines({ balances, t }) {
      const rows = []
      const fields = [
        ['available', t('available')],
        ['total', t('total')],
        ['granted', t('granted')],
        ['toppedUp', t('toppedUp')],
        ['cash', t('cash')],
        ['voucher', t('voucher')],
        ['frozen', t('frozen')],
        ['used', t('usedAmount')],
      ]
      for (const balance of balances) {
        if (!isRecord(balance)) continue
        const symbol = currencySymbol(balance.currency)
        for (const [key, label] of fields) {
          const value = balance[key]
          if (typeof value !== 'number' || !Number.isFinite(value)) continue
          if (key === 'total' && typeof balance.available === 'number' && balance.total === balance.available) continue
          rows.push(h('div', { className: 'dshp-q-kv', key: `${balance.currency}-${key}` },
            h('span', null, label),
            h('b', null, `${symbol}${formatAmount(value)}`),
          ))
        }
      }
      return rows.length > 0 ? rows : null
    }

    function TotalUsageBlock({ totalUsage, t }) {
      if (!isRecord(totalUsage)) return null
      const hintStyle = { marginTop: '6px' }
      if (totalUsage.unavailable === 'need-token') {
        return h('div', { className: 'dshp-q-note', style: hintStyle }, t('totalUsageNeedToken'))
      }
      if (isRecord(totalUsage.error)) {
        const auth = totalUsage.error.category === 'auth'
        return h('div', { className: 'dshp-q-note', style: hintStyle }, auth ? t('totalUsageAuth') : `${errorText(totalUsage.error, t)}${totalUsage.error.message ? ' — ' + totalUsage.error.message : ''}`)
      }
      const totalPct = typeof totalUsage.totalPct === 'number' ? totalUsage.totalPct : undefined
      if (totalPct === undefined) return null
      const kimiPct = typeof totalUsage.kimiPct === 'number' ? totalUsage.kimiPct : Math.max(0, totalPct - (typeof totalUsage.codePct === 'number' ? totalUsage.codePct : 0))
      const codePct = typeof totalUsage.codePct === 'number' ? totalUsage.codePct : 0
      const reset = typeof totalUsage.resetsAt === 'number' ? formatReset(totalUsage.resetsAt, t) : ''
      return h('div', { className: 'dshp-q-total' },
        h('div', { className: 'dshp-q-win-head' },
          h('span', { className: 'dshp-q-win-label' }, t('totalUsage')),
          h('span', { className: 'dshp-q-win-value', 'data-low': totalPct > 90 ? 'true' : 'false' }, `${formatAmount(totalPct)}%`),
        ),
        h('div', { className: 'dshp-q-bar', 'data-low': totalPct > 90 ? 'true' : 'false' }, h('i', { style: { width: `${Math.min(100, Math.max(0, totalPct))}%` } })),
        h('div', { className: 'dshp-q-meta' },
          `${t('totalUsageKimi')} ${formatAmount(kimiPct)}% · ${t('totalUsageCode')} ${formatAmount(codePct)}%${reset ? ` · ${reset}` : ''}`),
      )
    }

    function ProviderCard({ provider, t }) {
      const balances = Array.isArray(provider.balances) ? provider.balances : []
      const windows = Array.isArray(provider.windows) ? provider.windows : []
      const plan = isRecord(provider.plan) ? provider.plan : undefined
      const team = isRecord(provider.team) ? provider.team : undefined
      const totalUsage = isRecord(provider.totalUsage) ? provider.totalUsage : undefined
      const kindLabel = provider.kind === 'balance' ? t('balanceOnly') : provider.kind === 'quota' ? t('quotaOnly') : provider.kind === 'mixed' ? t('mixed') : ''
      return h('div', { className: 'dshp-q-card' },
        h('div', { className: 'dshp-q-card-head' },
          h(VendorDot, { vendor: vendorKeyOf(provider), size: 8 }),
          h('span', { className: 'dshp-q-card-name' }, provider.label || provider.vendorLabel || provider.vendor),
          kindLabel ? h('span', { className: 'dshp-q-kind' }, kindLabel) : null,
          team && team.isTeam === true ? h('span', { className: 'dshp-q-team' }, t('teamYes')) : null,
        ),
        plan && plan.name ? h('div', { className: 'dshp-q-planline' },
          h('span', { className: 'dshp-q-planname' }, plan.name),
          plan.tier ? h('span', { className: 'dshp-q-kind' }, formatTier(plan.tier)) : null,
          plan.renewalAt ? h('span', { className: 'dshp-q-meta', style: { margin: 0 } }, `${t('renewal')} ${formatDate(plan.renewalAt)}`) : null,
        ) : null,
        balances.length > 0 ? h(BalanceLines, { balances, t }) : null,
        totalUsage ? h(TotalUsageBlock, { totalUsage, t }) : null,
        windows.map((entry, index) => h(WindowLine, { key: `${provider.id}-${entry.key || index}-${index}`, entry, t })),
        provider.note ? h('div', { className: 'dshp-q-note' }, provider.note) : null,
        isRecord(provider.error) ? h('div', { className: 'dshp-q-error' }, `${errorText(provider.error, t)}${provider.error.message ? ' — ' + provider.error.message : ''}`) : null,
      )
    }

    function CompactRow({ group, t }) {
      const plan = groupPlan(group)
      const metrics = compactMetrics(group)
      const labels = { '5h': t('short5h'), week: t('shortWeek'), month: t('shortMonth') }
      const balanceProvider = group.providers.find((provider) => provider.status === 'ok' && Array.isArray(provider.balances) && provider.balances.length > 0)
      return h('span', { className: 'dshp-q-row' },
        h(VendorDot, { vendor: group.key }),
        h('span', { className: 'dshp-q-name' }, group.label),
        plan && plan.name && plan.name !== 'Kimi Code' ? h('span', { className: 'dshp-q-plan' }, plan.name) : null,
        metrics.length > 0
          ? h('span', { className: 'dshp-q-metrics' },
            metrics.map((metric) => h('span', {
              key: metric.key,
              className: 'dshp-q-metric',
              'data-low': metric.remaining < 10 ? 'true' : 'false',
            }, `${labels[metric.key]} ${metric.remaining <= 0 ? '0%' : Math.round(metric.remaining) + '%'}`)),
          )
          : h('span', { className: 'dshp-q-value', 'data-muted': groupStatus(group) === 'ok' ? 'false' : 'true' },
            balanceProvider ? formatMoney(balanceProvider.balances[0]) : primaryValueOfGroup(group, t)),
      )
    }

    function primaryValueOfGroup(group, t) {
      for (const provider of group.providers) {
        if (provider.status !== 'ok') continue
        const value = primaryValue(provider, t)
        if (value && value !== '—') return value
      }
      const first = group.providers[0]
      if (first && first.status === 'need-config') return t('notConfigured')
      if (first && isRecord(first.error)) return errorShort(first.error, t)
      return '—'
    }

    function OverviewRow({ group, t, onSelect }) {
      const plan = groupPlan(group)
      const metrics = compactMetrics(group)
      const labels = { '5h': t('short5h'), week: t('shortWeek'), month: t('shortMonth') }
      const balanceProvider = group.providers.find((provider) => provider.status === 'ok' && Array.isArray(provider.balances) && provider.balances.length > 0)
      return h('button', {
        type: 'button',
        className: 'dshp-q-ovrow',
        onClick: onSelect,
      },
        h(VendorDot, { vendor: group.key, size: 7 }),
        h('span', { className: 'dshp-q-ovname' }, group.label),
        plan && plan.name && plan.name !== 'Kimi Code' ? h('span', { className: 'dshp-q-plan' }, plan.name) : null,
        metrics.length > 0
          ? h('span', { className: 'dshp-q-metrics' },
            metrics.map((metric) => h('span', {
              key: metric.key,
              className: 'dshp-q-metric',
              'data-low': metric.remaining < 10 ? 'true' : 'false',
            }, `${labels[metric.key]} ${metric.remaining <= 0 ? '0%' : Math.round(metric.remaining) + '%'}`)),
          )
          : h('span', { className: 'dshp-q-value', 'data-muted': groupStatus(group) === 'ok' ? 'false' : 'true' },
            balanceProvider ? formatMoney(balanceProvider.balances[0]) : primaryValueOfGroup(group, t)),
        h('span', { className: 'dshp-q-dot', 'data-status': groupStatus(group) }),
      )
    }

    function DetailPanel({ data, loading, rpcError, t, onRefresh, onClose, activeIndex, onActiveChange }) {
      const groups = groupProviders(data?.providers)
      const supported = Array.isArray(data?.supportedVendors) ? data.supportedVendors : []
      const configured = new Set(groups.map((group) => group.key))
      const tabCount = groups.length + 1
      const active = Math.min(Math.max(0, typeof activeIndex === 'number' ? activeIndex : 0), Math.max(0, tabCount - 1))
      const current = active > 0 ? groups[active - 1] : undefined
      return h(React.Fragment, null,
        h('div', { className: 'dshp-q-pop-head' },
          h('span', { className: 'dshp-q-pop-title' }, t('title')),
          h('button', { type: 'button', className: 'dshp-q-btn', onClick: onRefresh, disabled: loading }, loading ? t('refreshing') : t('refresh')),
          h('button', { type: 'button', className: 'dshp-q-btn', onClick: onClose }, t('close')),
        ),
        rpcError ? h('div', { className: 'dshp-q-error' }, `${t('loadFailed')} — ${rpcError}`) : null,
        loading && !data ? h('div', { className: 'dshp-q-empty' }, t('loading')) : null,
        groups.length > 0 ? h('div', { className: 'dshp-q-tabs', role: 'tablist', title: t('scrollHint') },
          h('button', {
            key: 'overview',
            type: 'button',
            role: 'tab',
            'aria-selected': active === 0,
            className: 'dshp-q-tab',
            'data-active': active === 0 ? 'true' : 'false',
            onClick: () => onActiveChange(0),
          },
            h('span', { className: 'dshp-q-ovdot' }, '◎'),
            t('overview'),
          ),
          groups.map((group, index) => h('button', {
            key: group.key,
            type: 'button',
            role: 'tab',
            'aria-selected': index + 1 === active,
            className: 'dshp-q-tab',
            'data-active': index + 1 === active ? 'true' : 'false',
            onClick: () => onActiveChange(index + 1),
          },
            h(VendorDot, { vendor: group.key, size: 6 }),
            group.label,
            h('span', { className: 'dshp-q-dot', 'data-status': groupStatus(group) }),
          )),
        ) : null,
        active === 0 && groups.length > 0
          ? h('div', { className: 'dshp-q-overview' },
            groups.map((group) => h(OverviewRow, {
              key: group.key,
              group,
              t,
              onSelect: () => onActiveChange(groups.indexOf(group) + 1),
            })),
          )
          : null,
        current ? current.providers.map((provider) => h(ProviderCard, { key: provider.id || provider.providerId || provider.label, provider, t })) : null,
        groups.length === 0 && data ? h('div', { className: 'dshp-q-empty' },
          h('div', null, t('empty')),
          h('div', { className: 'dshp-q-meta' }, t('emptyHint')),
        ) : null,
        h('div', { className: 'dshp-q-pop-foot' },
          h('span', null, `${t('supported')}:`),
          supported.map((vendor) => {
            const label = GROUP_LABEL[vendor.id] || vendor.label
            const on = configured.has(vendor.id)
            return h('span', { key: vendor.id, className: 'dshp-q-chip', 'data-off': on ? 'false' : 'true', title: on ? undefined : t('unconfigured') }, label)
          }),
          groups.length > 1 ? h('span', { style: { marginLeft: 'auto' } }, t('scrollHint')) : null,
        ),
      )
    }

    // ------------------------------------------------------------------
    // the footer panel
    // ------------------------------------------------------------------

    function QuotaPanel(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const wide = props.wide !== false
      const rpc = props.rpc
      const [data, setData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [rpcError, setRpcError] = useState(null)
      const [expanded, setExpanded] = useState(false)
      const [anchor, setAnchor] = useState(null)
      const [activeVendor, setActiveVendor] = useState(0)
      const rootRef = useRef(null)
      const popRef = useRef(null)
      const groupsRef = useRef([])
      const aliveRef = useRef(true)
      const loadingRef = useRef(false)
      const pollRef = useRef(DEFAULT_POLL_MS)

      const load = useMemo(() => {
        const run = async (force) => {
          if (!rpc) {
            setRpcError('RPC unavailable')
            return
          }
          if (loadingRef.current) return
          loadingRef.current = true
          setLoading(true)
          try {
            const envelope = await rpc.call(CHANNEL, force ? 'refresh' : 'snapshot', { force: !!force })
            if (!aliveRef.current) return
            if (envelope && envelope.ok === true) {
              const payload = envelope.value
              if (payload && payload.ok === true) {
                setData(payload.snapshot)
                if (payload.snapshot && typeof payload.snapshot.ttlMs === 'number') {
                  pollRef.current = Math.max(15_000, Math.min(3_600_000, payload.snapshot.ttlMs))
                }
                setRpcError(null)
              } else {
                setRpcError(payload?.error?.message || payload?.error?.code || 'query failed')
              }
            } else {
              setRpcError(envelope?.error?.message || 'query failed')
            }
          } catch (error) {
            if (aliveRef.current) setRpcError(error instanceof Error ? error.message : String(error))
          } finally {
            loadingRef.current = false
            if (aliveRef.current) setLoading(false)
          }
        }
        return run
      }, [rpc])

      useEffect(() => {
        aliveRef.current = true
        let timer
        const schedule = () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            if (!aliveRef.current) return
            if (!document.hidden) load(false)
            schedule()
          }, pollRef.current)
        }
        load(false)
        schedule()
        const onVisible = () => { if (!document.hidden) load(false) }
        document.addEventListener('visibilitychange', onVisible)
        window.addEventListener('focus', onVisible)
        return () => {
          aliveRef.current = false
          window.clearTimeout(timer)
          document.removeEventListener('visibilitychange', onVisible)
          window.removeEventListener('focus', onVisible)
        }
      }, [load])

      useEffect(() => {
        if (!expanded) return
        const update = () => {
          const rect = rootRef.current?.getBoundingClientRect()
          if (!rect) return
          const width = 348
          const left = Math.min(Math.max(8, rect.left), Math.max(8, window.innerWidth - width - 8))
          setAnchor({ left, bottom: Math.max(8, window.innerHeight - rect.top + 8) })
        }
        update()
        const onPointerDown = (event) => {
          if (rootRef.current && !rootRef.current.contains(event.target)) setExpanded(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setExpanded(false)
          if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
            event.preventDefault()
            cycleVendor(1)
          }
          if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
            event.preventDefault()
            cycleVendor(-1)
          }
        }
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [expanded])

      const groups = groupProviders(data?.providers)
      groupsRef.current = groups

      const cycleVendor = (direction) => {
        const total = groupsRef.current.length + 1
        if (total <= 1) return
        setActiveVendor((current) => (current + direction + total) % total)
      }

      // Wheel over the popover switches vendor; inside a long card it scrolls
      // normally and only switches when the content is already at an edge.
      useEffect(() => {
        if (!expanded) return
        const element = popRef.current
        if (!element) return
        const onWheel = (event) => {
          const direction = event.deltaY > 0 ? 1 : event.deltaY < 0 ? -1 : 0
          if (direction === 0) return
          const atTop = element.scrollTop <= 0
          const atBottom = element.scrollTop + element.clientHeight >= element.scrollHeight - 1
          if ((direction > 0 && atBottom) || (direction < 0 && atTop)) {
            event.preventDefault()
            cycleVendor(direction)
          }
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [expanded])

      const status = snapshotStatus(data)
      const dotStatus = rpcError ? 'error' : status === 'ok' ? 'ok' : status === 'warn' ? 'warn' : status === 'error' ? 'error' : 'idle'
      const updatedText = data ? `${t('updatedAt')} ${formatTime(data.generatedAt)}` : loading ? t('loading') : t('never')
      const toggle = () => setExpanded((value) => {
        if (!value) setActiveVendor(0)
        return !value
      })

      const popover = expanded && anchor
        ? h('div', { className: 'dshp-q-pop', ref: popRef, style: { left: anchor.left, bottom: anchor.bottom }, role: 'dialog', 'aria-label': t('title') },
          h(DetailPanel, {
            data,
            loading,
            rpcError,
            t,
            onRefresh: () => load(true),
            onClose: () => setExpanded(false),
            activeIndex: activeVendor,
            onActiveChange: setActiveVendor,
          }),
        )
        : null

      if (!wide) {
        return h('div', { className: 'dshp-q-root', 'data-wide': 'false', ref: rootRef },
          h('style', null, CSS),
          h('button', {
            type: 'button',
            className: 'dshp-q-iconbtn',
            onClick: toggle,
            'aria-label': t('openDetails'),
            'aria-expanded': expanded,
            title: `${t('title')} · ${updatedText}`,
          },
            h('svg', { viewBox: '0 0 20 20', width: 15, height: 15, 'aria-hidden': true },
              h('rect', { x: 2.5, y: 5, width: 15, height: 11, rx: 2.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
              h('path', { d: 'M2.5 8.5h15', stroke: 'currentColor', strokeWidth: 1.4 }),
              h('circle', { cx: 13.5, cy: 12, r: 1.2, fill: 'currentColor' }),
            ),
            h('span', { className: 'dshp-q-dot', 'data-status': dotStatus }),
          ),
          popover,
        )
      }

      return h('div', { className: 'dshp-q-root', 'data-wide': 'true', ref: rootRef },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: 'dshp-q-summary',
          onClick: toggle,
          'aria-expanded': expanded,
          'aria-label': t('openDetails'),
          title: expanded ? t('close') : t('openDetails'),
        },
          h('span', { className: 'dshp-q-head' },
            h('span', { className: 'dshp-q-title' }, t('title')),
            h('span', { className: 'dshp-q-dot', 'data-status': dotStatus }),
            h('span', { className: 'dshp-q-time' }, updatedText),
          ),
          h('span', { className: 'dshp-q-body' },
            groups.length === 0
              ? h('span', { className: 'dshp-q-empty' }, data ? t('empty') : loading ? t('loading') : t('never'))
              : groups.slice(0, 4).map((group) => h(CompactRow, { key: group.key, group, t })),
            groups.length > 4 ? h('span', { className: 'dshp-q-more' }, `+${groups.length - 4}`) : null,
            rpcError ? h('span', { className: 'dshp-q-more' }, t('loadFailed')) : null,
          ),
        ),
        popover,
      )
    }

    // ------------------------------------------------------------------
    // dshps settings section
    // ------------------------------------------------------------------

    function SettingsField({ label, children }) {
      return h('label', { className: 'dshp-set-field' },
        h('span', { className: 'dshp-set-label' }, label),
        children,
      )
    }

    /** Keeps a render/effect failure from blanking the whole settings panel. */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }

      static getDerivedStateFromError(error) {
        return { error }
      }

      render() {
        if (this.state.error) {
          const t = this.props.t
          return h('div', { className: 'dshp-set' },
            h('div', { className: 'dshp-set-head' },
              h('h2', null, t('settingsTitle')),
              h('p', null, t('settingsDescription')),
            ),
            h('div', { className: 'dshp-set-card' },
              h('h3', null, t('settingsQuotaTitle')),
              h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } },
                `${t('settingsPageError')} — ${this.state.error?.message || String(this.state.error)}`),
            ),
          )
        }
        return this.props.children
      }
    }

    function DshpsSettingsPage(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const rpc = props.rpc
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [revision, setRevision] = useState(undefined)
      const [detected, setDetected] = useState(null)
      const [form, setForm] = useState({ organization: '', project: '', type: 2, refreshIntervalSeconds: 60 })
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(null)
      // Kimi web token lives only in the Host process memory; the input never
      // leaves this component after Apply and is never persisted.
      const [kimiToken, setKimiToken] = useState('')
      const [kimiTokenSet, setKimiTokenSet] = useState(false)
      const [kimiBusy, setKimiBusy] = useState(false)
      const [kimiMessage, setKimiMessage] = useState(null)

      const applySettingsResult = (result) => {
        if (!result || result.ok !== true) {
          setPhase('error')
          setError(result?.error?.message || t('settingsUnavailable'))
          return false
        }
        const settings = isRecord(result.settings) ? result.settings : {}
        if (settings.available !== true) {
          setPhase('missing')
          return false
        }
        const value = isRecord(settings.value) ? settings.value : {}
        const zhipu = isRecord(value.team) && isRecord(value.team.zhipu) ? value.team.zhipu : {}
        setRevision(typeof settings.revision === 'number' ? settings.revision : undefined)
        setForm({
          organization: typeof zhipu.organization === 'string' ? zhipu.organization : '',
          project: typeof zhipu.project === 'string' ? zhipu.project : '',
          type: typeof zhipu.type === 'number' ? zhipu.type : 2,
          refreshIntervalSeconds: typeof value.refreshIntervalSeconds === 'number' ? value.refreshIntervalSeconds : 60,
        })
        setPhase('ready')
        setError(null)
        return true
      }

      const readSettings = () => {
        if (!rpc) {
          setPhase('error')
          setError(t('settingsUnavailable'))
          return
        }
        setPhase('loading')
        try {
          rpc.call(CHANNEL, 'settings', {}).then((envelope) => {
            if (!envelope || envelope.ok !== true) {
              setPhase('error')
              setError(envelope?.error?.message || t('settingsUnavailable'))
              return
            }
            applySettingsResult(envelope.value)
          }).catch((reason) => {
            setPhase('error')
            setError(reason instanceof Error ? reason.message : String(reason))
          })
        } catch (reason) {
          setPhase('error')
          setError(reason instanceof Error ? reason.message : String(reason))
        }
      }

      const readDetected = () => {
        if (!rpc) return
        try {
          rpc.call(CHANNEL, 'snapshot', {}).then((envelope) => {
            if (envelope && envelope.ok === true && envelope.value && envelope.value.ok === true) {
              setDetected(envelope.value.snapshot)
            }
          }).catch(() => {})
        } catch {
          /* optional overview */
        }
      }

      const readKimiToken = () => {
        if (!rpc) return
        try {
          rpc.call(CHANNEL, 'kimi-token', {}).then((envelope) => {
            if (envelope && envelope.ok === true && envelope.value && envelope.value.ok === true) {
              setKimiTokenSet(envelope.value.kimiTokenSet === true)
            }
          }).catch(() => {})
        } catch {
          /* optional */
        }
      }

      const applyKimiToken = async () => {
        if (!rpc || kimiToken.trim().length === 0) return
        setKimiBusy(true)
        setKimiMessage(null)
        try {
          const envelope = await rpc.call(CHANNEL, 'kimi-token', { token: kimiToken })
          if (envelope && envelope.ok === true && envelope.value && envelope.value.ok === true) {
            setKimiTokenSet(envelope.value.kimiTokenSet === true)
            setKimiToken('')
            setKimiMessage({ kind: 'ok', text: t('kimiTokenApplied') })
            readDetected()
          } else {
            setKimiMessage({ kind: 'error', text: envelope?.value?.error?.message || envelope?.error?.message || t('kimiTokenInvalid') })
          }
        } catch (reason) {
          setKimiMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
        } finally {
          setKimiBusy(false)
        }
      }

      const clearKimiToken = async () => {
        if (!rpc) return
        setKimiBusy(true)
        setKimiMessage(null)
        try {
          const envelope = await rpc.call(CHANNEL, 'kimi-token', { clear: true })
          if (envelope && envelope.ok === true && envelope.value && envelope.value.ok === true) {
            setKimiTokenSet(false)
            setKimiMessage({ kind: 'ok', text: t('kimiTokenCleared') })
            readDetected()
          }
        } catch {
          /* optional */
        } finally {
          setKimiBusy(false)
        }
      }

      useEffect(() => {
        readSettings()
        readDetected()
        readKimiToken()
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [])

      const update = (key) => (event) => {
        const raw = event.target.value
        setForm((current) => ({ ...current, [key]: key === 'type' || key === 'refreshIntervalSeconds' ? Number(raw) : raw }))
      }

      const save = async () => {
        if (!rpc || phase !== 'ready') return
        setSaving(true)
        setMessage(null)
        const refresh = Number.isFinite(form.refreshIntervalSeconds) ? Math.max(15, Math.min(3600, Math.round(form.refreshIntervalSeconds))) : 60
        const type = Number.isFinite(form.type) ? Math.max(1, Math.min(9, Math.round(form.type))) : 2
        const ops = [
          { op: 'set', path: ['team', 'zhipu', 'organization'], value: form.organization.trim() },
          { op: 'set', path: ['team', 'zhipu', 'project'], value: form.project.trim() },
          { op: 'set', path: ['team', 'zhipu', 'type'], value: type },
          { op: 'set', path: ['refreshIntervalSeconds'], value: refresh },
        ]
        try {
          const envelope = await rpc.call(CHANNEL, 'settings-write', { ops, revision })
          if (!envelope || envelope.ok !== true) {
            setMessage({ kind: 'error', text: envelope?.error?.message || t('settingsUnavailable') })
            return
          }
          const result = envelope.value
          if (result && result.ok === true) {
            applySettingsResult(result)
            setMessage({ kind: 'ok', text: t('settingsSaved') })
            readDetected()
            return
          }
          if (result?.error?.code === 'settings-conflict') {
            setMessage({ kind: 'error', text: t('settingsConflict') })
            readSettings()
            return
          }
          setMessage({ kind: 'error', text: result?.error?.message || t('settingsUnavailable') })
        } catch (reason) {
          setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
        } finally {
          setSaving(false)
        }
      }

      const groups = groupProviders(detected?.providers)
      return h('div', { className: 'dshp-set' },
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('settingsTitle')),
          h('p', null, t('settingsDescription')),
        ),
        h('div', { className: 'dshp-set-card' },
          h('h3', null, t('settingsQuotaTitle')),
          h('p', { className: 'dshp-set-sub' }, t('settingsQuotaDescription')),
          phase === 'loading' ? h('div', { className: 'dshp-set-hint' }, t('loading')) : null,
          phase === 'missing' ? h('div', { className: 'dshp-set-hint' }, t('settingsMissing')) : null,
          phase === 'error' ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error || t('settingsUnavailable')) : null,
          phase === 'ready' ? h(React.Fragment, null,
            h('h4', { className: 'dshp-set-sectitle' }, t('settingsGlmTeam')),
            h('div', { className: 'dshp-set-grid' },
              h(SettingsField, { label: t('settingsOrg') },
                h('input', { type: 'text', value: form.organization, onChange: update('organization'), placeholder: 'org-…', spellCheck: false }),
              ),
              h(SettingsField, { label: t('settingsProject') },
                h('input', { type: 'text', value: form.project, onChange: update('project'), placeholder: 'proj_…', spellCheck: false }),
              ),
              h(SettingsField, { label: t('settingsType') },
                h('input', { type: 'number', min: 1, max: 9, value: form.type, onChange: update('type') }),
              ),
              h(SettingsField, { label: t('settingsRefresh') },
                h('input', { type: 'number', min: 15, max: 3600, step: 5, value: form.refreshIntervalSeconds, onChange: update('refreshIntervalSeconds') }),
              ),
            ),
            h('p', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, t('settingsGlmTeamHint')),
            h('p', { className: 'dshp-set-hint' }, t('settingsRefreshHint')),
            h('div', { className: 'dshp-set-actions' },
              h('button', { type: 'button', className: 'dshp-set-primary', onClick: save, disabled: saving }, saving ? t('settingsSaving') : t('settingsSave')),
              h('button', { type: 'button', className: 'dshp-set-secondary', onClick: readSettings, disabled: saving }, t('settingsReload')),
              message ? h('span', { className: 'dshp-set-status', 'data-error': message.kind === 'error' ? 'true' : 'false' }, message.text) : null,
            ),
            h('div', { className: 'dshp-set-divider' }),
            h('h4', { className: 'dshp-set-sectitle' }, t('kimiTokenTitle')),
            h('p', { className: 'dshp-set-sub' }, t('kimiTokenHint')),
            h('div', { className: 'dshp-set-grid' },
              h(SettingsField, { label: `${t('kimiTokenLabel')} · ${kimiTokenSet ? t('kimiTokenActive') : t('kimiTokenInactive')}` },
                h('input', {
                  type: 'password',
                  value: kimiToken,
                  onChange: (event) => setKimiToken(event.target.value),
                  placeholder: 'refresh_token…',
                  spellCheck: false,
                  autoComplete: 'off',
                }),
              ),
            ),
            h('div', { className: 'dshp-set-actions' },
              h('button', { type: 'button', className: 'dshp-set-primary', onClick: applyKimiToken, disabled: kimiBusy || kimiToken.trim().length === 0 }, kimiBusy ? t('settingsSaving') : t('kimiTokenApply')),
              h('button', { type: 'button', className: 'dshp-set-secondary', onClick: clearKimiToken, disabled: kimiBusy }, t('kimiTokenClear')),
              kimiMessage ? h('span', { className: 'dshp-set-status', 'data-error': kimiMessage.kind === 'error' ? 'true' : 'false' }, kimiMessage.text) : null,
            ),
            h('div', { className: 'dshp-set-divider' }),
            h('div', { className: 'dshp-set-hint' }, t('settingsDetected')),
            h('div', { className: 'dshp-set-chips' },
              groups.length === 0
                ? h('span', { className: 'dshp-set-hint' }, t('settingsDetectedEmpty'))
                : groups.map((group) => h('span', { key: group.key, className: 'dshp-set-chip' },
                  h('b', null, group.label),
                  groupPlan(group)?.name && groupPlan(group).name !== group.label && !(group.key === 'kimi' && groupPlan(group).name === 'Kimi Code')
                    ? h('span', null, groupPlan(group).name)
                    : null,
                  groupTeam(group) ? h('span', null, t('teamYes')) : null,
                )),
            ),
            h('p', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('settingsOrderHint')),
          ) : null,
          h('p', { className: 'dshp-set-meta', 'data-hidden': phase === 'ready' ? 'true' : 'false' },
            `${t('settingsStatus')}: ${phase}${typeof revision === 'number' ? ` · rev ${revision}` : ''}${rpc ? '' : ` · ${t('settingsNoRpc')}`}`),
        ),
      )
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    return {
      inject: ['slots', 'locale', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dshps: quota locale')
        const connection = ctx.get('connection')
        const rpc = connection && connection.rpc ? connection.rpc : undefined
        const bound = ctx.locale.bind ? ctx.locale.bind(NS) : (key) => key
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dshp-quota',
          order: 10,
          label: () => bound('title'),
          locale: NS,
        }, (slotProps) => h(QuotaPanel, { ...slotProps, rpc })))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dshps',
          order: 18,
          label: () => bound('settingsTitle'),
          locale: NS,
        }, (slotProps) => h(PageBoundary, { t: slotProps.t }, h(DshpsSettingsPage, { ...slotProps, rpc }))))
      },
    }
  },
})
