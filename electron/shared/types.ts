import type { Component } from 'vue'

export type Protocol = 'openai' | 'anthropic'

/**
 * 全项目统一消息码（单一真源）。服务层/主进程返回 OpResult 时以此标识结果语义，
 * 前端据 code + args 走 i18n 渲染，杜绝中文字符串硬编码比较。
 */
export type MsgCode =
  // 通用
  | 'msg.common.canceled'
  | 'msg.common.error'
  | 'msg.common.ok'
  // IDE
  | 'msg.ide.applyDone'
  | 'msg.ide.applyNeedRestart'
  | 'msg.ide.resetDone'
  | 'msg.ide.resetAllDone'
  | 'msg.ide.resetAllFailed'
  | 'msg.ide.notFound'
  | 'msg.ide.notWritable'
  | 'msg.ide.needClose'
  | 'msg.ide.parseError'
  | 'msg.ide.configInvalid'
  | 'msg.ide.pathInvalid'
  | 'msg.ide.manualAddOk'
  | 'msg.ide.incompatibleProtocol'
  | 'msg.ide.rowAmbiguous'
  // 供应商
  | 'msg.provider.saveOk'
  | 'msg.provider.removeOk'
  | 'msg.provider.missingFields'
  | 'msg.provider.duplicateName'
  | 'msg.provider.invalidBaseUrl'
  | 'msg.provider.fieldTooLong'
  | 'msg.provider.testOk'
  | 'msg.provider.testTimeout'
  | 'msg.provider.testAuthFailed'
  | 'msg.provider.testBadUrl'
  | 'msg.provider.testNetErr'
  | 'msg.provider.testHttpErr'
  | 'msg.provider.keyUnavailable'
  | 'msg.provider.exportOk'
  | 'msg.provider.importOk'
  | 'msg.provider.importFailed'
  | 'msg.provider.notFound'
  // 快照 / 备份 / 日志
  | 'msg.snapshot.createOk'
  | 'msg.snapshot.nameRequired'
  | 'msg.snapshot.notFound'
  | 'msg.snapshot.applyOk'
  | 'msg.snapshot.applyFailed'
  | 'msg.snapshot.removeOk'
  | 'msg.snapshot.exportOk'
  | 'msg.snapshot.importOk'
  | 'msg.snapshot.importFailed'
  | 'msg.backup.restoreOk'
  | 'msg.backup.restoreWarn'
  | 'msg.backup.restoreFailed'
  | 'msg.backup.restoreNotFound'
  | 'msg.backup.restoreNoTarget'
  | 'msg.backup.removeOk'
  | 'msg.backup.notFound'
  | 'msg.log.clearOk'
  | 'msg.log.exportOk'
  // 设置 / 代理 / 更新
  | 'msg.settings.saveOk'
  | 'msg.settings.dataDirChanged'
  | 'msg.settings.dataDirSame'
  | 'msg.settings.resetDone'
  | 'msg.settings.relaunchNeeded'
  | 'msg.proxy.started'
  | 'msg.proxy.stopped'
  | 'msg.proxy.error'
  | 'msg.proxy.errorPortInUse'
  | 'msg.update.available'
  | 'msg.update.notAvailable'
  | 'msg.update.downloaded'
  | 'msg.update.noFeed'
  | 'msg.update.error'

/**
 * 统一操作结果契约：所有会产生用户可见反馈的 IPC 操作均以此返回。
 * - ok：成功与否
 * - code：i18n 消息码（MsgCode），前端据此渲染提示
 * - args：消息码插值参数（如端口号、数量、路径等）
 * - data：成功时携带的业务数据
 * - canceled：用户主动取消系统对话框（导入/导出/选择目录等），前端应静默处理
 */
export interface OpResult<T = unknown> {
  ok: boolean
  code?: MsgCode
  args?: Record<string, string | number>
  data?: T
  canceled?: boolean
}

export interface Provider {
  id: string
  name: string
  protocol: Protocol
  /** 加密后的 apiKey，格式: enc:<iv>:<tag>:<data> */
  apiKey: string
  /** 明文密钥后 4 位，供前端 sk-****xxxx 脱敏展示（绝不含完整明文） */
  keyTail?: string
  baseUrl: string
  model: string
  group?: string
  createdAt: number
  updatedAt: number
}

/** 供应商三要素在目标载体中的落点（点路径 / 字段名 / 环境变量名），null 或缺省表示不写入 */
export interface FieldMap {
  apiKey?: string | null
  baseUrl?: string | null
  model?: string | null
}

/**
 * 存储策略：描述供应商信息应以何种载体写入目标 IDE。
 * - json：明文 JSON 配置文件（按点路径写入，如 Zed settings.json）
 * - sqlite：VS Code 系的 state.vscdb（ItemTable 里一行 JSON），用 sql.js 整库读写
 * - toml：TOML 配置（如 Codex config.toml）+ 可选 secretFile(JSON) 存 Key
 * - env：KEY=VALUE 文本（如 Gemini CLI 的 .env）
 */
