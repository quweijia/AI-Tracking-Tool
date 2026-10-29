import { app, ipcMain, nativeImage } from 'electron'
import type { NativeImage } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { getConfigData } from './ipc'

/**
 * 自定义 Dock 栏图标（macOS）：
 * - 设置页选择后即时生效（app.dock.setIcon），并持久化 PNG 到 userData/dock-icons/
 * - 启动时 restoreDockIcon() 恢复上次的非默认选择；默认方案 dev 用 build/icon.png，打包版由 Info.plist 生效
 */

/** 恢复默认图标：先尝试系统级重置，dev 下再用 build/icon.png 兜底 */
function resetToDefaultIcon(): void {
  try {
    // Electron 类型未标注 null，运行时传 nil 会恢复 macOS 默认应用图标
    ;(app.dock as unknown as { setIcon: (img: NativeImage | null) => void }).setIcon(null)
  } catch {
    // 忽略：老版本可能不接受 null
  }
  if (!app.isPackaged) {
    try {
      app.dock.setIcon(join(app.getAppPath(), 'build/icon.png'))
    } catch {
      // 忽略图标设置失败，不阻塞调用方
    }
  }
}

/** 应用指定图标（key='default' 时恢复默认）；自定义图标同时持久化，供下次启动恢复 */
export function applyDockIcon(key: string, dataUrl?: string): { ok: boolean; message: string } {
  if (process.platform !== 'darwin' || !app.dock) {
    return { ok: true, message: '当前平台不支持自定义 Dock 图标' }
  }
  try {
    if (!key || key === 'default' || !dataUrl) {
      resetToDefaultIcon()
      return { ok: true, message: '已恢复默认图标' }
    }
    const image = nativeImage.createFromDataURL(dataUrl)
    if (image.isEmpty()) return { ok: false, message: '图标数据无效' }
    app.dock.setIcon(image)
    // 持久化：下次启动恢复
    const dir = join(app.getPath('userData'), 'dock-icons')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${key}.png`), image.toPNG())
    return { ok: true, message: 'Dock 图标已更新' }
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}

/** 启动时恢复上次的非默认图标选择（读取持久化的 PNG） */
export function restoreDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return
  try {
    const key = getConfigData()['appIcon'] as string | undefined
    if (!key || key === 'default') return
    const file = join(app.getPath('userData'), 'dock-icons', `${key}.png`)
    if (!existsSync(file)) return
    const image = nativeImage.createFromPath(file)
    if (!image.isEmpty()) app.dock.setIcon(image)
  } catch {
    // 忽略恢复失败，保持默认图标
  }
}

export function registerDockIconHandlers(): void {
  ipcMain.handle('dock-icon:set', (_e, key: string, dataUrl?: string) => applyDockIcon(key, dataUrl))
}
