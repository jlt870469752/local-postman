# Local Postman

轻量级本地 API 调试工具（Tauri 2 + Vite）。

## 功能概览

- HTTP 请求支持：`GET` `POST` `PUT` `DELETE` `PATCH` `HEAD` `OPTIONS`
- 请求编辑：
  - Query Params / Headers
  - Body 类型：`none` `form-data` `x-www-form-urlencoded` `raw` `binary(base64)` `graphql`
  - `raw` 支持类型：`Text` `JavaScript` `JSON` `HTML` `XML`
- 响应查看：
  - Tab：`Body` `Headers` `Cookies`
  - Body 格式：`JSON` `XML` `HTML` `JavaScript` `Raw` `Hex` `Base64`
  - `Preview`（HTML/图片）与 `Visualize`（JSON）
  - 快捷搜索（仅在响应 Body 内）
- 请求 Tabs：
  - 新建/切换/关闭
  - 溢出时左右滚动箭头
  - 下拉查看全部 tabs + 搜索
- Collections / History：
  - 保存请求到 Collection
  - 自动记录历史并可回放

## 技术栈

- 前端：Vite + 原生 HTML/CSS/JS
- 桌面容器：Tauri 2
- 后端：Rust + Reqwest + Tokio

## 环境要求

- Node.js 18+
- Rust（建议与项目一致：`1.77.2+`）
- Tauri 2 构建依赖（按你的系统安装）

## 快速开始

```bash
npm install
```

### 启动前端开发服务（仅 Web）

```bash
npm run dev
```

### 启动桌面应用（推荐）

```bash
npm run tauri:dev
```

## 构建

```bash
# 前端构建
npm run build

# 桌面应用打包
npm run tauri:build
```

## 常用脚本

- `npm run dev`：启动 Vite
- `npm run build`：构建前端
- `npm run preview`：预览前端构建产物
- `npm run tauri:dev`：启动 Tauri 开发模式
- `npm run tauri:build`：构建桌面安装包

## 数据存储

应用会将数据存储到系统的 Tauri `app_data_dir` 目录，主要文件：

- `history.json`：请求历史
- `collections.json`：收藏集合

## 快捷键

- `Ctrl/Cmd + F`：在响应 Body 中打开搜索框
- `Esc`：关闭搜索框或关闭 tabs 下拉框

## 项目结构

```text
local-postman/
├─ index.html          # 主界面与样式
├─ src/main.js         # 前端业务逻辑
├─ src-tauri/src/lib.rs# Tauri/Rust 命令与数据存储
├─ package.json
└─ README.md
```

