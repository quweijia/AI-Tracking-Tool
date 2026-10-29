import { create } from 'zustand'
import compareUrl from '../assets/dock-icons/compare.png'
import cursorAiUrl from '../assets/dock-icons/cursor-ai.png'
import letterDarkUrl from '../assets/dock-icons/letter-dark.png'
import cursorUrl from '../assets/dock-icons/cursor.png'
import letterLightUrl from '../assets/dock-icons/letter-light.png'

export type AppIconKey = 'default' | 'compare' | 'cursor-ai' | 'letter-dark' | 'cursor' | 'letter-light'

export interface AppIconOption {
  key: AppIconKey
  label: string
  url: string
}

/** 可选的自定义图标（默认项使用当前应用 icon，在设置页单独渲染） */
export const APP_ICONS: AppIconOption[] = [
  { key: 'compare', label: '双卡对比', url: compareUrl },
  { key: 'cursor-ai', label: 'AI 光标', url: cursorAiUrl },
  { key: 'cursor', label: '取景光标', url: cursorUrl },
  { key: 'letter-dark', label: '星环 A · 深色', url: letterDarkUrl },
  { key: 'letter-light', label: '星环 A · 浅色', url: letterLightUrl }
]

/** 按 key 找图标（含 default，default 无 url，由调用方提供当前应用 icon） */
export function findAppIcon(key: AppIconKey): AppIconOption | null {
  return APP_ICONS.find((o) => o.key === key) ?? null
}

interface AppIconState {
  key: AppIconKey
  setKey: (key: AppIconKey) => void
}

/** 应用图标选择（顶栏 logo 与 Dock 同步），持久化在 config.appIcon */
export const useAppIconStore = create<AppIconState>((set) => ({
  key: 'default',
  setKey: (key) => set({ key })
}))
