<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { NCard, NForm, NFormItem, NSelect, NSwitch, NButton, NTag, NSpace, NInputNumber, NInput, useDialog } from 'naive-ui'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import { setLocale } from '../i18n'
import type { AppSettings, ProxyConfig, ProxyStatus } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
// useResult 内部已集成 useMessage，统一从其取 message，避免同一实例被取两次。
const { message, showResult } = useResult()
const checking = ref(false)
const resetting = ref(false)
const installing = ref(false)
const dataDir = ref<{ current: string; custom: string | null }>({ current: '', custom: null })
const version = ref('')
const updatePending = ref('')

const proxy = ref<ProxyStatus>({ enabled: false, running: false, port: 8787, url: 'http://127.0.0.1:8787', providerId: null, providerName: null })
const proxyBusy = ref(false)
// 端口本地暂存：blur/Enter 才提交，避免逐键触发挥关重启
const portInput = ref<number | null>(proxy.value.port)
const token = ref('')
const tokenVisible = ref(false)
const maskedToken = computed(() => {
  if (!token.value) return ''
  if (tokenVisible.value) return token.value
  return `${token.value.slice(0, 4)}${'•'.repeat(16)}${token.value.slice(-4)}`
})

const providerOptions = computed(() =>
  store.providers.map((p) => ({ label: `${p.name} · ${p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'}`, value: p.id }))
)

/** proxy:status / system:get-data-dir 是值型通道：主进程失败时真实 reject，故在本函数内兜底，调用方（onMounted / 重置流程）无需再接异常 */
async function loadProxy() {
  try {
    proxy.value = await window.api.proxy.status()
    portInput.value = proxy.value.port
  } catch {
    message.error(t('msg.common.error'))
  }
}

async function loadDataDir() {
  try {
    dataDir.value = await window.api.system.getDataDir()
  } catch {
    message.error(t('msg.common.error'))
  }
}

async function loadToken() {
  try {
    token.value = await window.api.proxy.token()
  } catch {
    message.error(t('settings.proxy.tokenFailed'))
  }
}

async function loadVersionState() {
  try {
    version.value = await window.api.system.getVersion()
    updatePending.value = (await window.api.system.getUpdateState()).downloadedVersion
  } catch {
    /* 开发模式无更新模块时静默 */
  }
}

// autoDownload 开启后下载完成是异步事件：检查更新后轮询 60s，待安装版本就绪即展示按钮
let updatePoll: ReturnType<typeof setInterval> | null = null
function stopUpdatePoll() {
  if (updatePoll) { clearInterval(updatePoll); updatePoll = null }
}
function startUpdatePoll() {
  stopUpdatePoll()
  let ticks = 0
  updatePoll = setInterval(async () => {
    ticks++
    try {
      const s = await window.api.system.getUpdateState()
      if (s.downloadedVersion) {
        updatePending.value = s.downloadedVersion
        stopUpdatePoll()
        return
      }
    } catch { /* 忽略单次失败 */ }
    if (ticks >= 12) stopUpdatePoll()
  }, 5000)
}

onMounted(() => {
  loadProxy()
  loadDataDir()
  loadVersionState()
  loadToken()
})

onBeforeUnmount(stopUpdatePoll)

/** proxy:configure 透传 OpResult<ProxyStatus>：成功用 r.data 刷新状态；失败走消息码 showResult */
async function setProxy(patch: Partial<ProxyConfig>) {
  proxyBusy.value = true
  try {
    const r = await window.api.proxy.configure(patch)
    if (r.data) proxy.value = r.data
    portInput.value = proxy.value.port
    // 仅切换转发目标且成功时不弹提示（选择结果已体现在界面），其余一律按消息码反馈
    if (!('providerId' in patch) || !r.ok) showResult(r)
    if (r.ok && patch.enabled && !token.value) await loadToken()
  } finally {
    proxyBusy.value = false
  }
}

/** 端口失焦/回车提交：非法值或未变化时回退，不发起 IPC */
function commitPort() {
  const v = portInput.value
  if (!v || v < 1024 || v > 65535 || v === proxy.value.port) {
    portInput.value = proxy.value.port
    return
  }
  setProxy({ port: v })
}

async function copyProxyUrl() {
  const url = `${proxy.value.url}/v1`
  try {
    await navigator.clipboard.writeText(url)
    message.success(t('settings.proxy.copied'))
  } catch {
    // 失败提示走本地化文案，绝不把 URL 本身当错误消息弹出（与 copyToken/copyGen 口径一致）
    message.error(t('home.copyFailed'))
  }
}

