import { useEffect, useRef } from 'react'

/**
 * 豆包下载按钮同款光晕交互：
 * - 悬停时指针位置逐帧 lerp 插值写入 CSS 变量 --glow-x/--glow-y（光斑丝滑跟随）
 * - 空闲（未悬停）时光斑沿椭圆轨迹自动巡游，保持按钮"呼吸感"
 * - --glow-on 标记悬停态，供 CSS 提高 光斑不透明度 / 边缘 bloom 强度
 */
export function usePointerGlow<T extends HTMLElement>() {
  const ref = useRef<T>(null)

  useEffect(() => {
    const el = ref.current
    if (!el) return
    let raf = 0
    let targetX = 0.5
    let targetY = 0.5
    let x = 0.5
    let y = 0.5
    let hover = false
    let t = Math.random() * 100

    const onMove = (e: PointerEvent) => {
      const r = el.getBoundingClientRect()
      targetX = Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width)))
      targetY = Math.min(1, Math.max(0, (e.clientY - r.top) / Math.max(1, r.height)))
    }
    const onEnter = () => {
      hover = true
    }
    const onLeave = () => {
      hover = false
    }

    const tick = () => {
      t += 0.016
      if (!hover) {
        // 空闲巡游：椭圆轨迹缓慢漂移（错开相位避免机械感）
        targetX = 0.5 + Math.sin(t * 0.9) * 0.42
        targetY = 0.5 + Math.sin(t * 1.4 + 1.2) * 0.34
      }
      // lerp 插值：光斑平滑趋近目标位置
      x += (targetX - x) * 0.12
      y += (targetY - y) * 0.12
      el.style.setProperty('--glow-x', `${(x * 100).toFixed(2)}%`)
      el.style.setProperty('--glow-y', `${(y * 100).toFixed(2)}%`)
      el.style.setProperty('--glow-on', hover ? '1' : '0')
      raf = requestAnimationFrame(tick)
    }

    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerenter', onEnter)
    el.addEventListener('pointerleave', onLeave)
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerenter', onEnter)
      el.removeEventListener('pointerleave', onLeave)
    }
  }, [])

  return ref
}
