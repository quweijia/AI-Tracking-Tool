import { ipcMain, nativeImage } from 'electron'
import { getConfigData } from './ipc'
import { proxyFetch } from './figma'
import { normalizeTolerance, type ToleranceConfig } from '../shared/types'

/** AI 模型配置（OpenAI 兼容协议） */
export interface AIModelConfig {
  id: string
  name: string
  baseUrl: string
  apiKey: string
  model: string
  /** 是否支持图像输入（走查需多模态模型） */
  vision: boolean
  createdAt: number
}

/** AI 标注候选（归一化坐标） */
interface AIAnnotation {
  targetImage: 'design' | 'screenshot'
  shape: 'rect' | 'point' | 'text' | 'measure' | 'picker'
  x: number
  y: number
  width: number
  height: number
  description: string
  severity: 'major' | 'minor' | 'suggestion'
  category: 'spacing' | 'typography' | 'color' | 'style' | 'interaction' | 'compatibility'
  suggestion?: { current: string; fix: string; properties?: string }
  /** 问题分级：模型显式给出时透传（required=正式缺陷；optional=备选参考），缺省由走查侧兜底判定 */
  level?: 'required' | 'optional'
  /** 分级判定理由（level=optional 时模型给出） */
  levelReason?: string
}

const SEVERITIES = ['major', 'minor', 'suggestion']
const CATEGORIES = ['spacing', 'typography', 'color', 'style', 'interaction', 'compatibility']
const SHAPES = ['rect', 'point', 'text', 'measure', 'picker']
const LEVELS = ['required', 'optional']

function chatUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, '')
  return /\/chat\/completions$/.test(trimmed) ? trimmed : `${trimmed}/chat/completions`
}

function getModel(modelId: string): AIModelConfig {
  const config = getConfigData()
  const models = (config.aiModels as AIModelConfig[] | undefined) ?? []
  const model = models.find((m) => m.id === modelId)
  if (!model) throw new Error('未找到该模型配置，请到「AI 模型管理」检查')
  if (!model.baseUrl || !model.apiKey || !model.model) {
    throw new Error('模型配置不完整（Base URL / API Key / 模型名）')
  }
  return model
}

/** 调用 OpenAI 兼容 chat/completions */
interface ChatResult {
  text: string
  finishReason: string
}

interface ChatOpts {
  /** 流式接收（识别长输出时避免整体硬超时，且可上报进度） */
  stream?: boolean
  /** 流式模式下无新数据的最长等待（默认 60s，超时判定服务卡死） */
  idleMs?: number
  /** 流式接收进度回调（参数 = 已接收字符数） */
  onProgress?: (chars: number) => void
}

/** 解析 SSE data 行 delta，累加 content / reasoning_content */
function consumeSseChunk(payload: string, acc: { content: string; reasoning: string; finishReason: string }): void {
  if (payload === '[DONE]') return
  try {
    const j = JSON.parse(payload) as {
      choices?: { delta?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[]
    }
    const c = j.choices?.[0]
    const delta = c?.delta
    if (typeof delta?.content === 'string') acc.content += delta.content
    if (typeof delta?.reasoning_content === 'string') acc.reasoning += delta.reasoning_content
    if (c?.finish_reason) acc.finishReason = String(c.finish_reason)
  } catch {
    // 忽略不完整或非 JSON 行
  }
}

async function callChat(
  model: AIModelConfig,
  messages: unknown,
  maxTokens: number,
  timeoutMs = 60000,
  extraBody?: Record<string, unknown>,
  opts: ChatOpts = {}
): Promise<ChatResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  const useStream = opts.stream === true
  const init = {
    method: 'POST' as const,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${model.apiKey}`
    },
    body: JSON.stringify({
      model: model.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      ...(useStream ? { stream: true } : {}),
      ...extraBody
    }),
    signal: ctrl.signal
  }
  let res: Response
  try {
    // 内网 LLM 地址通常可直连：先直连，网络层失败（fetch failed 等）再走代理链重试
    res = await fetch(chatUrl(model.baseUrl), init)
  } catch (err) {
    if (ctrl.signal.aborted) throw new Error(`请求超时（${Math.round(timeoutMs / 1000)}s），请检查模型服务是否可达`)
    try {
      res = await proxyFetch(chatUrl(model.baseUrl), init)
    } catch {
      throw new Error(
        `网络请求失败（${err instanceof Error ? err.message : String(err)}）：模型服务不可达。请确认 Base URL 正确且服务已启动；若模型服务在外网，可在「设置 → MCP 管理」配置代理地址后重试`
      )
    }
  }
  try {
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 404) {
        throw new Error(
          `接口返回 404：${chatUrl(model.baseUrl)} 不存在。请检查 Base URL 是否需要以 /v1 结尾（如 http://117.73.0.134:9875/v1）`
        )
      }
      throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`)
    }
    // 流式读取：SSE 增量解析，空闲超时判定卡死，进度实时回调
    if (useStream && res.body && typeof res.body.getReader === 'function') {
      const acc = { content: '', reasoning: '', finishReason: '' }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const idleMs = opts.idleMs ?? 60000
      let lastData = Date.now()
      let idleAborted = false
      const watchdog = setInterval(() => {
        if (Date.now() - lastData > idleMs) {
          idleAborted = true
          void reader.cancel().catch(() => {})
        }
      }, 3000)
      try {
        let buf = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          lastData = Date.now()
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const t = line.trim()
            if (t.startsWith('data:')) consumeSseChunk(t.slice(5).trim(), acc)
          }
          opts.onProgress?.(acc.content.length + acc.reasoning.length)
        }
      } finally {
        clearTimeout(timer)
        clearInterval(watchdog)
      }
      if (idleAborted || ctrl.signal.aborted) {
        throw new Error(`请求超时（${Math.round(idleMs / 1000)}s 无新数据）：模型服务响应中断，请重试`)
      }
      let text = acc.content.trim() ? acc.content : acc.reasoning
      if (!text.trim()) throw new Error('模型返回内容为空')
      return { text, finishReason: acc.finishReason }
    }
    const data = (await res.json().catch(() => null)) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; finish_reason?: unknown }[]
    } | null
    if (!data) {
      throw new Error('接口返回内容不是有效 JSON，请确认地址为 OpenAI 兼容接口')
    }
    const msg = data?.choices?.[0]?.message
    const finishReason = String(data?.choices?.[0]?.finish_reason ?? '')
    let content = typeof msg?.content === 'string' ? msg.content : ''
    if (!content.trim()) {
      // 思考型模型可能把 max_tokens 花在 reasoning_content 上，content 为空时回退用思考内容提取结果
      content = typeof msg?.reasoning_content === 'string' ? msg.reasoning_content : ''
    }
    if (!content.trim()) {
      throw new Error('模型返回内容为空')
    }
    return { text: content, finishReason }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(
        `请求超时（${Math.round(timeoutMs / 1000)} 秒无响应）：请检查地址/端口是否可达，或 Base URL 是否需要以 /v1 结尾`
      )
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** 从模型回复中提取 JSON（容忍 ```json 包裹与前后缀文字） */
function extractJson(text: string): { issues?: unknown } {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const raw = fence ? fence[1] : text
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(
      `模型未返回有效的 JSON 结果（响应片段：${text.slice(0, 160).replace(/\s+/g, ' ')}）`
    )
  }
  return JSON.parse(raw.slice(start, end + 1)) as { issues?: unknown }
}

