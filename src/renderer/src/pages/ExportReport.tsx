import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, Link } from 'react-router-dom'
import { useEffect, useState } from 'react'
import {
  db,
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
function buildAnalysisHtml(issues: ReportIssue[]): string {
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
    `<text x="60" y="74" text-anchor="middle" font-size="9" fill="#667085">个问题</text></svg>`
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
            `<div class="sug-row"><span class="sug-key">现状</span><span class="sug-val">${esc(s.current)}</span></div>` +
            `<div class="sug-row"><span class="sug-key fix">建议改法</span><span class="sug-val">${esc(s.fix)}</span></div>` +
            (s.properties
              ? `<div class="sug-row"><span class="sug-key prop">涉及属性</span><span class="sug-val mono">${esc(s.properties)}</span></div>`
              : '') +
            `</div></div>`
          )
        })
        .join('')}</div>`
    : `<div class="sug-empty">暂无 AI 结构化修复建议。在对比工作台使用「AI 识别」生成候选并采纳后，导出报告会在此按「现状 → 建议改法 → 涉及属性」列出修改指引。</div>`

  return (
    `<section class="canvas-card"><div class="canvas-title">AI 报告分析</div><div class="ai-analysis-body">` +
    `<div class="chart-row">` +
    `<div class="chart-block"><div class="chart-block-title">问题分类分布</div><div class="donut-wrap">${donut}<div class="donut-legend">${legend}</div></div></div>` +
    `<div class="chart-block"><div class="chart-block-title">严重度分布</div>${bars}</div>` +
    `</div>` +
    `<div class="chart-block sug-block"><div class="chart-block-title">修复建议（AI 结构化）</div>${sugHtml}</div>` +
    `</div></section>`
  )
}

export default function ExportReport() {
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>()
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
  const [pendingAction, setPendingAction] = useState<'export' | 'feishu'>('export')
  /** 飞书配置是否就绪 */
  const [feishuReady, setFeishuReady] = useState(false)
  const [feishuLoading, setFeishuLoading] = useState(false)

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
    }): Promise<string> => {
    const [rawDesign, rawShot] = await Promise.all([
      page?.designImagePath ? window.electronAPI.readImage(page.designImagePath) : null,
      page?.screenshotPath ? window.electronAPI.readImage(page.screenshotPath) : null
    ])
    // 飞书附件场景传入压缩后的图片，控制 HTML 附件体积（本地导出仍用原图）
    const designImg = imgOverride?.design !== undefined ? imgOverride.design : rawDesign
    const shotImg = imgOverride?.shot !== undefined ? imgOverride.shot : rawShot

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
      targetLabel: issue.targetImage === 'design' ? '设计稿' : '开发截图',
      shapeLabel: SHAPE_LABELS[issue.shape ?? 'rect'],
      fixStatus: issue.fixStatus,
      color: issue.color,
      aiSuggestion: issue.aiSuggestion
    }))

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
    const analysisHtml = buildAnalysisHtml(reportIssues)

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UI 走查报告 - ${escapeHtml(page?.pageName ?? '')}</title>
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
  .canvas-title { padding:10px 14px; border-bottom:1px solid var(--border); font-size:12px; font-weight:600; color:var(--text2); display:flex; align-items:center; gap:8px; }
  .canvas-title::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--primary); }
  .rep-canvas { position:relative; background:#f6f7f9; }
  .rep-canvas img { width:100%; display:block; user-select:none; }
  .fs-btn { margin-left:auto; padding:3px 10px; font-size:12px; color:var(--text2); background:#fff; border:1px solid var(--border); border-radius:6px; cursor:pointer; }
  .fs-btn:hover { color:var(--primary); border-color:var(--primary); background:var(--primary-soft); }
  #card-design:fullscreen, #card-design:-webkit-full-screen,
  #card-screenshot:fullscreen, #card-screenshot:-webkit-full-screen { background:#eef1f6; padding:14px; display:flex; flex-direction:column; overflow:auto; }
  #card-design:fullscreen .canvas-title, #card-design:-webkit-full-screen .canvas-title,
  #card-screenshot:fullscreen .canvas-title, #card-screenshot:-webkit-full-screen .canvas-title { border-radius:8px; border:1px solid var(--border); }
  #card-design:fullscreen .rep-canvas, #card-design:-webkit-full-screen .rep-canvas,
  #card-screenshot:fullscreen .rep-canvas, #card-screenshot:-webkit-full-screen .rep-canvas { flex:1; min-height:0; overflow:auto; background:#fff; border-radius:8px; }
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
      <h1>UI 走查报告 - ${escapeHtml(page?.pageName ?? '')}</h1>
      <div class="meta">
        <strong>项目：</strong>${escapeHtml(project?.name ?? '')}　<strong>页面：</strong>${escapeHtml(page?.pageName ?? '')}　<strong>端类型：</strong>${page ? PLATFORM_LABELS[page.platform] : ''}${page?.figmaUrl ? `　<strong>设计稿：</strong><a href="${escapeHtml(page.figmaUrl)}" target="_blank" rel="noreferrer">在 Figma 中打开 ↗</a>` : ''}
        <br><strong>生成时间：</strong>${new Date().toLocaleString('zh-CN')}
      </div>
    </div>
    <button id="btn-export-summary" class="btn-export" onclick="exportSummary()" title="全部标注回应后可用">导出研发修改报告</button>
  </div>

  <div class="stats" id="stats"></div>

  <div class="hint-bar"><b>使用说明：</b>① 点击图片上的<b>标注序号</b>（或在下方明细清单中点击对应行），查看问题详情；② 在详情面板逐条回应「✓ 已修复」或「✕ 无法修复（需填写原因）」，回应自动保存到本机；③ 点击右上角「导出研发修改报告」生成完成情况汇总，未全部回应时会提示确认。</div>

  <div class="canvas-grid">
    <section class="canvas-card" id="card-design">
      <div class="canvas-title">设计稿<button class="fs-btn" id="fs-btn-design" onclick="toggleFs('card-design')">⛶ 全屏查看</button></div>
      <div class="rep-canvas" id="canvas-design">
        ${designImg ? `<img id="img-design" src="${designImg}" alt="设计稿">` : '<div style="padding:40px;text-align:center;color:#98a2b3">未上传设计稿</div>'}
        <svg class="arrow-layer" id="arrows-design"></svg>
        <div class="markers" id="markers-design"></div>
      </div>
    </section>

    <section class="canvas-card" id="card-screenshot">
      <div class="canvas-title">开发截图<button class="fs-btn" id="fs-btn" onclick="toggleFs('card-screenshot')">⛶ 全屏查看</button></div>
      <div class="rep-canvas" id="canvas-screenshot">
        ${shotImg ? `<img id="img-screenshot" src="${shotImg}" alt="开发截图">` : '<div style="padding:40px;text-align:center;color:#98a2b3">未上传开发截图</div>'}
        <svg class="arrow-layer" id="arrows-screenshot"></svg>
        <div class="markers" id="markers-screenshot"></div>
      </div>
    </section>
  </div>

  <section class="canvas-card">
    <div class="canvas-title">问题明细清单（点击行查看详情并回应）</div>
    <div class="issue-table-wrap"><table id="issue-table"></table></div>
  </section>

  ${analysisHtml}

  <footer>由 UI 走查工具生成</footer>
</div>

<div id="detail-mask" class="detail-mask" onclick="closeDetail()"></div>
<aside id="detail-panel" class="detail-panel"></aside>

<div id="export-confirm" class="modal-mask-rc hidden">
  <div class="modal-rc">
    <h3>还有标注未回应</h3>
    <p id="export-confirm-text"></p>
    <div class="modal-rc-actions">
      <button class="btn btn-plain" onclick="closeExportConfirm()">返回</button>
      <button class="btn btn-primary" onclick="doExportSummary()">继续导出报告</button>
    </div>
  </div>
</div>

<script>
var DATA = ${dataJson};
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
  var btn = document.getElementById('fs-btn');
  var btnDesign = document.getElementById('fs-btn-design');
  if (btn) btn.textContent = fsEl && fsEl.id === 'card-screenshot' ? '✕ 退出全屏' : '⛶ 全屏查看';
  if (btnDesign) btnDesign.textContent = fsEl && fsEl.id === 'card-design' ? '✕ 退出全屏' : '⛶ 全屏查看';
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

function buildMarkers() {
  ['design', 'screenshot'].forEach(function (target) {
    var layer = document.getElementById('markers-' + target);
    if (!layer) return;
    layer.innerHTML = '';
    DATA.issues.forEach(function (i) {
      if (i.targetImage !== target) return;
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
        var pickLine = i.sampleA ? '设计 ' + i.sampleA : (i.sampleB ? '开发 ' + i.sampleB : esc(i.description));
        if (i.sampleA && i.sampleB) pickLine += '<br>开发 ' + i.sampleB;
        el.innerHTML = '<span class="mk-num">' + i.no + '</span><span class="mk-pick-chip" style="background:' + chipHex + '"></span><span class="mk-pick-text">' + pickLine + '</span>';
      }
      if (el) {
        var cc = mkColor(i);
        if (cc) el.style.setProperty('--mk-c', cc);
        el.onclick = (function (issue) { return function () { openDetail(issue.id); }; })(i);
        layer.appendChild(el);
      }
    });
    drawArrows(target);
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
    if (i.targetImage !== target) return;
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
    '<div class="stat"><div class="num">' + total + '</div><div class="lbl">问题总数</div></div>' +
    '<div class="stat"><div class="num pend">' + pend + '</div><div class="lbl">待修复</div></div>' +
    '<div class="stat"><div class="num done">' + done + '</div><div class="lbl">已修复</div></div>' +
    '<div class="stat"><div class="num blocked">' + blocked + '</div><div class="lbl">无法修复</div></div>';
  var btn = document.getElementById('btn-export-summary');
  btn.disabled = false;
  btn.title = allResponded() ? '导出研发修改报告' : '还有 ' + pend + ' 个标注未回应，可确认后继续导出';
}

/** 问题明细清单：列出全部问题（含无坐标未上图），行可点击打开详情 */
function renderTable() {
  var tb = document.getElementById('issue-table');
  if (!tb) return;
  var head = '<thead><tr><th style="width:44px">#</th><th>问题描述</th><th style="width:86px">严重度</th><th style="width:92px">分类</th><th style="width:96px">标注图</th><th style="width:122px">回应结果</th></tr></thead>';
  var rows = DATA.issues.map(function (i) {
    var r = responses[i.id];
    var st = !r
      ? '<span class="tag st-wait">未回应</span>'
      : r.state === 'fixed'
        ? '<span class="tag st-fixed">✓ 已修复</span>'
        : '<span class="tag sev-major">✕ 无法修复</span>';
    return '<tr data-id="' + esc(i.id) + '"><td>' + i.no + '</td><td>' + esc(i.description) + '</td><td><span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span></td><td style="white-space:nowrap">' + esc(i.categoryLabel) + '</td><td style="white-space:nowrap">' + esc(i.targetLabel) + '</td><td>' + st + '</td></tr>';
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
    '<div class="dp-sub">问题 ' + i.no + ' · ' + esc(i.targetLabel) + (i.shapeLabel ? ' · ' + esc(i.shapeLabel) : '') + '</div></div>' +
    '<button class="dp-close" onclick="closeDetail()">×</button></div>' +
    '<div class="dp-card"><div class="dp-card-label">问题信息</div><div class="dp-meta">' +
    '<span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span>' +
    '<span class="tag plain">' + esc(i.categoryLabel) + '</span>' +
    '<span class="tag plain">' + esc(i.targetLabel) + '</span>' +
    '<span class="tag ' + (i.status === 'fixed' ? 'st-fixed' : 'st-pending') + '">' + esc(i.statusLabel) + '</span>' +
    '</div></div>' +
    '<div class="dp-card"><div class="dp-card-label">回应操作</div>';
  if (!r) {
    html += '<p class="dp-q">该问题是否已修复？</p>' +
      '<div class="dp-actions">' +
      '<button class="btn btn-primary" onclick="respond(\\'fixed\\')">✓ 已修复</button>' +
      '<button class="btn btn-ghost-danger" onclick="toggleBlock(true)">✕ 无法修复</button></div>' +
      '<div id="block-form" class="block-form hidden">' +
      '<textarea id="block-reason" placeholder="请填写无法修复的原因（必填），如：接口暂不支持、下版本处理等"></textarea>' +
      '<button class="btn btn-primary" onclick="submitBlock()">提交</button></div>';
  } else if (r.state === 'fixed') {
    html += '<div class="dp-state done">✓ 已修复' +
      (r.preset && !r.at ? '<span class="dp-time">（工具内复验已通过）</span>' : '<span class="dp-time">' + fmtTime(r.at) + '</span>') +
      '</div><button class="btn-text" onclick="clearResponse()">修改回应</button>';
  } else {
    html += '<div class="dp-state blocked">✕ 无法修复<span class="dp-time">' + fmtTime(r.at) + '</span></div>' +
      '<p class="dp-reason">' + esc(r.reason || '未填写原因') + '</p>' +
      '<button class="btn-text" onclick="clearResponse()">修改回应</button>';
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
  if (!v) { alert('请填写无法修复的原因'); return; }
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
    document.getElementById('export-confirm-text').textContent = '还有 ' + unresp + ' 个标注未回应修改结果，报告将按当前进度导出，未回应条目会标记为「未回应」。';
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
      ? '<span class="tag st-wait">未回应</span>'
      : r.state === 'fixed'
        ? '<span class="tag st-fixed">✓ 已完成</span>'
        : '<span class="tag sev-major">✕ 无法修复</span>' + (r.reason ? '<div class="dp-reason" style="margin-top:6px">' + esc(r.reason) + '</div>' : '');
    return '<tr><td>' + i.no + '</td><td>' + esc(i.description) + '</td><td><span class="tag sev-' + i.severity + '">' + esc(i.severityLabel) + '</span></td><td style="white-space:nowrap">' + esc(i.categoryLabel) + '</td><td style="white-space:nowrap">' + esc(i.targetLabel) + '</td><td>' + result + '</td></tr>';
  }).join('');
  var html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><title>研发修改报告 - ' + esc(DATA.pageName) + '</title><style>' +
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
    '<h1>研发修改报告</h1>' +
    '<div class="meta"><strong>项目：</strong>' + esc(DATA.projectName) + '　<strong>页面：</strong>' + esc(DATA.pageName) + '　<strong>端类型：</strong>' + esc(DATA.platformLabel) + (DATA.figmaUrl ? '　<strong>设计稿：</strong><a href="' + esc(DATA.figmaUrl) + '" target="_blank">在 Figma 中打开 ↗</a>' : '') + '<br><strong>导出时间：</strong>' + new Date().toLocaleString('zh-CN') + '</div>' +
    '<div class="stats">' +
    '<div class="stat"><div class="num">' + DATA.issues.length + '</div><div class="lbl">问题总数</div></div>' +
    '<div class="stat"><div class="num g">' + done + '</div><div class="lbl">已完成</div></div>' +
    '<div class="stat"><div class="num r">' + blocked + '</div><div class="lbl">无法修复</div></div>' +
    '<div class="stat"><div class="num">' + un + '</div><div class="lbl">未回应</div></div></div>' +
    '<table><thead><tr><th style="width:40px">#</th><th>问题描述</th><th style="width:86px">严重度</th><th style="width:92px">分类</th><th style="width:96px">标注图</th><th style="width:132px">处理结果</th></tr></thead><tbody>' +
    rows +
    '</tbody></table><footer>由 UI 走查工具导出的研发修改报告</footer></div></body></html>';
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
  var img = document.getElementById('img-screenshot');
  if (img && !img.complete) { img.addEventListener('load', function () { buildMarkers(); }); }
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
        setResultMsg({
          type: res.fallback ? 'warn' : 'ok',
          text: res.fallback ? `已导出（${res.message}）` : `已导出：${res.path}`
        })
      } else if (res && res.canceled) {
        return // 用户取消了保存对话框
      } else {
        setResultMsg({ type: 'error', text: `导出失败：${res?.message || '未知错误'}` })
      }
    } catch (err) {
      setResultMsg({ type: 'error', text: `导出失败：${err instanceof Error ? err.message : String(err)}` })
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

  /** 一键创建飞书文档（内容口径与 HTML 报告一致：排除未审核候选） */
  const doFeishu = async () => {
    if (!page) return
    setFeishuLoading(true)
    setResultMsg(null)
    try {
      const [designImg, shotImg] = await Promise.all([
        page.designImagePath ? window.electronAPI.readImage(page.designImagePath) : null,
        page.screenshotPath ? window.electronAPI.readImage(page.screenshotPath) : null
      ])
      const sorted = [...(issues ?? [])].sort((a, b) => a.createdAt - b.createdAt)
      const reportable = sorted.filter((i) => !(i.isAISuggested && !i.aiConfirmed))
      const doneCount = reportable.filter((i) => i.status === 'fixed').length
      const rawImages: { name: string; dataUrl: string }[] = []
      if (designImg) rawImages.push({ name: '设计稿', dataUrl: designImg })
      if (shotImg) rawImages.push({ name: '开发截图', dataUrl: shotImg })
      const images = await Promise.all(
        rawImages.map(async (img) => ({ name: img.name, dataUrl: await toUploadImage(img.dataUrl) }))
      )
      // 附件版 HTML 用压缩图重新生成，避免内嵌原图导致附件超过飞书 20MB 上传上限
      const attachHtml = await generateReportHTML({
        design: images.find((i) => i.name === '设计稿')?.dataUrl ?? (designImg ? '' : null),
        shot: images.find((i) => i.name === '开发截图')?.dataUrl ?? (shotImg ? '' : null)
      })
      const res = await window.electronAPI.feishuCreateReport({
        title: `UI 走查报告 - ${page.pageName}`,
        metaLines: [
          `项目：${project?.name ?? ''}　页面：${page.pageName}　端类型：${PLATFORM_LABELS[page.platform]}`,
          ...(page.figmaUrl ? [`设计稿：${page.figmaUrl}`] : []),
          `生成时间：${new Date().toLocaleString('zh-CN')}`
        ],
        stats: [
          { label: '问题总数', value: String(reportable.length) },
          { label: '已修复', value: String(doneCount) },
          { label: '待处理', value: String(reportable.length - doneCount) }
        ],
        issues: reportable.map((i, idx) => ({
          no: idx + 1,
          title: i.description,
          severityLabel: SEVERITY_LABELS[i.severity],
          categoryLabel: CATEGORY_LABELS[i.category],
          targetLabel: i.targetImage === 'design' ? '设计稿' : '开发截图',
          statusLabel: ISSUE_STATUS_LABELS[i.status],
          suggestion: i.aiSuggestion
        })),
        images,
        htmlReport: {
          name: `UI 走查报告 - ${page.pageName}.html`,
          dataUrl: htmlToDataUrl(attachHtml)
        }
      })
      // 主进程捕获错误后返回 {ok:false, message}，必须按 ok 分流而非无条件提示成功；
      // ok 时 message 可能携带降级/失败 warning（如附件上传失败、多维表降级），需完整透出
      if (!res.ok) {
        setResultMsg({ type: 'error', text: `创建飞书文档失败：${res.message}` })
        return
      }
      const msg = res.message ?? ''
      setResultMsg({
        type: msg && msg !== '文档创建成功' ? 'warn' : 'ok',
        text: msg || '飞书文档已创建，浏览器将自动打开'
      })
    } catch (err) {
      setResultMsg({
        type: 'error',
        text: `创建飞书文档失败：${err instanceof Error ? err.message : String(err)}`
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

  const handleFeishu = async () => {
    if (!feishuReady) {
      setResultMsg({ type: 'warn', text: '请先在「设置 → 应用授权」配置飞书自建应用的 App ID / App Secret' })
      return
    }
    if (unreviewed > 0) {
      setPendingAction('feishu')
      setShowUnreviewed(true)
      return
    }
    await doFeishu()
  }

  const total = issues?.length ?? 0
  const pending = issues?.filter((i) => i.status === 'pending').length ?? 0

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <Link to={`/project/${projectId}/page/${pageId}`} className="back-link">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            返回对比
          </Link>
          <h1>导出报告</h1>
        </div>
      </div>

      <div className="card export-card">
        <p>
          <strong>项目：</strong>
          {project?.name}
        </p>
        <p>
          <strong>页面：</strong>
          {page?.pageName}
        </p>
        <p>
          <strong>问题：</strong>
          共 {total} 个，待修复 {pending} 个
        </p>
        <p className="export-note">
          报告为交互式：研发可在报告内点击图上标注查看详情、回应「已修复 / 无法修复（原因）」，
          全部回应后可在报告内一键导出研发修改报告。
        </p>
        <div className="wizard-actions">
          <button className="btn-primary" onClick={handleExport} disabled={exporting || feishuLoading || !page}>
            {exporting ? '导出中...' : '导出 HTML 报告'}
          </button>
          <button
            className="btn-secondary"
            onClick={handleFeishu}
            disabled={feishuLoading || exporting || !page}
            title={feishuReady ? '将报告一键创建为飞书文档' : '需先在「AI 模型管理」配置飞书应用'}
          >
            {feishuLoading ? '创建中...' : '生成飞书文档'}
          </button>
        </div>
        {resultMsg && <p className={`export-result ${resultMsg.type}`}>{resultMsg.text}</p>}
      </div>

      {showUnreviewed && (
        <div
          className="modal-mask"
          onMouseDown={(e) => e.target === e.currentTarget && setShowUnreviewed(false)}
        >
          <div className="modal">
            <h3>存在未审核的 AI 候选标注</h3>
            <p className="modal-confirm-text">
              当前页面有 {unreviewed} 条 AI 候选标注尚未审核，它们不会计入
              {pendingAction === 'feishu' ? '飞书文档' : '本次导出的报告'}。
              可先返回工作台逐条采纳或忽略，也可以直接继续。
            </p>
            <div className="modal-actions">
              <span className="modal-spacer" />
              <button className="btn-secondary" onClick={() => setShowUnreviewed(false)}>
                返回审核
              </button>
              <button
                className="btn-primary"
                onClick={() => {
                  setShowUnreviewed(false)
                  if (pendingAction === 'export') {
                    doExport()
                  } else {
                    doFeishu()
                  }
                }}
              >
                继续{pendingAction === 'feishu' ? '创建飞书文档' : '导出'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
