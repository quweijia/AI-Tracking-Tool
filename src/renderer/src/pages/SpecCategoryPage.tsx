import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, Navigate, useNavigate, useParams } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useLiveQuery } from 'dexie-react-hooks'
import { SpecPlatIcon } from '../components/Layout'
import {
  db,
  bySort,
  genId,
  getFigmaPat,
  platformList,
  syncSpecFromFigma,
  rollbackSpecVersion,
  deleteSpecCascade,
  deleteSpecVersion,
  importSpecTokensFromJson,
  type DesignSpec,
  type Project,
  type SpecCategory,
  type SpecImportMode,
  type SpecSyncOutcome,
  type SpecToken,
  type SpecVersion
} from '../db'
import { parseTokenValue, type SpecTokenValue, type TokenKind } from '../../../shared/types'
import { EXPORT_SUFFIX, exportTokens, type ExportFormat, type ExportToken } from '../../../shared/tokenExport'
import { parseVariablesJsonBundle } from '../../../shared/variablesImport'
import { extractFigmaFileKey } from '../../../shared/figmaUrl'
import { ProjectLogo } from '../components/ProjectCard'
import SpecModal from '../components/SpecModal'
import USelect from '../components/USelect'
import heroBannerArtUrl from '../assets/hero-banner-xmxq.png'
import heroBannerArtDarkUrl from '../assets/hero-banner-xmxq-dark.png'
import heroBannerCatArtUrl from '../assets/hero-banner-art.png'
import heroBannerGfUrl from '../assets/hero-banner-gf.png'
import heroBannerGfDarkUrl from '../assets/hero-banner-gf-dark.png'
import heroBannerCatArtDarkUrl from '../assets/hero-banner-art-dark.png'

/** 一期 7 类 Token（左栏顺序） */
const KINDS: TokenKind[] = ['color', 'spacing', 'fontSize', 'lineHeight', 'radius', 'shadow', 'border']

/** 深浅模式命名识别：英文拆词后含 light/dark（词边界，避免 highlight/darken 误判，兼容 light-mode/lightmode/驼峰），中文含 浅色/亮色/深色/暗色 等 */
const nameMode = (name: string): 'light' | 'dark' | undefined => {
  if (/浅色|亮色|日间/.test(name)) return 'light'
  if (/深色|暗色|夜间/.test(name)) return 'dark'
  const lower = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase()
  if (/(^|[^a-z])light([^a-z]|$)/.test(lower) || lower.includes('lightmode')) return 'light'
  if (/(^|[^a-z])dark([^a-z]|$)/.test(lower) || lower.includes('darkmode')) return 'dark'
  return undefined
}

/** Token 深浅视图：mode 字段优先；无 mode 时从编组命名（path 各段）派生深浅，并剔除模式段得到基础路径（color/light/bg → color/bg + light） */
const splitModeOf = (tok: SpecToken): { mode: string; basePath: string } => {
  if (tok.mode) return { mode: tok.mode, basePath: tok.path }
  const kept: string[] = []
  let mode: 'light' | 'dark' | undefined
  for (const seg of tok.path.split('/')) {
    const m = nameMode(seg)
    if (m) {
      mode ??= m
      continue // 模式段不进入基础路径
    }
    kept.push(seg)
  }
  return mode ? { mode, basePath: kept.join('/') } : { mode: '', basePath: tok.path }
}

/** 导出格式 → 下拉文案 key 与保存对话框过滤器 */
const EXPORT_FMTS: { key: ExportFormat; labelKey: string; filter: { name: string; extensions: string[] } }[] = [
  { key: 'json', labelKey: 'fmtJson', filter: { name: 'JSON', extensions: ['json'] } },
  { key: 'css', labelKey: 'fmtCss', filter: { name: 'CSS', extensions: ['css'] } },
  { key: 'tailwind', labelKey: 'fmtTailwind', filter: { name: 'JavaScript', extensions: ['js'] } }
]

/** Token 值 → 展示文本（color 由表格单独渲染色块） */
function fmtValue(v: SpecTokenValue): string {
  if (v.kind === 'color') return v.hex
  if (v.kind === 'shadow')
    return v.layers
      .map((l) => `${l.inset ? 'inset ' : ''}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`)
      .join(', ')
  if (v.kind === 'border') return `${v.width}px ${v.style} ${v.color}`
  return `${v.value}px`
}

/** 横幅标题悬停操作 icon：编辑规范（与项目详情 title-edit-btn 同款 14px 线性风格） */
function PencilIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M17 3a2.85 2.85 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  )
}

/** 横幅标题悬停操作 icon：删除规范 */
function TrashIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M3 6h18" />
      <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
      <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
    </svg>
  )
}

/** Token 分类小图标（左栏 7 变体） */
function KindIcon({ kind }: { kind: TokenKind }) {
  const p = {
    width: 13,
    height: 13,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 2,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    'aria-hidden': true
  }
  switch (kind) {
    case 'color':
      return (
        <svg {...p}>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" opacity=".4" />
        </svg>
      )
    case 'spacing':
      return (
        <svg {...p}>
          <path d="M6 4v16M18 4v16M9 12h6m0 0-2-2m2 2-2 2" />
        </svg>
      )
    case 'fontSize':
      return (
        <svg {...p}>
          <polyline points="4 7 4 4 20 4 20 7" />
          <path d="M9 20h6M12 4v16" />
        </svg>
      )
    case 'lineHeight':
      return (
        <svg {...p}>
          <path d="M4 5h16M4 12h16M4 19h16" />
          <path d="M7 3 5 5l2 2M17 17l2 2-2 2" />
        </svg>
      )
    case 'radius':
      return <svg {...p}>{<path d="M4 20v-8a8 8 0 0 1 8-8h8" />}</svg>
    case 'shadow':
      return (
        <svg {...p}>
          <rect x="3" y="3" width="12" height="12" rx="2" />
          <path d="M8.5 20H17a3 3 0 0 0 3-3V8.5" />
        </svg>
      )
    case 'border':
      return (
        <svg {...p}>
          <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="4 3" />
        </svg>
      )
  }
}

/**
 * 规范详情页（/specs/:categoryId/spec/:specId）：页头（应用徽标 + 同步/导出）、规范来源卡（Figma 链接验证 / .fig 上传 + 连接状态）、
 * 当前版本卡（版本号 + 统计 + 元信息）、Design Token 卡（分类左栏 + 表格 + 分页 + 复制）、
 * 项目绑定卡（三态项目卡 + 快速绑定），历史版本抽屉与规范弹窗复用。
 */
