import { contextBridge, ipcRenderer } from 'electron'

const api = {
  saveImage: (buffer: ArrayBuffer, ext: string): Promise<string> =>
    ipcRenderer.invoke('file:saveImage', buffer, ext),
  readImage: (relativePath: string): Promise<string | null> =>
    ipcRenderer.invoke('file:readImage', relativePath),
  deleteImage: (relativePath: string): Promise<boolean> =>
    ipcRenderer.invoke('file:deleteImage', relativePath),
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
  getConfig: (): Promise<Record<string, unknown>> => ipcRenderer.invoke('config:get'),
  setConfig: (key: string, value: unknown): Promise<boolean> =>
    ipcRenderer.invoke('config:set', key, value),
  // AI 识别
  aiTest: (modelId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }> =>
    ipcRenderer.invoke('ai:test', modelId),
  aiAnnotate: (input: {
    modelId: string
    pageName: string
    platformLabel: string
    designDataUrl: string
    shotDataUrl: string
    /** SkillHub 技能指引（选中技能的说明），注入识别请求 */
    skillGuides?: string[]
  }): Promise<{
    ok: boolean
    issues?: {
      targetImage: 'design' | 'screenshot'
      shape: 'rect' | 'point' | 'text'
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
      targetLabel: string
      statusLabel: string
      suggestion?: { current: string; fix: string; properties?: string }
    }[]
    images: { name: string; dataUrl: string }[]
    htmlReport?: { name: string; dataUrl: string }
  }): Promise<{ ok: boolean; url?: string; message: string }> =>
    ipcRenderer.invoke('feishu:createReport', payload),
  // 窗口控制（自绘红绿灯，替代原生红绿灯）
  minimizeWindow: (): void => ipcRenderer.send('window:minimize'),
  maximizeWindow: (): void => ipcRenderer.send('window:maximize'),
  closeWindow: (): void => ipcRenderer.send('window:close')
}

export type ElectronAPI = typeof api

contextBridge.exposeInMainWorld('electronAPI', api)
