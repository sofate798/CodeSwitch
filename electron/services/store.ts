import Store from 'electron-store'
import type { Provider, Snapshot, AppSettings, BackupEntry } from '../shared/types'

interface Schema {
  providers: Provider[]
  snapshots: Snapshot[]
  settings: AppSettings
  backups: BackupEntry[]
  /** 各 IDE 当前状态（自定义后写入）；sqliteRowKey 记录定位到的数据库行键，供恢复时精准清除 */
  ideBindings: Record<string, { providerId: string | null; configPath: string | null; sqliteRowKey?: string }>
}

export const store = new Store<Schema>({
  defaults: {
    providers: [],
    snapshots: [],
    backups: [],
    ideBindings: {},
    settings: {
      theme: 'system',
      locale: 'zh-CN',
      autoLaunch: false,
      dataDir: ''
    }
  }
})
