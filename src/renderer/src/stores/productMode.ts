import { create } from 'zustand'

/**
 * 产品模式（产品标注工具）全局开关。
 *
 * - 持久化：沿用 electron 配置文件（config:get / config:set），重启后状态保持
 * - 联动：切换后广播 CustomEvent('product-mode-change')，与 spec-menu-change / app-theme-change 同一先例；
 *   主要消费者（Layout / Settings / 路由守卫）直接订阅本 store
 * - 隔离：仅控制 UI 显隐与路由可达性，不改动任何走查数据与渲染逻辑
 */

/** 配置文件中的 key（勿改，历史持久化依赖） */
const CONFIG_KEY = 'productModeEnabled'

export type AppMode = 'walk' | 'product'

interface ProductModeState {
  /** 是否启用产品模式 */
  enabled: boolean
  /** 是否已完成首次配置加载（路由守卫需等加载完成，避免启动时误跳转） */
  loaded: boolean
  /** 应用启动时调用一次：从配置读取开关状态 */
  load: () => void
  /** 切换开关：立即生效 + 持久化 + 广播事件 */
  setEnabled: (next: boolean) => void
  /** 当前模式（便利派生） */
  mode: () => AppMode
}

export const useProductModeStore = create<ProductModeState>((set, get) => ({
  enabled: false,
  loaded: false,
  load: () => {
    void window.electronAPI.getConfig().then((cfg) => {
      const enabled = cfg[CONFIG_KEY] === true
      console.log(`[PRODUCT_MODE] load from config: enabled=${enabled}`)
      set({ enabled, loaded: true })
    })
  },
  setEnabled: (next) => {
    if (get().enabled === next) return
    set({ enabled: next })
    console.log(`[PRODUCT_MODE] setEnabled -> ${next}; broadcast product-mode-change`)
    void window.electronAPI.setConfig(CONFIG_KEY, next)
    // 通知所有消费者立即联动（标题 / 菜单过滤 / 路由守卫）
    window.dispatchEvent(new CustomEvent('product-mode-change', { detail: next }))
  },
  mode: () => (get().enabled ? 'product' : 'walk')
}))

/** 当前是否产品模式（非 React 上下文便利读取） */
export const isProductMode = (): boolean => useProductModeStore.getState().enabled
