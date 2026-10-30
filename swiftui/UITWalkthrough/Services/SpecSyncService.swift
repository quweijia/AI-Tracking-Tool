import Foundation
import SwiftData

// MARK: - 设计规范空间服务（第一阶段引擎复用）
//
// 引擎侧：engine-bridge spec-sync / figma-file-meta / spec-import-json / export-tokens 子命令
//         （打包 Electron 版 specSync.ts / variablesImport.ts / tokenExport.ts / figma.ts 纯逻辑模块，只读引用不改动）。
// 编排侧：SpecStore 镜像渲染层 db/index.ts 规范段（appendSpecVersion / syncSpecFromFigma /
//         importSpecTokensFromJson / rollbackSpecVersion / deleteSpecVersion / deleteSpecCascade）。

// MARK: - 任意 JSON 值（Token value 原样透传入库，不做结构化改写）

/// Token 值的原始 JSON（引擎输出 → 规范化重编码 → specTokens.value 存储串）
enum RawJSON: Sendable, Equatable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([RawJSON])
    case object([String: RawJSON])
}

extension RawJSON: Codable {
    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            self = .null
        } else if let v = try? c.decode(Bool.self) {
            self = .bool(v)
        } else if let v = try? c.decode(Double.self) {
            self = .number(v)
        } else if let v = try? c.decode(String.self) {
            self = .string(v)
        } else if let v = try? c.decode([RawJSON].self) {
            self = .array(v)
        } else {
            self = .object(try c.decode([String: RawJSON].self))
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .null: try c.encodeNil()
        case .bool(let v): try c.encode(v)
        case .number(let v): try c.encode(v)
        case .string(let v): try c.encode(v)
        case .array(let v): try c.encode(v)
        case .object(let v): try c.encode(v)
        }
    }

    /// 规范化 JSON 字符串（入 specTokens.value）
    var jsonString: String {
        guard let data = try? JSONEncoder().encode(self) else { return "null" }
        return String(data: data, encoding: .utf8) ?? "null"
    }
}

// MARK: - 引擎 DTO（字段名与引擎 TS 结构一致）

/// 引擎 ParsedToken 行（value 原样捕获；description 为 Swift 关键字改名映射）
struct EngineParsedTokenDTO: Decodable, Sendable {
    var kind: TokenKind
    var name: String
    var path: String
    var value: RawJSON
    var source: TokenSource
    var tokenDescription: String?
    var tokenId: String?
    var figmaName: String?
    var mode: String?
    var tier: String?
    var isDefaultMode: Bool?
    var rawCode: String?
    var aliasRef: String?
    var type: TokenType?

    enum CodingKeys: String, CodingKey {
        case kind, name, path, value, source
        case tokenDescription = "description"
        case tokenId, figmaName, mode, tier, isDefaultMode, rawCode, aliasRef, type
    }
}

/// 降级链路记录（SpecDegradation）
struct EngineSpecDegradationDTO: Decodable, Sendable {
    var level: String
    var reason: String
    var hint: String?
}

/// spec-sync 出参（SpecSyncResult；variableDenied 时 ok=false 携带降级结构透传）
struct EngineSpecSyncDTO: Decodable, Sendable {
    var ok: Bool
    var message: String?
    var fileName: String?
    var sourceLevel: String?
    var tokens: [EngineParsedTokenDTO]?
    var degraded: [EngineSpecDegradationDTO]?
    var variableDenied: Bool?
}

/// figma-file-meta 出参行（fetchFigmaFileMeta）
struct EngineFileMetaDTO: Decodable, Sendable {
    var fileKey: String
    var ok: Bool
    var message: String?
    var lastModified: Double?
    var fileName: String?
}

struct EngineFileMetaListDTO: Decodable, Sendable {
    var ok: Bool
    var metas: [EngineFileMetaDTO]
}

/// spec-import-json 出参
struct EngineImportJSONDTO: Decodable, Sendable {
    var ok: Bool
    var tokens: [EngineParsedTokenDTO]
}

