# RoomCanvas 官方介绍页

沿用本地 Form / 砚台设计：深灰背景、黄铜金操作、Manrope 与系统中文字体。内容来自根 README；素材仅包含 LiteReality 官方办公室样例，不包含私人卧室。

## 本地预览

在仓库根目录执行 `python3 web/scripts/serve.py` 后访问：

http://127.0.0.1:7880/sites/roomcanvas-official/dist/

也可以独立运行：

```sh
python3 -m http.server 7890 --bind 127.0.0.1 --directory sites/roomcanvas-official/dist
```

打开 http://127.0.0.1:7890/ 。直接双击 `dist/index.html` 也可浏览；复制命令在非安全上下文提供选中文本的后备操作。

## 文件

- `dist/index.html`：中文官方介绍、功能、快速开始、文档与常见问题。
- `dist/style.css`：现有品牌配色、响应式布局、键盘焦点和减弱动效。
- `dist/main.js`：样例切换、日夜对比、复制命令和手机导航。
- `dist/assets/`：项目实际图像、本地字体与许可证。
- `.openai/hosting.json`：独立 Sites 静态站点配置。

本页仅介绍产品。模型编辑、重建服务、摄像头识别仍在现有应用中；文档和源码链接需要项目仓库访问权限。
