import type { IDEAdapterDef } from '../shared/types'

/**
 * IDE 适配器注册表（数据驱动 + 存储策略）。
 * 路径中的 ${ENV} 占位符在运行时展开。
 *
 * 检测优先级：homeMarkers（家目录配置文件夹，跨盘符最可靠）> detectPaths（exe 多位置）> configPaths。
 *
 * storage 策略决定供应商信息如何落盘：
 * - json：明文 JSON（Zed / Antigravity）
 * - sqlite：VS Code 系的 globalStorage/state.vscdb，用 sql.js 直写 ItemTable（Cursor/Trae/Kiro/Qoder/...）
 * - toml：Codex config.toml
 * - env：Gemini CLI 的 .env
 * 未知 schema 的分支用 sqlite.probeContains 自适应探测凭证行；探测失败则回退为 assist（生成配置+引导）。
 */
export const IDE_REGISTRY: IDEAdapterDef[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'cursor',
    protocols: ['openai', 'anthropic'],
    // 实测 state.vscdb：OpenAI Key 存于 secret://cursorAuth/openAIKey，是 Cursor 自身 safeStorage 加密的 SecretStorage 项，
    // 外部写不出它能解开的密文；并不存在 cursorAuth 这一 JSON 行（旧版直写只会插入一行 Cursor 不读、却含明文 Key 的数据）。
    // 故为 assist：给出三要素由用户在 Cursor 设置里填写；下面的 storage 仅供“恢复默认”清除旧版插入的那一行里的字段。
    capability: 'assist',
    homeMarkers: ['${USERPROFILE}\\.cursor'],
    configPaths: ['${APPDATA}\\Cursor\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Cursor\\Cursor.exe',
      'D:\\Program\\cursor\\Cursor.exe',
      'D:\\Program\\Cursor\\Cursor.exe',
      'C:\\Program Files\\Cursor\\Cursor.exe'
    ],
    processNames: ['Cursor.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: ['${APPDATA}\\Cursor\\User\\globalStorage\\state.vscdb'],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      rowKey: 'cursorAuth',
      valueFields: { apiKey: 'openAiApiKey', baseUrl: 'openAiBaseUrl' },
      // C2：Anthropic 覆写必须同时落 apiKey + baseUrl + model，仅写 apiKey 会导致端点/模型缺失
      anthropicValueFields: {
        apiKey: 'anthropicOverrideApiKey',
        baseUrl: 'anthropicOverrideBaseUrl',
        model: 'anthropicOverrideModel'
      },
      probeContains: ['openAiApiKey', 'anthropicOverrideApiKey', 'apiKey']
    },
    noteKey: 'ide.note.cursor'
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    icon: 'windsurf',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.codeium\\windsurf'],
    configPaths: ['${APPDATA}\\Windsurf\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Windsurf\\Windsurf.exe',
      'D:\\Program\\Windsurf\\Windsurf.exe',
      'C:\\Program Files\\Windsurf\\Windsurf.exe'
    ],
    processNames: ['Windsurf.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: ['${APPDATA}\\Windsurf\\User\\globalStorage\\state.vscdb'],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      valueFields: { apiKey: 'customModelApiKey', baseUrl: 'customModelBaseUrl', model: 'customModelName' },
      probeContains: ['customModelApiKey', 'apiKey', 'baseUrl']
    },
    noteKey: 'ide.note.windsurf'
  },
  {
    id: 'trae',
    name: 'Trae',
    icon: 'trae',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.trae'],
    configPaths: ['${APPDATA}\\Trae\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Trae\\Trae.exe',
      'D:\\Program\\Trae\\Trae.exe',
      'C:\\Program Files\\Trae\\Trae.exe'
    ],
    processNames: ['Trae.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: ['${APPDATA}\\Trae\\User\\globalStorage\\state.vscdb'],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      valueFields: { apiKey: 'apiKey', baseUrl: 'baseUrl', model: 'model' },
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url']
    },
    noteKey: 'ide.note.trae'
  },
  {
    id: 'zed',
    name: 'Zed',
    icon: 'zed',
    // Zed 官方文档：Key 只从系统钥匙串 / 环境变量读取（明确要求不要写进 settings.json），
    // 自定义端点须写成 language_models.openai_compatible.<id>.api_url + available_models 数组。
    // 现有字段映射表达不了数组，直写也拿不到 Key，故为 assist：生成正确片段，Key 由用户在 Zed 内填写。
    protocols: ['openai'],
    capability: 'assist',
    homeMarkers: ['${APPDATA}\\Zed', '${USERPROFILE}\\.config\\zed'],
    configPaths: ['${APPDATA}\\Zed\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Zed\\Zed.exe',
      'D:\\Program\\Zed\\Zed.exe',
      'C:\\Program Files\\Zed\\Zed.exe'
    ],
    // M4：settings.json 整文件重写前需确认 Zed 已关闭，避免其退出时覆盖
    processNames: ['Zed.exe'],
    storage: {
      kind: 'json',
      paths: ['${APPDATA}\\Zed\\settings.json'],
      // 旧版直写过的字段（Zed 并不读取，其中 api_key 是落盘的明文 Key）：仅供“恢复默认”清除残留
      fields: {
        apiKey: 'language_models.openai.api_key',
        baseUrl: 'language_models.openai.base_url',
        model: 'language_models.openai.default_model'
      }
    },
    noteKey: 'ide.note.zed'
  },
  {
    id: 'kiro',
    name: 'Kiro',
    icon: 'kiro',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.kiro'],
    configPaths: ['${APPDATA}\\Kiro\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Kiro\\Kiro.exe',
      'D:\\Program\\Kiro\\Kiro.exe',
      'C:\\Program Files\\Kiro\\Kiro.exe'
    ],
    processNames: ['Kiro.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: ['${APPDATA}\\Kiro\\User\\globalStorage\\state.vscdb'],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      valueFields: { apiKey: 'apiKey', baseUrl: 'baseUrl', model: 'model' },
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url']
    },
    noteKey: 'ide.note.kiro'
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    icon: 'codebuddy',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.codebuddy'],
    configPaths: ['${APPDATA}\\CodeBuddy\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\CodeBuddy\\CodeBuddy.exe',
      'D:\\Program\\CodeBuddy\\CodeBuddy.exe',
      'C:\\Program Files\\CodeBuddy\\CodeBuddy.exe'
    ],
    processNames: ['CodeBuddy.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: ['${APPDATA}\\CodeBuddy\\User\\globalStorage\\state.vscdb'],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      valueFields: { apiKey: 'apiKey', baseUrl: 'baseUrl', model: 'model' },
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url']
    },
    noteKey: 'ide.note.codebuddy'
  },
  {
    id: 'qoder',
    name: 'Qoder',
    icon: 'qoder',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.qoder', '${USERPROFILE}\\.qoder-cn'],
    configPaths: ['${APPDATA}\\QoderCN\\User\\globalStorage\\state.vscdb'],
    detectPaths: [
      'D:\\Program\\Qoder CN IDE\\Qoder CN IDE.exe',
      'D:\\Program\\Qoder\\Qoder.exe',
      '${LOCALAPPDATA}\\Programs\\Qoder\\Qoder.exe'
    ],
    processNames: ['Qoder CN IDE.exe', 'Qoder.exe'],
    storage: {
      kind: 'sqlite',
      dbPaths: [
        '${APPDATA}\\QoderCN\\User\\globalStorage\\state.vscdb',
        '${APPDATA}\\com.qoder.app.stable\\User\\globalStorage\\state.vscdb'
      ],
      table: 'ItemTable',
      keyColumn: 'key',
      valueColumn: 'value',
      valueFields: { apiKey: 'apiKey', baseUrl: 'baseUrl', model: 'model' },
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url']
    },
    noteKey: 'ide.note.qoder'
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    icon: 'antigravity',
    // C2：Antigravity config.json 落点为 openai.*，无独立可靠的 anthropic 落点，仅保留 openai
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.antigravity_cockpit'],
    configPaths: ['${USERPROFILE}\\.antigravity_cockpit\\config.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Antigravity\\Antigravity.exe',
      'D:\\Program\\Antigravity\\Antigravity.exe'
    ],
    processNames: ['Antigravity.exe'],
    storage: {
      kind: 'json',
      paths: ['${USERPROFILE}\\.antigravity_cockpit\\config.json'],
      fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' }
    },
    noteKey: 'ide.note.antigravity'
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    icon: 'gemini',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.gemini'],
    configPaths: ['${USERPROFILE}\\.gemini\\.env'],
    detectPaths: ['${USERPROFILE}\\.gemini'],
    storage: {
      kind: 'env',
      paths: ['${USERPROFILE}\\.gemini\\.env'],
      mapping: { apiKey: 'OPENAI_API_KEY', baseUrl: 'OPENAI_BASE_URL', model: 'OPENAI_MODEL' }
    },
    noteKey: 'ide.note.gemini-cli'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    icon: 'codex',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.codex'],
    configPaths: ['${USERPROFILE}\\.codex\\config.toml'],
    detectPaths: ['${USERPROFILE}\\.codex'],
    storage: {
      kind: 'toml',
      paths: ['${USERPROFILE}\\.codex\\config.toml'],
      scalars: { model: '${model}', model_provider: 'codeswitch' },
      table: ['model_providers', 'codeswitch'],
      // Codex 配置参考：wire_api 仅支持 "responses"（"chat" 已移除）；自定义 provider 的 Key 只从
      // env_key 指向的环境变量或 experimental_bearer_token 取，auth.json 里的 OPENAI_API_KEY 对它无效。
      tableValues: { name: 'CodeSwitch', base_url: '${baseUrl}', wire_api: 'responses', experimental_bearer_token: '${apiKey}' },
      legacySecretFile: { path: '${USERPROFILE}\\.codex\\auth.json', field: 'OPENAI_API_KEY' }
    },
    noteKey: 'ide.note.codex'
  },
  {
    id: 'claude-code',
    name: 'Claude Code',
    icon: 'claude',
    // Claude Code 只读 Anthropic 协议端点（ANTHROPIC_* 系列变量），openai 供应商需经本地网关跨协议接入
    protocols: ['anthropic'],
    homeMarkers: ['${USERPROFILE}\\.claude'],
    configPaths: ['${USERPROFILE}\\.claude\\settings.json'],
    detectPaths: [
      '${APPDATA}\\npm\\claude.cmd',
      '${USERPROFILE}\\.local\\bin\\claude.exe'
    ],
    // CLI 不持写 settings.json（每会话读取），无 GUI 型退出覆盖风险，故不设 processNames
    storage: {
      kind: 'json',
      paths: ['${USERPROFILE}\\.claude\\settings.json'],
      fields: {
        apiKey: 'env.ANTHROPIC_API_KEY',
        baseUrl: 'env.ANTHROPIC_BASE_URL',
        model: 'env.ANTHROPIC_MODEL'
      }
    },
    noteKey: 'ide.note.claude-code'
  }
]

/**
 * 展开路径模板中的 ${ENV} 占位符。
 * M9：任一占位符对应的环境变量缺失/为空时，整条路径判为无效并返回 null，
 * 由调用方 filter 掉，避免替换成空串产生 "\..." 之类的畸形根相对路径。
 */
export function resolvePath(tpl: string): string | null {
  const placeholderRe = /\$\{(\w+)\}/g
  // 先校验：任一 ${VAR} 占位符对应环境变量缺失/为空，则整条路径判为无效。
  // （用显式循环而非「闭包内改写外部布尔标志」，避免 TS 控制流分析把标志误判为恒 false。）
  for (const match of tpl.matchAll(placeholderRe)) {
    const v = process.env[match[1]]
    if (v == null || v === '') return null
  }
  return tpl.replace(placeholderRe, (_, name: string) => process.env[name] ?? '')
}
