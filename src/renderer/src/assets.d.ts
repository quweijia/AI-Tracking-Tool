// 图片资源模块声明（须放在无 import/export 的环境声明文件中才生效）
declare module '*.png' {
  const src: string
  export default src
}
