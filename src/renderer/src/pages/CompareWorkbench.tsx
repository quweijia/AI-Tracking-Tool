import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useSearchParams, useLocation, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, genId, recordVisit, touchPage, Issue, Category, Severity, TargetImage, AnnotationShape, PLATFORM_LABELS, aiAnnotationsToIssues } from '../db'
import AnnotationCanvas, { NormalizedRect } from '../components/AnnotationCanvas'
import AutoWalkPanel from '../components/AutoWalkPanel'
import EditPageModal from '../components/EditPageModal'
import ProjectModal from '../components/ProjectModal'
import IssueEditorModal from '../components/IssueEditorModal'
import IssueDrawer from '../components/IssueDrawer'
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
function ToolIcon({ name }: { name: ToolValue }) {
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

function ExportIcon() {
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

export default function CompareWorkbench() {
  const { t } = useTranslation('compareWorkbench')
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const [searchParams, setSearchParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const page = useLiveQuery(() => db.pages.get(pageId!), [pageId])
  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  const issues = useLiveQuery(() => db.issues.where('pageId').equals(pageId!).toArray(), [pageId])

  const [designUrl, setDesignUrl] = useState('')
  const [shotUrl, setShotUrl] = useState('')
  const [mode, setMode] = useState<ViewMode>('side-by-side')
  /** 工作台模式：手动标注 / 自动走查（双模式共存，切换保留各自状态）；外部跳转可经 location.state 直接进入审核（自动走查）视图 */
  const [workMode, setWorkMode] = useState<WorkMode>(() =>
    (location.state as { mode?: WorkMode } | null)?.mode === 'auto' ? 'auto' : 'manual'
  )
  /** 自动走查设置（Figma 连接 / 开发 URL）卡片是否展开，折叠按钮在工作模式切换左侧 */
  const [walkControlsOpen, setWalkControlsOpen] = useState(true)
  const [zoom, setZoom] = useState(1)
  const [syncScroll, setSyncScroll] = useState(true)
  const [sliderPos, setSliderPos] = useState(50)
  /** 滑块模式：是否显示分界线（隐藏后画布分界线与调整滑杆都收起） */
  const [showDivider, setShowDivider] = useState(true)
  /** 当前标注工具，默认抓手（浏览/平移），选择标注工具后可直接绘制 */
  const [tool, setTool] = useState<ToolValue>('hand')
  /** 问题清单抽屉 */
  const [drawerOpen, setDrawerOpen] = useState(false)
  // 问题清单点击卡片 → 画布上对应标注闪烁定位（约 2.2s 后自动清除）
  const [flashId, setFlashId] = useState<string | null>(null)
  const flashTimer = useRef<number | null>(null)
  /** 聚焦查看的问题：双图放大 2x 并滚动居中到该点位，其余标注隐藏（再点一次取消） */
  const [focusIssue, setFocusIssue] = useState<Issue | null>(null)
  /** 编辑页面信息弹窗 */
  const [editPageOpen, setEditPageOpen] = useState(false)
  /** 绑定规范弹窗（复用项目编辑弹窗，内含按端分类的规范绑定选择器） */
  const [bindSpecOpen, setBindSpecOpen] = useState(false)
  /** 编辑中的已有问题 / 新建草稿（null = 弹窗关闭） */
  const [editingIssue, setEditingIssue] = useState<Issue | null>(null)

  /** 标注撤销/重做历史栈（手动标注的新增/删除/编辑共用，切页清空） */
  const [undoStack, setUndoStack] = useState<HistoryOp[]>([])
  const [redoStack, setRedoStack] = useState<HistoryOp[]>([])

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
  }, [focusIssue, zoom, workMode])

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
      if (e.code !== 'Space' || e.repeat) return
      if (isTypingTarget(e.target)) return
      e.preventDefault()
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

  // 快捷键：Mac Cmd+Z 撤销 / Cmd+Shift+Z 重做（Windows Ctrl 同理；输入框内交给原生撤销）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
  }) => {
    if (!editingIssue) return
    const confirmed = editingIssue.isAISuggested && !editingIssue.aiConfirmed ? { aiConfirmed: true } : {}
    const after: Issue = { ...editingIssue, ...fields, ...confirmed }
    await db.issues.update(editingIssue.id, { ...fields, ...confirmed })
    pushHistory({ type: 'update', before: editingIssue, after })
    void touchPage(editingIssue.pageId)
    setEditingIssue(null)
  }

  // ===== 快速创建（不弹窗）：测量距离 / 吸色取样 =====
  // 吸色离屏画布缓存：url → 已绘制的离屏 canvas（点击时同步取双图像素）
  const sampleCacheRef = useRef<Map<string, HTMLCanvasElement>>(new Map())
  useEffect(() => {
    ;[designUrl, shotUrl].forEach((url) => {
      if (!url || sampleCacheRef.current.has(url)) return
      const img = new Image()
      img.src = url
      img.onload = () => {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        canvas.getContext('2d', { willReadFrequently: true })?.drawImage(img, 0, 0)
        sampleCacheRef.current.set(url, canvas)
      }
    })
  }, [designUrl, shotUrl])

  /** 在指定图片上取归一化坐标处的像素色（hex），画布未就绪返回 null */
  const sampleColorAt = (url: string, nx: number, ny: number): string | null => {
    const canvas = sampleCacheRef.current.get(url)
    const ctx = canvas?.getContext('2d', { willReadFrequently: true })
    if (!canvas || !ctx || !canvas.width || !canvas.height) return null
    const px = Math.min(canvas.width - 1, Math.max(0, Math.round(nx * canvas.width)))
    const py = Math.min(canvas.height - 1, Math.max(0, Math.round(ny * canvas.height)))
    try {
      const d = ctx.getImageData(px, py, 1, 1).data
      return rgbToHex(d[0], d[1], d[2])
    } catch {
      return null
    }
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
      // 吸色：一次点击同时取设计稿与开发截图同一坐标的颜色，双图各生成一条吸色标注
      const ownHex = data.colorHex ?? sampleColorAt(target === 'design' ? designUrl : shotUrl, rect.x, rect.y)
      const otherHex = sampleColorAt(target === 'design' ? shotUrl : designUrl, rect.x, rect.y)
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
    await db.issues.delete(editingIssue.id)
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
      !window.confirm(t('aiOverwriteConfirm', { n: candidates.length }))
    ) {
      return
    }
    // 注册后台任务：切换页面不影响识别，返回页面时从这里恢复状态；同页可再次点击并行发起
    const taskId = useAiTasksStore.getState().start(pageId, page?.pageName ?? '')
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
      {/* 顶部横幅：返回项目 + 页面名 + 元信息 + 右上操作 + AI 插图（与其他页面横幅统一） */}
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          <Link to={`/project/${projectId}`} className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {project?.name ?? t('backToProject')}
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
              <a className="figma-link" href={page.figmaUrl} target="_blank" rel="noreferrer" title={page.figmaUrl}>
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
            onClick={() => setSkillPickOpen(true)}
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
          {/* 绑定规范：复用项目编辑弹窗（内含按端分类的规范绑定选择器），置于问题清单左侧 */}
          {project && (
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
          <Link to={`/project/${projectId}/page/${pageId}/export`} className="btn-primary">
            <ExportIcon />
            {t('exportReport')}
          </Link>
        </div>
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt={t('aiArtAlt')} draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      {aiMsg && (
        <p className={`ai-msg ${aiMsg.ok ? 'ok' : 'err'}`}>
          {aiMsg.ok ? '✓ ' : '✕ '}
          {aiMsg.text}
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
              <div className="panel-title">
                {t('panelDesign')}
                <span className="panel-count">{t('annotationCount', { n: designIssues.length })}</span>
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
                  onClick={() => handleReupload('design')}
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
                    />
                  </div>
                )}
              </div>
            </div>
            <div className="compare-panel card">
              <div className="panel-title">
                {t('panelShot')}
                <span className="panel-count">{t('annotationCount', { n: shotIssues.length })}</span>
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
            category: 'spacing',
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

      {/* 绑定规范：复用项目编辑弹窗 */}
      {bindSpecOpen && project && (
        <ProjectModal project={project} onDone={() => setBindSpecOpen(false)} onCancel={() => setBindSpecOpen(false)} />
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
