import Store from 'electron-store'
import type { Provider, Snapshot, AppSettings, BackupEntry, ProxyConfig } from '../shared/types'

interface Schema {
  providers: Provider[]
  snapshots: Snapshot[]
  settings: AppSettings
  backups: BackupEntry[]
  /** 本地转发网关配置（OpenAI/Anthropic 兼容代理） */
  proxy: ProxyConfig
  /**
   * 本地转发网关的鉴权 token（Alex-H4）。
   * 仅 CodeSwitch 内部与用户显式配置知晓；首次启动网关时生成并持久化。
   * 不属于 ProxyConfig（该类型由 shared/types.ts 定义），单独成键避免污染网关配置结构。
   */
  proxyToken: string
  /** 各 IDE 当前状态（自定义后写入）；sqliteRowKey 记录定位到的数据库行键，供恢复时精准清除 */
  ideBindings: Record<string, { providerId: string | null; configPath: string | null; sqliteRowKey?: string }>
}

export const store = new Store<Schema>({
  defaults: {
    providers: [],
    snapshots: [],
    backups: [],
    ideBindings: {},
    proxyToken: '',
    proxy: {
      enabled: false,
      port: 8787,
      providerId: null
    },
    settings: {
      theme: 'system',
      locale: 'zh-CN',
      autoLaunch: false,
      dataDir: ''
    }
  }
})

/**
 * 串行写队列（Sam-M6）。
 *
 * electron-store 的 set 是同步落盘的，单次读写天然原子；风险只出现在
 * 「get → (await 异步) → set」这类跨 await 的读改写序列上（如 provider:remove、
 * system:reset-all 会连续改多个键）。runExclusive 把这类多键操作排成一条链，
 * 保证同一时刻只有一个临界区在执行，消除并发读改写竞态。
 *
 * 用法（handler 侧由 B4 调用）：
 *   await runExclusive(() => { const p = store.get('providers'); ...; setMany([...]) })
 */
let chain: Promise<unknown> = Promise.resolve()

export function runExclusive<T>(task: () => T | Promise<T>): Promise<T> {
  const run = chain.then(task, task)
  // 无论成功失败都要推进链条，且吞掉错误避免污染后续任务
  chain = run.then(
    () => undefined,
    () => undefined
  )
  return run
}

/** 在串行队列内对 store 做一次读改写事务（便于多键原子更新） */
export function mutate<T>(fn: (s: Store<Schema>) => T | Promise<T>): Promise<T> {
  return runExclusive(() => fn(store))
}

/**
 * 批量写入：在同一临界区内连续 set 多个键，尽量避免多次磁盘往返造成的中间态被观察到。
 * 传入键值对数组，按顺序写入。
 */
export function setMany(entries: Array<[keyof Schema, unknown]>): void {
  for (const [k, v] of entries) store.set(k as never, v as never)
}