const clamp01 = (v: unknown): number => Math.min(1, Math.max(0, Number(v) || 0))

/** 从 dataUrl 解析图片真实像素尺寸（PNG 读 IHDR / JPEG 扫 SOF 段；解析失败返回 null） */
function getImageSizeFromDataUrl(dataUrl: string): { width: number; height: number } | null {
  try {
    const buf = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    // PNG：8 字节签名（0x89504E47…），IHDR 块内大端宽高固定在 16/20 偏移
    if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) {
      return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
    }
    // JPEG：FFD8 开头，逐段扫描 SOF0~SOF15（排除 DHT/DAC/JPG 等非帧头段）
    if (buf.length >= 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off++
          continue
        }
        const marker = buf[off + 1]
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { height: buf.readUInt16BE(off + 5), width: buf.readUInt16BE(off + 7) }
        }
        off += 2 + buf.readUInt16BE(off + 2)
      }
    }
  } catch {
    // 非法 dataUrl 走 null 兜底
  }
  return null
}

/** 传给模型的图片信息：原图尺寸 / 发送尺寸 / 坐标反向映射系数 */
interface ModelImageInfo {
  dataUrl: string
  origW: number
  origH: number
  sentW: number
  sentH: number
  /** scale = 原图宽 ÷ 发送宽：模型图片像素 × scale = 原始画布像素（降采样时 > 1） */
  scale: number
}

/**
 * 图片预处理：发送前按服务端限制约束尺寸。
 * 实测服务端（vLLM）对超过限制的图做「非等比」压缩：宽保持、高强制压到 ~1024
 * （台架实证 1299×1805 → 服务端压高至 ~1011，模型输出 y 系统性偏小 0.56 倍而 x 正确——
 * 模型在被压高的图上定位准确，但按 prompt 声称的原图高换算归一化）。
 * 因此发送图必须满足：宽 ≤1299（实测该宽度未被压）、高 ≤1024。
 * 竖长整页图无法直接满足 → aiAnnotate 走纵向切段（planEvenSegments），本函数只做
 * 宽度约束的等比缩放；归一化坐标在等比缩放下不变，渲染端消费不受影响。
 */
const AI_SEGMENT_MAX_W = 1299
/** 每段最大高度：服务端高度硬限制（实测 >1024 即被非等比压高致 y 定位系统性偏移） */
const AI_SEGMENT_MAX_H = 1024
/** 相邻段重叠像素：保证跨段边界附近的元素在至少一段中完整可见 */
const AI_SEGMENT_OVERLAP = 64

interface PreparedImage {
  dataUrl: string
  W: number
  H: number
  /** 预处理前的原始图尺寸：仅用于尺寸链路日志与 scale 展示，坐标换算以 W/H 为准 */
  origW: number
  origH: number
}

function constrainImageWidth(dataUrl: string, label: string): PreparedImage {
  const size = getImageSizeFromDataUrl(dataUrl)
  if (!size) {
    console.warn(`[ai-coord] ${label}: 图片尺寸解析失败，按原始 dataURL 发送`)
    return { dataUrl, W: 0, H: 0, origW: 0, origH: 0 }
  }
  if (size.width <= AI_SEGMENT_MAX_W) {
    console.log(`[ai-coord] ${label}: 原图 ${size.width}x${size.height}px，宽 ≤${AI_SEGMENT_MAX_W} 不缩放（scale=1）`)
    return { dataUrl, W: size.width, H: size.height, origW: size.width, origH: size.height }
  }
  const ratio = AI_SEGMENT_MAX_W / size.width
  const W = AI_SEGMENT_MAX_W
  const H = Math.round(size.height * ratio)
  const resized = nativeImage.createFromDataURL(dataUrl).resize({ width: W, height: H })
  console.log(
    `[ai-coord] ${label}: 原图 ${size.width}x${size.height}px → 送图基准 ${W}x${H}px（宽度约束，scale=${(size.width / W).toFixed(3)}）`
  )
  return {
    dataUrl: `data:image/png;base64,${resized.toPNG().toString('base64')}`,
    W,
    H,
    origW: size.width,
    origH: size.height
  }
}

/** 纵向均匀切段：n 段按比例均分，段间扩展 overlap 保证跨缝元素完整；
 * 段高（含 overlap 扩展）通过段数控制 ≤ SEG_MAX_H（n ≥ H / (MAX_H - 2×overlap)） */
function planSegCount(H: number): number {
  return Math.max(1, Math.ceil(H / (AI_SEGMENT_MAX_H - 2 * AI_SEGMENT_OVERLAP)))
}

interface ImageSegment {
  top: number
  height: number
}

function planEvenSegments(H: number, n: number): ImageSegment[] {
  if (n <= 1) return [{ top: 0, height: H }]
  const segs: ImageSegment[] = []
  for (let i = 0; i < n; i++) {
    const top0 = Math.round((H * i) / n)
    const bot0 = Math.round((H * (i + 1)) / n)
    const top = Math.max(0, top0 - (i > 0 ? AI_SEGMENT_OVERLAP : 0))
    const bot = Math.min(H, bot0 + (i < n - 1 ? AI_SEGMENT_OVERLAP : 0))
    segs.push({ top, height: bot - top })
  }
  return segs
}

