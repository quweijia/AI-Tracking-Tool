import { create } from 'zustand'

/** 设置中心左侧导航的分区 key（侧边栏导航与设置页内容区共用） */
export type SettingsTab = 'models' | 'general' | 'mcp' | 'skills' | 'auth' | 'browser' | 'about'

interface SettingsState {
  tab: SettingsTab
  setTab: (tab: SettingsTab) => void
}

export const useSettingsStore = create<SettingsState>((set) => ({
  tab: 'models',
  setTab: (tab) => set({ tab })
}))
