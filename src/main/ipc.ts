import { app, ipcMain, dialog, shell } from 'electron'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from 'fs'
import { registerAiHandlers } from './ai'
import { registerFeishuHandlers } from './feishu'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

let imagesDir = ''
let dataDir = ''
let configPath = ''

function ensureDataDirs(): void {
  dataDir = join(app.getPath('userData'), 'walkthrough-data')
  imagesDir = join(dataDir, 'images')
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })
  configPath = join(app.getPath('userData'), 'walkthrough-config.json')
}

function resolveImagePath(relativePath: string): string {
  return join(dataDir, relativePath)
}

/** 读取本地配置（供 AI / 飞书等主进程模块复用） */
export function getConfigData(): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  try {
    return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
  } catch {
    return {}
  }
}

export function registerIpcHandlers(): void {
  ensureDataDirs()
  registerAiHandlers()
  registerFeishuHandlers()

  // 保存图片二进制，返回相对路径（数据库中仅存相对路径）
  ipcMain.handle('file:saveImage', (_e, buffer: ArrayBuffer, ext: string) => {
    const fileName = `${crypto.randomUUID()}.${ext}`
    writeFileSync(join(imagesDir, fileName), Buffer.from(buffer))
    return `images/${fileName}`
  })

  // 读取图片，返回 data URL
  ipcMain.handle('file:readImage', (_e, relativePath: string) => {
    const fullPath = resolveImagePath(relativePath)
    if (!existsSync(fullPath)) return null
    const ext = (relativePath.split('.').pop() ?? 'png').toLowerCase()
    const mime = MIME[ext] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(fullPath).toString('base64')}`
  })

  ipcMain.handle('file:deleteImage', (_e, relativePath: string) => {
    const fullPath = resolveImagePath(relativePath)
    if (existsSync(fullPath)) unlinkSync(fullPath)
    return true
  })

  // 系统对话框选择图片，复制进数据目录，返回相对路径 + data URL
  ipcMain.handle('file:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const src = result.filePaths[0]
    const ext = (src.split('.').pop() ?? 'png').toLowerCase()
    const fileName = `${crypto.randomUUID()}.${ext}`
    const buffer = readFileSync(src)
    writeFileSync(join(imagesDir, fileName), buffer)
    const mime = MIME[ext] ?? 'image/png'
    return {
      relativePath: `images/${fileName}`,
      dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
    }
  })

  // 导出 HTML 报告到用户选择的位置。
  // 若目标位置无写入权限（如系统目录受限），自动降级到应用数据目录/临时目录，保证报告一定导得出来
  ipcMain.handle(
    'file:exportReport',
    async (
      _e,
      html: string,
      fileName: string
    ): Promise<{
      ok: boolean
      canceled: boolean
      path: string | null
      fallback: boolean
      message: string
    }> => {
      const result = await dialog.showSaveDialog({
        title: '导出报告',
        defaultPath: fileName,
        filters: [{ name: 'HTML', extensions: ['html'] }]
      })
      if (result.canceled || !result.filePath) {
        return { ok: false, canceled: true, path: null, fallback: false, message: '' }
      }

      const attempts = [
        result.filePath,
        join(dataDir, 'exports', fileName),
        join(tmpdir(), 'ui-walkthrough-exports', fileName)
      ]
      let lastError = ''
      for (let i = 0; i < attempts.length; i++) {
        try {
          mkdirSync(dirname(attempts[i]), { recursive: true })
          writeFileSync(attempts[i], html, 'utf-8')
          shell.openPath(attempts[i])
          return {
            ok: true,
            canceled: false,
            path: attempts[i],
            fallback: i > 0,
            message: i > 0 ? `目标位置无写入权限，已改存到：${attempts[i]}` : ''
          }
        } catch (err) {
          lastError = err instanceof Error ? err.message : String(err)
        }
      }
      return { ok: false, canceled: false, path: null, fallback: false, message: lastError }
    }
  )

  // 配置读写（AI API Key、飞书授权等）
  ipcMain.handle('config:get', () => {
    if (!existsSync(configPath)) return {}
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8'))
    } catch {
      return {}
    }
  })

  ipcMain.handle('config:set', (_e, key: string, value: unknown) => {
    let config: Record<string, unknown> = {}
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, 'utf-8'))
      } catch {
        config = {}
      }
    }
    config[key] = value
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
    return true
  })
}
