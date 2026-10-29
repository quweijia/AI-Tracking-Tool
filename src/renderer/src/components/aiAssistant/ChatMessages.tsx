import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useAiAssistantStore } from '../../stores/aiAssistant'
import { mentionChipLabel } from '../../assistant/context'
import { EXTRA_SUGGESTS, QUICK_PROMPTS } from '../../assistant/prompt'
import type { AssistantRef } from '../../db'
import assistantImg from '../../assets/ai-assistant.png'

/**
 * 对话消息区：历史气泡（用户/AI）、流式打字机气泡、错误气泡（可重试）、
 * 空状态（问候语 + 推荐问题卡片，换一批随机抽取）、历史加载态。
 */
interface ChatMessagesProps {
  /** 推荐问题/快捷问题点击直接发送 */
  onSuggest: (prompt: string) => void
  /** 错误气泡重试（重发最后一条用户消息） */
  onRetry: () => void
}

/** 推荐卡片随机抽 5 条（快捷 5 条 + 扩展 5 条） */
function pickSuggests(): string[] {
  const pool = [...QUICK_PROMPTS.map((q) => q.prompt), ...EXTRA_SUGGESTS]
  const out: string[] = []
  while (out.length < 5 && pool.length) {
    out.push(pool.splice(Math.floor(Math.random() * pool.length), 1)[0])
  }
  return out
}

/** 助手头像（与悬浮球同一机器人形象） */
function AssistantAvatar() {
  return (
    <span className="ai-msg-avatar" aria-hidden>
      <img src={assistantImg} alt="" draggable={false} />
    </span>
  )
}

export default function ChatMessages({ onSuggest, onRetry }: ChatMessagesProps) {
  const { t } = useTranslation('aiAssistant')
  const messages = useAiAssistantStore((s) => s.messages)
  const loading = useAiAssistantStore((s) => s.loading)
  const streaming = useAiAssistantStore((s) => s.streaming)
  const streamText = useAiAssistantStore((s) => s.streamText)
  const error = useAiAssistantStore((s) => s.error)
  const projectId = useAiAssistantStore((s) => s.projectId)
  const pageId = useAiAssistantStore((s) => s.pageId)
  const bodyRef = useRef<HTMLDivElement>(null)
  const [copiedId, setCopiedId] = useState('')
  const [suggests, setSuggests] = useState<string[]>(() => pickSuggests())

  // 新消息 / 流式输出时滚动到底部
  useEffect(() => {
    const el = bodyRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages.length, streamText, error, loading])

  const copyMsg = async (id: string, content: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content)
      setCopiedId(id)
      setTimeout(() => setCopiedId(''), 1500)
    } catch {
      // 剪贴板不可用时静默（按钮态不变化）
    }
  }

  return (
    <div className="ai-chat-body" ref={bodyRef}>
      {loading ? (
        <div className="ai-chat-loading">{t('loadingHistory')}</div>
      ) : messages.length === 0 && !streaming && !error ? (
        <div className="ai-chat-empty">
          <div className="ai-chat-greeting">
            <div className="ai-chat-greeting-text">
              <h4>{t('greeting')}</h4>
              <p>{t('greetingDesc')}</p>
              {!projectId && !pageId && <p className="ai-chat-context-tip">{t('contextNoneTip')}</p>}
            </div>
            <img className="ai-chat-greeting-img" src={assistantImg} alt="" draggable={false} />
          </div>
          <div className="ai-suggest-head">
            <span>{t('suggestTitle')}</span>
            <button type="button" className="ai-suggest-refresh" onClick={() => setSuggests(pickSuggests())}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
              </svg>
              {t('refreshSuggests')}
            </button>
          </div>
          <div className="ai-suggest-grid">
            {suggests.map((s) => (
              <button key={s} type="button" className="ai-suggest-card" onClick={() => onSuggest(s)}>
                {s}
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          {messages.map((m) =>
            m.role === 'user' ? (
              <div key={m.id} className="ai-msg ai-msg-user">
                <div className="ai-bubble ai-bubble-user">
                  {m.refs && m.refs.length > 0 && (
                    <div className="ai-bubble-refs">
                      {m.refs.map((r: AssistantRef) => (
                        <span key={`${r.type}-${r.id}`} className="ai-ref-chip">
                          @{mentionChipLabel(r)}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="ai-bubble-text">{m.content}</div>
                </div>
              </div>
            ) : (
              <div key={m.id} className="ai-msg ai-msg-assistant">
                <AssistantAvatar />
                <div className="ai-bubble ai-bubble-assistant">
                  <div className="ai-bubble-text">{m.content}</div>
                  <button
                    type="button"
                    className="ai-bubble-copy"
                    title={t('copy')}
                    onClick={() => void copyMsg(m.id, m.content)}
                  >
                    {copiedId === m.id ? (
                      t('copied')
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <rect x="9" y="9" width="12" height="12" rx="2" />
                        <path d="M5 15V5a2 2 0 0 1 2-2h10" />
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            )
          )}
          {streaming && (
            <div className="ai-msg ai-msg-assistant">
              <AssistantAvatar />
              <div className="ai-bubble ai-bubble-assistant ai-bubble-streaming">
                <div className="ai-bubble-text">
                  {streamText}
                  <span className="ai-cursor" aria-hidden />
                </div>
              </div>
            </div>
          )}
          {error && (
            <div className="ai-msg ai-msg-assistant">
              <AssistantAvatar />
              <div className="ai-bubble ai-bubble-error">
                <div className="ai-bubble-text">{error}</div>
                <button type="button" className="ai-error-retry" onClick={onRetry}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6" />
                  </svg>
                  {t('retry')}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}
