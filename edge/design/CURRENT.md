# 当前品牌图稿

当前交付版本：`brand-v1-connected`。

- 完整展示板：`brand-v1-connected/brand-board.png`
- 独立 Logo：`brand-v1-connected/logo-master.png`
- 正圆形应用图标：`brand-v1-connected/app-icon-circle.png`
- 原始图形来源：`brand-v1-connected/app-icon.png`（原圆角方形展示稿，仅用于提取图案）
- 内置图像编辑提示词：`brand-v1-connected/prompt.md`

此版本接通了左侧嘴部负形，完整展示板三处图形已同步更新，并经逐项视觉检查。

插件资源由 `scripts/export-icons.mjs` 从已确认图案统一导出：图案等比缩放以完整保留斩线两端，黑色底板改为正圆，圆外透明。16/32/48/128 像素 PNG 均使用同一正圆母图，并校验尺寸与圆形透明边缘。

名称为「扰人杀手 / Annoy Killer」。正圆形图标已打包为 1.0.23，并同步、校验 Chrome 已安装目录；功能代码保持原有 1.0.22 内容不变。Chrome 运行实例的重载未在本任务中执行。
