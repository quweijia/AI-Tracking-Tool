import {
  db,
  permanentlyDeleteWalkProjects,
  permanentlyDeleteWalkFolders,
  permanentlyDeleteWalkPages,
  permanentlyDeleteReports,
  type Issue,
  type Project,
  type WalkthroughPage
} from './index'
import {
  productDb,
  permanentlyDeleteProductProjects,
  permanentlyDeleteProductFolders,
  permanentlyDeleteProductSets
} from './product'

/**
 * 回收站保留期与磁盘治理（阶段 3）：
 * - 保留天数持久化在 electron 配置文件（config:get/set，与 productModeEnabled 同一存储），
 *   键 trashRetentionDays，可选字段；未设置 / 非法值回退默认 30 天，旧配置无需迁移
 * - expireAt 不落库：动态按 deletedAt + 当前配置天数计算，改配置对全部回收站项立即生效
 * - 扫描入口：应用启动 + 打开回收站，过期项按阶段 2 彻底删除规则静默清理（记录 + 磁盘文件）
 * - 孤儿文件回收跟随彻底清理流程：引用白名单含软删记录（回收站可还原的文件不算孤儿）
 */

/** 回收站保留天数默认值（config.trashRetentionDays 未设置时的回退值） */
export const DEFAULT_TRASH_RETENTION_DAYS = 30

/** 配置文件中的键（勿改，持久化依赖） */
const RETENTION_CONFIG_KEY = 'trashRetentionDays'

/** 读取保留天数配置：非法值（<1 / 非数字）一律回退默认值，不抛错 */
export async function readTrashRetentionDays(): Promise<number> {
  try {
    const cfg = await window.electronAPI.getConfig()
    const raw = cfg[RETENTION_CONFIG_KEY]
    if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 1) return Math.floor(raw)
  } catch (err) {
    console.warn('[TRASH] 读取保留天数配置失败，按默认值处理:', err)
  }
  return DEFAULT_TRASH_RETENTION_DAYS
}

/** 写入保留天数配置（设置页预留入口；与读取一致的合法性归一） */
export async function writeTrashRetentionDays(days: number): Promise<void> {
  const v = Number.isFinite(days) && days >= 1 ? Math.floor(days) : DEFAULT_TRASH_RETENTION_DAYS
  await window.electronAPI.setConfig(RETENTION_CONFIG_KEY, v)
}

/** 过期判定：deletedAt + 保留天数 ≤ 当前时间（deletedAt 缺失视为未删除，不清理） */
function isExpired(deletedAt: number | undefined | null, days: number, now: number): boolean {
  return typeof deletedAt === 'number' && deletedAt + days * 86400000 <= now
}

/** 扫描两库（walk + product）全部过期软删记录，按类型分组复用阶段 2 彻底删除函数。
 *  顺序：先子项（页面/标注集/报告/文件夹），后父项（项目级联兜底）；任一失败仅计数不中断 */
async function purgeExpiredRecords(days: number, now: number): Promise<{ ok: number; failed: number }> {
  const [projects, folders, pages, reports, pProjects, pFolders, pSets] = await Promise.all([
    db.projects.toArray(),
    db.folders.toArray(),
    db.pages.toArray(),
    db.reportRecords.toArray(),
    productDb.projects.toArray(),
    productDb.folders.toArray(),
    productDb.sets.toArray()
  ])
  const expiredProjectIds = projects.filter((p) => isExpired(p.deletedAt, days, now)).map((p) => p.id)
  const expiredFolderIds = folders.filter((f) => isExpired(f.deletedAt, days, now)).map((f) => f.id)
  const expiredPageIds = pages.filter((p) => isExpired(p.deletedAt, days, now)).map((p) => p.id)
  const expiredReportIds = reports.filter((r) => isExpired(r.deletedAt, days, now)).map((r) => r.id)
  const expiredPProjectIds = pProjects.filter((p) => isExpired(p.deletedAt, days, now)).map((p) => p.id)
  const expiredPFolderIds = pFolders.filter((f) => isExpired(f.deletedAt, days, now)).map((f) => f.id)
  const expiredPSetIds = pSets.filter((s) => isExpired(s.deletedAt, days, now)).map((s) => s.id)

  let ok = 0
  let failed = 0
  const merge = (r: { ok: number; failed: number }) => {
    ok += r.ok
    failed += r.failed
  }
  if (expiredPSetIds.length) merge(await permanentlyDeleteProductSets(expiredPSetIds))
  if (expiredPFolderIds.length) merge(await permanentlyDeleteProductFolders(expiredPFolderIds))
  if (expiredPProjectIds.length) merge(await permanentlyDeleteProductProjects(expiredPProjectIds))
  if (expiredReportIds.length) merge(await permanentlyDeleteReports(expiredReportIds))
  if (expiredPageIds.length) merge(await permanentlyDeleteWalkPages(expiredPageIds))
  if (expiredFolderIds.length) merge(await permanentlyDeleteWalkFolders(expiredFolderIds))
  if (expiredProjectIds.length) merge(await permanentlyDeleteWalkProjects(expiredProjectIds))
  return { ok, failed }
}

