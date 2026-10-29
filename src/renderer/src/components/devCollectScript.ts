/**
 * 注入 webview 的 DOM 样式采集脚本（纯 JS 字符串，在目标页面上下文执行）：
 * 遍历可见元素，提取 getComputedStyle 真实渲染样式 + 包围盒 + 文本 + data-figma-id，
 * 归一化为与 Figma 图层树相同的 StyleNode 结构。
 * 注意：调用前页面应已滚动到顶部，坐标为视口/文档相对坐标。
 */
import { tr } from '../i18n'

/** 生成采集脚本（函数化：内部文案按当前语言注入，切语言后重新生成生效） */
export const getDomCollectScript = (): string => String.raw`
(() => {
  const MAX_NODES = 1500;
  const SKIP_TAGS = new Set(['SCRIPT','STYLE','LINK','META','HEAD','TITLE','NOSCRIPT','TEMPLATE','BR','IFRAME','SVG','PATH','CIRCLE','RECT','G','DEFS','USE']);
  const COUNTER = { n: 0, skipped: 0 };

  const toHex = (r, g, b) =>
    '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('').toUpperCase();

  const colorOf = (raw) => {
    if (!raw || raw === 'none' || raw === 'transparent') return null;
    const m = raw.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.slice(0, 3).some(v => isNaN(v))) return null;
    const a = p[3] === undefined ? 1 : p[3];
    if (a < 0.05) return null;
    return toHex(p[0], p[1], p[2]);
  };

  const num = (v) => {
    const n = parseFloat(v);
    return isFinite(n) ? Math.round(n * 100) / 100 : undefined;
  };

  const weightOf = (v) => {
    if (!v) return undefined;
    if (v === 'bold' || v === 'bolder') return 700;
    if (v === 'normal' || v === 'lighter') return 400;
    const n = parseInt(v, 10);
    return isFinite(n) ? n : undefined;
  };

  const radiusOf = (cs) => {
    const corners = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius]
      .map(v => parseFloat(v));
    if (corners.some(v => isNaN(v))) return undefined;
    if (corners.every(v => v === 0)) return undefined;
    return corners.map(v => Math.round(v * 100) / 100);
  };

  const domPath = (el) => {
    const parts = [];
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && cur.tagName !== 'BODY' && depth < 6) {
      let seg = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(seg + '#' + cur.id); break; }
      const parent = cur.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, c => c.tagName === cur.tagName);
        if (same.length > 1) seg += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')';
      }
      parts.unshift(seg);
      cur = parent;
      depth++;
    }
    return parts.join('>') || 'body';
  };

  const ownText = (el) => {
    let text = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t) text += (text ? ' ' : '') + t;
      }
      if (text.length > 200) break;
    }
    return text.slice(0, 200);
  };

  // 有效背景色：自身背景透明时向上取最近祖先的可见背景（a11y 对比度检查用）
  const effectiveBgOf = (el) => {
    let cur = el;
    let depth = 0;
    while (cur && cur.nodeType === 1 && depth < 8) {
      let bg;
      try { bg = getComputedStyle(cur).backgroundColor; } catch { return null; }
      const c = colorOf(bg);
      if (c) return c;
      cur = cur.parentElement;
      depth++;
    }
    return null;
  };

  const collect = (el) => {
    if (COUNTER.n >= MAX_NODES) { COUNTER.skipped++; return null; }
    if (!el || el.nodeType !== 1) return null;
    const tag = el.tagName.toUpperCase();
    if (SKIP_TAGS.has(tag)) return null;
    let cs;
    try { cs = getComputedStyle(el); } catch { return null; }
    if (cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity) === 0) return null;
    const rect = el.getBoundingClientRect();
    if (rect.width < 1 || rect.height < 1) return null;

    const text = ownText(el);
    const fill = colorOf(cs.backgroundColor);
    const textColor = text ? colorOf(cs.color) : null;
    const display = cs.display;
    const isFlexGrid = display.includes('flex') || display.includes('grid');

    const node = {
      id: 'dom-' + COUNTER.n,
      name: tag.toLowerCase() + (typeof el.className === 'string' && el.className.trim()
        ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.') : ''),
      type: text ? 'text' : (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS' || tag === 'PICTURE' ? 'rect' : 'frame'),
      x: Math.round((rect.left + window.scrollX) * 100) / 100,
      y: Math.round((rect.top + window.scrollY) * 100) / 100,
      width: Math.round(rect.width * 100) / 100,
      height: Math.round(rect.height * 100) / 100
    };
    if (fill) node.fill = fill;
    if (text) node.text = text;
    if (textColor) node.textColor = textColor;
    const fs = num(cs.fontSize);
    if (fs !== undefined) node.fontSize = fs;
    const fw = weightOf(cs.fontWeight);
    if (fw !== undefined) node.fontWeight = fw;
    if (cs.fontFamily) node.fontFamily = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim().slice(0, 60);
    if (cs.lineHeight !== 'normal') node.lineHeight = num(cs.lineHeight);
    if (cs.letterSpacing !== 'normal') node.letterSpacing = num(cs.letterSpacing);
    if (cs.textAlign === 'center' || cs.textAlign === 'right') node.textAlign = cs.textAlign;
    const pts = [cs.paddingTop, cs.paddingRight, cs.paddingBottom, cs.paddingLeft].map(num);
    if (pts.some(v => v !== undefined && v > 0)) {
      node.paddingTop = pts[0] || 0;
      node.paddingRight = pts[1] || 0;
      node.paddingBottom = pts[2] || 0;
      node.paddingLeft = pts[3] || 0;
    }
    if (isFlexGrid) {
      const rg = num(cs.rowGap) || 0;
      const cg = num(cs.columnGap) || 0;
      if (Math.max(rg, cg) > 0) node.gap = Math.max(rg, cg);
    }
    const radius = radiusOf(cs);
    if (radius) node.borderRadius = radius;
    const bw = num(cs.borderTopWidth) || 0;
    if (bw > 0 && cs.borderTopStyle !== 'none') {
      node.borderWidth = bw;
      const bc = colorOf(cs.borderTopColor);
      if (bc) node.borderColor = bc;
    }
    if (cs.boxShadow && cs.boxShadow !== 'none') node.boxShadow = cs.boxShadow.slice(0, 200);
    const op = parseFloat(cs.opacity);
    if (op < 1) node.opacity = Math.round(op * 100) / 100;
    node.dominantColor = fill || textColor || null;
    if (node.width > 0 && node.height > 0) node.aspectRatio = Math.round(node.width / node.height * 1000) / 1000;
    // 图片加载状态与替代文本（元素清单一致性 / a11y 检查用）
    if (tag === 'IMG') {
      node.imgBroken = el.complete === true && el.naturalWidth === 0;
      const alt = el.getAttribute('alt');
      if (alt !== null) node.alt = alt;
    }
    // 表单控件的无障碍标签来源（a11y 检查用：三处均缺失判「输入框无标签」）
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      const placeholder = el.getAttribute('placeholder');
      const ariaLabel = el.getAttribute('aria-label');
      const labelledby = el.getAttribute('aria-labelledby');
      if (placeholder !== null) node.placeholder = placeholder;
      if (ariaLabel) node.ariaLabel = ariaLabel;
      if (labelledby) node.ariaLabelledby = labelledby;
    }
    if (text && textColor) {
      const ebg = effectiveBgOf(el);
      if (ebg) node.effectiveBg = ebg;
    }
    const fid = el.getAttribute && el.getAttribute('data-figma-id');
    if (fid) node.dataFigmaId = fid;
    node.domPath = domPath(el);
    COUNTER.n++;
    return node;
  };

  const walk = (el, depth) => {
    const node = collect(el);
    if (!node) return null;
    if (depth < 14 && COUNTER.n < MAX_NODES) {
      const children = [];
      for (const child of el.children) {
        const c = walk(child, depth + 1);
        if (c) children.push(c);
      }
      if (children.length) node.children = children;
    }
    return node;
  };

  const body = document.body;
  if (!body) return JSON.stringify({ ok: false, message: ${JSON.stringify(tr('bodyMissing', 'devCollectScript'))} });

  const rootFill = colorOf(getComputedStyle(body).backgroundColor) || colorOf(getComputedStyle(document.documentElement).backgroundColor);
  const root = {
    id: 'dom-root',
    name: 'body',
    type: 'frame',
    x: 0,
    y: 0,
    width: Math.round(Math.max(document.documentElement.scrollWidth, window.innerWidth) * 100) / 100,
    height: Math.round(Math.max(document.documentElement.scrollHeight, window.innerHeight) * 100) / 100,
    fill: rootFill || null,
    dominantColor: rootFill || null,
    domPath: 'body'
  };
  const children = [];
  for (const child of body.children) {
    const c = walk(child, 1);
    if (c) children.push(c);
  }
  if (children.length) root.children = children;

  return JSON.stringify({
    ok: true,
    root,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    collected: COUNTER.n,
    skipped: COUNTER.skipped
  });
})()
`
