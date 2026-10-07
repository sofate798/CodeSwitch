<script setup lang="ts">
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { NCard, NForm, NFormItem, NSelect, NSwitch, NButton, NTag, useMessage } from 'naive-ui'
import { useAppStore } from '../stores/app'
import { setLocale } from '../i18n'

const store = useAppStore()
const { t } = useI18n()
const message = useMessage()
const checking = ref(false)

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
          <n-space>
            <n-button size="small" @click="openDataDir">{{ t('settings.openDataDir') }}</n-button>
            <n-button size="small" :loading="checking" @click="checkUpdate">
              {{ t('settings.checkUpdate') }}
            </n-button>
          </n-space>
        </n-form-item>
      </n-form>
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
</style>
