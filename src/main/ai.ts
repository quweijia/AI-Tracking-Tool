import { ipcMain } from 'electron'
import { getConfigData } from './ipc'

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
  shape: 'rect' | 'point' | 'text'
  x: number
  y: number
  width: number
  height: number
  description: string
  severity: 'major' | 'minor' | 'suggestion'
  category: 'spacing' | 'typography' | 'color' | 'style' | 'interaction' | 'compatibility'
  suggestion?: { current: string; fix: string; properties?: string }
}

const SEVERITIES = ['major', 'minor', 'suggestion']
const CATEGORIES = ['spacing', 'typography', 'color', 'style', 'interaction', 'compatibility']
const SHAPES = ['rect', 'point', 'text']

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

/** 调用 OpenAI 兼容 chat/completions；timeoutMs 防止内网不可达时永久挂起 */
interface ChatResult {
  text: string
  finishReason: string
}

async function callChat(
  model: AIModelConfig,
  messages: unknown,
  maxTokens: number,
  timeoutMs = 60000,
  extraBody?: Record<string, unknown>
): Promise<ChatResult> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(chatUrl(model.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${model.apiKey}`
      },
      body: JSON.stringify({
        model: model.model,
        messages,
        max_tokens: maxTokens,
        temperature: 0.2,
        ...extraBody
      }),
      signal: ctrl.signal
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      if (res.status === 404) {
        throw new Error(
          `接口返回 404：${chatUrl(model.baseUrl)} 不存在。请检查 Base URL 是否需要以 /v1 结尾（如 http://117.73.0.134:9875/v1）`
        )
      }
      throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`)
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

/** 校验并归一化模型输出的标注候选 */
function normalizeIssues(raw: unknown): AIAnnotation[] {
  if (!Array.isArray(raw)) return []
  const out: AIAnnotation[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const description = String(o.description ?? '').trim()
    if (!description) continue
    const shape = SHAPES.includes(String(o.shape)) ? (String(o.shape) as AIAnnotation['shape']) : 'rect'
    const pointLike = shape === 'point' || shape === 'text'
    const sug = (o.suggestion ?? {}) as Record<string, unknown>
    out.push({
      targetImage: o.targetImage === 'design' ? 'design' : 'screenshot',
      shape,
      x: clamp01(o.x),
      y: clamp01(o.y),
      width: pointLike ? 0 : clamp01(o.width),
      height: pointLike ? 0 : clamp01(o.height),
      description: description.slice(0, 200),
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
      }
    })
  }
  return out
}

const SYSTEM_PROMPT = `你是资深 UI 走查（Visual QA）专家。用户会提供同一页面的两张图：第一张是 UI 设计稿，第二张是开发实现截图。请找出开发实现与设计稿不一致的地方（间距/文字排版/颜色/样式/交互/兼容性等），并输出 JSON。
严格只输出一个 JSON 对象，不要任何解释文字，格式：
{"issues":[{"targetImage":"screenshot","shape":"rect","x":0.1,"y":0.2,"width":0.3,"height":0.1,"description":"主按钮间距与设计稿不符，左右 padding 偏大 8px","severity":"minor","category":"spacing","suggestion":{"current":"按钮左右 padding 为 20px","fix":"改为 12px","properties":"padding"}}]}
字段要求：
- targetImage：标注画在哪张图上。"screenshot"=开发截图（一般的不一致都标在这里），"design"=设计稿（元素缺失、新增元素等）
- shape：rect=框选区域 / point=点位标记 / text=文字标注；point 与 text 时 width、height 必须为 0
- x,y,width,height：归一化坐标（0~1），相对所在图片左上角，指向问题所在的确切区域
- description：一句话中文问题描述，说清楚差异
- severity：major=严重影响视觉/功能，minor=一般差异，suggestion=优化建议
- category：spacing=间距规范 / typography=文字排版（字号、字重、行高、对齐等）/ color=颜色规范 / style=样式规范（圆角、阴影、描边、缺失/多余元素等）/ interaction=交互体验 / compatibility=兼容性问题（平台差异、适配异常等）
- suggestion：结构化修复建议，current=开发现状，fix=建议改法，properties=涉及的 CSS 属性（如 padding、font-size、color）
- 控制在 15 个问题以内，优先输出影响大的；确实无差异时输出 {"issues":[]}`

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
        // SkillHub 技能指引：作为额外检查要点注入
        const guides = (input.skillGuides ?? []).map((g) => g.trim()).filter(Boolean)
        const guideText = guides.length
          ? `\n请同时结合以下自定义走查技能/检查要点进行识别（逐条核对这些要点，并在描述中注明命中的要点）：\n${guides.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
          : ''
        const userText = `页面名称：${input.pageName || '未命名页面'}\n端类型：${input.platformLabel || '未知'}\n第一张图 = 设计稿，第二张图 = 开发实现截图。请按系统要求输出 JSON。${guideText}`
        const content = [
          { type: 'text', text: userText },
          { type: 'image_url', image_url: { url: input.designDataUrl } },
          { type: 'image_url', image_url: { url: input.shotDataUrl } }
        ]
        // 模型 max_token 上限 200K，识别请求放宽到 16384，
        // 避免思考型模型把 token 耗在 reasoning 上导致 JSON 被截断
        const first = await callChat(
          model,
          [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
          16384,
          180000
        )
        let text = first.text
        let issues: AIAnnotation[]
        try {
          issues = normalizeIssues(extractJson(text).issues)
        } catch (parseErr) {
          // 思考型模型可能把 max_tokens 全部耗在 reasoning 上导致响应截断（finish_reason=length），
          // 此时自动携带「关闭思考」参数重试一次（vLLM 标准参数，其他服务仅在截断时才会触发）
          if (first.finishReason !== 'length') throw parseErr
          const retry = await callChat(
            model,
            [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content }],
            16384,
            180000,
            { chat_template_kwargs: { enable_thinking: false } }
          )
          text = retry.text
          issues = normalizeIssues(extractJson(text).issues)
        }
        return { ok: true, issues, message: `识别完成，共 ${issues.length} 条候选` }
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

export { registerAiHandlers }