/** 裁出纵向区段（dataURL → nativeImage.crop → PNG dataURL） */
function cropSegment(pre: PreparedImage, seg: ImageSegment): PreparedImage {
  if (seg.top === 0 && seg.height === pre.H) return pre
  const img = nativeImage.createFromDataURL(pre.dataUrl)
  const cropped = img.crop({ x: 0, y: seg.top, width: pre.W, height: seg.height })
  return {
    dataUrl: `data:image/png;base64,${cropped.toPNG().toString('base64')}`,
    W: pre.W,
    H: seg.height,
    origW: pre.origW,
    origH: pre.origH
  }
}

/** 段图的尺寸信息（normalizeIssues 的坐标系输入：段宽/段高即模型实际看到的图尺寸） */
function segmentImageInfo(seg: PreparedImage): ModelImageInfo {
  return { dataUrl: seg.dataUrl, origW: seg.W, origH: seg.H, sentW: seg.W, sentH: seg.H, scale: 1 }
}

/** 模型输出的像素 bbox（x1,y1=左上角，x2,y2=右下角，基于传给模型的图片坐标系） */
interface PixelBbox {
  x1: number
  y1: number
  x2: number
  y2: number
}

/**
 * 坐标转换函数（阶段1核心）：模型像素 bbox × scale 反向映射回原始截图画布像素，
 * 再 ÷ 原图宽高得到归一化坐标（0~1）。渲染层按归一化百分比绘制，
 * 与画布显示尺寸 / devicePixelRatio / 预览容器缩放天然无关。
 */
function mapBboxToNormalized(
  b: PixelBbox,
  img: ModelImageInfo
): { x: number; y: number; width: number; height: number } {
  const ox1 = b.x1 * img.scale
  const oy1 = b.y1 * img.scale
  const ox2 = b.x2 * img.scale
  const oy2 = b.y2 * img.scale
  return {
    x: clamp01(ox1 / img.origW),
    y: clamp01(oy1 / img.origH),
    width: clamp01((ox2 - ox1) / img.origW),
    height: clamp01((oy2 - oy1) / img.origH)
  }
}

