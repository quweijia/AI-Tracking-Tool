/** 通用兜底 namespace（defaultNS）；各页面文案在各自 namespace 内维护 */
export default {
  appName: 'AI 走查工具',
  cancel: '取消',
  confirm: '确定',
  confirmAction: '确认操作',
  save: '保存',
  close: '关闭',
  delete: '删除',
  loading: '加载中...',
  /** 软删除（回收站）提示：删除项目/文件夹/页面后统一提示，可在回收站还原 */
  movedToTrash: '已移入回收站，可在回收站还原',
  /** macOS 录屏权限引导弹窗（截图功能） */
  perm: {
    title: '需要录屏权限',
    desc: '使用截图功能需要授权「录屏与系统录音」权限',
    step1: '点击「打开系统设置」，进入 隐私与安全性 → 录屏与系统录音',
    step2: '按住下方应用图标，拖入右侧应用列表（或点击 + 添加本应用）',
    step3: '授权后若截图仍不可用，请重启应用',
    dragHint: '按住拖到系统设置',
    openSettings: '打开系统设置',
    done: '完成',
    granted: '授权成功',
    grantedDesc: '截图功能已可用'
  }
}
