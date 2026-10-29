import SwiftData
import SwiftUI

@main
struct UITWalkthroughApp: App {
    /// SwiftData 容器：13 个 @Model 一一镜像 Electron Dexie 13 表
    let container: ModelContainer

    init() {
        do {
            container = try ModelContainer(
                for: Project.self, Folder.self, WalkthroughPage.self, Visit.self, ReportRecord.self,
                Issue.self,
                SpecCategory.self, DesignSpec.self, SpecVersion.self, SpecToken.self,
                ProjectSpecBinding.self, SpecTokenMapping.self,
                AssistantMessage.self
            )
        } catch {
            fatalError("SwiftData 容器初始化失败: \(error)")
        }
    }

    var body: some Scene {
        WindowGroup("UI 走查工具") {
            RootView()
                .modelContainer(container)
        }
    }
}
