import { contextBridge } from 'electron'

/**
 * 通过 contextBridge 暴露安全的 IPC API 给渲染进程。
 * 渲染进程通过 window.api.* 调用，不直接接触 ipcRenderer。
 */
contextBridge.exposeInMainWorld('api', {
  ide: {
    scan: () => ipcInvoke('ide:scan'),
    apply: (ideId: string, providerId: string) => ipcInvoke('ide:apply', ideId, providerId),
    reset: (ideId: string) => ipcInvoke('ide:reset', ideId),
    manualAdd: (ideId: string, path: string) => ipcInvoke('ide:manual-add', ideId, path)
  },
  provider: {
    list: () => ipcInvoke('provider:list'),
    save: (p: any) => ipcInvoke('provider:save', p),
    remove: (id: string) => ipcInvoke('provider:remove', id),
    test: (id: string) => ipcInvoke('provider:test', id),
    revealKey: (id: string) => ipcInvoke('provider:reveal-key', id),
    export: () => ipcInvoke('provider:export'),
    import: () => ipcInvoke('provider:import')
  },
  snapshot: {
    list: () => ipcInvoke('snapshot:list'),
    create: (name: string, desc?: string) => ipcInvoke('snapshot:create', name, desc ?? ''),
    apply: (id: string) => ipcInvoke('snapshot:apply', id),
    remove: (id: string) => ipcInvoke('snapshot:remove', id)
  },
  backup: {
    list: (ideId?: string) => ipcInvoke('backup:list', ideId),
    restore: (backupId: string) => ipcInvoke('backup:restore', backupId),
    remove: (backupId: string) => ipcInvoke('backup:remove', backupId)
  },
  log: {
    list: () => ipcInvoke('log:list'),
    clear: () => ipcInvoke('log:clear')
  },
  settings: {
    get: () => ipcInvoke('settings:get'),
    set: (patch: any) => ipcInvoke('settings:set', patch)
  },
  system: {
    pickFile: (defaultPath?: string) => ipcInvoke('system:pick-file', defaultPath),
    openDataDir: () => ipcInvoke('system:open-data-dir'),
    checkUpdate: () => ipcInvoke('system:check-update')
  }
})

// 独立函数避免在 contextBridge 里直接引用 ipcRenderer（类型安全）
import { ipcRenderer } from 'electron'
function ipcInvoke(channel: string, ...args: unknown[]) {
  return ipcRenderer.invoke(channel, ...args)
}
