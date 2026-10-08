<script setup lang="ts">
import { ref, computed, h, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  NGrid, NGi, NCard, NTag, NButton, NSelect, NSpace, NEmpty, NInput,
  NModal, NSpin, NPopover, useDialog
} from 'naive-ui'
import {
  RefreshOutline as IconRefresh,
  CheckmarkDoneOutline as IconCheckmarkDone,
  HardwareChipOutline as IconHardwareChipOutline,
  LayersOutline as IconBatch,
  ColorPaletteOutline as IconResetAll,
  HelpCircleOutline as IconHelp
} from '@vicons/ionicons5'
import { useAppStore } from '../stores/app'
import { useResult } from '../composables/useResult'
import type { IDEState, OpResult, Provider, Protocol } from '../../electron/shared/types'

const store = useAppStore()
const { t } = useI18n()
const dialog = useDialog()
const { message, showResult } = useResult()

// 应用弹窗状态
const applyTarget = ref<IDEState | null>(null)
const modalShow = ref(false)
const selectedProviderId = ref<string | undefined>(undefined)
const applying = ref(false)

// 生成配置（assist 型）弹窗状态
const genShow = ref(false)
const genIde = ref<IDEState | null>(null)
const genProviderId = ref<string | undefined>(undefined)
const genText = ref('')
const genTargetPath = ref('')
const generating = ref(false)

// 批量应用弹窗状态（Jack-Med5 / FR-04-2 P0）
const batchShow = ref(false)
const batchIdeIds = ref<string[]>([])
const batchProviderId = ref<string | undefined>(undefined)
const batchRunning = ref(false)
// B4：批量应用进度文本（正在应用 i/n：名称），仅运行中展示
const batchProgress = ref('')

const statusMeta = (s: IDEState['status']) => {
  const light = store.settings.theme === 'light'
  switch (s) {
    case 'customized': return { label: t('home.status.customized'), color: light ? '#16a34a' : '#22c55e' }
    case 'default': return { label: t('home.status.default'), color: light ? '#6b7280' : '#9aa0ad' }
    case 'error': return { label: t('home.status.error'), color: light ? '#dc2626' : '#ef4444' }
    default: return { label: t('home.status.missing'), color: '#6b7280' }
  }
}

const providerOption = (p: Provider) => ({ label: `${p.name} (${p.protocol === 'openai' ? 'OpenAI' : 'Anthropic'})`, value: p.id })

const providerOptions = computed(() => store.providers.map(providerOption))

/** 协议兼容的供应商：Claude Code 等单一协议 IDE 选到不兼容供应商会被后端拦截，前端先滤掉 */
const compatProviders = (protocols: Protocol[] | undefined): Provider[] =>
  store.providers.filter((p) => !protocols || !protocols.length || protocols.includes(p.protocol))

const applyProviderOptions = computed(() => compatProviders(applyTarget.value?.protocols).map(providerOption))
const genProviderOptions = computed(() => compatProviders(genIde.value?.protocols).map(providerOption))

/** 默认选中项：已有绑定且协议兼容则沿用，否则退到首个兼容供应商 */
function pickProvider(ide: IDEState): string | undefined {
  const bound = ide.currentProviderId ? store.providers.find((p) => p.id === ide.currentProviderId) : undefined
  if (bound && ide.protocols.includes(bound.protocol)) return bound.id
  return compatProviders(ide.protocols)[0]?.id
}

/** 写入/生成入口的禁用判定：按协议兼容而非供应商总数（单一协议 IDE 否则点开是空列表） */
const hasCompatProvider = (ide: IDEState): boolean => compatProviders(ide.protocols).length > 0

// 仅"已安装 + 支持自动写入"的 IDE 才纳入批量应用候选；选定供应商后再按协议筛掉不兼容项
const autoIdeOptions = computed(() => {
  const proto = store.providers.find((p) => p.id === batchProviderId.value)?.protocol
  return store.ides
    .filter((i) => i.installed && i.capability === 'auto')
    .filter((i) => !proto || i.protocols.includes(proto))
    .map((i) => ({ label: i.name, value: i.id }))
})

// 切换供应商后剔除已勾选但不兼容的目标，避免批量任务里埋下必然失败项
watch(batchProviderId, () => {
  const valid = new Set(autoIdeOptions.value.map((o) => o.value))
  batchIdeIds.value = batchIdeIds.value.filter((id) => valid.has(id))
})

function openApply(ide: IDEState) {
  applyTarget.value = ide
  selectedProviderId.value = pickProvider(ide)
  modalShow.value = true
  // 预判：整库/整文件回写型 IDE 若正在运行，先给出弱提示（真正拦截在 confirmApply）
  if (ide.running) message.warning(t('home.closeIdeConfirm', { name: ide.name }))
}

