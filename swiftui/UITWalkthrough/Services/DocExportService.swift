import AppKit
import CryptoKit
import Foundation

// MARK: - 文档平台导出服务（对齐 Electron feishu.ts + docExport.ts）
// 飞书：自建应用凭据 → docx 文档（概况 / 统计表 / 截图 / 明细多维表 / 建议表 / HTML 附件）
// 腾讯：报告内容生成 docx → 官方 v2 导入链路（预导入 → COS 上传 → 异步导入 → 轮询进度）
// 金山：App ID / App Secret 创建在线文档。接口失败时把服务端真实返回透给调用方，绝不伪造成功。

// MARK: - 凭据配置

struct FeishuAppConfig: Codable, Equatable, Sendable {
    var appId: String?
    var appSecret: String?
}

struct TencentDocsConfig: Codable, Equatable, Sendable {
    var clientId: String?
    var accessToken: String?
    var openId: String?
}

struct KingsoftDocsConfig: Codable, Equatable, Sendable {
    var appId: String?
    var appSecret: String?
}

// MARK: - 通用工具

enum DocExportUtil {
    /// 压缩为 JPEG data URL（最长边 2200px，白底），避免原图过大导致飞书素材上传失败
    static func compressedJpegDataUrl(_ dataUrl: String) -> String {
        guard let range = dataUrl.range(of: "base64,"),
              let data = Data(base64Encoded: String(dataUrl[range.upperBound...])),
              let image = NSImage(data: data)
        else { return dataUrl }
        let w = Int(image.size.width.rounded())
        let h = Int(image.size.height.rounded())
        guard w > 0, h > 0 else { return dataUrl }
        let maxEdge = 2200.0
        let scale = min(1, maxEdge / Double(max(w, h)))
        let nw = max(1, Int((Double(w) * scale).rounded()))
        let nh = max(1, Int((Double(h) * scale).rounded()))
        guard let rep = NSBitmapImageRep(
            bitmapDataPlanes: nil, pixelsWide: nw, pixelsHigh: nh,
            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0
        ) else { return dataUrl }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        NSColor.white.setFill()
        NSRect(x: 0, y: 0, width: nw, height: nh).fill()
        image.draw(in: NSRect(x: 0, y: 0, width: nw, height: nh), from: .zero, operation: .sourceOver)
        NSGraphicsContext.restoreGraphicsState()
        guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.88]) else { return dataUrl }
        return "data:image/jpeg;base64,\(jpeg.base64EncodedString())"
    }

    /// HTML 报告文本转 base64 dataUrl（UTF-8 编码保证中文不乱码）
    static func htmlToDataUrl(_ html: String) -> String {
        "data:text/html;base64,\(Data(html.utf8).base64EncodedString())"
    }

    /// data URL → 二进制（取 base64 段）
    static func dataUrlBytes(_ dataUrl: String) -> [UInt8] {
        guard let range = dataUrl.range(of: "base64,"),
              let data = Data(base64Encoded: String(dataUrl[range.upperBound...]))
        else { return [] }
        return Array(data)
    }
}

// MARK: - 飞书

enum FeishuService {
    static let baseUrl = "https://open.feishu.cn/open-apis"

    static var config: FeishuAppConfig { AppConfigStore.load().feishu ?? FeishuAppConfig() }

    static var isReady: Bool {
        let c = config
        return !(c.appId ?? "").isEmpty && !(c.appSecret ?? "").isEmpty
    }

    /// 验证凭据（对齐 feishu:test）
    static func test() async -> (ok: Bool, message: String) {
        do {
            _ = try await tenantToken()
            return (true, "飞书应用验证通过")
        } catch {
            return (false, errorMessage(error))
        }
    }

    static func errorMessage(_ error: Error) -> String {
        (error as? DocExportError)?.message ?? error.localizedDescription
    }

    static func tenantToken() async throws -> String {
        let c = config
        guard let appId = c.appId, !appId.isEmpty, let appSecret = c.appSecret, !appSecret.isEmpty else {
            throw DocExportError("尚未配置飞书应用，请到「设置 → 应用授权」填写 App ID / App Secret")
        }
        var req = URLRequest(url: URL(string: "\(baseUrl)/auth/v3/tenant_access_token/internal")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["app_id": appId, "app_secret": appSecret])
        let (data, _) = try await URLSession.shared.data(for: req)
        let obj = try JSONSerialization.jsonObject(with: data) as? [String: Any] ?? [:]
        let code = obj["code"] as? Int ?? -1
        guard code == 0, let token = obj["tenant_access_token"] as? String else {
            let msg = obj["msg"] as? String ?? ""
            throw DocExportError("获取 tenant_access_token 失败（\(code)）：\(msg)")
        }
        return token
    }

    /// 统一 JSON 请求：code !== 0 抛错，返回 data 节点
    static func json(_ token: String, _ url: String, body: [String: Any]? = nil, method: String = "POST") async throws -> [String: Any] {
        var req = URLRequest(url: URL(string: url)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, _) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let code = obj["code"] as? Int ?? -1
        guard code == 0 else {
            let msg = obj["msg"] as? String ?? ""
            throw DocExportError("飞书 API（\(code)）：\(msg)")
        }
        return obj["data"] as? [String: Any] ?? [:]
    }

