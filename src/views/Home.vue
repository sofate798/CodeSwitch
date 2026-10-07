<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NGrid, NGi, NCard, NTag, NButton, NSelect, NSpace, NEmpty,
  NModal, NMessageProvider, useMessage, useDialog
} from 'naive-ui'
import {
  CheckmarkCircle as IconCheckmarkCircle, CloseCircle as IconCloseCircle,
  Warning as IconWarning, RefreshOutline as IconRefresh,
  CheckmarkDoneOutline as IconCheckmarkDone, HardwareChipOutline as IconHardwareChipOutline
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import type { IDEState } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

// 应用弹窗状态
const applyTarget = ref<IDEState | null>(null)
const modalShow = ref(false)
const selectedProviderId = ref<string | undefined>(undefined)
const applying = ref(false)

const statusMeta = (s: IDEState['status']) => {
  const light = store.settings.theme === 'light'
  switch (s) {
    case 'customized': return { label: t('home.status.customized'), color: light ? '#16a34a' : '#22c55e' }
    case 'default': return { label: t('home.status.default'), color: light ? '#6b7280' : '#9aa0ad' }
    case 'error': return { label: t('home.status.error'), color: light ? '#dc2626' : '#ef4444' }
    default: return { label: t('home.status.missing'), color: '#6b7280' }
  }
}

const providerOptions = computed(() =>
  store.providers.map((p) => ({ label: `${p.name} (${p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'})`, value: p.id }))
)

function openApply(ide: IDEState) {
  applyTarget.value = ide
  selectedProviderId.value = ide.currentProviderId ?? undefined
  modalShow.value = true
}

async function confirmApply() {
  if (!applyTarget.value || !selectedProviderId.value) return
  applying.value = true
  try {
    const r = await window.api.ide.apply(applyTarget.value.id, selectedProviderId.value!)
    if (r.ok) message.success(r.message)
    else message.error(r.message)
    await store.refreshAll()
    modalShow.value = false
    applyTarget.value = null
  } finally {
    applying.value = false
  }
}

function confirmReset(ide: IDEState) {
  dialog.warning({
    title: t('home.resetTitle'),
    content: t('home.resetConfirm', { name: ide.name }),
    positiveText: t('common.reset'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const r = await window.api.ide.reset(ide.id)
      r.ok ? message.success(r.message) : message.error(r.message)
      await store.refreshAll()
    }
  })
}
async function pickManualPath(ide: IDEState) {
  const picked = await window.api.system.pickFile()
  if (!picked) return
  const r = await window.api.ide.manualAdd(ide.id, picked)
  r.ok ? message.success(t('home.manualPathDone')) : message.error(r.message)
  await store.refreshAll()
}
</script>

<template>
  <div class="page">
    <div class="page-title">{{ t('home.title') }}</div>
    <div class="page-sub">{{ t('home.subtitle') }}</div>

    <n-empty v-if="store.ides.length === 0" :description="t('common.refresh') + '...'" />

    <n-grid :cols="3" :x-gap="16" :y-gap="16" responsive="screen">
      <n-gi v-for="ide in store.ides" :key="ide.id">
        <n-card :bordered="false" class="ide-card" size="small" hoverable>
          <div class="ide-head">
            <div class="ide-name">
              <n-icon :component="IconHardwareChipOutline" :size="18" color="#60a5fa" />
              <span>{{ ide.name }}</span>
            </div>
            <n-tag size="tiny" :color="{ color: statusMeta(ide.status).color + '22', textColor: statusMeta(ide.status).color, borderColor: 'transparent' }">
              {{ statusMeta(ide.status).label }}
            </n-tag>
          </div>

          <div class="ide-meta">
            <div class="meta-row">
              <span class="meta-label">{{ t('home.currentProvider') }}</span>
              <span class="meta-value">{{ ide.currentProviderId ? store.providerName(ide.currentProviderId) : t('home.defaultProvider') }}</span>
            </div>
            <div class="meta-row">
              <span class="meta-label">{{ t('home.configPath') }}</span>
              <span class="meta-value path" :title="ide.configPath ?? undefined">{{ ide.configPath ?? t('home.notFound') }}</span>
            </div>
          </div>

          <div class="ide-actions">
            <n-button size="small" type="primary" :disabled="!ide.installed || store.providers.length === 0 || !!ide.note" @click="openApply(ide)">
              <template #icon><n-icon :component="IconCheckmarkDone" :size="14" /></template>
              {{ t('common.apply') }}
            </n-button>
            <n-button size="small" :disabled="!ide.installed || ide.status === 'default' || !!ide.note" @click="confirmReset(ide)">
              <template #icon><n-icon :component="IconRefresh" :size="14" /></template>
              {{ t('common.reset') }}
            </n-button>
            <n-button size="small" :disabled="!ide.installed" @click="pickManualPath(ide)">
              {{ t('home.manualPath') }}
            </n-button>
          </div>
          <div v-if="ide.note" class="ide-note">{{ ide.note }}</div>
        </n-card>
      </n-gi>
    </n-grid>

    <!-- 应用供应商弹窗 -->
    <n-modal v-model:show="modalShow" :mask-closable="false" preset="card" style="width: 480px" :title="t('home.applyTitle')">
      <n-space vertical :size="16">
        <div>
          <div class="form-label">{{ t('home.targetIde') }}</div>
          <n-tag>{{ applyTarget?.name }}</n-tag>
        </div>
        <div>
          <div class="form-label">{{ t('providers.name') }}</div>
          <n-select v-model:value="selectedProviderId" :options="providerOptions" :placeholder="t('home.selectProvider')" />
        </div>
        <n-space justify="end">
          <n-button @click="modalShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="applying" @click="confirmApply">{{ t('common.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.ide-card { background: var(--bg-card); }
.ide-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.ide-name { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.ide-meta { margin-bottom: 14px; }
.meta-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
.meta-label { color: var(--text-secondary); }
.meta-value { color: var(--text-primary); max-width: 60%; text-align: right; }
.meta-value.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 11px; }
.ide-actions { display: flex; gap: 8px; }
.ide-note { font-size: 11px; color: var(--warning); margin-top: 8px; line-height: 1.4; }
.form-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
</style>
