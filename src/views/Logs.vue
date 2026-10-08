<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { NButton, NSpace, NEmpty, NInput, NSelect, useDialog } from 'naive-ui'
import { TrashOutline as IconTrashOutline, DownloadOutline as IconDownload } from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import type { LogEntry } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { showResult } = useResult()

// B5：关键词检索（action/detail，大小写不敏感）+ 级别过滤
const keyword = ref('')
const levelFilter = ref<'all' | LogEntry['level']>('all')

const levelOptions = computed(() => [
  { label: t('logs.levelAll'), value: 'all' },
  { label: t('logs.levelInfo'), value: 'info' },
  { label: t('logs.levelWarn'), value: 'warn' },
  { label: t('logs.levelError'), value: 'error' }
])

const levelLabel = (level: LogEntry['level']) =>
  level === 'error' ? t('logs.levelError') : level === 'warn' ? t('logs.levelWarn') : t('logs.levelInfo')

const filteredLogs = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return store.logs.filter((l) => {
    if (levelFilter.value !== 'all' && l.level !== levelFilter.value) return false
    if (!kw) return true
    return l.action.toLowerCase().includes(kw) || (l.detail ?? '').toLowerCase().includes(kw)
  })
})

// 筛选生效且无命中 -> 专属空态；日志本身为空 -> 全局空态
const noMatch = computed(() => store.logs.length > 0 && filteredLogs.value.length === 0)

function fmt(ts: number) {
  return new Date(ts).toLocaleString(store.settings.locale === 'zh-CN' ? 'zh-CN' : 'en-US', { hour12: false })
}
async function doExport(format: 'txt' | 'json') {
  showResult(await window.api.log.export(format))
}
function clear() {
  dialog.warning({
    title: t('logs.clearTitle'), content: t('logs.clearConfirm'),
    positiveText: t('logs.clear'), negativeText: t('common.cancel'),
    onPositiveClick: async () => { showResult(await window.api.log.clear()); await store.refreshAll() }
  })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('logs.title') }}</div>
        <div class="page-sub">{{ t('logs.subtitle') }}</div>
      </div>
      <n-space :size="8">
        <n-button size="small" :disabled="store.logs.length === 0" @click="doExport('txt')">
          <template #icon><n-icon :component="IconDownload" :size="14" /></template>{{ t('logs.exportTxt') }}
        </n-button>
        <n-button size="small" :disabled="store.logs.length === 0" @click="doExport('json')">
          <template #icon><n-icon :component="IconDownload" :size="14" /></template>{{ t('logs.exportJson') }}
        </n-button>
        <n-button size="small" @click="clear">
          <template #icon><n-icon :component="IconTrashOutline" :size="14" /></template>{{ t('logs.clear') }}
        </n-button>
      </n-space>
    </div>

    <n-empty v-if="store.logs.length === 0" :description="t('logs.empty')" />

    <template v-else>
      <div class="log-toolbar">
        <n-input
          v-model:value="keyword"
          size="small"
          clearable
          :placeholder="t('logs.searchPlaceholder')"
          style="width: 260px"
        />
        <n-select
          v-model:value="levelFilter"
          size="small"
          :options="levelOptions"
          style="width: 130px"
        />
        <span class="log-count">{{ t('logs.count', { total: store.logs.length, shown: filteredLogs.length }) }}</span>
      </div>

      <n-empty v-if="noMatch" :description="t('logs.noMatch')" style="margin-top: 32px" />

      <div v-else class="log-list">
        <div v-for="l in filteredLogs" :key="l.id" class="log-row">
          <span class="log-level" :class="l.level">{{ levelLabel(l.level) }}</span>
          <span class="log-action">{{ l.action }}</span>
          <span class="log-detail" :title="l.detail">{{ l.detail }}</span>
          <span class="log-time">{{ fmt(l.ts) }}</span>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; margin-bottom: 16px; }
.log-toolbar { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.log-count { font-size: 12px; color: var(--text-secondary); white-space: nowrap; }
.log-list { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.log-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 4px; }
.log-row:hover { background: var(--bg-hover); }
.log-action { font-weight: 500; min-width: 120px; }
.log-detail { color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-time { color: var(--text-secondary); font-size: 11px; font-family: monospace; }
.log-level {
  font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; min-width: 48px; text-align: center;
}
.log-level.info { background: var(--info-soft); color: var(--info); }
.log-level.warn { background: var(--warning-soft); color: var(--warning); }
.log-level.error { background: var(--danger-soft); color: var(--danger); }
</style>
