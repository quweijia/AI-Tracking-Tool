import SwiftData
import SwiftUI

/// 项目详情页（对齐 Electron ProjectDetail + Layout 项目树：左侧文件夹/页面树 + 右侧页面网格）
struct ProjectDetailView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context

    let projectID: String

    @Query private var projects: [Project]
    @Query private var pages: [WalkthroughPage]
    @Query private var folders: [Folder]

    @State private var scopeFolderID: String?
    @State private var pageSheet: PageSheetMode?
    @State private var folderSheet: FolderSheetMode?
    @State private var editingProject: Project?
    @State private var renamingTarget: RenameTarget?
    @State private var deletingPage: WalkthroughPage?
    @State private var deletingFolder: Folder?

    /// 树/网格共用的排序（手动 sortNo 优先，未拖过的按创建时间）
    private var sortedPages: [WalkthroughPage] {
        pages.sorted { $0.sortOrder < $1.sortOrder }
    }

    private var sortedFolders: [Folder] {
        folders.sorted { $0.sortOrder < $1.sortOrder }
    }

    private var project: Project? { projects.first { $0.id == projectID } }

    var body: some View {
        HStack(spacing: 0) {
            treeColumn
            Divider()
            gridColumn
        }
        .navigationTitle(project?.name ?? "项目详情")
        .toolbar {
            ToolbarItemGroup {
                Button { folderSheet = .create(parentId: scopeFolderID) } label: {
                    Label("新建文件夹", systemImage: "folder.badge.plus")
                }
                Button { pageSheet = .create(projectId: projectID, folderId: scopeFolderID) } label: {
                    Label("新建页面", systemImage: "plus.rectangle.on.rectangle")
                }
                Button { editingProject = project } label: {
                    Label("编辑项目", systemImage: "pencil")
                }
            }
        }
        .sheet(item: $pageSheet) { PageSheet(mode: $0) }
        .sheet(item: $folderSheet) { FolderSheet(mode: $0, folders: sortedFolders, projectId: projectID) }
        .sheet(item: $editingProject) { ProjectSheet(mode: .edit($0)) }
        .alert("重命名", isPresented: Binding(
            get: { renamingTarget != nil },
            set: { if !$0 { renamingTarget = nil } }
        )) {
            TextField("名称", text: renameBinding)
            Button("确定") { commitRename() }
            Button("取消", role: .cancel) { renamingTarget = nil }
        }
        .confirmationDialog(
            "删除页面「\(deletingPage?.pageName ?? "")」？",
            isPresented: Binding(
                get: { deletingPage != nil },
                set: { if !$0 { deletingPage = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除（含标注与图片）", role: .destructive) {
                if let p = deletingPage { Cascade.deletePages([p.id], context: context) }
                deletingPage = nil
            }
            Button("取消", role: .cancel) { deletingPage = nil }
        }
        .confirmationDialog(
            "删除文件夹「\(deletingFolder?.name ?? "")」？",
            isPresented: Binding(
                get: { deletingFolder != nil },
                set: { if !$0 { deletingFolder = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("删除（级联删除子文件夹与页面）", role: .destructive) {
                if let f = deletingFolder {
                    Cascade.deleteFolder(f.id, context: context)
                    if scopeFolderID == f.id { scopeFolderID = nil }
                }
                deletingFolder = nil
            }
            Button("取消", role: .cancel) { deletingFolder = nil }
        }
    }

    // MARK: - 左侧树

    private var treeColumn: some View {
        List {
            Section {
                Label("全部页面", systemImage: "square.grid.2x2")
                    .contentShape(Rectangle())
                    .onTapGesture { scopeFolderID = nil }
                ForEach(rootFolders) { folder in
                    FolderNodeView(
                        folder: folder,
                        folders: sortedFolders,
                        pages: sortedPages,
                        selectedFolderID: $scopeFolderID,
                        renaming: { renamingTarget = $0 },
                        deleting: { deletingFolder = $0 },
                        moveTargets: folderMoveTargets
                    )
                }
                ForEach(rootPages) { page in
                    treePageRow(page)
                }
            } header: {
                Text("页面树")
            }
        }
        .listStyle(.sidebar)
        .frame(minWidth: 220, idealWidth: 250)
    }

    private var rootFolders: [Folder] { sortedFolders.filter { $0.parentId == nil } }
    private var rootPages: [WalkthroughPage] { sortedPages.filter { $0.folderId == nil } }

    private func treePageRow(_ page: WalkthroughPage) -> some View {
        HStack {
            Image(systemName: "doc.text")
                .foregroundStyle(.secondary)
            Text(page.pageName)
                .lineLimit(1)
            Spacer()
            PageStatusBadgeView(status: page.status)
        }
        .padding(.vertical, 2)
        .contentShape(Rectangle())
        .onTapGesture { appState.open(page: page, context: context) }
        .contextMenu {
            Button("打开") { appState.open(page: page, context: context) }
            Button("重命名") { renamingTarget = .page(page) }
            moveMenu(for: page)
            SortMenu { direction in movePage(page, direction) }
            Button("删除页面", role: .destructive) { deletingPage = page }
        }
    }

    // MARK: - 右侧网格

    private var gridPages: [WalkthroughPage] {
        guard let scope = scopeFolderID else { return sortedPages }
        return sortedPages.filter { $0.folderId == scope }
    }

    private var gridColumn: some View {
        ScrollView {
            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 220), spacing: 16)],
                spacing: 16
            ) {
                if gridPages.isEmpty {
                    ContentUnavailableView(
                        "暂无页面",
                        systemImage: "photo.stack",
                        description: Text("点击工具栏「新建页面」上传设计稿与开发截图")
                    )
                    .frame(maxWidth: .infinity, minHeight: 360)
                    .gridCellColumns(3)
                }
                ForEach(gridPages) { page in
                    PageCardView(page: page) {
                        appState.open(page: page, context: context)
                    } edit: {
                        pageSheet = .edit(page)
                    } delete: {
                        deletingPage = page
                    }
                }
            }
            .padding(20)
        }
    }

    // MARK: - 移动 / 排序

    /// 文件夹移动目标（根级 + 全部文件夹，路径展示防歧义）
    private var folderMoveTargets: [FolderMoveTarget] {
        var result: [FolderMoveTarget] = [.root]
        let byParent = Dictionary(grouping: sortedFolders) { $0.parentId ?? "" }
        func walk(_ parent: String, _ prefix: String) {
            for f in (byParent[parent] ?? []) {
                let path = prefix.isEmpty ? f.name : "\(prefix)/\(f.name)"
                result.append(.folder(id: f.id, path: path))
                walk(f.id, path)
            }
        }
        walk("", "")
        return result
    }

    private func moveMenu(for page: WalkthroughPage) -> some View {
        Menu("移动到…") {
            Button("项目根级") { page.folderId = nil; touch(page) }
            ForEach(folderMoveTargets) { target in
                if case .folder(let id, let path) = target, id != page.folderId {
                    Button(path) { page.folderId = id; touch(page) }
                }
            }
        }
    }

    private func movePage(_ page: WalkthroughPage, _ direction: SortDirection) {
        let siblings = sortedPages
        guard let idx = siblings.firstIndex(where: { $0.id == page.id }) else { return }
        let target = direction == .up ? idx - 1 : idx + 1
        guard siblings.indices.contains(target) else { return }
        let other = siblings[target]
        let a = page.sortNo ?? Int(page.createdAt)
        let b = other.sortNo ?? Int(other.createdAt)
        page.sortNo = b
        other.sortNo = a
        touch(page)
        touch(other)
    }

    private func touch(_ page: WalkthroughPage) {
        page.updatedAt = nowMs()
        try? context.save()
    }

    // MARK: - 重命名

    private var renameBinding: Binding<String> {
        Binding(
            get: { renamingTarget?.currentName ?? "" },
            set: { renamingTarget?.currentName = $0 }
        )
    }

    private func commitRename() {
        guard let target = renamingTarget else { return }
        let trimmed = target.currentName.trimmingCharacters(in: .whitespaces)
        if !trimmed.isEmpty {
            switch target {
            case .page(let p): p.pageName = trimmed
            case .folder(let f): f.name = trimmed
            }
            try? context.save()
        }
        renamingTarget = nil
    }
}

