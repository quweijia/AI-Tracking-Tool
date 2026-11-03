import SwiftUI

/// 快速创建载荷：测量 px / 吸色 hex（对齐 AnnotationCanvas `onQuickCreate` 的 data）
struct QuickCreateData {
    var measurePx: Double?
    var colorHex: String?
}

/// 标注层交互回调集合（对齐 AnnotationCanvas Props 的回调面）
struct AnnotationHandlers {
    /// 全局序号（与问题清单一致）
    let noOf: (Issue) -> Int
    /// 拖拽绘制完成 → 弹详情创建
    let onCreate: (CGRect, TargetImage) -> Void
    /// 测量/吸色直接创建（不弹窗）
    let onQuickCreate: (CGRect, TargetImage, QuickCreateData) -> Void
    /// 拖拽移动已有标注后提交新位置
    var onMove: ((Issue, CGRect) -> Void)?
    /// 点击已有标注 → 打开详情
    let onEdit: (Issue) -> Void
}

/// 标注工具（hand=抓手仅浏览不绘制，对齐 CompareWorkbench `ToolValue`）
enum AnnotationTool: Hashable {
    case hand
    case shape(AnnotationShape)

    /// 左侧工具栏顺序：抓手 / 点位 / 箭头 / 框选 / 文字 / 测量 / 吸色
    static let railOrder: [AnnotationTool] = [
        .hand, .shape(.point), .shape(.arrow), .shape(.rect),
        .shape(.text), .shape(.measure), .shape(.picker)
    ]

    var shape: AnnotationShape? {
        if case .shape(let s) = self { return s }
        return nil
    }

    var label: String {
        switch self {
        case .hand: "抓手"
        case .shape(let s): s.label
        }
    }

    var hint: String {
        switch self {
        case .hand: "抓手：按住拖拽平移画布，配合缩放查看细节"
        case .shape(.point): "点击图片放置点位标记"
        case .shape(.arrow): "拖拽绘制箭头指向"
        case .shape(.rect): "拖拽框选问题区域"
        case .shape(.text): "点击图片添加文字标注"
        case .shape(.measure):
            "测量距离：点击第一个点拖到第二个点松开完成测量，尺寸数值可在详情中修改"
        case .shape(.picker):
            "吸色取样：点击图上位置，同时吸取设计稿与开发截图同一坐标的颜色，并在双图上分别标注对应色值"
        }
    }

    /// SF Symbol（工具栏图标，线性风格对齐 ToolIcon）
    var systemImage: String {
        switch self {
        case .hand: "hand.draw"
        case .shape(.point): "smallcircle.filled.circle"
        case .shape(.arrow): "arrow.up.right"
        case .shape(.rect): "rectangle.dashed"
        case .shape(.text): "textformat"
        case .shape(.measure): "ruler"
        case .shape(.picker): "eyedropper"
        }
    }
}

/// 标注层渲染配色（对齐 global.css .anno-box / .anno-point / .anno-arrow-line / .anno-num）
enum SeverityRenderColor {
    static func strokeHex(severity: Severity) -> String {
        switch severity {
        case .suggestion: "#98a2b3"
        case .minor: "#f59e0b"
        case .major: "#ef4444"
        }
    }

    static func fillOpacity(severity: Severity) -> Double {
        switch severity {
        case .major: 0.1
        default: 0.08
        }
    }

    /// 编号文字色（.anno-num.severity-*）
    static func numHex(severity: Severity) -> String {
        switch severity {
        case .suggestion: "#667085"
        case .minor: "#b45309"
        case .major: "#dc2626"
        }
    }

    static let fixedHex = "#16a34a"
    static let measureHex = "#2563eb"
    static let draftHex = "#2563eb"
    static let pickLabelHex = "#1f2733"
}

