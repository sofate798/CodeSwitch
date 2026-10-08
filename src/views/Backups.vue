<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard, NButton, NSpace, NTag, NSelect, NEmpty, useDialog
} from 'naive-ui'
import {
  RefreshOutline as IconRefresh, TrashOutline as IconTrashOutline,
  TimeOutline as IconTimeOutline, ArchiveOutline as IconArchiveOutline
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import type { BackupEntry } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { message, showResult } = useResult()

const backups = ref<BackupEntry[]>([])
const ideFilter = ref<string | null>(null)
const restoring = ref<string | null>(null)

const ideOptions = ref<{ label: string; value: string }[]>([])

async function load() {
  backups.value = await window.api.backup.list(ideFilter.value || undefined)
}

onMounted(async () => {
  await store.refreshAll()
  // 从扫描结果构建筛选选项（含备份对应但未安装的 IDE 也一并展示）
  const scanned = new Map(store.ides.map((i) => [i.id, i.name]))
  const all = await window.api.backup.list()
  const names = new Map(all.map((b) => [b.ideId, scanned.get(b.ideId) ?? b.ideId]))
  ideOptions.value = [
    { label: t('backups.allIdes'), value: '' },
    ...Array.from(names.entries()).map(([id, name]) => ({ label: name, value: id }))
  ]
  ideFilter.value = ''
  await load()
})

function ideName(ideId: string): string {
  return store.ides.find((i) => i.id === ideId)?.name ?? ideId
}

function reasonLabel(reason: string): string {
  if (reason.startsWith('apply')) return t('backups.reasonApply')
  if (reason.startsWith('reset')) return t('backups.reasonReset')
  return t('backups.reasonManual')
}

function fmtSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString(store.settings.locale, { hour12: false })
}

function restore(b: BackupEntry) {
  dialog.warning({
    title: t('backups.restoreTitle'),
    content: t('backups.restoreConfirm', { ide: ideName(b.ideId) }),
    positiveText: t('backups.restore'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      restoring.value = b.id
      try {
        const r = await window.api.backup.restore(b.id)
        showResult(r)
        // 恢复成功但检测到残留 -wal（Sam-M4 数据安全告警）：单独弱提醒，不阻断
        if (r.ok && r.args?.warning) message.warning(t('msg.backup.restoreWarn', { warning: String(r.args.warning) }))
        await store.refreshAll()
        await load()
      } finally {
        restoring.value = null
      }
    }
  })
}

function remove(b: BackupEntry) {
  dialog.warning({
    title: t('backups.deleteTitle'),
    content: t('backups.deleteConfirm'),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      showResult(await window.api.backup.remove(b.id))
      await load()
    }
  })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('backups.title') }}</div>
        <div class="page-sub">{{ t('backups.subtitle') }}</div>
      </div>
      <n-space align="center" :size="8">
        <n-select
          v-model:value="ideFilter"
          :options="ideOptions"
          size="small"
          style="width: 200px"
          @update:value="load"
        />
        <n-button size="small" @click="load">
          <template #icon><n-icon :component="IconRefresh" :size="14" /></template>
          {{ t('common.refresh') }}
        </n-button>
      </n-space>
    </div>

    <n-empty v-if="backups.length === 0" :description="t('backups.empty')" />

    <div class="bak-list">
      <n-card v-for="b in backups" :key="b.id" size="small" :bordered="false" class="bak-card">
        <div class="bak-main">
          <n-icon :component="IconArchiveOutline" :size="18" />
          <div class="bak-info">
            <div class="bak-line1">
              <span class="bak-ide">{{ ideName(b.ideId) }}</span>
              <n-tag size="tiny" :bordered="false" round>{{ reasonLabel(b.reason) }}</n-tag>
              <span class="bak-size">{{ fmtSize(b.size) }}</span>
            </div>
            <div class="bak-line2">
              <n-icon :component="IconTimeOutline" :size="12" />
              <span>{{ fmt(b.timestamp) }}</span>
            </div>
            <div class="bak-path" :title="b.sourcePath ?? b.file">{{ b.sourcePath ?? b.file }}</div>
          </div>
        </div>
        <div class="bak-actions">
          <n-button size="tiny" type="primary" :loading="restoring === b.id" @click="restore(b)">
            {{ t('backups.restore') }}
          </n-button>
          <n-button size="tiny" type="error" @click="remove(b)">
            <template #icon><n-icon :component="IconTrashOutline" :size="12" /></template>
          </n-button>
        </div>
      </n-card>
    </div>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.bak-list { display: flex; flex-direction: column; gap: 8px; }
.bak-card { background: var(--bg-card); }
.bak-card :deep(.n-card__content) { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.bak-main { display: flex; align-items: flex-start; gap: 10px; min-width: 0; }
.bak-info { min-width: 0; }
.bak-line1 { display: flex; align-items: center; gap: 8px; }
.bak-ide { font-weight: 600; font-size: 13.5px; }
.bak-size { font-size: 11px; color: var(--text-secondary); }
.bak-line2 { display: flex; align-items: center; gap: 4px; font-size: 11.5px; color: var(--text-secondary); margin-top: 2px; }
.bak-path { font-size: 11px; color: var(--text-secondary); font-family: monospace; margin-top: 2px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 560px; }
.bak-actions { display: flex; gap: 6px; flex-shrink: 0; }
</style>
