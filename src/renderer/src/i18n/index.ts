import i18next, { type i18n as I18n } from 'i18next'
import { initReactI18next } from 'react-i18next'

/**
 * 界面语言初始化：
 * - 语言包按 namespace 拆分（一个源文件对应 locales/<lang>/ 下的一个模块文件）
 * - 持久化沿用 localStorage['app-lang']（与 app-theme 模式一致）
 * - 语言变化时同步 <html lang> 并通知主进程重建应用菜单
 */

/** 收集 locales/<lang>/ 下所有模块，模块文件名即 namespace 名 */
function collect(mods: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {}
  for (const [path, mod] of Object.entries(mods)) {
    const name = path.split('/').pop()!.replace(/\.ts$/, '')
    out[name] = (mod as { default: Record<string, unknown> }).default
  }
  return out
}

const zhModules = import.meta.glob('./locales/zh-CN/*.ts', { eager: true })
const enModules = import.meta.glob('./locales/en-US/*.ts', { eager: true })

export type AppLang = 'zh-CN' | 'en-US'

const saved = localStorage.getItem('app-lang')
export const initialLang: AppLang = saved === 'en-US' ? 'en-US' : 'zh-CN'

const i18n: I18n = i18next.createInstance()

void i18n.use(initReactI18next).init({
  resources: {
    'zh-CN': collect(zhModules),
    'en-US': collect(enModules)
  },
  lng: initialLang,
  fallbackLng: 'zh-CN',
  defaultNS: 'common',
  interpolation: { escapeValue: false },
  returnEmptyString: false
})

// 同步 <html lang>（index.html 硬编码 zh-CN，切语言后动态更新）
document.documentElement.lang = initialLang
i18n.on('languageChanged', (lng) => {
  document.documentElement.lang = lng
  // 通知主进程重建应用菜单（菜单文案由主进程维护）
  void window.electronAPI?.setAppLang?.(lng as AppLang)
})

/** 切换界面语言（设置页调用；非组件环境也可直接改 i18n） */
export function changeAppLang(lang: AppLang): void {
  localStorage.setItem('app-lang', lang)
  void i18n.changeLanguage(lang)
}

/** 非 React 环境（store / db / 工具函数）取文案；语言切换后新取值生效 */
export function tr(key: string, ns: string, options?: Record<string, unknown>): string {
  return i18n.t(key, { ns, ...(options ?? {}) }) as string
}

export default i18n
