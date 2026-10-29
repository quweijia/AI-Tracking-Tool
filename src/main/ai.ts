import { ipcMain } from 'electron'
import { getConfigData } from './ipc'
import { proxyFetch } from './figma'

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
}

const SEVERITIES = ['major', 'minor', 'suggestion']
const CATEGORIES = ['spacing', 'typography', 'color', 'style', 'interaction', 'compatibility']
const SHAPES = ['rect', 'point', 'text', 'measure', 'picker']

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
    // 点位/文字/吸色只保留坐标点，宽高置 0；测量保留宽高矢量
    const zeroDims = shape === 'point' || shape === 'text' || shape === 'picker'
    const sug = (o.suggestion ?? {}) as Record<string, unknown>
    out.push({
      targetImage: o.targetImage === 'design' ? 'design' : 'screenshot',
      shape,
      x: clamp01(o.x),
      y: clamp01(o.y),
      width: zeroDims ? 0 : clamp01(o.width),
      height: zeroDims ? 0 : clamp01(o.height),
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

// 视觉语义走查：站在设计师肉眼验收视角，基于两张截图对比找问题。
// 不做像素级测量，只抓「视觉上真实存在、需要改」的问题，压低误报
const SYSTEM_PROMPT = `你是资深 UI 设计师，正在对开发实现页面做上线前的肉眼验收走查。用户会提供两张图：第一张是 Figma 设计稿（验收基准），第二张是开发实现的页面截图。请像设计师验收一样，用眼睛对比两张图，找出「开发实现和设计稿看起来不一样、且真实需要修改」的视觉问题，输出 JSON。

只报告肉眼可辨认、确实需要开发修改的问题。以下情况必须跳过、不要报告：
- 两张图内容数据不同导致的差异（列表条数不同、图片内容不同、用户名/时间等动态文案不同）
- 字体渲染抗锯齿、亚像素级模糊等截图天然差异
- 你不确定是否真的是问题的地方（宁可漏报，不可误报）
- 设计稿中未展示、但属于合理响应式布局差异的部分

检查清单（逐项对比两张图）：
1. 文字类：文字被截断、溢出容器、换行位置异常、字体不对、字号视觉上明显不一致、文案与设计稿不一样
2. 对齐布局：元素之间不对齐、上下错位、元素意外重叠、间距视觉上明显过大或过小
3. 图标图片：图标缺失、图标或图片变形拉伸、颜色不对、图片加载失败、出现异常占位图
4. 组件状态：按钮/输入框的禁用、报错等状态样式缺失或异常，弹窗/浮层样式异常
5. 色彩：颜色明显偏差（色相/深浅一眼能看出不一样）、文字与背景对比度过低看不清
6. 排版：多行文本行高拥挤或过松、标题层级视觉错乱（该大的不大、该粗的不粗）

严格只输出一个 JSON 对象，不要任何解释文字，格式：
{"issues":[{"targetImage":"screenshot","shape":"rect","x":0.1,"y":0.2,"width":0.3,"height":0.05,"description":"主按钮文案被截断，末尾缺少省略号","severity":"major","category":"typography","suggestion":{"current":"按钮文字显示不全","fix":"检查按钮宽度或文字截断规则","properties":"text-overflow"}}]}
字段要求：
- targetImage：标注画在哪张图上。"screenshot"=开发截图（多数问题标在这里），"design"=设计稿（元素缺失、新增元素等，在设计稿上框选）。两张图尺寸可能不同，坐标相对各自图片独立计算
- shape 按问题类型选择：
  * "rect"：框选问题元素（文字问题、图标图片、缺失/多余元素、组件状态、排版问题都用 rect）
  * "measure"：间距明显过大/过小时标注间距区间。x,y=起点，width,height=到终点的矢量（垂直间距 width=0，水平间距 height=0）
  * "picker"：颜色明显偏差。x,y=取色点，width/height=0
  * "point"：对齐错位等无明显边界的问题。x,y=问题位置中心点，width/height=0
- x,y,width,height：归一化坐标（0~1），相对所在图片左上角。先定位问题元素的边界，再除以图片宽高换算；框必须紧贴问题元素
- description：一句话中文问题描述，站在设计师视角说清「哪里、和设计稿相比怎么了」
- severity：major=明显影响视觉/可用，必须改；minor=一般差异，应该改；suggestion=可优化的细节
- category：typography=文字类与排版 / spacing=对齐布局与间距 / color=色彩 / style=图标图片与组件状态样式 / interaction=交互状态缺失（如 hover/禁用/报错态）/ compatibility=适配异常。按问题最贴切的一项选择
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
        // SkillHub 技能指引：作为额外检查要点注入
        const guides = (input.skillGuides ?? []).map((g) => g.trim()).filter(Boolean)
        const guideText = guides.length
          ? `\n请同时结合以下自定义走查技能/检查要点进行识别（逐条核对这些要点，并在描述中注明命中的要点）：\n${guides.map((g, i) => `${i + 1}. ${g}`).join('\n')}`
          : ''
        const systemPrompt = SYSTEM_PROMPT + walkOptionsPrompt(input.walkOptions)
        const userText = `页面名称：${input.pageName || '未命名页面'}\n端类型：${input.platformLabel || '未知'}\n第一张图 = 设计稿，第二张图 = 开发实现截图。请按系统要求输出 JSON。${guideText}`
        // 使用原始图片：AI 返回归一化坐标基于其接收到的图片，若图片被压缩/缩放，
        // 坐标会与实际渲染的原始图片产生系统性偏移，导致标注错位。
        // 每张图前插入文字标签，避免模型混淆两张图导致坐标画错位置
        const content = [
          { type: 'text', text: userText },
          { type: 'text', text: '【第 1 张图：UI 设计稿】所有 design 标注的坐标相对这张图计算' },
          { type: 'image_url', image_url: { url: input.designDataUrl } },
          { type: 'text', text: '【第 2 张图：开发实现截图】所有 screenshot 标注的坐标相对这张图计算' },
          { type: 'image_url', image_url: { url: input.shotDataUrl } }
        ]
        // 流式接收：避免思考型模型整体超时；进度实时推送给渲染层显示
        const startedAt = Date.now()
        let lastEmit = 0
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
              chars
            })
          }
        }
        // 模型 max_token 上限 200K，识别请求放宽到 16384，
        // 避免思考型模型把 token 耗在 reasoning 上导致 JSON 被截断
        const first = await callChat(
          model,
          [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
          16384,
          600000,
          undefined,
          chatOpts
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
            [{ role: 'system', content: systemPrompt }, { role: 'user', content }],
            16384,
            600000,
            { chat_template_kwargs: { enable_thinking: false } },
            chatOpts
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
