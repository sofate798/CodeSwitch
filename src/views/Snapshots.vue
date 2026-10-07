<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard, NButton, NSpace, NTag, NModal, NInput, NEmpty, useMessage, useDialog
} from 'naive-ui'
import { AddOutline as IconAddOutline, CameraOutline as IconCameraOutline, TrashOutline as IconTrashOutline, CheckmarkDoneOutline as IconCheckmarkDone } from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const modalShow = ref(false)
const name = ref('')
const desc = ref('')
const applyingId = ref<string | null>(null)

async function create() {
  if (!name.value.trim()) {
    message.warning(t('snapshots.nameRequired'))
    return
  }
  await window.api.snapshot.create(name.value, desc.value)
  message.success(t('common.add'))
  modalShow.value = false
  name.value = ''; desc.value = ''
  await store.refreshAll()
}

function apply(id: string) {
  applyingId.value = id
  window.api.snapshot.apply(id).then(async (r) => {
    r.ok ? message.success(t('snapshots.applySuccess', { name: store.snapshots.find(s => s.id === id)?.name ?? '' }))
         : message.error(t('snapshots.applyFailed', { errors: r.message }))
    await store.refreshAll()
  }).finally(() => { applyingId.value = null })
}

function remove(id: string) {
  dialog.warning({
    title: t('snapshots.deleteTitle'), content: t('snapshots.deleteConfirm'),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await window.api.snapshot.remove(id)
      await store.refreshAll()
    }
  })
}

function fmt(ts: number) {
  return new Date(ts).toLocaleString(t('settings.locale') === 'zh-CN' ? 'zh-CN' : 'en-US', { hour12: false })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('snapshots.title') }}</div>
        <div class="page-sub">{{ t('snapshots.subtitle') }}</div>
      </div>
      <n-button type="primary" @click="modalShow = true">
        <template #icon><n-icon :component="IconAddOutline" :size="16" /></template>
        {{ t('snapshots.createTitle') }}
      </n-button>
    </div>

    <n-empty v-if="store.snapshots.length === 0" :description="t('snapshots.empty')" />

    <div class="snap-list">
      <n-card v-for="s in store.snapshots" :key="s.id" size="small" :bordered="false" class="snap-card">
        <div class="snap-head">
          <n-icon :component="IconCameraOutline" :size="18" color="#60a5fa" />
          <span class="snap-name">{{ s.name }}</span>
          <n-tag size="tiny" :bordered="false">{{ t('snapshots.ideCount', { count: Object.keys(s.ideBindings).length }) }}</n-tag>
        </div>
        <div v-if="s.description" class="snap-desc">{{ s.description }}</div>
        <div class="snap-time">{{ fmt(s.createdAt) }}</div>
        <div class="snap-actions">
          <n-button size="tiny" type="primary" :loading="applyingId === s.id" @click="apply(s.id)">
            <template #icon><n-icon :component="IconCheckmarkDone" :size="12" /></template>{{ t('common.apply') }}
          </n-button>
          <n-button size="tiny" type="error" @click="remove(s.id)">
            <template #icon><n-icon :component="IconTrashOutline" :size="12" /></template>
          </n-button>
        </div>
      </n-card>
    </div>

    <n-modal v-model:show="modalShow" preset="card" style="width: 420px" :title="t('snapshots.createTitle')">
      <n-space vertical>
        <n-input v-model:value="name" :placeholder="t('snapshots.namePlaceholder')" />
        <n-input v-model:value="desc" type="textarea" :placeholder="t('snapshots.descPlaceholder')" />
        <n-space justify="end">
          <n-button @click="modalShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" @click="create">{{ t('common.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; margin-bottom: 20px; }
.snap-list { display: flex; flex-direction: column; gap: 10px; }
.snap-card { background: var(--bg-card); }
.snap-head { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.snap-name { font-weight: 600; }
.snap-desc { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.snap-time { font-size: 11px; color: var(--text-secondary); margin-bottom: 10px; }
.snap-actions { display: flex; gap: 6px; }
</style>