export default function SpecCategoryPage() {
  const { t, i18n } = useTranslation('specsPage')
  const { categoryId = '', specId: routeSpecId = '' } = useParams<{
    categoryId: string
    specId: string
  }>()

  // ───────────── 数据（全部 hooks 置于 early return 之前） ─────────────
  const categories = useLiveQuery(() => db.specCategories.toArray())
  const specs = useLiveQuery(
    () => db.designSpecs.where('categoryId').equals(categoryId).toArray(),
    [categoryId]
  )
  // 旧深链接兼容：/specs/:specId（规范 id）→ 重定向到所属分类
  const legacySpec = useLiveQuery(() => db.designSpecs.get(categoryId), [categoryId])

  const sortedCats = useMemo(() => [...(categories ?? [])].sort(bySort), [categories])
  const sortedSpecs = useMemo(() => [...(specs ?? [])].sort(bySort), [specs])
  const activeSpec = useMemo(
    () => sortedSpecs.find((s) => s.id === routeSpecId),
    [sortedSpecs, routeSpecId]
  )
  const specId = activeSpec?.id

  const versions = useLiveQuery(
    () =>
      specId
        ? db.specVersions.where('specId').equals(specId).toArray()
        : Promise.resolve<SpecVersion[]>([]),
    [specId]
  )
  /** 当前生效 = no 最大版本 */
  const latest = useMemo(() => [...(versions ?? [])].sort((a, b) => b.no - a.no)[0], [versions])
  const tokens = useLiveQuery(
    async () => {
      if (!latest) return []
      const rows = await db.specTokens.where('versionId').equals(latest.id).toArray()
      // 按入库序号排序：保持 Figma 解析 / JSON 导入的原始分组与顺序（旧数据无 sortNo 时保持原序）
      return rows.sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0))
    },
    [latest?.id],
    [] as SpecToken[]
  )
  const bindingsAll = useLiveQuery(() => db.projectSpecBindings.toArray(), [])
  const projects = useLiveQuery(async () => (await db.projects.toArray()).sort(bySort), [])

  // PAT 有无（连接状态卡三态）
  const [hasPat, setHasPat] = useState(false)
  useEffect(() => {
    void getFigmaPat().then((p) => setHasPat(!!p))
  }, [])

  // ───────────── 本地状态 ─────────────
  const [srcTab, setSrcTab] = useState<'url' | 'fig' | 'json'>('url')
  const [urlDraft, setUrlDraft] = useState('')
  const [verifyMsg, setVerifyMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const [kindFilter, setKindFilter] = useState<TokenKind | 'all'>('all')
  const [query, setQuery] = useState('')
  /** 左侧类别下折叠的分组过滤：null = 显示该类别全部 */
  const [pathFilter, setPathFilter] = useState<string | null>(null)
  /** 三层 Token 体系层级过滤（Primitive/Semantic/Component）：null = 全部层级 */
  const [tierFilter, setTierFilter] = useState<string | null>(null)
  /** 左侧分组子列表是否展开 */
  const [kidsOpen, setKidsOpen] = useState(false)
  const [showHist, setShowHist] = useState(false)
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<DesignSpec | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [syncOk, setSyncOk] = useState<SpecSyncOutcome | null>(null)
  const [syncErr, setSyncErr] = useState<string | null>(null)
  const [copiedId, setCopiedId] = useState('')
  const [exportMsg, setExportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  // JSON 文件导入
  const [importing, setImporting] = useState(false)
  const [importMsg, setImportMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const jsonInputRef = useRef<HTMLInputElement>(null)
  // 导入模式选择弹窗（同步/JSON 导入共用）：挂起 resolve，等待用户选「清空重导 / 去重叠加 / 取消」
  const [modeAsk, setModeAsk] = useState<((mode: SpecImportMode | null) => void) | null>(null)
  // 历史抽屉：当前展开 Token 详情的版本 id（空 = 全部收起）
  const [histVerId, setHistVerId] = useState('')

  // 历史详情：展开版本的 Token 列表（按入库顺序）
  const histTokens = useLiveQuery(
    async () => {
      if (!histVerId) return []
      const rows = await db.specTokens.where('versionId').equals(histVerId).toArray()
      return rows.sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0))
    },
    [histVerId],
    [] as SpecToken[]
  )

  // 切换规范时回填链接草稿
  useEffect(() => {
    setUrlDraft(activeSpec?.figmaUrl ?? '')
    setVerifyMsg(null)
    setTierFilter(null)
    setPathFilter(null)
    setKidsOpen(false)
  }, [activeSpec?.id, activeSpec?.figmaUrl])

  const fmtTime = (ts: number) =>
    new Date(ts).toLocaleString(i18n.language === 'en-US' ? 'en-US' : 'zh-CN', { hour12: false })

  // ───────────── 派生数据 ─────────────
  const category = useMemo(() => sortedCats.find((c) => c.id === categoryId), [sortedCats, categoryId])

  /** 本分类全部规范 id（应用徽标 / 绑定清除范围） */
  const catSpecIds = useMemo(() => new Set(sortedSpecs.map((s) => s.id)), [sortedSpecs])
  const specNameById = useMemo(() => new Map(sortedSpecs.map((s) => [s.id, s.name])), [sortedSpecs])

  /** 应用徽标：本分类任一规范被项目绑定 */
  const applied = useMemo(
    () => (bindingsAll ?? []).some((b) => catSpecIds.has(b.specId)),
    [bindingsAll, catSpecIds]
  )
  /** 本规范绑定项目数（版本卡统计） */
  const boundCount = useMemo(
    () => (bindingsAll ?? []).filter((b) => b.specId === specId).length,
    [bindingsAll, specId]
  )

  /** 匹配分类端的项目（走查按页面端自动取套，绑定列表只列匹配端） */
  const matchedProjects = useMemo(
    () => (projects ?? []).filter((p: Project) => platformList(p.platform).includes(category?.platformKey ?? 'pc')),
    [projects, category?.platformKey]
  )

  /** 各类 Token 计数（当前生效版本） */
  const countByKind = useMemo(() => {
    const map = new Map<TokenKind, number>()
    for (const tok of tokens) map.set(tok.kind, (map.get(tok.kind) ?? 0) + 1)
    return map
  }, [tokens])

  /** 无层级归属的 token 归入统一桶（仅混合数据时出现） */
  const NO_TIER = ''

  /** 是否三层 Token 体系数据（任一 token 带 Primitive/Semantic/Component 层级即启用层级菜单） */
  const hasTiers = useMemo(() => tokens.some((t) => !!t.tier), [tokens])

  /** 层级列表 + 计数（保持导入首次出现序：Primitive → Semantic → Component） */
  const tierCounts = useMemo(() => {
    const map = new Map<string, number>()
    for (const tok of tokens) {
      const key = tok.tier ?? NO_TIER
      map.set(key, (map.get(key) ?? 0) + 1)
    }
    return map
  }, [tokens])

  /** 当前层级下的分组路径（保持首次出现顺序，用于左侧折叠子列表） */
  const tierPaths = useMemo(() => {
    if (tierFilter === null) return []
    const map = new Map<string, number>()
    for (const tok of tokens) {
      if ((tok.tier ?? NO_TIER) !== tierFilter) continue
      map.set(tok.path, (map.get(tok.path) ?? 0) + 1)
    }
    return [...map].map(([path, count]) => ({ path, count }))
  }, [tokens, tierFilter])

  /** 切换层级：与类别同交互——点击已选层级时已选分组则回全部，否则收起/展开子列表 */
  const selectTier = (tk: string) => {
    if (tk === tierFilter) {
      if (pathFilter) setPathFilter(null)
      else setKidsOpen((o) => !o)
      return
    }
    setTierFilter(tk)
    setPathFilter(null)
    setKidsOpen(true)
  }

  /** 当前类别下的分组列表（保持首次出现顺序，用于左侧折叠子列表） */
  const kindPaths = useMemo(() => {
    if (kindFilter === 'all') return []
    const map = new Map<string, number>()
    for (const tok of tokens) {
      if (tok.kind !== kindFilter) continue
      map.set(tok.path, (map.get(tok.path) ?? 0) + 1)
    }
    return [...map].map(([path, count]) => ({ path, count }))
  }, [tokens, kindFilter])

  /** 切换类别：换类别时默认展示全部分组；点击已选类别时——已选中某分组则回全部，否则收起/展开子列表 */
  const selectKind = (k: TokenKind | 'all') => {
    if (k === kindFilter) {
      if (pathFilter) setPathFilter(null)
      else setKidsOpen((o) => !o)
      return
    }
    setKindFilter(k)
    setPathFilter(null)
    setKidsOpen(true)
  }

  /** Token 深浅视图缓存：过滤 / 模式列 / 行聚合 / 侧边栏树统一使用（mode 字段优先，编组命名派生兜底） */
  const modeView = useMemo(() => {
    const map = new Map<string, { mode: string; basePath: string }>()
    for (const tok of tokens) map.set(tok.id, splitModeOf(tok))
    return map
  }, [tokens])

  /** 过滤：层级体系（tier）或类别（kind）+ 分组 + 关键词（名称/路径/值/描述）；分组匹配按剔除模式段后的基础路径 */
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return tokens.filter((tok) => {
      if (
        hasTiers
          ? tierFilter !== null && (tok.tier ?? NO_TIER) !== tierFilter
          : kindFilter !== 'all' && tok.kind !== kindFilter
      )
        return false
      if (pathFilter) {
        const bp = modeView.get(tok.id)?.basePath ?? tok.path
        if (bp !== pathFilter && !bp.startsWith(`${pathFilter}/`)) return false
      }
      if (!q) return true
      return (
        tok.name.toLowerCase().includes(q) ||
        tok.path.toLowerCase().includes(q) ||
        tok.value.toLowerCase().includes(q) ||
        (tok.description ?? '').toLowerCase().includes(q)
      )
    })
  }, [tokens, hasTiers, tierFilter, kindFilter, pathFilter, query, modeView])

  /** 表格并列的模式列（保持导入首次出现顺序；编组命名派生的深浅同样计入） */
  const tableModes = useMemo(() => {
    const modes: string[] = []
    for (const tok of filtered) {
      const m = modeView.get(tok.id)?.mode ?? ''
      if (m && !modes.includes(m)) modes.push(m)
    }
    return modes
  }, [filtered, modeView])

  /** 自动识别浅色/深色模式（mode 字段或编组命名均可命中）：两者同时存在时固定两列并列展示（浅色列在前、深色列在后），否则并列全部模式 */
  const lightMode = tableModes.find((m) => nameMode(m) === 'light')
  const darkMode = tableModes.find((m) => nameMode(m) === 'dark')
  const hasModePair = !!lightMode && !!darkMode
  const cols: (string | undefined)[] = hasModePair ? [lightMode, darkMode] : tableModes.length ? tableModes : [undefined]

  /** 列头文案：识别为浅色/深色的模式显示本地化名，其余显示原始名 */
  const modeHead = (m: string | undefined): string => {
    if (m === undefined) return t('thValue')
    if (hasModePair && m === lightMode) return t('modeLight')
    if (hasModePair && m === darkMode) return t('modeDark')
    return m
  }

  /** Token 表格平铺行：同名多模式并列（按 基础路径+名称 聚合——剔除编组中的深浅模式段，使 color/light/bg 与 color/dark/bg 并列为同一行的两列；保持导入首次出现序） */
  type TreeRow = { name: string; path: string; byMode: { mode: string; tok: SpecToken }[] }
  const flatRows = useMemo<TreeRow[]>(() => {
    const rows: TreeRow[] = []
    const map = new Map<string, TreeRow>()
    for (const tok of filtered) {
      const mv = modeView.get(tok.id)
      const key = `${mv ? mv.basePath : tok.path}\u0000${tok.name}`
      let row = map.get(key)
      if (!row) {
        row = { name: tok.name, path: mv ? mv.basePath : tok.path, byMode: [] }
        map.set(key, row)
        rows.push(row)
      }
      row.byMode.push({ mode: mv ? mv.mode : (tok.mode ?? ''), tok })
    }
    return rows
  }, [filtered, modeView])

  /** 侧边栏文件夹树节点：seg 为该层文件夹名（Figma 原始命名），total 为含子级的 Token 总数 */
  interface SideNode {
    seg: string
    kids: Map<string, SideNode>
    own: number
    total: number
  }

  /** 按 path 的每一段 "/" 逐层编组为文件夹树（深浅模式段已剔除，与表格基础路径一致；数据源随层级/类别过滤联动） */
  const sideTree = useMemo(() => {
    const src = hasTiers
      ? tierFilter === null
        ? []
        : tokens.filter((t) => (t.tier ?? NO_TIER) === tierFilter)
      : kindFilter === 'all'
        ? []
        : tokens.filter((t) => t.kind === kindFilter)
    const root: SideNode = { seg: '', kids: new Map(), own: 0, total: 0 }
    for (const tok of src) {
      const segs = (modeView.get(tok.id)?.basePath ?? tok.path)
        .split('/')
        .map((s) => s.trim())
        .filter(Boolean)
      let node = root
      for (const seg of segs) {
        let kid = node.kids.get(seg)
        if (!kid) {
          kid = { seg, kids: new Map(), own: 0, total: 0 }
          node.kids.set(seg, kid)
        }
        node = kid
      }
      node.own += 1
    }
    const fill = (n: SideNode): number => {
      n.total = n.own + [...n.kids.values()].reduce((s, k) => s + fill(k), 0)
      return n.total
    }
    for (const kid of root.kids.values()) fill(kid)
    return root
  }, [tokens, hasTiers, tierFilter, kindFilter, modeView])

  /** 折叠的文件夹（全路径 key），缺省全展开 */
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleFolder = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  /** 引用 Token 弹层：点击引用名后展示完整引用链 + 解析出的实际值（色值） */
  const [refPop, setRefPop] = useState<{ tok: SpecToken; x: number; y: number } | null>(null)

  /** 引用链叶子名（{Light.Primitives.color.blue} / Primitives.color.blue → blue） */
  const refLeaf = (ref: string): string => {
    const segs = ref.split(/[./]/).filter(Boolean)
    return segs.length ? segs[segs.length - 1] : ref
  }

  /** 取一行在指定模式列的 token；无命中时无模式 Token 视为模式无关值回填首列（浅色/唯一值列） */
  const modeCell = (row: { byMode: { mode: string; tok: SpecToken }[] }, m: string | undefined): SpecToken | undefined => {
    if (m === undefined) return row.byMode[0]?.tok
    const hit = row.byMode.find((e) => e.mode === m)
    if (hit) return hit.tok
    const bare = row.byMode.find((e) => e.mode === '')
    return bare && m === cols[0] ? bare.tok : undefined
  }

  /** 表格网格：名称列 + N 个模式值列（无模式信息时退化为单值列） */
  const tokGridCols = {
    gridTemplateColumns: `minmax(130px, 1.15fr) repeat(${cols.length}, minmax(96px, 1fr))`
  }

  /** 参与导出的 Token：排除启发式来源（不作为规范基准）与损坏值 */
  const exportList = useMemo<ExportToken[]>(
    () =>
      tokens
        .filter((tok) => tok.source !== 'heuristic')
        .map((tok) => ({ kind: tok.kind, name: tok.name, path: tok.path, value: parseTokenValue(tok.value) }))
        .filter((tok): tok is ExportToken => tok.value !== undefined),
    [tokens]
  )

  /** 连接状态三态：有 file key + PAT → 正常；有 key 无 PAT → 缺 Token；无 → 未连接 */
  const connState = !activeSpec?.figmaFileKey ? 'none' : hasPat ? 'ok' : 'nopat'

  const archiveName = activeSpec?.figArchivePath?.split(/[\\/]/).pop()

  // ───────────── 处理函数 ─────────────
  const handleVerify = async () => {
    if (!activeSpec) return
    const url = urlDraft.trim()
    const key = url ? extractFigmaFileKey(url) : null
    if (!key) {
      setVerifyMsg({ ok: false, text: t('linkInvalid') })
      return
    }
    await db.designSpecs.update(activeSpec.id, { figmaUrl: url, figmaFileKey: key, updatedAt: Date.now() })
    setVerifyMsg({ ok: true, text: t('linkVerified') })
  }

  /** 导入前询问模式：无历史版本直接叠加；有历史弹窗让用户选「清空重导 / 去重叠加 / 取消」 */
  const askImportMode = (): Promise<SpecImportMode | null> => {
    if (!versions?.length) return Promise.resolve('merge')
    return new Promise((resolve) => {
      setModeAsk(() => (mode: SpecImportMode | null) => {
        setModeAsk(null)
        resolve(mode)
      })
    })
  }

  const handleSync = async () => {
    if (!activeSpec || syncing) return
    const mode = await askImportMode()
    if (!mode) return
    setSyncing(true)
    setSyncOk(null)
    setSyncErr(null)
    try {
      const res = await syncSpecFromFigma(activeSpec, { mode })
      if (res.variableDenied) {
        // 变量级 403（无变量读取权限，Enterprise 专属）：询问是否改同步样式
        if (window.confirm(t('variableDeniedAsk'))) {
          setSyncOk(await syncSpecFromFigma(activeSpec, { mode, startLevel: 'style' }))
        } else {
          setSyncErr(t('variableDeniedCancel'))
        }
      } else {
        setSyncOk(res)
      }
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : String(e))
    } finally {
      setSyncing(false)
    }
  }

  const handleUploadFig = async () => {
    if (!activeSpec) return
    const res = await window.electronAPI.specImportFig()
    if (res) await db.designSpecs.update(activeSpec.id, { figArchivePath: res.relativePath })
  }

  const handleRollback = async (v: SpecVersion) => {
    if (!activeSpec || !window.confirm(t('rollbackConfirm', { no: v.no }))) return
    setSyncOk(null)
    setSyncErr(null)
    try {
      setSyncOk(await rollbackSpecVersion(activeSpec.id, v.id))
      setShowHist(false)
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 删除历史版本（当前生效版本不可删；版本与 Token 一并移除） */
  const handleDeleteVersion = async (v: SpecVersion) => {
    if (!activeSpec || !window.confirm(t('deleteVerConfirm', { no: v.no }))) return
    setSyncOk(null)
    setSyncErr(null)
    try {
      await deleteSpecVersion(activeSpec.id, v.id)
    } catch (e) {
      setSyncErr(e instanceof Error ? e.message : String(e))
    }
  }

  /** 页头「导出 Token」下拉：选格式直接生成产物并另存 */
  const handleExport = async (fmt: string) => {
    if (!activeSpec) return
    const f = fmt as ExportFormat
    const meta = EXPORT_FMTS.find((x) => x.key === f)
    if (!meta) return
    if (!exportList.length) {
      setExportMsg({ ok: false, text: t('exportEmpty') })
      return
    }
    const res = await window.electronAPI.saveText(
      exportTokens(exportList, f),
      `${activeSpec.name}.${EXPORT_SUFFIX[f]}`,
      meta.filter
    )
    if (res.ok && res.path) setExportMsg({ ok: true, text: t('exportSaved', { path: res.path }) })
    else setExportMsg({ ok: false, text: t('exportFailed') })
  }

  /** JSON 多文件导入（Primitive / Semantic / Component 三层体系）：跨文件解析别名后按所选模式入库 */
  const handleImportJsonFiles = async (files: File[]) => {
    if (!activeSpec || !files.length) return
    const mode = await askImportMode()
    if (!mode) return
    setImporting(true)
    setImportMsg(null)
    try {
      const parsed = parseVariablesJsonBundle(
        await Promise.all(files.map(async (f) => ({ text: await f.text(), name: f.name })))
      )
      const res = await importSpecTokensFromJson(activeSpec, parsed, { mode })
      setImportMsg({ ok: true, text: t('importDone', { no: res.versionNo, count: res.tokenCount }) })
    } catch (e) {
      setImportMsg({ ok: false, text: `${t('importFailed')}：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setImporting(false)
    }
  }

  /** 绑定：清除该项目在本分类内的旧绑定，再绑当前规范 */
  const bindSpec = async (projectId: string) => {
    if (!specId) return
    await db.projectSpecBindings.where('projectId').equals(projectId).filter((b) => catSpecIds.has(b.specId)).delete()
    await db.projectSpecBindings.add({ id: genId(), projectId, specId, createdAt: Date.now() })
  }

  const unbindSpec = async (projectId: string) => {
    if (!specId) return
    await db.projectSpecBindings.where('projectId').equals(projectId).filter((b) => b.specId === specId).delete()
  }

  const handleCopyTok = async (tok: SpecToken) => {
    const v = parseTokenValue(tok.value)
    if (!v) return
    await navigator.clipboard.writeText(fmtValue(v))
    setCopiedId(tok.id)
    setTimeout(() => setCopiedId((cur) => (cur === tok.id ? '' : cur)), 1500)
  }

  const handleDeleteSpec = async () => {
    if (!activeSpec) return
    if (!window.confirm(t('deleteSpecConfirm', { name: activeSpec.name }))) return
    await deleteSpecCascade(activeSpec.id)
    setEditing(null)
  }

  // ───────────── 守卫（均在 hooks 之后） ─────────────
  if (!categories) return <div className="page" />
  if (legacySpec)
    return <Navigate to={`/specs/${legacySpec.categoryId}/spec/${legacySpec.id}`} replace />
  if (!category) return <Navigate to="/specs" replace />
  if (!activeSpec) return <Navigate to={`/specs/${categoryId}`} replace />

  const connText =
    connState === 'ok' ? t('connOk') : connState === 'nopat' ? t('connNoPat') : t('connNone')

  /** 递归渲染侧边栏文件夹树：点箭头折叠/展开，点名称过滤该文件夹（含子级），再点取消过滤 */
  const renderSideTree = (node: SideNode, depth: number, parentKey: string): ReactNode[] => {
    const out: ReactNode[] = []
    for (const kid of node.kids.values()) {
      const key = parentKey ? `${parentKey}/${kid.seg}` : kid.seg
      const open = !collapsed.has(key)
      out.push(
        <div className="specx-pnode" key={key} style={{ paddingLeft: depth * 12 }}>
          {/* 最后一级（无子文件夹）不渲染展开箭头，仅占位保持名称对齐 */}
          {kid.kids.size > 0 ? (
            <button
              type="button"
              className={`specx-pnode-caret${open ? '' : ' closed'}`}
              aria-label={open ? 'collapse' : 'expand'}
              onClick={() => toggleFolder(key)}
            >
              <svg width="10" height="10" viewBox="0 0 10 10">
                <path
                  d="M3 1.5 6.5 5 3 8.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.4"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          ) : (
            <i className="specx-pnode-gap" aria-hidden />
          )}
          <button
            type="button"
            className={`specx-pnode-name${pathFilter === key ? ' active' : ''}`}
            title={key}
            onClick={() => setPathFilter(pathFilter === key ? null : key)}
          >
            <span className="specx-kind-label">{kid.seg}</span>
            <i>{kid.total}</i>
          </button>
        </div>
      )
      if (open) out.push(...renderSideTree(kid, depth + 1, key))
    }
    return out
  }

  return (
    <div className="page specx-page">
      {/* 顶部横幅：返回端分类总览 + 规范名（悬停显示编辑/删除）+ 导出/同步（与项目详情横幅统一） */}
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          <Link to={`/specs/${categoryId}`} className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t('backToCat')}
          </Link>
          <h1 className="rv2-title detail-title">
            <span className="specx-hero-ico" aria-hidden>
              <SpecPlatIcon platformKey={category.platformKey} />
            </span>
            <span className="detail-title-text">{activeSpec.name}</span>
            {/* 悬停显示：编辑 / 删除（原规范来源卡右上角操作移至此处，与项目横幅交互一致） */}
            <button className="title-edit-btn" onClick={() => setEditing(activeSpec)} title={t('editSpec')}>
              <PencilIcon />
            </button>
            <button className="title-edit-btn is-danger" onClick={() => void handleDeleteSpec()} title={t('deleteSpec')}>
              <TrashIcon />
            </button>
          </h1>
          <div className="detail-meta">
            {applied && (
              <span className="specx-pill ok">
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M20 6 9 17l-5-5" />
                </svg>
                {t('applied')}
              </span>
            )}
          </div>
        </div>
        <div className="detail-actions">
          <USelect value="" onChange={(v) => void handleExport(v)} options={EXPORT_FMTS.map((f) => ({ value: f.key, label: t(f.labelKey) }))} placeholder={t('exportToken')} title={t('exportToken')} />
          <button className="btn-primary" disabled={syncing || !activeSpec} onClick={() => void handleSync()}>
            <svg className={`icon-refresh${syncing ? ' spinning' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {t('syncFigma')}
          </button>
        </div>
        <img className="rv2-hero-art" src={heroBannerArtUrl} alt="" draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerArtDarkUrl} alt="" draggable={false} />
      </div>

      {/* 操作结果状态条 */}
      {syncing && <div className="spec-sync-status">{t('syncing')}</div>}
      {!syncing && syncOk && (
        <div className="spec-sync-status ok">
          {t('syncDone')} · V{syncOk.versionNo} · {syncOk.tokenCount} {t('tokensLabel')} · {syncOk.summary}
          {syncOk.sourceLevel ? ` · ${t(`source_${syncOk.sourceLevel}`)}` : ''}
        </div>
      )}
      {!syncing && syncErr && (
        <div className="spec-sync-status err">
          {t('syncFailed')}：{syncErr}
        </div>
      )}
      {exportMsg && <div className={`spec-sync-status ${exportMsg.ok ? 'ok' : 'err'}`}>{exportMsg.text}</div>}
      {/* 降级透明化：变量解析未达成时明示降级原因与建议（不再静默兜底改名） */}
      {!syncing && !!syncOk?.degraded?.length && (
        <div className="spec-sync-status warn">
          <b className="specx-degrade-title">{t('degradeTitle')}</b>
          {syncOk.degraded.map((d, i) => (
            <span className="specx-degrade-item" key={i}>
              · [{t(`source_${d.level}`)}] {d.reason}
              {d.hint ? ` — ${d.hint}` : ''}
            </span>
          ))}
        </div>
      )}

      {!activeSpec ? (
        /* 空态：分类下无规范 */
        <div className="card specx-empty">
          <h3>{t('emptyCategoryTitle')}</h3>
          <p>{t('emptyCategoryDesc')}</p>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            {t('newSpec')}
          </button>
        </div>
      ) : (
        <>
          <div className="specx-topgrid">
            {/* 规范来源卡（编辑/删除入口已移至顶部横幅标题悬停） */}
            <div className="card specx-card">
              <div className="specx-card-head">
                <div className="specx-card-titles">
                  <h3>{t('srcTitle')}</h3>
                  <p>{t('srcDesc')}</p>
                </div>
                {/* 分段切换：Figma 链接 | 上传 .fig（置于卡片头右上角） */}
                <div className="specx-segtabs">
                  <button type="button" className={srcTab === 'url' ? 'active' : ''} onClick={() => setSrcTab('url')}>
                    {t('srcTabUrl')}
                  </button>
                  <button type="button" className={srcTab === 'fig' ? 'active' : ''} onClick={() => setSrcTab('fig')}>
                    {t('srcTabFig')}
                  </button>
                  <button type="button" className={srcTab === 'json' ? 'active' : ''} onClick={() => setSrcTab('json')}>
                    {t('srcTabJson')}
                  </button>
                </div>
              </div>

              {srcTab === 'url' ? (
                <div className="specx-urlwrap">
                  <div className="specx-urlrow">
                    <span className="specx-url-ico" aria-hidden>
                      <svg width="13" height="13" viewBox="0 0 38 57" fill="none">
                        <path d="M19 28.5a9.5 9.5 0 1 1 9.5 9.5H19v-9.5Z" fill="#1ABCFE" />
                        <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0Z" fill="#0ACF83" />
                        <path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19Z" fill="#FF7262" />
                        <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5Z" fill="#F24E1E" />
                        <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5Z" fill="#A259FF" />
                      </svg>
                    </span>
                    <input
                      className="input"
                      value={urlDraft}
                      placeholder={t('specUrlPlaceholder')}
                      onChange={(e) => {
                        setUrlDraft(e.target.value)
                        setVerifyMsg(null)
                      }}
                    />
                    <button className="btn-secondary" onClick={() => void handleVerify()}>
                      {t('verifyLink')}
                    </button>
                  </div>
                  {verifyMsg && <div className={`specx-verify ${verifyMsg.ok ? 'ok' : 'err'}`}>{verifyMsg.text}</div>}
                </div>
              ) : srcTab === 'fig' ? (
                <div className="specx-figrow">
                  <button className="btn-secondary" onClick={() => void handleUploadFig()}>
                    {t('uploadFig')}
                  </button>
                  <span className="specx-figname" title={archiveName ?? ''}>
                    {archiveName ? `${t('archiveLabel')} · ${archiveName}` : t('figArchiveNone')}
                  </span>
                </div>
              ) : (
                <div className="specx-figrow">
                  <input
                    ref={jsonInputRef}
                    type="file"
                    accept=".json,application/json"
                    multiple
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const files = e.target.files ? [...e.target.files] : []
                      if (files.length) void handleImportJsonFiles(files)
                      e.target.value = ''
                    }}
                  />
                  <button className="btn-secondary" disabled={importing} onClick={() => jsonInputRef.current?.click()}>
                    {importing ? t('importing') : t('importJsonBtn')}
                  </button>
                  <span className="specx-figname">{t('importJsonDesc')}</span>
                  {importMsg && <div className={`specx-verify ${importMsg.ok ? 'ok' : 'err'}`}>{importMsg.text}</div>}
                </div>
              )}

              {/* 连接状态卡 */}
              <div className={`specx-conn ${connState}`}>
                <span className="specx-conn-logo" aria-hidden>
                  DS
                </span>
                <div className="specx-conn-main">
                  <b>{activeSpec.figFileName || activeSpec.name}</b>
                  <span>{latest ? `V${latest.no} · ${tokens.length} ${t('tokensLabel')}` : t('neverSynced')}</span>
                </div>
                <span className="specx-conn-state">● {connText}</span>
              </div>
            </div>

            {/* 当前版本卡 */}
            <div className="card specx-card specx-vercard">
              <div className="specx-card-head">
                <div className="specx-card-titles">
                  <h3>{t('verTitle')}</h3>
                </div>
                {latest ? <span className="specx-pill ok">{t('verLatest')}</span> : <span className="specx-pill gray">{t('verNone')}</span>}
              </div>
              {/* 版本号可点击查看历史版本（原「查看历史版本」按钮移除） */}
              <button
                type="button"
                className="specx-ver-no"
                onClick={() => setShowHist(true)}
                title={t('viewHistory')}
              >
                {latest ? `V${latest.no}` : '—'}
              </button>
              <div className="specx-ver-stats">
                <div className="specx-ver-stat">
                  <b>{tokens.length}</b>
                  <span>{t('statTokens')}</span>
                </div>
                <div className="specx-ver-stat">
                  <b>{versions?.length ?? 0}</b>
                  <span>{t('statVersions')}</span>
                </div>
                <div className="specx-ver-stat">
                  <b>{boundCount}</b>
                  <span>{t('statProjects')}</span>
                </div>
              </div>
              <div className="specx-ver-info">
                <div>
                  <span>{t('lastSync')}</span>
                  <b>{latest ? fmtTime(latest.syncedAt) : t('neverSynced')}</b>
                </div>
              </div>
            </div>
          </div>

          {/* Design Token 卡 */}
          <div className="card specx-card">
            <div className="specx-card-head">
              <div className="specx-card-titles">
                <h3>{t('tokenTitle')}</h3>
                <p>{t('tokenDesc')}</p>
              </div>
              <div className="specx-headtools">
                <input
                  className="input specx-search"
                  placeholder={t('searchTokens')}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
            </div>
            {!latest ? (
              <div className="empty-state">
                <p>{t('emptyTokens')}</p>
              </div>
            ) : (
              <div className="specx-tokgrid">
                {/* 左栏分类：三层体系数据按层级（Primitive/Semantic/Component）分组，否则按类别（color/…）分组 */}
                <div className="specx-kinds">
                  {hasTiers ? (
                    <>
                      <button
                        type="button"
                        className={tierFilter === null ? 'active' : ''}
                        onClick={() => {
                          setTierFilter(null)
                          setPathFilter(null)
                        }}
                      >
                        <span className="specx-kind-label">{t('tokenAll')}</span>
                        <i>{tokens.length}</i>
                      </button>
                      {[...tierCounts.keys()].map((tk) => (
                        <Fragment key={tk || 'no-tier'}>
                          <button
                            type="button"
                            className={[
                              tierFilter === tk ? 'active' : '',
                              tierFilter === tk && tierPaths.length ? 'has-kids' : '',
                              tierFilter === tk && tierPaths.length && !kidsOpen ? 'closed' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() => selectTier(tk)}
                          >
                            <span className="specx-kind-label" title={tk || undefined}>
                              {tk || t('noTier')}
                            </span>
                            <i>{tierCounts.get(tk) ?? 0}</i>
                          </button>
                          {/* 层级下的分组子列表（按 "/" 分层文件夹树）：点层级默认展开，点文件夹只看该组（含子级） */}
                          {tk === tierFilter && kidsOpen && tierPaths.length > 0 && (
                            <div className="specx-kids">{renderSideTree(sideTree, 0, '')}</div>
                          )}
                        </Fragment>
                      ))}
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={kindFilter === 'all' ? 'active' : ''}
                        onClick={() => selectKind('all')}
                      >
                        <span className="specx-kind-label">{t('tokenAll')}</span>
                        <i>{tokens.length}</i>
                      </button>
                      {KINDS.map((k) => (
                        <Fragment key={k}>
                          <button
                            type="button"
                            className={[
                              kindFilter === k ? 'active' : '',
                              kindFilter === k && kindPaths.length ? 'has-kids' : '',
                              kindFilter === k && kindPaths.length && !kidsOpen ? 'closed' : ''
                            ]
                              .filter(Boolean)
                              .join(' ')}
                            onClick={() => selectKind(k)}
                          >
                            <span className="specx-kind-label">
                              <KindIcon kind={k} />
                              {t(`kind_${k}`)}
                            </span>
                            <i>{countByKind.get(k) ?? 0}</i>
                          </button>
                          {/* 分组折叠子列表（按 "/" 分层文件夹树）：点类别默认展开，点文件夹只看该组（含子级） */}
                          {k === kindFilter && kidsOpen && kindPaths.length > 0 && (
                            <div className="specx-kids">{renderSideTree(sideTree, 0, '')}</div>
                          )}
                        </Fragment>
                      ))}
                    </>
                  )}
                </div>
                {/* 右侧表格：名称 + 各模式值平铺列表（浅色/深色同时存在时固定两列并列展示），点色值直接复制；固定 10 行高度，超出滚动 */}
                <div className="specx-toktable">
                  <div className="specx-thead" style={tokGridCols}>
                    <span>{t('thName')}</span>
                    {cols.map((m) => (
                      <span key={m ?? 'value'}>{modeHead(m)}</span>
                    ))}
                  </div>
                  <div className="specx-tbody">
                    {flatRows.map((row) => (
                      <div
                        className="specx-trow"
                        key={`${row.path}\u0000${row.name}`}
                        style={tokGridCols}
                      >
                        <span className="specx-tname" title={row.path ? `${row.path}/${row.name}` : row.name}>
                          {row.name}
                        </span>
                        {cols.map((m) => {
                          const tok = modeCell(row, m)
                          const v = tok ? parseTokenValue(tok.value) : undefined
                          const copied = tok ? copiedId === tok.id : false
                          // 引用 Token：单元格显示被调用的名称，点击弹出引用链与解析值（色值）
                          if (tok?.aliasRef) {
                            return (
                              <span key={m ?? 'value'} className="specx-tvalue">
                                <button
                                  type="button"
                                  className="specx-tref"
                                  title={`${t('refFrom')} ${tok.aliasRef} · ${t('refCellHint')}`}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    setRefPop({ tok, x: e.clientX, y: e.clientY })
                                  }}
                                >
                                  <svg width="10" height="10" viewBox="0 0 10 10">
                                    <path
                                      d="M4 1.5H2.2A1.2 1.2 0 0 0 1 2.7v4.6A1.2 1.2 0 0 0 2.2 8.5h4.6A1.2 1.2 0 0 0 8 7.3V6M6 1h3v3M8.8 1.2 4.8 5.2"
                                      fill="none"
                                      stroke="currentColor"
                                      strokeWidth="1.1"
                                      strokeLinecap="round"
                                      strokeLinejoin="round"
                                    />
                                  </svg>
                                  {refLeaf(tok.aliasRef)}
                                </button>
                              </span>
                            )
                          }
                          return (
                            <span
                              key={m ?? 'value'}
                              className={v ? 'specx-tvalue cpcopy' : 'specx-tvalue'}
                              title={v ? `${fmtValue(v)} · ${t('copyTok')}` : ''}
                              onClick={tok && v ? () => void handleCopyTok(tok) : undefined}
                            >
                              {v?.kind === 'color' && <i className="spec-swatch" style={{ background: v.hex }} />}
                              <code>{v ? (copied ? t('copied') : fmtValue(v)) : '—'}</code>
                            </span>
                          )
                        })}
                      </div>
                    ))}
                    {!filtered.length && <div className="specx-tfoot-empty">{t('noMatchTok')}</div>}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* 项目绑定卡 */}
          <div className="card specx-card">
            <div className="specx-card-head">
              <div className="specx-card-titles">
                <h3>{t('bindTitle')}</h3>
                <p>{t('bindDesc')}</p>
              </div>
            </div>
            {matchedProjects.length === 0 ? (
              <div className="empty-state">
                <p>{t('noProjects')}</p>
              </div>
            ) : (
              <div className="specx-bindgrid">
                {matchedProjects.map((p) => {
                  const mine = (bindingsAll ?? []).some((b) => b.projectId === p.id && b.specId === specId)
                  const otherBinding = (bindingsAll ?? []).find(
                    (b) => b.projectId === p.id && b.specId !== specId && catSpecIds.has(b.specId)
                  )
                  const pillCls = mine ? 'ok' : otherBinding ? 'warn' : 'gray'
                  const pillText = mine ? t('bindBound') : otherBinding ? t('bindOther') : t('bindUnbound')
                  const desc = mine
                    ? t('bindMineDesc')
                    : otherBinding
                      ? t('bindOtherDesc', { name: specNameById.get(otherBinding.specId) ?? '—' })
                      : t('bindNoneDesc')
                  return (
                    <div className="specx-bindcard" key={p.id}>
                      <div className="specx-bind-top">
                        {/* 项目 Logo 与项目列表完全一致（图片/首字符/按 id 散列底色） */}
                        <ProjectLogo project={p} />
                        <b title={p.name}>{p.name}</b>
                        <span className={`specx-pill ${pillCls}`}>{pillText}</span>
                      </div>
                      <p className="specx-bind-desc">{desc}</p>
                      <div className="specx-bind-actions">
                        {mine ? (
                          <button className="btn-secondary" onClick={() => void unbindSpec(p.id)}>
                            {t('unbind')}
                          </button>
                        ) : otherBinding ? (
                          <button className="btn-secondary" onClick={() => void bindSpec(p.id)}>
                            {t('changeSpec')}
                          </button>
                        ) : (
                          <button className="btn-primary" onClick={() => void bindSpec(p.id)}>
                            {t('bindAction')}
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* 导入模式选择弹窗（同步 Figma / JSON 导入共用）：删除原数据需二次确认 */}
      {modeAsk && (
        <div className="spec-hist-mask" onClick={() => { modeAsk(null); }}>
          <div className="spec-mode-modal" onClick={(e) => e.stopPropagation()}>
            <h3>{t('modeAskTitle')}</h3>
            <p className="spec-mode-desc">{t('modeAskDesc')}</p>
            <div className="spec-mode-opts">
              <button
                className="btn-secondary"
                onClick={() => modeAsk('merge')}
              >
                {t('modeMerge')}
                <span className="spec-mode-opt-desc">{t('modeMergeDesc')}</span>
              </button>
              <button
                className="btn-danger"
                onClick={() => {
                  // 删除原数据不可恢复：二次确认
                  if (window.confirm(t('modeReplaceConfirm'))) modeAsk('replace')
                }}
              >
                {t('modeReplace')}
                <span className="spec-mode-opt-desc">{t('modeReplaceDesc')}</span>
              </button>
            </div>
            <button className="btn-text btn-sm spec-mode-cancel" onClick={() => modeAsk(null)}>
              {t('cancel')}
            </button>
          </div>
        </div>
      )}

      {/* 引用 Token 弹层：完整引用链 + 解析出的实际值（色值色块），点击遮罩关闭 */}
      {refPop && (
        <div className="spec-ref-mask" onClick={() => setRefPop(null)}>
          <div
            className="spec-ref-pop"
            style={{
              left: Math.max(8, Math.min(refPop.x, window.innerWidth - 332)),
              top: Math.min(refPop.y + 10, window.innerHeight - 132)
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <span className="spec-ref-label">{t('refFrom')}</span>
            <code className="spec-ref-chain" title={refPop.tok.aliasRef}>
              {refPop.tok.aliasRef}
            </code>
            {(() => {
              const v = parseTokenValue(refPop.tok.value)
              if (!v) return <code className="spec-ref-chain">—</code>
              return (
                <div className="spec-ref-val">
                  {v.kind === 'color' && <i className="spec-swatch" style={{ background: v.hex }} />}
                  <code>{fmtValue(v)}</code>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {/* 历史版本抽屉 */}
      {showHist && activeSpec && (
        <div
          className="spec-hist-mask"
          onClick={() => { setShowHist(false); setHistVerId('') }}
        >
          <div className="spec-hist-drawer" onClick={(e) => e.stopPropagation()}>
            <div className="spec-hist-head">
              <h3>{t('history')}</h3>
              <button
                className="btn-text btn-sm"
                onClick={() => { setShowHist(false); setHistVerId('') }}
              >
                ✕
              </button>
            </div>
            <div className="spec-hist-list">
              {[...(versions ?? [])].sort((a, b) => b.no - a.no).map((v) => (
                <div className={`spec-hist-row${histVerId === v.id ? ' open' : ''}`} key={v.id}>
                  <div
                    className="spec-hist-main"
                    role="button"
                    title={t('verDetailToggle')}
                    onClick={() => setHistVerId(histVerId === v.id ? '' : v.id)}
                  >
                    <svg
                      className="spec-hist-caret"
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.4"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                    <b>V{v.no}</b>
                    {latest?.id === v.id && <span className="spec-hist-current">{t('current')}</span>}
                    <span className="spec-hist-time">{fmtTime(v.syncedAt)}</span>
                  </div>
                  <div className="spec-hist-meta" onClick={() => setHistVerId(histVerId === v.id ? '' : v.id)}>
                    {v.tokenCount} {t('tokensLabel')}
                    {v.summary ? ` · ${v.summary}` : ''}
                  </div>
                  {latest?.id !== v.id && (
                    <div className="spec-hist-acts">
                      <button className="btn-text btn-sm" onClick={() => void handleRollback(v)}>
                        {t('rollback')}
                      </button>
                      <button className="btn-text btn-sm specx-vdel" onClick={() => void handleDeleteVersion(v)}>
                        {t('deleteVer')}
                      </button>
                    </div>
                  )}
                  {/* 版本 Token 详情：点击版本行展开，展示 kind / 名称（含模式）/ 值 */}
                  {histVerId === v.id && (
                    <div className="spec-hist-detail">
                      {(histTokens ?? []).map((tk) => {
                        const pv = parseTokenValue(tk.value)
                        return (
                          <div className="spec-hist-tok" key={tk.id}>
                            <span className={`spec-hist-tok-kind k-${tk.kind}`}>{t(`kind_${tk.kind}`)}</span>
                            <span className="spec-hist-tok-name" title={tk.mode ? `${tk.name} · ${tk.mode}` : tk.name}>
                              {tk.name}
                              {tk.mode ? <i className="spec-hist-tok-mode">{tk.mode}</i> : null}
                            </span>
                            <span className="spec-hist-tok-val" title={pv ? fmtValue(pv) : tk.value}>
                              {pv ? fmtValue(pv) : tk.value}
                            </span>
                          </div>
                        )
                      })}
                      {!histTokens?.length && <div className="spec-hist-tok-empty">{t('verDetailEmpty')}</div>}
                    </div>
                  )}
                </div>
              ))}
              {!versions?.length && <div className="specx-tfoot-empty">{t('neverSynced')}</div>}
            </div>
          </div>
        </div>
      )}

      {/* 规范新建/编辑弹窗 */}
      {creating && <SpecModal categoryId={categoryId} onCancel={() => setCreating(false)} />}
      {editing && <SpecModal categoryId={categoryId} spec={editing} onCancel={() => setEditing(null)} />}
    </div>
  )
}

/**
 * 端分类总览页（/specs/:categoryId）：页头（端图标 + 描述 + 新建规范）+ 该端多套规范的卡片网格，
 * 点击卡片进入 /specs/:categoryId/spec/:specId 规范详情页。
 */
export function SpecsCategoryIndex() {
  const { t } = useTranslation('specsPage')
  const { categoryId = '' } = useParams<{ categoryId: string }>()
  const [creating, setCreating] = useState(false)
  const categories = useLiveQuery(() => db.specCategories.toArray())
  const specs = useLiveQuery(
    () => db.designSpecs.where('categoryId').equals(categoryId).toArray(),
    [categoryId]
  )
  const versionsAll = useLiveQuery(() => db.specVersions.toArray())
  const bindingsAll = useLiveQuery(() => db.projectSpecBindings.toArray())

  const category = useMemo(
    () => (categories ?? []).find((c) => c.id === categoryId),
    [categories, categoryId]
  )
  const sortedSpecs = useMemo(() => [...(specs ?? [])].sort(bySort), [specs])

  /** 每套规范的最新版本 */
  const latestBySpec = useMemo(() => {
    const m = new Map<string, SpecVersion>()
    for (const v of versionsAll ?? []) {
      const cur = m.get(v.specId)
      if (!cur || v.no > cur.no) m.set(v.specId, v)
    }
    return m
  }, [versionsAll])

  /** 每套规范的版本总数 */
  const verCountBySpec = useMemo(() => {
    const m = new Map<string, number>()
    for (const v of versionsAll ?? []) m.set(v.specId, (m.get(v.specId) ?? 0) + 1)
    return m
  }, [versionsAll])

  // ───────────── 守卫（均在 hooks 之后） ─────────────
  if (!categories || !versionsAll || !bindingsAll) return <div className="page" />
  if (!category) return <Navigate to="/specs" replace />

  return (
    <div className="page specx-page specx-catidx">
      {/* 顶部横幅：返回规范中心 + 端分类名 + 新建规范（与项目详情横幅统一） */}
      <div className="rv2-hero detail-hero">
        <div className="rv2-hero-main">
          <Link to="/specs" className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t('backToOverview')}
          </Link>
          <h1 className="rv2-title detail-title">
            <span className="specx-hero-ico" aria-hidden>
              <SpecPlatIcon platformKey={category.platformKey} />
            </span>
            <span className="detail-title-text">
              {category.builtin ? t(`platform_${category.platformKey}`) : category.name}
            </span>
          </h1>
          <p className="specx-hero-desc">
            {category.builtin ? t(`catDesc_${category.platformKey}`) : t('catDescCustom')}
          </p>
        </div>
        <div className="detail-actions">
          <button className="btn-primary" onClick={() => setCreating(true)}>
            + {t('newSpec')}
          </button>
        </div>
        <img className="rv2-hero-art" src={heroBannerCatArtUrl} alt="" draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerCatArtDarkUrl} alt="" draggable={false} />
      </div>

      {/* 该端规范卡片网格 */}
      {sortedSpecs.length === 0 ? (
        <div className="card specx-empty">
          <h3>{t('emptyCategoryTitle')}</h3>
          <p>{t('emptyCategoryDesc')}</p>
          <button className="btn-primary" onClick={() => setCreating(true)}>
            {t('newSpec')}
          </button>
        </div>
      ) : (
        <div className="specx-catgrid">
          {sortedSpecs.map((s) => {
            const latest = latestBySpec.get(s.id)
            // 同步状态：已关联 Figma 且完成过同步（有同步版本/时间）才算正常；仅贴链接未同步显示「未同步」
            const state: CatState = s.figmaFileKey && (latest?.syncedAt || s.lastSyncedAt) ? 'ok' : 'none'
            return (
              <Link key={s.id} to={`/specs/${categoryId}/spec/${s.id}`} className="card specx-catcard">
                <div className="specx-cat-top">
                  <span className="specx-cat-ico" aria-hidden>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="m12 2 10 6-10 6L2 8Z" />
                      <path d="m2 14 10 6 10-6" />
                    </svg>
                  </span>
                  {latest && <span className="specx-pill gray">V{latest.no}</span>}
                </div>
                <b className="specx-cat-name" title={s.name}>
                  {s.name}
                </b>
                <p className="specx-cat-desc" title={s.figFileName ?? ''}>
                  {s.figFileName || t('specNoSource')}
                </p>
                <div className="specx-cat-stats">
                  <span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <circle cx="12" cy="12" r="9" />
                      <path d="M12 7v5l3 3" />
                    </svg>
                    {t('specVerCount', { n: verCountBySpec.get(s.id) ?? 0 })}
                  </span>
                  <i aria-hidden />
                  <span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="3" width="7" height="7" rx="1.5" />
                      <rect x="14" y="3" width="7" height="7" rx="1.5" />
                      <rect x="3" y="14" width="7" height="7" rx="1.5" />
                      <rect x="14" y="14" width="7" height="7" rx="1.5" />
                    </svg>
                    {t('catTokenCount', { n: latest?.tokenCount ?? 0 })}
                  </span>
                </div>
                <div className="specx-cat-foot">
                  <span className={`specx-state is-${state}`}>
                    <i aria-hidden />
                    {t(state === 'ok' ? 'stateOk' : 'stateNotConnected')}
                  </span>
                  <span className="specx-cat-arrow" aria-hidden>
                    ›
                  </span>
                </div>
              </Link>
            )
          })}
        </div>
      )}

      {/* 新建规范弹窗 */}
      {creating && <SpecModal categoryId={categoryId} onCancel={() => setCreating(false)} />}
    </div>
  )
}

/** 分类同步状态：ok 全部已连接 / partial 部分连接 / none 未连接 / empty 无规范 */
type CatState = 'ok' | 'partial' | 'none' | 'empty'

/** 总览页状态 → 文案 key */
const STATE_KEY: Record<CatState, string> = {
  ok: 'stateOk',
  partial: 'statePartial',
  none: 'stateNotConnected',
  empty: 'stateEmpty'
}

/** 检查更新单行状态：update 有更新 / latest 最新 / nosync 未同步 / nokey 未关联 / error 失败 */
type CheckStatus = 'update' | 'latest' | 'nosync' | 'nokey' | 'error'

/** 检查更新结果行 */
type CheckRow = {
  spec: DesignSpec
  cat?: SpecCategory
  status: CheckStatus
  message?: string
  remoteTs?: number
  localTs: number
}

/** 检查更新状态 → pill 样式与文案 key */
const CHECK_STATUS: Record<CheckStatus, { cls: string; key: string }> = {
  update: { cls: 'warn', key: 'statusUpdate' },
  latest: { cls: 'ok', key: 'statusLatest' },
  nosync: { cls: 'gray', key: 'statusNoSync' },
  nokey: { cls: 'gray', key: 'statusNoKey' },
  error: { cls: 'err', key: 'statusError' }
}

/** 总览页时间戳 → 本地短格式（xx/xx HH:mm） */
function fmtShortTime(ts: number): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString(undefined, { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

/** 最近使用规范空态缺省插画（纯 SVG，深浅主题色由 CSS 控制） */
function RecentEmptyArt() {
  return (
    <svg width="150" height="90" viewBox="0 0 200 120" fill="none" aria-hidden>
      {/* 地面光晕 */}
      <ellipse className="re-halo" cx="100" cy="104" rx="66" ry="9" />
      {/* 背面卡片 */}
      <rect className="re-card re-card-back" x="52" y="18" width="72" height="88" rx="8" />
      {/* 正面卡片 */}
      <rect className="re-card" x="66" y="12" width="72" height="88" rx="8" />
      <rect className="re-chip" x="76" y="24" width="18" height="18" rx="5" />
      <rect className="re-line" x="76" y="52" width="52" height="6" rx="3" />
      <rect className="re-line" x="76" y="64" width="38" height="6" rx="3" />
      <rect className="re-line" x="76" y="76" width="46" height="6" rx="3" />
      {/* 新增徽标 */}
      <circle className="re-plus" cx="146" cy="26" r="12" />
      <path d="M146 20v12M140 26h12" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
      {/* 装饰点 */}
      <circle className="re-dot" cx="46" cy="30" r="4" />
      <circle className="re-dot" cx="160" cy="86" r="5" />
      <circle className="re-dot" cx="36" cy="74" r="3" />
    </svg>
  )
}

/** 「规范如何融入走查」三步指引（总览面板与指南弹窗共用） */
function HowStepsList() {
  const { t } = useTranslation('specsPage')
  const steps = [
    {
      ico: (
        <svg width="15" height="15" viewBox="0 0 38 57" fill="none" aria-hidden>
          <path d="M19 28.5a9.5 9.5 0 1 1 9.5 9.5H19v-9.5Z" fill="#1ABCFE" />
          <path d="M0 47.5A9.5 9.5 0 0 1 9.5 38H19v9.5a9.5 9.5 0 1 1-19 0Z" fill="#0ACF83" />
          <path d="M19 0v19h9.5a9.5 9.5 0 1 0 0-19H19Z" fill="#FF7262" />
          <path d="M0 9.5A9.5 9.5 0 0 0 9.5 19H19V0H9.5A9.5 9.5 0 0 0 0 9.5Z" fill="#F24E1E" />
          <path d="M0 28.5A9.5 9.5 0 0 0 9.5 38H19V19H9.5A9.5 9.5 0 0 0 0 28.5Z" fill="#A259FF" />
        </svg>
      ),
      tk: 'howStep1T',
      dk: 'howStep1D'
    },
    {
      ico: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
          <circle cx="6" cy="6" r="2.6" />
          <circle cx="18" cy="6" r="2.6" />
          <circle cx="6" cy="18" r="2.6" />
          <circle cx="18" cy="18" r="2.6" />
        </svg>
      ),
      tk: 'howStep2T',
      dk: 'howStep2D'
    },
    {
      ico: (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      ),
      tk: 'howStep3T',
      dk: 'howStep3D'
    }
  ]
  return (
    <ol className="specx-how-list">
      {steps.map((s, i) => (
        <li key={s.tk}>
          <span className="specx-how-no" aria-hidden>
            {i + 1}
          </span>
          <div className="specx-how-body">
            <div className="specx-how-t">
              <i>{s.ico}</i>
              {t(s.tk)}
            </div>
            <p>{t(s.dk)}</p>
          </div>
        </li>
      ))}
    </ol>
  )
}

/** /specs 总览页：Banner + 端分类卡片 + 最近使用规范 + 三步指引 + 统计条 */
export function SpecsIndex() {
  const { t } = useTranslation('specsPage')
  const navigate = useNavigate()
  const [showGuide, setShowGuide] = useState(false)
  const [newOpen, setNewOpen] = useState(false)
  const [creatingIn, setCreatingIn] = useState('')
  const [checking, setChecking] = useState(false)
  const [checkState, setCheckState] = useState<
    | { phase: 'noPat' }
    | { phase: 'error'; message: string }
    | { phase: 'done'; rows: CheckRow[]; outdated: number }
    | null
  >(null)
  const categories = useLiveQuery(() => db.specCategories.toArray())
  const specsAll = useLiveQuery(() => db.designSpecs.toArray())
  const versionsAll = useLiveQuery(() => db.specVersions.toArray())
  const bindings = useLiveQuery(() => db.projectSpecBindings.toArray())
  const projects = useLiveQuery(() => db.projects.toArray())

  const cats = useMemo(() => [...(categories ?? [])].sort(bySort), [categories])
  const projectName = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.name])), [projects])

  /** 每套规范的最新版本（取版本号最大） */
  const latestBySpec = useMemo(() => {
    const m = new Map<string, SpecVersion>()
    for (const v of versionsAll ?? []) {
      const cur = m.get(v.specId)
      if (!cur || v.no > cur.no) m.set(v.specId, v)
    }
    return m
  }, [versionsAll])

  /** 每个端分类：规范数 / Token 总数 / 同步状态 / 最近同步时间 */
  const catInfo = useMemo(() => {
    const m = new Map<string, { specCount: number; tokenCount: number; state: CatState; lastSync: number }>()
    const byCat = new Map<string, DesignSpec[]>()
    for (const s of specsAll ?? []) {
      const list = byCat.get(s.categoryId) ?? []
      list.push(s)
      byCat.set(s.categoryId, list)
    }
    for (const [cid, list] of byCat) {
      let tokenCount = 0
      let connected = 0
      let lastSync = 0
      for (const s of list) {
        const latest = latestBySpec.get(s.id)
        tokenCount += latest?.tokenCount ?? 0
        if (s.figmaFileKey && (latest?.syncedAt || s.lastSyncedAt)) connected += 1
        const ts = latest?.syncedAt ?? s.lastSyncedAt ?? 0
        if (ts > lastSync) lastSync = ts
      }
      const state: CatState = list.length === 0 ? 'empty' : connected === list.length ? 'ok' : connected > 0 ? 'partial' : 'none'
      m.set(cid, { specCount: list.length, tokenCount, state, lastSync })
    }
    return m
  }, [specsAll, latestBySpec])

  /** 已被项目绑定的端分类（卡片展示「已应用」徽标） */
  const appliedCats = useMemo(() => {
    const catOfSpec = new Map((specsAll ?? []).map((s) => [s.id, s.categoryId]))
    const set = new Set<string>()
    for (const b of bindings ?? []) {
      const cid = catOfSpec.get(b.specId)
      if (cid) set.add(cid)
    }
    return set
  }, [specsAll, bindings])

  /** 最近使用的规范：按最后同步/更新时间取前 5 */
  const recent = useMemo(() => {
    const catById = new Map((categories ?? []).map((c) => [c.id, c]))
    const boundBySpec = new Map<string, string[]>()
    for (const b of bindings ?? []) {
      const name = projectName.get(b.projectId)
      if (!name) continue
      const list = boundBySpec.get(b.specId) ?? []
      list.push(name)
      boundBySpec.set(b.specId, list)
    }
    return [...(specsAll ?? [])]
      .map((s) => {
        const latest = latestBySpec.get(s.id)
        return {
          spec: s,
          cat: catById.get(s.categoryId),
          tokens: latest?.tokenCount ?? 0,
          ts: latest?.syncedAt ?? s.updatedAt,
          projs: boundBySpec.get(s.id) ?? [],
          synced: !!s.figmaFileKey && !!(latest?.syncedAt || s.lastSyncedAt)
        }
      })
      .sort((a, b) => b.ts - a.ts)
      .slice(0, 5)
  }, [categories, specsAll, bindings, projectName, latestBySpec])

  /** 底部统计 */
  const stats = useMemo(() => {
    const specs = specsAll ?? []
    let tokens = 0
    let connected = 0
    for (const s of specs) {
      tokens += latestBySpec.get(s.id)?.tokenCount ?? 0
      if (s.figmaFileKey) connected += 1
    }
    const bound = new Set((bindings ?? []).map((b) => b.projectId))
    return { managed: specs.length, tokens, bound: bound.size, okText: `${connected}/${specs.length}` }
  }, [specsAll, bindings, latestBySpec])

  // ───────────── 守卫（均在 hooks 之后） ─────────────
  if (!categories || !specsAll || !versionsAll || !bindings || !projects) return <div className="page" />

  const catNameOf = (c?: SpecCategory) => (c ? (c.builtin ? t(`platform_${c.platformKey}`) : c.name) : '—')

  /** 检查更新：逐套规范轻量读取 Figma last_modified，与本地最近同步时间比对 */
  const handleCheck = async () => {
    if (checking) return
    setChecking(true)
    try {
      const pat = await getFigmaPat()
      if (!pat) {
        setCheckState({ phase: 'noPat' })
        return
      }
      const list = specsAll ?? []
      const withKey = list.filter((s) => s.figmaFileKey)
      const metas = withKey.length
        ? await window.electronAPI.specCheckUpdates({
            pat,
            fileKeys: withKey.map((s) => s.figmaFileKey as string)
          })
      : []
      const byKey = new Map(metas.map((m) => [m.fileKey, m]))
      const catById = new Map((categories ?? []).map((c) => [c.id, c]))
      const rows: CheckRow[] = list.map((s) => {
        const localTs = latestBySpec.get(s.id)?.syncedAt ?? s.lastSyncedAt ?? 0
        if (!s.figmaFileKey) return { spec: s, cat: catById.get(s.categoryId), status: 'nokey', localTs }
        const meta = byKey.get(s.figmaFileKey)
        if (!meta || !meta.ok)
          return { spec: s, cat: catById.get(s.categoryId), status: 'error', message: meta?.message, localTs }
        if (!localTs)
          return { spec: s, cat: catById.get(s.categoryId), status: 'nosync', remoteTs: meta.lastModified, localTs }
        return meta.lastModified && meta.lastModified > localTs
          ? { spec: s, cat: catById.get(s.categoryId), status: 'update', remoteTs: meta.lastModified, localTs }
          : { spec: s, cat: catById.get(s.categoryId), status: 'latest', remoteTs: meta.lastModified, localTs }
      })
      const order: Record<CheckRow['status'], number> = { update: 0, latest: 1, nosync: 2, nokey: 3, error: 4 }
      rows.sort((a, b) => order[a.status] - order[b.status])
      setCheckState({ phase: 'done', rows, outdated: rows.filter((r) => r.status === 'update').length })
    } catch (e) {
      setCheckState({ phase: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setChecking(false)
    }
  }

  return (
    <div className="page specx-page specx-idx">
      {/* 渐变 Banner：规范中心（参考项目列表横幅：文案居左，指南/新建按钮嵌右上角） */}
      <div className="specx-banner">
        <div className="specx-banner-main">
          {/* 标题/副标题复用项目列表横幅 rv2-title/rv2-desc 样式 */}
          <h1 className="rv2-title">{t('heroTitle')}</h1>
          <p className="rv2-desc">{t('heroDesc')}</p>
          {/* 亮点卡：复用最近访问横幅 rv2-feats 样式，内容对应规范对接三环节 */}
          <div className="rv2-feats">
            <span className="rv2-feat">
              <span className="rv2-feat-icon blue">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M21 12a9 9 0 1 1-2.64-6.36" />
                  <path d="M21 3v6h-6" />
                </svg>
              </span>
              <span>
                <b>{t('featSync')}</b>
                <i>{t('featSyncSub')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon purple">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m12 2 9 4.9-9 4.9-9-4.9L12 2Z" />
                  <path d="m3 11.9 9 4.9 9-4.9" />
                  <path d="m3 16.9 9 4.9 9-4.9" />
                </svg>
              </span>
              <span>
                <b>{t('featToken')}</b>
                <i>{t('featTokenSub')}</i>
              </span>
            </span>
            <span className="rv2-feat">
              <span className="rv2-feat-icon green">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 12l2 2 4-5" />
                  <circle cx="12" cy="12" r="9" />
                </svg>
              </span>
              <span>
                <b>{t('featAudit')}</b>
                <i>{t('featAuditSub')}</i>
              </span>
            </span>
          </div>
        </div>
        {/* 总览页横幅插图：深浅主题双图切换（与项目详情/标注页横幅同范式） */}
        <img className="rv2-hero-art" src={heroBannerGfUrl} alt="" draggable={false} />
        <img className="rv2-hero-art-dark" src={heroBannerGfDarkUrl} alt="" draggable={false} />
        <div className="specx-banner-actions">
          <button className="btn-secondary" onClick={() => setShowGuide(true)}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2Z" />
            </svg>
            {t('guideBtn')}
          </button>
          <button className="btn-secondary" disabled={checking} onClick={() => void handleCheck()}>
            <svg className={`icon-refresh${checking ? ' spinning' : ''}`} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
            {checking ? t('checking') : t('checkUpdate')}
          </button>
          <div className="specx-new">
            <button className="btn-primary" onClick={() => setNewOpen(!newOpen)}>
              + {t('newSpec')}
            </button>
            {newOpen && (
              <>
                <div className="specx-new-mask" onClick={() => setNewOpen(false)} />
                <div className="specx-new-menu">
                  <div className="specx-new-title">{t('pickCatTitle')}</div>
                  {cats.map((c) => (
                    <button
                      key={c.id}
                      className="specx-new-item"
                      onClick={() => {
                        setNewOpen(false)
                        setCreatingIn(c.id)
                      }}
                    >
                      <span className="specx-cat-ico sm" aria-hidden>
                        <SpecPlatIcon platformKey={c.platformKey} />
                      </span>
                      {c.builtin ? t(`platform_${c.platformKey}`) : c.name}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* 端分类卡片 */}
      <div className="specx-catgrid">
        {cats.map((c) => {
          const info = catInfo.get(c.id) ?? { specCount: 0, tokenCount: 0, state: 'empty' as CatState, lastSync: 0 }
          return (
            <Link key={c.id} to={`/specs/${c.id}`} className="card specx-catcard">
              <div className="specx-cat-top">
                <span className="specx-cat-ico" aria-hidden>
                  <SpecPlatIcon platformKey={c.platformKey} />
                </span>
                {appliedCats.has(c.id) && (
                  <span className="specx-pill ok">
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M20 6 9 17l-5-5" />
                    </svg>
                    {t('applied')}
                  </span>
                )}
              </div>
              <b className="specx-cat-name">{c.builtin ? t(`platform_${c.platformKey}`) : c.name}</b>
              <p className="specx-cat-desc">{c.builtin ? t(`catDesc_${c.platformKey}`) : t('catDescCustom')}</p>
              <div className="specx-cat-stats">
                <span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m12 2 10 6-10 6L2 8Z" />
                    <path d="m2 14 10 6 10-6" />
                  </svg>
                  {t('catSpecCount', { n: info.specCount })}
                </span>
                <i aria-hidden />
                <span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <rect x="3" y="3" width="7" height="7" rx="1.5" />
                    <rect x="14" y="3" width="7" height="7" rx="1.5" />
                    <rect x="3" y="14" width="7" height="7" rx="1.5" />
                    <rect x="14" y="14" width="7" height="7" rx="1.5" />
                  </svg>
                  {t('catTokenCount', { n: info.tokenCount })}
                </span>
              </div>
              <div className="specx-cat-foot">
                <span className={`specx-state is-${info.state}`}>
                  <i aria-hidden />
                  {t(STATE_KEY[info.state])}
                </span>
                <span className="specx-cat-arrow" aria-hidden>
                  ›
                </span>
              </div>
            </Link>
          )
        })}
      </div>

      {/* 最近使用的规范 + 三步指引 */}
      <div className="specx-idx-mid">
        <div className="card rv2-card specx-recent">
          <div className="rv2-card-head">
            <span className="rv2-card-title">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <circle cx="12" cy="12" r="9" />
                <path d="M12 7v5l3 2" />
              </svg>
              {t('recentTitle')}
            </span>
            <span className="rv2-card-sub">{t('recentCount', { count: recent.length })}</span>
          </div>
          {/* 表格样式与最近访问页访问记录表一致（rv2-table），仅覆盖为 6 列栅格 */}
          <div className="rv2-table specx-rtable">
            <div className="rv2-table-head">
              <span>{t('thSpec')}</span>
              <span>{t('thProject')}</span>
              <span>{t('thTokenCount')}</span>
              <span>{t('thLastSync')}</span>
              <span>{t('thStatus')}</span>
              <span>{t('thOp')}</span>
            </div>
            {recent.length === 0 && (
              <div className="specx-rempty">
                <RecentEmptyArt />
                <p>{t('recentEmpty')}</p>
              </div>
            )}
            {recent.map(({ spec, cat, tokens, ts, projs, synced: ok }) => {
              const projText = projs.length === 0 ? t('notBound') : projs.length === 1 ? projs[0] : `${projs[0]} +${projs.length - 1}`
              return (
                <div
                  key={spec.id}
                  className="rv2-table-row"
                  onClick={() => cat && navigate(`/specs/${cat.id}/spec/${spec.id}`)}
                >
                  <span className="specx-rname" title={spec.name}>
                    {spec.name}
                  </span>
                  <span className="specx-rproj" title={projText}>
                    {projText}
                  </span>
                  <span>{tokens}</span>
                  <span>{fmtShortTime(ts)}</span>
                  <span>
                    {/* 未绑定项目时状态显示「未绑定」，不显示同步状态 */}
                    <span className={`specx-state is-${projs.length > 0 && ok ? 'ok' : 'none'}`}>
                      <i aria-hidden />
                      {projs.length === 0 ? t('notBound') : ok ? t('stateOk') : t('stateNotConnected')}
                    </span>
                  </span>
                  <span>
                    <button
                      className="btn-text btn-sm"
                      onClick={(e) => {
                        e.stopPropagation()
                        if (cat) navigate(`/specs/${cat.id}/spec/${spec.id}`)
                      }}
                    >
                      {t('viewAction')}
                    </button>
                  </span>
                </div>
              )
            })}
          </div>
        </div>
        <div className="card specx-how">
          <h3>{t('howTitle')}</h3>
          <HowStepsList />
        </div>
      </div>

      {/* 底部统计条 */}
      <div className="specx-statrow">
        <div className="card specx-stat">
          <span className="specx-stat-ico" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="m12 2 10 6-10 6L2 8Z" />
              <path d="m2 14 10 6 10-6" />
            </svg>
          </span>
          <div>
            <b>{String(stats.managed).padStart(2, '0')}</b>
            <span>{t('statManaged')}</span>
          </div>
        </div>
        <div className="card specx-stat">
          <span className="specx-stat-ico" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="7" height="7" rx="1.5" />
              <rect x="14" y="3" width="7" height="7" rx="1.5" />
              <rect x="3" y="14" width="7" height="7" rx="1.5" />
              <rect x="14" y="14" width="7" height="7" rx="1.5" />
            </svg>
          </span>
          <div>
            <b>{stats.tokens}</b>
            <span>{t('statTokensAll')}</span>
          </div>
        </div>
        <div className="card specx-stat">
          <span className="specx-stat-ico" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
          </span>
          <div>
            <b>{String(stats.bound).padStart(2, '0')}</b>
            <span>{t('statBound')}</span>
          </div>
        </div>
        <div className="card specx-stat">
          <span className="specx-stat-ico" aria-hidden>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 12a9 9 0 1 1-2.64-6.36" />
              <path d="M21 3v6h-6" />
            </svg>
          </span>
          <div>
            <b>{stats.okText}</b>
            <span>{t('statNormal')}</span>
          </div>
        </div>
      </div>

      {/* 规范使用指南弹窗 */}
      {showGuide && (
        <div className="modal-mask" onClick={() => setShowGuide(false)}>
          <div className="modal specx-guide" onClick={(e) => e.stopPropagation()}>
            <h3>{t('guideTitle')}</h3>
            <p className="specx-guide-intro">{t('guideIntro')}</p>
            <HowStepsList />
            <div className="specx-guide-tip">{t('guideExportTip')}</div>
            <div className="specx-guide-foot">
              <button className="btn-primary" onClick={() => setShowGuide(false)}>
                {t('gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 检查更新结果弹窗 */}
      {checkState && (
        <div className="modal-mask" onClick={() => setCheckState(null)}>
          <div className="modal specx-check" onClick={(e) => e.stopPropagation()}>
            <h3>{t('checkTitle')}</h3>
            {checkState.phase === 'noPat' && <p className="specx-check-note">{t('checkNoPat')}</p>}
            {checkState.phase === 'error' && (
              <p className="specx-check-note err">
                {t('checkFailed')}：{checkState.message}
              </p>
            )}
            {checkState.phase === 'done' &&
              (checkState.rows.length === 0 ? (
                <p className="specx-check-note">{t('checkNoSpecs')}</p>
              ) : (
                <>
                  <p className="specx-check-sum">
                    {checkState.outdated > 0
                      ? t('checkSomeOutdated', { n: checkState.outdated })
                      : t('checkAllLatest', { n: checkState.rows.length })}
                  </p>
                  <div className="specx-check-list">
                    <div className="specx-check-row is-head">
                      <span>{t('thSpec')}</span>
                      <span>{t('thCat')}</span>
                      <span>{t('thCheckStatus')}</span>
                      <span>{t('thLocalSync')}</span>
                      <span>{t('thRemoteMod')}</span>
                      <span>{t('thOp')}</span>
                    </div>
                    {checkState.rows.map(({ spec, cat, status, remoteTs, localTs }) => (
                      <div className="specx-check-row" key={spec.id}>
                        <span className="specx-rname" title={spec.name}>
                          {spec.name}
                        </span>
                        <span className="specx-rproj" title={catNameOf(cat)}>
                          {catNameOf(cat)}
                        </span>
                        <span>
                          <span className={`specx-pill ${CHECK_STATUS[status].cls}`}>
                            {t(CHECK_STATUS[status].key)}
                          </span>
                        </span>
                        <span>{localTs ? fmtShortTime(localTs) : '—'}</span>
                        <span>{remoteTs ? fmtShortTime(remoteTs) : '—'}</span>
                        <span>
                          {status === 'update' && cat && (
                            <button
                              className="btn-text btn-sm"
                              onClick={() => {
                                setCheckState(null)
                                navigate(`/specs/${cat.id}/spec/${spec.id}`)
                              }}
                            >
                              {t('goSync')}
                            </button>
                          )}
                        </span>
                      </div>
                    ))}
                  </div>
                </>
              ))}
            <div className="specx-guide-foot">
              <button className="btn-primary" onClick={() => setCheckState(null)}>
                {t('gotIt')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 新建规范（先选端分类） */}
      {creatingIn && <SpecModal categoryId={creatingIn} onCancel={() => setCreatingIn('')} />}
    </div>
  )
}
