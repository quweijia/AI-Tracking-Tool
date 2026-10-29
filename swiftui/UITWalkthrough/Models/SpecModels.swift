import Foundation
import SwiftData

// MARK: - 设计规范空间（镜像 Dexie v6 五表：specCategories / designSpecs / specVersions / specTokens / projectSpecBindings / specTokenMappings）

/// 端分类（规范空间一级菜单）：预置 4 类映射 Platform，可改名不可删；自定义分类创建时强制选择映射端类型
@Model
final class SpecCategory {
    @Attribute(.unique) var id: String
    var name: String
    /// 映射的页面端类型（走查取套依据：page.platform → platformKey）
    var platformKey: Platform
    /// 预置标记：1=预置（可改名不可删），0=自定义（可删）
    var builtin: Int
    var sortNo: Int?
    var createdAt: Double

    init(
        id: String = genId(),
        name: String,
        platformKey: Platform,
        builtin: Int = 0,
        sortNo: Int? = nil,
        createdAt: Double = nowMs()
    ) {
        self.id = id
        self.name = name
        self.platformKey = platformKey
        self.builtin = builtin
        self.sortNo = sortNo
        self.createdAt = createdAt
    }

    var isBuiltin: Bool { builtin == 1 }
    var sortOrder: Double { effectiveSortOrder(sortNo: sortNo, createdAt: createdAt) }
}

/// 规范套：一个端分类下可建多套，走查项目按端分类各绑一套
@Model
final class DesignSpec {
    @Attribute(.unique) var id: String
    var categoryId: String
    var name: String
    /// Figma 规范链接（Token 提取以链接 API 解析为准）
    var figmaUrl: String?
    /// 解析出的 Figma file key（同步时回填）
    var figmaFileKey: String?
    /// Figma 文件名（同步时回填）
    var figFileName: String?
    /// .fig 上传存档路径（仅存档不解析）
    var figArchivePath: String?
    var note: String?
    /// 最近同步时间
    var lastSyncedAt: Double?
    var createdAt: Double
    var updatedAt: Double

