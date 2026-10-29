import Foundation

// MARK: - 项目 / 页面

/// 适用端类型（Electron：Dexie `Platform`；项目侧多选、页面侧单选，rawValue 与 Dexie 存储串一致）
enum Platform: String, Codable, CaseIterable, Identifiable, Sendable {
    case h5
    case pc
    case dashboard
    case electron

    var id: String { rawValue }

    /// Electron db/index.ts `PLATFORM_LABELS`
    var label: String {
        switch self {
        case .h5: "移动端"
        case .pc: "PC 端"
        case .dashboard: "可视化大屏"
        case .electron: "Electron 桌面"
        }
    }
}

/// 页面走查状态（固定三态；文案对齐 assistant/context.ts `PAGE_STATUS_LABELS`）
enum PageStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case pending
    case reviewing
    case completed

    var id: String { rawValue }

    var label: String {
        switch self {
        case .pending: "待走查"
        case .reviewing: "走查中"
        case .completed: "已完成"
        }
    }
}

// MARK: - 问题清单

/// 问题状态（Electron：Dexie `IssueStatus`）
enum IssueStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case pending
    case inProgress = "in-progress"
    case fixed
    case ignored
    case designConfirmed = "design-confirmed"

    var id: String { rawValue }

    /// Electron db/index.ts `ISSUE_STATUS_LABELS`
    var label: String {
        switch self {
        case .pending: "待修复"
        case .inProgress: "修复中"
        case .fixed: "已修复"
        case .ignored: "已忽略"
        case .designConfirmed: "设计确认不改"
        }
    }
}

/// 严重等级（三档；文案对齐 db/index.ts `SEVERITY_LABELS`：建议/一般/严重）
enum Severity: String, Codable, CaseIterable, Identifiable, Sendable {
    case suggestion
    case minor
    case major

    var id: String { rawValue }

    var label: String {
        switch self {
        case .suggestion: "建议"
        case .minor: "一般"
        case .major: "严重"
        }
    }

    /// 按严重度自动着色的缺省色（对齐 ExportReport.tsx `SEV_COLORS`）
    var colorHex: String {
        switch self {
        case .major: "#dc2626"
        case .minor: "#f59e0b"
        case .suggestion: "#64748b"
        }
    }
}

/// 问题分类（Electron：Dexie `Category`，7 类；rawValue 与存储串一致）
enum IssueCategory: String, Codable, CaseIterable, Identifiable, Sendable {
    case spacing
    case typography
    case color
    case style
    case missingComponent = "missing-component"
    case interaction
    case compatibility

    var id: String { rawValue }

    /// Electron db/index.ts `CATEGORY_LABELS`
    var label: String {
        switch self {
        case .spacing: "间距规范"
        case .typography: "文字排版"
        case .color: "颜色规范"
        case .style: "样式规范"
        case .missingComponent: "组件缺失"
        case .interaction: "交互体验"
        case .compatibility: "兼容性问题"
        }
    }

    /// 报告分析图表配色（对齐 ExportReport.tsx `CAT_COLORS`；missing-component 报告未定义，返回 nil 由调用方兜底）
    var reportColorHex: String? {
        switch self {
        case .spacing: "#2563eb"
        case .typography: "#7c3aed"
        case .color: "#f59e0b"
        case .style: "#dc2626"
        case .interaction: "#06b6d4"
        case .compatibility: "#16a34a"
        case .missingComponent: nil
        }
    }
}

/// 标注落在哪张图上（设计稿 / 开发截图）
enum TargetImage: String, Codable, CaseIterable, Identifiable, Sendable {
    case design
    case screenshot

    var id: String { rawValue }

    var label: String {
        switch self {
        case .design: "设计稿"
        case .screenshot: "开发截图"
        }
    }
}

/// 标注形状（框选/点位/箭头/文字/测量/吸色；rawValue 与 Dexie 存储串一致）
enum AnnotationShape: String, Codable, CaseIterable, Identifiable, Sendable {
    case rect
    case point
    case arrow
    case text
    case measure
    case picker

    var id: String { rawValue }

    /// Electron db/index.ts `SHAPE_LABELS`
    var label: String {
        switch self {
        case .rect: "框选"
        case .point: "点位"
        case .arrow: "箭头"
        case .text: "文字"
        case .measure: "测量"
        case .picker: "吸色"
        }
    }
}