// MARK: - 文件夹树节点（递归）

private struct FolderNodeView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context

    let folder: Folder
    let folders: [Folder]
    let pages: [WalkthroughPage]
    @Binding var selectedFolderID: String?
    let renaming: (RenameTarget) -> Void
    let deleting: (Folder) -> Void

    @State private var expanded = true

    private var children: [Folder] { folders.filter { $0.parentId == folder.id } }
    private var folderPages: [WalkthroughPage] { pages.filter { $0.folderId == folder.id } }

    var body: some View {
        DisclosureGroup(isExpanded: $expanded) {
            ForEach(children) { child in
                FolderNodeView(
                    folder: child,
                    folders: folders,
                    pages: pages,
                    selectedFolderID: $selectedFolderID,
                    renaming: renaming,
                    deleting: deleting
                )
            }
            ForEach(folderPages) { page in
                HStack {
                    Image(systemName: "doc.text").foregroundStyle(.secondary)
                    Text(page.pageName).lineLimit(1)
                    Spacer()
                    PageStatusBadgeView(status: page.status)
                }
                .contentShape(Rectangle())
                .onTapGesture { appState.open(page: page, context: context) }
                .contextMenu {
                    Button("打开") { appState.open(page: page, context: context) }
                    Button("重命名") { renaming(.page(page)) }
                }
            }
        } label: {
            HStack {
                folderIcon
                Text(folder.name).lineLimit(1)
                Spacer()
                Text("\(folderPages.count)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture { selectedFolderID = folder.id }
            .contextMenu {
                Button("重命名") { renaming(.folder(folder)) }
                Button("删除文件夹", role: .destructive) { deleting(folder) }
            }
        }
    }

    private var folderIcon: some View {
        Image(systemName: "folder.fill")
            .foregroundStyle(colorFromHex(folder.color ?? "") ?? Color.accentColor)
    }
}

// MARK: - 页面卡片

private struct PageCardView: View {
    let page: WalkthroughPage
    let open: () -> Void
    let edit: () -> Void
    let delete: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            LocalImageView(relativePath: page.designImagePath)
                .frame(height: 130)
                .clipped()
            VStack(alignment: .leading, spacing: 6) {
                Text(page.pageName)
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                HStack(spacing: 6) {
                    PlatformBadgeView(platform: page.platform)
                    PageStatusBadgeView(status: page.status)
                    Spacer()
                    Text(timeAgo(page.updatedAt ?? page.createdAt))
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(10)
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(.separator, lineWidth: 1))
        .contentShape(Rectangle())
        .onTapGesture(count: 2, perform: open)
        .contextMenu {
            Button("打开") { open() }
            Button("编辑信息") { edit() }
            Button("删除页面", role: .destructive) { delete() }
        }
    }
}

// MARK: - 表单与交互模型

enum PageSheetMode: Identifiable {
    case create(projectId: String, folderId: String?)
    case edit(WalkthroughPage)

    var id: String {
        switch self {
        case .create(let projectId, let folderId): "create-\(projectId)-\(folderId ?? "root")"
        case .edit(let p): p.id
        }
    }
}

enum FolderSheetMode: Identifiable {
    case create(parentId: String?)
    case edit(Folder)

    var id: String {
        switch self {
        case .create(let parentId): "create-\(parentId ?? "root")"
        case .edit(let f): f.id
        }
    }
}

enum RenameTarget {
    case page(WalkthroughPage)
    case folder(Folder)

    var currentName: String {
        get {
            switch self {
            case .page(let p): p.pageName
            case .folder(let f): f.name
            }
        }
        nonmutating set {
            switch self {
            case .page(let p): p.pageName = newValue
            case .folder(let f): f.name = newValue
            }
        }
    }
}

enum FolderMoveTarget: Identifiable {
    case root
    case folder(id: String, path: String)

    var id: String {
        switch self {
        case .root: "root"
        case .folder(let id, _): id
        }
    }
}

enum SortDirection {
    case up
    case down
}

/// 上移/下移菜单（树与卡片共用）
struct SortMenu: View {
    let move: (SortDirection) -> Void

    var body: some View {
        Menu("排序") {
            Button("上移") { move(.up) }
            Button("下移") { move(.down) }
        }
    }
}
