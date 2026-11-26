import { contextBridge, ipcRenderer } from 'electron'
import type { StyleNode, ToleranceConfig, MatchPair, StyleDiff, SpecSyncResult, LayeredRunSummary, WalkSessionProfile } from '../shared/types'

const api = {
  saveImage: (buffer: ArrayBuffer, ext: string): Promise<string> =>
    ipcRenderer.invoke('file:saveImage', buffer, ext),
  saveDataUrl: (dataUrl: string): Promise<string> =>
    ipcRenderer.invoke('file:saveDataUrl', dataUrl),
  readImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('file:readImage', relativePath),
  deleteImage: (relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:deleteImage', relativePath),
  // 撤回删除：把回收站里的图片按原路径移回（Cmd+Z 撤回批量删除用），返回成功恢复数
  restoreImages: (relativePaths: string[]): Promise<number> =>
    ipcRenderer.invoke('file:restoreImages', relativePaths),
  // 同步原生窗口主题源（light/dark）：避免系统深色 + 应用浅色时原生窗口外围出现深色描边
  setThemeSource: (source: 'system' | 'light' | 'dark'): Promise<boolean> =>
    ipcRenderer.invoke('theme:setSource', source),
  // 回收站彻底删除：物理删除数据图片并连带清理 image_trash 内同路径历史文件，返回清理文件数
  purgeImages: (relativePaths: string[]): Promise<number> =>
    ipcRenderer.invoke('file:purgeImages', relativePaths),
  // 回收站磁盘治理：孤儿文件回收（referenced=全部存活记录引用路径白名单，含软删记录；
  // pageIds=全部页面 id 白名单），返回清理文件/目录数
  purgeOrphanFiles: (referenced: string[], pageIds: string[]): Promise<number> =>
    ipcRenderer.invoke('trash:purgeOrphanFiles', referenced, pageIds),
  selectImage: (): Promise<{ relativePath: string; dataUrl: string } | null> =>
    ipcRenderer.invoke('file:selectImage'),
  exportReport: (
    html: string,
    fileName: string
  ): Promise<{
    ok: boolean
    canceled: boolean
    path: string | null
    fallback: boolean
    message: string
  }> => ipcRenderer.invoke('file:exportReport', html, fileName),
  // 通用文本文件另存为（设计规范 Token 导出等），不自动打开
  saveText: (
    content: string,
    fileName: string,
    filter?: { name: string; extensions: string[] }
  ): Promise<{ ok: boolean; canceled: boolean; path: string | null; fallback: boolean; message: string }> =>
    ipcRenderer.invoke('file:saveText', content, fileName, filter),
  getConfig: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:get'),
  setConfig: (key: string, value: unknown): Promise<boolean> =>
    ipcRenderer.invoke('config:set', key, value),
  // 自定义 Dock 图标（key='default' 恢复默认；自定义时传 dataUrl）
  setDockIcon: (key: string, dataUrl?: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('dock-icon:set', key, dataUrl),
  // AI 识别
  aiTest: (modelId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }> =>
    ipcRenderer.invoke('ai:test', modelId),
  mcpTest: (input: {
    serverUrl: string
    pat?: string
    /** 该服务自定义代理地址（可选），连通性测试同样走此代理 */
    proxy?: string
  }): Promise<{ ok: boolean; message: string; latencyMs?: number }> =>
    ipcRenderer.invoke('mcp:testConnectivity', input),
  // SkillHub：选择并导入 Zip 技能安装包（解析 manifest + .md 指南）
  importSkillZip: (): Promise<{
    ok: boolean
    canceled: boolean
    message: string
    skill?: { name: string; desc?: string; guides: string[] }
  }> => ipcRenderer.invoke('skills:importZip'),
  openDevBrowser: (url: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('browser:openWindow', url),
  // 自动走查登录流程：唤起登录模式内置浏览器窗口（检测到登录页时）
  openLoginWindow: (url: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('browser:openWindow', url, { loginMode: true }),
  // 登录等待超时/用户取消 → 关闭登录窗口
  closeLoginWindow: (): Promise<void> => ipcRenderer.invoke('browser:closeWindow'),
  // 登录窗口回传结果 → 主窗口监听（success=登录成功已保存会话，closed=窗口被手动关闭）
  walkOnLoginResult: (cb: (type: 'success' | 'closed') => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, type: 'success' | 'closed'): void => cb(type)
    ipcRenderer.on('walk:login-result', listener)
    return () => ipcRenderer.removeListener('walk:login-result', listener)
  },
  // 会话 profile：读取（解密）指定 URL 域名的登录态快照
  walkSessionLoad: (url: string): Promise<{ found: boolean; profile?: WalkSessionProfile }> =>
    ipcRenderer.invoke('walkSession:load', url),
  // 会话 profile：登录窗口抓取的上下文 + 主进程补齐 Cookie → safeStorage 加密落盘
  walkSessionSave: (payload: { url: string; marker?: string; ls?: Record<string, string>; ss?: Record<string, string>; idb?: unknown[] }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('walkSession:save', payload),
  // 会话 profile：Cookie 注入 walkthrough 分区（同域名走查优先加载 profile）
  walkSessionInjectCookies: (profile: WalkSessionProfile): Promise<{ ok: boolean; count: number }> =>
    ipcRenderer.invoke('walkSession:injectCookies', profile),
  // 会话 profile：CDP 注册「文档创建前」的 localStorage/sessionStorage/indexedDB 恢复脚本
  walkSessionInitStorage: (webContentsId: number, profile: WalkSessionProfile): Promise<{ ok: boolean; message?: string }> =>
    ipcRenderer.invoke('walkSession:initStorage', webContentsId, profile),
  // 分析报告：用系统浏览器打开本地导出的 HTML 报告文件
  openReportSystem: (filePath: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('report:openSystem', filePath),
  // 分析报告：用内置浏览器打开本地导出的 HTML 报告文件
  openReportBuiltin: (filePath: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('report:openBuiltin', filePath),
  // 导出历史：在系统文件管理器中定位报告文件（true = 已定位）
  showInFolder: (filePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:showInFolder', filePath),
  // 导出历史：删除记录时把本地 HTML 报告文件移入废纸篓
  deleteReportFile: (filePath: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('file:deleteReport', filePath),
  // 清除内置浏览器（persist:walkthrough 分区）的浏览数据：Cookies / 本地存储 / 缓存等
  clearBrowserData: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('browser:clearData'),
  // 内置浏览器分区切为直连（外部站点被系统代理拦截导致 ERR_FAILED(-2) 时的兜底）
  setBrowserDirectProxy: (): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('browser:setDirectProxy'),
  // ===== 自动走查视口与采集结果链路（宽度自动匹配 Figma，采集由弹窗发起） =====
  /** 主窗口：下发自动走查视口到开发浏览器弹窗（宽度自动匹配 Figma 画板） */
  setDevViewport: (vp: { width: number; height: number; autoWidth?: boolean }): void =>
    ipcRenderer.send('browser:setViewport', vp),
  /** 弹窗页：挂载时拉取主窗口已下发的视口（规避「先发送后加载」竞态） */
  popupGetViewport: (): Promise<{ width: number; height: number; autoWidth?: boolean } | null> =>
    ipcRenderer.invoke('browser:popupGetViewport'),
  /** 弹窗页：接收主窗口下发的视口（返回取消订阅） */
  popupOnViewport: (
    cb: (vp: { width: number; height: number; autoWidth?: boolean }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, vp: { width: number; height: number; autoWidth?: boolean }): void =>
      cb(vp)
    ipcRenderer.on('browser:viewport', listener)
    return () => ipcRenderer.removeListener('browser:viewport', listener)
  },
  /** 弹窗页：回传「生成问题标注」采集结果（主进程转发主窗口） */
  popupSendWalkResult: (data: {
    domRoot: unknown
    screenshotDataUrl: string
    viewport: { width: number; height: number }
    collected: number
    skipped: number
  }): void => ipcRenderer.send('browser:walk-result', data),
  /** 弹窗页（登录模式）：会话 profile 已保存 → 通知主窗口恢复自动走查 */
  popupSendLoginResult: (): void => ipcRenderer.send('browser:login-result', 'success'),
  /** 主窗口：接收弹窗回传的采集结果（返回取消订阅） */
  walkOnResult: (
    handler: (data: {
      domRoot: unknown
      screenshotDataUrl: string
      viewport: { width: number; height: number }
      collected: number
      skipped: number
    }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, data: {
      domRoot: unknown
      screenshotDataUrl: string
      viewport: { width: number; height: number }
      collected: number
      skipped: number
    }): void => handler(data)
    ipcRenderer.on('browser:walk-captured', listener)
    return () => ipcRenderer.removeListener('browser:walk-captured', listener)
  },
  /** 弹窗页：接收主窗口发来的导航指令（返回取消订阅） */
  popupOnNavigate: (cb: (url: string) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, url: string): void => cb(url)
    ipcRenderer.on('browser:navigate', listener)
    return () => ipcRenderer.removeListener('browser:navigate', listener)
  },
  aiAnnotate: (input: {
    modelId: string
    pageName: string
    platformLabel: string
    designDataUrl: string
    shotDataUrl: string
    /** SkillHub 技能指引（选中技能的说明），注入识别请求 */
    skillGuides?: string[]
    /** 自动走查自定义检查项（检查维度/深度/分析设置/输出风格），注入识别 prompt */
    walkOptions?: {
      dimensionLabels?: string[]
      depth?: 'loose' | 'standard' | 'strict'
      analysisLabels?: string[]
      style?: 'concise' | 'detailed'
      /** 项目绑定规范的 Token 摘要，触发 AI「规范合规」检查 */
      specSummary?: string
    }
  }): Promise<{
    ok: boolean
    issues?: {
      targetImage: 'design' | 'screenshot'
      shape: 'rect' | 'point' | 'text' | 'measure' | 'picker'
      x: number
      y: number
      width: number
      height: number
      description: string
      severity: 'major' | 'minor' | 'suggestion'
      category: 'spacing' | 'typography' | 'color' | 'style' | 'interaction' | 'compatibility'
      suggestion?: { current: string; fix: string; properties?: string }
      /** 问题分级（模型显式返回才携带）：required=正式缺陷；optional=备选参考 */
      level?: 'required' | 'optional'
      /** 分级判定理由（level=optional 时携带） */
      levelReason?: string
    }[]
    message: string
  }> => ipcRenderer.invoke('ai:annotate', input),
  /** AI 识别流式进度（返回取消订阅） */
  onAiProgress: (
    cb: (info: { pageName?: string; elapsedMs: number; chars: number }) => void
  ): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, info: { pageName?: string; elapsedMs: number; chars: number }): void =>
      cb(info)
    ipcRenderer.on('ai:annotate:progress', listener)
    return () => ipcRenderer.removeListener('ai:annotate:progress', listener)
  },
  // 飞书集成
  feishuTest: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('feishu:test'),
  feishuCreateReport: (payload: {
    title: string
    metaLines: string[]
    stats: { label: string; value: string }[]
    issues: {
      no: number
      title: string
      severityLabel: string
      categoryLabel: string
      sourceLabel: string
      targetLabel: string
      statusLabel: string
      suggestion?: { current: string; fix: string; properties?: string }
    }[]
    images: { name: string; dataUrl: string }[]
    htmlReport?: { name: string; dataUrl: string }
  }): Promise<{ ok: boolean; url?: string; message: string }> =>
    ipcRenderer.invoke('feishu:createReport', payload),
  // 腾讯文档 / 金山文档集成
  tencentTest: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('tencent:test'),
  // 腾讯文档：payload 与飞书一致（报告内容生成 docx 后导入为在线文档）
  tencentCreateReport: (payload: {
    title: string
    metaLines: string[]
    stats: { label: string; value: string }[]
    issues: {
      no: number
      title: string
      severityLabel: string
      categoryLabel: string
      sourceLabel: string
      targetLabel: string
      statusLabel: string
      suggestion?: { current: string; fix: string; properties?: string }
    }[]
    images: { name: string; dataUrl: string }[]
    htmlReport?: { name: string; dataUrl: string }
  }): Promise<{ ok: boolean; url?: string; message: string }> =>
    ipcRenderer.invoke('tencent:createReport', payload),
  kingsoftTest: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('kingsoft:test'),
  kingsoftCreateReport: (payload: { title: string }): Promise<{ ok: boolean; url?: string; message: string }> =>
    ipcRenderer.invoke('kingsoft:createReport', payload),
  // ───────────── 工作区设置（应用数据存放位置：磁盘占用 / 压缩包备份 / 恢复导入） ─────────────
  /** 更改工作区文件夹：主进程迁移现有数据并立即生效 */
  workspacePick: (): Promise<{ ok: boolean; canceled?: boolean; path?: string; message?: string }> =>
    ipcRenderer.invoke('workspace:pick'),
  /** 数据目录磁盘占用统计（递归累加文件大小） */
  workspaceUsage: (): Promise<{ ok: boolean; bytes: number; dir: string; message?: string }> =>
    ipcRenderer.invoke('workspace:usage'),
  /** 备份压缩包：渲染层打包全表 JSON 串传入，主进程弹框选保存文件夹并 zip 打包 */
  workspaceBackup: (dbJson: string): Promise<{ ok: boolean; canceled?: boolean; time?: number; path?: string; message: string }> =>
    ipcRenderer.invoke('workspace:backup', dbJson),
  /** 从备份压缩包恢复：返回全表数据与合并后配置（资产与配置文件已由主进程处理） */
  workspaceRestore: (): Promise<{
    ok: boolean
    db?: { version?: number; time?: number; tables?: Record<string, unknown[]> }
    config?: Record<string, unknown>
    message: string
  }> => ipcRenderer.invoke('workspace:restore'),
  // 窗口控制（自绘红绿灯，替代原生红绿灯）
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('window:maximize'),
  closeWindow: (): void => ipcRenderer.send('window:close'),
  /** 标题栏拖拽：渲染层 mousedown 启动、mousemove 持续挪窗、mouseup 结束（主进程按光标位移 setPosition） */
  dragWindowStart: (): void => ipcRenderer.send('window:drag-start'),
  dragWindowMove: (): void => ipcRenderer.send('window:drag-move'),
  dragWindowEnd: (): void => ipcRenderer.send('window:drag-end'),
  /** 主窗口：订阅窗口聚焦状态（主进程 focus/blur 转发；激活点击被吞时 DOM focus/blur 不可靠） */
  onWindowFocusChanged: (cb: (focused: boolean) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, focused: boolean): void => cb(focused)
    ipcRenderer.on('window:focus-changed', listener)
    return () => ipcRenderer.removeListener('window:focus-changed', listener)
  },
  /** 主窗口：订阅最大化状态变化（Windows 自绘标题栏 max/restore 按钮切换图标） */
  onWindowMaximizedChanged: (cb: (maximized: boolean) => void): (() => void) => {
    const listener = (_e: Electron.IpcRendererEvent, maximized: boolean): void => cb(maximized)
    ipcRenderer.on('window:maximized-changed', listener)
    return () => ipcRenderer.removeListener('window:maximized-changed', listener)
  },
  /** 主窗口：查询当前是否最大化（自绘按钮初始态对齐） */
  getWindowMaximized: (): Promise<boolean> => ipcRenderer.invoke('window:is-maximized'),
  /** 当前操作系统平台（渲染层按平台切换窗口控制按钮样式：darwin 红绿灯 / win32 三按钮） */
  platform: process.platform,
  // 自动走查：Figma REST 只读读取（图层样式树 + Frame 截图）
  figmaFetchDesign: (input: {
    pat: string
    figmaUrl?: string
    scale?: number
  }): Promise<{
    ok: boolean
    message: string
    data?: {
      fileKey: string
      nodeId: string
      nodeName: string
      root: StyleNode
      nodes: StyleNode[]
      screenshotDataUrl: string
      frameSize: { width: number; height: number }
      scale: number
      skippedCount: number
    }
  }> => ipcRenderer.invoke('figma:fetchDesign', input),
  // 自动走查：轻量读取 Figma Frame 尺寸（视口宽度自动匹配用，不渲染截图）
  figmaNodeSize: (input: {
    pat: string
    figmaUrl?: string
  }): Promise<{ ok: boolean; message: string; width?: number; height?: number; nodeName?: string }> =>
    ipcRenderer.invoke('figma:nodeSize', input),
  // 设计规范 Token 同步：Variables → Styles → 启发式 三级解析（失败时 reject；startLevel 指定起始级别，variableDenied=变量无权限已中断）
  specSyncTokens: (input: {
    pat: string
    figmaUrl: string
    startLevel?: 'variable' | 'style' | 'heuristic'
  }): Promise<SpecSyncResult> => ipcRenderer.invoke('spec:sync', input),
  // 设计规范检查更新：轻量读取各 Figma 文件 last_modified（depth=0），与本地同步时间比对
  specCheckUpdates: (input: {
    pat: string
    fileKeys: string[]
  }): Promise<
    { fileKey: string; ok: boolean; message: string; lastModified?: number; fileName?: string }[]
  > => ipcRenderer.invoke('spec:checkUpdates', input),
  // 设计规范 .fig 存档：系统对话框选择文件复制进数据目录（仅存档不解析）
  specImportFig: (): Promise<{ relativePath: string; fileName: string } | null> =>
    ipcRenderer.invoke('spec:importFig'),
  // 自动走查：模糊匹配 + 属性级样式比对（主进程执行）
  walkthroughCompare: (input: {
    designRoot: StyleNode
    domRoot: StyleNode
    tolerance?: Partial<ToleranceConfig>
    viewport: { width: number; height: number }
    /** 是否比对宽高与内边距/间距（仅检查深度为严格时 true） */
    includeSizeSpacing?: boolean
  }): Promise<{
    ok: boolean
    message?: string
    pairs: MatchPair[]
    diffs: StyleDiff[]
    unmatchedDesignCount: number
    unmatchedDomCount: number
    /** 分层误差旁路判定结果（分层开关开启时返回） */
    layered?: LayeredRunSummary
    /** 圆角父级裁剪豁免项（结构化对比增强开启且圆角追溯生效时返回，仅旁路展示） */
    exemptDiffs?: StyleDiff[]
  }> => ipcRenderer.invoke('walkthrough:compare', input),
  // ===== 客观走查门（ux-ui-agent-skills vendor）=====
  /** 列出全部可用 gate（名称 / 是否需浏览器 / 测量内容） */
  gatesList: (): Promise<{
    ok: boolean
    gates: { name: string; file: string; runner: 'node' | 'python3'; browser: boolean; measures: string }[]
    message?: string
  }> => ipcRenderer.invoke('gates:list'),
  /** 运行单个客观 gate（targets 传 HTML 路径，或直接传 html 内容），exitCode 0=通过 1=发现问题 2=无法测量 */
  gatesRun: (input: {
    name: string
    targets?: string[]
    html?: string
    timeoutMs?: number
  }): Promise<{
    ok: boolean
    exitCode: number
    stdout: string
    stderr: string
    durationMs: number
    timedOut: boolean
    message?: string
    gate?: string
  }> => ipcRenderer.invoke('gates:run', input),
  // ===== 界面语言：通知主进程按语言重建应用菜单（渲染层语言包切换后调用） =====
  setAppLang: (lang: 'zh-CN' | 'en-US'): void => ipcRenderer.send('app:set-lang', lang),
  // ===== AI 小助手（独立流式通道，与走查识别互不影响） =====
  /** 发起助手流式对话（delta 经 onAssistantChunk 逐段回传，invoke 在流结束后返回最终状态） */
  aiAssistantChat: (input: {
    reqId: string
    modelId: string
    messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
  }): Promise<{ ok: boolean; aborted?: boolean; message: string }> =>
    ipcRenderer.invoke('ai:assistant:chat', input),
  /** 中断助手流式生成 */
  aiAssistantAbort: (reqId: string): Promise<boolean> => ipcRenderer.invoke('ai:assistant:abort', reqId),
  /** 助手流式 delta 事件（返回取消订阅） */
  onAssistantChunk: (
    cb: (chunk: { reqId: string; delta: string; reasoning?: string; done?: boolean; error?: string }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      chunk: { reqId: string; delta: string; reasoning?: string; done?: boolean; error?: string }
    ): void => cb(chunk)
    ipcRenderer.on('ai:assistant:chunk', listener)
    return () => ipcRenderer.removeListener('ai:assistant:chunk', listener)
  },
  /** 提示词优化：把输入框草稿交给模型改写为更清晰的提问（非流式，一次性返回） */
  aiAssistantOptimize: (input: { modelId: string; draft: string }): Promise<{ ok: boolean; text?: string; message: string }> =>
    ipcRenderer.invoke('ai:assistant:optimize', input),
  // ===== 标注截图附件（详情弹窗专用） =====
  /** 系统对话框多选本地图片，返回文件名 + data URL（落盘统一走 saveAttachment） */
  pickLocalAttachments: (): Promise<{ fileName: string; ext: string; size: number; dataUrl: string }[]> =>
    ipcRenderer.invoke('attachment:pickLocal'),
  /** 附件原图落盘 walkthrough-data/attachments/<pageId>/，返回相对路径与字节数 */
  saveAttachment: (dataUrl: string, pageId: string): Promise<{ relPath: string; size: number }> =>
    ipcRenderer.invoke('attachment:save', dataUrl, pageId),
  /** 批量删除附件原图（仅允许 attachments/ 目录内路径），返回成功删除数 */
  deleteAttachments: (relPaths: string[]): Promise<number> =>
    ipcRenderer.invoke('attachment:deleteMany', relPaths),
  /** 读取剪贴板图片（主进程兜底通道），无图片返回 null */
  readClipboardImage: (): Promise<string | null> =>
    ipcRenderer.invoke('attachment:readClipboardImage'),
  // ===== 标注截图（详情弹窗「截图」按钮 + 全屏选区 overlay） =====
  /** 冻结屏幕 → overlay 框选 → 返回选区原图 data URL；失败时带原因（permission/cancelled/error/busy） */
  captureRegion: (): Promise<{ ok: true; dataUrl: string } | { ok: false; reason: 'permission' | 'cancelled' | 'error' | 'busy' }> =>
    ipcRenderer.invoke('attachment:captureRegion'),
  /** overlay 初始化：返回冻结帧压缩预览 + overlay 逻辑尺寸（仅 overlay 窗口自身可调用，非 overlay 返回 null） */
  captureOverlayInit: (): Promise<{ bgDataUrl: string; width: number; height: number } | null> =>
    ipcRenderer.invoke('capture-overlay:init'),
  /** overlay 背景就绪：通知主进程显示窗口（消除白屏闪烁） */
  captureOverlayShown: (): void => ipcRenderer.send('capture-overlay:shown'),
  /** overlay 选区确认：上报选区矩形（CSS 像素） */
  captureOverlaySelect: (rect: { x: number; y: number; width: number; height: number }): void =>
    ipcRenderer.send('capture-overlay:select', rect),
  /** overlay 取消（Esc / 点击空白 / 拖拽过小） */
  captureOverlayCancel: (): void => ipcRenderer.send('capture-overlay:cancel'),
  /** 屏幕选择器：用户点击目标屏后通知主进程（仅屏幕选择器窗口可调用） */
  captureScreenPick: (idx: number): void => ipcRenderer.send('capture-screen-pick', idx),
  /** 产品标注 URL 采集：内置浏览器截图完成后回传结果到主窗口（新建页面用） */
  newPageResult: (data: { dataUrl: string; name?: string }): void => ipcRenderer.send('browser:new-page-result', data),
  /** 监听内置浏览器 URL 采集回传结果（新建页面用） */
  onNewPageResult: (cb: (data: { dataUrl: string; name?: string }) => void): (() => void) => {
    const handler = (_e: any, data: { dataUrl: string; name?: string }) => cb(data)
    ipcRenderer.on('browser:new-page-result', handler as any)
    return () => ipcRenderer.removeListener('browser:new-page-result', handler as any)
  },
  /** 产品标注画布 URL 采集：替换当前页图片的回传通道 */
  urlCaptureResult: (data: { dataUrl: string; name?: string }): void => ipcRenderer.send('browser:url-capture-result', data),
  /** 监听内置浏览器 URL 采集回传结果（画布替换图片用） */
  onUrlCaptureResult: (cb: (data: { dataUrl: string; name?: string }) => void): (() => void) => {
    const handler = (_e: any, data: { dataUrl: string; name?: string }) => cb(data)
    ipcRenderer.on('browser:url-capture-result', handler as any)
    return () => ipcRenderer.removeListener('browser:url-capture-result', handler as any)
  },
  /** 打开内置浏览器弹窗（支持 captureMode 产品标注采集模式） */
  openBrowserWindow: (url?: string, opts?: { captureMode?: boolean; loginMode?: boolean; capturePurpose?: 'newPage' | 'replaceImage' }): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('browser:openWindow', url, opts),
  // ===== macOS 录屏权限引导（截图功能依赖系统「录屏与系统录音」授权） =====
  /** 查询屏幕录制权限状态（darwin 返回实际状态，其他平台恒为 granted） */
  screenPermissionStatus: (): Promise<'granted' | 'denied' | 'restricted' | 'not-determined'> =>
    ipcRenderer.invoke('permission:screenStatus'),
  /** 打开系统设置 → 隐私与安全性 → 录屏与系统录音 */
  openScreenPermissionSettings: (): Promise<void> => ipcRenderer.invoke('permission:openScreenSettings'),
  /** 应用信息（名称 + 图标 dataURL，权限引导弹窗展示用） */
  getAppInfo: (): Promise<{ name: string; iconDataUrl: string }> => ipcRenderer.invoke('permission:appInfo'),
  /** 启动应用包原生拖拽：按住引导弹窗图标 → 拖入系统设置列表完成授权 */
  startAppDrag: (): Promise<boolean> => ipcRenderer.invoke('permission:startAppDrag')
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
