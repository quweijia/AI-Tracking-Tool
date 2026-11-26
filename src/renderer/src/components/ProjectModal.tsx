import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useLiveQuery } from 'dexie-react-hooks'
import { useTranslation } from 'react-i18next'
import {
  db,
  softDeleteProjects,
  genId,
  Platform,
  PLATFORM_LABELS,
  Project,
  platformList,
  DesignSpec,
  type ProjectSpecBinding
} from '../db'
import { confirmDialog } from './ConfirmDialog'
import { showToast } from './Toast'
import { PlatformIcon } from './PlatformBadge'
import { LOGO_COLORS, logoColorOf } from './ProjectCard'
import LogoCropper from './LogoCropper'
import USelect from './USelect'

interface Props {
  /** 传 project 为编辑模式，否则为新建 */
  project?: Project
  onDone: () => void
  onCancel: () => void
}

const PLATFORM_KEYS = Object.keys(PLATFORM_LABELS) as Platform[]

/** 设计规范菜单开关缓存：记录上次读取结果，弹窗再次打开时首帧即命中正确状态；null = 尚未读取过（不渲染绑定区块） */
let specMenuOnCache: boolean | null = null

/** 读取设计规范菜单开关并写入模块缓存 */
const refreshSpecMenuCache = () =>
  window.electronAPI
    .getConfig()
    .then((cfg) => {
      specMenuOnCache = cfg.specMenuEnabled !== false
    })
    .catch(() => {
      // 配置读取失败（如文件损坏）时按默认开启兜底，避免弹窗渲染门闸等一个永不就绪的结果
      specMenuOnCache = true
    })

// 模块加载即预读开关并常驻监听变更：本模块被项目列表/新建走查/项目详情静态导入，应用启动即加载，
// 预读在用户点开弹窗之前完成，开启/关闭两种状态下首帧都能渲染出正确高度，弹窗不再跳动；
// 设置页切换开关时弹窗可能未挂载（组件内监听收不到），需在模块级同步缓存
void refreshSpecMenuCache()
window.addEventListener('spec-menu-change', refreshSpecMenuCache)

