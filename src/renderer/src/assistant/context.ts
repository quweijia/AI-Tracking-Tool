import { db, CATEGORY_LABELS, SEVERITY_LABELS, ISSUE_STATUS_LABELS } from '../db'
import type { Issue, ReportRecord, AssistantRef } from '../db'
import { loadProjectSpecTokens, formatSpecSummary } from '../spec/specCheck'
import { SYSTEM_PROMPT } from './prompt'

/**
 * AI 小助手上下文组装器：
 * 路由（项目/页面）或打开的报告变化时重建，发送提问时随消息注入大模型。
 * 数据全部来自现有 Dexie 表（projects/pages/issues/reportRecords/specTokens），不新增存储。
 */

/** 注入 prompt 的问题条数上限（防超限；超出时按创建时间取最新） */
const ISSUES_LIMIT = 60
/** 随消息序列发送的对话历史条数上限 */
const HISTORY_LIMIT = 20
/** 最近报告条数上限 */
const REPORTS_LIMIT = 5
/** 单条问题/历史消息的文案截断长度 */
const TEXT_LIMIT = 120

const REPORT_TYPE_LABELS: Record<ReportRecord['type'], string> = {
  html: 'HTML 交互报告',
  feishu: '飞书文档',
  tencent: '腾讯文档',
  kingsoft: '金山文档',
  dev: '研发修改报告'
}

/** 页面走查状态文案（PageStatus 固定三态） */
const PAGE_STATUS_LABELS: Record<string, string> = {
  pending: '待走查',
  reviewing: '走查中',
  completed: '已完成'
}

export interface AssistantContextData {
  /** 当前选中项目（未选中为 null） */
  project: { id: string; name: string; platform: string[] } | null
  /** 当前页面信息（项目级会话为 null） */
  page: { id: string; pageName: string; platform: string; status: string } | null
  /** 当前打开报告 ID（未指定时取页面/项目最近一份） */
  reportId: string
  /** 最近报告列表（检索历史用） */
  reports: { id: string; name: string; type: string; total: number; createdAt: number }[]
  /** 当前 diff 问题数组（含噪声标记，已截断） */
  issues: {
    id: string
    category: string
    severity: string
    status: string
    rect: { x: number; y: number; width: number; height: number }
    description: string
    diff: string
    matchConfidence?: number
    noise: string
  }[]
  /** 规范 Token 摘要（formatSpecSummary 分组文本，未绑定为空串） */
  specTokensSummary: string
  /** 本轮对话历史（随消息序列发送，此处仅作条数说明） */
  historyCount: number
}

/** 差值文本：结构化建议（现状 → 改法）> 测量值 > 双图取样色 */
function issueDiff(issue: Issue): string {
  if (issue.aiSuggestion) {
    return [issue.aiSuggestion.current, issue.aiSuggestion.fix].filter(Boolean).join(' → ')
  }
  if (issue.measureValue) return issue.measureValue
  if (issue.sampleA && issue.sampleB) return `${issue.sampleA} vs ${issue.sampleB}`
  return ''
}

/** 噪声标记：已豁免状态 / 低匹配置信度（结构化比对）→ 模型据此区分真实缺陷与容差噪声 */
function issueNoise(issue: Issue): string {
  if (issue.status === 'ignored') return '已忽略'
  if (issue.status === 'design-confirmed') return '设计确认不改'
  if (issue.source === 'structured' && typeof issue.matchConfidence === 'number' && issue.matchConfidence < 0.6) {
    return '疑似容差噪声（匹配置信度低）'
  }
  return '待判定'
}

function clip(text: string, limit = TEXT_LIMIT): string {
  const t = text.trim()
  return t.length > limit ? `${t.slice(0, limit)}…` : t
}

/**
 * 组装当前上下文：projectId 为空（项目列表页）时各字段降级为空，不报错。
 * @param reportId 面板当前打开的报告 ID（可空，缺省取最近一份）
 */
export async function buildAssistantContext(
  projectId: string,
  pageId: string,
  reportId = ''
): Promise<AssistantContextData> {
  const project = projectId ? ((await db.projects.get(projectId)) ?? null) : null
  const page = pageId ? ((await db.pages.get(pageId)) ?? null) : null
  const ctx: AssistantContextData = {
    project: project ? { id: project.id, name: project.name, platform: project.platform } : null,
    page: page
      ? {
          id: page.id,
          pageName: page.pageName,
          platform: page.platform,
          status: PAGE_STATUS_LABELS[page.status] ?? page.status
        }
      : null,
    reportId,
    reports: [],
    issues: [],
    specTokensSummary: '',
    historyCount: 0
  }
  if (!project && !page) return ctx
  // 最近报告（页面优先，其次项目）
  const reportRows = (
    await db.reportRecords
      .where(page ? 'pageId' : 'projectId')
      .equals(page ? page.id : project!.id)
      .sortBy('createdAt')
  )
    .reverse()
    .slice(0, REPORTS_LIMIT)
  ctx.reports = reportRows.map((r) => ({
    id: r.id,
    name: r.name,
    type: REPORT_TYPE_LABELS[r.type],
    total: r.total,
    createdAt: r.createdAt
  }))
  ctx.reportId = reportId || reportRows[0]?.id || ''
  // 当前 diff 问题（页面级会话才有；按创建时间最新在前，截断 ISSUES_LIMIT）
  if (page) {
    const issueRows = (await db.issues.where('pageId').equals(page.id).sortBy('createdAt')).reverse()
    ctx.issues = issueRows.slice(0, ISSUES_LIMIT).map((i) => ({
      id: i.id,
      category: CATEGORY_LABELS[i.category] ?? i.category,
      severity: SEVERITY_LABELS[i.severity] ?? i.severity,
      status: ISSUE_STATUS_LABELS[i.status] ?? i.status,
      rect: { x: i.x, y: i.y, width: i.width, height: i.height },
      description: clip(i.description),
      diff: issueDiff(i),
      ...(typeof i.matchConfidence === 'number' ? { matchConfidence: i.matchConfidence } : {}),
      noise: issueNoise(i)
    }))
    // 规范 Token 摘要（复用走查校验的取套逻辑：页面端类型 → 绑定规范套最新版本）
    const tokens = await loadProjectSpecTokens(project!.id, page.platform)
    if (tokens.length) ctx.specTokensSummary = formatSpecSummary(tokens)
  }
  return ctx
}

