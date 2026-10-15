import { app, BrowserWindow, ipcMain, Menu, MenuItemConstructorOptions, shell } from 'electron'
import { join } from 'path'
import { registerIpcHandlers } from './ipc'

/**
 * 开发模式下将用户数据（图片、配置）放在项目 data/ 目录，
 * 便于查看与重置；打包后使用系统默认 userData 目录。
 */
if (!app.isPackaged) {
  app.setPath('userData', join(app.getAppPath(), 'data'))
}

/** 应用菜单全中文（macOS 顶栏 / Windows 窗口菜单），dev 下应用名由 Info.plist 的 CFBundleName 决定 */
function buildAppMenu(): void {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac
      ? ([
          {
            label: 'AI 走查工具',
            submenu: [
              { role: 'about', label: '关于 AI 走查工具' },
              { type: 'separator' },
              { role: 'hide', label: '隐藏 AI 走查工具' },
              { role: 'hideOthers', label: '隐藏其他' },
              { role: 'unhide', label: '全部显示' },
              { type: 'separator' },
              { role: 'quit', label: '退出 AI 走查工具' }
            ]
          }
        ] as MenuItemConstructorOptions[])
      : []),
    {
      label: '文件',
      submenu: [isMac ? { role: 'close', label: '关闭窗口' } : { role: 'quit', label: '退出' }]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo', label: '撤销' },
        { role: 'redo', label: '重做' },
        { type: 'separator' },
        { role: 'cut', label: '剪切' },
        { role: 'copy', label: '拷贝' },
        { role: 'paste', label: '粘贴' },
        ...(isMac ? ([{ role: 'pasteAndMatchStyle', label: '粘贴并匹配样式' }] as MenuItemConstructorOptions[]) : []),
        { role: 'delete', label: '删除' },
        { type: 'separator' },
        { role: 'selectAll', label: '全选' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '切换开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: '进入全屏' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize', label: '最小化' },
        { role: 'zoom', label: '缩放' },
        ...(isMac
          ? ([{ type: 'separator' }, { role: 'front', label: '前置全部窗口' }] as MenuItemConstructorOptions[])
          : ([{ role: 'close', label: '关闭窗口' }] as MenuItemConstructorOptions[])
        )
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '访问作者主页',
          click: (): void => {
            void shell.openExternal('https://quweijia.is-a.dev/')
          }
        }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
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
      sandbox: true
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
  registerWindowControls()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
