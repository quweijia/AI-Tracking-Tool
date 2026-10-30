import Foundation

// MARK: - AI 视觉标注框吸附校正（对齐 Electron spec/aiRectRefine.ts）
//
// AI 模型返回的归一化坐标是视觉估算值，与真实元素矩形存在偏移。
// 用走查时已采集的 DOM 树（截图轨）与 Figma 图层树（设计稿轨）中的
// 精确元素矩形对 AI 框做吸附：找 IoU 最高的真实节点替换估算框，
// 点/文本标注则吸附到所在最小节点的中心，measure/picker 保持不动。

/// 吸附数据源节点：仅需几何字段（StyleNode 的其余键解码时忽略）
private struct RefineNode: Decodable {
    var x: Double?
    var y: Double?
    var width: Double?
    var height: Double?
    var children: [RefineNode]?
}

/// rect 吸附阈值：IoU 低于该值视为 AI 框没有明确对应元素，保留原框
private let snapIou = 0.18

/// 全页容器判定比例：宽高同时 ≥ 95% 画布的节点是页面画布本身，不参与吸附
private let pageRatio = 0.95

private struct PxRect {
    var x: Double
    var y: Double
    var w: Double
    var h: Double
}

private func iou(_ a: PxRect, _ b: PxRect) -> Double {
    let ix = max(0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    let iy = max(0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))
    let inter = ix * iy
    if inter <= 0 { return 0 }
    return inter / (a.w * a.h + b.w * b.h - inter)
}

/// 展平树为候选矩形列表：过滤无效/过小/全页画布节点
private func collectRects(_ data: Data, _ w: Double, _ h: Double) -> [PxRect] {
    guard let root = try? JSONDecoder().decode(RefineNode.self, from: data) else { return [] }
    var out: [PxRect] = []
    func walk(_ n: RefineNode) {
        if let x = n.x, let y = n.y, let width = n.width, let height = n.height,
           x.isFinite, y.isFinite, width.isFinite, height.isFinite {
            if width >= 2, height >= 2, !(width >= w * pageRatio && height >= h * pageRatio) {
                out.append(PxRect(x: x, y: y, w: width, h: height))
            }
        }
        for c in n.children ?? [] { walk(c) }
    }
    walk(root)
    return out
}

/// 就地校正 AI 视觉 Issue 的归一化标注坐标（仅 walk 链路调用，手动双图无比对树）。
/// 吸附在程序轨去重之前执行：AI 框与程序轨矩形精确重叠后，rectIoU 去重也更准。
enum AiRectRefine {
    struct Input {
        var domRootJSON: Data?
        var viewport: CGSize?
        var designRootJSON: Data?
        var frameSize: CGSize?
    }

    static func refine(_ rows: [Issue], input: Input) {
        // 按目标图准备两套坐标系：px 树矩形 → 归一化时除以画布宽高
        var prepared: [(img: TargetImage, w: Double, h: Double, rects: [PxRect])] = []
        let sources: [(tree: Data?, size: CGSize?, img: TargetImage)] = [
            (input.domRootJSON, input.viewport, .screenshot),
            (input.designRootJSON, input.frameSize, .design)
        ]
        for s in sources {
            guard let tree = s.tree, let size = s.size,
                  size.width > 4, size.height > 4 else { continue }
            let rects = collectRects(tree, size.width, size.height)
            if !rects.isEmpty {
                prepared.append((s.img, size.width, size.height, rects))
            }
        }
        if prepared.isEmpty { return }

        for row in rows {
            if row.displayShape == .measure || row.displayShape == .picker { continue }
            let img: TargetImage = row.targetImage == .design ? .design : .screenshot
            guard let src = prepared.first(where: { $0.img == img }) else { continue }
            let w = src.w
            let h = src.h
            if row.displayShape == .rect {
                let box = PxRect(x: row.x * w, y: row.y * h, w: row.width * w, h: row.height * h)
                guard box.w > 1, box.h > 1 else { continue }
                var best: PxRect?
                var bestIou = 0.0
                for cand in src.rects {
                    let v = iou(box, cand)
                    if v > bestIou {
                        bestIou = v
                        best = cand
                    }
                }
                // 吸附到 IoU 最高的真实元素矩形（归一化回写）
                if let best, bestIou >= snapIou {
                    row.x = best.x / w
                    row.y = best.y / h
                    row.width = best.w / w
                    row.height = best.h / h
                }
            } else {
                // point/text：找包含标注点的最小面积节点，吸附到其中心
                let px = (row.x + row.width / 2) * w
                let py = (row.y + row.height / 2) * h
                var best: PxRect?
                for cand in src.rects {
                    if px >= cand.x, px <= cand.x + cand.w, py >= cand.y, py <= cand.y + cand.h {
                        if best == nil || cand.w * cand.h < best!.w * best!.h {
                            best = cand
                        }
                    }
                }
                if let best {
                    row.x = (best.x + best.w / 2) / w
                    row.y = (best.y + best.h / 2) / h
                    row.width = 0
                    row.height = 0
                }
            }
        }
    }
}
