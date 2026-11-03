import SwiftUI

/// 应用根视图：侧边栏导航 + 内容区路由
/// 对齐 Electron 版 [App.tsx] 路由结构与 [Layout.tsx] 左侧项目树
/// 侧边栏：AppSidebar (200px 白底 + 导航圆点)
/// 顶栏：AppTopBar (52px + 红绿灯 + 搜索 + 品牌)
struct RootView: View {
    @State private var appState = AppState()
    @State private var sidebarCollapsed = false
    @State private var searchText = ""

    var body: some View {
        HStack(spacing: 0) {
            // 左侧导航栏（对齐 Electron .app-sidebar）
            AppSidebar(
                selection: $appState.section,
                isCollapsed: $sidebarCollapsed,
                logoImage: nil,
                versionText: "v1.0.0"
            )

            // 主内容区
            VStack(spacing: 0) {
                // 顶栏
                AppTopBar(
                    title: appState.section.title,
                    showSearch: true,
                    searchText: $searchText
                )

                // 内容路由
                contentForSection(appState.section)
            }
            .background(Color.appBg)
        }
        .environment(appState)
        .frame(minWidth: 1100, minHeight: 700)
    }

    @ViewBuilder
    private func contentForSection(_ section: AppSection) -> some View {
        switch section {
        case .projects:
            ProjectsHomeView()
        case .recent:
            ComingSoonView(title: "最近访问", hint: "对应 Electron 版 RecentAccess")
        case .compare:
            CompareWorkbenchView()
        case .reports:
            if let pid = appState.reportExportPageID {
                ExportReportView(pageId: pid)
            } else {
                ReportsHomeView()
            }
        case .specs:
            SpecSpaceView()
        case .settings:
            SettingsView()
        }
    }
}

/// 侧边栏一级导航（与 Electron 版 Layout 侧边栏条目对齐）
enum AppSection: String, CaseIterable, Identifiable, Hashable {
    case projects
    case recent
    case compare
    case reports
    case specs
    case settings

    var id: String { rawValue }

    var title: String {
        switch self {
        case .projects: "项目"
        case .recent: "最近访问"
        case .compare: "对比工作台"
        case .reports: "分析报告"
        case .specs: "设计规范"
        case .settings: "设置"
        }
    }

    var icon: String {
        switch self {
        case .projects: "folder"
        case .recent: "clock"
        case .compare: "square.split.2x1"
        case .reports: "doc.text.magnifyingglass"
        case .specs: "paintbrush"
        case .settings: "gearshape"
        }
    }
}

/// 里程碑占位页：使用 AppEmptyState 替代默认 ContentUnavailableView
struct ComingSoonView: View {
    let title: String
    var hint: String

    var body: some View {
        AppEmptyState(
            title,
            description: hint,
            systemImage: "hammer"
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    RootView()
}
