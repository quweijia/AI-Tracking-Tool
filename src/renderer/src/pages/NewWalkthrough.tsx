import { useLiveQuery } from 'dexie-react-hooks'
import { useParams, useNavigate, useSearchParams } from 'react-router-dom'
import { useState } from 'react'
import { db, genId, Platform, PLATFORM_LABELS } from '../db'
import USelect from '../components/USelect'

interface PickedImage {
  relativePath: string
  dataUrl: string
}

export default function NewWalkthrough() {
  const { projectId } = useParams<{ projectId: string }>()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const initialVersionId = searchParams.get('versionId') ?? ''

  const versions = useLiveQuery(
    () => db.versions.where('projectId').equals(projectId!).toArray(),
    [projectId]
  )

  const [versionId, setVersionId] = useState(initialVersionId)
  const [pageName, setPageName] = useState('')
  const [platform, setPlatform] = useState<Platform>('h5')
  const [figmaUrl, setFigmaUrl] = useState('')
  const [design, setDesign] = useState<PickedImage | null>(null)
  const [screenshot, setScreenshot] = useState<PickedImage | null>(null)

  const pickImage = async (target: 'design' | 'screenshot') => {
    const result = await window.electronAPI.selectImage()
    if (!result) return
    if (target === 'design') setDesign(result)
    else setScreenshot(result)
  }

  const canSubmit = versionId !== '' && pageName.trim() !== '' && design !== null && screenshot !== null

  const handleSubmit = async () => {
    if (!projectId || !canSubmit) return
    // Figma 链接非必填；未带协议时自动补 https://
    const trimmedUrl = figmaUrl.trim()
    const normalizedUrl =
      trimmedUrl && !/^https?:\/\//i.test(trimmedUrl) ? `https://${trimmedUrl}` : trimmedUrl
    const pageId = genId()
    await db.pages.add({
      id: pageId,
      versionId,
      projectId,
      pageName: pageName.trim(),
      platform,
      figmaUrl: normalizedUrl || undefined,
      designImagePath: design.relativePath,
      screenshotPath: screenshot.relativePath,
      status: 'reviewing',
      createdAt: Date.now()
    })
    navigate(`/project/${projectId}/page/${pageId}`)
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>新建走查页面</h1>
      </div>

      <div className="card wizard-body">
        <label className="field-label">所属版本</label>
        <USelect
          value={versionId}
          onChange={setVersionId}
          placeholder="请选择版本"
          options={[{ value: '', label: '请选择版本' }, ...(versions ?? []).map((v) => ({ value: v.id, label: v.name }))]}
        />

        <label className="field-label">页面名称</label>
        <input
          className="input"
          placeholder="如：登录页、首页、个人中心"
          value={pageName}
          onChange={(e) => setPageName(e.target.value)}
        />

        <label className="field-label">端类型</label>
        <USelect
          value={platform}
          onChange={(v) => setPlatform(v as Platform)}
          options={(Object.keys(PLATFORM_LABELS) as Platform[]).map((k) => ({ value: k, label: PLATFORM_LABELS[k] }))}
        />

        <label className="field-label">设计稿 Figma 链接（可选）</label>
        <input
          className="input"
          placeholder="如：https://www.figma.com/file/xxxx/页面名，报告中可点击跳转"
          value={figmaUrl}
          onChange={(e) => setFigmaUrl(e.target.value)}
        />

        <div className="upload-row">
          <div className="upload-box">
            <p className="field-label">① 设计稿（Figma 导出 PNG）</p>
            <button className="btn-primary" onClick={() => pickImage('design')}>
              选择图片
            </button>
            {design && (
              <div className="image-preview">
                <img src={design.dataUrl} alt="设计稿" />
                <span className="ok-label">已上传</span>
              </div>
            )}
          </div>
          <div className="upload-box">
            <p className="field-label">② 开发截图（支持长图）</p>
            <button className="btn-primary" onClick={() => pickImage('screenshot')}>
              选择图片
            </button>
            {screenshot && (
              <div className="image-preview">
                <img src={screenshot.dataUrl} alt="开发截图" />
                <span className="ok-label">已上传</span>
              </div>
            )}
          </div>
        </div>

        <div className="wizard-actions">
          <button className="btn-secondary" onClick={() => navigate(-1)}>
            取消
          </button>
          <button className="btn-primary" onClick={handleSubmit} disabled={!canSubmit}>
            开始走查
          </button>
        </div>
      </div>
    </div>
  )
}
