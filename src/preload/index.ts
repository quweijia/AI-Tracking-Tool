import { contextBridge, ipcRenderer } from 'electron'
import type { StyleNode, ToleranceConfig, MatchPair, StyleDiff, SpecSyncResult } from '../shared/types'

const api = {
  saveImage: (buffer: ArrayBuffer, ext: string): Promise<string> =>
    ipcRenderer.invoke('file:saveImage', buffer, ext),
  saveDataUrl: (dataUrl: string): Promise<string> =>
    ipcRenderer.invoke('file:saveDataUrl', dataUrl),
  readImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('file:readImage', relativePath),
  deleteImage: (relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:deleteImage', relativePath),
  /** 用系统默认应用打开文件/目录（导出报告后快速查看） */
  openFile: (targetPath: string): Promise<string> => ipcRenderer.invoke('file:open', targetPath),
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
  // 分析报告：用系统浏览器打开本地导出的 HTML 报告文件
  openReportSystem: (filePath: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('report:openSystem', filePath),
  // 分析报告：用内置浏览器打开本地导出的 HTML 报告文件
  openReportBuiltin: (filePath: string): Promise<{ ok: boolean; message: string }> =>
    ipcRenderer.invoke('report:openBuiltin', filePath),
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
  // 窗口控制（自绘红绿灯，替代原生红绿灯）
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('window:maximize'),
  closeWindow: (): void => ipcRenderer.send('window:close'),
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
    cb: (chunk: { reqId: string; delta: string; done?: boolean; error?: string }) => void
  ): (() => void) => {
    const listener = (
      _e: Electron.IpcRendererEvent,
      chunk: { reqId: string; delta: string; done?: boolean; error?: string }
    ): void => cb(chunk)
    ipcRenderer.on('ai:assistant:chunk', listener)
    return () => ipcRenderer.removeListener('ai:assistant:chunk', listener)
  }
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