export type StorageSpec =
  | { kind: 'json'; paths: string[]; fields: FieldMap }
  | {
      kind: 'sqlite'
      /** 候选数据库绝对路径（可含 ${ENV}），按优先级排列 */
      dbPaths: string[]
      table: string
      keyColumn: string
      valueColumn: string
      /** 已知行键（如 Cursor 的 cursorAuth）；缺省时用 probeContains 自适应探测 */
      rowKey?: string
      /** OpenAI 协议时，供应商字段在该行 JSON 值里的点路径 */
      valueFields: FieldMap
      /** Anthropic 协议时使用的字段映射（缺省则复用 valueFields） */
      anthropicValueFields?: FieldMap
      /** 自适应探测：命中这些特征键之一的 JSON 行即视为凭证槽位 */
      probeContains?: string[]
      /** 若原值为 DPAPI(safeStorage) 密文，则写回时镜像加密 */
      encryptSecret?: boolean
    }
  | {
      kind: 'toml'
      paths: string[]
      /** 顶层标量键，值支持 ${model} ${baseUrl} ${apiKey} 占位符 */
      scalars?: Record<string, string | number | boolean>
      /** 需写入的表段路径，如 ['model_providers', 'codeswitch'] */
      table?: string[]
      tableValues?: Record<string, string | number | boolean>
      /** Key 单独落到的 JSON 文件（如 Codex auth.json），field 为 JSON 键名 */
      secretFile?: { path: string; field: string }
    }
  | { kind: 'env'; paths: string[]; mapping: FieldMap }

/** IDE 自动化能力：auto=可一键写入；assist=生成配置+一键复制引导；manual=仅提示手动 */
export type IDECapability = 'auto' | 'assist' | 'manual'

export interface IDEAdapterDef {
  id: string
  name: string
  icon: string
  protocols: Protocol[]
  /** 候选配置文件绝对路径（可含环境变量占位），按优先级排列 */
  configPaths: string[]
  /** 检测是否安装：常见可执行文件/安装目录候选 */
  detectPaths: string[]
  /** 家目录探针：这些文件夹/文件存在即视为已安装或曾使用（跨盘符通用，最可靠） */
  homeMarkers?: string[]
  /** 存储策略：决定供应商信息如何落盘 */
  storage: StorageSpec
  /** IDE 进程名（含扩展名），用于写入前检测是否在运行 */
  processNames?: string[]
  /** 强制指定能力等级（缺省则按 storage 自动推断） */
  capability?: IDECapability
  /** 写入时在配置 JSON 根级别附加的固定字段（如协议标记） */
  extraWrite?: Record<string, unknown>
  /** 是否支持自动写入（false 表示纯手动配置型，UI 禁用应用按钮） */
  writable?: boolean
  /** 给用户的提示文本 i18n key（如 ide.note.cursor）；前端用 t(noteKey) 渲染，杜绝硬编码中文 */
  noteKey?: string
}

export type IDEStatus = 'default' | 'customized' | 'error' | 'missing'

export interface IDEState {
  id: string
  name: string
  installed: boolean
  status: IDEStatus
  configPath: string | null
  currentProviderId: string | null
  lastBackup: number | null
  /** 提示文本的 i18n key（来自适配器静态提示或扫描期动态错误）；前端用 t(noteKey) 渲染 */
  noteKey?: string
  /** 自动化能力，UI 据此决定按钮态与交互 */
  capability: IDECapability
  /** 目标 IDE 当前是否在运行（写入前需关闭） */
  running?: boolean
}

export interface BackupEntry {
  id: string
  ideId: string
  timestamp: number
  file: string
  /** 备份时配置文件的原路径（恢复目标）；旧数据可能缺失 */
  sourcePath?: string
  /** 伴随主文件一起备份的附属文件（如 state.vscdb 的 -wal/-shm），[原路径, 备份路径][] */
  extraFiles?: Array<{ source: string; backup: string }>
  reason: string
  size: number
}

export interface Snapshot {
  id: string
  name: string
  description?: string
  createdAt: number
  ideBindings: Record<string, { providerId: string | null }>
}

export interface LogEntry {
  id: string
  ts: number
  level: 'info' | 'warn' | 'error'
  action: string
  detail?: string
}

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

export interface AppSettings {
  theme: 'system' | 'dark' | 'light'
  locale: 'zh-CN' | 'en-US'
  autoLaunch: boolean
  dataDir: string
}

/** 本地转发网关配置 */
export interface ProxyConfig {
  /** 是否启用网关 */
  enabled: boolean
  /** 监听端口（127.0.0.1） */
  port: number
  /** 转发目标供应商 id（null 表示未选择） */
  providerId: string | null
}

/** 本地转发网关运行状态 */
export interface ProxyStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  providerId: string | null
  providerName: string | null
  error?: string
}

