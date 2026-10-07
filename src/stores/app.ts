import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { IDEState, Provider, Snapshot, LogEntry, AppSettings } from '../../electron/shared/types'

export const useAppStore = defineStore('app', () => {
  const ides = ref<IDEState[]>([])
  const providers = ref<Provider[]>([])
  const snapshots = ref<Snapshot[]>([])
  const logs = ref<LogEntry[]>([])
  const settings = ref<AppSettings>({ theme: 'system', locale: 'zh-CN', autoLaunch: false, dataDir: '' })

  const installedIDEs = computed(() => ides.value.filter((i) => i.installed))
  const customizedCount = computed(() => ides.value.filter((i) => i.status === 'customized').length)

  async function refreshAll() {
    const [i, p, s, l] = await Promise.all([
      window.api.ide.scan(),
      window.api.provider.list(),
      window.api.snapshot.list(),
      window.api.log.list()
    ])
    ides.value = i
    providers.value = p
    snapshots.value = s
    logs.value = l
  }

  async function refreshSettings() {
    settings.value = await window.api.settings.get()
  }

  function providerName(id: string | null): string {
    if (!id) return ''
    return providers.value.find((p) => p.id === id)?.name ?? ''
  }

  return {
    ides, providers, snapshots, logs, settings,
    installedIDEs, customizedCount,
    refreshAll, refreshSettings, providerName
  }
})
