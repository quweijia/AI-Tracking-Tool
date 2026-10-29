import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { db, genId } from '../../db'
import type { AssistantRef } from '../../db'
import { useAiAssistantStore } from '../../stores/aiAssistant'
import { applyMentions, buildAssistantContext, buildChatMessages, formatMentionNotes, mentionChipLabel } from '../../assistant/context'
import { QUICK_PROMPTS } from '../../assistant/prompt'
import ChatMessages from './ChatMessages'
import MentionMenu from './MentionMenu'
import assistantImg from '../../assets/ai-assistant.png'

/**
 * AI 小助手：右下角悬浮球 + 对话面板（全局常驻，挂在 Layout）。
 * - 路由（项目/页面）变化自动 loadSession 隔离会话并刷新上下文
 * - 流式：chunk 事件按 reqId 拼接打字机输出，完成/失败后落库
 * - 悬浮球显隐由设置页控制（config: aiAssistantVisible，缺省显示）
 */
export default function AiAssistant() {
  const { t } = useTranslation('aiAssistant')
  const location = useLocation()
  const open = useAiAssistantStore((s) => s.open)
  const toggle = useAiAssistantStore((s) => s.toggle)
  const setOpen = useAiAssistantStore((s) => s.setOpen)
  const loadSession = useAiAssistantStore((s) => s.loadSession)
  const streaming = useAiAssistantStore((s) => s.streaming)
  const [fabVisible, setFabVisible] = useState(true)
  const [fabSize, setFabSize] = useState(44)
  const [text, setText] = useState('')
  const [refs, setRefs] = useState<AssistantRef[]>([])
  const [mention, setMention] = useState<{ open: boolean; query: string }>({ open: false, query: '' })
  const [confirmClear, setConfirmClear] = useState(false)
  const [quickOpen, setQuickOpen] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // 路由解析当前项目/页面（非项目/页面路由为空 → 项目级会话）
  const routeMatch = location.pathname.match(/^\/project\/([^/]+)(?:\/page\/([^/]+))?/)
  const projectId = routeMatch?.[1] ?? ''
  const pageId = routeMatch?.[2] ?? ''

  // 悬浮球显隐 / 图标大小（设置页控制，缺省显示 44px；设置保存后经事件即时刷新）
  useEffect(() => {
    const reloadFabConfig = () => {
      void window.electronAPI
        .getConfig()
        .then((cfg) => {
          setFabVisible((cfg.aiAssistantVisible as boolean | undefined) ?? true)
          const size = Number(cfg.aiAssistantFabSize)
          const clamped = Number.isFinite(size) && size >= 28 && size <= 72 ? size : 44
          setFabSize(clamped)
          // 同步 CSS 变量：back-top 等固定元素按悬浮球实际尺寸避让
          document.documentElement.style.setProperty('--ai-fab-size', `${clamped}px`)
        })
        .catch(() => setFabVisible(true))
    }
    reloadFabConfig()
    window.addEventListener('ai-assistant-config-change', reloadFabConfig)
    return () => window.removeEventListener('ai-assistant-config-change', reloadFabConfig)
  }, [])

  // 项目/页面切换（或面板打开）时加载对应会话历史
  useEffect(() => {
    if (open) void loadSession(projectId, pageId)
  }, [projectId, pageId, open, loadSession])

  // 设置页清空全部历史后，刷新打开中的当前会话
  useEffect(() => {
    const onHistoryClear = () => {
      if (open) void loadSession(projectId, pageId)
    }
    window.addEventListener('ai-assistant-history-clear', onHistoryClear)
    return () => window.removeEventListener('ai-assistant-history-clear', onHistoryClear)
  }, [projectId, pageId, open, loadSession])

  // 流式 chunk 订阅：delta 拼接、错误提示、完成后落库（组件卸载取消订阅）
  useEffect(() => {
    const off = window.electronAPI.onAssistantChunk((chunk) => {
      const st = useAiAssistantStore.getState()
      if (chunk.reqId !== st.streamingReqId) return
      if (chunk.error) {
        st.setError(chunk.error)
        st.resetStream()
        return
      }
      if (chunk.delta) st.appendStreamText(chunk.delta)
      if (chunk.done) {
        const full = useAiAssistantStore.getState().streamText
        if (full.trim()) void st.addMessage('assistant', full)
        st.resetStream()
      }
    })
    return off
  }, [])

  /** 发送提问：组装上下文 + 历史 → 主进程流式请求 */
  const send = async (raw: string, mentionRefs: AssistantRef[], opts?: { skipUserAdd?: boolean }) => {
    const content = raw.trim()
    const st = useAiAssistantStore.getState()
    if (!content || st.streaming) return
    // 模型配置：助手专用模型 → 全局默认 → 首个（与走查识别取默认模型一致）
    let modelId = ''
    try {
      const cfg = await window.electronAPI.getConfig()
      const models = ((cfg.aiModels as { id: string }[] | undefined) ?? []).filter((m) => m.id)
      if (models.length) {
        const defId = (cfg.aiAssistantModelId as string | undefined) ?? (cfg.aiDefaultModelId as string | undefined) ?? models[0].id
        modelId = models.find((m) => m.id === defId)?.id ?? models[0].id
      }
    } catch {
      // 配置读取失败按未配置处理
    }
    if (!modelId) {
      st.setError(t('modelMissing'))
      return
    }
    const history = useAiAssistantStore.getState().messages
    if (!opts?.skipUserAdd) {
      await useAiAssistantStore.getState().addMessage('user', content, mentionRefs.length ? mentionRefs : undefined)
    }
    const ctx = await buildAssistantContext(
      useAiAssistantStore.getState().projectId,
      useAiAssistantStore.getState().pageId,
      ''
    )
    await applyMentions(ctx, mentionRefs)
    const notes = await formatMentionNotes(mentionRefs)
    const messages = buildChatMessages(history, `${content}${notes}`, ctx)
    const reqId = genId()
    const st2 = useAiAssistantStore.getState()
    st2.setStreamingReqId(reqId)
    st2.setStreaming(true)
    st2.setError('')
    try {
      await window.electronAPI.aiAssistantChat({ reqId, modelId, messages })
    } catch (err) {
      const st3 = useAiAssistantStore.getState()
      if (st3.streaming) {
        st3.setError(err instanceof Error ? err.message : String(err))
        st3.resetStream()
      }
    }
  }

  /** 输入框变更：检测光标前 @ 引用触发态（@ 后无空格即视为输入中） */
  const onInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setText(v)
    const caret = e.target.selectionStart ?? v.length
    const m = v.slice(0, caret).match(/@([^@\s]*)$/)
    setMention(m ? { open: true, query: m[1] } : { open: false, query: '' })
  }

  // 输入框自动伸缩：随内容增高，最高约 6 行（超出内部滚动）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  /** 选中引用对象：移除输入框中的 @query，记录引用 chip */
  const pickMention = (ref: AssistantRef) => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? text.length
    const m = text.slice(0, caret).match(/@([^@\s]*)$/)
    if (m && m.index !== undefined) {
      setText(text.slice(0, m.index) + text.slice(caret))
    }
    setRefs((prev) => (prev.some((r) => r.type === ref.type && r.id === ref.id) ? prev : [...prev, ref]))
    setMention({ open: false, query: '' })
    el?.focus()
  }

  const submit = () => {
    if (!text.trim() || streaming) return
    const payload = text
    const payloadRefs = refs
    setText('')
    setRefs([])
    setMention({ open: false, query: '' })
    void send(payload, payloadRefs)
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  /** 快捷按钮：追加预设 prompt 到输入框（可再编辑后发送） */
  const appendQuick = (prompt: string) => {
    setText((prev) => (prev.trim() ? `${prev.trimEnd()} ${prompt}` : prompt))
    inputRef.current?.focus()
  }

  const stop = () => {
    const st = useAiAssistantStore.getState()
    if (st.streamingReqId) void window.electronAPI.aiAssistantAbort(st.streamingReqId)
  }

  const retry = () => {
    const st = useAiAssistantStore.getState()
    const lastUser = [...st.messages].reverse().find((m) => m.role === 'user')
    if (lastUser) void send(lastUser.content, lastUser.refs ?? [], { skipUserAdd: true })
  }

  const clear = async () => {
    setConfirmClear(false)
    await useAiAssistantStore.getState().clearSession()
  }

  return (
    <>
      {/* 悬浮球（面板打开时隐藏；设置页可整体关闭） */}
      {fabVisible && !open && (
        <button
          type="button"
          className="ai-assistant-fab"
          style={{ width: fabSize, height: fabSize }}
          title={t('fabLabel')}
          onClick={toggle}
        >
          <img src={assistantImg} alt="" draggable={false} />
        </button>
      )}

      {/* 对话面板（fixed 右侧，独立于页面内容） */}
      {open && (
        <div className="ai-assistant-panel">
          <div className="ai-assistant-header">
            <span className="ai-assistant-header-icon" aria-hidden>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 8V4H8" />
                <rect width="16" height="12" x="4" y="8" rx="2" />
                <path d="M2 14h2" />
                <path d="M20 14h2" />
                <path d="M15 13v2" />
                <path d="M9 13v2" />
              </svg>
            </span>
            <span className="ai-assistant-title">{t('title')}</span>
            <span className={`ai-session-pill${projectId || pageId ? '' : ' none'}`}>
              {projectId || pageId ? (
                <>
                  <span className="ai-session-dot" aria-hidden />
                  {pageId ? t('sessionPage') : t('sessionProject')}
                </>
              ) : (
                t('sessionNone')
              )}
            </span>
            <span className="ai-assistant-header-actions">
              <button type="button" title={t('clear')} onClick={() => setConfirmClear(true)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                </svg>
              </button>
              <button type="button" title={t('winClose', { ns: 'layout' })} onClick={() => setOpen(false)}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>

          <ChatMessages onSuggest={(p) => void send(p, [])} onRetry={retry} />

          <div className="ai-assistant-footer">
            {refs.length > 0 && (
              <div className="ai-input-refs">
                {refs.map((r) => (
                  <span key={`${r.type}-${r.id}`} className="ai-ref-chip">
                    @{mentionChipLabel(r)}
                    <button
                      type="button"
                      aria-label="remove"
                      onClick={() => setRefs((prev) => prev.filter((x) => !(x.type === r.type && x.id === r.id)))}
                    >
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                        <path d="M18 6 6 18M6 6l12 12" />
                      </svg>
                    </button>
                  </span>
                ))}
              </div>
            )}
            <div className="ai-input-wrap">
              {mention.open && (
                <MentionMenu
                  projectId={projectId}
                  pageId={pageId}
                  query={mention.query}
                  onPick={pickMention}
                  onClose={() => setMention({ open: false, query: '' })}
                />
              )}
              <textarea
                ref={inputRef}
                className="ai-input"
                value={text}
                onChange={onInputChange}
                onKeyDown={onKeyDown}
                placeholder={t('inputPlaceholder')}
                rows={1}
              />
              {streaming ? (
                <button type="button" className="ai-send-btn stop" title={t('stop')} onClick={stop}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                </button>
              ) : (
                <button type="button" className="ai-send-btn" title={t('send')} disabled={!text.trim()} onClick={submit}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="m22 2-7 20-4-9-9-4z" />
                    <path d="M22 2 11 13" />
                  </svg>
                </button>
              )}
            </div>
            <div className={`ai-quick-row${quickOpen ? ' open' : ''}`}>
              <div className="ai-quick-list">
                {QUICK_PROMPTS.map((q) => (
                  <button key={q.key} type="button" className="ai-quick-btn" onClick={() => appendQuick(q.prompt)}>
                    {q.label}
                  </button>
                ))}
              </div>
              <button
                type="button"
                className="ai-quick-toggle"
                title={quickOpen ? t('quickCollapse') : t('quickExpand')}
                onClick={() => setQuickOpen((v) => !v)}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="m6 9 6 6 6-6" />
                </svg>
              </button>
            </div>
            <div className="ai-disclaimer">{t('disclaimer')}</div>
          </div>

          {/* 清空确认（面板内居中卡片弹窗） */}
          {confirmClear && (
            <div className="ai-clear-confirm" onClick={() => setConfirmClear(false)}>
              <div className="ai-clear-card" onClick={(e) => e.stopPropagation()}>
                <span className="ai-clear-icon" aria-hidden>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
                  </svg>
                </span>
                <h4>{t('clearTitle')}</h4>
                <p>{t('clearConfirm')}</p>
                <div className="ai-clear-confirm-actions">
                  <button type="button" className="ai-clear-cancel" onClick={() => setConfirmClear(false)}>
                    {t('cancel', { ns: 'layout' })}
                  </button>
                  <button type="button" className="ai-clear-ok" onClick={() => void clear()}>
                    {t('clear')}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </>
  )
}
