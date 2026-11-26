import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, screen, shell } from 'electron'
import { appendFileSync } from 'fs'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'
import { registerDockIconHandlers, restoreDockIcon } from './dockIcon'

/**
 * 开发模式下将用户数据（图片、配置）放在项目 data/ 目录，
 * 便于查看与重置；打包后使用系统默认 userData 目录。
 * 注意：Electron 官方二进制被重命名（如 Electron.app → AI 走查工具.app）后
 * isPackaged 会误判为 true，故叠加「可执行文件位于 node_modules」这一
 * 开发环境特征，保证开发时 userData 恒定指向项目 data/。
 */
if (!app.isPackaged || process.execPath.includes('node_modules')) {
  app.setPath('userData', join(app.getAppPath(), 'data'))
}

/** 应用菜单语言包（渲染层切换语言时经 app:set-lang 通知重建） */
type MenuLang = 'zh-CN' | 'en-US'
const MENU_STR: Record<MenuLang, Record<string, string>> = {
  'zh-CN': {
    appName: 'AI 走查工具',
    about: '关于 AI 走查工具',
    hide: '隐藏 AI 走查工具',
    hideOthers: '隐藏其他',
    unhide: '全部显示',
    quit: '退出 AI 走查工具',
    quitShort: '退出',
    file: '文件',
    close: '关闭窗口',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    view: '视图',
    reload: '重新加载',
    forceReload: '强制重新加载',
    toggleDevTools: '切换开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    fullscreen: '进入全屏',
    window: '窗口',
    minimize: '最小化',
    zoom: '缩放',
    front: '前置全部窗口',
    help: '帮助',
    visitAuthor: '访问作者主页'
  },
  'en-US': {
    appName: 'AI Walkthrough',
    about: 'About AI Walkthrough',
    hide: 'Hide AI Walkthrough',
    hideOthers: 'Hide Others',
    unhide: 'Show All',
    quit: 'Quit AI Walkthrough',
    quitShort: 'Quit',
    file: 'File',
    close: 'Close Window',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    view: 'View',
    reload: 'Reload',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    fullscreen: 'Enter Full Screen',
    window: 'Window',
    minimize: 'Minimize',
    zoom: 'Zoom',
    front: 'Bring All to Front',
    help: 'Help',
    visitAuthor: 'Visit Author Homepage'
  }
}

/** 当前菜单语言（默认中文；渲染层启动/切换语言时经 IPC 通知更新） */
let menuLang: MenuLang = 'zh-CN'

/** 应用菜单（macOS 顶栏 / Windows 窗口菜单），按界面语言生成 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const s = MENU_STR[menuLang]
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: s.appName,
            submenu: [
              { role: 'about', label: s.about },
              { type: 'separator' },
              { role: 'hide', label: s.hide },
              { role: 'hideOthers', label: s.hideOthers },
              { role: 'unhide', label: s.unhide },
              { type: 'separator' },
              { role: 'quit', label: s.quit }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: s.file,
      submenu: [isMac ? { role: 'close', label: s.close } : { role: 'quit', label: s.quitShort }]
    },
    {
      label: s.edit,
      submenu: [
        // 不放 undo/redo 角色：菜单加速器先于渲染层 keydown 拦截 Cmd/Ctrl+Z，渲染层自定义撤销
        // （拖拽排序 / 移动层级撤回、标注撤销）会完全收不到按键；
        // 输入框内的文本撤销由 Chromium 原生编辑命令处理，不依赖该菜单项
        { role: 'cut', label: s.cut },
        { role: 'copy', label: s.copy },
        { role: 'paste', label: s.paste },
        ...(isMac
          ? ([{ role: 'pasteAndMatchStyle', label: s.pasteAndMatchStyle }] as MenuItemConstructorOptions[])
          : []),
        { role: 'delete', label: s.delete }
        // 不放 selectAll 角色：菜单加速器先于渲染层 keydown 拦截 Cmd/Ctrl+A，会导致输入框外全选无法禁用；
        // 输入框内的全选由 Chromium 原生编辑命令处理，不依赖该菜单项
      ]
    },
    {
      label: s.view,
      submenu: [
        { role: 'reload', label: s.reload },
        { role: 'forceReload', label: s.forceReload },
        { role: 'toggleDevTools', label: s.toggleDevTools },
        { type: 'separator' },
        { role: 'resetZoom', label: s.resetZoom },
        { role: 'zoomIn', label: s.zoomIn },
        { role: 'zoomOut', label: s.zoomOut },
        { type: 'separator' },
        { role: 'togglefullscreen', label: s.fullscreen }
      ]
    },
    {
      label: s.window,
      submenu: [
        { role: 'minimize', label: s.minimize },
        { role: 'zoom', label: s.zoom },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front', label: s.front }] as MenuItemConstructorOptions[])
          : ([{ role: 'close', label: s.close }] as MenuItemConstructorOptions[])
        )
      ]
    },
    {
      label: s.help,
      submenu: [
        {
          label: s.visitAuthor,
          click: (): void => {
            void shell.openExternal('https://quweijia.is-a.dev/')
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

/** 注册语言切换：渲染层 i18n 初始化与设置页切换时调用（重建应用菜单） */
function registerLangHandlers(): void {
  ipcMain.on('app:set-lang', (_e, lang: string) => {
    if (lang === 'zh-CN' || lang === 'en-US') {
      menuLang = lang
      buildAppMenu()
    }
  })
}

