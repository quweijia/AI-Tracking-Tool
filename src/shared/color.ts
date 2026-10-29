/**
 * 颜色解析与色差计算：hex/rgb 字符串解析、rgb → Lab（D65）、ΔE CIEDE2000。
 * 供主进程结构化比对与渲染层展示共用。
 */

export interface RGBA {
  r: number
  g: number
  b: number
  /** 0~1 */
  a: number
}

export interface Lab {
  L: number
  a: number
  b: number
}

/** 解析 #rgb/#rrggbb/#rrggbbaa/rgb()/rgba()/rgba 空格语法，失败返回 null */
export function parseColor(input: string | undefined | null): RGBA | null {
  if (!input) return null
  const s = input.trim().toLowerCase()
  if (s === 'transparent') return { r: 0, g: 0, b: 0, a: 0 }
  // #rgb / #rgba / #rrggbb / #rrggbbaa
  if (s.startsWith('#')) {
    const hex = s.slice(1)
    if (hex.length === 3 || hex.length === 4) {
      const [r, g, b, a] = hex.split('').map((c) => parseInt(c + c, 16))
      return { r, g, b, a: hex.length === 4 ? a / 255 : 1 }
    }
    if (hex.length === 6 || hex.length === 8) {
      const r = parseInt(hex.slice(0, 2), 16)
      const g = parseInt(hex.slice(2, 4), 16)
      const b = parseInt(hex.slice(4, 6), 16)
      const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
      if ([r, g, b].some((v) => Number.isNaN(v))) return null
      return { r, g, b, a }
    }
    return null
  }
  // rgb(1, 2, 3) / rgba(1,2,3,.5) / rgb(1 2 3 / .5)
  const m = s.match(/^rgba?\(([^)]+)\)$/)
  if (m) {
    const parts = m[1].split(/[\s,/]+/).filter(Boolean)
    if (parts.length >= 3) {
      const nums = parts.map((p) => (p.endsWith('%') ? (parseFloat(p) / 100) * 255 : parseFloat(p)))
      if (nums.slice(0, 3).some((v) => Number.isNaN(v))) return null
      return {
        r: nums[0],
        g: nums[1],
        b: nums[2],
        a: parts[3] !== undefined && !Number.isNaN(parseFloat(parts[3])) ? parseFloat(parts[3]) : 1
      }
    }
  }
  return null
}

