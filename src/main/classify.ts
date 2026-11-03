/**
 * 节点自动分类器（分层误差模型 v3，纯判定逻辑，无副作用）：
 * 对一个匹配对（设计稿节点 + DOM 节点）判定：
 * - nodeKind：container（容器/模块承载）/ control（交互与内容控件）/ text（文本）
 * - adaptable：自适应容器（跳过尺寸维，避免流式布局误报）
 *
 * 分类优先级：DOM 语义标签 > Figma text 类型 > 节点名关键词 > 尺寸兜底。
 */
import type { NodeKind, StyleNode } from '../shared/types'

/** 交互/内容类语义标签：控件 */
const CONTROL_TAGS = new Set([
  'button',
  'input',
  'select',
  'textarea',
  'a',
  'label',
  'img',
  'svg',
  'video',
  'audio',
  'canvas',
  'progress',
  'meter'
])

/** 布局承载类语义标签：容器 */
const CONTAINER_TAGS = new Set([
  'div',
  'section',
  'main',
  'header',
  'footer',
  'nav',
  'aside',
  'article',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'table',
  'thead',
  'tbody',
  'tr',
  'td',
  'th',
  'form',
  'fieldset',
  'figure',
  'dialog'
])

/** 控件关键词（节点名命中 → control），中英文双份 */
const CONTROL_KEYWORDS = [
  'button',
  'btn',
  'icon',
  'avatar',
  'checkbox',
  'radio',
  'switch',
  'toggle',
  'slider',
  'input',
  'field',
  'tag',
  'badge',
  'chip',
  'logo',
  'image',
  'img',
  'thumbnail',
  'thumb',
  '按钮',
  '图标',
  '头像',
  '复选',
  '单选',
  '开关',
  '滑块',
  '输入',
  '标签',
  '徽标',
  '图片',
  '缩略'
]

/** 自适应布局关键词（命中 → adaptable，跳过尺寸维） */
const ADAPTABLE_KEYWORDS = [
  'layout',
  'wrapper',
  'wrap',
  'container',
  'grid',
  'list',
  'card',
  'banner',
  'section',
  'row',
  'col',
  'flex',
  'stack',
  'page',
  'modal',
  'drawer',
  'panel',
  'sidebar',
  '布局',
  '容器',
  '卡片',
  '列表',
  '横幅',
  '弹窗',
  '抽屉',
  '面板',
  '侧边',
  '页面'
]

/** 尺寸兜底阈值：max(宽,高) ≥ 240 视为容器 */
const KIND_SIZE_MIN = 240

/** 自适应容器最小边：宽或高 ≥ 240 视为自适应（流式/栅格布局，尺寸常随内容变化） */
export const ADAPTABLE_MIN_EDGE = 240

/** 从 domPath 尾段提取 HTML 标签名（如 "div.card > button.primary" → "button"） */
function domTag(node: StyleNode): string | undefined {
  const path = node.domPath ?? ''
  const last = path.split('>').pop()?.trim() ?? ''
  const m = /^([a-zA-Z][a-zA-Z0-9-]*)/.exec(last)
  return m ? m[1].toLowerCase() : undefined
}

function hitKeywords(name: string, keywords: string[]): boolean {
  const lower = name.toLowerCase()
  return keywords.some((k) => lower.includes(k))
}

/** 单节点分类结果 */
export interface NodeClass {
  nodeKind: NodeKind
  adaptable: boolean
}

/**
 * 对匹配对分类（以设计稿节点为主线，DOM 语义标签最可靠时优先采纳）。
 * 纯函数：不读取外部状态，便于 esbuild 打包后独立运行验证。
 */
export function classifyPair(design: StyleNode, dom: StyleNode): NodeClass {
  const w = Math.max(design.width, dom.width)
  const h = Math.max(design.height, dom.height)
  const name = design.name || dom.name || ''

  // 1. 文本节点（Figma type=text 或设计稿显式标注）
  if (design.type === 'text') return { nodeKind: 'text', adaptable: false }

  // 2. DOM 语义标签（最可靠）
  const tag = domTag(dom)
  if (tag && CONTROL_TAGS.has(tag)) return { nodeKind: 'control', adaptable: false }
  if (tag && CONTAINER_TAGS.has(tag)) {
    // 容器标签但节点名明显是控件关键词（如 div 内含 icon 图标类），仍归控件
    if (hitKeywords(name, CONTROL_KEYWORDS) && Math.max(w, h) < KIND_SIZE_MIN) {
      return { nodeKind: 'control', adaptable: false }
    }
    return { nodeKind: 'container', adaptable: isAdaptable(name, w, h) }
  }

  // 3. 节点名关键词（设计稿图层名 / DOM 名）
  if (hitKeywords(name, CONTROL_KEYWORDS)) return { nodeKind: 'control', adaptable: false }

  // 4. 尺寸兜底：大块 → 容器，小块 → 控件
  const nodeKind: NodeKind = Math.max(w, h) >= KIND_SIZE_MIN ? 'container' : 'control'
  return { nodeKind, adaptable: nodeKind === 'container' && isAdaptable(name, w, h) }
}

/** 自适应判定：宽或高 ≥ ADAPTABLE_MIN_EDGE，或名含布局关键词 */
function isAdaptable(name: string, w: number, h: number): boolean {
  return w >= ADAPTABLE_MIN_EDGE || h >= ADAPTABLE_MIN_EDGE || hitKeywords(name, ADAPTABLE_KEYWORDS)
}
