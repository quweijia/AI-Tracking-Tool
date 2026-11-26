import { execFile, execFileSync, spawn, type ChildProcess } from 'child_process'
import { mkdtempSync, rmSync, appendFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { app, BrowserWindow, ipcMain, nativeImage, screen, shell, systemPreferences } from 'electron'
import type { NativeImage, Rectangle } from 'electron'

/** 截图诊断日志文件（写入 userData 目录，崩溃时仍可查阅） */
function getCaptureLogPath(): string {
  return join(app.getPath('userData'), 'capture.log')
}
function logCapture(s: string): void {
  const line = `[${new Date().toISOString()}] ${s}\n`
  try { appendFileSync(getCaptureLogPath(), line) } catch {}
  console.log(`[CAPTURE] ${s}`)
}

/** overlay 选区（主窗口 CSS 像素，相对 overlay 左上角） */
interface SelectRect {
  x: number
  y: number
  width: number
  height: number
}

type CaptureResult =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: 'permission' | 'cancelled' | 'error' | 'busy' }

/** 一次进行中的截图会话（同一时刻仅允许一个，null = 空闲） */
interface CaptureSession {
  overlay: BrowserWindow
  /** 冻结帧原图（物理像素） */
  fullImage: NativeImage
  /** 目标显示器 DIP 边界（选区坐标基准） */
  displayBounds: Rectangle
  /** 发起截图的主窗口，结束后恢复焦点 */
  hostWin: BrowserWindow | null
  resolve: (r: CaptureResult) => void
}

let session: CaptureSession | null = null

/**
 * 选区 overlay 页面（自包含，不加载 renderer bundle，避免 Dexie/会话副作用）。
 * 交互：十字光标拖拽画框、光标放大镜（最近邻放大 + 像素网格 + 十字准线 + HEX 色值 +
 * 滚轮 4~16 倍，与画布测量/吸色放大镜同款体验）、选区端点吸附光标下像素中心（与放大镜
 * 准星严格对齐）、选区外暗化、尺寸徽标、拖拽 <8px 或 Esc 视为取消。
 * 注意：模板字符串内禁用反引号与 ${，脚本全部用普通引号。
 */
