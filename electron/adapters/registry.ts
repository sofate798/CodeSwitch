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
 * - toml：Codex config.toml + auth.json
 * - env：Gemini CLI 的 .env
 * 未知 schema 的分支用 sqlite.probeContains 自适应探测凭证行；探测失败则回退为 assist（生成配置+引导）。
 */
export const IDE_REGISTRY: IDEAdapterDef[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'cursor',
    protocols: ['openai', 'anthropic'],
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
      probeContains: ['openAiApiKey', 'anthropicOverrideApiKey', 'apiKey'],
      encryptSecret: true
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
      probeContains: ['customModelApiKey', 'apiKey', 'baseUrl'],
      encryptSecret: true
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
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url'],
      encryptSecret: true
    },
    noteKey: 'ide.note.trae'
  },
  {
    id: 'zed',
    name: 'Zed',
    icon: 'zed',
    // C2：Zed settings.json 落点为 language_models.openai.*，无独立可靠的 anthropic 落点，仅保留 openai
    protocols: ['openai'],
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
      fields: {
        apiKey: 'language_models.openai.api_key',
        baseUrl: 'language_models.openai.base_url',
        model: 'language_models.openai.default_model'
      }
    }
    // Zed settings.json 为明文 JSON，支持一键写入（文件不存在时自动创建）
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot (VS Code)',
    icon: 'copilot',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.copilot'],
    configPaths: ['${APPDATA}\\Code\\User\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Microsoft VS Code\\Code.exe',
      'D:\\Program\\Microsoft VS Code\\Code.exe',
      'C:\\Program Files\\Microsoft VS Code\\Code.exe'
    ],
    processNames: ['Code.exe'],
    capability: 'assist',
    storage: { kind: 'json', paths: ['${APPDATA}\\Code\\User\\settings.json'], fields: {} },
    noteKey: 'ide.note.copilot'
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
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url'],
      encryptSecret: true
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
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url'],
      encryptSecret: true
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
      probeContains: ['apiKey', 'baseUrl', 'api_key', 'base_url'],
      encryptSecret: true
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
      tableValues: { name: 'CodeSwitch', base_url: '${baseUrl}', env_key: 'OPENAI_API_KEY', wire_api: 'chat' },
      secretFile: { path: '${USERPROFILE}\\.codex\\auth.json', field: 'OPENAI_API_KEY' }
    },
    noteKey: 'ide.note.codex'
  }
]

/**
 * 展开路径模板中的 ${ENV} 占位符。
 * M9：任一占位符对应的环境变量缺失/为空时，整条路径判为无效并返回 null，
 * 由调用方 filter 掉，避免替换成空串产生 "\..." 之类的畸形根相对路径。
 */
export function resolvePath(tpl: string): string | null {
  let missing = false
  const out = tpl.replace(/\$\{(\w+)\}/g, (_, name) => {
    const v = process.env[name]
    if (v == null || v === '') {
      missing = true
      return ''
    }
    return v
  })
  return missing ? null : out
}
