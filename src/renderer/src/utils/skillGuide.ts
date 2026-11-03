/** SkillHub 技能（config.skills 存储结构，与手动标注页一致） */
export interface SkillItemLite {
  id: string
  name: string
  desc?: string
  url?: string
  /** Zip 包导入的指南文档内容 */
  guides?: string[]
}

/**
 * 把选中的技能拼为「名称+描述+参考链接+指南」的指引文本数组。
 * 与手动标注页（CompareWorkbench）注入 aiAnnotate 的格式保持同一套规则，
 * 供自动走查链路复用（本文件不改变手动标注页的原有逻辑）。
 */
export function buildSkillGuides(skills: SkillItemLite[], skillIds: string[]): string[] {
  return skills
    .filter((s) => skillIds.includes(s.id))
    .map((s) => {
      const base = `${s.name}${s.desc ? `：${s.desc}` : ''}${s.url ? `（参考：${s.url}）` : ''}`
      const guides = (s.guides ?? []).map((g) => g.slice(0, 2000)).join('\n\n')
      return guides ? `${base}\n技能指南：\n${guides}` : base
    })
}
