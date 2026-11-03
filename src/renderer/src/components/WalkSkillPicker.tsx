import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { SkillItemLite } from '../utils/skillGuide'

interface WalkSkillPickerProps {
  /** 可选技能列表（config.skills） */
  skills: SkillItemLite[]
  /** 当前已选技能 id */
  initial: string[]
  /** 确认选择（写入「上次选用」持久化并生效到本次走查） */
  onConfirm: (ids: string[]) => void
  /** 将当前勾选保存为全局默认绑定技能 */
  onSaveDefault: (ids: string[]) => void
  onCancel: () => void
}

/**
 * 自动走查技能选择弹窗（模块1：自动走查接入 SkillHub）。
 * 复用手动标注页技能弹窗的样式类名（skill-pick-*），仅多选 +「设为默认绑定」，
 * 不影响手动标注链路。
 */
export default function WalkSkillPicker({ skills, initial, onConfirm, onSaveDefault, onCancel }: WalkSkillPickerProps) {
  const { t } = useTranslation('autoWalkPanel')
  const [picked, setPicked] = useState<string[]>(initial)

  // Escape 关闭弹窗
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  const toggle = (id: string): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal">
        <h3>{t('skillPickTitle')}</h3>
        <p className="settings-desc">{t('skillPickDesc')}</p>
        {skills.length === 0 ? (
          <p className="settings-empty">{t('skillPickEmpty')}</p>
        ) : (
          <div className="skill-pick-list">
            {skills.map((s) => {
              const active = picked.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`skill-pick-item ${active ? 'active' : ''}`}
                  onClick={() => toggle(s.id)}
                >
                  <span className="skill-pick-check">{active ? '✓' : ''}</span>
                  <span className="skill-pick-body">
                    <span className="skill-pick-name">{s.name}</span>
                    {s.desc && <span className="skill-pick-desc">{s.desc}</span>}
                  </span>
                </button>
              )
            })}
          </div>
        )}
        <div className="modal-actions">
          <button
            className="btn-secondary"
            disabled={picked.length === 0}
            title={t('skillPickDesc')}
            onClick={() => onSaveDefault(picked)}
          >
            {t('skillSaveDefault')}
          </button>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('skillCancel')}
          </button>
          <button className="btn-primary" onClick={() => onConfirm(picked)}>
            {picked.length ? t('skillConfirm', { n: picked.length }) : t('skillConfirmNone')}
          </button>
        </div>
      </div>
    </div>
  )
}