/** 收集「全部存活记录」的磁盘引用路径白名单（walk + product，含回收站软删记录）。
 *  范围仅限 images/ 与 attachments/ 命名空间（其他目录不在孤儿扫描范围） */
async function collectReferencedPaths(): Promise<string[]> {
  const [projects, pages, issues, pProjects, pAnnotations] = await Promise.all([
    db.projects.toArray(),
    db.pages.toArray(),
    db.issues.toArray(),
    productDb.projects.toArray(),
    productDb.annotations.toArray()
  ])
  const paths: string[] = [
    ...projects.flatMap((p: Project) => (p.logoPath ? [p.logoPath] : [])),
    ...pages.flatMap((p: WalkthroughPage) =>
      [p.designImagePath, p.screenshotPath, p.walkDesignPath, p.walkShotPath].filter(
        (v): v is string => !!v
      )
    ),
    ...issues.flatMap((i: Issue) => [
      ...(i.fixScreenshotPath ? [i.fixScreenshotPath] : []),
      ...(i.attachments ?? []).map((a) => a.relPath)
    ]),
    ...pProjects.flatMap((p) => (p.logoPath ? [p.logoPath] : [])),
    ...pAnnotations.flatMap((a) => (a.attachments ?? []).map((att) => att.relPath))
  ]
  return [
    ...new Set(
      paths.filter(
        (p): p is string => !!p && (p.startsWith('images/') || p.startsWith('attachments/'))
      )
    )
  ]
}

/** 孤儿文件回收：引用白名单（含软删）之外的 images/ 文件与无主 attachments/<pageId>/ 目录回收。
 *  彻底删除后校验/兜底残留文件；失败仅 [TRASH] 日志，不阻塞清理流程 */
async function purgeOrphanFiles(): Promise<void> {
  try {
    const [referenced, walkPageIds, productPageIds] = await Promise.all([
      collectReferencedPaths(),
      db.pages.toCollection().primaryKeys(),
      productDb.pages.toCollection().primaryKeys()
    ])
    const pageIds = [...walkPageIds, ...productPageIds].map(String)
    const purged = await window.electronAPI.purgeOrphanFiles(referenced, pageIds)
    if (purged > 0) console.log(`[TRASH] 孤儿文件回收: ${purged} 个（文件/目录）`)
  } catch (err) {
    console.warn('[TRASH] 孤儿文件回收失败（不影响记录清理）:', err)
  }
}

/** 清理流程并发锁：启动扫描与打开回收站可能同时触发，合并为同一在途任务，避免重复清理 */
let sweepInFlight: Promise<{ ok: number; failed: number }> | null = null

/**
 * 回收站过期清理扫描（应用启动 + 打开回收站两个入口）：
 * 1) 按当前配置保留天数找出全部过期软删记录，静默彻底删除（记录 + 磁盘文件）
 * 2) 随后跑一遍孤儿文件回收（把彻底删除残留、历史遗留的无引用文件一并回收）
 * 失败仅 [TRASH] 日志，界面无感知，不抛错。
 */
export function purgeExpiredTrash(): Promise<{ ok: number; failed: number }> {
  if (sweepInFlight) return sweepInFlight
  sweepInFlight = (async () => {
    try {
      const days = await readTrashRetentionDays()
      const res = await purgeExpiredRecords(days, Date.now())
      if (res.ok > 0) console.log(`[TRASH] 过期清理完成: 彻底删除 ${res.ok} 条（保留 ${days} 天）`)
      if (res.failed > 0) console.warn(`[TRASH] 过期清理失败 ${res.failed} 条，待下次扫描重试`)
      await purgeOrphanFiles()
      return res
    } catch (err) {
      console.warn('[TRASH] 过期清理扫描失败:', err)
      return { ok: 0, failed: 0 }
    } finally {
      sweepInFlight = null
    }
  })()
  return sweepInFlight
}
