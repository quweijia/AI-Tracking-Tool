import Foundation
import SwiftData

/// Issue 值快照：撤销/重做需要整条还原（对齐 Electron `db.issues.put(before/after)` 与 `bulkPut/bulkDelete`）。
/// @Model 是引用类型，直接存引用无法还原"改动前"状态，必须复制值。
struct IssueSnapshot {
    var id: String
    var pageId: String
    var targetImage: TargetImage
    var x: Double
    var y: Double
    var width: Double
    var height: Double
    var issueDescription: String
    var severity: Severity
    var category: IssueCategory
    var status: IssueStatus
    var shape: AnnotationShape?
    var color: String?
    var measureValue: String?
    var sampleA: String?
    var sampleB: String?
    var isAISuggested: Bool?
    var aiConfirmed: Bool?
    var source: IssueSource?
    var imgSet: ImgSet?
    var figmaNodeId: String?
    var domPath: String?
    var matchConfidence: Double?
    var aiSuggestion: AISuggestion?
    var fixScreenshotPath: String?
    var fixStatus: FixStatus?
    var fixNote: String?
    var verifiedAt: Double?
    var reverifyCount: Int?
    var createdAt: Double

    init(_ issue: Issue) {
        id = issue.id
        pageId = issue.pageId
        targetImage = issue.targetImage
        x = issue.x
        y = issue.y
        width = issue.width
        height = issue.height
        issueDescription = issue.issueDescription
        severity = issue.severity
        category = issue.category
        status = issue.status
        shape = issue.shape
        color = issue.color
        measureValue = issue.measureValue
        sampleA = issue.sampleA
        sampleB = issue.sampleB
        isAISuggested = issue.isAISuggested
        aiConfirmed = issue.aiConfirmed
        source = issue.source
        imgSet = issue.imgSet
        figmaNodeId = issue.figmaNodeId
        domPath = issue.domPath
        matchConfidence = issue.matchConfidence
        aiSuggestion = issue.aiSuggestion
        fixScreenshotPath = issue.fixScreenshotPath
        fixStatus = issue.fixStatus
        fixNote = issue.fixNote
        verifiedAt = issue.verifiedAt
        reverifyCount = issue.reverifyCount
        createdAt = issue.createdAt
    }

    /// 新建一条同值 Issue（撤销"删除"时重新落库，保持原 id 不变）
    func makeIssue() -> Issue {
        Issue(
            id: id,
            pageId: pageId,
            targetImage: targetImage,
            x: x,
            y: y,
            width: width,
            height: height,
            issueDescription: issueDescription,
            severity: severity,
            category: category,
            status: status,
            shape: shape,
            color: color,
            measureValue: measureValue,
            sampleA: sampleA,
            sampleB: sampleB,
            imgSet: imgSet,
            source: source,
            createdAt: createdAt
        ).applying(self)
    }
}

extension Issue {
    /// 把快照值写回已有实例（撤销"编辑/移动"时整条还原）
    @discardableResult
    func applying(_ snapshot: IssueSnapshot) -> Issue {
        targetImage = snapshot.targetImage
        x = snapshot.x
        y = snapshot.y
        width = snapshot.width
        height = snapshot.height
        issueDescription = snapshot.issueDescription
        severity = snapshot.severity
        category = snapshot.category
        status = snapshot.status
        shape = snapshot.shape
        color = snapshot.color
        measureValue = snapshot.measureValue
        sampleA = snapshot.sampleA
        sampleB = snapshot.sampleB
        isAISuggested = snapshot.isAISuggested
        aiConfirmed = snapshot.aiConfirmed
        source = snapshot.source
        imgSet = snapshot.imgSet
        figmaNodeId = snapshot.figmaNodeId
        domPath = snapshot.domPath
        matchConfidence = snapshot.matchConfidence
        aiSuggestion = snapshot.aiSuggestion
        fixScreenshotPath = snapshot.fixScreenshotPath
        fixStatus = snapshot.fixStatus
        fixNote = snapshot.fixNote
        verifiedAt = snapshot.verifiedAt
        reverifyCount = snapshot.reverifyCount
        createdAt = snapshot.createdAt
        return self
    }
}

/// 标注历史操作（可逆）：add=新增 delete=删除 update=编辑/移动位置
/// （对齐 CompareWorkbench.tsx `HistoryOp`；add 正向=恢复、反向=删除，delete 相反）
enum AnnotationHistoryOp {
    case add([IssueSnapshot])
    case delete([IssueSnapshot])
    case update(before: IssueSnapshot, after: IssueSnapshot)

    /// 是否为新增操作（撤销/重做方向判断用）
    var isAdd: Bool {
        if case .add = self { return true }
        return false
    }
}

/// 标注撤销/重做历史栈（上限 50 步，切页清空；Cmd+Z 撤销、Cmd+Shift+Z 重做）
@MainActor
@Observable
final class AnnotationHistory {
    private(set) var undoStack: [AnnotationHistoryOp] = []
    private(set) var redoStack: [AnnotationHistoryOp] = []

    var canUndo: Bool { !undoStack.isEmpty }
    var canRedo: Bool { !redoStack.isEmpty }

    /// 记录一步操作（入撤销栈并清空重做栈）
    func push(_ op: AnnotationHistoryOp) {
        undoStack.append(op)
        if undoStack.count > 50 { undoStack.removeFirst() }
        redoStack.removeAll()
    }

    func clear() {
        undoStack.removeAll()
        redoStack.removeAll()
    }

    func undo(context: ModelContext, pageId: String?) {
        guard let op = undoStack.popLast() else { return }
        redoStack.append(op)
        apply(op, forward: false, context: context, pageId: pageId)
    }

    func redo(context: ModelContext, pageId: String?) {
        guard let op = redoStack.popLast() else { return }
        undoStack.append(op)
        apply(op, forward: true, context: context, pageId: pageId)
    }

    /// forward：add 重做 / delete 撤销 = 恢复；其余 = 删除；update 按 before/after 整条还原
    private func apply(_ op: AnnotationHistoryOp, forward: Bool, context: ModelContext, pageId: String?) {
        switch op {
        case .add(let snapshots), .delete(let snapshots):
            let restore = (op.isAdd && forward) || (!op.isAdd && !forward)
            if restore {
                for snapshot in snapshots { upsert(snapshot, context: context) }
            } else {
                for snapshot in snapshots {
                    if let live = Self.find(snapshot.id, context: context) { context.delete(live) }
                }
            }
        case .update(let before, let after):
            upsert(forward ? after : before, context: context)
        }
        touch(pageId: pageId, context: context)
        try? context.save()
    }

    /// 触碰页面（updatedAt 驱动项目列表「最近更新」；save 由调用方统一执行）
    private func touch(pageId: String?, context: ModelContext) {
        guard let pageId else { return }
        var descriptor = FetchDescriptor<WalkthroughPage>(predicate: #Predicate { $0.id == pageId })
        descriptor.fetchLimit = 1
        if let page = try? context.fetch(descriptor).first {
            page.updatedAt = nowMs()
        }
    }

    /// 存在同 id 则写值还原，否则重建（覆盖"先删后撤"边界）
    private func upsert(_ snapshot: IssueSnapshot, context: ModelContext) {
        if let live = Self.find(snapshot.id, context: context) {
            live.applying(snapshot)
        } else {
            context.insert(snapshot.makeIssue())
        }
    }

    static func find(_ id: String, context: ModelContext) -> Issue? {
        var descriptor = FetchDescriptor<Issue>(predicate: #Predicate { $0.id == id })
        descriptor.fetchLimit = 1
        return try? context.fetch(descriptor).first
    }
}
