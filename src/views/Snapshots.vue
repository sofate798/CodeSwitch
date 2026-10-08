<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NTimeline, NTimelineItem, NButton, NSpace, NTag, NModal, NInput, NEmpty, NIcon,
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

async function doExport(s: Snapshot) {
  showResult(await window.api.snapshot.export(s.id))
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
          <div class="snap-actions">
            <n-button size="tiny" type="primary" :loading="applyingId === s.id" @click="doApply(s)">
              <template #icon><n-icon :component="IconCheckmarkDone" :size="12" /></template>{{ t('common.apply') }}
            </n-button>
            <n-button size="tiny" @click="doExport(s)" :title="t('snapshots.exportBtn')">
              <template #icon><n-icon :component="IconExport" :size="12" /></template>
            </n-button>
            <n-button size="tiny" type="error" @click="remove(s)" :title="t('common.delete')">
              <template #icon><n-icon :component="IconTrashOutline" :size="12" /></template>
            </n-button>
          </div>
        </div>
      </n-timeline-item>
    </n-timeline>

    <n-modal v-model:show="modalShow" preset="card" style="width: 420px" :title="t('snapshots.createTitle')">
      <n-space vertical>
        <n-input v-model:value="name" :placeholder="t('snapshots.namePlaceholder')" />
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
.page-head { display: flex; justify-content: space-between; margin-bottom: 20px; }
.snap-timeline { padding-top: 6px; }
.snap-body { display: flex; flex-direction: column; gap: 8px; }
.snap-desc { font-size: 12px; color: var(--text-secondary); }
.snap-actions { display: flex; gap: 6px; }
</style>