    /// 限频/瞬态错误自动退避重试（表格逐块写入调用较多，避免偶发限频直接失败）
    static func retrying<T>(_ times: Int = 3, _ fn: () async throws -> T) async throws -> T {
        var lastErr: Error = DocExportError("unknown")
        for i in 0...times {
            do {
                return try await fn()
            } catch {
                lastErr = error
                let msg = errorMessage(error)
                let retryable = msg.contains("频率") || msg.lowercased().contains("rate limit")
                    || msg.lowercased().contains("too many") || msg.contains("99991400")
                    || msg.range(of: "12542\\d\\d", options: .regularExpression) != nil
                if !retryable || i == times { throw error }
                try? await Task.sleep(nanoseconds: UInt64(600_000_000 * (i + 1)))
            }
        }
        throw lastErr
    }

    // MARK: - 块操作

    struct TextElement: Encodable {
        var textRun: TextRun

        enum CodingKeys: String, CodingKey {
            case textRun = "text_run"
        }

        struct TextRun: Encodable {
            var content: String
            var textElementStyle: Style?

            enum CodingKeys: String, CodingKey {
                case content
                case textElementStyle = "text_element_style"
            }

            struct Style: Encodable {
                var bold: Bool?
                var link: Link?
            }

            struct Link: Encodable {
                var url: String
            }
        }
    }

    /// 文本块（block_type 2），bold 可选；url 传入时生成超链接（docx 链接要求 URL 先做 URL 编码）
    static func textBlock(_ content: String, bold: Bool = false, link: String? = nil) -> [String: Any] {
        var style: [String: Any] = [:]
        if bold { style["bold"] = true }
        if let link { style["link"] = ["url": link.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? link] }
        var run: [String: Any] = ["content": content]
        if !style.isEmpty { run["text_element_style"] = style }
        return ["block_type": 2, "text": ["elements": [ ["text_run": run] ]]]
    }

    static func heading2(_ content: String) -> [String: Any] {
        ["block_type": 4, "heading2": ["elements": [ ["text_run": ["content": content]] ]]]
    }

    /// 追加文本块到文档末尾（每批最多 50 个）
    static func appendTextBlocks(_ token: String, _ docId: String, _ blocks: [[String: Any]]) async throws {
        var index = 0
        while index < blocks.count {
            let chunk = Array(blocks[index..<min(index + 50, blocks.count)])
            try await retrying {
                _ = try await json(
                    token,
                    "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(docId)/children?document_revision_id=-1",
                    body: ["children": chunk, "index": -1]
                )
            }
            index += 50
        }
    }

    /// 创建空的图片/文件块（官方三步流第一步），返回可直接挂素材/patch 的块 ID。
    /// 文件块外层会包一个 View Block（block_type 33），真正的 File Block ID 是它的 children[0]。
    static func createEmptyMediaBlock(_ token: String, _ docId: String, file: Bool) async throws -> String {
        let block: [String: Any] = file
            ? ["block_type": 23, "file": ["token": ""]]
            : ["block_type": 27, "image": ["token": ""]]
        let data: [String: Any] = try await retrying {
            try await json(
                token,
                "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(docId)/children?document_revision_id=-1",
                body: ["children": [block], "index": -1]
            )
        }
        let children = data["children"] as? [[String: Any]] ?? []
        guard let first = children.first, let blockId = first["block_id"] as? String else {
            throw DocExportError("未返回块 ID")
        }
        if file {
            guard let fileBlockId = (first["children"] as? [Any])?.first as? String else {
                throw DocExportError("文件块创建异常：未返回 File Block ID")
            }
            return fileBlockId
        }
        return blockId
    }

