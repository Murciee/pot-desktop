<p align="center">
  <img width="96" src="public/icon.svg" alt="pot" />
</p>

<h1 align="center">pot</h1>

<p align="center">
  基于 <a href="https://github.com/pot-app/pot-desktop">pot-app/pot-desktop</a> 的 Windows 二次开发版本，主要加强覆盖翻译和设置界面。<br/>
  上游版权归原作者所有，本仓库只维护自己的改动。
</p>

<p align="center">
  <a href="https://github.com/Murciee/pot-desktop/releases/latest"><img alt="release" src="https://img.shields.io/github/v/release/Murciee/pot-desktop?label=release" /></a>
  <img alt="tauri" src="https://img.shields.io/badge/Tauri-1.6-24C8DB?logo=tauri&logoColor=white" />
  <img alt="platform" src="https://img.shields.io/badge/platform-Windows-0078D4?logo=windows&logoColor=white" />
  <a href="LICENSE"><img alt="license" src="https://img.shields.io/github/license/Murciee/pot-desktop" /></a>
</p>

<p align="center">
  <img src="asset/1.png" width="32%" />
  <img src="asset/2.png" width="32%" />
  <img src="asset/3.png" width="32%" />
</p>

## 本分支改动

- **覆盖翻译（Windows）**：点击选区外才关闭；翻译失败或超时会提示渠道与原因；可选 OCR 引擎；覆盖层贴合选区。
- **设置界面**：控件右对齐、窗口尺寸与位置记忆、代理和热键字段对齐、长输入框不再被裁切。
- **OpenAI 兼容接口**：支持关闭思考（reasoning）。
- 其余修复见 [CHANGELOG](CHANGELOG)。

## 功能

- 划词翻译、输入翻译、截图 OCR、截图翻译、覆盖翻译
- 多接口并行翻译与文字识别
- 导出到生词本
- 外部 HTTP 调用，方便被其他软件触发
- 插件系统（`.potext`）
- 多语言界面

## 下载

Windows 安装包见 [Releases](https://github.com/Murciee/pot-desktop/releases/latest)。安装后可在设置中开启自动更新。

> 其他平台请自行编译，或使用[上游版本](https://github.com/pot-app/pot-desktop/releases)。

## 覆盖翻译

在托盘菜单选择「覆盖翻译」，或为「覆盖翻译」绑定快捷键后框选屏幕区域。识别选区文字后，译文会覆盖在原位置；默认点击穿透，按同一个快捷键进入编辑模式（刷新、原文/译文、字号、锁定、关闭）。

已知限制：

- 独占全屏的 DirectX 游戏无法覆盖。
- DRM 视频或硬件叠加层画面可能截取为黑屏。
- 暂不支持跨屏截图，选区需在同一块显示器内。

## 支持接口

| 类型     | 内置接口                                                                                                                                                                                          |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 翻译     | OpenAI、智谱 AI、Gemini、Ollama（离线）、阿里、百度、彩云小译、腾讯、腾讯交互、火山、小牛、Google、Bing、DeepL、有道、剑桥词典、Yandex、Lingva、Tatoeba、ECDICT                                            |
| 文字识别 | 系统 OCR（Windows.Media.OCR / Apple Vision / Tesseract）、Tesseract.js（离线）、百度、腾讯、火山、讯飞、腾讯图片翻译、百度图片翻译、Simple LaTeX、OCRSpace、Rapid（离线）、Paddle（离线）              |
| 语音合成 | Lingva                                                                                                                                                                                            |
| 生词本   | Anki、欧路词典、有道、扇贝                                                                                                                                                                        |

更多接口通过[插件](#插件)扩展。

## 插件

插件扩展名为 `.potext`。在 [Plugin List](https://pot-app.com/plugin.html) 找到需要的插件并下载，然后进入 **偏好设置 → 服务设置 → 添加外部插件 → 安装外部插件**，选择文件即可。安装后在服务列表里启用即可使用。

插件开发模板与文档同样见 [Plugin List](https://pot-app.com/plugin.html)。

## 外部调用

软件会监听本地 HTTP 端口（默认 `60828`，可在设置中修改），其他程序可直接调用：

| 请求                                        | 作用                         |
| ------------------------------------------- | ---------------------------- |
| `POST /`                                    | 翻译 body 中的文本           |
| `POST /translate`                           | 同上                         |
| `GET /config`                               | 打开设置                     |
| `GET /selection_translate`                  | 划词翻译                     |
| `GET /input_translate`                      | 输入翻译                     |
| `GET /ocr_recognize`                        | 截图 OCR                     |
| `GET /ocr_translate`                        | 截图翻译                     |
| `GET /ocr_recognize?screenshot=false`       | 使用外部截图做 OCR           |
| `GET /ocr_translate?screenshot=false`       | 使用外部截图做截图翻译       |

示例：

```bash
curl "127.0.0.1:60828/selection_translate"
```

使用外部截图时，把图片保存到 `$CACHE/com.pot-app.desktop/pot_screenshot_cut.png`，再请求带 `screenshot=false` 的接口。Windows 上的 `$CACHE` 为 `%LOCALAPPDATA%`。

## 编译

环境要求：

- Node.js >= 18
- pnpm >= 8.5
- Rust >= 1.80（Windows 需安装 MSVC 构建工具）

```bash
pnpm install
pnpm tauri dev     # 开发调试
pnpm tauri build   # 打包
```

## 许可

[GPL-3.0](LICENSE)，与上游一致。
