import { BrowserWindow, app, ipcMain, session, shell } from 'electron'
import { join } from 'path'
import { readdirSync, statSync } from 'fs'
import { pathToFileURL } from 'url'

/**
 * 独立「开发浏览器」弹窗：
 * - 加载应用内 /browser 路由（地址栏 + 视口展示 + webview，persist:walkthrough 分区与内嵌浏览器登录态互通）
 * - 主窗口自动走查下发视口（宽度自动匹配 Figma 画板），弹窗内加载页面后由用户点击
 *   「生成问题标注」发起采集，结果经主进程转发回主窗口（流程发起方为弹窗本身）
 */
let popup: BrowserWindow | null = null

function popupPageUrl(url?: string): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const base = devUrl ? `${devUrl}/#/browser` : `file://${join(__dirname, '../renderer/index.html')}#/browser`
  return url ? `${base}?url=${encodeURIComponent(url)}` : base
}

/** 打开/聚焦开发浏览器弹窗；带 url 时导航（含已有窗口） */
export function openDevBrowserPopup(url?: string): { ok: boolean; message: string } {
  const target = url?.trim()
  if (target && !/^https?:\/\//i.test(target) && !/^file:\/\//i.test(target)) {
    return { ok: false, message: 'URL 需以 http://、https:// 或 file:// 开头' }
  }
  if (popup && !popup.isDestroyed()) {
    popup.show()
    popup.focus()
    if (target) popup.webContents.send('browser:navigate', target)
    return { ok: true, message: '已聚焦开发浏览器窗口' }
  }
  popup = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 420,
    minHeight: 360,
    title: '内置浏览器',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })
  popup.on('closed', () => {
    popup = null
  })
  void popup.loadURL(popupPageUrl(target || undefined))
  return { ok: true, message: '已打开开发浏览器窗口' }
}

/** 自动走查视口（autoWidth=true 表示宽度来自 Figma 画板尺寸，弹窗内只读展示） */
export interface DevViewport {
  width: number
  height: number
  autoWidth?: boolean
}

/** 最近一次下发的视口：弹窗页可能在视口消息后才完成加载，挂载时通过 popupGetViewport 拉取兜底 */
let lastViewport: DevViewport | null = null

/** 主窗口下发视口：缓存 + 实时推送（弹窗未就绪时由弹窗挂载拉取） */
function sendPopupViewport(vp: DevViewport): void {
  lastViewport = vp
  if (popup && !popup.isDestroyed()) popup.webContents.send('browser:viewport', vp)
}

/** 弹窗采集结果转发主窗口（主窗口 = 除弹窗外唯一的窗口） */
function forwardWalkResult(data: unknown): void {
  const main = BrowserWindow.getAllWindows().find((w) => w !== popup && !w.isDestroyed())
  main?.webContents.send('browser:walk-captured', data)
}

/** 递归统计目录体积（字节），目录不存在或不可读返回 0 */
function dirSize(p: string): number {
  try {
    let total = 0
    for (const name of readdirSync(p)) {
      const fp = join(p, name)
      const st = statSync(fp)
      total += st.isDirectory() ? dirSize(fp) : st.size
    }
    return total
  } catch {
    return 0
  }
}

/** 字节 → 人类可读体积：≥1MB 显示 X.X MB，否则显示 KB */
function fmtSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 注册浏览器弹窗相关 IPC */
export function registerBrowserHandlers(): void {
  ipcMain.handle('browser:openWindow', (_e, url?: string) => openDevBrowserPopup(url))
  // 主窗口：下发自动走查视口
  ipcMain.on('browser:setViewport', (_e, vp: DevViewport) => sendPopupViewport(vp))
  // 弹窗页：挂载时拉取已下发的视口（规避「先发送后加载」竞态）
  ipcMain.handle('browser:popupGetViewport', () => lastViewport)
  // 弹窗页：回传采集结果 → 转发主窗口
  ipcMain.on('browser:walk-result', (_e, data: unknown) => forwardWalkResult(data))
  // 设置页：清除内置浏览器（persist:walkthrough 分区）保存的浏览数据
  ipcMain.handle('browser:clearData', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      // 清除前统计分区数据目录体积，用于提示释放了多少空间
      const partitionDir = join(app.getPath('userData'), 'Partitions', 'walkthrough')
      const before = dirSize(partitionDir)
      const ses = session.fromPartition('persist:walkthrough')
      await ses.clearStorageData({
        storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage', 'shadercache']
      })
      await ses.clearCache()
      const freed = Math.max(before - dirSize(partitionDir), before)
      return {
        ok: true,
        message: before > 0 ? `已清除 ${fmtSize(freed)} 浏览数据（Cookies、本地存储、缓存等）` : '已清除浏览记录（Cookies、本地存储、缓存等），暂无数据'
      }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  // webview 外部站点 ERR_FAILED(-2) 兜底：将内置浏览器分区切为直连（系统代理不可达/拦截时恢复加载）
  ipcMain.handle('browser:setDirectProxy', async (): Promise<{ ok: boolean; message: string }> => {
    try {
      await session.fromPartition('persist:walkthrough').setProxy({ mode: 'direct' })
      return { ok: true, message: '已切换为直连' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  // 分析报告：用系统浏览器打开本地导出的 HTML 报告文件
  ipcMain.handle('report:openSystem', async (_e, filePath: string): Promise<{ ok: boolean; message: string }> => {
    try {
      if (!filePath?.trim()) return { ok: false, message: '缺少报告文件路径' }
      await shell.openExternal(pathToFileURL(filePath.trim()).href)
      return { ok: true, message: '已在系统浏览器打开' }
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) }
    }
  })
  // 分析报告：用内置浏览器弹窗打开本地导出的 HTML 报告文件
  ipcMain.handle('report:openBuiltin', (_e, filePath: string) => {
    if (!filePath?.trim()) return { ok: false, message: '缺少报告文件路径' }
    return openDevBrowserPopup(pathToFileURL(filePath.trim()).href)
  })
}
