import { useEffect, useMemo, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import { db, genId, Platform, DesignSpec } from '../db'
import { PlatformIcon } from './PlatformBadge'
import USelect from './USelect'

interface Props {
  /** 项目 id（绑定关系挂在项目上） */
  projectId: string
  /** 当前标注页面的端类型：仅展示该端的规范分类 */
  platform: Platform
  onDone: () => void
  onCancel: () => void
}

/**
 * 标注页「绑定规范」弹窗：仅绑定规范（按当前页面端类型分类各绑一套，走查时自动套用），
 * 不含项目名称 / Logo / 端类型 / 删除等编辑项；保存时只重写当前端分类的绑定，其他端不受影响。
 */
export default function BindSpecModal({ projectId, platform, onDone, onCancel }: Props) {
  const { t } = useTranslation('bindSpecModal')
  /** 端分类 id → 规范套 id（'' = 不绑定） */
  const [bindByCategory, setBindByCategory] = useState<Record<string, string>>({})

  const categories = useLiveQuery(() => db.specCategories.toArray(), []) ?? []
  const specs = useLiveQuery(() => db.designSpecs.toArray(), []) ?? []
  const bindings = useLiveQuery(
    () => db.projectSpecBindings.where('projectId').equals(projectId).toArray(),
    [projectId]
  )

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // 规范套 id → 所属端分类 id（绑定反查用）
  const specCatOf = useMemo(() => new Map(specs.map((s) => [s.id, s.categoryId])), [specs])

  // 只显示当前页面端类型对应的分类（走查取套依据：page.platform → category.platformKey）
  const visibleCats = useMemo(
    () =>
      categories
        .filter((c) => c.platformKey === platform)
        .sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || a.createdAt - b.createdAt),
    [categories, platform]
  )

  // 规范套按分类分组
  const specsByCat = useMemo(() => {
    const m: Record<string, DesignSpec[]> = {}
    for (const s of specs) (m[s.categoryId] ??= []).push(s)
    return m
  }, [specs])

  // 已有绑定初始化为选中态（bindings 与 specs 都就绪后执行一次）
  useEffect(() => {
    if (!bindings) return
    const map: Record<string, string> = {}
    for (const b of bindings) {
      const catId = specCatOf.get(b.specId)
      if (catId) map[catId] = b.specId
    }
    setBindByCategory(map)
  }, [bindings, specCatOf])

  const setBind = (catId: string, specId: string) =>
    setBindByCategory((prev) => ({ ...prev, [catId]: specId }))

  /** 保存：只重写当前端分类的绑定（其他端绑定保留不动） */
  const handleSave = async () => {
    const catIds = new Set(visibleCats.map((c) => c.id))
    await db.transaction('rw', db.projectSpecBindings, async () => {
      const olds = await db.projectSpecBindings.where('projectId').equals(projectId).toArray()
      await db.projectSpecBindings.bulkDelete(
        olds.filter((b) => catIds.has(specCatOf.get(b.specId) ?? '')).map((b) => b.id)
      )
      const rows = Object.entries(bindByCategory)
        .filter(([catId, specId]) => !!specId && catIds.has(catId))
        .map(([, specId]) => ({ id: genId(), projectId, specId, createdAt: Date.now() }))
      if (rows.length) await db.projectSpecBindings.bulkAdd(rows)
    })
    onDone()
  }

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal bind-spec-modal">
        <h3>{t('title')}</h3>
        <p className="modal-subtitle">{t('desc')}</p>

        {specs.length === 0 || visibleCats.length === 0 ? (
          <div className="spec-bind-empty">{t('empty')}</div>
        ) : (
          <div className="spec-bind-grid">
            {visibleCats.map((cat) => {
              const bound = bindByCategory[cat.id] ?? ''
              const opts = [
                { value: '', label: t('none') },
                ...(specsByCat[cat.id] ?? []).map((s) => ({ value: s.id, label: s.name }))
              ]
              return (
                <div key={cat.id} className={`spec-bind-row${bound ? ' bound' : ''}`}>
                  <span className="spec-bind-cat">
                    <span className="spec-bind-cat-icon">
                      <PlatformIcon platform={cat.platformKey} size={15} />
                    </span>
                    <span className="spec-bind-cat-name">{cat.name}</span>
                  </span>
                  <USelect
                    className={`spec-bind-select${bound ? ' is-bound' : ''}`}
                    value={bound}
                    onChange={(v) => setBind(cat.id, v)}
                    options={opts}
                  />
                </div>
              )
            })}
          </div>
        )}

        <div className="modal-actions">
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleSave}>
            {t('save')}
          </button>
        </div>
      </div>
    </div>
  )
}
