# AI Tracking Tool（AI 走查工具）

UI 设计走查（Visual QA）桌面应用，面向设计/前端协作场景：将 UI 设计稿与开发实现截图并排对比、标注差异、跟踪修复状态，并一键导出可交互走查报告或同步到飞书。

> 作者：[Vic Qu](https://quweijia.is-a.dev/)

## 功能特性

### 对比与标注
- **四种对比视图**：并排、洋葱皮叠加、滑块（含分界线调节）、差异闪烁，均支持缩放与抓手平移
- **七类标注工具**：抓手、点位标注、箭头、框选、文字标注、测量距离（读取真实图片像素尺寸）、吸色取样（一次点击同时取双图同坐标色值）
- 标注支持拖拽移动、自定义颜色（含黑白色与描边适配）、全局连续序号
- 标注严重度四级分类：严重 / 一般 / 建议 / 设计确认，问题固定六大分类（间距规范、文字排版、颜色规范、样式规范、交互体验、兼容性）

### AI 能力
- **AI 视觉识别**：接入 OpenAI 兼容多模态接口，自动对比设计稿与开发截图，输出结构化问题候选与修复建议
- **SkillHub 技能指引**：自定义走查检查要点，识别时注入 AI 提示词
- 多模型管理、连通性测试、MCP 服务配置

### 协作与产出
- 项目 → 菜单（版本）→ 页面三级管理，侧边栏树状菜单支持拖拽排序、重命名、展开收起
- 问题状态流转（待修复 / 进行中 / 已修复 / 忽略 / 设计确认）、复验记录（通过 / 打回 + 截图佐证）
- **导出交互式 HTML 走查报告**：设计稿与开发截图并排、标注可点击查看详情、支持全屏查看、问题明细清单、AI 报告分析区块
- **研发修改报告**导出：含处理结果与未回应提示
- **飞书集成**：一键生成飞书文档（自动上传截图、压缩超限附件）+ 问题明细多维表（人员分配、状态单选），失败自动降级并透出 warning

### 体验
- 深色 / 浅色 / 跟随系统三态主题
- 最近访问记录（按页面活动时间排序）、继续上次工作入口
- 项目 Logo 上传或文字占位（8 色板），平台四类型标签（H5 / PC / 大屏 / Electron）
- 自绘 macOS 窗口控制按钮（修复原生红绿灯失焦消失问题）、中文应用菜单

## 技术栈

| 层 | 技术 |
|---|---|
| 框架 | Electron 33 + electron-vite 2 |
| 渲染层 | React 18 + TypeScript + react-router（HashRouter）+ zustand |
| 数据 | Dexie 4（IndexedDB），标注坐标 0~1 归一化存储 |
| 标注层 | SVG 覆盖方案（双图独立标注） |
| 打包 | electron-builder 26（mac dmg/zip 双架构 + win nsis） |

## 下载安装（发行包）

安装包在 macOS（Intel / Apple Silicon）与 Windows（x64）三端分别构建，产物输出至 `release/{version}/`：

| 平台 | 产物 | 说明 |
|---|---|---|
| macOS Intel | `AI 走查工具-{version}-x64.dmg` / `.zip` | Intel 芯片 |
| macOS Apple Silicon | `AI 走查工具-{version}-arm64.dmg` / `.zip` | M1/M2/M3/M4 系列 |
| Windows x64 | `AI-Walkthrough-Setup-{version}.exe` | NSIS 向导式安装，可选安装目录 |

也可直接从 GitHub Releases 下载（Release 资产使用 ASCII 文件名，如 `AI-Walkthrough-1.0.0-x64.dmg`）：https://github.com/quweijia/AI-Tracking-Tool/releases

未申请代码签名证书：

- **macOS** 首次打开若提示「无法验证开发者」，右键 App → 「打开」，或前往 系统设置 → 隐私与安全性 → 仍要打开
- **Windows** 安装/运行时若弹出 SmartScreen 蓝色提示，点击「更多信息 → 仍要运行」

打包版用户数据独立存放（macOS `~/Library/Application Support/AI 走查工具`、Windows `%APPDATA%/AI 走查工具`），不污染开发目录。

## 快速开始

```bash
# 环境要求：Node.js 20+

npm install            # 安装依赖
npm run dev            # 启动开发模式（主进程改动需手动重启）
npm run typecheck      # 类型检查（node + web 两套 tsconfig）
npm run build:mac      # typecheck + 构建 + 打包 macOS 双架构（x64 + arm64）
npm run build:mac:intel  # 仅打包 macOS Intel（x64）
npm run build:mac:arm    # 仅打包 macOS Apple Silicon（arm64）
npm run build:win      # typecheck + 构建 + 打包 Windows x64（NSIS 安装器）
npm run build:all      # 一次性打包 macOS 双架构 + Windows x64
```

> 交叉打包说明：macOS 上可直接交叉构建 Windows NSIS 安装器与另一架构的 macOS 包（本项目无 native 模块）。「客观走查门」为可选增强能力，依赖运行环境自备 `python3` 与 Playwright Chromium（`npx playwright install chromium`），缺省时对应 gate 会明确报「无法测量」而非误报通过。

## 数据与隐私

- 所有项目数据、标注、图片**仅存储在本地**（IndexedDB + 应用数据目录），不上传任何服务器
- AI 模型、MCP、飞书等凭据仅保存在本地配置文件中
- 飞书集成需自行创建飞书应用并开通对应权限（文档读写、图片/文件上传）

## 目录结构

```
src/
├── main/        # Electron 主进程（窗口、IPC、AI 识别、飞书集成、文件存取）
├── preload/     # contextBridge 预加载
└── renderer/    # React 渲染层
    ├── pages/       # 项目列表 / 项目详情 / 对比工作台 / 问题清单 / 报告导出 / 设置
    ├── components/  # 画布标注、问题抽屉、各弹窗、平台标签等
    ├── stores/      # zustand 状态
    ├── db/          # Dexie 数据模型与级联删除
    └── styles/      # 全局样式（深浅色主题变量）
```

## License

[MIT](./LICENSE)
