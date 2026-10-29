import { ipcMain } from 'electron'
import { getConfigData } from './ipc'
import { proxyFetch } from './figma'
import type { AIModelConfig } from './ai'

/**
 * AI 小助手独立流式通道：与 ai.ts 走查识别完全隔离（不改走查链路）。
 * delta 通过 ai:assistant:chunk 事件逐段转发（渲染层打字机输出），支持 reqId 中断。
 * 仅做请求转发与错误映射，模型配置复用「AI 模型管理」（OpenAI 兼容协议，智谱 GLM 兼容）。
 */

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

/** 解析 SSE data 行，返回本段增量 content 与 finish_reason */
function sseDelta(payload: string): { delta: string; finishReason: string } {
  if (payload === '[DONE]') return { delta: '', finishReason: '' }
  try {
    const j = JSON.parse(payload) as { choices?: { delta?: { content?: unknown }; finish_reason?: unknown }[] }
    const c = j.choices?.[0]
    return {
      delta: typeof c?.delta?.content === 'string' ? c.delta.content : '',
      finishReason: c?.finish_reason ? String(c.finish_reason) : ''
    }
  } catch {
    // 忽略不完整或非 JSON 行
    return { delta: '', finishReason: '' }
  }
}

/** 进行中的助手请求（reqId → 控制器），ai:assistant:abort 中断用 */
const pending = new Map<string, AbortController>()

interface AssistantChatInput {
  reqId: string
  modelId: string
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[]
}

function registerAssistantHandlers(): void {
  // 流式对话：delta 经 chunk 事件转发，invoke 在流结束后返回最终状态
  ipcMain.handle(
    'ai:assistant:chat',
    async (e, input: AssistantChatInput): Promise<{ ok: boolean; aborted?: boolean; message: string }> => {
      const { reqId } = input
      const send = (chunk: { delta: string; done?: boolean; error?: string }): void =>
        e.sender.send('ai:assistant:chunk', { reqId, ...chunk })
      let ctrl: AbortController | undefined
      let timer: NodeJS.Timeout | undefined
      let watchdog: NodeJS.Timeout | undefined
      try {
        const model = getModel(input.modelId)
        const messages = Array.isArray(input.messages) ? input.messages : []
        if (!messages.length) throw new Error('对话内容为空')
        ctrl = new AbortController()
        pending.set(reqId, ctrl)
        // 整体硬超时上限（流式空闲另有 watchdog 判定，参照 ai.ts 识别链路的 600s）
        timer = setTimeout(() => ctrl?.abort(), 600000)
        const init = {
          method: 'POST' as const,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${model.apiKey}`
          },
          body: JSON.stringify({
            model: model.model,
            messages,
            max_tokens: 8192,
            temperature: 0.4,
            stream: true
          }),
          signal: ctrl.signal
        }
        let res: Response
        try {
          // 先直连，网络层失败再走代理链重试（与走查识别一致）
          res = await fetch(chatUrl(model.baseUrl), init)
        } catch (err) {
          if (ctrl.signal.aborted) throw new Error('请求超时，请检查模型服务是否可达')
          try {
            res = await proxyFetch(chatUrl(model.baseUrl), init)
          } catch {
            throw new Error(
              `网络请求失败（${err instanceof Error ? err.message : String(err)}）：模型服务不可达。请确认 Base URL 正确；若模型服务在外网，可在「设置 → MCP 管理」配置代理地址后重试`
            )
          }
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (res.status === 401 || res.status === 403) {
            throw new Error(`API Key 无效或无权限（${res.status}）：请到「设置 → AI 模型管理」检查 Key`)
          }
          if (res.status === 404) {
            throw new Error(
              `接口返回 404：${chatUrl(model.baseUrl)} 不存在。请检查 Base URL 是否需要以 /v4 结尾（如智谱 https://open.bigmodel.cn/api/paas/v4）`
            )
          }
          if (res.status === 429) {
            throw new Error('请求频率超限（429）：请稍后重试，或检查模型服务额度')
          }
          throw new Error(`接口返回 ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`)
        }
        if (!res.body || typeof res.body.getReader !== 'function') {
          throw new Error('当前环境不支持流式读取')
        }
        // SSE 增量解析：空闲超时判定服务卡死（参照 ai.ts 识别链路）
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        const idleMs = 60000
        let lastData = Date.now()
        let idleAborted = false
        watchdog = setInterval(() => {
          if (Date.now() - lastData > idleMs) {
            idleAborted = true
            void reader.cancel().catch(() => {})
          }
        }, 3000)
        let buf = ''
        let content = ''
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          lastData = Date.now()
          buf += decoder.decode(value, { stream: true })
          const lines = buf.split('\n')
          buf = lines.pop() ?? ''
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith('data:')) continue
            const { delta } = sseDelta(t.slice(5).trim())
            if (delta) {
              content += delta
              send({ delta })
            }
          }
        }
        if (idleAborted) {
          throw new Error(`请求超时（${Math.round(idleMs / 1000)}s 无新数据）：模型服务响应中断，请重试`)
        }
        // 用户主动中断：静默收尾（渲染层丢弃半截回复），不作为错误提示
        if (ctrl.signal.aborted) return { ok: false, aborted: true, message: '已中断' }
        if (!content.trim()) throw new Error('模型返回内容为空')
        send({ delta: '', done: true })
        return { ok: true, message: '完成' }
      } catch (err) {
        if (ctrl?.signal.aborted) {
          send({ delta: '', done: true })
          return { ok: false, aborted: true, message: '已中断' }
        }
        const message = err instanceof Error ? err.message : String(err)
        send({ delta: '', done: true, error: message })
        return { ok: false, message }
      } finally {
        if (timer) clearTimeout(timer)
        if (watchdog) clearInterval(watchdog)
        pending.delete(reqId)
      }
    }
  )

  // 中断生成（reqId 匹配进行中的请求）
  ipcMain.handle('ai:assistant:abort', (_e, reqId: string): boolean => {
    const ctrl = pending.get(reqId)
    if (!ctrl) return false
    ctrl.abort()
    return true
  })
}

export { registerAssistantHandlers }