async function confirmApply() {
  if (!applyTarget.value || !selectedProviderId.value) return
  applying.value = true
  try {
    const ide = applyTarget.value
    const r = await window.api.ide.apply(ide.id, selectedProviderId.value!)
    // 后端统一 OpResult：目标 IDE 正在运行 -> msg.ide.needClose，给出关闭引导；其余走统一反馈
    if (!r.ok && r.code === 'msg.ide.needClose') {
      dialog.warning({
        title: t('home.closeIdeTitle'),
        content: t('home.closeIdeConfirm', { name: ide.name }),
        positiveText: t('common.close'),
        onPositiveClick: () => {
          modalShow.value = false
          applyTarget.value = null
        }
      })
    } else if (showResult(r)) {
      modalShow.value = false
      applyTarget.value = null
    }
    await store.refreshAll()
  } finally {
    applying.value = false
  }
}

function openGenerate(ide: IDEState) {
  genIde.value = ide
  genProviderId.value = pickProvider(ide)
  genText.value = ''
  genTargetPath.value = ''
  genShow.value = true
}

async function confirmGenerate() {
  if (!genIde.value || !genProviderId.value) return
  generating.value = true
  try {
    const r = await window.api.ide.generateConfig(genIde.value.id, genProviderId.value)
    if (r.ok) {
      genText.value = r.data?.text ?? ''
      genTargetPath.value = r.data?.targetPath ?? ''
    } else {
      showResult(r)
    }
  } finally {
    generating.value = false
  }
}

async function copyGen() {
  // Jack-High2：失败改用 home.copyFailed，不再误用"已复制"文案
  try {
    await navigator.clipboard.writeText(genText.value)
    message.success(t('home.copied'))
  } catch {
    message.error(t('home.copyFailed'))
  }
}

function openGenFolder() {
  if (genTargetPath.value) window.api.system.openPath(genTargetPath.value)
}

function confirmReset(ide: IDEState) {
  dialog.warning({
    title: t('home.resetTitle'),
    content: t('home.resetConfirm', { name: ide.name }),
    positiveText: t('common.reset'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const r = await window.api.ide.reset(ide.id)
      showResult(r)
      await store.refreshAll()
    }
  })
}

async function pickManualPath(ide: IDEState) {
  const picked = await window.api.system.pickFile()
  if (!picked) return
  const r = await window.api.ide.manualAdd(ide.id, picked)
  showResult(r)
  await store.refreshAll()
}

// ---------------- 批量应用 / 全部恢复默认 ----------------

function openBatch() {
  batchIdeIds.value = []
  batchProviderId.value = undefined
  batchProgress.value = ''
  batchShow.value = true
}

async function confirmBatch() {
  if (!batchProviderId.value || batchIdeIds.value.length === 0) {
    message.warning(t('home.batchApplyNoTarget'))
    return
  }
  batchRunning.value = true
  const targets = [...batchIdeIds.value]
  const total = targets.length
  let count = 0
  let firstFailed: OpResult | null = null
  try {
    const pid = batchProviderId.value
    for (let i = 0; i < total; i++) {
      const ideId = targets[i]
      // 逐项更新进度，让用户看到当前正在写入哪个 IDE
      const ideName = store.ides.find((x) => x.id === ideId)?.name ?? ideId
      batchProgress.value = t('home.batchApplying', { i: i + 1, n: total, name: ideName })
      const r = await window.api.ide.apply(ideId, pid)
      if (r.ok) count++
      else if (!firstFailed) firstFailed = r
    }
    await store.refreshAll()
    batchShow.value = false
    // B4：结果统一进汇总 dialog（成功数 + 首个失败原因 + 建议），不再只弹零散 message
    const failed = total - count
    const failedText = firstFailed ? t(firstFailed.code ?? 'msg.common.error', firstFailed.args ?? {}) : ''
    const content = [
      t('home.batchResultSummary', { ok: count, failed }),
      failedText,
      failed > 0 ? t('home.batchResultSuggest') : ''
    ].filter(Boolean).join('\n')
    // pre-line 渲染保留行分隔，汇总/失败原因/建议各占一行
    const contentRender = () => h('div', { style: 'white-space: pre-line' }, content)
    if (failed > 0) {
      dialog.warning({
        title: t('home.batchResultTitle'),
        content: contentRender,
        positiveText: t('common.confirm')
      })
    } else {
      dialog.success({
        title: t('home.batchResultTitle'),
        content: contentRender,
        positiveText: t('common.confirm')
      })
    }
  } finally {
    batchRunning.value = false
    batchProgress.value = ''
  }
}