const OVERLAY_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;cursor:crosshair;user-select:none;-webkit-user-select:none;background:#000}
#bg{position:fixed;left:0;top:0;width:100vw;height:100vh;display:block}
#box{position:fixed;display:none;border:1px solid #2563eb;box-shadow:0 0 0 100000px rgba(15,23,42,.4);z-index:10}
#size{position:fixed;display:none;transform:translateX(-50%);background:#2563eb;color:#fff;font:12px/1 -apple-system,'Segoe UI',sans-serif;padding:4px 8px;border-radius:4px;white-space:nowrap;z-index:11}
#loupe{position:fixed;display:none;border-radius:50%;overflow:hidden;border:2px solid rgba(15,23,42,.9);background:rgba(15,23,42,.35);box-shadow:0 6px 20px rgba(0,0,0,.35);z-index:20;pointer-events:none}
#loupe canvas{display:block}
#chip{position:fixed;display:none;width:118px;box-sizing:border-box;background:rgba(15,23,42,.92);color:#f8fafc;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;padding:6px 9px;border-radius:6px;box-shadow:0 4px 12px rgba(0,0,0,.3);z-index:20;pointer-events:none;white-space:nowrap}
#chip .r1{display:flex;justify-content:space-between}
#chip .r2{opacity:.85}
</style></head><body><img id="bg" alt=""><div id="box"></div><div id="size"></div><div id="loupe"><canvas id="lcv"></canvas></div><div id="chip"><div class="r1"><span id="hex">------</span><span id="zmv">×8</span></div><div class="r2" id="rgb">rgb(-, -, -)</div></div>
<script>
(function () {
  var api = window.electronAPI
  var bg = document.getElementById('bg'), box = document.getElementById('box'), size = document.getElementById('size')
  var loupe = document.getElementById('loupe'), lcv = document.getElementById('lcv'), chip = document.getElementById('chip')
  var hexEl = document.getElementById('hex'), rgbEl = document.getElementById('rgb'), zmvEl = document.getElementById('zmv')
  var dw = 0, dh = 0, sx = 0, sy = 0, dragging = false
  // 放大镜：冻结帧整图物理像素缓存 + 倍率状态（默认 8 倍，滚轮 4~16，与画布测量/吸色放大镜一致）
  var src = null
  var zoom = 8
  var ZMIN = 4, ZMAX = 16, TARGET = 148, OFFSET = 18, CHIP_W = 118
  api.captureOverlayInit().then(function (data) {
    if (!data) return
    dw = data.width; dh = data.height
    var img = new Image()
    img.onload = function () {
      bg.src = data.bgDataUrl
      // 构建放大镜整图采样缓存（一次性读取 ImageData，之后中心取色只查数组）
      try {
        var c = document.createElement('canvas')
        c.width = img.naturalWidth; c.height = img.naturalHeight
        var c2 = c.getContext('2d', { willReadFrequently: true })
        c2.drawImage(img, 0, 0)
        src = { canvas: c, w: c.width, h: c.height, data: c2.getImageData(0, 0, c.width, c.height).data }
      } catch (err) { src = null }
      api.captureOverlayShown()
    }
    img.src = data.bgDataUrl
  })
  function update(x, y, w, h) {
    box.style.left = x + 'px'; box.style.top = y + 'px'; box.style.width = w + 'px'; box.style.height = h + 'px'
    size.textContent = Math.round(w) + ' × ' + Math.round(h)
    size.style.left = (x + w / 2) + 'px'; size.style.top = Math.min(y + h + 12, dh - 28) + 'px'
  }
  // ---- 光标放大镜（最近邻放大，内容锚定光标下的图像物理像素，保证取框起点精准）----
  function hideLoupe() { loupe.style.display = 'none'; chip.style.display = 'none' }
  function drawLoupe(mx, my) {
    if (!src || dw <= 0 || dh <= 0) return
    var r = Math.max(2, Math.round(TARGET / (2 * zoom)))
    var span = 2 * r + 1
    var sz = span * zoom
    var dpr = window.devicePixelRatio || 1
    lcv.width = Math.round(sz * dpr); lcv.height = Math.round(sz * dpr)
    lcv.style.width = sz + 'px'; lcv.style.height = sz + 'px'
    loupe.style.width = sz + 'px'; loupe.style.height = sz + 'px'
    var ctx = lcv.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false
    var cx = Math.min(src.w - 1, Math.max(0, Math.floor(mx * src.w / dw)))
    var cy = Math.min(src.h - 1, Math.max(0, Math.floor(my * src.h / dh)))
    ctx.clearRect(0, 0, sz, sz)
    try { ctx.drawImage(src.canvas, cx - r, cy - r, span, span, 0, 0, sz, sz) } catch (err) { return }
    // 浅灰像素网格线（偏移 0.5 保证 1px 细线）
    ctx.strokeStyle = 'rgba(148,163,184,.45)'
    ctx.lineWidth = 1
    ctx.beginPath()
    for (var i = 1; i <= 2 * r; i++) {
      var p = i * zoom + 0.5
      ctx.moveTo(p, 0); ctx.lineTo(p, sz)
      ctx.moveTo(0, p); ctx.lineTo(sz, p)
    }
    ctx.stroke()
    // 中心像素高亮框 + 细十字准线（深色描边 + 白色细线，深浅底色都可见）
    var c0 = sz / 2
    ctx.strokeStyle = 'rgba(255,92,92,.9)'
    ctx.strokeRect(c0 - zoom / 2 + 0.5, c0 - zoom / 2 + 0.5, zoom - 1, zoom - 1)
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.55)'
    ctx.beginPath(); ctx.moveTo(0, c0); ctx.lineTo(sz, c0); ctx.moveTo(c0, 0); ctx.lineTo(c0, sz); ctx.stroke()
    ctx.lineWidth = 1; ctx.strokeStyle = 'rgba(255,255,255,.95)'
    ctx.beginPath(); ctx.moveTo(0, c0); ctx.lineTo(sz, c0); ctx.moveTo(c0, 0); ctx.lineTo(c0, sz); ctx.stroke()
    // 中心像素色值（HEX/RGB），读整图缓存数组
    var o = (cy * src.w + cx) * 4
    var hex = '#' + [src.data[o], src.data[o + 1], src.data[o + 2]]
      .map(function (v) { return v.toString(16).padStart(2, '0') }).join('').toUpperCase()
    hexEl.textContent = hex
    rgbEl.textContent = 'rgb(' + src.data[o] + ', ' + src.data[o + 1] + ', ' + src.data[o + 2] + ')'
    zmvEl.textContent = '×' + zoom
    // 圆随光标跟手：默认光标右下方，贴近屏幕右/下边缘翻转到左/上方；色值条贴放大镜外侧
    var lx = mx + OFFSET, ly = my + OFFSET
    if (lx + sz > dw - 4) lx = mx - OFFSET - sz
    if (ly + sz > dh - 4) ly = my - OFFSET - sz
    lx = Math.max(4, Math.min(lx, dw - sz - 4))
    ly = Math.max(4, Math.min(ly, dh - sz - 4))
    loupe.style.left = lx + 'px'; loupe.style.top = ly + 'px'
    var chx = lx + sz + 10
    if (chx + CHIP_W > dw - 4) chx = lx - CHIP_W - 10
    chx = Math.max(4, Math.min(chx, dw - CHIP_W - 4))
    chip.style.left = chx + 'px'
    chip.style.top = Math.max(4, Math.min(ly, dh - 56)) + 'px'
    loupe.style.display = 'block'; chip.style.display = 'block'
  }
  // 选区端点吸附：取光标下图像像素的中心（与画布测距/吸色端点口径一致）。
  // 放大镜准星始终穿过该像素中心，吸附后选框边角与准星严格重合，消除鼠标光标与
  // 放大镜十字光标的偏移错位（src 构建失败时退回原始坐标，行为不变）
  function snapX(mx) {
    if (!src || dw <= 0) return mx
    return (Math.min(src.w - 1, Math.max(0, Math.floor(mx * src.w / dw))) + 0.5) * dw / src.w
  }
  function snapY(my) {
    if (!src || dh <= 0) return my
    return (Math.min(src.h - 1, Math.max(0, Math.floor(my * src.h / dh))) + 0.5) * dh / src.h
  }
  document.addEventListener('mousedown', function (e) {
    if (e.button !== 0) return
    dragging = true; sx = snapX(e.clientX); sy = snapY(e.clientY)
    box.style.display = 'block'; size.style.display = 'block'; update(sx, sy, 0, 0)
  })
  document.addEventListener('mousemove', function (e) {
    drawLoupe(e.clientX, e.clientY)
    if (!dragging) return
    var ex = snapX(e.clientX), ey = snapY(e.clientY)
    update(Math.min(sx, ex), Math.min(sy, ey), Math.abs(ex - sx), Math.abs(ey - sy))
  })
  document.addEventListener('mouseleave', hideLoupe)
  // 滚轮调节倍率（4~16，步进 2），重绘当前光标位置
  document.addEventListener('wheel', function (e) {
    e.preventDefault()
    zoom = Math.min(ZMAX, Math.max(ZMIN, zoom + (e.deltaY < 0 ? 2 : -2)))
    drawLoupe(e.clientX, e.clientY)
  }, { passive: false })
  document.addEventListener('mouseup', function (e) {
    if (!dragging) return
    dragging = false
    var ex = snapX(e.clientX), ey = snapY(e.clientY)
    var w = Math.abs(ex - sx), h = Math.abs(ey - sy)
    if (w < 8 || h < 8) { api.captureOverlayCancel(); return }
    api.captureOverlaySelect({ x: Math.min(sx, ex), y: Math.min(sy, ey), width: w, height: h })
  })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') api.captureOverlayCancel() })
  document.addEventListener('contextmenu', function (e) { e.preventDefault() })
})()
</script></body></html>`

/** 选区裁剪：CSS 像素 clamp 到显示器内 → 按冻结帧缩放比换算物理像素 → 原图无损裁剪 */
function cropSelection(fullImage: NativeImage, displayBounds: Rectangle, rect: SelectRect): string {
  const cx = Math.max(0, Math.min(rect.x, displayBounds.width))
  const cy = Math.max(0, Math.min(rect.y, displayBounds.height))
  const cw = Math.max(1, Math.min(rect.width, displayBounds.width - cx))
  const ch = Math.max(1, Math.min(rect.height, displayBounds.height - cy))
  const scale = fullImage.getSize().width / displayBounds.width
  const cropped = fullImage.crop({
    x: Math.round(cx * scale),
    y: Math.round(cy * scale),
    width: Math.max(1, Math.round(cw * scale)),
    height: Math.max(1, Math.round(ch * scale))
  })
  return 'data:image/png;base64,' + cropped.toPNG().toString('base64')
}

/** 统一收尾：关闭 overlay → 裁剪/取消 → 恢复主窗口焦点 → resolve（session 已置 null 时防重入直接返回） */
function finish(rect: SelectRect | null): void {
  const s = session
  if (!s) return
  session = null
  if (!s.overlay.isDestroyed()) s.overlay.close()
  let result: CaptureResult
  if (rect) {
    try {
      result = { ok: true, dataUrl: cropSelection(s.fullImage, s.displayBounds, rect) }
    } catch (err) {
      console.warn('[CAPTURE] 选区裁剪失败:', err)
      result = { ok: false, reason: 'error' }
    }
  } else {
    result = { ok: false, reason: 'cancelled' }
  }
  const host = s.hostWin
  if (host && !host.isDestroyed()) {
    if (host.isMinimized()) host.restore()
    host.show()
    host.focus()
  }
  s.resolve(result)
}

/**
 * 屏幕选择器页面：多显示器时弹出缩略图列表，用户点击目标屏后关闭。
 * 注意：模板字符串内禁用反引号与 ${，脚本全部用普通引号。
 */
const PICKER_HTML_TEMPLATE = (screens: string) => `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;padding:0;background:#0f172a;overflow:hidden;user-select:none;-webkit-user-select:none}
#picker{display:flex;gap:16px;padding:24px;align-items:center;justify-content:center;flex-wrap:wrap;min-height:100vh}
.scr-card{position:relative;cursor:pointer;border-radius:8px;overflow:hidden;transition:transform .15s,box-shadow .15s;border:3px solid transparent;background:#1e293b}
.scr-card:hover{border-color:#2563eb;transform:scale(1.03);box-shadow:0 0 24px rgba(37,99,235,.35)}
.scr-card img{display:block;max-width:320px;max-height:180px;object-fit:cover}
.scr-ph{width:300px;height:168px;display:flex;align-items:center;justify-content:center;color:#64748b;font:13px/1.8 -apple-system,'Segoe UI',sans-serif;text-align:center}
.scr-label{position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.65);color:#fff;font:12px/1.5 -apple-system,'Segoe UI',sans-serif;padding:4px 8px;text-align:center}
</style></head><body><div id="picker">${screens}</div>
<script>
(function () {
  var api = window.electronAPI
  var picker = document.getElementById('picker')
  if (!api || !picker) { document.body.textContent = '选择器初始化失败（preload 未加载）'; return }
  picker.addEventListener('click', function (e) {
    var card = e.target.closest('.scr-card')
    if (!card) return
    var idx = parseInt(card.getAttribute('data-idx'), 10)
    api.captureScreenPick(idx)
  })
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') api.captureScreenPick(-1)
  })
})()
</script></body></html>`

/** 执行一次系统 screencapture 区域截图（-x 静默，输出 PNG 到指定文件）
 * 通过 AppleScript 间接调用，避免 Node.js child_process 直接触发 ThreadPool CHECK 崩溃 */
function runScreencapture(area: Rectangle, file: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = `do shell script "screencapture -x -t png -R ${area.x},${area.y},${area.width},${area.height} '${file}'"`
    execFile(
      'osascript',
      ['-e', script],
      { timeout: 10000 },
      (err) => (err ? reject(err) : resolve())
    )
  })
}

/** 创建临时目录（用完在 finally 中清理） */
function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), 'aiwt-capture-'))
}

/**
 * 屏幕缩略图（选择器用）：返回 JPEG dataURL，失败返回 ''。
 * 改用系统 screencapture CLI：desktopCapturer 在 macOS + Electron 33 环境下
 * 反复触发线程池 CHECK 原生崩溃（NOTREACHED 闪退），彻底绕开。
 */
async function captureDisplayThumbnail(bounds: Rectangle): Promise<string> {
  const dir = makeTempDir()
  const file = join(dir, 'thumb.png')
  try {
    await runScreencapture(bounds, file)
    const img = nativeImage.createFromPath(file)
    if (img.isEmpty()) return ''
    const resized = img.getSize().width > 640 ? img.resize({ width: 640 }) : img
    return 'data:image/jpeg;base64,' + resized.toJPEG(70).toString('base64')
  } catch (err) {
    console.warn('[CAPTURE] 屏幕缩略图抓取失败:', err)
    return ''
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败忽略
    }
  }
}

/**
 * 冻结帧原图（冻结帧用）：物理像素 PNG。
 * 同样走 screencapture CLI，按显示器 bounds 全局坐标截取（Retina 下输出物理分辨率）。
 */
async function captureDisplayFrame(bounds: Rectangle): Promise<NativeImage> {
  const dir = makeTempDir()
  const file = join(dir, 'freeze.png')
  try {
    await runScreencapture(bounds, file)
    return nativeImage.createFromPath(file)
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // 清理失败忽略
    }
  }
}

/** 显示屏幕选择器窗口（多显示器时调用），用户点击目标屏后返回 Display；取消返回 null */
async function showScreenPicker(hostWin: BrowserWindow | null, displays: Electron.Display[], thumbs: string[]): Promise<Electron.Display | null> {
  // 构建 HTML 卡片（按 display 顺序，确保索引一致）
  const cards = displays.map((display, idx) => {
    const bgDataUrl = thumbs[idx] ?? ''
    const label = display.label || `Display ${idx + 1}`
    // 缩略图可能为空（捕获流未热）：显示占位提示，卡片仍可点击
    const thumbHtml = bgDataUrl
      ? `<img src="${bgDataUrl}" alt="${label}">`
      : `<div class="scr-ph">预览暂不可用<br>仍可点击该屏幕进行截图</div>`
    return `<div class="scr-card" data-idx="${idx}">${thumbHtml}<div class="scr-label">${label}${display.bounds.width}×${display.bounds.height}</div></div>`
  }).join('')

  const pickerHtml = PICKER_HTML_TEMPLATE(cards)

  // 计算居中位置（主窗口或主显示器）
  const bounds = hostWin && !hostWin.isDestroyed() ? hostWin.getBounds() : undefined
  const posX = bounds ? Math.round(bounds.x + (bounds.width - 720) / 2) : Math.round((screen.getPrimaryDisplay().bounds.width - 720) / 2)
  const posY = bounds ? Math.round(bounds.y + (bounds.height - 300) / 2) : Math.round((screen.getPrimaryDisplay().bounds.height - 300) / 2)

  const picker = new BrowserWindow({
    x: posX,
    y: posY,
    width: 720,
    height: 300,
    show: false,
    frame: true,
    resizable: false,
    minimizable: false,
    maximizable: false,
    title: '选择截图屏幕',
    alwaysOnTop: true,
    center: true,
    skipTaskbar: true,
    // 不用 modal：macOS 上 modal 子窗口会成为父窗口的 sheet，特殊窗口层级
    // 与截图 overlay（screen-saver 层级）并存时易触发 AppKit 原生崩溃（闪退）
    modal: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      backgroundThrottling: false
    }
  })

  return new Promise((resolve) => {
    // 统一收口：选择 / 取消 / 窗口关闭都必须移除监听器。
    // 若监听器残留，下次截图时旧闭包访问已销毁窗口的 webContents 会抛
    // "Object has been destroyed"，中断 EventEmitter 派发导致新监听器收不到点击。
    let settled = false
    const settle = (r: Electron.Display | null) => {
      if (settled) return
      settled = true
      ipcMain.removeListener('capture-screen-pick', onPick)
      // 等 picker 完全销毁后再 resolve：resolve 会立即唤醒调用方去创建
      // alwaysOnTop overlay，若 modal sheet 尚在销毁中并发创建窗口，
      // macOS 上会触发窗口层级冲突的原生崩溃（应用闪退）
      if (picker.isDestroyed()) {
        resolve(r)
        return
      }
      picker.once('closed', () => resolve(r))
      picker.close()
    }
    const onPick = (e: Electron.IpcMainEvent, idx: number) => {
      if (picker.isDestroyed()) return
      try {
        if (e.sender !== picker.webContents) return
      } catch {
        // e.sender 已是销毁的 WebContents，访问会抛 "Object has been destroyed"
        return
      }
      console.log('[CAPTURE] 屏幕选择器收到选择:', idx)
      settle(idx < 0 || idx >= displays.length ? null : displays[idx])
    }
    ipcMain.on('capture-screen-pick', onPick)
    picker.on('closed', () => settle(null))

    picker.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pickerHtml))
    picker.once('ready-to-show', () => {
      picker.show()
      picker.focus()
    })
  })
}

/** 从 process.execPath（<bundle>/Contents/MacOS/<binary>）向上解析 .app 包路径，用于权限引导的原生拖拽 */
function resolveAppBundlePath(): string {
  let dir = dirname(process.execPath)
  for (let i = 0; i < 6; i++) {
    if (dir.endsWith('.app')) return dir
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.execPath
}

/** 标注截图附件：冻结帧 → 全屏选区 overlay → 原图无损裁剪（详情弹窗「截图」按钮） */
export function registerCaptureHandlers(): void {
  ipcMain.handle('attachment:captureRegion', async (e): Promise<CaptureResult> => {
    const t0 = Date.now()
    const logStep = (s: string) => logCapture(`${Date.now() - t0}ms ${s}`)
    try {
      logStep('START')
      if (session) return { ok: false, reason: 'busy' }

      // macOS 屏幕录制权限：未授权时返回 permission，由渲染层弹出权限引导（TRAE CN 风格）
      // 注意：dev 模式下 getMediaAccessStatus 返回 'unknown'（未签名），此时应允许尝试捕获
      try {
        const status = systemPreferences.getMediaAccessStatus('screen')
        logStep(`perm=${status}`)
        // 'unknown' 出现在未签名/dev 模式下，实际捕获可能仍然成功
        if (process.platform === 'darwin' && status === 'denied') {
          return { ok: false, reason: 'permission' }
        }
        if (process.platform === 'darwin' && status === 'unknown') {
          logCapture('屏幕权限状态 unknown（dev 模式），直接尝试捕获')
        }
      } catch (err) {
        console.warn('[CAPTURE] 权限检查失败:', err)
        // 权限检查失败时仍尝试捕获
      }

      // 安全获取主窗口
      let hostWin: BrowserWindow | null = null
      try {
        hostWin = BrowserWindow.fromWebContents(e.sender)
        logStep('hostWin acquired')
      } catch {
        logStep('hostWin null')
      }

      logStep('getAllDisplays')
      const displays = screen.getAllDisplays()
      logStep(`displays=${displays.length}`)
      if (displays.length === 0) return { ok: false, reason: 'error' }

      // 多显示器：弹出选择器让用户选择目标屏幕；单显示器直接用主窗口所在屏
      let targetDisplay: Electron.Display
      if (displays.length > 1) {
        try {
          logStep('capturing thumbnails')
          // 用系统 screencapture 逐屏抓缩略图（并行），绕开 desktopCapturer 崩溃问题
          const thumbs = await Promise.all(displays.map((d) => captureDisplayThumbnail(d.bounds)))
          logStep(`thumbnails done, showing picker`)
          const picked = await showScreenPicker(hostWin, displays, thumbs)
          if (!picked) return { ok: false, reason: 'cancelled' }
          targetDisplay = picked
          logStep(`picked display: ${targetDisplay.label}`)
        } catch (err) {
          console.warn('[CAPTURE] 屏幕选择器失败:', err)
          return { ok: false, reason: 'error' }
        }
      } else {
        try {
          targetDisplay = screen.getDisplayNearestPoint(
            hostWin && !hostWin.isDestroyed()
              ? { x: hostWin.getBounds().x + hostWin.getBounds().width / 2, y: hostWin.getBounds().y + hostWin.getBounds().height / 2 }
              : screen.getCursorScreenPoint()
          )
          logStep(`single display: ${targetDisplay.label}`)
        } catch {
          targetDisplay = displays[0]
        }
      }

      // 冻结帧：按显示器 bounds 全局坐标用系统 screencapture 抓原图
      // （物理像素，Retina 下输出 2x 分辨率；后续裁剪按 fullImage 实际尺寸换算比例）
      logStep('capturing freeze frame')
      let fullImage: NativeImage
      try {
        fullImage = await captureDisplayFrame(targetDisplay.bounds)
        if (fullImage.isEmpty()) return { ok: false, reason: 'error' }
        logStep(`freeze frame done, size=${fullImage.getSize().width}x${fullImage.getSize().height}`)
      } catch (err) {
        console.warn('[CAPTURE] 冻结帧捕获失败:', err)
        return { ok: false, reason: 'error' }
      }

      logStep('creating overlay window')
      const overlay = new BrowserWindow({
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
        show: false,
        frame: false,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        hasShadow: false,
        enableLargerThanScreen: true,
        alwaysOnTop: true,
        webPreferences: {
          preload: join(__dirname, '../preload/index.js'),
          backgroundThrottling: false
        }
      })
      logStep('overlay window created, setting alwaysOnTop')
      overlay.setAlwaysOnTop(true, 'screen-saver')
      overlay.on('closed', () => finish(null))

      // overlay 初始化握手：init 返回冻结帧数据 → 页面 decode 完成 → shown → 此时才显示窗口（避免白屏闪烁）
      logStep('loading overlay HTML')
      const result = await new Promise<CaptureResult>((resolve) => {
        session = { overlay, fullImage, displayBounds: targetDisplay.bounds, hostWin, resolve }
        void overlay.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(OVERLAY_HTML)).catch(() => finish(null))
      })
      logStep('DONE')
      return result
    } catch (err) {
      logCapture(`ERROR: ${err instanceof Error ? err.stack : String(err)}`)
      console.error('[CAPTURE] 截图功能崩溃:', err)
      return { ok: false, reason: 'error' }
    }
  })

  // overlay 初始化：仅 overlay 自身的 webContents 可调用，返回压缩预览帧 + 逻辑尺寸
  ipcMain.handle('capture-overlay:init', (e): { bgDataUrl: string; width: number; height: number } | null => {
    try {
      if (!session || e.sender !== session.overlay.webContents || session.overlay.isDestroyed()) return null
      return {
        bgDataUrl: 'data:image/jpeg;base64,' + session.fullImage.toJPEG(80).toString('base64'),
        width: session.displayBounds.width,
        height: session.displayBounds.height
      }
    } catch (err) {
      console.warn('[CAPTURE] overlay init 失败:', err)
      return null
    }
  })

  // overlay 背景就绪：此时才显示并聚焦窗口
  ipcMain.on('capture-overlay:shown', (e) => {
    if (!session || e.sender !== session.overlay.webContents) return
    if (!session.overlay.isDestroyed()) {
      session.overlay.show()
      session.overlay.focus()
    }
  })

  ipcMain.on('capture-overlay:select', (_e, rect: SelectRect) => {
    if (
      !session ||
      !rect ||
      typeof rect.x !== 'number' ||
      typeof rect.y !== 'number' ||
      typeof rect.width !== 'number' ||
      typeof rect.height !== 'number'
    )
      return
    finish({ x: rect.x, y: rect.y, width: rect.width, height: rect.height })
  })

  ipcMain.on('capture-overlay:cancel', () => finish(null))

  // ===== macOS 录屏权限引导（参考 TRAE CN：可把应用图标拖入系统设置「录屏与系统录音」列表完成授权） =====

  // 查询屏幕录制权限状态：darwin 返回系统实际状态，其他平台视为已授权
  ipcMain.handle('permission:screenStatus', (): string => {
    if (process.platform !== 'darwin') return 'granted'
    return systemPreferences.getMediaAccessStatus('screen')
  })

  // 打开系统设置 → 隐私与安全性 → 录屏与系统录音
  ipcMain.handle('permission:openScreenSettings', (): void => {
    void shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
  })

  // 应用信息（名称 + 图标 dataURL），引导弹窗展示用
  ipcMain.handle('permission:appInfo', async (): Promise<{ name: string; iconDataUrl: string }> => {
    const bundle = resolveAppBundlePath()
    let iconDataUrl = ''
    try {
      const icon = await app.getFileIcon(bundle, { size: 'large' })
      iconDataUrl = icon.toDataURL()
    } catch (err) {
      console.warn('[CAPTURE] 获取应用图标失败:', err)
    }
    return { name: app.getName(), iconDataUrl }
  })

  // 启动应用包原生文件拖拽：按住引导弹窗中的图标 → 拖入系统设置列表完成授权
  ipcMain.handle('permission:startAppDrag', async (e): Promise<boolean> => {
    const bundle = resolveAppBundlePath()
    try {
      const icon = await app.getFileIcon(bundle, { size: 'large' })
      e.sender.startDrag({ file: bundle, icon })
      return true
    } catch (err) {
      console.warn('[CAPTURE] 启动应用拖拽失败:', err)
      return false
    }
  })
}
