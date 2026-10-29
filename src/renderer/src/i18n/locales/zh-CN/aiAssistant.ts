/** AI 小助手面板文案（悬浮球 / 对话面板 / @引用 / 错误提示） */
export default {
  title: 'AI 小助手',
  fabLabel: 'AI 小助手',
  // 会话维度标记
  sessionProject: '项目会话',
  sessionPage: '页面会话',
  sessionNone: '全局会话',
  // 空状态与推荐问题
  greeting: '你好，我是 UI 走查助手',
  greetingDesc: '可以问我本页问题解读、报告汇总、规范校验、开发整改话术或历史检索',
  suggestTitle: '试试这样问',
  refreshSuggests: '换一批',
  // 消息操作
  copy: '复制',
  copied: '已复制',
  retry: '重试',
  loadingHistory: '加载对话记录…',
  // 输入区
  inputPlaceholder: '输入问题，@ 引用项目/页面/报告/问题，Enter 发送',
  send: '发送',
  stop: '停止生成',
  clear: '清空对话',
  clearTitle: '清空当前会话？',
  clearConfirm: '确认清空当前会话的全部对话记录吗？',
  quickSection: '快捷提问',
  quickExpand: '展开快捷提问',
  quickCollapse: '收起快捷提问',
  disclaimer: 'AI 生成内容仅供参考，请以实际走查数据为准',
  // @ 引用菜单
  mentionProject: '项目',
  mentionPage: '页面',
  mentionReport: '报告',
  mentionIssue: '问题',
  mentionSearchPlaceholder: '搜索…',
  mentionEmpty: '无匹配结果',
  // 错误与缺省
  modelMissing: '尚未配置 AI 模型，请到「设置 → AI 模型管理」添加后使用',
  sendFailed: '发送失败',
  contextNoneTip: '当前不在项目/页面内，回答不包含走查数据'
}
