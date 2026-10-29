import Foundation

// MARK: - 走查容差（对齐 shared/types.ts ToleranceConfig / DEFAULT_TOLERANCE）

/// 容差配置（全局一套，设置页可调；阈值过紧会把渲染抗锯齿/取整误差当差异报出）
struct ToleranceConfig: Codable, Equatable, Sendable {
    /// 尺寸容差 px（宽/高/位置）
    var size: Double
    /// 文字排版容差 px（字号/行高/字间距）
    var typography: Double
    /// 间距容差 px（padding/gap）
    var spacing: Double
    /// 圆角容差 px
    var radius: Double
    /// 色差容差（ΔE CIEDE2000）
    var color: Double
    /// 描边容差 px
    var border: Double

    /// 默认走查容差（「实际落地走查可执行」口径）
    static let defaultValue = ToleranceConfig(size: 2, typography: 2, spacing: 4, radius: 2, color: 8, border: 2)

    /// 校正非法容差输入并合并默认值（对齐 normalizeTolerance：非有限数/负数回退默认，保留 2 位小数）
    static func normalize(_ raw: ToleranceConfig?) -> ToleranceConfig {
        guard let raw else { return defaultValue }
        return ToleranceConfig(
            size: clamp(raw.size, defaultValue.size),
            typography: clamp(raw.typography, defaultValue.typography),
            spacing: clamp(raw.spacing, defaultValue.spacing),
            radius: clamp(raw.radius, defaultValue.radius),
            color: clamp(raw.color, defaultValue.color),
            border: clamp(raw.border, defaultValue.border)
        )
    }

    private static func clamp(_ v: Double, _ fallback: Double) -> Double {
        v.isFinite && v >= 0 ? (v * 100).rounded() / 100 : fallback
    }
}

// MARK: - 自动走查自定义检查项（对齐 shared/types.ts WalkCheckOptions）

/// 检查深度：宽松 / 标准（推荐）/ 严格
enum WalkDepth: String, Codable, Sendable, CaseIterable {
    case loose
    case standard
    case strict

    var label: String {
        switch self {
        case .loose: "宽松"
        case .standard: "标准（推荐）"
        case .strict: "严格"
        }
    }
}

/// 输出风格：简洁 / 详细
enum WalkOutputStyle: String, Codable, Sendable, CaseIterable {
    case concise
    case detailed

    var label: String {
        switch self {
        case .concise: "简洁"
        case .detailed: "详细"
        }
    }
}

/// 检查维度 / AI 分析设置的静态目录（label 与面板勾选项一致，对齐 WALK_DIMENSIONS / WALK_ANALYSES）
enum WalkCatalog {
    struct Dimension: Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        var id: String { key }
    }

    struct Analysis: Identifiable, Sendable, Equatable {
        let key: String
        let label: String
        var id: String { key }
    }

    /// AI 视觉走查 6 项检查维度
    static let dimensions: [Dimension] = [
        .init(key: "text", label: "文字类"),
        .init(key: "layout", label: "对齐布局"),
        .init(key: "image", label: "图标图片"),
        .init(key: "state", label: "组件状态"),
        .init(key: "color", label: "色彩"),
        .init(key: "typography", label: "排版")
    ]

    /// AI 分析设置
    static let analyses: [Analysis] = [
        .init(key: "locate", label: "问题定位与原因"),
        .init(key: "fix", label: "修改建议"),
        .init(key: "risk", label: "风险评估"),
        .init(key: "priority", label: "优化优先级")
    ]
}

/// 自动走查自定义检查项（持久化在应用配置的 walkCheckOptions 键）
struct WalkCheckOptions: Codable, Equatable, Sendable {
    /// 检查维度 key 列表（WalkCatalog.dimensions 子集）
    var dimensions: [String]
    /// 检查深度
    var depth: WalkDepth
    /// AI 分析设置 key 列表（WalkCatalog.analyses 子集）
    var analysis: [String]
    /// 输出风格
    var style: WalkOutputStyle
    /// 按需叠加无障碍 a11y 检查（默认关闭）
    var a11y: Bool

    static let defaultValue = WalkCheckOptions(
        dimensions: WalkCatalog.dimensions.map(\.key),
        depth: .standard,
        analysis: WalkCatalog.analyses.map(\.key),
        style: .detailed,
        a11y: false
    )

    /// 校正本地存储的检查项：过滤已下线的维度 key，补齐缺省字段（对齐 normalizeWalkCheckOptions）
    static func normalize(_ raw: WalkCheckOptions?) -> WalkCheckOptions {
        guard let raw else { return defaultValue }
        let validDims = Set(WalkCatalog.dimensions.map(\.key))
        let validAnalyses = Set(WalkCatalog.analyses.map(\.key))
        let dims = raw.dimensions.filter { validDims.contains($0) }
        let analyses = raw.analysis.filter { validAnalyses.contains($0) }
        return WalkCheckOptions(
            dimensions: dims.isEmpty ? defaultValue.dimensions : dims,
            depth: raw.depth,
            analysis: analyses.isEmpty ? defaultValue.analysis : analyses,
            style: raw.style,
            a11y: raw.a11y
        )
    }
}

