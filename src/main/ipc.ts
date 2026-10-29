import { app, ipcMain, dialog, shell } from 'electron'
import { join, dirname } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync
} from 'fs'
import { registerAiHandlers } from './ai'
import { registerAssistantHandlers } from './assistant'
import { registerFeishuHandlers } from './feishu'
import { registerDocExportHandlers } from './docExport'
import { fetchFigmaDesign, fetchFigmaFileMeta, fetchFigmaNodeSize, proxyFetch, setFigmaCustomProxy } from './figma'
import { syncSpecTokens } from './specSync'
import { registerBrowserHandlers } from './browserWindow'
import { registerGateHandlers } from './gates'
import { matchNodes } from './matcher'
import { computeDiffs } from './diff'
import { normalizeTolerance } from '../shared/types'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp'
}

let imagesDir = ''
let dataDir = ''
let configPath = ''
let specsDir = ''

function ensureDataDirs(): void {
  dataDir = join(app.getPath('userData'), 'walkthrough-data')
  imagesDir = join(dataDir, 'images')
  specsDir = join(dataDir, 'specs')
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })
  if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true })
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

/** 应用 MCP 管理中已启用服务的自定义代理到 Figma 网络层（多个启用服务取第一个配置了代理的） */
function applyMcpProxy(): void {
  const cfg = getConfigData()
  const mcps = (cfg.mcps as { proxy?: string; enabled?: boolean }[] | undefined) ?? []
  const proxy =
    mcps.find((m) => m.enabled !== false && m.proxy && m.proxy.trim())?.proxy?.trim() ?? ''
  setFigmaCustomProxy(proxy)
}

