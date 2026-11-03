import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import type { Issue } from '../db'
import { extractSkillTags } from '../utils/skillTags'
import type { WalkRunRecord } from '../utils/skillStats'

interface Props {
  /** 走查运行元信息（localStorage，上限 50 条） */
  runs: WalkRunRecord[]
  /** 当前问题库（联查统计，被删的问题自动不计） */
  issues: Issue[]
  open: boolean
  onToggle: () => void
}

/** 采纳口径：已修复或设计确认（与走查报告口径一致） */
const isAdopted = (i: Issue) => i.status === 'fixed' || i.status === 'design-confirmed'

/** 技能效果统计面板（模块3）：纯展示，命中数 / 采纳率 / 开关技能对比 */
export default function SkillStatsPanel({ runs, issues, open, onToggle }: Props) {
  const { t } = useTranslation('autoWalkPanel')

  /** 问题 id → issue 索引 */
  const byId = useMemo(() => new Map(issues.map((i) => [i.id, i])), [issues])

  /** 汇总：走查次数（带/未带技能）、当前问题总数、命中技能数、已处理数 */
  const summary = useMemo(() => {
    const withRuns = runs.filter((r) => r.skillUsed).length
    let hit = 0
    let adopted = 0
    for (const i of issues) {
      if (extractSkillTags(i.description).length > 0) {
        hit++
        if (isAdopted(i)) adopted++
      }
    }
    return {
      total: runs.length,
      withRuns,
      withoutRuns: runs.length - withRuns,
      issues: issues.length,
      hit,
      adopted
    }
  }, [runs, issues])

  /** 按技能命中分布：运行记录 issueIds 联查当前问题库，按命中数降序 */
  const bySkill = useMemo(() => {
    const map = new Map<string, { hit: number; adopted: number }>()
    for (const r of runs) {
      for (const id of r.issueIds) {
        const issue = byId.get(id)
        if (!issue) continue
        for (const name of extractSkillTags(issue.description)) {
          const e = map.get(name) ?? { hit: 0, adopted: 0 }
          e.hit++
          if (isAdopted(issue)) e.adopted++
          map.set(name, e)
        }
      }
    }
    return [...map.entries()].sort((a, b) => b[1].hit - a[1].hit)
  }, [runs, byId])

  /** 开关技能对比：带技能 vs 未带技能走查的问题命中与采纳率（ids 去重联查） */
  const compare = useMemo(() => {
    const build = (skillUsed: boolean) => {
      const ids = new Set<string>()
      for (const r of runs) if (r.skillUsed === skillUsed) r.issueIds.forEach((id) => ids.add(id))
      let hit = 0
      let adopted = 0
      for (const id of ids) {
        const issue = byId.get(id)
        if (!issue) continue
        hit++
        if (isAdopted(issue)) adopted++
      }
      return {
        runCount: runs.filter((r) => r.skillUsed === skillUsed).length,
        issuesN: ids.size,
        hit,
        rate: hit > 0 ? Math.round((adopted / hit) * 100) : null
      }
    }
    return { with: build(true), without: build(false) }
  }, [runs, byId])

  return (
    <div className="aw-skill-stats">
      <button type="button" className="aw-skill-stats-head" onClick={onToggle}>
        <span className={`aw-skill-stats-arrow${open ? ' open' : ''}`}>▸</span>
        {t('statsTitle')}
        {!open && <span className="aw-skill-stats-hint">{summary.total}</span>}
      </button>
      {open && (
        <div className="aw-skill-stats-body">
          {!runs.length ? (
            <p className="aw-skill-stats-empty">{t('statsEmpty')}</p>
          ) : (
            <>
              <p className="aw-skill-stats-summary">
                {t('statsSummary', {
                  n: summary.total,
                  ws: summary.withRuns,
                  wo: summary.withoutRuns,
                  issues: summary.issues,
                  hit: summary.hit,
                  adopted: summary.adopted
                })}
              </p>
              <table className="aw-skill-stats-table">
                <thead>
                  <tr>
                    <th>{t('statsBySkill')}</th>
                    <th>{t('statsColHit')}</th>
                    <th>{t('statsColAdopted')}</th>
                  </tr>
                </thead>
                <tbody>
                  {bySkill.length === 0 ? (
                    <tr>
                      <td className="aw-skill-stats-none" colSpan={3}>
                        {t('statsNoHit')}
                      </td>
                    </tr>
                  ) : (
                    bySkill.map(([name, s]) => (
                      <tr key={name}>
                        <td>{name}</td>
                        <td>{s.hit}</td>
                        <td>{s.adopted}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
              <table className="aw-skill-stats-table">
                <thead>
                  <tr>
                    <th>{t('statsCompare')}</th>
                    <th>{t('statsColRuns')}</th>
                    <th>{t('statsColIssues')}</th>
                    <th>{t('statsColHit')}</th>
                    <th>{t('statsColRate')}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr>
                    <td>{t('statsWith')}</td>
                    <td>{compare.with.runCount}</td>
                    <td>{compare.with.issuesN}</td>
                    <td>{compare.with.hit}</td>
                    <td>{compare.with.rate === null ? '—' : `${compare.with.rate}%`}</td>
                  </tr>
                  <tr>
                    <td>{t('statsWithout')}</td>
                    <td>{compare.without.runCount}</td>
                    <td>{compare.without.issuesN}</td>
                    <td>{compare.without.hit}</td>
                    <td>{compare.without.rate === null ? '—' : `${compare.without.rate}%`}</td>
                  </tr>
                </tbody>
              </table>
            </>
          )}
        </div>
      )}
    </div>
  )
}