    /// 上传素材（docx_image / docx_file），parent_node 为目标块 ID
    static func uploadMedia(_ token: String, parentNode: String, dataUrl: String, name: String, parentType: String, mime: String) async throws -> String {
        let bytes = DocExportUtil.dataUrlBytes(dataUrl)
        // 飞书 upload_all 上限 20MB，超限直接给出明确提示（HTML 报告内嵌原图时容易出现）
        if bytes.count > 20 * 1024 * 1024 {
            throw DocExportError("文件「\(name)」约 \(Int((Double(bytes.count) / 1024 / 1024).rounded()))MB，超过飞书 20MB 上传上限，请压缩图片后重试")
        }
        let boundary = "uwt\(UUID().uuidString.replacingOccurrences(of: "-", with: ""))"
        var body = Data()
        func field(_ name: String, _ value: String) {
            body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"\(name)\"\r\n\r\n\(value)\r\n".utf8))
        }
        field("file_name", name)
        field("parent_type", parentType)
        field("parent_node", parentNode)
        field("size", String(bytes.count))
        body.append(Data("--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"\(name)\"\r\nContent-Type: \(mime)\r\n\r\n".utf8))
        body.append(Data(bytes))
        body.append(Data("\r\n--\(boundary)--\r\n".utf8))

        var req = URLRequest(url: URL(string: "\(baseUrl)/drive/v1/medias/upload_all")!)
        req.httpMethod = "POST"
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body
        let (data, _) = try await URLSession.shared.data(for: req)
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let code = obj["code"] as? Int ?? -1
        let nested = obj["data"] as? [String: Any]
        guard code == 0, let fileToken = nested?["file_token"] as? String else {
            let msg = obj["msg"] as? String ?? ""
            throw DocExportError("上传「\(name)」失败（\(code)）：\(msg)（请到飞书开放平台 → 权限管理，为该应用开通云文档上传权限 drive:file:upload 或 drive:drive，并重新发布应用版本）")
        }
        return fileToken
    }

    /// 更新块（replace_image / replace_file 等 patch 操作）
    static func patchBlock(_ token: String, _ docId: String, _ blockId: String, _ patch: [String: Any]) async throws {
        try await retrying {
            _ = try await json(
                token,
                "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(blockId)?document_revision_id=-1",
                body: patch,
                method: "PATCH"
            )
        }
    }

    /// 删除文档的最后一个子块（上传失败时清理空图片/文件块，避免文档里留下一直转圈的占位块）
    static func deleteLastBlock(_ token: String, _ docId: String) async {
        do {
            let data = try await json(
                token,
                "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(docId)/children?page_size=500",
                method: "GET"
            )
            let count = (data["items"] as? [Any])?.count ?? 0
            guard count > 0 else { return }
            _ = try await json(
                token,
                "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(docId)/children?document_revision_id=-1&start_index=\(count - 1)&end_index=\(count)",
                method: "DELETE"
            )
        } catch {
            // 清理失败不影响主流程（最多留一个空块）
        }
    }

    /// 图片插入三步流：建空图片块 → 上传素材（挂到该块）→ replace_image（直接带 token 创建的图片块不显示）
    static func insertImage(_ token: String, _ docId: String, _ dataUrl: String, _ name: String) async throws {
        let blockId = try await createEmptyMediaBlock(token, docId, file: false)
        do {
            let fileToken = try await uploadMedia(token, parentNode: blockId, dataUrl: dataUrl, name: "\(name).jpg", parentType: "docx_image", mime: "image/jpeg")
            try await patchBlock(token, docId, blockId, ["replace_image": ["token": fileToken]])
        } catch {
            // 上传/替换失败：删掉空图片块，避免文档里留下一直加载的占位块
            await deleteLastBlock(token, docId)
            throw error
        }
    }

    /// HTML 报告附件三步流：建空文件块 → 上传 docx_file → replace_file
    static func insertFileAttachment(_ token: String, _ docId: String, _ dataUrl: String, _ name: String) async throws {
        let blockId = try await createEmptyMediaBlock(token, docId, file: true)
        do {
            let fileToken = try await uploadMedia(token, parentNode: blockId, dataUrl: dataUrl, name: name, parentType: "docx_file", mime: "text/html")
            try await patchBlock(token, docId, blockId, ["replace_file": ["token": fileToken]])
        } catch {
            await deleteLastBlock(token, docId)
            throw error
        }
    }

    /// 插入表格（block_type 31）：一次建表+单元格+文本，行数多时按 chunkSize 分段（续表重复表头）；columnWidths 控制各列宽（px，总宽约 780）
    static func insertTable(_ token: String, _ docId: String, _ rows: [[(content: String, bold: Bool)]], chunkSize: Int = 10, columnWidths: [Int]? = nil) async throws {
        guard let colSize = rows.first?.count, colSize > 0 else { return }
        var seq = 0
        let idPrefix = "uwt\(String(Int(Date().timeIntervalSince1970 * 1000), radix: 36))"
        func nextId() -> String {
            defer { seq += 1 }
            return "\(idPrefix)\(seq)"
        }
        var start = 0
        while start < rows.count {
            let chunk = start == 0 ? Array(rows[0..<min(chunkSize, rows.count)]) : [rows[0]] + Array(rows[start..<min(start + chunkSize, rows.count)])
            let tableId = nextId()
            var cellIds: [String] = []
            for _ in 0..<(chunk.count * colSize) { cellIds.append(nextId()) }
            var descendants: [[String: Any]] = [
                [
                    "block_id": tableId,
                    "block_type": 31,
                    "table": [
                        "property": [
                            "row_size": chunk.count,
                            "column_size": colSize
                        ] + (columnWidths.map { ["column_width": $0] } ?? [:])
                    ],
                    "children": cellIds
                ]
            ]
            for (idx, cellId) in cellIds.enumerated() {
                let cell = chunk[idx / colSize][idx % colSize]
                let textId = nextId()
                descendants.append(["block_id": cellId, "block_type": 32, "table_cell": [:], "children": [textId]])
                var run: [String: Any] = ["content": cell.content]
                if cell.bold { run["text_element_style"] = ["bold": true] }
                descendants.append([
                    "block_id": textId,
                    "block_type": 2,
                    "text": ["elements": [ ["text_run": run] ]],
                    "children": []
                ])
            }
            try await retrying {
                _ = try await json(
                    token,
                    "\(baseUrl)/docx/v1/documents/\(docId)/blocks/\(docId)/descendant?document_revision_id=-1",
                    body: ["index": -1, "children_id": [tableId], "descendants": descendants]
                )
            }
            start += chunkSize
        }
    }

    // MARK: - 问题明细多维表

    /// 创建「问题明细」多维表格（Bitable）：状态为单选可直接切换，前端开发为人员字段可直接选人。
    /// 建表后删除应用自带的默认空「数据表」，并开放组织内链接编辑权限（团队均可编辑）。
    /// 致命失败即抛错（调用方降级为文档内表格）；权限类失败不阻塞，随文档 message 透出。
    static func createIssueBitable(_ token: String, _ title: String, _ issues: [DocExportPayload.Issue]) async throws -> (url: String, warnings: [String]) {
        var softWarnings: [String] = []
        var appToken = ""
        do {
            // 1. 创建多维表格应用
            let app = try await retrying {
                try await json(token, "\(baseUrl)/bitable/v1/apps", body: ["name": "问题明细 - \(title)"])
            }
            appToken = app["app"]?["app_token"] as? String ?? ""

            // 2. 建表（字段：序号/问题描述/严重度/分类/状态/标注图/前端开发-人员）
            func opt(_ name: String, _ color: Int) -> [String: Any] { ["name": name, "color": color] }
            let tbl = try await retrying {
                try await json(token, "\(baseUrl)/bitable/v1/apps/\(appToken)/tables", body: [
                    "table": [
                        "name": "问题明细",
                        "fields": [
                            ["field_name": "序号", "type": 2, "property": ["formatter": "0"]],
                            ["field_name": "问题描述", "type": 1],
                            ["field_name": "严重度", "type": 3, "property": ["options": [opt("严重", 21), opt("一般", 53), opt("建议", 0)]]],
                            ["field_name": "分类", "type": 3, "property": ["options": [
                                opt("间距规范", 3), opt("文字排版", 5), opt("颜色规范", 1),
                                opt("样式规范", 21), opt("交互体验", 24), opt("兼容性问题", 13)
                            ]]],
                            ["field_name": "来源", "type": 3, "property": ["options": [opt("结构化比对", 24), opt("视觉比对", 26), opt("手动标注", 0)]]],
                            ["field_name": "状态", "type": 3, "property": ["options": [
                                opt("待修复", 21), opt("修复中", 53), opt("已修复", 1), opt("已忽略", 0), opt("设计确认不改", 3)
                            ]]],
                            ["field_name": "标注图", "type": 1],
                            // 前端开发：人员字段（type 11），在多维表里直接选人分配
                            ["field_name": "前端开发", "type": 11, "property": ["multiple": false]]
                        ]
                    ]
                ])
            }
            guard let tableId = tbl["table_id"] as? String else {
                throw DocExportError("建表失败：未返回 table_id")
            }

            // 3. 批量写入记录（每批最多 100 条；人员字段留空，由使用者在多维表中选人）
            let records = issues.map { i -> [String: Any] in
                [
                    "fields": [
                        "序号": i.no,
                        "问题描述": i.title,
                        "严重度": i.severityLabel,
                        "分类": i.categoryLabel,
                        "来源": i.sourceLabel,
                        "状态": i.statusLabel,
                        "标注图": i.targetLabel
                    ]
                ]
            }
            var index = 0
            while index < records.count {
                let chunk = Array(records[index..<min(index + 100, records.count)])
                try await retrying {
                    _ = try await json(token, "\(baseUrl)/bitable/v1/apps/\(appToken)/tables/\(tableId)/records/batch_create", body: ["records": chunk])
                }
                index += 100
            }

            // 4. 删除创建应用时自带的默认空「数据表」，只保留问题明细表（失败不阻塞，仅提示）
            do {
                let list = try await retrying {
                    try await json(token, "\(baseUrl)/bitable/v1/apps/\(appToken)/tables?page_size=100", method: "GET")
                }
                for t in list["items"] as? [[String: Any]] ?? [] {
                    if let tid = t["table_id"] as? String, tid != tableId {
                        try await retrying {
                            _ = try await json(token, "\(baseUrl)/bitable/v1/apps/\(appToken)/tables/\(tid)", method: "DELETE")
                        }
                    }
                }
            } catch {
                softWarnings.append("默认空「数据表」删除失败（\(errorMessage(error))），可在多维表中手动删除")
            }

            // 5. 开放编辑权限：组织内获得链接的人可编辑（团队成员均可直接修改）；失败不阻塞，仅提示
            do {
                try await retrying {
                    _ = try await json(token, "\(baseUrl)/drive/v1/permissions/\(appToken)/public?type=bitable", body: ["link_share_entity": "tenant_editable"], method: "PATCH")
                }
            } catch {
                softWarnings.append("已创建多维表，但开放团队编辑权限失败（\(errorMessage(error))），可在多维表右上角「分享」手动设置「组织内获得链接的人可编辑」")
            }

            return ("https://feishu.cn/base/\(appToken)", softWarnings)
        } catch {
            // 应用/表已建但记录写入失败：删除空多维表避免留下「空表格」误导用户，再把错误抛给降级逻辑
            if !appToken.isEmpty {
                do {
                    // 多维表是云文档文件，删除走 drive 接口（bitable/v1/apps 无 DELETE 路由，会 404）
                    _ = try await json(token, "\(baseUrl)/drive/v1/files/\(appToken)?type=bitable", method: "DELETE")
                } catch let delErr {
                    // 清理失败（常见为缺 drive:drive / space:document:delete 权限）：把残留提示并入错误信息随降级 warning 透出
                    var msg = errorMessage(error)
                    msg += "；删除空多维表也失败（\(errorMessage(delErr))），飞书里会残留一个空表，可到开放平台开通 drive:drive 或 space:document:delete 权限后重试，或手动删除该空表"
                    throw DocExportError(msg)
                }
            }
            throw error
        }
    }

    // MARK: - 创建报告文档主流程

    /// 一键创建走查报告飞书文档：概况 + 统计表 + 截图 + 明细表 + 建议表 + HTML 报告附件，成功后自动打开
    static func createReport(_ payload: DocExportPayload) async -> (ok: Bool, url: String?, message: String) {
        var warnings: [String] = []
        do {
            let token = try await tenantToken()
            // 1. 创建文档
            let doc = try await json(token, "\(baseUrl)/docx/v1/documents", body: ["title": payload.title])
            guard let docId = doc["document"]?["document_id"] as? String else {
                throw DocExportError("创建文档失败：未返回 document_id")
            }

            // 2. 走查概况
            try await appendTextBlocks(token, docId, [heading2("走查概况")] + payload.metaLines.map { textBlock($0) })

            // 3. 问题统计（表格；失败降级为文本行）
            do {
                try await insertTable(
                    token, docId,
                    [[(content: "指标", bold: true), (content: "数值", bold: true)]] +
                        payload.stats.map { [(content: $0.label, bold: false), (content: $0.value, bold: false)] },
                    chunkSize: 10,
                    columnWidths: [150, 630]
                )
            } catch {
                warnings.append("统计表格创建失败，已用文本展示")
                try await appendTextBlocks(
                    token, docId,
                    payload.stats.map { textBlock("\($0.label)：\($0.value)") } + [textBlock(errorMessage(error))]
                )
            }

            // 4. 页面截图（官方三步流；单张失败不阻塞其余）
            if !payload.images.isEmpty {
                try await appendTextBlocks(token, docId, [heading2("页面截图")])
                for img in payload.images {
                    if img.dataUrl.isEmpty { continue }
                    do {
                        try await appendTextBlocks(token, docId, [textBlock(img.name, bold: true)])
                        try await insertImage(token, docId, img.dataUrl, img.name)
                    } catch {
                        warnings.append("截图「\(img.name)」插入失败：\(errorMessage(error))")
                    }
                }
            }

            // 5. 问题明细（优先创建可交互的多维表格：状态单选可切换 + 前端开发分配列；失败降级为文档内表格）
            try await appendTextBlocks(token, docId, [heading2("问题明细")])
            if payload.issues.isEmpty {
                try await appendTextBlocks(token, docId, [textBlock("本次走查未发现需要处理的问题。")])
            } else {
                do {
                    let bitable = try await createIssueBitable(token, payload.title, payload.issues)
                    warnings.append(contentsOf: bitable.warnings)
                    try await appendTextBlocks(token, docId, [
                        textBlock("问题明细已生成多维表格（仅含问题明细表，状态可直接切换、可直接分配前端开发，团队内获得链接的人均可编辑）："),
                        textBlock("打开问题明细多维表 ↗", bold: true, link: bitable.url)
                    ])
                } catch {
                    warnings.append("多维表格创建失败已降级为文档表格：\(errorMessage(error))（若提示权限不足，请在飞书开放平台为应用开通 bitable:app 权限并重新发布版本）")
                    do {
                        try await insertTable(
                            token, docId,
                            [[(content: "序号", bold: true), (content: "问题描述", bold: true), (content: "严重度", bold: true), (content: "分类", bold: true), (content: "来源", bold: true), (content: "标注图", bold: true), (content: "状态", bold: true)]] +
                                payload.issues.map { i in
                                    [
                                        (content: String(i.no), bold: false), (content: i.title, bold: false),
                                        (content: i.severityLabel, bold: false), (content: i.categoryLabel, bold: false),
                                        (content: i.sourceLabel, bold: false), (content: i.targetLabel, bold: false),
                                        (content: i.statusLabel, bold: false)
                                    ]
                                },
                            chunkSize: 10,
                            columnWidths: [48, 252, 68, 96, 88, 72, 156]
                        )
                    } catch {
                        warnings.append("明细表格创建失败，已用文本展示")
                        let fallback = payload.issues.flatMap { i -> [[String: Any]] in
                            [
                                textBlock("\(i.no). \(i.title)", bold: true),
                                textBlock("严重度：\(i.severityLabel)　分类：\(i.categoryLabel)　来源：\(i.sourceLabel)　标注图：\(i.targetLabel)　状态：\(i.statusLabel)")
                            ]
                        }
                        try await appendTextBlocks(token, docId, fallback)
                    }
                }
            }

            // 6. 修复建议（仅列出带 AI 结构化建议的条目）
            let sugIssues = payload.issues.filter { !($0.suggestion?.current ?? "").isEmpty || !($0.suggestion?.fix ?? "").isEmpty }
            if !sugIssues.isEmpty {
                try await appendTextBlocks(token, docId, [heading2("修复建议")])
                do {
                    try await insertTable(
                        token, docId,
                        [[(content: "序号", bold: true), (content: "问题描述", bold: true), (content: "现状", bold: true), (content: "建议改法", bold: true), (content: "涉及属性", bold: true)]] +
                            sugIssues.map { i in
                                [
                                    (content: String(i.no), bold: false), (content: i.title, bold: false),
                                    (content: i.suggestion?.current ?? "—", bold: false),
                                    (content: i.suggestion?.fix ?? "—", bold: false),
                                    (content: i.suggestion?.properties?.isEmpty == false ? i.suggestion!.properties! : "—", bold: false)
                                ]
                            },
                        chunkSize: 10,
                        columnWidths: [56, 280, 170, 180, 94]
                    )
                } catch {
                    warnings.append("建议表格创建失败，已用文本展示")
                    let fallback = sugIssues.flatMap { i -> [[String: Any]] in
                        [
                            textBlock("\(i.no). \(i.title)", bold: true),
                            textBlock("现状：\(i.suggestion?.current ?? "—")"),
                            textBlock("建议改法：\(i.suggestion?.fix ?? "—")"),
                            textBlock("涉及属性：\(i.suggestion?.properties?.isEmpty == false ? i.suggestion!.properties! : "—")")
                        ]
                    }
                    try await appendTextBlocks(token, docId, fallback)
                }
            }

            // 7. 交互式 HTML 报告附件（可点击打开；失败不阻塞文档）
            if let htmlReport = payload.htmlReport, !htmlReport.dataUrl.isEmpty {
                try await appendTextBlocks(token, docId, [
                    heading2("交互式报告附件"),
                    textBlock("点击下方附件可在浏览器中打开完整交互式报告（图上标注可点击、可直接回应修复结果）。")
                ])
                do {
                    try await insertFileAttachment(token, docId, htmlReport.dataUrl, htmlReport.name)
                } catch {
                    warnings.append("HTML 报告附件上传失败：\(errorMessage(error))")
                }
            }

            // 8. 开放编辑权限：组织内获得链接的人可编辑（失败不阻塞文档，仅提示）
            do {
                _ = try await json(token, "\(baseUrl)/drive/v1/permissions/\(docId)/public?type=docx", body: ["link_share_entity": "tenant_editable"], method: "PATCH")
            } catch {
                warnings.append("已创建文档，但开放团队编辑权限失败（\(errorMessage(error))），可在文档右上角「分享」手动设置「组织内获得链接的人可编辑」（需在飞书开放平台开通 drive:permission 权限）")
            }

            let url = "https://feishu.cn/docx/\(docId)"
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            return (true, url, warnings.isEmpty ? "文档创建成功" : "文档创建成功（\(warnings.joined(separator: "；"))）")
        } catch {
            return (false, nil, errorMessage(error))
        }
    }
}

