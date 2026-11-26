import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, genId, recordVisit, touchPage, deleteIssuesCascade, CATEGORY_UNSET, Issue, IssueAttachment, Category, Severity, TargetImage, AnnotationShape, PLATFORM_LABELS, aiAnnotationsToIssues } from '../db'
import AnnotationCanvas, { NormalizedRect } from '../components/AnnotationCanvas'
import AutoWalkPanel from '../components/AutoWalkPanel'
import EditPageModal from '../components/EditPageModal'
import BindSpecModal from '../components/BindSpecModal'
import IssueEditorModal from '../components/IssueEditorModal'
import IssueDrawer from '../components/IssueDrawer'
import { confirmDialog } from '../components/ConfirmDialog'
import ReverifyModal from '../components/ReverifyModal'
import { PlatformBadge } from '../components/PlatformBadge'
import { useAiTasksStore } from '../stores/aiTasks'
import { loadProjectSpecTokens, formatSpecSummary } from '../spec/specCheck'
import { usePointerGlow } from '../hooks/usePointerGlow'
import heroBannerArtUrl from '../assets/hero-banner-bz.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-bz-dark.png'

type ViewMode = 'side-by-side' | 'onion' | 'slider' | 'blink'

/** 工作台模式：手动标注（双图对比）/ 自动走查（Figma 结构化比对） */
type WorkMode = 'manual' | 'auto'

/** 标注工具取值：hand 为抓手（平移浏览），不产生标注 */
type ToolValue = AnnotationShape | 'hand'

/** 标注历史操作（可逆）：add=新增 delete=删除 update=编辑/移动位置，用于撤销与重做 */
type HistoryOp =
  | { type: 'add'; issues: Issue[] }
  | { type: 'delete'; issues: Issue[] }
  | { type: 'update'; before: Issue; after: Issue }

/** SkillHub 技能（config.skills 存储结构） */
interface SkillItemLite {
  id: string
  name: string
  desc?: string
  url?: string
  /** Zip 包导入的指南文档内容 */
  guides?: string[]
}

/** 绑定规范 icon（规范网格 + 加号） */
function SpecIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <path d="M17 13.5v6M14 16.5h6" />
    </svg>
  )
}

/** 工具图标（线性风格，随文字颜色继承） */
export function ToolIcon({ name }: { name: ToolValue }) {
  const common = {
    width: 14,
    height: 14,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (name) {
    case 'hand':
      return (
        <svg {...common}>
          <path d="M18 11V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2" />
          <path d="M14 10V4a2 2 0 0 0-2-2a2 2 0 0 0-2 2v2" />
          <path d="M10 10.5V6a2 2 0 0 0-2-2a2 2 0 0 0-2 2v8" />
          <path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.86-5.99-2.34l-3.6-3.6a2 2 0 0 1 2.83-2.82L7 15" />
        </svg>
      )
    case 'point':
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
        </svg>
      )
    case 'arrow':
      return (
        <svg {...common}>
          <path d="M5 19 19 5" />
          <path d="M13 5h6v6" />
        </svg>
      )
    case 'rect':
      return (
        <svg {...common}>
          <rect x="4" y="6" width="16" height="12" rx="1.5" strokeDasharray="4 3" />
        </svg>
      )
    case 'text':
      return (
        <svg {...common}>
          <path d="M5 6V4h14v2" />
          <path d="M12 4v16" />
          <path d="M9 20h6" />
        </svg>
      )
    case 'measure':
      return (
        <svg {...common}>
          <path d="M3 9.5 9.5 3l11 11L14 20.5z" />
          <path d="M7.2 8.3l1.7 1.7M10 5.5l1.7 1.7M11.5 12.6l1.7 1.7M14.3 9.8l1.7 1.7" />
        </svg>
      )
    case 'picker':
      return (
        <svg {...common}>
          <path d="m2 22 1-1h3l9-9" />
          <path d="M3 21v-3l9-9" />
          <path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z" />
        </svg>
      )
  }
}

/** 顶部按钮 / 标题编辑 icon（线性风格，随文字颜色继承） */
function SparklesIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3.5l1.9 5 5 1.9-5 1.9-1.9 5-1.9-5-5-1.9 5-1.9z" />
      <path d="M18.8 15.2l.8 2.1 2.1.8-2.1.8-.8 2.1-.8-2.1-2.1-.8 2.1-.8z" />
    </svg>
  )
}

function ListIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M8 6h13M8 12h13M8 18h13" />
      <path d="M3.5 6h.01M3.5 12h.01M3.5 18h.01" />
    </svg>
  )
}

export function ExportIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v11" />
      <path d="m7.5 9.5 4.5 4.5 4.5-4.5" />
      <path d="M4 20h16" />
    </svg>
  )
}

function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.83 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z" />
    </svg>
  )
}

function LinkIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7" />
      <path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7" />
    </svg>
  )
}

/** 该标注是否带坐标信息、需要渲染到图上（列表手加的问题无坐标不渲染） */
const renderOnCanvas = (i: Issue) =>
  i.shape === 'point' ||
  i.shape === 'text' ||
  i.shape === 'measure' ||
  i.shape === 'picker' ||
  i.width !== 0 ||
  i.height !== 0

