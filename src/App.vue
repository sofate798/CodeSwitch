<script setup lang="ts">
import { computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import {
  NConfigProvider, NMessageProvider, NDialogProvider,
  NSpace, NTag, darkTheme,
  zhCN, enUS, dateZhCN, dateEnUS
} from 'naive-ui'
import {
  HomeOutline as IconHomeOutline, HardwareChipOutline as IconHardwareChipOutline,
  KeyOutline as IconKeyOutline, CameraOutline as IconCameraOutline,
  ArchiveOutline as IconArchiveOutline, ListOutline as IconListOutline,
  SettingsOutline as IconSettingsOutline,
  RefreshOutline as IconRefresh
} from '@vicons/ionicons5'
import { useAppStore } from './stores/app'
import logoUrl from './assets/logo.png'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const store = useAppStore()

const menu = computed(() => [
  { path: '/home', label: t('nav.home'), icon: IconHomeOutline },
  { path: '/providers', label: t('nav.providers'), icon: IconKeyOutline },
  { path: '/snapshots', label: t('nav.snapshots'), icon: IconCameraOutline },
  { path: '/backups', label: t('nav.backups'), icon: IconArchiveOutline },
  { path: '/logs', label: t('nav.logs'), icon: IconListOutline },
  { path: '/settings', label: t('nav.settings'), icon: IconSettingsOutline }
])

// 组件库主题覆盖：浅色仅微调主色；深色额外把 Naive 自带灰阶（弹窗/下拉/输入框/卡片）
// 对齐到 main.css 调色板，消除"组件灰与页面灰不一致"，并统一语义色。
const themeOverrides = computed(() => ({
  common: {
    borderRadius: '6px',
    primaryColor: '#3b82f6',
    primaryColorHover: '#60a5fa',
    primaryColorPressed: '#2563eb',
    ...(store.isDark
      ? {
          bodyColor: '#131419',
          cardColor: '#21232c',
          modalColor: '#272a34',
          popoverColor: '#272a34',
          inputColor: '#1a1c23',
          tableColor: '#21232c',
          borderColor: '#2c2f39',
          dividerColor: '#2c2f39',
          hoverColor: '#2b2e39',
          pressedColor: '#31343f',
          textColor1: '#eceef3',
          textColor2: '#d3d7df',
          textColor3: '#99a1b0',
          placeholderColor: '#6c7382',
          iconColor: '#99a1b0',
          iconColorHover: '#c7ccd6',
          infoColor: '#3b82f6',
          infoColorHover: '#60a5fa',
          infoColorPressed: '#2563eb',
          successColor: '#22c55e',
          successColorHover: '#4ade80',
          successColorPressed: '#16a34a',
          warningColor: '#f59e0b',
          warningColorHover: '#fbbf24',
          warningColorPressed: '#d97706',
          errorColor: '#ef4444',
          errorColorHover: '#f87171',
          errorColorPressed: '#dc2626'
        }
      : {})
  },
  // 深色主题下 Naive 把所有实心彩色按钮（primary/error/success/warning/info）的文字/图标
  // 默认取为 baseColor（=#000 黑），与彩色背景对比差、不易读。这里统一改为白色（浅色本就是白，两主题一致）。
  Button: {
    textColorPrimary: '#fff',
    textColorHoverPrimary: '#fff',
    textColorPressedPrimary: '#fff',
    textColorFocusPrimary: '#fff',
    textColorError: '#fff',
    textColorHoverError: '#fff',
    textColorPressedError: '#fff',
    textColorFocusError: '#fff',
    textColorSuccess: '#fff',
    textColorHoverSuccess: '#fff',
    textColorPressedSuccess: '#fff',
    textColorFocusSuccess: '#fff',
    textColorWarning: '#fff',
    textColorHoverWarning: '#fff',
    textColorPressedWarning: '#fff',
    textColorFocusWarning: '#fff',
    textColorInfo: '#fff',
    textColorHoverInfo: '#fff',
    textColorPressedInfo: '#fff',
    textColorFocusInfo: '#fff'
  }
}))

// Jack-High1：主题解析（含 'system' 跟随 OS 明暗）已上移到 store.isDark 单一数据源，
// matchMedia 监听也集中于 store；这里仅据解析结果选择 Naive 主题对象。
const activeTheme = computed(() => (store.isDark ? darkTheme : null))

// 动态走查发现：n-config-provider 未传 locale 时，Naive 组件内置文案（下拉“请选择”、输入框“请输入”等）
// 恒为库默认英文，与界面语言脱节。故随应用 locale 联动传入组件语言包与日期语言包。
const naiveLocale = computed(() => (store.settings.locale === 'en-US' ? enUS : zhCN))
const naiveDateLocale = computed(() => (store.settings.locale === 'en-US' ? dateEnUS : dateZhCN))

// 将同一选择同步到 <html data-theme>，让 main.css 的自定义变量（--bg-* / --text-* 等）跟随切换。
watch(() => store.isDark, (dark) => {
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
}, { immediate: true })

const activeKey = computed(() => route.path)
const installedCount = computed(() => store.installedIDEs.length)
const routeTitle = computed(() => t(String(route.meta.titleKey ?? '')))

onMounted(() => {
  // refreshAll / refreshSettings 内部均已 try/catch 兜底、绝不向外抛（值型通道失败会 reject，已在内接住），这里无需再 .catch。
  store.refreshAll()
  store.refreshSettings()
})

function nav(path: string) { router.push(path) }
</script>

<template>
  <n-config-provider :theme="activeTheme" :theme-overrides="themeOverrides" :locale="naiveLocale" :date-locale="naiveDateLocale">
    <n-message-provider>
      <n-dialog-provider>
        <div class="layout">
          <!-- 侧边栏 -->
          <aside class="sidebar">
            <div class="logo">
              <!-- 品牌标识豁免项：logo.png 为位图品牌 Logo，不适用矢量图标要求；
                   已通过 .logo-img 的 object-fit/尺寸处理，确保在深/浅主题下均清晰。 -->
              <img :src="logoUrl" class="logo-img" alt="CodeSwitch" />
              <span class="logo-text">CodeSwitch</span>
            </div>
            <nav class="nav">
              <button
                v-for="item in menu"
                :key="item.path"
                class="nav-item"
                :class="{ active: activeKey === item.path }"
                @click="nav(item.path)"
              >
                <n-icon :component="item.icon" :size="20" />
                <span>{{ item.label }}</span>
              </button>
            </nav>
            <div class="sidebar-footer">
              <n-tag size="tiny" :bordered="false" round>{{ t('statusbar.customized', { count: store.customizedCount }) }}</n-tag>
            </div>
          </aside>

          <!-- 主区 -->
          <div class="main">
            <header class="topbar">
              <div class="topbar-title">{{ routeTitle }}</div>
              <n-space align="center" :size="12">
                <n-button size="small" @click="store.refreshAll()">
                  <template #icon><n-icon :component="IconRefresh" :size="14" /></template>
                  {{ t('common.refresh') }}
                </n-button>
              </n-space>
            </header>

            <main class="content">
              <router-view />
            </main>

            <footer class="statusbar">
              <span>{{ t('statusbar.scanned', { count: installedCount }) }}</span>
              <span class="dot"></span>
              <span>{{ t('statusbar.local') }}</span>
            </footer>
          </div>
        </div>
      </n-dialog-provider>
    </n-message-provider>
  </n-config-provider>
</template>

<style scoped>
.layout { display: flex; height: 100vh; overflow: hidden; }
.sidebar {
  width: 200px; background: var(--bg-sidebar); border-right: 1px solid var(--border);
  display: flex; flex-direction: column; padding: 16px 10px; flex-shrink: 0;
}
.logo { display: flex; align-items: center; gap: 8px; padding: 4px 10px 20px; }
.logo-img { width: 24px; height: 24px; border-radius: 6px; object-fit: contain; display: block; }
.logo-text { font-weight: 700; font-size: 15px; letter-spacing: 0.3px; }
.nav { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.nav-item {
  display: flex; align-items: center; gap: 10px; padding: 9px 12px; border-radius: 6px;
  background: transparent; border: none; color: var(--text-secondary); cursor: pointer;
  font-size: 13.5px; transition: all 0.15s;
}
.nav-item:hover { background: var(--bg-hover); color: var(--text-primary); }
.nav-item:focus-visible { outline: 2px solid var(--ring); outline-offset: -2px; }
.nav-item.active { background: var(--accent-soft); color: var(--accent-strong); }
.sidebar-footer { padding: 10px; }

.main { flex: 1; display: flex; flex-direction: column; min-width: 0; }
/* Windows 原生窗口按钮覆盖层压在右上角（实测 136px 宽），右内边距须让出它，否则刷新按钮被盖住点不到；
   无覆盖层的平台 env 取回退值，结果仍为 16px */
.topbar {
  height: 48px; border-bottom: 1px solid var(--border);
  padding: 0 calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw) + 16px) 0 20px;
  display: flex; align-items: center; justify-content: space-between; flex-shrink: 0;
  -webkit-app-region: drag;
}
.topbar > * { -webkit-app-region: no-drag; }
.topbar-title { font-weight: 600; font-size: 14px; }
.content { flex: 1; overflow: hidden; position: relative; }
.content > * { height: 100%; }
.statusbar {
  height: 28px; border-top: 1px solid var(--border); padding: 0 16px;
  display: flex; align-items: center; gap: 10px; font-size: 12px; color: var(--text-secondary);
  flex-shrink: 0;
}
.dot { width: 4px; height: 4px; border-radius: 50%; background: var(--text-secondary); }
</style>
