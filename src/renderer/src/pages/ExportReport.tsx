import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link, useNavigate } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  db,
  genId,
  Category,
  CATEGORY_LABELS,
  ISSUE_STATUS_LABELS,
  SEVERITY_LABELS,
  PLATFORM_LABELS,
  SHAPE_LABELS
} from '../db'

interface ReportIssue {
  id: string
  no: number
  shape: string
  targetImage: string
  x: number
  y: number
  width: number
  height: number
  description: string
  severity: string
  severityLabel: string
  categoryLabel: string
  status: string
  statusLabel: string
  targetLabel: string
  shapeLabel: string
  fixStatus?: string
  /** 自定义标注颜色（hex），缺省按严重度着色 */
  color?: string
  /** AI 结构化修复建议 */
  aiSuggestion?: { current: string; fix: string; properties?: string }
  /** 分类 key（用于分析图表配色） */
  category: string
  /** 问题来源：结构化比对 / 视觉比对 / 手动标注 */
  sourceLabel: string
  /** 所属图片集：manual 手动上传 / walk 自动走查（缺省视为 manual） */
  imgSet?: string
}

const CAT_COLORS: Record<string, string> = {
  spacing: '#2563eb',
  typography: '#7c3aed',
  color: '#f59e0b',
  style: '#dc2626',
  interaction: '#06b6d4',
  compatibility: '#16a34a'
}

const SEV_COLORS: Record<string, string> = { major: '#dc2626', minor: '#f59e0b', suggestion: '#64748b' }

/** 生成报告内嵌的 AI 分析区：分类环形图 + 严重度柱状图 + 结构化修复建议 */
type TranslateFn = (key: string, options?: Record<string, unknown>) => string
function buildAnalysisHtml(issues: ReportIssue[], t: TranslateFn): string {
  const esc = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  if (issues.length === 0) return ''

  // 分类环形图（SVG stroke-dasharray 分段，-90° 起始）
  const catCount: Record<string, number> = {}
  issues.forEach((i) => {
    catCount[i.category] = (catCount[i.category] ?? 0) + 1
  })
  const catEntries = Object.entries(catCount).sort((a, b) => b[1] - a[1])
  const C = 2 * Math.PI * 45
  let cum = 0
  const segs = catEntries
    .map(([cat, n]) => {
      const len = (n / issues.length) * C
      const seg = `<circle cx="60" cy="60" r="45" fill="none" stroke="${CAT_COLORS[cat] ?? '#98a2b3'}" stroke-width="16" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-cum).toFixed(2)}"/>`
      cum += len
      return seg
    })
    .join('')
  const donut =
    `<svg width="118" height="118" viewBox="0 0 120 120" style="flex-shrink:0">` +
    `<g transform="rotate(-90 60 60)">${segs}<circle cx="60" cy="60" r="34" fill="#f9fafb"/></g>` +
    `<text x="60" y="58" text-anchor="middle" font-size="19" font-weight="700" fill="#1f2937">${issues.length}</text>` +
    `<text x="60" y="74" text-anchor="middle" font-size="9" fill="#667085">${t('analysis.issuesUnit')}</text></svg>`
  const legend = catEntries
    .map(
      ([cat, n]) =>
        `<div class="legend-row"><span class="legend-dot" style="background:${CAT_COLORS[cat] ?? '#98a2b3'}"></span>` +
        `<span class="legend-name">${esc(CATEGORY_LABELS[cat as Category] ?? cat)}</span>` +
        `<span class="legend-val">${n} · ${Math.round((n / issues.length) * 100)}%</span></div>`
    )
    .join('')

  // 严重度横向柱状图
  const sevOrder = ['major', 'minor', 'suggestion']
  const sevCount: Record<string, number> = { major: 0, minor: 0, suggestion: 0 }
  issues.forEach((i) => {
    if (sevCount[i.severity] !== undefined) sevCount[i.severity]++
  })
  const maxSev = Math.max(...Object.values(sevCount), 1)
  const bars = sevOrder
    .map(
      (s) =>
        `<div class="bar-row"><span class="bar-label">${esc(SEVERITY_LABELS[s as keyof typeof SEVERITY_LABELS])}</span>` +
        `<div class="bar-track"><div class="bar-fill" style="width:${Math.max((sevCount[s] / maxSev) * 100, sevCount[s] > 0 ? 4 : 0).toFixed(1)}%;background:${SEV_COLORS[s]}"></div></div>` +
        `<span class="bar-count">${sevCount[s]}</span></div>`
    )
    .join('')

  // 结构化修复建议（仅统计已采纳的 AI 建议）
  const sugIssues = issues.filter((i) => i.aiSuggestion)
  const sugHtml = sugIssues.length
    ? `<div class="sug-list">${sugIssues
        .map((i) => {
          const s = i.aiSuggestion!
          return (
            `<div class="sug-item"><span class="sug-no" style="background:${i.color || SEV_COLORS[i.severity] || '#2563eb'}">${i.no}</span>` +
            `<div class="sug-body"><div class="sug-title">${esc(i.description)}</div>` +
            `<div class="sug-row"><span class="sug-key">${t('analysis.sugCurrent')}</span><span class="sug-val">${esc(s.current)}</span></div>` +
            `<div class="sug-row"><span class="sug-key fix">${t('analysis.sugFix')}</span><span class="sug-val">${esc(s.fix)}</span></div>` +
            (s.properties
              ? `<div class="sug-row"><span class="sug-key prop">${t('analysis.sugProps')}</span><span class="sug-val mono">${esc(s.properties)}</span></div>`
              : '') +
            `</div></div>`
          )
        })
        .join('')}</div>`
    : `<div class="sug-empty">${t('analysis.sugEmpty')}</div>`

  return (
    `<section class="canvas-card"><div class="canvas-title">${t('analysis.title')}</div><div class="ai-analysis-body">` +
    `<div class="chart-row">` +
    `<div class="chart-block"><div class="chart-block-title">${t('analysis.categoryDist')}</div><div class="donut-wrap">${donut}<div class="donut-legend">${legend}</div></div></div>` +
    `<div class="chart-block"><div class="chart-block-title">${t('analysis.severityDist')}</div>${bars}</div>` +
    `</div>` +
    `<div class="chart-block sug-block"><div class="chart-block-title">${t('analysis.suggestions')}</div>${sugHtml}</div>` +
    `</div></section>`
  )
}

/** 文档导出目标（飞书 / 腾讯文档 / 金山文档，创建后自动打开；文案在组件内按语言包构建） */
type DocTargetKey = 'feishu' | 'tencent' | 'kingsoft'
const DOC_TARGET_KEYS: DocTargetKey[] = ['feishu', 'tencent', 'kingsoft']

