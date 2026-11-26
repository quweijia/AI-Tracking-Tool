import { BrowserWindow, app, ipcMain, session, shell } from 'electron'
import { join, dirname } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import { pathToFileURL } from 'url'

/**
 * 独立「开发浏览器」弹窗：
 * - 加载应用内 /browser 路由（地址栏 + 视口展示 + webview，persist:walkthrough 分区与内嵌浏览器登录态互通）
 * - 主窗口自动走查下发视口（宽度自动匹配 Figma 画板），弹窗内加载页面后由用户点击
 *   「生成问题标注」发起采集，结果经主进程转发回主窗口（流程发起方为弹窗本身）
 */
let popup: BrowserWindow | null = null
/** 当前弹窗模式：login / capture / 空（普通） */
let popupMode: 'login' | 'capture' | '' = ''

function popupPageUrl(url?: string, mode?: 'login' | 'capture', purpose?: 'newPage' | 'replaceImage'): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  const base = devUrl ? `${devUrl}/#/browser` : `file://${join(__dirname, '../renderer/index.html')}#/browser`
  const params: string[] = []
  if (url) params.push(`url=${encodeURIComponent(url)}`)
  if (mode) params.push(`mode=${mode}`)
  if (purpose) params.push(`purpose=${purpose}`)
  return params.length ? `${base}?${params.join('&')}` : base
}

/** 打开/聚焦开发浏览器弹窗；带 url 时导航（含已有窗口）。各模式互斥切换 */
export function openDevBrowserPopup(url?: string, opts?: { loginMode?: boolean; captureMode?: boolean; capturePurpose?: 'newPage' | 'replaceImage' }): { ok: boolean; message: string } {
  const target = url?.trim()
  let mode: 'login' | 'capture' | '' = ''
  if (opts?.loginMode) mode = 'login'
  else if (opts?.captureMode) mode = 'capture'
  const purpose = mode === 'capture' ? (opts?.capturePurpose || 'newPage') : undefined
  if (target && !/^https?:\/\//i.test(target) && !/^file:\/\//i.test(target)) {
    return { ok: false, message: 'URL 需以 http://、https:// 或 file:// 开头' }
  }
  if (popup && !popup.isDestroyed()) {
    // 采集模式：总是重建窗口，确保 mode=capture 参数正确传递
    // 其他模式：不同模式时重建，同模式时复用
    if (mode === 'capture' || popupMode !== mode) {
      popup.destroy()
      popup = null
      popupMode = ''
    } else {
      popup.show()
      popup.focus()
      if (target) popup.webContents.send('browser:navigate', target)
      return { ok: true, message: '已聚焦开发浏览器窗口' }
    }
  }
  const title = mode === 'login' ? '登录 · 内置浏览器' : mode === 'capture' ? '采集 · 内置浏览器' : '内置浏览器'
  popup = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 420,
    minHeight: 360,
    title,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })
  popupMode = mode
  popup.on('closed', () => {
    const wasLogin = popupMode === 'login'
    popupMode = ''
    popup = null
    if (wasLogin) void import('./walkSession').then(({ forwardLoginResult }) => forwardLoginResult('closed'))
  })
  popup.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    // 采集模式：guest 页面任何 window.open（target=_blank 链接/脚本弹窗）一律纯 deny——
    // 递归 openDevBrowserPopup 会命中「capture 模式总是重建」逻辑销毁当前采集弹窗，
    // 页面被整体重置（采集前功尽弃/采集中断）；其他模式维持「转发新开弹窗」行为
    if (mode === 'capture') return { action: 'deny' }
    if (/^https?:\/\//i.test(openUrl) || /^file:\/\//i.test(openUrl)) openDevBrowserPopup(openUrl, { loginMode: mode === 'login' })
    return { action: 'deny' }
  })
  void popup.loadURL(popupPageUrl(target, mode || undefined, purpose))
  return { ok: true, message: '已打开开发浏览器窗口' }
}