/// 点击位移阈值（归一化）：小于视为点击，大于视为误拖/拖拽
private let clickThreshold: CGFloat = 0.005
/// 框选最小尺寸阈值（过滤误触）
private let rectMinSize: CGFloat = 0.01
/// 移动标注的位移阈值（像素）：超过视为拖拽移动，否则单击打开详情
private let moveThresholdPoints: CGFloat = 3

/// 标注层：铺在图片上渲染问题标注并处理绘制/移动手势（SwiftUI 版 AnnotationCanvas）。
/// 坐标口径与 Electron 一致：所有标注使用归一化 0~1 相对整幅图。
/// 抓手工具不挂手势（画布原生滚动平移），仅点击标注打开详情。
struct AnnotationLayer: View {
    let issues: [Issue]
    let tool: AnnotationTool
    let targetImage: TargetImage
    /// 图片原始像素尺寸（测量 px 换算）
    let pixelSize: CGSize
    let handlers: AnnotationHandlers
    var flashId: String? = nil
    var focusId: String? = nil

    // 绘制/移动中的临时状态
    @State private var draftRect: CGRect?
    @State private var draftArrow: (start: CGPoint, end: CGPoint)?
    @State private var measureStart: CGPoint?
    @State private var measurePreview: CGPoint?
    @State private var dragID: String?
    @State private var dragRect: CGRect?

    var body: some View {
        GeometryReader { geo in
            let size = geo.size
            let stack = ZStack(alignment: .topLeading) {
                ForEach(issues) { issue in
                    if focusId == nil || focusId == issue.id {
                        issueView(issue, size: size)
                    }
                }
                draftViews(size: size)
            }
            .contentShape(Rectangle())

            Group {
                if tool.shape != nil {
                    stack.highPriorityGesture(drawGesture(size: size))
                } else {
                    stack.onTapGesture(coordinateSpace: .local) { loc in
                        if let hit = hitTest(loc, size: size) {
                            handlers.onEdit(hit)
                        }
                    }
                }
            }
        }
    }

    // MARK: - 手势（绘制 + 命中移动合一；Electron 由各命中元素 stopPropagation 实现，这里在起点做命中分派）

    private func drawGesture(size: CGSize) -> some Gesture {
        DragGesture(minimumDistance: 0, coordinateSpace: .local)
            .onChanged { changed($0, size: size) }
            .onEnded { ended($0, size: size) }
    }

    private func norm(_ p: CGPoint, size: CGSize) -> CGPoint {
        CGPoint(x: min(1, max(0, p.x / size.width)), y: min(1, max(0, p.y / size.height)))
    }

    private func changed(_ value: DragGesture.Value, size: CGSize) {
        let start = norm(value.startLocation, size: size)
        let cur = norm(value.location, size: size)

        // 移动已有标注（起点命中优先，对齐命中元素 stopPropagation）
        if dragID == nil, let hit = hitTest(value.startLocation, size: size) {
            dragID = hit.id
            dragRect = CGRect(x: hit.x, y: hit.y, width: hit.width, height: hit.height)
        }
        if let id = dragID, let hit = issues.first(where: { $0.id == id }) {
            let origin = CGRect(x: hit.x, y: hit.y, width: hit.width, height: hit.height)
            var moved = origin
            moved.origin.x = min(1, max(0, origin.origin.x + cur.x - start.x))
            moved.origin.y = min(1, max(0, origin.origin.y + cur.y - start.y))
            dragRect = moved
            return
        }

        guard let shape = tool.shape else { return }
        switch shape {
        case .rect:
            draftRect = CGRect.normalized(from: start, to: cur)
        case .arrow:
            draftArrow = (start, cur)
        case .measure:
            if measureStart != nil { measurePreview = cur }
        case .point, .text, .picker:
            break
        }
    }

