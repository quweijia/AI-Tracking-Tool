import SwiftUI
import SwiftData

/// 应用级状态：替代 Electron IPC 事件总线的全局选中态（@Observable 单向数据流）。
/// 视图层只读状态 + 调用方法变更，数据变更统一经 ModelContext 落 SwiftData。
@MainActor
@Observable
final class AppState {
    /// 侧边栏一级导航当前节
    var section: AppSection = .projects
    /// 当前打开的项目（项目详情/工作台共用）
    var activeProjectID: String?
    /// 当前打开的页面（对比工作台目标）
    var activePageID: String?

    /// 打开页面：记录访问（visits 表）+ 切到对比工作台
    func open(page: WalkthroughPage, context: ModelContext) {
        activeProjectID = page.projectId
        activePageID = page.id
        section = .compare
        context.insert(Visit(pageId: page.id, projectId: page.projectId))
        try? context.save()
    }

    /// 关闭页面回到项目详情
    func closePage() {
        activePageID = nil
        section = .projects
    }
}
