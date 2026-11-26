import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { productDb, ProductAnnotation, ProductPage, bySort } from '../db/product'
import { Category, Severity, ISSUE_STATUS_LABELS, CATEGORY_LABELS, SEVERITY_LABELS } from '../db'
import type { IssueStatus } from '../db'
import { db, genId as uiGenId, softDeleteReports } from '../db'
import { confirmDialog } from '../components/ConfirmDialog'
import { toIntMeasureValue } from './ProductAnnotationCanvasPage'
import { inkFor } from '../components/AnnotationCanvas'

/** ───────────── 产品模式导出报告 ───────────── */

/** 文档导出目标（飞书 / 腾讯文档 / 金山文档，创建后自动打开；文案在语言包构建） */
type DocTargetKey = 'feishu' | 'tencent' | 'kingsoft'
const DOC_TARGET_KEYS: DocTargetKey[] = ['feishu', 'tencent', 'kingsoft']

const CAT_COLORS: Record<string, string> = {
  prototype: '#ec4899',
  spacing: '#2563eb',
  typography: '#7c3aed',
  color: '#f59e0b',
  style: '#dc2626',
  interaction: '#06b6d4',
  compatibility: '#16a34a',
  missing_component: '#9333ea',
}

const SEV_COLORS: Record<string, string> = {
  major: 'var(--anno-major)',
  minor: 'var(--anno-minor)',
  suggestion: 'var(--anno-suggestion)',
}

/** HTML 转义 */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** HTML 报告所在文件夹路径（悬停文件夹 icon 提示用）：取文件路径的目录部分 */
const folderOf = (p: string): string => p.replace(/[/\\][^/\\]*$/, '') || p

/** 附件缩略图（报告中使用） */
interface ReportAttachment {
  fileName: string
  thumbDataUrl: string
  /** 用于右侧面板展开时显示大图 */
  fullDataUrl?: string
}

/** 产品标注 → 报告数据行 */
interface ReportIssue {
  id: string
  no: number
  pageName: string
  pageImage?: string
  shape: string
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
  color?: string
  measureValue?: string
  sampleColor?: string
  category: string
  attachments?: ReportAttachment[]
}

/** 压缩为 JPEG（最长边 1600px），控制报告体积 */
const toReportImage = (dataUrlOrBlob: string | Blob): Promise<string> =>
  new Promise((resolve) => {
    // Blob 转 ObjectURL
    const src = dataUrlOrBlob instanceof Blob ? URL.createObjectURL(dataUrlOrBlob) : dataUrlOrBlob
    const img = new Image()
    img.onload = () => {
      try {
        const MAX = 1600
        const scale = Math.min(1, MAX / Math.max(img.width, img.height))
        const w = Math.max(1, Math.round(img.width * scale))
        const h = Math.max(1, Math.round(img.height * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve(src)
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, w, h)
        ctx.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.88))
      } catch {
        resolve(src)
      }
      if (src.startsWith('blob:')) URL.revokeObjectURL(src)
    }
    img.onerror = () => {
      if (src.startsWith('blob:')) URL.revokeObjectURL(src)
      resolve('')
    }
    img.src = src
  })

/** 标注 → 报告数据行（测量值与画布口径一致：只保留整数，禁止小数） */
function toReportIssueRow(a: ProductAnnotation, page: ProductPage, idx: number): ReportIssue {
  return {
    id: a.id,
    no: idx + 1,
    pageName: page.name,
    shape: a.type,
    x: a.x,
    y: a.y,
    width: a.width,
    height: a.height,
    description: a.description,
    severity: (a.severity ?? 'minor') as Severity,
    severityLabel: SEVERITY_LABELS[(a.severity ?? 'minor') as Severity],
    categoryLabel: CATEGORY_LABELS[(a.category ?? 'spacing') as Category],
    status: (a.status ?? 'pending') as IssueStatus,
    statusLabel: ISSUE_STATUS_LABELS[(a.status ?? 'pending') as IssueStatus],
    color: a.color,
    measureValue: a.measureValue ? toIntMeasureValue(a.measureValue) : undefined,
    sampleColor: a.sampleColor,
    category: (a.category ?? 'spacing') as Category,
    attachments: a.attachments?.map((att) => ({
      fileName: att.fileName,
      thumbDataUrl: att.thumbDataUrl,
      fullDataUrl: att.thumbDataUrl, // 报告内大图也用缩略图，避免数据过大
    })),
  }
}

/** 标注绘制色（与 HTML 报告一致）：已修复转绿，自定义色优先，其余按严重度 */
const sevDrawColor = (i: ReportIssue): string => {
  if (i.status === 'fixed') return '#16a34a'
  if (i.status === 'blocked') return '#dc2626'
  if (i.color) return i.color
  if (i.severity === 'major') return '#dc2626'
  if (i.severity === 'minor') return '#f59e0b'
  if (i.severity === 'suggestion') return '#667085'
  return '#2563eb'
}

/** 文档明细标题：描述 + 测量/取样详情后缀（在线文档表格列有限，详情并入标题展示） */
const docIssueTitle = (i: ReportIssue): string => {
  const desc = i.description || ''
  if (i.shape === 'measure' && i.measureValue) return desc ? `${desc}（测量 ${i.measureValue}）` : `测量 ${i.measureValue}`
  if (i.shape === 'picker' && i.sampleColor) return desc ? `${desc}（取样 ${i.sampleColor}）` : `取样 ${i.sampleColor}`
  return desc
}

/** 把标注合成到页面图上生成静态标注图（供在线文档正文嵌入：飞书/腾讯文档无法承载 SVG 覆盖层）。
 * 与报告画布同款样式：序号徽章 / 矩形框 / 点位 / 箭头 / 测量线（含⊥短线与整数尺寸文案）/ 文字 / 取色 */
const compositeAnnotations = (imageBase64: string, issues: ReportIssue[]): Promise<string> =>
  new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const W = img.naturalWidth
        const H = img.naturalHeight
        if (!W || !H) return resolve('')
        const canvas = document.createElement('canvas')
        canvas.width = W
        canvas.height = H
        const ctx = canvas.getContext('2d')
        if (!ctx) return resolve('')
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, W, H)
        ctx.drawImage(img, 0, 0)
        // 线宽/字号随图宽缩放：报告画板显示宽约 1100px，保持与 HTML 报告视觉比例一致
        const s = Math.max(1, W / 1100)
        ctx.lineCap = 'round'
        ctx.textBaseline = 'middle'
        const setFont = (px: number) => {
          ctx.font = `700 ${px * s}px -apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif`
        }
        // 序号徽章：彩色圆 + 白描边 + 白字（与报告 mk-num 样式一致）
        const badge = (cx: number, cy: number, no: number, color: string) => {
          ctx.beginPath()
          ctx.arc(cx, cy, 10 * s, 0, Math.PI * 2)
          ctx.fillStyle = color
          ctx.fill()
          ctx.lineWidth = 2 * s
          ctx.strokeStyle = '#ffffff'
          ctx.stroke()
          setFont(11)
          ctx.textAlign = 'center'
          ctx.fillStyle = inkFor(color)
          ctx.fillText(String(no), cx, cy + 0.5)
        }
        // 白描边文字（模拟 paint-order: stroke，浅色底上仍可读）
        const haloText = (text: string, x: number, y: number, color: string, px: number, align: CanvasTextAlign) => {
          setFont(px)
          ctx.textAlign = align
          ctx.lineWidth = 4 * s
          ctx.strokeStyle = '#ffffff'
          ctx.strokeText(text, x, y)
          ctx.fillStyle = color
          ctx.fillText(text, x, y)
        }
        issues.forEach((i) => {
          const color = sevDrawColor(i)
          const x = i.x * W
          const y = i.y * H
          const w = i.width * W
          const h = i.height * H
          if (i.shape === 'rect') {
            ctx.lineWidth = 2 * s
            ctx.strokeStyle = color
            ctx.strokeRect(x, y, w, h)
            badge(x, y, i.no, color)
          } else if (i.shape === 'point') {
            ctx.beginPath()
            ctx.arc(x, y, 9 * s, 0, Math.PI * 2)
            ctx.fillStyle = color
            ctx.fill()
            ctx.lineWidth = 2 * s
            ctx.strokeStyle = '#ffffff'
            ctx.stroke()
            setFont(11)
            ctx.textAlign = 'center'
            ctx.fillStyle = inkFor(color)
            ctx.fillText(String(i.no), x, y + 0.5)
          } else if (i.shape === 'arrow') {
            const ex = x + w
            const ey = y + h
            ctx.lineWidth = 2.5 * s
            ctx.strokeStyle = color
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.lineTo(ex, ey)
            ctx.stroke()
            const ang = Math.atan2(ey - y, ex - x)
            const head = 13 * s
            ctx.beginPath()
            ctx.moveTo(ex, ey)
            ctx.lineTo(ex - head * Math.cos(ang - 0.42), ey - head * Math.sin(ang - 0.42))
            ctx.lineTo(ex - head * Math.cos(ang + 0.42), ey - head * Math.sin(ang + 0.42))
            ctx.closePath()
            ctx.fillStyle = color
            ctx.fill()
            badge((x + ex) / 2, (y + ey) / 2, i.no, color)
          } else if (i.shape === 'measure') {
            const ex = x + w
            const ey = y + h
            ctx.lineWidth = 2 * s
            ctx.strokeStyle = color
            ctx.beginPath()
            ctx.moveTo(x, y)
            ctx.lineTo(ex, ey)
            ctx.stroke()
            // 两端⊥短线（与画布/报告样式一致，颜色同主线）
            const len = Math.hypot(w, h) || 1
            const nx = -h / len
            const ny = w / len
            const t = 6 * s
            for (const [px2, py2] of [
              [x, y],
              [ex, ey]
            ] as Array<[number, number]>) {
              ctx.beginPath()
              ctx.moveTo(px2 - nx * t, py2 - ny * t)
              ctx.lineTo(px2 + nx * t, py2 + ny * t)
              ctx.stroke()
            }
            const vertical = Math.abs(i.width) < Math.abs(i.height)
            const label = i.measureValue || `${Math.round(Math.hypot(w, h))}px`
            haloText(
              label,
              vertical ? (x + ex) / 2 + 8 * s : (x + ex) / 2,
              vertical ? (y + ey) / 2 : (y + ey) / 2 - 9 * s,
              color,
              12.5,
              vertical ? 'start' : 'center'
            )
            badge(vertical ? x + 12 * s : x, vertical ? y : y - 12 * s, i.no, color)
          } else if (i.shape === 'text') {
            badge(x, y, i.no, color)
            // 描述含换行时逐行渲染，整块相对点位垂直居中（与画布 SVG 渲染口径一致）
            const lines = (i.description || '').split('\n')
            const lh = 18 * s
            lines.forEach((ln, idx) => haloText(ln, x + 16 * s, y - ((lines.length - 1) / 2) * lh + idx * lh, color, 14, 'start'))
          } else if (i.shape === 'picker') {
            ctx.beginPath()
            ctx.arc(x, y, 7 * s, 0, Math.PI * 2)
            ctx.fillStyle = i.sampleColor || color
            ctx.fill()
            ctx.lineWidth = 1.5 * s
            ctx.strokeStyle = '#ffffff'
            ctx.stroke()
            if (i.sampleColor) haloText(i.sampleColor, x + 11 * s, y, color, 12, 'start')
            badge(x - 12 * s, y, i.no, color)
          }
        })
        resolve(canvas.toDataURL('image/jpeg', 0.88))
      } catch {
        resolve('')
      }
    }
    img.onerror = () => resolve('')
    img.src = imageBase64
  })

