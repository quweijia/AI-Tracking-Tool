/**
 * 无障碍 a11y 检查（按需叠加，默认关闭）：基于 webview 采集的 DOM 样式树做程序侧检查。
 * 覆盖 5 类高频问题：图片缺 alt、文字对比度不足、字号过小、可点目标过小、输入框无标签。
 * 输出为语言无关的结构化发现项，最终 Issue 描述由调用方（AutoWalkPanel）按当前语言拼装。
 */
import type { StyleNode } from '../../../shared/types'
import { parseColor } from '../../../shared/color'
import type { Category, Severity } from '../db'

/** 单条 a11y 发现（语言无关，落库前转 Issue） */
export interface A11yFinding {
  kind: 'img-alt-missing' | 'contrast-low' | 'font-too-small' | 'tap-target-small' | 'input-no-label'
  category: Category
  severity: Severity
  /** 归一化标注框（0~1，相对开发截图） */
  rect: { x: number; y: number; width: number; height: number }
  /** 命中节点 */
  node: StyleNode
  domPath?: string
  /** 实测值文本（对比度倍数 / 字号 / 尺寸），描述拼装用 */
  actualText?: string
  /** 建议阈值文本 */
  expectedText?: string
}

/** 每类发现最多保留条数 + 总量上限：a11y 问题重复度高，防刷屏 */
const MAX_PER_KIND = 5
const MAX_FINDINGS = 40

/** WCAG 相对亮度（r/g/b 为 0~255） */
function luminance({ r, g, b }: { r: number; g: number; b: number }): number {
  const ch = (v: number) => {
    const s = v / 255
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b)
}

/** WCAG 对比度（倍数）；任一色解析失败返回 null（不误报） */
function contrastRatio(fg: string | undefined, bg: string | undefined): number | null {
  const cf = parseColor(fg)
  const cb = parseColor(bg)
  if (!cf || !cb) return null
  const lf = luminance(cf)
  const lb = luminance(cb)
  const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf]
  return (hi + 0.05) / (lo + 0.05)
}

/** 可点标签：button / a / 带onclick语义的常见标签（name 首段为小写标签名） */
function isClickable(name: string): boolean {
  const tag = name.split(/[.#]/)[0]?.toLowerCase() ?? ''
  return tag === 'button' || tag === 'a' || tag === 'input' || tag === 'select' || tag === 'textarea'
}

/** 表单控件标签 */
function isFormField(name: string): boolean {
  const tag = name.split(/[.#]/)[0]?.toLowerCase() ?? ''
  return tag === 'input' || tag === 'textarea' || tag === 'select'
}

/**
 * a11y 检查主入口。
 * @param domRoot DOM 采集根节点（坐标相对视口/文档）
 * @param viewport 页面视口尺寸
 */
export function checkA11y(
  domRoot: StyleNode,
  viewport: { width: number; height: number }
): A11yFinding[] {
  const out: A11yFinding[] = []
  const kindCount = new Map<string, number>()
  const vw = viewport.width || 1
  const vh = viewport.height || 1

  const visit = (n: StyleNode): void => {
    if (out.length < MAX_FINDINGS && n.width > 0 && n.height > 0) {
      const tag = n.name.split(/[.#]/)[0]?.toLowerCase() ?? ''

      // 1. 图片缺 alt（装饰性图片常故意留空 alt=""，仅「未设置属性」才违规）
      if (tag === 'img' && n.alt === undefined) {
        const c = kindCount.get('img-alt-missing') ?? 0
        if (c < MAX_PER_KIND) {
          kindCount.set('img-alt-missing', c + 1)
          out.push({
            kind: 'img-alt-missing',
            category: 'missing-component',
            severity: 'suggestion',
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath
          })
        }
      }

      // 2. 文字对比度：正文 < 4.5，大字（≥24px 或 ≥18.66px 粗体）< 3.0
      if (n.text && n.textColor && n.effectiveBg) {
        const ratio = contrastRatio(n.textColor, n.effectiveBg)
        if (ratio !== null) {
          const isLarge = (n.fontSize ?? 0) >= 24 || ((n.fontSize ?? 0) >= 18.66 && (n.fontWeight ?? 400) >= 700)
          const min = isLarge ? 3 : 4.5
          if (ratio < min) {
            const c = kindCount.get('contrast-low') ?? 0
            if (c < MAX_PER_KIND) {
              kindCount.set('contrast-low', c + 1)
              out.push({
                kind: 'contrast-low',
                category: 'color',
                severity: 'minor',
                rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
                node: n,
                domPath: n.domPath,
                actualText: `${(Math.round(ratio * 100) / 100).toFixed(2)}:1`,
                expectedText: `${min}:1`
              })
            }
          }
        }
      }

      // 3. 字号过小（<12px 阅读困难）
      if (n.text && n.fontSize !== undefined && n.fontSize < 12) {
        const c = kindCount.get('font-too-small') ?? 0
        if (c < MAX_PER_KIND) {
          kindCount.set('font-too-small', c + 1)
          out.push({
            kind: 'font-too-small',
            category: 'typography',
            severity: 'suggestion',
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath,
            actualText: `${n.fontSize}px`,
            expectedText: '≥12px'
          })
        }
      }

      // 4. 可点目标过小（<24×24 触控困难）
      if (isClickable(n.name) && n.width < 24 && n.height < 24) {
        const c = kindCount.get('tap-target-small') ?? 0
        if (c < MAX_PER_KIND) {
          kindCount.set('tap-target-small', c + 1)
          out.push({
            kind: 'tap-target-small',
            category: 'interaction',
            severity: 'suggestion',
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath,
            actualText: `${Math.round(n.width)}×${Math.round(n.height)}`,
            expectedText: '≥24×24'
          })
        }
      }

      // 5. 输入框无标签（placeholder / aria-label / aria-labelledby 均缺失）
      if (isFormField(n.name) && n.ariaLabel === undefined && n.ariaLabelledby === undefined && n.placeholder === undefined) {
        const c = kindCount.get('input-no-label') ?? 0
        if (c < MAX_PER_KIND) {
          kindCount.set('input-no-label', c + 1)
          out.push({
            kind: 'input-no-label',
            category: 'interaction',
            severity: 'suggestion',
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath
          })
        }
      }
    }
    for (const ch of n.children ?? []) visit(ch)
  }
  visit(domRoot)

  return out
}
