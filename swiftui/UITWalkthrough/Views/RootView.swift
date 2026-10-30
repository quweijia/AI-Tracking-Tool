import SwiftUI

/// 应用根视图：侧边栏导航 + 内容区路由
/// （对齐 Electron 版 [App.tsx] 路由结构与 [Layout.tsx] 左侧项目树）
struct RootView: View {
    @State private var appState = AppState()

    var body: some View {
        @Bindable var appState = appState
        NavigationSplitView {
            // 侧边栏切换到其他节时清掉报告导出目标，回到报告列表
            List(selection: Binding(
                get: { appState.section },
                set: {
                    if $0 != appState.section { appState.reportExportPageID = nil }
                    appState.section = $0
                }
            )) {
                Section {
                    ForEach(AppSection.allCases) { section in
                        Label(section.title, systemImage: section.icon)
                            .tag(section)
                    }
                }
            }
            .navigationSplitViewColumnWidth(min: 200, ideal: 230, max: 320)
            .listStyle(.sidebar)
        } detail: {
            switch appState.section {
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
        .environment(appState)
        .frame(minWidth: 1100, minHeight: 700)
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

/// 里程碑占位页：标注对应待迁移的 Electron 模块
struct ComingSoonView: View {
    let title: String
    var hint: String

    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: "hammer")
        } description: {
            Text(hint)
        }
    }
}

#Preview {
    RootView()
}