function batchReset() {
  dialog.warning({
    title: t('home.batchResetTitle'),
    content: t('home.batchResetConfirm'),
    positiveText: t('common.reset'),
    negativeText: t('common.cancel'),
    onPositiveClick: async () => {
      const r = await window.api.ide.reset('all')
      showResult(r)
      await store.refreshAll()
    }
  })
}
</script>

<template>
  <div class="page">
    <div class="page-head">
      <div>
        <div class="page-title">{{ t('home.title') }}</div>
        <div class="page-sub">{{ t('home.subtitle') }}</div>
      </div>
      <n-space :size="8">
        <n-button
          :disabled="store.providers.length === 0 || autoIdeOptions.length === 0"
          @click="openBatch"
        >
          <template #icon><n-icon :component="IconBatch" :size="16" /></template>
          {{ t('home.batchApply') }}
        </n-button>
        <n-button :disabled="store.ides.length === 0" @click="batchReset">
          <template #icon><n-icon :component="IconResetAll" :size="16" /></template>
          {{ t('home.batchReset') }}
        </n-button>
      </n-space>
    </div>

    <!-- Jack-Med11：区分 加载中 / 扫描出错 / 真正为空 三态，并消费 store.error（F1） -->
    <div v-if="store.loading && store.ides.length === 0" class="loading-state">
      <n-spin size="medium" :show="true" />
    </div>
    <n-empty
      v-else-if="store.ides.length === 0"
      style="margin-top: 48px"
      :description="store.error ? t(store.error) : t('home.empty')"
    >
      <template #extra>
        <div class="empty-hint">{{ t('home.emptyHint') }}</div>
      </template>
    </n-empty>

    <n-grid v-else :cols="3" :x-gap="16" :y-gap="16" responsive="screen">
      <n-gi v-for="ide in store.ides" :key="ide.id">
        <n-card :bordered="false" class="ide-card" size="small" hoverable>
          <div class="ide-head">
            <div class="ide-name">
              <n-icon :component="IconHardwareChipOutline" :size="18" />
              <span>{{ ide.name }}</span>
            </div>
            <div class="ide-tags">
              <!-- 说明长文本改为问号图标 + 点击 popover，卡片高度统一、网格更整齐 -->
              <n-popover v-if="ide.noteKey" trigger="click" placement="bottom-end" :style="{ maxWidth: '340px' }">
                <template #trigger>
                  <button type="button" class="note-btn" :aria-label="t('home.noteAria')">
                    <n-icon :component="IconHelp" :size="16" />
                  </button>
                </template>
                <div class="note-pop">{{ t(ide.noteKey) }}</div>
              </n-popover>
              <n-tag v-if="ide.running && ide.installed" size="tiny" :bordered="false" type="warning">{{ t('home.running') }}</n-tag>
              <n-tag v-if="ide.installed && ide.capability !== 'manual'" size="tiny" :bordered="false" :type="ide.capability === 'auto' ? 'success' : 'info'">
                {{ ide.capability === 'auto' ? t('home.capability.auto') : t('home.capability.assist') }}
              </n-tag>
              <n-tag size="tiny" :color="{ color: statusMeta(ide.status).color + '22', textColor: statusMeta(ide.status).color, borderColor: 'transparent' }">
                {{ statusMeta(ide.status).label }}
              </n-tag>
            </div>
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
            <n-button v-if="ide.capability === 'auto'" size="small" type="primary" :disabled="!ide.installed || !hasCompatProvider(ide)" @click="openApply(ide)">
              <template #icon><n-icon :component="IconCheckmarkDone" :size="14" /></template>
              {{ t('common.apply') }}
            </n-button>
            <n-button v-else-if="ide.capability === 'assist'" size="small" type="primary" :disabled="!ide.installed || !hasCompatProvider(ide)" @click="openGenerate(ide)">
              <template #icon><n-icon :component="IconCheckmarkDone" :size="14" /></template>
              {{ t('home.generate') }}
            </n-button>
            <n-button size="small" :disabled="!ide.installed || ide.status === 'default' || ide.capability !== 'auto'" @click="confirmReset(ide)">
              <template #icon><n-icon :component="IconRefresh" :size="14" /></template>
              {{ t('common.reset') }}
            </n-button>
            <n-button size="small" :disabled="!ide.installed" @click="pickManualPath(ide)">
              {{ t('home.manualPath') }}
            </n-button>
          </div>
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
          <n-select v-model:value="selectedProviderId" :options="applyProviderOptions" :placeholder="t('home.selectProvider')" />
          <div v-if="!applyProviderOptions.length" class="empty-hint">{{ t('home.noCompatibleProvider') }}</div>
        </div>
        <n-space justify="end">
          <n-button @click="modalShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="applying" @click="confirmApply">{{ t('common.confirm') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>

    <!-- 生成配置弹窗（assist 型） -->
    <n-modal v-model:show="genShow" :mask-closable="false" preset="card" style="width: 560px" :title="t('home.generateTitle')">
      <n-space vertical :size="16">
        <div>
          <div class="form-label">{{ t('home.targetIde') }}</div>
          <n-tag>{{ genIde?.name }}</n-tag>
        </div>
        <div>
          <div class="form-label">{{ t('providers.name') }}</div>
          <n-select v-model:value="genProviderId" :options="genProviderOptions" :placeholder="t('home.selectProvider')" />
          <div v-if="!genProviderOptions.length" class="empty-hint">{{ t('home.noCompatibleProvider') }}</div>
        </div>
        <div v-if="genIde?.noteKey" class="ide-note">{{ t(genIde.noteKey) }}</div>
        <n-button size="small" :loading="generating" @click="confirmGenerate">{{ t('home.generate') }}</n-button>
        <div v-if="genText">
          <div class="form-label">{{ t('home.generateHint') }}</div>
          <n-input :value="genText" type="textarea" readonly :autosize="{ minRows: 6, maxRows: 14 }" class="gen-text" />
          <n-space justify="end" style="margin-top: 12px">
            <n-button v-if="genTargetPath" size="small" @click="openGenFolder">{{ t('home.openFolder') }}</n-button>
            <n-button size="small" type="primary" @click="copyGen">{{ t('home.copy') }}</n-button>
          </n-space>
        </div>
        <n-space justify="end">
          <n-button @click="genShow = false">{{ t('common.close') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>

    <!-- 批量应用弹窗（Jack-Med5） -->
    <n-modal v-model:show="batchShow" :mask-closable="false" preset="card" style="width: 520px" :title="t('home.batchApplyTitle')">
      <n-space vertical :size="16">
        <div>
          <div class="form-label">{{ t('home.selectIdes') }}</div>
          <n-select
            v-model:value="batchIdeIds"
            multiple
            :options="autoIdeOptions"
            :max-tag-count="6"
            :placeholder="t('home.selectIdes')"
          />
          <div v-if="batchProviderId && !autoIdeOptions.length" class="empty-hint">{{ t('home.noCompatibleIde') }}</div>
        </div>
        <div>
          <div class="form-label">{{ t('providers.name') }}</div>
          <n-select v-model:value="batchProviderId" :options="providerOptions" :placeholder="t('home.selectProvider')" />
        </div>
        <div v-if="batchRunning && batchProgress" class="batch-progress">{{ batchProgress }}</div>
        <n-space justify="end">
          <n-button :disabled="batchRunning" @click="batchShow = false">{{ t('common.cancel') }}</n-button>
          <n-button type="primary" :loading="batchRunning" @click="confirmBatch">{{ t('common.apply') }}</n-button>
        </n-space>
      </n-space>
    </n-modal>
  </div>
</template>

<style scoped>
.page-head { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 16px; }
.loading-state { display: flex; justify-content: center; align-items: center; padding: 72px 0; }
.ide-card { background: var(--bg-card); border: 1px solid var(--border); }
.ide-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; }
.ide-tags { display: flex; align-items: center; gap: 6px; }
.gen-text :deep(textarea) { font-family: monospace; font-size: 12px; }
.ide-name { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 14px; }
.ide-meta { margin-bottom: 14px; }
.meta-row { display: flex; justify-content: space-between; font-size: 12px; padding: 3px 0; }
.meta-label { color: var(--text-secondary); }
.meta-value { color: var(--text-primary); max-width: 60%; text-align: right; }
.meta-value.path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: monospace; font-size: 11px; }
.ide-actions { display: flex; gap: 8px; }
.ide-note { font-size: 11px; color: var(--warning); margin-top: 8px; line-height: 1.4; }
.note-btn { display: inline-flex; align-items: center; justify-content: center; width: 22px; height: 22px; padding: 0; border: none; border-radius: 50%; background: transparent; color: var(--warning); cursor: pointer; transition: background 0.15s ease; }
.note-btn:hover { background: var(--warning-soft); }
.note-btn:focus-visible { outline: 2px solid var(--warning); outline-offset: 1px; }
.note-pop { font-size: 12px; line-height: 1.6; }
.form-label { font-size: 12px; color: var(--text-secondary); margin-bottom: 6px; }
.empty-hint { margin-top: 6px; font-size: 12px; color: var(--text-secondary); }
.batch-progress { font-size: 12px; color: var(--warning); }
</style>
