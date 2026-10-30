// src/entry.ts
var import_node_fs = require("node:fs");

// ../../src/shared/color.ts
function parseColor(input) {
  if (!input) return null;
  const s = input.trim().toLowerCase();
  if (s === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  if (s.startsWith("#")) {
    const hex = s.slice(1);
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split("").map((c) => parseInt(c + c, 16));
      return { r, g, b, a: hex.length === 4 ? a / 255 : 1 };
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16);
      const g = parseInt(hex.slice(2, 4), 16);
      const b = parseInt(hex.slice(4, 6), 16);
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
      if ([r, g, b].some((v) => Number.isNaN(v))) return null;
      return { r, g, b, a };
    }
    return null;
  }
  const m = s.match(/^rgba?\(([^)]+)\)$/);
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean);
    if (parts.length >= 3) {
      const nums = parts.map((p) => p.endsWith("%") ? parseFloat(p) / 100 * 255 : parseFloat(p));
      if (nums.slice(0, 3).some((v) => Number.isNaN(v))) return null;
      return {
        r: nums[0],
        g: nums[1],
        b: nums[2],
        a: parts[3] !== void 0 && !Number.isNaN(parseFloat(parts[3])) ? parseFloat(parts[3]) : 1
      };
    }
  }
  return null;
}
function rgbToHex({ r, g, b }) {
  const to = (v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase();
}
function rgbaLabel({ r, g, b, a }) {
  const alpha = Math.round(a * 100) / 100;
  return alpha >= 1 ? rgbToHex({ r, g, b, a }) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`;
}
var clamp01 = (v) => Math.max(0, Math.min(1, v));
function srgbChannelToLinear(c) {
  const cs = c / 255;
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4);
}
function rgbToLab({ r, g, b }) {
  const rl = srgbChannelToLinear(r);
  const gl = srgbChannelToLinear(g);
  const bl = srgbChannelToLinear(b);
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047;
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175;
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883;
  const f = (t) => t > 8856e-6 ? Math.cbrt(t) : 7.787 * t + 16 / 116;
  const fx = f(x);
  const fy = f(y);
  const fz = f(z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
function deltaE2000(lab1, lab2) {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const kL = 1;
  const kC = 1;
  const kH = 1;
  const C1 = Math.sqrt(a1 * a1 + b1 * b1);
  const C2 = Math.sqrt(a2 * a2 + b2 * b2);
  const Cavg = (C1 + C2) / 2;
  const pow7 = (v) => Math.pow(v, 7);
  const G = 0.5 * (1 - Math.sqrt(pow7(Cavg) / (pow7(Cavg) + pow7(25))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.sqrt(a1p * a1p + b1 * b1);
  const C2p = Math.sqrt(a2p * a2p + b2 * b2);
  const toDeg = (rad2) => rad2 * 180 / Math.PI;
  const h1p = a1p === 0 && b1 === 0 ? 0 : (toDeg(Math.atan2(b1, a1p)) + 360) % 360;
  const h2p = a2p === 0 && b2 === 0 ? 0 : (toDeg(Math.atan2(b2, a2p)) + 360) % 360;
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp * Math.PI / 360);
  const Lavg = (L1 + L2) / 2;
  const Cpavg = (C1p + C2p) / 2;
  let hpavg;
  if (C1p * C2p === 0) {
    hpavg = h1p + h2p;
  } else {
    hpavg = (h1p + h2p) / 2;
    if (Math.abs(h1p - h2p) > 180) {
      if (h1p + h2p < 360) hpavg += 180;
      else hpavg -= 180;
    }
  }
  const rad = (deg) => deg * Math.PI / 180;
  const T = 1 - 0.17 * Math.cos(rad(hpavg - 30)) + 0.24 * Math.cos(rad(2 * hpavg)) + 0.32 * Math.cos(rad(3 * hpavg + 6)) - 0.2 * Math.cos(rad(4 * hpavg - 63));
  const dTheta = 30 * Math.exp(-Math.pow((hpavg - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(pow7(Cpavg) / (pow7(Cpavg) + pow7(25)));
  const Sl = 1 + 0.015 * Math.pow(Lavg - 50, 2) / Math.sqrt(20 + Math.pow(Lavg - 50, 2));
  const Sc = 1 + 0.045 * Cpavg;
  const Sh = 1 + 0.015 * Cpavg * T;
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc;
  const tL = dLp / (kL * Sl);
  const tC = dCp / (kC * Sc);
  const tH = dHp / (kH * Sh);
  return Math.sqrt(Math.max(0, tL * tL + tC * tC + tH * tH + Rt * tC * tH));
}
function colorDeltaE(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb) return null;
  return deltaE2000(rgbToLab(ca), rgbToLab(cb));
}
function figmaColorToHex(color, opacity = 1) {
  if (!color) return null;
  const a = color.a ?? opacity;
  if (clamp01(a) < 0.05) return null;
  return rgbToHex({ r: color.r * 255, g: color.g * 255, b: color.b * 255, a: clamp01(a) });
}

// ../../src/main/matcher.ts
var MATCH_MIN_SCORE = 0.35;
function flatten(root) {
  const list = [];
  const w = root.width || 1;
  const h = root.height || 1;
  const walk = (node, parent, depth) => {
    const item = { node, parent, depth };
    list.push(item);
    for (const child of node.children ?? []) walk(child, item, depth + 1);
  };
  walk(root, null, 0);
  return { list, w, h };
}
function isAncestor(a, b) {
  let p = b.parent;
  while (p) {
    if (p === a) return true;
    p = p.parent;
  }
  return false;
}
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[n];
}
function textSimilarity(a, b) {
  const ta = (a ?? "").trim().toLowerCase();
  const tb = (b ?? "").trim().toLowerCase();
  if (!ta && !tb) return null;
  if (!ta || !tb) return 0.2;
  if (ta === tb) return 1;
  if (ta.includes(tb) || tb.includes(ta)) return 0.85;
  const dist = levenshtein(ta.slice(0, 80), tb.slice(0, 80));
  return Math.max(0, 1 - dist / Math.max(ta.length, tb.length));
}
function pairScore(d, m, ctx) {
  const sizeScore = 1 - Math.min(
    1,
    (Math.abs(d.width - m.width) / Math.max(d.width, m.width, 1) + Math.abs(d.height - m.height) / Math.max(d.height, m.height, 1)) / 2
  );
  const aspectScore = d.aspectRatio && m.aspectRatio ? 1 - Math.min(1, Math.abs(d.aspectRatio - m.aspectRatio) / 1.5) : 0.5;
  let colorScore = 0.5;
  if (d.dominantColor && m.dominantColor) {
    const de = colorDeltaE(d.dominantColor, m.dominantColor);
    colorScore = de === null ? 0.5 : 1 - Math.min(1, de / 45);
  }
  const dcx = (d.x + d.width / 2) / ctx.frameW;
  const dcy = (d.y + d.height / 2) / ctx.frameH;
  const mcx = (m.x + m.width / 2) / ctx.viewW;
  const mcy = (m.y + m.height / 2) / ctx.viewH;
  const dist = Math.sqrt((dcx - mcx) ** 2 + (dcy - mcy) ** 2);
  const posScore = 1 - Math.min(1, dist / 0.4);
  const textScore = textSimilarity(d.text, m.text);
  if (textScore !== null) {
    return sizeScore * 0.25 + textScore * 0.35 + colorScore * 0.15 + posScore * 0.15 + aspectScore * 0.1;
  }
  return sizeScore * 0.4 + colorScore * 0.25 + posScore * 0.25 + aspectScore * 0.1;
}
function matchNodes(designRoot, domRoot) {
  const design = flatten(designRoot);
  const dom = flatten(domRoot);
  const ctx = { frameW: design.w, frameH: design.h, viewW: dom.w, viewH: dom.h };
  const usedDesign = /* @__PURE__ */ new Set();
  const usedDom = /* @__PURE__ */ new Set();
  const pairs = [];
  const domList = dom.list;
  const designList = design.list;
  const designById = new Map(designList.map((it) => [it.node.figmaNodeId ?? it.node.id, it]));
  for (const mItem of domList) {
    const fid = mItem.node.dataFigmaId;
    if (!fid || usedDom.has(mItem.node.id)) continue;
    const dItem = designById.get(fid);
    if (!dItem || usedDesign.has(dItem.node.id)) continue;
    pairs.push({ design: dItem.node, dom: mItem.node, confidence: 1, method: "figma-id" });
    usedDesign.add(dItem.node.id);
    usedDom.add(mItem.node.id);
  }
  const isText = (n) => n.type === "text" || !!(n.text && n.text.trim());
  const candidates = [];
  for (const dItem of designList) {
    if (dItem.node.id === designRoot.id) continue;
    const dText = isText(dItem.node);
    for (const mItem of domList) {
      if (mItem.node.id === domRoot.id || isText(mItem.node) !== dText) continue;
      const score = pairScore(dItem.node, mItem.node, ctx);
      if (score >= MATCH_MIN_SCORE) candidates.push({ d: dItem, m: mItem, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  const fuzzyPairs = [];
  for (const c of candidates) {
    if (usedDesign.has(c.d.node.id) || usedDom.has(c.m.node.id)) continue;
    let crossed = false;
    for (const p of fuzzyPairs) {
      if (isAncestor(c.d, p.d) && isAncestor(p.m, c.m) || isAncestor(p.d, c.d) && isAncestor(c.m, p.m)) {
        crossed = true;
        break;
      }
    }
    if (crossed) continue;
    fuzzyPairs.push(c);
    usedDesign.add(c.d.node.id);
    usedDom.add(c.m.node.id);
  }
  for (const c of fuzzyPairs) {
    pairs.push({ design: c.d.node, dom: c.m.node, confidence: Math.round(c.score * 1e3) / 1e3, method: "fuzzy" });
  }
  const matchedDesign = new Set(pairs.map((p) => p.design.id));
  const matchedDom = new Set(pairs.map((p) => p.dom.id));
  return {
    pairs,
    unmatchedDesignCount: designList.filter((it) => !matchedDesign.has(it.node.id)).length,
    unmatchedDomCount: domList.filter((it) => !matchedDom.has(it.node.id)).length
  };
}

// ../../src/main/diff.ts
var MAX_DIFFS = 200;
var MIN_ELEM_SIZE = 8;
var px = (v) => `${Math.round(v * 100) / 100}px`;
function severityByRatio(ratio, major, minor) {
  return ratio >= major ? "major" : ratio >= minor ? "minor" : "suggestion";
}
var clamp012 = (v) => Math.max(0, Math.min(1, v));
function colorLabel(raw) {
  const c = parseColor(raw);
  return c ? rgbaLabel(c) : raw;
}
function devColorHex(raw) {
  const c = parseColor(raw);
  return c ? rgbToHex(c) : void 0;
}
function diffPair(pair, tol, includeSizeSpacing) {
  const out = [];
  const d = pair.design;
  const m = pair.dom;
  if (m.width < MIN_ELEM_SIZE || m.height < MIN_ELEM_SIZE) return out;
  const push = (item) => {
    out.push(item);
  };
  const checkSize = (prop, label, dv, mv) => {
    const diff = Math.abs(dv - mv);
    if (diff <= tol.size) return;
    push({
      category: "style",
      severity: severityByRatio(diff / Math.max(dv, 1), 0.25, 0.12),
      property: prop,
      label,
      designValue: px(dv),
      devValue: px(mv)
    });
  };
  if (includeSizeSpacing) {
    checkSize("width", "\u5BBD\u5EA6", d.width, m.width);
    checkSize("height", "\u9AD8\u5EA6", d.height, m.height);
  }
  const checkColor = (property, label, designColor, devColor) => {
    const de = colorDeltaE(designColor, devColor);
    if (de === null || de <= tol.color) return;
    push({
      category: "color",
      severity: severityByRatio(de, 15, 6),
      property,
      label,
      designValue: colorLabel(designColor),
      devValue: colorLabel(devColor),
      colorHex: devColorHex(devColor)
    });
  };
  if (d.type === "text" || d.text && d.text.trim()) {
    if (d.textColor && m.textColor) checkColor("color", "\u6587\u5B57\u989C\u8272", d.textColor, m.textColor);
  }
  if (d.fill && m.fill) checkColor("background", "\u80CC\u666F\u8272", d.fill, m.fill);
  if (d.type === "text" || d.text && d.text.trim()) {
    if (d.fontSize !== void 0) {
      const mv = m.fontSize ?? 0;
      const diff = Math.abs(d.fontSize - mv);
      if (diff > tol.typography) {
        push({
          category: "typography",
          severity: diff >= 4 ? "major" : diff >= 2 ? "minor" : "suggestion",
          property: "font-size",
          label: "\u5B57\u53F7",
          designValue: px(d.fontSize),
          devValue: m.fontSize === void 0 ? "\u672A\u8BBE\u7F6E" : px(mv)
        });
      }
    }
    if (d.fontWeight !== void 0 && m.fontWeight !== void 0 && d.fontWeight !== m.fontWeight) {
      const diff = Math.abs(d.fontWeight - m.fontWeight);
      push({
        category: "typography",
        severity: diff >= 300 ? "major" : "minor",
        property: "font-weight",
        label: "\u5B57\u91CD",
        designValue: String(d.fontWeight),
        devValue: String(m.fontWeight)
      });
    }
  }
  const checkSpacing = (prop, label, dv, mv) => {
    if (dv === void 0) return;
    const mVal = mv ?? 0;
    const diff = Math.abs(dv - mVal);
    if (diff <= tol.spacing) return;
    push({
      category: "spacing",
      severity: diff >= 8 ? "major" : diff >= 4 ? "minor" : "suggestion",
      property: prop,
      label,
      designValue: px(dv),
      devValue: px(mVal)
    });
  };
  if (includeSizeSpacing) {
    checkSpacing("padding-top", "\u4E0A\u5185\u8FB9\u8DDD", d.paddingTop, m.paddingTop);
    checkSpacing("padding-right", "\u53F3\u5185\u8FB9\u8DDD", d.paddingRight, m.paddingRight);
    checkSpacing("padding-bottom", "\u4E0B\u5185\u8FB9\u8DDD", d.paddingBottom, m.paddingBottom);
    checkSpacing("padding-left", "\u5DE6\u5185\u8FB9\u8DDD", d.paddingLeft, m.paddingLeft);
    checkSpacing("gap", "\u5143\u7D20\u95F4\u8DDD", d.gap, m.gap);
  }
  if (d.borderRadius?.length) {
    const dr = d.borderRadius;
    const mr = m.borderRadius ?? [0, 0, 0, 0];
    const maxDiff = Math.max(...dr.map((v, i) => Math.abs(v - (mr[i] ?? 0))));
    if (maxDiff > Math.max(tol.radius, 2)) {
      const fmtR = (arr) => {
        const all = arr.every((v) => Math.abs(v - arr[0]) < 0.01);
        return all ? px(arr[0]) : arr.map(px).join(" ");
      };
      push({
        category: "style",
        severity: maxDiff >= 6 ? "major" : "minor",
        property: "border-radius",
        label: "\u5706\u89D2",
        designValue: fmtR(dr),
        devValue: m.borderRadius ? fmtR(mr) : "\u672A\u8BBE\u7F6E"
      });
    }
  }
  return out;
}
function computeDiffs(pairs, tolerance, viewport, includeSizeSpacing = true) {
  const order = { major: 0, minor: 1, suggestion: 2 };
  const out = [];
  for (const pair of pairs) {
    const raws = diffPair(pair, tolerance, includeSizeSpacing);
    if (raws.length === 0) continue;
    const sorted = [...raws].sort((a, b) => order[a.severity] - order[b.severity]);
    const top = sorted[0];
    const colorItem = raws.find((r) => r.category === "color");
    const name = pair.design.name || pair.dom.name || "\u5143\u7D20";
    const details = raws.map((r) => `${r.label} ${r.designValue} \u2192 ${r.devValue}`).join("\uFF1B");
    const dom = pair.dom;
    out.push({
      category: top.category,
      severity: top.severity,
      property: raws.map((r) => r.property).join(","),
      label: `${raws.length} \u9879\u6837\u5F0F`,
      designValue: top.designValue,
      devValue: top.devValue,
      colorHex: colorItem?.colorHex,
      description: `\u300C${name}\u300D\u6574\u4F53\u6837\u5F0F\u4E0D\u4E00\u81F4\uFF08${raws.length} \u9879\uFF09\uFF1A${details}`,
      figmaNodeId: pair.design.figmaNodeId,
      domPath: dom.domPath,
      matchConfidence: pair.confidence,
      rect: {
        x: clamp012(dom.x / viewport.width),
        y: clamp012(dom.y / viewport.height),
        width: Math.max(4e-3, Math.min(1, dom.width / viewport.width)),
        height: Math.max(4e-3, Math.min(1, dom.height / viewport.height))
      }
    });
  }
  out.sort((a, b) => order[a.severity] - order[b.severity] || b.matchConfidence - a.matchConfidence);
  return out.slice(0, MAX_DIFFS);
}

// ../../src/shared/types.ts
var DEFAULT_TOLERANCE = {
  size: 2,
  typography: 2,
  spacing: 4,
  radius: 2,
  color: 8,
  border: 2
};
function normalizeTolerance(raw) {
  const merged = { ...DEFAULT_TOLERANCE, ...raw ?? {} };
  const clamp = (v, fallback) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : fallback;
  };
  return {
    size: clamp(merged.size, DEFAULT_TOLERANCE.size),
    typography: clamp(merged.typography, DEFAULT_TOLERANCE.typography),
    spacing: clamp(merged.spacing, DEFAULT_TOLERANCE.spacing),
    radius: clamp(merged.radius, DEFAULT_TOLERANCE.radius),
    color: clamp(merged.color, DEFAULT_TOLERANCE.color),
    border: clamp(merged.border, DEFAULT_TOLERANCE.border)
  };
}
var WALK_DIMENSIONS = [
  { key: "text", label: "\u6587\u5B57\u7C7B" },
  { key: "layout", label: "\u5BF9\u9F50\u5E03\u5C40" },
  { key: "image", label: "\u56FE\u6807\u56FE\u7247" },
  { key: "state", label: "\u7EC4\u4EF6\u72B6\u6001" },
  { key: "color", label: "\u8272\u5F69" },
  { key: "typography", label: "\u6392\u7248" }
];
var WALK_ANALYSES = [
  { key: "locate", label: "\u95EE\u9898\u5B9A\u4F4D\u4E0E\u539F\u56E0" },
  { key: "fix", label: "\u4FEE\u6539\u5EFA\u8BAE" },
  { key: "risk", label: "\u98CE\u9669\u8BC4\u4F30" },
  { key: "priority", label: "\u4F18\u5316\u4F18\u5148\u7EA7" }
];
var DEFAULT_WALK_CHECK_OPTIONS = {
  dimensions: WALK_DIMENSIONS.map((d) => d.key),
  depth: "standard",
  analysis: WALK_ANALYSES.map((a) => a.key),
  style: "detailed",
  a11y: false
};
var TOKEN_KIND_TO_TYPE = {
  color: "color",
  spacing: "dimension",
  fontSize: "typography",
  lineHeight: "typography",
  radius: "radius",
  shadow: "shadow",
  border: "dimension"
};

// ../../src/main/figma.ts
var import_node_http = require("node:http");
var import_node_https = require("node:https");
var import_node_tls = require("node:tls");
var FIGMA_API = "https://api.figma.com/v1";
var MAX_NODES = 1500;
var MAX_DEPTH = 12;
var cachedProxy;
var customProxy = "";
function setFigmaCustomProxy(proxy) {
  const next = ((proxy ?? "").trim() || "").replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
  if (next !== customProxy) {
    customProxy = next;
    cachedProxy = void 0;
  }
}
var stripScheme = (s) => s.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "").replace(/\/+$/, "");
function proxyCandidates() {
  const env = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY || process.env.http_proxy || "";
  const list = [];
  if (customProxy) list.push(customProxy);
  if (env) list.push(stripScheme(env));
  const local = "127.0.0.1:7890";
  if (!list.includes(local)) list.push(local);
  list.push(null);
  return list;
}
function proxyChainHint() {
  const parts = proxyCandidates().map((p) => {
    if (!p) return "\u76F4\u8FDE";
    if (p === "127.0.0.1:7890") return "\u672C\u673A\u4EE3\u7406 127.0.0.1:7890";
    return `\u4EE3\u7406 ${p}`;
  });
  return `\u5DF2\u4F9D\u6B21\u5C1D\u8BD5 ${parts.join(" \u2192 ")}\u3002\u82E5\u6D4F\u89C8\u5668\u80FD\u6253\u5F00 Figma \u800C\u5E94\u7528\u4E0D\u884C\uFF0C\u901A\u5E38\u662F\u4EE3\u7406\u672A\u4F5C\u7528\u4E8E\u672C\u5E94\u7528\uFF1A\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 MCP \u7BA1\u7406\u300D\u7F16\u8F91 Figma \u670D\u52A1\uFF0C\u586B\u5199\u53EF\u7528\u4EE3\u7406\u5730\u5740\uFF08\u5982 http://127.0.0.1:7890 \u6216\u516C\u53F8\u5185\u7F51\u4EE3\u7406\uFF09\u540E\u91CD\u8BD5`;
}
function connectViaProxy(proxy, host, port, timeoutMs) {
  const idx = proxy.lastIndexOf(":");
  const ph = idx > 0 ? proxy.slice(0, idx) : proxy;
  const pp = idx > 0 ? Number(proxy.slice(idx + 1)) : 80;
  return new Promise((resolve, reject) => {
    const req = (0, import_node_http.request)({
      host: ph,
      port: pp,
      method: "CONNECT",
      path: `${host}:${port}`,
      headers: { Host: `${host}:${port}` },
      timeout: timeoutMs
    });
    req.once("connect", (res, socket) => {
      if (res.statusCode === 200) resolve(socket);
      else {
        socket.destroy();
        reject(new Error(`\u4EE3\u7406 CONNECT \u5931\u8D25\uFF08HTTP ${res.statusCode}\uFF09`));
      }
    });
    req.once("timeout", () => req.destroy(new Error("\u4EE3\u7406\u8FDE\u63A5\u8D85\u65F6")));
    req.once("error", reject);
    req.end();
  });
}
async function nodeFetchOnce(url, init, proxy, timeoutMs, depth = 0) {
  const u = new URL(url);
  const isHttps = u.protocol === "https:";
  const targetPort = Number(u.port) || (isHttps ? 443 : 80);
  const method = (init.method ?? "GET").toUpperCase();
  const headers = { ...init.headers ?? {} };
  const hasBody = typeof init.body === "string";
  if (hasBody) headers["Content-Length"] = String(Buffer.byteLength(init.body));
  const tunnel = proxy ? await connectViaProxy(proxy, u.hostname, targetPort, timeoutMs) : void 0;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      tunnel?.destroy();
      reject(new Error("\u8BF7\u6C42\u8D85\u65F6"));
    }, timeoutMs);
    const opts = {
      hostname: u.hostname,
      port: targetPort,
      path: `${u.pathname}${u.search}`,
      method,
      headers,
      agent: false,
      servername: u.hostname
    };
    if (tunnel) {
      opts.createConnection = isHttps ? () => (0, import_node_tls.connect)({ socket: tunnel, servername: u.hostname }) : () => tunnel;
    }
    const sender = isHttps ? import_node_https.request : import_node_http.request;
    const req = sender(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        clearTimeout(timer);
        const status = res.statusCode ?? 0;
        const loc = res.headers.location;
        if ([301, 302, 303, 307, 308].includes(status) && loc && depth < 3) {
          nodeFetchOnce(new URL(loc, url).toString(), init, proxy, timeoutMs, depth + 1).then(resolve, reject);
          return;
        }
        resolve(
          new Response(Buffer.concat(chunks), {
            status,
            headers: res.headers
          })
        );
      });
    });
    req.on("timeout", () => req.destroy(new Error("\u8BF7\u6C42\u8D85\u65F6")));
    req.on("error", (err) => {
      clearTimeout(timer);
      tunnel?.destroy();
      reject(err);
    });
    if (init.signal) {
      if (init.signal.aborted) req.destroy(new Error("\u8BF7\u6C42\u5DF2\u53D6\u6D88"));
      else init.signal.addEventListener("abort", () => req.destroy(new Error("\u8BF7\u6C42\u5DF2\u53D6\u6D88")), { once: true });
    }
    if (hasBody) req.write(init.body);
    req.end();
  });
}
async function proxyFetch(url, init = {}) {
  const strategies = proxyCandidates();
  if (cachedProxy !== void 0) {
    try {
      return await nodeFetchOnce(url, init, cachedProxy, 3e4);
    } catch (err) {
      console.log("[figma:proxy] \u7F13\u5B58\u7B56\u7565\u5931\u6548:", String(err));
      cachedProxy = void 0;
    }
  }
  let lastErr;
  for (const proxy of strategies) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        if (attempt > 1) await new Promise((r) => setTimeout(r, 400));
        console.log(`[figma:proxy] \u5C1D\u8BD5:`, proxy ?? "\u76F4\u8FDE", attempt > 1 ? "(\u91CD\u8BD5)" : "");
        const res = await nodeFetchOnce(url, init, proxy, 3e4);
        console.log("[figma:proxy] \u6210\u529F:", proxy ?? "\u76F4\u8FDE");
        cachedProxy = proxy;
        return res;
      } catch (err) {
        console.log("[figma:proxy] \u5931\u8D25:", proxy ?? "\u76F4\u8FDE", String(err));
        lastErr = err;
      }
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(`${msg}\u3002${proxyChainHint()}`);
}
function parseFigmaUrl(url) {
  if (!url) return null;
  const m = url.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
  if (!m) return null;
  let nodeId = "";
  try {
    const raw = new URL(url).searchParams.get("node-id");
    if (raw) nodeId = raw.replace("-", ":");
  } catch {
  }
  return { fileKey: m[1], nodeId };
}
async function figmaApi(path, pat) {
  let res;
  try {
    res = await proxyFetch(`${FIGMA_API}${path}`, { headers: { "X-Figma-Token": pat } });
  } catch (err) {
    throw new Error(
      `\u65E0\u6CD5\u8FDE\u63A5 Figma API\uFF1A${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!res.ok) {
    let detail = "";
    try {
      const j = await res.json();
      const raw = j?.err || j?.message || "";
      if (raw) detail = `\uFF1A${raw.slice(0, 200)}`;
      else if (j?.status !== void 0) detail = `\uFF1A\u72B6\u6001\u7801 ${j.status}`;
    } catch {
    }
    if (res.status === 403) detail = detail || "\uFF1APAT \u65E0\u6548\u6216\u65E0\u8BE5\u6587\u4EF6\u8BBF\u95EE\u6743\u9650";
    else if (res.status === 404) detail = detail || "\uFF1A\u6587\u4EF6\u4E0D\u5B58\u5728\u6216 fileKey \u9519\u8BEF";
    else if (res.status === 429) detail = detail || "\uFF1A\u8BF7\u6C42\u8FC7\u4E8E\u9891\u7E41\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5";
    throw new Error(`Figma API \u8BF7\u6C42\u5931\u8D25\uFF08${res.status}\uFF09${detail}`);
  }
  return await res.json();
}
async function fetchFigmaFileMeta(fileKey, pat) {
  try {
    const meta = await figmaApi(
      `/files/${encodeURIComponent(fileKey)}?depth=0`,
      pat
    );
    const ts = meta.last_modified ? Date.parse(meta.last_modified) : NaN;
    return {
      ok: true,
      message: "",
      lastModified: Number.isNaN(ts) ? void 0 : ts,
      fileName: meta.name
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
var normType = (t) => {
  switch (t) {
    case "TEXT":
      return "text";
    case "GROUP":
      return "group";
    case "RECTANGLE":
      return "rect";
    case "ELLIPSE":
      return "ellipse";
    case "COMPONENT":
    case "COMPONENT_SET":
    case "INSTANCE":
      return "component";
    default:
      return "frame";
  }
};
var SKIPPED_TYPES = /* @__PURE__ */ new Set(["VECTOR", "LINE", "SLICE", "GUIDE", "BOOLEAN_OPERATION", "STAR", "REGULAR_POLYGON"]);
function firstSolidHex(paints) {
  const paint = paints?.find((p) => p.type === "SOLID" && p.visible !== false && p.color);
  return paint ? figmaColorToHex(paint.color, paint.opacity ?? 1) : null;
}
function effectsToCss(effects) {
  const shadows = (effects ?? []).filter((e) => e.type === "DROP_SHADOW" && e.visible !== false && e.color);
  if (!shadows.length) return void 0;
  return shadows.map((e) => {
    const { r, g, b } = e.color;
    const a = Math.round((e.color.a ?? 1) * 100) / 100;
    return `${Math.round(e.offset?.x ?? 0)}px ${Math.round(e.offset?.y ?? 0)}px ${Math.round(e.radius ?? 0)}px ${Math.round(e.spread ?? 0)}px rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${a})`;
  }).join(", ");
}
function walkNode(node, origin, depth, out, counter) {
  if (node.visible === false || SKIPPED_TYPES.has(node.type)) return null;
  const bbox = node.absoluteBoundingBox;
  if (!bbox) return null;
  const style = {
    id: node.id,
    name: node.name,
    type: normType(node.type),
    x: Math.round((bbox.x - origin.x) * 100) / 100,
    y: Math.round((bbox.y - origin.y) * 100) / 100,
    width: Math.round(bbox.width * 100) / 100,
    height: Math.round(bbox.height * 100) / 100,
    figmaNodeId: node.id
  };
  const fill = firstSolidHex(node.fills);
  if (fill) style.fill = fill;
  if (node.type === "TEXT") {
    style.textColor = fill ?? void 0;
    if (style.textColor) delete style.fill;
    style.text = (node.characters ?? "").slice(0, 200);
    const st = node.style;
    if (st?.fontSize) style.fontSize = st.fontSize;
    if (st?.fontWeight) style.fontWeight = st.fontWeight;
    if (st?.fontFamily) style.fontFamily = st.fontFamily;
    if (st?.lineHeightPx) style.lineHeight = Math.round(st.lineHeightPx * 100) / 100;
    if (st?.letterSpacing) style.letterSpacing = Math.round(st.letterSpacing * 100) / 100;
    if (st?.textAlignHorizontal && st.textAlignHorizontal !== "LEFT") style.textAlign = st.textAlignHorizontal.toLowerCase();
  }
  if (typeof node.cornerRadius === "number" && node.cornerRadius > 0) {
    style.borderRadius = [node.cornerRadius, node.cornerRadius, node.cornerRadius, node.cornerRadius];
  } else if (node.rectangleCornerRadii?.some((r) => r > 0)) {
    style.borderRadius = node.rectangleCornerRadii;
  }
  const stroke = firstSolidHex(node.strokes);
  if (stroke && (node.strokeWeight ?? 0) > 0) {
    style.borderWidth = Math.round(node.strokeWeight * 100) / 100;
    style.borderColor = stroke;
  }
  const shadow = effectsToCss(node.effects);
  if (shadow) style.boxShadow = shadow;
  if (node.layoutMode && node.layoutMode !== "NONE") {
    if (typeof node.itemSpacing === "number" && node.itemSpacing > 0) style.gap = node.itemSpacing;
    const pad = [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft];
    if (pad.some((v) => typeof v === "number" && v > 0)) {
      style.paddingTop = node.paddingTop || 0;
      style.paddingRight = node.paddingRight || 0;
      style.paddingBottom = node.paddingBottom || 0;
      style.paddingLeft = node.paddingLeft || 0;
    }
  }
  if (typeof node.opacity === "number" && node.opacity < 1) style.opacity = Math.round(node.opacity * 100) / 100;
  style.dominantColor = style.fill ?? style.textColor;
  if (style.width > 0 && style.height > 0) {
    style.aspectRatio = Math.round(style.width / style.height * 1e3) / 1e3;
  }
  out.push(style);
  if (out.length > MAX_NODES || depth >= MAX_DEPTH) {
    counter.skipped++;
    return style;
  }
  if (node.children?.length) {
    const children = [];
    for (const child of node.children) {
      const c = walkNode(child, origin, depth + 1, out, counter);
      if (c) children.push(c);
    }
    if (children.length) style.children = children;
  }
  return style;
}
async function fetchFrameScreenshot(pat, fileKey, nodeId, scale) {
  const j = await figmaApi(
    `/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=${scale}`,
    pat
  );
  const url = j.images?.[nodeId];
  if (!url) throw new Error("Figma \u622A\u56FE\u6E32\u67D3\u5931\u8D25\uFF1A\u8282\u70B9\u53EF\u80FD\u8FC7\u5927\u6216\u5305\u542B\u4E0D\u652F\u6301\u7684\u56FE\u5C42\u6570\u636E\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
  let imgRes;
  try {
    imgRes = await proxyFetch(url);
  } catch (err) {
    throw new Error(
      `Figma \u622A\u56FE\u4E0B\u8F7D\u5931\u8D25\uFF1A${err instanceof Error ? err.message : String(err)}`
    );
  }
  if (!imgRes.ok) throw new Error(`Figma \u622A\u56FE\u4E0B\u8F7D\u5931\u8D25\uFF08HTTP ${imgRes.status}\uFF09`);
  const buf = Buffer.from(await imgRes.arrayBuffer());
  if (buf.byteLength === 0) throw new Error("Figma \u622A\u56FE\u5185\u5BB9\u4E3A\u7A7A\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5");
  return `data:image/png;base64,${buf.toString("base64")}`;
}
async function fetchFigmaDesign(input) {
  const { pat, figmaUrl = "" } = input;
  if (!pat) return { ok: false, message: "\u672A\u914D\u7F6E Figma PAT\uFF1A\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 MCP \u7BA1\u7406\u300D\u4E2D\u586B\u5199\u5E26\u4EE4\u724C\u7684 MCP \u6761\u76EE" };
  const parsed = parseFigmaUrl(figmaUrl);
  if (!parsed) return { ok: false, message: "Figma \u94FE\u63A5\u65E0\u6CD5\u8BC6\u522B\uFF1A\u8BF7\u5728 Figma \u9009\u4E2D\u76EE\u6807 Frame \u540E\u53F3\u952E Copy link\uFF0C\u5E76\u786E\u4FDD\u94FE\u63A5\u5305\u542B node-id" };
  if (!parsed.nodeId) return { ok: false, message: "Figma \u94FE\u63A5\u7F3A\u5C11 node-id\uFF1A\u8BF7\u5728 Figma \u9009\u4E2D\u76EE\u6807 Frame \u540E\u91CD\u65B0 Copy link" };
  const { fileKey, nodeId } = parsed;
  const scale = input.scale ?? 2;
  try {
    const j = await figmaApi(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}`, pat);
    const entry = j.nodes?.[nodeId] ?? Object.values(j.nodes ?? {})[0];
    let doc = entry?.document;
    if (!doc) return { ok: false, message: "\u672A\u627E\u5230 node-id \u5BF9\u5E94\u7684\u56FE\u5C42\uFF1A\u8BF7\u786E\u8BA4\u94FE\u63A5\u53D6\u81EA\u5F53\u524D\u6587\u4EF6\u4E2D\u7684 Frame" };
    if (doc.type === "DOCUMENT" || doc.type === "PAGE") {
      const firstFrame = (doc.children ?? []).find((c) => c.visible !== false && c.absoluteBoundingBox);
      if (!firstFrame) return { ok: false, message: "\u8BE5\u9875\u9762\u4E0B\u6CA1\u6709\u53EF\u7528\u7684 Frame\uFF0C\u8BF7\u5728 Figma \u4E2D\u9009\u4E2D\u5177\u4F53 Frame \u540E Copy link" };
      doc = firstFrame;
    }
    const bbox = doc.absoluteBoundingBox;
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return { ok: false, message: "\u76EE\u6807\u56FE\u5C42\u6CA1\u6709\u6709\u6548\u5C3A\u5BF8\uFF0C\u8BF7\u9009\u62E9\u5E26\u5185\u5BB9\u7684 Frame" };
    }
    const nodes = [];
    const counter = { skipped: 0 };
    const root = walkNode(doc, { x: bbox.x, y: bbox.y }, 0, nodes, counter);
    if (!root) return { ok: false, message: "\u56FE\u5C42\u6811\u89E3\u6790\u5931\u8D25\uFF0C\u8BF7\u91CD\u8BD5\u6216\u66F4\u6362 Frame" };
    const screenshotDataUrl = await fetchFrameScreenshot(pat, fileKey, root.figmaNodeId, scale);
    return {
      ok: true,
      message: counter.skipped > 0 ? `\u8BBE\u8BA1\u7A3F\u8BFB\u53D6\u5B8C\u6210\uFF08\u8D85\u51FA\u4E0A\u9650\u8DF3\u8FC7 ${counter.skipped} \u4E2A\u56FE\u5C42\uFF09` : "\u8BBE\u8BA1\u7A3F\u8BFB\u53D6\u5B8C\u6210",
      data: {
        fileKey,
        nodeId: root.figmaNodeId,
        nodeName: root.name,
        root,
        nodes,
        screenshotDataUrl,
        frameSize: { width: root.width, height: root.height },
        scale,
        skippedCount: counter.skipped
      }
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
async function fetchFigmaNodeSize(input) {
  const { pat, figmaUrl = "" } = input;
  if (!pat) return { ok: false, message: "\u672A\u914D\u7F6E Figma PAT\uFF1A\u8BF7\u5728\u300C\u8BBE\u7F6E \u2192 MCP \u7BA1\u7406\u300D\u4E2D\u586B\u5199\u5E26\u4EE4\u724C\u7684 MCP \u6761\u76EE" };
  const parsed = parseFigmaUrl(figmaUrl);
  if (!parsed) return { ok: false, message: "Figma \u94FE\u63A5\u65E0\u6CD5\u8BC6\u522B\uFF1A\u8BF7\u5728 Figma \u9009\u4E2D\u76EE\u6807 Frame \u540E\u53F3\u952E Copy link" };
  if (!parsed.nodeId) return { ok: false, message: "Figma \u94FE\u63A5\u7F3A\u5C11 node-id\uFF1A\u8BF7\u91CD\u65B0 Copy link" };
  try {
    const j = await figmaApi(
      `/files/${parsed.fileKey}/nodes?ids=${encodeURIComponent(parsed.nodeId)}`,
      pat
    );
    const entry = j.nodes?.[parsed.nodeId] ?? Object.values(j.nodes ?? {})[0];
    let doc = entry?.document;
    if (!doc) return { ok: false, message: "\u672A\u627E\u5230 node-id \u5BF9\u5E94\u7684\u56FE\u5C42\uFF1A\u8BF7\u786E\u8BA4\u94FE\u63A5\u53D6\u81EA\u5F53\u524D\u6587\u4EF6\u4E2D\u7684 Frame" };
    if (doc.type === "DOCUMENT" || doc.type === "PAGE") {
      const firstFrame = (doc.children ?? []).find((c) => c.visible !== false && c.absoluteBoundingBox);
      if (!firstFrame) return { ok: false, message: "\u8BE5\u9875\u9762\u4E0B\u6CA1\u6709\u53EF\u7528\u7684 Frame\uFF0C\u8BF7\u9009\u4E2D\u5177\u4F53 Frame \u540E Copy link" };
      doc = firstFrame;
    }
    const bbox = doc.absoluteBoundingBox;
    if (!bbox || bbox.width <= 0 || bbox.height <= 0) {
      return { ok: false, message: "\u76EE\u6807\u56FE\u5C42\u6CA1\u6709\u6709\u6548\u5C3A\u5BF8\uFF0C\u8BF7\u9009\u62E9\u5E26\u5185\u5BB9\u7684 Frame" };
    }
    return {
      ok: true,
      message: "ok",
      width: Math.round(bbox.width),
      height: Math.round(bbox.height),
      nodeName: doc.name
    };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

// ../../src/shared/figmaUrl.ts
function extractFigmaFileKey(url) {
  const m = /figma\.com\/(?:file|design|proto|board)\/([A-Za-z0-9]{10,})/.exec(url.trim());
  return m ? m[1] : null;
}

// ../../src/shared/variablesImport.ts
function coerceTokenArray(input) {
  if (!input || typeof input !== "object") return [];
  const list = Array.isArray(input) ? input : Object.values(input);
  return list.filter((x) => !!x && typeof x === "object");
}
function rgbaToHex(c) {
  const to = (v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  const base = `#${to(c.r)}${to(c.g)}${to(c.b)}`.toUpperCase();
  return c.a !== void 0 && c.a < 1 ? `${base}${to(c.a)}`.toUpperCase() : base;
}
var round2 = (n) => Math.round(n * 100) / 100;
var FLOAT_KIND_RULES = [
  [/radius|corner|圆角/i, "radius"],
  [/line[-_ ]?height|行高/i, "lineHeight"],
  [/font[-_ ]?size|text[-_ ]?size|字号/i, "fontSize"],
  [/space|spacing|gap|padding|margin|inset|gutter|间距|间隔/i, "spacing"]
];
function floatKindByName(name, collectionName = "") {
  for (const [re, kind] of FLOAT_KIND_RULES) if (re.test(name)) return kind;
  for (const [re, kind] of FLOAT_KIND_RULES) if (re.test(collectionName)) return kind;
  return "spacing";
}
function expandFigmaVariables(variables, collections) {
  const varList = coerceTokenArray(variables);
  const varById = new Map(varList.map((v) => [v.id, v]));
  const colById = new Map(coerceTokenArray(collections).map((c) => [c.id, c]));
  const out = [];
  const pendingAliases = [];
  for (const v of varList) {
    const col = v.variableCollectionId ? colById.get(v.variableCollectionId) : void 0;
    const rawSegs = v.name.split("/").map((s) => s.trim()).filter(Boolean);
    if (!rawSegs.length) continue;
    const colName = col?.name?.trim() || "variables";
    const rawNameSeg = rawSegs[rawSegs.length - 1];
    const tier = TIER_RE.test(colName) ? colName : void 0;
    const rawPathSegs = [...tier ? [] : [colName], ...rawSegs.slice(0, -1)];
    const name = rawNameSeg;
    const path = rawPathSegs.length ? rawPathSegs.join("/") : colName;
    const modeNameOf = (modeId) => col?.modes?.find((m) => (m.id ?? m.modeId) === modeId)?.name ?? modeId;
    for (const [modeId, raw] of Object.entries(v.valuesByMode)) {
      if (raw === void 0 || raw === null) continue;
      if (typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
        const aliasId = raw.id;
        if (aliasId) pendingAliases.push({ v, modeId, aliasId });
        continue;
      }
      const cell = concreteCell(v, raw, colName);
      if (!cell) continue;
      out.push({
        kind: cell.kind,
        name,
        path,
        value: cell.value,
        source: "variable",
        description: v.description || void 0,
        tokenId: v.id,
        figmaName: v.name,
        mode: modeNameOf(modeId),
        tier,
        isDefaultMode: col?.defaultModeId ? modeId === col.defaultModeId : void 0,
        rawCode: v.codeSyntax?.WEB || v.codeSyntax?.iOS || v.codeSyntax?.ANDROID || void 0,
        type: TOKEN_KIND_TO_TYPE[cell.kind]
      });
    }
  }
  resolveRestAliases(pendingAliases, varById, colById, out);
  return out;
}
function concreteCell(v, raw, colName) {
  if (v.resolvedType === "COLOR" && typeof raw === "object") {
    const c = raw;
    if (c.r === void 0 || c.g === void 0 || c.b === void 0) return null;
    return { kind: "color", value: { kind: "color", hex: rgbaToHex(c) } };
  }
  if (v.resolvedType === "FLOAT" && typeof raw === "number") {
    const kind = floatKindByName(v.name, colName);
    return { kind, value: { kind, value: round2(raw), unit: "px" } };
  }
  return null;
}
function resolveRestAliases(pending, varById, colById, out) {
  for (const { v, modeId, aliasId } of pending) {
    const col = v.variableCollectionId ? colById.get(v.variableCollectionId) : void 0;
    const modeName = col?.modes?.find((m) => (m.id ?? m.modeId) === modeId)?.name ?? modeId;
    let cur = varById.get(aliasId);
    let cell = null;
    for (let hop = 0; cur && hop < 10; hop++) {
      const curCol = cur.variableCollectionId ? colById.get(cur.variableCollectionId) : void 0;
      const curColName = curCol?.name?.trim() || "variables";
      const curModeId = curCol?.modes?.find((m) => m.name === modeName && (m.id ?? m.modeId))?.id ?? curCol?.modes?.find((m) => m.name === modeName && (m.id ?? m.modeId))?.modeId ?? curCol?.defaultModeId ?? Object.keys(cur.valuesByMode)[0];
      const raw = cur.valuesByMode?.[curModeId];
      if (raw === void 0 || raw === null) break;
      if (typeof raw === "object" && raw.type === "VARIABLE_ALIAS") {
        const nextId = raw.id;
        if (!nextId) break;
        cur = varById.get(nextId);
        continue;
      }
      cell = concreteCell(cur, raw, curColName);
      break;
    }
    if (!cell || !cur) continue;
    const rawSegs = v.name.split("/").map((s) => s.trim()).filter(Boolean);
    if (!rawSegs.length) continue;
    const colName2 = col?.name?.trim() || "variables";
    const tier = TIER_RE.test(colName2) ? colName2 : void 0;
    const rawPathSegs = [...tier ? [] : [colName2], ...rawSegs.slice(0, -1)];
    out.push({
      kind: cell.kind,
      name: rawSegs[rawSegs.length - 1],
      path: rawPathSegs.length ? rawPathSegs.join("/") : colName2,
      value: cell.value,
      aliasRef: cur.name,
      source: "variable",
      description: v.description || void 0,
      tokenId: v.id,
      figmaName: v.name,
      mode: modeName,
      tier,
      isDefaultMode: col?.defaultModeId ? modeId === col.defaultModeId : void 0,
      rawCode: v.codeSyntax?.WEB || v.codeSyntax?.iOS || v.codeSyntax?.ANDROID || void 0,
      type: TOKEN_KIND_TO_TYPE[cell.kind]
    });
  }
}
var MODE_TOP_RE = /^(light|dark|light-mode|dark-mode|lightmode|darkmode|浅色|深色|亮色|暗色)$/i;
var TIER_RE = /^(primitives?|semantics?|components?|globals?|基础|语义|组件)$/i;
function parseOne(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error("JSON \u89E3\u6790\u5931\u8D25\uFF1A\u6587\u4EF6\u4E0D\u662F\u5408\u6CD5\u7684 JSON");
  }
  if (typeof data !== "object" || data === null) throw new Error("JSON \u5185\u5BB9\u4E3A\u7A7A\u6216\u683C\u5F0F\u4E0D\u6B63\u786E");
  const rest = data;
  const rawVars = rest.meta?.variables ?? rest.variables;
  if (rawVars && typeof rawVars === "object") {
    const varCount = (Array.isArray(rawVars) ? rawVars : Object.keys(rawVars)).length;
    if (varCount > 0) {
      const tokens = expandFigmaVariables(rawVars, rest.meta?.variableCollections ?? rest.variableCollections);
      if (tokens.length) return { tokens, pending: [] };
      throw new Error(
        `\u8BC6\u522B\u5230 ${varCount} \u4E2A Figma \u53D8\u91CF\uFF0C\u4F46\u672A\u89E3\u6790\u51FA\u53EF\u7528 Token\uFF1A\u53EF\u80FD\u5168\u90E8\u4E3A\u522B\u540D\u5F15\u7528\uFF08VARIABLE_ALIAS\uFF09\u6216\u5B57\u7B26\u4E32/\u5E03\u5C14\u7C7B\u578B\u53D8\u91CF`
      );
    }
  }
  const pending = [];
  return { tokens: parseDtcgTree(data, pending), pending };
}
function finishParsed(tokens, pending) {
  resolveAliasTokens(tokens, pending);
  if (!tokens.length) {
    throw new Error(
      "\u672A\u8BC6\u522B\u5230\u4EFB\u4F55 Token\uFF1A\u652F\u6301 Figma Variables \u5BFC\u51FA\u683C\u5F0F\uFF08meta.variables / variables \u952E\uFF09\u4E0E Tokens Studio / W3C DTCG \u5D4C\u5957\u683C\u5F0F\uFF08value/$value + type/$type\uFF09\uFF0C\u8BF7\u786E\u8BA4\u5BFC\u51FA\u7684 JSON \u6587\u4EF6\u5185\u5BB9"
    );
  }
  return tokens;
}
function parseVariablesJsonBundle(entries) {
  const tokens = [];
  const pending = [];
  for (const entry of entries) {
    const one = parseOne(entry.text);
    const fileName = (entry.name ?? "").replace(/\.json$/i, "").replace(/\.tokens$/i, "").trim();
    if (TIER_RE.test(fileName)) {
      const tier = fileName;
      for (const t of one.tokens) if (!t.tier) t.tier = tier;
      for (const p of one.pending) if (!p.tier) p.tier = tier;
    }
    tokens.push(...one.tokens);
    pending.push(...one.pending);
  }
  return finishParsed(tokens, pending);
}
function readDtcgLeaf(rec) {
  if (!("value" in rec || "$value" in rec)) return null;
  const desc = rec.$description ?? rec.description;
  const ext = rec.$extensions;
  return {
    value: rec.$value ?? rec.value,
    type: rec.$type ?? rec.type,
    description: typeof desc === "string" ? desc : void 0,
    tokenId: typeof ext?.["com.figma.variableId"] === "string" ? ext["com.figma.variableId"] : void 0
  };
}
function parseFigmaColorObject(v) {
  const alpha = typeof v.alpha === "number" ? v.alpha : 1;
  if (typeof v.hex === "string") {
    const base = parseColorStr(v.hex);
    if (!base) return null;
    if (alpha < 1) {
      const alphaHex = Math.round(alpha * 255).toString(16).padStart(2, "0").toUpperCase();
      return `#${base.slice(1, 7)}${alphaHex}`;
    }
    return base;
  }
  const comps = v.components;
  if (Array.isArray(comps) && comps.length >= 3 && comps.slice(0, 3).every((n) => typeof n === "number")) {
    return rgbaToHex({ r: comps[0], g: comps[1], b: comps[2], a: alpha });
  }
  return null;
}
function parseDtcgTree(root, pending) {
  const out = [];
  const hasModeSplit = Object.keys(root).some((k) => MODE_TOP_RE.test(k.trim())) || Object.entries(root).some(
    ([k, v]) => !k.startsWith("$") && TIER_RE.test(k.trim()) && typeof v === "object" && v !== null && Object.keys(v).some((kk) => MODE_TOP_RE.test(kk.trim()))
  );
  const walk = (node, segs, mode, tier) => {
    for (const [key, val] of Object.entries(node)) {
      if (key.startsWith("$")) continue;
      if (typeof val !== "object" || val === null) continue;
      const leaf = readDtcgLeaf(val);
      if (leaf) {
        emitDtcgLeaf(key, segs, mode, tier, leaf, out, pending);
      } else {
        const k = key.trim();
        const isModeTop = !mode && !tier && segs.length === 0 && hasModeSplit && MODE_TOP_RE.test(k);
        if (isModeTop) {
          walk(val, segs, k, tier);
          continue;
        }
        if (!tier && segs.length === 0 && TIER_RE.test(k)) {
          walk(val, segs, mode, k);
          continue;
        }
        walk(val, [...segs, key], mode, tier);
      }
    }
  };
  walk(root, [], void 0, void 0);
  return out;
}
function parsePxNum(v) {
  if (typeof v === "number") return Number.isFinite(v) ? v : void 0;
  if (typeof v === "string") {
    const m = v.trim().match(/^(-?\d*\.?\d+)\s*px$/i) ?? v.trim().match(/^(-?\d*\.?\d+)$/);
    return m ? parseFloat(m[1]) : void 0;
  }
  return void 0;
}
function isColorLike(v) {
  return /^#([0-9a-f]{3,8})$/i.test(v.trim()) || /^rgba?\(/i.test(v.trim());
}
function parseColorStr(v) {
  if (typeof v !== "string") return null;
  const s = v.trim();
  const hex = s.match(/^#([0-9a-f]{3,8})$/i);
  if (hex) {
    let h = hex[1];
    if (h.length === 3) h = [...h].map((c) => c + c).join("");
    if (h.length !== 6 && h.length !== 8) return null;
    return `#${h.toUpperCase()}`;
  }
  const rgb = s.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+%?))?\s*\)$/i);
  if (rgb) {
    const a = rgb[4] === void 0 ? 1 : rgb[4].endsWith("%") ? parseFloat(rgb[4]) / 100 : parseFloat(rgb[4]);
    return rgbaToHex({ r: parseFloat(rgb[1]) / 255, g: parseFloat(rgb[2]) / 255, b: parseFloat(rgb[3]) / 255, a });
  }
  return null;
}
function parseShadowLayers(v) {
  const arr = Array.isArray(v) ? v : [v];
  const layers = [];
  for (const item of arr) {
    if (typeof item !== "object" || item === null) return null;
    const o = item;
    const x = parsePxNum(o.offsetX ?? o.x);
    const y = parsePxNum(o.offsetY ?? o.y);
    const blur = parsePxNum(o.blur ?? o.radius);
    const spread = parsePxNum(o.spread);
    const color = parseColorStr(o.color);
    if (x === void 0 || y === void 0 || blur === void 0 || !color) return null;
    layers.push({ x: round2(x), y: round2(y), blur: round2(blur), spread: spread !== void 0 ? round2(spread) : void 0, color, inset: o.inset === true || void 0 });
  }
  return layers.length ? layers : null;
}
function parseBorderValue(v) {
  if (typeof v !== "object" || v === null) return null;
  const o = v;
  const width = parsePxNum(o.width);
  const color = parseColorStr(o.color);
  if (width === void 0 || !color) return null;
  return { width: round2(width), style: typeof o.style === "string" ? o.style : "solid", color };
}
function emitDtcgLeaf(key, segs, mode, tier, leaf, out, pending) {
  const trimmed = typeof leaf.value === "string" ? leaf.value.trim() : "";
  if (/^\{.+\}$/.test(trimmed)) {
    pending.push({ ref: trimmed.slice(1, -1), key, segs, mode, tier, leaf });
    return;
  }
  const v = leaf.value;
  const tn = leaf.type?.toLowerCase();
  const rawName = segs.length ? `${segs.join("/")}/${key}` : key;
  const name = key;
  const path = segs.join("/");
  const push = (suffix, kind2, value) => {
    out.push({
      kind: kind2,
      name: suffix ? `${name}.${suffix}` : name,
      path,
      value,
      source: "variable",
      description: leaf.description,
      tokenId: leaf.tokenId,
      figmaName: rawName,
      mode,
      tier,
      type: TOKEN_KIND_TO_TYPE[kind2]
    });
  };
  if (tn === "typography" && typeof v === "object" && v !== null) {
    const tv = v;
    const fs = parsePxNum(tv.fontSize);
    if (fs !== void 0) push("fontSize", "fontSize", { kind: "fontSize", value: round2(fs), unit: "px" });
    const lh = parsePxNum(tv.lineHeight);
    if (lh !== void 0 && (typeof tv.lineHeight === "string" || lh >= 8))
      push("lineHeight", "lineHeight", { kind: "lineHeight", value: round2(lh), unit: "px" });
    return;
  }
  if (tn === "boxshadow" || tn === "othershadow" || tn === "shadow") {
    const layers = parseShadowLayers(v);
    if (layers) push(null, "shadow", { kind: "shadow", layers });
    return;
  }
  if (tn === "border") {
    const b = parseBorderValue(v);
    if (b) push(null, "border", { kind: "border", ...b });
    return;
  }
  if (tn === "color" || !tn && typeof v === "string" && isColorLike(v)) {
    const hex = typeof v === "string" ? parseColorStr(v) : typeof v === "object" && v !== null ? parseFigmaColorObject(v) : null;
    if (hex) push(null, "color", { kind: "color", hex });
    return;
  }
  const n = parsePxNum(v);
  if (n === void 0 || n < 0) return;
  let kind;
  if (tn === "borderradius" || tn === "radius") kind = "radius";
  else if (tn === "fontsize" || tn === "fontsizes") kind = "fontSize";
  else if (tn === "lineheight" || tn === "lineheights") kind = "lineHeight";
  else kind = floatKindByName(key, segs[segs.length - 1] ?? "");
  push(null, kind, { kind, value: round2(n), unit: "px" });
}
function resolveAliasTokens(out, pending) {
  for (let round = 0; round < 10 && pending.length; round++) {
    const byFull = /* @__PURE__ */ new Map();
    const byName = /* @__PURE__ */ new Map();
    const addTo = (m, k, t) => {
      const list = m.get(k);
      if (list) list.push(t);
      else m.set(k, [t]);
    };
    for (const t of out) {
      addTo(byFull, `${t.path}/${t.name}`, t);
      if (t.tier) addTo(byFull, `${t.tier}/${t.path}/${t.name}`, t);
      addTo(byName, t.name, t);
    }
    const rest = [];
    let progressed = false;
    for (const p of pending) {
      const refSegs = p.ref.split(".").map((s) => s.trim()).filter(Boolean);
      const pick = (list) => list && list.length ? list.find((t) => t.mode === p.mode) ?? list[0] : void 0;
      const fullKeys = [];
      if (refSegs.length > 1 && MODE_TOP_RE.test(refSegs[0])) fullKeys.push(refSegs.slice(1).join("/"));
      fullKeys.push(refSegs.join("/"));
      let target;
      for (const k of fullKeys) {
        target = pick(byFull.get(k));
        if (target) break;
      }
      if (!target && refSegs.length) target = pick(byName.get(refSegs[refSegs.length - 1]));
      if (!target) {
        rest.push(p);
        continue;
      }
      out.push({
        kind: target.kind,
        name: p.key,
        path: p.segs.join("/"),
        value: target.value,
        aliasRef: p.ref,
        source: "variable",
        description: p.leaf.description,
        tokenId: p.leaf.tokenId,
        figmaName: p.segs.length ? `${p.segs.join("/")}/${p.key}` : p.key,
        mode: p.mode,
        tier: p.tier,
        type: target.type ?? TOKEN_KIND_TO_TYPE[target.kind]
      });
      progressed = true;
    }
    pending.length = 0;
    pending.push(...rest);
    if (!progressed) break;
  }
}

