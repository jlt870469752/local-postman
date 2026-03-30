# Local Postman

本项目是一个多功能本地桌面工具（Tauri 2 + Vite），首页可切换三个能力：

- `Postman`：API 请求调试
- `SAM 抠图`：单图/交互/批量抠图
- `去水印`：内置启动 `lama-cleaner` 本地服务

## 功能概览

### 1) Postman 请求调试

- HTTP 方法：`GET` `POST` `PUT` `DELETE` `PATCH` `HEAD` `OPTIONS`
- Body 类型：`none` `form-data` `x-www-form-urlencoded` `raw` `binary(base64)` `graphql`
- Raw 格式：`Text` `JavaScript` `JSON` `HTML` `XML`
- 响应视图：`Body` `Headers` `Cookies`
- Body 视图增强：`Preview` `Visualize` 搜索（快捷键触发）
- 多请求 Tabs、历史记录、Collections（含导入、拖拽、重命名等）

### 2) SAM 抠图

- 单张自动抠图
- 交互式抠图（点位标注、放大预览、任务续编）
- 批量抠图 + 任务队列
- Python 依赖检测、模型加载、输出格式配置

### 3) 去水印（lama-cleaner）

- 应用内安装/卸载 `lama-cleaner`
- 应用内启动/停止服务
- 端口可配置
- 模型下载状态检测（`big-lama.pt`）
- 命令文档弹窗（安装、卸载、启动、探活、模型检查）

## 环境要求

- Node.js `18+`
- Rust（建议 `1.77+`）
- Tauri 2 构建依赖（按系统安装）
- （可选）Conda/Miniconda 的 `sam` 环境，用于 SAM 与 lama-cleaner

## 快速开始

```bash
npm install
```

```bash
# 桌面开发（推荐）
npm run tauri:dev
```

```bash
# 前端开发（仅 Web）
npm run dev
```

## 构建

```bash
npm run build
npm run tauri:build
```

## 去水印服务说明

在首页进入 `去水印` 页面后：

1. 未安装时先点 `安装服务`
2. 可设置端口并点 `应用端口`
3. 点 `启动服务`，页面内打开 `http://127.0.0.1:<port>`

注意：

- 从去水印页面返回首页时，应用会自动停止由应用内启动的 `lama-cleaner` 进程。
- 下次进入去水印页面需要手动重新启动服务。

模型检测默认路径：

```bash
ls -lh ~/.cache/torch/hub/checkpoints/big-lama.pt
```

模型下载前置依赖修复（如需要）：

```bash
/opt/miniconda3/envs/sam/bin/pip install "huggingface_hub<0.26" --force-reinstall
```

## 常用脚本

- `npm run dev`：启动 Vite
- `npm run build`：构建前端
- `npm run preview`：预览前端构建产物
- `npm run tauri:dev`：启动 Tauri 开发模式
- `npm run tauri:build`：构建桌面安装包

## 数据存储

应用数据位于 Tauri `app_data_dir`，常见文件：

- `history.json`
- `collections.json`
- `sam-runtime.json`
- `lama-runtime.json`

## 项目结构

```text
local-postman/
├─ index.html
├─ src/main.js
├─ public/sam-ui/
├─ src-tauri/src/lib.rs
├─ src-tauri/src/sam.rs
└─ README.md
```
