import i18n from 'i18next'
import { initReactI18next } from 'react-i18next'
import type { AppSettings } from '@shared/types.ts'
import { en } from './locales/en.ts'
import { zh } from './locales/zh.ts'

export function resolveLocale(locale: AppSettings['locale']): 'zh' | 'en' {
  if (locale === 'zh' || locale === 'en') return locale
  return navigator.language.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

void i18n.use(initReactI18next).init({
  resources: { en: { translation: en }, zh: { translation: zh } },
  lng: resolveLocale('system'),
  fallbackLng: 'en',
  interpolation: { escapeValue: false },
  returnNull: false,
})

export function applyLocale(locale: AppSettings['locale']): void {
  const lng = resolveLocale(locale)
  if (i18n.language !== lng) void i18n.changeLanguage(lng)
  document.documentElement.lang = lng === 'zh' ? 'zh-CN' : 'en'
}

export default i18n
