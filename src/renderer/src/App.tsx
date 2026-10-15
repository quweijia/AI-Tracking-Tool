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

export default function App() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<ProjectList />} />
        <Route path="/recent" element={<RecentAccess />} />
        <Route path="/project/:projectId" element={<ProjectDetail />} />
        <Route path="/project/:projectId/new" element={<NewWalkthrough />} />
        <Route path="/project/:projectId/page/:pageId" element={<CompareWorkbench />} />
        <Route path="/project/:projectId/page/:pageId/issues" element={<IssueList />} />
        <Route path="/project/:projectId/page/:pageId/export" element={<ExportReport />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  )
}
