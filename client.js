/**
 * dshps — shared Web client bundle.
 *
 * Registers:
 *  - `dshp-quota` panel in `sidebar.footer.action` (the additive row directly
 *    above the sidebar user/settings area);
 *  - the dshps settings section (`settings.section`) where plugin options such as
 *    the GLM team organisation/project live, plus the Workflow tab for
 *    `dshp-workflow` (engine/limits/safety settings, the global workflow library
 *    and run history over `/dshp-workflow`).
 *
 * The panel reads data from the matching Host plugins through the authenticated
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
      tabQuota: '额度',
      tabNet: '网络代理',
      tabModels: '登录',
      netTitle: '网络代理',
      netOpen: '查看代理状态与统计',
      netRunning: '网关运行中',
      netStopped: '网关未运行',
      netPort: '端口',
      netEnvApplied: '已写入 .env',
      netEnvNotApplied: '未写入 .env',
      netEnvEffective: '当前进程已生效',
      netEnvPendingRestart: '已保存，重启 DSH 后生效',
      netWarnPortFallback: '配置端口 {configured} 被占用，网关已自动改用 {actual}；建议把端口改成 {actual} 并重新写入 .env。',
      netWarnAllProxy: '检测到 ALL_PROXY，它可能覆盖 HTTP_PROXY/HTTPS_PROXY，部分流量可能不经过网关。',
      netWarnLowercase: '.env 里只有小写 http_proxy；本插件管理的是大写 HTTP_PROXY，请改成大写或留空。',
      netWarnRestart: '已写入 .env，但当前 DSH 进程仍使用旧代理环境；请完整重启 DSH（不是只重载插件）。',
      netWarnPortMismatch: '.env 里的网关端口是 {file}，当前实际端口是 {router}；请重新写入 .env。',
      netWarnRouterDown: '本地网关未在运行，发往它的代理请求会失败。',
      netWarnNoProxy: 'NO_PROXY 绕过了这些供应商域名：{hosts}',
      netErrBadRequest: '请求参数无效，请检查代理或分流配置。',
      netErrEnvRead: '读取 .env 失败。',
      netErrEnvWrite: '写入 .env 失败。',
      netErrConflict: '配置已被其他页面更新，请重新读取后再保存。',
      netErrRejected: '设置服务拒绝了这次修改。',
      netErrSettings: '设置服务不可用。',
      netErrOperation: '操作失败，请查看插件日志。',
      netErrPortAdopt: '自动采用避让端口失败，请把配置端口改成实际端口后重试。',
      netEnvExternal: '被系统环境变量覆盖',
      netApplyEnv: '写入 .env',
      netRevertEnv: '撤销 .env',
      netRestartHint: '首次接入需完整退出并重启 DSH 一次；之后修改代理或分流规则会即时生效。',
      netListenPort: '监听端口',
      netListenPortHint: '默认 17890；修改后保存会自动重写 .env（如已接管），需完整重启 DSH 生效。',
      netPortChangedEnvWritten: '端口已改为 {port}，.env 已自动重写；请完整重启 DSH 生效。',
      netPortChangedNoEnv: '端口已改为 {port}；.env 尚未接管，重启前请先点「写入 .env」。',
      netPortChangedEnvError: '端口已改为 {port}，但 .env 重写失败：{error}',
      netEgressTest: '测试是否生效',
      netEgressOk: '已生效：请求经过本地网关',
      netEgressFail: '未生效：请求没有经过本地网关',
      netProxies: '代理列表',
      netProxyHint: '每个代理一行；供应商标签表示该供应商的流量走这个代理，没出现在任何代理里的供应商默认直连。默认出口只处理未匹配供应商规则的流量。',
      netProxyAdd: '添加代理',
      netProxyAssigned: '供应商',
      netProxyNoProviders: '还没有供应商使用这个代理',
      netProxyEdit: '编辑',
      netProxyDone: '完成',
      netProxySetDefault: '设为默认出口',
      netProxyDefaultBadge: '默认出口',
      netProxyDisabled: '已停用',
      netProxyDisabledWarn: '该代理已停用；分配给它的供应商请求会失败，请恢复启用或改分配。',
      netProxyDefaultDisabledWarn: '默认出口已停用；未匹配供应商规则的流量会失败。',
      netProxyDeleteConfirm: '删除这个代理？分配给它的供应商会改为直连。',
      netProxyFallbackName: '代理',
      netPortFallback: '端口 {configured} 被占用，已自动改用 {actual}',
      netProxyTesting: '测试中…',
      netProxyTestDone: '测试完成（未返回健康结果）',
      netSaving: '保存中…',
      netSaveFailed: '保存失败，请重试。',
      netPortAdopted: '端口 {configured} 被占用，已把配置端口自动改为 {actual} 并写入 .env；请完整重启 DSH 后生效。',
      netRoutingSummary: '{proxies} 个代理 · {routed} 个供应商已分流 · {direct} 个直连',
      netUnsaved: '有未保存的改动',
      netDirectProviders: '直连供应商',
      netDirectProvidersHint: '未出现在任何代理标签里的供应商默认直连；通过各代理行的「添加供应商」分流。',
      netMoveFrom: '当前：',
      netProviderEditHint: '点供应商标签可补充认证/回调域名，× 取消分流。',
      netProxyRemove: '删除',
      netProxyTest: '测试',
      netProxyIdle: '未测试',
      netProxyEmpty: '还没有代理；点「添加代理」新建一个，再把供应商分配到代理上。',
      netProxyOk: '正常',
      netProxyFail: '失败',
      netProxyName: '名称',
      netProxyUrl: '代理地址',
      netProxyUser: '用户名（可选）',
      netProxyPass: '密码（留空不变）',
      netEnabled: '启用',
      netProviders: '按供应商分流',
      netProvidersHint: '目标域名从已配置供应商自动带出；可补充认证/回调域名（逗号分隔）。未匹配的流量走默认出口。',
      netProviderHosts: '目标域名',
      netProviderProxy: '出口',
      netProviderDomains: '额外域名',
      netDefaultProxy: '默认出口',
      netDirect: '直连',
      netRouteAdd: '添加供应商',
      netRouteEmpty: '默认全部直连；点「添加供应商」选择要走代理的供应商。',
      netRouteSearch: '搜索供应商',
      netRouteNoProxy: '先添加并启用一个代理地址，再选择要走代理的供应商。',
      netRemoveTag: '移除',
      netMonitor: '监控与审计',
      netMonitorHint: '记录经网关的请求、失败与流量；页面打开时实时刷新。',
      netStatsTotal: '请求',
      netStatsActive: '活跃',
      netStatsFailed: '失败',
      netStatsBytes: '流量',
      netStatsSuccess: '成功率',
      netRecent: '最近请求',
      netRecentEmpty: '暂无请求',
      netLogsClear: '清空日志',
      netSave: '保存设置',
      netSaved: '已保存',
      netReload: '重新读取',
      netNoRpc: '网关 RPC 不可用',
      netUnavailable: '网关插件未启用或 RPC 不可用。',
      netConfigError: '配置无效',
      netRestartRequired: '端口改动需完整重启 DSH 生效',
      modelsTitle: '模型登录',
      modelsChatgpt: 'Sign in with ChatGPT',
      modelsChatgptHint: '使用 ChatGPT Plus/Pro 订阅登录 OpenAI（官方 OAuth 流程）。登录后选择 openai 路由的模型即可，无需 API Key。',
      modelsRouteHint: 'OAuth 登录本身就是直接连接 OpenAI 换取 token；「openai 路由」只是 DSH 模型里的一个无密钥 provider 入口，让这个 token 有模型可挂载，它不是网络代理、也不会转发请求。',
      modelsSignedIn: '已登录',
      modelsSignedOut: '未登录',
      modelsExpires: '凭据到期',
      modelsSignIn: '登录 ChatGPT',
      modelsSignOut: '退出登录',
      modelsSignInWaiting: '请在浏览器完成登录…',
      modelsCopyLink: '复制登录链接',
      modelsManualHint: '若浏览器没有完成回调，把最终跳转地址粘贴到这里：',
      modelsManualSubmit: '提交回调地址',
      modelsRouteMissing: '尚未创建 openai 路由',
      modelsRouteEnsure: '创建 openai 路由',
      modelsRouteKeyWarn: '认证方式：API Key（覆盖 OAuth，请清空 Key）',
      modelsAuthOauth: '认证方式：OAuth',
      modelsErrDeviceId: '保存本机设备 ID 失败，请重试。',
      modelsErrLoginTimeout: '登录等待超时，请重新发起登录。',
      modelsErrRouteNamespace: '未找到 llm-pi-ai 设置命名空间，无法创建 openai 路由。',
      modelsErrSettings: '设置服务不可用，请稍后重试。',
      modelsErrOperation: '操作失败，请重试或查看插件日志。',
      modelsFlows: '其他供应商登录',
      modelsFlowsHint: '只显示 DSH 内置、支持 OAuth 订阅登录的流程；API Key 登录在「设置 → 模型」里配置。',
      modelsFlowAdd: '添加登录',
      modelsFlowSearch: '搜索供应商登录',
      modelsFlowEmpty: '没有匹配的 OAuth 登录流程',
      modelsNoFlows: '当前没有可用的登录流程。',
      modelsFlowInFlight: '登录中…',
      modelsFlowCancel: '取消',
      modelsCancel: '取消',
      modelsSubmit: '提交',
      modelsNoticeCode: '验证码',
      modelsPromptSecret: '输入密钥',
      modelsPromptSelect: '请选择',
      modelsPromptText: '请输入',
      modelsCallbackManual: '回调端口被占用，可手动粘贴回调地址',
      modelsError: '登录失败',
      modelsUnavailable: '模型插件未启用或 RPC 不可用。',
      modelsReload: '刷新',
      floatTab: '悬浮窗',
      floatFabLabel: 'dshps 悬浮球',
      floatMenu: '展开悬浮窗菜单',
      floatMonitorTitle: '网络监控',
      floatAuditTitle: '审计日志',
      floatQuotaTitle: '额度总览',
      floatModelsTitle: '登录状态',
      floatLock: '锁定',
      floatLocked: '已锁定',
      floatUnlock: '解锁',
      floatRaise: '置于顶层',
      floatCollapse: '收起',
      floatExpand: '展开',
      floatClose: '关闭',
      floatHideFab: '隐藏悬浮球',
      floatLockedClose: '窗口已锁定：解锁后可移动、缩放或关闭',
      floatDragHandle: '拖动标题栏移动窗口',
      floatResize: '拖动调整大小',
      floatGateway: '网关',
      floatEnv: '代理环境',
      floatRecent: '最近请求',
      floatClear: '清空日志',
      floatReset: '重置悬浮窗',
      floatResetHint: '恢复默认位置、尺寸、开关和卫星球可见性。',
      floatSettingsTitle: '悬浮球与悬浮窗',
      floatSettingsHint: '位置、尺寸、锁定与开关保存在 $DSH_HOME/dshps/floating-ui.json，刷新或重启后恢复。',
      floatEnabled: '启用 dshps 悬浮球',
      floatFabLock: '锁定悬浮球位置（锁定时仍可展开卫星球）',
      floatSatellites: '卫星球显示',
      floatResetAction: '重置所有位置与状态',
      floatLoading: '加载悬浮层…',
      floatUnavailable: '悬浮层状态不可用',
      floatQuotaEmpty: '暂无已配置供应商',
      floatModelsSignedIn: 'ChatGPT 已登录',
      floatModelsSignedOut: 'ChatGPT 未登录',
      floatModelsRoute: 'openai 路由',
      floatModelsConfigured: '已创建',
      floatModelsMissing: '未创建',
      floatOpen: '已打开',
      floatClosed: '已关闭',
      tabWorkflow: '工作流',
      wfTitle: '工作流（dshp-workflow）',
      wfDescription: '工作流引擎、安全策略与运行记录。「运行」只能通过 /workflow run 或模型工具启动；带 ? 的字段可以悬停查看解释。',
      wfLoading: '加载中…',
      wfReload: '重新读取',
      wfUnavailable: '工作流插件未启用或 RPC 不可用。',
      wfNoRpc: 'RPC 不可用',
      wfLoadFailed: '加载失败',
      wfSettingsUnavailable: '工作流设置不可用。',
      wfSaved: '已保存',
      wfSave: '保存设置',
      wfSaving: '保存中…',
      wfConflict: '设置已被其他窗口修改，已重新读取。',
      wfEngineTitle: '引擎',
      wfEngineHint: '工具名、自动触发和子代理默认配置，决定谁能触发、子代理怎么跑。',
      wfEnabled: '启用工作流插件',
      wfToolName: '模型工具名（toolName）',
      wfAutoTrigger: '自动触发（autoTrigger）',
      wfAutoTriggerOff: '关闭（off）',
      wfAutoTriggerSuggest: '提示建议（suggest）',
      wfAutoTriggerAuto: '自动建议（auto）',
      wfSubagentProvider: '子代理运行方式（provider）',
      wfSubagentProviderHint: '默认 spawn，在 DSH 进程内跑；换外部后端前先确认它支持结构化返回。',
      wfSourceTitle: '子代理后端和预设从哪来？',
      wfSourceText: '两者都来自当前 DSH profile，不是工作流插件创建的。子代理后端（provider）是已注册的运行后端，默认 spawn；预设（preset）是新建会话时选的模式。',
      wfEngineDefaultsHint: '一般保持「进程内启动（spawn）+ 跟随发起会话」即可。外部后端需要先在 DSH 安装对应插件；固定预设后脚本不能再改。',
      wfProviderSpawn: '进程内独立子代理（spawn）',
      wfProviderFork: '继承父会话上下文（fork）',
      wfProviderAcp: '外部 ACP 代理（acp）',
      wfProviderCodex: 'Codex 外部代理（codex）',
      wfProviderClaudeCode: 'Claude Code 外部代理（claude-code）',
      wfPresetStandard: '标准编码模式',
      wfPresetPtc: 'PTC 工具模式',
      wfPresetMinimal: '精简模式',
      wfPresetCordis: 'Cordis 插件开发模式',
      wfPresetInherit: '跟随发起会话（默认）',
      wfPresetBroken: '不可用',
      wfProviderCapsOk: '当前 provider 支持工作流需要的结构化返回、固定 preset、模型参数和深度限制。',
      wfProviderCapsPartial: '注意：当前 provider 缺少工作流需要的部分能力（结构化返回 / 固定 preset / 模型参数 / 深度限制），依赖这些能力的工作流会失败。外部 CLI provider 与 workflow 的调用方式也可能不兼容，建议优先用 spawn。',
      wfCapabilityOrchestrate: '编排（orchestrate）',
      wfCapabilityObserve: '只读观察（observe）',
      wfCapabilityExecute: '命令执行（execute）',
      wfLimitsTitle: '限额',
      wfLimitsHint: '这些是硬上限：越界会终止本次运行，不会放宽或自动重试。',
      wfMaxConcurrentAgents: '最大并发子代理',
      wfMaxAgentsPerRun: '每次运行子代理上限',
      wfMaxItemsPerCall: '每批并行/流水线条目',
      wfMaxRunSeconds: '单次运行最长秒数',
      wfMaxWorldRuns: '确定性命令调用上限（world.run）',
      wfMaxReportItems: '报告条目上限',
      wfRunRetentionDays: '运行记录保留天数',
      wfMaxSavedWorkflows: '全局工作流保存上限',
      wfSafetyTitle: '安全策略',
      wfSafetyHint: '执行与临时脚本默认关闭；开启后按白名单放行。每个开关旁边的 ? 写了具体影响。',
      wfAllowObserve: '允许只读观察',
      wfAllowExecute: '允许执行命令',
      wfAllowAdHocExecute: '允许临时脚本执行命令',
      wfAllowAdHocScripts: '允许临时脚本运行',
      wfExecuteAllowlist: '可执行命令的工作流授权',
      wfChildPreset: '子代理预设（preset）',
      wfChildPresetHint: '固定子代理使用的 DSH 模式；不选则跟随发起会话。观察型工作流建议选只读预设。',
      wfHash: '内容哈希',
      wfAllowedCommands: '允许的命令（逗号分隔）',
      wfBlockedCommands: '禁止的命令（逗号分隔）',
      wfSandboxMode: '默认沙箱模式',
      wfSandboxWorkspaceWrite: '工作区可读写（workspace-write）',
      wfSandboxReadOnly: '只读（read-only）',
      wfSandboxDanger: '完全访问（danger-full-access，慎用）',
      wfTipEnabled: '关闭后工具、命令和 RPC 一起停用；已保存的工作流和运行记录不会删除。',
      wfTipToolName: '模型看到的工具名。改名后要重新加载插件行才生效，也不能和已有工具重名。',
      wfTipAutoTrigger: '只影响提示词里的建议，不改变权限。off 不提；suggest 只在用户点名工作流时提；auto 会对可拆分的复杂任务主动建议。',
      wfTipSubagentProvider: '子代理走哪个 provider。默认 spawn，在 DSH 进程内运行；只有装了其他 provider 才需要改。',
      wfTipChildPreset: '给工作流子代理固定一个 preset，设置后优先于脚本里的 preset。观察型工作流建议指向只读 preset：能力门只限制脚本钩子，管不到子代理自己的工具。',
      wfTipMaxConcurrentAgents: '同一时刻最多几个子代理并行。调高会更快，也更耗 token 和 CPU。',
      wfTipMaxAgentsPerRun: '一次运行累计能启动多少个子代理，到顶直接终止。',
      wfTipMaxItemsPerCall: '一次 parallel 或 pipeline 最多处理多少条；超过直接报错，不会截断。',
      wfTipMaxRunSeconds: '整个工作流的墙钟上限。到点会取消，正在跑的子代理和命令一并中止。',
      wfTipMaxWorldRuns: '一次运行最多执行多少条 world.run；0 表示一条也不允许。',
      wfTipMaxReportItems: '一次运行最多发布多少条 report；超过直接失败。',
      wfTipRunRetentionDays: '运行记录保留多少天；过期记录在下次加载或新建运行时清理。',
      wfTipMaxSavedWorkflows: '全局工作流最多保存多少个；项目工作流不计入。',
      wfTipAllowObserve: '允许脚本读取工作区的文件和 git 状态，只读。关闭后 files/git 钩子会直接报错。',
      wfTipAllowExecute: '允许脚本执行命令（world.run）。这是高危开关；具体命令仍受白名单约束，执行环境跟随会话沙箱。',
      wfTipAllowAdHocExecute: '允许临时脚本使用 world.run。默认关闭，并且还需要打开 allowAdHocScripts。',
      wfTipAllowAdHocScripts: '允许模型直接写脚本运行。脚本在 Host 进程内执行，等同受信代码，不是沙箱；已保存的工作流不受这个开关影响。',
      wfTipExecuteAllowlist: '允许执行命令的工作流授权，格式 id@sha256。内容一改，旧授权就失效；哈希显示在工作流库卡片上。',
      wfTipAllowedCommands: 'world.run 放行的命令名，按 basename 匹配，默认空。放行 node、python 或包管理器，等于允许执行任意代码，只加你信任的命令。',
      wfTipBlockedCommands: '即使命令在允许列表里，这里列出的也一律拒绝，优先级更高。',
      wfTipSandboxMode: '读不到会话沙箱策略时的回退模式。正常会跟随会话；read-only 最严格，danger-full-access 不要随便选。',
      wfLibraryTitle: '工作流库（全局）',
      wfLibraryHint: '全局工作流保存在 $DSH_HOME/dshps/workflow/workflows；项目工作流由 /workflow 命令管理，这里只列全局。卡片上的内容哈希用于 execute 授权。',
      wfLibraryEmpty: '还没有保存的全局工作流。用 /workflow save 创建，或让模型保存一个。',
      wfLibraryReload: '刷新工作流',
      wfWorkflowsCount: '个工作流',
      wfScopeGlobal: '全局',
      wfShow: '查看',
      wfHide: '收起',
      wfClose: '关闭',
      wfDelete: '删除',
      wfDeleteConfirm: '确认删除该工作流？',
      wfCancel: '取消',
      wfDeleted: '已删除',
      wfUpdatedAt: '更新于',
      wfBytes: '大小',
      wfId: 'ID',
      wfDocument: '工作流文档',
      wfReadFailed: '读取工作流失败',
      wfRunsTitle: '运行记录',
      wfRunsHint: '最近运行，最新在前。运行只能由 /workflow run 或模型工具启动。',
      wfRunsEmpty: '还没有运行记录。',
      wfRunsReload: '刷新运行',
      wfActiveRuns: '活跃运行',
      wfRunSelect: '选择一条运行查看详情。',
      wfRunDetail: '运行详情',
      wfRunLoading: '读取运行…',
      wfRunFailed: '读取运行失败',
      wfStatusQueued: '排队中',
      wfStatusRunning: '运行中',
      wfStatusCompleted: '已完成',
      wfStatusCancelled: '已取消',
      wfStatusError: '失败',
      wfStatusUnknown: '未知',
      wfAgents: '代理',
      wfAgentsStarted: '已启动代理',
      wfAgentsTitle: '子代理调用',
      wfAgentsEmpty: '没有子代理记录。',
      wfCached: '缓存命中',
      wfCachedShort: '缓存',
      wfDuration: '耗时',
      wfEndedAt: '结束',
      wfStopReason: '停止原因',
      wfPhases: '阶段',
      wfPhasesEmpty: '没有阶段记录。',
      wfLogs: '日志',
      wfLogsEmpty: '没有日志。',
      wfReports: '报告',
      wfReportsEmpty: '没有报告。',
      wfArtifacts: '产物',
      wfArtifactsEmpty: '没有产物。',
      wfArtifactView: '查看',
      wfArtifactLoading: '读取中…',
      wfArtifactFailed: '读取产物失败',
      wfUsage: '用量',
      wfUsageAgents: '代理',
      wfUsageWorldRuns: 'world.run',
      wfUsageDuration: '耗时',
      wfRunError: '运行错误',
      wfCancelRun: '取消运行',
      wfCancelledRun: '已请求取消运行',
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
      tabQuota: 'Balance',
      tabNet: 'Network',
      tabModels: 'Sign-in',
      netTitle: 'Network proxy',
      netOpen: 'Show proxy status and statistics',
      netRunning: 'Gateway running',
      netStopped: 'Gateway not running',
      netPort: 'Port',
      netEnvApplied: 'Written to .env',
      netEnvNotApplied: 'Not written to .env',
      netEnvEffective: 'Effective in this process',
      netEnvPendingRestart: 'Saved — restart DSH to apply',
      netWarnPortFallback: 'Port {configured} is busy; the gateway is using {actual}. Set the port to {actual} and apply the environment again.',
      netWarnAllProxy: 'ALL_PROXY is set and may override HTTP_PROXY/HTTPS_PROXY, so some traffic may bypass the gateway.',
      netWarnLowercase: 'The .env file sets lowercase http_proxy, but this plugin manages uppercase HTTP_PROXY. Use uppercase or remove it.',
      netWarnRestart: 'The router URL is written to .env, but this DSH process still uses the previous proxy environment; restart DSH fully (not just the plugin).',
      netWarnPortMismatch: 'The .env router port is {file}, but the current port is {router}; apply the environment again.',
      netWarnRouterDown: 'The local gateway is not running; requests sent to it will fail.',
      netWarnNoProxy: 'NO_PROXY bypasses these provider hosts: {hosts}',
      netErrBadRequest: 'The request was rejected; check the proxy or routing settings.',
      netErrEnvRead: 'Failed to read .env.',
      netErrEnvWrite: 'Failed to write .env.',
      netErrConflict: 'The configuration changed elsewhere; reload and save again.',
      netErrRejected: 'The settings service rejected this change.',
      netErrSettings: 'The settings service is unavailable.',
      netErrOperation: 'The operation failed; check the plugin log.',
      netErrPortAdopt: 'Could not adopt the fallback port; set the configured port to the actual port and retry.',
      netEnvExternal: 'Overridden by system environment',
      netApplyEnv: 'Write .env',
      netRevertEnv: 'Revert .env',
      netRestartHint: 'The first activation needs one full DSH restart. After that, proxy and routing changes apply immediately.',
      netListenPort: 'Listen port',
      netListenPortHint: 'Defaults to 17890. Saving a change rewrites .env when it is managed; a full DSH restart is required.',
      netPortChangedEnvWritten: 'Port changed to {port}; .env was rewritten automatically. Restart DSH fully to apply.',
      netPortChangedNoEnv: 'Port changed to {port}; .env is not managed yet. Apply .env before restarting.',
      netPortChangedEnvError: 'Port changed to {port}, but rewriting .env failed: {error}',
      netEgressTest: 'Test effectiveness',
      netEgressOk: 'Effective: traffic goes through the local gateway',
      netEgressFail: 'Not effective: traffic bypassed the local gateway',
      netProxies: 'Proxies',
      netProxyHint: 'One row per proxy. A provider tag means that provider goes through this proxy; providers in no proxy tag stay direct. The default egress only handles traffic that matches no provider rule.',
      netProxyAdd: 'Add proxy',
      netProxyAssigned: 'Providers',
      netProxyNoProviders: 'No provider uses this proxy yet',
      netProxyEdit: 'Edit',
      netProxyDone: 'Done',
      netProxySetDefault: 'Set as default egress',
      netProxyDefaultBadge: 'Default egress',
      netProxyDisabled: 'Disabled',
      netProxyDisabledWarn: 'This proxy is disabled; providers assigned to it will fail. Re-enable it or move them to another proxy.',
      netProxyDefaultDisabledWarn: 'The default egress proxy is disabled; unmatched traffic will fail.',
      netProxyDeleteConfirm: 'Delete this proxy? Providers assigned to it become direct.',
      netProxyFallbackName: 'Proxy',
      netPortFallback: 'Port {configured} is busy; using {actual}',
      netProxyTesting: 'Testing…',
      netProxyTestDone: 'Test finished without a health result',
      netSaving: 'Saving…',
      netSaveFailed: 'Save failed; try again.',
      netPortAdopted: 'Port {configured} was busy, so the configured port was changed to {actual} and written to .env; restart DSH fully to apply.',
      netRoutingSummary: 'Proxies: {proxies} · routed providers: {routed} · direct: {direct}',
      netUnsaved: 'Unsaved changes',
      netDirectProviders: 'Direct providers',
      netDirectProvidersHint: 'Providers in no proxy tag are direct by default; use “Add provider” on a proxy row to route them.',
      netMoveFrom: 'from',
      netProviderEditHint: 'Click a provider tag to add auth/callback domains; × removes the routing.',
      netProxyRemove: 'Remove',
      netProxyTest: 'Test',
      netProxyIdle: 'untested',
      netProxyEmpty: 'No proxies yet. Add one, then assign providers to it.',
      netProxyOk: 'OK',
      netProxyFail: 'failed',
      netProxyName: 'Name',
      netProxyUrl: 'Proxy URL',
      netProxyUser: 'Username (optional)',
      netProxyPass: 'Password (blank keeps current)',
      netEnabled: 'Enabled',
      netProviders: 'Per-provider routing',
      netProvidersHint: 'Target hosts come from configured providers; add auth/callback domains as needed (comma separated). Unmatched traffic uses the default egress.',
      netProviderHosts: 'Target hosts',
      netProviderProxy: 'Egress',
      netProviderDomains: 'Extra domains',
      netDefaultProxy: 'Default egress',
      netDirect: 'Direct',
      netRouteAdd: 'Add provider',
      netRouteEmpty: 'Everything is direct by default. Use “Add provider” to route a provider through the proxy.',
      netRouteSearch: 'Search providers',
      netRouteNoProxy: 'Add and enable a proxy address before routing providers through it.',
      netRemoveTag: 'Remove',
      netMonitor: 'Monitoring & audit',
      netMonitorHint: 'Requests, failures and bytes through the gateway; refreshed live while this page is open.',
      netStatsTotal: 'Requests',
      netStatsActive: 'Active',
      netStatsFailed: 'Failed',
      netStatsBytes: 'Traffic',
      netStatsSuccess: 'Success',
      netRecent: 'Recent requests',
      netRecentEmpty: 'No requests yet',
      netLogsClear: 'Clear logs',
      netSave: 'Save settings',
      netSaved: 'Saved',
      netReload: 'Reload',
      netNoRpc: 'Gateway RPC unavailable',
      netUnavailable: 'The gateway plugin is not active or its RPC is unavailable.',
      netConfigError: 'Invalid configuration',
      netRestartRequired: 'Port change needs a full DSH restart',
      modelsTitle: 'Model sign-in',
      modelsChatgpt: 'Sign in with ChatGPT',
      modelsChatgptHint: 'Sign in to OpenAI with a ChatGPT Plus/Pro plan (official OAuth flow). Then pick a model on the openai route — no API key needed.',
      modelsRouteHint: 'The OAuth flow itself talks to OpenAI directly to obtain the token. The openai route is just a keyless provider entry in DSH models that lets that token serve models; it is not a network proxy and does not forward requests.',
      modelsSignedIn: 'Signed in',
      modelsSignedOut: 'Signed out',
      modelsExpires: 'Credential expires',
      modelsSignIn: 'Sign in with ChatGPT',
      modelsSignOut: 'Sign out',
      modelsSignInWaiting: 'Finish signing in in your browser…',
      modelsCopyLink: 'Copy sign-in link',
      modelsManualHint: 'If the browser did not complete the callback, paste the final redirect URL here:',
      modelsManualSubmit: 'Submit callback URL',
      modelsRouteMissing: 'The openai route does not exist yet',
      modelsRouteEnsure: 'Create openai route',
      modelsRouteKeyWarn: 'Auth mode: API key (overrides OAuth — clear the key)',
      modelsAuthOauth: 'Auth mode: OAuth',
      modelsErrDeviceId: 'Failed to save the local device ID; try again.',
      modelsErrLoginTimeout: 'The sign-in timed out; start again.',
      modelsErrRouteNamespace: 'The llm-pi-ai settings namespace is missing, so the openai route cannot be created.',
      modelsErrSettings: 'The settings service is unavailable; try again.',
      modelsErrOperation: 'The operation failed; try again or check the plugin log.',
      modelsFlows: 'Other provider sign-ins',
      modelsFlowsHint: 'Only DSH flows that support OAuth subscription sign-in are listed; API-key sign-in lives under Settings → Models.',
      modelsFlowAdd: 'Add sign-in',
      modelsFlowSearch: 'Search provider sign-ins',
      modelsFlowEmpty: 'No matching OAuth sign-in flow',
      modelsNoFlows: 'No sign-in flow available.',
      modelsFlowInFlight: 'Signing in…',
      modelsFlowCancel: 'Cancel',
      modelsCancel: 'Cancel',
      modelsSubmit: 'Submit',
      modelsNoticeCode: 'Code',
      modelsPromptSecret: 'Enter secret',
      modelsPromptSelect: 'Choose',
      modelsPromptText: 'Enter value',
      modelsCallbackManual: 'Callback port is busy; paste the redirect URL manually',
      modelsError: 'Sign-in failed',
      modelsUnavailable: 'The model plugin is not active or its RPC is unavailable.',
      modelsReload: 'Reload',
      floatTab: 'Floating',
      floatFabLabel: 'dshps floating ball',
      floatMenu: 'Open the floating-window menu',
      floatMonitorTitle: 'Network monitor',
      floatAuditTitle: 'Audit log',
      floatQuotaTitle: 'Quota overview',
      floatModelsTitle: 'Sign-in status',
      floatLock: 'Lock',
      floatLocked: 'Locked',
      floatUnlock: 'Unlock',
      floatRaise: 'Bring to front',
      floatCollapse: 'Collapse',
      floatExpand: 'Expand',
      floatClose: 'Close',
      floatHideFab: 'Hide floating ball',
      floatLockedClose: 'Window is locked: unlock to move, resize or close',
      floatDragHandle: 'Drag the title bar to move',
      floatResize: 'Drag to resize',
      floatGateway: 'Gateway',
      floatEnv: 'Proxy env',
      floatRecent: 'Recent requests',
      floatClear: 'Clear log',
      floatReset: 'Reset floating layer',
      floatResetHint: 'Restores default positions, sizes, switches and satellite visibility.',
      floatSettingsTitle: 'Floating ball & windows',
      floatSettingsHint: 'Positions, sizes, locks and switches persist in $DSH_HOME/dshps/floating-ui.json and survive refreshes.',
      floatEnabled: 'Enable the dshps floating ball',
      floatFabLock: 'Lock the floating ball position (the ring still opens)',
      floatSatellites: 'Satellite windows',
      floatResetAction: 'Reset all positions and state',
      floatLoading: 'Loading the floating layer…',
      floatUnavailable: 'Floating-layer state is unavailable',
      floatQuotaEmpty: 'No provider configured',
      floatModelsSignedIn: 'ChatGPT signed in',
      floatModelsSignedOut: 'ChatGPT signed out',
      floatModelsRoute: 'openai route',
      floatModelsConfigured: 'configured',
      floatModelsMissing: 'missing',
      floatOpen: 'open',
      floatClosed: 'closed',
      tabWorkflow: 'Workflow',
      wfTitle: 'Workflow (dshp-workflow)',
      wfDescription: 'Workflow engine, safety policy and run history. Runs start only through /workflow run or the model tool; hover the ? next to a field for an explanation.',
      wfLoading: 'Loading…',
      wfReload: 'Reload',
      wfUnavailable: 'The workflow plugin is not active or its RPC is unavailable.',
      wfNoRpc: 'RPC unavailable',
      wfLoadFailed: 'Load failed',
      wfSettingsUnavailable: 'Workflow settings are unavailable.',
      wfSaved: 'Saved',
      wfSave: 'Save settings',
      wfSaving: 'Saving…',
      wfConflict: 'Settings changed elsewhere; reloaded.',
      wfEngineTitle: 'Engine',
      wfEngineHint: 'Tool name, auto-trigger and child-agent defaults: who can start a workflow and how children run.',
      wfEnabled: 'Enable the workflow plugin (enabled)',
      wfToolName: 'Model tool name (toolName)',
      wfAutoTrigger: 'Auto trigger (autoTrigger)',
      wfAutoTriggerOff: 'Off (off)',
      wfAutoTriggerSuggest: 'Suggest (suggest)',
      wfAutoTriggerAuto: 'Auto (auto)',
      wfSubagentProvider: 'Child agent mode (provider)',
      wfSubagentProviderHint: 'The default spawn runs children inside the DSH process; check that another backend supports structured results before switching.',
      wfSourceTitle: 'Where do the child-agent backend and preset come from?',
      wfSourceText: 'Both come from the current DSH profile; the workflow plugin does not create them. The child-agent backend (provider) is a registered runtime, spawn by default; the preset is the mode you pick for a new session.',
      wfEngineDefaultsHint: '“in-process spawn + follow the session” is the normal choice. External backends need their DSH plugin installed first; a fixed preset cannot be overridden by the script.',
      wfProviderSpawn: 'In-process child (spawn)',
      wfProviderFork: 'Inherit parent context (fork)',
      wfProviderAcp: 'External ACP agent (acp)',
      wfProviderCodex: 'External Codex agent (codex)',
      wfProviderClaudeCode: 'External Claude Code agent (claude-code)',
      wfPresetStandard: 'Standard coding mode',
      wfPresetPtc: 'PTC tool mode',
      wfPresetMinimal: 'Minimal mode',
      wfPresetCordis: 'Cordis plugin authoring mode',
      wfPresetInherit: 'Follow the starting session (default)',
      wfPresetBroken: 'unavailable',
      wfProviderCapsOk: 'This provider supports the structured results, fixed preset, model options and depth limit that workflows need.',
      wfProviderCapsPartial: 'Heads-up: this provider lacks some capabilities workflows need (structured results / fixed preset / model options / depth limit), so workflows that rely on them may fail. External CLI providers may also not match the workflow call path; prefer spawn.',
      wfCapabilityOrchestrate: 'Orchestrate',
      wfCapabilityObserve: 'Read-only observe',
      wfCapabilityExecute: 'Command execute',
      wfLimitsTitle: 'Limits',
      wfLimitsHint: 'These are hard caps. Going over one stops the run; nothing is widened or retried automatically.',
      wfMaxConcurrentAgents: 'Max concurrent child agents',
      wfMaxAgentsPerRun: 'Max child agents per run',
      wfMaxItemsPerCall: 'Items per parallel/pipeline batch',
      wfMaxRunSeconds: 'Max seconds per run',
      wfMaxWorldRuns: 'Deterministic command calls (world.run)',
      wfMaxReportItems: 'Report entries',
      wfRunRetentionDays: 'Run retention in days',
      wfMaxSavedWorkflows: 'Max saved global workflows',
      wfSafetyTitle: 'Safety',
      wfSafetyHint: 'Execute and ad-hoc scripts are off by default. Enabling them allows allowlisted work only; each ? explains the exact effect.',
      wfAllowObserve: 'Allow read-only observation',
      wfAllowExecute: 'Allow command execution',
      wfAllowAdHocExecute: 'Allow ad-hoc command execution',
      wfAllowAdHocScripts: 'Allow ad-hoc scripts',
      wfExecuteAllowlist: 'Execute grants',
      wfChildPreset: 'Child agent preset (preset)',
      wfChildPresetHint: 'Fixes the DSH mode used by workflow children; leave it empty to follow the starting session. Use a read-only preset for observation-only workflows.',
      wfHash: 'Content hash',
      wfAllowedCommands: 'Allowed commands (comma separated)',
      wfBlockedCommands: 'Blocked commands (comma separated)',
      wfSandboxMode: 'Default sandbox mode',
      wfSandboxWorkspaceWrite: 'Workspace read/write (workspace-write)',
      wfSandboxReadOnly: 'Read-only (read-only)',
      wfSandboxDanger: 'Full access (danger-full-access, caution)',
      wfTipEnabled: 'Turns the tool, command and RPC off together. Saved workflows and run records are kept.',
      wfTipToolName: 'The tool name the model sees. Renaming only takes effect after the plugin row reloads, and it must not collide with an existing tool.',
      wfTipAutoTrigger: 'Only changes prompt guidance, never permissions. off stays silent; suggest mentions workflows only when the user asks for one; auto suggests them for substantive, decomposable tasks.',
      wfTipSubagentProvider: 'Which provider runs child agents. The default spawn runs them inside the DSH process; change it only when another provider is installed.',
      wfTipChildPreset: 'A fixed preset for workflow children; it overrides presets from the script. For observation-only workflows point it at a read-only preset: the capability gates limit script hooks, not the child\'s own tools.',
      wfTipMaxConcurrentAgents: 'How many child agents may run at once. Raising it is faster but spends more tokens and CPU.',
      wfTipMaxAgentsPerRun: 'Total child agents one run may start; the run stops when it hits the cap.',
      wfTipMaxItemsPerCall: 'Maximum items per parallel or pipeline call. Over the cap the call fails instead of truncating.',
      wfTipMaxRunSeconds: 'Wall-clock limit for the whole workflow. At expiry the run is cancelled and live children and commands are stopped.',
      wfTipMaxWorldRuns: 'Maximum world.run commands per run; 0 means none.',
      wfTipMaxReportItems: 'Maximum report entries per run; exceeding it fails the run.',
      wfTipRunRetentionDays: 'Days to keep run records. Expired records are pruned on the next load or new run.',
      wfTipMaxSavedWorkflows: 'Maximum saved global workflows; project workflows are not counted.',
      wfTipAllowObserve: 'Lets scripts read workspace files and git state, read-only. With this off, files and git hooks fail.',
      wfTipAllowExecute: 'Lets scripts run commands (world.run). High risk: commands still need the allowlist, and the sandbox follows the session.',
      wfTipAllowAdHocExecute: 'Lets ad-hoc scripts use world.run. Off by default, and allowAdHocScripts must also be on.',
      wfTipAllowAdHocScripts: 'Lets the model write and run scripts directly. They run inside the Host process as trusted code, not in a sandbox; saved workflows are unaffected.',
      wfTipExecuteAllowlist: 'Execute grants as id@sha256. Editing the workflow invalidates the grant; the hash is shown on library cards.',
      wfTipAllowedCommands: 'Command names allowed for world.run, matched by basename. Empty by default. Allowing node, python or a package manager is equivalent to allowing arbitrary code; add only commands you trust.',
      wfTipBlockedCommands: 'Listed commands are denied even when allowed above; this takes precedence.',
      wfTipSandboxMode: 'Fallback sandbox mode when the session policy cannot be read. Normally the session setting wins; read-only is strictest, danger-full-access is rarely appropriate.',
      wfLibraryTitle: 'Workflow library (global)',
      wfLibraryHint: 'Global workflows live in $DSH_HOME/dshps/workflow/workflows; project workflows are managed by the /workflow command and are not listed here. The content hash on a card is what execute grants bind to.',
      wfLibraryEmpty: 'No global workflow saved yet. Create one with /workflow save or let the model save one.',
      wfLibraryReload: 'Reload workflows',
      wfWorkflowsCount: 'workflows',
      wfScopeGlobal: 'global',
      wfShow: 'Show',
      wfHide: 'Hide',
      wfClose: 'Close',
      wfDelete: 'Delete',
      wfDeleteConfirm: 'Delete this workflow?',
      wfCancel: 'Cancel',
      wfDeleted: 'Deleted',
      wfUpdatedAt: 'Updated',
      wfBytes: 'Size',
      wfId: 'ID',
      wfDocument: 'Workflow document',
      wfReadFailed: 'Could not read the workflow',
      wfRunsTitle: 'Run history',
      wfRunsHint: 'Recent runs, newest first. Runs start only through /workflow run or the model tool.',
      wfRunsEmpty: 'No runs yet.',
      wfRunsReload: 'Reload runs',
      wfActiveRuns: 'Active runs',
      wfRunSelect: 'Select a run to inspect it.',
      wfRunDetail: 'Run detail',
      wfRunLoading: 'Reading run…',
      wfRunFailed: 'Could not read the run',
      wfStatusQueued: 'queued',
      wfStatusRunning: 'running',
      wfStatusCompleted: 'completed',
      wfStatusCancelled: 'cancelled',
      wfStatusError: 'error',
      wfStatusUnknown: 'unknown',
      wfAgents: 'agents',
      wfAgentsStarted: 'Agents started',
      wfAgentsTitle: 'Child agents',
      wfAgentsEmpty: 'No child agents recorded.',
      wfCached: 'Cache hits',
      wfCachedShort: 'cached',
      wfDuration: 'Duration',
      wfEndedAt: 'Ended',
      wfStopReason: 'Stop reason',
      wfPhases: 'Phases',
      wfPhasesEmpty: 'No phases recorded.',
      wfLogs: 'Logs',
      wfLogsEmpty: 'No logs recorded.',
      wfReports: 'Reports',
      wfReportsEmpty: 'No reports recorded.',
      wfArtifacts: 'Artifacts',
      wfArtifactsEmpty: 'No artifacts recorded.',
      wfArtifactView: 'View',
      wfArtifactLoading: 'Reading…',
      wfArtifactFailed: 'Could not read the artifact',
      wfUsage: 'Usage',
      wfUsageAgents: 'agents',
      wfUsageWorldRuns: 'world.run',
      wfUsageDuration: 'duration',
      wfRunError: 'Run error',
      wfCancelRun: 'Cancel run',
      wfCancelledRun: 'Cancellation requested',
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
.dshp-set-primary,.dshp-set-secondary{height:30px;font-size:12.5px;white-space:nowrap;flex:0 0 auto;}
.dshp-set-primary,.dshp-set-secondary{border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);padding:0 14px;font:inherit;font-size:12.5px;cursor:pointer;}
.dshp-set-primary{font-weight:600;}
.dshp-set-primary:hover,.dshp-set-secondary:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-set button:focus{outline:none;}
.dshp-set button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
.dshp-set-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap;row-gap:8px;}
.dshp-set-primary{background:var(--dsw-alias-bg-layer-1) !important;color:var(--dsw-alias-label-primary) !important;border:1px solid var(--dsw-alias-border-l2);font-weight:600;}
.dshp-set-primary:hover{background:var(--dsw-alias-bg-layer-2) !important;}
.dshp-set-primary:disabled{opacity:.55;}
.dshp-set-secondary:disabled{opacity:.45;cursor:not-allowed;}
.dshp-set-warning{margin-top:8px;padding:8px 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-state-warn-primary);font-size:12px;line-height:1.5;white-space:normal;overflow-wrap:anywhere;}
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
/* ---- network proxy + model sign-in ---- */
.dshp-tabbar{display:flex;gap:6px;margin:2px 0 4px;flex-wrap:wrap;}
.dshp-tabbtn{height:28px;padding:0 13px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer;}
.dshp-tabbtn:hover{color:var(--dsw-alias-label-primary);}
.dshp-tabbtn[data-active="true"]{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font-weight:600;border-color:var(--dsw-alias-brand-primary);}
.dshp-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary);white-space:nowrap;}
.dshp-badge[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);border-color:var(--dsw-alias-state-success-primary);}
.dshp-badge[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary);}
.dshp-badge[data-kind="error"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dshp-net-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(116px,1fr));gap:8px;margin-top:8px;}
.dshp-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:var(--dsw-alias-bg-layer-1);min-width:0;}
.dshp-stat span{display:block;color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.4;}
.dshp-stat b{display:block;margin-top:2px;font-size:16px;font-weight:650;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshp-stat b small{font-size:11px;font-weight:500;color:var(--dsw-alias-label-secondary);}
.dshp-proxycard{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);margin-top:8px;}
.dshp-proxycard[data-disabled="true"]{border-color:var(--dsw-alias-state-warn-primary);}
.dshp-proxy-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dshp-proxy-name-tag{display:inline-flex;align-items:center;height:28px;padding:0 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;font-weight:600;cursor:pointer;}
.dshp-proxy-name-tag:hover{border-color:var(--dsw-alias-brand-primary);}
.dshp-proxy-meta{margin-left:auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.dshp-proxy-providers{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);}
.dshp-proxy-providers .dshp-set-label{flex:none;}
.dshp-proxy-providers .dshp-tag{cursor:default;}
.dshp-provider-editor{display:flex;flex-direction:column;gap:8px;padding:8px 10px;border:1px dashed var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-2);}
.dshp-proxy-editor{display:flex;flex-direction:column;gap:8px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);}
.dshp-proxy-warn{font-size:11.5px;color:var(--dsw-alias-state-warn-primary);}
.dshp-proxy-note{font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dshp-proxy-note[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);}
.dshp-proxy-note[data-kind="warn"]{color:var(--dsw-alias-state-warn-primary);}
.dshp-proxy-note[data-kind="error"]{color:var(--dsw-alias-state-error-primary);}
.dshp-proxy-summary{margin:6px 0 0;font-size:11.5px;color:var(--dsw-alias-label-secondary);}
.dshp-direct-summary{margin-top:10px;padding-top:8px;border-top:1px dashed var(--dsw-alias-border-l1);display:flex;flex-direction:column;gap:6px;align-items:flex-start;}
.dshp-inline{display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0;}
.dshp-inline .dshp-set-field{flex:1 1 140px;}
.dshp-inline .dshp-set-field[data-grow="true"]{flex:2 1 220px;}
.dshp-checkbox{display:inline-flex;align-items:center;gap:5px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dshp-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;}
.dshp-log{max-height:190px;overflow:auto;margin-top:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}
.dshp-table{width:100%;border-collapse:collapse;font-size:11.5px;}
.dshp-table th,.dshp-table td{padding:4px 7px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;white-space:nowrap;}
.dshp-table th{color:var(--dsw-alias-label-secondary);font-weight:500;position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);}
.dshp-table td[data-kind="ok"]{color:var(--dsw-alias-state-success-primary);}
.dshp-table td[data-kind="error"]{color:var(--dsw-alias-state-error-primary);}
.dshp-table tr:last-child td{border-bottom:none;}
.dshp-warn{color:var(--dsw-alias-state-warn-primary);}
.dshp-flow{display:flex;flex-direction:column;gap:6px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshp-flow:last-child{border-bottom:none;}
.dshp-flow-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dshp-flow-name{font-weight:600;font-size:12.5px;}
.dshp-answer{display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:4px;}
.dshp-answer input,.dshp-answer select{height:30px;padding:0 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm,6px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;min-width:180px;}
.dshp-notice{padding:6px 9px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-2);font-size:11.5px;line-height:1.5;margin-top:6px;word-break:break-word;}
.dshp-notice a{color:var(--dsw-alias-brand-primary);}
/* ---- floating ball + satellite ring + windows ---- */
.dshp-fab-wrap{position:fixed;z-index:132;width:48px;height:48px;pointer-events:none;}
.dshp-fab{position:absolute;inset:0;width:48px;height:48px;padding:0;border-radius:50%;pointer-events:auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 8px 24px rgba(0,0,0,.28);cursor:grab;touch-action:none;user-select:none;}
.dshp-fab:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-fab:active{cursor:grabbing;}
.dshp-fab[data-locked="true"]{cursor:pointer;}
.dshp-fab[data-open="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshp-sat{position:fixed;z-index:131;width:38px;height:38px;padding:0;border-radius:50%;pointer-events:auto;display:flex;align-items:center;justify-content:center;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);box-shadow:0 6px 18px rgba(0,0,0,.24);cursor:pointer;}
.dshp-sat:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-sat[data-active="true"]{border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary);}
.dshp-sat-dot{position:absolute;top:1px;right:1px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-success-primary);}
.dshp-fw{position:fixed;z-index:126;display:flex;flex-direction:column;pointer-events:auto;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-2);box-shadow:0 10px 28px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:12.5px;overflow:hidden;}
.dshp-fw-head{display:flex;align-items:center;gap:3px;height:34px;min-height:34px;padding:0 5px 0 10px;user-select:none;touch-action:none;background:var(--dsw-alias-bg-layer-1);border-bottom:1px solid var(--dsw-alias-border-l1);}
.dshp-fw[data-locked="false"] .dshp-fw-head{cursor:grab;}
.dshp-fw[data-locked="false"] .dshp-fw-head:active{cursor:grabbing;}
.dshp-fw-title{font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-right:auto;}
.dshp-fw-btn{display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;flex:none;}
.dshp-fw-btn:hover{background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);}
.dshp-fw-btn[data-active="true"]{color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-1);}
.dshp-fw-btn:disabled{opacity:.35;cursor:default;}
.dshp-fw-body{flex:1 1 auto;min-height:0;overflow:auto;padding:10px 12px;}
.dshp-fw[data-collapsed="true"] .dshp-fw-body{display:none;}
.dshp-fw[data-collapsed="true"] .dshp-fw-resize{display:none;}
.dshp-fw-resize{position:absolute;right:0;bottom:0;width:18px;height:18px;cursor:nwse-resize;pointer-events:auto;touch-action:none;z-index:1;}
.dshp-fw-resize::after{content:'';position:absolute;right:3px;bottom:3px;width:8px;height:8px;border-right:2px solid var(--dsw-alias-label-secondary);border-bottom:2px solid var(--dsw-alias-label-secondary);opacity:.55;}
.dshp-fw-grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:6px;}
.dshp-fw-stat{border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:6px 8px;background:var(--dsw-alias-bg-layer-1);min-width:0;}
.dshp-fw-stat span{display:block;font-size:10.5px;color:var(--dsw-alias-label-secondary);}
.dshp-fw-stat b{display:block;font-size:14px;font-variant-numeric:tabular-nums;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.dshp-fw-row{display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid var(--dsw-alias-border-l1);min-width:0;}
.dshp-fw-row:last-child{border-bottom:none;}
.dshp-fw-name{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);}
.dshp-fw-value{margin-left:auto;flex:none;font-variant-numeric:tabular-nums;}
.dshp-fw-mono{font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11px;}
.dshp-fw-tiny{font-size:11px;color:var(--dsw-alias-label-secondary);}
.dshp-fw-warn{color:var(--dsw-alias-state-warn-primary);}
.dshp-fw-error{color:var(--dsw-alias-state-error-primary);}
.dshp-fw-table{width:100%;border-collapse:collapse;font-size:11px;}
.dshp-fw-table th,.dshp-fw-table td{padding:3px 5px;border-bottom:1px solid var(--dsw-alias-border-l1);text-align:left;white-space:nowrap;}
.dshp-fw-table th{color:var(--dsw-alias-label-secondary);font-weight:500;position:sticky;top:0;background:var(--dsw-alias-bg-layer-2);}
.dshp-fw-actions{display:flex;gap:6px;align-items:center;margin-top:8px;flex-wrap:wrap;}
.dshp-fw-act{height:24px;padding:0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;cursor:pointer;}
.dshp-fw-act:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-fw-act:disabled{opacity:.5;cursor:default;}
.dshp-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;}
.dshp-set-switch{display:inline-flex;align-items:center;gap:8px;font-size:12.5px;color:var(--dsw-alias-label-primary);cursor:pointer;padding:4px 0;}
.dshp-set-switch input{width:16px;height:16px;accent-color:var(--dsw-alias-brand-primary);}
.dshp-set-checkgrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:4px 14px;margin-top:6px;}
/* DSH-style collapsible sections, tags and popover pickers */
.dshp-set-card-head{display:flex;align-items:center;gap:8px;width:100%;padding:0;border:none;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;font-weight:600;text-align:left;cursor:pointer;}
.dshp-set-card-head h3{margin:0;font:inherit;}
.dshp-set-card-head:hover{color:var(--dsw-alias-brand-primary);}
.dshp-set-card-sub{margin:2px 0 0;}
.dshp-set-card-chevron{margin-left:auto;flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;transition:transform .12s ease;}
.dshp-set-card-chevron[data-open="true"]{transform:rotate(90deg);}
.dshp-set-card-body{margin-top:10px;}
.dshp-set-flat{border-top:1px dashed var(--dsw-alias-border-l1);margin-top:12px;padding-top:10px;}
.dshp-set-flat:first-child{border-top:none;margin-top:0;padding-top:0;}
.dshp-tagbox{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin:6px 0;}
.dshp-tag{display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 4px 0 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:11.5px;}
.dshp-tag[data-active="true"]{border-color:var(--dsw-alias-brand-primary);}
.dshp-tag-main{padding:0;border:none;background:transparent;color:inherit;font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap;}
.dshp-tag-x{width:18px;height:18px;padding:0;border:none;border-radius:50%;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:13px;line-height:1;display:inline-flex;align-items:center;justify-content:center;}
.dshp-tag-x:hover{background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);}
.dshp-routing-picker{margin-top:8px;padding:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);}
.dshp-routing-picker input{width:100%;height:28px;box-sizing:border-box;margin-bottom:6px;padding:0 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;}
.dshp-routing-list{max-height:180px;overflow:auto;display:flex;flex-direction:column;gap:2px;}
.dshp-routing-item{display:flex;align-items:center;gap:8px;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;}
.dshp-routing-item:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-routing-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;}
.dshp-routing-detail{flex:0 1 auto;min-width:0;max-width:52%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary);font-size:11px;text-align:right;}
.dshp-popmenu-wrap{position:relative;display:inline-flex;min-width:0;}
.dshp-popmenu-btn{display:flex;align-items:center;gap:6px;height:30px;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer;min-width:150px;text-align:left;}
.dshp-popmenu-btn:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-popmenu-btn span:first-child{flex:1 1 auto;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshp-popmenu{position:absolute;z-index:150;top:calc(100% + 4px);left:0;min-width:100%;max-height:240px;overflow:auto;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-bg-layer-1);box-shadow:0 10px 28px rgba(0,0,0,.28);}
.dshp-popmenu-item{display:flex;align-items:center;width:100%;padding:6px 8px;border:none;border-radius:6px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;white-space:nowrap;}
.dshp-popmenu-item:hover{background:var(--dsw-alias-bg-layer-2);}
.dshp-popmenu-item[aria-selected="true"]{color:var(--dsw-alias-brand-primary);}
.dshp-fw-lockflag{font-size:10px;color:var(--dsw-alias-state-warn-primary);white-space:nowrap;}
.dshp-fw[data-locked="false"] .dshp-fw-lockflag{display:none;}
.dshp-fw[data-locked="true"] .dshp-fw-head{background:var(--dsw-alias-bg-layer-1);}
.dshp-fw-body--flush{padding:8px;}
.dshp-fab-lock{position:absolute;right:-3px;bottom:-3px;width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.85);transition:opacity .12s ease,transform .12s ease;cursor:pointer;z-index:2;pointer-events:auto;}
.dshp-fab-close{position:absolute;right:-3px;top:-3px;width:20px;height:20px;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:50%;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);display:flex;align-items:center;justify-content:center;opacity:0;transform:scale(.85);transition:opacity .12s ease,transform .12s ease;cursor:pointer;z-index:2;pointer-events:auto;}
.dshp-fab-wrap:hover .dshp-fab-lock,.dshp-fab-wrap:focus-within .dshp-fab-lock,.dshp-fab-lock[data-locked="true"]{opacity:1;transform:scale(1);}
.dshp-fab-wrap:hover .dshp-fab-close,.dshp-fab-wrap:focus-within .dshp-fab-close{opacity:1;transform:scale(1);}
.dshp-fab-close:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary);}
.dshp-fab-lock[data-locked="true"]{color:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary);}
.dshp-fab:focus,.dshp-sat:focus,.dshp-fw-btn:focus,.dshp-fab-lock:focus,.dshp-fab-close:focus{outline:none;}
.dshp-fab:focus-visible,.dshp-sat:focus-visible,.dshp-fw-btn:focus-visible,.dshp-fab-lock:focus-visible,.dshp-fab-close:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;}
/* ---- dshp-workflow settings tab ---- */
.dshp-wf-list{display:flex;flex-direction:column;gap:8px;margin-top:10px;}
.dshp-wf-item{display:flex;flex-direction:column;gap:5px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;}
.dshp-wf-item[data-active="true"]{border-color:var(--dsw-alias-brand-primary);}
.dshp-wf-item-head{display:flex;align-items:center;gap:7px;flex-wrap:wrap;min-width:0;}
.dshp-wf-name{font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshp-wf-sub{color:var(--dsw-alias-label-secondary);font-size:11.5px;line-height:1.5;word-break:break-word;}
.dshp-wf-row{display:flex;align-items:center;gap:8px;min-width:0;}
.dshp-wf-actions{display:flex;align-items:center;gap:6px;flex-wrap:wrap;}
.dshp-wf-badges{display:flex;gap:6px;flex-wrap:wrap;margin:2px 0 6px;}
.dshp-wf-settings{display:flex;flex-direction:column;gap:14px;margin-top:12px;}
.dshp-wf-page{display:flex;flex-direction:column;gap:16px;}
.dshp-wf-settings .dshp-set-card{padding:16px 18px;border-radius:12px;}
.dshp-wf-settings .dshp-set-card-head h3{font-size:13.5px;}
.dshp-wf-settings .dshp-set-label{display:flex;align-items:flex-start;gap:2px;min-height:32px;font-weight:500;line-height:1.4;color:var(--dsw-alias-label-primary);opacity:.86;}
.dshp-wf-settings .dshp-set-field{justify-content:flex-end;gap:6px;}
.dshp-wf-settings input[type=text],.dshp-wf-settings input[type=number]{height:32px;width:100%;box-sizing:border-box;padding:0 10px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12.5px;}
.dshp-wf-settings input[type=text]:focus,.dshp-wf-settings input[type=number]:focus{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:-1px;}
.dshp-wf-settings .dshp-set-grid{grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:14px 16px;}
.dshp-wf-settings .dshp-set-checkgrid{grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:8px;}
.dshp-wf-settings .dshp-set-switch{padding:8px 10px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);}
.dshp-wf-settings .dshp-set-switch:hover{border-color:var(--dsw-alias-border-l2);}
.dshp-wf-settings .dshp-set-actions{margin-top:0;}
.dshp-wf-warn{font-size:11.5px;line-height:1.55;margin:6px 0 0;}
.dshp-wf-source{display:flex;flex-direction:column;gap:5px;padding:12px 14px;border:1px solid var(--dsw-alias-border-l1);border-left:3px solid var(--dsw-alias-brand-primary);border-radius:10px;background:var(--dsw-alias-bg-layer-1);}
.dshp-wf-source-title{font-size:12.5px;font-weight:600;color:var(--dsw-alias-label-primary);}
.dshp-wf-source-text{margin:0;font-size:12px;line-height:1.65;color:var(--dsw-alias-label-secondary);}
.dshp-wf-tip{display:inline-flex;align-items:center;justify-content:center;width:14px;height:14px;margin-left:5px;box-sizing:border-box;border:1px solid var(--dsw-alias-label-secondary);border-radius:50%;color:var(--dsw-alias-label-secondary);font-size:10px;line-height:1;cursor:help;vertical-align:middle;flex:none;}
.dshp-wf-doc{margin:8px 0 0;padding:8px 10px;max-height:260px;overflow:auto;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:ui-monospace,SFMono-Regular,Consolas,monospace;font-size:11.5px;line-height:1.5;white-space:pre-wrap;word-break:break-word;}
.dshp-wf-runs{display:flex;flex-direction:column;gap:4px;margin-top:10px;}
.dshp-wf-run{display:flex;align-items:center;gap:8px;width:100%;padding:6px 9px;box-sizing:border-box;border:1px solid transparent;border-radius:7px;background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;text-align:left;cursor:pointer;min-width:0;}
.dshp-wf-run:hover{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-border-l1);}
.dshp-wf-run[data-active="true"]{background:var(--dsw-alias-bg-layer-1);border-color:var(--dsw-alias-brand-primary);}
.dshp-wf-run-name{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.dshp-wf-run-meta{flex:none;color:var(--dsw-alias-label-secondary);font-size:11px;white-space:nowrap;font-variant-numeric:tabular-nums;}
.dshp-wf-detail{margin-top:10px;padding:10px 12px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:var(--dsw-alias-bg-layer-1);min-width:0;}
.dshp-wf-kv{display:flex;gap:8px;justify-content:space-between;padding:2px 0;font-size:12px;color:var(--dsw-alias-label-secondary);}
.dshp-wf-kv b{color:var(--dsw-alias-label-primary);font-weight:600;text-align:right;word-break:break-word;}
.dshp-wf-list-line{font-size:11.5px;line-height:1.6;color:var(--dsw-alias-label-secondary);word-break:break-word;padding:1px 0;}
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
    // network proxy + model sign-in
    // ------------------------------------------------------------------

    function formatBytes(value) {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return '—'
      if (value < 1024) return `${Math.round(value)} B`
      const units = ['KB', 'MB', 'GB', 'TB']
      let size = value / 1024
      let index = 0
      while (size >= 1024 && index < units.length - 1) {
        size /= 1024
        index += 1
      }
      return `${size >= 100 ? Math.round(size) : size.toFixed(1)} ${units[index]}`
    }

    function netDotStatus(snapshot, error) {
      if (error) return 'error'
      if (!snapshot) return 'idle'
      if (snapshot.router && snapshot.router.running === false) return 'error'
      if (snapshot.env && snapshot.env.effective === true) return 'ok'
      return 'warn'
    }

    /**
     * Unwrap the Connection RPC reply to the plugin payload. `rpc.call` returns
     * the Connection result envelope; a Host half may in turn wrap its own
     * `{ ok, value }` envelope around the payload (dshp-net / dshp-models do),
     * while dshp-quota returns the payload directly. Unwrap at most a few
     * layers so every host transport shape reaches the same payload object.
     */
    function rpcPayload(envelope) {
      if (!envelope || envelope.ok !== true) return undefined
      let value = envelope.value
      for (let depth = 0; depth < 3; depth += 1) {
        if (!isRecord(value) || !isRecord(value.value)) break
        value = value.value
      }
      return value
    }

    function netEnvLabel(env, t) {
      if (!isRecord(env)) return t('netEnvNotApplied')
      if (env.effective === true) return t('netEnvEffective')
      if (env.pendingRestart === true) return t('netEnvPendingRestart')
      if (env.applied === true) return t('netEnvPendingRestart')
      return t('netEnvNotApplied')
    }

    /** Localized env warnings; Host returns stable codes plus English fallback. */
    function netEnvWarningTexts(env, t) {
      const items = isRecord(env) && Array.isArray(env.warningCodes) ? env.warningCodes : []
      const texts = []
      for (const item of items) {
        if (!isRecord(item) || typeof item.code !== 'string') continue
        const params = isRecord(item.params) ? item.params : {}
        if (item.code === 'port-fallback') {
          texts.push(t('netWarnPortFallback')
            .replace('{configured}', String(params.configured ?? '—'))
            .replace('{actual}', String(params.actual ?? '—')))
        } else if (item.code === 'all-proxy-override') {
          texts.push(t('netWarnAllProxy'))
        } else if (item.code === 'lowercase-http-proxy') {
          texts.push(t('netWarnLowercase'))
        } else if (item.code === 'restart-required') {
          texts.push(t('netWarnRestart'))
        } else if (item.code === 'port-mismatch') {
          texts.push(t('netWarnPortMismatch')
            .replace('{file}', String(params.file ?? '—'))
            .replace('{router}', String(params.router ?? '—')))
        } else if (item.code === 'router-not-running') {
          texts.push(t('netWarnRouterDown'))
        } else if (item.code === 'no-proxy-bypass') {
          const hosts = Array.isArray(params.hosts) ? params.hosts.join(', ') : ''
          texts.push(t('netWarnNoProxy').replace('{hosts}', hosts))
        }
      }
      if (texts.length === 0 && isRecord(env) && typeof env.warning === 'string' && env.warning.length > 0) {
        texts.push(env.warning)
      }
      return texts
    }

    /** Localized net RPC error; unknown codes keep the Host detail. */
    function netErrorText(error, t, fallbackKey = 'loadFailed') {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
      const key = {
        'bad-request': 'netErrBadRequest',
        'env-read-failed': 'netErrEnvRead',
        'env-write-failed': 'netErrEnvWrite',
        'settings-conflict': 'netErrConflict',
        'settings-rejected': 'netErrRejected',
        'settings-unavailable': 'netErrSettings',
        'operation-error': 'netErrOperation',
        'port-adopt-failed': 'netErrPortAdopt',
      }[code]
      if (key) return t(key)
      if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) return error.message
      return t(fallbackKey)
    }

    /** Localized models host error; unknown codes keep the Host detail. */
    function modelsErrorText(error, t, fallbackKey = 'modelsError') {
      const code = isRecord(error) && typeof error.code === 'string' ? error.code : ''
      const key = {
        'device-id-persist-failed': 'modelsErrDeviceId',
        'login-timeout': 'modelsErrLoginTimeout',
        'route-namespace-missing': 'modelsErrRouteNamespace',
        'settings-unavailable': 'modelsErrSettings',
        'operation-error': 'modelsErrOperation',
      }[code]
      if (key) return t(key)
      if (isRecord(error) && typeof error.message === 'string' && error.message.length > 0) return error.message
      return t(fallbackKey)
    }

    function netRecentRows(snapshot) {
      const recent = snapshot && Array.isArray(snapshot.recent) ? snapshot.recent : []
      return recent.slice(0, 18)
    }

    function netDraftFromSnapshot(snapshot) {
      const config = snapshot && isRecord(snapshot.config) ? snapshot.config : {}
      const proxies = Array.isArray(config.proxies) ? config.proxies : []
      const providerDict = isRecord(config.providers) ? config.providers : {}
      const providerRows = Array.isArray(config.providers)
        ? config.providers
        : (Array.isArray(snapshot?.providers) ? snapshot.providers : [])
      const copy = {}
      for (const key of Object.keys(providerDict)) {
        const entry = isRecord(providerDict[key]) ? providerDict[key] : {}
        copy[key] = {
          proxy: typeof entry.proxy === 'string' && entry.proxy.length > 0 ? entry.proxy : 'direct',
          domains: Array.isArray(entry.domains) ? entry.domains.slice() : [],
        }
      }
      for (const row of providerRows) {
        if (!isRecord(row) || typeof row.id !== 'string' || row.id.length === 0) continue
        copy[row.id] = {
          proxy: typeof row.proxy === 'string' && row.proxy.length > 0 ? row.proxy : 'direct',
          domains: Array.isArray(row.domains) ? row.domains.slice() : [],
        }
      }
      return {
        defaultProxy: typeof config.defaultProxy === 'string' ? config.defaultProxy : 'direct',
        port: Number.isInteger(config.port) ? config.port : 17890,
        proxies: proxies.map((proxy) => ({
          id: String(proxy.id ?? ''),
          label: typeof proxy.label === 'string' ? proxy.label : '',
          url: typeof proxy.url === 'string' ? proxy.url : '',
          username: typeof proxy.username === 'string' ? proxy.username : '',
          password: '',
          enabled: proxy.enabled !== false,
        })),
        providers: copy,
      }
    }

    function netRevisionOf(snapshot) {
      if (!isRecord(snapshot)) return undefined
      if (typeof snapshot.revision === 'number') return snapshot.revision
      if (isRecord(snapshot.config) && typeof snapshot.config.revision === 'number') return snapshot.config.revision
      return undefined
    }

    /** Search picker that assigns a provider to one proxy row, moving it from
     * any other proxy (a provider can belong to at most one upstream proxy). */
    function ProviderAssignPicker({ t, providerItems, proxyId, config, setProvider }) {
      const [open, setOpen] = useState(false)
      const [query, setQuery] = useState('')
      const currentProxyOf = (providerId) => {
        const entry = config.providers[providerId]
        return isRecord(entry) && typeof entry.proxy === 'string' ? entry.proxy : 'direct'
      }
      const filtered = providerItems.filter((item) => {
        if (currentProxyOf(item.id) === proxyId) return false
        const text = `${item.label} ${item.detail}`.toLowerCase()
        return query.trim().length === 0 || text.includes(query.trim().toLowerCase())
      })
      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          className: 'dshp-set-secondary',
          onClick: () => setOpen((value) => !value),
        }, t('netRouteAdd')),
        open ? h('div', { className: 'dshp-routing-picker' },
          h('input', {
            type: 'text',
            value: query,
            placeholder: t('netRouteSearch'),
            spellCheck: false,
            onChange: (event) => setQuery(event.target.value),
          }),
          h('div', { className: 'dshp-routing-list' },
            filtered.length === 0
              ? h('span', { className: 'dshp-set-hint' }, t('netRecentEmpty'))
              : filtered.map((item) => {
                const current = currentProxyOf(item.id)
                const currentProxy = config.proxies.find((proxy) => proxy.id === current)
                return h('button', {
                  key: item.id,
                  type: 'button',
                  className: 'dshp-routing-item',
                  onClick: () => {
                    setProvider(item.id, { proxy: proxyId })
                    setOpen(false)
                    setQuery('')
                  },
                },
                  h('span', { className: 'dshp-routing-name' }, item.label),
                  h('span', { className: 'dshp-routing-detail' },
                    currentProxy ? `${t('netMoveFrom')} ${currentProxy.label || currentProxy.id}` : t('netDirect')),
                )
              }),
          ),
        ) : null,
      )
    }

    /** Proxy-first routing editor: one row per proxy, provider tags inside. */
    function ProxyRoutingCard(props) {
      const {
        t, config, providerItems, runtimeProxies, busy, testing,
        onMutate, onAddProxy, onUpdateProxy, onRemoveProxy, onSetProvider, onTestProxy, onSave, dirty,
      } = props
      const [editingProxy, setEditingProxy] = useState('')
      const [expandedProvider, setExpandedProvider] = useState('')
      const [directOpen, setDirectOpen] = useState(false)
      const [directQuery, setDirectQuery] = useState('')
      const [testNotice, setTestNotice] = useState(null)
      const [saveNotice, setSaveNotice] = useState(null)
      const runtimeById = new Map((Array.isArray(runtimeProxies) ? runtimeProxies : []).map((entry) => [entry.id, entry]))
      const proxyOptions = [{ value: 'direct', label: t('netDirect') }].concat(
        config.proxies.map((proxy) => ({ value: proxy.id, label: proxy.label || proxy.id })),
      )
      const proxyExists = (id) => config.proxies.some((proxy) => proxy.id === id)
      const assignmentOf = (providerId) => {
        const entry = config.providers[providerId]
        return isRecord(entry) && typeof entry.proxy === 'string' ? entry.proxy : 'direct'
      }
      const assignedFor = (proxyId) => providerItems.filter((item) => assignmentOf(item.id) === proxyId)
      const routedCount = providerItems.filter((item) => proxyExists(assignmentOf(item.id))).length
      const directItems = providerItems.filter((item) => !proxyExists(assignmentOf(item.id)))
      const directFiltered = directItems.filter((item) => {
        const text = `${item.label} ${item.detail}`.toLowerCase()
        return directQuery.trim().length === 0 || text.includes(directQuery.trim().toLowerCase())
      })
      const proxyName = (proxy, index) => proxy.label || `${t('netProxyFallbackName')} ${index + 1}`
      const handleAddProxy = () => {
        const id = onAddProxy()
        if (id) setEditingProxy(id)
      }
      const handleRemove = (proxy, assignedCount) => {
        if (assignedCount > 0 && typeof window !== 'undefined' && typeof window.confirm === 'function'
          && window.confirm(t('netProxyDeleteConfirm')) !== true) return
        onRemoveProxy(proxy.id)
        if (editingProxy === proxy.id) setEditingProxy('')
        if (expandedProvider && assignmentOf(expandedProvider) === proxy.id) setExpandedProvider('')
      }
      const runProxyTest = async (proxy) => {
        setTestNotice({ id: proxy.id, kind: 'warn', text: t('netProxyTesting') })
        try {
          const health = await onTestProxy(proxy.id)
          if (isRecord(health)) {
            setTestNotice({
              id: proxy.id,
              kind: health.ok === true ? 'ok' : 'error',
              text: health.ok === true
                ? `${t('netProxyOk')} · ${health.ms ?? '—'} ms`
                : `${t('netProxyFail')}${health.error ? ` · ${health.error}` : ''}`,
            })
          } else {
            setTestNotice({ id: proxy.id, kind: 'error', text: t('netProxyFail') })
          }
        } catch (reason) {
          setTestNotice({ id: proxy.id, kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
        }
      }
      const handleSave = async () => {
        setSaveNotice({ kind: 'warn', text: t('netSaving') })
        try {
          const result = await onSave()
          if (result && result.ok === true) {
            if (result.portChanged === true) {
              const port = result.snapshot?.config?.port ?? config.port
              if (typeof result.envRewriteError === 'string' && result.envRewriteError.length > 0) {
                setSaveNotice({
                  kind: 'error',
                  text: t('netPortChangedEnvError')
                    .replace('{port}', String(port))
                    .replace('{error}', result.envRewriteError),
                })
              } else if (result.envRewritten === true) {
                setSaveNotice({ kind: 'warn', text: t('netPortChangedEnvWritten').replace('{port}', String(port)) })
              } else {
                setSaveNotice({ kind: 'warn', text: t('netPortChangedNoEnv').replace('{port}', String(port)) })
              }
            } else {
              setSaveNotice({ kind: 'ok', text: t('netSaved') })
            }
          } else {
            setSaveNotice({ kind: 'error', text: t('netSaveFailed') })
          }
        } catch (reason) {
          setSaveNotice({ kind: 'error', text: reason instanceof Error ? reason.message : t('netSaveFailed') })
        }
      }
      return h(React.Fragment, null,
        h('div', { className: 'dshp-inline' },
          h('span', { className: 'dshp-set-label' }, t('netListenPort')),
          h('input', {
            type: 'number',
            min: 1024,
            max: 65535,
            step: 1,
            value: config.port ?? 17890,
            style: { width: '110px' },
            onChange: (event) => {
              const next = Number(event.target.value)
              if (Number.isInteger(next) && next >= 1024 && next <= 65535) onMutate({ ...config, port: next })
            },
          }),
          h('span', { className: 'dshp-set-hint', style: { margin: 0 } }, t('netListenPortHint')),
        ),
        h('div', { className: 'dshp-inline' },
          h('span', { className: 'dshp-set-label' }, t('netDefaultProxy')),
          h(PickMenu, {
            value: config.defaultProxy,
            options: proxyOptions,
            onSelect: (value) => onMutate({ ...config, defaultProxy: value }),
            t,
          }),
          h('button', { type: 'button', className: 'dshp-set-secondary', onClick: handleAddProxy, disabled: busy }, t('netProxyAdd')),
        ),
        h('p', { className: 'dshp-proxy-summary' }, t('netRoutingSummary')
          .replace('{proxies}', String(config.proxies.length))
          .replace('{routed}', String(routedCount))
          .replace('{direct}', String(directItems.length))),
        config.proxies.length === 0 ? h('p', { className: 'dshp-set-hint' }, t('netProxyEmpty')) : null,
        config.proxies.map((proxy, index) => {
          const runtime = runtimeById.get(proxy.id)
          const health = runtime && isRecord(runtime.health) ? runtime.health : undefined
          const assigned = assignedFor(proxy.id)
          const isDefault = config.defaultProxy === proxy.id
          const editing = editingProxy === proxy.id
          const disabled = proxy.enabled === false
          return h('div', {
            key: proxy.id,
            className: 'dshp-proxycard',
            'data-disabled': disabled ? 'true' : 'false',
          },
            h('div', { className: 'dshp-proxy-head' },
              h('button', {
                type: 'button',
                className: 'dshp-proxy-name-tag',
                onClick: () => setEditingProxy(editing ? '' : proxy.id),
              }, proxyName(proxy, index)),
              isDefault ? h('span', { className: 'dshp-badge', 'data-kind': 'ok' }, t('netProxyDefaultBadge')) : null,
              h('span', {
                className: 'dshp-badge',
                'data-kind': disabled ? 'warn' : health ? (health.ok === true ? 'ok' : 'error') : 'warn',
              },
                disabled
                  ? t('netProxyDisabled')
                  : health
                    ? (health.ok === true
                      ? `${t('netProxyOk')} · ${health.ms ?? '—'} ms`
                      : `${t('netProxyFail')}${health.error ? ` · ${health.error}` : ''}`)
                    : t('netProxyIdle')),
              h('div', { className: 'dshp-proxy-meta' },
                h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  disabled: busy || testing === proxy.id,
                  onClick: () => { void runProxyTest(proxy) },
                }, testing === proxy.id ? t('loading') : t('netProxyTest')),
                h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  disabled: busy,
                  onClick: () => handleRemove(proxy, assigned.length),
                }, t('netProxyRemove')),
              ),
            ),
            disabled && assigned.length > 0 ? h('div', { className: 'dshp-proxy-warn' }, t('netProxyDisabledWarn')) : null,
            disabled && isDefault ? h('div', { className: 'dshp-proxy-warn' }, t('netProxyDefaultDisabledWarn')) : null,
            testNotice && testNotice.id === proxy.id
              ? h('div', { className: 'dshp-proxy-note', 'data-kind': testNotice.kind }, testNotice.text)
              : null,
            h('div', { className: 'dshp-proxy-providers' },
              h('span', { className: 'dshp-set-label' }, t('netProxyAssigned')),
              assigned.length === 0
                ? h('span', { className: 'dshp-set-hint' }, t('netProxyNoProviders'))
                : assigned.map((item) => h('span', {
                  key: item.id,
                  className: 'dshp-tag',
                  'data-active': expandedProvider === item.id ? 'true' : 'false',
                },
                  h('button', {
                    type: 'button',
                    className: 'dshp-tag-main',
                    title: t('netProviderEditHint'),
                    onClick: () => setExpandedProvider(expandedProvider === item.id ? '' : item.id),
                  }, item.label),
                  h('button', {
                    type: 'button',
                    className: 'dshp-tag-x',
                    'aria-label': t('netRemoveTag'),
                    onClick: () => {
                      onSetProvider(item.id, { proxy: 'direct', domains: [] })
                      if (expandedProvider === item.id) setExpandedProvider('')
                    },
                  }, '×'),
                )),
              h(ProviderAssignPicker, { t, providerItems, proxyId: proxy.id, config, setProvider: onSetProvider }),
            ),
            expandedProvider && assignmentOf(expandedProvider) === proxy.id ? (() => {
              const item = providerItems.find((candidate) => candidate.id === expandedProvider)
              const entry = config.providers[expandedProvider] || { proxy: proxy.id, domains: [] }
              return h('div', { className: 'dshp-provider-editor' },
                h('div', { className: 'dshp-inline' },
                  h('b', null, item ? item.label : expandedProvider),
                  h('span', { className: 'dshp-q-meta', style: { margin: 0 } }, item ? item.detail : ''),
                ),
                h('label', { className: 'dshp-set-field' },
                  h('span', { className: 'dshp-set-label' }, t('netProviderDomains')),
                  h('input', {
                    type: 'text',
                    value: Array.isArray(entry.domains) ? entry.domains.join(', ') : '',
                    placeholder: 'auth.openai.com, chatgpt.com',
                    spellCheck: false,
                    onChange: (event) => onSetProvider(expandedProvider, {
                      domains: event.target.value.split(',').map((part) => part.trim()).filter((part) => part.length > 0),
                    }),
                  }),
                ),
                h('div', { className: 'dshp-set-actions' },
                  h('button', { type: 'button', className: 'dshp-set-secondary', onClick: () => setExpandedProvider('') }, t('netProxyDone')),
                  h('button', {
                    type: 'button',
                    className: 'dshp-set-secondary',
                    onClick: () => {
                      onSetProvider(expandedProvider, { proxy: 'direct', domains: [] })
                      setExpandedProvider('')
                    },
                  }, t('netDirect')),
                ),
              )
            })() : null,
            editing ? h('div', { className: 'dshp-proxy-editor' },
              h('div', { className: 'dshp-inline' },
                h('label', { className: 'dshp-set-field' },
                  h('span', { className: 'dshp-set-label' }, t('netProxyName')),
                  h('input', { type: 'text', value: proxy.label, onChange: (event) => onUpdateProxy(proxy.id, { label: event.target.value }) }),
                ),
                h('label', { className: 'dshp-set-field', 'data-grow': 'true' },
                  h('span', { className: 'dshp-set-label' }, t('netProxyUrl')),
                  h('input', {
                    type: 'text',
                    value: proxy.url,
                    spellCheck: false,
                    placeholder: 'http://127.0.0.1:7890',
                    onChange: (event) => onUpdateProxy(proxy.id, { url: event.target.value }),
                  }),
                ),
              ),
              h('div', { className: 'dshp-inline' },
                h('label', { className: 'dshp-set-field' },
                  h('span', { className: 'dshp-set-label' }, t('netProxyUser')),
                  h('input', { type: 'text', value: proxy.username, spellCheck: false, onChange: (event) => onUpdateProxy(proxy.id, { username: event.target.value }) }),
                ),
                h('label', { className: 'dshp-set-field' },
                  h('span', { className: 'dshp-set-label' }, t('netProxyPass') + (runtime?.hasPassword ? ' · ●' : '')),
                  h('input', {
                    type: 'password',
                    value: proxy.password,
                    autoComplete: 'off',
                    onChange: (event) => onUpdateProxy(proxy.id, { password: event.target.value }),
                  }),
                ),
              ),
              h('div', { className: 'dshp-set-actions' },
                h('label', { className: 'dshp-checkbox' },
                  h('input', {
                    type: 'checkbox',
                    checked: proxy.enabled !== false,
                    onChange: (event) => onUpdateProxy(proxy.id, { enabled: event.target.checked }),
                  }),
                  t('netEnabled'),
                ),
                h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  disabled: busy || testing === proxy.id,
                  onClick: () => { void runProxyTest(proxy) },
                }, testing === proxy.id ? t('loading') : t('netProxyTest')),
                isDefault ? null : h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  onClick: () => onMutate({ ...config, defaultProxy: proxy.id }),
                }, t('netProxySetDefault')),
                h('button', { type: 'button', className: 'dshp-set-primary', onClick: () => setEditingProxy('') }, t('netProxyDone')),
              ),
            ) : null,
          )
        }),
        h('div', { className: 'dshp-set-actions', style: { marginTop: '8px' } },
          h('button', {
            type: 'button',
            className: 'dshp-set-primary',
            disabled: busy,
            onClick: () => { void handleSave() },
          }, t('netSave')),
          dirty ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' }, t('netUnsaved')) : null,
        ),
        saveNotice ? h('div', { className: 'dshp-proxy-note', 'data-kind': saveNotice.kind, style: { marginTop: '6px' } }, saveNotice.text) : null,
        h('div', { className: 'dshp-direct-summary' },
          h('button', {
            type: 'button',
            className: 'dshp-set-secondary',
            onClick: () => setDirectOpen((value) => !value),
          }, `${t('netDirectProviders')} · ${directItems.length}`),
          directOpen ? h('div', { className: 'dshp-routing-picker', style: { width: '100%' } },
            h('input', {
              type: 'text',
              value: directQuery,
              placeholder: t('netRouteSearch'),
              spellCheck: false,
              onChange: (event) => setDirectQuery(event.target.value),
            }),
            h('div', { className: 'dshp-routing-list' },
              directFiltered.length === 0
                ? h('span', { className: 'dshp-set-hint' }, t('netRecentEmpty'))
                : directFiltered.map((item) => h('span', { key: item.id, className: 'dshp-tag', style: { cursor: 'default' } },
                  h('span', { className: 'dshp-tag-main' }, item.label))),
            ),
            h('span', { className: 'dshp-set-hint' }, t('netDirectProvidersHint')),
          ) : null,
        ),
      )
    }

    function NetSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const rpc = props.rpc
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [testing, setTesting] = useState('')
      const aliveRef = useRef(true)

      const applySnapshot = (value) => {
        if (value && value.ok === true && isRecord(value.snapshot)) {
          setSnapshot(value.snapshot)
          setError(null)
          return true
        }
        if (value && value.error) setError(value.error.message || value.error.code || t('loadFailed'))
        return false
      }

      const load = useMemo(() => async (options = {}) => {
        const silent = options.silent === true
        if (!rpc) {
          setError(t('netNoRpc'))
          setLoading(false)
          return
        }
        if (!silent) setLoading(true)
        try {
          const envelope = await rpc.call('/dshp-net', 'snapshot', {})
          if (!aliveRef.current) return
          const payload = rpcPayload(envelope)
          if (payload) applySnapshot(payload)
          else setError(envelope?.error?.message || t('netNoRpc'))
        } catch (reason) {
          if (aliveRef.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          if (!silent && aliveRef.current) setLoading(false)
        }
      }, [rpc, t])

      useEffect(() => {
        aliveRef.current = true
        load()
        let timer
        const schedule = () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            if (!aliveRef.current) return
            // Background health/config refresh must stay silent: toggling the
            // loading flag every few seconds made the reload button flicker.
            if (!document.hidden) load({ silent: true })
            schedule()
          }, 3000)
        }
        schedule()
        return () => {
          aliveRef.current = false
          window.clearTimeout(timer)
        }
      }, [load])

      const config = draft || netDraftFromSnapshot(snapshot)
      const revision = netRevisionOf(snapshot)
      const providers = Array.isArray(snapshot?.config?.providers)
        ? snapshot.config.providers
        : (Array.isArray(snapshot?.providers) ? snapshot.providers : [])
      const providerItems = providers.map((provider) => {
        const id = String(provider.id ?? '')
        return {
          id,
          label: provider.label || id,
          detail: Array.isArray(provider.hosts) ? provider.hosts.join(', ') : '',
        }
      })

      const mutate = (next) => setDraft(next)

      const updateProxy = (id, patch) => {
        const next = {
          ...config,
          proxies: config.proxies.map((proxy) => proxy.id === id ? { ...proxy, ...patch } : proxy),
        }
        mutate(next)
      }

      const addProxy = () => {
        const id = `proxy-${Date.now().toString(36)}-${config.proxies.length}`
        mutate({ ...config, proxies: config.proxies.concat({ id, label: '', url: '', username: '', password: '', enabled: true }) })
        return id
      }

      const removeProxy = (id) => {
        const nextProviders = {}
        for (const key of Object.keys(config.providers)) {
          const entry = config.providers[key]
          nextProviders[key] = entry.proxy === id ? { ...entry, proxy: 'direct' } : entry
        }
        mutate({
          ...config,
          defaultProxy: config.defaultProxy === id ? 'direct' : config.defaultProxy,
          proxies: config.proxies.filter((proxy) => proxy.id !== id),
          providers: nextProviders,
        })
      }

      const setProvider = (id, patch) => {
        mutate({
          ...config,
          providers: {
            ...config.providers,
            [id]: { ...(config.providers[id] || { proxy: 'direct', domains: [] }), ...patch },
          },
        })
      }

      const run = async (endpoint, payload, done, fail) => {
        if (!rpc) return undefined
        let result
        setBusy(true)
        setMessage(null)
        try {
          const envelope = await rpc.call('/dshp-net', endpoint, payload || {})
          const value = rpcPayload(envelope)
          if (value && value.ok === true) {
            result = value
            if (done) done(value)
          } else {
            setMessage({
              kind: 'error',
              text: netErrorText(value?.error, t, fail || 'loadFailed')
                || netErrorText(envelope?.error, t, fail || 'loadFailed'),
            })
          }
        } catch (reason) {
          setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
        } finally {
          setBusy(false)
        }
        return result
      }

      const save = () => {
        const proxies = config.proxies.map((proxy) => ({
          id: proxy.id,
          label: proxy.label,
          url: proxy.url,
          username: proxy.username,
          enabled: proxy.enabled,
          ...typeof proxy.password === 'string' && proxy.password.length > 0 ? { password: proxy.password } : {},
        }))
        return run('config-write', {
          config: {
            defaultProxy: config.defaultProxy,
            port: config.port,
            proxies,
            providers: Object.fromEntries(Object.entries(config.providers || {}).filter(([, entry]) => (
              isRecord(entry) && (entry.proxy !== 'direct' || (Array.isArray(entry.domains) && entry.domains.length > 0))
            ))),
          },
          revision,
        }, (value) => {
          applySnapshot(value)
          setDraft(null)
        })
      }
      const applyEnv = async () => {
        const value = await run('env-apply', {}, () => load(), t('netEnvNotApplied'))
        if (isRecord(value) && typeof value.adoptedPort === 'number') {
          setMessage({
            kind: 'warn',
            text: t('netPortAdopted')
              .replace('{configured}', String(value.adoptedFrom ?? '—'))
              .replace('{actual}', String(value.adoptedPort)),
          })
        }
      }
      const revertEnv = () => run('env-revert', {}, () => load(), t('netEnvNotApplied'))
      const reload = () => {
        setDraft(null)
        setMessage(null)
        void load()
      }
      const testEgress = () => run('egress-test', {}, (value) => {
        setMessage({ kind: value.effective === true ? 'ok' : 'error', text: value.effective === true ? t('netEgressOk') : t('netEgressFail') })
        load()
      })
      const testProxy = async (id) => {
        setTesting(id)
        setMessage(null)
        try {
          const value = await run('proxy-test', { id }, () => load())
          return isRecord(value?.health) ? value.health : undefined
        } finally {
          setTesting('')
        }
      }
      const clearLogs = () => run('logs-clear', {}, () => load())

      const router = snapshot?.router
      const stats = snapshot?.stats
      const env = snapshot?.env
      const total = typeof stats?.total === 'number' ? stats.total : 0
      const failed = typeof stats?.failed === 'number' ? stats.failed : 0
      const bytesIn = typeof stats?.bytesIn === 'number' ? stats.bytesIn : 0
      const bytesOut = typeof stats?.bytesOut === 'number' ? stats.bytesOut : 0
      const statusKind = netDotStatus(snapshot, error)
      const envKind = env?.effective === true ? 'ok' : env?.applied === true ? 'warn' : 'warn'
      const envApplied = env?.applied === true
      const envEffective = env?.effective === true
      const envWarnings = netEnvWarningTexts(env, t)
      const portFallback = isRecord(router?.portFallback) ? router.portFallback : undefined

      return h('div', { className: 'dshp-set' },
        h('style', null, CSS),
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('netTitle')),
          h('p', null, t('netProvidersHint')),
        ),
        error ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h('div', { className: 'dshp-set-card' },
          h('h3', null, t('netTitle')),
          h('div', { className: 'dshp-inline' },
            h('span', { className: 'dshp-badge', 'data-kind': statusKind === 'error' ? 'error' : statusKind === 'ok' ? 'ok' : 'warn' },
              router?.running === false ? t('netStopped') : `${t('netRunning')} · ${t('netPort')} ${router?.port ?? '—'}`),
            portFallback
              ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' },
                t('netPortFallback')
                  .replace('{configured}', String(portFallback.configuredPort))
                  .replace('{actual}', String(portFallback.actualPort)))
              : null,
            h('span', { className: 'dshp-badge', 'data-kind': envKind }, netEnvLabel(env, t)),
            router?.restartRequired ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' }, t('netRestartRequired')) : null,
          ),
          envWarnings.map((text, index) => h('div', { key: `env-warning-${index}`, className: 'dshp-set-warning' }, text)),
          h('p', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('netRestartHint')),
          h('div', { className: 'dshp-set-actions' },
            h('button', { type: 'button', className: 'dshp-set-primary', onClick: applyEnv, disabled: busy }, t('netApplyEnv')),
            h('button', {
              type: 'button',
              className: 'dshp-set-secondary',
              onClick: revertEnv,
              disabled: busy || !envApplied,
            }, t('netRevertEnv')),
            h('button', {
              type: 'button',
              className: 'dshp-set-secondary',
              onClick: testEgress,
              disabled: busy || (!envApplied && !envEffective),
            }, t('netEgressTest')),
            h('button', { type: 'button', className: 'dshp-set-secondary', onClick: reload, disabled: busy || loading }, t('netReload')),
          ),
          message ? h('div', { className: 'dshp-set-status', 'data-error': message.kind === 'error' ? 'true' : 'false', style: { marginTop: '6px' } }, message.text) : null,
        ),
        h(CollapsibleCard, { title: t('netProxies'), hint: t('netProxyHint'), defaultOpen: false },
          h(ProxyRoutingCard, {
            t,
            config,
            providerItems,
            runtimeProxies: Array.isArray(snapshot?.config?.proxies) ? snapshot.config.proxies : [],
            busy,
            testing,
            onMutate: mutate,
            onAddProxy: addProxy,
            onUpdateProxy: updateProxy,
            onRemoveProxy: removeProxy,
            onSetProvider: setProvider,
            onTestProxy: testProxy,
            onSave: save,
            dirty: draft !== null,
          }),
        ),
        h(CollapsibleCard, { title: t('netMonitor'), hint: t('netMonitorHint'), defaultOpen: false },
          h('div', { className: 'dshp-net-grid' },
            h('div', { className: 'dshp-stat' }, h('span', null, t('netStatsTotal')), h('b', null, String(total))),
            h('div', { className: 'dshp-stat' }, h('span', null, t('netStatsActive')), h('b', null, String(typeof stats?.active === 'number' ? stats.active : 0))),
            h('div', { className: 'dshp-stat' }, h('span', null, t('netStatsFailed')), h('b', null, String(failed))),
            h('div', { className: 'dshp-stat' }, h('span', null, t('netStatsSuccess')), h('b', null, typeof stats?.successRate === 'number' ? `${Math.round(stats.successRate * 100)}%` : '—')),
            h('div', { className: 'dshp-stat' }, h('span', null, t('netStatsBytes')), h('b', null, formatBytes(bytesIn + bytesOut))),
          ),
          h('div', { className: 'dshp-set-actions' },
            h('button', { type: 'button', className: 'dshp-set-secondary', onClick: clearLogs, disabled: busy }, t('netLogsClear')),
          ),
          h('div', { className: 'dshp-log' },
            netRecentRows(snapshot).length === 0
              ? h('div', { className: 'dshp-set-hint' }, t('netRecentEmpty'))
              : h('table', { className: 'dshp-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('updatedAt')),
                  h('th', null, t('netProviderHosts')),
                  h('th', null, t('netProviderProxy')),
                  h('th', null, t('netStatsBytes')),
                  h('th', null, ''),
                )),
                h('tbody', null, netRecentRows(snapshot).map((row, index) => h('tr', { key: `${row.id ?? index}-${index}` },
                  h('td', null, formatTime(row.at)),
                  h('td', { className: 'dshp-mono' }, row.host),
                  h('td', null, row.direct === true || row.proxy === 'direct' ? t('netDirect') : (row.proxy ?? '—')),
                  h('td', null, formatBytes((row.bytesIn ?? 0) + (row.bytesOut ?? 0))),
                  h('td', { 'data-kind': row.ok === false ? 'error' : 'ok' }, row.ok === false ? '✕' : '✓'),
                ))),
              ),
          ),
        ),
      )
    }

    function ModelsSettings(props) {
      const t = typeof props.t === 'function' ? props.t : (key) => key
      const rpc = props.rpc
      const [snapshot, setSnapshot] = useState(null)
      const [error, setError] = useState(null)
      const [loading, setLoading] = useState(true)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null)
      const [paste, setPaste] = useState('')
      const [flow, setFlow] = useState(null)
      const [answers, setAnswers] = useState({})
      const [flowPickerOpen, setFlowPickerOpen] = useState(false)
      const [flowQuery, setFlowQuery] = useState('')
      const aliveRef = useRef(true)

      const applySnapshot = (value) => {
        if (value && value.ok === true && isRecord(value.snapshot)) {
          setSnapshot(value.snapshot)
          setError(null)
          return true
        }
        if (value && value.error) setError(value.error.message || value.error.code || t('loadFailed'))
        return false
      }

      const load = useMemo(() => async (options = {}) => {
        const silent = options.silent === true
        if (!rpc) {
          setError(t('modelsUnavailable'))
          setLoading(false)
          return
        }
        if (!silent) setLoading(true)
        try {
          const envelope = await rpc.call('/dshp-models', 'snapshot', {})
          if (!aliveRef.current) return
          const payload = rpcPayload(envelope)
          if (payload) applySnapshot(payload)
          else setError(envelope?.error?.message || t('modelsUnavailable'))
        } catch (reason) {
          if (aliveRef.current) setError(reason instanceof Error ? reason.message : String(reason))
        } finally {
          if (!silent && aliveRef.current) setLoading(false)
        }
      }, [rpc, t])

      useEffect(() => {
        aliveRef.current = true
        load()
        let timer
        const schedule = () => {
          window.clearTimeout(timer)
          timer = window.setTimeout(() => {
            if (!aliveRef.current) return
            // Login status still refreshes, but background polls must not toggle
            // the loading flag or the refresh button looks permanently busy.
            if (!document.hidden) load({ silent: true })
            schedule()
          }, 2500)
        }
        schedule()
        return () => {
          aliveRef.current = false
          window.clearTimeout(timer)
        }
      }, [load])

      const reload = () => {
        setMessage(null)
        void load()
      }

      useEffect(() => {
        if (!flow || !rpc || flow.state === 'done' || flow.state === 'error' || flow.state === 'cancelled') return
        let timer
        const tick = async () => {
          try {
            const envelope = await rpc.call('/dshp-models', 'flow-poll', { attemptId: flow.attemptId })
            if (!aliveRef.current) return
            const payload = rpcPayload(envelope)
            if (payload && payload.ok === true) {
              setFlow((current) => current ? { ...current, ...payload, attemptId: current.attemptId } : current)
            }
          } catch {
            /* transient */
          }
          if (aliveRef.current) timer = window.setTimeout(tick, 1200)
        }
        timer = window.setTimeout(tick, 800)
        return () => window.clearTimeout(timer)
      }, [flow, rpc])

      const call = async (endpoint, payload) => {
        if (!rpc) return undefined
        try {
          const envelope = await rpc.call('/dshp-models', endpoint, payload || {})
          const value = rpcPayload(envelope)
          if (!value || value.ok !== true) {
            setMessage({ kind: 'error', text: modelsErrorText(value?.error, t) || modelsErrorText(envelope?.error, t) })
            return undefined
          }
          applySnapshot(value)
          return value
        } catch (reason) {
          setMessage({ kind: 'error', text: reason instanceof Error ? reason.message : String(reason) })
          return undefined
        }
      }

      const openUrl = (url) => {
        try {
          if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(url, '_blank', 'noopener')
        } catch {
          /* popup blocked: the link is still shown for copy */
        }
      }

      const copyUrl = (url) => {
        try {
          const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
          if (clipboard && typeof clipboard.writeText === 'function') clipboard.writeText(url)
          setMessage({ kind: 'ok', text: t('modelsCopyLink') })
        } catch {
          setMessage({ kind: 'error', text: t('modelsError') })
        }
      }

      const signIn = async () => {
        setBusy(true)
        setMessage(null)
        try {
          const value = await call('chatgpt-login-start', {})
          if (value && typeof value.url === 'string' && value.url.length > 0) openUrl(value.url)
        } finally {
          setBusy(false)
        }
      }

      const submitPaste = async () => {
        if (paste.trim().length === 0) return
        setBusy(true)
        try {
          const value = await call('chatgpt-login-submit', { url: paste.trim() })
          if (value) setPaste('')
        } finally {
          setBusy(false)
        }
      }

      const signOut = async () => {
        setBusy(true)
        try {
          await call('chatgpt-logout', {})
        } finally {
          setBusy(false)
        }
      }

      const cancelLogin = async () => {
        setBusy(true)
        try {
          await call('chatgpt-login-cancel', {})
        } finally {
          setBusy(false)
        }
      }

      const ensureRoute = async () => {
        setBusy(true)
        try {
          await call('chatgpt-route-ensure', {})
        } finally {
          setBusy(false)
        }
      }

      const startFlow = async (entry, method) => {
        setBusy(true)
        setMessage(null)
        try {
          const value = await call('flow-start', { key: entry.key, method })
          if (value && typeof value.attemptId === 'string') {
            setFlow({ attemptId: value.attemptId, key: entry.key, label: entry.label, state: 'waiting', notices: value.notices || [], prompts: value.prompts || [] })
          }
        } finally {
          setBusy(false)
        }
      }

      const answerPrompt = async (prompt) => {
        if (!flow) return
        const value = answers[prompt.id]
        if (typeof value !== 'string' || value.length === 0) return
        try {
          await rpc.call('/dshp-models', 'flow-answer', { attemptId: flow.attemptId, promptId: prompt.id, value })
          setAnswers((current) => ({ ...current, [prompt.id]: '' }))
        } catch {
          /* poll picks up state */
        }
      }

      const cancelFlow = async () => {
        if (!flow) return
        try {
          await rpc.call('/dshp-models', 'flow-cancel', { attemptId: flow.attemptId })
        } catch {
          /* ignore */
        }
        setFlow(null)
      }

      const chatgpt = isRecord(snapshot?.chatgpt) ? snapshot.chatgpt : {}
      const login = isRecord(chatgpt.login) ? chatgpt.login : {}
      const signedIn = chatgpt.signedIn === true
      const flows = (Array.isArray(snapshot?.flows) ? snapshot.flows : []).filter((entry) => (
        entry && Array.isArray(entry.methods) && entry.methods.some((method) => method && method.id === 'oauth')
      ))
      const oauthFlowCount = flows.length
      const flowOptions = flows.filter((entry) => {
        const text = `${entry.label || ''} ${entry.key || ''}`.toLowerCase()
        return flowQuery.trim().length === 0 || text.includes(flowQuery.trim().toLowerCase())
      })
      const expiresIn = typeof chatgpt.expiresInMs === 'number' ? chatgpt.expiresInMs : undefined
      const expiresText = expiresIn === undefined ? '' : expiresIn <= 0 ? t('usedUp') : `${Math.max(0, Math.round(expiresIn / 60000))} min`

      return h('div', { className: 'dshp-set' },
        h('style', null, CSS),
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('modelsTitle')),
          h('p', null, t('modelsChatgptHint')),
        ),
        error ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
        h('div', { className: 'dshp-set-card' },
          h('h3', null, t('modelsChatgpt')),
          h('div', { className: 'dshp-inline' },
            h('span', { className: 'dshp-badge', 'data-kind': signedIn ? 'ok' : 'warn' }, signedIn ? t('modelsSignedIn') : t('modelsSignedOut')),
            expiresText ? h('span', { className: 'dshp-badge' }, `${t('modelsExpires')} ${expiresText}`) : null,
            chatgpt.routeConfigured !== true ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' }, t('modelsRouteMissing')) : null,
            signedIn && chatgpt.routeHasKeyOverride !== true ? h('span', { className: 'dshp-badge', 'data-kind': 'ok' }, t('modelsAuthOauth')) : null,
            chatgpt.routeHasKeyOverride === true ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' }, t('modelsRouteKeyWarn')) : null,
            login.callbackAvailable === false ? h('span', { className: 'dshp-badge', 'data-kind': 'warn' }, t('modelsCallbackManual')) : null,
          ),
          h('p', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('modelsChatgptHint')),
          h('p', { className: 'dshp-set-hint', style: { marginTop: '4px' } }, t('modelsRouteHint')),
          h('div', { className: 'dshp-set-actions' },
            h('button', { type: 'button', className: 'dshp-set-primary', onClick: signIn, disabled: busy }, t('modelsSignIn')),
            login.state === 'waiting' || login.state === 'exchanging'
              ? h('button', { type: 'button', className: 'dshp-set-secondary', onClick: cancelLogin, disabled: busy }, t('modelsCancel'))
              : null,
            chatgpt.routeConfigured !== true ? h('button', { type: 'button', className: 'dshp-set-secondary', onClick: ensureRoute, disabled: busy }, t('modelsRouteEnsure')) : null,
            signedIn ? h('button', { type: 'button', className: 'dshp-set-secondary', onClick: signOut, disabled: busy }, t('modelsSignOut')) : null,
            h('button', { type: 'button', className: 'dshp-set-secondary', onClick: reload, disabled: busy || loading }, t('modelsReload')),
            message ? h('span', { className: 'dshp-set-status', 'data-error': message.kind === 'error' ? 'true' : 'false' }, message.text) : null,
          ),
          login.state && login.state !== 'idle' ? h('div', { className: 'dshp-inline', style: { marginTop: '8px' } },
            h('span', { className: 'dshp-badge', 'data-kind': login.state === 'error' ? 'error' : login.state === 'done' ? 'ok' : 'warn' }, login.state),
            isRecord(login.error) && typeof login.error.message === 'string'
              ? h('span', { className: 'dshp-warn' }, `${t('modelsError')} — ${login.error.message}`)
              : null,
          ) : null,
          typeof login.url === 'string' && login.url.length > 0 && login.state !== 'done'
            ? h('div', { className: 'dshp-notice' },
              h('div', null, `${t('modelsSignInWaiting')} ${login.state || ''}`),
              h('div', { className: 'dshp-inline', style: { marginTop: '6px' } },
                h('span', { className: 'dshp-mono', style: { wordBreak: 'break-all' } }, login.url.length > 120 ? `${login.url.slice(0, 120)}…` : login.url),
                h('button', { type: 'button', className: 'dshp-set-secondary', onClick: () => openUrl(login.url) }, t('modelsSignIn')),
                h('button', { type: 'button', className: 'dshp-set-secondary', onClick: () => copyUrl(login.url) }, t('modelsCopyLink')),
              ),
            )
            : null,
          h('div', { className: 'dshp-answer' },
            h('input', {
              type: 'text',
              value: paste,
              placeholder: 'http://127.0.0.1:1455/auth/callback?…',
              spellCheck: false,
              onChange: (event) => setPaste(event.target.value),
            }),
            h('button', { type: 'button', className: 'dshp-set-secondary', onClick: submitPaste, disabled: busy || paste.trim().length === 0 }, t('modelsManualSubmit')),
          ),
          h('p', { className: 'dshp-set-hint', style: { marginTop: '6px' } }, t('modelsManualHint')),
        ),
        h(CollapsibleCard, { title: t('modelsFlows'), hint: t('modelsFlowsHint'), defaultOpen: false },
          h('div', { className: 'dshp-set-actions', style: { marginTop: 0 } },
            h('button', {
              type: 'button',
              className: 'dshp-set-primary',
              onClick: () => setFlowPickerOpen((value) => !value),
            }, t('modelsFlowAdd')),
            h('span', { className: 'dshp-set-hint' }, `${oauthFlowCount} ${t('modelsFlows')}`),
          ),
          flowPickerOpen ? h('div', { className: 'dshp-routing-picker' },
            h('input', {
              type: 'text',
              value: flowQuery,
              placeholder: t('modelsFlowSearch'),
              spellCheck: false,
              onChange: (event) => setFlowQuery(event.target.value),
            }),
            h('div', { className: 'dshp-routing-list' },
              flowOptions.length === 0
                ? h('span', { className: 'dshp-set-hint' }, t('modelsFlowEmpty'))
                : flowOptions.map((entry) => h('button', {
                  key: entry.key,
                  type: 'button',
                  className: 'dshp-routing-item',
                  disabled: busy || entry.inFlight === true,
                  onClick: () => {
                    setFlowPickerOpen(false)
                    setFlowQuery('')
                    startFlow(entry, 'oauth')
                  },
                }, h('span', null, entry.label || entry.key), h('span', null, entry.inFlight === true ? t('modelsFlowInFlight') : ''))),
            ),
          ) : null,
          flow
            ? h('div', { className: 'dshp-notice' },
              h('div', { className: 'dshp-inline' },
                h('span', { className: 'dshp-flow-name' }, flow.label || flow.key),
                h('span', { className: 'dshp-badge', 'data-kind': flow.state === 'error' ? 'error' : flow.state === 'done' ? 'ok' : 'warn' }, flow.state),
                h('button', { type: 'button', className: 'dshp-set-secondary', onClick: cancelFlow }, t('modelsFlowCancel')),
              ),
              flow.error ? h('div', { className: 'dshp-warn' }, flow.error) : null,
              (Array.isArray(flow.notices) ? flow.notices : []).map((notice, index) => h('div', { key: `n-${index}`, style: { marginTop: '5px' } },
                notice.message,
                notice.code ? h('code', { style: { marginLeft: '6px' } }, `${t('modelsNoticeCode')}: ${notice.code}`) : null,
                notice.url ? h('a', { href: notice.url, target: '_blank', rel: 'noreferrer noopener', style: { marginLeft: '6px' } }, notice.url) : null,
              )),
              (Array.isArray(flow.prompts) ? flow.prompts : []).map((prompt) => h('div', { key: prompt.id, className: 'dshp-answer' },
                h('span', { className: 'dshp-set-label' }, prompt.message || t('modelsPromptText')),
                prompt.kind === 'select' && Array.isArray(prompt.options)
                  ? h(PickMenu, {
                    value: answers[prompt.id] || '',
                    options: prompt.options.map((option) => ({ value: option.id, label: option.label || option.id })),
                    placeholder: t('modelsPromptSelect'),
                    onSelect: (value) => setAnswers((current) => ({ ...current, [prompt.id]: value })),
                    t,
                  })
                  : h('input', {
                    type: prompt.kind === 'secret' ? 'password' : 'text',
                    value: answers[prompt.id] || '',
                    placeholder: prompt.placeholder || '',
                    onChange: (event) => setAnswers((current) => ({ ...current, [prompt.id]: event.target.value })),
                  }),
                h('button', { type: 'button', className: 'dshp-set-secondary', onClick: () => answerPrompt(prompt) }, t('modelsSubmit')),
              )),
            )
            : null,
        ),
      )
    }

    // ------------------------------------------------------------------
    // floating layer: dshps ball + satellite ring + movable windows
    // ------------------------------------------------------------------

    const SHELL_CHANNEL = '/dshp-shell'
    const FLOAT_WINDOW_SIZE = 380
    const FLOAT_MIN_W = 240
    const FLOAT_MIN_H = 140
    const FLOAT_TITLEBAR_H = 34
    const FAB_SIZE = 48
    const SAT_SIZE = 38
    const RING_RADIUS = 78
    const FLOAT_SAVE_DELAY_MS = 250

    const FLOAT_WINDOWS = [
      { id: 'monitor', labelKey: 'floatMonitorTitle', icon: 'monitor' },
      { id: 'audit', labelKey: 'floatAuditTitle', icon: 'audit' },
      { id: 'quota', labelKey: 'floatQuotaTitle', icon: 'quota' },
      { id: 'models', labelKey: 'floatModelsTitle', icon: 'models' },
    ]

    function cloneJson(value) {
      return value === undefined ? undefined : JSON.parse(JSON.stringify(value))
    }

    function clampNumber(value, min, max) {
      return Math.min(max, Math.max(min, value))
    }

    function geometryFromWindow(win, viewport) {
      const w = clampNumber(win.w || FLOAT_WINDOW_SIZE, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, viewport.w))
      const h = clampNumber(win.h || 280, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, viewport.h))
      const renderH = win.collapsed ? FLOAT_TITLEBAR_H : h
      const left = clampNumber((win.x || 0) * viewport.w, 0, Math.max(0, viewport.w - w))
      const top = clampNumber((win.y || 0) * viewport.h, 0, Math.max(0, viewport.h - renderH))
      return { left, top, w, h }
    }

    function clampGeometry(geom, viewport, collapsed) {
      const maxW = Math.max(FLOAT_MIN_W, viewport.w)
      const maxH = Math.max(FLOAT_MIN_H, viewport.h)
      const w = clampNumber(geom.w, FLOAT_MIN_W, maxW)
      const h = clampNumber(geom.h, FLOAT_MIN_H, maxH)
      const renderH = collapsed ? FLOAT_TITLEBAR_H : h
      return {
        left: clampNumber(geom.left, 0, Math.max(0, viewport.w - w)),
        top: clampNumber(geom.top, 0, Math.max(0, viewport.h - renderH)),
        w,
        h,
      }
    }

    /**
     * Lay out the satellite balls around the FAB using the free angular sector
     * implied by the FAB's distance to the viewport edges:
     *  - open space        -> 360° (full ring);
     *  - near one edge     -> 180° half ring, opening away from that edge;
     *  - near a corner     -> 90° quarter ring, opening into the free quadrant.
     * Satellites are distributed by angle inside the sector; more satellites
     * simply add outer rings. Every returned position is inside the viewport
     * and no two satellites overlap. A compact grid is only the last-resort
     * fallback when even the outer rings cannot fit (tiny page / huge count).
     */
    function ringLayout(fab, count, viewport) {
      const margin = 8
      const width = Math.max(SAT_SIZE + margin * 2, viewport.w)
      const height = Math.max(SAT_SIZE + margin * 2, viewport.h)
      const cx = fab.left + FAB_SIZE / 2
      const cy = fab.top + FAB_SIZE / 2
      const threshold = RING_RADIUS + SAT_SIZE + 16
      const nearLeft = cx < threshold
      const nearRight = width - cx < threshold
      const nearTop = cy < threshold
      const nearBottom = height - cy < threshold
      const blocked = [nearLeft, nearRight, nearTop, nearBottom].filter(Boolean).length

      let span
      let center
      if (blocked === 0) {
        span = Math.PI * 2
        center = -Math.PI / 2
      } else if (blocked === 1) {
        span = Math.PI
        center = nearTop ? Math.PI / 2 : nearBottom ? -Math.PI / 2 : nearLeft ? 0 : Math.PI
      } else if (blocked === 2) {
        // Two blocked sides: a real corner has one free quadrant (90°). Two
        // opposite blocked sides (very narrow page) have no free quadrant, so
        // fall back to the grid instead of producing a nonsensical sector.
        if (nearTop && nearLeft) center = Math.PI / 4
        else if (nearTop && nearRight) center = (Math.PI * 3) / 4
        else if (nearBottom && nearRight) center = (-Math.PI * 3) / 4
        else if (nearBottom && nearLeft) center = -Math.PI / 4
        else return gridLayout(cx, cy, count, width, height, margin)
        span = Math.PI / 2
      } else {
        // Three or four blocked sides: keep a 90° sector toward the only free
        // direction if there is one; otherwise the grid is the honest layout.
        if (!nearTop) center = Math.PI / 2
        else if (!nearBottom) center = -Math.PI / 2
        else if (!nearLeft) center = 0
        else if (!nearRight) center = Math.PI
        else return gridLayout(cx, cy, count, width, height, margin)
        span = Math.PI / 2
      }

      const gap = SAT_SIZE + 10
      // Prefer ONE clean arc (like a phone's floating-ball satellite fan): all
      // satellites share the same radius and are evenly spaced by angle. Only
      // when that arc would need an unreasonable radius do we add outer rings.
      const countSafe = Math.max(1, count)
      const singleStep = span >= Math.PI * 2 ? (Math.PI * 2) / countSafe : span / countSafe
      const neededRadius = countSafe <= 1
        ? RING_RADIUS
        : gap / (2 * Math.sin(singleStep / 2))
      const singleRadius = Math.min(220, Math.max(RING_RADIUS, neededRadius))
      const singlePositions = []
      for (let index = 0; index < count; index += 1) {
        const angle = count === 1
          ? (span >= Math.PI * 2 ? -Math.PI / 2 : center)
          : span >= Math.PI * 2
            ? (-Math.PI / 2) + (index * Math.PI * 2) / count
            : (center - span / 2) + (singleStep * (index + 0.5))
        singlePositions.push({
          left: cx + Math.cos(angle) * singleRadius - SAT_SIZE / 2,
          top: cy + Math.sin(angle) * singleRadius - SAT_SIZE / 2,
        })
      }
      const singleInside = singlePositions.every((position) => (
        position.left >= margin &&
        position.top >= margin &&
        position.left + SAT_SIZE <= width - margin &&
        position.top + SAT_SIZE <= height - margin
      ))
      const singleApart = singlePositions.every((position, index) => singlePositions.every((other, otherIndex) => (
        index === otherIndex ||
        Math.hypot(position.left - other.left, position.top - other.top) >= SAT_SIZE
      )))
      if (singleInside && singleApart) return singlePositions

      const rings = []
      for (let index = 0; index < 6; index += 1) {
        const radius = RING_RADIUS + 54 * index
        rings.push({ radius, capacity: Math.max(1, Math.floor((span * radius) / gap)) })
      }
      let ringCount = 1
      while (ringCount < rings.length && rings.slice(0, ringCount).reduce((sum, ring) => sum + ring.capacity, 0) < count) ringCount += 1
      const chosen = rings.slice(0, ringCount)
      // Balance the satellites evenly across the chosen rings (respecting each
      // ring's capacity) instead of filling inner rings proportionally. This
      // avoids the sparse "1 inner + 3 outer" look of a 90° corner fan.
      const allocations = chosen.map((ring) => Math.min(ring.capacity, Math.max(1, Math.round(count / chosen.length))))
      let delta = count - allocations.reduce((sum, value) => sum + value, 0)
      let guard = 0
      while (delta !== 0 && guard < 1000) {
        guard += 1
        let changed = false
        for (let index = 0; index < chosen.length && delta !== 0; index += 1) {
          if (delta > 0 && allocations[index] < chosen[index].capacity) {
            allocations[index] += 1
            delta -= 1
            changed = true
          } else if (delta < 0 && allocations[index] > 1) {
            allocations[index] -= 1
            delta += 1
            changed = true
          }
        }
        if (!changed) break
      }
      const positions = []
      const start = center - span / 2
      for (let ringIndex = 0; ringIndex < chosen.length; ringIndex += 1) {
        const ring = chosen[ringIndex]
        const slots = allocations[ringIndex]
        for (let slot = 0; slot < slots; slot += 1) {
          let angle
          if (span >= Math.PI * 2) {
            angle = start + (slot * Math.PI * 2) / Math.max(1, slots)
          } else {
            // Half/quarter rings: pad the ends by half a slot so no ball sits
            // exactly on the sector boundary; alternate rings are staggered to
            // avoid a spoke-like look in multi-ring layouts.
            const offset = 0.5 + (ringIndex % 2 === 0 ? 0 : 0.5)
            angle = start + (span * (slot + offset)) / slots
          }
          positions.push({
            left: cx + Math.cos(angle) * ring.radius - SAT_SIZE / 2,
            top: cy + Math.sin(angle) * ring.radius - SAT_SIZE / 2,
          })
        }
      }
      const inside = positions.every((position) => (
        position.left >= margin &&
        position.top >= margin &&
        position.left + SAT_SIZE <= width - margin &&
        position.top + SAT_SIZE <= height - margin
      ))
      const apart = positions.every((position, index) => positions.every((other, otherIndex) => {
        if (index === otherIndex) return true
        return Math.hypot(position.left - other.left, position.top - other.top) >= SAT_SIZE
      }))
      if (inside && apart && positions.length === count) return positions
      return gridLayout(cx, cy, count, width, height, margin)
    }

    /** Compact row/column fallback used when arcs cannot fit (many satellites / tiny page). */
    function gridLayout(cx, cy, count, width, height, margin) {
      const gap = SAT_SIZE + 8
      const maxPerRow = Math.max(1, Math.floor((width - margin * 2 + 8) / gap))
      const maxRows = Math.max(1, Math.floor((height - margin * 2 + 8) / gap))
      let perRow = Math.min(5, maxPerRow, Math.max(1, Math.ceil(Math.sqrt(count))))
      let rows = Math.ceil(count / Math.max(1, perRow))
      if (rows > maxRows) {
        perRow = Math.min(maxPerRow, Math.ceil(count / maxRows))
        rows = Math.ceil(count / Math.max(1, perRow))
      }
      const panelWidth = perRow * gap - 8
      const panelHeight = rows * gap - 8
      const leftHalf = cx < width / 2
      const topHalf = cy < height / 2
      let panelLeft = leftHalf ? cx + FAB_SIZE / 2 + 10 : cx - FAB_SIZE / 2 - 10 - panelWidth
      let panelTop = topHalf ? cy + FAB_SIZE / 2 + 10 : cy - FAB_SIZE / 2 - 10 - panelHeight
      panelLeft = clampNumber(panelLeft, margin, Math.max(margin, width - panelWidth - margin))
      panelTop = clampNumber(panelTop, margin, Math.max(margin, height - panelHeight - margin))
      const positions = []
      for (let index = 0; index < count; index += 1) {
        const row = Math.floor(index / perRow)
        const column = index % perRow
        positions.push({
          left: panelLeft + column * gap,
          top: panelTop + row * gap,
        })
      }
      return positions
    }

    function FloatIcon({ kind, size = 18 }) {
      const common = { viewBox: '0 0 20 20', width: size, height: size, 'aria-hidden': true }
      if (kind === 'monitor') {
        return h('svg', common,
          h('circle', { cx: 10, cy: 10, r: 6.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M3.5 10h13M10 3.5c2.2 2 2.2 11 0 13M10 3.5c-2.2 2-2.2 11 0 13', fill: 'none', stroke: 'currentColor', strokeWidth: 1.1 }),
        )
      }
      if (kind === 'audit') {
        return h('svg', common,
          h('path', { d: 'M5 3.5h10v13l-2.5-1.6L10 16.5l-2.5-1.6L5 16.5z', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinejoin: 'round' }),
          h('path', { d: 'M7.5 7h5M7.5 10h5M7.5 13h3', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        )
      }
      if (kind === 'quota') {
        return h('svg', common,
          h('path', { d: 'M4 15V9.5M8 15V6M12 15v-4M16 15V4.5', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' }),
          h('path', { d: 'M3 17h14', stroke: 'currentColor', strokeWidth: 1.2, strokeLinecap: 'round' }),
        )
      }
      if (kind === 'models') {
        return h('svg', common,
          h('circle', { cx: 10, cy: 7, r: 3, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
          h('path', { d: 'M4.5 16.5c.8-3 2.8-4.5 5.5-4.5s4.7 1.5 5.5 4.5', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }),
        )
      }
      return h('svg', common, h('circle', { cx: 10, cy: 10, r: 5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }))
    }

    /** Shared client-side store for the floating layer (Host-backed, debounced writes). */
    function createFloatingStore(rpc) {
      let state = null
      let revision = 0
      let loading = true
      let saving = false
      let error = null
      let warnings = []
      let saveTimer = null
      let pendingSave = false
      const listeners = new Set()

      const snapshot = () => ({ state, revision, loading, saving, error, warnings })
      const emit = () => {
        for (const listener of [...listeners]) {
          try {
            listener()
          } catch {
            /* a broken subscriber must not break the layer */
          }
        }
      }

      const applyPayload = (payload) => {
        if (!payload || payload.ok !== true || !isRecord(payload.state)) return false
        state = payload.state
        revision = typeof payload.revision === 'number' ? payload.revision : revision
        warnings = Array.isArray(payload.warnings) ? payload.warnings : []
        error = null
        return true
      }

      const load = async () => {
        if (!rpc) {
          loading = false
          error = 'RPC unavailable'
          emit()
          return
        }
        loading = state === null
        emit()
        try {
          const envelope = await rpc.call(SHELL_CHANNEL, 'state', {})
          const payload = rpcPayload(envelope)
          if (!applyPayload(payload)) {
            error = payload?.error?.message || envelope?.error?.message || 'floating state unavailable'
          }
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason)
        } finally {
          loading = false
          emit()
        }
      }

      const saveNow = async () => {
        if (!rpc || !state) return
        if (saving) {
          pendingSave = true
          return
        }
        saving = true
        emit()
        const outgoing = state
        try {
          const envelope = await rpc.call(SHELL_CHANNEL, 'save', { state: outgoing, revision })
          const payload = rpcPayload(envelope)
          if (payload && payload.ok === true && isRecord(payload.state)) {
            revision = typeof payload.revision === 'number' ? payload.revision : revision
            warnings = Array.isArray(payload.warnings) ? payload.warnings : []
            if (state === outgoing) {
              state = payload.state
              error = null
            }
          } else {
            const code = payload?.error?.code
            if (code === 'state-conflict') {
              await load()
            } else {
              error = payload?.error?.message || envelope?.error?.message || 'floating state write failed'
            }
          }
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason)
        } finally {
          saving = false
          emit()
          if (pendingSave) {
            pendingSave = false
            scheduleSave()
          }
        }
      }

      const scheduleSave = () => {
        if (saveTimer !== null) window.clearTimeout(saveTimer)
        saveTimer = window.setTimeout(() => {
          saveTimer = null
          void saveNow()
        }, FLOAT_SAVE_DELAY_MS)
      }

      const update = (recipe) => {
        if (!state) return
        const next = recipe(cloneJson(state))
        if (!isRecord(next)) return
        state = next
        emit()
        scheduleSave()
      }

      const setPath = (mutate) => update((next) => {
        mutate(next)
        return next
      })

      const toggleWindow = (id) => setPath((next) => {
        const win = next.windows && next.windows[id]
        if (!win) return
        win.open = !win.open
        if (win.open) {
          win.z = next.nextZ || 1
          next.nextZ = (next.nextZ || 1) + 1
        }
      })

      const raiseWindow = (id) => update((next) => {
        const win = next.windows && next.windows[id]
        if (!win || !win.open) return next
        win.z = next.nextZ || 1
        next.nextZ = (next.nextZ || 1) + 1
        return next
      })

      const patchWindow = (id, patch) => setPath((next) => {
        const win = next.windows && next.windows[id]
        if (!win) return
        Object.assign(win, patch)
      })

      const commitGeometry = (id, geom, viewport) => setPath((next) => {
        const win = next.windows && next.windows[id]
        if (!win) return
        win.x = viewport.w > 0 ? clampNumber(geom.left / viewport.w, 0, 1) : win.x
        win.y = viewport.h > 0 ? clampNumber(geom.top / viewport.h, 0, 1) : win.y
        win.w = Math.round(clampNumber(geom.w, FLOAT_MIN_W, Math.max(FLOAT_MIN_W, viewport.w)))
        win.h = Math.round(clampNumber(geom.h, FLOAT_MIN_H, Math.max(FLOAT_MIN_H, viewport.h)))
      })

      const moveFab = (fab, viewport) => setPath((next) => {
        // Stored fab coordinates are viewport ratios of the ball CENTER; the
        // dragged geometry is the top-left corner, so convert back with the ball
        // radius instead of writing the top-left ratio (that made the ball jump
        // up-left after a drop).
        next.fab = {
          x: viewport.w > 0 ? clampNumber((fab.left + FAB_SIZE / 2) / viewport.w, 0, 1) : next.fab.x,
          y: viewport.h > 0 ? clampNumber((fab.top + FAB_SIZE / 2) / viewport.h, 0, 1) : next.fab.y,
        }
      })

      const setEnabled = (enabled) => setPath((next) => { next.enabled = enabled === true })
      const setFabLocked = (locked) => setPath((next) => { next.fabLocked = locked === true })
      const setSatellite = (id, visible) => setPath((next) => {
        next.satellites = isRecord(next.satellites) ? next.satellites : {}
        next.satellites[id] = visible === true
      })

      const reset = async () => {
        if (!rpc) return
        try {
          const envelope = await rpc.call(SHELL_CHANNEL, 'reset', {})
          const payload = rpcPayload(envelope)
          if (!applyPayload(payload)) error = payload?.error?.message || envelope?.error?.message || 'floating state reset failed'
        } catch (reason) {
          error = reason instanceof Error ? reason.message : String(reason)
        }
        emit()
      }

      const subscribe = (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      }

      return {
        snapshot,
        subscribe,
        load,
        update,
        reset,
        moveFab,
        commitGeometry,
        toggleWindow,
        raiseWindow,
        patchWindow,
        setEnabled,
        setFabLocked,
        setSatellite,
        __setForTest(next, nextRevision) {
          state = next
          revision = typeof nextRevision === 'number' ? nextRevision : 0
          loading = false
          error = null
          emit()
        },
      }
    }

    function useFloatingStore(store) {
      const [snapshot, setSnapshot] = useState(() => store.snapshot())
      useEffect(() => {
        const unsubscribe = store.subscribe(() => setSnapshot(store.snapshot()))
        return unsubscribe
      }, [store])
      return snapshot
    }

    function usePolledSnapshot(rpc, channel, endpoint, enabled, intervalMs, reloadKey) {
      const [data, setData] = useState(null)
      const [error, setError] = useState(null)
      useEffect(() => {
        if (!enabled || !rpc) return undefined
        let alive = true
        let timer = null
        const load = async () => {
          try {
            const envelope = await rpc.call(channel, endpoint, {})
            const payload = rpcPayload(envelope)
            if (!alive) return
            if (payload && payload.ok === true) {
              setData(payload.snapshot)
              setError(null)
            } else {
              setError(payload?.error?.message || envelope?.error?.message || 'RPC unavailable')
            }
          } catch (reason) {
            if (alive) setError(reason instanceof Error ? reason.message : String(reason))
          }
        }
        void load()
        timer = window.setInterval(() => {
          if (!document.hidden) void load()
        }, intervalMs)
        return () => {
          alive = false
          if (timer !== null) window.clearInterval(timer)
        }
      }, [rpc, channel, endpoint, enabled, intervalMs, reloadKey])
      return { data, error }
    }

    function FloatBadge({ kind, children }) {
      return h('span', { className: 'dshp-badge', 'data-kind': kind }, children)
    }

    function FloatMonitorContent({ rpc, t, enabled }) {
      const { data, error } = usePolledSnapshot(rpc, '/dshp-net', 'snapshot', enabled, 3000)
      const snapshot = data
      if (error) return h('div', { className: 'dshp-fw-error' }, error)
      if (!snapshot) return h('div', { className: 'dshp-fw-tiny' }, t('loading'))
      const stats = snapshot.stats || {}
      const router = snapshot.router || {}
      const env = snapshot.env || {}
      const total = typeof stats.total === 'number' ? stats.total : 0
      const failed = typeof stats.failed === 'number' ? stats.failed : 0
      const active = typeof stats.active === 'number' ? stats.active : 0
      const bytes = (typeof stats.bytesIn === 'number' ? stats.bytesIn : 0) + (typeof stats.bytesOut === 'number' ? stats.bytesOut : 0)
      const rows = netRecentRows(snapshot).slice(0, 8)
      return h(React.Fragment, null,
        h('div', { className: 'dshp-inline', style: { marginBottom: '8px' } },
          h(FloatBadge, { kind: router.running === false ? 'error' : 'ok' },
            `${t('floatGateway')}: ${router.running === false ? t('netStopped') : `${t('netRunning')} · ${router.port ?? '—'}`}`),
          h(FloatBadge, { kind: env.effective === true ? 'ok' : 'warn' }, `${t('floatEnv')}: ${netEnvLabel(env, t)}`),
        ),
        env.warning ? h('div', { className: 'dshp-fw-tiny dshp-fw-warn' }, env.warning) : null,
        h('div', { className: 'dshp-fw-grid' },
          h('div', { className: 'dshp-fw-stat' }, h('span', null, t('netStatsTotal')), h('b', null, String(total))),
          h('div', { className: 'dshp-fw-stat' }, h('span', null, t('netStatsActive')), h('b', null, String(active))),
          h('div', { className: 'dshp-fw-stat' }, h('span', null, t('netStatsFailed')), h('b', null, String(failed))),
        ),
        h('div', { className: 'dshp-fw-tiny', style: { marginTop: '6px' } }, `${t('netStatsBytes')}: ${formatBytes(bytes)}`),
        h('div', { className: 'dshp-fw-tiny', style: { marginTop: '8px' } }, t('floatRecent')),
        rows.length === 0
          ? h('div', { className: 'dshp-fw-tiny' }, t('netRecentEmpty'))
          : h('div', null, rows.map((row, index) => h('div', { key: `${row.id ?? index}-${index}`, className: 'dshp-fw-row' },
            h('span', { className: 'dshp-fw-name dshp-fw-mono' }, row.host || '—'),
            h('span', { className: 'dshp-fw-tiny' }, row.direct === true || row.proxy === 'direct' ? t('netDirect') : (row.proxy || '—')),
            h('span', { className: 'dshp-fw-value' }, row.ok === false ? h('span', { className: 'dshp-fw-error' }, '✕') : '✓'),
          ))),
      )
    }

    function FloatAuditContent({ rpc, t, enabled }) {
      const [reloadKey, setReloadKey] = useState(0)
      const { data, error } = usePolledSnapshot(rpc, '/dshp-net', 'snapshot', enabled, 5000, reloadKey)
      const rows = netRecentRows(data).slice(0, 40)
      const clear = async () => {
        try {
          await rpc.call('/dshp-net', 'logs-clear', {})
          setReloadKey((value) => value + 1)
        } catch {
          /* the next poll retries */
        }
      }
      return h(React.Fragment, null,
        h('div', { className: 'dshp-fw-actions', style: { marginTop: 0, marginBottom: '6px' } },
          h('button', { type: 'button', className: 'dshp-fw-act', onClick: clear }, t('floatClear')),
          h('span', { className: 'dshp-fw-tiny' }, `${t('netStatsTotal')}: ${typeof data?.stats?.total === 'number' ? data.stats.total : 0}`),
        ),
        error ? h('div', { className: 'dshp-fw-error' }, error) : null,
        rows.length === 0
          ? h('div', { className: 'dshp-fw-tiny' }, t('netRecentEmpty'))
          : h('table', { className: 'dshp-fw-table' },
            h('thead', null, h('tr', null,
              h('th', null, t('updatedAt')),
              h('th', null, t('netProviderHosts')),
              h('th', null, t('netProviderProxy')),
              h('th', null, t('netStatsBytes')),
            )),
            h('tbody', null, rows.map((row, index) => h('tr', { key: `${row.id ?? index}-${index}` },
              h('td', null, formatTime(row.at)),
              h('td', { className: 'dshp-fw-mono' }, row.host || '—'),
              h('td', null, row.direct === true || row.proxy === 'direct' ? t('netDirect') : (row.proxy || '—')),
              h('td', null, formatBytes((row.bytesIn ?? 0) + (row.bytesOut ?? 0))),
            ))),
          ),
      )
    }

    function FloatQuotaContent({ rpc, t, enabled }) {
      const { data, error } = usePolledSnapshot(rpc, '/dshp-quota', 'snapshot', enabled, 30000)
      if (error) return h('div', { className: 'dshp-fw-error' }, error)
      if (!data) return h('div', { className: 'dshp-fw-tiny' }, t('loading'))
      const groups = groupProviders(data?.providers)
      if (groups.length === 0) return h('div', { className: 'dshp-fw-tiny' }, t('floatQuotaEmpty'))
      return h('div', { className: 'dshp-q-root', 'data-wide': 'true' },
        h('div', { className: 'dshp-q-head' },
          h('span', { className: 'dshp-q-title' }, t('title')),
          h('span', { className: 'dshp-q-dot', 'data-status': snapshotStatus(data) }),
          h('span', { className: 'dshp-q-time' }, `${t('updatedAt')} ${formatTime(data.generatedAt)}`),
        ),
        h('div', { className: 'dshp-q-body' },
          groups.map((group) => h(CompactRow, { key: group.key, group, t })),
        ),
      )
    }

    function FloatModelsContent({ rpc, t, enabled }) {
      const { data, error } = usePolledSnapshot(rpc, '/dshp-models', 'snapshot', enabled, 5000)
      if (error) return h('div', { className: 'dshp-fw-error' }, error)
      if (!data) return h('div', { className: 'dshp-fw-tiny' }, t('loading'))
      const chatgpt = isRecord(data.chatgpt) ? data.chatgpt : {}
      const flows = Array.isArray(data.flows) ? data.flows : []
      const oauthFlows = flows.filter((entry) => Array.isArray(entry.methods) && entry.methods.some((method) => method && method.id === 'oauth'))
      return h(React.Fragment, null,
        h('div', { className: 'dshp-inline' },
          h(FloatBadge, { kind: chatgpt.signedIn === true ? 'ok' : 'warn' }, chatgpt.signedIn === true ? t('floatModelsSignedIn') : t('floatModelsSignedOut')),
          h(FloatBadge, { kind: chatgpt.routeConfigured === true ? 'ok' : 'warn' },
            `${t('floatModelsRoute')}: ${chatgpt.routeConfigured === true ? t('floatModelsConfigured') : t('floatModelsMissing')}`),
        ),
        typeof chatgpt.expiresInMs === 'number' && chatgpt.expiresInMs > 0
          ? h('div', { className: 'dshp-fw-tiny', style: { marginTop: '6px' } }, `${t('modelsExpires')} ${Math.max(0, Math.round(chatgpt.expiresInMs / 60000))} min`)
          : null,
        h('div', { className: 'dshp-fw-tiny', style: { marginTop: '8px' } }, `${t('modelsFlows')}: ${oauthFlows.length}`),
        h('div', { className: 'dshp-fw-tiny', style: { marginTop: '4px' } }, t('modelsFlowsHint')),
      )
    }

    function FloatWindowContent({ id, rpc, t, enabled }) {
      if (id === 'monitor') return h(FloatMonitorContent, { rpc, t, enabled })
      if (id === 'audit') return h(FloatAuditContent, { rpc, t, enabled })
      if (id === 'quota') return h(FloatQuotaContent, { rpc, t, enabled })
      if (id === 'models') return h(FloatModelsContent, { rpc, t, enabled })
      return null
    }

    function FloatingWindow({ def, win, viewport, t, rpc, active, onClose, onRaise, onLock, onCollapse, onCommit }) {
      const [geom, setGeom] = useState(null)
      const dragRef = useRef(null)
      const resizeRef = useRef(null)
      const geomRef = useRef(null)
      const winRef = useRef(null)
      const base = geometryFromWindow(win, viewport)
      const current = geom || base
      const renderH = win.collapsed ? FLOAT_TITLEBAR_H : current.h
      const height = clampNumber(renderH, FLOAT_TITLEBAR_H, viewport.h)
      const top = win.collapsed
        ? clampNumber(current.top, 0, Math.max(0, viewport.h - FLOAT_TITLEBAR_H))
        : clampNumber(current.top, 0, Math.max(0, viewport.h - height))
      const left = clampNumber(current.left, 0, Math.max(0, viewport.w - current.w))

      useEffect(() => {
        geomRef.current = null
        setGeom(null)
      }, [win.x, win.y, win.w, win.h, win.collapsed, viewport.w, viewport.h])

      const applyGeom = (next) => {
        geomRef.current = next
        setGeom(next)
      }
      const stopMove = (event) => event.stopPropagation()

      const onHeadPointerDown = (event) => {
        if (win.locked || event.button === 2) return
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* pointer capture is best-effort */
        }
        dragRef.current = { startX: event.clientX, startY: event.clientY, left, top }
        applyGeom({ left, top, w: current.w, h: current.h })
        event.preventDefault()
      }
      const onHeadPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        applyGeom(clampGeometry({
          left: drag.left + (event.clientX - drag.startX),
          top: drag.top + (event.clientY - drag.startY),
          w: current.w,
          h: current.h,
        }, viewport, win.collapsed))
      }
      const onHeadPointerUp = () => {
        if (dragRef.current && geomRef.current) onCommit(geomRef.current)
        dragRef.current = null
      }
      const onResizePointerDown = (event) => {
        if (win.locked || win.collapsed || event.button === 2) return
        onRaise()
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* pointer capture is best-effort */
        }
        resizeRef.current = { startX: event.clientX, startY: event.clientY, w: current.w, h: current.h }
        applyGeom({ left, top, w: current.w, h: current.h })
        event.preventDefault()
        event.stopPropagation()
      }
      const onResizePointerMove = (event) => {
        const resize = resizeRef.current
        if (!resize) return
        applyGeom(clampGeometry({
          left,
          top,
          w: resize.w + (event.clientX - resize.startX),
          h: resize.h + (event.clientY - resize.startY),
        }, viewport, false))
      }
      const onResizePointerUp = () => {
        if (resizeRef.current && geomRef.current) onCommit(geomRef.current)
        resizeRef.current = null
      }

      return h('section', {
        className: 'dshp-fw',
        ref: winRef,
        'data-locked': win.locked ? 'true' : 'false',
        'data-collapsed': win.collapsed ? 'true' : 'false',
        'data-active': active ? 'true' : 'false',
        style: { left: `${left}px`, top: `${top}px`, width: `${current.w}px`, height: `${height}px`, zIndex: 100 + Math.min(win.z || 0, 25) },
        'aria-label': t(def.labelKey),
        onPointerDown: onRaise,
      },
        h('div', {
          className: 'dshp-fw-head',
          onPointerDown: onHeadPointerDown,
          onPointerMove: onHeadPointerMove,
          onPointerUp: onHeadPointerUp,
          onPointerCancel: onHeadPointerUp,
          title: win.locked ? undefined : t('floatDragHandle'),
        },
          h('span', { className: 'dshp-fw-title' }, t(def.labelKey)),
          win.locked ? h('span', { className: 'dshp-fw-lockflag' }, t('floatLocked')) : null,
          h('button', {
            type: 'button',
            className: 'dshp-fw-btn',
            onClick: onCollapse,
            onPointerDown: stopMove,
            'aria-label': win.collapsed ? t('floatExpand') : t('floatCollapse'),
            title: win.collapsed ? t('floatExpand') : t('floatCollapse'),
          }, h('svg', { viewBox: '0 0 20 20', width: 14, height: 14, 'aria-hidden': true },
            h('path', {
              d: win.collapsed ? 'M5 7.5l5 5 5-5' : 'M5 12.5l5-5 5 5',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.6,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            }))),
          h('button', {
            type: 'button',
            className: 'dshp-fw-btn',
            onClick: onLock,
            onPointerDown: stopMove,
            'data-active': win.locked ? 'true' : 'false',
            'aria-label': win.locked ? t('floatUnlock') : t('floatLock'),
            title: win.locked ? t('floatUnlock') : t('floatLock'),
          }, h('svg', { viewBox: '0 0 20 20', width: 14, height: 14, 'aria-hidden': true },
            h('rect', { x: 5.5, y: 9, width: 9, height: 6.5, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 }),
            win.locked
              ? h('path', { d: 'M7.5 9V7.2a2.5 2.5 0 015 0V9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4 })
              : h('path', { d: 'M7.5 9V7.2a2.5 2.5 0 014.8-1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round' }))),
          h('button', {
            type: 'button',
            className: 'dshp-fw-btn',
            onClick: onRaise,
            onPointerDown: stopMove,
            'aria-label': t('floatRaise'),
            title: t('floatRaise'),
          }, h('svg', { viewBox: '0 0 20 20', width: 14, height: 14, 'aria-hidden': true },
            h('path', { d: 'M10 15V5M6 9l4-4 4 4', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' }))),
          h('button', {
            type: 'button',
            className: 'dshp-fw-btn',
            onClick: onClose,
            onPointerDown: stopMove,
            disabled: win.locked,
            'aria-label': win.locked ? t('floatLockedClose') : t('floatClose'),
            title: win.locked ? t('floatLockedClose') : t('floatClose'),
          }, h('svg', { viewBox: '0 0 20 20', width: 14, height: 14, 'aria-hidden': true },
            h('path', { d: 'M6 6l8 8M14 6l-8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }))),
        ),
        win.collapsed ? null : h('div', { className: 'dshp-fw-body' + (def.id === 'quota' ? ' dshp-fw-body--flush' : '') },
          h(FloatWindowContent, { id: def.id, rpc, t, enabled: true }),
        ),
        win.collapsed ? null : h('div', {
          className: 'dshp-fw-resize',
          'aria-hidden': true,
          title: t('floatResize'),
          onPointerDown: onResizePointerDown,
          onPointerMove: onResizePointerMove,
          onPointerUp: onResizePointerUp,
          onPointerCancel: onResizePointerUp,
        }),
      )
    }

    function FloatingLayer({ store, rpc, t }) {
      const floating = useFloatingStore(store)
      const state = floating.state
      const [viewport, setViewport] = useState(() => ({
        w: typeof window !== 'undefined' && Number.isFinite(window.innerWidth) ? window.innerWidth : 1280,
        h: typeof window !== 'undefined' && Number.isFinite(window.innerHeight) ? window.innerHeight : 800,
      }))
      const [expanded, setExpanded] = useState(false)
      const [fabGeom, setFabGeom] = useState(null)
      const fabRef = useRef(null)
      const fabDragRef = useRef(null)
      const fabMovedRef = useRef(false)

      useEffect(() => {
        store.load()
        const onResize = () => setViewport({
          w: typeof window.innerWidth === 'number' ? window.innerWidth : 1280,
          h: typeof window.innerHeight === 'number' ? window.innerHeight : 800,
        })
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [store])

      useEffect(() => {
        if (!expanded) return undefined
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setExpanded(false)
        }
        document.addEventListener('keydown', onKeyDown)
        return () => document.removeEventListener('keydown', onKeyDown)
      }, [expanded])

      if (!state) {
        return h('div', { className: 'dshp-float-layer' },
          h('style', null, CSS),
          floating.loading ? null : h('div', { className: 'dshp-sr' }, floating.error || t('floatUnavailable')),
        )
      }

      const fabBase = {
        left: clampNumber((state.fab?.x ?? 0.94) * viewport.w - FAB_SIZE / 2, 4, Math.max(4, viewport.w - FAB_SIZE - 4)),
        top: clampNumber((state.fab?.y ?? 0.6) * viewport.h - FAB_SIZE / 2, 4, Math.max(4, viewport.h - FAB_SIZE - 4)),
      }
      const fab = fabGeom || fabBase
      const satellites = FLOAT_WINDOWS.filter((def) => state.satellites ? state.satellites[def.id] !== false : true)
      const positions = ringLayout(fab, satellites.length, viewport)
      const openWindows = FLOAT_WINDOWS.filter((def) => state.windows && state.windows[def.id] && state.windows[def.id].open)
      const topZ = openWindows.reduce((max, def) => Math.max(max, state.windows[def.id].z || 0), 0)

      const onFabPointerDown = (event) => {
        fabMovedRef.current = false
        if (state.fabLocked) return
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          /* best-effort capture */
        }
        fabDragRef.current = { startX: event.clientX, startY: event.clientY, left: fab.left, top: fab.top }
        setFabGeom(fab)
        event.preventDefault()
      }
      const onFabPointerMove = (event) => {
        const drag = fabDragRef.current
        if (!drag) return
        const dx = event.clientX - drag.startX
        const dy = event.clientY - drag.startY
        if (Math.abs(dx) + Math.abs(dy) > 4) fabMovedRef.current = true
        setFabGeom({
          left: clampNumber(drag.left + dx, 4, Math.max(4, viewport.w - FAB_SIZE - 4)),
          top: clampNumber(drag.top + dy, 4, Math.max(4, viewport.h - FAB_SIZE - 4)),
        })
      }
      const onFabPointerUp = () => {
        const drag = fabDragRef.current
        fabDragRef.current = null
        if (drag && fabMovedRef.current && fabGeom) store.moveFab(fabGeom, viewport)
        setFabGeom(null)
        if (!fabMovedRef.current) setExpanded((value) => !value)
      }

      const toggleWindow = (id) => store.toggleWindow(id)
      const onCommit = (id) => (geom) => store.commitGeometry(id, geom, viewport)
      const toggleLock = (id) => {
        const win = state.windows[id]
        if (!win) return
        store.patchWindow(id, { locked: !win.locked })
      }
      const toggleCollapsed = (id) => {
        const win = state.windows[id]
        if (!win) return
        store.patchWindow(id, { collapsed: !win.collapsed })
      }

      return h('div', { className: 'dshp-float-layer' },
        h('style', null, CSS),
        state.enabled === false ? null : h(React.Fragment, null,
          h('div', { className: 'dshp-fab-wrap', style: { left: `${fab.left}px`, top: `${fab.top}px` } },
            h('button', {
              type: 'button',
              ref: fabRef,
              className: 'dshp-fab',
              'data-locked': state.fabLocked ? 'true' : 'false',
              'data-open': expanded ? 'true' : 'false',
              'aria-label': t('floatFabLabel'),
              title: `${t('floatFabLabel')} · ${t('floatMenu')}`,
              onPointerDown: onFabPointerDown,
              onPointerMove: onFabPointerMove,
              onPointerUp: onFabPointerUp,
              onPointerCancel: onFabPointerUp,
            },
              h('span', { className: 'dshp-sr' }, t('floatFabLabel')),
              h(FloatIcon, { kind: 'monitor', size: 22 }),
            ),
            h('button', {
              type: 'button',
              className: 'dshp-fab-lock',
              'data-locked': state.fabLocked ? 'true' : 'false',
              'aria-label': state.fabLocked ? t('floatUnlock') : t('floatLock'),
              title: state.fabLocked ? t('floatUnlock') : t('floatLock'),
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.stopPropagation()
                store.setFabLocked(!state.fabLocked)
              },
            },
              h('span', { className: 'dshp-sr' }, state.fabLocked ? t('floatUnlock') : t('floatLock')),
              h('svg', { viewBox: '0 0 20 20', width: 11, height: 11, 'aria-hidden': true },
                h('rect', { x: 5.5, y: 9, width: 9, height: 6.5, rx: 1.5, fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 }),
                state.fabLocked
                  ? h('path', { d: 'M7.5 9V7.2a2.5 2.5 0 015 0V9', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6 })
                  : h('path', { d: 'M7.5 9V7.2a2.5 2.5 0 014.8-1', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' })),
            ),
            h('button', {
              type: 'button',
              className: 'dshp-fab-close',
              'aria-label': t('floatHideFab'),
              title: t('floatHideFab'),
              onPointerDown: (event) => event.stopPropagation(),
              onClick: (event) => {
                event.stopPropagation()
                store.setEnabled(false)
              },
            },
              h('span', { className: 'dshp-sr' }, t('floatHideFab')),
              h('svg', { viewBox: '0 0 20 20', width: 11, height: 11, 'aria-hidden': true },
                h('path', { d: 'M6 6l8 8M14 6l-8 8', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' })),
            ),
          ),
          expanded ? satellites.map((def, index) => {
            const win = state.windows && state.windows[def.id]
            const position = positions[index] || fab
            return h('button', {
              key: def.id,
              type: 'button',
              className: 'dshp-sat',
              'data-active': win && win.open ? 'true' : 'false',
              'aria-label': t(def.labelKey),
              title: `${t(def.labelKey)} · ${win && win.open ? t('floatOpen') : t('floatClosed')}`,
              style: { left: `${position.left}px`, top: `${position.top}px` },
              onClick: () => toggleWindow(def.id),
            },
              h('span', { className: 'dshp-sr' }, t(def.labelKey)),
              h(FloatIcon, { kind: def.icon, size: 17 }),
              win && win.open ? h('span', { className: 'dshp-sat-dot' }) : null,
            )
          }) : null,
        ),
        openWindows.map((def) => {
          const win = state.windows[def.id]
          return h(FloatingWindow, {
            key: def.id,
            def,
            win,
            viewport,
            t,
            rpc,
            active: (win.z || 0) === topZ,
            onClose: () => toggleWindow(def.id),
            onRaise: () => store.raiseWindow(def.id),
            onLock: () => toggleLock(def.id),
            onCollapse: () => toggleCollapsed(def.id),
            onCommit: onCommit(def.id),
          })
        }),
      )
    }

    function FloatingSettings({ store, t }) {
      const floating = useFloatingStore(store)
      const state = floating.state
      useEffect(() => {
        store.load()
      }, [store])
      return h('div', { className: 'dshp-set' },
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('floatSettingsTitle')),
          h('p', null, t('floatSettingsHint')),
        ),
        floating.error ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, floating.error) : null,
        h('div', { className: 'dshp-set-card' },
          h('h3', null, t('floatSettingsTitle')),
          !state
            ? h('div', { className: 'dshp-set-hint' }, floating.loading ? t('floatLoading') : t('floatUnavailable'))
            : h(React.Fragment, null,
              h('label', { className: 'dshp-set-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: state.enabled !== false,
                  onChange: (event) => store.setEnabled(event.target.checked),
                }),
                t('floatEnabled'),
              ),
              h('label', { className: 'dshp-set-switch' },
                h('input', {
                  type: 'checkbox',
                  checked: state.fabLocked === true,
                  onChange: (event) => store.setFabLocked(event.target.checked),
                }),
                t('floatFabLock'),
              ),
              h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, t('floatSatellites')),
              h('div', { className: 'dshp-set-checkgrid' },
                FLOAT_WINDOWS.map((def) => h('label', { key: def.id, className: 'dshp-set-switch' },
                  h('input', {
                    type: 'checkbox',
                    checked: !state.satellites || state.satellites[def.id] !== false,
                    onChange: (event) => store.setSatellite(def.id, event.target.checked),
                  }),
                  t(def.labelKey),
                )),
              ),
              h('div', { className: 'dshp-set-actions' },
                h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  onClick: () => store.reset(),
                }, t('floatResetAction')),
                h('span', { className: 'dshp-set-hint' }, t('floatResetHint')),
              ),
            ),
        ),
      )
    }

    /** Collapsible subsection inside an existing settings card (default collapsed). */
    function SetSection({ title, hint, defaultOpen = false, children }) {
      const [open, setOpen] = useState(defaultOpen === true)
      return h('div', { className: 'dshp-set-flat' },
        h('button', {
          type: 'button',
          className: 'dshp-set-card-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h('span', null, title),
          h('span', { className: 'dshp-set-card-chevron', 'data-open': open ? 'true' : 'false' }, '▸'),
        ),
        hint ? h('p', { className: 'dshp-set-hint', style: { marginTop: '4px' } }, hint) : null,
        open ? h('div', { className: 'dshp-set-card-body' }, children) : null,
      )
    }

    /** Whole collapsible settings card (default collapsed). */
    function CollapsibleCard({ title, hint, defaultOpen = false, children }) {
      const [open, setOpen] = useState(defaultOpen === true)
      return h('div', { className: 'dshp-set-card' },
        h('button', {
          type: 'button',
          className: 'dshp-set-card-head',
          'aria-expanded': open,
          onClick: () => setOpen((value) => !value),
        },
          h('h3', null, title),
          h('span', { className: 'dshp-set-card-chevron', 'data-open': open ? 'true' : 'false' }, '▸'),
        ),
        hint ? h('p', { className: 'dshp-set-hint' , style: { marginTop: '4px' } }, hint) : null,
        open ? h('div', { className: 'dshp-set-card-body' }, children) : null,
      )
    }

    /** DSH-styled select-like popover (no native select). */
    function PickMenu({ value, options, placeholder, onSelect, disabled = false, t }) {
      const [open, setOpen] = useState(false)
      const ref = useRef(null)
      useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (ref.current && !ref.current.contains(event.target)) setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])
      const current = options.find((option) => option.value === value)
      return h('div', { className: 'dshp-popmenu-wrap', ref },
        h('button', {
          type: 'button',
          className: 'dshp-popmenu-btn',
          disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          onClick: () => setOpen((value_) => !value_),
        },
          h('span', null, current ? current.label : (placeholder || t?.('netDirect') || '—')),
          h('span', { className: 'dshp-set-card-chevron', 'data-open': open ? 'true' : 'false' }, '▾'),
        ),
        open ? h('div', { className: 'dshp-popmenu', role: 'listbox' },
          options.length === 0
            ? h('div', { className: 'dshp-set-hint', style: { padding: '6px 8px' } }, t?.('netProxyIdle') || '—')
            : options.map((option) => h('button', {
              key: option.value,
              type: 'button',
              role: 'option',
              'aria-selected': option.value === value,
              className: 'dshp-popmenu-item',
              onClick: () => {
                setOpen(false)
                onSelect(option.value)
              },
            }, option.label)),
        ) : null,
      )
    }

    // ------------------------------------------------------------------
    // dshp-workflow (engine settings, global library and run history)
    // ------------------------------------------------------------------

    const WF_CHANNEL = '/dshp-workflow'

    /** Front-end defaults mirroring the dshp-workflow Config defaults. */
    const WF_SETTINGS_DEFAULTS = {
      enabled: true,
      toolName: 'workflow_plus',
      autoTrigger: 'suggest',
      subagentProvider: 'spawn',
      childPreset: '',
      maxConcurrentAgents: 4,
      maxAgentsPerRun: 64,
      maxItemsPerCall: 128,
      maxRunSeconds: 1800,
      maxWorldRuns: 32,
      maxReportItems: 64,
      allowObserve: true,
      allowExecute: false,
      allowAdHocExecute: false,
      allowAdHocScripts: false,
      executeAllowlist: [],
      allowedCommands: [],
      blockedCommands: [],
      sandboxMode: 'workspace-write',
      runRetentionDays: 30,
      maxSavedWorkflows: 100,
    }

    const WF_AUTO_TRIGGER_OPTIONS = ['off', 'suggest', 'auto']
    const WF_SANDBOX_OPTIONS = ['workspace-write', 'read-only', 'danger-full-access']

    /** Split a comma-separated list field into trimmed non-empty strings. */
    function wfSplitList(value) {
      const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : []
      const result = []
      for (const entry of list) {
        if (typeof entry !== 'string') continue
        const trimmed = entry.trim()
        if (trimmed.length > 0 && !result.includes(trimmed)) result.push(trimmed)
      }
      return result
    }

    /** Coerce the Host settings value object into safe UI values. */
    function wfSettingsValue(value) {
      const source = isRecord(value) ? value : {}
      const next = {}
      for (const [key, fallback] of Object.entries(WF_SETTINGS_DEFAULTS)) {
        const raw = source[key]
        if (Array.isArray(fallback)) {
          next[key] = Array.isArray(raw) ? wfSplitList(raw) : fallback.slice()
        } else if (typeof fallback === 'boolean') {
          next[key] = typeof raw === 'boolean' ? raw : fallback
        } else if (typeof fallback === 'number') {
          const numeric = typeof raw === 'number' ? raw : (typeof raw === 'string' && raw.trim().length > 0 ? Number(raw) : NaN)
          next[key] = Number.isFinite(numeric) ? numeric : fallback
        } else {
          next[key] = typeof raw === 'string' ? raw : fallback
        }
      }
      // Keep unknown future values visible instead of silently rewriting them.
      if (typeof source.sandboxMode === 'string' && source.sandboxMode.length > 0) next.sandboxMode = source.sandboxMode
      if (typeof source.autoTrigger === 'string' && source.autoTrigger.length > 0) next.autoTrigger = source.autoTrigger
      return next
    }

    /**
     * Normalise a Host settings document: `{ available, revision, value }` (the
     * `settings`/`settings-write` return shape), possibly wrapped under
     * `settings`, or the plain value object that `snapshot` returns.
     */
    function wfSettingsDocument(payload, fallbackRevision) {
      const source = isRecord(payload) ? payload : {}
      const candidate = isRecord(source.settings) ? source.settings : source
      const revisionOf = (entry) => (isRecord(entry) && typeof entry.revision === 'number' && Number.isFinite(entry.revision) ? entry.revision : undefined)
      if (isRecord(candidate) && typeof candidate.available === 'boolean') {
        const revision = revisionOf(candidate)
        return {
          available: candidate.available,
          ns: typeof candidate.ns === 'string' ? candidate.ns : 'dshp-workflow',
          revision: typeof revision === 'number' ? revision : (typeof fallbackRevision === 'number' ? fallbackRevision : undefined),
          value: isRecord(candidate.value) ? candidate.value : {},
        }
      }
      return {
        available: true,
        ns: 'dshp-workflow',
        revision: typeof fallbackRevision === 'number' ? fallbackRevision : undefined,
        value: isRecord(candidate) ? candidate : {},
      }
    }

    /** Normalise the `snapshot` payload into settings doc + lists. */
    /** Provider choices reported by the Host's live subagent registry. */
    function wfProviderRows(value) {
      if (!Array.isArray(value)) return []
      return value.filter(isRecord).map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `provider-${index}`,
        inheritsParentContext: entry.inheritsParentContext === true,
        capabilities: isRecord(entry.capabilities) ? entry.capabilities : {},
      }))
    }

    /** Preset choices reported by the Host's live Agent preset registry. */
    function wfPresetRows(value) {
      if (!Array.isArray(value)) return []
      return value.filter(isRecord).map((entry, index) => ({
        id: typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `preset-${index}`,
        name: typeof entry.name === 'string' ? entry.name : '',
        description: typeof entry.description === 'string' ? entry.description : '',
        broken: typeof entry.broken === 'string' ? entry.broken : '',
      }))
    }

    /** Plain-language label for one workflow capability chip. */
    function wfCapabilityLabel(capability, t) {
      const keys = {
        orchestrate: 'wfCapabilityOrchestrate',
        observe: 'wfCapabilityObserve',
        execute: 'wfCapabilityExecute',
      }
      const key = keys[capability]
      return key && typeof t === 'function' ? t(key) : capability
    }

    function wfSnapshotModel(payload) {
      const source = isRecord(payload) ? payload : {}
      const snapshot = isRecord(source.snapshot) ? source.snapshot : source
      const revision = typeof snapshot.revision === 'number' && Number.isFinite(snapshot.revision) ? snapshot.revision : undefined
      const looksLikeSettingsDocument = isRecord(snapshot.value) && (typeof snapshot.available === 'boolean' || typeof snapshot.revision === 'number')
      const hasSettings = snapshot.settings !== undefined || typeof snapshot.available === 'boolean' || looksLikeSettingsDocument
      return {
        settings: hasSettings
          ? wfSettingsDocument(snapshot.settings !== undefined ? snapshot.settings : snapshot, revision)
          : { available: false, ns: 'dshp-workflow', revision, value: {} },
        workflows: Array.isArray(snapshot.workflows) ? snapshot.workflows : undefined,
        runs: Array.isArray(snapshot.runs) ? snapshot.runs : undefined,
        activeRuns: Array.isArray(snapshot.activeRuns) ? snapshot.activeRuns.filter((entry) => typeof entry === 'string') : [],
        providers: Array.isArray(snapshot.providers) ? wfProviderRows(snapshot.providers) : undefined,
        presets: Array.isArray(snapshot.presets) ? wfPresetRows(snapshot.presets) : undefined,
      }
    }

    /** Global library cards; the RPC list may be a bare array or `{ workflows }`. */
    function wfWorkflowCards(value) {
      const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.workflows) ? value.workflows : []
      return list.filter(isRecord).map((entry, index) => {
        const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `workflow-${index}`
        const capabilities = Array.isArray(entry.capabilities) ? entry.capabilities.filter((item) => typeof item === 'string') : []
        return {
          id,
          scope: entry.scope === 'project' ? 'project' : 'global',
          name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
          description: typeof entry.description === 'string' ? entry.description : '',
          capabilities: capabilities.length > 0 ? capabilities : ['orchestrate'],
          updatedAt: typeof entry.updatedAt === 'number' ? entry.updatedAt : undefined,
          bytes: typeof entry.bytes === 'number' ? entry.bytes : undefined,
        }
      })
    }

    function wfFormatDuration(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return '—'
      if (ms < 1000) return `${Math.round(ms)} ms`
      const seconds = ms / 1000
      if (seconds < 60) {
        const rounded = seconds >= 10 ? Math.round(seconds) : Math.round(seconds * 10) / 10
        return `${rounded} s`
      }
      const total = Math.round(seconds)
      const minutes = Math.floor(total / 60)
      if (minutes < 60) return `${minutes}m ${total % 60}s`
      return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
    }

    const WF_STATUS_LABEL_KEYS = {
      queued: 'wfStatusQueued',
      running: 'wfStatusRunning',
      completed: 'wfStatusCompleted',
      cancelled: 'wfStatusCancelled',
      error: 'wfStatusError',
    }

    function wfStatusLabel(status, t) {
      return t(WF_STATUS_LABEL_KEYS[status] || 'wfStatusUnknown')
    }

    function wfStatusKind(status) {
      if (status === 'completed') return 'ok'
      if (status === 'error') return 'error'
      if (status === 'running' || status === 'queued') return 'warn'
      return 'idle'
    }

    /** Run summaries, newest first; accepts a bare array or `{ runs }`. */
    function wfRunRows(value, activeRuns) {
      const list = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.runs) ? value.runs : []
      const active = new Set(Array.isArray(activeRuns) ? activeRuns : [])
      return list.filter(isRecord).map((entry, index) => {
        const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `run-${index}`
        const status = typeof entry.status === 'string' ? entry.status : 'unknown'
        const startedAt = typeof entry.startedAt === 'number' ? entry.startedAt : undefined
        const endedAt = typeof entry.endedAt === 'number' ? entry.endedAt : undefined
        const durationMs = typeof entry.durationMs === 'number'
          ? entry.durationMs
          : startedAt !== undefined && endedAt !== undefined
            ? Math.max(0, endedAt - startedAt)
            : undefined
        return {
          id,
          workflowId: typeof entry.workflowId === 'string' ? entry.workflowId : '',
          name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : (typeof entry.workflowId === 'string' && entry.workflowId.length > 0 ? entry.workflowId : id),
          status,
          startedAt,
          endedAt,
          durationMs,
          agentsStarted: typeof entry.agentsStarted === 'number' ? entry.agentsStarted : undefined,
          active: active.has(id) || status === 'running' || status === 'queued',
        }
      }).sort((left, right) => (right.startedAt ?? 0) - (left.startedAt ?? 0))
    }

    function wfTextLine(entry) {
      if (typeof entry === 'string') return entry
      if (isRecord(entry)) {
        if (typeof entry.message === 'string') return entry.message
        if (typeof entry.text === 'string') return entry.text
        if (typeof entry.title === 'string') return entry.title
      }
      try {
        return JSON.stringify(entry)
      } catch {
        return String(entry)
      }
    }

    function wfTextRows(list, limit) {
      const rows = (Array.isArray(list) ? list : []).map(wfTextLine).filter((line) => typeof line === 'string' && line.length > 0)
      return limit !== undefined ? rows.slice(0, limit) : rows
    }

    function wfReportRows(list) {
      const reports = Array.isArray(list) ? list : []
      return reports.slice(0, 5).map((entry, index) => {
        let preview = ''
        try {
          preview = JSON.stringify(entry)
        } catch {
          preview = String(entry)
        }
        return { id: `report-${index}`, preview: preview.length > 240 ? `${preview.slice(0, 240)}…` : preview }
      })
    }

    function wfAgentRows(list) {
      return (Array.isArray(list) ? list : []).filter(isRecord).map((entry, index) => ({
        id: typeof entry.childId === 'string' ? entry.childId : typeof entry.id === 'string' ? entry.id : `agent-${index}`,
        label: typeof entry.label === 'string' && entry.label.length > 0 ? entry.label : `agent-${index + 1}`,
        status: typeof entry.status === 'string' ? entry.status : '',
        cached: entry.cached === true,
        provider: typeof entry.provider === 'string' ? entry.provider : '',
        model: typeof entry.model === 'string' ? entry.model : '',
      }))
    }

    function wfArtifactRows(list) {
      return (Array.isArray(list) ? list : []).filter(isRecord).map((entry, index) => {
        const id = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : `artifact-${index}`
        return {
          id,
          name: typeof entry.name === 'string' && entry.name.length > 0 ? entry.name : id,
          kind: typeof entry.kind === 'string' && entry.kind.length > 0 ? entry.kind : 'markdown',
        }
      })
    }

    function wfErrorText(error) {
      if (typeof error === 'string') return error
      if (!isRecord(error)) return ''
      const code = typeof error.code === 'string' ? error.code : ''
      const message = typeof error.message === 'string' ? error.message : ''
      if (code.length > 0 && message.length > 0) return `${code}: ${message}`
      return message.length > 0 ? message : code
    }

    /** Run detail model; accepts the `run-read` payload (or the run itself). */
    function wfRunDetailModel(value) {
      const run = isRecord(value) && isRecord(value.run) ? value.run : value
      if (!isRecord(run)) return null
      const agents = wfAgentRows(run.agents)
      const startedAt = typeof run.startedAt === 'number' ? run.startedAt : undefined
      const endedAt = typeof run.endedAt === 'number' ? run.endedAt : undefined
      const running = run.status === 'running' || run.status === 'queued'
      const durationMs = typeof run.durationMs === 'number'
        ? run.durationMs
        : startedAt !== undefined && endedAt !== undefined
          ? Math.max(0, endedAt - startedAt)
          : startedAt !== undefined && running
            ? Math.max(0, Date.now() - startedAt)
            : undefined
      return {
        id: typeof run.id === 'string' ? run.id : '',
        workflowId: typeof run.workflowId === 'string' ? run.workflowId : '',
        name: typeof run.name === 'string' && run.name.length > 0 ? run.name : (typeof run.workflowId === 'string' && run.workflowId.length > 0 ? run.workflowId : 'run'),
        status: typeof run.status === 'string' ? run.status : 'unknown',
        stopReason: typeof run.stopReason === 'string' ? run.stopReason : '',
        startedAt,
        endedAt,
        durationMs,
        active: running,
        phases: wfTextRows(run.phases),
        logs: wfTextRows(run.logs, 200),
        reports: wfReportRows(run.reports),
        reportsTotal: Array.isArray(run.reports) ? run.reports.length : 0,
        artifacts: wfArtifactRows(run.artifacts),
        agents,
        agentsTotal: agents.length,
        cachedAgents: agents.filter((agent) => agent.cached).length,
        agentsStarted: typeof run.agentsStarted === 'number' ? run.agentsStarted : agents.length,
        usage: isRecord(run.usage) ? {
          agents: typeof run.usage.agents === 'number' ? run.usage.agents : undefined,
          worldRuns: typeof run.usage.worldRuns === 'number' ? run.usage.worldRuns : undefined,
          durationMs: typeof run.usage.durationMs === 'number' ? run.usage.durationMs : undefined,
        } : {},
        errorText: wfErrorText(run.error),
      }
    }

    /** Workflow document preview model from `workflow-read`. */
    function wfWorkflowView(value) {
      if (!isRecord(value)) return null
      const meta = isRecord(value.meta) ? value.meta : {}
      const document = typeof value.document === 'string' ? value.document : typeof value.text === 'string' ? value.text : ''
      const id = typeof meta.id === 'string' ? meta.id : (typeof value.id === 'string' ? value.id : '')
      return {
        id,
        name: typeof meta.name === 'string' && meta.name.length > 0 ? meta.name : id,
        description: typeof meta.description === 'string' ? meta.description : '',
        capabilities: Array.isArray(meta.capabilities) ? meta.capabilities.filter((entry) => typeof entry === 'string') : [],
        document,
        hash: typeof value.hash === 'string' ? value.hash : '',
      }
    }

    /** Artifact preview model from `artifact-read`. */
    function wfArtifactView(value) {
      const artifact = isRecord(value) && isRecord(value.artifact) ? value.artifact : value
      if (!isRecord(artifact)) return null
      let content = artifact.content
      if (typeof content !== 'string') {
        try {
          content = JSON.stringify(content, null, 2)
        } catch {
          content = String(content)
        }
      }
      return {
        id: typeof artifact.id === 'string' ? artifact.id : '',
        name: typeof artifact.name === 'string' && artifact.name.length > 0 ? artifact.name : 'artifact',
        kind: typeof artifact.kind === 'string' ? artifact.kind : 'markdown',
        content: typeof content === 'string' ? content : '',
      }
    }

    /**
     * Assemble the Workflow tab render model. Pure helper so the offline render
     * harness can build it from mocked RPC payloads.
     */
    function wfViewModel(input) {
      const source = isRecord(input) ? input : {}
      const settingsDocument = isRecord(source.settingsDocument) ? source.settingsDocument : { available: false, revision: undefined, value: {} }
      const phase = typeof source.phase === 'string'
        ? source.phase
        : settingsDocument.available === false ? 'unavailable' : 'ready'
      const activeRuns = Array.isArray(source.activeRuns) ? source.activeRuns.filter((entry) => typeof entry === 'string') : []
      // `settings` is coerced for saving; `form` keeps raw draft values so the
      // inputs can hold an intermediate empty string while the user retypes.
      const settings = wfSettingsValue(isRecord(source.draft) ? source.draft : settingsDocument.value)
      const form = isRecord(source.draft) ? { ...wfSettingsValue(settingsDocument.value), ...source.draft } : settings
      return {
        phase,
        error: typeof source.error === 'string' ? source.error : '',
        settings,
        form,
        revision: typeof settingsDocument.revision === 'number' ? settingsDocument.revision : (typeof source.revision === 'number' ? source.revision : undefined),
        busy: source.busy === true,
        message: isRecord(source.message) && typeof source.message.text === 'string' ? source.message : null,
        workflows: wfWorkflowCards(source.workflows),
        workflowView: wfWorkflowView(source.workflowView),
        selectedRunId: typeof source.selectedRunId === 'string' ? source.selectedRunId : '',
        runs: wfRunRows(source.runs, activeRuns),
        activeRuns,
        run: wfRunDetailModel(source.runDetail),
        runLoading: source.runLoading === true,
        runError: typeof source.runError === 'string' ? source.runError : '',
        artifact: wfArtifactView(source.artifact),
        artifactLoading: source.artifactLoading === true,
        pendingDelete: typeof source.pendingDelete === 'string' ? source.pendingDelete : '',
        providers: wfProviderRows(source.providers ?? settingsDocument.providers),
        presets: wfPresetRows(source.presets ?? settingsDocument.presets),
      }
    }

    /**
     * Call one `/dshp-workflow` endpoint and normalise the reply. The
     * authenticated Connection RPC adds its own `{ ok, value }` envelope; the
     * Host handler may return the payload directly, wrap it in
     * `{ ok: true, ...payload }`, or use `{ ok: true, value: payload }`.
     * All three shapes are unwrapped so a Host-side transport change cannot
     * blank the tab.
     */
    async function wfInvoke(rpc, endpoint, payload) {
      if (!rpc || typeof rpc.call !== 'function') {
        return { ok: false, error: { code: 'rpc-unavailable', message: 'RPC unavailable' } }
      }
      let envelope
      try {
        envelope = await rpc.call(WF_CHANNEL, endpoint, payload || {})
      } catch (reason) {
        return { ok: false, error: { code: 'rpc-error', message: reason instanceof Error ? reason.message : String(reason) } }
      }
      if (!envelope || envelope.ok !== true) {
        const error = isRecord(envelope) && isRecord(envelope.error) ? envelope.error : { code: 'rpc-error', message: 'RPC call failed' }
        return { ok: false, error }
      }
      let value = envelope.value
      for (let depth = 0; depth < 3; depth += 1) {
        if (!isRecord(value)) break
        if (value.ok === false) {
          const error = isRecord(value.error) ? value.error : { code: 'rpc-error', message: typeof value.error === 'string' ? value.error : 'RPC call failed' }
          return { ok: false, error }
        }
        const keys = Object.keys(value)
        if (value.ok === true && keys.length <= 2 && isRecord(value.value)) {
          value = value.value
          continue
        }
        if (value.ok === true) {
          const next = { ...value }
          delete next.ok
          value = next
          break
        }
        // Bare `{ value: payload }` wrapper (no `ok` marker).
        if (value.ok === undefined && keys.length === 1 && isRecord(value.value)) {
          value = value.value
          continue
        }
        break
      }
      return { ok: true, value: isRecord(value) ? value : {} }
    }

    function WorkflowTabView({ t, model, actions }) {
      const act = isRecord(actions) ? actions : {}
      const settings = isRecord(model.form) ? model.form : model.settings
      const setField = (key, value) => {
        if (typeof act.setField === 'function') act.setField(key, value)
      }
      const textField = (key, label, placeholder, tip) => h(SettingsField, { label, tip },
        h('input', {
          type: 'text',
          value: settings[key],
          placeholder,
          spellCheck: false,
          onChange: (event) => setField(key, event.target.value),
        }))
      const numberField = (key, label, min, max, tip) => h(SettingsField, { label, tip },
        h('input', {
          type: 'number',
          min,
          max,
          step: 1,
          value: settings[key],
          onChange: (event) => setField(key, event.target.value),
        }))
      const listField = (key, label, placeholder, tip) => h(SettingsField, { label, tip },
        h('input', {
          type: 'text',
          value: Array.isArray(settings[key]) ? settings[key].join(', ') : '',
          placeholder,
          spellCheck: false,
          onChange: (event) => setField(key, wfSplitList(event.target.value)),
        }))
      const switchField = (key, label, tip) => h('label', { className: 'dshp-set-switch', title: tip || undefined },
        h('input', { type: 'checkbox', checked: settings[key] === true, onChange: (event) => setField(key, event.target.checked) }),
        label,
        tip ? h(WfTip, { text: tip }) : null)

      const providerLabel = (id) => {
        const keys = {
          spawn: 'wfProviderSpawn',
          fork: 'wfProviderFork',
          acp: 'wfProviderAcp',
          codex: 'wfProviderCodex',
          'claude-code': 'wfProviderClaudeCode',
        }
        return keys[id] ? t(keys[id]) : id
      }
      const providerRows = Array.isArray(model.providers) ? model.providers : []
      const providerOptions = providerRows.map((entry) => ({ value: entry.id, label: providerLabel(entry.id) }))
      if (typeof settings.subagentProvider === 'string' && settings.subagentProvider.length > 0
        && !providerOptions.some((option) => option.value === settings.subagentProvider)) {
        providerOptions.push({ value: settings.subagentProvider, label: providerLabel(settings.subagentProvider) })
      }
      const presetRows = Array.isArray(model.presets) ? model.presets : []
      const presetKeys = {
        standard: 'wfPresetStandard',
        ptc: 'wfPresetPtc',
        minimal: 'wfPresetMinimal',
        cordis: 'wfPresetCordis',
      }
      const presetLabel = (preset) => {
        const known = presetKeys[preset.id] ? t(presetKeys[preset.id]) : ''
        const display = preset.name.length > 0 ? preset.name : known
        if (display.length === 0) return preset.id
        return display === preset.id ? display : `${display}（${preset.id}）`
      }
      const presetOptions = [{ value: '', label: t('wfPresetInherit') }]
      for (const preset of presetRows) {
        const suffix = preset.broken.length > 0 ? ` — ${t('wfPresetBroken')}` : ''
        presetOptions.push({ value: preset.id, label: `${presetLabel(preset)}${suffix}` })
      }
      if (typeof settings.childPreset === 'string' && settings.childPreset.length > 0
        && !presetOptions.some((option) => option.value === settings.childPreset)) {
        presetOptions.push({ value: settings.childPreset, label: settings.childPreset })
      }
      const selectedProvider = providerRows.find((entry) => entry.id === settings.subagentProvider)
      const providerCaps = isRecord(selectedProvider?.capabilities) ? selectedProvider.capabilities : null
      const providerCapsOk = providerCaps !== null
        && providerCaps.outputSchema === true
        && providerCaps.agentPreset === true
        && providerCaps.agentOptions === true
        && providerCaps.depthLimit === true
      const providerWarning = selectedProvider !== undefined && providerCaps !== null && !providerCapsOk
        ? t('wfProviderCapsPartial')
        : null

      const sourceNote = h('div', { className: 'dshp-wf-source' },
        h('div', { className: 'dshp-wf-source-title' }, t('wfSourceTitle')),
        h('p', { className: 'dshp-wf-source-text' }, t('wfSourceText')),
      )

      const engineCard = h(CollapsibleCard, { title: t('wfEngineTitle'), hint: t('wfEngineHint'), defaultOpen: true },
        switchField('enabled', t('wfEnabled'), t('wfTipEnabled')),
        h('div', { className: 'dshp-set-grid', style: { marginTop: '10px' } },
          textField('toolName', t('wfToolName'), 'workflow_plus', t('wfTipToolName')),
          h(SettingsField, { label: t('wfAutoTrigger'), tip: t('wfTipAutoTrigger') },
            h(PickMenu, {
              value: settings.autoTrigger,
              options: WF_AUTO_TRIGGER_OPTIONS.map((option) => ({
                value: option,
                label: option === 'off' ? t('wfAutoTriggerOff') : option === 'suggest' ? t('wfAutoTriggerSuggest') : t('wfAutoTriggerAuto'),
              })),
              onSelect: (value) => setField('autoTrigger', value),
              t,
            }),
          ),
          h(SettingsField, { label: t('wfSubagentProvider'), tip: t('wfTipSubagentProvider') },
            providerRows.length > 0
              ? h(PickMenu, {
                value: settings.subagentProvider,
                options: providerOptions,
                onSelect: (value) => setField('subagentProvider', value),
                t,
              })
              : h('input', {
                type: 'text',
                value: settings.subagentProvider,
                placeholder: 'spawn',
                spellCheck: false,
                onChange: (event) => setField('subagentProvider', event.target.value),
              }),
          ),
          h(SettingsField, { label: t('wfChildPreset'), tip: t('wfTipChildPreset') },
            presetRows.length > 0
              ? h(PickMenu, {
                value: settings.childPreset,
                options: presetOptions,
                onSelect: (value) => setField('childPreset', value),
                t,
              })
              : h('input', {
                type: 'text',
                value: settings.childPreset,
                placeholder: t('wfPresetInherit'),
                spellCheck: false,
                onChange: (event) => setField('childPreset', event.target.value),
              }),
          ),
        ),
        h('p', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, t('wfEngineDefaultsHint')),
        providerWarning ? h('p', { className: 'dshp-warn dshp-wf-warn' }, providerWarning) : null,
      )

      const limitsCard = h(CollapsibleCard, { title: t('wfLimitsTitle'), hint: t('wfLimitsHint'), defaultOpen: true },
        h('div', { className: 'dshp-set-grid' },
          numberField('maxConcurrentAgents', t('wfMaxConcurrentAgents'), 1, 64, t('wfTipMaxConcurrentAgents')),
          numberField('maxAgentsPerRun', t('wfMaxAgentsPerRun'), 1, 512, t('wfTipMaxAgentsPerRun')),
          numberField('maxItemsPerCall', t('wfMaxItemsPerCall'), 1, 2048, t('wfTipMaxItemsPerCall')),
          numberField('maxRunSeconds', t('wfMaxRunSeconds'), 30, 21600, t('wfTipMaxRunSeconds')),
          numberField('maxWorldRuns', t('wfMaxWorldRuns'), 0, 512, t('wfTipMaxWorldRuns')),
          numberField('maxReportItems', t('wfMaxReportItems'), 0, 1024, t('wfTipMaxReportItems')),
          numberField('runRetentionDays', t('wfRunRetentionDays'), 1, 3650, t('wfTipRunRetentionDays')),
          numberField('maxSavedWorkflows', t('wfMaxSavedWorkflows'), 1, 2000, t('wfTipMaxSavedWorkflows')),
        ),
      )

      const safetyCard = h(CollapsibleCard, { title: t('wfSafetyTitle'), hint: t('wfSafetyHint'), defaultOpen: true },
        h('div', { className: 'dshp-set-checkgrid' },
          switchField('allowObserve', t('wfAllowObserve'), t('wfTipAllowObserve')),
          switchField('allowExecute', t('wfAllowExecute'), t('wfTipAllowExecute')),
          switchField('allowAdHocExecute', t('wfAllowAdHocExecute'), t('wfTipAllowAdHocExecute')),
          switchField('allowAdHocScripts', t('wfAllowAdHocScripts'), t('wfTipAllowAdHocScripts')),
        ),
        h('div', { className: 'dshp-set-grid', style: { marginTop: '10px' } },
          listField('executeAllowlist', t('wfExecuteAllowlist'), 'review-changed@<sha256>', t('wfTipExecuteAllowlist')),
          listField('allowedCommands', t('wfAllowedCommands'), 'git, node', t('wfTipAllowedCommands')),
          listField('blockedCommands', t('wfBlockedCommands'), 'rm', t('wfTipBlockedCommands')),
          h(SettingsField, { label: t('wfSandboxMode'), tip: t('wfTipSandboxMode') },
            h(PickMenu, {
              value: settings.sandboxMode,
              options: WF_SANDBOX_OPTIONS.map((option) => ({
                value: option,
                label: option === 'workspace-write' ? t('wfSandboxWorkspaceWrite') : option === 'read-only' ? t('wfSandboxReadOnly') : t('wfSandboxDanger'),
              })),
              onSelect: (value) => setField('sandboxMode', value),
              t,
            }),
          ),
        ),
      )

      const actionsRow = h('div', { className: 'dshp-set-actions' },
        h('button', {
          type: 'button',
          className: 'dshp-set-primary',
          disabled: model.busy,
          onClick: () => { if (typeof act.save === 'function') act.save() },
        }, model.busy ? t('wfSaving') : t('wfSave')),
        h('button', {
          type: 'button',
          className: 'dshp-set-secondary',
          disabled: model.busy,
          onClick: () => { if (typeof act.reload === 'function') act.reload() },
        }, t('wfReload')),
        model.message
          ? h('span', { className: 'dshp-set-status', 'data-error': model.message.kind === 'error' ? 'true' : 'false' }, model.message.text)
          : null,
      )

      const shownView = model.workflowView
      const settingsBlock = h('div', { className: 'dshp-wf-settings' },
        sourceNote,
        engineCard,
        limitsCard,
        safetyCard,
        actionsRow,
      )

      const libraryCard = h(CollapsibleCard, { title: t('wfLibraryTitle'), hint: t('wfLibraryHint'), defaultOpen: true },
        h('div', { className: 'dshp-set-actions', style: { marginTop: 0 } },
          h('button', {
            type: 'button',
            className: 'dshp-set-secondary',
            disabled: model.busy,
            onClick: () => { if (typeof act.reloadLibrary === 'function') act.reloadLibrary() },
          }, t('wfLibraryReload')),
          h('span', { className: 'dshp-set-hint' }, `${model.workflows.length} ${t('wfWorkflowsCount')}`),
        ),
        model.workflows.length === 0
          ? h('div', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('wfLibraryEmpty'))
          : h('div', { className: 'dshp-wf-list' },
            model.workflows.map((card) => h('div', { key: `${card.scope}-${card.id}`, className: 'dshp-wf-item' },
              h('div', { className: 'dshp-wf-item-head' },
                h('span', { className: 'dshp-wf-name' }, card.name),
                h('span', { className: 'dshp-badge' }, t('wfScopeGlobal')),
                card.capabilities.map((capability) => h('span', { key: capability, className: 'dshp-set-chip' }, wfCapabilityLabel(capability, t))),
                card.updatedAt !== undefined ? h('span', { className: 'dshp-set-hint' }, `${t('wfUpdatedAt')} ${formatDateTime(card.updatedAt)}`) : null,
              ),
              h('div', { className: 'dshp-wf-sub dshp-mono' }, `${t('wfId')}: ${card.id}`),
              card.hash ? h('div', { className: 'dshp-wf-sub dshp-mono', title: card.hash }, `${t('wfHash')}: ${String(card.hash).slice(0, 16)}…`) : null,
              card.description.length > 0 ? h('div', { className: 'dshp-wf-sub' }, card.description) : null,
              h('div', { className: 'dshp-wf-actions', style: { marginTop: '2px' } },
                h('button', {
                  type: 'button',
                  className: 'dshp-set-secondary',
                  onClick: () => {
                    if (shownView && shownView.id === card.id) {
                      if (typeof act.hideWorkflow === 'function') act.hideWorkflow()
                    } else if (typeof act.showWorkflow === 'function') act.showWorkflow(card.id, card.scope)
                  },
                }, shownView && shownView.id === card.id ? t('wfHide') : t('wfShow')),
                model.pendingDelete === card.id
                  ? h(React.Fragment, null,
                    h('span', { className: 'dshp-warn' }, t('wfDeleteConfirm')),
                    h('button', {
                      type: 'button',
                      className: 'dshp-set-primary',
                      onClick: () => { if (typeof act.confirmDelete === 'function') act.confirmDelete(card.id, card.scope) },
                    }, t('wfDelete')),
                    h('button', {
                      type: 'button',
                      className: 'dshp-set-secondary',
                      onClick: () => { if (typeof act.cancelDelete === 'function') act.cancelDelete() },
                    }, t('wfCancel')),
                  )
                  : h('button', {
                    type: 'button',
                    className: 'dshp-set-secondary',
                    onClick: () => { if (typeof act.askDelete === 'function') act.askDelete(card.id) },
                  }, t('wfDelete')),
                card.bytes !== undefined ? h('span', { className: 'dshp-set-hint' }, `${t('wfBytes')} ${card.bytes} B`) : null,
              ),
            )),
          ),
        shownView
          ? h('div', { className: 'dshp-wf-detail' },
            h('div', { className: 'dshp-wf-item-head' },
              h('span', { className: 'dshp-wf-name' }, `${t('wfDocument')} · ${shownView.name || shownView.id}`),
              shownView.capabilities.map((capability) => h('span', { key: capability, className: 'dshp-set-chip' }, wfCapabilityLabel(capability, t))),
              h('button', {
                type: 'button',
                className: 'dshp-set-secondary',
                onClick: () => { if (typeof act.hideWorkflow === 'function') act.hideWorkflow() },
              }, t('wfClose')),
            ),
            shownView.description.length > 0 ? h('div', { className: 'dshp-wf-sub' }, shownView.description) : null,
            shownView.hash ? h('div', { className: 'dshp-wf-sub dshp-mono', title: shownView.hash }, `${t('wfHash')}: ${shownView.hash}`) : null,
            h('pre', { className: 'dshp-wf-doc' }, shownView.document.length > 0 ? shownView.document : '—'),
          )
          : null,
      )

      const usageParts = model.run ? [
        typeof model.run.usage.agents === 'number' ? `${t('wfUsageAgents')} ${model.run.usage.agents}` : '',
        typeof model.run.usage.worldRuns === 'number' ? `${t('wfUsageWorldRuns')} ${model.run.usage.worldRuns}` : '',
        typeof model.run.usage.durationMs === 'number' ? `${t('wfUsageDuration')} ${wfFormatDuration(model.run.usage.durationMs)}` : '',
      ].filter((part) => part.length > 0) : []

      const detailBlock = (() => {
        if (model.selectedRunId.length === 0) return h('div', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('wfRunSelect'))
        if (model.runLoading) return h('div', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('wfRunLoading'))
        if (model.runError.length > 0) {
          return h('div', { className: 'dshp-set-hint', style: { marginTop: '8px', color: 'var(--dsw-alias-state-error-primary)' } },
            `${t('wfRunFailed')} — ${model.runError}`)
        }
        const run = model.run
        if (!run) return h('div', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('wfRunSelect'))
        return h('div', { className: 'dshp-wf-detail' },
          h('div', { className: 'dshp-wf-item-head' },
            h('span', { className: 'dshp-wf-name' }, `${t('wfRunDetail')} · ${run.name}`),
            h('span', { className: 'dshp-badge', 'data-kind': wfStatusKind(run.status) }, wfStatusLabel(run.status, t)),
            run.stopReason.length > 0 ? h('span', { className: 'dshp-badge' }, `${t('wfStopReason')}: ${run.stopReason}`) : null,
            run.active
              ? h('button', {
                type: 'button',
                className: 'dshp-set-secondary',
                onClick: () => { if (typeof act.cancelRun === 'function') act.cancelRun(run.id) },
              }, t('wfCancelRun'))
              : null,
          ),
          h('div', { className: 'dshp-wf-badges' },
            h('span', { className: 'dshp-badge' }, `${t('wfAgentsStarted')} ${run.agentsStarted}`),
            h('span', { className: 'dshp-badge' }, `${t('wfCached')} ${run.cachedAgents}/${run.agentsTotal}`),
            h('span', { className: 'dshp-badge' }, `${t('wfDuration')} ${wfFormatDuration(run.durationMs)}`),
            run.endedAt !== undefined ? h('span', { className: 'dshp-badge' }, `${t('wfEndedAt')} ${formatDateTime(run.endedAt)}`) : null,
          ),
          run.errorText.length > 0
            ? h('div', { className: 'dshp-notice', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `${t('wfRunError')}: ${run.errorText}`)
            : null,
          usageParts.length > 0
            ? h('div', { className: 'dshp-wf-kv' }, h('span', null, t('wfUsage')), h('b', null, usageParts.join(' · ')))
            : null,
          h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, `${t('wfPhases')} (${run.phases.length})`),
          run.phases.length === 0
            ? h('div', { className: 'dshp-set-hint' }, t('wfPhasesEmpty'))
            : h('div', null, run.phases.map((line, index) => h('div', { key: `phase-${index}`, className: 'dshp-wf-list-line' }, `${index + 1}. ${line}`))),
          h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, `${t('wfLogs')} (${run.logs.length})`),
          run.logs.length === 0
            ? h('div', { className: 'dshp-set-hint' }, t('wfLogsEmpty'))
            : h('pre', { className: 'dshp-wf-doc' }, run.logs.join('\n')),
          h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, `${t('wfReports')} (${run.reportsTotal})`),
          run.reports.length === 0
            ? h('div', { className: 'dshp-set-hint' }, t('wfReportsEmpty'))
            : h('div', null, run.reports.map((report) => h('div', { key: report.id, className: 'dshp-wf-list-line dshp-mono' }, report.preview))),
          h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, `${t('wfAgentsTitle')} (${run.agentsTotal})`),
          run.agents.length === 0
            ? h('div', { className: 'dshp-set-hint' }, t('wfAgentsEmpty'))
            : h('div', null, run.agents.slice(0, 40).map((agent) => h('div', { key: agent.id, className: 'dshp-wf-list-line' },
              `${agent.label} · ${agent.status}${agent.provider || agent.model ? ` · ${[agent.provider, agent.model].filter((part) => part.length > 0).join('/')}` : ''}${agent.cached ? ` · ${t('wfCachedShort')}` : ''}`,
            ))),
          h('div', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, `${t('wfArtifacts')} (${run.artifacts.length})`),
          run.artifacts.length === 0
            ? h('div', { className: 'dshp-set-hint' }, t('wfArtifactsEmpty'))
            : h('div', null, run.artifacts.map((artifact) => h('div', { key: artifact.id, className: 'dshp-wf-row' },
              h('span', { className: 'dshp-wf-run-name' }, `${artifact.name} · ${artifact.kind}`),
              h('button', {
                type: 'button',
                className: 'dshp-set-secondary',
                disabled: model.artifactLoading,
                onClick: () => { if (typeof act.readArtifact === 'function') act.readArtifact(run.id, artifact.id) },
              }, model.artifactLoading ? t('wfArtifactLoading') : t('wfArtifactView')),
            ))),
          model.artifact
            ? h('pre', { className: 'dshp-wf-doc' }, `${model.artifact.name} · ${model.artifact.kind}\n\n${model.artifact.content}`)
            : null,
        )
      })()

      const runsCard = h(CollapsibleCard, { title: t('wfRunsTitle'), hint: t('wfRunsHint'), defaultOpen: true },
        h('div', { className: 'dshp-set-actions', style: { marginTop: 0 } },
          h('button', {
            type: 'button',
            className: 'dshp-set-secondary',
            disabled: model.busy,
            onClick: () => { if (typeof act.reloadRuns === 'function') act.reloadRuns() },
          }, t('wfRunsReload')),
          h('span', { className: 'dshp-badge', 'data-kind': model.activeRuns.length > 0 ? 'warn' : 'ok' }, `${t('wfActiveRuns')} ${model.activeRuns.length}`),
        ),
        model.runs.length === 0
          ? h('div', { className: 'dshp-set-hint', style: { marginTop: '8px' } }, t('wfRunsEmpty'))
          : h('div', { className: 'dshp-wf-runs' },
            model.runs.map((run) => h('button', {
              key: run.id,
              type: 'button',
              className: 'dshp-wf-run',
              'data-active': run.id === model.selectedRunId ? 'true' : 'false',
              onClick: () => { if (typeof act.selectRun === 'function') act.selectRun(run.id) },
            },
              h('span', { className: 'dshp-badge', 'data-kind': wfStatusKind(run.status) }, wfStatusLabel(run.status, t)),
              h('span', { className: 'dshp-wf-run-name' }, run.name),
              run.startedAt !== undefined ? h('span', { className: 'dshp-wf-run-meta' }, formatDateTime(run.startedAt)) : null,
              h('span', { className: 'dshp-wf-run-meta' }, `${t('wfAgents')} ${run.agentsStarted ?? '—'}`),
              h('span', { className: 'dshp-wf-run-meta' }, wfFormatDuration(run.durationMs)),
            )),
          ),
        detailBlock,
      )

      const statusHint = model.phase === 'loading'
        ? h('div', { className: 'dshp-set-hint' }, t('wfLoading'))
        : model.phase === 'unavailable'
          ? h('div', { className: 'dshp-set-hint' }, model.error.length > 0 ? model.error : t('wfUnavailable'))
          : model.phase === 'error'
            ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, model.error.length > 0 ? model.error : t('wfLoadFailed'))
            : null

      return h('div', { className: 'dshp-set' },
        h('style', null, CSS),
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('wfTitle')),
          h('p', null, t('wfDescription')),
        ),
        statusHint,
        model.phase !== 'ready'
          ? null
          : h('div', { className: 'dshp-wf-page' }, settingsBlock, libraryCard, runsCard),
      )
    }

    /**
     * dshp-workflow settings tab. The Host owns engine/library/run state; this
     * client only writes settings ops and deletes library entries, and reads
     * runs. Starting a run is deliberately absent — runs start through
     * `/workflow run` or the model tool so every run has a parent Agent.
     *
     * State order is part of the offline render-harness contract
     * (`tools/test-client.mjs` seeds it); `useMemo`/`useEffect` are not state
     * slots in the harness' fake React.
     */
    function WorkflowSettings({ rpc, t }) {
      const [settingsDoc, setSettingsDoc] = useState(null)
      const [draft, setDraft] = useState(null)
      const [phase, setPhase] = useState('loading')
      const [error, setError] = useState(null)
      const [workflows, setWorkflows] = useState([])
      const [runs, setRuns] = useState([])
      const [activeRuns, setActiveRuns] = useState([])
      const [saving, setSaving] = useState(false)
      const [message, setMessage] = useState(null)
      const [selectedRunId, setSelectedRunId] = useState('')
      const [runDetail, setRunDetail] = useState(null)
      const [runLoading, setRunLoading] = useState(false)
      const [runError, setRunError] = useState(null)
      const [workflowView, setWorkflowView] = useState(null)
      const [artifact, setArtifact] = useState(null)
      const [artifactLoading, setArtifactLoading] = useState(false)
      const [pendingDelete, setPendingDelete] = useState('')
      const aliveRef = useRef(true)

      const loadLibrary = useMemo(() => async () => {
        if (!rpc) return
        const result = await wfInvoke(rpc, 'workflows-list', { scope: 'global' })
        if (!aliveRef.current) return
        if (result.ok) {
          setWorkflows(Array.isArray(result.value.workflows) ? result.value.workflows : [])
        } else {
          setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfLoadFailed') })
        }
      }, [rpc, t])

      const loadRuns = useMemo(() => async () => {
        if (!rpc) return
        const result = await wfInvoke(rpc, 'runs-list', { limit: 50 })
        if (!aliveRef.current) return
        if (result.ok) {
          setRuns(Array.isArray(result.value.runs) ? result.value.runs : [])
        } else {
          setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfLoadFailed') })
        }
      }, [rpc, t])

      const loadSettings = useMemo(() => async () => {
        if (!rpc) {
          setPhase('unavailable')
          setError(t('wfNoRpc'))
          return
        }
        const result = await wfInvoke(rpc, 'settings', {})
        if (!aliveRef.current) return
        if (!result.ok) {
          setPhase('unavailable')
          setError(wfErrorText(result.error) || t('wfUnavailable'))
          return
        }
        const next = wfSettingsDocument(result.value)
        setSettingsDoc(next)
        setDraft(null)
        setPhase(next.available === false ? 'unavailable' : 'ready')
        setError(next.available === false ? t('wfSettingsUnavailable') : null)
      }, [rpc, t])

      const load = useMemo(() => async () => {
        if (!rpc) {
          setPhase('unavailable')
          setError(t('wfNoRpc'))
          return
        }
        setPhase('loading')
        setError(null)
        const result = await wfInvoke(rpc, 'snapshot', {})
        if (!aliveRef.current) return
        if (!result.ok) {
          setPhase('unavailable')
          setError(wfErrorText(result.error) || t('wfUnavailable'))
          return
        }
        const snapshot = wfSnapshotModel(result.value)
        setSettingsDoc({
          ...snapshot.settings,
          providers: snapshot.providers,
          presets: snapshot.presets,
        })
        setDraft(null)
        setWorkflows(Array.isArray(snapshot.workflows) ? snapshot.workflows : [])
        setRuns(Array.isArray(snapshot.runs) ? snapshot.runs : [])
        setActiveRuns(snapshot.activeRuns)
        setPhase(snapshot.settings.available === false ? 'unavailable' : 'ready')
        setError(snapshot.settings.available === false ? t('wfSettingsUnavailable') : null)
        if (snapshot.workflows === undefined) loadLibrary()
        if (snapshot.runs === undefined) loadRuns()
        if (snapshot.providers === undefined || snapshot.presets === undefined) {
          const options = await wfInvoke(rpc, 'runtime-options', {})
          if (!aliveRef.current || !options.ok) return
          setSettingsDoc((current) => (isRecord(current)
            ? {
                ...current,
                providers: wfProviderRows(options.value.providers),
                presets: wfPresetRows(options.value.presets),
              }
            : current))
        }
      }, [rpc, t, loadLibrary, loadRuns])

      useEffect(() => {
        aliveRef.current = true
        load()
        return () => {
          aliveRef.current = false
        }
      }, [load])

      const setField = (key, value) => {
        setDraft((current) => {
          const base = isRecord(current) ? current : wfSettingsValue(settingsDoc ? settingsDoc.value : undefined)
          return { ...base, [key]: value }
        })
      }

      const saveSettings = async () => {
        if (!rpc || saving) return
        setSaving(true)
        setMessage(null)
        try {
          const settings = wfSettingsValue(isRecord(draft) ? draft : settingsDoc ? settingsDoc.value : undefined)
          const ops = Object.keys(WF_SETTINGS_DEFAULTS).map((key) => ({ op: 'set', path: [key], value: settings[key] }))
          const revision = settingsDoc && typeof settingsDoc.revision === 'number' ? settingsDoc.revision : undefined
          const result = await wfInvoke(rpc, 'settings-write', { ops, revision })
          if (!aliveRef.current) return
          if (!result.ok) {
            const code = isRecord(result.error) && typeof result.error.code === 'string' ? result.error.code : ''
            if (code === 'settings-conflict') {
              setMessage({ kind: 'error', text: t('wfConflict') })
              await loadSettings()
            } else {
              setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfLoadFailed') })
            }
            return
          }
          const next = wfSettingsDocument(result.value, revision)
          if (Object.keys(next.value).length > 0) {
            setSettingsDoc(next)
            setDraft(null)
            setPhase(next.available === false ? 'unavailable' : 'ready')
          } else {
            await loadSettings()
          }
          setMessage({ kind: 'ok', text: t('wfSaved') })
        } finally {
          if (aliveRef.current) setSaving(false)
        }
      }

      const showWorkflow = async (id) => {
        if (!rpc) return
        const result = await wfInvoke(rpc, 'workflow-read', { id, scope: 'global' })
        if (!aliveRef.current) return
        if (result.ok) {
          setWorkflowView({ document: result.value.document, meta: result.value.meta, hash: result.value.hash })
        } else {
          setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfReadFailed') })
        }
      }

      const confirmDelete = async (id) => {
        if (!rpc) return
        const result = await wfInvoke(rpc, 'workflow-delete', { id, scope: 'global' })
        if (!aliveRef.current) return
        if (!result.ok) {
          setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfLoadFailed') })
          return
        }
        setPendingDelete('')
        if (isRecord(workflowView) && isRecord(workflowView.meta) && workflowView.meta.id === id) setWorkflowView(null)
        setMessage({ kind: 'ok', text: t('wfDeleted') })
        await loadLibrary()
      }

      const selectRun = async (runId) => {
        if (!rpc) return
        setSelectedRunId(runId)
        setRunDetail(null)
        setRunError(null)
        setArtifact(null)
        setRunLoading(true)
        try {
          const result = await wfInvoke(rpc, 'run-read', { runId })
          if (!aliveRef.current) return
          if (result.ok) {
            const detail = isRecord(result.value.run) ? result.value.run : result.value
            setRunDetail(detail)
          } else {
            setRunError(wfErrorText(result.error) || t('wfRunFailed'))
          }
        } finally {
          if (aliveRef.current) setRunLoading(false)
        }
      }

      const cancelRun = async (runId) => {
        if (!rpc) return
        const result = await wfInvoke(rpc, 'run-cancel', { runId })
        if (!aliveRef.current) return
        if (!result.ok) {
          setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfLoadFailed') })
          return
        }
        setMessage({ kind: 'ok', text: t('wfCancelledRun') })
        await selectRun(runId)
        await loadRuns()
      }

      const readArtifact = async (runId, artifactId) => {
        if (!rpc) return
        setArtifactLoading(true)
        try {
          const result = await wfInvoke(rpc, 'artifact-read', { runId, artifactId })
          if (!aliveRef.current) return
          if (result.ok) {
            setArtifact(isRecord(result.value.artifact) ? result.value.artifact : result.value)
          } else {
            setMessage({ kind: 'error', text: wfErrorText(result.error) || t('wfArtifactFailed') })
          }
        } finally {
          if (aliveRef.current) setArtifactLoading(false)
        }
      }

      const model = wfViewModel({
        phase,
        error,
        settingsDocument: settingsDoc,
        draft,
        workflows,
        runs,
        activeRuns,
        selectedRunId,
        runDetail,
        runLoading,
        runError,
        workflowView,
        artifact,
        artifactLoading,
        pendingDelete,
        busy: saving,
        message,
      })
      const actions = {
        setField,
        save: saveSettings,
        reload: load,
        reloadLibrary: loadLibrary,
        reloadRuns: loadRuns,
        showWorkflow,
        hideWorkflow: () => setWorkflowView(null),
        askDelete: (id) => setPendingDelete(typeof id === 'string' ? id : ''),
        cancelDelete: () => setPendingDelete(''),
        confirmDelete,
        selectRun,
        cancelRun,
        readArtifact,
      }
      return h(WorkflowTabView, { t, model, actions })
    }

    // ------------------------------------------------------------------
    // dshps settings section
    // ------------------------------------------------------------------

    /** Small hover tip used by the workflow settings fields. */
    function WfTip({ text }) {
      if (typeof text !== 'string' || text.length === 0) return null
      return h('span', {
        className: 'dshp-wf-tip',
        title: text,
        'aria-label': text,
        role: 'img',
      }, '?')
    }

    function SettingsField({ label, tip, hint, children }) {
      return h('label', { className: 'dshp-set-field' },
        h('span', { className: 'dshp-set-label' }, label, tip ? h(WfTip, { text: tip }) : null),
        children,
        hint ? h('span', { className: 'dshp-set-hint', style: { marginTop: '2px' } }, hint) : null,
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
      const store = props.store
      const [tab, setTab] = useState('quota')
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
        h('style', null, CSS),
        h('div', { className: 'dshp-set-head' },
          h('h2', null, t('settingsTitle')),
          h('p', null, t('settingsDescription')),
        ),
        h('div', { className: 'dshp-tabbar', role: 'tablist' },
          [['quota', t('tabQuota')], ['net', t('tabNet')], ['models', t('tabModels')], ['wf', t('tabWorkflow')], ['float', t('floatTab')]].map(([value, label]) => h('button', {
            key: value,
            type: 'button',
            role: 'tab',
            'aria-selected': tab === value,
            className: 'dshp-tabbtn',
            'data-active': tab === value ? 'true' : 'false',
            onClick: () => setTab(value),
          }, label)),
        ),
        tab === 'net' ? h(NetSettings, { rpc, t }) : null,
        tab === 'models' ? h(ModelsSettings, { rpc, t }) : null,
        tab === 'wf' ? h(WorkflowSettings, { rpc, t }) : null,
        tab === 'float' ? h(FloatingSettings, { store, t }) : null,
        tab === 'quota' ? h('div', { className: 'dshp-set-card' },
          h('h3', null, t('settingsQuotaTitle')),
          h('p', { className: 'dshp-set-sub' }, t('settingsQuotaDescription')),
          phase === 'loading' ? h('div', { className: 'dshp-set-hint' }, t('loading')) : null,
          phase === 'missing' ? h('div', { className: 'dshp-set-hint' }, t('settingsMissing')) : null,
          phase === 'error' ? h('div', { className: 'dshp-set-hint', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error || t('settingsUnavailable')) : null,
          phase === 'ready' ? h(React.Fragment, null,
            h(SetSection, { title: t('settingsGlmTeam'), hint: t('settingsGlmTeamHint') },
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
              h('p', { className: 'dshp-set-hint', style: { marginTop: '10px' } }, t('settingsRefreshHint')),
              h('div', { className: 'dshp-set-actions' },
                h('button', { type: 'button', className: 'dshp-set-primary', onClick: save, disabled: saving }, saving ? t('settingsSaving') : t('settingsSave')),
                h('button', { type: 'button', className: 'dshp-set-secondary', onClick: readSettings, disabled: saving }, t('settingsReload')),
                message ? h('span', { className: 'dshp-set-status', 'data-error': message.kind === 'error' ? 'true' : 'false' }, message.text) : null,
              ),
            ),
            h(SetSection, { title: t('kimiTokenTitle'), hint: t('kimiTokenHint') },
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
            ),
            h(SetSection, { title: t('settingsDetected') },
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
            ),
          ) : null,
          h('p', { className: 'dshp-set-meta', 'data-hidden': phase === 'ready' ? 'true' : 'false' },
            `${t('settingsStatus')}: ${phase}${typeof revision === 'number' ? ` · rev ${revision}` : ''}${rpc ? '' : ` · ${t('settingsNoRpc')}`}`),
        ) : null,
      )
    }

    // ------------------------------------------------------------------
    // plugin
    // ------------------------------------------------------------------

    const testHooks = {
      FLOAT_WINDOWS,
      SHELL_CHANNEL,
      geometryFromWindow,
      clampGeometry,
      ringLayout,
      ProxyRoutingCard,
      netEnvWarningTexts,
      store: null,
      workflow: {
        View: WorkflowTabView,
        Settings: WorkflowSettings,
        invoke: wfInvoke,
        snapshotModel: wfSnapshotModel,
        settingsDocument: wfSettingsDocument,
        settingsValue: wfSettingsValue,
        workflowCards: wfWorkflowCards,
        runRows: wfRunRows,
        runDetail: wfRunDetailModel,
        workflowView: wfWorkflowView,
        artifactView: wfArtifactView,
        viewModel: wfViewModel,
        formatDuration: wfFormatDuration,
        statusLabel: wfStatusLabel,
        statusKind: wfStatusKind,
        splitList: wfSplitList,
      },
    }

    return {
      inject: ['slots', 'locale', 'connection'],
      __test: testHooks,
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }), 'dshps: quota locale')
        const connection = ctx.get('connection')
        const rpc = connection && connection.rpc ? connection.rpc : undefined
        const floatingStore = createFloatingStore(rpc)
        testHooks.store = floatingStore
        const bound = ctx.locale.bind ? ctx.locale.bind(NS) : (key) => key
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dshp-quota',
          order: 10,
          label: () => bound('title'),
          locale: NS,
        }, (slotProps) => h(QuotaPanel, { ...slotProps, rpc })))
        ctx.slots.inject('shell.overlay', () => ctx.slots.register({
          name: 'shell.overlay',
          id: 'dshps-floating',
          order: 40,
        }, () => h(FloatingLayer, { store: floatingStore, rpc, t: bound })))
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dshps',
          order: 18,
          label: () => bound('settingsTitle'),
          locale: NS,
        }, (slotProps) => h(PageBoundary, { t: slotProps.t }, h(DshpsSettingsPage, { ...slotProps, rpc, store: floatingStore }))))
      },
    }
  },
})