    init(
        id: String = genId(),
        categoryId: String,
        name: String,
        figmaUrl: String? = nil,
        figmaFileKey: String? = nil,
        figFileName: String? = nil,
        figArchivePath: String? = nil,
        note: String? = nil,
        lastSyncedAt: Double? = nil,
        createdAt: Double = nowMs(),
        updatedAt: Double = nowMs()
    ) {
        self.id = id
        self.categoryId = categoryId
        self.name = name
        self.figmaUrl = figmaUrl
        self.figmaFileKey = figmaFileKey
        self.figFileName = figFileName
        self.figArchivePath = figArchivePath
        self.note = note
        self.lastSyncedAt = lastSyncedAt
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

/// 同步历史版本：当前生效 = 最新版本；回滚 = 历史版本 Token 复制为新版本（追加式保留审计链）
@Model
final class SpecVersion {
    @Attribute(.unique) var id: String
    var specId: String
    /// 递增版本号 V1..Vn
    var no: Int
    var syncedAt: Double
    var sourceFileKey: String?
    var tokenCount: Int
    /// 变更摘要（新增/删除/修改 计数），同步完成 toast 与历史列表展示
    var summary: String?

    init(
        id: String = genId(),
        specId: String,
        no: Int,
        syncedAt: Double = nowMs(),
        sourceFileKey: String? = nil,
        tokenCount: Int,
        summary: String? = nil
    ) {
        self.id = id
        self.specId = specId
        self.no = no
        self.syncedAt = syncedAt
        self.sourceFileKey = sourceFileKey
        self.tokenCount = tokenCount
        self.summary = summary
    }
}

/// Token 行：value 为 SpecTokenValue 的 JSON 序列化串（Dexie `specTokens` 表）
@Model
final class SpecToken {
    @Attribute(.unique) var id: String
    var specId: String
    var versionId: String
    var kind: TokenKind
    /// Figma 原始变量名（最后一段用户命名，不自动改名），导出保留原名
    var name: String
    /// 完整分组路径（变量集/文件夹层级，/ 分组，导出命名依据）
    var path: String
    /// JSON 序列化的 SpecTokenValue
    var value: String
    var source: TokenSource
    /// Figma 变量描述
    var tokenDescription: String?
    /// Figma 原生 variable id（映射与回溯依据）
    var tokenId: String?
    /// Figma 完整原始变量名（含文件夹段），解析预览对照表左列
    var figmaName: String?
    /// 所属模式（浅色/深色…），多模式每模式一行
    var mode: String?
    /// 三层 Token 体系归属层（Primitive / Semantic / Component），单层体系缺省
    var tier: String?
    /// 是否集合默认模式
    var isDefaultMode: Bool?
    /// codeSyntax 自动生成代码别名（独立字段，不覆盖 name）
    var rawCode: String?
    /// 对外标准类型（kind 的用户口径映射）
    var type: TokenType?
    /// 别名引用链原始文本（{a.b.c} 去花括号原文 / 目标变量完整原始名），引用 Token 点击查看解析值
    var aliasRef: String?
    /// 入库序号：保持 Figma 解析 / JSON 导入的原始分组与排序
    var sortNo: Int?

    init(
        id: String = genId(),
        specId: String,
        versionId: String,
        kind: TokenKind,
        name: String,
        path: String,
        value: String,
        source: TokenSource,
        tokenDescription: String? = nil,
        tokenId: String? = nil,
        figmaName: String? = nil,
        mode: String? = nil,
        tier: String? = nil,
        isDefaultMode: Bool? = nil,
        rawCode: String? = nil,
        type: TokenType? = nil,
        aliasRef: String? = nil,
        sortNo: Int? = nil
    ) {
        self.id = id
        self.specId = specId
        self.versionId = versionId
        self.kind = kind
        self.name = name
        self.path = path
        self.value = value
        self.source = source
        self.tokenDescription = tokenDescription
        self.tokenId = tokenId
        self.figmaName = figmaName
        self.mode = mode
        self.tier = tier
        self.isDefaultMode = isDefaultMode
        self.rawCode = rawCode
        self.type = type
        self.aliasRef = aliasRef
        self.sortNo = sortNo
    }

    /// 反序列化 Token 值（损坏数据返回 nil 不阻塞，对齐 parseTokenValue）
    var tokenValue: SpecTokenValue? {
        guard let data = value.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(SpecTokenValue.self, from: data)
    }

    /// 对外标准类型（缺省按 kind 映射）
    var displayType: TokenType { type ?? kind.standardType }
}

/// 项目↔规范绑定：一项目可绑多套（每端分类一套），走查按页面端类型自动取套
@Model
final class ProjectSpecBinding {
    @Attribute(.unique) var id: String
    var projectId: String
    var specId: String
    var createdAt: Double

    init(id: String = genId(), projectId: String, specId: String, createdAt: Double = nowMs()) {
        self.id = id
        self.projectId = projectId
        self.specId = specId
        self.createdAt = createdAt
    }
}

/// 规范 Token 映射：原始解析 token ↔ 目标标准 token 绑定关系。
/// 按项目+规范隔离持久化，切换项目/规范互不影响；sourceKey = `${tokenId ?? name}|${mode ?? ''}`。
@Model
final class SpecTokenMapping {
    @Attribute(.unique) var id: String
    var projectId: String
    var specId: String
    /// 源 token 唯一键：`${tokenId ?? name}|${mode ?? ''}`
    var sourceKey: String
    /// 源 token 展示信息快照（映射表直接渲染，免联表）
    var sourceName: String
    var sourcePath: String
    /// 目标标准 token 名称与分组路径
    var targetName: String
    var targetPath: String
    var status: TokenMappingStatus
    var createdAt: Double
    var updatedAt: Double

    init(
        id: String = genId(),
        projectId: String,
        specId: String,
        sourceKey: String,
        sourceName: String,
        sourcePath: String,
        targetName: String,
        targetPath: String,
        status: TokenMappingStatus = .pending,
        createdAt: Double = nowMs(),
        updatedAt: Double = nowMs()
    ) {
        self.id = id
        self.projectId = projectId
        self.specId = specId
        self.sourceKey = sourceKey
        self.sourceName = sourceName
        self.sourcePath = sourcePath
        self.targetName = targetName
        self.targetPath = targetPath
        self.status = status
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }
}

// MARK: - 预置端分类

/// 预置端分类（platformKey → 默认名，与 PLATFORM_LABELS 一致；界面展示时 builtin 分类走 label）
enum BuiltinSpecCategories {
    static let items: [(name: String, platformKey: Platform)] = [
        ("移动端", .h5),
        ("PC 端", .pc),
        ("可视化大屏", .dashboard),
        ("Electron 桌面", .electron)
    ]
}