/** 校验并归一化模型输出的标注候选（坐标字段兼容新旧两种格式） */
function normalizeIssues(
  raw: unknown,
  imgs: { design: ModelImageInfo; shot: ModelImageInfo }
): AIAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: AIAnnotation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const description = String(o.description ?? '').trim()
    if (!description) continue
    const shape = SHAPES.includes(String(o.shape)) ? (String(o.shape) as AIAnnotation['shape']) : 'rect'
    // 点位/文字/吸色只保留坐标点，宽高置 0；测量保留宽高矢量
    const zeroDims = shape === 'point' || shape === 'text' || shape === 'picker'
    const targetImage = o.targetImage === 'design' ? 'design' : 'screenshot'
    const img = targetImage === 'design' ? imgs.design : imgs.shot
    const n = (v: unknown): number => Number(v)
    // 新格式判别：x1/y1/x2/y2 均为有限数 → 像素坐标，按 scale 反向映射
    const hasPixelBbox =
      Number.isFinite(n(o.x1)) && Number.isFinite(n(o.y1)) && Number.isFinite(n(o.x2)) && Number.isFinite(n(o.y2))
    // 坐标契约：prompt 已强制要求输出「送入图片的像素坐标」（见 SYSTEM_PROMPT 坐标规则），
    // 旧的 ÷1000 虚拟坐标兜底已移除——它会把左上区域的小像素 bbox 误判为百分比造成整框位移。
    // 仍保留 0~1 分支做兼容（模型不遵守契约时的兜底，避免整条结果被丢弃）
    const normVals = [n(o.x1), n(o.y1), n(o.x2), n(o.y2)]
    const hasNormBbox =
      hasPixelBbox && normVals.every((v) => v >= -0.001 && v <= 1.001) && normVals.some((v) => v > 0)
    /** 定位偏差标记：坐标越出送图边界超过容差（5px）→ 描述末尾提示人工复核 */
    let suspicious = false
    let box: { x: number; y: number; width: number; height: number }
    if (hasNormBbox) {
      // 容错：模型可能交换左上/右下角，统一按 min/max 归位（measure 保留矢量方向）
      const keepSign = shape === 'measure'
      const bx1 = n(o.x1)
      const by1 = n(o.y1)
      const bx2 = n(o.x2)
      const by2 = n(o.y2)
      box = {
        x: clamp01(keepSign ? bx1 : Math.min(bx1, bx2)),
        y: clamp01(keepSign ? by1 : Math.min(by1, by2)),
        width: clamp01(Math.abs(bx2 - bx1)),
        height: clamp01(Math.abs(by2 - by1))
      }
      console.log(
        `[ai-coord] #${out.length + 1} ${targetImage}/${shape} 模型未按像素契约输出，按 0~1 归一化兜底接收=(x=${box.x.toFixed(4)}, y=${box.y.toFixed(4)}, w=${box.width.toFixed(4)}, h=${box.height.toFixed(4)})`
      )
      if (zeroDims) box = { x: box.x, y: box.y, width: 0, height: 0 }
    } else if (hasPixelBbox && img.sentW > 0 && img.origW > 0) {
      // 容错：模型可能交换左上/右下角，统一按 min/max 归位（measure 保留矢量方向）
      const keepSign = shape === 'measure'
      const bx1 = n(o.x1)
      const by1 = n(o.y1)
      const bx2 = n(o.x2)
      const by2 = n(o.y2)
      const loX = Math.min(bx1, bx2)
      const hiX = Math.max(bx1, bx2)
      const loY = Math.min(by1, by2)
      const hiY = Math.max(by1, by2)
      // 越界处理：整框落在图片外 → 丢弃该条；部分越界 → 钳位到图片边界并标记待复核
      if (hiX < 0 || loX > img.sentW || hiY < 0 || loY > img.sentH) {
        console.warn(
          `[ai-coord] 丢弃越界标注：bbox=(${bx1},${by1})~(${bx2},${by2}) 完全落在送图 ${img.sentW}x${img.sentH} 之外 | ${description.slice(0, 40)}`
        )
        continue
      }
      const clampPx = (v: number, max: number): number => Math.min(max, Math.max(0, v))
      const overflow = Math.max(0, -loX, hiX - img.sentW, -loY, hiY - img.sentH)
      suspicious = overflow > 5
      const b: PixelBbox = {
        x1: clampPx(bx1, img.sentW),
        y1: clampPx(by1, img.sentH),
        x2: clampPx(bx2, img.sentW),
        y2: clampPx(by2, img.sentH)
      }
      box = mapBboxToNormalized(b, img)
      // 偏移补偿日志：原图尺寸 / 送图尺寸 / scale / 原始 bbox / 钳位后 bbox / 最终归一化 bbox
      console.log(
        `[ai-coord] #${out.length + 1} ${targetImage}/${shape} 原图=${img.origW}x${img.origH} 送图=${img.sentW}x${img.sentH} scale=${img.scale} 原始bbox=(${bx1},${by1})~(${bx2},${by2}) 钳位后=(${b.x1.toFixed(0)},${b.y1.toFixed(0)})~(${b.x2.toFixed(0)},${b.y2.toFixed(0)}) → 原图px=(${(b.x1 * img.scale).toFixed(0)},${(b.y1 * img.scale).toFixed(0)})~(${(b.x2 * img.scale).toFixed(0)},${(b.y2 * img.scale).toFixed(0)}) → 归一化=(x=${box.x.toFixed(4)}, y=${box.y.toFixed(4)}, w=${box.width.toFixed(4)}, h=${box.height.toFixed(4)})${suspicious ? ' 【越界，标记复核】' : ''} | ${description.slice(0, 20)}`
      )
      if (zeroDims) box = { x: box.x, y: box.y, width: 0, height: 0 }
    } else {
      // 旧格式兼容：x,y,width,height 已是 0~1 归一化坐标
      box = {
        x: clamp01(o.x),
        y: clamp01(o.y),
        width: zeroDims ? 0 : clamp01(o.width),
        height: zeroDims ? 0 : clamp01(o.height)
      }
      console.log(
        `[ai-coord] #${out.length + 1} ${targetImage}/${shape} 旧归一化格式=(x=${box.x.toFixed(4)}, y=${box.y.toFixed(4)}, w=${box.width.toFixed(4)}, h=${box.height.toFixed(4)})`
      )
    }
    // 问题分级：模型显式返回才透传（白名单校验），缺省不填，由走查侧 resolveIssueLevel 兜底判定
    const level = LEVELS.includes(String(o.level)) ? (String(o.level) as AIAnnotation['level']) : undefined
    const levelReason = level ? String(o.levelReason ?? '').trim().slice(0, 200) || undefined : undefined
    if (level) {
      console.log(
        `[ISSUE_LEVEL] #${out.length + 1} level=${level} 可选=${level === 'optional'} 理由=${levelReason ?? '模型未给出'}`
      )
    }
    const sug = (o.suggestion ?? {}) as Record<string, unknown>
    out.push({
      targetImage,
      shape,
      x: box.x,
      y: box.y,
      width: box.width,
      height: box.height,
      // 240 = 原 200 上限 + 末尾命中技能标注【命中技能：技能名称】的预留空间（模块2/3 依赖标注完整）；
      // 定位偏差（越界钳位超过 5px 容差）时在描述末尾附人工复核提示
      description: suspicious
        ? `${description.slice(0, 214)}【定位偏差较大，建议人工复核】`
        : description.slice(0, 240),
      severity: SEVERITIES.includes(String(o.severity))
        ? (String(o.severity) as AIAnnotation['severity'])
        : 'minor',
      category: CATEGORIES.includes(String(o.category))
        ? (String(o.category) as AIAnnotation['category'])
        : 'spacing',
      suggestion: {
        current: String(sug.current ?? '').slice(0, 300),
        fix: String(sug.fix ?? '').slice(0, 300),
        properties: String(sug.properties ?? '').slice(0, 120) || undefined
      },
      ...(level ? { level, levelReason } : {})
    })
  }
  return out
}