export function registerIpcHandlers(): void {
  ensureDataDirs()
  registerAiHandlers()
  registerAssistantHandlers()
  registerFeishuHandlers()
  registerDocExportHandlers()
  registerGateHandlers()

  // 保存图片二进制，返回相对路径（数据库中仅存相对路径）
  ipcMain.handle('file:saveImage', (_e, buffer: ArrayBuffer, ext: string) => {
    const fileName = `${crypto.randomUUID()}.${ext}`
    writeFileSync(join(imagesDir, fileName), Buffer.from(buffer))
    return `images/${fileName}`
  })

  // 保存 data URL 图片（canvas 裁剪输出等），字符串跨 IPC 更可靠；返回相对路径
  ipcMain.handle('file:saveDataUrl', (_e, dataUrl: string) => {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(dataUrl.trim())
    if (!m) throw new Error('不支持的数据 URL 格式')
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const fileName = `${crypto.randomUUID()}.${ext}`
    writeFileSync(join(imagesDir, fileName), Buffer.from(m[2], 'base64'))
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

  // 通用文本文件另存为（设计规范 Token 导出 JSON/CSS/Tailwind 等），不自动打开文件
  ipcMain.handle(
    'file:saveText',
    async (
      _e,
      content: string,
      fileName: string,
      filter?: { name: string; extensions: string[] }
    ): Promise<{ ok: boolean; canceled: boolean; path: string | null; fallback: boolean; message: string }> => {
      const result = await dialog.showSaveDialog({
        title: '保存文件',
        defaultPath: fileName,
        filters: filter ? [filter] : undefined
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
          writeFileSync(attempts[i], content, 'utf-8')
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

  // 用系统默认应用打开文件/目录（导出报告后快速查看）
  ipcMain.handle('file:open', (_e, targetPath: string) => {
    const p = String(targetPath ?? '').trim()
    if (!p) return false
    return shell.openPath(p)
  })

  // Figma REST 只读读取（图层样式树 + Frame 截图），PAT 复用 MCP 配置令牌；先应用 MCP 自定义代理
  ipcMain.handle('figma:fetchDesign', (_e, input: { pat: string; figmaUrl?: string; scale?: number }) => {
    applyMcpProxy()
    return fetchFigmaDesign(input)
  })

  // Figma 轻量读取 Frame 尺寸（自动走查视口宽度自动匹配，不渲染截图）
  ipcMain.handle('figma:nodeSize', (_e, input: { pat: string; figmaUrl?: string }) => {
    applyMcpProxy()
    return fetchFigmaNodeSize(input)
  })

  // 设计规范 Token 同步：Variables → Styles → 启发式 三级解析（PAT 复用 MCP 配置令牌；startLevel 指定起始级别）
  ipcMain.handle(
    'spec:sync',
    (_e, input: { pat: string; figmaUrl: string; startLevel?: 'variable' | 'style' | 'heuristic' }) => {
      applyMcpProxy()
      return syncSpecTokens(input)
    }
  )

  // 设计规范检查更新：逐个轻量读取 Figma 文件 last_modified（depth=0），串行避免限流
  ipcMain.handle(
    'spec:checkUpdates',
    async (_e, input: { pat: string; fileKeys: string[] }) => {
      applyMcpProxy()
      const fileKeys = Array.isArray(input?.fileKeys) ? input.fileKeys.filter(Boolean) : []
      const results: {
        fileKey: string
        ok: boolean
        message: string
        lastModified?: number
        fileName?: string
      }[] = []
      for (const fileKey of fileKeys) {
        const meta = await fetchFigmaFileMeta(fileKey, input.pat)
        results.push({ fileKey, ...meta })
      }
      return results
    }
  )

  // 设计规范 .fig 存档：选择本地文件复制进数据目录（仅存档不解析），返回相对路径与原始文件名
  ipcMain.handle('spec:importFig', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择 .fig 文件',
      filters: [{ name: 'Figma', extensions: ['fig'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) return null
    const src = result.filePaths[0]
    const base = (src.split(/[\\/]/).pop() ?? 'archive.fig').replace(/[^\w.\-\u4e00-\u9fa5]+/g, '_')
    const fileName = `fig-${crypto.randomUUID().slice(0, 8)}-${base}`
    copyFileSync(src, join(specsDir, fileName))
    return { relativePath: `specs/${fileName}`, fileName: base }
  })

  // 自动走查：模糊匹配 + 属性级样式比对（容差从配置合并默认值）
  ipcMain.handle(
    'walkthrough:compare',
    (
      _e,
      input: {
        designRoot: import('../shared/types').StyleNode
        domRoot: import('../shared/types').StyleNode
        tolerance?: Record<string, number>
        viewport: { width: number; height: number }
        /** 是否比对宽高与内边距/间距（仅检查深度为严格时 true） */
        includeSizeSpacing?: boolean
      }
    ) => {
      const { designRoot, domRoot, viewport } = input
      const tolerance = normalizeTolerance(input.tolerance)
      const { pairs, unmatchedDesignCount, unmatchedDomCount } = matchNodes(designRoot, domRoot)
      const diffs = computeDiffs(pairs, tolerance, viewport, input.includeSizeSpacing !== false)
      return { ok: true, pairs, diffs, unmatchedDesignCount, unmatchedDomCount }
    }
  )

  // MCP 连通性测试：任何 HTTP 响应（含 405/404）都视为服务可达，仅网络层失败为不可达
  ipcMain.handle(
    'mcp:testConnectivity',
    async (_e, input: { serverUrl: string; pat?: string; proxy?: string }) => {
      setFigmaCustomProxy(input.proxy?.trim() ?? '')
      const start = Date.now()
      try {
        const headers: Record<string, string> = {}
        if (input.pat && input.pat.trim()) headers.Authorization = `Bearer ${input.pat.trim()}`
        const res = await proxyFetch(input.serverUrl, { headers })
        const ms = Date.now() - start
        return res.status < 500
          ? { ok: true, message: `连接成功（HTTP ${res.status}，${ms}ms）`, latencyMs: ms }
          : { ok: false, message: `服务响应异常（HTTP ${res.status}）`, latencyMs: ms }
      } catch (err) {
        return { ok: false, message: `连接失败：${err instanceof Error ? err.message : String(err)}` }
      }
    }
  )

  // 开发浏览器弹窗（打开/聚焦、自动走查弹窗内采集、采集结果回传）
  registerBrowserHandlers()

  // ===== SkillHub：导入 Zip 安装包 =====
  /** 递归收集目录下所有文件（相对路径） */
  const walkFiles = (dir: string, base = ''): string[] => {
    const out: string[] = []
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      const rel = base ? `${base}/${name}` : name
      if (statSync(full).isDirectory()) out.push(...walkFiles(full, rel))
      else out.push(rel)
    }
    return out
  }
  /** 单个指南内容上限（字符），超长截断避免撑爆识别请求 */
  const GUIDE_MAX_CHARS = 3000

  ipcMain.handle('skills:importZip', async (): Promise<{
    ok: boolean
    canceled: boolean
    message: string
    skill?: { name: string; desc?: string; guides: string[] }
  }> => {
    const result = await dialog.showOpenDialog({
      title: '选择 Skill 安装包',
      filters: [{ name: 'Skill 安装包', extensions: ['zip'] }],
      properties: ['openFile']
    })
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true, message: '' }
    }
    const zipPath = result.filePaths[0]
    const zipName = zipPath.split('/').pop() ?? ''
    const tmpDir = join(app.getPath('userData'), 'skill-import-tmp')
    try {
      rmSync(tmpDir, { recursive: true, force: true })
      mkdirSync(tmpDir, { recursive: true })
      // macOS 系统自带 unzip 解压（-o 覆盖 -q 静默）
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/unzip', ['-o', '-q', zipPath, '-d', tmpDir], (err) =>
          err ? reject(new Error(`解压失败：${err.message}`)) : resolve()
        )
      })
      const files = walkFiles(tmpDir)
      if (!files.length) return { ok: false, canceled: false, message: '安装包为空或解压失败' }
      // 解析 manifest（skill.json / manifest.json，取 name / description）
      const manifestFile = files.find((f) => /(^|\/)(skill|manifest)\.json$/i.test(f))
      let name = zipName.replace(/\.zip$/i, '') || '导入的技能'
      let desc = ''
      if (manifestFile) {
        try {
          const j = JSON.parse(readFileSync(join(tmpDir, manifestFile), 'utf-8')) as {
            name?: string
            description?: string
            desc?: string
          }
          if (j.name && j.name.trim()) name = j.name.trim()
          desc = (j.description ?? j.desc ?? '').trim()
        } catch {
          // manifest 损坏时回退 zip 文件名
        }
      } else {
        // Claude 风格 SKILL.md：frontmatter 或首个一级标题作为名称
        const skillMd = files.find((f) => /(^|\/)skill\.md$/i.test(f))
        if (skillMd) {
          const head = readFileSync(join(tmpDir, skillMd), 'utf-8').slice(0, 600)
          const fmName = head.match(/^name:\s*(.+)$/m)?.[1]?.trim()
          const h1 = head.match(/^#\s+(.+)$/m)?.[1]?.trim()
          if (fmName) name = fmName
          else if (h1) name = h1
        }
      }
      // 收集全部 .md 指南（按路径排序，单个截断）
      const guides = files
        .filter((f) => f.toLowerCase().endsWith('.md'))
        .sort()
        .map((f) => readFileSync(join(tmpDir, f), 'utf-8').trim().slice(0, GUIDE_MAX_CHARS))
        .filter((g) => g.length > 0)
        .slice(0, 10)
      if (!guides.length) {
        return { ok: false, canceled: false, message: '安装包中未找到 .md 指南文档，请检查包内容' }
      }
      return { ok: true, canceled: false, message: 'ok', skill: { name, desc: desc || undefined, guides } }
    } catch (err) {
      return { ok: false, canceled: false, message: err instanceof Error ? err.message : String(err) }
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

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
