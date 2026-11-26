import { app, clipboard, ipcMain, dialog, BrowserWindow, nativeTheme } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join, dirname, relative, isAbsolute } from 'path'
import { tmpdir } from 'os'
import { execFile } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  renameSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
  cpSync
} from 'fs'
import { registerAiHandlers } from './ai'
import { registerAssistantHandlers } from './assistant'
import { registerFeishuHandlers } from './feishu'
import { registerDocExportHandlers } from './docExport'
import { fetchFigmaDesign, fetchFigmaFileMeta, fetchFigmaNodeSize, proxyFetch, setFigmaCustomProxy } from './figma'
import { syncSpecTokens } from './specSync'
import { registerBrowserHandlers } from './browserWindow'
import { registerWalkSessionHandlers } from './walkSession'
import { registerGateHandlers } from './gates'
import { registerCaptureHandlers } from './capture'
import { matchNodes } from './matcher'
import { computeDiffs } from './diff'
import { computeLayered } from './layered'
import {
  LAYERED_TOLERANCE_KEY,
  STRUCTURED_CHECKS_KEY,
  normalizeLayeredTolerance,
  normalizeStructuredChecks,
  normalizeTolerance
} from '../shared/types'
import type { LayeredToleranceConfig, StructuredChecksConfig } from '../shared/types'

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif'
}

let imagesDir = ''
let dataDir = ''
let configPath = ''
let specsDir = ''
let trashDir = ''

function ensureDataDirs(): void {
  // 数据目录：默认 userData/walkthrough-data；设置工作区文件夹后数据迁移至该处（config.workspaceDir）
  configPath = join(app.getPath('userData'), 'walkthrough-config.json')
  const saved = getConfigData()['workspaceDir']
  const custom = typeof saved === 'string' && saved.trim() && isAbsolute(saved.trim()) ? saved.trim() : ''
  dataDir = custom || join(app.getPath('userData'), 'walkthrough-data')
  imagesDir = join(dataDir, 'images')
  specsDir = join(dataDir, 'specs')
  trashDir = join(dataDir, 'image_trash')
  if (!existsSync(imagesDir)) mkdirSync(imagesDir, { recursive: true })
  if (!existsSync(specsDir)) mkdirSync(specsDir, { recursive: true })
  if (!existsSync(trashDir)) mkdirSync(trashDir, { recursive: true })
  cleanupTrash()
}

/** 图片回收站登记条目：撤回删除（Cmd+Z）时按原路径恢复，超 7 天随启动清理 */
interface TrashEntry {
  trashName: string
  /** 相对 walkthrough-data 根的原路径 */
  relPath: string
  deletedAt: number
}

function readTrashRegistry(): TrashEntry[] {
  try {
    return JSON.parse(readFileSync(join(trashDir, 'registry.json'), 'utf-8')) as TrashEntry[]
  } catch {
    return []
  }
}

function writeTrashRegistry(items: TrashEntry[]): void {
  try {
    writeFileSync(join(trashDir, 'registry.json'), JSON.stringify(items))
  } catch (err) {
    // 登记失败仅影响撤回，不阻塞删除主流程
    console.warn('[IMAGE] 回收站登记写入失败:', err)
  }
}

