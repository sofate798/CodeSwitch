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
  /** 供应商字段在配置 JSON 中的点路径；null 表示该 IDE 不写入对应字段 */
  fields: {
    apiKey: string | null
    baseUrl: string | null
    model: string | null
  }
  /** 写入时在配置 JSON 根级别附加的固定字段（如协议标记） */
  extraWrite?: Record<string, unknown>
  /** 是否支持自动写入（false 表示配置为 SQLite/TOML 等非 JSON，需手动配置） */
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
}

export interface BackupEntry {
  id: string
  ideId: string
  timestamp: number
  file: string
  /** 备份时配置文件的原路径（恢复目标）；旧数据可能缺失 */
  sourcePath?: string
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
    apply(ideId: string, providerId: string): Promise<{ ok: boolean; message: string }>
    reset(ideId: string | 'all'): Promise<{ ok: boolean; message: string }>
    manualAdd(ideId: string, configPath: string): Promise<{ ok: boolean; message: string }>
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
