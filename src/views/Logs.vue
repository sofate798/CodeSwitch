<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import { NButton, NSpace, NEmpty, useDialog } from 'naive-ui'
import { TrashOutline as IconTrashOutline, DownloadOutline as IconDownload } from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { showResult } = useResult()

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

    <div class="log-list">
      <div v-for="l in store.logs" :key="l.id" class="log-row">
        <span class="log-level" :class="l.level">{{ l.level }}</span>
        <span class="log-action">{{ l.action }}</span>
        <span class="log-detail">{{ l.detail }}</span>
        <span class="log-time">{{ fmt(l.ts) }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; margin-bottom: 16px; }
.log-list { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; }
.log-row { display: flex; align-items: center; gap: 10px; padding: 6px 8px; border-radius: 4px; }
.log-row:hover { background: var(--bg-hover); }
.log-action { font-weight: 500; min-width: 120px; }
.log-detail { color: var(--text-secondary); flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.log-time { color: var(--text-secondary); font-size: 11px; font-family: monospace; }
.log-level {
  font-size: 10px; font-weight: 600; padding: 2px 6px; border-radius: 3px; min-width: 48px; text-align: center;
}
.log-level.info { background: #3b82f622; color: #60a5fa; }
.log-level.warn { background: #f59e0b22; color: #f59e0b; }
.log-level.error { background: #ef444422; color: #ef4444; }
</style>
