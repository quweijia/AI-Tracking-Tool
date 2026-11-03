/**
 * 自动走查运行元信息（模块3 技能效果统计）：
 * localStorage 存轻量运行记录（上限 50 条），问题本体仍在 Dexie 不新增字段；
 * 统计展示时实时与当前问题库联查——问题被删除自动不计，重新走查清空旧问题
 * 但运行记录保留，实现「累计走查」语义。
 */

/** 一次自动走查的运行元信息 */
export interface WalkRunRecord {
  /** 运行时间戳 */
  ts: number
  pageId: string
  pageName: string
  /** 本次是否带技能走查（开关对比维度） */
  skillUsed: boolean
  /** 本次选中的技能名称列表 */
  skillNames: string[]
  /** 本次落库的视觉问题 id（联查当前问题库得统计） */
  issueIds: string[]
}

const RUNS_KEY = 'walkSkillRuns'
/** 记录上限，超出裁剪最旧的 */
const RUNS_MAX = 50

/** 读取全部运行记录（异常时返回空） */
export function readWalkRuns(): WalkRunRecord[] {
  try {
    const raw = localStorage.getItem(RUNS_KEY)
    const arr = raw ? (JSON.parse(raw) as unknown) : null
    if (!Array.isArray(arr)) return []
    return arr.filter(
      (r): r is WalkRunRecord =>
        !!r &&
        typeof r === 'object' &&
        typeof (r as WalkRunRecord).ts === 'number' &&
        Array.isArray((r as WalkRunRecord).issueIds)
    )
  } catch {
    return []
  }
}

/** 追加一条运行记录（裁剪到上限），返回更新后的完整列表供 setState */
export function appendWalkRun(record: WalkRunRecord): WalkRunRecord[] {
  const trimmed = [...readWalkRuns(), record].slice(-RUNS_MAX)
  try {
    localStorage.setItem(RUNS_KEY, JSON.stringify(trimmed))
  } catch {
    // 存储异常（隐私模式等）静默降级：统计仍在本次会话内可用（返回值已带新记录）
  }
  return trimmed
}
