<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NCard, NButton, NSpace, NTag, NModal, NForm, NFormItem, NInput,
  NRadioGroup, NRadio, NIcon, NEmpty, useDialog,
  type FormInst, type FormRules
} from 'naive-ui'
import {
  AddOutline as IconAddOutline, CreateOutline as IconCreateOutline,
  TrashOutline as IconTrashOutline, FlashOutline as IconFlashOutline,
  CheckmarkCircle as IconCheckmarkCircle, CloseCircle as IconCloseCircle,
  DownloadOutline as IconExport, CloudUploadOutline as IconImport
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import IconLogoOpenAI from '../icons/IconLogoOpenAI.vue'
import IconLogoAnthropic from '../icons/IconLogoAnthropic.vue'
import type { Provider, Protocol } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { message, showResult } = useResult()

const modalShow = ref(false)
const editing = ref<Provider | null>(null)
const saving = ref(false)
const testingId = ref<string | null>(null)
// Jack-Med14：测试结果显示改为按消息码本地化后的文案（OpResult.code/args），不再依赖旧 r.message
// 值类型显式允许 undefined：仅被测试过的 Provider 才有对应键，未测试键运行时为 undefined
type TestEntry = { ok: boolean; text: string }
const testResult = ref<Record<string, TestEntry | undefined>>({})

const formRef = ref<FormInst | null>(null)
const form = ref({
  name: '',
  protocol: 'openai' as Protocol,
  apiKey: '',
  baseUrl: '',
  model: '',
  group: ''
})

function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL((raw || '').trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

// Jack-High4：NForm 行内校验，复用 providers.validation.*；编辑态允许 Key 留空（不改原值）
const rules = computed<FormRules>(() => ({
  name: { required: true, message: t('providers.validation.name'), trigger: ['input', 'blur'] },
  baseUrl: [
    { required: true, message: t('providers.validation.baseUrl'), trigger: ['input', 'blur'] },
    {
      validator: (_r, v: string) => isHttpUrl(v),
      message: t('providers.validation.baseUrlInvalid'),
      trigger: ['input', 'blur']
    }
  ],
  model: { required: true, message: t('providers.validation.model'), trigger: ['input', 'blur'] },
  apiKey: { required: !editing.value, message: t('providers.validation.apiKey'), trigger: ['input', 'blur'] }
}))

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
  try {
    await formRef.value?.validate()
  } catch {
    return // 行内校验未通过
  }
  saving.value = true
  try {
    const payload: Partial<Provider> & { protocol: Protocol } = { ...form.value }
    if (editing.value) payload.id = editing.value.id
    // 后端统一返回 OpResult<Provider>：成功 code=msg.provider.saveOk 走 showResult；
    // 失败按码提示且**不关弹窗/不清表单**，避免把失败渲染为成功。IPC reject 也兜底不静默。
    const res = await window.api.provider.save(payload)
    if (showResult(res)) {
      modalShow.value = false
      await store.refreshAll()
    }
  } catch {
    message.error(t('msg.common.error'))
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
      if (showResult(await window.api.provider.remove(p.id))) await store.refreshAll()
    }
  })
}

async function test(p: Provider) {
  testingId.value = p.id
  try {
    const r = await window.api.provider.test(p.id)
    const text = t(r.code ?? 'msg.common.error', r.args ?? {})
    testResult.value[p.id] = { ok: r.ok, text }
    r.ok ? message.success(text) : message.error(text)
  } finally {
    testingId.value = null
  }
}

// Jack-Med9/Tina-M1：脱敏展示消费后端 keyTail，渲染 sk-****{tail}，不再前端静态占位
function keyDisplay(p: Provider): string {
  return p.keyTail ? `sk-****${p.keyTail}` : 'sk-****'
}

async function doExport() {
  showResult(await window.api.provider.export())
}

async function doImport() {
  if (showResult(await window.api.provider.import())) await store.refreshAll()
}

