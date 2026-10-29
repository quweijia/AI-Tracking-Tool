import SwiftUI

/// 对比画布视图模式（对齐 CompareWorkbench.tsx `ViewMode` 与 i18n 文案）
enum CanvasViewMode: String, CaseIterable, Identifiable {
    case sideBySide = "side-by-side"
    case onion
    case slider
    case blink

    var id: String { rawValue }

    var label: String {
        switch self {
        case .sideBySide: "并排"
        case .onion: "叠加（洋葱皮）"
        case .slider: "滑块"
        case .blink: "差异闪烁"
        }
    }

    /// 叠加三模式共用一个画布视口（base=设计稿，top=开发截图）
    var isOverlay: Bool { self != .sideBySide }

    /// 面板标题（对齐 onionPanelTitle / sliderPanelTitle / blinkPanelTitle）
    var panelTitle: String {
        switch self {
        case .onion: "叠加对比：开发截图 50% 透明叠在设计稿上"
        case .slider: "滑块对比：拖动分割线查看左右两侧"
        case .blink: "差异闪烁：开发截图与设计稿交替闪烁"
        case .sideBySide: ""
        }
    }
}

/// 画布交互状态（对齐 zoom / sliderPos / showDivider / syncScroll）
@MainActor
@Observable
final class CompareCanvasModel {
    var mode: CanvasViewMode = .sideBySide
    /// 缩放倍率（0.25–3，步进 0.05）
    var zoom: Double = 1
    /// 滑块分割线位置（0–100，百分比分位）
    var sliderPos: Double = 50
    /// 是否显示滑块分界线
    var showDivider = true
    /// 并排模式同步滚动
    var syncScroll = true
}

/// 对比画布：四种视图模式渲染（对齐 Electron compare-container / overlay-canvas 行为）。
/// 坐标口径与 Electron 一致：所有标注使用归一化 0~1 相对整幅图。
struct CompareCanvasView: View {
    let designImage: NSImage?
    let shotImage: NSImage?
    @Bindable var model: CompareCanvasModel
    /// 并排面板「重新上传」回调（对齐 Electron panel-upload；叠加模式无此按钮）
    var onReupload: ((TargetImage) -> Void)? = nil

    var body: some View {
        if model.mode.isOverlay {
            OverlayCanvas(designImage: designImage, shotImage: shotImage, model: model)
        } else {
            SideBySideCanvas(designImage: designImage, shotImage: shotImage, model: model, onReupload: onReupload)
        }
    }
}

// MARK: - 并排模式（双面板 + 同步滚动）

private struct SideBySideCanvas: View {
    let designImage: NSImage?
    let shotImage: NSImage?
    @Bindable var model: CompareCanvasModel
    var onReupload: ((TargetImage) -> Void)?

    /// 同步滚动防回环（A 滚动驱动 B，B 的几何变化回调里跳过）
    @State private var syncing = false
    @State private var designPos = ScrollPosition()
    @State private var shotPos = ScrollPosition()

    var body: some View {
        HStack(spacing: 8) {
            canvasPanel(
                title: "设计稿", image: designImage, target: .design,
                help: "重新选择设计稿图片"
            ) { offset in
                sync(to: shotPos, from: offset)
            }
            canvasPanel(
                title: "开发截图", image: shotImage, target: .screenshot,
                help: "重新选择开发截图"
            ) { offset in
                sync(to: designPos, from: offset)
            }
        }
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }

    private func sync(to target: ScrollPosition, from offset: CGPoint) {
        guard model.syncScroll, !syncing else { return }
        syncing = true
        target.scrollTo(x: offset.x, y: offset.y)
        DispatchQueue.main.async { syncing = false }
    }

