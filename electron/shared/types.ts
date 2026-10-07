import type { Component } from 'vue'

export type Protocol = 'openai' | 'anthropic'

export interface Provider {
  id: string
  name: string
  protocol: Protocol
  /** 加密后的 apiKey，格式: enc:<iv>:<tag>:<data> */
  apiKey: string
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
  /** 给用户的备注（如新版 Cursor 配置存储位置说明） */
  note?: string
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
  note?: string
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

// 渲染进程通过 window.api 调用的类型
export interface API {
  ide: {
    scan(): Promise<IDEState[]>
    apply(ideId: string, providerId: string): Promise<{ ok: boolean; message: string; needCloseIde?: boolean }>
    reset(ideId: string | 'all'): Promise<{ ok: boolean; message: string }>
    manualAdd(ideId: string, configPath: string): Promise<{ ok: boolean; message: string }>
    /** 检测目标 IDE 是否正在运行（sqlite/toml 写入前需关闭） */
    checkRunning(ideId: string): Promise<boolean>
    /** 为 assist 型 IDE 生成待写入的配置文本（供一键复制） */
    generateConfig(ideId: string, providerId: string): Promise<{ ok: boolean; message: string; text?: string; targetPath?: string }>
  }
  provider: {
    list(): Promise<Provider[]>
    save(p: Partial<Provider> & { protocol: Protocol }): Promise<Provider>
    remove(id: string): Promise<void>
    test(id: string): Promise<TestResult>
    revealKey(id: string): Promise<string>
    /** 导出全部供应商为 JSON 文件（含明文 Key，主进程弹保存对话框） */
    export(): Promise<{ ok: boolean; message: string; count?: number }>
    /** 从 JSON 文件导入供应商（主进程弹打开对话框），返回导入数量 */
    import(): Promise<{ ok: boolean; message: string; count?: number }>
  }
  snapshot: {
    list(): Promise<Snapshot[]>
    create(name: string, description?: string): Promise<Snapshot>
    apply(id: string): Promise<{ ok: boolean; message: string }>
    remove(id: string): Promise<void>
  }
  backup: {
    list(ideId?: string): Promise<BackupEntry[]>
    restore(backupId: string): Promise<{ ok: boolean; message: string }>
    remove(backupId: string): Promise<void>
  }
  log: {
    list(): Promise<LogEntry[]>
    clear(): Promise<void>
  }
  settings: {
    get(): Promise<AppSettings>
    set(patch: Partial<AppSettings>): Promise<AppSettings>
  }
  system: {
    pickFile(defaultPath?: string): Promise<string | null>
    openDataDir(): Promise<void>
    /** 在系统文件管理器中定位并选中指定文件 */
    openPath(targetPath: string): Promise<void>
    checkUpdate(): Promise<{ pending: boolean; available: boolean; version?: string; message: string }>
  }
}

declare global {
  interface Window {
    api: API
  }
}

// 图标组件类型（给渲染层用）
export type IconComponent = Component
