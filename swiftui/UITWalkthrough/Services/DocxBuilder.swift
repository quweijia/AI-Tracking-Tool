import Foundation

// MARK: - 最小 docx 生成（OOXML + store 模式 zip，无第三方依赖，对齐 Electron docExport buildReportDocx）

/// 文档导出 payload（与飞书 / 腾讯创建接口一致的内容结构）
struct DocExportPayload {
    struct Stat {
        var label: String
        var value: String
    }

    struct Issue {
        var no: Int
        var title: String
        var severityLabel: String
        var categoryLabel: String
        var sourceLabel: String
        var targetLabel: String
        var statusLabel: String
        var suggestion: AISuggestionData?
    }

    struct Image {
        var name: String
        var dataUrl: String
    }

    var title: String
    var metaLines: [String]
    var stats: [Stat]
    var issues: [Issue]
    var images: [Image]
    /// 导出的交互式 HTML 报告（腾讯 docx 附说明文字；飞书作为附件块上传）
    var htmlReport: (name: String, dataUrl: String)?
}

enum DocxBuilder {
    // MARK: - CRC32 / zip

    /// CRC32 查表（zip 校验用）
    private static let crcTable: [UInt32] = {
        var table = [UInt32](repeating: 0, count: 256)
        for n in 0..<256 {
            var c: UInt32 = UInt32(n)
            for _ in 0..<8 {
                c = (c & 1) != 0 ? 0xEDB88320 ^ (c >> 1) : c >> 1
            }
            table[n] = c
        }
        return table
    }()

    private static func crc32(_ buf: [UInt8]) -> UInt32 {
        var c: UInt32 = 0xFFFFFFFF
        for b in buf {
            c = crcTable[Int((c ^ UInt32(b)) & 0xFF)] ^ (c >> 8)
        }
        return c ^ 0xFFFFFFFF
    }

    private static func le16(_ v: UInt16) -> [UInt8] {
        withUnsafeBytes(of: v.littleEndian) { Array($0) }
    }

    private static func le32(_ v: UInt32) -> [UInt8] {
        withUnsafeBytes(of: v.littleEndian) { Array($0) }
    }

    /// store（不压缩）模式打 zip 包；docx 对压缩方式无要求，store 最简单可靠
    static func zipStore(files: [(name: String, data: [UInt8])]) -> Data {
        var local: [UInt8] = []
        var central: [UInt8] = []
        var offset: UInt32 = 0
        for f in files {
            let name = Array(f.name.data(using: .utf8)!)
            let crc = crc32(f.data)
            // 本地文件头：签名/版本/bit11 UTF-8 文件名/store/时间(1980)/CRC/长度
            local += le32(0x04034B50)
            local += le16(20)
            local += le16(0x0800)
            local += le16(0)
            local += le16(0)
            local += le16(0x21)
            local += le32(crc)
            local += le32(UInt32(f.data.count))
            local += le32(UInt32(f.data.count))
            local += le16(UInt16(name.count))
            local += name
            local += f.data

            // 中央目录头
            central += le32(0x02014B50)
            central += le16(20)
            central += le16(20)
            central += le16(0x0800)
            central += le16(0)
            central += le16(0x21)
            central += le32(crc)
            central += le32(UInt32(f.data.count))
            central += le32(UInt32(f.data.count))
            central += le16(UInt16(name.count))
            central += le16(0)
            central += le16(0)
            central += le16(0)
            central += le16(0)
            central += le32(0)
            central += le32(offset)
            central += name
            offset += UInt32(30 + name.count + f.data.count)
        }
        // EOCD
        var out = local + central
        out += le32(0x06054B50)
        out += le16(0)
        out += le16(0)
        out += le16(UInt16(files.count))
        out += le16(UInt16(files.count))
        out += le32(UInt32(central.count))
        out += le32(offset)
        out += le16(0)
        return Data(out)
    }

    // MARK: - XML 构造

    static func escXml(_ s: String) -> String {
        s.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
            .replacingOccurrences(of: "'", with: "&apos;")
    }

    private struct RunOpts {
        var text: String
        var bold = false
        /// 字号（半磅，Word 惯例：21=10.5pt 正文）
        var sizeHalf: Int?
        var color: String?
    }

