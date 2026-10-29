import { create } from 'zustand'
import { db, genId, type AssistantMessage, type AssistantRef } from '../db'

/**
 * AI 小助手（全局悬浮面板，跨页面常驻）：
 * - 会话按项目/页面维度隔离持久化，pageId 空串 = 项目列表页的项目级会话
 * - 路由切换（项目/页面变化）时由面板组件调用 loadSession 重建消息列表
 * - 流式回复：delta 逐段拼入 streamText，生成完成/失败后 resetStream 收尾
 */
interface AiAssistantState {
  open: boolean
  /** 当前会话归属（与路由联动） */
  projectId: string
  pageId: string
  /** 当前会话历史（已落库消息，按 createdAt 正序） */
  messages: AssistantMessage[]
  /** 会话历史加载中 */
  loading: boolean
  /** AI 流式生成中 */
  streaming: boolean
  /** 进行中流式请求的 reqId（chunk 事件按此匹配，中断用） */
  streamingReqId: string
  /** 流式中的回复文本（未落库，随 delta 增长） */
  streamText: string
  /** 本轮请求的错误文案（面板内气泡展示，不落库） */
  error: string
  toggle: () => void
  setOpen: (open: boolean) => void
  /** 切换会话：从 IndexedDB 加载该项目/页面的历史对话（同会话重复调用不重载） */
  loadSession: (projectId: string, pageId: string) => Promise<void>
  /** 新增消息（落库 + 状态追加），返回完整消息对象供流式请求引用 */
  addMessage: (role: AssistantMessage['role'], content: string, refs?: AssistantRef[]) => Promise<AssistantMessage>
  setStreaming: (streaming: boolean) => void
  setStreamingReqId: (reqId: string) => void
  /** 流式 delta 追加 */
  appendStreamText: (delta: string) => void
  /** 流式结束/失败后清空流式状态 */
  resetStream: () => void
  setError: (error: string) => void
  /** 清空当前会话（IndexedDB 删除 + 状态清空） */
  clearSession: () => Promise<void>
}

export const useAiAssistantStore = create<AiAssistantState>((set, get) => ({
  open: false,
  projectId: '',
  pageId: '',
  messages: [],
  loading: false,
  streaming: false,
  streamingReqId: '',
  streamText: '',
  error: '',
  toggle: () => set((s) => ({ open: !s.open })),
  setOpen: (open) => set({ open }),
  loadSession: async (projectId, pageId) => {
    if (projectId === get().projectId && pageId === get().pageId) return
    set({ projectId, pageId, loading: true, messages: [], streamText: '', error: '', streaming: false })
    try {
      const rows = await db.assistantMessages.where('[projectId+pageId]').equals([projectId, pageId]).sortBy('createdAt')
      set({ messages: rows, loading: false })
    } catch {
      set({ loading: false })
    }
  },
  addMessage: async (role, content, refs) => {
    const msg: AssistantMessage = {
      id: genId(),
      projectId: get().projectId,
      pageId: get().pageId,
      role,
      content,
      ...(refs ? { refs } : {}),
      createdAt: Date.now()
    }
    await db.assistantMessages.add(msg)
    set((s) => ({ messages: [...s.messages, msg] }))
    return msg
  },
  setStreaming: (streaming) => set({ streaming, ...(streaming ? {} : { streamingReqId: '' }) }),
  setStreamingReqId: (streamingReqId) => set({ streamingReqId }),
  appendStreamText: (delta) => set((s) => ({ streamText: s.streamText + delta })),
  resetStream: () => set({ streamText: '', streaming: false }),
  setError: (error) => set({ error }),
  clearSession: async () => {
    const { projectId, pageId } = get()
    try {
      await db.assistantMessages.where('[projectId+pageId]').equals([projectId, pageId]).delete()
    } catch {
      // 删除失败不阻塞 UI，消息列表仍本地清空
    }
    set({ messages: [], streamText: '', error: '' })
  }
}))