/** 上下文序列化为注入文本（沿用需求文档的字段口径） */
export function serializeContext(ctx: AssistantContextData): string {
  return JSON.stringify(
    {
      当前选中项目: ctx.project,
      当前页面信息: ctx.page,
      当前打开报告ID: ctx.reportId || '无',
      最近报告: ctx.reports.map((r) => ({
        id: r.id,
        名称: r.name,
        类型: r.type,
        问题数: r.total,
        时间: new Date(r.createdAt).toLocaleString()
      })),
      当前diff问题数组: ctx.issues.map((i) => ({
        问题ID: i.id,
        坐标: `${i.rect.x.toFixed(3)},${i.rect.y.toFixed(3)},${i.rect.width.toFixed(3)},${i.rect.height.toFixed(3)}`,
        类型: i.category,
        严重度: i.severity,
        状态: i.status,
        差值: i.diff || '无',
        匹配置信度: i.matchConfidence ?? '未记录',
        是否噪声: i.noise
      })),
      当前项目绑定的Figma规范Token库: ctx.specTokensSummary || '未绑定规范',
      本轮对话历史: `最近 ${ctx.historyCount} 条已按消息序列发送`
    },
    null,
    1
  )
}

/**
 * 组装发送给大模型的完整消息序列：system 提示词 + 最近对话历史（真实消息）+ 用户提问（附上下文）。
 * @param history 本轮会话历史（store 中的已落库消息）
 * @param userContent 用户输入（已含 @引用文本）
 * @param ctx 当前上下文
 */
export function buildChatMessages(
  history: { role: 'user' | 'assistant'; content: string }[],
  userContent: string,
  ctx: AssistantContextData
): { role: 'system' | 'user' | 'assistant'; content: string }[] {
  const messages: { role: 'system' | 'user' | 'assistant'; content: string }[] = [
    { role: 'system', content: SYSTEM_PROMPT }
  ]
  for (const h of history.slice(-HISTORY_LIMIT)) {
    messages.push({ role: h.role, content: clip(h.content, 2000) })
  }
  ctx.historyCount = Math.min(history.length, HISTORY_LIMIT)
  messages.push({ role: 'user', content: `${userContent}\n\n【当前工作区上下文】\n${serializeContext(ctx)}` })
  return messages
}

/**
 * 应用 @ 引用到上下文：@报告 → 切换上下文指向的报告。
 * @项目/@页面/@问题ID 的详情由 formatMentionNotes 以文本附加（可跨项目引用）。
 */
export async function applyMentions(ctx: AssistantContextData, refs: AssistantRef[]): Promise<void> {
  for (const ref of refs) {
    if (ref.type === 'report' && ref.id) ctx.reportId = ref.id
  }
}

/**
 * @ 引用详情文本（附加在用户提问后）：问题带坐标/类型/差值/噪声标记，项目/页面带名称，
 * 让模型能引用当前路由之外的对象（如检索历史时引用别的项目）。
 */
export async function formatMentionNotes(refs: AssistantRef[]): Promise<string> {
  const lines: string[] = []
  for (const ref of refs) {
    if (ref.type === 'issue') {
      const i = await db.issues.get(ref.id)
      if (!i) continue
      lines.push(
        `- 引用问题 ${ref.label}（ID ${i.id}）：${CATEGORY_LABELS[i.category] ?? i.category}/${SEVERITY_LABELS[i.severity] ?? i.severity}/${ISSUE_STATUS_LABELS[i.status] ?? i.status}，坐标 ${i.x.toFixed(3)},${i.y.toFixed(3)},${i.width.toFixed(3)},${i.height.toFixed(3)}，描述：${clip(i.description)}`
      )
    } else if (ref.type === 'project') {
      const p = await db.projects.get(ref.id)
      if (p) lines.push(`- 引用项目「${p.name}」（ID ${p.id}，端 ${p.platform.join('/') || '未设置'}）`)
    } else if (ref.type === 'page') {
      const pg = await db.pages.get(ref.id)
      if (pg) {
        const prj = await db.projects.get(pg.projectId)
        lines.push(`- 引用页面「${pg.pageName}」（ID ${pg.id}，端 ${pg.platform}，所属项目「${prj?.name ?? pg.projectId}」）`)
      }
    } else if (ref.type === 'report') {
      const r = await db.reportRecords.get(ref.id)
      if (r) lines.push(`- 引用报告「${r.name}」（ID ${r.id}，${REPORT_TYPE_LABELS[r.type]}，问题数 ${r.total}）`)
    }
  }
  return lines.length ? `\n\n【用户@引用对象】\n${lines.join('\n')}` : ''
}

/** 面板用：引用展示文案（气泡 chip），如「项目 官网首页」 */
export function mentionChipLabel(ref: AssistantRef): string {
  const typeLabel =
    ref.type === 'project' ? '项目' : ref.type === 'page' ? '页面' : ref.type === 'report' ? '报告' : '问题'
  return `${typeLabel} ${ref.label}`
}
