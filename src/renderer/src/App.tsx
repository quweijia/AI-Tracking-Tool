import { useEffect, useRef, type ReactNode } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import Layout from './components/Layout'
import ProjectList from './pages/ProjectList'
import ProjectDetail from './pages/ProjectDetail'
import NewWalkthrough from './pages/NewWalkthrough'
import CompareWorkbench from './pages/CompareWorkbench'
import IssueList from './pages/IssueList'
import ExportReport from './pages/ExportReport'
import Settings from './pages/Settings'
import RecentAccess from './pages/RecentAccess'
import ReportsPage from './pages/ReportsPage'
import TrashPage from './pages/TrashPage'
import SpecCategoryPage, { SpecsCategoryIndex, SpecsIndex } from './pages/SpecCategoryPage'
import BrowserPopupPage from './pages/BrowserPopupPage'
import ProductHome from './pages/ProductHome'
import ProductProjectDetail from './pages/ProductProjectDetail'
import ProductAnnotationCanvasPage from './pages/ProductAnnotationCanvasPage'
import ProductExportReport from './pages/ProductExportReport'
import ScreenPermissionGuide from './components/ScreenPermissionGuide'
import { useProductModeStore } from './stores/productMode'
import { purgeExpiredTrash } from './db/trashCleanup'

/** 走查侧路由前缀：产品模式下这些页面属于被隐藏菜单，守卫统一重定向到产品标注首页（/recent、/reports 两种模式共用，不拦截） */
const WALK_ROUTE_RE = /^\/($|specs|new|project)/

/** 产品模式路由守卫：配置加载完成后按模式拦截走查路由 / 收回 /product 入口（/settings、/browser 不拦截） */
function ProductModeRouteGuard({ children }: { children?: ReactNode }) {
  const loaded = useProductModeStore((s) => s.loaded)
  const enabled = useProductModeStore((s) => s.enabled)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    if (!loaded) return
    if (enabled && WALK_ROUTE_RE.test(location.pathname)) {
      console.log(`[PRODUCT_MODE] route guard: redirect ${location.pathname} -> /product`)
      navigate('/product', { replace: true })
    } else if (!enabled && location.pathname.startsWith('/product')) {
      console.log(`[PRODUCT_MODE] route guard: redirect ${location.pathname} -> /`)
      navigate('/', { replace: true })
    }
  }, [loaded, enabled, location.pathname, navigate])

  return <>{children}</>
}

export default function App() {
  // 全局接管 Cmd/Ctrl+A 全选（Mac/Windows 统一）：焦点在输入框 / 文本域 / contenteditable 内时
  // 手动执行全选（应用菜单未注册 selectAll 角色，Mac 原生命令不会派发进输入框）；其余焦点
  // （画布、普通展示文字、空白区域）一律 preventDefault，配合画布容器的 user-select:none
  // 阻止误选。内置 webview 是独立渲染进程，其内部快捷键不经过此监听，不受影响
  useEffect(() => {
    const isEditableTarget = (t: EventTarget | null): boolean => {
      const el = t as HTMLElement | null
      return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key !== 'a' && e.key !== 'A') return
      if (!(e.metaKey || e.ctrlKey)) return
      const el = e.target as HTMLElement | null
      if (isEditableTarget(el)) {
        // 应用菜单未注册 selectAll 角色：Mac 原生 Cmd+A 不会派发进输入框，需手动全选
        e.preventDefault()
        if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
          ;(el as HTMLInputElement).select()
        } else {
          document.execCommand('selectAll')
        }
        return
      }
      e.preventDefault()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  // 启动时加载产品模式开关（electron config 持久化），加载完成后路由守卫与 UI 才生效
  useEffect(() => {
    useProductModeStore.getState().load()
    // 回收站保留期扫描：过期软删项静默彻底删除 + 孤儿文件回收（失败仅 [TRASH] 日志，不抛错）
    void purgeExpiredTrash()
  }, [])

  // 启动默认进入最近访问页面：模式开关在 load() 中已按上次退出状态恢复，/recent 两种模式
  // 共用且内容随模式切换（路由守卫不拦截）；仅在初始落地路由 `/` 时接管一次，用户手动回 `/` 不再劫持
  const loaded = useProductModeStore((s) => s.loaded)
  const bootLocation = useLocation()
  const bootNavigate = useNavigate()
  const bootNavigated = useRef(false)
  useEffect(() => {
    if (!loaded || bootNavigated.current || bootLocation.pathname !== '/') return
    bootNavigated.current = true
    bootNavigate('/recent', { replace: true })
  }, [loaded, bootLocation.pathname, bootNavigate])

  return (
    <>
      {/* macOS 录屏权限引导弹窗：全局单例，截图入口检测到权限缺失时唤起（含 /browser 弹窗页） */}
      <ScreenPermissionGuide />
      <Routes>
      {/* 独立开发浏览器弹窗：无侧边栏/顶栏的裸页面 */}
      <Route path="/browser" element={<BrowserPopupPage />} />
      <Route
        path="*"
        element={
          <ProductModeRouteGuard>
            <Layout>
              <Routes>
                {/* 产品标注首页（阶段 1 占位页，阶段 2 替换为产品项目管理列表） */}
                <Route path="/product" element={<ProductHome />} />
                <Route path="/product/:projectId" element={<ProductProjectDetail />} />
                <Route path="/product/:projectId/set/:setId" element={<ProductAnnotationCanvasPage />} />
                <Route path="/product/:projectId/export" element={<ProductExportReport />} />
                <Route path="/" element={<ProjectList />} />
                <Route path="/recent" element={<RecentAccess />} />
                <Route path="/reports" element={<ReportsPage />} />
                {/* 回收站：两种模式共用路由，页面内部按模式读取各自数据库（数据严格隔离） */}
                <Route path="/trash" element={<TrashPage />} />
                <Route path="/specs" element={<SpecsIndex />} />
                {/* 端分类总览：该端多套规范卡片 */}
                <Route path="/specs/:categoryId" element={<SpecsCategoryIndex />} />
                {/* 规范详情：来源 / 版本 / Token / 绑定 */}
                <Route path="/specs/:categoryId/spec/:specId" element={<SpecCategoryPage />} />
                <Route path="/new" element={<NewWalkthrough />} />
                <Route path="/project/:projectId" element={<ProjectDetail />} />
                <Route path="/project/:projectId/new" element={<NewWalkthrough />} />
                <Route path="/project/:projectId/page/:pageId" element={<CompareWorkbench />} />
                <Route path="/project/:projectId/page/:pageId/issues" element={<IssueList />} />
                <Route path="/project/:projectId/page/:pageId/export" element={<ExportReport />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="*" element={<Navigate to="/" replace />} />
              </Routes>
            </Layout>
          </ProductModeRouteGuard>
        }
      />
      </Routes>
    </>
  )
}