// 视觉语义走查：站在设计师肉眼验收视角，基于两张截图对比找问题。
// 不做像素级测量，只抓「视觉上真实存在、需要改」的问题，压低误报
const SYSTEM_PROMPT = `你是资深 UI 设计师，正在对开发实现页面做上线前的肉眼验收走查。用户会提供两张图：第一张是 Figma 设计稿（验收基准），第二张是开发实现的页面截图。请像设计师验收一样，用眼睛对比两张图，找出「开发实现和设计稿看起来不一样、且真实需要修改」的视觉问题，输出 JSON。

只报告肉眼可辨认、确实需要开发修改的问题。以下情况必须跳过、不要报告：
- 两张图内容数据不同导致的差异（列表条数不同、图片内容不同、用户名/时间等动态文案不同）
- 字体渲染抗锯齿、亚像素级模糊等截图天然差异
- 你不确定是否真的是问题的地方（宁可漏报，不可误报）
- 设计稿中未展示、但属于合理响应式布局差异的部分

问题分级规则（每条问题先判断再输出 level）：
1. 设计稿与开发图存在肉眼可见的视觉不一致（尺寸/错位/颜色/文案/样式差异）→ 正式缺陷，level="required"，必须标注
2. 两张图视觉上完全一致，仅「文字对比度不满足 WCAG 无障碍规范」→ 属设计选型，输出 level="optional" 的参考问题，禁止按缺陷强制标注
3. 判定「组件缺失」前必须先核对第一张设计稿截图：设计稿中存在该元素 → 判为疑似误报，level="optional"，levelReason 写明「疑似误报：设计稿中存在该元素」；设计稿确实没有该元素 → 才是正式缺陷，level="required"
4. 禁止把「设计稿本身就是这个样式」的规范选型（如刻意的低对比度设计）当成 UI 缺陷

检查清单（逐项对比两张图）：
1. 文字类：文字被截断、溢出容器、换行位置异常、字体不对、字号视觉上明显不一致、文案与设计稿不一样
2. 对齐布局：元素之间不对齐、上下错位、元素意外重叠、间距视觉上明显过大或过小
3. 图标图片：图标缺失、图标或图片变形拉伸、颜色不对、图片加载失败、出现异常占位图
4. 组件状态：按钮/输入框的禁用、报错等状态样式缺失或异常，弹窗/浮层样式异常
5. 色彩：颜色明显偏差（色相/深浅一眼能看出不一样）、文字与背景对比度过低看不清
6. 排版：多行文本行高拥挤或过松、标题层级视觉错乱（该大的不大、该粗的不粗）

严格只输出一个 JSON 对象，不要任何解释文字，格式：
{"issues":[{"targetImage":"screenshot","shape":"rect","x1":332,"y1":196,"x2":512,"y2":288,"description":"主按钮文案被截断，末尾显示不全","severity":"major","category":"typography","level":"required","suggestion":{"current":"按钮文字显示不全","fix":"检查按钮宽度或文字截断规则","properties":"text-overflow"}}]}
字段要求：
- targetImage：标注画在哪张图上。"screenshot"=开发截图（多数问题标在这里），"design"=设计稿（元素缺失、新增元素等，在设计稿上框选）。两张图尺寸可能不同，坐标相对各自图片独立计算（用户消息中标注了每张图的像素尺寸）
- shape 按问题类型选择：
  * "rect"：框选问题元素（文字问题、图标图片、缺失/多余元素、组件状态、排版问题都用 rect）
  * "measure"：间距明显过大/过小时标注间距区间。x1,y1=间距起点，x2,y2=间距终点（垂直间距 x1=x2，水平间距 y1=y2）
  * "picker"：颜色明显偏差。x1=y1=x2=y2=取色点
  * "point"：对齐错位等无明显边界的问题。x1=y1=x2=y2=问题位置中心点
- x1,y1,x2,y2 坐标规则（必须严格遵守）：相对「当前送入图片本身」的左上角原点，单位为像素整数；输出 x1,y1,x2,y2（x1,y1=左上角，x2,y2=右下角），不要归一化百分比、不要 0~1000 虚拟坐标系、不要自行缩放或换算成其它尺寸。例如图片宽 1280、高 800，元素位于像素 (512,160)~(768,240)，则输出 x1=512,y1=160,x2=768,y2=240
- 越界处理：坐标不得超出图片宽高（0 ≤ x ≤ 图片宽，0 ≤ y ≤ 图片高）；越界值会被直接丢弃，请务必按图片实际尺寸输出
- 误差锚定：优先识别元素边缘（文字的左/右边缘、按钮外框边缘、图标外接矩形边缘），不要把坐标锚在元素中心点，以降低偏移
- 坐标定位前的网格粗定位：先把图片均匀划分为 10×10 网格（想象叠加 10 行 10 列透明网格线），确定问题元素落在第几行第几列，再换算成像素：x ≈ (列-0.5)/10 × 图片宽，y ≈ (行-0.5)/10 × 图片高，最后在网格内按元素真实边缘细化到像素。y 坐标务必按图片完整高度计算——图片可能是长页或区段图，不要把所有元素都定位到图片上部；x 坐标同理按元素实际水平位置计算，元素在左侧就输出小值、居中就在图片宽的一半附近，不要都挤在页面中部
- description：一句话中文问题描述，站在设计师视角说清「哪里、和设计稿相比怎么了」
- severity：major=明显影响视觉/可用，必须改；minor=一般差异，应该改；suggestion=可优化的细节
- category：typography=文字类与排版 / spacing=对齐布局与间距 / color=色彩 / style=图标图片与组件状态样式 / interaction=交互状态缺失（如 hover/禁用/报错态）/ compatibility=适配异常。按问题最贴切的一项选择
- level：问题分级，每条必填。"required"=设计稿与开发图肉眼可见不一致的正式缺陷；"optional"=两张图视觉一致的对比度/WCAG 类提示或疑似误判的组件缺失，仅供评审参考，不作为缺陷
- levelReason：level="optional" 时必填，一句话说明判定理由（如「设计稿与开发图视觉一致，仅无障碍规范不达标，属于设计选型，仅供评审参考」）；level="required" 时不输出该字段
- suggestion：current=开发现状描述，fix=建议改法，properties=涉及的 CSS 属性（可选，如 color、line-height、text-overflow）
- 控制在 15 个问题以内，按影响从大到小排序；对比后确实无问题时输出 {"issues":[]}`

/** 自动走查检查项注入（来自面板「自定义检查项」配置） */
interface WalkOptionsInput {
  dimensionLabels?: string[]
  depth?: 'loose' | 'standard' | 'strict'
  analysisLabels?: string[]
  style?: 'concise' | 'detailed'
  /** 项目绑定规范的 Token 摘要（按类分组、截断），触发「规范合规」语义检查 */
  specSummary?: string
}

function walkOptionsPrompt(wo: WalkOptionsInput | undefined): string {
  if (!wo) return ''
  const parts: string[] = []
  if (wo.dimensionLabels?.length) {
    parts.push(`本次重点检查以下维度：${wo.dimensionLabels.join('、')}。`)
  }
  if (wo.depth === 'strict') {
    parts.push('检查深度为严格模式：轻微的字号差异、细微色差、轻微不对齐也要指出。')
  } else if (wo.depth === 'loose') {
    parts.push('检查深度为宽松模式：仅报告一眼就能看出、影响较大的问题，忽略细微差异。')
  } else {
    parts.push('检查深度为标准模式：报告中等及以上影响的视觉问题。')
  }
  if (wo.style === 'concise') {
    parts.push('输出风格为简洁模式：description 用一句话说清问题，不展开分析。')
  } else {
    parts.push('输出风格为详细模式：description 中说明问题定位（哪个元素/区域）、产生原因与影响。')
  }
  if (wo.analysisLabels?.length) {
    parts.push(
      `suggestion 字段需覆盖以下分析项：${wo.analysisLabels.join('、')}（current 填写现状与风险，fix 填写修改建议与优化优先级）。`
    )
  }
  const base = parts.length ? `\n自定义检查项要求：\n${parts.map((p) => `- ${p}`).join('\n')}` : ''
  // 规范 Token 摘要为多行文本，不进 `- ` 列表，单独成块拼接
  if (!wo.specSummary) return base
  return `${base}
设计规范 Token（本项目绑定的设计规范，节选）：
${wo.specSummary}
规范合规检查要求：
- 除常规差异比对外，额外检查截图元素是否符合上述 Token（颜色搭配、间距节奏、字号层级、圆角/阴影/描边一致性等语义性合规）
- 命中规范问题时按属性选 category（color/spacing/typography/style），description 中注明应使用的规范 Token 名与值
- 规范问题与设计稿差异问题为同一处时只输出一条，避免重复标注`
}