    /// 多 run 段落（一段内混排加粗 / 灰色小字等），pPr 可传居中 / 间距等段落属性
    private static func wRuns(_ runs: [RunOpts], _ pPr: String = "") -> String {
        let body = runs.map { r -> String in
            var rpr: [String] = []
            if r.bold { rpr.append("<w:b/>") }
            if let color = r.color { rpr.append("<w:color w:val=\"\(color)\"/>") }
            if let sizeHalf = r.sizeHalf {
                rpr.append("<w:sz w:val=\"\(sizeHalf)\"/><w:szCs w:val=\"\(sizeHalf)\"/>")
            }
            let rPr = rpr.isEmpty ? "" : "<w:rPr>\(rpr.joined())</w:rPr>"
            return "<w:r>\(rPr)<w:t xml:space=\"preserve\">\(escXml(r.text))</w:t></w:r>"
        }.joined()
        return "<w:p>\(pPr.isEmpty ? "" : "<w:pPr>\(pPr)</w:pPr>")\(body)</w:p>"
    }

    private static func wP(_ text: String, _ opts: RunOpts = .init(text: ""), _ pPr: String = "") -> String {
        wRuns([RunOpts(text: text, bold: opts.bold, sizeHalf: opts.sizeHalf, color: opts.color)], pPr)
    }

    /// 表格单元格
    private struct TCellOpts {
        var text: String
        var bold = false
        var sizeHalf: Int?
        var color: String?
        /// 背景底纹色（表头 / 建议行）
        var fill: String?
        /// 跨列数（合并单元格）
        var span: Int?
        /// 列宽（dxa）
        var width: Int?
    }

    private static func wCell(_ c: TCellOpts) -> String {
        var rpr: [String] = []
        if c.bold { rpr.append("<w:b/>") }
        if let color = c.color { rpr.append("<w:color w:val=\"\(color)\"/>") }
        if let sizeHalf = c.sizeHalf {
            rpr.append("<w:sz w:val=\"\(sizeHalf)\"/><w:szCs w:val=\"\(sizeHalf)\"/>")
        }
        let run = "<w:r>\(rpr.isEmpty ? "" : "<w:rPr>\(rpr.joined())</w:rPr>")<w:t xml:space=\"preserve\">\(escXml(c.text))</w:t></w:r>"
        var tcPr: [String] = ["<w:tcW w:w=\"\(c.width ?? 0)\" w:type=\"dxa\"/>"]
        if let span = c.span { tcPr.append("<w:gridSpan w:val=\"\(span)\"/>") }
        if let fill = c.fill { tcPr.append("<w:shd w:val=\"clear\" w:color=\"auto\" w:fill=\"\(fill)\"/>") }
        tcPr.append("<w:vAlign w:val=\"center\"/>")
        return "<w:tc><w:tcPr>\(tcPr.joined())</w:tcPr><w:p>\(run)</w:p></w:tc>"
    }

