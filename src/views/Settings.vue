<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { NCard, NForm, NFormItem, NSelect, NSwitch, NButton, NTag, NSpace, NInputNumber, NInput, useMessage, useDialog } from 'naive-ui'
import { useAppStore } from '../stores/app'
import { setLocale } from '../i18n'
import type { ProxyStatus } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const dialog = useDialog()
const checking = ref(false)
const resetting = ref(false)
const dataDir = ref<{ current: string; custom: string | null }>({ current: '', custom: null })

const proxy = ref<ProxyStatus>({ enabled: false, running: false, port: 8787, url: 'http://127.0.0.1:8787', providerId: null, providerName: null })
const proxyBusy = ref(false)

const providerOptions = computed(() =>
  store.providers.map((p) => ({ label: `${p.name} · ${p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}`, value: p.id }))
)

async function loadProxy() {
  proxy.value = await window.api.proxy.status()
}

async function loadDataDir() {
  dataDir.value = await window.api.system.getDataDir()
}

onMounted(() => {
  loadProxy()
  loadDataDir()
})

async function setProxy(patch: Partial<ProxyStatus>) {
  proxyBusy.value = true
  try {
    proxy.value = await window.api.proxy.configure(patch)
    if (patch.enabled && !proxy.value.running && proxy.value.error) message.error(proxy.value.error)
  } finally {
    proxyBusy.value = false
  }
}

async function copyProxyUrl() {
  const url = `${proxy.value.url}/v1`
  try {
    await navigator.clipboard.writeText(url)
    message.success(t('settings.proxy.copied'))
  } catch {
    message.error(url)
  }
}

async function save(patch: Partial<any>) {
  await window.api.settings.set(patch)
  await store.refreshSettings()
}

function onThemeChange(v: string) {
  save({ theme: v })
}

function onLangChange(v: 'zh-CN' | 'en-US') {
  setLocale(v)
  save({ locale: v })
}

function openDataDir() {
  window.api.system.openDataDir()
}

// 更改数据目录：主进程迁移数据后提示重启生效
function changeDataDir() {
  dialog.warning({
    title: t('settings.dataDirChangeTitle'),
    content: t('settings.dataDirChangeConfirm'),
    positiveText: t('common.confirm'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const r = await window.api.system.setDataDir()
      if (!r.ok) {
        if (r.message !== '已取消') message.error(r.message)
        return
      }
      await loadDataDir()
      dialog.success({
        title: t('settings.restartTitle'),
        content: t('settings.restartConfirm'),
        positiveText: t('settings.restartNow'),
        negativeText: t('settings.restartLater'),
        onPositiveClick: () => window.api.system.relaunch()
      })
    }
  })
}

// 重置软件：强确认，清除全部本地数据
function resetAll() {
  dialog.error({
    title: t('settings.resetTitle'),
    content: t('settings.resetConfirm'),
    positiveText: t('settings.resetBtn'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      resetting.value = true
      try {
        const r = await window.api.system.resetAll()
        if (r.ok) {
          message.success(t('settings.resetDone'))
          await store.refreshAll()
          await store.refreshSettings()
          await loadProxy()
          await loadDataDir()
        } else {
          message.error(r.message)
        }
      } finally {
        resetting.value = false
      }
    }
  })
}