// 渲染进程通过 window.api 调用的类型
export interface API {
  ide: {
    scan(): Promise<IDEState[]>
    apply(ideId: string, providerId: string): Promise<OpResult>
    reset(ideId: string | 'all'): Promise<OpResult>
    manualAdd(ideId: string, configPath: string): Promise<OpResult>
    /** 检测目标 IDE 是否正在运行（sqlite/toml 写入前需关闭） */
    checkRunning(ideId: string): Promise<boolean>
    /** 为 assist 型 IDE 生成待写入的配置文本（供一键复制），前端从 data.text / data.targetPath 读取 */
    generateConfig(ideId: string, providerId: string): Promise<OpResult<{ text: string; targetPath?: string }>>
  }
  provider: {
    list(): Promise<Provider[]>
    /** 新增/编辑供应商：统一返回 OpResult<Provider>（成功 code=msg.provider.saveOk，data=落库后的 Provider；字段缺失 code=msg.provider.missingFields） */
    save(p: Partial<Provider> & { protocol: Protocol }): Promise<OpResult<Provider>>
    /** 删除供应商（并清理绑定/快照/网关引用）：成功 code=msg.provider.removeOk */
    remove(id: string): Promise<OpResult>
    test(id: string): Promise<OpResult<{ latencyMs?: number }>>
    /** 查询供应商被哪些 IDE 引用（删除前警示）：data.ideIds/ideNames 为本机绑定该供应商的 IDE */
    usage(id: string): Promise<OpResult<{ ideIds: string[]; ideNames: string[] }>>
    /** 导出全部供应商为 JSON 文件（含明文 Key，主进程弹保存对话框）；成功 code=msg.provider.exportOk，data=文件路径，args.count=数量 */
    export(): Promise<OpResult<string>>
    /** 从 JSON 文件导入供应商（主进程弹打开对话框）；成功 code=msg.provider.importOk（args.count），解析/校验失败 code=msg.provider.importFailed */
    import(): Promise<OpResult>
  }
  snapshot: {
    list(): Promise<Snapshot[]>
    /** 创建快照：统一返回 OpResult<Snapshot>（成功 code=msg.snapshot.createOk，data=新快照） */
    create(name: string, description?: string): Promise<OpResult<Snapshot>>
    apply(id: string): Promise<OpResult>
    remove(id: string): Promise<OpResult>
    /** 导出单个快照为 .csnap 文件（内嵌其引用的供应商，含明文 Key，主进程弹保存对话框）；成功 code=msg.snapshot.exportOk，data=文件路径 */
    export(id: string): Promise<OpResult<string>>
    /** 从 .csnap 文件导入快照（主进程弹打开对话框），自动导入内嵌供应商并重映射绑定；成功 code=msg.snapshot.importOk（args.count/args.name），失败 code=msg.snapshot.importFailed */
    import(): Promise<OpResult>
  }
  backup: {
    list(ideId?: string): Promise<BackupEntry[]>
    restore(backupId: string): Promise<OpResult>
    remove(backupId: string): Promise<OpResult>
  }
  log: {
    list(): Promise<LogEntry[]>
    clear(): Promise<OpResult>
    /** 导出当前已加载的日志为 txt 或 json（主进程弹保存对话框）；成功 code=msg.log.exportOk，data=文件路径，args.count=条数 */
    export(format: 'txt' | 'json'): Promise<OpResult<string>>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  proxy: {
    /** 获取网关状态（是否运行 / 端口 / URL / 目标供应商） */
    status(): Promise<ProxyStatus>
    /** 修改配置并按 enabled 启停（端口变化会重启）：透传 OpResult<ProxyStatus>，失败带消息码（如端口占用） */
    configure(patch: Partial<ProxyConfig>): Promise<OpResult<ProxyStatus>>
    /** 获取网关本地鉴权 token，供用户在客户端配置 Authorization: Bearer <token> */
    token(): Promise<string>
  }
  system: {
    pickFile(defaultPath?: string): Promise<string | null>
    openDataDir(): Promise<void>
    /** 在系统文件管理器中定位并选中指定文件 */
    openPath(targetPath: string): Promise<void>
    /** 当前应用版本号（app.getVersion，供关于区展示） */
    getVersion(): Promise<string>
    /** 更新状态：downloadedVersion 非空表示已有下载完成的更新待安装 */
    getUpdateState(): Promise<{ downloadedVersion: string }>
    /** 检查更新（事件驱动）：返回 OpResult，version 经 args.version 承载（available/notAvailable/noFeed/error） */
    checkUpdate(): Promise<OpResult>
    /** 安装已下载的更新并重启（quitAndInstall），对应 system:install-update（主进程注册） */
    installUpdate(): Promise<OpResult>
    /** 获取数据目录：current=实际生效目录，custom=用户自定义目录（未设置为 null） */
    getDataDir(): Promise<{ current: string; custom: string | null }>
    /** 选择并迁移到新的数据目录（弹目录选择框）；成功 code=msg.settings.dataDirChanged（data.needRestart=true 提示重启），选到当前目录 code=msg.settings.dataDirSame，其余失败 code=msg.common.error */
    setDataDir(): Promise<OpResult<{ needRestart?: boolean }>>
    /** 重置软件：清除 CodeSwitch 全部本地数据（供应商/快照/备份/日志/绑定/网关/设置） */
    resetAll(): Promise<OpResult>
    /** 重启应用（更改数据目录后生效） */
    relaunch(): Promise<void>
  }
}

declare global {
  interface Window {
    api: API
  }
}

// 图标组件类型（给渲染层用）
export type IconComponent = Component