async function copyToken() {
  if (!token.value) {
    message.error(t('settings.proxy.tokenFailed'))
    return
  }
  try {
    await navigator.clipboard.writeText(token.value)
    message.success(t('settings.proxy.tokenCopied'))
  } catch {
    message.error(t('home.copyFailed'))
  }
}

async function save(patch: Partial<AppSettings>) {
  try {
    await window.api.settings.set(patch)
  } catch {
    // settings:set 为值型通道（回写最新全量设置），失败会 reject；写不进去时必须提示，不能静默“看起来已切换”
    message.error(t('msg.common.error'))
    return
  }
  await store.refreshSettings()
}

function onThemeChange(v: string) {
  save({ theme: v as AppSettings['theme'] })
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
      if (r.canceled) return
      if (!r.ok) {
        showResult(r)
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
        if (showResult(r)) {
          await store.refreshAll()
          await store.refreshSettings()
          await loadProxy()
          await loadDataDir()
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
    // 事件驱动结果：available(成功) / notAvailable|noFeed(中性提示) / 其余(失败)
    const text = t(r.code ?? 'msg.common.error', r.args ?? {})
    if (r.ok) {
      message.success(text)
      startUpdatePoll()
    } else if (r.code === 'msg.update.notAvailable' || r.code === 'msg.update.noFeed') message.info(text)
    else message.error(text)
  } catch (e) {
    // safeHandle 已兜底业务异常，此处仅防渲染侧意外；原始异常文本不外透 UI
    console.error('checkUpdate failed:', e)
    message.error(t('msg.common.error'))
  } finally {
    checking.value = false
  }
}

// 安装已下载的更新（quitAndInstall，主进程重启应用）
async function installUpdate() {
  installing.value = true
  try {
    const r = await window.api.system.installUpdate()
    if (!r.ok) showResult(r)
  } finally {
    installing.value = false
  }
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('settings.title') }}</div>
        <div class="page-sub">{{ t('settings.subtitle') }}</div>
      </div>
    </div>

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
          <n-space :size="8" align="center">
            <n-button size="small" :loading="checking" @click="checkUpdate">
              {{ t('settings.checkUpdate') }}
            </n-button>
            <n-button v-if="updatePending" size="small" type="primary" :loading="installing" @click="installUpdate">
              {{ t('settings.installUpdate') }} (v{{ updatePending }})
            </n-button>
          </n-space>
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
            :value="portInput"
            :min="1024"
            :max="65535"
            :disabled="!proxy.enabled"
            :show-button="true"
            style="width: 160px"
            @update:value="(v: number | null) => (portInput = v)"
            @blur="commitPort"
            @keyup.enter="commitPort"
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
        <n-form-item v-if="proxy.enabled" :label="t('settings.proxy.token')">
          <n-space vertical :size="6" style="width: 100%">
            <n-space align="center" :size="8">
              <n-input :value="maskedToken" readonly style="width: 260px" size="small" />
              <n-button size="small" tertiary @click="tokenVisible = !tokenVisible">
                {{ tokenVisible ? t('settings.proxy.tokenHide') : t('settings.proxy.tokenShow') }}
              </n-button>
              <n-button size="small" @click="copyToken">{{ t('settings.proxy.copy') }}</n-button>
            </n-space>
            <div class="dir-hint">{{ t('settings.proxy.tokenHint') }}</div>
          </n-space>
        </n-form-item>
      </n-form>

      <div class="proxy-hint">{{ t('settings.proxy.hint') }}</div>
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
      <n-tag size="small" :bordered="false">CodeSwitch{{ version ? ` v${version}` : '' }}</n-tag>
      <span class="about-text">{{ t('settings.about') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* C2：标题区与内容间距对齐 Home（page-sub 全局 20px + head 下 16px） */
.page-head { margin-bottom: 16px; }
.set-card { background: var(--bg-card); border: 1px solid var(--border); max-width: 640px; margin-bottom: 20px; }
.about { display: flex; align-items: center; gap: 12px; }
.about-text { font-size: 12px; color: var(--text-secondary); }
.proxy-head { display: flex; justify-content: space-between; align-items: flex-start; }
.proxy-title { font-weight: 600; font-size: 14px; }
.proxy-sub { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
.proxy-hint { font-size: 12px; color: var(--text-secondary); line-height: 1.6; margin-top: 4px; white-space: pre-line; }
.dir-hint { font-size: 11px; color: var(--text-secondary); }
.danger-card { border: 1px solid var(--danger-soft); }
</style>
