import { Routes, Route, Navigate } from 'react-router-dom'
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
import SpecCategoryPage, { SpecsCategoryIndex, SpecsIndex } from './pages/SpecCategoryPage'
import BrowserPopupPage from './pages/BrowserPopupPage'

export default function App() {
  return (
    <Routes>
      {/* 独立开发浏览器弹窗：无侧边栏/顶栏的裸页面 */}
      <Route path="/browser" element={<BrowserPopupPage />} />
      <Route
        path="*"
        element={
          <Layout>
            <Routes>
              <Route path="/" element={<ProjectList />} />
              <Route path="/recent" element={<RecentAccess />} />
              <Route path="/reports" element={<ReportsPage />} />
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
        }
      />
    </Routes>
  )
}