// MARK: - 腾讯文档

enum TencentDocService {
    static let baseUrl = "https://docs.qq.com/openapi"

    static var config: TencentDocsConfig { AppConfigStore.load().tencentDocs ?? TencentDocsConfig() }

    /// 腾讯文档 v2 鉴权请求头（官方文档头名：Client-Id / Open-Id / Access-Token）
    static func headers(_ cfg: TencentDocsConfig) -> [String: String] {
        [
            "Client-Id": cfg.clientId ?? "",
            "Open-Id": cfg.openId ?? "",
            "Access-Token": cfg.accessToken ?? ""
        ]
    }

    static func requireConfig() throws -> TencentDocsConfig {
        let cfg = config
        guard let clientId = cfg.clientId, !clientId.isEmpty,
              let accessToken = cfg.accessToken, !accessToken.isEmpty,
              let openId = cfg.openId, !openId.isEmpty
        else {
            throw DocExportError("尚未配置腾讯文档凭据，请到「设置 → 应用授权」填写 Client ID / Access Token / Open ID")
        }
        return cfg
    }

    static func errorMessage(_ error: Error) -> String {
        (error as? DocExportError)?.message ?? error.localizedDescription
    }

    /// 腾讯文档 v2 业务返回码 → 可读提示（官方错误码表）
    static func retMessage(_ ret: Int, _ msg: String) -> String {
        switch ret {
        case 10313: return "Access-Token 为空，请检查凭据填写"
        case 10302: return "Client-Id 与 Access-Token 不匹配，请检查应用 ID 是否填对"
        case 10303: return "Open-Id 与 Access-Token 不匹配，请检查 Open ID 是否填对"
        case 37019: return "Access-Token 校验失败（错误或已过期），请到开放平台重置后更新"
        case 10107: return "导入文件过大（超过平台上限）"
        case 10108: return "导入文件的格式不支持"
        case 10109: return "导入的文件已损坏，请重试"
        case 10111: return "不支持导入加密文件"
        default: return msg.isEmpty ? "业务错误 ret \(ret)" : "业务错误 ret \(ret)：\(msg)"
        }
    }

