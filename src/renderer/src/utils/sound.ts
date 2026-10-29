/**
 * 轻量提示音（Web Audio 合成，无需音频资产）：
 * AI 识别任务完成时播放上行双音「叮-咚」，遵循通用设置 soundEnabled 开关（默认开启）。
 */
let audioCtx: AudioContext | null = null

const getCtx = (): AudioContext | null => {
  try {
    if (!audioCtx) {
      const Ctor =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
      if (!Ctor) return null
      audioCtx = new Ctor()
    }
    return audioCtx
  } catch {
    return null
  }
}

/** 播放任务完成提示音（设置关闭或音频上下文不可用时静默） */
export const playTaskDoneSound = async () => {
  try {
    const cfg = await window.electronAPI.getConfig()
    if (cfg.soundEnabled === false) return
  } catch {
    // 配置读取失败按开启处理，不打断任务流程
  }
  const ctx = getCtx()
  if (!ctx) return
  if (ctx.state === 'suspended') void ctx.resume()
  const now = ctx.currentTime
  const tone = (freq: number, at: number) => {
    const osc = ctx.createOscillator()
    const gain = ctx.createGain()
    osc.type = 'sine'
    osc.frequency.value = freq
    gain.gain.setValueAtTime(0.0001, now + at)
    gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.02)
    gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.3)
    osc.connect(gain).connect(ctx.destination)
    osc.start(now + at)
    osc.stop(now + at + 0.32)
  }
  // 叮-咚：E6 → A6，柔和上行，约 0.45s 结束
  tone(1318.5, 0)
  tone(1760, 0.14)
}