/** rgb → #RRGGBB */
const rgbToHex = (r: number, g: number, b: number) =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`.toUpperCase()

/** 从配置中取 Figma PAT（与 AutoWalkPanel 同源逻辑：优先已启用 MCP 服务，回退旧版 figmaMcp 字段） */
function patFromConfig(cfg: Record<string, unknown>): string {
  const mcps = (cfg.mcps as { pat?: string; enabled?: boolean }[] | undefined) ?? []
  const withPat = mcps.find((m) => m.enabled !== false && m.pat && m.pat.trim())
  if (withPat) return withPat.pat!.trim()
  const legacy = cfg.figmaMcp as { pat?: string } | undefined
  return legacy?.pat?.trim() ?? ''
}

export default function CompareWorkbench() {
  const { t } = useTranslation('compareWorkbench')
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const page = useLiveQuery(() => db.pages.get(pageId!), [pageId])
  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  /** 页面所在文件夹：横幅「返回上一级」用——页面挂在文件夹内时返回该文件夹视图，否则返回项目详情根 */
  const parentFolder = useLiveQuery(
    () => (page?.folderId ? db.folders.get(page.folderId) : undefined),
    [page?.folderId]
  )
  /** 横幅返回链接目标与文案（文件夹已删除时兜底回项目根） */
  const backTarget = parentFolder ? `/project/${projectId}?f=${parentFolder.id}` : `/project/${projectId}`
  const backLabel = parentFolder?.name ?? project?.name ?? t('backToProject')
  const issues = useLiveQuery(() => db.issues.where('pageId').equals(pageId!).toArray(), [pageId])

  const [designUrl, setDesignUrl] = useState('')
  const [shotUrl, setShotUrl] = useState('')
  const [mode, setMode] = useState<ViewMode>('side-by-side')
  /** 工作台模式：手动标注 / 自动走查（双模式共存，切换保留各自状态）；外部跳转可经 location.state 直接进入审核（自动走查）视图 */
  const [workMode, setWorkMode] = useState<WorkMode>(() => {
    if ((location.state as { mode?: WorkMode } | null)?.mode === 'auto') return 'auto'
    // 打开设置等跳转会卸载本组件，按页面记忆上次的工作模式，返回本页时恢复（默认手动标注）
    return sessionStorage.getItem(`work-mode:${projectId}/${pageId}`) === 'auto' ? 'auto' : 'manual'
  })
  /** 自动走查设置（Figma 连接 / 开发 URL）卡片是否展开，折叠按钮在工作模式切换左侧 */
  const [walkControlsOpen, setWalkControlsOpen] = useState(true)
  /** 页面内全屏标注：仅切换本页布局（隐藏横幅/工具栏 + body class 折叠侧边栏），不调用 Electron 系统全屏。
   *  状态按页面记入 sessionStorage：跳转「导出报告」后返回本页仍恢复全屏；退出全屏或点返回项目即清除。 */
  const [isAnnotateFullscreen, setIsAnnotateFullscreen] = useState<boolean>(() =>
    sessionStorage.getItem(`annotate-fullscreen:${projectId}/${pageId}`) === '1'
  )
  const [zoom, setZoom] = useState(1)
  const [syncScroll, setSyncScroll] = useState(true)
  /** 取色是否同步双图：开启时一次点击在设计稿与开发截图同一坐标各生成一条吸色标注 */
  const [pickerSync, setPickerSync] = useState(true)
  /** 吸色同步取样：正在悬停一侧的上报采样点（归一化 + 来源画布），对侧画布据此镜像放大镜 */
  const [pickerPixel, setPickerPixel] = useState<{ nx: number; ny: number; from: TargetImage } | null>(null)
  const [sliderPos, setSliderPos] = useState(50)
  /** 滑块模式：是否显示分界线（隐藏后画布分界线与调整滑杆都收起） */
  const [showDivider, setShowDivider] = useState(true)
  /** 当前标注工具，默认抓手（浏览/平移），选择标注工具后可直接绘制 */
  const [tool, setTool] = useState<ToolValue>('hand')
  /** 吸色工具 + 同步取样开启时才镜像放大镜；关闭（切工具/关同步）时清掉残留采样点 */
  const pickerSyncActive = pickerSync && tool === 'picker'
  useEffect(() => {
    if (!pickerSyncActive) setPickerPixel(null)
  }, [pickerSyncActive])
  /** 问题清单抽屉 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 问题清单点击卡片 → 画布上对应标注闪烁定位（约 2.2s 后自动清除）
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  /** 聚焦查看的问题：双图放大 2x 并滚动居中到该点位，其余标注隐藏（再点一次取消） */
  const [focusIssue, setFocusIssue] = useState<Issue | null>(null)
  // 聚焦问题被删除后（问题清单删除/编辑弹窗删除/批量清除）自动退出聚焦，避免画板残留聚焦态与顶栏聚焦条
  useEffect(() => {
    if (focusIssue && !(issues ?? []).some((i) => i.id === focusIssue.id)) setFocusIssue(null)
  }, [issues, focusIssue, setFocusIssue])
  /** 编辑页面信息弹窗 */
  const [editPageOpen, setEditPageOpen] = useState(false)
  /** 绑定规范弹窗（仅绑定规范，按当前页面端类型显示分类；项目编辑在项目详情页进行） */
  const [bindSpecOpen, setBindSpecOpen] = useState(false)
  /** 设计规范菜单开关（设置页「通用」控制，关闭后横幅不显示「绑定规范」按钮；默认开启） */
  const [specMenuOn, setSpecMenuOn] = useState(true)
  /** 编辑中的已有问题 / 新建草稿（null = 弹窗关闭） */
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null)

  /** 标注撤销/重做历史栈（手动标注的新增/删除/编辑共用，切页清空） */
  const [undoStack, setUndoStack] = useState<HistoryOp[]>([])
  const [redoStack, setRedoStack] = useState<HistoryOp[]>([])

  // 设计规范菜单开关联动：初次读取 config，设置页切换后经 spec-menu-change 事件即时同步（与侧边栏同一机制）
  useEffect(() => {
    const refresh = () => {
      void window.electronAPI.getConfig().then((cfg) => setSpecMenuOn(cfg.specMenuEnabled !== false))
    }
    refresh()
    window.addEventListener('spec-menu-change', refresh)
    return () => window.removeEventListener('spec-menu-change', refresh)
  }, [])

  /** 在标注图上高亮闪烁指定标注（重复点击重置计时），并进入/退出聚焦查看 */
  const handleFlash = (issue: Issue) => {
    setFlashId(issue.id)
    if (flashTimer.current) window.clearTimeout(flashTimer.current)
    flashTimer.current = window.setTimeout(() => setFlashId(null), 2300)
    setFocusIssue((prev) => (prev?.id === issue.id ? null : issue))
  }

  // AI 识别后台任务：切页后返回时恢复结果提示；按钮不被进行中的任务禁用，可并行发起多个
  const aiTasks = useAiTasksStore((s) => s.tasks)
  const aiRunningCount = aiTasks.filter((t) => t.pageId === pageId && t.status === 'running').length
  // 豆包下载按钮同款光晕交互：指针跟随光斑 + 空闲自动巡游
  const aiBtnGlowRef = usePointerGlow<HTMLButtonElement>()
  useEffect(() => {
    if (!pageId) return
    const finished = aiTasks.filter(
      (t) => t.pageId === pageId && (t.status === 'done' || t.status === 'failed' || t.status === 'interrupted')
    )
    if (finished.length === 0) return
    const done = finished.filter((t) => t.status === 'done')
    const failed = finished.filter((t) => t.status === 'failed')
    const interrupted = finished.filter((t) => t.status === 'interrupted')
    let ok = true
    let text: string
    if (finished.length === 1) {
      text = finished[0].message
      ok = finished[0].status === 'done'
    } else {
      const parts: string[] = []
      if (done.length) parts.push(t('aiTasksDone', { n: done.length }))
      if (failed.length) parts.push(t('aiTasksFailed', { n: failed.length }))
      if (interrupted.length) parts.push(t('aiTasksInterrupted', { n: interrupted.length }))
      text = t('aiTasksSummary', { parts: parts.join(t('enumSep')) })
      ok = done.length > 0
    }
    setAiMsg({ ok, text })
    finished.forEach((t) => useAiTasksStore.getState().clear(t.id))
  }, [aiTasks, pageId])
  const [creating, setCreating] = useState<{
    rect: NormalizedRect
    targetImage: 'design' | 'screenshot'
    shape: AnnotationShape
  } | null>(null)
  /** 复验弹窗 */
  const [reverifyIssue, setReverifyIssue] = useState<Issue | null>(null)
  const [oldScreenshotUrl, setOldScreenshotUrl] = useState<string | null>(null)

  // ===== AI 识别 =====
  /** 默认 AI 模型（未配置为 null） */
  const [aiModel, setAiModel] = useState<{ id: string; name: string } | null>(null)
  const [aiMsg, setAiMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [skills, setSkills] = useState<SkillItemLite[]>([])
  /** AI 识别前的技能选择弹窗（可多选） */
  const [skillPickOpen, setSkillPickOpen] = useState(false)
  const [pickedSkillIds, setPickedSkillIds] = useState<string[]>([])
  /** 已有识别进行中再次点击按钮的确认弹窗（继续 / 中断 / 重新开始） */
  const [runningConfirmOpen, setRunningConfirmOpen] = useState(false)

  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const models = (cfg.aiModels as { id: string; name: string }[] | undefined) ?? []
      const defId = (cfg.aiDefaultModelId as string | undefined) ?? models[0]?.id ?? ''
      setAiModel(models.find((m) => m.id === defId) ?? models[0] ?? null)
      // SkillHub 技能列表：AI 识别时弹窗多选作为走查指引
      setSkills((cfg.skills as SkillItemLite[] | undefined) ?? [])
    })
  }, [])

  // 记录一次页面访问（30 分钟去重），供「最近访问」页统计
  useEffect(() => {
    if (pageId && projectId) recordVisit(pageId, projectId)
  }, [pageId, projectId])

  const designRef = useRef<HTMLDivElement>(null)
  const shotRef = useRef<HTMLDivElement>(null)
  const overlayCanvasRef = useRef<HTMLDivElement>(null)
  /** 叠加模式滚动容器（抓手/空格平移用） */
  const overlayPanelRef = useRef<HTMLDivElement>(null)

  // 聚焦查看（手动模式）：放大 2x，双图 / 叠加画布滚动居中到问题点位
  // 依赖不含 zoom：聚焦期间点画板放大/缩小应正常生效，不能因 zoom 变化重跑把画布拉回 2x
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (workMode !== 'manual' || !focusIssue) return
    setZoom(2)
    const raf = window.requestAnimationFrame(() => {
      for (const el of [designRef.current, shotRef.current, overlayPanelRef.current]) {
        if (!el) continue
        const img = el.querySelector('img')
        if (!img) continue
        const r = img.getBoundingClientRect()
        if (!r.width || !r.height) continue
        el.scrollLeft = (focusIssue.x + focusIssue.width / 2) * r.width - el.clientWidth / 2
        el.scrollTop = (focusIssue.y + focusIssue.height / 2) * r.height - el.clientHeight / 2
      }
    })
    return () => window.cancelAnimationFrame(raf)
  }, [focusIssue, workMode])

  useEffect(() => {
    if (page?.designImagePath) {
      window.electronAPI.readImage(page.designImagePath).then((url) => setDesignUrl(url ?? ''))
    }
    if (page?.screenshotPath) {
      window.electronAPI.readImage(page.screenshotPath).then((url) => setShotUrl(url ?? ''))
    }
  }, [page])

  // ===== 重新上传设计稿 / 开发截图（替换文件并清理旧图） =====
  const handleReupload = async (target: 'design' | 'screenshot') => {
    if (!pageId) return
    const result = await window.electronAPI.selectImage()
    if (!result) return
    const oldPath = target === 'design' ? page?.designImagePath : page?.screenshotPath
    if (oldPath && oldPath !== result.relativePath) {
      await window.electronAPI.deleteImage(oldPath).catch(() => undefined)
    }
    await db.pages.update(
      pageId,
      target === 'design'
        ? { designImagePath: result.relativePath, updatedAt: Date.now() }
        : { screenshotPath: result.relativePath, updatedAt: Date.now() }
    )
  }

  // 设计稿重新上传弹窗：二选一（本地文件 / Figma 读取），error 展示在弹窗内
  const [reupDesignOpen, setReupDesignOpen] = useState(false)
  const [reupDesignBusy, setReupDesignBusy] = useState(false)
  const [reupDesignErr, setReupDesignErr] = useState('')

  /** 直接读取 Figma 设计稿：按页面绑定的 Figma 链接拉取画板截图，落盘替换当前设计稿 */
  const handleFigmaReupload = async () => {
    if (!pageId || reupDesignBusy) return
    const figUrl = (page?.figmaUrl ?? '').trim()
    if (!figUrl) {
      setReupDesignErr(t('reupDesignNoFigmaUrl'))
      return
    }
    setReupDesignBusy(true)
    setReupDesignErr('')
    try {
      const cfg = await window.electronAPI.getConfig()
      const pat = patFromConfig(cfg)
      if (!pat) {
        setReupDesignErr(t('reupDesignNoPat'))
        return
      }
      const fig = await window.electronAPI.figmaFetchDesign({ pat, figmaUrl: figUrl })
      if (!fig.ok || !fig.data?.screenshotDataUrl) {
        setReupDesignErr(fig.message || t('reupDesignFigmaFail'))
        return
      }
      const buf = await (await fetch(fig.data.screenshotDataUrl)).arrayBuffer()
      const relPath = await window.electronAPI.saveImage(buf, 'png')
      const oldPath = page?.designImagePath
      if (oldPath && oldPath !== relPath) {
        await window.electronAPI.deleteImage(oldPath).catch(() => undefined)
      }
      await db.pages.update(pageId, { designImagePath: relPath, updatedAt: Date.now() })
      setReupDesignOpen(false)
    } catch (e) {
      setReupDesignErr(e instanceof Error ? e.message : String(e))
    } finally {
      setReupDesignBusy(false)
    }
  }

  // 后台任务悬浮入口跳转：?view=auto|manual 显式指定进入的工作模式（同页面内切换模式不会卸载
  // 组件，必须靠 query 通知，否则会停留在上次记忆的模式）；消费后立即从 URL 移除，
  // 保证用户手动切换模式后再次跳转仍能触发
  const viewParam = searchParams.get('view')
  useEffect(() => {
    if (viewParam !== 'auto' && viewParam !== 'manual') return
    setWorkMode(viewParam)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('view')
        return next
      },
      { replace: true }
    )
  }, [viewParam, setSearchParams])

  // 从问题清单「定位」跳转：?issue=<id>，打开对应编辑弹窗
  const focusIssueId = searchParams.get('issue')
  useEffect(() => {
    if (!focusIssueId || !issues) return
    const target = issues.find((i) => i.id === focusIssueId)
    if (target) {
      setEditingIssue(target)
      setSearchParams({}, { replace: true })
    }
  }, [focusIssueId, issues, setSearchParams])

  // ===== 空格键按住 → 画布平移模式（仅并排、非标注时）=====
  const [spaceHeld, setSpaceHeld] = useState(false)
  useEffect(() => {
    const isTypingTarget = (t: EventTarget | null) => {
      const el = t as HTMLElement | null
      return !!el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
    }
    const down = (e: KeyboardEvent) => {
      if (e.code !== 'Space') return
      if (isTypingTarget(e.target)) return
      // 按住不放时浏览器会持续派发 repeat keydown 并触发页面滚动默认行为，必须一并阻止
      e.preventDefault()
      if (e.repeat) return
      setSpaceHeld(true)
    }
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false)
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
      setSpaceHeld(false)
    }
  }, [])

  // ===== 页面内全屏标注（仅本页布局切换，禁止调用 Electron 系统全屏 API） =====
  const toggleAnnotateFullscreen = () =>
    setIsAnnotateFullscreen((v) => {
      console.log(`[FULLSCREEN_ANNOTATE] ${!v ? 'enter' : 'exit'}`)
      return !v
    })

  // 全屏期间给 body 挂 class 折叠左侧侧边栏（纯 CSS 显隐，不改持久化折叠态），退出/离开页面自动还原
  useEffect(() => {
    if (!isAnnotateFullscreen) return
    document.body.classList.add('annotate-fullscreen')
    return () => document.body.classList.remove('annotate-fullscreen')
  }, [isAnnotateFullscreen])

  // 全屏状态同步到 sessionStorage（按页面隔离）：导出报告跳转后返回本页时经 state 初始化恢复全屏；
  // 退出全屏即清除记录；全屏状态下经非返回项目入口离开页面则保留记录，回到本页仍恢复
  useEffect(() => {
    const key = `annotate-fullscreen:${projectId}/${pageId}`
    if (isAnnotateFullscreen) sessionStorage.setItem(key, '1')
    else sessionStorage.removeItem(key)
  }, [isAnnotateFullscreen, projectId, pageId])

  // 工作模式同步到 sessionStorage（按页面隔离）：打开设置等跳转离开后返回本页，恢复上次的工作模式（自动走查/手动标注）
  useEffect(() => {
    sessionStorage.setItem(`work-mode:${projectId}/${pageId}`, workMode)
  }, [workMode, projectId, pageId])

  // 全屏态 ESC 退出（输入类元素聚焦时让位，不劫持画布快捷键与弹窗内的 ESC）
  useEffect(() => {
    if (!isAnnotateFullscreen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      console.log('[FULLSCREEN_ANNOTATE] exit via ESC')
      setIsAnnotateFullscreen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [isAnnotateFullscreen])

  // 聚焦查看 ESC 退出（清单卡片点击聚焦后）：全屏态让位（先退全屏再退聚焦），输入类元素
  // 聚焦与任一弹窗打开时不劫持（.modal-mask 兜底覆盖 confirmDialog 等动态弹窗）
  useEffect(() => {
    if (!focusIssue) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el && ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) return
      if (
        isAnnotateFullscreen ||
        editingIssue ||
        creating ||
        reverifyIssue ||
        editPageOpen ||
        bindSpecOpen ||
        reupDesignOpen ||
        skillPickOpen ||
        runningConfirmOpen ||
        document.querySelector('.modal-mask')
      )
        return
      setFocusIssue(null)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [
    focusIssue,
    isAnnotateFullscreen,
    editingIssue,
    creating,
    reverifyIssue,
    editPageOpen,
    bindSpecOpen,
    reupDesignOpen,
    skillPickOpen,
    runningConfirmOpen
  ])

  // 布局切换后画布容器尺寸变化：派发 resize 兜底触发依赖窗口尺寸的逻辑重算，并打印容器实测尺寸便于排查坐标偏移
  useEffect(() => {
    const timer = window.setTimeout(() => {
      window.dispatchEvent(new Event('resize'))
      const rect = document.querySelector('.compare-body')?.getBoundingClientRect()
      console.log(
        `[FULLSCREEN_ANNOTATE] mode=${isAnnotateFullscreen ? 'fullscreen' : 'normal'} canvas=${Math.round(rect?.width ?? 0)}x${Math.round(rect?.height ?? 0)}`
      )
    }, 220)
    return () => window.clearTimeout(timer)
  }, [isAnnotateFullscreen])

  const handleScroll = (source: 'design' | 'shot') => {
    if (!syncScroll || mode !== 'side-by-side') return
    const from = source === 'design' ? designRef.current : shotRef.current
    const to = source === 'design' ? shotRef.current : designRef.current
    if (from && to) {
      to.scrollTop = from.scrollTop
      to.scrollLeft = from.scrollLeft
    }
  }

  // 按住空格或使用抓手工具时拖拽：把鼠标位移转成 scroll 位移（并排双图 / 叠加面板通用）
  const handlePanStart = (e: React.MouseEvent, source: 'design' | 'shot' | 'overlay') => {
    if (!spaceHeld && tool !== 'hand') return
    const el =
      source === 'design' ? designRef.current : source === 'shot' ? shotRef.current : overlayPanelRef.current
    if (!el) return
    e.preventDefault()
    const start = { x: e.clientX, y: e.clientY, scrollLeft: el.scrollLeft, scrollTop: el.scrollTop }
    const move = (ev: MouseEvent) => {
      el.scrollLeft = start.scrollLeft - (ev.clientX - start.x)
      el.scrollTop = start.scrollTop - (ev.clientY - start.y)
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // ===== 滑块模式：直接拖动分割线（阻止冒泡，不触发画布平移） =====
  const startSliderDrag = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const canvas = overlayCanvasRef.current
    if (!canvas) return
    const move = (ev: MouseEvent) => {
      const rect = canvas.getBoundingClientRect()
      const pct = ((ev.clientX - rect.left) / rect.width) * 100
      setSliderPos(Math.min(100, Math.max(0, pct)))
    }
    const up = () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }

  // 统一编号：按当前工作模式的清单口径（手动=手动标注组，自动=走查组）按创建时间排序，与问题清单一致
  const issueNos = useMemo(() => {
    const m = new Map<string, number>()
    ;[...(issues ?? [])]
      .filter((i) => (workMode === 'auto' ? i.imgSet === 'walk' : i.imgSet !== 'walk'))
      .sort((a, b) => a.createdAt - b.createdAt)
      .forEach((i, idx) => m.set(i.id, idx + 1))
    return m
  }, [issues, workMode])

  // 手动工作台只展示手动标注（imgSet!=='walk'），自动走查结果隔离在「自动走查」tab
  const isManual = (i: Issue) => i.imgSet !== 'walk'
  const designIssues = (issues ?? []).filter((i) => isManual(i) && i.targetImage === 'design' && renderOnCanvas(i))
  const shotIssues = (issues ?? []).filter((i) => isManual(i) && i.targetImage === 'screenshot' && renderOnCanvas(i))

  // ===== 标注撤销 / 重做：基于可逆操作栈（新增/删除/编辑/移动），Cmd+Z 撤销、Cmd+Shift+Z 重做 =====
  /** 记录一步标注操作（入撤销栈并清空重做栈，上限 50 步） */
  const pushHistory = (op: HistoryOp) => {
    setUndoStack((s) => [...s.slice(-49), op])
    setRedoStack([])
  }

  /** 正/反向应用一步操作：add 正向=按原 id 恢复、反向=删除；delete 相反；update 按 before/after 整条还原 */
  const applyHistoryOp = async (op: HistoryOp, dir: 'undo' | 'redo') => {
    const forward = (op.type === 'add' && dir === 'redo') || (op.type === 'delete' && dir === 'undo')
    if (op.type === 'add' || op.type === 'delete') {
      if (forward) await db.issues.bulkPut(op.issues)
      else await db.issues.bulkDelete(op.issues.map((i) => i.id))
    } else {
      await db.issues.put(dir === 'undo' ? op.before : op.after)
    }
    if (pageId) void touchPage(pageId)
  }

  const undo = async () => {
    const op = undoStack[undoStack.length - 1]
    if (!op) return
    setUndoStack((s) => s.slice(0, -1))
    setRedoStack((r) => [...r, op])
    await applyHistoryOp(op, 'undo')
  }

  const redo = async () => {
    const op = redoStack[redoStack.length - 1]
    if (!op) return
    setRedoStack((s) => s.slice(0, -1))
    setUndoStack((s) => [...s, op])
    await applyHistoryOp(op, 'redo')
  }

  // 切换页面时清空历史（历史操作属于当前页标注）
  useEffect(() => {
    setUndoStack([])
    setRedoStack([])
  }, [pageId])

  // 快捷键：Mac Cmd+Z 撤销 / Cmd+Shift+Z 重做（Windows Ctrl 同理；输入框内交给原生撤销；自动走查模式由 AutoWalkPanel 自己处理）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (workMode !== 'manual') return
      if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 'z') return
      const el = e.target as HTMLElement | null
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return
      e.preventDefault()
      if (e.shiftKey) void redo()
      else void undo()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const handleCreate = async (fields: {
    description: string
    severity: Issue['severity']
    category: Issue['category']
    status: Issue['status']
    targetImage: Issue['targetImage']
    color?: string
    attachments?: IssueAttachment[]
  }) => {
    if (!creating || !pageId) return
    const issue: Issue = {
      id: genId(),
      pageId,
      targetImage: creating.targetImage,
      x: creating.rect.x,
      y: creating.rect.y,
      width: creating.rect.width,
      height: creating.rect.height,
      shape: creating.shape,
      description: fields.description,
      severity: fields.severity,
      category: fields.category,
      status: 'pending',
      color: fields.color,
      attachments: fields.attachments,
      createdAt: Date.now()
    }
    await db.issues.add(issue)
    pushHistory({ type: 'add', issues: [issue] })
    void touchPage(pageId)
    setCreating(null)
  }

  const handleUpdate = async (fields: {
    description: string
    severity: Issue['severity']
    category: Issue['category']
    status: Issue['status']
    targetImage: Issue['targetImage']
    color?: string
    measureValue?: string
    attachments?: IssueAttachment[]
  }) => {
    if (!editingIssue) return
    // 候选编辑保存即转正式；备选问题转正式时同时置 optionalChecked 生成画布标注（单条采纳为唯一确认入口）
    const confirmed = editingIssue.isAISuggested && !editingIssue.aiConfirmed
      ? { aiConfirmed: true, ...(editingIssue.level === 'optional' ? { optionalChecked: true } : {}) }
      : {}
    const after: Issue = { ...editingIssue, ...fields, ...confirmed }
    await db.issues.update(editingIssue.id, { ...fields, ...confirmed })
    pushHistory({ type: 'update', before: editingIssue, after })
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  // ===== 快速创建（不弹窗）：测量距离 / 吸色取样 =====
  // 吸色整图像素缓存：url → { 尺寸, ImageData 数组 }（一次性读取，取色只查数组）
  const sampleCacheRef = useRef<Map<string, { w: number; h: number; data: Uint8ClampedArray }>>(new Map())
  useEffect(() => {
    ;[designUrl, shotUrl].forEach((url) => {
      if (!url || sampleCacheRef.current.has(url)) return
      const img = new Image()
      img.src = url
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return
        try {
          ctx.drawImage(img, 0, 0)
          sampleCacheRef.current.set(url, {
            w: canvas.width,
            h: canvas.height,
            data: ctx.getImageData(0, 0, canvas.width, canvas.height).data
          })
        } catch {
          /* 跨域图片取不到像素时跳过 */
        }
      }
    })
  }, [designUrl, shotUrl])

  /** 在指定图片上取归一化坐标处的像素色（hex），缓存未就绪返回 null */
  const sampleColorAt = (url: string, nx: number, ny: number): string | null => {
    const entry = sampleCacheRef.current.get(url)
    if (!entry || !entry.w || !entry.h) return null
    const px = Math.min(entry.w - 1, Math.max(0, Math.round(nx * entry.w)))
    const py = Math.min(entry.h - 1, Math.max(0, Math.round(ny * entry.h)))
    const o = (py * entry.w + px) * 4
    return rgbToHex(entry.data[o], entry.data[o + 1], entry.data[o + 2])
  }

  const handleQuickCreate = async (
    rect: { x: number; y: number; width: number; height: number },
    target: 'design' | 'screenshot',
    data: { measurePx?: number; colorHex?: string }
  ) => {
    if (!pageId) return
    let issue: Issue
    if (data.measurePx !== undefined) {
      issue = {
        id: genId(),
        pageId,
        targetImage: target,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        shape: 'measure',
        description: `尺寸标注 ${Math.round(data.measurePx)}px`,
        severity: 'suggestion',
        category: 'spacing',
        status: 'pending',
        measureValue: `${Math.round(data.measurePx)}px`,
        createdAt: Date.now()
      }
    } else {
      // 吸色：默认同步取设计稿与开发截图同一坐标的颜色（双图各生成一条）；工具栏可关闭同步，只取当前点击的一侧
      const ownHex = data.colorHex ?? sampleColorAt(target === 'design' ? designUrl : shotUrl, rect.x, rect.y)
      const otherHex = pickerSync ? sampleColorAt(target === 'design' ? shotUrl : designUrl, rect.x, rect.y) : ''
      const now = Date.now()
      const rows: Issue[] = []
      if (ownHex) {
        rows.push({
          id: genId(),
          pageId,
          targetImage: target,
          x: rect.x,
          y: rect.y,
          width: 0,
          height: 0,
          shape: 'picker',
          description: ownHex,
          severity: 'suggestion',
          category: 'color',
          status: 'pending',
          ...(target === 'design' ? { sampleA: ownHex } : { sampleB: ownHex }),
          createdAt: now
        })
      }
      if (otherHex) {
        const otherTarget: TargetImage = target === 'design' ? 'screenshot' : 'design'
        rows.push({
          id: genId(),
          pageId,
          targetImage: otherTarget,
          x: rect.x,
          y: rect.y,
          width: 0,
          height: 0,
          shape: 'picker',
          description: otherHex,
          severity: 'suggestion',
          category: 'color',
          status: 'pending',
          ...(otherTarget === 'design' ? { sampleA: otherHex } : { sampleB: otherHex }),
          createdAt: now + 1
        })
      }
      if (rows.length) {
        await db.issues.bulkAdd(rows)
        pushHistory({ type: 'add', issues: rows })
        void touchPage(pageId)
      }
      return
    }
    await db.issues.add(issue)
    pushHistory({ type: 'add', issues: [issue] })
    void touchPage(pageId)
  }

  /** 拖拽移动标注后提交新位置 */
  const handleMove = async (issue: Issue, rect: NormalizedRect) => {
    await db.issues.update(issue.id, {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    })
    pushHistory({
      type: 'update',
      before: issue,
      after: { ...issue, x: rect.x, y: rect.y, width: rect.width, height: rect.height }
    })
    void touchPage(issue.pageId)
  }

  const handleDelete = async () => {
    if (!editingIssue) return
    pushHistory({ type: 'delete', issues: [editingIssue] })
    await deleteIssuesCascade([editingIssue])
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  // 抽屉：快速添加问题
  const handleQuickAdd = (fields: { description: string; severity: Severity; category: Category; targetImage: TargetImage }) => {
    if (!pageId) return
    void db.issues.add({
      id: genId(),
      pageId,
      targetImage: fields.targetImage,
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      description: fields.description,
      severity: fields.severity,
      category: fields.category,
      status: 'pending',
      createdAt: Date.now()
    })
    void touchPage(pageId)
  }

  // 抽屉：复验
  const openReverify = async (issue: Issue) => {
    setReverifyIssue(issue)
    setOldScreenshotUrl(null)
    const p = await db.pages.get(pageId!)
    if (p?.screenshotPath) {
      const url = await window.electronAPI.readImage(p.screenshotPath)
      setOldScreenshotUrl(url)
    }
  }

  // ===== AI 自动识别走查问题（skillIds：弹窗多选的技能）；可并行发起多个任务 =====

  /** 中断当前页面所有进行中的识别任务（等待中的识别结果将被丢弃） */
  const interruptPageTasks = () => {
    useAiTasksStore
      .getState()
      .tasks.filter((t) => t.pageId === pageId && t.status === 'running')
      .forEach((t) => useAiTasksStore.getState().interrupt(t.id))
  }

  const runAIAnnotate = async (skillIds: string[] = []) => {
    if (!pageId || !aiModel) return
    // 分模式取图：手动标注识别手动上传双图；自动走查识别自动采集的走查双图
    const auto = workMode === 'auto'
    let designDataUrl = designUrl
    let shotDataUrl = shotUrl
    if (auto) {
      if (!page?.walkDesignPath || !page.walkShotPath) {
        setAiMsg({ ok: false, text: t('aiNoWalkImages') })
        return
      }
      const [d, s] = await Promise.all([
        window.electronAPI.readImage(page.walkDesignPath),
        window.electronAPI.readImage(page.walkShotPath)
      ])
      if (!d || !s) {
        setAiMsg({ ok: false, text: t('aiWalkImagesReadFailed') })
        return
      }
      designDataUrl = d
      shotDataUrl = s
    } else if (!designUrl || !shotUrl) {
      return
    }
    // 手动 AI 识别只覆盖手动候选；自动走查模式只覆盖走查内的 AI 候选
    const candidates = (issues ?? []).filter(
      (i) => i.isAISuggested && !i.aiConfirmed && (auto ? i.imgSet === 'walk' : i.imgSet !== 'walk')
    )
    if (
      candidates.length > 0 &&
      !(await confirmDialog({ message: t('aiOverwriteConfirm', { n: candidates.length }), tone: 'danger' }))
    ) {
      return
    }
    // 注册后台任务：切换页面不影响识别，返回页面时从这里恢复状态；同页可再次点击并行发起
    const taskId = useAiTasksStore.getState().start(pageId!, projectId!, page?.pageName ?? '', workMode)
    setAiMsg(null)
    try {
      // 多选技能说明作为走查指引注入请求（Zip 导入的指南文档一并注入，超长截断）
      const skillGuides = skills
        .filter((s) => skillIds.includes(s.id))
        .map((s) => {
          const base = `${s.name}${s.desc ? `：${s.desc}` : ''}${s.url ? `（参考：${s.url}）` : ''}`
          const guides = (s.guides ?? []).map((g) => g.slice(0, 2000)).join('\n\n')
          return guides ? `${base}\n技能指南：\n${guides}` : base
        })
      const res = await window.electronAPI.aiAnnotate({
        modelId: aiModel.id,
        pageName: page?.pageName ?? '',
        platformLabel: page ? PLATFORM_LABELS[page.platform] : '',
        designDataUrl,
        shotDataUrl,
        skillGuides: skillGuides.length ? skillGuides : undefined,
        // 绑定规范 Token 摘要注入识别请求，让 AI 按规范值校验颜色/字号/间距等
        walkOptions: {
          specSummary: page
            ? await loadProjectSpecTokens(page.projectId, page.platform)
                .then((toks) => (toks.length ? formatSpecSummary(toks) : undefined))
                .catch(() => undefined)
            : undefined
        }
      })
      // 任务被用户中断：丢弃结果，不落库
      if (useAiTasksStore.getState().tasks.find((t) => t.id === taskId)?.status === 'interrupted') {
        useAiTasksStore.getState().clear(taskId)
        return
      }
      if (!res.ok) {
        useAiTasksStore.getState().finish(taskId, false, res.message)
        setAiMsg({ ok: false, text: res.message })
        return
      }
      // 覆盖旧候选（仅删除未采纳的）
      if (candidates.length) await db.issues.bulkDelete(candidates.map((i) => i.id))
      // AI 结果转 Issue：测量标注按图片原始尺寸换算 px，吸色标注双图取样
      const rows = await aiAnnotationsToIssues(pageId, res.issues ?? [], designDataUrl, shotDataUrl, {
        imgSet: auto ? 'walk' : undefined
      })
      if (rows.length) await db.issues.bulkAdd(rows)
      if (rows.length) void touchPage(pageId)
      const doneText = rows.length
        ? t('aiDoneWithCount', { n: rows.length })
        : t('aiDoneNoDiff')
      useAiTasksStore.getState().finish(taskId, true, doneText)
      setAiMsg({ ok: true, text: doneText })
      if (rows.length) setDrawerOpen(true)
    } catch (err) {
      const errText = err instanceof Error ? err.message : String(err)
      useAiTasksStore.getState().finish(taskId, false, errText)
      setAiMsg({ ok: false, text: errText })
    }
  }

  const isOverlay = mode !== 'side-by-side'

  /** 抓手工具下仅平移浏览，不进入标注绘制态 */
  const activeTool: AnnotationShape | null = tool === 'hand' ? null : tool
  const panMode = tool === 'hand'

  /** 对比视图模式（文案随界面语言生成） */
  const VIEW_MODES: { value: ViewMode; label: string }[] = [
    { value: 'side-by-side', label: t('viewSideBySide') },
    { value: 'onion', label: t('viewOnion') },
    { value: 'slider', label: t('viewSlider') },
    { value: 'blink', label: t('viewBlink') }
  ]

  /** 标注工具（文案随界面语言生成） */
  const TOOLS: { value: ToolValue; label: string; hint: string }[] = [
    { value: 'hand', label: t('toolHand'), hint: t('toolHandHint') },
    { value: 'point', label: t('toolPoint'), hint: t('toolPointHint') },
    { value: 'arrow', label: t('toolArrow'), hint: t('toolArrowHint') },
    { value: 'rect', label: t('toolRect'), hint: t('toolRectHint') },
    { value: 'text', label: t('toolText'), hint: t('toolTextHint') },
    { value: 'measure', label: t('toolMeasure'), hint: t('toolMeasureHint') },
    { value: 'picker', label: t('toolPicker'), hint: t('toolPickerHint') }
  ]

  return (
    <div className="page compare-page">
      {/* 顶部横幅：返回上一级（页面在文件夹内时返回该文件夹视图，否则返回项目详情）+ 页面名 + 元信息 + 右上操作 + AI 插图（与其他页面横幅统一）；页面内全屏标注模式隐藏以最大化画布 */}
      {!isAnnotateFullscreen && (
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          <Link to={backTarget} className="back-link" draggable={false}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {backLabel}
          </Link>
          <h1 className="rv2-title detail-title">
            <span className="detail-title-text">{page?.pageName ?? '...'}</span>
            <button
              className="title-edit-btn"
              onClick={() => setEditPageOpen(true)}
              disabled={!page}
              title={t('editPageInfo')}
            >
              <PencilIcon />
            </button>
          </h1>
          <div className="detail-meta">
            {page && <PlatformBadge platform={page.platform} />}
            {page?.figmaUrl && (
              <a className="figma-link" href={page.figmaUrl} target="_blank" rel="noreferrer" title={page.figmaUrl} draggable={false}>
                <LinkIcon />
                <span>{t('figmaDesign')}</span>
              </a>
            )}
          </div>
        </div>
        <div className="detail-actions">
          <button
            ref={aiBtnGlowRef}
            className={`btn-secondary btn-ai${aiRunningCount ? ' loading' : ''}`}
            onClick={() => (aiRunningCount ? setRunningConfirmOpen(true) : setSkillPickOpen(true))}
            disabled={!aiModel || (workMode === 'manual' && (!designUrl || !shotUrl))}
            title={
              !aiModel
                ? t('aiTitleNoModel')
                : workMode === 'auto'
                  ? t('aiTitleAuto')
                  : !designUrl || !shotUrl
                    ? t('aiTitleNeedImages')
                    : t('aiTitleManual')
            }
          >
            <span className="ai-glow" aria-hidden />
            <span className="ai-spark">
              <SparklesIcon />
            </span>
            {aiRunningCount
              ? aiTasks.find((t) => t.status === 'running' && t.pageId === pageId)?.message ?? t('aiRunning')
              : t('aiRecognize')}
          </button>
          {/* 绑定规范：复用项目编辑弹窗（内含按端分类的规范绑定选择器），置于问题清单左侧；设置页关闭设计规范菜单后隐藏 */}
          {project && specMenuOn && (
            <button className="btn-secondary" onClick={() => setBindSpecOpen(true)}>
              <SpecIcon />
              {t('bindSpec')}
            </button>
          )}
          <button
            className={`btn-secondary${drawerOpen ? ' active' : ''}`}
            onClick={() => setDrawerOpen(!drawerOpen)}
          >
            <ListIcon />
            {t('issueList')}
          </button>
          <Link to={`/project/${projectId}/page/${pageId}/export`} className="btn-primary" draggable={false}>
            <ExportIcon />
            {t('exportReport')}
          </Link>
        </div>
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('aiArtAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>
      )}

      {aiMsg && (
        <p className={`ai-msg ${aiMsg.ok ? 'ok' : 'err'}`}>
          {/* 前缀与正文包进同一 span，关闭按钮 flex 右贴边垂直居中 */}
          <span>
            {aiMsg.ok ? '✓ ' : '✕ '}
            {aiMsg.text}
          </span>
          {/* 识别完成/失败通知条支持手动关闭 */}
          <button
            type="button"
            className="auto-walk-msg-close"
            aria-label={t('close')}
            onClick={() => setAiMsg(null)}
          >
            ×
          </button>
        </p>
      )}

      {/* 聚焦查看提示条（手动标注模式）：画布只显示当前问题点位，可退出 */}
      {workMode === 'manual' && focusIssue && (
        <div className="aw-focus-bar">
          <span>
            {t('focusingOn', {
              desc:
                focusIssue.description.length > 32
                  ? `${focusIssue.description.slice(0, 32)}…`
                  : focusIssue.description
            })}
          </span>
          <button type="button" onClick={() => setFocusIssue(null)}>
            {t('exitFocus')}
          </button>
        </div>
      )}

      <div className="workbench-header">
        {/* 全屏标注模式：头部左侧 = 返回项目按钮 + 当前页面标题；点击返回属明确退出，清除全屏记录避免返回时误恢复 */}
        {isAnnotateFullscreen && (
          <div className="fs-head-left">
            <Link
              to={backTarget}
              className="seg-icon-btn"
              title={t('backToProject')}
              aria-label={t('backToProject')}
              draggable={false}
              onClick={() => sessionStorage.removeItem(`annotate-fullscreen:${projectId}/${pageId}`)}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M15 18l-6-6 6-6" />
              </svg>
            </Link>
            <span className="fs-page-title">{page?.pageName ?? '...'}</span>
          </div>
        )}
        <div className="workbench-tools">
          {workMode === 'manual' && (
            <>
              {!isOverlay && (
                <label className="inline-label">
                  <input
                    type="checkbox"
                    checked={syncScroll}
                    onChange={(e) => setSyncScroll(e.target.checked)}
                  />
                  {t('syncScroll')}
                </label>
              )}
              {mode === 'slider' && (
                <>
                  <label className="inline-label">
                    {t('divider')}
                    <input
                      type="range"
                      min={0}
                      max={100}
                      value={sliderPos}
                      onChange={(e) => setSliderPos(Number(e.target.value))}
                    />
                  </label>
                  <label className="inline-label">
                    <input
                      type="checkbox"
                      checked={showDivider}
                      onChange={(e) => setShowDivider(e.target.checked)}
                    />
                    {t('showDividerLabel')}
                  </label>
                </>
              )}
              <label className="inline-label zoom-label">
                {t('zoom')}
                <input
                  type="range"
                  min={0.25}
                  max={3}
                  step={0.05}
                  value={zoom}
                  onChange={(e) => setZoom(Number(e.target.value))}
                />
                {Math.round(zoom * 100)}%
              </label>
              <div className="segmented">
                {VIEW_MODES.map((m) => (
                  <button
                    key={m.value}
                    type="button"
                    className={`segment-item ${mode === m.value ? 'active' : ''}`}
                    onClick={() => setMode(m.value)}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
            </>
          )}
          {workMode === 'auto' && aiRunningCount > 0 && (
            /* AI 识别进行中提示：与「收起设置」按钮同一行，按钮左侧显示（原在自动走查设置卡片内的消息条） */
            <span className="walk-running-hint">{t('aiTaskRunning', { ns: 'autoWalkPanel' })}</span>
          )}
          {workMode === 'auto' && (
            /* 自动走查消息槽：正在采集/采集完成等通知由 AutoWalkPanel 经 Portal 渲染到此处（「展开设置」按钮左侧，不再单独占一行） */
            <div id="walk-msg-slot" className="walk-msg-slot" />
          )}
          {workMode === 'auto' && (
            <button
              type="button"
              className="btn-secondary walk-controls-toggle"
              onClick={() => setWalkControlsOpen((v) => !v)}
              title={walkControlsOpen ? t('collapseAutoSettings') : t('expandAutoSettings')}
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                {walkControlsOpen ? <path d="M6 15l6-6 6 6" /> : <path d="M6 9l6 6 6-6" />}
              </svg>
              {walkControlsOpen ? t('collapseSettings') : t('expandSettings')}
            </button>
          )}
          {/* 工作模式切换 + 页面内全屏标注按钮（Segmented 右侧，随工具行右对齐） */}
          <div className="segmented work-mode-switch" title={t('workModeSwitchTitle')}>
            {(['manual', 'auto'] as const).map((m) => (
              <button
                key={m}
                type="button"
                className={`segment-item ${workMode === m ? 'active' : ''}`}
                onClick={() => setWorkMode(m)}
              >
                {m === 'manual' ? t('modeManual') : t('modeAuto')}
              </button>
            ))}
          </div>
          {/* 全屏标注模式：横幅右上操作以图标按钮形式并入工具行（Segmented 与全屏按钮之间），行为与横幅内一致 */}
          {isAnnotateFullscreen && (
            <>
              <button
                className={`seg-icon-btn${aiRunningCount ? ' loading' : ''}`}
                onClick={() => (aiRunningCount ? setRunningConfirmOpen(true) : setSkillPickOpen(true))}
                disabled={!aiModel || (workMode === 'manual' && (!designUrl || !shotUrl))}
                title={
                  !aiModel
                    ? t('aiTitleNoModel')
                    : workMode === 'auto'
                      ? t('aiTitleAuto')
                      : !designUrl || !shotUrl
                        ? t('aiTitleNeedImages')
                        : t('aiTitleManual')
                }
              >
                <SparklesIcon />
              </button>
              <button
                className={`seg-icon-btn${drawerOpen ? ' active' : ''}`}
                onClick={() => setDrawerOpen(!drawerOpen)}
                title={t('issueList')}
              >
                <ListIcon />
              </button>
              <Link
                to={`/project/${projectId}/page/${pageId}/export`}
                className="seg-icon-btn"
                title={t('exportReport')}
                draggable={false}
              >
                <ExportIcon />
              </Link>
            </>
          )}
          <button
            type="button"
            className="seg-icon-btn"
            onClick={toggleAnnotateFullscreen}
            title={isAnnotateFullscreen ? t('fsAnnotateExit') : t('fsAnnotate')}
            aria-label={isAnnotateFullscreen ? t('fsAnnotateExit') : t('fsAnnotate')}
          >
            {/* 展开/收起图标：全屏激活时切换为收起样式 */}
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              {isAnnotateFullscreen ? (
                <>
                  <path d="M4 14h6v6" />
                  <path d="m3 21 7-7" />
                  <path d="M20 10h-6V4" />
                  <path d="m14 10 7-7" />
                </>
              ) : (
                <>
                  <path d="M15 3h6v6" />
                  <path d="m21 3-7 7" />
                  <path d="M9 21H3v-6" />
                  <path d="m3 21 7-7" />
                </>
              )}
            </svg>
          </button>
        </div>
      </div>

      <div className="compare-body">
        {workMode === 'auto' ? (
          page && (
            <AutoWalkPanel
              page={page}
              issues={issues ?? []}
              onWalkDone={() => setWorkMode('manual')}
              focusIssue={focusIssue}
              onExitFocus={() => setFocusIssue(null)}
              controlsOpen={walkControlsOpen}
            />
          )
        ) : isOverlay ? (
          <div className="card overlay-panel">
            <div className="panel-title overlay-panel-title">
              {mode === 'onion' && t('onionPanelTitle')}
              {mode === 'slider' && t('sliderPanelTitle')}
              {mode === 'blink' && t('blinkPanelTitle')}
            </div>
            <div
              ref={overlayPanelRef}
              className={`overlay-canvas-viewport ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
              onMouseDown={(e) => handlePanStart(e, 'overlay')}
            >
              <div ref={overlayCanvasRef} className="overlay-canvas" style={{ width: `${zoom * 100}%` }}>
                {designUrl && <img src={designUrl} alt={t('altDesign')} className="overlay-base" />}
                {shotUrl && (
                  <img
                    src={shotUrl}
                    alt={t('altShot')}
                    className={
                      mode === 'onion'
                        ? 'overlay-top onion'
                        : mode === 'blink'
                          ? 'overlay-top blink-anim'
                          : 'overlay-top'
                    }
                    style={mode === 'slider' ? { clipPath: `inset(0 0 0 ${sliderPos}%)` } : undefined}
                  />
                )}
                {/* 叠加模式同样显示开发截图的标注，并可直接标注（坐标对齐开发截图图层） */}
                {shotUrl && (
                  <AnnotationCanvas
                    overlay
                    dataUrl={shotUrl}
                    alt={t('altShotAnnoLayer')}
                    issues={shotIssues}
                    tool={activeTool}
                    panMode={panMode}
                    spacePan={spaceHeld}
                    targetImage="screenshot"
                    noOf={(issue) => issueNos.get(issue.id) ?? 0}
                    onCreate={(rect, target) =>
                      setCreating({ rect, targetImage: target, shape: activeTool! })
                    }
                    onQuickCreate={handleQuickCreate}
                    onMove={handleMove}
                    onEdit={(issue) => setEditingIssue(issue)}
                    flashId={flashId}
                    focusId={focusIssue?.id ?? null}
                  />
                )}
                {mode === 'slider' && showDivider && (
                  <div
                    className="slider-divider"
                    style={{ left: `${sliderPos}%` }}
                    onMouseDown={startSliderDrag}
                  >
                    <div className="slider-handle" />
                  </div>
                )}
              </div>
            </div>
            <p className="annotation-hint">{t('overlayHint')}</p>
          </div>
        ) : (
          <div className="compare-container">
            <div className="compare-panel card">
              <div className="panel-title cw-panel-title">
                {t('panelDesign')}
                <span className="count count-accent panel-count">{t('annotationCount', { n: designIssues.length })}</span>
                <span className="panel-hist">
                  <button
                    type="button"
                    className="panel-hist-btn"
                    onClick={() => void undo()}
                    disabled={undoStack.length === 0}
                    title={`${t('undo')} (${navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'}Z)`}
                    aria-label={t('undo')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9 14 4 9l5-5" />
                      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="panel-hist-btn"
                    onClick={() => void redo()}
                    disabled={redoStack.length === 0}
                    title={`${t('redo')} (${navigator.platform.toLowerCase().includes('mac') ? '⇧⌘' : 'Ctrl+'}Z)`}
                    aria-label={t('redo')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m15 14 5-5-5-5" />
                      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
                    </svg>
                  </button>
                </span>
                <button
                  className="panel-upload"
                  onClick={() => {
                    setReupDesignErr('')
                    setReupDesignOpen(true)
                  }}
                  title={t('reuploadDesignTitle')}
                >
                  {t('reupload')}
                </button>
              </div>
              <div
                ref={designRef}
                className={`canvas-area ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
                onScroll={() => handleScroll('design')}
                onMouseDown={(e) => handlePanStart(e, 'design')}
              >
                {designUrl && (
                  <div style={{ width: `${zoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={designUrl}
                      alt="设计稿"
                      issues={designIssues}
                      tool={activeTool}
                      panMode={panMode}
                  spacePan={spaceHeld}
                      targetImage="design"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      onCreate={(rect, target) =>
                        setCreating({ rect, targetImage: target, shape: activeTool! })
                      }
                      onQuickCreate={handleQuickCreate}
                      onMove={handleMove}
                      onEdit={(issue) => setEditingIssue(issue)}
                      flashId={flashId}
                      focusId={focusIssue?.id ?? null}
                      mirrorLoupe={pickerSyncActive && pickerPixel?.from === 'screenshot' ? pickerPixel : null}
                      onPickerPixel={pickerSyncActive ? (p) => setPickerPixel(p ? { ...p, from: 'design' } : null) : undefined}
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="compare-panel card">
              <div className="panel-title cw-panel-title">
                {t('panelShot')}
                <span className="count count-accent panel-count">{t('annotationCount', { n: shotIssues.length })}</span>
                <span className="panel-hist">
                  <button
                    type="button"
                    className="panel-hist-btn"
                    onClick={() => void undo()}
                    disabled={undoStack.length === 0}
                    title={`${t('undo')} (${navigator.platform.toLowerCase().includes('mac') ? '⌘' : 'Ctrl+'}Z)`}
                    aria-label={t('undo')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M9 14 4 9l5-5" />
                      <path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
                    </svg>
                  </button>
                  <button
                    type="button"
                    className="panel-hist-btn"
                    onClick={() => void redo()}
                    disabled={redoStack.length === 0}
                    title={`${t('redo')} (${navigator.platform.toLowerCase().includes('mac') ? '⇧⌘' : 'Ctrl+'}Z)`}
                    aria-label={t('redo')}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="m15 14 5-5-5-5" />
                      <path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13" />
                    </svg>
                  </button>
                </span>
                <button
                  className="panel-upload"
                  onClick={() => handleReupload('screenshot')}
                  title={t('reuploadShotTitle')}
                >
                  {t('reupload')}
                </button>
              </div>
              <div
                ref={shotRef}
                className={`canvas-area ${panMode ? 'hand-pan' : ''} ${spaceHeld ? 'space-pan' : ''}`}
                onScroll={() => handleScroll('shot')}
                onMouseDown={(e) => handlePanStart(e, 'shot')}
              >
                {shotUrl && (
                  <div style={{ width: `${zoom * 100}%` }}>
                    <AnnotationCanvas
                      dataUrl={shotUrl}
                      alt="开发截图"
                      issues={shotIssues}
                      tool={activeTool}
                      panMode={panMode}
                  spacePan={spaceHeld}
                      targetImage="screenshot"
                      noOf={(issue) => issueNos.get(issue.id) ?? 0}
                      onCreate={(rect, target) =>
                        setCreating({ rect, targetImage: target, shape: activeTool! })
                      }
                      onQuickCreate={handleQuickCreate}
                      onMove={handleMove}
                      onEdit={(issue) => setEditingIssue(issue)}
                      flashId={flashId}
                      focusId={focusIssue?.id ?? null}
                      mirrorLoupe={pickerSyncActive && pickerPixel?.from === 'design' ? pickerPixel : null}
                      onPickerPixel={pickerSyncActive ? (p) => setPickerPixel(p ? { ...p, from: 'screenshot' } : null) : undefined}
                    />
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {drawerOpen && (
          <IssueDrawer
            issues={(issues ?? []).filter(workMode === 'auto' ? (i) => i.imgSet === 'walk' : isManual)}
            onHighlight={handleFlash}
            onEdit={(issue) => setEditingIssue(issue)}
            onReverify={openReverify}
            onAdd={workMode === 'auto' ? undefined : handleQuickAdd}
            onClose={() => setDrawerOpen(false)}
            specMenuOn={specMenuOn}
          />
        )}
      </div>

      {workMode === 'manual' && (
        <div className="anno-toolbar-wrap">
          <div className="anno-toolbar">
            {TOOLS.map((t) => (
              <button
                key={t.value}
                type="button"
                className={`anno-tool ${tool === t.value ? 'active' : ''}`}
                onClick={() => setTool(t.value)}
              >
                <ToolIcon name={t.value} />
                {t.label}
              </button>
            ))}
            {/* 取色同步开关：仅吸色工具激活时出现，激活态=双图同步取色 */}
            {tool === 'picker' && (
              <button
                type="button"
                className={`anno-tool${pickerSync ? ' active' : ''}`}
                title={t('pickerSyncHint')}
                onClick={() => setPickerSync((v) => !v)}
              >
                {t('pickerSync')}
              </button>
            )}
          </div>
          <p className="anno-toolbar-hint">
            {TOOLS.find((t) => t.value === tool)?.hint}
            {t('toolbarHintSuffix')}
          </p>
        </div>
      )}

      {creating && (
        <IssueEditorModal
          mode="create"
          issue={{
            id: '',
            pageId: pageId!,
            targetImage: creating.targetImage,
            x: creating.rect.x,
            y: creating.rect.y,
            width: creating.rect.width,
            height: creating.rect.height,
            description: '',
            severity: 'minor',
            category: CATEGORY_UNSET,
            status: 'pending',
            createdAt: 0
          }}
          onSave={handleCreate}
          onCancel={() => setCreating(null)}
        />
      )}

      {editingIssue && (
        <IssueEditorModal
          mode="edit"
          issue={editingIssue}
          onSave={handleUpdate}
          onDelete={handleDelete}
          onCancel={() => setEditingIssue(null)}
        />
      )}

      {reverifyIssue && (
        <ReverifyModal
          issue={reverifyIssue}
          oldScreenshotUrl={oldScreenshotUrl}
          onClose={() => setReverifyIssue(null)}
        />
      )}

      {editPageOpen && page && (
        <EditPageModal
          page={page}
          onSave={(fields) => {
            db.pages.update(pageId!, { ...fields, updatedAt: Date.now() })
            setEditPageOpen(false)
          }}
          onCancel={() => setEditPageOpen(false)}
        />
      )}

      {/* 绑定规范：仅绑定规范弹窗（只显示当前页面端类型的规范分类，不含项目编辑项） */}
      {bindSpecOpen && page && (
        <BindSpecModal
          projectId={projectId!}
          platform={page.platform}
          onDone={() => setBindSpecOpen(false)}
          onCancel={() => setBindSpecOpen(false)}
        />
      )}

      {/* 设计稿重新上传：选择本地文件或直接读取 Figma 设计稿 */}
      {reupDesignOpen && (
        <div className="modal-mask" onClick={() => !reupDesignBusy && setReupDesignOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('reupDesignTitle')}</h3>
            <div className="reup-opts">
              <button
                type="button"
                className="reup-opt"
                disabled={reupDesignBusy}
                onClick={() => {
                  setReupDesignOpen(false)
                  void handleReupload('design')
                }}
              >
                <span className="reup-opt-name">{t('reupDesignLocal')}</span>
                <span className="reup-opt-hint">{t('reupDesignLocalHint')}</span>
              </button>
              <button
                type="button"
                className="reup-opt"
                disabled={reupDesignBusy}
                onClick={() => void handleFigmaReupload()}
              >
                <span className="reup-opt-name">{t('reupDesignFigma')}</span>
                <span className="reup-opt-hint">{t('reupDesignFigmaHint')}</span>
              </button>
            </div>
            {reupDesignBusy && <p className="reup-err">{t('reupDesignFigmaBusy')}</p>}
            {reupDesignErr && <p className="reup-err">{reupDesignErr}</p>}
          </div>
        </div>
      )}

      {skillPickOpen && (
        <SkillPickModal
          skills={skills}
          initial={pickedSkillIds}
          onCancel={() => setSkillPickOpen(false)}
          onConfirm={(ids) => {
            setPickedSkillIds(ids)
            setSkillPickOpen(false)
            void runAIAnnotate(ids)
          }}
        />
      )}

      {runningConfirmOpen && (
        <RunningConfirmModal
          onContinue={() => setRunningConfirmOpen(false)}
          onInterrupt={() => {
            interruptPageTasks()
            setRunningConfirmOpen(false)
          }}
          onRestart={() => {
            interruptPageTasks()
            setRunningConfirmOpen(false)
            setSkillPickOpen(true)
          }}
        />
      )}
    </div>
  )
}

/** AI 识别前的技能选择弹窗：SkillHub 技能多选，确认后作为走查指引注入 */
function SkillPickModal({
  skills,
  initial,
  onConfirm,
  onCancel
}: {
  skills: SkillItemLite[]
  initial: string[]
  onConfirm: (ids: string[]) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('compareWorkbench')
  const [picked, setPicked] = useState<string[]>(initial)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggle = (id: string): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{t('skillPickTitle')}</h3>
        <p className="settings-desc">{t('skillPickDesc')}</p>
        {skills.length === 0 ? (
          <p className="settings-empty">{t('skillPickEmpty')}</p>
        ) : (
          <div className="skill-pick-list">
            {skills.map((s) => {
              const active = picked.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`skill-pick-item ${active ? 'active' : ''}`}
                  onClick={() => toggle(s.id)}
                >
                  <span className="skill-pick-check">{active ? '✓' : ''}</span>
                  <span className="skill-pick-body">
                    <span className="skill-pick-name">{s.name}</span>
                    {s.desc && <span className="skill-pick-desc">{s.desc}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={() => onConfirm(picked)}>
            {picked.length ? t('startWalkthrough') : t('walkWithoutSkill')}
          </button>
        </div>
      </div>
    </div>
  )
}

/** 识别进行中再次点击的确认弹窗：继续（关闭弹窗等待结果）/ 中断当前任务 / 中断并重新开始 */
function RunningConfirmModal({
  onContinue,
  onInterrupt,
  onRestart
}: {
  onContinue: () => void
  onInterrupt: () => void
  onRestart: () => void
}) {
  const { t } = useTranslation('compareWorkbench')

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onContinue()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onContinue])

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onContinue()}>
      <div className="modal">
        <h3>{t('aiRunningDialogTitle')}</h3>
        <p className="settings-desc">{t('aiRunningDialogDesc')}</p>
        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onContinue}>
            {t('aiRunningContinue')}
          </button>
          <button className="btn-danger" onClick={onInterrupt}>
            {t('aiRunningInterrupt')}
          </button>
          <button className="btn-primary" onClick={onRestart}>
            {t('aiRunningRestart')}
          </button>
        </div>
      </div>
    </div>
  )
}