    /// v2 form-urlencoded POST，返回 {status, ret, msg, data}
    static func form(_ cfg: TencentDocsConfig, _ path: String, _ params: [String: String]) async throws -> (status: Int, ret: Int, msg: String, data: [String: Any]) {
        var req = URLRequest(url: URL(string: "\(baseUrl)\(path)")!)
        req.httpMethod = "POST"
        for (k, v) in headers(cfg) { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        let body = params.map { k, v in
            "\(k.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? k)=\(v.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? v)"
        }.joined(separator: "&")
        req.httpBody = Data(body.utf8)
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let ret = obj["ret"] as? Int ?? -1
        let msg = obj["msg"] as? String ?? ""
        let nested = obj["data"] as? [String: Any] ?? [:]
        return (status, ret, msg, nested)
    }

    /// 验证凭据（对齐 tencent:test：请求一个不存在文件的元信息端点，鉴权类错误才算失败）
    static func test() async -> (ok: Bool, message: String) {
        do {
            let cfg = try requireConfig()
            var req = URLRequest(url: URL(string: "\(baseUrl)/drive/v2/files/__uwt_conn_check__/metadata")!)
            for (k, v) in headers(cfg) { req.setValue(v, forHTTPHeaderField: k) }
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            if status == 401 || status == 403 {
                return (false, "鉴权失败（HTTP \(status)）：请检查 Client ID / Access Token / Open ID 是否正确、token 是否已过期")
            }
            let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
            let ret = obj["ret"] as? Int ?? 0
            let msg = obj["msg"] as? String ?? ""
            if [10302, 10303, 10313, 37019].contains(ret) {
                return (false, "鉴权失败：\(retMessage(ret, msg))")
            }
            return (true, "腾讯文档凭据验证通过")
        } catch {
            return (false, errorMessage(error))
        }
    }

    /// 创建报告文档：docx → 预导入 → COS PUT → 异步导入 → 轮询进度，成功后自动打开
    static func createReport(_ payload: DocExportPayload) async -> (ok: Bool, url: String?, message: String) {
        do {
            let cfg = try requireConfig()
            let docx = DocxBuilder.buildReportDocx(payload)
            let md5 = Insecure.MD5.hash(data: docx).map { String(format: "%02x", $0) }.joined()
            let safeTitle = payload.title.replacingOccurrences(of: "[\\\\/:*?\"<>|]", with: "_", options: .regularExpression)
            let fileName = String(safeTitle.prefix(36)) + ".docx"

            // 1. 预导入：换取腾讯云 COS 上传链接
            let pre = try await form(cfg, "/drive/v2/files/upload", [
                "fileMD5": md5,
                "fileName": fileName,
                "fileSize": String(docx.count)
            ])
            guard pre.ret == 0 else {
                return (false, nil, "预导入失败：\(retMessage(pre.ret, pre.msg))")
            }
            guard let cosPutUrl = pre.data["COSPutURL"] as? String,
                  let cosFileKey = pre.data["COSFileKey"] as? String else {
                let raw = String(data: JSONSerialization.data(withJSONObject: pre.data, options: [.fragmentsAllowed]), encoding: .utf8) ?? ""
                return (false, nil, "预导入返回异常：\(String(raw.prefix(200)))")
            }

            // 2. 上传报告文件到 COS（CustomHeader 为签名约定头，需原样携带）
            var putReq = URLRequest(url: URL(string: cosPutUrl)!)
            putReq.httpMethod = "PUT"
            if let custom = pre.data["CustomHeader"] as? [String: String] {
                for (k, v) in custom { putReq.setValue(v, forHTTPHeaderField: k) }
            }
            putReq.httpBody = Data(docx)
            let (putData, putResp) = try await URLSession.shared.data(for: putReq)
            let putStatus = (putResp as? HTTPURLResponse)?.statusCode ?? 0
            if !(200..<300).contains(putStatus) {
                let errText = String(data: putData, encoding: .utf8) ?? ""
                return (false, nil, "报告文件上传失败（COS HTTP \(putStatus)）：\(String(errText.prefix(200)))")
            }

            // 3. 触发异步导入
            let imp = try await form(cfg, "/drive/v2/files/async-import", [
                "fileMD5": md5,
                "fileName": fileName,
                "COSFileKey": cosFileKey
            ])
            guard imp.ret == 0 else {
                return (false, nil, "导入失败：\(retMessage(imp.ret, imp.msg))")
            }
            guard let progressQueryID = imp.data["progressQueryID"] as? String else {
                let raw = String(data: JSONSerialization.data(withJSONObject: imp.data, options: [.fragmentsAllowed]), encoding: .utf8) ?? ""
                return (false, nil, "导入返回异常：\(String(raw.prefix(200)))")
            }

            // 4. 轮询导入进度（1.5s 一次，最长约 75s）
            var url: String?
            for _ in 0..<50 {
                try? await Task.sleep(nanoseconds: 1_500_000_000)
                var q = URLRequest(url: URL(string: "\(baseUrl)/drive/v2/files/import-progress?progressQueryID=\(progressQueryID.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? progressQueryID)")!)
                for (k, v) in headers(cfg) { q.setValue(v, forHTTPHeaderField: k) }
                guard let (qdata, _) = try? await URLSession.shared.data(for: q),
                      let jd = (try? JSONSerialization.jsonObject(with: qdata) as? [String: Any]) else { continue }
                if let ret = jd["ret"] as? Int, ret != 0 {
                    return (false, nil, "导入失败：\(retMessage(ret, jd["msg"] as? String ?? ""))")
                }
                if let nested = jd["data"] as? [String: Any], (nested["progress"] as? Int) == 100 {
                    url = nested["url"] as? String
                    break
                }
            }
            guard let url else {
                return (false, nil, "导入超时：可稍后在腾讯文档「我的文档」中查看结果后重试")
            }
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            return (true, url, "腾讯文档已创建（含完整报告内容），浏览器将自动打开")
        } catch {
            return (false, nil, errorMessage(error))
        }
    }
}

// MARK: - 金山文档

enum KingsoftDocService {
    static let baseUrl = "https://openapi.wps.cn"

