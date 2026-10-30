import Foundation
import SwiftData

/// 级联删除：一一镜像 db/index.ts 的 deletePagesCascade / deleteProjectCascade / deleteFolderCascade /
/// deleteSpecCascade / deleteSpecCategoryCascade（先删本地图片文件失败不阻塞，再删记录）。
@MainActor
enum Cascade {
    /// 级联删除一组页面：删图片文件（含复验截图）→ 删访问记录/标注/页面
    static func deletePages(_ pageIDs: [String], context: ModelContext) {
        guard !pageIDs.isEmpty else { return }
        let idSet = Set(pageIDs)
        let pages = fetchPages(context: context).filter { idSet.contains($0.id) }
        let issues = fetchIssues(context: context).filter { idSet.contains($0.pageId) }
        var imagePaths: [String] = []
        for p in pages {
            imagePaths.append(contentsOf: [p.designImagePath, p.screenshotPath])
            if let walkDesign = p.walkDesignPath { imagePaths.append(walkDesign) }
            if let walkShot = p.walkShotPath { imagePaths.append(walkShot) }
        }
        for i in issues {
            if let fix = i.fixScreenshotPath { imagePaths.append(fix) }
        }
        imagePaths.forEach { ImageStore.delete($0) }
        fetchVisits(context: context).filter { idSet.contains($0.pageId) }.forEach { context.delete($0) }
        issues.forEach { context.delete($0) }
        pages.forEach { context.delete($0) }
        try? context.save()
    }

    /// 级联删除项目：全部文件夹、页面、问题记录与图片文件，以及规范绑定关系与 Token 映射
    static func deleteProject(_ projectID: String, context: ModelContext) {
        let pageIDs = fetchPages(context: context)
            .filter { $0.projectId == projectID }
            .map(\.id)
        deletePages(pageIDs, context: context)
        fetchVisits(context: context).filter { $0.projectId == projectID }.forEach { context.delete($0) }
        fetchFolders(context: context).filter { $0.projectId == projectID }.forEach { context.delete($0) }
        fetchAll(ProjectSpecBinding.self, context: context)
            .filter { $0.projectId == projectID }.forEach { context.delete($0) }
        fetchAll(SpecTokenMapping.self, context: context)
            .filter { $0.projectId == projectID }.forEach { context.delete($0) }
        if let project = fetchAll(Project.self, context: context).first(where: { $0.id == projectID }) { context.delete(project) }
        try? context.save()
    }

    /// 级联删除分组文件夹：BFS 递归收集全部子孙文件夹（防环去重），
    /// 先删各层文件夹内页面（含标注与图片），再删所有文件夹记录
    static func deleteFolder(_ folderID: String, context: ModelContext) {
        var allIds: [String] = []
        var seen: Set<String> = [folderID]
        var frontier = [folderID]
        while !frontier.isEmpty {
            allIds.append(contentsOf: frontier)
            let children = fetchFolders(context: context)
                .filter { $0.parentId.map { frontier.contains($0) } == true && !seen.contains($0.id) }
            frontier = children.map(\.id)
            frontier.forEach { seen.insert($0) }
        }
        let idSet = Set(allIds)
        let pageIDs = fetchPages(context: context)
            .filter { $0.folderId.map { idSet.contains($0) } == true }
            .map(\.id)
        deletePages(pageIDs, context: context)
        fetchFolders(context: context).filter { idSet.contains($0.id) }.forEach { context.delete($0) }
        try? context.save()
    }

    /// 级联删除一套规范：绑定关系、全部历史版本的 Token、Token 映射、版本记录与规范行（.fig 存档保留不动）
    static func deleteSpec(_ specID: String, context: ModelContext) {
        fetchAll(ProjectSpecBinding.self, context: context)
            .filter { $0.specId == specID }.forEach { context.delete($0) }
        fetchAll(SpecToken.self, context: context)
            .filter { $0.specId == specID }.forEach { context.delete($0) }
        fetchAll(SpecVersion.self, context: context)
            .filter { $0.specId == specID }.forEach { context.delete($0) }
        fetchAll(SpecTokenMapping.self, context: context)
            .filter { $0.specId == specID }.forEach { context.delete($0) }
        if let spec = fetchAll(DesignSpec.self, context: context).first(where: { $0.id == specID }) { context.delete(spec) }
        try? context.save()
    }

    /// 级联删除端分类：其下全部规范套连带删除（预置分类在 UI 层禁删，此处不做拦截）
    static func deleteSpecCategory(_ categoryID: String, context: ModelContext) {
        fetchAll(DesignSpec.self, context: context)
            .filter { $0.categoryId == categoryID }
            .forEach { deleteSpec($0.id, context: context) }
        if let category = fetchAll(SpecCategory.self, context: context).first(where: { $0.id == categoryID }) {
            context.delete(category)
        }
        try? context.save()
    }

    // MARK: - 取数工具（全量取内存过滤，数据量为本地走查规模可接受）

    private static func fetchAll<T: PersistentModel>(_ type: T.Type, context: ModelContext) -> [T] {
        (try? context.fetch(FetchDescriptor<T>())) ?? []
    }

    private static func fetchPages(context: ModelContext) -> [WalkthroughPage] {
        fetchAll(WalkthroughPage.self, context: context)
    }

    private static func fetchIssues(context: ModelContext) -> [Issue] {
        fetchAll(Issue.self, context: context)
    }

    private static func fetchVisits(context: ModelContext) -> [Visit] {
        fetchAll(Visit.self, context: context)
    }

    private static func fetchFolders(context: ModelContext) -> [Folder] {
        fetchAll(Folder.self, context: context)
    }
}