/** 关闭内置浏览器弹窗（自动走查登录等待超时/取消时调用） */
export function closeDevBrowserPopup(): void {
  if (popup && !popup.isDestroyed()) popup.close()
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

/** 产品标注采集：记录发起 openBrowserWindow 的主窗口（结果回传目标），避免窗口枚举误命中 overlay/选择器等辅助窗口 */
let captureOpener: BrowserWindow | null = null

/** 产品标注采集结果转发：显式 opener 优先，兜底窗口枚举排除法；失败与转发均有日志便于诊断 */
function forwardCaptureResult(channel: string, data: unknown): void {
  const size =
    data && typeof data === 'object' && 'dataUrl' in (data as Record<string, unknown>)
      ? String((data as { dataUrl?: unknown }).dataUrl ?? '').length
      : -1
  const target =
    captureOpener && !captureOpener.isDestroyed()
      ? captureOpener
      : BrowserWindow.getAllWindows().find(
          (w) => w !== popup && !w.isDestroyed() && !w.getTitle().includes('选择截图屏幕')
        )
  if (!target) {
    console.warn('[BROWSER] 采集结果无回传目标（发起窗口已关闭）:', channel)
    return
  }
  console.log('[BROWSER] 转发采集结果:', channel, '→ 目标窗口:', target.getTitle(), 'dataUrl 长度:', size)
  target.webContents.send(channel, data)
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
  ipcMain.handle('browser:openWindow', (e, url?: string, opts?: { loginMode?: boolean; captureMode?: boolean; capturePurpose?: 'newPage' | 'replaceImage' }) => {
    // 记录发起方（主窗口）：产品标注采集结果经弹窗回传时定位目标
    captureOpener = BrowserWindow.fromWebContents(e.sender)
    return openDevBrowserPopup(url, opts)
  })
  // 主窗口：登录等待超时/取消 → 关闭登录模式弹窗
  ipcMain.handle('browser:closeWindow', () => closeDevBrowserPopup())
  // 主窗口：下发自动走查视口
  ipcMain.on('browser:setViewport', (_e, vp: DevViewport) => sendPopupViewport(vp))
  // 弹窗页：挂载时拉取已下发的视口（规避「先发送后加载」竞态）
  ipcMain.handle('browser:popupGetViewport', () => lastViewport)
  // 弹窗页：回传采集结果 → 转发主窗口
  ipcMain.on('browser:walk-result', (_e, data: unknown) => forwardWalkResult(data))
  // 弹窗页：产品标注 URL 采集结果 → 转发发起方主窗口
  ipcMain.on('browser:new-page-result', (_e, data: unknown) => forwardCaptureResult('browser:new-page-result', data))
  // 弹窗页：产品标注画布 URL 采集（替换图片）结果 → 转发发起方主窗口
  ipcMain.on('browser:url-capture-result', (_e, data: unknown) => forwardCaptureResult('browser:url-capture-result', data))
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
  // 导出历史：在系统文件管理器（Finder/资源管理器）中定位报告文件。
  // 文件不存在（被手动删除/移动）时兜底打开其所在目录，避免静默无反应
  ipcMain.handle('file:showInFolder', (_e, filePath: string): boolean => {
    try {
      const p = filePath?.trim()
      if (!p) return false
      if (existsSync(p)) shell.showItemInFolder(p)
      else void shell.openPath(dirname(p))
      return true
    } catch {
      return false
    }
  })
  // 导出历史：删除记录时把本地 HTML 报告文件移入系统废纸篓（可恢复）；文件已不存在视为成功
  ipcMain.handle(
    'file:deleteReport',
    async (_e, filePath: string): Promise<{ ok: boolean; message: string }> => {
      try {
        const p = filePath?.trim()
        if (!p) return { ok: false, message: '缺少报告文件路径' }
        if (!/\.html?$/i.test(p)) return { ok: false, message: '仅支持删除 HTML 报告文件' }
        if (!existsSync(p)) return { ok: true, message: '' }
        await shell.trashItem(p)
        return { ok: true, message: '' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}