    static var config: KingsoftDocsConfig { AppConfigStore.load().kingsoftDocs ?? KingsoftDocsConfig() }

    static func errorMessage(_ error: Error) -> String {
        (error as? DocExportError)?.message ?? error.localizedDescription
    }

    /// App ID / App Secret 换取应用 token（KOpen v2）
    static func token() async throws -> String {
        let cfg = config
        guard let appId = cfg.appId, !appId.isEmpty, let appSecret = cfg.appSecret, !appSecret.isEmpty else {
            throw DocExportError("尚未配置金山文档凭据，请到「设置 → 应用授权」填写 App ID / App Secret")
        }
        var req = URLRequest(url: URL(string: "\(baseUrl)/kopen/woa/v2/dev/app/token")!)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try JSONSerialization.data(withJSONObject: ["app_id": appId, "app_key": appSecret])
        let (data, response) = try await URLSession.shared.data(for: req)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        let text = String(data: data, encoding: .utf8) ?? ""
        let obj = (try? JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
        let code = obj["code"] as? Int
        let tok = (obj["token"] as? String) ?? ((obj["data"] as? [String: Any])?["token"] as? String)
        guard status == 200, code == nil || code == 0, let tok else {
            return try throwKingsoft(status: status, code: code, text: text)
        }
        return tok
    }

    private static func throwKingsoft(status: Int, code: Int?, text: String) throws -> String {
        throw DocExportError("金山文档凭据验证失败（HTTP \(status)，code \(code.map(String.init) ?? "-")）：\(String(text.prefix(200)))（请检查 App ID / App Secret，并确认应用已开通金山文档 API）")
    }

    /// 在响应 JSON 里递归找文档链接字段（url / doc_url），兼容 data 包裹层级
    static func findDocUrl(_ obj: Any, depth: Int = 0) -> String? {
        if depth > 4 { return nil }
        if let dict = obj as? [String: Any] {
            for (k, v) in dict {
                if (k == "url" || k == "doc_url"), let s = v as? String, s.hasPrefix("http") { return s }
            }
            for v in dict.values {
                if let hit = findDocUrl(v, depth: depth + 1) { return hit }
            }
        }
        if let arr = obj as? [Any] {
            for v in arr {
                if let hit = findDocUrl(v, depth: depth + 1) { return hit }
            }
        }
        return nil
    }

    /// 验证凭据（对齐 kingsoft:test）
    static func test() async -> (ok: Bool, message: String) {
        do {
            _ = try await token()
            return (true, "金山文档凭据验证通过")
        } catch {
            return (false, errorMessage(error))
        }
    }

    /// 创建在线文档（标题为报告名），成功后自动打开
    static func createReport(_ title: String) async -> (ok: Bool, url: String?, message: String) {
        do {
            let tok = try await token()
            var req = URLRequest(url: URL(string: "\(baseUrl)/kopen/woa/v2/dev/files/create")!)
            req.httpMethod = "POST"
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.setValue("Bearer \(tok)", forHTTPHeaderField: "Authorization")
            req.httpBody = try JSONSerialization.data(withJSONObject: ["name": title, "type": "document"])
            let (data, response) = try await URLSession.shared.data(for: req)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let text = String(data: data, encoding: .utf8) ?? ""
            guard (200..<300).contains(status) else {
                return (false, nil, "金山文档创建接口 HTTP \(status)：\(String(text.prefix(300)))")
            }
            guard let obj = try? JSONSerialization.jsonObject(with: data) else {
                return (false, nil, "金山文档返回非 JSON：\(String(text.prefix(300)))")
            }
            guard let url = findDocUrl(obj) else {
                return (false, nil, "金山文档返回中未找到文档链接：\(String(text.prefix(300)))")
            }
            if let u = URL(string: url) { NSWorkspace.shared.open(u) }
            return (true, url, "金山文档已创建，浏览器将自动打开")
        } catch {
            return (false, nil, errorMessage(error))
        }
    }
}

/// 统一错误类型（保留原始中文文案）
struct DocExportError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