/** 单页画布卡片 HTML（key 用于侧边锚点定位与箭头层运行时绘制） */
function buildPageCanvas(key: string, pageName: string, pageImage: string, issues: ReportIssue[]): string {
  // 分离普通标记与箭头/测量 SVG；文字/颜色标注输出「点位圆点 + 内容胶囊」两个元素（与画布编辑器一致）
  const markersHtml = issues
    .map((i) => {
      const shape = i.shape || 'rect'
      let els: string[] = []
      if (shape === 'rect') {
        els = [`<div class="mk mk-box sev-${i.severity}" data-id="${esc(i.id)}" style="left:${i.x * 100}%;top:${i.y * 100}%;width:${i.width * 100}%;height:${i.height * 100}%">` +
          `<span class="mk-hit mk-hit-t"></span><span class="mk-hit mk-hit-b"></span><span class="mk-hit mk-hit-l"></span><span class="mk-hit mk-hit-r"></span>` +
          `<span class="mk-num">${i.no}</span></div>`]
      } else if (shape === 'point') {
        els = [`<div class="mk mk-pin sev-${i.severity}" data-id="${esc(i.id)}" style="left:${i.x * 100}%;top:${i.y * 100}%"><span class="mk-num">${i.no}</span></div>`]
      } else if (shape === 'text') {
        // 与 UI 走查报告一致：序号内嵌胶囊左端锚定标注点（即点位标记），贴右缘时由运行时避让翻转到左侧
        els = [`<div class="mk mk-label sev-${i.severity}" data-id="${esc(i.id)}" style="left:${i.x * 100}%;top:${i.y * 100}%"><span class="mk-num">${i.no}</span><span class="mk-text">${esc(i.description || '')}</span></div>`]
      } else if (shape === 'picker') {
        // 与 UI 走查报告一致：序号 + 取样色圆片 + 色值文本内嵌同一胶囊，锚定标注点
        const pickText = i.sampleColor ? i.sampleColor : esc(i.description || '')
        const pickChip = i.sampleColor ? `<span class="mk-pick-chip" style="background:${esc(i.sampleColor)}"></span>` : ''
        els = [`<div class="mk mk-pick sev-${i.severity}" data-id="${esc(i.id)}" style="left:${i.x * 100}%;top:${i.y * 100}%"><span class="mk-num">${i.no}</span>${pickChip}<span class="mk-pick-text">${pickText}</span></div>`]
      } else if (shape === 'measure') {
        // 仅生成序号徽章，SVG 测量线移至独立 overlay
        const mv = Math.abs(i.width) < Math.abs(i.height)
        const cc = mv ? 'mk-mv' : 'mk-mh'
        els = [`<div class="mk mk-measure ${cc} sev-${i.severity}" data-id="${esc(i.id)}" style="left:${(i.x + i.width / 2) * 100}%;top:${(i.y + i.height / 2) * 100}%"><span class="mk-num">${i.no}</span></div>`]
      } else if (shape === 'arrow') {
        // 仅生成序号徽章，SVG 箭头线移至独立 overlay
        els = [`<div class="mk mk-pin sev-${i.severity}" data-id="${esc(i.id)}" style="left:${(i.x + i.width / 2) * 100}%;top:${(i.y + i.height / 2) * 100}%"><span class="mk-num">${i.no}</span></div>`]
      }
      if (i.color) {
        // 追加到既有 style 属性（直接替换 sev-class 会破坏引号结构导致 HTML 畸形）；
        // 浅色标注底（如白色）时序号自动切深色字，避免数字与底色融合
        const ink = inkFor(i.color)
        const inkCss = ink === '#fff' ? '' : `;--mk-ink:${ink}`
        // 浅色标注色（白色等）：胶囊文字也切深色，避免白字白底不可读（深色时缺省回退 var(--mk-c)）
        const lblCss = ink === '#334155' ? ';--mk-lbl:#334155' : ''
        const colorCss = `;--mk-c:${esc(i.color)}${inkCss}${lblCss}`
        els = els.map((e) => e.replace(/style="([^"]*)"/, (m, s) => `style="${s}${colorCss}"`))
      }
      return els.join('')
    })
    .join('')

  // 箭头/测量线改为运行时绘制：百分比 viewBox + preserveAspectRatio="none" 会让
  // 箭头头部多边形、测量文字与描边在非正方形画板上被拉伸变形（运行时用像素坐标无此问题）
  return `
    <section class="canvas-card" id="page-${key}">
      <div class="canvas-title"><span class="ct-name">${esc(pageName)}</span><div class="zoom-bar" data-key="${key}">
        <button type="button" data-zoom="out" title="缩小">−</button>
        <span class="zoom-val">100%</span>
        <button type="button" data-zoom="in" title="放大">+</button>
        <button type="button" class="z-reset" data-zoom="reset" title="重置为原始尺寸">1:1</button>
      </div></div>
      <div class="rep-canvas">
        <div class="rep-stage" id="stage-${key}">
          <img src="${pageImage}" alt="${esc(pageName)}">
          <svg class="arrow-layer" id="arrows-${key}"></svg>
          <div class="markers">${markersHtml}</div>
        </div>
      </div>
    </section>`
}

/** 右侧问题清单面板 HTML（与标注时清单位置一致，替代底部明细表）：
 * 条目可展开详情，支持切换「待修复 / 已修复」与回复修复说明；状态由脚本持久化，可导出回复报告 */
function buildIssuePanel(issues: ReportIssue[]): string {
  if (!issues.length) return ''
  const renderItem = (i: ReportIssue): string => {
    const drawColor = sevDrawColor(i)
    const extra =
      i.shape === 'measure' && i.measureValue
        ? `<div class="ii-extra"><span class="ii-extra-lbl">${esc('测量值')}</span><span class="ii-extra-val">${esc(i.measureValue)}</span></div>`
        : i.shape === 'picker' && i.sampleColor
          ? `<div class="ii-extra"><span class="ii-extra-lbl">${esc('取样色值')}</span><span class="ii-chip" style="background:${esc(i.sampleColor)}"></span><span class="ii-extra-val mono">${esc(i.sampleColor.toUpperCase())}</span></div>`
          : ''
    const attsHtml = i.attachments && i.attachments.length > 0
      ? `<div class="ii-atts"><span class="ii-extra-lbl">${esc('截图附件')}</span><div class="ii-atts-grid">${i.attachments.map((a) => `<img src="${a.thumbDataUrl}" alt="${esc(a.fileName)}" class="ii-att-img" title="${esc(a.fileName)}"/>`).join('')}</div></div>`
      : ''
    return `<div class="issue-item" data-id="${esc(i.id)}" data-cat="${esc(i.category || 'spacing')}">
  <div class="ii-head">
    <span class="ii-no" style="background:${drawColor};color:${inkFor(drawColor)}">${i.no}</span>
    <div class="ii-main">
      <div class="ii-desc">${esc(i.description || '(无描述)')}</div>
      <div class="ii-meta"><span class="tag sev-${i.severity}">${esc(i.severityLabel)}</span><span class="tag plain">${esc(i.categoryLabel)}</span><span class="ii-page">${esc(i.pageName)}</span></div>
    </div>
    <span class="ii-status st-pending" data-role="status">${esc(i.statusLabel)}</span>
  </div>
  <div class="ii-body">
    ${extra}
    ${attsHtml}
    <div class="ii-actions"><button type="button" class="st-btn" data-st="pending">${esc('待修复')}</button><button type="button" class="st-btn" data-st="fixed">${esc('已修复')}</button><button type="button" class="st-btn" data-st="blocked">${esc('无法修复')}</button></div>
    <div class="ii-blocked" style="display:none"><textarea class="ii-reply" placeholder="${esc('回复无法修复说明…')}"></textarea><div class="ii-blocked-foot"><button type="button" class="ii-save-btn" data-role="reply-save">保存</button><span class="ii-reply-meta" data-role="reply-meta"></span></div></div>
  </div>
</div>`
  }
  // 按页面分组（保持首次出现顺序），每组一个可折叠区块；组内条目顺序不变
  const groups: { name: string; html: string[]; count: number }[] = []
  const groupIdx = new Map<string, number>()
  issues.forEach((i) => {
    let gi = groupIdx.get(i.pageName)
    if (gi === undefined) {
      gi = groups.length
      groupIdx.set(i.pageName, gi)
      groups.push({ name: i.pageName, html: [], count: 0 })
    }
    groups[gi].html.push(renderItem(i))
    groups[gi].count++
  })
  const items = groups
    .map(
      (g) => `<div class="ip-group" data-page="${esc(g.name)}">
  <button type="button" class="ip-group-head"><span class="ipg-arrow"></span><span class="ipg-name">${esc(g.name)}</span><span class="ipg-n">${g.count}</span></button>
  <div class="ip-group-body">${g.html.join('')}</div>
</div>`
    )
    .join('')
  // 分类筛选 chips：全部 + 各分类（带计数与分类色点），data-cat 为空串表示全部
  const catCount: Record<string, number> = {}
  issues.forEach((i) => {
    const c = i.category || 'spacing'
    catCount[c] = (catCount[c] ?? 0) + 1
  })
  const filterChips =
    `<button type="button" class="ipf-chip active" data-cat="">${esc('全部')}<span class="ipf-n">${issues.length}</span></button>` +
    Object.entries(catCount)
      .map(
        ([c, n]) =>
          `<button type="button" class="ipf-chip" data-cat="${esc(c)}"><span class="ipf-dot" style="background:${CAT_COLORS[c] ?? '#98a2b3'}"></span>${esc(CATEGORY_LABELS[c as Category] ?? c)}<span class="ipf-n">${n}</span></button>`
      )
      .join('')

  return `
<aside class="issue-panel" id="issue-panel">
  <div class="ip-head">
    <div class="ip-title">${esc('问题清单')}<span class="ip-count" id="ip-count"></span></div>
    <button type="button" class="ip-export" onclick="exportReplyReport()">${esc('导出回复报告')}</button>
  </div>
  <div class="ip-legend" id="ip-legend"></div>
  <div class="ip-filters" id="ip-filters">${filterChips}</div>
  <div class="ip-list" id="ip-list">${items}</div>
</aside>`
}

/** 统计卡片 HTML */
function buildStats(issues: ReportIssue[]): string {
  const sevCount: Record<string, number> = { major: 0, minor: 0, suggestion: 0 }
  issues.forEach((i) => {
    if (sevCount[i.severity] !== undefined) sevCount[i.severity]++
  })
  return `
    <div class="stats">
      <div class="stat"><div class="num">${issues.length}</div><div class="lbl">${esc('总计')}</div></div>
      <div class="stat"><div class="num" style="color:var(--anno-major)">${sevCount.major}</div><div class="lbl">${esc('严重')}</div></div>
      <div class="stat"><div class="num" style="color:var(--anno-minor)">${sevCount.minor}</div><div class="lbl">${esc('一般')}</div></div>
      <div class="stat"><div class="num" style="color:var(--anno-suggestion)">${sevCount.suggestion}</div><div class="lbl">${esc('建议')}</div></div>
    </div>`
}