// Jack-Low19：供应商列表刷新后清空过期测试结果，避免陈旧状态误导
watch(() => store.providers, () => { testResult.value = {} })
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('providers.title') }}</div>
        <div class="page-sub">{{ t('providers.subtitle') }}</div>
      </div>
      <n-space>
        <n-button @click="doImport">
          <template #icon><n-icon :component="IconImport" :size="16" /></template>
          {{ t('providers.importBtn') }}
        </n-button>
        <n-button @click="doExport">
          <template #icon><n-icon :component="IconExport" :size="16" /></template>
          {{ t('providers.exportBtn') }}
        </n-button>
        <n-button type="primary" @click="openCreate">
          <template #icon><n-icon :component="IconAddOutline" :size="16" /></template>
          {{ t('providers.createTitle') }}
        </n-button>
      </n-space>
    </div>

    <n-empty v-if="store.providers.length === 0" :description="t('providers.empty')" />

    <div class="provider-grid">
      <n-card v-for="p in store.providers" :key="p.id" size="small" :bordered="false" class="p-card" hoverable>
        <div class="p-head">
          <div class="p-name">
            <n-icon :component="p.protocol === 'openai' ? IconLogoOpenAI : IconLogoAnthropic" :size="16" />
            <span>{{ p.name }}</span>
          </div>
          <n-tag size="tiny" :bordered="false" :color="{ color: p.protocol === 'openai' ? '#3b82f622' : '#f59e0b22', textColor: p.protocol === 'openai' ? '#60a5fa' : '#f59e0b', borderColor: 'transparent' }">
            {{ p.protocol === 'openai' ? 'OpenAI' : 'Anthropic' }}
          </n-tag>
        </div>
        <div class="p-meta">
          <div class="p-row"><span class="k">Base URL</span><span class="v">{{ p.baseUrl }}</span></div>
          <div class="p-row"><span class="k">Model</span><span class="v">{{ p.model }}</span></div>
          <div class="p-row"><span class="k">API Key</span><span class="v mono">{{ keyDisplay(p) }}</span></div>
        </div>
        <div v-if="testResult[p.id]" class="p-test" :class="{ ok: testResult[p.id]?.ok }">
          <n-icon :component="testResult[p.id]?.ok ? IconCheckmarkCircle : IconCloseCircle" :size="12" />
          {{ testResult[p.id]?.text }}
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
      <n-form ref="formRef" :model="form" :rules="rules" label-placement="top" size="medium">
        <n-form-item :label="t('providers.name')" path="name">
          <n-input v-model:value="form.name" :placeholder="t('providers.namePlaceholder')" />
        </n-form-item>
        <n-form-item :label="t('providers.protocol')" path="protocol">
          <n-radio-group v-model:value="form.protocol">
            <n-space>
              <n-radio value="openai">{{ t('providers.openai') }}</n-radio>
              <n-radio value="anthropic">{{ t('providers.anthropic') }}</n-radio>
            </n-space>
          </n-radio-group>
        </n-form-item>
        <n-form-item label="API Key" path="apiKey">
          <n-input v-model:value="form.apiKey" type="password" show-password-on="click" :placeholder="editing ? t('providers.apiKeyEditPlaceholder') : t('providers.apiKeyPlaceholder')" />
        </n-form-item>
        <n-form-item label="Base URL" path="baseUrl">
          <n-input v-model:value="form.baseUrl" :placeholder="form.protocol === 'openai' ? 'https://api.openai.com/v1' : 'https://api.anthropic.com'" />
        </n-form-item>
        <n-form-item label="Model" path="model">
          <n-input v-model:value="form.model" :placeholder="form.protocol === 'openai' ? 'gpt-4o' : 'claude-3-5-sonnet-20241022'" />
        </n-form-item>
        <n-form-item :label="t('providers.group')" path="group">
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
.p-card { background: var(--bg-card); border: 1px solid var(--border); }
.p-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }
.p-name { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.p-meta { margin-bottom: 10px; }
.p-row { display: flex; justify-content: space-between; font-size: 12px; padding: 2px 0; }
.k { color: var(--text-secondary); }
.v { max-width: 65%; text-align: right; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.v.mono { font-family: monospace; }
.p-test { font-size: 11px; padding: 4px 8px; border-radius: 4px; margin-bottom: 8px; background: var(--danger-soft); color: var(--danger); display: flex; align-items: center; gap: 4px; }
.p-test.ok { background: var(--success-soft); color: var(--success); }
.p-actions { display: flex; gap: 6px; }
</style>