async function checkUpdate() {
  checking.value = true
  try {
    // 主进程通过 IPC 调用 electron-updater
    const r = await window.api.system.checkUpdate()
    if (r.pending) message.info(r.message)
    else if (r.available) message.success(t('settings.updateAvailable', { version: r.version }))
    else message.success(t('settings.upToDate'))
  } catch (e) {
    message.error((e as Error).message)
  } finally {
    checking.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-title">{{ t('settings.title') }}</div>
    <div class="page-sub">{{ t('settings.subtitle') }}</div>

    <n-card size="small" :bordered="false" class="set-card">
      <n-form label-placement="left" label-width="120px">
        <n-form-item :label="t('settings.theme')">
          <n-select
            :value="store.settings.theme"
            :options="[
              { label: t('settings.themeSystem'), value: 'system' },
              { label: t('settings.themeDark'), value: 'dark' },
              { label: t('settings.themeLight'), value: 'light' }
            ]"
            @update:value="onThemeChange"
          />
        </n-form-item>
        <n-form-item :label="t('settings.language')">
          <n-select
            :value="store.settings.locale"
            :options="[
              { label: t('settings.langZh'), value: 'zh-CN' },
              { label: t('settings.langEn'), value: 'en-US' }
            ]"
            @update:value="onLangChange"
          />
        </n-form-item>
        <n-form-item :label="t('settings.autoLaunch')">
          <n-switch :value="store.settings.autoLaunch" @update:value="(v: boolean) => save({ autoLaunch: v })" />
        </n-form-item>
        <n-form-item :label="t('settings.dataDir')">
          <n-space vertical :size="8" style="width: 100%">
            <n-input :value="dataDir.current" readonly size="small" />
            <n-space :size="8">
              <n-button size="small" @click="openDataDir">{{ t('settings.openDataDir') }}</n-button>
              <n-button size="small" @click="changeDataDir">{{ t('settings.dataDirChange') }}</n-button>
            </n-space>
            <div v-if="dataDir.custom" class="dir-hint">{{ t('settings.dataDirCustom') }}</div>
          </n-space>
        </n-form-item>
        <n-form-item :label="t('settings.update')">
          <n-button size="small" :loading="checking" @click="checkUpdate">
            {{ t('settings.checkUpdate') }}
          </n-button>
        </n-form-item>
      </n-form>
    </n-card>

    <!-- 本地转发网关 -->
    <n-card size="small" :bordered="false" class="set-card">
      <div class="proxy-head">
        <div>
          <div class="proxy-title">{{ t('settings.proxy.title') }}</div>
          <div class="proxy-sub">{{ t('settings.proxy.subtitle') }}</div>
        </div>
        <n-space align="center" :size="8">
          <n-tag size="small" :bordered="false" :type="proxy.running ? 'success' : 'default'">
            {{ proxy.running ? t('settings.proxy.running') : t('settings.proxy.stopped') }}
          </n-tag>
          <n-switch :value="proxy.enabled" :loading="proxyBusy" @update:value="(v: boolean) => setProxy({ enabled: v })" />
        </n-space>
      </div>

      <n-form label-placement="left" label-width="120px" style="margin-top: 8px">
        <n-form-item :label="t('settings.proxy.target')">
          <n-select
            :value="proxy.providerId"
            :options="providerOptions"
            :disabled="providerOptions.length === 0"
            :placeholder="t('settings.proxy.targetPlaceholder')"
            @update:value="(v: string) => setProxy({ providerId: v })"
          />
        </n-form-item>
        <n-form-item :label="t('settings.proxy.port')">
          <n-input-number
            :value="proxy.port"
            :min="1024"
            :max="65535"
            :disabled="!proxy.enabled"
            style="width: 160px"
            @update:value="(v: number | null) => v && setProxy({ port: v })"
          />
        </n-form-item>
        <n-form-item :label="t('settings.proxy.url')">
          <n-space align="center" :size="8">
            <n-input :value="`${proxy.url}/v1`" readonly style="width: 260px" size="small" />
            <n-button size="small" @click="copyProxyUrl">
              {{ t('settings.proxy.copy') }}
            </n-button>
          </n-space>
        </n-form-item>
      </n-form>

      <div class="proxy-hint">{{ t('settings.proxy.hint') }}</div>
      <div v-if="proxy.error" class="proxy-error">{{ proxy.error }}</div>
    </n-card>

    <!-- 危险操作 -->
    <n-card size="small" :bordered="false" class="set-card danger-card">
      <div class="proxy-head">
        <div>
          <div class="proxy-title">{{ t('settings.dangerTitle') }}</div>
          <div class="proxy-sub">{{ t('settings.resetDesc') }}</div>
        </div>
        <n-button size="small" type="error" :loading="resetting" @click="resetAll">{{ t('settings.resetBtn') }}</n-button>
      </div>
    </n-card>

    <div class="about">
      <n-tag size="small" :bordered="false">CodeSwitch v1.1.0</n-tag>
      <span class="about-text">{{ t('settings.about') }}</span>
    </div>
  </div>
</template>

<style scoped>
.set-card { background: var(--bg-card); max-width: 640px; margin-bottom: 20px; }
.about { display: flex; align-items: center; gap: 12px; }
.about-text { font-size: 12px; color: var(--text-secondary); }
.proxy-head { display: flex; justify-content: space-between; align-items: flex-start; }
.proxy-title { font-weight: 600; font-size: 14px; }
.proxy-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.proxy-hint { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-top: 4px; white-space: pre-line; }
.proxy-error { font-size: 12px; color: #ef4444; margin-top: 6px; }
.dir-hint { font-size: 11px; color: var(--text-secondary); }
.danger-card { border: 1px solid #ef444433; }
</style>
