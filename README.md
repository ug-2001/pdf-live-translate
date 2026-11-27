# PDF 实时翻译（PDF Live Translate）

一个 Chrome / Edge 扩展（Manifest V3，无构建步骤）：把浏览器里的英文 PDF 用自带阅读器打开，段落随滚动实时译成中文，原文和译文左右对照。

参考 [zarazhangrui/youtube-digest](https://github.com/zarazhangrui/youtube-digest) 的做法：稳定 ID 分段、小批次请求、JSON 结构化返回、按 ID 对齐校验、低温度、结果本地缓存。只借思路，代码是重写的，因为这个仓库处理的是 YouTube 字幕，PDF 的字块提取和版面完全不同。

## 它怎么工作

1. 点扩展图标 → 读取当前标签页；如果 URL 是 PDF，交给扩展自带的阅读器（`viewer.html`）。
2. 阅读器用 pdf.js 渲染页面，同时抽取文字，按"行距中位数"把文本行合并成段落块（过长段落会在句号处切成两半，前半段先译先显示）。
3. 每个段落块绑一个 `IntersectionObserver`，滚动到可视区才入队翻译；同一时刻最多 2 个批次在飞。
4. 批次规则：默认每批 ≤ 4 段、≤ 3000 字符，超出就拆批；每段 ID 形如 `p1b3s0`，模型返回必须按 ID 对齐，缺失的段落标红可点重试。
5. 译文按原文字块的位置对齐到右侧一栏，读完自动上移避让，不会互相压住。
6. 结果按 `provider|model|目标语言|长度|FNV 哈希` 存进 `localStorage`，同一段只翻一次；换缩放或重开也不重复扣额度。

## 安装

1. 打开 `chrome://extensions`（Edge 用 `edge://extensions`）。
2. 打开右上角「开发者模式」。
3. 点「加载已解压的扩展程序」，选择这个文件夹：
   `C:\Users\ug\Documents\pdf-live-translate`
4. 想读本地文件的话，在该扩展卡片上点「详细信息」，把「允许访问文件网址」打开。

## 配置

点扩展图标 → 「打开设置」，或在扩展卡片上点「扩展程序选项」。

- **OpenAI 兼容接口（推荐）**：Base URL 填 `https://api.deepseek.com`，模型填 `deepseek-chat`（或你账号支持的模型），API Key 填自己的。Kimi、通义、OpenRouter 等只要兼容 `/chat/completions` 都能用，Base URL 带上版本号（如 `https://api.moonshot.cn/v1`）。
- **免费 Google 接口**：不用填 Key，走 `translate.googleapis.com` 的公开端点。本机实测可用（Chrome 会走系统代理），但它是非官方接口，限流和失效的风险由它自己承担。
- Key 只写进 `chrome.storage.local`，不出现在源码里，也不经过任何第三方服务器；扩散或提交代码前记得清掉。

设置页有「测试连接」，会翻译一句 *Attention is all you need.* 验证 Key 和网络。

## 用法

- 在浏览器打开 PDF → 点扩展图标 → 「翻译当前这个 PDF」。
- 本地文件：点「打开本地 PDF 文件 / 粘贴链接」，或直接把 PDF 拖到阅读器窗口里。
- 阅读器右上角：`原文页` 开关（默认开）、`显示译文` 开关、`图文对照 / 纯文本` 切换、`A− / A+` 英文字号、`−/+` 页面缩放、`设置`。
- 布局：**译文列在左、占主宽度（约 60%）**，原文扫描页在右侧窄栏；取消勾选「原文页」后原文完全隐藏，译文列占满整宽。
- 段落标红 = 翻译失败，点那一段会重试。

### 字体与字号

- 页面本体是 pdf.js 画的位图，其中的英文字体是 PDF 文件内嵌的，**改不了**。
- 「纯文本」模式会隐藏位图，用真正的 **Courier New** 排版英文，逐段与中文对照，适合长时间精读。
- 「图文对照」模式下，右栏每条译文上方的英文原文摘要也是 Courier New。
- `A− / A+` 调的是英文字号（默认 14px），中文自动跟随 +1px。设置记在阅读器页的 localStorage。

## 已知边界

- **扫描版 PDF** 没有文字层，抽不出文本，本页会提示"无可提取文字"，需要 OCR 后再处理。
- 双栏排版按栏内行距合并，跨栏的段落可能被拆成两段，不影响阅读。
- 翻译走网络，正文首屏会有 0.5–2 秒延迟；已译过的段落是即时的。
- 需要登录才能下载的 PDF：扩展用 `credentials: include` 带上你的 cookie 去取，多数站点可以；遇到 401/403 就把 PDF 先下载到本地，再用本地文件方式打开。
- 只在 Chromium 系（Chrome / Edge）测过；Firefox 的 MV3 差异没适配。

## 目录

```
manifest.json      扩展清单（storage / tabs / <all_urls>）
background.js      探测当前标签页、打开阅读器
popup.html/js      小面板：翻译当前 PDF / 打开本地文件 / 进设置
options.html/js    设置页（引擎、Base URL、模型、Key、批次参数）
viewer.html/css/js 阅读器：pdf.js 渲染 + 分块 + 实时翻译队列
shared.js          设置读写、翻译提供方、缓存、分批
textblocks.js      纯函数：pdf.js 文本 → 段落块（可在 Node 里单测）
vendor/            pdf.js 4.10.38（pdf.min.mjs + worker）
tools/             Node 冒烟测试脚本
```

## 自检

```powershell
node tools/smoke-textblocks.mjs "<some.pdf>" 60   # 分块效果
node tools/smoke-translate.mjs                    # 分批 + 真实翻译请求
```