// MARK: - Token 值（对齐 shared/types.ts SpecTokenValue）

/// 单层阴影（box-shadow 通用结构）
struct ShadowLayer: Codable, Equatable, Sendable {
    var x: Double
    var y: Double
    var blur: Double
    var spread: Double?
    /// hex 色值
    var color: String
    var inset: Bool?
}

/// Token 值（JSON 序列化后存 specTokens.value；kind 判别，与 Electron JSON 结构逐字段兼容）
enum SpecTokenValue: Equatable, Sendable {
    case color(hex: String)
    case spacing(value: Double)
    case fontSize(value: Double)
    case lineHeight(value: Double)
    case radius(value: Double)
    case shadow(layers: [ShadowLayer])
    case border(width: Double, style: String, color: String)
}

extension SpecTokenValue: Codable {
    private enum CodingKeys: String, CodingKey {
        case kind, hex, value, unit, layers, width, style, color
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .kind) {
        case "color":
            self = .color(hex: try c.decode(String.self, forKey: .hex))
        case "spacing":
            self = .spacing(value: try c.decode(Double.self, forKey: .value))
        case "fontSize":
            self = .fontSize(value: try c.decode(Double.self, forKey: .value))
        case "lineHeight":
            self = .lineHeight(value: try c.decode(Double.self, forKey: .value))
        case "radius":
            self = .radius(value: try c.decode(Double.self, forKey: .value))
        case "shadow":
            self = .shadow(layers: try c.decode([ShadowLayer].self, forKey: .layers))
        case "border":
            self = .border(
                width: try c.decode(Double.self, forKey: .width),
                style: try c.decode(String.self, forKey: .style),
                color: try c.decode(String.self, forKey: .color)
            )
        case let kind:
            throw DecodingError.dataCorruptedError(
                forKey: .kind, in: c, debugDescription: "未知 Token 值类型: \(kind)"
            )
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        switch self {
        case .color(let hex):
            try c.encode("color", forKey: .kind)
            try c.encode(hex, forKey: .hex)
        case .spacing(let v):
            try c.encode("spacing", forKey: .kind)
            try c.encode(v, forKey: .value)
            try c.encode("px", forKey: .unit)
        case .fontSize(let v):
            try c.encode("fontSize", forKey: .kind)
            try c.encode(v, forKey: .value)
            try c.encode("px", forKey: .unit)
        case .lineHeight(let v):
            try c.encode("lineHeight", forKey: .kind)
            try c.encode(v, forKey: .value)
            try c.encode("px", forKey: .unit)
        case .radius(let v):
            try c.encode("radius", forKey: .kind)
            try c.encode(v, forKey: .value)
            try c.encode("px", forKey: .unit)
        case .shadow(let layers):
            try c.encode("shadow", forKey: .kind)
            try c.encode(layers, forKey: .layers)
        case .border(let width, let style, let color):
            try c.encode("border", forKey: .kind)
            try c.encode(width, forKey: .width)
            try c.encode(style, forKey: .style)
            try c.encode(color, forKey: .color)
        }
    }
}

extension SpecTokenValue {
    /// 展示值（Token 预览 / 报告）：色值原样、尺寸带 px 单位、阴影转 CSS box-shadow 片段、边框转 CSS 简写
    var displayText: String {
        switch self {
        case .color(let hex):
            return hex.uppercased()
        case .spacing(let v), .fontSize(let v), .lineHeight(let v), .radius(let v):
            return formatPx(v)
        case .shadow(let layers):
            return layers.map { layer in
                var parts = [formatPx(layer.x), formatPx(layer.y), formatPx(layer.blur)]
                if let spread = layer.spread { parts.append(formatPx(spread)) }
                if layer.inset == true { parts.insert("inset", at: 0) }
                parts.append(layer.color.uppercased())
                return parts.joined(separator: " ")
            }.joined(separator: ", ")
        case .border(let width, let style, let color):
            return "\(formatPx(width)) \(style) \(color.uppercased())"
        }
    }

    private func formatPx(_ v: Double) -> String {
        v == v.rounded() ? String(Int(v)) : String(v)
    }
}

// MARK: - 结构化修复建议 / 助手引用

/// AI 结构化修复建议（现状 → 建议改法 → 涉及属性），采纳后随报告导出
struct AISuggestion: Codable, Equatable, Sendable {
    var current: String
    var fix: String
    var properties: String?
}

/// 助手消息携带的 @引用：type 决定注入的上下文对象，label 为引用气泡展示文案
struct AssistantRef: Codable, Equatable, Sendable, Hashable {
    enum Kind: String, Codable, Sendable {
        case project
        case page
        case report
        case issue
    }

    var type: Kind
    /// 引用目标 id（项目/页面/报告/问题）
    var id: String
    var label: String
}