/** rgba → #RRGGBB（透明度参与四舍五入但不写入 hex） */
export function rgbToHex({ r, g, b }: RGBA): string {
  const to = (v: number) =>
    Math.max(0, Math.min(255, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
  return `#${to(r)}${to(g)}${to(b)}`.toUpperCase()
}

/** rgba → rgba(r, g, b, a) 可读文案（用于差异描述） */
export function rgbaLabel({ r, g, b, a }: RGBA): string {
  const alpha = Math.round(a * 100) / 100
  return alpha >= 1 ? rgbToHex({ r, g, b, a }) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${alpha})`
}

const clamp01 = (v: number): number => Math.max(0, Math.min(1, v))

function srgbChannelToLinear(c: number): number {
  const cs = c / 255
  return cs <= 0.04045 ? cs / 12.92 : Math.pow((cs + 0.055) / 1.055, 2.4)
}

/** sRGB → XYZ（D65）→ Lab */
export function rgbToLab({ r, g, b }: RGBA): Lab {
  const rl = srgbChannelToLinear(r)
  const gl = srgbChannelToLinear(g)
  const bl = srgbChannelToLinear(b)
  // D65 白点归一化矩阵
  const x = (rl * 0.4124564 + gl * 0.3575761 + bl * 0.1804375) / 0.95047
  const y = rl * 0.2126729 + gl * 0.7151522 + bl * 0.072175
  const z = (rl * 0.0193339 + gl * 0.119192 + bl * 0.9503041) / 1.08883
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116)
  const fx = f(x)
  const fy = f(y)
  const fz = f(z)
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) }
}

/** CIEDE2000 色差（0~100，常规 UI 差异 <2 视觉上难以分辨） */
export function deltaE2000(lab1: Lab, lab2: Lab): number {
  const { L: L1, a: a1, b: b1 } = lab1
  const { L: L2, a: a2, b: b2 } = lab2
  const kL = 1
  const kC = 1
  const kH = 1

  const C1 = Math.sqrt(a1 * a1 + b1 * b1)
  const C2 = Math.sqrt(a2 * a2 + b2 * b2)
  const Cavg = (C1 + C2) / 2
  const pow7 = (v: number): number => Math.pow(v, 7)
  const G = 0.5 * (1 - Math.sqrt(pow7(Cavg) / (pow7(Cavg) + pow7(25))))
  const a1p = (1 + G) * a1
  const a2p = (1 + G) * a2
  const C1p = Math.sqrt(a1p * a1p + b1 * b1)
  const C2p = Math.sqrt(a2p * a2p + b2 * b2)
  const toDeg = (rad: number): number => (rad * 180) / Math.PI
  const h1p = a1p === 0 && b1 === 0 ? 0 : (toDeg(Math.atan2(b1, a1p)) + 360) % 360
  const h2p = a2p === 0 && b2 === 0 ? 0 : (toDeg(Math.atan2(b2, a2p)) + 360) % 360

  const dLp = L2 - L1
  const dCp = C2p - C1p
  let dhp = 0
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p
    if (dhp > 180) dhp -= 360
    else if (dhp < -180) dhp += 360
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI) / 360)

  const Lavg = (L1 + L2) / 2
  const Cpavg = (C1p + C2p) / 2
  let hpavg: number
  if (C1p * C2p === 0) {
    hpavg = h1p + h2p
  } else {
    hpavg = (h1p + h2p) / 2
    if (Math.abs(h1p - h2p) > 180) {
      if (h1p + h2p < 360) hpavg += 180
      else hpavg -= 180
    }
  }
  const rad = (deg: number): number => (deg * Math.PI) / 180
  const T =
    1 -
    0.17 * Math.cos(rad(hpavg - 30)) +
    0.24 * Math.cos(rad(2 * hpavg)) +
    0.32 * Math.cos(rad(3 * hpavg + 6)) -
    0.2 * Math.cos(rad(4 * hpavg - 63))
  const dTheta = 30 * Math.exp(-Math.pow((hpavg - 275) / 25, 2))
  const Rc = 2 * Math.sqrt(pow7(Cpavg) / (pow7(Cpavg) + pow7(25)))
  const Sl = 1 + (0.015 * Math.pow(Lavg - 50, 2)) / Math.sqrt(20 + Math.pow(Lavg - 50, 2))
  const Sc = 1 + 0.045 * Cpavg
  const Sh = 1 + 0.015 * Cpavg * T
  const Rt = -Math.sin(rad(2 * dTheta)) * Rc

  const tL = dLp / (kL * Sl)
  const tC = dCp / (kC * Sc)
  const tH = dHp / (kH * Sh)
  return Math.sqrt(Math.max(0, tL * tL + tC * tC + tH * tH + Rt * tC * tH))
}

/** 两个颜色字符串的 ΔE，解析失败返回 null */
export function colorDeltaE(a: string | undefined, b: string | undefined): number | null {
  const ca = parseColor(a)
  const cb = parseColor(b)
  if (!ca || !cb) return null
  return deltaE2000(rgbToLab(ca), rgbToLab(cb))
}

/** Figma REST 颜色（0~1 浮点）→ hex；透明度低于阈值返回 null（视为无填充） */
export function figmaColorToHex(
  color: { r: number; g: number; b: number } | undefined,
  opacity = 1
): string | null {
  if (!color) return null
  const a = (color as { a?: number }).a ?? opacity
  if (clamp01(a) < 0.05) return null
  return rgbToHex({ r: color.r * 255, g: color.g * 255, b: color.b * 255, a: clamp01(a) })
}
