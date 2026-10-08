import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { IDEState, Provider, Snapshot, LogEntry, AppSettings } from '../../electron/shared/types'
import { i18n, setLocale } from '../i18n'

export const useAppStore = defineStore('app', () => {
  const ides = ref<IDEState[]>([])
  const providers = ref<Provider[]>([])
  const snapshots = ref<Snapshot[]>([])
  const logs = ref<LogEntry[]>([])
  const settings = ref<AppSettings>({ theme: 'system', locale: 'zh-CN', autoLaunch: false, dataDir: '' })

  // Jack-High3：全局加载/错误态，供视图（F2）渲染加载/错误/空态。
  // error 存放 i18n 消息码（MsgCode），由视图经 t() 本地化展示。
  const loading = ref(false)
  const error = ref<string | null>(null)

  const installedIDEs = computed(() => ides.value.filter((i) => i.installed))
  const customizedCount = computed(() => ides.value.filter((i) => i.status === 'customized').length)

  // 采用 allSettled：任一分片失败也保留其余成功数据；本函数绝不向外抛异常，
  // 避免 App.vue onMounted 产生未处理的 Promise rejection。
  async function refreshAll() {
    loading.value = true
    error.value = null
    try {
      const [i, p, s, l] = await Promise.allSettled([
        window.api.ide.scan(),
        window.api.provider.list(),
        window.api.snapshot.list(),
        window.api.log.list()
      ])
      let failed = false
      if (i.status === 'fulfilled') ides.value = i.value
      else failed = true
      if (p.status === 'fulfilled') providers.value = p.value
      else failed = true
      if (s.status === 'fulfilled') snapshots.value = s.value
      else failed = true
      if (l.status === 'fulfilled') logs.value = l.value
      else failed = true
      // 部分或全部失败：设置错误码，成功分片已写入对应 ref，视图仍可展示其余数据。
      error.value = failed ? 'msg.common.error' : null
    } catch {
      // 兜底（如 window.api 缺失等异常），保证不向外抛。
      error.value = 'msg.common.error'
    } finally {
      loading.value = false
    }
  }

  // settings:get 是值型通道（载荷为裸 AppSettings），主进程失败时会真实 reject。
  // 本函数在 App.vue onMounted 直接调用且无人接 rejection，故必须就地兜底：
  // 失败保留当前值（首屏即默认值），不把原始异常文本冒泡到控制台。
  async function refreshSettings() {
    try {
      settings.value = await window.api.settings.get()
    } catch {
      error.value = 'msg.common.error'
      return
    }
    // Jack-Med13：界面语言以后端设置为单一数据源，localStorage('cs-locale') 仅作首屏回退。
    const target = settings.value.locale
    if (target && i18n.global.locale.value !== target) {
      setLocale(target)
    }
  }

  function providerName(id: string | null): string {
    if (!id) return ''
    return providers.value.find((p) => p.id === id)?.name ?? ''
  }

  return {
    ides, providers, snapshots, logs, settings,
    loading, error,
    installedIDEs, customizedCount,
    refreshAll, refreshSettings, providerName
  }
})
