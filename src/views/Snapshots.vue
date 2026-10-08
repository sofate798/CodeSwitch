<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NTimeline, NTimelineItem, NButton, NSpace, NTag, NModal, NInput, NEmpty, NIcon, NTooltip,
  useDialog
} from 'naive-ui'
import {
  AddOutline as IconAddOutline, TrashOutline as IconTrashOutline,
  CheckmarkDoneOutline as IconCheckmarkDone, DownloadOutline as IconExport,
  CloudUploadOutline as IconImport
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import type { Snapshot } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { message, showResult } = useResult()

const modalShow = ref(false)
const name = ref('')
const desc = ref('')
const applyingId = ref<string | null>(null)
const creating = ref(false)

// B6：快照绑定明细（IDE → 供应商）有界展示，最多 6 条 + 溢出计数；供应商已删除时显占位
const MAX_BINDING_DISPLAY = 6
function bindingLines(s: Snapshot) {
  const entries = Object.entries(s.ideBindings ?? {})
  const lines = entries.slice(0, MAX_BINDING_DISPLAY).map(([ideId, binding]) => {
    const ideName = store.ides.find((i) => i.id === ideId)?.name ?? ideId
    const providerId = binding?.providerId ?? null
    // 无 providerId → 快照记录的是默认态；有 id 但查不到 → 供应商已被删除
    const label = !providerId
      ? t('home.defaultProvider')
      : store.providers.find((p) => p.id === providerId)?.name ?? t('snapshots.providerRemoved')
    return `${ideName} → ${label}`
  })
  return { lines, extra: entries.length - lines.length }
}

async function create() {
  if (!name.value.trim()) {
    message.warning(t('snapshots.nameRequired'))
    return
  }
  // Jack-Low15：创建加 loading + try/catch
  creating.value = true
  try {
    const r = await window.api.snapshot.create(name.value, desc.value)
    // 统一 OpResult<Snapshot>：仅成功才关弹窗/清空/刷新；IPC reject 兜底不静默
    if (showResult(r)) {
      modalShow.value = false
      name.value = ''
      desc.value = ''
      await store.refreshAll()
    }
  } catch {
    message.error(t('msg.common.error'))
  } finally {
    creating.value = false
  }
}

// Jack-Med6：应用前二次确认。applySnapshot 会先把“当前已绑定”的 IDE 全部 reset 再按快照应用，
// 因此影响数 = 快照绑定 ∩当前已绑定 的并集，不能只算快照内数量（会低估破坏半径）。
function doApply(s: Snapshot) {
  const snapIds = Object.keys(s.ideBindings ?? {})
  const boundIds = store.ides.filter((i) => i.currentProviderId).map((i) => i.id)
  const count = new Set([...snapIds, ...boundIds]).size
  dialog.warning({
    title: t('snapshots.applyConfirmTitle'),
    content: t('snapshots.applyConfirm', { name: s.name, count }),
    positiveText: t('common.apply'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      applyingId.value = s.id
      try {
        showResult(await window.api.snapshot.apply(s.id))
        await store.refreshAll()
      } finally {
        applyingId.value = null
      }
    }
  })
}

function remove(s: Snapshot) {
  dialog.warning({
    title: t('snapshots.deleteTitle'), content: t('snapshots.deleteConfirm'),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      showResult(await window.api.snapshot.remove(s.id))
      await store.refreshAll()
    }
  })
}

// B1：快照导出会内嵌引用供应商（含明文 Key），先二次确认再走 IPC
function doExport(s: Snapshot) {
  dialog.warning({
    title: t('snapshots.exportWarnTitle'),
    content: t('snapshots.exportWarn'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      showResult(await window.api.snapshot.export(s.id))
    }
  })
}

async function doImport() {
  if (showResult(await window.api.snapshot.import())) await store.refreshAll()
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString(store.settings.locale === 'zh-CN' ? 'zh-CN' : 'en-US', { hour12: false })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('snapshots.title') }}</div>
        <div class="page-sub">{{ t('snapshots.subtitle') }}</div>
      </div>
      <n-space :size="8">
        <n-button @click="doImport">
          <template #icon><n-icon :component="IconImport" :size="16" /></template>
          {{ t('snapshots.importBtn') }}
        </n-button>
        <n-button @click="modalShow = true">
          <template #icon><n-icon :component="IconAddOutline" :size="16" /></template>
          {{ t('snapshots.createTitle') }}
        </n-button>
      </n-space>
    </div>

    <n-empty v-if="store.snapshots.length === 0" :description="t('snapshots.empty')" />

    <!-- Jack-Med10：卡片列表改为 n-timeline 时间线视图（PRD 要求） -->
    <n-timeline v-else class="snap-timeline">
      <n-timeline-item
        v-for="s in store.snapshots"
        :key="s.id"
        type="success"
        :time="fmt(s.createdAt)"
        :title="s.name"
      >
        <div class="snap-body">
          <n-tag size="tiny" :bordered="false">{{ t('snapshots.ideCount', { count: Object.keys(s.ideBindings ?? {}).length }) }}</n-tag>
          <div v-if="s.description" class="snap-desc">{{ s.description }}</div>
          <div v-if="bindingLines(s).lines.length" class="snap-detail">
            <div class="snap-detail-title">{{ t('snapshots.detail') }}</div>
            <div v-for="line in bindingLines(s).lines" :key="line" class="snap-detail-line">{{ line }}</div>
            <div v-if="bindingLines(s).extra > 0" class="snap-detail-line more">… +{{ bindingLines(s).extra }}</div>
          </div>
          <div class="snap-actions">
            <n-button size="tiny" type="primary" :loading="applyingId === s.id" @click="doApply(s)">
              <template #icon><n-icon :component="IconCheckmarkDone" :size="12" /></template>{{ t('common.apply') }}
            </n-button>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" :aria-label="t('snapshots.exportBtn')" @click="doExport(s)">
                  <template #icon><n-icon :component="IconExport" :size="12" /></template>
                </n-button>
              </template>
              {{ t('snapshots.exportBtn') }}
            </n-tooltip>
            <n-tooltip trigger="hover">
              <template #trigger>
                <n-button size="tiny" type="error" :aria-label="t('common.delete')" @click="remove(s)">
                  <template #icon><n-icon :component="IconTrashOutline" :size="12" /></template>
                </n-button>
              </template>
              {{ t('common.delete') }}
            </n-tooltip>
          </div>
        </div>
      </n-timeline-item>
    </n-timeline>

    <n-modal v-model:show="modalShow" preset="card" style="width: 420px" :title="t('snapshots.createTitle')">
      <n-space vertical>
        <n-input v-model:value="name" :placeholder="t('snapshots.namePlaceholder')" @keydown.enter.prevent="create" />
        <n-input v-model:value="desc" type="textarea" :placeholder="t('snapshots.descPlaceholder')" />
        <n-space justify="end">
          <n-button @click="modalShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="creating" @click="create">{{ t('common.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; margin-bottom: 16px; }
.snap-timeline { padding-top: 6px; }
.snap-body { display: flex; flex-direction: column; gap: 8px; }
.snap-desc { font-size: 12px; color: var(--text-secondary); }
.snap-detail { font-size: 12px; color: var(--text-secondary); border-left: 2px solid var(--border); padding-left: 8px; }
.snap-detail-title { color: var(--text-secondary); margin-bottom: 2px; }
.snap-detail-line { color: var(--text-primary); font-family: monospace; font-size: 11px; line-height: 1.6; }
.snap-detail-line.more { color: var(--text-secondary); }
.snap-actions { display: flex; gap: 6px; }
</style>