/** 新建 / 编辑项目弹窗：名称、适用端类型（多选）、项目 Logo；删除项目入口收进编辑弹窗 */
export default function ProjectModal({ project, onDone, onCancel }: Props) {
  const { t } = useTranslation('projectModal')
  const navigate = useNavigate()
  const [name, setName] = useState(project?.name ?? '')
  const [platforms, setPlatforms] = useState<Platform[]>(() => {
    const list = platformList(project?.platform)
    return list.length ? list : ['h5']
  })
  const [logo, setLogo] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 无 Logo 时文字占位底色（'' = 自动按项目散列取色） */
  const [logoColor, setLogoColor] = useState(project?.logoColor ?? '')
  /** 待裁剪的原图（选图后先进裁剪确认；含临时文件路径，结束时清理） */
  const [pendingOriginal, setPendingOriginal] = useState<{ relativePath: string; dataUrl: string } | null>(null)
  /** 待裁剪的原图 dataUrl（驱动裁剪弹层显示） */
  const [cropping, setCropping] = useState<string | null>(null)
  /** 规范绑定：端分类 id → 规范套 id（'' = 不绑定） */
  const [bindByCategory, setBindByCategory] = useState<Record<string, string>>({})
  /** 设计规范菜单开关（设置页「通用」控制）：null = 配置未就绪，首帧不渲染绑定区块，避免关闭状态下「先显示再消失」的闪烁 */
  const [specMenuOn, setSpecMenuOn] = useState<boolean | null>(specMenuOnCache)

  // 绑定选择器数据：端分类、规范套、编辑模式下的已有绑定。
  // 保留 useLiveQuery 原始 undefined 语义（undefined = Dexie 数据仍在加载）：若在这里 ?? [] 兜底，
  // 首帧会把「加载中」误判为「无规范套」先渲染矮的空态框，数据到达后再换成高网格，弹窗高度会「弹一下」
  const categoriesQ = useLiveQuery(() => db.specCategories.toArray(), [])
  const specsQ = useLiveQuery(() => db.designSpecs.toArray(), [])
  const bindingsQ = useLiveQuery(
    () =>
      project
        ? db.projectSpecBindings.where('projectId').equals(project.id).toArray()
        : Promise.resolve<ProjectSpecBinding[]>([]),
    [project?.id]
  )
  const categories = categoriesQ ?? []
  const specs = specsQ ?? []
  const bindings = bindingsQ ?? []
  // 弹窗渲染门闸：菜单开关配置 + 三份数据全部就绪才渲染，弹窗出现即最终高度
  const dataReady = specMenuOn !== null && categoriesQ !== undefined && specsQ !== undefined && bindingsQ !== undefined

  // 编辑模式：读取已保存的 Logo 作为初始预览（否则弹窗里只显示文字占位）
  useEffect(() => {
    const p = project?.logoPath
    if (!p) return
    let alive = true
    window.electronAPI
      .readImage(p)
      .then((d) => {
        if (alive && d) setLogo({ relativePath: p, dataUrl: d })
      })
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [project?.logoPath])

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  // 设计规范菜单开关联动：初次读取 config，设置页切换后经 spec-menu-change 事件即时同步（与侧边栏同一机制）
  useEffect(() => {
    const refresh = () => {
      void window.electronAPI
        .getConfig()
        .then((cfg) => {
          const on = cfg.specMenuEnabled !== false
          specMenuOnCache = on
          setSpecMenuOn(on)
        })
        .catch(() => {
          // 配置读取失败时按默认开启兜底，保证弹窗不被「未就绪」门闸永久阻塞
          specMenuOnCache = true
          setSpecMenuOn(true)
        })
    }
    refresh()
    window.addEventListener('spec-menu-change', refresh)
    return () => window.removeEventListener('spec-menu-change', refresh)
  }, [])

  const togglePlatform = (k: Platform) => {
    setPlatforms((prev) => (prev.includes(k) ? prev.filter((x) => x !== k) : [...prev, k]))
  }

  // 规范套 id → 所属端分类 id（绑定反查用）
  const specCatOf = useMemo(() => new Map(specs.map((s) => [s.id, s.categoryId])), [specs])

  // 编辑模式：已有绑定初始化为选中态（bindings 与 specs 都就绪后执行一次）
  useEffect(() => {
    if (!bindings) return
    const map: Record<string, string> = {}
    for (const b of bindings) {
      const catId = specCatOf.get(b.specId)
      if (catId) map[catId] = b.specId
    }
    setBindByCategory(map)
  }, [bindings, specCatOf])

  // 只显示项目所选端对应的分类（走查取套依据：page.platform → category.platformKey）
  const visibleCats = useMemo(
    () =>
      categories
        .filter((c) => platforms.includes(c.platformKey))
        .sort((a, b) => (a.sortNo ?? 0) - (b.sortNo ?? 0) || a.createdAt - b.createdAt),
    [categories, platforms]
  )

  // 规范套按分类分组
  const specsByCat = useMemo(() => {
    const m: Record<string, DesignSpec[]> = {}
    for (const s of specs) (m[s.categoryId] ??= []).push(s)
    return m
  }, [specs])

  const setBind = (catId: string, specId: string) => setBindByCategory((prev) => ({ ...prev, [catId]: specId }))

  const pickLogo = async () => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    // GIF 动图跳过裁剪（canvas 裁剪输出静态 PNG 会丢动画），直接采用 selectImage 已落盘的原图
    if (result.dataUrl.startsWith('data:image/gif')) {
      setLogo(result)
      return
    }
    // 选择后先进入裁剪界面，确认后再采用（原图临时文件在裁剪结束/取消时清理）
    setPendingOriginal(result)
    setCropping(result.dataUrl)
  }

  /** 裁剪确认：采用裁剪结果并清理原图临时文件 */
  const handleCropDone = async (relativePath: string, dataUrl: string) => {
    if (pendingOriginal) {
      await window.electronAPI.deleteImage(pendingOriginal.relativePath).catch(() => undefined)
    }
    setPendingOriginal(null)
    setCropping(null)
    setLogo({ relativePath, dataUrl })
  }

  /** 裁剪取消：丢弃选图并清理原图临时文件 */
  const handleCropCancel = async () => {
    if (pendingOriginal) {
      await window.electronAPI.deleteImage(pendingOriginal.relativePath).catch(() => undefined)
    }
    setPendingOriginal(null)
    setCropping(null)
  }

  /** 命名查重：与其他项目同名（编辑时排除自身）时禁止保存，并提供跳转入口 */
  const duplicate = useLiveQuery(() => {
    const t = name.trim()
    if (!t) return undefined
    return db.projects.filter((p) => !p.deletedAt && p.name === t && p.id !== project?.id).first()
  }, [name, project?.id])

  const canSave = name.trim().length > 0 && platforms.length > 0 && !duplicate

  /** 编辑模式：删除整个项目（软删除进回收站，标注与文件保留，可在回收站还原）；删除后关闭弹窗并返回项目列表 */
  const handleDelete = async () => {
    if (!project) return
    const ok = await confirmDialog({ message: t('deleteConfirm', { name: project.name }), tone: 'danger' })
    if (!ok) return
    await softDeleteProjects([project.id])
    onDone()
    navigate('/')
    showToast(t('common:movedToTrash'), { tone: 'info' })
  }

  const handleSave = async () => {
    if (!canSave) return
    const nextLogoPath = logo?.relativePath ?? project?.logoPath
    // 先确定项目 id（新建也提前生成），绑定写入需要它
    const pid = project?.id ?? crypto.randomUUID()

    if (project) {
      // 替换 Logo 时清理旧图片文件
      if (project.logoPath && project.logoPath !== nextLogoPath) {
        await window.electronAPI.deleteImage(project.logoPath).catch(() => undefined)
      }
      await db.projects.update(project.id, {
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        logoColor: logoColor || undefined,
        updatedAt: Date.now()
      })
    } else {
      await db.projects.add({
        id: pid,
        name: name.trim(),
        platform: platforms,
        ...(nextLogoPath ? { logoPath: nextLogoPath } : {}),
        ...(logoColor ? { logoColor } : {}),
        createdAt: Date.now(),
        updatedAt: Date.now()
      })
    }

    // 规范绑定全删重建（仅保存当前所选端分类的选择；未选 = 不绑定）
    await db.transaction('rw', db.projectSpecBindings, async () => {
      await db.projectSpecBindings.where('projectId').equals(pid).delete()
      const rows = Object.entries(bindByCategory)
        .filter(([, specId]) => !!specId)
        .map(([, specId]) => ({ id: genId(), projectId: pid, specId, createdAt: Date.now() }))
      if (rows.length) await db.projectSpecBindings.bulkAdd(rows)
    })
    onDone()
  }

  // 数据未就绪：本帧不渲染弹窗，下一帧直接以最终高度出现（必须放在所有 hooks 之后，避免 hooks 数量变化）
  if (!dataReady) return null

  const avatarSrc = logo?.dataUrl ?? ''

  return (
    <>
      <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal project-modal">
        <h3>{project ? t('editTitle') : t('createTitle')}</h3>

        <label className="field-label">{t('logoLabel')}</label>
        <div className="logo-picker">
          {/* 上传/更换统一收口到点击 Logo 头像本身（已设置时悬停显示「更换 Logo」提示） */}
          <button
            className={`logo-avatar${avatarSrc ? ' has-logo' : ''}`}
            onClick={pickLogo}
            title={avatarSrc ? t('logoReplaceTitle') : t('logoPickTitle')}
            style={avatarSrc ? undefined : { background: logoColor || logoColorOf(project?.id ?? name) }}
          >
            {avatarSrc ? (
              <img src={avatarSrc} alt="" draggable={false} />
            ) : (
              <span>{name.trim().slice(0, 1) || '+'}</span>
            )}
          </button>
        </div>

        {!avatarSrc && (
          <>
            <label className="field-label">{t('logoColorLabel')}</label>
            <div className="logo-color-row">
              {LOGO_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`logo-color-dot${logoColor === c ? ' active' : ''}`}
                  style={{ background: c }}
                  onClick={() => setLogoColor(c)}
                  title={c}
                />
              ))}
            </div>
          </>
        )}

        <label className="field-label">{t('nameLabel')}</label>
        <input
          className="input"
          autoFocus
          placeholder={t('namePlaceholder')}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        {duplicate && (
          <div className="dup-hint">
            <span>{t('duplicateMsg')}</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => {
                onDone()
                navigate(`/project/${duplicate.id}`)
              }}
            >
              {t('openProject')}
            </button>
          </div>
        )}

        <label className="field-label">{t('platformLabel')}</label>
        <div className="platform-options">
          {PLATFORM_KEYS.map((k) => (
            <button
              key={k}
              type="button"
              className={`platform-option${platforms.includes(k) ? ' active' : ''}`}
              onClick={() => togglePlatform(k)}
            >
              <PlatformIcon platform={k} size={15} />
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>

        {/* 设计规范菜单关闭（设置页「通用」）时隐藏整个绑定区块；已保存的绑定数据保留不受影响 */}
        {specMenuOn && (
          <>
            <label className="field-label">{t('specBindLabel')}</label>
            {specs.length === 0 ? (
              <div className="spec-bind-empty">{t('specBindEmpty')}</div>
            ) : (
              <div className="spec-bind-grid">
                {visibleCats.map((cat) => {
                  const bound = bindByCategory[cat.id] ?? ''
                  const opts = [
                    { value: '', label: t('specBindNone') },
                    ...(specsByCat[cat.id] ?? []).map((s) => ({ value: s.id, label: s.name }))
                  ]
                  return (
                    <div key={cat.id} className="spec-bind-row">
                      <span className={`spec-bind-cat${bound ? ' bound' : ''}`}>
                        <PlatformIcon platform={cat.platformKey} size={13} />
                        {cat.name}
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
          </>
        )}

        <div className="modal-actions">
          {project && (
            <button className="btn-danger" onClick={handleDelete}>
              {t('deleteProject')}
            </button>
          )}
          <span className="modal-spacer" />
          <button className="btn-secondary" onClick={onCancel}>
            {t('cancel')}
          </button>
          <button className="btn-primary" disabled={!canSave} onClick={handleSave}>
            {project ? t('save') : t('create')}
          </button>
        </div>
      </div>
      </div>
      {/* Logo 裁剪弹层（覆盖在项目弹窗之上） */}
      {cropping && (
        <LogoCropper src={cropping} onCancel={handleCropCancel} onDone={handleCropDone} />
      )}
    </>
  )
}
