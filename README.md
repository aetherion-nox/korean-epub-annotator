# 韩语 EPUB 标注器

为韩语电子书显示汉字词和外来语词源，帮助阅读时理解词汇。扩展在浏览器内使用 Kiwi 分词与词典进行分析，也可选择通过大模型处理有歧义的词语或补充词源。

## 功能

- 为韩语 EPUB 中的汉字词和外来语添加标注，生成可在阅读器中打开的 EPUB。
- 使用本地分词器与词典；可选大模型 API 审核或手动聊天审核。
- 在发送审核请求前分析全书，显示首轮计划批数；API 模式支持设置并发数。
- 审核遇到未完成的目标时，可继续使用 API、切换手动审核，或选择保留原文后生成电子书。
- 提供任务进度与诊断信息；在任务页面保持打开时支持连接恢复。
- 原文中符合条件的韩文括注可为后文提供临时词典依据，不修改永久词典。
- 可选实验性词源补充、智能分词修复及汉字读音校验；读音校验默认关闭。

词典、分词和模型判断都可能出错，人名和专有名词尤其需要结合上下文核对。

## 安装

1. 在 [Releases](https://github.com/aetherion-nox/korean-epub-annotator/releases/latest) 下载 `Korean-EPUB-Annotator-v1.0.0.zip` 并解压。
2. 在 Chrome 打开 `chrome://extensions`，启用**开发者模式**。
3. 点击**加载已解压的扩展程序**，选择含有 `manifest.json` 的文件夹。
4. 点击扩展图标打开标注页面。

## 导入词典

在**设置**中导入词典，可使用[网页标注器的预制词典](https://github.com/aetherion-nox/korean-web-annotator/releases/latest)（下载并解压 `hanja_dict.zip`，导入其中的 DB），也可直接导入[韩国语基础词典](https://krdict.korean.go.kr/download/downloadPopup)提供的 JSON 格式 ZIP。

预制词典根据韩国国立国语院《韩国语基础词典》制作，属于非官方发行。文本数据采用 [CC BY-SA 2.0 KR](https://creativecommons.org/licenses/by-sa/2.0/kr/)；图片和音频链接不因此获得相同许可。

## 标注电子书

在标注页拖入或选择无 DRM 的 EPUB 文件。完成后会自动下载标注后的 EPUB，也可使用下载按钮再次保存。处理期间请保持标注页面打开；关闭或刷新页面后，尚未完成的任务无法保证恢复。

支持 API 自动审核和手动聊天审核。手动模式下，复制或下载提示词并发送给模型，再粘贴或上传返回的 JSON；未完成时按界面提示继续。使用 API 时，书中待审核文本和候选信息会发送给所配置的模型服务商，费用取决于服务商和使用量。

## 适用范围

支持无 DRM、可正常解析的 UTF-8 EPUB，主要处理书籍阅读顺序中的正文。书籍自身的图片、样式和其他资源会保留；无法安全对应原文位置的内容不会强行标注。不同阅读器对 Ruby 标注的显示效果可能不同。

## 从源码构建

需要 Python 3 和 Node.js。运行 `python3 restore_distribution.py` 恢复浏览器运行时，执行 `npm install` 和 `npm run prepare:epub` 后，可在浏览器加载源码文件夹。恢复脚本会校验运行时包的 SHA-256，并保留本项目自带的分析引擎源码。

[下载安装包](https://github.com/aetherion-nox/korean-epub-annotator/releases) · [第三方声明](THIRD_PARTY_NOTICES.md)
