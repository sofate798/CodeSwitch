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
      anthropicValueFields: { apiKey: 'anthropicOverrideApiKey' },
      probeContains: ['openAiApiKey', 'anthropicOverrideApiKey', 'apiKey'],
      encryptSecret: true
    },
    note: 'Cursor 自带 AI 需 Pro 及以上订阅才能自定义端点（官方服务端限制，直写 state.vscdb 也无法绕过）；免费版请在「设置 → 本地转发网关」启用后，在 Cursor 内用 Cline/Continue 等 OpenAI 兼容扩展指向网关地址。写入前请先完全关闭 Cursor。'
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
    note: 'Windsurf 自定义模型凭证存于应用数据库，采用自适应探测定位；写入前请先关闭 Windsurf。'
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
    note: 'Trae 凭证存于应用数据库，采用自适应探测定位；写入前请先关闭 Trae。'
  },
  {
    id: 'zed',
    name: 'Zed',
    icon: 'zed',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${APPDATA}\\Zed', '${USERPROFILE}\\.config\\zed'],
    configPaths: ['${APPDATA}\\Zed\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Zed\\Zed.exe',
      'D:\\Program\\Zed\\Zed.exe',
      'C:\\Program Files\\Zed\\Zed.exe'
    ],
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
    note: 'Copilot 的 BYOK 密钥存于 VS Code 系统级密钥库（DPAPI），无法安全直写。可生成配置后在 VS Code Settings → Copilot → Models 手动粘贴。'
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
    note: 'Kiro 凭证存于应用数据库，采用自适应探测定位；写入前请先关闭 Kiro。'
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
    note: 'CodeBuddy 凭证存于应用数据库，采用自适应探测定位；写入前请先关闭 CodeBuddy。'
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
    note: 'Qoder 凭证存于应用数据库，采用自适应探测定位；写入前请先关闭 Qoder。'
  },
  {
    id: 'antigravity',
    name: 'Antigravity',
    icon: 'antigravity',
    protocols: ['openai', 'anthropic'],
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
    note: 'Antigravity 配置为明文 JSON；若其控制台另有校验，写入后可能需在界面确认。'
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
    note: 'Gemini CLI 原生使用 Google 账号 OAuth；此处按 OpenAI 兼容模式写入 ~/.gemini/.env，需 CLI 支持 OpenAI 兼容端点方生效。'
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
    note: 'Codex CLI 使用 ~/.codex/config.toml + auth.json；将写入 model_provider=codeswitch 并把 Key 存入 auth.json。'
  }
]

export function resolvePath(tpl: string): string {
  return tpl.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
}
