import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

/** 引导弹窗触发事件名：任意截图入口检测到 macOS 录屏权限未授权时派发，组件挂载在 App 根部统一响应 */
const GUIDE_EVENT = 'screen-permission-guide'

/** 任意截图入口检测到 macOS 录屏权限未授权时调用，弹出权限引导弹窗（TRAE CN 风格） */
export function showScreenPermissionGuide(): void {
  window.dispatchEvent(new CustomEvent(GUIDE_EVENT))
}

/** 权限状态轮询间隔（ms）：在系统设置完成授权后 1s 内自动感知 */
const POLL_INTERVAL = 1000
/** 授权成功提示展示时长（ms），随后自动关闭 */
const GRANTED_TOAST_MS = 1600

/**
 * macOS 录屏权限引导弹窗（参考 TRAE CN 获取录屏权限的样式与交互）：
 * 步骤指引 + 可拖拽应用图标（按住发起 .app 原生拖拽，可拖入系统设置
 * 「隐私与安全性 → 录屏与系统录音」的应用列表完成授权）+ 打开系统设置快捷入口。
 * 授权成功后自动感知并关闭。
 */
export default function ScreenPermissionGuide() {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const [granted, setGranted] = useState(false)
  const [appName, setAppName] = useState('')
  const [iconDataUrl, setIconDataUrl] = useState('')

  const close = useCallback(() => {
    setOpen(false)
    setGranted(false)
  }, [])

  /** 监听全局唤起事件 */
  useEffect(() => {
    const onOpen = () => {
      setGranted(false)
      setOpen(true)
    }
    window.addEventListener(GUIDE_EVENT, onOpen)
    return () => window.removeEventListener(GUIDE_EVENT, onOpen)
  }, [])

  /** 弹窗打开时拉取应用图标与名称 */
  useEffect(() => {
    if (!open) return
    window.electronAPI
      .getAppInfo()
      .then((info) => {
        setAppName(info.name)
        setIconDataUrl(info.iconDataUrl)
      })
      .catch(() => undefined)
  }, [open])

  /** 权限轮询：授权成功 → 展示成功态 */
  useEffect(() => {
    if (!open || granted) return
    let stopped = false
    const timer = window.setInterval(() => {
      window.electronAPI
        .screenPermissionStatus()
        .then((status) => {
          if (!stopped && status === 'granted') setGranted(true)
        })
        .catch(() => undefined)
    }, POLL_INTERVAL)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [open, granted])

  /** 授权成功态展示 1.6s 后自动关闭 */
  useEffect(() => {
    if (!granted) return
    const timer = window.setTimeout(close, GRANTED_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [granted, close])

  /** Esc 关闭 */
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, close])

  /** 按住图标 → 主进程发起 .app 包原生拖拽（用户可拖入系统设置列表） */
  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault()
    void window.electronAPI.startAppDrag()
  }

  if (!open) return null

  return (
    <div className="modal-mask" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal screen-perm-modal">
        <button type="button" className="screen-perm-close" onClick={close} title={t('close')}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        {granted ? (
          <div className="screen-perm-granted">
            <div className="screen-perm-granted-icon">
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </div>
            <div className="screen-perm-granted-title">{t('perm.granted')}</div>
            <div className="screen-perm-granted-desc">{t('perm.grantedDesc')}</div>
          </div>
        ) : (
          <>
            {/* 头部：图标 + 标题 + 说明 */}
            <div className="screen-perm-head">
              <div className="screen-perm-head-icon">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <rect x="2" y="4" width="20" height="14" rx="2" />
                  <path d="m10 9 5 2-5 2z" />
                  <path d="M8 22h8" />
                </svg>
              </div>
              <div className="screen-perm-head-text">
                <h3>{t('perm.title')}</h3>
                <p>{t('perm.desc')}</p>
              </div>
            </div>

            {/* 步骤指引 */}
            <ol className="screen-perm-steps">
              <li>{t('perm.step1')}</li>
              <li>{t('perm.step2')}</li>
              <li>{t('perm.step3')}</li>
            </ol>

            {/* 可拖拽应用图标：按住发起 .app 原生拖拽，拖入系统设置列表完成授权 */}
            <div className="screen-perm-drag-zone">
              <div
                className="screen-perm-drag-chip"
                onMouseDown={handleDragStart}
                title={t('perm.dragHint')}
              >
                {iconDataUrl ? (
                  <img src={iconDataUrl} alt={appName} draggable={false} />
                ) : (
                  <div className="screen-perm-drag-placeholder">
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                      <rect x="3" y="3" width="18" height="18" rx="4" />
                    </svg>
                  </div>
                )}
                <span className="screen-perm-drag-name">{appName}</span>
              </div>
              <div className="screen-perm-drag-hint">
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                  <path d="M9 11.5V5a1.5 1.5 0 0 1 3 0v6" />
                  <path d="M12 11V9.5a1.5 1.5 0 0 1 3 0V13" />
                  <path d="M15 13v-1.5a1.5 1.5 0 0 1 3 0V15a6 6 0 0 1-6 6h-1a6 6 0 0 1-6-6v-3a1.5 1.5 0 0 1 3 0" />
                </svg>
                {t('perm.dragHint')}
              </div>
            </div>

            {/* 操作区 */}
            <div className="screen-perm-actions">
              <button type="button" className="btn-secondary" onClick={close}>
                {t('perm.done')}
              </button>
              <button
                type="button"
                className="btn-primary"
                onClick={() => void window.electronAPI.openScreenPermissionSettings()}
              >
                {t('perm.openSettings')}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
