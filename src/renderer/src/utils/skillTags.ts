/**
 * 命中技能标注解析（模块3）：
 * AI 在问题描述末尾追加【命中技能：技能名称】标注（约定见 main/ai.ts 的 SKILL_FOOTER），
 * 可多个并列；本工具负责提取与展示时剥离，不改动数据库结构。
 */

/** 命中标注格式：全角括号包裹，冒号后为技能名称 */
const SKILL_TAG_RE = /【命中技能：([^】]+)】/g

/** 从问题描述中提取命中技能名称（去重，保持首次出现顺序） */
export function extractSkillTags(description: string): string[] {
  const seen: string[] = []
  const set = new Set<string>()
  for (const m of description.matchAll(SKILL_TAG_RE)) {
    const name = m[1].trim()
    if (!name || set.has(name)) continue
    set.add(name)
    seen.push(name)
  }
  return seen
}

/** 去掉命中技能标注后的干净描述（列表 / 聚焦条展示用） */
export function stripSkillTags(description: string): string {
  return description.replace(SKILL_TAG_RE, '').trim()
}