    /// 定宽表格：tblGrid 固定列宽 + 100% 页宽 + 单元格内边距，排版稳定不依赖内容自适应
    private static func wGridTable(_ widths: [Int], _ rows: [[String]]) -> String {
        func border(_ n: String) -> String {
            "<w:\(n) w:val=\"single\" w:sz=\"4\" w:space=\"0\" w:color=\"D9D9D9\"/>"
        }
        let tblPr = "<w:tblPr><w:tblW w:w=\"5000\" w:type=\"pct\"/>" +
            "<w:tblBorders>\(["top", "left", "bottom", "right", "insideH", "insideV"].map(border).joined())</w:tblBorders>" +
            "<w:tblCellMar><w:top w:w=\"60\" w:type=\"dxa\"/><w:left w:w=\"100\" w:type=\"dxa\"/><w:bottom w:w=\"60\" w:type=\"dxa\"/><w:right w:w=\"100\" w:type=\"dxa\"/></w:tblCellMar></w:tblPr>"
        let grid = "<w:tblGrid>\(widths.map { "<w:gridCol w:w=\"\($0)\"/>" }.joined())</w:tblGrid>"
        let trs = rows.map { "<w:tr>\($0.joined())</w:tr>" }.joined()
        return "<w:tbl>\(tblPr)\(grid)\(trs)</w:tbl>"
    }

    // MARK: - 图片尺寸解析

    /// 读取 PNG / JPEG 像素尺寸（读不出返回 0，由调用方按默认比例兜底）
    static func imagePixelSize(_ buf: [UInt8], _ ext: String) -> (w: Int, h: Int) {
        func be16(_ i: Int) -> Int { Int(buf[i]) << 8 | Int(buf[i + 1]) }
        func be32(_ i: Int) -> Int { Int(buf[i]) << 24 | Int(buf[i + 1]) << 16 | Int(buf[i + 2]) << 8 | Int(buf[i + 3]) }
        if ext == "png", buf.count > 24 {
            return (be32(16), be32(20))
        }
        if ext == "jpg" || ext == "jpeg" {
            var pos = 2
            while pos + 9 < buf.count {
                if buf[pos] != 0xFF { break }
                let marker = buf[pos + 1]
                if marker >= 0xC0 && marker <= 0xCF && marker != 0xC4 && marker != 0xC8 && marker != 0xCC {
                    return (be16(pos + 7), be16(pos + 5))
                }
                pos += 2 + be16(pos + 2)
            }
        }
        return (0, 0)
    }

    // MARK: - 报告 docx 组装

    /// 把报告 payload 组装为 docx：标题 + 元信息 + 统计表 + 问题明细表 + 附图，图文口径与飞书文档一致
    static func buildReportDocx(_ p: DocExportPayload) -> Data {
        var body: [String] = []
        // 主标题：居中加粗，下留间距
        body.append(wRuns([RunOpts(text: p.title, bold: true, sizeHalf: 36)], "<w:jc w:val=\"center\"/><w:spacing w:after=\"200\"/>"))
        // 元信息行：灰色小字，行距与段后间距拉开
        for line in p.metaLines {
            body.append(wRuns([RunOpts(text: line, sizeHalf: 20, color: "595959")], "<w:spacing w:after=\"60\" w:line=\"312\" w:lineRule=\"auto\"/>"))
        }
        // 统计表：100% 页宽等宽格子，浅蓝底
        if !p.stats.isEmpty {
            let seg = 9026 / p.stats.count
            let widths = (0..<p.stats.count).map { i in i == p.stats.count - 1 ? 9026 - seg * (p.stats.count - 1) : seg }
            body.append(wGridTable(
                widths,
                [p.stats.enumerated().map { i, s in
                    wCell(TCellOpts(text: "\(s.label)：\(s.value)", bold: true, sizeHalf: 20, fill: "E8EEF9", width: widths[i]))
                }]
            ))
        }

        // 问题明细表：表头行 + 每问题一行属性，AI 建议以合并单元格行紧随其后
        if !p.issues.isEmpty {
            body.append(wP("问题明细", RunOpts(text: "", bold: true, sizeHalf: 28), "<w:spacing w:before=\"280\" w:after=\"140\"/>"))
            let cols = [600, 3200, 950, 1150, 1150, 926, 1050]
            func head(_ t: String, _ i: Int) -> String {
                wCell(TCellOpts(text: t, bold: true, sizeHalf: 18, fill: "E8EEF9", width: cols[i]))
            }
            var rows: [[String]] = [[
                head("编号", 0), head("标题", 1), head("严重度", 2), head("类别", 3), head("来源", 4), head("目标", 5), head("状态", 6)
            ]]
            for i in p.issues {
                func c(_ t: String, _ j: Int) -> String {
                    wCell(TCellOpts(text: t, sizeHalf: 18, width: cols[j]))
                }
                rows.append([
                    c(String(i.no), 0), c(i.title, 1), c(i.severityLabel, 2), c(i.categoryLabel, 3),
                    c(i.sourceLabel, 4), c(i.targetLabel, 5), c(i.statusLabel, 6)
                ])
                if let sug = i.suggestion {
                    rows.append([wCell(TCellOpts(
                        text: "建议　现状：\(sug.current)　改法：\(sug.fix)",
                        sizeHalf: 18, color: "595959", fill: "FAFBFD", span: 7
                    ))])
                }
            }
            body.append(wGridTable(cols, rows))
        }

        // 附图：解析 dataUrl → media 文件 + 关系 + inline drawing（按页宽等比缩放）
        var media: [(name: String, data: [UInt8])] = []
        var rels: [String] = []
        var imgIdx = 0
        for img in p.images {
            if imgIdx == 0 {
                body.append(wP("附图", RunOpts(text: "", bold: true, sizeHalf: 28), "<w:spacing w:before=\"280\" w:after=\"140\"/>"))
            }
            guard let m = parseImageDataUrl(img.dataUrl) else { continue }
            imgIdx += 1
            let fileName = "image\(imgIdx).\(m.ext)"
            let rid = "rIdImg\(imgIdx)"
            rels.append("<Relationship Id=\"\(rid)\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/image\" Target=\"media/\(fileName)\"/>")
            media.append((name: "word/media/\(fileName)", data: m.data))
            var (w, h) = imagePixelSize(m.data, m.ext)
            if w == 0 || h == 0 {
                w = 1200
                h = 800
            }
            // A4 内容区宽约 15.9cm ≈ 5,700,000 EMU；1px = 9525 EMU
            let px = w * 9525
            let scale = min(1.0, 5700000.0 / Double(px))
            let cx = Int((Double(px) * scale).rounded())
            let cy = Int((Double(h * 9525) * scale).rounded())
            body.append(wP(img.name, RunOpts(text: "", bold: true, sizeHalf: 22, color: "404040"), "<w:spacing w:before=\"160\" w:after=\"80\"/>"))
            body.append("<w:p><w:r><w:drawing><wp:inline distT=\"0\" distB=\"0\" distL=\"0\" distR=\"0\"><wp:extent cx=\"\(cx)\" cy=\"\(cy)\"/><wp:effectExtent l=\"0\" t=\"0\" r=\"0\" b=\"0\"/><wp:docPr id=\"\(imgIdx)\" name=\"Picture \(imgIdx)\"/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect=\"1\"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><pic:pic><pic:nvPicPr><pic:cNvPr id=\"\(imgIdx)\" name=\"Picture \(imgIdx)\"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed=\"\(rid)\"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x=\"0\" y=\"0\"/><a:ext cx=\"\(cx)\" cy=\"\(cy)\"/></a:xfrm><a:prstGeom prst=\"rect\"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>")
        }

        if p.htmlReport != nil {
            body.append(wRuns(
                [RunOpts(
                    text: "注：交互式 HTML 报告（图上标注定位、研发回应与修改报告导出）无法作为附件随腾讯文档携带，请在应用「导出报告」页点「导出 HTML 报告」获取完整版本。",
                    sizeHalf: 18, color: "808080"
                )],
                "<w:spacing w:before=\"240\"/>"
            ))
        }

        let documentXml =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<w:document xmlns:w=\"http://schemas.openxmlformats.org/wordprocessingml/2006/main\" xmlns:r=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships\" xmlns:wp=\"http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing\" xmlns:a=\"http://schemas.openxmlformats.org/drawingml/2006/main\" xmlns:pic=\"http://schemas.openxmlformats.org/drawingml/2006/picture\"><w:body>" +
            body.joined() +
            "<w:sectPr><w:pgSz w:w=\"11906\" w:h=\"16838\"/><w:pgMar w:top=\"1440\" w:right=\"1440\" w:bottom=\"1440\" w:left=\"1440\" w:header=\"851\" w:footer=\"992\" w:gutter=\"0\"/></w:sectPr></w:body></w:document>"
        let contentTypes =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"><Default Extension=\"rels\" ContentType=\"application/vnd.openxmlformats-package.relationships+xml\"/><Default Extension=\"xml\" ContentType=\"application/xml\"/><Default Extension=\"png\" ContentType=\"image/png\"/><Default Extension=\"jpg\" ContentType=\"image/jpeg\"/><Default Extension=\"jpeg\" ContentType=\"image/jpeg\"/></Types>"
        let rootRels =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument\" Target=\"word/document.xml\"/></Relationships>"
        let docRels =
            "<?xml version=\"1.0\" encoding=\"UTF-8\" standalone=\"yes\"?>" +
            "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\(rels.joined())</Relationships>"

        return zipStore(files: [
            (name: "[Content_Types].xml", data: Array(contentTypes.data(using: .utf8)!)),
            (name: "_rels/.rels", data: Array(rootRels.data(using: .utf8)!)),
            (name: "word/document.xml", data: Array(documentXml.data(using: .utf8)!)),
            (name: "word/_rels/document.xml.rels", data: Array(docRels.data(using: .utf8)!))
        ] + media)
    }

    /// 解析 data:image/(png|jpe?g);base64,... → (ext, bytes)
    static func parseImageDataUrl(_ dataUrl: String) -> (ext: String, data: [UInt8])? {
        let trimmed = dataUrl.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let r = trimmed.range(of: "^data:image/(png|jpe?g);base64,(.+)$", options: .regularExpression) else { return nil }
        let whole = trimmed[r]
        guard let semi = whole.firstIndex(of: ";"), let comma = whole.firstIndex(of: ",") else { return nil }
        let extStart = whole.index(whole.startIndex, offsetBy: 11)
        let ext = String(whole[extStart..<semi])
        let b64 = String(whole[whole.index(after: comma)...])
        guard let data = Data(base64Encoded: b64) else { return nil }
        let normalized = ext == "jpeg" ? "jpeg" : ext
        return (normalized, Array(data))
    }
}