// ../../src/main/specSync.ts
async function parseVariables(fileKey, pat) {
  let lastErr;
  for (const endpoint of ["local", "published"]) {
    try {
      const res = await figmaApi(`/files/${fileKey}/variables/${endpoint}`, pat);
      const tokens = expandFigmaVariables(res.meta?.variables, res.meta?.variableCollections);
      if (tokens.length) return tokens;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;
  return [];
}
async function fetchAllStyleDocs(keys, pat) {
  const out = new Array(keys.length).fill(null);
  const BATCH = 6;
  for (let i = 0; i < keys.length; i += BATCH) {
    const slice = keys.slice(i, i + BATCH);
    const docs = await Promise.all(
      slice.map(async (k) => {
        try {
          const res = await figmaApi(`/styles/${k}`, pat);
          return res.meta?.document ?? null;
        } catch {
          return null;
        }
      })
    );
    docs.forEach((d, j) => out[i + j] = d);
  }
  return out;
}
async function parseStyles(fileKey, pat) {
  const res = await figmaApi(`/files/${fileKey}/styles`, pat);
  const metas = (res.meta?.styles ?? []).filter((s) => s.styleType !== "GRID");
  if (!metas.length) return [];
  const docs = await fetchAllStyleDocs(
    metas.map((s) => s.key),
    pat
  );
  const out = [];
  metas.forEach((meta, i) => {
    const doc = docs[i];
    if (!doc) return;
    const solid = doc.fills?.find((f) => f.visible !== false && f.type === "SOLID" && f.color);
    if (solid?.color) {
      out.push({
        kind: "color",
        name: meta.name,
        path: meta.name,
        value: { kind: "color", hex: rgbaToHex(solid.color) },
        source: "style",
        description: meta.description || void 0
      });
    }
    const ts = doc.style;
    if (ts?.fontSize && ts.fontSize > 0) {
      out.push({
        kind: "fontSize",
        name: `${meta.name}/fontSize`,
        path: `${meta.name}/fontSize`,
        value: { kind: "fontSize", value: round2(ts.fontSize), unit: "px" },
        source: "style",
        description: meta.description || void 0
      });
    }
    if (ts?.lineHeightPx && ts.lineHeightPx > 0) {
      out.push({
        kind: "lineHeight",
        name: `${meta.name}/lineHeight`,
        path: `${meta.name}/lineHeight`,
        value: { kind: "lineHeight", value: round2(ts.lineHeightPx), unit: "px" },
        source: "style"
      });
    }
    const layers = (doc.effects ?? []).filter((e) => e.visible !== false && e.type !== "LAYER_BLUR" && e.color).map((e) => ({
      x: round2(e.offset?.x ?? 0),
      y: round2(e.offset?.y ?? 0),
      blur: round2(e.radius ?? 0),
      spread: e.spread !== void 0 ? round2(e.spread) : void 0,
      color: rgbaToHex(e.color),
      inset: e.type === "INNER_SHADOW" || void 0
    }));
    if (layers.length) {
      out.push({
        kind: "shadow",
        name: meta.name,
        path: meta.name,
        value: { kind: "shadow", layers },
        source: "style",
        description: meta.description || void 0
      });
    }
  });
  return out;
}
function collectHeuristics(root) {
  const stats = /* @__PURE__ */ new Map();
  const bump = (key, kind, value) => {
    const hit = stats.get(key);
    if (hit) hit.count += 1;
    else stats.set(key, { count: 1, kind, value });
  };
  const visit = (node) => {
    if (node.visible === false) return;
    const solid = node.fills?.find((f) => f.visible !== false && f.type === "SOLID" && f.color);
    if (solid?.color) bump(`color:${rgbaToHex(solid.color)}`, "color", { kind: "color", hex: rgbaToHex(solid.color) });
    const radii = node.rectangleCornerRadii ?? (node.cornerRadius !== void 0 ? [node.cornerRadius] : []);
    const uniq = [...new Set(radii.filter((r) => r > 0))];
    if (uniq.length === 1)
      bump(`radius:${uniq[0]}`, "radius", { kind: "radius", value: round2(uniq[0]), unit: "px" });
    if (node.itemSpacing && node.itemSpacing > 0)
      bump(`spacing:${node.itemSpacing}`, "spacing", {
        kind: "spacing",
        value: round2(node.itemSpacing),
        unit: "px"
      });
    if (node.style?.fontSize && node.style.fontSize > 0)
      bump(`fontSize:${node.style.fontSize}`, "fontSize", {
        kind: "fontSize",
        value: round2(node.style.fontSize),
        unit: "px"
      });
    if (node.style?.lineHeightPx && node.style.lineHeightPx > 0)
      bump(`lineHeight:${node.style.lineHeightPx}`, "lineHeight", {
        kind: "lineHeight",
        value: round2(node.style.lineHeightPx),
        unit: "px"
      });
    const layers = (node.effects ?? []).filter((e) => e.visible !== false && e.color);
    if (layers.length)
      bump(
        `shadow:${layers.map((e) => `${e.offset?.x ?? 0},${e.offset?.y ?? 0},${e.radius ?? 0},${rgbaToHex(e.color)}`).join("|")}`,
        "shadow",
        {
          kind: "shadow",
          layers: layers.map((e) => ({
            x: round2(e.offset?.x ?? 0),
            y: round2(e.offset?.y ?? 0),
            blur: round2(e.radius ?? 0),
            spread: e.spread !== void 0 ? round2(e.spread) : void 0,
            color: rgbaToHex(e.color),
            inset: e.type === "INNER_SHADOW" || void 0
          }))
        }
      );
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);
  return stats;
}
var HEURISTIC_TOP_N = 40;
function parseHeuristic(fileKey, pat) {
  return figmaApi(`/files/${fileKey}?depth=4`, pat).then((res) => {
    const tokens = [];
    if (!res.document) return { fileName: res.name ?? "", tokens };
    const byKind = /* @__PURE__ */ new Map();
    for (const entry of collectHeuristics(res.document).values()) {
      const list = byKind.get(entry.kind) ?? [];
      list.push(entry);
      byKind.set(entry.kind, list);
    }
    for (const [kind, list] of byKind) {
      list.sort((a, b) => b.count - a.count);
      for (const { value } of list.slice(0, HEURISTIC_TOP_N)) {
        const label = value.kind === "color" ? value.hex : value.kind === "shadow" ? `shadow-${tokens.filter((t) => t.kind === "shadow").length + 1}` : value.kind === "border" ? `${value.width}px ${value.style}` : `${value.value}px`;
        tokens.push({
          kind,
          name: `${kind}/${label}`,
          path: `heuristic/${kind}`,
          value,
          source: "heuristic"
        });
      }
    }
    return { fileName: res.name ?? "", tokens };
  });
}
async function fetchFileName(fileKey, pat) {
  try {
    const res = await figmaApi(`/files/${fileKey}?depth=1`, pat);
    return res.name ?? "";
  } catch {
    return "";
  }
}
async function syncSpecTokens(input) {
  const pat = (input.pat ?? "").trim();
  if (!pat) throw new Error("\u672A\u914D\u7F6E Figma Personal Access Token\uFF0C\u8BF7\u5148\u5728\u300C\u8BBE\u7F6E \u2192 MCP \u7BA1\u7406\u300D\u4E2D\u586B\u5199");
  const fileKey = extractFigmaFileKey(input.figmaUrl ?? "");
  if (!fileKey) throw new Error("Figma \u89C4\u8303\u94FE\u63A5\u683C\u5F0F\u4E0D\u6B63\u786E");
  const allLevels = [
    { level: "variable", run: () => parseVariables(fileKey, pat) },
    { level: "style", run: () => parseStyles(fileKey, pat) },
    {
      level: "heuristic",
      run: async () => (await parseHeuristic(fileKey, pat)).tokens
    }
  ];
  const order = allLevels.map((l) => l.level);
  const startIdx = order.indexOf(input.startLevel ?? "variable");
  const levels = allLevels.slice(Math.max(0, startIdx));
  const degraded = [];
  let lastErr;
  for (const { level, run } of levels) {
    try {
      const tokens = await run();
      if (tokens.length) {
        return {
          ok: true,
          message: "",
          fileName: await fetchFileName(fileKey, pat),
          sourceLevel: level,
          tokens,
          degraded
        };
      }
      lastErr = new Error(`\u8BE5\u7EA7\u522B\u65E0\u53EF\u7528\u6570\u636E\uFF1A${level}`);
    } catch (err) {
      lastErr = err;
      const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
      if (level === "variable" && /403|file_variables/i.test(msg)) {
        return {
          ok: false,
          message: msg,
          variableDenied: true,
          degraded: [
            {
              level,
              reason: msg,
              hint: "Figma \u53D8\u91CF API \u4EC5\u5BF9 Enterprise \u5957\u9910\u5F00\u653E\uFF08file_variables:read \u4E3A Enterprise \u4E13\u5C5E\u6743\u9650\uFF09\uFF0C\u65E0\u6CD5\u5BFC\u5165\u81EA\u5EFA Token\uFF08\u53D8\u91CF\uFF09"
            }
          ]
        };
      }
    }
    degraded.push({
      level,
      reason: lastErr instanceof Error ? lastErr.message : String(lastErr),
      // 变量级 403 = PAT 缺 file_variables:read；该 scope 为 Figma Enterprise 套餐专属，普通套餐生成令牌时无此选项，重新生成也无法勾选
      hint: level === "variable" ? /403|file_variables/i.test(lastErr instanceof Error ? lastErr.message : String(lastErr)) ? "Figma \u53D8\u91CF API \u4EC5\u5BF9 Enterprise \u5957\u9910\u5F00\u653E\uFF08file_variables:read \u4E3A Enterprise \u4E13\u5C5E\u6743\u9650\uFF09\u3002\u5EFA\u8BAE\u6539\u7528\u53D8\u91CF\u5BFC\u51FA\u63D2\u4EF6\u751F\u6210 JSON \u540E\u5728\u300C\u5BFC\u5165 JSON\u300D\u4E2D\u5BFC\u5165\uFF08\u652F\u6301\u4E09\u5C42 Token \u4F53\u7CFB\u4E0E\u522B\u540D\u89E3\u6790\uFF09\uFF1B\u5982\u4E3A Enterprise \u5957\u9910\uFF0C\u8BF7\u786E\u8BA4\u4EE4\u724C\u5DF2\u52FE\u9009\u300C\u8BFB\u53D6\u53D8\u91CF\u300D\u6743\u9650\u540E\u91CD\u8BD5" : "\u5F53\u524D\u6587\u4EF6\u672A\u8BFB\u53D6\u5230 Figma \u53D8\u91CF\uFF08\u53EF\u80FD\u53D8\u91CF\u90FD\u6765\u81EA\u7EC4\u4EF6\u5E93\u6216\u672A\u5B9A\u4E49\u672C\u5730\u53D8\u91CF\uFF09\uFF0C\u5DF2\u964D\u7EA7\u4E3A\u6837\u5F0F\u89E3\u6790\uFF1B\u5EFA\u8BAE\u5728\u53D8\u91CF\u5E93\u6587\u4EF6\u4E0A\u540C\u6B65\uFF0C\u6216\u7528 Figma Variables \u63D2\u4EF6\u5BFC\u51FA JSON \u540E\u5BFC\u5165" : void 0
    });
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

// ../../src/shared/tokenExport.ts
function valueText(v) {
  if (v.kind === "color") return v.hex;
  if (v.kind === "shadow")
    return v.layers.map((l) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`).join(", ");
  if (v.kind === "border") return `${v.width}px ${v.style} ${v.color}`;
  return `${v.value}px`;
}
function toKebab(seg) {
  return seg.replace(/([a-z0-9])([A-Z])/g, "$1-$2").replace(/[\s_.]+/g, "-").toLowerCase();
}
function toCamel(seg) {
  const words = seg.split(/[^A-Za-z0-9]+/).filter(Boolean);
  if (!words.length) return "x";
  return words[0].toLowerCase() + words.slice(1).map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join("");
}
function dtcgLeaf(t) {
  const v = t.value;
  if (v.kind === "color") return { $value: v.hex, $type: "color", $name: t.name };
  if (v.kind === "shadow") {
    const layer = (l) => ({
      color: l.color,
      offsetX: `${l.x}px`,
      offsetY: `${l.y}px`,
      blur: `${l.blur}px`,
      spread: `${l.spread ?? 0}px`,
      inset: Boolean(l.inset)
    });
    return {
      $value: v.layers.length === 1 ? layer(v.layers[0]) : v.layers.map(layer),
      $type: "shadow",
      $name: t.name
    };
  }
  if (v.kind === "border")
    return { $value: { color: v.color, width: `${v.width}px`, style: v.style }, $type: "border", $name: t.name };
  return { $value: `${v.value}px`, $type: "dimension", $name: t.name };
}
function buildDtcgTree(tokens) {
  const root = {};
  for (const t of tokens) {
    const segs = t.path.split("/").filter(Boolean);
    if (!segs.length) continue;
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = segs[i];
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[segs[segs.length - 1]] = dtcgLeaf(t);
  }
  return root;
}
function exportCss(tokens) {
  const seen = /* @__PURE__ */ new Map();
  for (const t of tokens) {
    const varName = `--${t.path.split("/").filter(Boolean).map(toKebab).join("-")}`;
    seen.set(varName, valueText(t.value));
  }
  const lines = [...seen.entries()].map(([k, v]) => `  ${k}: ${v};`);
  return `:root {
${lines.join("\n")}
}
`;
}
var TW_GROUP = {
  color: "colors",
  spacing: "spacing",
  fontSize: "fontSize",
  lineHeight: "lineHeight",
  radius: "borderRadius",
  shadow: "boxShadow",
  border: "borderWidth"
};
function twValue(t) {
  const v = t.value;
  if (v.kind === "color") return v.hex;
  if (v.kind === "shadow")
    return v.layers.map(
      (l) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`
    );
  if (v.kind === "border") return `${v.width}px`;
  return `${v.value}px`;
}
function buildTwTree(tokens) {
  const groups = {};
  for (const t of tokens) {
    const segs = t.path.split("/").filter(Boolean);
    if (!segs.length) continue;
    const group = groups[TW_GROUP[t.kind]] ??= {};
    let node = group;
    for (let i = 0; i < segs.length - 1; i++) {
      const k = toCamel(segs[i]);
      if (typeof node[k] !== "object" || node[k] === null) node[k] = {};
      node = node[k];
    }
    node[toCamel(segs[segs.length - 1])] = twValue(t);
  }
  return groups;
}
function serTw(obj, depth) {
  const padIn = "  ".repeat(depth + 1);
  return Object.entries(obj).map(([k, v]) => {
    if (typeof v === "string") return `${padIn}'${k}': '${v}'`;
    if (Array.isArray(v)) return `${padIn}'${k}': [${v.map((s) => `'${s}'`).join(", ")}]`;
    return `${padIn}'${k}': {
${serTw(v, depth + 1)}
${padIn}}`;
  }).join(",\n");
}
function exportTailwind(tokens) {
  const extend = buildTwTree(tokens);
  return `/** Generated by UI \u8D70\u67E5\u5DE5\u5177\uFF08\u8BBE\u8BA1\u89C4\u8303\u5BFC\u51FA\uFF09\uFF0C\u53EF\u5408\u5E76\u8FDB tailwind.config.js */
module.exports = {
  theme: {
    extend: {
${serTw(extend, 2)}
    }
  }
}
`;
}
function exportJson(tokens) {
  return `${JSON.stringify(buildDtcgTree(tokens), null, 2)}
`;
}
function exportTokens(tokens, fmt) {
  if (fmt === "css") return exportCss(tokens);
  if (fmt === "tailwind") return exportTailwind(tokens);
  return exportJson(tokens);
}

// ../../src/renderer/src/spec/specCheck.ts
var MAX_PER_KEY = 3;
var MAX_VIOLATIONS = 400;
function colorDiffE(a, b) {
  const ca = parseColor(a);
  const cb = parseColor(b);
  if (!ca || !cb || ca.a < 0.05 || cb.a < 0.05) return null;
  return deltaE2000(rgbToLab(ca), rgbToLab(cb));
}
function nearestColor(tokens, actual) {
  let best = null;
  for (const t of tokens) {
    if (t.value.kind !== "color") continue;
    const dE = colorDiffE(actual, t.value.hex);
    if (dE === null) continue;
    if (!best || dE < best.dE) best = { token: t, dE };
  }
  return best;
}
function nearestFloat(tokens, kind, actual) {
  let best = null;
  for (const t of tokens) {
    if (t.kind !== kind || t.value.kind !== kind) continue;
    const delta = Math.abs(t.value.value - actual);
    if (!best || delta < best.delta) best = { token: t, delta };
  }
  return best;
}
function parseBoxShadow(raw) {
  if (!raw || raw === "none") return null;
  const re = /(inset\s+)?((?:rgba?\([^)]*\))|(?:#[0-9a-fA-F]{3,8})|(?:[a-z]+))\s+(-?[\d.]+)px\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+(-?[\d.]+)px)?\s*(inset)?/g;
  const layers = [];
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (!parseColor(m[2])) return null;
    layers.push({
      x: parseFloat(m[3]),
      y: parseFloat(m[4]),
      blur: parseFloat(m[5]),
      spread: m[6] !== void 0 ? parseFloat(m[6]) : 0,
      color: m[2],
      inset: Boolean(m[1] || m[7])
    });
  }
  return layers.length ? layers : null;
}
function floatLabel(t) {
  return t.value.kind === "spacing" || t.value.kind === "fontSize" || t.value.kind === "lineHeight" || t.value.kind === "radius" ? `${t.value.value}px` : "";
}
function shadowLabel(t) {
  if (t.value.kind !== "shadow") return "";
  return t.value.layers.map((l) => `${l.inset ? "inset " : ""}${l.x}px ${l.y}px ${l.blur}px ${l.spread ?? 0}px ${l.color}`).join(", ");
}
var severityOf = (delta, tol) => delta <= tol * 2 ? "minor" : "major";
function checkSpec(root, tokens, viewport, tol) {
  const out = [];
  const keyCount = /* @__PURE__ */ new Map();
  const vw = viewport.width || 1;
  const vh = viewport.height || 1;
  const has = (kind) => tokens.some((t) => t.kind === kind);
  const push = (v, key) => {
    const n = keyCount.get(key) ?? 0;
    if (n >= MAX_PER_KEY) return;
    if (out.length >= MAX_VIOLATIONS) return;
    keyCount.set(key, n + 1);
    out.push({
      ...v,
      rect: { x: v.node.x / vw, y: v.node.y / vh, width: v.node.width / vw, height: v.node.height / vh }
    });
  };
  const colorCheck = (node, actual, property, propKey) => {
    if (!actual || !has("color")) return;
    const near = nearestColor(tokens, actual);
    if (!near || near.dE <= tol.color) return;
    push(
      {
        node,
        category: "color",
        property,
        propKey,
        actualText: actual,
        tokenName: near.token.name,
        expectedText: near.token.value.kind === "color" ? near.token.value.hex : "",
        deltaKind: "deltaE",
        deltaValue: near.dE,
        severity: severityOf(near.dE, tol.color)
      },
      `${property}|${actual}|${near.token.name}`
    );
  };
  const floatCheck = (node, actual, property, propKey, kind, tolPx, category) => {
    if (actual === void 0 || actual <= 0 || !has(kind)) return;
    const near = nearestFloat(tokens, kind, actual);
    if (!near || near.delta <= tolPx) return;
    push(
      {
        node,
        category,
        property,
        propKey,
        actualText: `${actual}px`,
        tokenName: near.token.name,
        expectedText: floatLabel(near.token),
        deltaKind: "px",
        deltaValue: near.delta,
        severity: severityOf(near.delta, tolPx)
      },
      `${property}|${actual}|${near.token.name}`
    );
  };
  const visit = (node) => {
    if (node.width > 0 && node.height > 0) {
      colorCheck(node, node.fill, "background", "bgColor");
      colorCheck(node, node.textColor, "text-color", "textColor");
      floatCheck(node, node.gap, "gap", "gap", "spacing", tol.spacing, "spacing");
      floatCheck(node, node.paddingTop, "padding-top", "padding", "spacing", tol.spacing, "spacing");
      floatCheck(node, node.paddingRight, "padding-right", "padding", "spacing", tol.spacing, "spacing");
      floatCheck(node, node.paddingBottom, "padding-bottom", "padding", "spacing", tol.spacing, "spacing");
      floatCheck(node, node.paddingLeft, "padding-left", "padding", "spacing", tol.spacing, "spacing");
      floatCheck(node, node.fontSize, "font-size", "fontSize", "fontSize", tol.typography, "typography");
      floatCheck(node, node.lineHeight, "line-height", "lineHeight", "lineHeight", tol.typography, "typography");
      const radii = [...new Set((node.borderRadius ?? []).filter((r) => r > 0))];
      if (radii.length && has("radius")) {
        let worst = null;
        for (const r of radii) {
          const near = nearestFloat(tokens, "radius", r);
          if (near && (!worst || near.delta > worst.delta)) worst = near;
        }
        if (worst && worst.delta > tol.radius) {
          push(
            {
              node,
              category: "style",
              property: "border-radius",
              propKey: "radius",
              actualText: radii.map((r) => `${r}px`).join(", "),
              tokenName: worst.token.name,
              expectedText: floatLabel(worst.token),
              deltaKind: "px",
              deltaValue: worst.delta,
              severity: severityOf(worst.delta, tol.radius)
            },
            `border-radius|${radii.join(",")}|${worst.token.name}`
          );
        }
      }
      if (node.boxShadow && has("shadow")) {
        const dom = parseBoxShadow(node.boxShadow);
        const shadowToks = tokens.filter((t) => t.kind === "shadow" && t.value.kind === "shadow");
        if (dom && shadowToks.length) {
          const tolD = Math.max(2, tol.border);
          const matched = shadowToks.find((t) => {
            if (t.value.kind !== "shadow") return false;
            if (t.value.layers.length !== dom.length) return false;
            return t.value.layers.every(
              (l) => dom.some(
                (d) => d.inset === Boolean(l.inset) && Math.abs(d.x - l.x) <= tolD && Math.abs(d.y - l.y) <= tolD && Math.abs(d.blur - l.blur) <= tolD && Math.abs(d.spread - (l.spread ?? 0)) <= tolD && (colorDiffE(d.color, l.color) ?? Infinity) <= tol.color * 2
              )
            );
          });
          if (!matched) {
            const rep = shadowToks[0];
            push(
              {
                node,
                category: "style",
                property: "box-shadow",
                propKey: "shadow",
                actualText: node.boxShadow,
                tokenName: rep.name,
                expectedText: shadowLabel(rep),
                severity: "minor"
              },
              `box-shadow|${node.boxShadow}`
            );
          }
        }
      }
      if ((node.borderWidth ?? 0) > 0 && has("border")) {
        const borderToks = tokens.filter((t) => t.kind === "border" && t.value.kind === "border");
        const matched = borderToks.find((t) => {
          if (t.value.kind !== "border") return false;
          if (Math.abs(t.value.width - (node.borderWidth ?? 0)) > tol.border) return false;
          return (colorDiffE(node.borderColor, t.value.color) ?? Infinity) <= tol.color;
        });
        if (!matched && borderToks.length) {
          const rep = borderToks.reduce(
            (a, b) => Math.abs(b.value.width - (node.borderWidth ?? 0)) < Math.abs(a.value.width - (node.borderWidth ?? 0)) ? b : a
          );
          const bv = rep.value;
          push(
            {
              node,
              category: "style",
              property: "border",
              propKey: "border",
              actualText: `${node.borderWidth}px ${node.borderColor ?? ""}`.trim(),
              tokenName: rep.name,
              expectedText: `${bv.width}px ${bv.style} ${bv.color}`,
              severity: "minor"
            },
            `border|${node.borderWidth}|${node.borderColor ?? ""}`
          );
        }
      }
    }
    for (const c of node.children ?? []) visit(c);
  };
  visit(root);
  return out;
}

// ../../src/renderer/src/spec/elementCheck.ts
var MAX_FINDINGS = 30;
var textKey = (t) => t.replace(/\s+/g, "").toLowerCase();
function textSimilar(a, b) {
  const ka = textKey(a);
  const kb = textKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  if (ka.includes(kb) || kb.includes(ka)) return true;
  const short = ka.length <= kb.length ? ka : kb;
  const long = ka.length <= kb.length ? kb : ka;
  if (short.length < 2) return false;
  let hit = 0;
  for (const ch of short) if (long.includes(ch)) hit++;
  return hit / short.length >= 0.5 && Math.abs(ka.length - kb.length) <= Math.max(4, short.length);
}
function flatten2(root) {
  const out = [];
  const visit = (n) => {
    out.push(n);
    for (const c of n.children ?? []) visit(c);
  };
  visit(root);
  return out;
}
function checkElements(designRoot, domRoot, frameSize, viewport) {
  const out = [];
  const fw = frameSize.width || 1;
  const fh = frameSize.height || 1;
  const vw = viewport.width || 1;
  const vh = viewport.height || 1;
  const toViewport = (n) => ({
    cx: (n.x + n.width / 2) / fw * vw,
    cy: (n.y + n.height / 2) / fh * vh
  });
  const domNodes = flatten2(domRoot);
  for (const node of domNodes) {
    if (node.imgBroken !== true) continue;
    if (out.length >= MAX_FINDINGS) break;
    out.push({
      kind: "img-broken",
      category: "missing-component",
      severity: "major",
      targetImage: "screenshot",
      rect: { x: node.x / vw, y: node.y / vh, width: node.width / vw, height: node.height / vh },
      node,
      domPath: node.domPath
    });
  }
  const domTextNodes = domNodes.filter((n) => n.type === "text" && n.text);
  const domTextMap = /* @__PURE__ */ new Map();
  for (const n of domTextNodes) {
    const key = textKey(n.text);
    const list = domTextMap.get(key);
    if (list) list.push(n);
    else domTextMap.set(key, [n]);
  }
  const nearestDomText = (dn) => {
    const { cx, cy } = toViewport(dn);
    let best = null;
    for (const n of domTextNodes) {
      const dx = n.x + n.width / 2 - cx;
      const dy = n.y + n.height / 2 - cy;
      const dist = Math.hypot(dx, dy);
      const tol = Math.max(40, dn.height / fh * vh);
      if (dist > tol) continue;
      if (!best || dist < best.dist) best = { node: n, dist };
    }
    return best;
  };
  const visitDesign = (n) => {
    if (out.length < MAX_FINDINGS && n.type === "text" && n.text && n.text.trim()) {
      const key = textKey(n.text);
      const exact = domTextMap.get(key);
      if (exact?.length) {
        exact.shift();
      } else {
        const near = nearestDomText(n);
        if (!near) {
          out.push({
            kind: "element-missing",
            category: "missing-component",
            severity: "major",
            targetImage: "design",
            rect: { x: n.x / fw, y: n.y / fh, width: n.width / fw, height: n.height / fh },
            designNode: n,
            designText: n.text
          });
        } else if (!textSimilar(n.text, near.node.text)) {
          out.push({
            kind: "text-mismatch",
            category: "typography",
            severity: "suggestion",
            targetImage: "screenshot",
            rect: {
              x: near.node.x / vw,
              y: near.node.y / vh,
              width: near.node.width / vw,
              height: near.node.height / vh
            },
            node: near.node,
            designNode: n,
            designText: n.text,
            domText: near.node.text,
            domPath: near.node.domPath
          });
        }
      }
    }
    for (const c of n.children ?? []) visitDesign(c);
  };
  visitDesign(designRoot);
  return out;
}

// ../../src/renderer/src/spec/a11yCheck.ts
var MAX_PER_KIND = 5;
var MAX_FINDINGS2 = 40;
function luminance({ r, g, b }) {
  const ch = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(r) + 0.7152 * ch(g) + 0.0722 * ch(b);
}
function contrastRatio(fg, bg) {
  const cf = parseColor(fg);
  const cb = parseColor(bg);
  if (!cf || !cb) return null;
  const lf = luminance(cf);
  const lb = luminance(cb);
  const [hi, lo] = lf >= lb ? [lf, lb] : [lb, lf];
  return (hi + 0.05) / (lo + 0.05);
}
function isClickable(name) {
  const tag = name.split(/[.#]/)[0]?.toLowerCase() ?? "";
  return tag === "button" || tag === "a" || tag === "input" || tag === "select" || tag === "textarea";
}
function isFormField(name) {
  const tag = name.split(/[.#]/)[0]?.toLowerCase() ?? "";
  return tag === "input" || tag === "textarea" || tag === "select";
}
function checkA11y(domRoot, viewport) {
  const out = [];
  const kindCount = /* @__PURE__ */ new Map();
  const vw = viewport.width || 1;
  const vh = viewport.height || 1;
  const visit = (n) => {
    if (out.length < MAX_FINDINGS2 && n.width > 0 && n.height > 0) {
      const tag = n.name.split(/[.#]/)[0]?.toLowerCase() ?? "";
      if (tag === "img" && n.alt === void 0) {
        const c = kindCount.get("img-alt-missing") ?? 0;
        if (c < MAX_PER_KIND) {
          kindCount.set("img-alt-missing", c + 1);
          out.push({
            kind: "img-alt-missing",
            category: "missing-component",
            severity: "suggestion",
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath
          });
        }
      }
      if (n.text && n.textColor && n.effectiveBg) {
        const ratio = contrastRatio(n.textColor, n.effectiveBg);
        if (ratio !== null) {
          const isLarge = (n.fontSize ?? 0) >= 24 || (n.fontSize ?? 0) >= 18.66 && (n.fontWeight ?? 400) >= 700;
          const min = isLarge ? 3 : 4.5;
          if (ratio < min) {
            const c = kindCount.get("contrast-low") ?? 0;
            if (c < MAX_PER_KIND) {
              kindCount.set("contrast-low", c + 1);
              out.push({
                kind: "contrast-low",
                category: "color",
                severity: "minor",
                rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
                node: n,
                domPath: n.domPath,
                actualText: `${(Math.round(ratio * 100) / 100).toFixed(2)}:1`,
                expectedText: `${min}:1`
              });
            }
          }
        }
      }
      if (n.text && n.fontSize !== void 0 && n.fontSize < 12) {
        const c = kindCount.get("font-too-small") ?? 0;
        if (c < MAX_PER_KIND) {
          kindCount.set("font-too-small", c + 1);
          out.push({
            kind: "font-too-small",
            category: "typography",
            severity: "suggestion",
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath,
            actualText: `${n.fontSize}px`,
            expectedText: "\u226512px"
          });
        }
      }
      if (isClickable(n.name) && n.width < 24 && n.height < 24) {
        const c = kindCount.get("tap-target-small") ?? 0;
        if (c < MAX_PER_KIND) {
          kindCount.set("tap-target-small", c + 1);
          out.push({
            kind: "tap-target-small",
            category: "interaction",
            severity: "suggestion",
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath,
            actualText: `${Math.round(n.width)}\xD7${Math.round(n.height)}`,
            expectedText: "\u226524\xD724"
          });
        }
      }
      if (isFormField(n.name) && n.ariaLabel === void 0 && n.ariaLabelledby === void 0 && n.placeholder === void 0) {
        const c = kindCount.get("input-no-label") ?? 0;
        if (c < MAX_PER_KIND) {
          kindCount.set("input-no-label", c + 1);
          out.push({
            kind: "input-no-label",
            category: "interaction",
            severity: "suggestion",
            rect: { x: n.x / vw, y: n.y / vh, width: n.width / vw, height: n.height / vh },
            node: n,
            domPath: n.domPath
          });
        }
      }
    }
    for (const ch of n.children ?? []) visit(ch);
  };
  visit(domRoot);
  return out;
}

// src/entry.ts
function readStdin() {
  const raw = (0, import_node_fs.readFileSync)(0, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}
function nodeRef(n) {
  if (!n) return void 0;
  return { domPath: n.domPath };
}
async function main() {
  const command = process.argv[2] ?? "";
  try {
    const input = readStdin();
    let out;
    switch (command) {
      case "compare": {
        const { designRoot, domRoot, viewport } = input;
        if (!designRoot || !domRoot) throw new Error("compare \u7F3A\u5C11 designRoot / domRoot \u5165\u53C2");
        const tolerance = normalizeTolerance(input.tolerance);
        const { pairs, unmatchedDesignCount, unmatchedDomCount } = matchNodes(designRoot, domRoot);
        const diffs = computeDiffs(pairs, tolerance, viewport, input.includeSizeSpacing !== false);
        out = { ok: true, diffs, unmatchedDesignCount, unmatchedDomCount };
        break;
      }
      case "figma-node-size": {
        if (typeof input.proxy === "string") setFigmaCustomProxy(input.proxy);
        out = await fetchFigmaNodeSize({ pat: input.pat, figmaUrl: input.figmaUrl });
        break;
      }
      case "figma-design": {
        if (typeof input.proxy === "string") setFigmaCustomProxy(input.proxy);
        const res = await fetchFigmaDesign({ pat: input.pat, figmaUrl: input.figmaUrl, scale: input.scale });
        if (!res.ok || !res.data) {
          out = { ok: false, message: res.message };
          break;
        }
        const shot = res.data.screenshotDataUrl;
        (0, import_node_fs.writeFileSync)(String(input.outScreenshot), Buffer.from(shot.slice(shot.indexOf(",") + 1), "base64"));
        (0, import_node_fs.writeFileSync)(String(input.outRoot), JSON.stringify({ root: res.data.root, nodes: res.data.nodes }));
        out = {
          ok: true,
          message: res.message,
          fileKey: res.data.fileKey,
          nodeId: res.data.nodeId,
          nodeName: res.data.nodeName,
          frameSize: res.data.frameSize,
          scale: res.data.scale,
          skippedCount: res.data.skippedCount
        };
        break;
      }
      case "check-spec": {
        if (!input.domRoot) throw new Error("check-spec \u7F3A\u5C11 domRoot \u5165\u53C2");
        const violations = checkSpec(
          input.domRoot,
          input.tokens ?? [],
          input.viewport,
          normalizeTolerance(input.tolerance)
        );
        out = {
          ok: true,
          violations: violations.map((v) => ({ ...v, node: nodeRef(v.node) }))
        };
        break;
      }
      case "check-elements": {
        if (!input.designRoot || !input.domRoot) throw new Error("check-elements \u7F3A\u5C11 designRoot / domRoot \u5165\u53C2");
        const findings = checkElements(input.designRoot, input.domRoot, input.frameSize, input.viewport);
        out = {
          ok: true,
          findings: findings.map((f) => ({
            ...f,
            node: nodeRef(f.node),
            designNode: nodeRef(f.designNode)
          }))
        };
        break;
      }
      case "check-a11y": {
        if (!input.domRoot) throw new Error("check-a11y \u7F3A\u5C11 domRoot \u5165\u53C2");
        const findings = checkA11y(input.domRoot, input.viewport);
        out = {
          ok: true,
          findings: findings.map((f) => ({ ...f, node: nodeRef(f.node) }))
        };
        break;
      }
      case "spec-sync": {
        if (typeof input.proxy === "string") setFigmaCustomProxy(input.proxy);
        try {
          out = await syncSpecTokens({
            pat: input.pat,
            figmaUrl: input.figmaUrl,
            startLevel: input.startLevel
          });
        } catch (err) {
          out = { ok: false, message: err instanceof Error ? err.message : String(err) };
        }
        break;
      }
      case "figma-file-meta": {
        if (typeof input.proxy === "string") setFigmaCustomProxy(input.proxy);
        const fileKeys = Array.isArray(input.fileKeys) ? input.fileKeys.filter(Boolean) : [];
        const metas = [];
        for (const fileKey of fileKeys) {
          const meta = await fetchFigmaFileMeta(fileKey, input.pat);
          metas.push({ fileKey, ...meta });
        }
        out = { ok: true, metas };
        break;
      }
      case "spec-import-json": {
        const files = Array.isArray(input.files) ? input.files : [];
        if (!files.length)
          throw new Error("\u672A\u8BC6\u522B\u5230\u4EFB\u4F55 Token\uFF1A\u652F\u6301 Figma Variables \u5BFC\u51FA\u683C\u5F0F\uFF08meta.variables / variables \u952E\uFF09\u4E0E Tokens Studio / W3C DTCG \u5D4C\u5957\u683C\u5F0F\uFF08value/$value + type/$type\uFF09\uFF0C\u8BF7\u786E\u8BA4\u5BFC\u51FA\u7684 JSON \u6587\u4EF6\u5185\u5BB9");
        const tokens = parseVariablesJsonBundle(files);
        out = { ok: true, tokens };
        break;
      }
      case "export-tokens": {
        const tokens = Array.isArray(input.tokens) ? input.tokens : [];
        const format = String(input.format ?? "json");
        if (!["json", "css", "tailwind"].includes(format)) throw new Error(`\u4E0D\u652F\u6301\u7684\u5BFC\u51FA\u683C\u5F0F\uFF1A${format}`);
        out = { ok: true, text: exportTokens(tokens, format) };
        break;
      }
      default:
        throw new Error(`\u672A\u77E5\u5B50\u547D\u4EE4\uFF1A${command}`);
    }
    process.stdout.write(JSON.stringify(out));
  } catch (err) {
    process.stdout.write(JSON.stringify({ ok: false, message: err instanceof Error ? err.message : String(err) }));
  }
}
void main();
