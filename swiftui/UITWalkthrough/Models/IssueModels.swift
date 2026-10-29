import Foundation
import SwiftData

/// 走查问题标注（Dexie `issues` 表）。
/// 坐标为归一化（0~1），相对所属图（targetImage + imgSet 决定哪张）左上角，与分辨率解耦。
/// 命名映射：Electron 字段 description → issueDescription（避开保留名），其余字段一一对应。
@Model
final class Issue {
    @Attribute(.unique) var id: String
    var pageId: String
    /// 标注所在图：设计稿 / 开发截图
    var targetImage: TargetImage
    /// 归一化坐标（0~1），标注框左上角与宽高
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    /// 问题描述（Electron 字段 description）
    var issueDescription: String
    var severity: Severity
    var category: IssueCategory
    var status: IssueStatus
    /// 标注形状，缺省视为 rect
    var shape: AnnotationShape?
    /// 自定义标注颜色（hex），缺省按严重度着色
    var color: String?
    /// 测量标注的尺寸文案（如「128px」），创建时按图片原始尺寸计算，可直接修改
    var measureValue: String?
    /// 吸色标注：设计稿取样色（hex）
    var sampleA: String?
    /// 吸色标注：开发截图取样色（hex），与 sampleA 组成双图对比
    var sampleB: String?
    /// AI 候选标记
    var isAISuggested: Bool?
    var aiConfirmed: Bool?
    /// 问题来源：结构化比对 / 图片视觉比对（AI）/ 手动标注 / 规范校验 / 元素清单 / 无障碍（旧数据缺省视为手动）
    var source: IssueSource?
    /// 图集归属：walk=自动走查双图上的标注，manual=手动上传双图上的标注（缺省视为 manual）
    var imgSet: ImgSet?
    /// 结构化比对回溯：设计稿 Figma 节点 ID
    var figmaNodeId: String?
    /// 结构化比对回溯：DOM 选择器路径
    var domPath: String?
    /// 结构化比对回溯：匹配置信度 0~1
    var matchConfidence: Double?
    /// AI 结构化修复建议（现状 → 建议改法 → 涉及属性），采纳后随报告导出
    var aiSuggestion: AISuggestion?
    // 复验
    /// 复验上传的修复后截图路径
    var fixScreenshotPath: String?
    var fixStatus: FixStatus?
    var fixNote: String?
    /// 最近一次复验时间戳
    var verifiedAt: Double?
    /// 复验判定次数（通过/打回各计一次）
    var reverifyCount: Int?
    var createdAt: Double

    init(
        id: String = genId(),
        pageId: String,
        targetImage: TargetImage = .screenshot,
        x: Double,
        y: Double,
        width: Double,
        height: Double,
        issueDescription: String,
        severity: Severity = .minor,
        category: IssueCategory = .style,
        status: IssueStatus = .pending,
        shape: AnnotationShape? = nil,
        color: String? = nil,
        measureValue: String? = nil,
        sampleA: String? = nil,
        sampleB: String? = nil,
        imgSet: ImgSet? = nil,
        source: IssueSource? = nil,
        createdAt: Double = nowMs()
    ) {
        self.id = id
        self.pageId = pageId
        self.targetImage = targetImage
        self.x = x
        self.y = y
        self.width = width
        self.height = height
        self.issueDescription = issueDescription
        self.severity = severity
        self.category = category
        self.status = status
        self.shape = shape
        self.color = color
        self.measureValue = measureValue
        self.sampleA = sampleA
        self.sampleB = sampleB
        self.imgSet = imgSet
        self.source = source
        self.createdAt = createdAt
    }

    /// 标注渲染色：自定义颜色优先，缺省按严重度（对齐渲染层规则）
    var displayColorHex: String { color ?? severity.colorHex }

    /// 缺省形状（旧数据无 shape 字段，默认按 rect 渲染）
    var displayShape: AnnotationShape { shape ?? .rect }

    /// 缺省图集归属（旧数据缺省视为 manual）
    var displayImgSet: ImgSet { imgSet ?? .manual }
}
