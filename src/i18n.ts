import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

const saved = (localStorage.getItem('cs-locale') as 'zh-CN' | 'en-US') || 'zh-CN'

export const i18n = createI18n({
  legacy: false,
  locale: saved,
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
})

// 首屏可用 localStorage('cs-locale') 回退；F1 store 在 refreshSettings 后调用 setLocale
// 以后端 settings.locale 覆盖，作为语言的单一数据源。
export function setLocale(locale: string): void {
  i18n.global.locale.value = locale as 'zh-CN' | 'en-US'
  localStorage.setItem('cs-locale', locale)
}
