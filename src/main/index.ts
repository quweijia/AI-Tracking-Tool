import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron'
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
    selectAll: '全选',
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
    selectAll: 'Select All',
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
        { role: 'undo', label: s.undo },
        { role: 'redo', label: s.redo },
        { type: 'separator' },
        { role: 'cut', label: s.cut },
        { role: 'copy', label: s.copy },
        { role: 'paste', label: s.paste },
        ...(isMac
          ? ([{ role: 'pasteAndMatchStyle', label: s.pasteAndMatchStyle }] as MenuItemConstructorOptions[])
          : []),
        { role: 'delete', label: s.delete },
        { type: 'separator' },
        { role: 'selectAll', label: s.selectAll }
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
  ipcMain.on('window:minimize', () => win?.minimize())
  ipcMain.on('window:maximize', () => {
    if (!win) return
    if (win.isMaximized()) win.unmaximize()
    else win.maximize()
  })
  ipcMain.on('window:close', () => win?.close())
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
    // 隐藏原生标题栏，窗口控制按钮由渲染层自绘（左侧预留 84px）
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 19 },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // 自动走查内置浏览器（webview 加载研发环境页面）
      webviewTag: true
    }
  })
  win = mainWindow

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

// 开发模式下进程名显示为「AI 走查工具」（打包版由 electron-builder 的 productName 决定）
app.setName('AI 走查工具')

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
