# 研究样本来源

研究在 2026-10-26 下载并解析了 11 个真实文件。网站引擎在 2026-10-27 使用这组语料作本地回归，得到相同的 43 个位图笔尖。公开仓库只包含来源记录，不包含这些文件或派生素材。

| 仓库 | 固定提交 | 使用的样本 |
|---|---|---|
| [GNOME/gimp-data](https://github.com/GNOME/gimp-data) | `dba1b6d3d5e0703c5337c9ec32805ac017dc1270` | Bristles-01.gbr、pepper.gbr、Acrylic-01.gih、vine.gih、Hardness-050.vbr、Star.vbr |
| [mypaint/mypaint-brushes](https://github.com/mypaint/mypaint-brushes) | `08da4a48a4b63f2e0f3303942d7c21da8479ea9f` | classic/charcoal.myb、classic/smudge.myb |
| [KDE/krita](https://github.com/KDE/krita) | `8799df6d3fb1654ca80bc17dc26a082be9f3872c` | Basic-5_Size_default.kpp、WaterC_Spread.kpp、测试集 brushes_by_mar_ka_d338ela.abr |

MyPaint 原始设置有明确 CC0 政策；GIMP 历史资源和 Krita 第三方测试 ABR 的逐文件再分发许可没有在本项目中全部核清。因此这批外部素材没有加入公开仓库，也没有放入在线演示。

在线“载入演示”由 `makeDemos()` 现场生成六种格式的文件，以独立程序生成的点阵、形状和参数为内容，适合测试格式流转，不代表某款商业笔刷的效果。