export default function ProductExportReport() {
  const { t } = useTranslation('productCanvas')
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  /** 当前标注集（从标注画布进入时携带）：报告只覆盖该标注集的页面，与实际标注范围一致 */
  const [searchParams] = useSearchParams()
  const setId = searchParams.get('setId')

  const project = useLiveQuery(() => productDb.projects.get(projectId!), [projectId])
  // 目标标注集（页面）：报告标题以页面名称命名，而非项目名称
  const targetSet = useLiveQuery(async () => (setId ? productDb.sets.get(setId) : undefined), [setId])
  /** 报告标题基准名：页面（标注集）名称优先，旧入口无 setId 时回退项目名 */
  const reportName = targetSet?.name ?? project?.name ?? '产品标注报告'
  const allPages = useLiveQuery(
    async () => {
      // 指定标注集时只取该集页面（与画布实际标注的页面一致）；旧入口无 setId 时回退到全项目页面
      const rows = setId
        ? await productDb.pages.where('setId').equals(setId).toArray()
        : await productDb.pages.where('projectId').equals(projectId!).toArray()
      return rows.sort(bySort)
    },
    [projectId, setId]
  )

  /** 全项目标注总数：聚合各页 count（不能在渲染中内联 Dexie Promise，否则会显示 [object Dexie.Promise]） */
  const totalAnnotations =
    useLiveQuery(async () => {
      if (!allPages) return 0
      const counts = await Promise.all(allPages.map((p) => productDb.annotations.where('pageId').equals(p.id).count()))
      return counts.reduce((sum, c) => sum + c, 0)
    }, [allPages]) ?? 0

  /** 导出状态 */
  const [exporting, setExporting] = useState(false)
  const [resultMsg, setResultMsg] = useState<{ type: 'ok' | 'warn' | 'error'; text: string } | null>(null)
  /** 飞书配置是否就绪 */
  const [feishuReady, setFeishuReady] = useState(false)
  const [docLoading, setDocLoading] = useState(false)
  /** 文档导出目标（飞书 / 腾讯 / 金山） */
  const [docTarget, setDocTarget] = useState<DocTargetKey>('feishu')
  /** 目标按钮文案（按当前语言构建） */
  const docTargets = DOC_TARGET_KEYS.map((key) => ({
    key,
    label: t(`docTarget.${key}.label`),
    btn: t(`docTarget.${key}.btn`),
    name: t(`docTarget.${key}.name`),
  }))

  // 检查飞书配置
  useEffect(() => {
    window.electronAPI.getConfig().then((cfg) => {
      const f = (cfg.feishu ?? {}) as { appId?: string; appSecret?: string }
      setFeishuReady(!!f.appId && !!f.appSecret)
    })
  }, [])

  /** HTML → dataUrl（用于飞书/腾讯附件上传） */
  const htmlToDataUrl = (html: string): string => {
    const bytes = new TextEncoder().encode(html)
    let bin = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return 'data:text/html;base64,' + btoa(bin)
  }

  /** 加载全部页面 + 标注 + 报告压缩图并组装数据行（HTML 报告与在线文档共用同一数据源，测量值/序号/页面口径一致） */
  const loadPageData = async () => {
    const out: Array<{ page: ProductPage; annotations: ProductAnnotation[]; imageBase64: string; issues: ReportIssue[] }> = []
    if (!allPages?.length) return out
    for (const page of allPages) {
      const annotations = (await productDb.annotations.where('pageId').equals(page.id).toArray()).sort((a, b) => a.createdAt - b.createdAt)
      const imageBase64 = await toReportImage(page.image)
      out.push({ page, annotations, imageBase64, issues: annotations.map((a, idx) => toReportIssueRow(a, page, idx)) })
    }
    return out
  }

  /** 生成报告 HTML（复用现有导出引擎的 CSS Token，仅裁剪内容块） */
  const generateReportHTML = async (): Promise<string> => {
    if (!allPages?.length) return '<html><body>Empty</body></html>'

    // 逐页加载图片 + 标注（测量值已按画布口径取整）
    const pageData = await loadPageData()
    const allIssues = pageData.flatMap((pd) => pd.issues)

    // 逐页画布 HTML + 侧边导航 + 箭头绘制数据（仅含已上图且有标注的页面；key 用数字索引，避免页面名含空格/特殊字符时锚点跳转失效）
    const canvasParts: string[] = []
    const sidebarParts: string[] = []
    const arrowPages: Array<{ key: string; issues: ReportIssue[] }> = []
    pageData.forEach(({ page, imageBase64, issues: pageIssues }, pi) => {
      if (!imageBase64 || !pageIssues.length) return
      const key = String(pi)
      canvasParts.push(buildPageCanvas(key, page.name, imageBase64, pageIssues))
      sidebarParts.push(`
    <a class="sidebar-item" href="#page-${key}">
      <div class="sidebar-thumb" style="background-image:url(${imageBase64})"></div>
      <div class="sidebar-page-name">${esc(page.name)}</div>
    </a>`)
      arrowPages.push({ key, issues: pageIssues })
    })
    const canvasesHtml = canvasParts.join('')
    const sidebarHtml = sidebarParts.join('')

    // 报告实例唯一键：回复状态 localStorage 按报告隔离 + 回复报告内嵌状态识别
    const reportKey = `r${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

    // 构建完整 HTML
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(reportName)}</title>
<style>
  :root { --primary:#2563eb; --text:#1f2937; --text-2:#667085; --text-3:#98a2b3; --surface-sunken:#f6f7f9; --border:#e7eaf0; --bg:#f5f6f8; --card-bg:#fff; --radius:12px; --radius-sm:8px; --shadow-card:0 1px 2px rgba(16,24,40,.04); --anno-suggestion:#667085; --anno-minor:#f59e0b; --anno-minor-text:#b45309; --anno-major:#dc2626; --fill:#f2f4f8; --fill-soft:#fafbfd; --surface-inset:#f9fafb; --success-soft:#e8f7ee; --success-text:#15803d; --danger-soft:#fde8e8; --warning-soft:#fef3c7; --primary-soft:#eff4ff; }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif; background:var(--bg); color:var(--text); padding:28px 32px 60px; padding-left:184px; padding-right:352px; }
  .wrap { max-width:1100px; margin:0 auto; }
  .rep-header h1 { font-size:22px; font-weight:700; }
  .meta { color:var(--text-2); font-size:13px; margin-top:8px; line-height:1.7; }
  .stats { display:flex; gap:16px; margin:16px 0 24px; }
  .stat { flex:1; background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius); padding:16px; text-align:center; box-shadow:var(--shadow-card); }
  .stat .num { font-size:26px; font-weight:700; }
  .stat .lbl { font-size:12px; color:var(--text-2); margin-top:4px; }
  .canvas-card { background:var(--card-bg); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin-bottom:20px; box-shadow:var(--shadow-card); position:relative; }
  .canvas-title { padding:12px 16px; border-bottom:1px solid var(--border); font-size:12px; font-weight:600; color:var(--text-2); display:flex; align-items:center; gap:8px; }
  .canvas-title::before { content:''; width:6px; height:6px; border-radius:50%; background:var(--primary); }
  .canvas-title .ct-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .rep-canvas { position:relative; background:var(--surface-sunken); overflow:auto; }
  .rep-canvas img { width:100%; display:block; user-select:none; }
  .rep-stage { position:relative; width:100%; }
  /* 画板缩放工具条：放在画板标题行最右侧（flex 布局 margin-left:auto 推到行尾） */
  .zoom-bar { position:relative; flex-shrink:0; margin-left:auto; display:flex; align-items:center; gap:2px; background:var(--card-bg); border:1px solid var(--border); border-radius:999px; padding:3px 6px; box-shadow:0 2px 8px rgba(16,24,40,.14); }
  .zoom-bar button { min-width:24px; height:24px; border:none; background:transparent; border-radius:999px; font-size:14px; font-weight:700; color:var(--text); cursor:pointer; padding:0 6px; }
  .zoom-bar button:hover { background:var(--surface-sunken); }
  .zoom-bar .zoom-val { min-width:42px; text-align:center; font-size:12px; font-weight:600; color:var(--text-2); }
  .zoom-bar .z-reset { font-size:11px; font-weight:600; color:var(--text-2); }
  .rep-stage.zoomed { cursor:grab; }
  .rep-stage.dragging { cursor:grabbing; }
  .rep-svg { position:absolute; inset:0; width:100%; height:100%; z-index:1; overflow:visible; pointer-events:none; }
  .arrow-layer { position:absolute; inset:0; width:100%; height:100%; z-index:1; overflow:visible; pointer-events:none; }
  .arrow-layer .rep-arrow-hit { stroke:transparent; stroke-width:14; fill:none; pointer-events:stroke; cursor:pointer; }
  .arrow-layer .rep-measure-hit { stroke:transparent; stroke-width:14; fill:none; pointer-events:stroke; cursor:pointer; }
  .arrow-layer .rep-measure-label { pointer-events:auto; cursor:pointer; }
  .markers { position:absolute; inset:0; z-index:2; pointer-events:none; }
  .markers .mk { pointer-events:auto; }
  .markers .mk-box { pointer-events:none; }
  .mk { position:absolute; cursor:pointer; }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-measure, .rep-measure-label) { --mk-c:var(--primary); }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-measure, .rep-measure-label).sev-major { --mk-c:var(--anno-major); }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-measure, .rep-measure-label).sev-minor { --mk-c:var(--anno-minor); }
  :is(.mk, .rep-arrow, .rep-arrow-head, .rep-measure, .rep-measure-label).sev-suggestion { --mk-c:var(--anno-suggestion); }
  .mk-box { border:2px solid var(--mk-c); border-radius:4px; background:color-mix(in srgb, var(--mk-c) 6%, transparent); pointer-events:none; }
  .mk-hit { position:absolute; pointer-events:auto; cursor:pointer; }
  .mk-hit-t { left:-8px; right:-8px; top:-8px; height:16px; }
  .mk-hit-b { left:-8px; right:-8px; bottom:-8px; height:16px; }
  .mk-hit-l { top:-8px; bottom:-8px; left:-8px; width:16px; }
  .mk-hit-r { top:-8px; bottom:-8px; right:-8px; width:16px; }
  .mk-box .mk-num { pointer-events:auto; }
  .mk-num { position:absolute; top:-11px; left:-11px; min-width:20px; height:20px; padding:0 4px; border-radius:999px; background:var(--mk-c); color:var(--mk-ink,#fff); font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; box-shadow:0 0 0 2px #fff; }
  .mk-pin { width:22px; height:22px; border-radius:50%; background:var(--mk-c); transform:translate(-50%,-50%); display:flex; align-items:center; justify-content:center; box-shadow:0 0 0 2px #fff, 0 2px 6px rgba(0,0,0,.25); }
  .mk-pin .mk-num { position:static; box-shadow:none; background:transparent; }
  .mk-label { transform:translateY(-50%); background:rgba(255,255,255,.96); border:1.5px solid var(--mk-c); color:var(--mk-lbl,var(--mk-c)); border-radius:999px; padding:2px 12px 2px 2px; font-size:12px; font-weight:600; max-width:280px; width:max-content; display:flex; align-items:center; gap:8px; }
  .mk-label .mk-num { position:static; flex-shrink:0; }
  /* 描述支持换行（编辑器为多行输入）：pre-line 保留 \n，长句按 max-width 自动折行 */
  .mk-label .mk-text { white-space:pre-line; line-height:1.45; overflow-wrap:anywhere; }
  .mk-pick { display:flex; align-items:center; gap:8px; transform:translate(-8px,-50%); background:rgba(255,255,255,.96); border:1.5px solid var(--mk-c); border-radius:999px; padding:2px 12px 2px 4px; font-size:12px; font-weight:600; color:#1f2733; max-width:190px; width:max-content; }
  .mk-pick .mk-num { position:static; flex-shrink:0; }
  .mk-pick-chip { width:16px; height:16px; border-radius:50%; flex-shrink:0; box-shadow:0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,.2); }
  .mk-pick-text { line-height:1.35; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  /* 贴边翻转避让后的位置指引：胶囊右缘外侧小三角指向标记点，保证点位直观 */
  .mk-label.flip::after, .mk-pick.flip::after { content:''; position:absolute; left:100%; top:50%; margin-top:-5px; border:5px solid transparent; border-left-color:var(--mk-c); }
  /* 常驻点位箭头：胶囊左端外侧小三角指向标记点（贴右缘翻转时由右端 .flip::after 接管） */
  .mk-label::before, .mk-pick::before { content:''; position:absolute; right:100%; top:50%; margin-top:-5px; border:5px solid transparent; border-right-color:var(--mk-c); }
  .mk-label.flip::before, .mk-pick.flip::before { content:none; }
  .rep-arrow { stroke:var(--mk-c); stroke-width:2.5; fill:none; }
  .rep-arrow-head { fill:var(--mk-c); }
  .rep-measure { stroke:var(--mk-c); stroke-width:2; fill:none; }
  .rep-measure-label { fill:var(--mk-c); font-size:12.5px; font-weight:700; dominant-baseline:central; paint-order:stroke; stroke:#fff; stroke-width:4px; }
  .mk-measure { position:absolute; transform:translate(-50%,-50%); }
  .mk-mh .mk-num { top:6px; left:0; transform:translate(-50%,0); position:absolute; }
  .mk-mv .mk-num { top:0; left:-6px; transform:translate(-100%,-50%); position:absolute; }
  /* 标签 */
  .tag { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:500; white-space:nowrap; }
  .tag.sev-major { background:var(--danger-soft); color:var(--anno-major); }
  .tag.sev-minor { background:var(--warning-soft); color:var(--anno-minor-text); }
  .tag.sev-suggestion { background:var(--fill); color:var(--anno-suggestion); }
  .tag.st-pending { background:var(--primary-soft); color:var(--primary); }
  .tag.plain { background:var(--fill); color:var(--text-2); }
  /* 右侧问题清单（与标注时清单位置一致）：展开详情、切换待修复/已修复、回复修复说明 */
  .issue-panel { position:fixed; top:0; right:0; bottom:0; width:320px; background:var(--card-bg); border-left:1px solid var(--border); box-shadow:-6px 0 20px rgba(16,24,40,.08); display:flex; flex-direction:column; z-index:15; }
  .ip-head { padding:14px 14px 12px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:8px; }
  .ip-title { font-size:14px; font-weight:700; }
  .ip-count { color:var(--text-2); font-size:12px; font-weight:600; margin-left:4px; }
  .ip-export { border:1px solid var(--primary); background:var(--primary-soft); color:var(--primary); border-radius:8px; padding:6px 10px; font-size:12px; font-weight:600; cursor:pointer; white-space:nowrap; }
  .ip-export:hover { background:var(--primary); color:#fff; }
  .ip-export:disabled { opacity:.6; cursor:default; }
  .ip-legend { padding:10px 14px; border-bottom:1px solid var(--border); display:flex; gap:8px; }
  /* 分类筛选条：chips 横排可换行，active 高亮主色 */
  .ip-filters { padding:8px 12px; border-bottom:1px solid var(--border); display:flex; flex-wrap:wrap; gap:6px; }
  .ipf-chip { display:inline-flex; align-items:center; gap:5px; padding:3px 10px; border-radius:999px; border:1px solid var(--border); background:var(--card-bg); font-size:12px; color:var(--text-2); cursor:pointer; }
  .ipf-chip:hover { border-color:var(--primary); color:var(--text); }
  .ipf-chip.active { background:var(--primary); border-color:var(--primary); color:#fff; }
  .ipf-chip .ipf-dot { width:8px; height:8px; border-radius:50%; flex-shrink:0; }
  .ipf-chip .ipf-n { font-weight:700; }
  .ipf-chip.active .ipf-dot { box-shadow:0 0 0 1.5px #fff; }
  .ip-legend .lg { font-size:12px; font-weight:600; padding:2px 10px; border-radius:999px; }
  .ip-legend .lg.pending { background:var(--primary-soft); color:var(--primary); }
  .ip-legend .lg.fixed { background:var(--success-soft); color:var(--success-text); }
  .ip-list { flex:1; overflow-y:auto; padding:10px; }
  /* 问题清单按页面分组：组头可点击折叠/展开该页全部条目 */
  .ip-group { margin-bottom:14px; }
  .ip-group:last-child { margin-bottom:4px; }
  .ip-group-head { width:100%; display:flex; align-items:center; gap:7px; padding:7px 10px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--fill-soft); cursor:pointer; }
  .ip-group-head:hover { border-color:#c7d2fe; }
  .ipg-arrow { width:0; height:0; border-top:5px solid var(--text-2); border-right:4px solid transparent; border-left:4px solid transparent; flex-shrink:0; transition:transform .15s ease; }
  .ip-group.collapsed .ipg-arrow { transform:rotate(-90deg); }
  .ipg-name { flex:1; min-width:0; text-align:left; font-size:12px; font-weight:700; color:var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ipg-n { flex-shrink:0; font-size:11px; font-weight:700; color:var(--text-2); background:var(--fill); border-radius:999px; padding:1px 8px; }
  .ip-group.collapsed .ip-group-body { display:none; }
  .issue-item { background:var(--card-bg); border:1px solid var(--border); border-left:3px solid var(--primary-soft); border-radius:var(--radius-sm); margin-bottom:8px; transition:border-color .15s ease, box-shadow .15s ease; }
  .issue-item:hover { border-color:#c7d2fe; }
  .issue-item.is-fixed { border-left-color:#16a34a; }
  .issue-item.is-blocked { border-left-color:var(--anno-major); }
  .issue-item.active { border-color:var(--primary); box-shadow:0 0 0 2px var(--primary-soft); }
  .ii-head { display:flex; align-items:flex-start; gap:10px; padding:10px 12px; cursor:pointer; }
  .ii-no { width:22px; height:22px; border-radius:50%; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:2px; }
  .ii-main { flex:1; min-width:0; }
  .ii-desc { font-size:13px; line-height:1.45; word-break:break-all; white-space:pre-line; }
  .ii-meta { display:flex; flex-wrap:wrap; align-items:center; gap:6px; margin-top:6px; }
  .ii-page { font-size:11px; color:var(--text-3); max-width:110px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ii-status { flex-shrink:0; font-size:11px; font-weight:700; padding:3px 8px; border-radius:999px; }
  .ii-status.st-pending { background:var(--primary-soft); color:var(--primary); }
  .ii-status.st-fixed { background:var(--success-soft); color:var(--success-text); }
  .ii-status.st-blocked { background:var(--danger-soft); color:var(--anno-major); }
  .tag.st-blocked { background:var(--danger-soft); color:var(--anno-major); }
  .ii-body { display:none; padding:2px 12px 12px; border-top:1px dashed var(--border); }
  .issue-item.expanded .ii-body { display:block; }
  .ii-extra { display:flex; align-items:center; gap:8px; margin-top:10px; font-size:12px; }
  .ii-extra-lbl { color:var(--text-2); flex-shrink:0; }
  .ii-extra-val { font-weight:600; }
  .ii-extra-val.mono { font-family:ui-monospace,SFMono-Regular,monospace; }
  .ii-chip { width:16px; height:16px; border-radius:50%; flex-shrink:0; border:1px solid var(--border); box-shadow:0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,.2); }
  .ii-atts { margin-top:10px; }
  .ii-atts-grid { display:flex; flex-wrap:wrap; gap:6px; margin-top:6px; }
  .ii-att-img { width:72px; height:72px; object-fit:cover; border-radius:6px; border:1px solid var(--border); cursor:zoom-in; transition:transform .15s ease; }
  .ii-att-img:hover { transform:scale(1.05); }
  /* 截图附件大图浮层：清单/弹窗缩略图点击放大，点击任意处关闭（z-index 盖过详情弹窗 21） */
  .att-view { position:fixed; inset:0; background:rgba(0,0,0,.78); z-index:30; display:none; align-items:center; justify-content:center; cursor:zoom-out; }
  .att-view.show { display:flex; }
  .att-view img { max-width:92vw; max-height:90vh; border-radius:8px; box-shadow:0 12px 48px rgba(0,0,0,.5); display:block; transition:transform .12s ease; }
  .att-view .att-caption { position:absolute; bottom:24px; left:50%; transform:translateX(-50%); color:#fff; font-size:12px; background:rgba(0,0,0,.5); padding:5px 14px; border-radius:999px; max-width:80vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .ii-actions { display:flex; gap:8px; margin-top:10px; }
  .st-btn { flex:1; border:1px solid var(--border); background:var(--card-bg); color:var(--text-2); border-radius:8px; padding:7px 0; font-size:12px; font-weight:600; cursor:pointer; }
  .st-btn:hover { border-color:var(--text-3); }
  .st-btn.active[data-st="pending"] { background:var(--primary-soft); border-color:var(--primary); color:var(--primary); }
  .st-btn.active[data-st="fixed"] { background:var(--success-soft); border-color:#16a34a; color:var(--success-text); }
  .st-btn.active[data-st="blocked"] { background:var(--danger-soft); border-color:var(--anno-major); color:var(--anno-major); }
  .ii-reply { width:100%; margin-top:10px; padding:8px 10px; border:1px solid var(--border); border-radius:8px; background:var(--fill-soft); color:var(--text); font-size:12px; font-family:inherit; line-height:1.5; resize:vertical; min-height:56px; }
  .ii-reply:focus { outline:none; border-color:var(--primary); background:#fff; }
  .ii-reply-meta { margin-top:6px; font-size:11px; color:var(--text-3); }
  /* 弹窗回复区：保存按钮 + 回复时间同行 */
  .ii-blocked-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; margin-top:6px; }
  .ii-blocked-foot .ii-reply-meta { margin-top:0; }
  .ii-save-btn { flex-shrink:0; border:1px solid var(--primary); background:var(--primary-soft); color:var(--primary); border-radius:8px; padding:5px 14px; font-size:12px; font-weight:600; cursor:pointer; }
  .ii-save-btn:hover { background:var(--primary); color:#fff; }
  /* 画布标注定位闪烁圈 */
  .flash-ring { pointer-events:none; animation:flash-pulse 1.4s ease-out forwards; }
  @keyframes flash-pulse { 0% { opacity:0; stroke-width:7; } 20% { opacity:1; } 100% { opacity:0; stroke-width:1; } }
  /* 点位/文字/取色标注整体闪烁脉冲：序号+胶囊整块一起闪（不只序号圈，贴边翻转后跟随实际渲染位置） */
  .mk.flash { animation:mk-flash-pulse 1.4s ease-out forwards; }
  @keyframes mk-flash-pulse { 0% { box-shadow:0 0 0 0 var(--mk-c); } 100% { box-shadow:0 0 0 14px transparent; } }
  /* 画布标注详情弹窗（点击画布标注时弹出，不干扰右侧清单） */
  .detail-popup-mask { position:fixed; inset:0; background:rgba(0,0,0,.25); z-index:20; display:none; }
  .detail-popup-mask.show { display:block; }
  .detail-popup { position:fixed; z-index:21; background:#fff; border:1px solid var(--border); border-radius:12px; box-shadow:0 12px 40px rgba(16,24,40,.16); padding:18px 20px; min-width:260px; max-width:340px; pointer-events:auto; }
  .detail-popup:empty { display:none; }
  .dp-head { display:flex; align-items:center; gap:8px; margin-bottom:14px; }
  .dp-no { width:22px; height:22px; border-radius:50%; font-size:11px; font-weight:700; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
  .dp-desc { font-size:13px; line-height:1.55; word-break:break-all; flex:1; min-width:0; }
  .dp-meta { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:12px; }
  .dp-extra { display:flex; align-items:center; gap:8px; margin-bottom:12px; font-size:12px; padding-top:10px; border-top:1px dashed var(--border); }
  .dp-extra-lbl { color:var(--text-2); flex-shrink:0; }
  .dp-extra-val { font-weight:600; }
  .dp-extra-val.mono { font-family:ui-monospace,SFMono-Regular,monospace; }
  .dp-chip { width:16px; height:16px; border-radius:50%; flex-shrink:0; border:1px solid var(--border); box-shadow:0 0 0 1.5px #fff, 0 1px 3px rgba(0,0,0,.2); }
  /* 状态操作区 + 弹窗内截图附件/回复区的垂直间距 */
  .dp-actions { display:flex; gap:8px; margin-top:14px; }
  .detail-popup .st-btn { padding:8px 0; }
  .detail-popup .ii-atts { margin-top:12px; }
  .detail-popup .ii-reply { margin-top:12px; }
  /* 侧边导航 */
  .sidebar-nav { position:fixed; left:0; top:0; bottom:0; width:160px; background:var(--card-bg); border-right:1px solid var(--border); overflow-y:auto; padding:16px 8px; z-index:10; }
  .sidebar-item { display:flex; flex-direction:column; align-items:center; gap:6px; padding:10px 4px; text-decoration:none; color:var(--text-2); border-radius:var(--radius-sm); transition:background .15s ease; }
  .sidebar-item:hover { background:var(--fill); }
  .sidebar-thumb { width:100%; aspect-ratio:16/10; border-radius:6px; background-size:cover; background-position:center; background-color:var(--surface-sunken); border:1px solid var(--border); }
  .sidebar-page-name { font-size:11px; text-align:center; line-height:1.3; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; width:100%; }
  footer { margin-top:32px; color:var(--text-3); font-size:12px; text-align:center; }
</style>
</head>
<body>
<nav class="sidebar-nav">
  ${sidebarHtml}
</nav>

<div class="wrap">
  <div class="rep-header">
    <div>
      <h1>${esc(reportName)}</h1>
      <div class="meta">
        <strong>${esc('项目')}</strong>${esc(project?.name ?? '')}　<strong>${esc('页面数')}</strong>${allPages.length}　<strong>${esc('标注总数')}</strong>${allIssues.length}
        <br><strong>${esc('导出时间')}</strong>${new Date().toLocaleString('zh-CN')}
        <br><strong>${esc('协作说明')}</strong>${esc('点击画布标注查看详情，右侧清单可切换「待修复 / 已修复 / 无法修复」；点击「导出回复报告」生成携带最新回复状态的报告文件')}
      </div>
    </div>
  </div>

  ${buildStats(allIssues)}

  ${canvasesHtml}

  <footer>${esc('产品标注报告')} · ${new Date().toLocaleString('zh-CN')}</footer>
</div>

${buildIssuePanel(allIssues)}

<div class="detail-popup-mask" id="detail-mask"></div>
<div class="detail-popup" id="detail-popup"></div>
<div class="att-view" id="att-view"><img id="att-view-img" alt=""/><div class="att-caption" id="att-caption"></div></div>

<script id="report-state" type="application/json">{}</script>

<script>
var DATA = ${JSON.stringify(allIssues).replace(/</g, '\\u003c')};
var PAGE_ISSUES = ${JSON.stringify(Object.fromEntries(arrowPages.map((p) => [p.key, p.issues]))).replace(/</g, '\\u003c')};
var PAGE_KEYS = Object.keys(PAGE_ISSUES);
var REPORT_KEY = ${JSON.stringify(reportKey)};
var STATE_KEY = '__prodReportState_' + REPORT_KEY;
var FIXED_C = '#16a34a';
var BLOCKED_C = '#dc2626';
var STATUS_LABELS = { pending: '待修复', fixed: '已修复', blocked: '无法修复' };
// 回复状态：内嵌（回复报告携带）与本机缓存按条目 updatedAt 合并，较新者生效
var REPORT_STATE = (function () {
  var embedded = {};
  try { embedded = JSON.parse(document.getElementById('report-state').textContent || '{}') || {}; } catch (e) { embedded = {}; }
  var saved = {};
  try { saved = JSON.parse(localStorage.getItem(STATE_KEY) || '{}') || {}; } catch (e) { saved = {}; }
  var out = {};
  for (var a in saved) out[a] = saved[a];
  for (var b in embedded) { if (!out[b] || (embedded[b].updatedAt || 0) >= (out[b].updatedAt || 0)) out[b] = embedded[b]; }
  return out;
})();
var currentPopupId = null;

function findIssue(id) {
  for (var k = 0; k < DATA.length; k++) {
    if (DATA[k].id === id) return DATA[k];
  }
  return null;
}

function findPageKey(id) {
  for (var k = 0; k < PAGE_KEYS.length; k++) {
    var arr = PAGE_ISSUES[PAGE_KEYS[k]] || [];
    for (var j = 0; j < arr.length; j++) { if (arr[j].id === id) return PAGE_KEYS[k]; }
  }
  return null;
}

function saveState() { try { localStorage.setItem(STATE_KEY, JSON.stringify(REPORT_STATE)); } catch (e) {} }

// 绘制色：已修复→绿，无法修复→红，自定义色→自定义，否则用严重度默认色
function drawColor(i) {
  var st = REPORT_STATE[i.id] || {};
  if (st.status === 'fixed') return FIXED_C;
  if (st.status === 'blocked') return BLOCKED_C;
  if (i.color) return i.color;
  var sev = { major: '#dc2626', minor: '#f59e0b', suggestion: '#667085' };
  return sev[i.severity] || '#2563eb';
}

// 回复状态 → DOM 同步：清单条目状态/按钮/回复文本 + 画布标记颜色
function applyStateToDom() {
  var fixed = 0, blocked = 0;
  DATA.forEach(function (i) {
    var st = REPORT_STATE[i.id] || {};
    var status = st.status || i.status || 'pending';
    if (status === 'fixed') fixed++;
    if (status === 'blocked') blocked++;
    var item = document.querySelector('.issue-item[data-id="' + i.id + '"]');
    if (!item) return;
    item.classList.toggle('is-fixed', status === 'fixed');
    item.classList.toggle('is-blocked', status === 'blocked');
    var pill = item.querySelector('[data-role="status"]');
    if (pill) { pill.textContent = STATUS_LABELS[status] || '待修复'; pill.className = 'ii-status st-' + status; }
    item.querySelectorAll('.st-btn').forEach(function (b) { b.classList.toggle('active', b.getAttribute('data-st') === status); });
    // 只有无法修复时才显示回复输入框
    var blockedDiv = item.querySelector('.ii-blocked');
    if (blockedDiv) blockedDiv.style.display = status === 'blocked' ? 'block' : 'none';
    var ta = item.querySelector('.ii-reply');
    if (ta && document.activeElement !== ta) ta.value = st.reply || '';
    var meta = item.querySelector('[data-role="reply-meta"]');
    if (meta) meta.textContent = st.reply ? ('回复时间 ' + new Date(st.replyAt || Date.now()).toLocaleString('zh-CN')) : '';
    var color = drawColor(i);
    var ink = inkFor(color);
    document.querySelectorAll('.mk[data-id="' + i.id + '"]').forEach(function (el) {
      el.style.setProperty('--mk-c', color);
      // 每次都按当前颜色重算：切回待修复时复位，避免残留已修复态的白字序号
      el.style.setProperty('--mk-ink', ink);
      if (ink === '#334155') {
        // 浅色标注色（白色等）：胶囊文字切深色，避免白字白底不可读
        el.style.setProperty('--mk-lbl', '#334155');
      } else {
        el.style.removeProperty('--mk-lbl');
      }
    });
  });
  var cnt = document.getElementById('ip-count');
  // 计数跟随分类筛选：选中分类时只计该分类条目（curCat 由下方筛选脚本维护）
  if (cnt) cnt.textContent = '（' + (curCat ? DATA.filter(function (d) { return (d.category || 'spacing') === curCat; }).length : DATA.length) + '）';
  var lg = document.getElementById('ip-legend');
  if (lg) lg.innerHTML = '<span class="lg pending">待修复 ' + (DATA.length - fixed - blocked) + '</span><span class="lg fixed">已修复 ' + fixed + '</span><span class="lg blocked" style="background:var(--danger-soft);color:var(--anno-major)">无法修复 ' + blocked + '</span>';
}

function setStatus(id, st) {
  var cur = REPORT_STATE[id] || {};
  REPORT_STATE[id] = { status: st, reply: st === 'blocked' ? (cur.reply || '') : '', replyAt: Date.now(), updatedAt: Date.now() };
  saveState();
  applyStateToDom();
  redrawArrows();
  // 选择无法修复时自动展开条目，让回复输入框可见
  if (st === 'blocked') {
    var item = document.querySelector('.issue-item[data-id="' + id + '"]');
    if (item) {
      document.querySelectorAll('.issue-item.expanded').forEach(function (el) { if (el !== item) { el.classList.remove('expanded'); el.classList.remove('active'); } });
      item.classList.add('expanded');
      item.classList.add('active');
    }
  }
  // 更新弹窗状态（如果当前弹窗就是该条目）
  if (currentPopupId === id) showPopup(id);
}

// 画布标注闪烁圈：在箭头层叠加临时描边形状，1.4s 动画后移除
function flashMarker(id, key) {
  var info = findIssue(id);
  var svg = document.getElementById('arrows-' + key);
  var stage = document.getElementById('stage-' + key);
  if (!info || !svg || !stage) return;
  var rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  var color = drawColor(info);
  var ns = 'http://www.w3.org/2000/svg';
  var x1 = info.x * rect.width, y1 = info.y * rect.height;
  var w = info.width * rect.width, h = info.height * rect.height;
  var el;
  if (info.shape === 'point' || info.shape === 'picker' || info.shape === 'text') {
    // 整体闪烁：直接给标注元素加脉冲类（文字/取色整条胶囊、点位圆钉），缩放/贴边翻转后自动跟随实际渲染位置
    var target = document.querySelector('.mk[data-id="' + id + '"]');
    if (!target) return;
    target.classList.remove('flash');
    void target.offsetWidth; // 强制回流，连续点击同一标注可重新播放动画
    target.classList.add('flash');
    setTimeout(function () { target.classList.remove('flash'); }, 1500);
    return;
  } else {
    el = document.createElementNS(ns, 'rect');
    var pad = 8;
    el.setAttribute('x', Math.min(x1, x1 + w) - pad);
    el.setAttribute('y', Math.min(y1, y1 + h) - pad);
    el.setAttribute('width', Math.abs(w) + pad * 2);
    el.setAttribute('height', Math.abs(h) + pad * 2);
    el.setAttribute('rx', 6);
  }
  el.setAttribute('fill', 'none');
  el.setAttribute('stroke', color);
  el.setAttribute('class', 'flash-ring');
  svg.appendChild(el);
  setTimeout(function () { if (el.parentNode) el.parentNode.removeChild(el); }, 1500);
}

// 点击画布标注 → 弹出详情浮层（不聚焦右侧清单）
function showPopup(id) {
  var info = findIssue(id);
  if (!info) return;
  currentPopupId = id;
  var st = REPORT_STATE[id] || {};
  var status = st.status || info.status || 'pending';
  var color = drawColor(info);
  var extra = '';
  if (info.shape === 'measure' && info.measureValue) {
    extra += '<div class="dp-extra"><span class="dp-extra-lbl">测量值</span><span class="dp-extra-val">' + esc(info.measureValue) + '</span></div>';
  } else if (info.shape === 'picker' && info.sampleColor) {
    extra += '<div class="dp-extra"><span class="dp-extra-lbl">取样色值</span><span class="dp-chip" style="background:' + info.sampleColor + '"></span><span class="dp-extra-val mono">' + esc(info.sampleColor.toUpperCase()) + '</span></div>';
  }
  // 截图附件：缩略图网格
  var attsHtml = '';
  if (info.attachments && info.attachments.length > 0) {
    var grid = '';
    for (var ai = 0; ai < info.attachments.length; ai++) {
      grid += '<img src="' + info.attachments[ai].thumbDataUrl + '" alt="' + esc(info.attachments[ai].fileName) + '" class="ii-att-img" title="' + esc(info.attachments[ai].fileName) + '" onclick="openAttach(this.src,this.title)"/>';
    }
    attsHtml = '<div class="ii-atts"><span class="ii-extra-lbl">截图附件</span><div class="ii-atts-grid">' + grid + '</div></div>';
  }
  // 无法修复回复输入框
  var blockedHtml = '';
  if (status === 'blocked') {
    blockedHtml = '<div class="ii-blocked"><textarea class="ii-reply" placeholder="回复无法修复说明…" id="popup-block-reason">' + esc(st.reply || '') + '</textarea><div class="ii-blocked-foot"><button type="button" class="ii-save-btn" id="popup-reply-save">保存</button><span class="ii-reply-meta" id="popup-reply-meta">' + (st.reply ? '回复时间 ' + new Date(st.replyAt || Date.now()).toLocaleString('zh-CN') : '') + '</span></div></div>';
  }
  var popup = document.getElementById('detail-popup');
  var mask = document.getElementById('detail-mask');
  popup.innerHTML =
    '<div class="dp-head"><span class="dp-no" style="background:' + color + ';color:' + inkFor(color) + '">' + info.no + '</span><span class="dp-desc">' + esc(info.description || '(无描述)') + '</span></div>' +
    '<div class="dp-meta"><span class="tag sev-' + info.severity + '">' + esc(info.severityLabel) + '</span><span class="tag plain">' + esc(info.categoryLabel) + '</span><span class="tag st-' + status + '">' + (STATUS_LABELS[status] || '待修复') + '</span></div>' +
    (extra ? extra : '') +
    (attsHtml ? attsHtml : '') +
    '<div class="dp-actions"><button type="button" class="st-btn" data-st="pending">待修复</button><button type="button" class="st-btn" data-st="fixed">已修复</button><button type="button" class="st-btn" data-st="blocked">无法修复</button></div>' +
    blockedHtml;
  // 定位到标注附近
  var key = findPageKey(id);
  if (key) {
    var stage = document.getElementById('stage-' + key);
    if (stage) {
      var r = stage.getBoundingClientRect();
      var mx = info.x * r.width + r.left;
      var my = info.y * r.height + r.top;
      // 避免超出视口右侧（320px面板区域）
      popup.style.left = Math.min(mx + 20, window.innerWidth - 360) + 'px';
      popup.style.top = Math.max(10, my - 40) + 'px';
    }
  }
  popup.style.display = 'block';
  mask.classList.add('show');
  // 弹窗内状态切换按钮
  popup.querySelectorAll('.st-btn').forEach(function (b) {
    b.classList.toggle('active', b.getAttribute('data-st') === status);
    b.addEventListener('click', function (ev) {
      ev.stopPropagation();
      var newSt = b.getAttribute('data-st');
      // 点击无法修复时先收集已输入的回复，避免被 setStatus 覆盖清空
      if (newSt === 'blocked') {
        var popupTa = document.getElementById('popup-block-reason');
        if (popupTa && popupTa.value.trim()) {
          REPORT_STATE[id] = { status: 'blocked', reply: popupTa.value.trim(), replyAt: Date.now(), updatedAt: Date.now() };
          saveState();
        }
      }
      setStatus(id, newSt);
      // 兜底：若弹窗未因 setStatus 重渲染而缺少回复框，则补插
      if (newSt === 'blocked' && !popup.querySelector('.ii-blocked')) {
        var reply = (REPORT_STATE[id] || {}).reply || '';
        popup.insertAdjacentHTML('beforeend', '<div class="ii-blocked"><textarea class="ii-reply" placeholder="回复无法修复说明…" id="popup-block-reason">' + esc(reply) + '</textarea><div class="ii-blocked-foot"><button type="button" class="ii-save-btn" id="popup-reply-save">保存</button><span class="ii-reply-meta" id="popup-reply-meta">' + (reply ? '回复时间 ' + new Date((REPORT_STATE[id] || {}).replyAt || Date.now()).toLocaleString('zh-CN') : '') + '</span></div></div>');
      } else if (newSt !== 'blocked') {
        var blockedDiv = popup.querySelector('.ii-blocked');
        if (blockedDiv) blockedDiv.remove();
      }
      // 激活态刷新 + 绑定回复输入保存
      popup.querySelectorAll('.st-btn').forEach(function (x) { x.classList.toggle('active', x.getAttribute('data-st') === newSt); });
      bindPopupReply(id);
    });
  });
  // 初始即为无法修复：回复输入框也要绑定保存，否则输入内容丢失
  if (status === 'blocked') bindPopupReply(id);
}

/** 弹窗「无法修复」回复：输入/保存即持久化并同步右侧清单卡片（初始渲染与点击切换后共用，防重复绑定） */
function bindPopupReply(id) {
  var ta = document.getElementById('popup-block-reason');
  if (!ta || ta.dataset.bound) return;
  ta.dataset.bound = '1';
  var commit = function (feedback) {
    var val = ta.value.trim();
    REPORT_STATE[id] = { status: 'blocked', reply: ta.value, replyAt: Date.now(), updatedAt: Date.now() };
    saveState();
    // 同步右侧清单卡片（回复内容 + 回复时间 + 状态样式）
    applyStateToDom();
    var meta = document.getElementById('popup-reply-meta');
    if (meta) meta.textContent = val ? ('回复时间 ' + new Date().toLocaleString('zh-CN')) : '';
    if (feedback) {
      var btn = document.getElementById('popup-reply-save');
      if (btn && !btn.dataset.fb) {
        btn.dataset.fb = '1';
        btn.textContent = '已保存 ✓';
        // 短暂展示保存成功后自动关闭弹窗
        setTimeout(function () { delete btn.dataset.fb; hidePopup(); }, 500);
      }
    }
  };
  ta.addEventListener('input', function () { commit(false); });
  var saveBtn = document.getElementById('popup-reply-save');
  if (saveBtn) saveBtn.addEventListener('click', function (ev) { ev.stopPropagation(); commit(true); });
}

function hidePopup() {
  var popup = document.getElementById('detail-popup');
  var mask = document.getElementById('detail-mask');
  popup.innerHTML = '';
  popup.style.display = 'none';
  mask.classList.remove('show');
  currentPopupId = null;
}

// 右侧清单 → 聚焦画布标注位置（不展开面板，不滚动清单）
function locateFromPanel(id) {
  var info = findIssue(id);
  if (!info) return;
  var key = findPageKey(id);
  if (key) {
    var card = document.getElementById('page-' + key);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'start' });
    flashMarker(id, key);
  }
  // 高亮右侧清单条目（闪烁边框提示）
  var item = document.querySelector('.issue-item[data-id="' + id + '"]');
  if (item) {
    item.classList.add('active');
    item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    setTimeout(function () { item.classList.remove('active'); }, 1500);
  }
}

// 导出回复报告：当前回复状态写入内嵌 state 后整体序列化下载（自包含 HTML，可直接转发）
function exportReplyReport() {
  saveState();
  var tag = document.getElementById('report-state');
  if (tag) {
    var json = JSON.stringify(REPORT_STATE);
    // 转义 "</" 避免 JSON 内容提前闭合 script 标签（"\/" 为合法 JSON 转义，解析回 "/"）
    tag.textContent = json.split('</').join('<' + String.fromCharCode(92) + '/');
  }
  var html = '\x3C!DOCTYPE html>\\n' + document.documentElement.outerHTML;
  var blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  var a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (document.title || '产品标注报告') + '-回复.html';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  var btn = document.querySelector('.ip-export');
  if (btn) { var old = btn.textContent; btn.textContent = '已生成 ✓'; btn.disabled = true; setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1600); }
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }

// 截图附件大图浮层：清单/弹窗缩略图点击放大 / 点击任意处关闭 / 滚轮缩放（0.2~8 倍）
var attScale = 1;
function applyAttScale() {
  var img = document.getElementById('att-view-img');
  if (img) img.style.transform = 'scale(' + attScale + ')';
}
function openAttach(src, name) {
  attScale = 1;
  var img = document.getElementById('att-view-img');
  img.src = src || '';
  img.style.transform = 'none';
  document.getElementById('att-caption').textContent = name || '';
  document.getElementById('att-view').classList.add('show');
}
function closeAttach() {
  attScale = 1;
  var img = document.getElementById('att-view-img');
  img.style.transform = 'none';
  img.src = '';
  document.getElementById('att-view').classList.remove('show');
}
document.getElementById('att-view').addEventListener('click', closeAttach);
document.getElementById('att-view').addEventListener('wheel', function (ev) {
  if (!this.classList.contains('show')) return;
  ev.preventDefault();
  attScale = Math.min(8, Math.max(0.2, attScale + (ev.deltaY < 0 ? 0.2 : -0.2)));
  applyAttScale();
}, { passive: false });

function inkFor(hex) {
  var h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
  var r = parseInt(h.slice(0, 2), 16) || 0;
  var g = parseInt(h.slice(2, 4), 16) || 0;
  var b = parseInt(h.slice(4, 6), 16) || 0;
  return 0.299 * r + 0.587 * g + 0.114 * b > 186 ? '#334155' : '#fff';
}

// 箭头/测量层运行时绘制
function drawArrows(key) {
  var svg = document.getElementById('arrows-' + key);
  var stage = document.getElementById('stage-' + key);
  if (!svg || !stage) return;
  svg.innerHTML = '';
  var rect = stage.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  svg.setAttribute('viewBox', '0 0 ' + rect.width + ' ' + rect.height);
  var ns = 'http://www.w3.org/2000/svg';
  (PAGE_ISSUES[key] || []).forEach(function (i) {
    if (i.shape !== 'arrow' && i.shape !== 'measure') return;
    var stq = REPORT_STATE[i.id] || {};
    var c = stq.status === 'fixed' ? FIXED_C : (stq.status === 'blocked' ? BLOCKED_C : (i.color || ''));
    var x1 = i.x * rect.width, y1 = i.y * rect.height;
    var x2 = (i.x + i.width) * rect.width, y2 = (i.y + i.height) * rect.height;
    var cls = 'sev-' + i.severity;
    if (i.shape === 'measure') {
      var mline = document.createElementNS(ns, 'line');
      mline.setAttribute('x1', x1); mline.setAttribute('y1', y1);
      mline.setAttribute('x2', x2); mline.setAttribute('y2', y2);
      mline.setAttribute('class', 'rep-measure ' + cls);
      svg.appendChild(mline);
      var mdx = x2 - x1, mdy = y2 - y1;
      var mlen = Math.hypot(mdx, mdy) || 1;
      var mnx = -mdy / mlen, mny = mdx / mlen;
      [[x1, y1], [x2, y2]].forEach(function (p) {
        var tick = document.createElementNS(ns, 'line');
        tick.setAttribute('x1', p[0] - mnx * 6); tick.setAttribute('y1', p[1] - mny * 6);
        tick.setAttribute('x2', p[0] + mnx * 6); tick.setAttribute('y2', p[1] + mny * 6);
        tick.setAttribute('class', 'rep-measure ' + cls);
        if (c) tick.style.setProperty('--mk-c', c);
        svg.appendChild(tick);
      });
      var vertical = Math.abs(i.width) < Math.abs(i.height);
      var label = document.createElementNS(ns, 'text');
      label.setAttribute('x', (x1 + x2) / 2); label.setAttribute('y', (y1 + y2) / 2);
      label.setAttribute('dx', vertical ? 8 : 0);
      label.setAttribute('dy', vertical ? 0 : -9);
      label.setAttribute('text-anchor', vertical ? 'start' : 'middle');
      label.setAttribute('class', 'rep-measure-label ' + cls);
      if (c) label.style.setProperty('--mk-c', c);
      label.textContent = i.measureValue || (Math.round(Math.hypot(i.width * rect.width, i.height * rect.height)) + 'px');
      label.setAttribute('data-id', i.id);
      svg.appendChild(label);
      var mhit = document.createElementNS(ns, 'line');
      mhit.setAttribute('x1', x1); mhit.setAttribute('y1', y1);
      mhit.setAttribute('x2', x2); mhit.setAttribute('y2', y2);
      mhit.setAttribute('class', 'rep-measure-hit');
      mhit.setAttribute('data-id', i.id);
      svg.appendChild(mhit);
      if (c) mline.style.setProperty('--mk-c', c); else mline.style.removeProperty('--mk-c');
    } else {
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
      var hit = document.createElementNS(ns, 'line');
      hit.setAttribute('x1', x1); hit.setAttribute('y1', y1);
      hit.setAttribute('x2', x2); hit.setAttribute('y2', y2);
      hit.setAttribute('class', 'rep-arrow-hit');
      hit.setAttribute('data-id', i.id);
      svg.appendChild(hit);
      if (c) { line.style.setProperty('--mk-c', c); poly.style.setProperty('--mk-c', c); }
    }
  });
}

function redrawArrows() { PAGE_KEYS.forEach(drawArrows); }

// 边界避让（与 UI 走查报告一致）：文字/颜色胶囊超出画板右边界时翻转到点位左侧，顶/底越界时钳回可视区域
function avoidOverflow(el, layer, shape) {
  var rect = layer.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  // 先还原上一轮避让结果（flip 类 + 内联 transform）再测量：relayout 会在图片加载 /
  // ResizeObserver / 缩放时多次触发，若带着上一轮 translate(-100%) 测量，翻转后的
  // 胶囊右缘已回到点位处，会被误判为「未超界」而移除 flip，导致标注重新超出画板
  // 且失去指向三角（UI 走查报告每次重建元素无此问题，此处复用元素必须先复位）
  el.classList.remove('flip');
  el.style.transform = '';
  var box = el.getBoundingClientRect();
  if (!box.width) return;
  var flipX = box.left - rect.left + box.width > rect.width - 4;
  if (flipX) el.classList.add('flip'); else el.classList.remove('flip');
  if (shape === 'picker') {
    el.style.transform = flipX ? 'translate(calc(-100% + 7px), -50%)' : 'translate(-7px, -50%)';
  } else {
    el.style.transform = flipX ? 'translate(-100%, -50%)' : 'translate(0, -50%)';
  }
  box = el.getBoundingClientRect();
  if (box.top - rect.top < 0) {
    el.style.transform = shape === 'picker' ? 'translate(-7px, 0)' : (flipX ? 'translate(-100%, 0)' : 'translate(0, 0)');
  } else if (box.bottom - rect.top > rect.height) {
    el.style.transform = shape === 'picker' ? 'translate(-7px, -100%)' : (flipX ? 'translate(-100%, -100%)' : 'translate(0, -100%)');
  }
}

function fixMarkerOverflow() {
  document.querySelectorAll('.rep-stage').forEach(function (st) {
    var layer = st.querySelector('.markers');
    if (!layer) return;
    layer.querySelectorAll('.mk-label, .mk-pick').forEach(function (el) {
      avoidOverflow(el, layer, el.classList.contains('mk-pick') ? 'picker' : 'text');
    });
  });
}

function relayout() { redrawArrows(); fixMarkerOverflow(); }
relayout();
// 图片异步解码后画板尺寸才稳定：onload + ResizeObserver 双保险触发重绘与标注避让
try {
  var ro = new ResizeObserver(relayout);
  PAGE_KEYS.forEach(function (k) {
    var st = document.getElementById('stage-' + k);
    if (!st) return;
    ro.observe(st);
    var im = st.querySelector('img');
    if (im && !im.complete) im.addEventListener('load', relayout);
  });
} catch (e) {}
window.addEventListener('resize', relayout);

// ── 画板缩放：宽度百分比缩放（标记/箭头层全部按百分比或运行时像素重绘，自动适配），放大后可拖拽平移 ──
var curCat = ''; // 当前问题清单筛选分类（空串 = 全部）
var ZOOM = {}; // key -> 缩放倍数
function setZoom(key, z) {
  z = Math.round(z * 100) / 100;
  if (z < 1) z = 1;
  if (z > 4) z = 4;
  ZOOM[key] = z;
  var st = document.getElementById('stage-' + key);
  if (!st) return;
  st.style.width = z * 100 + '%';
  st.classList.toggle('zoomed', z > 1);
  var card = document.getElementById('page-' + key);
  var val = card && card.querySelector('.zoom-val');
  if (val) val.textContent = Math.round(z * 100) + '%';
  relayout();
}
document.querySelectorAll('.zoom-bar').forEach(function (bar) {
  var key = bar.getAttribute('data-key');
  bar.addEventListener('click', function (ev) {
    var b = ev.target && ev.target.closest ? ev.target.closest('button') : null;
    if (!b || !key) return;
    var cur = ZOOM[key] || 1;
    var act = b.getAttribute('data-zoom');
    if (act === 'in') setZoom(key, cur + 0.25);
    else if (act === 'out') setZoom(key, cur - 0.25);
    else setZoom(key, 1);
  });
});
// 放大后拖拽平移：按住画布拖动滚动容器；拖拽超过阈值时抑制本次 click（避免误触标注弹窗）
document.querySelectorAll('.rep-canvas').forEach(function (wrap) {
  var stage = wrap.querySelector('.rep-stage');
  var key = stage ? stage.id.replace(/^stage-/, '') : '';
  var down = null;
  var moved = false;
  wrap.addEventListener('mousedown', function (ev) {
    if ((ZOOM[key] || 1) <= 1) return;
    if (ev.target && ev.target.closest && ev.target.closest('.zoom-bar')) return;
    down = { x: ev.clientX, y: ev.clientY, sl: wrap.scrollLeft, st: wrap.scrollTop };
    moved = false;
    ev.preventDefault();
    if (stage) stage.classList.add('dragging');
  });
  document.addEventListener('mousemove', function (ev) {
    if (!down) return;
    var dx = ev.clientX - down.x;
    var dy = ev.clientY - down.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
    wrap.scrollLeft = down.sl - dx;
    wrap.scrollTop = down.st - dy;
  });
  document.addEventListener('mouseup', function () {
    if (!down) return;
    down = null;
    if (stage) stage.classList.remove('dragging');
  });
  // 捕获阶段拦截：拖拽后释放鼠标触发的 click 不再冒泡到标注层
  wrap.addEventListener('click', function (ev) {
    if (moved) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }, true);
});

// ── 问题清单分类筛选：点击 chips 切换显示对应分类条目（画布标记保持不动） ──
var ipFilters = document.getElementById('ip-filters');
if (ipFilters) {
  ipFilters.addEventListener('click', function (ev) {
    var chip = ev.target && ev.target.closest ? ev.target.closest('.ipf-chip') : null;
    if (!chip) return;
    ipFilters.querySelectorAll('.ipf-chip').forEach(function (c) { c.classList.toggle('active', c === chip); });
    curCat = chip.getAttribute('data-cat') || '';
    var shown = 0;
    document.querySelectorAll('#ip-list .issue-item').forEach(function (it) {
      var ok = !curCat || it.getAttribute('data-cat') === curCat;
      it.style.display = ok ? '' : 'none';
      if (ok) shown++;
    });
    // 筛选后隐藏没有任何可见条目的页面分组
    document.querySelectorAll('#ip-list .ip-group').forEach(function (g) {
      var any = false;
      g.querySelectorAll('.issue-item').forEach(function (it) { if (it.style.display !== 'none') any = true; });
      g.style.display = any ? '' : 'none';
    });
    var cnt = document.getElementById('ip-count');
    if (cnt) cnt.textContent = '（' + shown + '）';
  });
}

// 点击画布标注 → 弹出详情浮层
document.querySelectorAll('.markers').forEach(function (layer) {
  layer.onclick = function (ev) {
    var n = ev.target;
    while (n && n !== this && !(n.getAttribute && n.getAttribute('data-id'))) n = n.parentNode;
    if (n && n !== this) showPopup(n.getAttribute('data-id'));
  };
});

// SVG 箭头/测量层点击 → 弹出详情浮层
document.querySelectorAll('.arrow-layer').forEach(function (svg) {
  svg.onclick = function (ev) {
    var n = ev.target;
    while (n && n !== this && !(n.getAttribute && n.getAttribute('data-id'))) n = n.parentNode;
    if (n && n !== this) showPopup(n.getAttribute('data-id'));
  };
});

// 弹窗遮罩点击关闭
document.getElementById('detail-mask').addEventListener('click', hidePopup);

// 右侧清单交互：状态切换 / 展开条目 / 聚焦画布标注（事件委托）
var ipList = document.getElementById('ip-list');
if (ipList) {
  ipList.addEventListener('click', function (ev) {
    var btn = ev.target.closest ? ev.target.closest('.st-btn') : null;
    if (btn) {
      ev.stopPropagation();
      setStatus(btn.closest('.issue-item').getAttribute('data-id'), btn.getAttribute('data-st'));
      return;
    }
    // 截图附件缩略图 → 放大查看（不触发收起/定位）
    var attImg = ev.target.closest ? ev.target.closest('.ii-att-img') : null;
    if (attImg) {
      ev.stopPropagation();
      openAttach(attImg.getAttribute('src'), attImg.getAttribute('title') || attImg.getAttribute('alt') || '');
      return;
    }
    // 回复保存按钮 → 持久化 + 「已保存 ✓」反馈 + 折叠卡片
    var saveBtn = ev.target.closest ? ev.target.closest('[data-role="reply-save"]') : null;
    if (saveBtn) {
      ev.stopPropagation();
      var sItem = saveBtn.closest('.issue-item');
      var sId = sItem.getAttribute('data-id');
      var sTa = sItem.querySelector('.ii-reply');
      REPORT_STATE[sId] = { status: 'blocked', reply: sTa ? sTa.value : '', replyAt: Date.now(), updatedAt: Date.now() };
      saveState();
      applyStateToDom();
      saveBtn.textContent = '已保存 ✓';
      setTimeout(function () {
        saveBtn.textContent = '保存';
        // 保存后折叠卡片
        sItem.classList.remove('expanded');
        sItem.classList.remove('active');
      }, 600);
      return;
    }
    var item = ev.target.closest('.issue-item');
    if (!item) return;
    // 点击条目头部 → 展开条目 + 聚焦画布标注位置
    if (!ev.target.closest('.ii-body')) {
      // 展开当前条目
      document.querySelectorAll('.issue-item.expanded').forEach(function (el) { if (el !== item) { el.classList.remove('expanded'); el.classList.remove('active'); } });
      item.classList.add('expanded');
      item.classList.add('active');
      locateFromPanel(item.getAttribute('data-id'));
      return;
    }
    // 回复输入框/回复区域：不收起条目，保证可正常输入
    if (ev.target.closest('.ii-reply') || ev.target.closest('.ii-blocked')) return;
    // 点击已展开条目的 ii-body 区域（非按钮）→ 收起
    item.classList.remove('expanded');
    item.classList.remove('active');
  });
  ipList.addEventListener('input', function (ev) {
    var ta = ev.target.closest ? ev.target.closest('.ii-reply') : null;
    if (!ta) return;
    var id = ta.closest('.issue-item').getAttribute('data-id');
    var cur = REPORT_STATE[id] || {};
    REPORT_STATE[id] = { status: cur.status || 'pending', reply: ta.value, replyAt: Date.now(), updatedAt: Date.now() };
    saveState();
  });
}

// 问题清单按页面分组：点击组头折叠/展开该页全部条目
document.querySelectorAll('.ip-group-head').forEach(function (h) {
  h.addEventListener('click', function () {
    h.closest('.ip-group').classList.toggle('collapsed');
  });
});

// 点击左侧导航缩略图：右侧清单自动展开当前页面的分组并滚动到该分组
document.querySelectorAll('.sidebar-item').forEach(function (a) {
  a.addEventListener('click', function () {
    var nameEl = a.querySelector('.sidebar-page-name');
    if (!nameEl) return;
    var name = nameEl.textContent;
    document.querySelectorAll('#ip-list .ip-group').forEach(function (g) {
      if (g.getAttribute('data-page') !== name) return;
      g.classList.remove('collapsed');
      g.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
});

// 初始同步回复状态（清单条目 + 画布标记颜色）
applyStateToDom();
// 已标记为无法修复的条目自动展开，让回复输入框可见
DATA.forEach(function (i) {
  var st = REPORT_STATE[i.id] || {};
  if (st.status === 'blocked') {
    var item = document.querySelector('.issue-item[data-id="' + i.id + '"]');
    if (item) { item.classList.add('expanded'); item.classList.add('active'); }
  }
});

// ESC 关闭弹窗
document.addEventListener('keydown', function (ev) {
  if (ev.key === 'Escape') hidePopup();
});
</script>
</body>
</html>`
  }

  /** 打开 HTML 报告文件 */
  const handleOpenHtmlReport = async (filePath: string) => {
    const res = await window.electronAPI.openReportBuiltin(filePath)
    if (!res.ok) setResultMsg({ type: 'error', text: res.message })
  }

  /** 打开在线文档链接 */
  const handleOpenUrl = (url: string) => {
    window.open(url, '_blank')
  }

  /** 执行导出 */
  const handleExport = async () => {
    setExporting(true)
    setResultMsg(null)
    try {
      const html = await generateReportHTML()
      const now = new Date()
      const name = `产品标注报告_${reportName}_${now.toISOString().slice(0, 10)}_${now.toTimeString().slice(0, 8)}.html`
      const res = await window.electronAPI.exportReport(html, name)
      if (res && res.ok && res.path) {
        await db.reportRecords
          .add({
            id: uiGenId(),
            pageId: setId ?? '',
            projectId: projectId!,
            type: 'html',
            name,
            filePath: res.path ?? undefined,
            total: totalAnnotations,
            createdAt: Date.now(),
          })
          .catch(() => undefined)
        const openRes = await window.electronAPI.openReportBuiltin(res.path)
        setResultMsg({
          type: !openRes.ok ? 'warn' : 'ok',
          text: !openRes.ok
            ? `${t('msg.exportedToPath', { path: res.path })}（${openRes.message}）`
            : t('msg.exportedToPath', { path: res.path })
        })
      } else if (res && res.canceled) {
        return
      } else {
        setResultMsg({ type: 'error', text: t('msg.exportFailed', { msg: res?.message || t('msg.unknownError') }) })
      }
    } catch (err) {
      setResultMsg({ type: 'error', text: t('msg.exportFailed', { msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setExporting(false)
    }
  }

  /** 一键创建飞书文档 */
  const doFeishu = async () => {
    setDocLoading(true)
    setResultMsg(null)
    try {
      const html = await generateReportHTML()
      const payload = await buildDocPayload(html)
      const res = await window.electronAPI.feishuCreateReport(payload)
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.feishu.name'), msg: res.message }) })
        return
      }
      await db.reportRecords.add({
        id: uiGenId(),
        pageId: setId ?? '',
        projectId: projectId!,
        type: 'feishu',
        name: payload.title,
        url: res.url,
        total: payload.issues.length,
        createdAt: Date.now(),
      }).catch(() => undefined)
      setResultMsg({ type: 'ok', text: res.message || t('msg.docCreatedAutoOpen', { name: t('docTarget.feishu.name') }) })
    } catch (err) {
      setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.feishu.name'), msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setDocLoading(false)
    }
  }

  /** 一键创建腾讯文档 */
  const doTencent = async () => {
    setDocLoading(true)
    setResultMsg(null)
    try {
      const html = await generateReportHTML()
      const payload = await buildDocPayload(html)
      const res = await window.electronAPI.tencentCreateReport(payload)
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.tencent.name'), msg: res.message }) })
        return
      }
      await db.reportRecords.add({
        id: uiGenId(),
        pageId: setId ?? '',
        projectId: projectId!,
        type: 'tencent',
        name: payload.title,
        url: res.url,
        total: payload.issues.length,
        createdAt: Date.now(),
      }).catch(() => undefined)
      setResultMsg({ type: 'ok', text: res.message || t('msg.docCreatedAutoOpen', { name: t('docTarget.tencent.name') }) })
    } catch (err) {
      setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.tencent.name'), msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setDocLoading(false)
    }
  }

  /** 一键创建金山文档 */
  const doKingsoft = async () => {
    setDocLoading(true)
    setResultMsg(null)
    try {
      const title = `${reportName} - ${new Date().toLocaleDateString('zh-CN')}`
      const res = await window.electronAPI.kingsoftCreateReport({ title })
      if (!res.ok) {
        setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.kingsoft.name'), msg: res.message }) })
        return
      }
      await db.reportRecords.add({
        id: uiGenId(),
        pageId: setId ?? '',
        projectId: projectId!,
        type: 'kingsoft',
        name: title,
        url: res.url,
        total: totalAnnotations,
        createdAt: Date.now(),
      }).catch(() => undefined)
      setResultMsg({ type: 'ok', text: res.message || t('msg.docCreatedAutoOpen', { name: t('docTarget.kingsoft.name') }) })
    } catch (err) {
      setResultMsg({ type: 'error', text: t('msg.createFailed', { name: t('docTarget.kingsoft.name'), msg: err instanceof Error ? err.message : String(err) }) })
    } finally {
      setDocLoading(false)
    }
  }

  /** 生成文档：按所选目标分流（飞书 / 腾讯 / 金山） */
  const handleCreateDoc = async () => {
    if (docTarget === 'feishu') {
      if (!feishuReady) {
        setResultMsg({ type: 'warn', text: t('msg.feishuConfigNeeded') })
        return
      }
      await doFeishu()
      return
    }
    if (docTarget === 'tencent') {
      await doTencent()
      return
    }
    // 金山：创建在线文档（标题为报告名）
    await doKingsoft()
  }

  /** 组装文档导出 payload（飞书 / 腾讯共用）：正文内嵌逐页标注合成图 + 标注详情（测量值/取样色并入明细标题） */
  const buildDocPayload = async (html: string) => {
    const pageData = await loadPageData()
    const allIssues = pageData.flatMap((pd) => pd.issues)
    // 标注图片：逐页把标注合成到页面图上（仅含有标注且图片可用的页），文档正文直接可见标注位置
    const images: Array<{ name: string; dataUrl: string }> = []
    for (const pd of pageData) {
      if (!pd.imageBase64 || !pd.issues.length) continue
      const composed = await compositeAnnotations(pd.imageBase64, pd.issues)
      if (composed) images.push({ name: `${pd.page.name} · 标注图`, dataUrl: composed })
    }
    return {
      title: `${reportName} - ${new Date().toLocaleDateString('zh-CN')}`,
      metaLines: [
        `${t('projectName')}${project?.name ?? ''}  ${t('pageCount')}${allPages?.length ?? 0}  ${t('totalAnnotations')}${allIssues.length}`,
        `导出时间 ${new Date().toLocaleString('zh-CN')}`,
      ],
      stats: [
        { label: '总计', value: String(allIssues.length) },
        { label: '严重', value: String(allIssues.filter((i) => i.severity === 'major').length) },
        { label: '一般', value: String(allIssues.filter((i) => i.severity === 'minor').length) },
        { label: '建议', value: String(allIssues.filter((i) => i.severity === 'suggestion').length) },
      ],
      issues: allIssues.map((i) => ({
        no: i.no,
        title: docIssueTitle(i),
        severityLabel: i.severityLabel,
        categoryLabel: i.categoryLabel,
        sourceLabel: '手动标注',
        targetLabel: i.pageName,
        statusLabel: i.statusLabel,
      })),
      images,
      htmlReport: {
        name: `产品标注报告_${reportName}_${new Date().toISOString().slice(0, 10)}_${new Date().toTimeString().slice(0, 8)}.html`,
        dataUrl: htmlToDataUrl(html),
      },
    }
  }

  /** 导出历史记录（排除已软删进回收站的记录） */
  const reportHistory = useLiveQuery(
    async () =>
      (
        await db.reportRecords
          .where('projectId')
          .equals(projectId!)
          .filter((r) => !r.deletedAt)
          .toArray()
      ).sort((a, b) => b.createdAt - a.createdAt),
    [projectId]
  )

  /** 类型标签映射 */
  const typeLabel: Record<string, string> = useMemo(() => ({
    html: t('type.html'),
    feishu: t('type.feishu'),
    tencent: t('type.tencent'),
    kingsoft: t('type.kingsoft'),
  }), [t])

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <a className="back-link" draggable={false} onClick={() => navigate(-1)}>
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
            {t('backToPage')}
          </a>
          <h1>{t('exportProjectReport')}</h1>
        </div>
      </div>

      <div className="card export-card" style={{ position: 'relative' }}>
        {/* 文档目标选择（飞书 / 腾讯 / 金山）：固定在卡片右上角 */}
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
        {/* 报告信息摘要：标签与值留隙、行距放宽，对齐 UI 走查导出报告的间距节奏 */}
        <div className="export-info-list">
          <p><strong>{t('projectName')}</strong>{project?.name ?? '-'}</p>
          <p><strong>{t('pageCount')}</strong>{allPages?.length ?? 0} {t('pages')}</p>
          <p><strong>{t('totalAnnotations')}</strong>{totalAnnotations}</p>
        </div>
        {/* 导出按钮 */}
        <div className="wizard-actions export-actions">
          <div className="export-actions-left">
            <button className="btn-primary" onClick={handleExport} disabled={exporting || docLoading || !(allPages?.length)}>
              {exporting ? t('exporting') : t('exportHTML')}
            </button>
            <button
              className="btn-secondary"
              onClick={handleCreateDoc}
              disabled={docLoading || exporting || !(allPages?.length)}
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
              {docLoading ? t('creatingDoc') : docTargets.find((d) => d.key === docTarget)!.btn}
            </button>
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
                  <span className="badge badge-primary report-history-type-badge" title={typeLabel[record.type] || record.type}>
                    {typeLabel[record.type] || record.type}
                  </span>
                  <span className="report-history-name">{record.name}</span>
                  <span className="report-history-count">{t('page.totalIssues', { n: record.total })}</span>
                  <span className="report-history-time">{new Date(record.createdAt).toLocaleString('zh-CN')}</span>
                </div>
                <div className="report-history-actions">
                  {record.type === 'html' && record.filePath && (
                    <button
                      type="button"
                      className="report-history-folder"
                      onClick={(e) => {
                        e.stopPropagation()
                        window.electronAPI
                          .showInFolder(record.filePath!)
                          .then((ok) => {
                            if (!ok) setResultMsg({ type: 'error', text: t('msg.openFolderFailed') })
                          })
                          .catch(() => setResultMsg({ type: 'error', text: t('msg.openFolderFailed') }))
                      }}
                      title={folderOf(record.filePath!)}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M2 6a2 2 0 0 1 2-2h5l2 2h9a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2z" />
                      </svg>
                    </button>
                  )}
                  <button
                    type="button"
                    className="report-history-delete"
                    onClick={async (e) => {
                      e.stopPropagation()
                      if (!(await confirmDialog({ message: t('page.confirmDeleteRecord', { defaultValue: '确认删除该导出记录？' }), tone: 'danger' }))) return
                      // 软删进回收站：保留期内可还原；HTML 文件保留，彻底删除/过期清理时才移入废纸篓
                      await softDeleteReports([record.id], 'product')
                    }}
                    title={t('page.deleteRecordTip')}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