/** 启动清理：物理删除回收站中超 7 天的文件并移除登记条目 */
function cleanupTrash(): void {
  const items = readTrashRegistry()
  if (!items.length) return
  const deadline = Date.now() - 7 * 24 * 60 * 60 * 1000
  const keep: TrashEntry[] = []
  for (const item of items) {
    if (item.deletedAt < deadline) {
      try {
        rmSync(join(trashDir, item.trashName), { force: true })
      } catch (err) {
        console.warn('[IMAGE] 回收站清理失败:', item.trashName, err)
      }
    } else {
      keep.push(item)
    }
  }
  if (keep.length !== items.length) writeTrashRegistry(keep)
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
  migrateLegacyWorkspace()
  registerAiHandlers()
  registerAssistantHandlers()
  registerFeishuHandlers()
  registerDocExportHandlers()
  registerGateHandlers()
  registerCaptureHandlers()

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

  // 主题源同步：渲染层把解析后的主题（light/dark）同步给原生层。
  // Electron 原生窗口 chrome 默认跟随系统深浅色，系统深色 + 应用浅色时
  // macOS 会在窗口外围绘制一圈深色描边，同步后原生层与应用外观一致
  ipcMain.handle('theme:setSource', (_e, source: 'system' | 'light' | 'dark') => {
    nativeTheme.themeSource = source
    return true
  })

  // 读取图片，返回 data URL
  ipcMain.handle('file:readImage', (_e, relativePath: string) => {
    const fullPath = resolveImagePath(relativePath)
    if (!existsSync(fullPath)) return null
    const ext = (relativePath.split('.').pop() ?? 'png').toLowerCase()
    const mime = MIME[ext] ?? 'image/png'
    return `data:${mime};base64,${readFileSync(fullPath).toString('base64')}`
  })

  // 删除图片：先移入回收站（支持 Cmd+Z 撤回删除），登记原路径；超 7 天随启动清理物理删除
  ipcMain.handle('file:deleteImage', (_e, relativePath: string) => {
    const fullPath = resolveImagePath(relativePath)
    if (existsSync(fullPath)) {
      try {
        const trashName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${relativePath.split(/[\\/]/).pop() ?? 'img'}`
        renameSync(fullPath, join(trashDir, trashName))
        writeTrashRegistry([...readTrashRegistry(), { trashName, relPath: relativePath, deletedAt: Date.now() }])
      } catch (err) {
        // 移入回收站失败兜底直接删除（保证删除主流程不中断）
        console.warn('[IMAGE] 移入回收站失败，直接删除:', relativePath, err)
        try {
          unlinkSync(fullPath)
        } catch {
          /* 文件占用等极端情况放弃 */
        }
      }
    }
    return true
  })

  // 撤回删除：按最新登记条目把回收站文件移回原路径（同一路径多次删除时恢复最近一次），返回成功恢复数
  ipcMain.handle('file:restoreImages', (_e, relPaths: unknown) => {
    const wanted = new Set(
      Array.isArray(relPaths) ? relPaths.filter((p): p is string => typeof p === 'string') : []
    )
    if (!wanted.size) return 0
    const items = readTrashRegistry()
    const used = new Set<number>()
    let restored = 0
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (!wanted.has(item.relPath) || used.has(i)) continue
      used.add(i)
      const from = join(trashDir, item.trashName)
      if (!existsSync(from)) continue
      try {
        const to = resolveImagePath(item.relPath)
        mkdirSync(dirname(to), { recursive: true })
        renameSync(from, to)
        restored++
      } catch (err) {
        console.warn('[IMAGE] 恢复图片失败:', item.relPath, err)
      }
    }
    if (used.size) writeTrashRegistry(items.filter((_it, i) => !used.has(i)))
    return restored
  })

  // 回收站「彻底删除」：物理删除数据文件（不走 image_trash 兜底），并连带清理此前
  // 已散落在 image_trash 中的同路径历史文件；单文件失败仅记 [TRASH] 日志，不阻塞整体流程
  ipcMain.handle('file:purgeImages', (_e, relPaths: unknown) => {
    const wanted = Array.isArray(relPaths)
      ? Array.from(
          new Set(relPaths.filter((p): p is string => typeof p === 'string' && p.trim().length > 0))
        )
      : []
    if (!wanted.length) return 0
    const wantedSet = new Set(wanted)
    let purged = 0
    for (const relPath of wanted) {
      try {
        const fullPath = resolveImagePath(relPath)
        if (existsSync(fullPath)) {
          rmSync(fullPath, { force: true })
          purged++
        }
      } catch (err) {
        console.warn('[TRASH] 彻底删除图片失败:', relPath, err)
      }
    }
    // 同步清理 image_trash 中同原路径的历史登记条目（如此前单独删除过的旧版截图）
    const items = readTrashRegistry()
    const keep: typeof items = []
    for (const item of items) {
      if (!wantedSet.has(item.relPath)) {
        keep.push(item)
        continue
      }
      try {
        rmSync(join(trashDir, item.trashName), { force: true })
        purged++
      } catch (err) {
        console.warn('[TRASH] 清理废纸篓图片失败:', item.relPath, err)
        keep.push(item) // 删除失败保留登记，待后续流程再清
      }
    }
    if (keep.length !== items.length) writeTrashRegistry(keep)
    return purged
  })

  // 回收站磁盘治理：孤儿文件回收（阶段 3）。渲染层传入「全部存活记录的引用路径白名单」
  // （含回收站软删记录——可还原的文件不能当孤儿删）与「全部页面 id 白名单」，本侧扫描
  // images/ 与 attachments/ 目录：无引用文件物理删除；页面 id 不存在的附件目录整目录回收；
  // 目录在白名单内的逐文件比对。单文件失败仅记 [TRASH] 日志，不阻塞、不崩溃
  ipcMain.handle('trash:purgeOrphanFiles', (_e, referenced: unknown, pageIds: unknown) => {
    const refSet = new Set(
      Array.isArray(referenced) ? referenced.filter((p): p is string => typeof p === 'string') : []
    )
    const pageIdSet = new Set(
      Array.isArray(pageIds) ? pageIds.filter((p): p is string => typeof p === 'string') : []
    )
    let purged = 0

    // images/：仅一层文件（saveImage/saveDataUrl/selectImage 均平铺落盘），无引用即孤儿
    try {
      for (const name of readdirSync(imagesDir, { withFileTypes: true })) {
        if (!name.isFile()) continue
        const relPath = `images/${name.name}`
        if (refSet.has(relPath)) continue
        try {
          rmSync(join(imagesDir, name.name), { force: true })
          purged++
        } catch (err) {
          console.warn('[TRASH] 孤儿图片清理失败:', relPath, err)
        }
      }
    } catch (err) {
      console.warn('[TRASH] 孤儿图片扫描失败:', err)
    }

    // attachments/<pageId>/：目录名不在页面白名单 → 整目录回收；在白名单 → 目录内文件逐个比对
    const attachRoot = join(dataDir, 'attachments')
    if (!existsSync(attachRoot)) return purged
    try {
      for (const entry of readdirSync(attachRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        const dirRel = `attachments/${entry.name}`
        if (!pageIdSet.has(entry.name)) {
          try {
            rmSync(join(attachRoot, entry.name), { recursive: true, force: true })
            purged++
            console.log('[TRASH] 回收无主附件目录:', dirRel)
          } catch (err) {
            console.warn('[TRASH] 孤儿附件目录清理失败:', dirRel, err)
          }
          continue
        }
        for (const f of readdirSync(join(attachRoot, entry.name), { withFileTypes: true })) {
          if (!f.isFile()) continue
          const relPath = `${dirRel}/${f.name}`
          if (refSet.has(relPath)) continue
          try {
            rmSync(join(attachRoot, entry.name, f.name), { force: true })
            purged++
          } catch (err) {
            console.warn('[TRASH] 孤儿附件清理失败:', relPath, err)
          }
        }
      }
    } catch (err) {
      console.warn('[TRASH] 孤儿附件扫描失败:', err)
    }
    if (purged > 0) console.log(`[TRASH] 孤儿文件回收完成: ${purged} 个`)
    return purged
  })

  // 系统对话框选择图片，复制进数据目录，返回相对路径 + data URL
  ipcMain.handle('file:selectImage', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择图片',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }],
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

  // ───────────── 标注截图附件（详情弹窗专用，独立命名空间） ─────────────

  // 附件目录：walkthrough-data/attachments/<pageId>/，按页面隔离；pageId 白名单校验防路径穿越
  const ensureAttachDir = (pageId: string): string => {
    if (!/^[\w-]+$/.test(pageId)) throw new Error('非法的页面 ID')
    const dir = join(dataDir, 'attachments', pageId)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    return dir
  }

  // 本地上传：系统对话框多选 png/jpg/jpeg/webp，返回文件名与 data URL（落盘统一走 attachment:save）
  ipcMain.handle('attachment:pickLocal', async () => {
    const result = await dialog.showOpenDialog({
      title: '选择截图附件',
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return []
    return result.filePaths.map((src) => {
      const ext = (src.split('.').pop() ?? 'png').toLowerCase()
      const buffer = readFileSync(src)
      const mime = MIME[ext] ?? 'image/png'
      return {
        fileName: src.split(/[\\/]/).pop() ?? 'image',
        ext,
        size: buffer.byteLength,
        dataUrl: `data:${mime};base64,${buffer.toString('base64')}`
      }
    })
  })

  // 附件原图落盘：attachments/<pageId>/<uuid>.<ext>（磁盘文件名用 uuid，同名展示文件互不覆盖）
  ipcMain.handle('attachment:save', (_e, dataUrl: string, pageId: string) => {
    const m = /^data:image\/(png|jpe?g|webp);base64,(.+)$/.exec(String(dataUrl).trim())
    if (!m) throw new Error('不支持的数据 URL 格式')
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1]
    const dir = ensureAttachDir(pageId)
    const fileName = `${crypto.randomUUID()}.${ext}`
    const buffer = Buffer.from(m[2], 'base64')
    writeFileSync(join(dir, fileName), buffer)
    const relPath = `attachments/${pageId}/${fileName}`
    console.log('[ATTACHMENT] 原图落盘:', relPath, `${buffer.byteLength} bytes`)
    return { relPath, size: buffer.byteLength }
  })

  // 批量删除附件原图（仅允许 attachments/ 目录内路径），返回成功删除数
  ipcMain.handle('attachment:deleteMany', (_e, relPaths: unknown) => {
    const list = Array.isArray(relPaths)
      ? relPaths.filter((p): p is string => typeof p === 'string' && p.startsWith('attachments/'))
      : []
    let deleted = 0
    for (const p of list) {
      const full = resolveImagePath(p)
      if (existsSync(full)) {
        try {
          unlinkSync(full)
          deleted++
        } catch (err) {
          console.warn('[ATTACHMENT] 删除附件文件失败:', p, err)
        }
      }
    }
    return deleted
  })

  // 剪贴板兜底通道：渲染层 navigator.clipboard.read 受限（旧版 Chromium/无焦点）时走主进程读取
  ipcMain.handle('attachment:readClipboardImage', () => {
    const img = clipboard.readImage()
    if (img.isEmpty()) return null
    return `data:image/png;base64,${img.toPNG().toString('base64')}`
  })

  // 导出 HTML 报告到用户选择的位置。
  // 若目标位置无写入权限（如系统目录受限），自动降级到应用数据目录/临时目录，保证报告一定导得出来。
  // 不自动打开文件：由渲染层按设置页「AI 任务默认浏览器」决定用内置浏览器或系统浏览器打开
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
      // 结构化对比增强（圆角 computed 修复等）：配置从默认值合并后透传 computeDiffs
      const checksCfg = normalizeStructuredChecks(
        getConfigData()[STRUCTURED_CHECKS_KEY] as Partial<StructuredChecksConfig> | undefined
      )
      const { diffs, exemptDiffs } = computeDiffs(
        pairs,
        tolerance,
        viewport,
        input.includeSizeSpacing !== false,
        checksCfg
      )
      // 分层误差旁路（v3）：开关关闭时不参与计算，返回值缺省 layered 字段，行为与现状一致
      const layeredCfg = normalizeLayeredTolerance(
        getConfigData()[LAYERED_TOLERANCE_KEY] as Partial<LayeredToleranceConfig> | undefined
      )
      const layered = layeredCfg.enabled ? computeLayered(pairs, layeredCfg, viewport) : undefined
      return { ok: true, pairs, diffs, exemptDiffs, unmatchedDesignCount, unmatchedDomCount, layered }
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

  // 自动走查会话 profile（登录抓取、加密落盘、后续走查注入）
  registerWalkSessionHandlers()

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

  // ───────────── 工作区设置（应用数据存放位置：磁盘占用 / 压缩包备份 / 恢复导入） ─────────────

  /** 读取主进程配置（walkthrough-config.json，缺失或损坏时返回空对象） */
  const readConfigData = (): Record<string, unknown> => {
    if (!existsSync(configPath)) return {}
    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }

  /** 备份的资产目录名（图片 / 规范附件 / 问题截图附件） */
  const ASSET_DIRS = ['images', 'specs', 'attachments'] as const

  /** 备份文件名时间戳段：20261118-1530 */
  const backupStamp = (): string => {
    const d = new Date()
    const p = (n: number): string => String(n).padStart(2, '0')
    return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`
  }

  /** 目录包含关系：b 在 a 内部或与 a 相等时返回 true（用于拒绝嵌套，防止迁移递归复制自身） */
  const isInside = (a: string, b: string): boolean => {
    const rel = relative(a, b)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }

  /**
   * 启动迁移防护：旧版本「工作区文件夹」语义是备份导出路径，残留的 workspaceDir 在新语义下会被当作
   * 数据目录——若该自定义目录尚无图片数据而默认目录有（历史图片被指针抛下），启动时自动把默认目录
   * 数据整体迁移过去，避免备份/读图时数据目录悬空丢图（须在 ensureDataDirs 之后调用，依赖 configPath）
   */
  function migrateLegacyWorkspace(): void {
    const saved = getConfigData()['workspaceDir']
    const custom = typeof saved === 'string' && saved.trim() && isAbsolute(saved.trim()) ? saved.trim() : ''
    if (!custom) return
    const def = join(app.getPath('userData'), 'walkthrough-data')
    if (custom === def) return
    const defImages = join(def, 'images')
    const customImages = join(custom, 'images')
    const hasImages = (dir: string): boolean => existsSync(dir) && readdirSync(dir).length > 0
    // 仅在「默认目录有图、自定义目录无图」时迁移一次；用户主动清空自定义目录后不会反复搬回
    if (!hasImages(defImages) || hasImages(customImages)) return
    try {
      cpSync(def, custom, { recursive: true })
    } catch (err) {
      console.warn('[WORKSPACE] 旧版工作区目录迁移失败:', err)
    }
  }

  /** 系统对话框选择文件夹。必须挂到当前窗口做父窗口，否则 macOS 无边框/全屏状态下对话框可能不显示 */
  const pickFolder = async (e: IpcMainInvokeEvent, title: string): Promise<string | null> => {
    const win = BrowserWindow.fromWebContents(e.sender)
    const opts = {
      title,
      properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>
    }
    const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  }

  /** 更改工作区文件夹：选择新目录 → 迁移现有数据 → 写配置 → 重载数据目录指针（立即生效，无需重启） */
  ipcMain.handle('workspace:pick', async (e) => {
    try {
      const dir = await pickFolder(e, '选择应用数据存放文件夹')
      if (!dir) return { ok: false, canceled: true, message: '' }
      const def = join(app.getPath('userData'), 'walkthrough-data')
      // 与默认数据目录、当前数据目录均不得重合或嵌套（否则迁移时会递归复制自身）
      if (isInside(dir, def) || isInside(def, dir)) {
        return { ok: false, message: '文件夹不能与默认数据目录重合或互相嵌套' }
      }
      if (isInside(dir, dataDir) || isInside(dataDir, dir)) {
        return { ok: false, message: '文件夹不能与当前数据目录重合或互相嵌套' }
      }
      mkdirSync(dir, { recursive: true })
      if (existsSync(dataDir) && readdirSync(dataDir).length > 0) {
        cpSync(dataDir, dir, { recursive: true })
        // 迁移即移动：数据已完整落在新目录，清空旧目录避免双份数据造成混乱（清理失败不阻塞，仅遗留孤儿文件）
        try {
          rmSync(dataDir, { recursive: true, force: true })
        } catch (err) {
          console.warn('[WORKSPACE] 旧数据目录清理失败:', err)
        }
      }
      writeFileSync(configPath, JSON.stringify({ ...readConfigData(), workspaceDir: dir }, null, 2), 'utf-8')
      ensureDataDirs()
      return { ok: true, path: dir }
    } catch (err) {
      return { ok: false, message: `更改工作区文件夹失败：${err instanceof Error ? err.message : String(err)}` }
    }
  })

  /** 磁盘占用统计：递归累加数据目录内全部文件大小 */
  ipcMain.handle('workspace:usage', () => {
    try {
      let total = 0
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const p = join(d, name)
          const st = statSync(p)
          if (st.isDirectory()) walk(p)
          else total += st.size
        }
      }
      if (existsSync(dataDir)) walk(dataDir)
      return { ok: true, bytes: total, dir: dataDir }
    } catch (err) {
      return { ok: false, bytes: 0, dir: dataDir, message: err instanceof Error ? err.message : String(err) }
    }
  })

  /** 备份压缩包：渲染层传全表 JSON 串，主进程弹框选保存文件夹 → 组装临时目录（db/config/meta + 资产）→ 系统 zip 打包 */
  ipcMain.handle('workspace:backup', async (e, dbJson: string) => {
    let staging = ''
    try {
      const dir = await pickFolder(e, '选择备份压缩包保存位置')
      if (!dir) return { ok: false, canceled: true, message: '' }
      staging = join(tmpdir(), `wt-backup-${Date.now()}`)
      mkdirSync(staging, { recursive: true })
      for (const name of ASSET_DIRS) {
        const src = join(dataDir, name)
        if (existsSync(src)) cpSync(src, join(staging, name), { recursive: true })
      }
      writeFileSync(join(staging, 'db.json'), dbJson, 'utf-8')
      // 备份配置剔除本机工作区指向与备份时间（换电脑恢复时不应带上）
      const backupConfig = { ...readConfigData() }
      delete backupConfig['workspaceDir']
      delete backupConfig['workspaceLastBackup']
      writeFileSync(join(staging, 'config.json'), JSON.stringify(backupConfig, null, 2), 'utf-8')
      const time = Date.now()
      writeFileSync(join(staging, 'meta.json'), JSON.stringify({ version: 1, time }, null, 2), 'utf-8')
      const zipPath = join(dir, `AI走查数据备份-${backupStamp()}.zip`)
      // macOS 系统自带 zip 命令递归压缩（与 skills:importZip 的 unzip 方案对称，包内文件名全 ASCII 无编码问题）
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/zip', ['-r', '-q', zipPath, '.'], { cwd: staging }, (err) =>
          err ? reject(err) : resolve()
        )
      })
      writeFileSync(configPath, JSON.stringify({ ...readConfigData(), workspaceLastBackup: time }, null, 2), 'utf-8')
      return { ok: true, time, path: zipPath, message: '备份完成' }
    } catch (err) {
      return { ok: false, message: `备份失败：${err instanceof Error ? err.message : String(err)}` }
    } finally {
      if (staging) rmSync(staging, { recursive: true, force: true })
    }
  })

  /** 恢复压缩包：选择备份 zip → 系统 unzip 解压到临时目录 → 资产回填数据目录 → 配置合并（保留本机工作区指向）→ 返回全表数据由渲染层写回 IndexedDB */
  ipcMain.handle('workspace:restore', async (e) => {
    let tmpDir = ''
    try {
      const win = BrowserWindow.fromWebContents(e.sender)
      const opts = {
        title: '选择备份压缩包',
        properties: ['openFile'] as Array<'openFile'>,
        filters: [{ name: '备份压缩包', extensions: ['zip'] }]
      }
      const result = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      if (result.canceled || result.filePaths.length === 0) return { ok: false, canceled: true, message: '' }
      tmpDir = join(tmpdir(), `wt-restore-${Date.now()}`)
      mkdirSync(tmpDir, { recursive: true })
      // macOS 系统自带 unzip 解压（-o 覆盖 -q 静默），与 skills:importZip 一致
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/unzip', ['-o', '-q', result.filePaths[0], '-d', tmpDir], (err) =>
          err ? reject(err) : resolve()
        )
      })
      const dbFile = join(tmpDir, 'db.json')
      if (!existsSync(dbFile)) {
        return { ok: false, message: '所选压缩包不是本应用的备份包（缺少 db.json）' }
      }
      for (const name of ASSET_DIRS) {
        const src = join(tmpDir, name)
        if (existsSync(src)) cpSync(src, join(dataDir, name), { recursive: true })
      }
      let backupConfig: Record<string, unknown> = {}
      const cfgFile = join(tmpDir, 'config.json')
      if (existsSync(cfgFile)) {
        try {
          backupConfig = JSON.parse(readFileSync(cfgFile, 'utf-8')) as Record<string, unknown>
        } catch {
          backupConfig = {}
        }
      }
      // 配置按备份合并，并清除本机工作区指向与备份时间（恢复后回默认数据目录，避免指向已失效的本机路径）
      const merged = { ...readConfigData(), ...backupConfig }
      delete merged['workspaceDir']
      delete merged['workspaceLastBackup']
      writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8')
      // 指向已从配置清除，必须重算数据目录指针（否则本次会话仍指向恢复前的旧目录，图片全部失联）
      ensureDataDirs()
      const db = JSON.parse(readFileSync(dbFile, 'utf-8'))
      return { ok: true, db, config: merged, message: '恢复完成' }
    } catch (err) {
      return { ok: false, message: `恢复失败：${err instanceof Error ? err.message : String(err)}` }
    } finally {
      if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
    }
  })
}
