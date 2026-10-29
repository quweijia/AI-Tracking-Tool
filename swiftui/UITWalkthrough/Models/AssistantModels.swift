import Foundation
import SwiftData

/// AI 小助手对话消息：按项目/页面维度隔离持久化（pageId 空串 = 项目列表页的项目级会话）
@Model
final class AssistantMessage {
    @Attribute(.unique) var id: String
    var projectId: String
    var pageId: String
    /// user=用户提问，assistant=AI 回复
    var role: AssistantRole
    var content: String
    /// 用户消息携带的 @引用快照（assistant 消息无此字段）
    var refs: [AssistantRef]?
    var createdAt: Double

    init(
        id: String = genId(),
        projectId: String,
        pageId: String,
        role: AssistantRole,
        content: String,
        refs: [AssistantRef]? = nil,
        createdAt: Double = nowMs()
    ) {
        self.id = id
        self.projectId = projectId
        self.pageId = pageId
        self.role = role
        self.content = content
        self.refs = refs
        self.createdAt = createdAt
    }
}

/// 消息角色
enum AssistantRole: String, Codable, Sendable, CaseIterable {
    case user
    case assistant
}