/** 自绘窗口控制按钮的 IPC（原生红绿灯失焦重绘会消失，改为渲染层实现） */
function registerWindowControls(): void {
  // macOS 原生红绿灯在失焦时点击也能完成「激活 + 操作」，自绘按钮需在每次操作前补一次 focus 对齐该行为
  const focusAnd = (fn: () => void): void => {
    if (win) {
      win.focus()
      fn()
    }
  }
  ipcMain.on('window:minimize', () => focusAnd(() => win?.minimize()))
  ipcMain.on('window:maximize', () => focusAnd(() => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  }))
  ipcMain.on('window:close', () => focusAnd(() => win?.close()))
  // 渲染层初始化查询当前最大化状态（对齐 Windows max/restore 按钮初始图标）
  ipcMain.handle('window:is-maximized', () => (win ? win.isMaximized() : false))
  // 标题栏拖拽：CSS drag 区域不派发 DOM 事件（也无法监听双击），改由渲染层
  // mousedown/mousemove 驱动 —— start 记录光标与窗口原点，move 按光标位移挪窗。
  // 最大化/全屏状态下不跟随拖拽（与原生标题栏行为一致）
  let dragOrigin: { cursor: { x: number; y: number }; pos: number[] } | null = null
  ipcMain.on('window:drag-start', () => {
    if (!win || win.isFullScreen() || win.isMaximized()) return
    dragOrigin = { cursor: screen.getCursorScreenPoint(), pos: win.getPosition() }
  })
  ipcMain.on('window:drag-move', () => {
    if (!win || !dragOrigin) return
    const cur = screen.getCursorScreenPoint()
    win.setPosition(dragOrigin.pos[0] + cur.x - dragOrigin.cursor.x, dragOrigin.pos[1] + cur.y - dragOrigin.cursor.y)
  })
  ipcMain.on('window:drag-end', () => {
    dragOrigin = null
  })
}

/** 主窗口引用（自绘窗口控制按钮的 IPC 使用） */
let win: BrowserWindow | null = null

function createWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false,
    autoHideMenuBar: false,
    title: 'AI 走查工具',
    // 隐藏原生标题栏，窗口控制按钮由渲染层自绘：
    // macOS 用 hiddenInset + 左侧自绘红绿灯（trafficLightPosition 仅 mac 生效）；
    // Windows 用 hidden 移除系统标题栏（避免与自绘顶栏叠成双层），右上角自绘三按钮
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    trafficLightPosition: { x: 14, y: 19 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 自动走查内置浏览器（webview 加载研发环境页面）
      webviewTag: true,
      // 登录窗口弹出后主窗口易被遮挡，页面 timer（如登录等待倒计时）不因遮挡/失焦被 Chromium 节流
      backgroundThrottling: false
    }
  })
  win = mainWindow

  // 失焦激活兜底：macOS 上点击未激活窗口的顶栏（拖拽/双击区域及其周边）激活时，
  // 渲染层收不到 DOM focus/blur 与后续鼠标事件（事件流卡死，窗口控制按钮置灰且点不动）。
  // 主进程事件始终可靠：激活时强制恢复 webContents 事件焦点以解开卡死状态，
  // 并把聚焦状态经 IPC 推给渲染层，同步按钮置灰态。
  mainWindow.on('focus', () => {
    // 仅在 webContents 未持焦时补一次，避免 focus 事件内反复触发
    if (!mainWindow.webContents.isFocused()) mainWindow.webContents.focus()
    mainWindow.webContents.send('window:focus-changed', true)
  })
  mainWindow.on('blur', () => mainWindow.webContents.send('window:focus-changed', false))

  // 最大化状态变化推给渲染层（Windows 自绘标题栏的 max/restore 按钮随状态切换图标）
  const sendMaximized = (): void => mainWindow.webContents.send('window:maximized-changed', mainWindow.isMaximized())
  mainWindow.on('maximize', sendMaximized)
  mainWindow.on('unmaximize', sendMaximized)

  mainWindow.on('ready-to-show', () => {
    // macOS：永久隐藏原生红绿灯，改用渲染层自绘窗口控制按钮
    // （原生按钮在其它窗口叠加/失焦重绘时会直接消失，无法根治）
    if (process.platform === 'darwin') {
      try {
        mainWindow.setWindowButtonVisibility(false)
      } catch {
        // 忽略异常
      }
    }
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// 全局异常捕获：防止未捕获异常导致应用闪退
process.on('uncaughtException', (err) => {
  console.error('[MAIN] 未捕获异常:', err)
})
process.on('unhandledRejection', (reason) => {
  console.error('[MAIN] 未处理的 Promise 拒绝:', reason)
})

// 开发模式下进程名显示为「AI 走查工具」（打包版由 electron-builder 的 productName 决定）
app.setName('AI 走查工具')

// macOS + sandbox 环境下 webviewTag 的 Network Service 偶发崩溃，
// 禁用 NetworkServiceInProcess 使其运行在独立进程中，崩溃后自动重启而不带倒主进程
// 同时关闭 TrustTokens 和 OptimizePhpCompilation 以减少内存服务崩溃
// macOS + webviewTag 环境下 Network Service 频繁崩溃（exit 137），
// 通过以下组合方案保持应用存活：
// 1. 禁用 NetworkServiceInProcess — 让网络服务独立进程运行，崩溃不影响主进程
// 2. 禁用 TrustTokens / OptimizePhpCompilation — 减少内存服务崩溃
// 3. 禁用 GPU 沙箱 — 避免 macOS 上 GPU 进程崩溃带倒主进程
app.commandLine.appendSwitch('disable-features', 'NetworkServiceInProcess,TrustTokens,OptimizePhpCompilation')
app.commandLine.appendSwitch('no-sandbox')
app.commandLine.appendSwitch('disable-gpu-sandbox')
app.commandLine.appendSwitch('disable-software-rasterizer')

// 第二实例触达时聚焦已有窗口（dock 保持单个「AI 走查工具」图标）
function focusExistingWindow(): void {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  }
}

// 单实例锁：重复启动（含误触多次启动）时新进程直接退出并聚焦已有窗口。
// dev 热重载重启时旧进程释放锁有延迟，故带短重试（300ms 间隔 / 5s 上限），
// 避免把 electron-vite 的正常重启误判为重复启动而杀死整条 dev 链路。
// 锁基于 userData 路径（开发/打包各自独立单例）。
function bootApp(): void {
  // 崩溃诊断：未捕获异常 / 渲染层或子进程崩溃写入 userData/crash.log，闪退时有据可查
  const logCrash = (tag: string, detail: unknown): void => {
    const line = `[${new Date().toISOString()}] ${tag}\n${
      detail instanceof Error ? (detail.stack ?? detail.message) : String(detail)
    }\n\n`
    try {
      appendFileSync(join(app.getPath('userData'), 'crash.log'), line)
    } catch {
      // 日志写入失败不阻塞主流程
    }
    console.error(`[CRASH] ${tag}:`, detail)
  }
  process.on('uncaughtException', (err) => logCrash('uncaughtException', err))
  process.on('unhandledRejection', (reason) => logCrash('unhandledRejection', reason))
  // 注意签名：render-process-gone 回调为 (event, webContents, details)，details 在第三位；
  // 同时输出 webContents 类型与 URL 以定位崩的是哪个进程（宿主窗口 / webview guest）
  app.on('render-process-gone', (_e, wc, details) => {
    let wcInfo = ''
    try {
      wcInfo = ` type=${wc.getType()} id=${wc.id} url=${wc.getURL()}`
    } catch {
      // webContents 已销毁时取不到信息
    }
    logCrash('render-process-gone', JSON.stringify(details) + wcInfo)
  })
  app.on('child-process-gone', (_e, details) => logCrash('child-process-gone', JSON.stringify(details)))

  app.on('second-instance', focusExistingWindow)

  app.whenReady().then(() => {
    // macOS 开发模式下设置 Dock 启动图标；打包版由 Info.plist 内嵌的 icon.icns 自动生效。
    // 注意：打包产物不含 build/ 目录，且 setIcon 对无效路径会抛异常，
    // 一旦中断 whenReady 链路将导致 createWindow 与中文菜单均不执行（无窗口 + 英文菜单）。
    if (process.platform === 'darwin' && app.dock && !app.isPackaged) {
      try {
        app.dock.setIcon(join(app.getAppPath(), 'build/icon.png'))
      } catch {
        // 忽略图标设置失败，不阻塞启动
      }
    }
    buildAppMenu()
    registerIpcHandlers()
    registerDockIconHandlers()
    registerWindowControls()
    registerLangHandlers()
    // 恢复上次选择的自定义 Dock 图标（默认方案由上方 dev 分支 / Info.plist 生效）
    restoreDockIcon()
    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
}

if (app.requestSingleInstanceLock()) {
  bootApp()
} else {
  const start = Date.now()
  const retry = setInterval(() => {
    if (app.requestSingleInstanceLock()) {
      clearInterval(retry)
      bootApp()
    } else if (Date.now() - start > 5000) {
      // 超时仍未拿到锁 = 真·重复启动，退出并让已运行实例聚焦
      clearInterval(retry)
      app.exit(0)
    }
  }, 300)
}
