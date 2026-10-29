import SwiftData
import SwiftUI

/// 工作台模式：手动标注（双图对比）/ 自动走查（Figma 结构化比对）
/// （对齐 CompareWorkbench.tsx `WorkMode`；自动走查依赖引擎桥接，占位至里程碑 m5）
enum WorkbenchWorkMode: String, CaseIterable, Identifiable {
    case manual
    case auto

    var id: String { rawValue }

    var label: String { self == .manual ? "手动标注" : "自动走查" }
}

/// 对比工作台：顶栏（返回/页面信息）+ 画布工具条 + 三栏主体
/// （对齐 Electron CompareWorkbench：hero 头部 + workbench-header + compare-body）
struct CompareWorkbenchView: View {
    @Environment(AppState.self) private var appState
    @Environment(\.modelContext) private var context
    @Query private var allPages: [WalkthroughPage]
    @Query private var allProjects: [Project]

    @State private var canvasModel = CompareCanvasModel()
    @State private var workMode: WorkbenchWorkMode = .manual
    @State private var editPageOpen = false

    private var page: WalkthroughPage? {
        allPages.first { $0.id == appState.activePageID }
    }

    private var project: Project? {
        allProjects.first { $0.id == appState.activeProjectID }
    }

    var body: some View {
        VStack(spacing: 0) {
            headerBar
            toolbar
            Divider()
            if workMode == .manual {
                canvasBody
                if canvasModel.mode.isOverlay {
                    overlayHint
                }
            } else {
                autoWalkPlaceholder
            }
        }
        .background(Color(nsColor: .controlBackgroundColor))
        .sheet(isPresented: $editPageOpen) {
            if let page {
                PageSheet(mode: .edit(page))
            }
        }
    }

    // MARK: - 顶栏（对齐 hero：返回项目 + 页面标题 + 平台徽标 + Figma 链接 + 编辑信息）

    private var headerBar: some View {
        HStack(spacing: 10) {
            Button {
                appState.closePage()
            } label: {
                Label("返回项目", systemImage: "chevron.left")
            }
            .controlSize(.small)

            if let page {
                Divider().frame(height: 16)
                Text(page.pageName)
                    .font(.headline)
                    .lineLimit(1)
                PlatformBadgeView(platform: page.platform)
                if let url = page.figmaUrl, !url.isEmpty, let dest = URL(string: url) {
                    Link(destination: dest) {
                        Label("Figma 设计稿", systemImage: "link")
                            .labelStyle(.titleAndIcon)
                    }
                    .controlSize(.small)
                    .help(url)
                }
            }
            Spacer()
            if page != nil {
                Button("编辑页面信息") { editPageOpen = true }
                    .controlSize(.small)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
    }

    // MARK: - 画布工具条（对齐 workbench-header：同步滚动 / 分割线 / 缩放 / 视图模式 / 工作模式）

    private var toolbar: some View {
        HStack(spacing: 14) {
            if workMode == .manual {
                if !canvasModel.mode.isOverlay {
                    Toggle("同步滚动", isOn: $canvasModel.syncScroll)
                }
                if canvasModel.mode == .slider {
                    HStack(spacing: 6) {
                        Text("分割线")
                        Slider(value: $canvasModel.sliderPos, in: 0...100)
                            .frame(width: 140)
                    }
                    Toggle("显示分界线", isOn: $canvasModel.showDivider)
                }
                HStack(spacing: 6) {
                    Text("缩放")
                    Slider(value: $canvasModel.zoom, in: 0.25...3, step: 0.05)
                        .frame(width: 120)
                    Text("\(Int((canvasModel.zoom * 100).rounded()))%")
                        .monospacedDigit()
                        .frame(width: 44, alignment: .leading)
                }
                Picker("视图模式", selection: $canvasModel.mode) {
                    ForEach(CanvasViewMode.allCases) { m in
                        Text(m.label).tag(m)
                    }
                }
                .pickerStyle(.segmented)
                .labelsHidden()
            }
            Spacer()
            Picker("工作模式", selection: $workMode) {
                ForEach(WorkbenchWorkMode.allCases) { m in
                    Text(m.label).tag(m)
                }
            }
            .pickerStyle(.segmented)
            .labelsHidden()
            .help("切换手动标注与自动走查模式")
        }
        .controlSize(.small)
        .padding(.horizontal, 12)
        .padding(.bottom, 8)
    }

    // MARK: - 画布主体（手动图集：designImagePath / screenshotPath）

    @ViewBuilder
    private var canvasBody: some View {
        if let page {
            CompareCanvasView(
                designImage: ImageStore.image(of: page.designImagePath),
                shotImage: ImageStore.image(of: page.screenshotPath),
                model: canvasModel,
                onReupload: { reupload($0, page: page) }
            )
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ContentUnavailableView {
                Label("未打开页面", systemImage: "photo.on.rectangle.angled")
            } description: {
                Text("从「项目」选择页面打开，即可开始双图对比走查")
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    /// 重新上传双图（对齐 handleReupload：选图 → 落盘 → 删旧图 → 更新路径 + touch updatedAt）
    private func reupload(_ target: TargetImage, page: WalkthroughPage) {
        guard let url = ImagePicker.pickImage(),
              let newRel = try? ImageStore.importFile(at: url) else { return }
        switch target {
        case .design:
            if !page.designImagePath.isEmpty { ImageStore.delete(page.designImagePath) }
            page.designImagePath = newRel
        case .screenshot:
            if !page.screenshotPath.isEmpty { ImageStore.delete(page.screenshotPath) }
            page.screenshotPath = newRel
        }
        page.updatedAt = nowMs()
        try? context.save()
    }

    /// 叠加模式底部提示（对齐 annotation-hint）
    private var overlayHint: some View {
        Text("叠加 / 滑块 / 闪烁模式下标注显示在开发截图图层上，可直接标注")
            .font(.caption)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 6)
    }

    /// 自动走查占位：引擎桥接（engine-bridge CLI + Process）与 Figma 结构化比对在 m5 实现
    private var autoWalkPlaceholder: some View {
        ContentUnavailableView {
            Label("自动走查", systemImage: "wand.and.stars")
        } description: {
            Text("Figma 结构化比对 + 自动走查引擎将在后续里程碑实现")
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

#Preview {
    CompareWorkbenchView()
        .frame(width: 1200, height: 760)
}
