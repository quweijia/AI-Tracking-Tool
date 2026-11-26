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
import USelect from '../USelect'
import assistantImg from '../../assets/ai-assistant.png'

/** 面板宽度持久化 localStorage key（左缘拖拽调整） */
const PANEL_WIDTH_KEY = 'ai-assistant-panel-width'

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
  // 快捷提问悬停预览：输入框 placeholder 临时切换为悬停项文案（灰色），点击填入后恢复黑色正文
  const [hoverQuick, setHoverQuick] = useState('')
  // 提示词优化：进行中标记 + 失败提示（输入框上方错误条展示）
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeError, setOptimizeError] = useState('')
  // 优化请求代次计数：非流式 IPC 无法中途取消，点击停止后作废代次、过期响应直接丢弃
  const optimizeGenRef = useRef(0)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  // 输入区底行模型选择器：可选模型列表 + 面板内选择（'' 为跟随全局默认）
  const [models, setModels] = useState<{ id: string; name: string }[]>([])
  const [selModelId, setSelModelId] = useState('')
  // 面板宽度：localStorage 持久化（拖拽范围 360~720，不超过视口）
  const [panelWidth, setPanelWidth] = useState(() => {
    const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
    const max = Math.min(720, window.innerWidth - 32)
    return Number.isFinite(saved) && saved >= 360 && saved <= max ? saved : 400
  })
  const panelWidthRef = useRef(panelWidth)
  // 左缘拖拽调整宽度（复用侧栏 resizer 模式：mousemove 跟随 + mouseup 持久化）
  const startPanelResize = (e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = panelWidthRef.current
    document.body.classList.add('ai-panel-resizing')
    const onMove = (ev: MouseEvent) => {
      const w = Math.max(360, Math.min(Math.min(720, window.innerWidth - 32), startW + startX - ev.clientX))
      panelWidthRef.current = w
      setPanelWidth(w)
    }
    const onUp = () => {
      document.body.classList.remove('ai-panel-resizing')
      localStorage.setItem(PANEL_WIDTH_KEY, String(panelWidthRef.current))
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

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
          const clamped = Number.isFinite(size) && size >= 36 && size <= 96 ? size : 44
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

  // 模型列表 + 面板选择（设置页保存后经事件即时刷新；面板选择持久化到 aiAssistantModelId）
  useEffect(() => {
    const reloadModels = () => {
      void window.electronAPI
        .getConfig()
        .then((cfg) => {
          const list = ((cfg.aiModels as { id: string; name?: string }[] | undefined) ?? [])
            .filter((m) => m.id)
            .map((m) => ({ id: m.id, name: m.name || m.id }))
          setModels(list)
          const saved = cfg.aiAssistantModelId as string | undefined
          setSelModelId(saved && list.some((m) => m.id === saved) ? saved : '')
        })
        .catch(() => {
          setModels([])
          setSelModelId('')
        })
    }
    reloadModels()
    window.addEventListener('ai-assistant-config-change', reloadModels)
    return () => window.removeEventListener('ai-assistant-config-change', reloadModels)
  }, [])

  /** 解析当前生效模型：面板选择优先 → 助手专用配置 → 全局默认 → 首个（与设置页回退链一致） */
  const resolveModelId = async (): Promise<string> => {
    try {
      const cfg = await window.electronAPI.getConfig()
      const list = ((cfg.aiModels as { id: string }[] | undefined) ?? []).filter((m) => m.id)
      if (!list.length) return ''
      const preferred =
        selModelId ||
        ((cfg.aiAssistantModelId as string | undefined) ?? (cfg.aiDefaultModelId as string | undefined) ?? list[0].id)
      return list.find((m) => m.id === preferred)?.id ?? list[0].id
    } catch {
      // 配置读取失败按未配置处理
      return ''
    }
  }

  /** 切换面板模型选择：即时生效 + 持久化 + 广播（设置页与其他监听者同步） */
  const onModelChange = (v: string) => {
    setSelModelId(v)
    void window.electronAPI.setConfig('aiAssistantModelId', v)
    window.dispatchEvent(new CustomEvent('ai-assistant-config-change'))
  }

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
      if (chunk.reasoning) st.appendReasoning(chunk.reasoning)
      if (chunk.delta) st.appendStreamText(chunk.delta)
      if (chunk.done) {
        const s2 = useAiAssistantStore.getState()
        const full = s2.streamText
        if (full.trim()) void st.addMessage('assistant', full, undefined, s2.reasoningText || undefined)
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
    // 模型配置：面板选择 → 助手专用 → 全局默认 → 首个
    const modelId = await resolveModelId()
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

  /** 提示词优化：把输入框草稿交给模型改写为更清晰的提问（非流式，成功后回填输入框） */
  const optimize = async () => {
    const draft = text.trim()
    if (!draft || streaming || optimizing) return
    // 模型配置：面板选择 → 助手专用 → 全局默认 → 首个（与 send 保持一致）
    const modelId = await resolveModelId()
    if (!modelId) {
      setOptimizeError(t('modelMissing'))
      return
    }
    setOptimizing(true)
    setOptimizeError('')
    const gen = ++optimizeGenRef.current
    try {
      const res = await window.electronAPI.aiAssistantOptimize({ modelId, draft })
      if (optimizeGenRef.current !== gen) return // 已点击停止，丢弃过期结果
      if (res.ok && res.text?.trim()) {
        setText(res.text.trim())
        inputRef.current?.focus()
      } else {
        setOptimizeError(res.message || t('sendFailed'))
      }
    } catch (err) {
      if (optimizeGenRef.current !== gen) return // 已点击停止，忽略过期报错
      setOptimizeError(err instanceof Error ? err.message : String(err))
    } finally {
      setOptimizing(false)
    }
  }

  /** 停止优化：作废进行中的请求（后续返回的结果经代次检查直接丢弃），恢复可再次发起 */
  const cancelOptimize = () => {
    optimizeGenRef.current++
    setOptimizing(false)
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
        <div className="ai-assistant-panel" style={{ width: panelWidth }}>
          {/* 左缘拖拽手柄：向左拖动加宽面板 */}
          <div className="ai-panel-resizer" onMouseDown={startPanelResize} />
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
            <span className={`chip chip-sm ai-session-pill${projectId || pageId ? '' : ' none'}`}>
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
                  <span key={`${r.type}-${r.id}`} className="chip chip-sm ai-ref-chip">
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
            {optimizeError && (
              <div className="ai-optimize-error">
                <span>{optimizeError}</span>
                <button type="button" aria-label="close" onClick={() => setOptimizeError('')}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                    <path d="M18 6 6 18M6 6l12 12" />
                  </svg>
                </button>
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
                placeholder={hoverQuick || t('inputPlaceholder')}
                rows={1}
              />
              {/* 底行操作条：左模型选择器 / 右优化 + 发送（TRAE 输入框风格） */}
              <div className="ai-input-actions">
                <USelect
                  className="ai-model-select"
                  value={selModelId}
                  onChange={onModelChange}
                  options={[{ value: '', label: t('modelFollow') }, ...models.map((m) => ({ value: m.id, label: m.name }))]}
                  disabled={!models.length}
                  placeholder={t('modelPlaceholder')}
                />
                <span className="ai-input-buttons">
                  <button
                    type="button"
                    className={`ai-optimize-btn${optimizing ? ' loading' : ''}`}
                    title={optimizing ? t('stopOptimize') : t('optimize')}
                    disabled={!text.trim() || streaming}
                    onClick={() => (optimizing ? cancelOptimize() : void optimize())}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
                      <path d="M10.5 3 Q10.5 10 17.5 10 Q10.5 10 10.5 17 Q10.5 10 3.5 10 Q10.5 10 10.5 3 Z" />
                      <path d="M17.5 13.5 Q17.5 17.5 21.5 17.5 Q17.5 17.5 17.5 21.5 Q17.5 17.5 13.5 17.5 Q17.5 17.5 17.5 13.5 Z" />
                    </svg>
                  </button>
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
                </span>
              </div>
            </div>
            <div className={`ai-quick-row${quickOpen ? ' open' : ''}`}>
              <div className="ai-quick-list" onMouseLeave={() => setHoverQuick('')}>
                {QUICK_PROMPTS.map((q) => (
                  <button
                    key={q.key}
                    type="button"
                    className="ai-quick-btn"
                    onMouseEnter={() => setHoverQuick(q.prompt)}
                    onClick={() => appendQuick(q.prompt)}
                  >
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