/**
 * 通用规范检查清单（仅在「未选择任何自定义技能」时注入）。
 * 目的：把笼统的「看一眼找差异」变成固定 8 项清单逐条遍历，提升通用 UI 问题召回；
 * 同时用容差阈值 + 分级（required/optional）压住误报。
 * 有选中技能时本块不注入（技能优先，维持原有行为）。
 */
function generalChecklistPrompt(tol: ToleranceConfig): string {
  return `
【通用规范检查清单（本轮未选择自定义技能，必须完整执行本清单）】
本清单取代上文「检查清单（逐项对比两张图）」，其余规则（坐标换算、字段格式、输出约束）继续生效。
请按下列 8 项固定清单逐条遍历核验，每一项都必须明确判断「本页是否存在该方面的问题」，不得跳过、不得泛泛扫一眼：
① 文字：字号、字重、行高、字体、文字截断/溢出、可读性、文案一致性
② 颜色：文本对比度（WCAG）、主色/语义色误用（如危险操作用主色）、硬编码色与设计稿不一致、状态色（成功/警告/错误）是否统一
③ 间距栅格：内边距、外边距、元素之间间距、对齐方式（左对齐/居中/右对齐是否统一）
④ 圆角、阴影、边框：圆角规格是否统一、阴影层级是否合理、边框粗细/颜色是否一致
⑤ 组件：按钮、输入框、标签、弹窗、表格、下拉等组件的样式与状态（默认/hover/禁用）是否统一
⑥ 布局层级：信息层级是否清晰、主次是否分明、是否有元素重叠遮挡、内容溢出容器
⑦ 适配：元素溢出/被裁切、点击热区是否过小（明显小于常规 32×32 触控区）
⑧ 细节：图标大小与风格、图标与文字间距、分割线规范

逐项核验方法（必须逐项执行，禁止合并成一次整体扫视）：
- 对每一项：先在设计稿中定位该方面涉及的元素区域，再到开发截图同一位置找到对应元素，逐条对照判断
- 每一项都要有结论：存在问题 → 输出标注；确实无问题 → 不输出，但内部必须完成该项核验，不得因「看起来差不多」跳过整项

容差放行（重要，避免无效误报）：
- 差异小于容差的视为渲染/取整误差，一律不报告：间距/内边距/gap ≤ ${tol.spacing}px、字号/行高/字间距 ≤ ${tol.typography}px、圆角 ≤ ${tol.radius}px、描边 ≤ ${tol.border}px、尺寸/位置 ≤ ${tol.size}px、颜色 ΔE ≤ ${tol.color}
- 肉眼不可辨、需要放大像素才能确认的差异不报告
- 两张图数据内容差异（列表条数、图片内容、用户名/时间等动态文案）不报告
- 设计稿本身就是该样式（刻意的设计选型）不报告

分级（通用规范问题必须区分严重问题与建议优化）：
- level="required"：严重问题——肉眼明显可见、影响可读性/可用性/一致性（文字截断、对比度过低、间距明显错乱、状态色误用、元素重叠遮挡等），必须标注
- level="optional"：建议优化——低优先级样式差异、处在容差边缘的细节不统一（圆角/图标大小/边框粗细轻微不一致等），作为可选参考标注，不强制生成问题

命中标注要求（区分通用规范问题与自定义技能问题）：
- 通用规范问题必须在 description 末尾追加命中项标注，格式【通用规范-①文字】…【通用规范-⑧细节】，编号与标题必须取自上方清单（如【通用规范-③间距栅格】）
- 命中多个项时并列多个标注（如【通用规范-①文字】【通用规范-⑤组件】）
- 本轮未选择自定义技能，禁止输出【命中技能：…】标注`
}

/** 单技能条目长度上限：优先保留技能名称与核心规则，长说明/参考链接依次后置丢弃 */
const SKILL_ITEM_MAX = 200
/** 技能块总长上限（含标题与命中标注指令），预算不足时从后往前整条丢弃技能 */
const SKILL_BLOCK_MAX = 2000
/** 技能块标题（system prompt 末块开头） */
const SKILL_HEADER = '【自定义走查技能检查要点】除基础检查清单外，逐条核对以下技能要点：'
/** 技能块命中标注指令：模块3 按正则【命中技能：技能名称】解析统计，标注格式不可改 */
const SKILL_FOOTER =
  '命中标注要求：某条问题描述命中上述某项技能要点时，必须在该条 description 末尾追加【命中技能：技能名称】，名称与对应条目「」中的技能名完全一致（示例：【命中技能：深色模式检查】）；未命中技能的问题不加该标注；命中多个技能时并列多个标注；技能要点与基础检查清单冲突时，以技能要点为准。'

/**
 * 组装单条技能要点行：`N. 技能「名称」：核心规则`。
 * 超长时依次丢弃「技能指南」长说明段、「（参考：…）」括注，最后按预算硬截断，保证技能名完整。
 */
function buildSkillItemLine(index: number, raw: string): string | null {
  const t = raw.trim()
  if (!t) return null
  const fallback = `技能${index}`
  const name = (t.split(/[：:、\n]/)[0] || '').trim() || fallback
  const label = `${index}. 技能「${name}」`
  const bodyRaw = t.startsWith(name) ? t.slice(name.length) : t
  let body = bodyRaw.replace(/^[：:、\s]+/, '')
  if (`${label}：${body}`.length > SKILL_ITEM_MAX) {
    body = body.split('技能指南：')[0].trim()
    if (`${label}：${body}`.length > SKILL_ITEM_MAX) {
      body = body.replace(/（参考：[^）]*）/g, '').trim()
    }
    if (`${label}：${body}`.length > SKILL_ITEM_MAX) {
      body = body.slice(0, Math.max(SKILL_ITEM_MAX - label.length - 1, 0))
    }
  }
  return body ? `${label}：${body}` : label
}

