import Foundation
import SwiftData

// MARK: - 项目 / 文件夹 / 页面 / 访问记录 / 报告记录（镜像 Dexie projects / folders / pages / visits / reportRecords）

/// 项目（Dexie `projects` 表）
@Model
final class Project {
    @Attribute(.unique) var id: String
    var name: String
    /// 适用端类型（可多选；旧 Electron 数据为单选字符串，读取时归一化为数组）
    var platform: [Platform]
    /// 项目 Logo 图片（本地相对路径），缺省用名称首字符占位
    var logoPath: String?
    /// 无 Logo 时文字占位底色（hex，用户自选），缺省按 id 散列取色
    var logoColor: String?
    /// 侧边栏树状菜单手动排序值（拖拽生成，小值在前），缺省按创建时间
    var sortNo: Int?
    var createdAt: Double
    var updatedAt: Double

    init(
        id: String = genId(),
        name: String,
        platform: [Platform] = [],
        logoPath: String? = nil,
        logoColor: String? = nil,
        sortNo: Int? = nil,
        createdAt: Double = nowMs(),
        updatedAt: Double = nowMs()
    ) {
        self.id = id
        self.name = name
        self.platform = platform
        self.logoPath = logoPath
        self.logoColor = logoColor
        self.sortNo = sortNo
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// 列表排序键（手动 sortNo 优先，未拖过的按创建时间）
    var sortOrder: Double { effectiveSortOrder(sortNo: sortNo, createdAt: createdAt) }
}

/// 分组文件夹：项目内与页面并列展示，支持多层嵌套（Dexie `folders` 表）
@Model
final class Folder {
    @Attribute(.unique) var id: String
    var projectId: String
    /// 父文件夹 id（缺省为项目根级）
    var parentId: String?
    var name: String
    /// 文件夹 icon（预设 key）
    var icon: String?
    /// 文件夹主题色（hex，用于 icon 着色）
    var color: String?
    /// 侧边栏树状菜单手动排序值
    var sortNo: Int?
    var createdAt: Double

    init(
        id: String = genId(),
        projectId: String,
        parentId: String? = nil,
        name: String,
        icon: String? = nil,
        color: String? = nil,
        sortNo: Int? = nil,
        createdAt: Double = nowMs()
    ) {
        self.id = id
        self.projectId = projectId
        self.parentId = parentId
        self.name = name
        self.icon = icon
        self.color = color
        self.sortNo = sortNo
        self.createdAt = createdAt
    }

    var sortOrder: Double { effectiveSortOrder(sortNo: sortNo, createdAt: createdAt) }
}

/// 走查页面（Dexie `pages` 表）
@Model
final class WalkthroughPage {
    @Attribute(.unique) var id: String
    /// 所属分组文件夹（缺省直接挂在项目根级与文件夹并列展示）
    var folderId: String?
    var projectId: String
    var pageName: String
    var platform: Platform
    /// 手动上传设计稿路径
    var designImagePath: String
    /// 手动上传开发截图路径
    var screenshotPath: String
    /// 设计稿 Figma 链接（非必选），报告中可点击跳转
    var figmaUrl: String?
    /// 开发环境页面 URL（自动走查用，非必选）
    var devUrl: String?
    /// 自动走查独立双图：Figma 采集设计稿（与手动上传的设计稿隔离，不互相覆盖）
    var walkDesignPath: String?
    /// 自动走查独立双图：开发页面采集截图（与手动上传的开发截图隔离）
    var walkShotPath: String?
    var status: PageStatus
    /// 侧边栏树状菜单手动排序值
    var sortNo: Int?
    var createdAt: Double
    /// 最后修改时间（重新上传图片/编辑信息时刷新），用于「最近访问」排序
    var updatedAt: Double?
    /// 验收状态：导出报告页「验收通过」后置 true，分析报告页状态列联动「已完成」
    var accepted: Bool?
    var acceptedAt: Double?

    init(
        id: String = genId(),
        folderId: String? = nil,
        projectId: String,
        pageName: String,
        platform: Platform,
        designImagePath: String = "",
        screenshotPath: String = "",
        figmaUrl: String? = nil,
        devUrl: String? = nil,
        walkDesignPath: String? = nil,
        walkShotPath: String? = nil,
        status: PageStatus = .pending,
        sortNo: Int? = nil,
        createdAt: Double = nowMs(),
        updatedAt: Double? = nil,
        accepted: Bool? = nil,
        acceptedAt: Double? = nil
    ) {
        self.id = id
        self.folderId = folderId
        self.projectId = projectId
        self.pageName = pageName
        self.platform = platform
        self.designImagePath = designImagePath
        self.screenshotPath = screenshotPath
        self.figmaUrl = figmaUrl
        self.devUrl = devUrl
        self.walkDesignPath = walkDesignPath
        self.walkShotPath = walkShotPath
        self.status = status
        self.sortNo = sortNo
        self.createdAt = createdAt
        self.updatedAt = updatedAt
        self.accepted = accepted
        self.acceptedAt = acceptedAt
    }

    var sortOrder: Double { effectiveSortOrder(sortNo: sortNo, createdAt: createdAt) }
}

/// 页面访问记录：用于「最近访问」页统计与分组展示（Dexie `visits` 表）
@Model
final class Visit {
    @Attribute(.unique) var id: String
    var pageId: String
    var projectId: String
    var visitedAt: Double

    init(id: String = genId(), pageId: String, projectId: String, visitedAt: Double = nowMs()) {
        self.id = id
        self.pageId = pageId
        self.projectId = projectId
        self.visitedAt = visitedAt
    }
}

/// 导出历史记录（HTML 报告 / 云文档推送），为后续推送项目管理工具预留（Dexie `reportRecords` 表）
@Model
final class ReportRecord {
    @Attribute(.unique) var id: String
    var pageId: String
    var projectId: String
    var type: ReportType
    var name: String
    /// 飞书文档链接等可回访地址
    var url: String?
    /// HTML 报告导出文件绝对路径（分析报告页打开用；旧记录无此字段）
    var filePath: String?
    /// 导出时的问题统计
    var total: Int
    var createdAt: Double

    init(
        id: String = genId(),
        pageId: String,
        projectId: String,
        type: ReportType,
        name: String,
        url: String? = nil,
        filePath: String? = nil,
        total: Int,
        createdAt: Double = nowMs()
    ) {
        self.id = id
        self.pageId = pageId
        self.projectId = projectId
        self.type = type
        self.name = name
        self.url = url
        self.filePath = filePath
        self.total = total
        self.createdAt = createdAt
    }
}
