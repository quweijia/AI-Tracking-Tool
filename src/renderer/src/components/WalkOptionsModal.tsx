import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { ToleranceConfig, WalkCheckOptions } from '../../../shared/types'
import { WALK_ANALYSES, WALK_DIMENSIONS } from '../../../shared/types'

/** 弹窗骨架（复用全局 .modal-mask/.modal 样式）：Esc 关闭 + 点击遮罩关闭 */
function ModalShell({
  title,
  desc,
  onCancel,
  children,
  footer
}: {
  title: string
  desc?: string
  onCancel: () => void
  children: React.ReactNode
  footer: React.ReactNode
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal walk-opt-modal">
        <h3>{title}</h3>
        {desc && <p className="settings-desc">{desc}</p>}
        {children}
        <div className="modal-actions">{footer}</div>
      </div>
    </div>
  )
}

/** 多选检查项（chips） */
function CheckChips({
  options,
  value,
  onChange
}: {
  options: { key: string; label: string }[]
  value: string[]
  onChange: (next: string[]) => void
}) {
  return (
    <div className="walk-opt-chips">
      {options.map((o) => {
        const active = value.includes(o.key)
        return (
          <button
            key={o.key}
            type="button"
            className={`walk-opt-chip ${active ? 'active' : ''}`}
            onClick={() => onChange(active ? value.filter((k) => k !== o.key) : [...value, o.key])}
          >
            {active ? '✓ ' : ''}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}

/** 单选组（纵向 radio 行） */
function OptRadio<T extends string>({
  name,
  options,
  value,
  onChange
}: {
  name: string
  options: { value: T; label: string }[]
  value: T
  onChange: (v: T) => void
}) {
  return (
    <div className="walk-opt-radios">
      {options.map((o) => (
        <label key={o.value} className={`walk-opt-radio ${value === o.value ? 'active' : ''}`}>
          <input
            type="radio"
            name={name}
            checked={value === o.value}
            onChange={() => onChange(o.value)}
          />
          <span>{o.label}</span>
        </label>
      ))}
    </div>
  )
}

/** 弹窗内的设置分区：标题加深 + 分隔线拉开模块间距 */
function OptSection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="walk-opt-sec">
      <label className="field-label">{title}</label>
      {children}
    </div>
  )
}

/**
 * 自定义检查项弹窗：检查维度 / 检查深度 / AI 分析设置 / 输出风格 / 无障碍 a11y 开关。
 * 检查深度注入 AI 视觉比对 prompt（结构化容差倍率仅高级调试时生效）。
 */
export function WalkCheckOptionsModal({
  initial,
  onSave,
  onCancel
}: {
  initial: WalkCheckOptions
  onSave: (opts: WalkCheckOptions) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('walkOptionsModal')
  const [dimensions, setDimensions] = useState<string[]>(initial.dimensions)
  const [depth, setDepth] = useState<WalkCheckOptions['depth']>(initial.depth)
  const [analysis, setAnalysis] = useState<string[]>(initial.analysis)
  const [style, setStyle] = useState<WalkCheckOptions['style']>(initial.style)
  const [a11y, setA11y] = useState<boolean>(initial.a11y)

  // 展示 label 随界面语言生成（WALK_DIMENSIONS/WALK_ANALYSES 的原 label 仅用于 AI prompt 注入）
  const dimOptions = WALK_DIMENSIONS.map((d) => ({ key: d.key, label: t(`dim_${d.key}`) }))
  const anaOptions = WALK_ANALYSES.map((a) => ({ key: a.key, label: t(`ana_${a.key}`) }))

  return (
    <ModalShell
      title={t('checkTitle')}
      desc={t('checkDesc')}
      onCancel={onCancel}
      footer={
        <>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={dimensions.length === 0 || analysis.length === 0}
            onClick={() => onSave({ dimensions, depth, analysis, style, a11y })}
          >
            {t('save')}
          </button>
        </>
      }
    >
      <OptSection title={t('secDimensions')}>
        <CheckChips options={dimOptions} value={dimensions} onChange={setDimensions} />
      </OptSection>

      <OptSection title={t('secDepth')}>
        <OptRadio
          name="walk-depth"
          value={depth}
          onChange={setDepth}
          options={[
            { value: 'loose', label: t('depthLoose') },
            { value: 'standard', label: t('depthStandard') },
            { value: 'strict', label: t('depthStrict') }
          ]}
        />
        <p className="settings-desc walk-opt-hint">
          {t('depthHint')}
        </p>
      </OptSection>

      <OptSection title={t('secAnalysis')}>
        <CheckChips options={anaOptions} value={analysis} onChange={setAnalysis} />
      </OptSection>

      <OptSection title={t('secStyle')}>
        <OptRadio
          name="walk-style"
          value={style}
          onChange={setStyle}
          options={[
            { value: 'concise', label: t('styleConcise') },
            { value: 'detailed', label: t('styleDetailed') }
          ]}
        />
      </OptSection>

      <OptSection title={t('secA11y')}>
        <div className="walk-opt-switch-row">
          <span>{t('a11yToggle')}</span>
          <button
            type="button"
            className={`switch ${a11y ? 'on' : ''}`}
            title={a11y ? t('a11yOff') : t('a11yOn')}
            onClick={() => setA11y(!a11y)}
          />
        </div>
        <p className="settings-desc walk-opt-hint">{t('secA11yHint')}</p>
      </OptSection>
    </ModalShell>
  )
}

/** 高级调试弹窗：结构化尺寸 diff 开关（默认关闭）+ 手动运行 + 比对容差（留给有精确还原调试需求的开发） */
export function WalkAdvancedModal({
  initial,
  debugEnabled,
  canRun,
  busy,
  onSave,
  onToggleDebug,
  onRun,
  onCancel
}: {
  initial: ToleranceConfig
  debugEnabled: boolean
  /** 是否具备运行条件（有最近一次走查的采集缓存且当前不忙） */
  canRun: boolean
  busy: boolean
  onSave: (t: ToleranceConfig) => void
  onToggleDebug: (v: boolean) => void
  onRun: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation('walkOptionsModal')
  const [tolerance, setTolerance] = useState<ToleranceConfig>(initial)

  const FIELDS: { key: keyof ToleranceConfig; label: string; hint: string }[] = [
    { key: 'size', label: t('tol_size'), hint: t('tol_size_hint') },
    { key: 'typography', label: t('tol_typography'), hint: t('tol_typography_hint') },
    { key: 'spacing', label: t('tol_spacing'), hint: t('tol_spacing_hint') },
    { key: 'radius', label: t('tol_radius'), hint: t('tol_radius_hint') },
    { key: 'border', label: t('tol_border'), hint: t('tol_border_hint') },
    { key: 'color', label: t('tol_color'), hint: t('tol_color_hint') }
  ]

  const change = (key: keyof ToleranceConfig, value: string): void => {
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0) return
    setTolerance({ ...tolerance, [key]: Math.round(n * 100) / 100 })
  }

  return (
    <ModalShell
      title={t('advTitle')}
      desc={t('advDesc')}
      onCancel={onCancel}
      footer={
        <>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={() => onSave(tolerance)}>
            {t('save')}
          </button>
        </>
      }
    >
      <OptSection title={t('advDebugSec')}>
        <div className="walk-opt-switch-row">
          <span>{t('advDebugToggle')}</span>
          <button
            type="button"
            className={`switch ${debugEnabled ? 'on' : ''}`}
            title={debugEnabled ? t('advDebugOff') : t('advDebugOn')}
            onClick={() => onToggleDebug(!debugEnabled)}
          />
        </div>
        <p className="settings-desc walk-opt-hint">{t('advDebugHint')}</p>
        <button
          type="button"
          className="btn-secondary walk-adv-run"
          disabled={!canRun || busy}
          title={canRun ? t('advRunNow') : t('advRunStale')}
          onClick={onRun}
        >
          {busy ? t('advRunning') : t('advRunNow')}
        </button>
      </OptSection>
      <OptSection title={t('tolTitle')}>
        <div className="settings-tol-grid">
          {FIELDS.map((f) => (
            <label key={f.key} className="settings-tol-item" title={f.hint}>
              <span className="settings-tol-label">{f.label}</span>
              <span className="settings-tol-input">
                <input
                  className="input input-sm"
                  type="number"
                  min={0}
                  step={f.key === 'color' ? 0.5 : 1}
                  value={tolerance[f.key]}
                  onChange={(e) => change(f.key, e.target.value)}
                />
                <span className="settings-tol-unit">{f.key === 'color' ? 'ΔE' : 'px'}</span>
              </span>
            </label>
          ))}
        </div>
        <p className="settings-desc walk-opt-hint">{t('tolHint')}</p>
      </OptSection>
    </ModalShell>
  )
}
