/** 内置浏览器组件文案 */
export default {
  scriptTimeout: '页面脚本执行超时',
  loadFailedReason: '页面加载失败：{{reason}}',
  loadFailedNetwork:
    '页面加载失败（网络错误）：系统代理可能拦截了该站点，已自动尝试直连仍失败。请检查该地址在系统浏览器中是否可达；内网页面请确认已连接内网',
  loadFailedCode: '页面加载失败（{{code}}）：{{description}}',
  checkUrlNetwork: '请检查 URL 与网络',
  browserNotCreated: '内置浏览器尚未创建',
  loadTimeout: '页面加载超时（20s）：URL 可能不可达，或页面正在等待登录/跳转。当前地址：{{url}}',
  emptyAddress: '（空）',
  domCollectFailed: '页面 DOM 采集失败',
  screenshotEmpty: '页面截图内容为空，请确认页面已加载完成',
  scrollTopStuck: '页面无法滚动回顶部，截图已中止（页面可能禁用了滚动），请重试',
  guestLayoutMismatch: '页面视口与设计基准宽不一致且自动校正未收敛，截图已中止，请重试',
  captureReloaded: '页面在采集过程中重新加载，截图已中止，请重试',
  compositorStale: '页面渲染长时间未更新，截图已中止以避免内容重复，请重试',
  notLoaded: '未加载页面',
  refresh: '刷新',
  emptyUrlHint: '输入开发环境页面 URL 后加载'
}