/// 问题来源（结构化比对 / 视觉比对（AI）/ 手动标注 / 规范 Token 校验 / 元素清单 / 无障碍）
enum IssueSource: String, Codable, CaseIterable, Identifiable, Sendable {
    case structured
    case visual
    case manual
    case spec
    case element
    case a11y

    var id: String { rawValue }

    /// 文案对齐 i18n/zh-CN/sourceBadge.ts
    var label: String {
        switch self {
        case .structured: "结构化比对"
        case .visual: "视觉比对"
        case .manual: "手动标注"
        case .spec: "规范校验"
        case .element: "元素清单"
        case .a11y: "无障碍"
        }
    }
}

/// 图集归属：walk=自动走查双图上的标注，manual=手动上传双图上的标注（旧数据缺省视为 manual）
enum ImgSet: String, Codable, CaseIterable, Identifiable, Sendable {
    case manual
    case walk

    var id: String { rawValue }

    var label: String {
        switch self {
        case .manual: "手动标注"
        case .walk: "自动走查"
        }
    }
}

/// 复验判定结果
enum FixStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case passed
    case failed

    var id: String { rawValue }
}

// MARK: - 报告

/// 导出类型（HTML 交互报告 / 飞书 / 腾讯 / 金山 / 研发修改报告）
enum ReportType: String, Codable, CaseIterable, Identifiable, Sendable {
    case html
    case feishu
    case tencent
    case kingsoft
    case dev

    var id: String { rawValue }

    /// 文案对齐 assistant/context.ts `REPORT_TYPE_LABELS`
    var label: String {
        switch self {
        case .html: "HTML 交互报告"
        case .feishu: "飞书文档"
        case .tencent: "腾讯文档"
        case .kingsoft: "金山文档"
        case .dev: "研发修改报告"
        }
    }
}

// MARK: - 设计规范 Token

/// Token 内部类别（7 类，rawValue 与 Dexie / 引擎 JSON 的 kind 串一致）
enum TokenKind: String, Codable, CaseIterable, Identifiable, Sendable {
    case color
    case spacing
    case fontSize
    case lineHeight
    case radius
    case shadow
    case border

    var id: String { rawValue }

    /// 内部 7 类 kind → 对外 5 类 type（对齐 shared/types.ts `TOKEN_KIND_TO_TYPE`）
    var standardType: TokenType {
        switch self {
        case .color: .color
        case .spacing: .dimension
        case .fontSize: .typography
        case .lineHeight: .typography
        case .radius: .radius
        case .shadow: .shadow
        case .border: .dimension
        }
    }
}

/// Token 提取来源：Figma 变量 / Figma 样式 / 启发式图层扫描兜底
enum TokenSource: String, Codable, CaseIterable, Identifiable, Sendable {
    case variable
    case style
    case heuristic

    var id: String { rawValue }
}

/// 对外标准 Token 类型（用户口径：color / dimension / radius / shadow / typography）
enum TokenType: String, Codable, CaseIterable, Identifiable, Sendable {
    case color
    case dimension
    case radius
    case shadow
    case typography

    var id: String { rawValue }
}

/// 规范 Token 映射状态：已匹配 / 待确认
enum TokenMappingStatus: String, Codable, CaseIterable, Identifiable, Sendable {
    case matched
    case pending

    var id: String { rawValue }

    var label: String {
        switch self {
        case .matched: "已匹配"
        case .pending: "待确认"
        }
    }
}

// MARK: - 标注颜色预设

/// 标注自定义颜色预设（value 为 nil = 按严重度自动着色；对齐 db/index.ts `ANNOTATION_COLORS`）
struct AnnotationColorPreset: Identifiable, Sendable, Equatable {
    let value: String?
    let label: String
    var id: String { value ?? "" }
}

enum AnnotationColorCatalog {
    static let presets: [AnnotationColorPreset] = [
        .init(value: nil, label: "按严重度"),
        .init(value: "#ef4444", label: "红色"),
        .init(value: "#f59e0b", label: "橙色"),
        .init(value: "#2563eb", label: "蓝色"),
        .init(value: "#16a34a", label: "绿色"),
        .init(value: "#9333ea", label: "紫色"),
        .init(value: "#ffffff", label: "白色"),
        .init(value: "#000000", label: "黑色")
    ]
}
