<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard, NButton, NSpace, NTag, NModal, NForm, NFormItem, NInput,
  NRadioGroup, NRadio, NEmpty, useMessage, useDialog
} from 'naive-ui'
import {
  AddOutline as IconAddOutline, CreateOutline as IconCreateOutline,
  TrashOutline as IconTrashOutline, FlashOutline as IconFlashOutline,
  CheckmarkCircle as IconCheckmarkCircle, CloseCircle as IconCloseCircle
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import IconLogoOpenAI from '../icons/IconLogoOpenAI.vue'
import IconLogoAnthropic from '../icons/IconLogoAnthropic.vue'
import type { Provider } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()

const modalShow = ref(false)
const editing = ref<Provider | null>(null)
const saving = ref(false)
const testingId = ref<string | null>(null)
const testResult = ref<Record<string, { ok: boolean; message: string }>>({})

const form = ref({
  name: '',
  protocol: 'openai' as 'openai' | 'anthropic',
  apiKey: '',
  baseUrl: '',
  model: '',
  group: ''
})

function openCreate() {
  editing.value = null
  form.value = { name: '', protocol: 'openai', apiKey: '', baseUrl: '', model: '', group: '' }
  modalShow.value = true
}

function openEdit(p: Provider) {
  editing.value = p
  form.value = {
    name: p.name, protocol: p.protocol,
    apiKey: '', baseUrl: p.baseUrl, model: p.model, group: p.group ?? ''
  }
  modalShow.value = true
}

async function save() {
  // 前置必填校验
  if (!form.value.name.trim() || !form.value.baseUrl.trim() || !form.value.model.trim()) {
    message.error(t('providers.name'))
    return
  }
  if (!editing.value && !form.value.apiKey.trim()) {
    message.error(t('providers.apiKey'))
    return
  }
  saving.value = true
  try {
    const payload: any = { ...form.value }
    if (editing.value) payload.id = editing.value.id
    await window.api.provider.save(payload)
    message.success(editing.value ? t('common.edit') : t('common.add'))
    modalShow.value = false
    await store.refreshAll()
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    saving.value = false
  }
}

function remove(p: Provider) {
  dialog.warning({
    title: t('providers.deleteTitle'),
    content: t('providers.deleteConfirm', { name: p.name }),
    positiveText: t('common.delete'), negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      await window.api.provider.remove(p.id)
      message.success(t('common.delete'))
      await store.refreshAll()
    }
  })
}

async function test(p: Provider) {
  testingId.value = p.id
  try {
    const r = await window.api.provider.test(p.id)
    testResult.value[p.id] = r
    r.ok ? message.success(t('providers.testSuccess', { ms: r.latencyMs ?? 0 }))
         : message.error(t('providers.testFailed', { msg: r.message }))
  } finally {
    testingId.value = null
  }
}

function maskKey(cipher: string): string {
  if (!cipher) return ''
  return 'sk-****'
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('providers.title') }}</div>
        <div class="page-sub">{{ t('providers.subtitle') }}</div>
      </div>
      <n-button type="primary" @click="openCreate">
        <template #icon><n-icon :component="IconAddOutline" :size="16" /></template>
        {{ t('providers.createTitle') }}
      </n-button>
    </div>

    <n-empty v-if="store.providers.length === 0" :description="t('providers.empty')" />

    <div class="provider-grid">
      <n-card v-for="p in store.providers" :key="p.id" size="small" :bordered="false" class="p-card" hoverable>
        <div class="p-head">
          <div class="p-name">
            <n-icon :component="p.protocol === 'openai' ? IconLogoOpenAI : IconLogoAnthropic" :size="16" color="#60a5fa" />
            <span>{{ p.name }}</span>
          </div>
          <n-tag size="tiny" :bordered="false" :color="{ color: p.protocol === 'openai' ? '#3b82f622' : '#f59e0b22', textColor: p.protocol === 'openai' ? '#60a5fa' : '#f59e0b', borderColor: 'transparent' }">
            {{ p.protocol === 'openai' ? 'OpenAI' : 'Anthropic' }}
          </n-tag>
        </div>
        <div class="p-meta">
          <div class="p-row"><span class="k">Base URL</span><span class="v">{{ p.baseUrl }}</span></div>
          <div class="p-row"><span class="k">Model</span><span class="v">{{ p.model }}</span></div>
          <div class="p-row"><span class="k">API Key</span><span class="v mono">{{ maskKey(p.apiKey) }}</span></div>
        </div>
        <div v-if="testResult[p.id]" class="p-test" :class="{ ok: testResult[p.id].ok }">
          <n-icon :component="testResult[p.id].ok ? IconCheckmarkCircle : IconCloseCircle" :size="12" />
          {{ testResult[p.id].message }}
        </div>
        <div class="p-actions">
          <n-button size="tiny" :loading="testingId === p.id" @click="test(p)">
            <template #icon><n-icon :component="IconFlashOutline" :size="12" /></template>{{ t('common.test') }}
          </n-button>
          <n-button size="tiny" @click="openEdit(p)">
            <template #icon><n-icon :component="IconCreateOutline" :size="12" /></template>{{ t('common.edit') }}
          </n-button>
          <n-button size="tiny" type="error" @click="remove(p)">
            <template #icon><n-icon :component="IconTrashOutline" :size="12" /></template>{{ t('common.delete') }}
          </n-button>
        </div>
      </n-card>
    </div>

    <!-- 编辑弹窗 -->
    <n-modal v-model:show="modalShow" preset="card" style="width: 520px" :title="editing ? t('providers.editTitle') : t('providers.createTitle')">
      <n-form label-placement="top" size="medium">
        <n-form-item :label="t('providers.name')">
          <n-input v-model:value="form.name" :placeholder="t('providers.namePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('providers.protocol')">
          <n-radio-group v-model:value="form.protocol">
            <n-space>
              <n-radio value="openai">{{ t('providers.openai') }}</n-radio>
              <n-radio value="anthropic">{{ t('providers.anthropic') }}</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="API Key">
          <n-input v-model:value="form.apiKey" type="password" show-password-on="click" :placeholder="editing ? t('providers.apiKeyEditPlaceholder') : t('providers.apiKeyPlaceholder')" />
        </n-form-item>
        <n-form-item label="Base URL">
          <n-input v-model:value="form.baseUrl" :placeholder="form.protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'" />
        </n-form-item>
        <n-form-item label="Model">
          <n-input v-model:value="form.model" :placeholder="form.protocol === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'" />
        </n-form-item>
        <n-form-item :label="t('providers.group')">
          <n-input v-model:value="form.group" :placeholder="t('providers.groupPlaceholder')" />
        </n-form-item>
        <n-space justify="end">
          <n-button @click="modalShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="saving" @click="save">{{ t('common.save') }}</n-button>
        </n-space>
      </n-form>
    </n-modal>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 20px; }
.provider-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
.p-card { background: var(--bg-card); }
.p-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.p-name { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.p-meta { margin-bottom: 10px; }
.p-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
.k { color: var(--text-secondary); }
.v { max-width: 65%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v.mono { font-family: monospace; }
.p-test { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; background: #ef444422; color: #ef4444; display: flex; align-items: center; gap: 4px; }
.p-test.ok { background: #22c55e22; color: #22c55e; }
.p-actions { display: flex; gap: 6px; }
</style>