    private func canvasPanel(
        title: String,
        image: NSImage?,
        target: TargetImage,
        help reuploadHelp: String,
        onScroll: @escaping (CGPoint) -> Void
    ) -> some View {
        VStack(spacing: 0) {
            HStack {
                Text(title).font(.callout.weight(.medium))
                Spacer()
                if let onReupload {
                    Button("重新上传") { onReupload(target) }
                        .buttonStyle(.borderless)
                        .controlSize(.small)
                        .help(reuploadHelp)
                }
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider()
            if let image {
                GeometryReader { geo in
                    ScrollView {
                        Image(nsImage: image)
                            .resizable()
                            .scaledToFit()
                            .frame(width: geo.size.width * model.zoom)
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 6)
                    }
                    .scrollPosition(designPosBinding(for: title))
                    .onScrollGeometryChange(for: CGPoint.self) { geo in
                        CGPoint(x: geo.contentOffset.x, y: geo.contentOffset.y)
                    } action: { _, new in
                        onScroll(new)
                    }
                }
            } else {
                ContentUnavailableView("缺少图片", systemImage: "photo.badge.plus")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
    }

    /// 两个面板各自的 ScrollPosition 状态按面板标题区分
    private func designPosBinding(for title: String) -> Binding<ScrollPosition> {
        title == "设计稿" ? $designPos : $shotPos
    }
}

// MARK: - 叠加三模式（onion / slider / blink，base=设计稿 top=开发截图）

private struct OverlayCanvas: View {
    let designImage: NSImage?
    let shotImage: NSImage?
    @Bindable var model: CompareCanvasModel

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Text(model.mode.panelTitle)
                    .font(.callout.weight(.medium))
                Spacer()
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            Divider()
            if designImage == nil || shotImage == nil {
                ContentUnavailableView(
                    "需要设计稿与开发截图",
                    systemImage: "photo.on.rectangle",
                    description: Text("叠加 / 滑块 / 闪烁模式需要双图齐备")
                )
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                viewport
            }
        }
        .background(.background, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).strokeBorder(.separator, lineWidth: 1))
        .padding(.horizontal, 8)
        .padding(.top, 8)
    }

    private var viewport: some View {
        GeometryReader { geo in
            let width = geo.size.width * model.zoom
            // 画布盒以设计稿宽高比为准（对齐 .overlay-base 决定高度、top 图 object-fit:fill 拉伸）
            let aspect = imageAspect(designImage) ?? 1
            let height = width / aspect
            ScrollView {
                ZStack(alignment: .topLeading) {
                    if let designImage {
                        Image(nsImage: designImage)
                            .resizable()
                            .frame(width: width, height: height)
                    }
                    if let shotImage {
                        topImage(shotImage, width: width, height: height)
                    }
                }
                .frame(width: width, height: height, alignment: .topLeading)
                .overlay {
                    if model.mode == .slider && model.showDivider {
                        dividerOverlay(width: width, height: height)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .top)
                .padding(.vertical, 6)
            }
        }
    }

    /// 顶层开发截图：onion=50% 透明 / blink=1s steps 交替(0.85/0) / slider=左侧裁切
    @ViewBuilder
    private func topImage(_ image: NSImage, width: CGFloat, height: CGFloat) -> some View {
        let base = Image(nsImage: image)
            .resizable()
            .frame(width: width, height: height)
        switch model.mode {
        case .onion:
            base.opacity(0.5)
        case .blink:
            TimelineView(.periodic(from: .now, by: 0.25)) { timeline in
                let frac = timeline.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 1)
                base.opacity(frac < 0.5 ? 0.85 : 0)
            }
        case .slider:
            base.mask(alignment: .leading) {
                Color.white.frame(width: width * (1 - model.sliderPos / 100))
            }
        case .sideBySide:
            base
        }
    }

    /// 可拖动分割线（对齐 .slider-divider + startSliderDrag；加宽热区便于拖拽）
    private func dividerOverlay(width: CGFloat, height: CGFloat) -> some View {
        Color.clear
            .frame(width: 18, height: height)
            .overlay {
                ZStack {
                    Rectangle()
                        .fill(Color.white)
                        .frame(width: 2)
                        .frame(maxHeight: .infinity)
                        .shadow(color: .black.opacity(0.35), radius: 1)
                    Capsule()
                        .fill(Color.white)
                        .frame(width: 4, height: 28)
                        .shadow(color: .black.opacity(0.35), radius: 2)
                }
            }
            .position(x: width * model.sliderPos / 100, y: height / 2)
            .gesture(
                DragGesture(minimumDistance: 0)
                    .onChanged { value in
                        let x = width * model.sliderPos / 100 + (value.location.x - 9)
                        model.sliderPos = min(100, max(0, x / width * 100))
                    }
            )
    }

    private func imageAspect(_ image: NSImage?) -> CGFloat? {
        guard let size = image?.size, size.height > 0 else { return nil }
        return size.width / size.height
    }
}
