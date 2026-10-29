import SwiftData
import SwiftUI

/// 新建/编辑页面弹窗（对齐 Electron PageModal：名称/端类型/状态/Figma 链接/开发地址/双图上传）
struct PageSheet: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let mode: PageSheetMode

    @State private var pageName = ""
    @State private var platform: Platform = .h5
    @State private var status: PageStatus = .pending
    @State private var figmaUrl = ""
    @State private var devUrl = ""
    @State private var designImagePath = ""
    @State private var screenshotPath = ""

    var body: some View {
        VStack(spacing: 0) {
            Text(isEdit ? "编辑页面" : "新建页面")
                .font(.headline)
                .padding(.top, 16)
            Form {
                TextField("页面名称", text: $pageName)
                Picker("适用端", selection: $platform) {
                    ForEach(Platform.allCases) { p in
                        Text(p.label).tag(p)
                    }
                }
                .pickerStyle(.segmented)
                Picker("走查状态", selection: $status) {
                    ForEach(PageStatus.allCases) { s in
                        Text(s.label).tag(s)
                    }
                }
                TextField("设计稿 Figma 链接（选填）", text: $figmaUrl)
                TextField("开发环境页面 URL（自动走查用，选填）", text: $devUrl)
                imageRow(title: "设计稿", path: $designImagePath)
                imageRow(title: "开发截图", path: $screenshotPath)
            }
            .formStyle(.grouped)
            .padding(.horizontal, 12)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEdit ? "保存" : "创建") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(pageName.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
        }
        .frame(width: 480)
        .onAppear { load() }
    }

    private var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    private func imageRow(title: String, path: Binding<String>) -> some View {
        HStack(spacing: 10) {
            LocalImageView(relativePath: path.wrappedValue.isEmpty ? nil : path.wrappedValue)
                .frame(width: 64, height: 44)
                .clipShape(RoundedRectangle(cornerRadius: 6))
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.callout)
                HStack {
                    Button("选择图片") {
                        guard let url = ImagePicker.pickImage(),
                              let newRel = try? ImageStore.importFile(at: url) else { return }
                        if !path.wrappedValue.isEmpty { ImageStore.delete(path.wrappedValue) }
                        path.wrappedValue = newRel
                    }
                    if !path.wrappedValue.isEmpty {
                        Button("移除", role: .destructive) {
                            ImageStore.delete(path.wrappedValue)
                            path.wrappedValue = ""
                        }
                    }
                }
                .controlSize(.small)
            }
            Spacer()
        }
    }

    private func load() {
        guard case .edit(let p) = mode else { return }
        pageName = p.pageName
        platform = p.platform
        status = p.status
        figmaUrl = p.figmaUrl ?? ""
        devUrl = p.devUrl ?? ""
        designImagePath = p.designImagePath
        screenshotPath = p.screenshotPath
    }

    private func submit() {
        let trimmed = pageName.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        switch mode {
        case .create(let projectId, let folderId):
            context.insert(
                WalkthroughPage(
                    folderId: folderId,
                    projectId: projectId,
                    pageName: trimmed,
                    platform: platform,
                    designImagePath: designImagePath,
                    screenshotPath: screenshotPath,
                    figmaUrl: figmaUrl.isEmpty ? nil : figmaUrl,
                    devUrl: devUrl.isEmpty ? nil : devUrl,
                    status: status
                )
            )
        case .edit(let p):
            p.pageName = trimmed
            p.platform = platform
            p.status = status
            p.figmaUrl = figmaUrl.isEmpty ? nil : figmaUrl
            p.devUrl = devUrl.isEmpty ? nil : devUrl
            if p.designImagePath != designImagePath, !p.designImagePath.isEmpty {
                ImageStore.delete(p.designImagePath)
            }
            p.designImagePath = designImagePath
            if p.screenshotPath != screenshotPath, !p.screenshotPath.isEmpty {
                ImageStore.delete(p.screenshotPath)
            }
            p.screenshotPath = screenshotPath
            p.updatedAt = nowMs()
        }
        try? context.save()
        dismiss()
    }
}

/// 新建/编辑文件夹弹窗（对齐 FolderModal：名称 + 主题色；icon 预设后续补齐）
struct FolderSheet: View {
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss

    let mode: FolderSheetMode
    let folders: [Folder]
    let projectId: String

    @State private var name = ""
    @State private var color: String?
    @State private var parentId: String?

    private static let colorPresets = [
        "#3b82f6", "#8b5cf6", "#ec4899", "#f43f5e", "#14b8a6", "#f97316", "#22c55e", "#eab308"
    ]

    var body: some View {
        VStack(spacing: 0) {
            Text(isEdit ? "编辑文件夹" : "新建文件夹")
                .font(.headline)
                .padding(.top, 16)
            Form {
                TextField("文件夹名称", text: $name)
                Picker("父级", selection: Binding(
                    get: { parentId ?? "root" },
                    set: { parentId = $0 == "root" ? nil : $0 }
                )) {
                    Text("项目根级").tag("root")
                    ForEach(editableParents) { f in
                        Text(f.name).tag(f.id)
                    }
                }
                VStack(alignment: .leading, spacing: 6) {
                    Text("主题色")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    HStack(spacing: 6) {
                        Circle()
                            .fill(Color(nsColor: .controlBackgroundColor))
                            .frame(width: 20, height: 20)
                            .overlay(Circle().strokeBorder(color == nil ? Color.primary : .separator))
                            .onTapGesture { color = nil }
                            .help("自动")
                        ForEach(Self.colorPresets, id: \.self) { hex in
                            Circle()
                                .fill(colorFromHex(hex) ?? Color.gray)
                                .frame(width: 20, height: 20)
                                .overlay(Circle().strokeBorder(color == hex ? Color.primary : .separator))
                                .onTapGesture { color = hex }
                        }
                    }
                }
            }
            .formStyle(.grouped)
            .padding(.horizontal, 12)
            HStack {
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button(isEdit ? "保存" : "创建") { submit() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            .padding(12)
        }
        .frame(width: 400)
        .onAppear { load() }
    }

    private var isEdit: Bool {
        if case .edit = mode { return true }
        return false
    }

    /// 父级候选：排除自身与自身子孙（防环）
    private var editableParents: [Folder] {
        guard case .edit(let f) = mode else { return folders }
        var banned: Set<String> = [f.id]
        var changed = true
        while changed {
            changed = false
            for folder in folders where folder.parentId.map({ banned.contains($0) }) == true && !banned.contains(folder.id) {
                banned.insert(folder.id)
                changed = true
            }
        }
        return folders.filter { !banned.contains($0.id) }
    }

    private func load() {
        switch mode {
        case .create(let pid):
            parentId = pid
        case .edit(let f):
            name = f.name
            color = f.color
            parentId = f.parentId
        }
    }

    private func submit() {
        let trimmed = name.trimmingCharacters(in: .whitespaces)
        guard !trimmed.isEmpty else { return }
        switch mode {
        case .create:
            context.insert(
                Folder(projectId: projectId, parentId: parentId, name: trimmed, color: color)
            )
        case .edit(let f):
            f.name = trimmed
            f.color = color
            // 防环：父级若在自己子树内则不生效
            if let pid = parentId, editableParents.contains(where: { $0.id == pid }) {
                f.parentId = pid
            } else if parentId == nil {
                f.parentId = nil
            }
        }
        try? context.save()
        dismiss()
    }
}