/// export-tokens 出参
struct EngineExportTokensDTO: Decodable, Sendable {
    var ok: Bool
    var text: String
}

// MARK: - EngineBridge 规范空间子命令

extension EngineBridge {
    /// Figma Token 三级解析（Variables → Styles → 启发式；variableDenied 不抛错，原样透传由编排层处理）
    static func specSync(
        pat: String,
        figmaUrl: String,
        startLevel: String?,
        proxy: String?
    ) async throws -> EngineSpecSyncDTO {
        var payload: [String: Any] = ["pat": pat, "figmaUrl": figmaUrl]
        if let startLevel { payload["startLevel"] = startLevel }
        if let proxy { payload["proxy"] = proxy }
        return try await runRaw(command: "spec-sync", payload: payload, as: EngineSpecSyncDTO.self)
    }

    /// 批量轻量读取 Figma 文件 last_modified（检查更新，引擎内串行防限流）
    static func figmaFileMeta(pat: String, fileKeys: [String], proxy: String?) async throws -> [EngineFileMetaDTO] {
        var payload: [String: Any] = ["pat": pat, "fileKeys": fileKeys]
        if let proxy { payload["proxy"] = proxy }
        return try await run(command: "figma-file-meta", payload: payload, as: EngineFileMetaListDTO.self).metas
    }

    /// Token JSON 导入解析（Figma REST 同构 / Tokens Studio / W3C DTCG，跨文件别名解析）
    static func specImportJSON(files: [(name: String, text: String)]) async throws -> [EngineParsedTokenDTO] {
        let payload: [String: Any] = [
            "files": files.map { ["text": $0.text, "name": $0.name] }
        ]
        return try await run(command: "spec-import-json", payload: payload, as: EngineImportJSONDTO.self).tokens
    }

    /// Token 多格式导出（json / css / tailwind；tokens 元素形如 {kind, name, path, value}）
    static func exportTokens(_ tokens: EngineJSONBox, format: String) async throws -> String {
        let payload: [String: Any] = ["tokens": tokens.values, "format": format]
        return try await run(command: "export-tokens", payload: payload, as: EngineExportTokensDTO.self).text
    }
}

// MARK: - 编排层中间结构与结果

/// Token 行中间结构：引擎输出（specTokens.value JSON 串已就绪）或 SwiftData 行快照（merge 去重叠加用）
struct ParsedTokenRow: Sendable {
    var kind: TokenKind
    var name: String
    var path: String
    /// 规范化 JSON 字符串（直接入 SpecToken.value）
    var valueJSON: String
    var source: TokenSource
    var tokenDescription: String?
    var tokenId: String?
    var figmaName: String?
    var mode: String?
    var tier: String?
    var isDefaultMode: Bool?
    var rawCode: String?
    var aliasRef: String?
    var type: TokenType?
    var sortNo: Int?

    /// 版本 diff 键：kind + name + mode（多模式展开后同名 token 靠 mode 区分）
    var diffKey: String { "\(kind.rawValue)|\(name)|\(mode ?? "")" }

    init(dto: EngineParsedTokenDTO, sortNo: Int) {
        kind = dto.kind
        name = dto.name
        path = dto.path
        valueJSON = dto.value.jsonString
        source = dto.source
        tokenDescription = dto.tokenDescription
        tokenId = dto.tokenId
        figmaName = dto.figmaName
        mode = dto.mode
        tier = dto.tier
        isDefaultMode = dto.isDefaultMode
        rawCode = dto.rawCode
        aliasRef = dto.aliasRef
        type = dto.type
        self.sortNo = sortNo
    }

    /// 从 SwiftData 行重建（merge 时保留原 sortNo 位置；value 原串透传不重编码）
    init(row: SpecToken) {
        kind = row.kind
        name = row.name
        path = row.path
        valueJSON = row.value
        source = row.source
        tokenDescription = row.tokenDescription
        tokenId = row.tokenId
        figmaName = row.figmaName
        mode = row.mode
        tier = row.tier
        isDefaultMode = row.isDefaultMode
        rawCode = row.rawCode
        aliasRef = row.aliasRef
        type = row.type
        sortNo = row.sortNo
    }
}

