import type { IDEAdapterDef } from '../shared/types'

/**
 * IDE 适配器注册表（数据驱动）。
 * 路径中的 ${ENV} 占位符在运行时展开。
 *
 * 检测优先级：homeMarkers（家目录配置文件夹，跨盘符最可靠）> detectPaths（exe 多位置）> configPaths。
 * writable=false 表示该 IDE 的凭证存储为 SQLite / Protobuf / TOML / safeStorage 加密，
 * CodeSwitch 不直接写文件，只在 UI 提示用户在对应设置界面手动配置。
 */
export const IDE_REGISTRY: IDEAdapterDef[] = [
  {
    id: 'cursor',
    name: 'Cursor',
    icon: 'cursor',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.cursor'],
    configPaths: ['${APPDATA}\\Cursor\\User\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Cursor\\Cursor.exe',
      'D:\\Program\\cursor\\Cursor.exe',
      'D:\\Program\\Cursor\\Cursor.exe',
      'C:\\Program Files\\Cursor\\Cursor.exe'
    ],
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'Cursor 的自定义 OpenAI Key 加密存储在应用内数据库（state.vscdb），请在 Cursor Settings → Models → OpenAI API Key 中手动填写'
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    icon: 'windsurf',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.codeium\\windsurf'],
    configPaths: [
      '${USERPROFILE}\\.codeium\\windsurf\\model_config.json',
      '${USERPROFILE}\\.codeium\\windsurf\\user_settings.pb'
    ],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Windsurf\\Windsurf.exe',
      'D:\\Program\\Windsurf\\Windsurf.exe',
      'C:\\Program Files\\Windsurf\\Windsurf.exe'
    ],
    fields: {
      apiKey: 'customModelApiKey',
      baseUrl: 'customModelBaseUrl',
      model: 'customModelName'
    },
    writable: false,
    note: '新版 Windsurf 配置为 Protobuf 二进制（user_settings.pb），请在 Windsurf Settings → Cascade → Custom Model 中手动配置'
  },
  {
    id: 'trae',
    name: 'Trae',
    icon: 'trae',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.trae'],
    configPaths: ['${APPDATA}\\Trae\\User\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Trae\\Trae.exe',
      'D:\\Program\\Trae\\Trae.exe',
      'C:\\Program Files\\Trae\\Trae.exe'
    ],
    fields: { apiKey: 'trae.openai.apiKey', baseUrl: 'trae.openai.baseUrl', model: 'trae.openai.model' },
    writable: false,
    note: 'Trae 的模型凭证加密存储，请在 Trae 设置 → 模型服务商 中手动配置自定义接口'
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
    fields: {
      apiKey: 'language_models.openai.api_key',
      baseUrl: 'language_models.openai.base_url',
      model: 'language_models.openai.default_model'
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
    fields: { apiKey: null, baseUrl: null, model: null },
    writable: false,
    note: 'Copilot 凭证与自定义 endpoint 由 VS Code / GitHub 统一管理，请通过代理或 VS Code Settings 调整'
  },
  {
    id: 'kiro',
    name: 'Kiro',
    icon: 'kiro',
    protocols: ['openai', 'anthropic'],
    homeMarkers: ['${USERPROFILE}\\.kiro'],
    configPaths: ['${APPDATA}\\Kiro\\User\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\Kiro\\Kiro.exe',
      'D:\\Program\\Kiro\\Kiro.exe',
      'C:\\Program Files\\Kiro\\Kiro.exe'
    ],
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'Kiro 的模型凭证加密存储，请在 Kiro Settings → Profiles / Model Provider 中手动配置'
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy',
    icon: 'codebuddy',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.codebuddy'],
    configPaths: ['${APPDATA}\\CodeBuddy\\User\\settings.json'],
    detectPaths: [
      '${LOCALAPPDATA}\\Programs\\CodeBuddy\\CodeBuddy.exe',
      'D:\\Program\\CodeBuddy\\CodeBuddy.exe',
      'C:\\Program Files\\CodeBuddy\\CodeBuddy.exe'
    ],
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'CodeBuddy 的凭证通过系统加密存储，请在 CodeBuddy 设置中手动配置自定义模型接口'
  },
  {
    id: 'qoder',
    name: 'Qoder',
    icon: 'qoder',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.qoder', '${USERPROFILE}\\.qoder-cn'],
    configPaths: [
      '${APPDATA}\\QoderCN\\User\\settings.json',
      '${APPDATA}\\com.qoder.app.stable\\User\\settings.json'
    ],
    detectPaths: [
      'D:\\Program\\Qoder CN IDE\\Qoder CN IDE.exe',
      'D:\\Program\\Qoder\\Qoder.exe',
      '${LOCALAPPDATA}\\Programs\\Qoder\\Qoder.exe'
    ],
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'Qoder 的凭证加密存储，请在 Qoder Settings → Model / Custom Endpoint 中手动配置'
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
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'Antigravity 的凭证由其控制台统一管理，请在 Antigravity 界面中手动配置供应商'
  },
  {
    id: 'gemini-cli',
    name: 'Gemini CLI',
    icon: 'gemini',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.gemini'],
    configPaths: ['${USERPROFILE}\\.gemini\\settings.json'],
    detectPaths: ['${USERPROFILE}\\.gemini'],
    fields: { apiKey: 'openai.apiKey', baseUrl: 'openai.baseUrl', model: 'openai.model' },
    writable: false,
    note: 'Gemini CLI 默认使用 Google 账号 OAuth 登录，自定义接口需通过环境变量或第三方代理配置'
  },
  {
    id: 'codex',
    name: 'Codex CLI',
    icon: 'codex',
    protocols: ['openai'],
    homeMarkers: ['${USERPROFILE}\\.codex'],
    configPaths: ['${USERPROFILE}\\.codex\\config.toml'],
    detectPaths: ['${USERPROFILE}\\.codex'],
    fields: { apiKey: null, baseUrl: null, model: null },
    writable: false,
    note: 'Codex CLI 使用 TOML 配置（~/.codex/config.toml）与 auth.json，请手动编辑 model_provider / base_url / env_key'
  }
]

export function resolvePath(tpl: string): string {
  return tpl.replace(/\$\{(\w+)\}/g, (_, name) => process.env[name] || '')
}
