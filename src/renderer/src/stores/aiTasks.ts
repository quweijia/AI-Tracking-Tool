import { create } from 'zustand'
import { tr } from '../i18n'
import { playTaskDoneSound } from '../utils/sound'

/**
 * AI 识别任务（跨页面后台运行，支持同页/多页多任务并行）：
 * - 任务数组存储，同一点击即新建一个任务，按钮不被进行中的任务禁用
 * - 完成/失败时 finish；被中断的任务 finish 不生效，结果直接丢弃
 * - 组件卸载（切换页面）不影响任务执行，返回页面时从这里恢复状态与结果提示
 */
export type AiTaskStatus = 'running' | 'done' | 'failed' | 'interrupted'

/** 任务来源模式：手动标注页 / 自动走查页（点击后台入口跳转时需回到对应模式） */
export type AiTaskMode = 'manual' | 'auto'

export interface AiTask {
  id: string
  pageId: string
  /** 所属项目：全局悬浮提示点击后可跳回任务所在页面 */
  projectId: string
  pageName: string
  /** 发起任务时所在的工作模式 */
  mode: AiTaskMode
  status: AiTaskStatus
  message: string
  startedAt: number
}

interface AiTasksState {
  tasks: AiTask[]
  /** 新建任务，返回任务 id */
  start: (pageId: string, projectId: string, pageName: string, mode: AiTaskMode) => string
  /** 用户选择「中断任务」：正在等待的识别结果将被丢弃 */
  interrupt: (taskId: string) => void
  /** 更新某页面所有进行中任务的进度提示（流式接收字数/耗时） */
  progressPage: (pageName: string, note: string) => void
  finish: (taskId: string, ok: boolean, message: string) => void
  clear: (taskId: string) => void
  /** 进行中的任务列表（切页提醒用） */
  runningList: () => AiTask[]
}

const genTaskId = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

export const useAiTasksStore = create<AiTasksState>((set, get) => ({
  tasks: [],
  start: (pageId, projectId, pageName, mode) => {
    const id = genTaskId()
    set((s) => ({
      tasks: [
        ...s.tasks,
        { id, pageId, projectId, pageName, mode, status: 'running', message: tr('running', 'aiTasks'), startedAt: Date.now() }
      ]
    }))
    return id
  },
  interrupt: (taskId) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.id === taskId && t.status === 'running' ? { ...t, status: 'interrupted', message: tr('interrupted', 'aiTasks') } : t
      )
    })),
  progressPage: (pageName, note) =>
    set((s) => ({
      tasks: s.tasks.map((t) =>
        t.status === 'running' && (!pageName || t.pageName === pageName)
          ? { ...t, message: tr('progress', 'aiTasks', { note }) }
          : t
      )
    })),
  finish: (taskId, ok, message) => {
    // 任务真实流转为「完成」时播放提示音（中断/重复 finish 静默；开关在音效工具内判断）
    if (ok && get().tasks.some((t) => t.id === taskId && t.status === 'running')) void playTaskDoneSound()
    return set((s) => ({
      tasks: s.tasks.map((t) => {
        // 已被中断：保持中断态，结果由调用方丢弃
        if (t.id !== taskId || t.status !== 'running') return t
        return { ...t, status: ok ? 'done' : 'failed', message }
      })
    }))
  },
  clear: (taskId) => set((s) => ({ tasks: s.tasks.filter((t) => t.id !== taskId) })),
  runningList: () => get().tasks.filter((t) => t.status === 'running')
}))
