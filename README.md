# BrushBridge · 笔刷转换工作台

一个在浏览器中运行的笔刷格式解析与转换网站。文件不会上传到服务器；解析、生成预览、烘焙和 ZIP 打包均在本地 Web Worker 中完成。

**在线使用：https://akhialomgir.github.io/brushbridge/**

## 功能

- 批量选择或拖入文件，检测格式、版本、笔尖数量和资源依赖。
- 提取原始笔尖并预览，明确区分 Krita 图标与真实笔尖。
- 自动生成 ABR、GBR、PNG，以及含原文件和 SHA-256 的可逆存档。
- 导出转换清单，逐文件记录跳过原因、损失与近似步骤。
- 显式允许降级后，可以拆分多帧、丢弃颜色保留 alpha，并对部分参数笔刷烘焙基础形状。
- 自行生成的六格式演示；不包含第三方笔刷素材，无远程依赖或分析服务。
- 单文件 ≤ 64 MB，每批最多 20 个，总输入 ≤ 128 MB，ZIP 输出 ≤ 256 MB。

## 覆盖软件和真实边界

| 软件 | 输入格式 | 已实现 | 不能保证 / 尚未实现 |
|---|---|---|---|
| Photoshop | ABR 1/2/6.1/6.2 | 8 位 sampled 笔尖，raw / PackBits | computed、16 位、现代动态描述符 |
| GIMP | GBR 1/2 | 灰度覆盖率 / RGBA，名称、尺寸、间距 | GBR v3、老式附加 PAT 扩展 |
| GIMP | GIH | 所有栅格帧，选帧规则记录 | 跨引擎多维选帧行为 |
| GIMP | VBR 1.0/1.5 | 参数解析；可选近似烘焙 | GIMP 原生渲染和解析式缩放 |
| MyPaint | MYB JSON | 原始设置、输入曲线；可选基础形状烘焙 | libmypaint 动态、速度滤波、混色与原生预设映射 |
| Krita | KPP | PNG 元数据、XML、参数、资源引用、图标 | 外部资源自动补全、引擎动态；仅 auto_brush 可近似烘焙 |
| CSP | SUT/SUTG | **原文件存档** | 原生解码 / 写入；ABR 为候选迁移入口 |
| Procreate | BRUSH/BRUSHSET/BRUSHLIBRARY | **原文件存档** | 原生解码 / 写入 |

这不是“所有笔刷无损互转器”。跨引擎笔刷行为受时间、压力、倾斜、底色、混色、随机状态等影响。所有输出的原生应用导入和完整笔触一致性均未完成验证。ABR 输出采用 v2 sampled 子集；PNG/GBR 保存素材，不能替代完整预设。

近似烘焙只按基础尺寸和形状创建固定分辨率笔尖（半径最大取 510 px），不使用完整源引擎；它必须由用户显式开启。保存原始字节请用可逆存档。SHA-256 用于完整性核验，不是来源真实性签名。

PNG 原始灰度图使用覆盖率：0=透明，255=不透明。`-preview.png` 是黑色墨水加 alpha 的展示图；RGBA 原图保留全透明像素的 RGB 值。

## 本地运行

不需要安装前端依赖，Node.js 22+ 用于测试，Python 3 用于静态预览：

```sh
npm test
npm run dev
```

打开 `http://localhost:4173/`。请通过 HTTPS 或 localhost 访问，不能直接双击 HTML（模块 Worker 和 Web Crypto 需要安全上下文）。推荐新版 Chrome、Edge、Firefox 或 Safari。

## 部署

本仓库通过 GitHub Pages 的分支发布模式部署：`main` 分支下的 `/docs`。修改 `dist/` 后执行 `npm test && npm run build`，将生成的 `docs/` 和源码一起提交；推送后 Pages 自动更新。首次部署在仓库 Settings → Pages 选择 **Deploy from a branch**，分支 `main`，目录 `/docs`。

所有资源采用相对路径，可部署到 GitHub Pages 项目子目录。也可直接将 `dist/` 部署到任意静态托管平台。

## 代码结构

- `dist/index.html` / `dist/styles.css`：响应式中文工作台。
- `dist/app.js`：上传队列、交互、预览、损失提示与下载。
- `dist/converter-worker.js`：在 Worker 中执行文件处理。
- `dist/engine.js`：格式解析、可选近似烘焙、输出编码与原文件存档。
- `dist/zip.js`：带 CRC32 的 UTF-8 ZIP Store 写入器。
- `tests/engine.test.js`：自行生成的格式样本和行为边界测试。
- `scripts/build-pages.mjs`：将静态源码同步到 GitHub Pages 发布目录 `docs/`。
- `tools/brushbridge.py`：上一轮 Python 命令行原型，支持解析、存档和部分 ABR 导出；它与网页近似烘焙能力不同。

浏览器版本和 Python 版本的存档清单结构分别为 `brushbridge-web/1` 和 `brushbridge/1`；网页 ZIP 通过 `original/` 目录还原文件，Python `restore` 仅用于 Python 版 `.brushpkg`。不要混用两种存档格式。

## 验证

默认测试使用程序生成的六格式样本，无需下载第三方笔刷。可选的原始研究语料测试：

```sh
BRUSHBRIDGE_CORPUS=/absolute/path/to/samples npm test
```

原始研究集覆盖 11 个文件、43 个位图笔尖。文件不包含在此公开仓库中。其来源记录可见 `RESEARCH.md`；不要把公开下载能力等同于再分发授权。

## 参考规范

- [GIMP GBR](https://developer.gimp.org/core/standards/gbr/)、[GIH](https://developer.gimp.org/core/standards/gih/)、[VBR](https://developer.gimp.org/core/standards/vbr/)
- [Krita 预设结构](https://community.kde.org/Krita/PaintOp_Presets)、[Krita ABR loader](https://github.com/KDE/krita/blob/8799df6d3fb1654ca80bc17dc26a082be9f3872c/libs/brush/kis_abr_brush_collection.cpp)
- [libmypaint 设置定义](https://github.com/mypaint/libmypaint/blob/master/brushsettings.json)
- [CSP 支持的导入格式](https://help.clip-studio.com/en-us/manual_en/150_tools/Importing_tools.htm)

所有代码和演示素材为本项目编写；未复制上游绘画引擎源码。参考项目保留其各自许可。