    private func ended(_ value: DragGesture.Value, size: CGSize) {
        let start = norm(value.startLocation, size: size)
        let cur = norm(value.location, size: size)
        let moved = hypot(cur.x - start.x, cur.y - start.y)
        let movedPoints = hypot(
            value.location.x - value.startLocation.x,
            value.location.y - value.startLocation.y
        )

        if let id = dragID {
            defer {
                dragID = nil
                dragRect = nil
            }
            guard let issue = issues.first(where: { $0.id == id }) else { return }
            if movedPoints >= moveThresholdPoints, let rect = dragRect, let onMove = handlers.onMove {
                onMove(issue, rect)
            } else if movedPoints < moveThresholdPoints {
                handlers.onEdit(issue)
            }
            return
        }

        guard let shape = tool.shape else { return }
        switch shape {
        case .rect:
            let rect = CGRect.normalized(from: start, to: cur)
            draftRect = nil
            if rect.width > rectMinSize && rect.height > rectMinSize {
                handlers.onCreate(rect, targetImage)
            }
        case .arrow:
            draftArrow = nil
            if moved > 0.02 {
                // 箭头记录起点 + 矢量（宽高可为负表示方向）
                handlers.onCreate(
                    CGRect(x: start.x, y: start.y, width: cur.x - start.x, height: cur.y - start.y),
                    targetImage
                )
            }
        case .measure:
            if let ms = measureStart {
                // 第二段：拖到第二点松开完成测量；位移过小视为误触，取消
                if moved > clickThreshold {
                    let dx = cur.x - ms.x, dy = cur.y - ms.y
                    handlers.onQuickCreate(
                        CGRect(x: ms.x, y: ms.y, width: dx, height: dy),
                        targetImage,
                        QuickCreateData(measurePx: measurePx(dx: dx, dy: dy))
                    )
                }
                measureStart = nil
                measurePreview = nil
            } else if moved <= clickThreshold {
                // 第一点：按下抬起即固定
                measureStart = start
            }
        case .point, .text:
            if moved <= clickThreshold {
                handlers.onCreate(CGRect(x: start.x, y: start.y, width: 0, height: 0), targetImage)
            }
        case .picker:
            if moved <= clickThreshold {
                // 自身图取样在工作台 onQuickCreate 里统一处理（own + 另一张图同坐标）
                handlers.onQuickCreate(
                    CGRect(x: start.x, y: start.y, width: 0, height: 0),
                    targetImage,
                    QuickCreateData(colorHex: nil)
                )
            }
        }
    }

    /// 归一化矢量 → 实际像素距离（按图片原始尺寸）
    private func measurePx(dx: CGFloat, dy: CGFloat) -> Double {
        guard pixelSize.width > 0, pixelSize.height > 0 else { return 0 }
        return hypot(dx * pixelSize.width, dy * pixelSize.height)
    }

    // MARK: - 命中测试（像素空间；对齐各形状 hit 区域：point r16 / picker r18 / 线 8px / 文字包围盒 / rect 包含）

