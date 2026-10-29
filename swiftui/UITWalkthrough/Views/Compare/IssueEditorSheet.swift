import SwiftUI

/// 标注编辑表单字段包（create/edit 共用；对齐 IssueEditorModal onSave 载荷）
struct IssueEditorFields {
    var issueDescription: String
    var severity: Severity
    var category: IssueCategory
    var status: IssueStatus
    var targetImage: TargetImage
    /// 自定义标注颜色；nil = 按严重度着色
    var color: String?
    /// 测量标注的尺寸文案（仅测量标注）
    var measureValue: String?
}

/// 新建标注草稿：画布拖拽完成后携带 rect / 图层 / 形状进入创建表单
/// （对齐 CompareWorkbench `creating` state）
struct CreatingDraft: Identifiable {
    let id = UUID()
    var rect: CGRect
    var targetImage: TargetImage
    var shape: AnnotationShape
}

/// 标注详情表单（对齐 IssueEditorModal.tsx）：
/// 描述 / 分类 / 严重度 / 所在图 / 状态（仅编辑）/ 尺寸数值（仅测量）/ 标注颜色板
struct IssueEditorSheet: View {
    enum Mode {
        case create(CreatingDraft)
        case edit(Issue)

        var isEdit: Bool {
            if case .edit = self { return true }
            return false
        }

        var shape: AnnotationShape? {
            switch self {
            case .create(let draft): draft.shape
            case .edit(let issue): issue.displayShape
            }
        }
    }

    let mode: Mode
    var onSave: (IssueEditorFields) -> Void
    var onDelete: (() -> Void)? = nil

    @Environment(\.dismiss) private var dismiss
    @State private var descText = ""
    @State private var severity: Severity = .minor
    @State private var category: IssueCategory = .spacing
    @State private var status: IssueStatus = .pending
    @State private var targetImage: TargetImage = .screenshot
    @State private var colorPreset: String?
    @State private var measureValue = ""

    init(mode: Mode, onSave: @escaping (IssueEditorFields) -> Void, onDelete: (() -> Void)? = nil) {
        self.mode = mode
        self.onSave = onSave
        self.onDelete = onDelete
        switch mode {
        case .create(let draft):
            _descText = State(initialValue: "")
            _severity = State(initialValue: .minor)
            _category = State(initialValue: .spacing)
            _status = State(initialValue: .pending)
            _targetImage = State(initialValue: draft.targetImage)
            _colorPreset = State(initialValue: nil)
            _measureValue = State(initialValue: "")
        case .edit(let issue):
            _descText = State(initialValue: issue.issueDescription)
            _severity = State(initialValue: issue.severity)
            _category = State(initialValue: issue.category)
            _status = State(initialValue: issue.status)
            _targetImage = State(initialValue: issue.targetImage)
            _colorPreset = State(initialValue: issue.color)
            _measureValue = State(initialValue: issue.measureValue ?? "")
        }
    }

    private var isMeasure: Bool { mode.shape == .measure }
    private var trimmedDesc: String { descText.trimmingCharacters(in: .whitespacesAndNewlines) }
    private var canSave: Bool { !trimmedDesc.isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(mode.isEdit ? "编辑问题标注" : "新建问题标注")
                .font(.headline)

            fieldLabel("问题描述")
            TextEditor(text: $descText)
                .font(.body)
                .scrollContentBackground(.hidden)
                .frame(height: 68)
                .padding(6)
                .overlay(alignment: .topLeading) {
                    if descText.isEmpty {
                        Text("描述这里与设计稿不一致的地方")
                            .font(.body)
                            .foregroundStyle(.tertiary)
                            .padding(.top, 12)
                            .padding(.leading, 11)
                            .allowsHitTesting(false)
                    }
                }
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .strokeBorder(Color(nsColor: .separatorColor))
                )

            HStack(spacing: 12) {
                pickerField("分类", selection: $category) {
                    ForEach(IssueCategory.allCases) { c in Text(c.label).tag(c) }
                }
                pickerField("严重等级", selection: $severity) {
                    ForEach(Severity.allCases) { s in Text(s.label).tag(s) }
                }
            }
            HStack(spacing: 12) {
                pickerField("所在图", selection: $targetImage) {
                    ForEach(TargetImage.allCases) { t in Text(t.label).tag(t) }
                }
                if mode.isEdit {
                    pickerField("状态", selection: $status) {
                        ForEach(IssueStatus.allCases) { s in Text(s.label).tag(s) }
                    }
                }
            }

            if isMeasure {
                fieldLabel("尺寸数值")
                TextField("如 128px", text: $measureValue)
                    .textFieldStyle(.roundedBorder)
            }

            fieldLabel("标注颜色")
            colorPalette

            HStack {
                if mode.isEdit, let onDelete {
                    Button("删除", role: .destructive, action: onDelete)
                }
                Spacer()
                Button("取消") { dismiss() }
                    .keyboardShortcut(.cancelAction)
                Button("保存") { save() }
                    .keyboardShortcut(.defaultAction)
                    .disabled(!canSave)
            }
        }
        .padding(16)
        .frame(width: 420)
    }

    // MARK: - 子视图

    private func fieldLabel(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(.secondary)
    }

    private func pickerField<T: Hashable, Content: View>(
        _ label: String,
        selection: Binding<T>,
        @ViewBuilder content: () -> Content
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            fieldLabel(label)
            Picker(label, selection: selection) { content() }
                .labelsHidden()
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var colorPalette: some View {
        HStack(spacing: 8) {
            ForEach(AnnotationColorCatalog.presets) { preset in
                let selected = colorPreset == preset.value
                Button {
                    colorPreset = preset.value
                } label: {
                    ZStack {
                        Circle()
                            .fill(preset.value.flatMap { colorFromHex($0) } ?? Color(nsColor: .controlBackgroundColor))
                        if preset.value == nil {
                            Image(systemName: "wand.and.stars")
                                .font(.system(size: 10))
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 22, height: 22)
                    .overlay(
                        Circle().strokeBorder(
                            selected ? Color.accentColor : Color.black.opacity(0.15),
                            lineWidth: selected ? 2 : 1
                        )
                    )
                }
                .buttonStyle(.plain)
                .help(preset.label)
            }
            Spacer()
        }
    }

    // MARK: - 动作

    private func save() {
        guard canSave else { return }
        let trimmedMeasure = measureValue.trimmingCharacters(in: .whitespacesAndNewlines)
        onSave(IssueEditorFields(
            issueDescription: trimmedDesc,
            severity: severity,
            category: category,
            status: status,
            targetImage: targetImage,
            color: colorPreset,
            measureValue: isMeasure ? (trimmedMeasure.isEmpty ? nil : trimmedMeasure) : nil
        ))
        dismiss()
    }
}
