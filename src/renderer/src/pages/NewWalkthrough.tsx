import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { db, genId, Platform, PLATFORM_LABELS, Folder } from '../db'
import USelect from '../components/USelect'

interface PickedImage {
  relativePath: string
  dataUrl: string
}

/** 文件夹下拉选项显示层级路径（如「设计规范 / AI 赋能」） */
function folderLabel(f: Folder, all: Folder[]): string {
  let label = f.name
  let cur = f
  const seen = new Set<string>()
  while (cur.parentId && !seen.has(cur.parentId)) {
    seen.add(cur.parentId)
    const parent = all.find((x) => x.id === cur.parentId)
    if (!parent) break
    label = `${parent.name} / ${label}`
    cur = parent
  }
  return label
}

export default function NewWalkthrough() {
  const { t } = useTranslation('newWalkthrough')
  /** 路由携带项目时（/project/:projectId/new）为指定项目；/new 为通用入口（需先选择项目） */
  const routeProjectId = useParams<{ projectId: string }>().projectId
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialFolderId = searchParams.get('folderId') ?? ''

  const projects = useLiveQuery(() => db.projects.toArray(), [])
  const [projectId, setProjectId] = useState(routeProjectId ?? '')
  const effectiveProjectId = routeProjectId ?? projectId

  const folders = useLiveQuery(
    () => (effectiveProjectId ? db.folders.where('projectId').equals(effectiveProjectId).toArray() : []),
    [effectiveProjectId]
  )

  const [folderId, setFolderId] = useState(initialFolderId)
  const [pageName, setPageName] = useState('')
  const [platform, setPlatform] = useState<Platform>('h5')
  const [figmaUrl, setFigmaUrl] = useState('')
  /** 开发环境页面 URL（可选，自动走查用） */
  const [devUrl, setDevUrl] = useState('')
  const [design, setDesign] = useState<PickedImage | null>(null)
  const [screenshot, setScreenshot] = useState<PickedImage | null>(null)

  /** 通用入口切换项目时清空文件夹选择（避免残留其他项目的文件夹） */
  useEffect(() => {
    setFolderId(routeProjectId ? initialFolderId : '')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveProjectId])

  const pickImage = async (target: 'design' | 'screenshot') => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    if (target === 'design') setDesign(result)
    else setScreenshot(result)
  }

  /** 双图已传齐，或已填写 Figma 链接 + 开发环境 URL（自动走查可现场采集）时即可创建 */
  const hasUrls = figmaUrl.trim() !== '' && devUrl.trim() !== ''

  /** 同层级命名查重：同一项目、同一文件夹下的其他页面同名时提示并支持跳转 */
  const duplicatePage = useLiveQuery(() => {
    const t = pageName.trim()
    if (!effectiveProjectId || !t) return undefined
    return db.pages
      .filter(
        (p) =>
          p.projectId === effectiveProjectId &&
          (p.folderId ?? '') === (folderId || '') &&
          p.pageName === t
      )
      .first()
  }, [pageName, effectiveProjectId, folderId])

  const canSubmit =
    effectiveProjectId !== '' && pageName.trim() !== '' && !duplicatePage &&
    ((design !== null && screenshot !== null) || hasUrls)

  const handleSubmit = async () => {
    if (!effectiveProjectId || !canSubmit) return
    // Figma 链接非必填；未带协议时自动补 https://
    const trimmedUrl = figmaUrl.trim()
    const normalizedUrl =
      trimmedUrl && !/^https?:\/\//i.test(trimmedUrl) ? `https://${trimmedUrl}` : trimmedUrl
    const trimmedDev = devUrl.trim()
    const normalizedDev =
      trimmedDev && !/^https?:\/\//i.test(trimmedDev) ? `http://${trimmedDev}` : trimmedDev
    const pageId = genId()
    await db.pages.add({
      id: pageId,
      folderId: folderId || undefined,
      projectId: effectiveProjectId,
      pageName: pageName.trim(),
      platform,
      figmaUrl: normalizedUrl || undefined,
      devUrl: normalizedDev || undefined,
      designImagePath: design?.relativePath ?? '',
      screenshotPath: screenshot?.relativePath ?? '',
      status: 'reviewing',
      createdAt: Date.now()
    })
    navigate(`/project/${effectiveProjectId}/page/${pageId}`)
  }

  return (
    <div className="page">
      <div className="page-header">
        <div className="settings-head-left">
          {/* 返回按钮：样式与设置页一致，返回进入前的页面（如最近访问） */}
          <button type="button" className="settings-close" title={t('back')} onClick={() => navigate(-1)}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <h1>{t('title')}</h1>
        </div>
      </div>

      <div className="card wizard-body">
        {/* 通用入口（/new）：先选择项目，再选择所属文件夹 */}
        {!routeProjectId && (
          <>
            <label className="field-label">{t('projectLabel')}</label>
            <USelect
              value={projectId}
              onChange={setProjectId}
              placeholder={t('selectProjectFirst')}
              options={[
                { value: '', label: t('selectProjectFirst') },
                ...(projects ?? []).map((p) => ({ value: p.id, label: p.name }))
              ]}
            />
          </>
        )}

        <label className="field-label">{t('folderLabel')}</label>
        <USelect
          value={folderId}
          onChange={setFolderId}
          placeholder={effectiveProjectId ? t('ungrouped') : t('selectProjectFirst')}
          options={[
            { value: '', label: t('ungroupedOption') },
            ...(folders ?? []).map((v) => ({ value: v.id, label: folderLabel(v, folders ?? []) }))
          ]}
        />

        <label className="field-label">{t('pageNameLabel')}</label>
        <input
          className="input"
          placeholder={t('pageNamePlaceholder')}
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />
        {duplicatePage && (
          <div className="dup-hint">
            <span>{t('duplicatePageMsg')}</span>
            <button
              type="button"
              className="btn-text"
              onClick={() => navigate(`/project/${effectiveProjectId}/page/${duplicatePage.id}`)}
            >
              {t('openPage')}
            </button>
          </div>
        )}

        <label className="field-label">{t('platformLabel')}</label>
        <div className="segmented">
          {(Object.keys(PLATFORM_LABELS) as Platform[]).map((k) => (
            <button
              key={k}
              type="button"
              className={`segment-item${platform === k ? ' active' : ''}`}
              onClick={() => setPlatform(k)}
            >
              {t(`platform_${k}`)}
            </button>
          ))}
        </div>

        <label className="field-label">{t('figmaLabel')}</label>
        <input
          className="input"
          placeholder={t('figmaPlaceholder')}
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
        />

        <label className="field-label">{t('devUrlLabel')}</label>
        <input
          className="input"
          placeholder={t('devUrlPlaceholder')}
          value={devUrl}
          onChange={(e) => setDevUrl(e.target.value)}
        />

        <div className="upload-row">
          <div className="upload-box">
            <p className="field-label">{t('designLabel')}</p>
            <button className="btn-primary" onClick={() => pickImage('design')}>
              {t('chooseImage')}
            </button>
            {design && (
              <div className="image-preview">
                <img src={design.dataUrl} alt={t('designAlt')} />
                <span className="ok-label">{t('uploaded')}</span>
              </div>
            )}
          </div>
          <div className="upload-box">
            <p className="field-label">{t('screenshotLabel')}</p>
            <button className="btn-primary" onClick={() => pickImage('screenshot')}>
              {t('chooseImage')}
            </button>
            {screenshot && (
              <div className="image-preview">
                <img src={screenshot.dataUrl} alt={t('screenshotAlt')} />
                <span className="ok-label">{t('uploaded')}</span>
              </div>
            )}
          </div>
        </div>

        <div className="wizard-actions">
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            {t('cancel')}
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            {t('startWalkthrough')}
          </button>
        </div>
      </div>
    </div>
  )
}