export default function ExportReport() {
  const { t } = useTranslation('exportReport')
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
  const navigate = useNavigate()
  const project = useLiveQuery(() => db.projects.get(projectId!), [projectId])
  const page = useLiveQuery(() => db.pages.get(pageId!), [pageId])
  const issues = useLiveQuery(
    () => db.issues.where('pageId').equals(pageId!).toArray(),
    [pageId]
  )

  const [exporting, setExporting] = useState(false)
  const [resultMsg, setResultMsg] = useState<{ type: 'ok' | 'warn' | 'error'; text: string } | null>(
    null
  )
  /** 存在未审核 AI 候选时的继续导出确认弹窗 */
  const [showUnreviewed, setShowUnreviewed] = useState(false)
  /** 确认弹窗后要继续执行的动作 */
  const [pendingAction, setPendingAction] = useState<'export' | 'feishu' | 'tencent'>('export')
  /** 飞书配置是否就绪 */
  const [feishuReady, setFeishuReady] = useState(false)
  const [feishuLoading, setFeishuLoading] = useState(false)
  /** 文档导出目标（飞书 / 腾讯 / 金山） */
  const [docTarget, setDocTarget] = useState<DocTargetKey>('feishu')
  /** 目标按钮文案（按当前语言构建） */
  const docTargets = DOC_TARGET_KEYS.map((key) => ({
    key,
    label: t(`docTarget.${key}.label`),
    btn: t(`docTarget.${key}.btn`),
    name: t(`docTarget.${key}.name`)
  }))

  // 检查飞书配置
  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const f = (cfg.feishu ?? {}) as { appId?: string; appSecret?: string }
      setFeishuReady(!!f.appId && !!f.appSecret)
    })
  }, [])

  /** 生成交互式报告 HTML：图上标注可点击，研发可在报告里回应「已修复 / 无法修复」，全部回应后可导出研发修改报告 */
  const generateReportHTML = async (imgOverride?: {
      design?: string | null
      shot?: string | null
      walkDesign?: string | null
      walkShot?: string | null
    }): Promise<string> => {
    // 手动标注画布用手动上传图；自动走查画布用走查采集图（标注坐标基于各自图，分开渲染防止错位）
    const [rawDesign, rawShot, rawWalkDesign, rawWalkShot] = await Promise.all([
      page?.designImagePath ? window.electronAPI.readImage(page.designImagePath) : null,
      page?.screenshotPath ? window.electronAPI.readImage(page.screenshotPath) : null,
      page?.walkDesignPath ? window.electronAPI.readImage(page.walkDesignPath) : null,
      page?.walkShotPath ? window.electronAPI.readImage(page.walkShotPath) : null
    ])
    // 飞书附件场景传入压缩后的图片，控制 HTML 附件体积（本地导出仍用原图）
    const designImg = imgOverride?.design !== undefined ? imgOverride.design : rawDesign
    const shotImg = imgOverride?.shot !== undefined ? imgOverride.shot : rawShot
    const walkDesignImg = imgOverride?.walkDesign !== undefined ? imgOverride.walkDesign : rawWalkDesign
    const walkShotImg = imgOverride?.walkShot !== undefined ? imgOverride.walkShot : rawWalkShot

    const sorted = [...(issues ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    // 未审核的 AI 候选不计入报告（采纳/编辑后才会进入）
    const reportable = sorted.filter((i) => !(i.isAISuggested && !i.aiConfirmed))
    const reportIssues: ReportIssue[] = reportable.map((issue, idx) => ({
      id: issue.id,
      no: idx + 1,
      shape: issue.shape ?? 'rect',
      targetImage: issue.targetImage,
      x: issue.x,
      y: issue.y,
      width: issue.width,
      height: issue.height,
      description: issue.description,
      severity: issue.severity,
      severityLabel: SEVERITY_LABELS[issue.severity],
      category: issue.category,
      categoryLabel: CATEGORY_LABELS[issue.category],
      status: issue.status,
      statusLabel: ISSUE_STATUS_LABELS[issue.status],
      targetLabel: issue.targetImage === 'design' ? t('design') : t('devScreenshot'),
      shapeLabel: SHAPE_LABELS[issue.shape ?? 'rect'],
      fixStatus: issue.fixStatus,
      color: issue.color,
      aiSuggestion: issue.aiSuggestion,
      sourceLabel:
        issue.source === 'structured'
          ? t('sourceStructured')
          : issue.source === 'visual'
            ? t('sourceVisual')
            : issue.source === 'spec'
              ? t('sourceSpec')
              : issue.source === 'element'
                ? t('sourceElement')
                : issue.source === 'a11y'
                  ? t('sourceA11y')
                  : t('sourceManual'),
      imgSet: issue.imgSet ?? 'manual'
    }))

    // 画布分组：手动标注用手动上传图，自动走查用走查采集图，两版并存时分两个区块展示
    const hasWalk = reportIssues.some((i) => i.imgSet === 'walk')
    const hasManual = reportIssues.some((i) => i.imgSet === 'manual')
    const showManual = hasManual || !hasWalk // 无任何标注 / 无走查标注时保持原有手动双图画布
    const showWalk = hasWalk
    const bothSets = showManual && showWalk

    /** 单个画布卡片（key 决定 img/markers/arrows 的 DOM id，供报告脚本定位） */
    const canvasCard = (key: string, title: string, img: string | null, emptyText: string) => `
      <section class="canvas-card" id="card-${key}">
        <div class="canvas-title">${title}<button class="fs-btn" data-card="card-${key}" onclick="toggleFs('card-${key}')">${t('exportedHtml.fullscreen')}</button></div>
        <div class="rep-canvas" id="canvas-${key}">
          ${img ? `<img id="img-${key}" src="${img}" alt="${title}">` : `<div style="padding:40px;text-align:center;color:#98a2b3">${emptyText}</div>`}
          <svg class="arrow-layer" id="arrows-${key}"></svg>
          <div class="markers" id="markers-${key}"></div>
        </div>
      </section>`

    const manualCanvases = showManual
      ? `<div class="canvas-grid">
          ${canvasCard('md', t('design'), designImg, t('exportedHtml.emptyDesign'))}
          ${canvasCard('ms', t('devScreenshot'), shotImg, t('exportedHtml.emptyShot'))}
        </div>`
      : ''
    const walkCanvases = showWalk
      ? `${bothSets ? `<div class="canvas-group-title">${t('exportedHtml.groupWalk')}</div>` : ''}<div class="canvas-grid">
          ${canvasCard('wd', bothSets ? t('design') : t('exportedHtml.canvasDesignWalk'), walkDesignImg, t('exportedHtml.emptyWalkDesign'))}
          ${canvasCard('ws', bothSets ? t('devScreenshot') : t('exportedHtml.canvasShotWalk'), walkShotImg, t('exportedHtml.emptyWalkShot'))}
        </div>`
      : ''
    const canvasesHtml = `${bothSets && showManual ? `<div class="canvas-group-title">${t('exportedHtml.groupManual')}</div>` : ''}${manualCanvases}${walkCanvases}`

    // 注入 <script> 前转义，防止内容截断脚本标签
    const dataJson = JSON.stringify({
      projectName: project?.name ?? '',
      pageName: page?.pageName ?? '',
      platformLabel: page ? PLATFORM_LABELS[page.platform] : '',
      figmaUrl: page?.figmaUrl ?? '',
      generatedAt: new Date().toLocaleString('zh-CN'),
      issues: reportIssues
    }).replace(/</g, '\\u003c')

    // AI 分析区：分类环形图 + 严重度柱状图 + 修复建议
    const analysisHtml = buildAnalysisHtml(reportIssues, t)

    // 注入报告脚本的运行期文案对象（脚本在浏览器打开报告后才执行，需在生成期固化文案）
    const tJson = JSON.stringify({
      fullscreen: t('exportedHtml.fullscreen'),
      exitFullscreen: t('exportedHtml.exitFullscreen'),
      pickDesign: t('exportedHtml.pickDesign'),
      pickDev: t('exportedHtml.pickDev'),
      labelProject: t('labelProject'),
      labelPage: t('labelPage'),
      labelPlatform: t('labelPlatform'),
      labelDesign: t('labelDesign'),
      labelExportedAt: t('labelExportedAt'),
      openInFigma: t('exportedHtml.openInFigma'),
      exportDevReport: t('exportedHtml.exportDevReport'),
      btnExportUnresponded: t('exportedHtml.btnExportUnresponded'),
      confirmUnresponded: t('exportedHtml.confirmUnresponded'),
      statTotal: t('exportedHtml.statTotal'),
      statPending: t('exportedHtml.statPending'),
      statFixed: t('exportedHtml.statFixed'),
      statBlocked: t('exportedHtml.statBlocked'),
      statDone: t('exportedHtml.statDone'),
      statPendingProcess: t('exportedHtml.statPendingProcess'),
      colDescription: t('exportedHtml.colDescription'),
      colSeverity: t('exportedHtml.colSeverity'),
      colCategory: t('exportedHtml.colCategory'),
      colSource: t('exportedHtml.colSource'),
      colTarget: t('exportedHtml.colTarget'),
      colResponse: t('exportedHtml.colResponse'),
      colResult: t('exportedHtml.colResult'),
      tagUnresponded: t('exportedHtml.tagUnresponded'),
      tagFixed: t('exportedHtml.tagFixed'),
      tagBlocked: t('exportedHtml.tagBlocked'),
      tagDone: t('exportedHtml.tagDone'),
      detailIssueNo: t('exportedHtml.detailIssueNo'),
      detailInfoTitle: t('exportedHtml.detailInfoTitle'),
      detailRespondTitle: t('exportedHtml.detailRespondTitle'),
      detailQuestion: t('exportedHtml.detailQuestion'),
      blockPlaceholder: t('exportedHtml.blockPlaceholder'),
      submit: t('exportedHtml.submit'),
      presetRecheckPassed: t('exportedHtml.presetRecheckPassed'),
      changeResponse: t('exportedHtml.changeResponse'),
      noReason: t('exportedHtml.noReason'),
      alertReasonRequired: t('exportedHtml.alertReasonRequired'),
      devReportHeading: t('exportedHtml.devReportHeading'),
      devReportFooter: t('exportedHtml.devReportFooter')
    }).replace(/</g, '\\u003c')

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(t('exportedHtml.title', { name: page?.pageName ?? '' }))}</title>
<style>
  :root { --primary:#2563eb; --danger:#dc2626; --done:#16a34a; --text:#1f2937; --text2:#667085; --border:#e7eaf0; --bg:#f5f6f8; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif; background:var(--bg); color:var(--text); padding:28px 32px 60px; }
  .wrap { max-width:1100px; margin:0 auto; }
  .rep-header { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; margin-bottom:20px; }
  .rep-header h1 { font-size:22px; font-weight:700; letter-spacing:-0.01em; }
  .meta { color:var(--text2); font-size:13px; margin-top:6px; line-height:1.7; }
  .meta a { color:var(--primary); text-decoration:none; word-break:break-all; }
  .meta a:hover { text-decoration:underline; }
  .stats { display:flex; gap:14px; margin:18px 0 22px; }
  .stat { flex:1; background:#fff; border:1px solid var(--border); border-radius:12px; padding:16px; text-align:center; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .stat .num { font-size:26px; font-weight:700; }
  .stat .num.pend { color:var(--primary); }
  .stat .num.done { color:var(--done); }
  .stat .num.blocked { color:var(--danger); }
  .stat .lbl { font-size:12px; color:var(--text2); margin-top:4px; }
  .canvas-card { background:#fff; border:1px solid var(--border); border-radius:12px; overflow:hidden; margin-bottom:20px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .canvas-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; align-items:start; margin-bottom:24px; }
  .canvas-grid .canvas-card { margin-bottom:0; }
  .canvas-group-title { font-size:15px; font-weight:700; color:var(--text); margin:4px 0 12px; }
  .canvas-title { padding:10px 14px; border-bottom:1px solid var(--border); font-size:12px; font-weight:600; color:var(--text2); display:flex; align-items:center; gap:8px; }
  .canvas-title::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--primary); }
  .rep-canvas { position:relative; background:#f6f7f9; }
  .rep-canvas img { width:100%; display:block; user-select:none; }
  .fs-btn { margin-left:auto; padding:3px 10px; font-size:12px; color:var(--text2); background:#fff; border:1px solid var(--border); border-radius:6px; cursor:pointer; }
  .fs-btn:hover { color:var(--primary); border-color:var(--primary); background:var(--primary-soft); }
  .canvas-card:fullscreen, .canvas-card:-webkit-full-screen { background:#eef1f6; padding:14px; display:flex; flex-direction:column; overflow:auto; }
  .canvas-card:fullscreen .canvas-title, .canvas-card:-webkit-full-screen .canvas-title { border-radius:8px; border:1px solid var(--border); }
  .canvas-card:fullscreen .rep-canvas, .canvas-card:-webkit-full-screen .rep-canvas { flex:1; min-height:0; overflow:auto; background:#fff; border-radius:8px; }
  .rep-canvas svg.arrow-layer { position:absolute; inset:0; width:100%; height:100%; z-index:1; overflow:visible; }
  .markers { position:absolute; inset:0; z-index:2; pointer-events:none; }
  .markers .mk { pointer-events:auto; }
  .hint-bar { font-size:13px; color:var(--text2); background:#fff; border:1px solid var(--border); border-radius:10px; padding:10px 16px; margin-bottom:20px; line-height:1.7; }
  /* 标注标记（--mk-c 同时定义在 .mk 与报告箭头元素上，避免箭头线取不到颜色） */
  .mk { position:absolute; cursor:pointer; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot) { --mk-c:#2563eb; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot).sev-major { --mk-c:#ef4444; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot).sev-minor { --mk-c:#f59e0b; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot).sev-suggestion { --mk-c:#64748b; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot).done { --mk-c:var(--done); }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-arrow-dot).blocked { --mk-c:var(--danger); }
  .mk-box { border:2px solid var(--mk-c); border-radius:3px; background:color-mix(in srgb, var(--mk-c) 6%, transparent); }
  .mk-num { position:absolute; top:-11px; left:-11px; min-width:20px; height:20px; padding:0 5px; border-radius:999px; background:var(--mk-c); color:#fff; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; box-shadow:0 0 0 2px #fff; }
  .mk-pin { width:22px; height:22px; border-radius:50%; background:var(--mk-c); transform:translate(-50%,-50%); display:flex; align-items:center; justify-content:center; box-shadow:0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.25); }
  .mk-pin .mk-num { position:static; box-shadow:none; background:transparent; }
  .mk-label { transform:translateY(-50%); background:rgba(255,255,255,.96); border:1.5px solid var(--mk-c); color:var(--mk-c); border-radius:999px; padding:2px 10px 2px 2px; font-size:12px; font-weight:600; max-width:280px; display:flex; align-items:center; gap:6px; }
  .mk-label .mk-num { position:static; flex-shrink:0; }
  .mk-label .mk-text { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .mk:hover { filter:brightness(1.08); }
  .mk.done .mk-num::after { content:'✓'; margin-left:2px; }
  .mk.blocked .mk-num::after { content:'✕'; margin-left:2px; }
  .rep-arrow { stroke:var(--mk-c); stroke-width:2.5; fill:none; pointer-events:stroke; cursor:pointer; }
  .rep-arrow-head { fill:var(--mk-c); }
  .rep-arrow-dot { fill:var(--mk-c); stroke:#fff; stroke-width:2; }
  .rep-arrow-num { fill:#fff; font-size:11px; font-weight:700; text-anchor:middle; dominant-baseline:central; pointer-events:none; }
  .rep-arrow-hit { stroke:transparent; stroke-width:14; fill:none; pointer-events:stroke; cursor:pointer; }
  /* 测量距离标注 */
  .rep-measure { stroke:var(--mk-c); stroke-width:2; fill:none; }
  .rep-measure-dot { fill:var(--mk-c); stroke:#fff; stroke-width:1.5; }
  .rep-measure-num { fill:var(--mk-c); font-size:11px; font-weight:700; dominant-baseline:central; paint-order:stroke; stroke:#fff; stroke-width:3.5px; pointer-events:none; }
  .rep-measure-label { fill:var(--mk-c); font-size:12.5px; font-weight:700; dominant-baseline:central; paint-order:stroke; stroke:#fff; stroke-width:4px; pointer-events:none; }
  .rep-measure-hit { stroke:transparent; stroke-width:14; fill:none; pointer-events:stroke; cursor:pointer; }
  /* 吸色取样标注 */
  .mk-pick { display:flex; align-items:center; gap:6px; transform:translate(-7px,-50%); background:rgba(255,255,255,.96); border:1.5px solid var(--mk-c); border-radius:999px; padding:2px 10px 2px 3px; font-size:12px; font-weight:600; color:#1f2733; max-width:300px; }
  .mk-pick .mk-num { position:static; flex-shrink:0; }
  .mk-pick-chip { width:16px; height:16px; border-radius:50%; flex-shrink:0; box-shadow:0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,.2); }
  .mk-pick-text { line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 详情面板：右侧抽屉滑出，遮罩淡入淡出；内容按卡片分区 */
  .detail-mask { position:fixed; inset:0; background:rgba(16,24,40,.35); z-index:19; opacity:0; pointer-events:none; transition:opacity .22s ease; }
  .detail-mask.show { opacity:1; pointer-events:auto; }
  .detail-panel { position:fixed; top:0; right:0; bottom:0; width:400px; max-width:92vw; background:#f7f8fa; z-index:20; box-shadow:-8px 0 30px rgba(16,24,40,.14); padding:18px; overflow:auto; transform:translateX(103%); transition:transform .28s cubic-bezier(.22,.61,.36,1); }
  .detail-panel.show { transform:translateX(0); }
  /* 全屏查看时详情改为居中弹窗（不再用右侧抽屉） */
  .detail-panel.as-modal { top:50%; left:50%; right:auto; bottom:auto; width:min(640px,92vw); max-height:86vh; border-radius:16px; box-shadow:0 24px 64px rgba(16,24,40,.32); opacity:0; transform:translate(-50%,-46%); transition:transform .22s ease, opacity .22s ease; }
  .detail-panel.as-modal.show { opacity:1; transform:translate(-50%,-50%); }
  .hidden { display:none !important; }
  .dp-head { display:flex; align-items:flex-start; gap:10px; margin-bottom:14px; }
  .dp-no { width:28px; height:28px; border-radius:9px; color:#fff; font-size:13px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; background:#2563eb; box-shadow:0 1px 3px rgba(16,24,40,.18); }
  .dp-no.sev-major { background:#ef4444; } .dp-no.sev-minor { background:#f59e0b; } .dp-no.sev-suggestion { background:#64748b; }
  .dp-no.done { background:var(--done); } .dp-no.blocked { background:var(--danger); }
  .dp-head-main { flex:1; min-width:0; }
  .dp-head h3 { font-size:15px; line-height:1.5; word-break:break-all; }
  .dp-sub { font-size:12px; color:var(--text2); margin-top:3px; }
  .dp-close { border:none; background:none; font-size:22px; color:#98a2b3; cursor:pointer; line-height:1; flex-shrink:0; }
  .dp-close:hover { color:var(--text); }
  .dp-card { background:#fff; border:1px solid var(--border); border-radius:12px; padding:14px; margin-bottom:12px; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .dp-card-label { font-size:11px; font-weight:600; color:var(--text2); letter-spacing:.02em; margin-bottom:8px; }
  .dp-card:last-child { margin-bottom:0; }
  .dp-meta { display:flex; flex-wrap:wrap; gap:6px; }
  .tag { display:inline-block; padding:2px 9px; border-radius:999px; font-size:12px; font-weight:500; white-space:nowrap; }
  .tag.sev-major { background:#fde8e8; color:#dc2626; } .tag.sev-minor { background:#fef3c7; color:#b45309; } .tag.sev-suggestion { background:#f2f4f8; color:#667085; }
  .tag.plain { background:#f2f4f8; color:#667085; }
  .tag.st-pending { background:#eff4ff; color:#2563eb; }
  .tag.st-fixed { background:#e8f7ee; color:#15803d; }
  .dp-q { font-size:14px; font-weight:600; margin:0 0 10px; }
  .dp-actions { display:flex; gap:10px; }
  .btn { padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; border:1px solid transparent; }
  .btn-primary { background:var(--primary); color:#fff; }
  .btn-primary:hover { background:#1d4ed8; }
  .btn-ghost-danger { background:#fff; color:var(--danger); border-color:#f2c1c1; }
  .btn-ghost-danger:hover { background:#fef2f2; }
  .btn-text { background:none; border:none; color:var(--primary); font-size:13px; cursor:pointer; padding:0; margin-top:12px; }
  .block-form { margin-top:12px; display:flex; flex-direction:column; gap:8px; }
  .block-form textarea { width:100%; min-height:76px; padding:10px; border:1px solid #dfe3ea; border-radius:8px; font-size:13px; font-family:inherit; resize:vertical; outline:none; }
  .block-form textarea:focus { border-color:var(--primary); }
  .block-form .btn { align-self:flex-start; }
  .dp-state { border-radius:10px; padding:12px 14px; font-size:14px; font-weight:600; margin:0 0 4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap; }
  .dp-state.done { background:#e8f7ee; color:#15803d; }
  .dp-state.blocked { background:#fde8e8; color:#dc2626; }
  .dp-time { font-size:12px; font-weight:400; opacity:.8; }
  .dp-reason { font-size:13px; color:var(--text); background:#fafbfd; border:1px solid var(--border); border-radius:8px; padding:10px 12px; margin-top:8px; line-height:1.7; }
  .btn-export { padding:8px 16px; border-radius:8px; font-size:13px; font-weight:500; cursor:pointer; border:1px solid transparent; background:var(--primary); color:#fff; }
  .btn-export:disabled { background:#b8ccf7; cursor:not-allowed; }
  /* 导出确认弹窗 */
  .modal-mask-rc { position:fixed; inset:0; background:rgba(16,24,40,.45); z-index:30; display:flex; align-items:center; justify-content:center; }
  .modal-rc { background:#fff; border-radius:14px; padding:22px 24px; width:380px; max-width:90vw; box-shadow:0 12px 40px rgba(16,24,40,.2); }
  .modal-rc h3 { font-size:16px; margin-bottom:10px; }
  .modal-rc p { font-size:13px; color:var(--text2); line-height:1.7; margin-bottom:18px; }
  .modal-rc-actions { display:flex; gap:10px; justify-content:flex-end; }
  .btn-plain { background:#f2f4f8; color:var(--text); }
  /* 问题明细清单 */
  .issue-table-wrap { background:#fff; border:1px solid var(--border); border-radius:12px; overflow:hidden; box-shadow:0 1px 2px rgba(16,24,40,.04); }
  .issue-table-wrap table { width:100%; border-collapse:collapse; }
  .issue-table-wrap th, .issue-table-wrap td { padding:10px 14px; border-bottom:1px solid var(--border); font-size:13px; text-align:left; vertical-align:top; }
  .issue-table-wrap tr:last-child td { border-bottom:none; }
  .issue-table-wrap th { background:#f9fafb; color:#667085; font-size:12px; font-weight:600; white-space:nowrap; }
  .issue-table-wrap .tag { white-space:nowrap; }
  .issue-table-wrap tbody tr { cursor:pointer; }
  .issue-table-wrap tbody tr:hover { background:#f8faff; }
  .tag.st-wait { background:#f2f4f8; color:#98a2b3; }
  /* AI 报告分析 */
  .ai-analysis-body { padding:16px 14px; }
  .chart-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
  .chart-block { background:#f9fafb; border:1px solid var(--border); border-radius:10px; padding:14px; min-width:0; }
  .chart-block-title { font-size:12px; font-weight:600; color:var(--text2); margin-bottom:12px; }
  .sug-block { margin-top:14px; }
  .donut-wrap { display:flex; align-items:center; gap:18px; }
  .donut-legend { display:flex; flex-direction:column; gap:8px; flex:1; min-width:0; }
  .legend-row { display:flex; align-items:center; gap:8px; font-size:12px; }
  .legend-dot { width:10px; height:10px; border-radius:3px; flex-shrink:0; }
  .legend-name { flex:1; color:var(--text); }
  .legend-val { color:var(--text2); font-weight:600; white-space:nowrap; }
  .bar-row { display:flex; align-items:center; gap:10px; }
  .bar-row + .bar-row { margin-top:14px; }
  .bar-label { width:48px; font-size:12px; color:var(--text2); flex-shrink:0; }
  .bar-track { flex:1; height:14px; background:#eef0f4; border-radius:999px; overflow:hidden; }
  .bar-fill { height:100%; border-radius:999px; }
  .bar-count { width:22px; text-align:right; font-size:12px; font-weight:600; flex-shrink:0; }
  .sug-list { display:flex; flex-direction:column; gap:10px; }
  .sug-item { display:flex; gap:12px; background:#fff; border:1px solid var(--border); border-radius:10px; padding:12px 14px; }
  .sug-no { width:22px; height:22px; border-radius:7px; color:#fff; font-size:12px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
  .sug-body { flex:1; min-width:0; }
  .sug-title { font-size:13px; font-weight:600; margin-bottom:8px; line-height:1.6; }
  .sug-row { display:flex; gap:8px; font-size:12px; line-height:1.7; margin-top:4px; }
  .sug-key { flex-shrink:0; background:#f2f4f8; color:#667085; border-radius:5px; padding:1px 7px; font-weight:600; white-space:nowrap; height:fit-content; }
  .sug-key.fix { background:#eff4ff; color:#2563eb; }
  .sug-key.prop { background:#fef3c7; color:#b45309; }
  .sug-val { flex:1; min-width:0; word-break:break-word; }
  .sug-val.mono { font-family:ui-monospace,Menlo,Consolas,monospace; color:#374151; }
  .sug-empty { font-size:13px; color:var(--text2); line-height:1.7; }
  footer { margin-top:32px; color:#9ca3af; font-size:12px; text-align:center; }
</style>
</head>
<body>
<div class="wrap">
  <div class="rep-header">
    <div>
      <h1>${escapeHtml(t('exportedHtml.title', { name: page?.pageName ?? '' }))}</h1>
      <div class="meta">
        <strong>${t('labelProject')}</strong>${escapeHtml(project?.name ?? '')}　<strong>${t('labelPage')}</strong>${escapeHtml(page?.pageName ?? '')}　<strong>${t('labelPlatform')}</strong>${page ? PLATFORM_LABELS[page.platform] : ''}${page?.figmaUrl ? `　<strong>${t('labelDesign')}</strong><a href="${escapeHtml(page.figmaUrl)}" target="_blank" rel="noreferrer">${t('exportedHtml.openInFigma')}</a>` : ''}
        <br><strong>${t('labelGeneratedAt')}</strong>${new Date().toLocaleString('zh-CN')}
      </div>
    </div>
    <button id="btn-export-summary" class="btn-export" onclick="exportSummary()" title="${t('exportedHtml.exportDevReportTip')}">${t('exportedHtml.exportDevReport')}</button>
  </div>

  <div class="stats" id="stats"></div>

  <div class="hint-bar">${t('exportedHtml.hintBar')}</div>

  ${canvasesHtml}

  <section class="canvas-card">
    <div class="canvas-title">${t('exportedHtml.tableTitle')}</div>
    <div class="issue-table-wrap"><table id="issue-table"></table></div>
  </section>

  ${analysisHtml}

  <footer>${t('exportedHtml.footerGenerated')}</footer>
</div>

<div id="detail-mask" class="detail-mask" onclick="closeDetail()"></div>
<aside id="detail-panel" class="detail-panel"></aside>

<div id="export-confirm" class="modal-mask-rc hidden">
  <div class="modal-rc">
    <h3>${t('exportedHtml.confirmModalTitle')}</h3>
    <p id="export-confirm-text"></p>
    <div class="modal-rc-actions">
      <button class="btn btn-plain" onclick="closeExportConfirm()">${t('exportedHtml.confirmModalBack')}</button>
      <button class="btn btn-primary" onclick="doExportSummary()">${t('exportedHtml.confirmModalContinue')}</button>
    </div>
  </div>
</div>

<script>
var DATA = ${dataJson};
var T = ${tJson};
var responses = {};
try { responses = JSON.parse(localStorage.getItem('ui-wt-responses') || '{}') || {}; } catch (e) { responses = {}; }
var currentId = null;

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function fmtTime(ts) { if (!ts) return ''; var d = new Date(ts); return d.toLocaleString('zh-CN'); }
function save() { try { localStorage.setItem('ui-wt-responses', JSON.stringify(responses)); } catch (e) {} }
function stateOf(i) { var r = responses[i.id]; return r ? r.state : 'none'; }
function stateClass(i) { var s = stateOf(i); return s === 'fixed' ? ' done' : s === 'blocked' ? ' blocked' : ''; }
/** 自定义颜色：仅在未回应/待修复状态生效（已修复、无法修复保持状态色） */
function mkColor(i) { return i.color && !stateClass(i) ? i.color : null; }
function allResponded() { return DATA.issues.length > 0 && DATA.issues.every(function (i) { return !!responses[i.id]; }); }
function findIssue(id) { for (var k = 0; k < DATA.issues.length; k++) { if (DATA.issues[k].id === id) return DATA.issues[k]; } return null; }

/** 设计稿/开发截图标注区全屏查看（兼容 webkit 前缀，按钮文案随状态切换） */
function toggleFs(cardId) {
  var card = document.getElementById(cardId);
  if (!document.fullscreenElement && !document.webkitFullscreenElement) {
    var req = card.requestFullscreen || card.webkitRequestFullscreen;
    if (req) req.call(card);
  } else {
    var exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) exit.call(document);
  }
}
function syncFsBtn() {
  var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  Array.prototype.forEach.call(document.querySelectorAll('.fs-btn'), function (btn) {
    var cardId = btn.getAttribute('data-card');
    btn.textContent = fsEl && fsEl.id === cardId ? T.exitFullscreen : T.fullscreen;
  });
}
/** 全屏时把详情遮罩/抽屉挂进当前全屏元素，退出时移回 body：全屏内点标注直接弹出详情，无需退出 */
var detailMaskEl = document.getElementById('detail-mask');
var detailPanelEl = document.getElementById('detail-panel');
function syncDetailHost() {
  syncFsBtn();
  var fsEl = document.fullscreenElement || document.webkitFullscreenElement;
  var host = fsEl || document.body;
  if (!host) return;
  // 全屏时详情面板切为居中弹窗形态
  if (detailPanelEl) detailPanelEl.classList.toggle('as-modal', !!fsEl);
  if (detailMaskEl && detailMaskEl.parentElement !== host) host.appendChild(detailMaskEl);
  if (detailPanelEl && detailPanelEl.parentElement !== host) host.appendChild(detailPanelEl);
}
document.addEventListener('fullscreenchange', syncDetailHost);
document.addEventListener('webkitfullscreenchange', syncDetailHost);

/** 标注 → 所属画布 key：手动标注(m)用上传图(md/ms)，自动走查(w)用采集图(wd/ws) */
function canvasKey(i) {
  var set = i.imgSet === 'walk' ? 'w' : 'm';
  return set + (i.targetImage === 'design' ? 'd' : 's');
}
var CANVASES = ['md', 'ms', 'wd', 'ws'];

function buildMarkers() {
  CANVASES.forEach(function (key) {
    var layer = document.getElementById('markers-' + key);
    if (!layer) return;
    layer.innerHTML = '';
    DATA.issues.forEach(function (i) {
      if (canvasKey(i) !== key) return;
      var shape = i.shape || 'rect';
      // 与工具内画布口径一致：无坐标的清单问题不上图（在明细清单中查看）
      if (!(shape === 'point' || shape === 'text' || shape === 'picker' || shape === 'measure' || i.width !== 0 || i.height !== 0)) return;
      var el = null;
      if (shape === 'rect') {
        el = document.createElement('div');
        el.className = 'mk mk-box sev-' + i.severity + stateClass(i);
        el.style.left = (i.x * 100) + '%';
        el.style.top = (i.y * 100) + '%';
        el.style.width = (i.width * 100) + '%';
        el.style.height = (i.height * 100) + '%';
        el.innerHTML = '<span class="mk-num">' + i.no + '</span>';
      } else if (shape === 'point') {
        el = document.createElement('div');
        el.className = 'mk mk-pin sev-' + i.severity + stateClass(i);
        el.style.left = (i.x * 100) + '%';
        el.style.top = (i.y * 100) + '%';
        el.innerHTML = '<span class="mk-num">' + i.no + '</span>';
      } else if (shape === 'text') {
        el = document.createElement('div');
        el.className = 'mk mk-label sev-' + i.severity + stateClass(i);
        el.style.left = (i.x * 100) + '%';
        el.style.top = (i.y * 100) + '%';
        el.innerHTML = '<span class="mk-num">' + i.no + '</span><span class="mk-text">' + esc(i.description) + '</span>';
      } else if (shape === 'picker') {
        el = document.createElement('div');
        el.className = 'mk mk-pick sev-' + i.severity + stateClass(i);
        el.style.left = (i.x * 100) + '%';
        el.style.top = (i.y * 100) + '%';
        var chipHex = i.sampleA || i.sampleB || '#3b82f6';
        var pickLine = i.sampleA ? T.pickDesign + ' ' + i.sampleA : (i.sampleB ? T.pickDev + ' ' + i.sampleB : esc(i.description));
        if (i.sampleA && i.sampleB) pickLine += '<br>' + T.pickDev + ' ' + i.sampleB;
        el.innerHTML = '<span class="mk-num">' + i.no + '</span><span class="mk-pick-chip" style="background:' + chipHex + '"></span><span class="mk-pick-text">' + pickLine + '</span>';
      }
      if (el) {
        var cc = mkColor(i);
        if (cc) el.style.setProperty('--mk-c', cc);
        el.onclick = (function (issue) { return function () { openDetail(issue.id); }; })(i);
        layer.appendChild(el);
      }
    });
    drawArrows(key);
  });
}

function drawArrows(target) {
  var svg = document.getElementById('arrows-' + target);
  var canvas = document.getElementById('canvas-' + target);
  if (!svg || !canvas) return;
  svg.innerHTML = '';
  var rect = canvas.getBoundingClientRect();
  if (!rect.width) return;
  svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
  var ns = 'http://www.w3.org/2000/svg';
  DATA.issues.forEach(function (i) {
    if (canvasKey(i) !== target) return;
    var shape = i.shape || 'rect';
    var x1, y1, x2, y2, cls, cc, num, hit;
    if (shape === 'measure') {
      // 测量距离：线 + 端点圆 + 尺寸文案（数值可在详情中修改）
      x1 = i.x * rect.width; y1 = i.y * rect.height;
      x2 = (i.x + i.width) * rect.width; y2 = (i.y + i.height) * rect.height;
      cls = 'sev-' + i.severity + stateClass(i);
      var mline = document.createElementNS(ns, 'line');
      mline.setAttribute('x1', x1); mline.setAttribute('y1', y1);
      mline.setAttribute('x2', x2); mline.setAttribute('y2', y2);
      mline.setAttribute('class', 'rep-measure ' + cls);
      svg.appendChild(mline);
      var mdots = [];
      [x1, x2].forEach(function (cx, idx) {
        var cy = idx === 0 ? y1 : y2;
        var mdot = document.createElementNS(ns, 'circle');
        mdot.setAttribute('cx', cx); mdot.setAttribute('cy', cy);
        mdot.setAttribute('r', 3.5);
        mdot.setAttribute('class', 'rep-measure-dot ' + cls);
        svg.appendChild(mdot);
        mdots.push(mdot);
      });
      var vertical = Math.abs(i.width) < Math.abs(i.height);
      num = document.createElementNS(ns, 'text');
      num.setAttribute('x', x1); num.setAttribute('y', y1);
      num.setAttribute('dx', vertical ? 10 : -10);
      num.setAttribute('text-anchor', vertical ? 'start' : 'end');
      num.setAttribute('class', 'rep-measure-num');
      num.textContent = i.no;
      svg.appendChild(num);
      var label = document.createElementNS(ns, 'text');
      label.setAttribute('x', (x1 + x2) / 2); label.setAttribute('y', (y1 + y2) / 2);
      label.setAttribute('dx', vertical ? 8 : 0);
      label.setAttribute('dy', vertical ? 0 : -9);
      label.setAttribute('text-anchor', vertical ? 'start' : 'middle');
      label.setAttribute('class', 'rep-measure-label ' + cls);
      label.textContent = i.measureValue || (Math.round(Math.hypot(i.width * rect.width, i.height * rect.height)) + 'px');
      svg.appendChild(label);
      hit = document.createElementNS(ns, 'line');
      hit.setAttribute('x1', x1); hit.setAttribute('y1', y1);
      hit.setAttribute('x2', x2); hit.setAttribute('y2', y2);
      hit.setAttribute('class', 'rep-measure-hit');
      hit.onclick = (function (issue) { return function () { openDetail(issue.id); }; })(i);
      svg.appendChild(hit);
      cc = mkColor(i);
      if (cc) {
        mline.style.setProperty('--mk-c', cc);
        mdots.forEach(function (n) { n.style.setProperty('--mk-c', cc); });
        label.style.setProperty('--mk-c', cc);
      }
      return;
    }
    if (shape !== 'arrow') return;
    x1 = i.x * rect.width; y1 = i.y * rect.height;
    x2 = (i.x + i.width) * rect.width; y2 = (i.y + i.height) * rect.height;
    cls = 'sev-' + i.severity + stateClass(i);
    var line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', x1); line.setAttribute('y1', y1);
    line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('class', 'rep-arrow ' + cls);
    svg.appendChild(line);
    var ang = Math.atan2(y2 - y1, x2 - x1);
    var headLen = 13;
    var poly = document.createElementNS(ns, 'polygon');
    poly.setAttribute('points',
      x2 + ',' + y2 + ' ' +
      (x2 - headLen * Math.cos(ang - 0.42)) + ',' + (y2 - headLen * Math.sin(ang - 0.42)) + ' ' +
      (x2 - headLen * Math.cos(ang + 0.42)) + ',' + (y2 - headLen * Math.sin(ang + 0.42)));
    poly.setAttribute('class', 'rep-arrow-head ' + cls);
    svg.appendChild(poly);
    var dot = document.createElementNS(ns, 'circle');
    dot.setAttribute('cx', (x1 + x2) / 2); dot.setAttribute('cy', (y1 + y2) / 2);
    dot.setAttribute('r', 10);
    dot.setAttribute('class', 'rep-arrow-dot ' + cls);
    svg.appendChild(dot);
    var cc = mkColor(i);
    if (cc) {
      line.style.setProperty('--mk-c', cc);
      poly.style.setProperty('--mk-c', cc);
      dot.style.setProperty('--mk-c', cc);
    }
    var num = document.createElementNS(ns, 'text');
    num.setAttribute('x', (x1 + x2) / 2); num.setAttribute('y', (y1 + y2) / 2);
    num.setAttribute('class', 'rep-arrow-num');
    num.textContent = i.no;
    svg.appendChild(num);
    var hit = document.createElementNS(ns, 'line');
    hit.setAttribute('x1', x1); hit.setAttribute('y1', y1);
    hit.setAttribute('x2', x2); hit.setAttribute('y2', y2);
    hit.setAttribute('class', 'rep-arrow-hit');
    hit.onclick = (function (issue) { return function () { openDetail(issue.id); }; })(i);
    svg.appendChild(hit);
  });
}

function renderStats() {
  var total = DATA.issues.length, done = 0, blocked = 0, pend = 0;
  DATA.issues.forEach(function (i) {
    var s = stateOf(i);
    if (s === 'fixed' || i.status === 'fixed') done++;
    else if (s === 'blocked') blocked++;
    else pend++;
  });
  document.getElementById('stats').innerHTML =
    '<div class="stat"><div class="num">' + total + '</div><div class="lbl">' + T.statTotal + '</div></div>' +
    '<div class="stat"><div class="num pend">' + pend + '</div><div class="lbl">' + T.statPending + '</div></div>' +
    '<div class="stat"><div class="num done">' + done + '</div><div class="lbl">' + T.statFixed + '</div></div>' +
    '<div class="stat"><div class="num blocked">' + blocked + '</div><div class="lbl">' + T.statBlocked + '</div></div>';
  var btn = document.getElementById('btn-export-summary');
  btn.disabled = false;
  btn.title = allResponded() ? T.exportDevReport : T.btnExportUnresponded.replace('{n}', pend);
}

/** 问题明细清单：列出全部问题（含无坐标未上图），行可点击打开详情 */
function renderTable() {
  var tb = document.getElementById('issue-table');
  if (!tb) return;
  var head = '<thead><tr><th style="width:44px">#</th><th>' + T.colDescription + '</th><th style="width:86px">' + T.colSeverity + '</th><th style="width:92px">' + T.colCategory + '</th><th style="width:86px">' + T.colSource + '</th><th style="width:96px">' + T.colTarget + '</th><th style="width:122px">' + T.colResponse + '</th></tr></thead>';
  var rows = DATA.issues.map(function (i) {
    var r = responses[i.id];
    var st = !r
      ? '<span class="tag st-wait">' + T.tagUnresponded + '</span>'
      : r.state === 'fixed'
        ? '<span class="tag st-fixed">' + T.tagFixed + '</span>'
        : '<span class="tag sev-major">' + T.tagBlocked + '</span>';
    return '<tr data-id="' + esc(i.id) + '"><td>' + i.no + '</td><td>' + esc(i.description) + '</td><td><span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span></td><td style="white-space:nowrap">' + esc(i.categoryLabel) + '</td><td style="white-space:nowrap">' + esc(i.sourceLabel) + '</td><td style="white-space:nowrap">' + esc(i.targetLabel) + '</td><td>' + st + '</td></tr>';
  }).join('');
  tb.innerHTML = head + '<tbody>' + rows + '</tbody>';
  var trs = tb.querySelectorAll('tr[data-id]');
  for (var k = 0; k < trs.length; k++) {
    (function (tr) {
      tr.onclick = function () { openDetail(tr.getAttribute('data-id')); };
    })(trs[k]);
  }
}

function renderDetail() {
  var panel = document.getElementById('detail-panel');
  var i = findIssue(currentId);
  if (!i) { panel.innerHTML = ''; return; }
  var r = responses[i.id];
  var cc = mkColor(i);
  var noStyle = cc ? ' style="background:' + esc(cc) + '"' : '';
  var html = '<div class="dp-head">' +
    '<span class="dp-no sev-' + i.severity + stateClass(i) + '"' + noStyle + '>' + i.no + '</span>' +
    '<div class="dp-head-main"><h3>' + esc(i.description) + '</h3>' +
    '<div class="dp-sub">' + T.detailIssueNo.replace('{no}', i.no) + ' · ' + esc(i.targetLabel) + (i.shapeLabel ? ' · ' + esc(i.shapeLabel) : '') + '</div></div>' +
    '<button class="dp-close" onclick="closeDetail()">×</button></div>' +
    '<div class="dp-card"><div class="dp-card-label">' + T.detailInfoTitle + '</div><div class="dp-meta">' +
    '<span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span>' +
    '<span class="tag plain">' + esc(i.categoryLabel) + '</span>' +
    '<span class="tag plain">' + esc(i.sourceLabel) + '</span>' +
    '<span class="tag plain">' + esc(i.targetLabel) + '</span>' +
    '<span class="tag ' + (i.status === 'fixed' ? 'st-fixed' : 'st-pending') + '">' + esc(i.statusLabel) + '</span>' +
    '</div></div>' +
    '<div class="dp-card"><div class="dp-card-label">' + T.detailRespondTitle + '</div>';
  if (!r) {
    html += '<p class="dp-q">' + T.detailQuestion + '</p>' +
      '<div class="dp-actions">' +
      '<button class="btn btn-primary" onclick="respond(\\'fixed\\')">' + T.tagFixed + '</button>' +
      '<button class="btn btn-ghost-danger" onclick="toggleBlock(true)">' + T.tagBlocked + '</button></div>' +
      '<div id="block-form" class="block-form hidden">' +
      '<textarea id="block-reason" placeholder="' + T.blockPlaceholder + '"></textarea>' +
      '<button class="btn btn-primary" onclick="submitBlock()">' + T.submit + '</button></div>';
  } else if (r.state === 'fixed') {
    html += '<div class="dp-state done">' + T.tagFixed +
      (r.preset && !r.at ? '<span class="dp-time">' + T.presetRecheckPassed + '</span>' : '<span class="dp-time">' + fmtTime(r.at) + '</span>') +
      '</div><button class="btn-text" onclick="clearResponse()">' + T.changeResponse + '</button>';
  } else {
    html += '<div class="dp-state blocked">' + T.tagBlocked + '<span class="dp-time">' + fmtTime(r.at) + '</span></div>' +
      '<p class="dp-reason">' + esc(r.reason || T.noReason) + '</p>' +
      '<button class="btn-text" onclick="clearResponse()">' + T.changeResponse + '</button>';
  }
  html += '</div>';
  panel.innerHTML = html;
}

function openDetail(id) {
  currentId = id;
  renderDetail();
  document.getElementById('detail-mask').classList.add('show');
  document.getElementById('detail-panel').classList.add('show');
}
function closeDetail() {
  currentId = null;
  document.getElementById('detail-mask').classList.remove('show');
  document.getElementById('detail-panel').classList.remove('show');
}
function respond(state) {
  if (!currentId) return;
  responses[currentId] = { state: state, reason: '', at: Date.now() };
  save(); renderAll(); renderDetail();
}
function toggleBlock(show) {
  var f = document.getElementById('block-form');
  if (f) f.classList.toggle('hidden', !show);
  if (show) { var t = document.getElementById('block-reason'); if (t) t.focus(); }
}
function submitBlock() {
  if (!currentId) return;
  var v = (document.getElementById('block-reason').value || '').trim();
  if (!v) { alert(T.alertReasonRequired); return; }
  responses[currentId] = { state: 'blocked', reason: v, at: Date.now() };
  save(); renderAll(); renderDetail();
}
function clearResponse() {
  if (!currentId) return;
  delete responses[currentId];
  save(); renderAll(); renderDetail();
}

function exportSummary() {
  // 未全部回应时弹出自定义提示弹窗，允许按当前进度继续导出
  var unresp = 0;
  DATA.issues.forEach(function (i) { if (!responses[i.id]) unresp++; });
  if (unresp > 0) {
    document.getElementById('export-confirm-text').textContent = T.confirmUnresponded.replace('{n}', unresp);
    document.getElementById('export-confirm').classList.remove('hidden');
    return;
  }
  doExportSummary();
}
function closeExportConfirm() {
  document.getElementById('export-confirm').classList.add('hidden');
}
function doExportSummary() {
  closeExportConfirm();
  var done = 0, blocked = 0, un = 0;
  DATA.issues.forEach(function (i) {
    var s = responses[i.id] && responses[i.id].state;
    if (s === 'fixed') done++; else if (s === 'blocked') blocked++; else un++;
  });
  var rows = DATA.issues.map(function (i) {
    var r = responses[i.id];
    var result = !r
      ? '<span class="tag st-wait">' + T.tagUnresponded + '</span>'
      : r.state === 'fixed'
        ? '<span class="tag st-fixed">' + T.tagDone + '</span>'
        : '<span class="tag sev-major">' + T.tagBlocked + '</span>' + (r.reason ? '<div class="dp-reason" style="margin-top:6px">' + esc(r.reason) + '</div>' : '');
    return '<tr><td>' + i.no + '</td><td>' + esc(i.description) + '</td><td><span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span></td><td style="white-space:nowrap">' + esc(i.categoryLabel) + '</td><td style="white-space:nowrap">' + esc(i.sourceLabel) + '</td><td style="white-space:nowrap">' + esc(i.targetLabel) + '</td><td>' + result + '</td></tr>';
  }).join('');
  var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>' + T.devReportHeading + ' - ' + esc(DATA.pageName) + '</title><style>' +
    'body{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Segoe UI",sans-serif;background:#f5f6f8;color:#1f2937;padding:32px;}' +
    '.wrap{max-width:1000px;margin:0 auto;}h1{font-size:22px;margin-bottom:6px;}' +
    '.meta{color:#667085;font-size:13px;margin-bottom:20px;line-height:1.7;}' +
    '.meta a{color:#2563eb;text-decoration:none;word-break:break-all;}.meta a:hover{text-decoration:underline;}' +
    '.stats{display:flex;gap:14px;margin-bottom:22px;}' +
    '.stat{flex:1;background:#fff;border:1px solid #e7eaf0;border-radius:12px;padding:16px;text-align:center;}' +
    '.stat .num{font-size:26px;font-weight:700;}.stat .num.g{color:#16a34a;}.stat .num.r{color:#dc2626;}' +
    '.stat .lbl{font-size:12px;color:#667085;margin-top:4px;}' +
    'table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e7eaf0;border-radius:12px;overflow:hidden;}' +
    'th,td{padding:10px 14px;border-bottom:1px solid #e7eaf0;font-size:13px;text-align:left;vertical-align:top;}' +
    'th{background:#f9fafb;color:#667085;font-size:12px;}' +
    '.tag{display:inline-block;padding:2px 9px;border-radius:999px;font-size:12px;font-weight:500;}' +
    '.st-fixed{background:#e8f7ee;color:#15803d;}.st-wait{background:#f2f4f8;color:#667085;}' +
    '.sev-major{background:#fde8e8;color:#dc2626;}.sev-minor{background:#fef3c7;color:#b45309;}.sev-suggestion{background:#f2f4f8;color:#667085;}' +
    '.dp-reason{font-size:12px;color:#667085;background:#fafbfd;border:1px solid #e7eaf0;border-radius:6px;padding:6px 10px;}' +
    'footer{margin-top:28px;color:#9ca3af;font-size:12px;text-align:center;}' +
    '</style></head><body><div class="wrap">' +
    '<h1>' + T.devReportHeading + '</h1>' +
    '<div class="meta"><strong>' + T.labelProject + '</strong>' + esc(DATA.projectName) + '　<strong>' + T.labelPage + '</strong>' + esc(DATA.pageName) + '　<strong>' + T.labelPlatform + '</strong>' + esc(DATA.platformLabel) + (DATA.figmaUrl ? '　<strong>' + T.labelDesign + '</strong><a href="' + esc(DATA.figmaUrl) + '" target="_blank">' + T.openInFigma + '</a>' : '') + '<br><strong>' + T.labelExportedAt + '</strong>' + new Date().toLocaleString('zh-CN') + '</div>' +
    '<div class="stats">' +
    '<div class="stat"><div class="num">' + DATA.issues.length + '</div><div class="lbl">' + T.statTotal + '</div></div>' +
    '<div class="stat"><div class="num g">' + done + '</div><div class="lbl">' + T.statDone + '</div></div>' +
    '<div class="stat"><div class="num r">' + blocked + '</div><div class="lbl">' + T.statBlocked + '</div></div>' +
    '<div class="stat"><div class="num">' + un + '</div><div class="lbl">' + T.tagUnresponded + '</div></div></div>' +
    '<table><thead><tr><th style="width:40px">#</th><th>' + T.colDescription + '</th><th style="width:86px">' + T.colSeverity + '</th><th style="width:92px">' + T.colCategory + '</th><th style="width:86px">' + T.colSource + '</th><th style="width:96px">' + T.colTarget + '</th><th style="width:132px">' + T.colResult + '</th></tr></thead><tbody>' +
    rows +
    '</tbody></table><footer>' + T.devReportFooter + '</footer></div></body></html>';
  var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  var d = new Date();
  var ds = d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  a.download = '研发修改报告_' + DATA.pageName + '_' + ds + '.html';
  document.body.appendChild(a);
  a.click();
  setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

function renderAll() { renderStats(); buildMarkers(); renderTable(); }

// 预填：工具内复验已通过的问题直接记为已修复
DATA.issues.forEach(function (i) {
  if (i.fixStatus === 'passed' && !responses[i.id]) {
    responses[i.id] = { state: 'fixed', reason: '', at: null, preset: true };
  }
});

window.addEventListener('resize', function () { buildMarkers(); });
window.addEventListener('load', function () {
  // 任意画布图片晚于脚本加载完成时，重算一次标注坐标
  Array.prototype.forEach.call(document.querySelectorAll('img[id^="img-"]'), function (img) {
    if (img && !img.complete) { img.addEventListener('load', function () { buildMarkers(); }); }
  });
  renderAll();
});
renderAll();
</script>
</body>
</html>`
  }

  const escapeHtml = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

  /** 实际执行导出 */
  const doExport = async () => {
    setExporting(true)
    setResultMsg(null)
    try {
      const html = await generateReportHTML()
      const name = `走查报告_${page?.pageName ?? '页面'}_${new Date().toISOString().slice(0, 10)}.html`
      const res = await window.electronAPI.exportReport(html, name)
      if (res && res.ok && res.path) {
        // 写入导出历史（失败不阻塞导出本身）
        const exportTotal = (issues ?? []).filter((i) => !(i.isAISuggested && !i.aiConfirmed)).length
        await db.reportRecords
          .add({
            id: genId(),
            pageId: pageId!,
            projectId: projectId!,
            type: 'html',
            name,
            filePath: res.path ?? undefined,
            total: exportTotal,
            createdAt: Date.now()
          })
          .catch(() => undefined)
        setResultMsg({
          type: res.fallback ? 'warn' : 'ok',
          text: res.fallback ? t('msg.exportedWithMsg', { msg: res.message }) : t('msg.exportedToPath', { path: res.path })
        })
      } else if (res && res.canceled) {
        return // 用户取消了保存对话框
      } else {
        setResultMsg({ type: 'error', text: t('msg.exportFailed', { msg: res?.message || t('msg.unknownError') }) })
      }
    } catch (err) {
      setResultMsg({ type: 'error', text: t('msg.exportFailed', { msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setExporting(false)
    }
  }

  /** 压缩为 JPEG（最长边 2200px），避免原图过大导致飞书素材上传失败 */
  const toUploadImage = (dataUrl: string): Promise<string> =>
    new Promise((resolve) => {
      try {
        const img = new Image()
        img.onload = () => {
          try {
            const MAX = 2200
            const scale = Math.min(1, MAX / Math.max(img.width, img.height))
            const w = Math.max(1, Math.round(img.width * scale))
            const h = Math.max(1, Math.round(img.height * scale))
            const canvas = document.createElement('canvas')
            canvas.width = w
            canvas.height = h
            const ctx = canvas.getContext('2d')
            if (!ctx) return resolve(dataUrl)
            ctx.fillStyle = '#ffffff'
            ctx.fillRect(0, 0, w, h)
            ctx.drawImage(img, 0, 0, w, h)
            resolve(canvas.toDataURL('image/jpeg', 0.88))
          } catch {
            resolve(dataUrl)
          }
        }
        img.onerror = () => resolve(dataUrl)
        img.src = dataUrl
      } catch {
        resolve(dataUrl)
      }
    })

  /** HTML 报告文本转 base64 dataUrl（TextEncoder 保证中文不乱码） */
  const htmlToDataUrl = (html: string): string => {
    const bytes = new TextEncoder().encode(html)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return 'data:text/html;base64,' + btoa(bin)
  }

  /** 组装文档导出 payload（飞书 / 腾讯共用，内容口径与 HTML 报告一致：排除未审核候选） */
  const buildDocPayload = async () => {
    if (!page) throw new Error(t('msg.pageDataNotLoaded'))
    // 与 HTML 报告口径一致：手动标注图与自动走查采集图分别压缩
    const [designImg, shotImg, walkDesignImg, walkShotImg] = await Promise.all([
      page.designImagePath ? window.electronAPI.readImage(page.designImagePath) : null,
      page.screenshotPath ? window.electronAPI.readImage(page.screenshotPath) : null,
      page.walkDesignPath ? window.electronAPI.readImage(page.walkDesignPath) : null,
      page.walkShotPath ? window.electronAPI.readImage(page.walkShotPath) : null
    ])
    const sorted = [...(issues ?? [])].sort((a, b) => a.createdAt - b.createdAt)
    const reportable = sorted.filter((i) => !(i.isAISuggested && !i.aiConfirmed))
    const doneCount = reportable.filter((i) => i.status === 'fixed').length
    const rawImages: { name: string; dataUrl: string }[] = []
    if (designImg) rawImages.push({ name: t('design'), dataUrl: designImg })
    if (shotImg) rawImages.push({ name: t('devScreenshot'), dataUrl: shotImg })
    if (walkDesignImg) rawImages.push({ name: t('walkDesign'), dataUrl: walkDesignImg })
    if (walkShotImg) rawImages.push({ name: t('walkDevScreenshot'), dataUrl: walkShotImg })
    const images = await Promise.all(
      rawImages.map(async (img) => ({ name: img.name, dataUrl: await toUploadImage(img.dataUrl) }))
    )
    // 附件版 HTML 用压缩图重新生成，避免内嵌原图导致附件超过上传上限
    const compressed = (name: string, raw: string | null) =>
      images.find((i) => i.name === name)?.dataUrl ?? (raw ? '' : null)
    const attachHtml = await generateReportHTML({
      design: compressed(t('design'), designImg),
      shot: compressed(t('devScreenshot'), shotImg),
      walkDesign: compressed(t('walkDesign'), walkDesignImg),
      walkShot: compressed(t('walkDevScreenshot'), walkShotImg)
    })
    const payload = {
      title: t('exportedHtml.title', { name: page.pageName }),
      metaLines: [
        `${t('labelProject')}${project?.name ?? ''}　${t('labelPage')}${page.pageName}　${t('labelPlatform')}${PLATFORM_LABELS[page.platform]}`,
        ...(page.figmaUrl ? [`${t('labelDesign')}${page.figmaUrl}`] : []),
        `${t('labelGeneratedAt')}${new Date().toLocaleString('zh-CN')}`
      ],
      stats: [
        { label: t('exportedHtml.statTotal'), value: String(reportable.length) },
        { label: t('exportedHtml.statFixed'), value: String(doneCount) },
        { label: t('exportedHtml.statPendingProcess'), value: String(reportable.length - doneCount) }
      ],
      issues: reportable.map((i, idx) => ({
        no: idx + 1,
        title: i.description,
        severityLabel: SEVERITY_LABELS[i.severity],
        categoryLabel: CATEGORY_LABELS[i.category],
        sourceLabel:
          i.source === 'structured'
            ? t('sourceStructured')
            : i.source === 'visual'
              ? t('sourceVisual')
              : i.source === 'spec'
                ? t('sourceSpec')
                : i.source === 'element'
                  ? t('sourceElement')
                  : i.source === 'a11y'
                    ? t('sourceA11y')
                    : t('sourceManual'),
        targetLabel: i.targetImage === 'design' ? t('design') : t('devScreenshot'),
        statusLabel: ISSUE_STATUS_LABELS[i.status],
        suggestion: i.aiSuggestion
      })),
      images,
      htmlReport: {
        name: `UI 走查报告 - ${page.pageName}.html`,
        dataUrl: htmlToDataUrl(attachHtml)
      }
    }
    return { payload, reportable }
  }

  /** 一键创建飞书文档（内容口径与 HTML 报告一致：排除未审核候选） */
  const doFeishu = async () => {
    if (!page) return
    setFeishuLoading(true)
    setResultMsg(null)
    try {
      const { payload, reportable } = await buildDocPayload()
      const res = await window.electronAPI.feishuCreateReport(payload)
      // 主进程捕获错误后返回 {ok:false, message}，必须按 ok 分流而非无条件提示成功；
      // ok 时 message 可能携带降级/失败 warning（如附件上传失败、多维表降级），需完整透出
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.feishu.name'), msg: res.message }) })
        return
      }
      // 写入导出历史（失败不阻塞主流程）
      await db.reportRecords
        .add({
          id: genId(),
          pageId: page.id,
          projectId: projectId!,
          type: 'feishu',
          name: t('exportedHtml.title', { name: page.pageName }),
          url: res.url,
          total: reportable.length,
          createdAt: Date.now()
        })
        .catch(() => undefined)
      const msg = res.message ?? ''
      setResultMsg({
        type: msg && msg !== '文档创建成功' ? 'warn' : 'ok',
        text: msg || t('msg.feishuCreatedAutoOpen')
      })
    } catch (err) {
      setResultMsg({
        type: 'error',
        text: t('msg.createFailed', { name: t('docTarget.feishu.name'), msg: err instanceof Error ? err.message : String(err) })
      })
    } finally {
      setFeishuLoading(false)
    }
  }

  /** 一键创建腾讯文档（报告内容生成 docx 后导入为在线文档，内容口径与飞书文档一致） */
  const doTencent = async () => {
    if (!page) return
    setFeishuLoading(true)
    setResultMsg(null)
    try {
      const { payload, reportable } = await buildDocPayload()
      const res = await window.electronAPI.tencentCreateReport(payload)
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.tencent.name'), msg: res.message }) })
        return
      }
      // 写入导出历史（失败不阻塞主流程）
      await db.reportRecords
        .add({
          id: genId(),
          pageId: page.id,
          projectId: projectId!,
          type: 'tencent',
          name: payload.title,
          url: res.url,
          total: reportable.length,
          createdAt: Date.now()
        })
        .catch(() => undefined)
      const msg = res.message ?? ''
      setResultMsg({
        type: msg.includes('超时') || msg.includes('失败') ? 'warn' : 'ok',
        text: msg || t('msg.tencentCreatedAutoOpen')
      })
    } catch (err) {
      setResultMsg({
        type: 'error',
        text: t('msg.createFailed', {
          name: t('docTarget.tencent.name'),
          msg: err instanceof Error ? err.message : String(err)
        })
      })
    } finally {
      setFeishuLoading(false)
    }
  }

  /** 未审核 AI 候选数量 */
  const unreviewed = issues?.filter((i) => i.isAISuggested && !i.aiConfirmed).length ?? 0

  const handleExport = async () => {
    if (unreviewed > 0) {
      setPendingAction('export')
      setShowUnreviewed(true)
      return
    }
    await doExport()
  }

  /** 生成文档：按所选目标分流（飞书 / 腾讯写入完整内容；金山创建在线文档后自动打开） */
  const handleCreateDoc = async () => {
    const target = docTargets.find((d) => d.key === docTarget)!
    if (docTarget === 'feishu') {
      if (!feishuReady) {
        setResultMsg({ type: 'warn', text: t('msg.feishuConfigNeeded') })
        return
      }
      if (unreviewed > 0) {
        setPendingAction('feishu')
        setShowUnreviewed(true)
        return
      }
      await doFeishu()
      return
    }
    // 腾讯：报告内容生成 docx 后导入，内容与飞书文档一致，同样拦截未审核候选
    if (docTarget === 'tencent') {
      if (unreviewed > 0) {
        setPendingAction('tencent')
        setShowUnreviewed(true)
        return
      }
      await doTencent()
      return
    }
    // 金山：创建在线文档（标题为报告名），按 ok 分流
    if (!page) return
    setFeishuLoading(true)
    setResultMsg(null)
    try {
      const title = t('exportedHtml.title', { name: page.pageName })
      const reportable = (issues ?? []).filter((i) => !(i.isAISuggested && !i.aiConfirmed)).length
      const res = await window.electronAPI.kingsoftCreateReport({ title })
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: target.name, msg: res.message }) })
        return
      }
      // 写入导出历史（失败不阻塞主流程）
      await db.reportRecords
        .add({
          id: genId(),
          pageId: page.id,
          projectId: projectId!,
          type: docTarget,
          name: title,
          url: res.url,
          total: reportable,
          createdAt: Date.now()
        })
        .catch(() => undefined)
      setResultMsg({ type: 'ok', text: res.message || t('msg.docCreatedAutoOpen', { name: target.name }) })
    } catch (err) {
      setResultMsg({
        type: 'error',
        text: t('msg.createFailed', {
          name: target.name,
          msg: err instanceof Error ? err.message : String(err)
        })
      })
    } finally {
      setFeishuLoading(false)
    }
  }

  const total = issues?.length ?? 0
  const pending = issues?.filter((i) => i.status === 'pending').length ?? 0

  /** 当前页面已导出的报告历史记录 */
  const reportHistory = useLiveQuery(
    () => db.reportRecords.where('pageId').equals(pageId!).sortBy('createdAt'),
    [pageId]
  )
  /** 当前项目 / 页面名称（用于显示） */
  const projectName = project?.name
  const pageName = page?.pageName

  const typeLabel: Record<string, string> = {
    html: t('type.html'),
    feishu: t('type.feishu'),
    tencent: t('type.tencent'),
    kingsoft: t('type.kingsoft'),
    dev: t('type.dev')
  }

  /** 删除报告历史记录 */
  const handleDeleteReport = async (recordId: string) => {
    if (!window.confirm(t('page.confirmDeleteRecord'))) return
    await db.reportRecords.delete(recordId)
  }

  /** 打开 HTML 报告文件 */
  const handleOpenHtmlReport = async (filePath: string) => {
    await window.electronAPI.openFile(filePath)
  }

  /** 打开在线文档链接 */
  const handleOpenUrl = (url: string) => {
    window.open(url, '_blank')
  }

  /** 验收通过：写入页面验收状态，分析报告列表状态列联动显示「已完成」 */
  const handleAccept = async () => {
    if (!page) return
    const ok = window.confirm(t('page.confirmAccept', { name: page.pageName }))
    if (!ok) return
    await db.pages.update(page.id, { accepted: true, acceptedAt: Date.now() })
  }

  /** 取消验收：状态恢复为「进行中」 */
  const handleRevokeAccept = async () => {
    if (!page) return
    const ok = window.confirm(t('page.confirmRevokeAccept', { name: page.pageName }))
    if (!ok) return
    await db.pages.update(page.id, { accepted: false })
  }

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link to={`/project/${projectId}/page/${pageId}`} className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t('page.backToCompare')}
          </Link>
          <h1>{t('page.title')}</h1>
        </div>
      </div>

      <div className="card export-card">
        <div className="segmented export-doc-seg" title={t('page.segTitle')}>
          {docTargets.map((d) => (
            <button
              key={d.key}
              type="button"
              className={`segment-item${docTarget === d.key ? ' active' : ''}`}
              onClick={() => setDocTarget(d.key)}
            >
              {d.label}
            </button>
          ))}
        </div>
        <p>
          <strong>{t('labelProject')}</strong>
          {project?.name}
        </p>
        <p>
          <strong>{t('labelPage')}</strong>
          {page?.pageName}
        </p>
        <p>
          <strong>{t('labelIssue')}</strong>
          {t('page.issueSummary', { total, pending })}
        </p>
        <p className="export-note">{t('page.interactiveNote')}</p>
        <div className="wizard-actions export-actions">
          <div className="export-actions-left">
            <button className="btn-primary" onClick={handleExport} disabled={exporting || feishuLoading || !page}>
              {exporting ? t('page.exporting') : t('page.exportHtmlBtn')}
            </button>
            <button
              className="btn-secondary"
              onClick={handleCreateDoc}
              disabled={feishuLoading || exporting || !page}
              title={
                docTarget === 'feishu'
                  ? feishuReady
                    ? t('page.feishuReadyTip')
                    : t('page.feishuNotReadyTip')
                  : t('page.docReadyTip', {
                      name: docTargets.find((d) => d.key === docTarget)!.name
                    })
              }
            >
              {feishuLoading ? t('page.creating') : docTargets.find((d) => d.key === docTarget)!.btn}
            </button>
          </div>
          <div className="export-actions-right">
            {page?.accepted ? (
              <>
                <span className="export-accepted-badge">{t('page.acceptedBadge')}</span>
                <button className="btn-secondary" onClick={handleRevokeAccept} title={t('page.revokeAcceptTip')}>
                  {t('page.revokeAccept')}
                </button>
              </>
            ) : (
              <button
                className="btn-secondary"
                onClick={handleAccept}
                disabled={!page}
                title={t('page.acceptTip')}
              >
                {t('page.accept')}
              </button>
            )}
          </div>
        </div>
        {resultMsg && <p className={`export-result ${resultMsg.type}`}>{resultMsg.text}</p>}
      </div>

      {/* 历史导出记录列表 */}
      {reportHistory && reportHistory.length > 0 && (
        <div className="card report-history-card">
          <h3 className="report-history-title">{t('page.historyTitle')}</h3>
          <div className="report-history-list">
            {reportHistory.map((record) => (
              <div
                key={record.id}
                className="report-history-item"
                onClick={() => {
                  if (record.type === 'html' && record.filePath) handleOpenHtmlReport(record.filePath)
                  else if (record.url) handleOpenUrl(record.url)
                }}
                title={t('page.viewReportTip')}
              >
                <div className="report-history-main">
                  <span className="report-history-type-badge" title={typeLabel[record.type] || record.type}>
                    {typeLabel[record.type] || record.type}
                  </span>
                  <span className="report-history-name">{record.name}</span>
                  <span className="report-history-count">{t('page.totalIssues', { n: record.total })}</span>
                  <span className="report-history-time">{new Date(record.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <button
                  type="button"
                  className="report-history-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteReport(record.id)
                  }}
                  title={t('page.deleteRecordTip')}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {showUnreviewed && (
        <div
          className="modal-mask"
          onMouseDown={(e) => e.target === e.currentTarget && setShowUnreviewed(false)}
        >
          <div className="modal">
            <h3>{t('page.unreviewedTitle')}</h3>
            <p className="modal-confirm-text">
              {t('page.unreviewedBody', {
                n: unreviewed,
                target: pendingAction === 'feishu' ? t('type.feishu') : t('page.thisExportReport')
              })}
            </p>
            <div className="modal-actions">
              <span className="modal-spacer" />
              <button
                className="btn-secondary"
                onClick={() => {
                  setShowUnreviewed(false)
                  // 跳回对比工作台并直接进入「自动走查」审核视图
                  navigate(`/project/${projectId}/page/${pageId}`, { state: { mode: 'auto' } })
                }}
              >
                {t('page.backToReview')}
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowUnreviewed(false)
                  if (pendingAction === 'export') {
                    doExport()
                  } else if (pendingAction === 'tencent') {
                    doTencent()
                  } else {
                    doFeishu()
                  }
                }}
              >
                {pendingAction === 'feishu'
                  ? t('page.continueCreateFeishu')
                  : pendingAction === 'tencent'
                    ? t('page.continueCreateTencent')
                    : t('page.continueExport')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
