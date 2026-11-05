import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { StructuredChecksConfig, ToleranceConfig, WalkCheckOptions } from '../../../shared/types'
import { WALK_ANALYSES, WALK_DIMENSIONS } from '../../../shared/types'
import type { SkillItemLite } from '../utils/skillGuide'

/** 弹窗骨架（复用全局 .modal-mask/.modal 样式）：Esc 关闭 + 点击遮罩关闭 */
function ModalShell({
  title,
  desc,
  onCancel,
  children,
  footer,
  overlay
}: {
  title: string
  desc?: string
  onCancel: () => void
  children: React.ReactNode
  footer: React.ReactNode
  /** 渲染在遮罩层根节点内的悬浮层（如鼠标跟随气泡，不受弹窗滚动区裁剪） */
  overlay?: React.ReactNode
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
      {/* 弹窗超过窗口高度时内容区自适应滚动，隐藏滚动条滑块（组件级样式，不影响全局） */}
      <style>{`
.walk-opt-modal{max-height:calc(100vh - 96px);display:flex;flex-direction:column}
.walk-opt-modal .modal-actions{flex-shrink:0}
.walk-opt-body{flex:1;min-height:0;overflow-y:auto;scrollbar-width:none;-ms-overflow-style:none}
.walk-opt-body::-webkit-scrollbar{width:0;height:0;display:none}
/* 技能列表项精简：仅大标题 + 左侧复选框垂直居中 */
.walk-opt-modal .skill-pick-item{align-items:center}
.walk-opt-modal .skill-pick-check{margin-top:0}
/* 技能详情气泡：鼠标跟随，fixed 定色不随亮暗主题切换 */
.walk-skill-tip{position:fixed;z-index:2100;max-width:320px;padding:8px 12px;border-radius:8px;background:#1f1f26;color:#f2f2f5;font-size:12px;line-height:1.6;pointer-events:none;box-shadow:0 8px 20px rgba(0,0,0,.25)}
`}</style>
      <div className="modal walk-opt-modal">
        <h3>{title}</h3>
        {desc && <p className="settings-desc">{desc}</p>}
        <div className="walk-opt-body">{children}</div>
        <div className="modal-actions">{footer}</div>
      </div>
      {/* 悬浮层（鼠标跟随气泡）：fixed + pointer-events:none，遮罩层全屏无裁剪 */}
      {overlay}
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
  skills,
  skillIds,
  onSkillChange,
  onSaveSkillDefault,
  onSave,
  onCancel
}: {
  initial: WalkCheckOptions
  /** 可选走查技能列表（config.skills）与当前已选 id（保存时一并提交生效） */
  skills: SkillItemLite[]
  skillIds: string[]
  onSkillChange: (ids: string[]) => void
  /** 将勾选保存为全局默认绑定技能 */
  onSaveSkillDefault: (ids: string[]) => void
  onSave: (opts: WalkCheckOptions) => void
  onCancel: () => void
}) {
  const { t } = useTranslation('walkOptionsModal')
  const { t: ta } = useTranslation('autoWalkPanel')
  const [dimensions, setDimensions] = useState<string[]>(initial.dimensions)
  const [depth, setDepth] = useState<WalkCheckOptions['depth']>(initial.depth)
  const [analysis, setAnalysis] = useState<string[]>(initial.analysis)
  const [style, setStyle] = useState<WalkCheckOptions['style']>(initial.style)
  const [a11y, setA11y] = useState<boolean>(initial.a11y)
  /** 技能多选（批量提交：勾选只改本地，保存时随检查项一并生效） */
  const [picked, setPicked] = useState<string[]>(skillIds)

  const toggleSkill = (id: string): void =>
    setPicked((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]))

  /** 技能详情气泡（鼠标跟随）：desc 为空的技能不显示 */
  const [tip, setTip] = useState<{ x: number; y: number; text: string } | null>(null)
  const showTip = (e: React.MouseEvent, text: string): void => {
    if (!text) return
    setTip({ x: e.clientX, y: e.clientY, text })
  }
  const moveTip = (e: React.MouseEvent): void => {
    setTip((prev) => (prev ? { ...prev, x: e.clientX, y: e.clientY } : prev))
  }

  // 展示 label 随界面语言生成（WALK_DIMENSIONS/WALK_ANALYSES 的原 label 仅用于 AI prompt 注入）
  const dimOptions = WALK_DIMENSIONS.map((d) => ({ key: d.key, label: t(`dim_${d.key}`) }))
  const anaOptions = WALK_ANALYSES.map((a) => ({ key: a.key, label: t(`ana_${a.key}`) }))

  return (
    <ModalShell
      title={t('checkTitle')}
      desc={t('checkDesc')}
      onCancel={onCancel}
      overlay={
        tip && (
          <div className="walk-skill-tip" style={{ left: tip.x + 14, top: tip.y + 14 }}>
            {tip.text}
          </div>
        )
      }
      footer={
        <>
          <button
            className="btn-secondary"
            disabled={picked.length === 0}
            title={ta('skillPickDesc')}
            onClick={() => onSaveSkillDefault(picked)}
          >
            {ta('skillSaveDefault')}
          </button>
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button
            className="btn-primary"
            disabled={dimensions.length === 0 || analysis.length === 0}
            onClick={() => {
              onSave({ dimensions, depth, analysis, style, a11y })
              onSkillChange(picked)
            }}
          >
            {t('save')}
          </button>
        </>
      }
    >
      <OptSection title={ta('skillLabel')}>
        {skills.length === 0 ? (
          <p className="settings-empty">{ta('skillPickEmpty')}</p>
        ) : (
          <div className="skill-pick-list">
            {skills.map((s) => {
              const active = picked.includes(s.id)
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`skill-pick-item ${active ? 'active' : ''}`}
                  onMouseEnter={(e) => showTip(e, s.desc ?? '')}
                  onMouseMove={moveTip}
                  onMouseLeave={() => setTip(null)}
                  onClick={() => toggleSkill(s.id)}
                >
                  <span className="skill-pick-check">{active ? '✓' : ''}</span>
                  <span className="skill-pick-name">{s.name}</span>
                </button>
              )
            })}
          </div>
        )}
      </OptSection>

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
  layeredEnabled,
  structuredChecks,
  canRun,
  busy,
  onSave,
  onToggleDebug,
  onChangeLayeredEnabled,
  onChangeStructuredChecks,
  onRun,
  onCancel
}: {
  initial: ToleranceConfig
  debugEnabled: boolean
  /** 分层还原度判定开关（与 Settings 页共用同一配置键，此处只切 enabled） */
  layeredEnabled: boolean
  /** 结构化对比增强配置：圆角 computed/父级追溯开关 + Hug 文本宽度判定模式 */
  structuredChecks: StructuredChecksConfig
  /** 是否具备运行条件（有最近一次走查的采集缓存且当前不忙） */
  canRun: boolean
  busy: boolean
  onSave: (t: ToleranceConfig) => void
  onToggleDebug: (v: boolean) => void
  onChangeLayeredEnabled: (v: boolean) => void
  onChangeStructuredChecks: (v: StructuredChecksConfig) => void
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
      <OptSection title={t('layeredSec')}>
        <div className="walk-opt-switch-row">
          <span>{t('layeredToggle')}</span>
          <button
            type="button"
            className={`switch ${layeredEnabled ? 'on' : ''}`}
            title={layeredEnabled ? t('layeredOff') : t('layeredOn')}
            onClick={() => onChangeLayeredEnabled(!layeredEnabled)}
          />
        </div>
        <p className="settings-desc walk-opt-hint">{t('layeredHint')}</p>
      </OptSection>
      <OptSection title={t('structSec')}>
        <div className="walk-opt-switch-row">
          <span>{t('structRadiusToggle')}</span>
          <button
            type="button"
            className={`switch ${structuredChecks.radiusCheck ? 'on' : ''}`}
            title={structuredChecks.radiusCheck ? t('structRadiusOff') : t('structRadiusOn')}
            onClick={() =>
              onChangeStructuredChecks({ ...structuredChecks, radiusCheck: !structuredChecks.radiusCheck })
            }
          />
        </div>
        <p className="settings-desc walk-opt-hint">{t('structRadiusHint')}</p>
        <OptRadio
          name="walk-hug"
          value={structuredChecks.hugWidthMode}
          onChange={(v) => onChangeStructuredChecks({ ...structuredChecks, hugWidthMode: v })}
          options={[
            { value: 'text-content', label: t('hugTextContent') },
            { value: 'strict', label: t('hugStrict') }
          ]}
        />
        <p className="settings-desc walk-opt-hint">{t('structHugHint')}</p>
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