/**
 * 组装「自定义走查技能」system prompt 末块。
 * 结构：标题 → 逐条技能要点（单条 ≤200 字符）→ 命中标注指令（description 末尾强制追加【命中技能：技能名称】）。
 * 整块 ≤2000 字符；无有效技能时返回空串（system prompt 与改造前完全一致）。
 */
function skillGuidesPrompt(guides: string[]): string {
  const lines: string[] = []
  let used = SKILL_HEADER.length + SKILL_FOOTER.length + 3
  for (const g of guides) {
    const line = buildSkillItemLine(lines.length + 1, g)
    if (!line) continue
    if (used + line.length + 1 > SKILL_BLOCK_MAX) break
    lines.push(line)
    used += line.length + 1
  }
  if (!lines.length) return ''
  return `\n${SKILL_HEADER}\n${lines.join('\n')}\n${SKILL_FOOTER}`
}

function registerAiHandlers(): void {
  // 测试模型连通性
  ipcMain.handle(
    'ai:test',
    async (_e, modelId: string): Promise<{ ok: boolean; latencyMs?: number; message: string }> => {
      const start = Date.now()
      try {
        const model = getModel(modelId)
        await callChat(model, [{ role: 'user', content: '回复"ok"两个字母即可' }], 2048, 20000)
        return { ok: true, latencyMs: Date.now() - start, message: '连接成功' }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // AI 识别走查问题：输入设计稿 + 开发截图（data URL），输出候选标注
  ipcMain.handle(
    'ai:annotate',
    async (
      _e,
      input: {
        modelId: string
        pageName: string
        platformLabel: string
        designDataUrl: string
        shotDataUrl: string
        /** SkillHub 技能指引（选中技能的说明），附加到识别要求中 */
        skillGuides?: string[]
        /** 自动走查自定义检查项（检查维度/深度/分析设置/输出风格） */
        walkOptions?: WalkOptionsInput
      }
    ): Promise<{ ok: boolean; issues?: AIAnnotation[]; message: string }> => {
      try {
        const model = getModel(input.modelId)
        if (!model.vision) {
          return { ok: false, message: '当前模型未开启「图像输入」，请到 AI 模型管理中更换或调整' }
        }
        if (!input.designDataUrl || !input.shotDataUrl) {
          return { ok: false, message: '缺少设计稿或开发截图，无法识别' }
        }
        // SkillHub 技能指引：注入位置从用户消息末尾挪到 system prompt 末块（模块2）。
        // 分块顺序：基础走查规则（SYSTEM_PROMPT）→ 自定义检查项（walkOptionsPrompt）
        //   → 通用规范清单（仅无技能时，generalChecklistPrompt）→ 技能要点（含命中标注指令）。
        // 通用清单与技能要点二选一注入：有技能只走技能，无技能才强制跑 8 项通用清单。
        const guides = (input.skillGuides ?? []).map((g) => g.trim()).filter(Boolean)
        // 通用规范清单：仅「未选择任何自定义技能」时注入（读全局容差配置，通用走查同样遵守容差）；
        // 有选中技能时只执行技能要点，不叠加通用清单（维持原有行为）
        const generalPrompt = guides.length
          ? ''
          : generalChecklistPrompt(
              normalizeTolerance(getConfigData()['walkTolerance'] as Partial<ToleranceConfig> | undefined)
            )
        const systemPrompt =
          SYSTEM_PROMPT + walkOptionsPrompt(input.walkOptions) + generalPrompt + skillGuidesPrompt(guides)
        // 图片预处理：宽度约束（≤1299，实测该宽度服务端不做压缩）
        const designPre = constrainImageWidth(input.designDataUrl, '设计稿')
        const shotPre = constrainImageWidth(input.shotDataUrl, '开发截图')
        // 纵向切段：每段高 ≤1024（服务端高度硬限制，>1024 会被非等比压高致 y 系统性偏移）。
        // 两图统一段数、按各自高度比例均分，同段号覆盖同一页面区域；
        // 单屏短图（高 ≤896px）自动退化为单段 = 单次请求，行为与切段前完全一致
        const nSeg = Math.max(planSegCount(designPre.H), planSegCount(shotPre.H))
        const designSegs = planEvenSegments(designPre.H, nSeg)
        const shotSegs = planEvenSegments(shotPre.H, nSeg)
        console.log(
          `[ai-coord] 尺寸链路：设计稿 原图 ${designPre.origW}x${designPre.origH} → 送图基准 ${designPre.W}x${designPre.H}；` +
            `开发截图 原图 ${shotPre.origW}x${shotPre.origH} → 送图基准 ${shotPre.W}x${shotPre.H}；` +
            `画板容器尺寸由渲染层按归一化百分比映射，不参与换算；切段 ${nSeg} 段：` +
            shotSegs.map((s) => `[${s.top}~${s.top + s.height}]`).join(' ')
        )
        const dimText = (img: PreparedImage, segH: number): string =>
          img.W > 0 ? `（图片尺寸：${img.W}×${segH} 像素）` : ''
        // 流式接收：避免思考型模型整体超时；进度跨段累计推送给渲染层显示
        const startedAt = Date.now()
        let lastEmit = 0
        let totalChars = 0
        let segBaseChars = 0
        const chatOpts = {
          stream: true as const,
          idleMs: 60000,
          onProgress: (chars: number): void => {
            const now = Date.now()
            if (now - lastEmit < 500) return // 节流 500ms
            lastEmit = now
            _e.sender.send('ai:annotate:progress', {
              pageName: input.pageName,
              elapsedMs: now - startedAt,
              chars: segBaseChars + chars
            })
          }
        }
        const allIssues: AIAnnotation[] = []
        let okSegs = 0
        let lastErr: unknown
        // 模型 max_token 上限 200K，识别请求放宽到 16384，
        // 避免思考型模型把 token 耗在 reasoning 上导致 JSON 被截断
        for (let i = 0; i < nSeg; i++) {
          const dSeg = designSegs[i]
          const sSeg = shotSegs[i]
          const designSegImg = cropSegment(designPre, dSeg)
          const shotSegImg = cropSegment(shotPre, sSeg)
          console.log(
            `[ai-coord] 段 ${i + 1}/${nSeg} 送图：设计稿 ${designSegImg.W}x${designSegImg.H}（整页高 ${designPre.H}，段顶 ${dSeg.top}）｜` +
              `截图 ${shotSegImg.W}x${shotSegImg.H}（整页高 ${shotPre.H}，段顶 ${sSeg.top}）`
          )
          // 段级 prompt（v10 台架验证文案）：告知模型这是长页的第 i/N 段，
          // 坐标相对「本段图片」计算（段高 ≤1024 不被压，段内定位精确）
          const segNote =
            nSeg > 1
              ? `这是整页长图的第 ${i + 1}/${nSeg} 段：开发截图整页高 ${shotPre.H} 像素，本段为其中纵向 ${sSeg.top}~${sSeg.top + sSeg.height} 像素区域；设计稿整页高 ${designPre.H} 像素，已按相同比例切出对应区段（两图为同一页面的同一纵向区段）。`
              : ''
          const coordText =
            nSeg > 1
              ? 'x1,y1,x2,y2 输出相对本段图片左上角的像素坐标（像素整数，不要归一化、不要 0~1000 虚拟坐标系），取值必须落在本段图片宽高范围内'
              : 'x1,y1,x2,y2 输出相对本张图片左上角的像素坐标（像素整数，不要归一化、不要 0~1000 虚拟坐标系），取值必须落在图片宽高范围内'
          const userText = `页面名称：${input.pageName || '未命名页面'}\n端类型：${input.platformLabel || '未知'}\n${segNote}第一张图 = 设计稿${nSeg > 1 ? '对应区段' : ''}${dimText(designPre, dSeg.height)}，第二张图 = 开发实现截图${nSeg > 1 ? '对应区段' : ''}${dimText(shotPre, sSeg.height)}。${coordText}。请按系统要求输出 JSON。`
          // 每张图前插入文字标签（含像素尺寸），避免模型混淆两张图导致坐标画错位置
          const content = [
            { type: 'text', text: userText },
            { type: 'text', text: `【第 1 张图：UI 设计稿${nSeg > 1 ? '区段' : ''}${dimText(designPre, dSeg.height)}】所有 design 标注的坐标以这张图左上角为像素原点` },
            { type: 'image_url', image_url: { url: designSegImg.dataUrl } },
            { type: 'text', text: `【第 2 张图：开发实现截图${nSeg > 1 ? '区段' : ''}${dimText(shotPre, sSeg.height)}】所有 screenshot 标注的坐标以这张图左上角为像素原点` },
            { type: 'image_url', image_url: { url: shotSegImg.dataUrl } }
          ]
          const messages = [{ role: 'system', content: systemPrompt }, { role: 'user', content }]
          try {
            segBaseChars = totalChars
            const first = await callChat(model, messages, 16384, 600000, undefined, chatOpts)
            totalChars += first.text.length
            let raw: unknown
            try {
              raw = extractJson(first.text).issues
            } catch (parseErr) {
              // 思考型模型可能把 max_tokens 全部耗在 reasoning 上导致响应截断（finish_reason=length），
              // 此时自动携带「关闭思考」参数重试一次（vLLM 标准参数，其他服务仅在截断时才会触发）
              if (first.finishReason !== 'length') throw parseErr
              const retry = await callChat(
                model,
                messages,
                16384,
                600000,
                { chat_template_kwargs: { enable_thinking: false } },
                chatOpts
              )
              totalChars += retry.text.length
              raw = extractJson(retry.text).issues
            }
            // 段内归一化坐标 → 整页归一化坐标：y 按段偏移与段高换算（v10 台架验证公式），
            // x 不变（段宽 = 整页宽，等比缩放下归一化值不变）
            const segIssues = normalizeIssues(raw, {
              design: segmentImageInfo(designSegImg),
              shot: segmentImageInfo(shotSegImg)
            })
            for (const it of segIssues) {
              const seg = it.targetImage === 'design' ? dSeg : sSeg
              const H = it.targetImage === 'design' ? designPre.H : shotPre.H
              const yLocal = it.y * seg.height
              const y1 = seg.top + yLocal
              const y2 = seg.top + (it.y + it.height) * seg.height
              console.log(
                `[ai-coord] 段合并 ${i + 1}/${nSeg} ${it.targetImage} 段内y=${yLocal.toFixed(0)}px+段顶${seg.top}=整页${y1.toFixed(0)}px/整页高${H} → 归一化y=${(y1 / H).toFixed(4)}`
              )
              it.y = y1 / H
              it.height = Math.max(0, (y2 - y1) / H)
              allIssues.push(it)
            }
            okSegs++
          } catch (segErr) {
            // 段级失败宽容：单段失败告警跳过继续，全部失败才整体报错
            lastErr = segErr
            console.warn(
              `[ai-coord] 段 ${i + 1}/${nSeg} 识别失败：${segErr instanceof Error ? segErr.message : String(segErr)}`
            )
          }
        }
        if (okSegs === 0) {
          throw lastErr instanceof Error ? lastErr : new Error(String(lastErr ?? '所有分段识别均失败'))
        }
        // 重叠区去重：相邻段重叠带内同一元素可能被两段各自检出，
        // y 中心接近（±1.5×overlap 换算归一化）且 x 区间交叠视为同一条，保留先检出者
        const issues: AIAnnotation[] = []
        for (const it of allIssues) {
          const H = it.targetImage === 'design' ? designPre.H : shotPre.H
          const tol = (AI_SEGMENT_OVERLAP * 1.5) / Math.max(1, H)
          const yc = it.y + it.height / 2
          const dup = issues.find(
            (k) =>
              k.targetImage === it.targetImage &&
              Math.abs(k.y + k.height / 2 - yc) < tol &&
              Math.min(k.x + k.width, it.x + it.width) > Math.max(k.x, it.x)
          )
          if (dup) {
            console.log(
              `[ai-coord] 重叠区去重：丢弃「${it.description.slice(0, 24)}」（与「${dup.description.slice(0, 24)}」疑似同一元素）`
            )
            continue
          }
          issues.push(it)
        }
        const segStat = nSeg > 1 && okSegs < nSeg ? `（${okSegs}/${nSeg} 段成功）` : ''
        return { ok: true, issues, message: `识别完成，共 ${issues.length} 条候选${segStat}` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export { registerAiHandlers }
