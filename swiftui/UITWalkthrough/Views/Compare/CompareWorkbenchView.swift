import SwiftUI

/// 对比工作台三栏布局：左侧工具栏 / 中间画布 / 右侧标注面板
/// （功能对等清单第 1 项；对齐 Electron 版 CompareWorkbench + AnnotationCanvas + IssueDrawer）
struct CompareWorkbenchView: View {
    var body: some View {
        HStack(spacing: 0) {
            ToolRailView()
                .frame(minWidth: 52, idealWidth: 56, maxWidth: 64)
            Divider()
            CompareCanvasPlaceholder()
                .frame(minWidth: 400, maxWidth: .infinity, maxHeight: .infinity)
            Divider()
            AnnotationPanelView()
                .frame(minWidth: 280, idealWidth: 320, maxWidth: 380)
        }
    }
}

/// 左侧工具栏：标注形状工具（框选 / 点位 / 箭头 / 文字 / 测量 / 吸色，后续里程碑实现）
private struct ToolRailView: View {
    var body: some View {
        VStack(spacing: 12) {
            Text("工具")
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer()
        }
        .padding(.top, 12)
        .background(.bar)
    }
}

/// 中间画布占位：后续实现四种对比模式（并排 / 叠加 onion / 滑块 slider / 闪烁 blink）
private struct CompareCanvasPlaceholder: View {
    var body: some View {
        ContentUnavailableView {
            Label("对比画布", systemImage: "photo.on.rectangle.angled")
        } description: {
            Text("并排 / 叠加 / 滑块 / 闪烁 四种对比模式将在后续里程碑实现")
        }
        .background(Color(nsColor: .controlBackgroundColor))
    }
}

/// 右侧标注面板：问题清单与编辑（对应 Electron 版 IssueDrawer / IssueEditorModal）
private struct AnnotationPanelView: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("标注面板")
                .font(.headline)
                .padding()
            Divider()
            ContentUnavailableView {
                Label("问题清单", systemImage: "list.bullet.rectangle")
            } description: {
                Text("问题创建 / 编辑 / 严重等级 / 规范依据 / 修改建议将在此展示")
            }
        }
        .background(.background)
    }
}

#Preview {
    CompareWorkbenchView()
        .frame(width: 1200, height: 760)
}