    private func hitTest(_ p: CGPoint, size: CGSize) -> Issue? {
        for issue in issues.reversed() {
            if focusId != nil && issue.id != focusId { continue }
            let rect = CGRect(x: issue.x, y: issue.y, width: issue.width, height: issue.height)
            let a = CGPoint(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
            let b = CGPoint(x: rect.maxX * size.width, y: rect.maxY * size.height)
            switch issue.displayShape {
            case .point:
                if hypot(p.x - a.x, p.y - a.y) <= 16 { return issue }
            case .picker:
                if hypot(p.x - a.x, p.y - a.y) <= 18 { return issue }
            case .arrow, .measure:
                if distanceToSegment(p, a, b) <= 8 { return issue }
            case .text:
                let w = CGFloat(issue.issueDescription.count) * 14
                if CGRect(x: a.x, y: a.y, width: w, height: 20).contains(p) { return issue }
            case .rect:
                if rect.width == 0 && rect.height == 0 {
                    if abs(p.x - a.x) <= 8 && abs(p.y - a.y) <= 8 { return issue }
                } else if CGRect(x: a.x, y: a.y, width: b.x - a.x, height: b.y - a.y).contains(p) {
                    return issue
                }
            }
        }
        return nil
    }

    // MARK: - 渲染

    @ViewBuilder
    private func issueView(_ issue: Issue, size: CGSize) -> some View {
        let num = handlers.noOf(issue)
        let isFixed = issue.status == .fixed
        let useCustom = issue.color != nil && !isFixed
        let color = colorValue(
            custom: useCustom ? issue.color : nil,
            severity: issue.severity,
            fixed: isFixed,
            measure: issue.displayShape == .measure
        )
        let rect = dragID == issue.id ? (dragRect ?? rectOf(issue)) : rectOf(issue)

        Group {
            switch issue.displayShape {
            case .rect:
                rectView(issue, rect: rect, color: color, num: num, size: size)
            case .point:
                pointView(color: color, num: num, rect: rect, size: size)
            case .arrow:
                arrowView(color: color, num: num, numColorValue: numColor(issue), rect: rect, size: size)
            case .text:
                textView(issue, color: color, rect: rect, size: size)
            case .measure:
                measureView(issue, color: color, num: num, rect: rect, size: size)
            case .picker:
                pickerView(issue, rect: rect, size: size)
            }
        }
        .modifier(FlashPulse(active: flashId == issue.id))
    }

    private func rectOf(_ issue: Issue) -> CGRect {
        CGRect(x: issue.x, y: issue.y, width: issue.width, height: issue.height)
    }

    /// 自定义色 > 已修复绿 > 测量蓝 > 严重度色
    private func colorValue(custom: String?, severity: Severity, fixed: Bool, measure: Bool) -> Color {
        if let custom, let c = colorFromHex(custom) { return c }
        if fixed, let c = colorFromHex(SeverityRenderColor.fixedHex) { return c }
        if measure, let c = colorFromHex(SeverityRenderColor.measureHex) { return c }
        return colorFromHex(SeverityRenderColor.strokeHex(severity: severity)) ?? .gray
    }

    private func numColor(_ issue: Issue) -> Color {
        colorFromHex(SeverityRenderColor.numHex(severity: issue.severity)) ?? .gray
    }

    private func rectView(_ issue: Issue, rect: CGRect, color: Color, num: Int, size: CGSize) -> some View {
        let isCandidate = issue.isAISuggested == true && issue.aiConfirmed != true
        return ZStack(alignment: .topLeading) {
            Rectangle()
                .fill(color.opacity(SeverityRenderColor.fillOpacity(severity: issue.severity)))
            Rectangle()
                .strokeBorder(
                    color,
                    style: StrokeStyle(lineWidth: 2, dash: isCandidate ? [6, 3] : [])
                )
            Text("\(num)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(numColor(issue))
                .whiteHalo()
                .padding(.leading, 2)
        }
        .frame(width: max(rect.width * size.width, 1), height: max(rect.height * size.height, 1))
        .offset(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
    }

    private func pointView(color: Color, num: Int, rect: CGRect, size: CGSize) -> some View {
        ZStack {
            Circle()
                .fill(color)
                .frame(width: 18, height: 18)
                .overlay(Circle().strokeBorder(Color.white, lineWidth: 2))
            Text("\(num)")
                .font(.system(size: 10, weight: .bold))
                .foregroundStyle(Color.white)
        }
        .position(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
    }

    private func arrowView(color: Color, num: Int, numColorValue: Color, rect: CGRect, size: CGSize) -> some View {
        let a = CGPoint(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
        let b = CGPoint(x: rect.maxX * size.width, y: rect.maxY * size.height)
        return ZStack {
            ArrowLineShape(from: a, to: b)
                .stroke(color, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
            Text("\(num)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(numColorValue)
                .whiteHalo()
                .position((a + b) / 2)
        }
    }

    private func textView(_ issue: Issue, color: Color, rect: CGRect, size: CGSize) -> some View {
        Text(issue.issueDescription)
            .font(.system(size: 14, weight: .semibold))
            .foregroundStyle(color)
            .whiteHalo()
            .fixedSize()
            .offset(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
    }

    private func measureView(_ issue: Issue, color: Color, num: Int, rect: CGRect, size: CGSize) -> some View {
        let a = CGPoint(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
        let b = CGPoint(x: rect.maxX * size.width, y: rect.maxY * size.height)
        let mid = (a + b) / 2
        let vertical = abs(rect.width) < abs(rect.height)
        let label = issue.measureValue ?? "\(Int(measurePx(dx: rect.width, dy: rect.height).rounded()))px"
        return ZStack {
            ArrowLineShape(from: a, to: b, arrowHead: false)
                .stroke(color, style: StrokeStyle(lineWidth: 2, lineCap: .round))
            Circle().fill(color).frame(width: 7, height: 7).position(a)
            Circle().fill(color).frame(width: 7, height: 7).position(b)
            Text("\(num)")
                .font(.system(size: 12, weight: .bold))
                .foregroundStyle(numColor(issue))
                .whiteHalo()
                .position(a + CGPoint(x: vertical ? 10 : -10, y: 0))
            Text(label)
                .font(.system(size: 12.5, weight: .bold))
                .foregroundStyle(color)
                .whiteHalo()
                .position(mid + (vertical ? CGPoint(x: 8, y: 0) : CGPoint(x: 0, y: -9)))
        }
    }

    private func pickerView(_ issue: Issue, rect: CGRect, size: CGSize) -> some View {
        let hexValue = targetImage == .design ? issue.sampleA : issue.sampleB
        let chipColor = colorFromHex(hexValue ?? issue.color ?? (targetImage == .design ? "#3b82f6" : "#ef4444"))
        let displayText: String
        if let hexValue {
            displayText = (targetImage == .design ? "设计 " : "开发 ") + hexValue
        } else {
            let d = issue.issueDescription
            displayText = d.count > 40 ? String(d.prefix(40)) + "…" : d
        }
        let c = CGPoint(x: rect.origin.x * size.width, y: rect.origin.y * size.height)
        return HStack(spacing: 4) {
            Circle()
                .fill(chipColor ?? .gray)
                .frame(width: 14, height: 14)
                .overlay(Circle().strokeBorder(Color.white, lineWidth: 1.5))
            Text(displayText)
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(colorFromHex(SeverityRenderColor.pickLabelHex) ?? Color.primary)
                .whiteHalo()
                .fixedSize()
        }
        .offset(x: c.x - 7, y: c.y - 7)
    }

    // MARK: - 草稿

    @ViewBuilder
    private func draftViews(size: CGSize) -> some View {
        let draftColor = colorFromHex(SeverityRenderColor.draftHex) ?? .blue
        if let draft = draftRect {
            Rectangle()
                .fill(draftColor.opacity(0.12))
                .overlay(
                    Rectangle().strokeBorder(
                        draftColor,
                        style: StrokeStyle(lineWidth: 1.5, dash: [5, 3])
                    )
                )
                .frame(width: draft.width * size.width, height: draft.height * size.height)
                .offset(x: draft.origin.x * size.width, y: draft.origin.y * size.height)
        }
        if let arrow = draftArrow {
            ArrowLineShape(
                from: CGPoint(x: arrow.start.x * size.width, y: arrow.start.y * size.height),
                to: CGPoint(x: arrow.end.x * size.width, y: arrow.end.y * size.height)
            )
            .stroke(draftColor, style: StrokeStyle(lineWidth: 2, dash: [5, 3]))
        }
        if let ms = measureStart {
            let end = measurePreview ?? ms
            let a = CGPoint(x: ms.x * size.width, y: ms.y * size.height)
            let b = CGPoint(x: end.x * size.width, y: end.y * size.height)
            let px = measurePx(dx: end.x - ms.x, dy: end.y - ms.y)
            ZStack {
                ArrowLineShape(from: a, to: b, arrowHead: false)
                    .stroke(draftColor, style: StrokeStyle(lineWidth: 2, lineCap: .round))
                Circle().fill(draftColor).frame(width: 7, height: 7).position(a)
                Circle().fill(draftColor).frame(width: 7, height: 7).position(b)
                Text("\(Int(px.rounded()))px")
                    .font(.system(size: 12.5, weight: .bold))
                    .foregroundStyle(draftColor)
                    .whiteHalo()
                    .position(
                        abs(end.x - ms.x) >= abs(end.y - ms.y)
                            ? CGPoint(x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 - 9)
                            : CGPoint(x: (a.x + b.x) / 2 + 8, y: (a.y + b.y) / 2)
                    )
            }
        }
    }
}

// MARK: - 辅助形状与效果

/// 带箭头头的线段（对齐 SVG marker-end）
private struct ArrowLineShape: Shape {
    var from: CGPoint
    var to: CGPoint
    var arrowHead = true

    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: from)
        path.addLine(to: to)
        guard arrowHead else { return path }
        let angle = atan2(to.y - from.y, to.x - from.x)
        let headLen: CGFloat = 9
        let spread: CGFloat = 0.42
        let p1 = CGPoint(
            x: to.x - headLen * cos(angle - spread),
            y: to.y - headLen * sin(angle - spread)
        )
        let p2 = CGPoint(
            x: to.x - headLen * cos(angle + spread),
            y: to.y - headLen * sin(angle + spread)
        )
        path.move(to: to)
        path.addLine(to: p1)
        path.move(to: to)
        path.addLine(to: p2)
        return path
    }
}

/// 文字白色描边光晕（对齐 paint-order: stroke #fff 4px）
private struct WhiteHalo: ViewModifier {
    func body(content: Content) -> some View {
        content
            .shadow(color: .white, radius: 1.5, x: 0.8, y: 0.8)
            .shadow(color: .white, radius: 1.5, x: -0.8, y: 0.8)
            .shadow(color: .white, radius: 1.5, x: 0.8, y: -0.8)
            .shadow(color: .white, radius: 1.5, x: -0.8, y: -0.8)
    }
}

private extension View {
    func whiteHalo() -> some View { modifier(WhiteHalo()) }
}

/// 问题清单点击卡片 → 画布标注高亮闪烁（对齐 issue-flash 0.55s × 4）
private struct FlashPulse: ViewModifier {
    let active: Bool
    @State private var dimmed = false

    func body(content: Content) -> some View {
        if active {
            content
                .opacity(dimmed ? 0.25 : 1)
                .onAppear {
                    dimmed = false
                    withAnimation(.easeInOut(duration: 0.275).repeatCount(8, autoreverses: true)) {
                        dimmed = true
                    }
                }
        } else {
            content
        }
    }
}

private func distanceToSegment(_ p: CGPoint, _ a: CGPoint, _ b: CGPoint) -> CGFloat {
    let abx = b.x - a.x, aby = b.y - a.y
    let apx = p.x - a.x, apy = p.y - a.y
    let lenSq = abx * abx + aby * aby
    let t = lenSq == 0 ? 0 : min(1, max(0, (apx * abx + apy * aby) / lenSq))
    let cx = a.x + t * abx, cy = a.y + t * aby
    return hypot(p.x - cx, p.y - cy)
}

private extension CGPoint {
    static func + (l: CGPoint, r: CGPoint) -> CGPoint {
        CGPoint(x: l.x + r.x, y: l.y + r.y)
    }
    static func / (l: CGPoint, r: Double) -> CGPoint {
        CGPoint(x: l.x / r, y: l.y / r)
    }
}