/// 同步/导入/回滚结果（镜像 SpecSyncOutcome，供状态条与历史列表展示）
struct SpecSyncOutcome: Sendable {
    var versionId: String
    var versionNo: Int
    var tokenCount: Int
    var sourceLevel: String
    var fileName: String?
    var summary: String
    var degraded: [EngineSpecDegradationDTO]?
    /// 变量级 403（PAT 无变量读取权限）：未入库，待用户选择是否改同步样式
    var variableDenied: Bool?
}

/// 导入模式：replace=删除原数据重导为 V1；merge=与最新版本按 kind+name+mode 去重叠加后存新版本
enum SpecImportMode: String, Sendable {
    case replace
    case merge
}

// MARK: - 编排（镜像 db/index.ts 规范段，全部主线程操作 SwiftData）

@MainActor
enum SpecStore {
    // MARK: 查询

    /// 某规范当前最新版本行（no 最大；无版本返回 nil）
    static func latestVersion(_ ctx: ModelContext, specId: String) -> SpecVersion? {
        var d = FetchDescriptor<SpecVersion>(predicate: #Predicate { $0.specId == specId })
        d.fetchLimit = 1
        return (try? ctx.fetch(d))?.max(by: { $0.no < $1.no })
    }

    /// 某版本全部 Token（按入库序号排序，保持 Figma 解析 / JSON 导入的原始分组与顺序）
    static func tokens(_ ctx: ModelContext, versionId: String) -> [SpecToken] {
        let d = FetchDescriptor<SpecToken>(predicate: #Predicate { $0.versionId == versionId })
        let rows = (try? ctx.fetch(d)) ?? []
        return rows.sorted { ($0.sortNo ?? 0) < ($1.sortNo ?? 0) }
    }

    // MARK: 版本追加（Figma 同步 / JSON 导入 / 回滚共用）

    private struct AppendOptions {
        var label: String?
        var sourceLevel: String
        var fileName: String?
        /// 是否回写规范的 Figma 文件元信息（JSON 导入不回写）
        var touchFileName: Bool
        var mode: SpecImportMode = .merge
    }

    /// 追加新版本 + 全量重写该版本 Token（支持清空重导/去重叠加两种模式；summary 与上一版本按 diffKey 对比）
    @discardableResult
    private static func appendVersion(
        _ ctx: ModelContext,
        spec: DesignSpec,
        tokens rows: [ParsedTokenRow],
        opts: AppendOptions
    ) throws -> SpecSyncOutcome {
        // 清空重导：先删除该规范全部版本与 Token（历史一并移除），之后按 V1 重新入库
        if opts.mode == .replace {
            deleteAllTokens(ctx, specId: spec.id)
            deleteAllVersions(ctx, specId: spec.id)
        }
        let prev = latestVersion(ctx, specId: spec.id)
        var effective = rows
        // 去重叠加：最新版本 Token 为底，同 diffKey 新值覆盖，旧有新无保留；旧 Token 保持原 sortNo，新增依序追加尾部
        if opts.mode == .merge, let prev {
            var map: [String: ParsedTokenRow] = [:]
            for r in tokens(ctx, versionId: prev.id) {
                let parsed = ParsedTokenRow(row: r)
                map[parsed.diffKey] = parsed
            }
            for (i, t) in rows.enumerated() {
                var t = t
                t.sortNo = map[t.diffKey]?.sortNo ?? (1_000_000 + i)
                map[t.diffKey] = t
            }
            effective = map.values.sorted { ($0.sortNo ?? 0) < ($1.sortNo ?? 0) }
        }
        let prevKeys = prev.map { Set(tokens(ctx, versionId: $0.id).map { ParsedTokenRow(row: $0).diffKey }) } ?? []
        let nextKeys = effective.map(\.diffKey)
        let nextSet = Set(nextKeys)
        let added = nextKeys.filter { !prevKeys.contains($0) }.count
        let removed = prevKeys.filter { !nextSet.contains($0) }.count
        let changed = min(prevKeys.count - removed, nextKeys.count - added)
        var parts: [String] = []
        if added > 0 { parts.append("新增 \(added)") }
        if removed > 0 { parts.append("删除 \(removed)") }
        if changed > 0 { parts.append("更新 \(changed)") }
        if parts.isEmpty { parts.append("无变更") }
        let summary = opts.label.map { "\($0) · \(parts.joined(separator: " · "))" } ?? parts.joined(separator: " · ")

        let now = nowMs()
        let versionId = genId()
        let versionNo = (prev?.no ?? 0) + 1
        ctx.insert(
            SpecVersion(
                id: versionId,
                specId: spec.id,
                no: versionNo,
                syncedAt: now,
                sourceFileKey: opts.touchFileName ? extractFigmaFileKey(spec.figmaUrl ?? "") : nil,
                tokenCount: effective.count,
                summary: summary
            )
        )
        for (i, t) in effective.enumerated() {
            ctx.insert(
                SpecToken(
                    id: genId(),
                    specId: spec.id,
                    versionId: versionId,
                    kind: t.kind,
                    name: t.name,
                    path: t.path,
                    value: t.valueJSON,
                    source: t.source,
                    tokenDescription: t.tokenDescription,
                    tokenId: t.tokenId,
                    figmaName: t.figmaName,
                    mode: t.mode,
                    tier: t.tier,
                    isDefaultMode: t.isDefaultMode,
                    rawCode: t.rawCode,
                    type: t.type,
                    aliasRef: t.aliasRef,
                    sortNo: i
                )
            )
        }
        if opts.touchFileName {
            spec.figFileName = opts.fileName ?? spec.figFileName
            spec.figmaFileKey = extractFigmaFileKey(spec.figmaUrl ?? "")
            spec.lastSyncedAt = now
            spec.updatedAt = now
        } else {
            spec.lastSyncedAt = now
        }
        try ctx.save()
        return SpecSyncOutcome(
            versionId: versionId,
            versionNo: versionNo,
            tokenCount: effective.count,
            sourceLevel: opts.sourceLevel,
            fileName: opts.touchFileName ? opts.fileName : nil,
            summary: summary
        )
    }

    // MARK: 一键同步（镜像 syncSpecFromFigma）

    /// PAT 读取：镜像 getFigmaPat（AppConfig 第一个启用且带令牌的 MCP 条目 → 旧版 figmaMcp.pat）
    static func figmaPAT() -> String {
        AppConfigStore.load().figmaPAT ?? ""
    }

    /// 一键同步：引擎三级解析 → 追加新版本 → 回写规范元信息。
    /// 变量级 403（无变量读取权限）时中断未入库，返回 variableDenied 交由上层询问用户。
    static func syncFromFigma(
        _ ctx: ModelContext,
        spec: DesignSpec,
        mode: SpecImportMode,
        startLevel: String? = nil
    ) async throws -> SpecSyncOutcome {
        let pat = figmaPAT()
        if pat.isEmpty {
            throw EngineBridgeError.commandFailed("未配置 Figma Token，请先在「设置 → MCP 管理」中填写 PAT")
        }
        guard let figmaUrl = spec.figmaUrl, !figmaUrl.isEmpty else {
            throw EngineBridgeError.commandFailed("该规范未填写 Figma 规范链接")
        }
        let res = try await EngineBridge.specSync(
            pat: pat,
            figmaUrl: figmaUrl,
            startLevel: startLevel,
            proxy: AppConfigStore.load().figmaProxy
        )
        if res.variableDenied == true {
            return SpecSyncOutcome(
                versionId: "", versionNo: 0, tokenCount: 0, sourceLevel: "variable",
                fileName: nil, summary: "", degraded: res.degraded, variableDenied: true
            )
        }
        let rows = (res.tokens ?? []).enumerated().map { ParsedTokenRow(dto: $1, sortNo: $0) }
        if rows.isEmpty {
            throw EngineBridgeError.commandFailed(res.message ?? "解析完成但未提取到任何 Token")
        }
        var outcome = try appendVersion(
            ctx, spec: spec, tokens: rows,
            opts: AppendOptions(
                label: nil, sourceLevel: res.sourceLevel ?? "",
                fileName: res.fileName, touchFileName: true, mode: mode
            )
        )
        outcome.degraded = res.degraded
        return outcome
    }

    // MARK: JSON 导入（镜像 importSpecTokensFromJson）

    /// JSON 导入：多文件解析（跨文件别名）→ 按所选模式入库新版本
    static func importJSON(
        _ ctx: ModelContext,
        spec: DesignSpec,
        files: [(name: String, text: String)],
        mode: SpecImportMode
    ) async throws -> SpecSyncOutcome {
        let dtos = try await EngineBridge.specImportJSON(files: files)
        let rows = dtos.enumerated().map { ParsedTokenRow(dto: $1, sortNo: $0) }
        if rows.isEmpty {
            throw EngineBridgeError.commandFailed("导入文件中未解析到任何 Token")
        }
        return try appendVersion(
            ctx, spec: spec, tokens: rows,
            opts: AppendOptions(
                label: "JSON 导入", sourceLevel: "variable",
                fileName: nil, touchFileName: false, mode: mode
            )
        )
    }

    // MARK: 回滚 / 版本删除（镜像 rollbackSpecVersion / deleteSpecVersion）

    /// 回滚：历史版本 Token 复制为新版本（追加式保留审计链，当前生效切到新版本）
    @discardableResult
    static func rollback(_ ctx: ModelContext, specId: String, versionId: String) throws -> SpecSyncOutcome {
        guard let target = fetchSpecVersion(ctx, id: versionId), target.specId == specId else {
            throw EngineBridgeError.commandFailed("版本不存在")
        }
        let latest = latestVersion(ctx, specId: specId)
        if latest?.id == versionId {
            throw EngineBridgeError.commandFailed("该版本已是当前生效版本")
        }
        let rows = tokens(ctx, versionId: versionId).map { ParsedTokenRow(row: $0) }
        let now = nowMs()
        let newId = genId()
        let summary = "回滚自 V\(target.no)"
        ctx.insert(
            SpecVersion(
                id: newId, specId: specId, no: (latest?.no ?? 0) + 1, syncedAt: now,
                sourceFileKey: target.sourceFileKey, tokenCount: rows.count, summary: summary
            )
        )
        for (i, t) in rows.enumerated() {
            ctx.insert(
                SpecToken(
                    id: genId(), specId: specId, versionId: newId, kind: t.kind, name: t.name,
                    path: t.path, value: t.valueJSON, source: t.source,
                    tokenDescription: t.tokenDescription, tokenId: t.tokenId, figmaName: t.figmaName,
                    mode: t.mode, tier: t.tier, isDefaultMode: t.isDefaultMode,
                    rawCode: t.rawCode, type: t.type, aliasRef: t.aliasRef, sortNo: i
                )
            )
        }
        var specDescriptor = FetchDescriptor<DesignSpec>(predicate: #Predicate { $0.id == specId })
        specDescriptor.fetchLimit = 1
        if let spec = try? ctx.fetch(specDescriptor).first {
            spec.lastSyncedAt = now
        }
        try ctx.save()
        return SpecSyncOutcome(
            versionId: newId, versionNo: (latest?.no ?? 0) + 1, tokenCount: rows.count,
            sourceLevel: "", fileName: nil, summary: summary
        )
    }

    /// 删除历史版本（连同该版本全部 Token；当前生效版本不可删）
    static func deleteVersion(_ ctx: ModelContext, specId: String, versionId: String) throws {
        guard let target = fetchSpecVersion(ctx, id: versionId), target.specId == specId else {
            throw EngineBridgeError.commandFailed("版本不存在")
        }
        if latestVersion(ctx, specId: specId)?.id == versionId {
            throw EngineBridgeError.commandFailed("当前生效版本不可删除")
        }
        ctx.delete(target)
        deleteVersionTokens(ctx, versionId: versionId)
        try ctx.save()
    }

    // MARK: 级联删除（镜像 deleteSpecCascade / deleteSpecCategoryCascade）

    /// 级联删除一套规范：绑定、全部版本 Token、映射、版本记录与规范行（.fig 存档文件保留不动）
    static func deleteSpecCascade(_ ctx: ModelContext, specId: String) throws {
        let specId_ = specId
        deleteAllBindings(ctx, specId: specId_)
        deleteAllTokens(ctx, specId: specId_)
        deleteAllVersions(ctx, specId: specId_)
        let d = FetchDescriptor<SpecTokenMapping>(predicate: #Predicate { $0.specId == specId_ })
        for m in (try? ctx.fetch(d)) ?? [] { ctx.delete(m) }
        if let spec = fetchDesignSpec(ctx, id: specId) { ctx.delete(spec) }
        try ctx.save()
    }

    /// 级联删除端分类：其下全部规范套连带删除（预置分类 UI 层禁删）
    static func deleteSpecCategoryCascade(_ ctx: ModelContext, categoryId: String) throws {
        let d = FetchDescriptor<DesignSpec>(predicate: #Predicate { $0.categoryId == categoryId })
        for s in (try? ctx.fetch(d)) ?? [] { try deleteSpecCascade(ctx, specId: s.id) }
        if let cat = fetchSpecCategory(ctx, id: categoryId) { ctx.delete(cat) }
        try ctx.save()
    }

    // MARK: 删除辅助

    private static func fetchSpecVersion(_ ctx: ModelContext, id: String) -> SpecVersion? {
        let d = FetchDescriptor<SpecVersion>(predicate: #Predicate { $0.id == id })
        return (try? ctx.fetch(d))?.first
    }

    private static func fetchDesignSpec(_ ctx: ModelContext, id: String) -> DesignSpec? {
        let d = FetchDescriptor<DesignSpec>(predicate: #Predicate { $0.id == id })
        return (try? ctx.fetch(d))?.first
    }

    private static func fetchSpecCategory(_ ctx: ModelContext, id: String) -> SpecCategory? {
        let d = FetchDescriptor<SpecCategory>(predicate: #Predicate { $0.id == id })
        return (try? ctx.fetch(d))?.first
    }

    private static func deleteVersionTokens(_ ctx: ModelContext, versionId: String) {
        let d = FetchDescriptor<SpecToken>(predicate: #Predicate { $0.versionId == versionId })
        for t in (try? ctx.fetch(d)) ?? [] { ctx.delete(t) }
    }

    private static func deleteAllTokens(_ ctx: ModelContext, specId: String) {
        let d = FetchDescriptor<SpecToken>(predicate: #Predicate { $0.specId == specId })
        for t in (try? ctx.fetch(d)) ?? [] { ctx.delete(t) }
    }

    private static func deleteAllVersions(_ ctx: ModelContext, specId: String) {
        let d = FetchDescriptor<SpecVersion>(predicate: #Predicate { $0.specId == specId })
        for v in (try? ctx.fetch(d)) ?? [] { ctx.delete(v) }
    }

    private static func deleteAllBindings(_ ctx: ModelContext, specId: String) {
        let d = FetchDescriptor<ProjectSpecBinding>(predicate: #Predicate { $0.specId == specId })
        for b in (try? ctx.fetch(d)) ?? [] { ctx.delete(b) }
    }
}

// MARK: - Figma 工具（引擎同源逻辑的 Swift 侧引用）

/// 从 Figma 链接提取 file key（对齐 shared/figmaUrl.ts：/file|design|proto|board/ 后 10+ 位 id）
func extractFigmaFileKey(_ url: String) -> String? {
    let pattern = "figma\\.com/(?:file|design|proto|board)/([A-Za-z0-9]{10,})"
    guard let re = try? NSRegularExpression(pattern: pattern) else { return nil }
    let ns = url as NSString
    guard let m = re.firstMatch(in: url, range: NSRange(location: 0, length: ns.length)),
          m.numberOfRanges > 1 else { return nil }
    return ns.substring(with: m.range(at: 1))
}
