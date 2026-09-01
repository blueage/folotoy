# FoloPass 2FA — 网页端

在浏览器里导入 2FAS Auth 备份文件（`.2fas` / `.json`），本地解密并实时生成 TOTP 验证码，
再把挑好的一批令牌通过 Web Bluetooth 推送到 **FoloToy AI Passport 工卡**上。

> 本目录由同作者的 quick2fas 查看器演进而来：查看器部分的设计文档仍留在
> `docs/plans/quick2fas-web-viewer/`，工卡同步部分的契约在仓库根的
> [`docs/protocol.zh_CN.md`](../docs/protocol.zh_CN.md)。

**零后端**：没有服务端运行时、没有数据库、没有账号系统。构建产物是一组静态文件，所有解析、
解密与验证码计算都在浏览器中完成。应用支持 PWA 安装，首次加载后可完全离线使用。

技术栈：React + TypeScript + Vite + Tailwind CSS + `vite-plugin-pwa`。

提供两种构建形态：

- **静态站点**（`npm run build` → `dist/`）：常规部署，带 PWA 离线支持；
- **单文件**（`npm run build:file` → `dist-file/folopass-2fa.html`）：一个自足的 HTML，
  双击即可用，不需要任何服务器。见下文「单文件构建」。
  ⚠️ 单文件形态**没有来源隔离**，安全性弱于静态站点，动手前先读「安全须知」。

## 安全须知（务必先读）

把 TOTP 种子放进浏览器，会**瓦解「手机 / 电脑」这层分离** —— 而这层分离正是两步验证之所以是
「第二个」因素的原因。任何能在本应用来源（origin）上执行代码的人（XSS），或者能直接操作你已经
打开的浏览器的人，都可以读取全部种子。

本应用会把条目加密后存入 IndexedDB，包裹密钥以 `extractable: false` 生成。这只提高了**离线翻取
浏览器数据目录**的门槛，**不能**防御来源上的 XSS，也**不能**防御正在操作你浏览器的攻击者。

请在明确接受这一取舍后再使用，并优先把它部署在你自己控制的来源上。

### 单文件版（`file://`）的额外风险 —— 比站点部署更弱

**实测结论：同一浏览器下，所有 `file://` 页面共用同一个存储源。**（复现方法：把
`scripts/probe-file-origin.html` 放到与 `folopass-2fa.html` 不同的目录再双击打开。）

这意味着单文件版**没有来源隔离**：

- 你随手打开的**任何一个本地 HTML 文件**——下载的报表、别人发来的附件、某个工具导出的
  预览页——都能读到本应用的 IndexedDB；
- 它不仅能读到密文条目，还能直接取到那把包裹密钥。**`extractable: false` 只阻止导出原始
  密钥材料，不阻止使用它**：拿到 `CryptoKey` 对象就能调 `crypto.subtle.decrypt`，解出全部种子；
- 站点部署（HTTPS）不存在这个问题：来源隔离由浏览器强制，别的网站读不到你这个来源的
  IndexedDB。

所以这两种形态的安全性**不对等**：

| | 静态站点（HTTPS） | 单文件（`file://`） |
| --- | --- | --- |
| 来源隔离 | 有，浏览器强制 | **无，所有本地文件共用一个源** |
| 谁能读到保险库 | 该来源上的代码（XSS） | 该浏览器打开的**任意**本地 HTML |
| 包裹密钥能否被他人使用 | 否（跨来源取不到） | **能** |

单文件版的便利（零部署、拷走就能用）是拿这一层隔离换来的。**如果你的机器上会打开来路不明的
本地 HTML 文件，请用静态站点形态，不要用单文件版。**

> 想彻底规避的话，可选的方向是让单文件版不落盘（打开即导入、关闭即忘），用每次重新导入换回
> 隔离。当前**未实现**——单文件版与站点版共用同一套 IndexedDB 持久化。

## 环境要求

Node.js ≥ 20，npm ≥ 10。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm install` | 安装依赖 |
| `npm run dev` | 启动开发服务器（热更新） |
| `npm run build` | 类型检查并构建生产产物到 `dist/` |
| `npm run build:file` | 构建单文件产物 `dist-file/folopass-2fa.html` 并校验其自足性 |
| `npm run preview` | 在本地预览 `dist/` 产物（最接近线上行为） |
| `npm run lint` | ESLint 检查 |
| `npm run typecheck` | `tsc --noEmit` 严格类型检查 |
| `npm test` | 运行 Vitest（单次执行，非 watch 模式） |
| `npm run icons` | 重新生成品牌图标模块（见「条目图标」） |

## 部署

`npm run build` 产出的 `dist/` 是纯静态目录，直接把它整体上传到任意静态托管即可
（对象存储 + CDN、Nginx、GitHub Pages、Cloudflare Pages 等），无需任何后端进程。

两点注意：

1. **必须使用 HTTPS**（`localhost` 除外）。WebCrypto 与 Service Worker 都只在安全上下文中可用，
   否则解密与离线能力都会失效。
2. 应用默认部署在**站点根路径** `/`。如果要部署到子路径，需要同时调整 `vite.config.ts` 的 `base`
   以及 `public/manifest.webmanifest` 里的 `start_url` / `scope`。

`dist/sw.js` 由 Workbox 生成，会预缓存全部构建产物；升级时正常覆盖部署即可，Service Worker 会在
下次加载时拉取新版本。

## 单文件构建

```
npm run build:file      # → dist-file/folopass-2fa.html（约 412 KB，零外部引用）
```

产物是**单独一个 HTML 文件**，把它拷到任何地方双击打开即可使用，不需要 `npm run preview`，
也不需要任何静态服务器。JS、CSS、图标全部内联在文件内部。

> ⚠️ **先读「安全须知 → 单文件版（`file://`）的额外风险」。** 这个形态没有来源隔离：
> 同一浏览器打开的任意本地 HTML 都能读到保险库并解密。CSP 再严也挡不住这一点——
> CSP 约束的是本页面能加载什么，管不到别的页面能读什么。

`file://` 与常规部署有三条相反的约束，`vite.config.file.ts` 逐条处理：

1. **外部 module script 取不到。** `file://` 页面的源是不透明的，
   `<script type="module" src="...">` 会被 CORS 拦截。因此 JS/CSS 必须全部内联
   （内联的 module script 不发请求，可以正常执行）。
2. **Service Worker 无法注册。** PWA 那一套在 `file://` 下没有意义，单文件构建整体去掉，
   因此它没有「离线缓存」的概念 —— 文件本身就是全部。
3. **内联脚本与 `script-src 'self'` 冲突。** 这里不退让成 `'unsafe-inline'`，而是在构建后
   计算内联块的 sha256 写进 CSP。单文件版的 CSP 因此比站点版更严：

   ```
   default-src 'none'; script-src 'sha256-…'; style-src 'sha256-…';
   img-src data:; font-src data:; connect-src 'none'; object-src 'none';
   base-uri 'none'; form-action 'none'; frame-ancestors 'none'
   ```

`scripts/verify-file-build.mjs` 挂在构建流程末尾，逐项校验产物：目录里只有一个文件、没有任何
外部 `src`/`href`、CSP 哈希与内联块的实际内容一致、没有 `unsafe-inline` / `unsafe-eval`、
没有残留的 Service Worker 注册。任一项不过则构建失败 —— 这些问题一旦漏出去，
表现是双击后白屏，而构建本身照样「成功」。

## 推送到工卡

页脚的「同步到工卡」打开工卡面板，它做四件事：连接、挑条目、改工卡上的显示名、推送。

**运行条件**：Web Bluetooth 只在桌面版 Chrome / Edge 与安卓 Chrome 上可用，且页面必须是
**HTTPS 或 localhost**。iOS Safari 不支持。**单文件形态（`file://`）用不了**——
那不是安全上下文，蓝牙与 WebCrypto 都会被禁用。

几处刻意的设计：

- **顺序不在面板里改。** 工卡上的顺序就是主列表的顺序（拖左侧图标调整）。
  两个地方都能排序，"到底哪个说了算"就没法回答了。
- **推送是整体替换。** 勾中的条目就是推送后卡上的全部条目；工卡侧只有 COMMIT 成功
  才生效，中途失败不会留下半份保险库。
- **中文名会被挡下，而不是推一行豆腐块上卡。** 工卡只有 Montserrat 拉丁字体。
  面板里每条都有一个「工卡上的名字」输入框，清空即回到自动推导（发行方 → 服务名）。
  这个名字跟着条目一起加密存放——名字本身也是"你在用哪些服务"的线索。
- **推送顺带对时，也带时区。** 工卡冷启动后没有可信时间就不显示验证码，因此 BEGIN 帧里
  带当前时刻与浏览器时区（工卡顶栏显示本地时间靠它）。只想对时不动条目时用「只对时」。

### 开机自动对时（Wi-Fi）

面板里可以存一个 2.4 GHz Wi-Fi 到工卡（`WIFI` 帧，协议 v2）。工卡每次开机连上去做一次
SNTP 对时，**对完 `esp_wifi_deinit()` 把协议栈整个拆掉**，之后不再联网。

两处要留意：

- **密码经不加密的 BLE 链路下发，并明文存在工卡的 NVS 里**，与令牌种子同等对待。
  给工卡一个访客网络，别用主网络的密码。
- 保存成功后页面**立即清空密码输入框**：它已经在工卡上了，留在页面状态里只是多一处泄露面。

工卡侧的容量、协议与落盘格式见 [`../docs/protocol.zh_CN.md`](../docs/protocol.zh_CN.md)，
链路的安全取舍见 [`../docs/security.zh_CN.md`](../docs/security.zh_CN.md)。

### 代码结构

| 文件 | 职责 |
| --- | --- |
| `src/lib/badge/limits.ts` | 与固件 `main/otp_types.h` 一一对应的硬边界 + 名字清洗 |
| `src/lib/badge/protocol.ts` | 帧编解码、CRC32、通知重组（纯函数） |
| `src/lib/badge/entry.ts` | 保险库条目 → 工卡条目的转换与拒绝理由 |
| `src/lib/badge/sync.ts` | 推送、对时、Wi-Fi 配置、清空；只依赖 `BadgeLink` 接口，不认识蓝牙 |
| `src/lib/badge/ble.ts` | Web Bluetooth 实现（连接、20 字节一块写、通知） |
| `src/lib/badge/fakeBadge.ts` | 照着协议文档重新实现的假工卡，供测试对接 |
| `src/components/BadgePanel.tsx` | 面板界面 |

`fakeBadge.ts` 刻意不复用编码器的中间结果：两端理解不一致（字段顺序、端序、CRC 覆盖范围）
会在测试里直接暴露，而不是等到真机上表现为"工卡一直拒收"。

## 条目操作与键盘

除搜索与复制外，列表还支持**删除单条**与**拖拽排序**（设计文档 D2 已按此修订，见其中的
D2-history）。备份文件仍是条目**内容**的唯一来源：应用不提供新增、编辑、改名、分组。

| 操作 | 鼠标 | 键盘 |
| --- | --- | --- |
| 复制验证码 | 点击行的中间区域 | Tab 到该行后回车 |
| 删除条目 | 移到行的**右上角**，浮现小 ✕，点击后二次确认 | Tab 到删除按钮（聚焦即显形） |
| 调整顺序 | 拖动左侧的品牌图标 | 聚焦图标后按 ↑ / ↓ |
| 搜索 | 点输入框 | **直接打字**即可，`Esc` 清空 |

几处刻意的设计，改动前请先了解：

- **拖拽过程中绝不重排 DOM。** 浏览器一旦发现被拖拽的源节点被移动就会中止拖拽（表现为"排序
  无效"），而重排又会让光标下的元素随之改变、触发新一轮 `dragOver`，形成来回抖动。落点只用
  一条绝对定位的指示线表示，松手后才整体提交。`TokenList.test.tsx` 有回归用例守着。
- **搜索状态下禁用排序**：过滤时拖拽只能得到一个覆盖子集的顺序，语义含糊。
- **顺序存在密文之外**（见下节），因此重排不需要包裹密钥、也不重新加密。
- **"直接打字即搜索"只移动焦点、不吞事件**（`src/hooks/useTypeToSearch.ts`）：在 `keydown`
  阶段聚焦输入框后，浏览器会把该字符落进新的焦点元素。自己拼字符串会在输入法组词、按住重复
  时出错。组合键、功能键、方向键（留给拖拽排序）、以及面板打开时一律放行。

### 显示顺序的存储

顺序作为明文字段存在每条记录上、**位于密文之外**：重排只改这个数字，既不需要包裹密钥也不必
重新加密（顺序本身不是秘密，记录 id 早已是明文主键）。`load()` 据此排序——注意 IndexedDB 的
`getAll()` 返回的是**主键顺序**，不排序的话显示次序会是 id 字典序而非备份文件里的次序。
引入排序之前写入的记录没有这个字段，会退回 `getAll` 的返回顺序。

## 条目图标

列表里每个条目左侧的图标由 `src/components/ServiceIcon.tsx` 决定，两层策略：

- **品牌彩色图标**：`src/lib/icons/brands.generated.ts` 里内置了一批常见发行方的官方彩色标志，
  由 `npm run icons`（`scripts/gen-brand-icons.mjs`）从 [theSVG](https://thesvg.org/) 烘焙而来。
  上游完整包解包后约 76MB，与单文件形态冲突，因此只固化用得上的那些；它本身仅是
  `devDependency`，产物里没有它的运行时代码。
- **首字母色块**：认不出的发行方回退到一个稳定配色的字母块（同一名字永远同一颜色）。

改动图标集合后重跑 `npm run icons`，它会报告消毒统计与缺失项。

### 发行方名字怎么匹配

`src/lib/icons/resolve.ts` 先归一化（转小写、去掉非字母数字字符、**保留中日韩字符**，否则中文名
会被清成空串），再按四步匹配，顺序不能调换：

1. **精确** → 2. **别名表** → 3. **剥掉 `.com` 等后缀** → 4. **最长子串** → 5. **按主机名分段**

分段匹配必须排在最长子串**之后**：否则 `Google Cloud Platform` 会被 `google` 这一段抢走，拿不到
更精确的 Google Cloud。而它又不可或缺——`sso.dnb.com` 归一化成 `ssodnbcom`，其中 `dnb` 只有
3 个字符、低于子串匹配的长度门槛（门槛是为了防止 `x`、`qq` 这类短名字乱匹配），只有按点切开
才能命中。

别名表覆盖 `Gmail → Google`、`Twitter → X`，以及 `微信` / `支付宝` / `知乎` 等中文名。

### 消毒管线（改动生成脚本前必读）

上游 SVG 直接内联进页面会踩三个坑，每一个都是**静默**出错——不报错，只是渲染不对：

| 问题 | 后果 | 处理 |
| --- | --- | --- |
| `style="..."` 属性 | CSP 无 `unsafe-inline` → 被拦截，掉填充 | 改写成等价的表现属性 |
| `<style>` 标签 + `class` | 同上；Illustrator 导出几乎都是这个形态 | 先解析类规则落成属性，再剔除 |
| `id="a"` 这类短 id | 内联 SVG 的 id 是**文档级**的，`url(#a)` 命中第一个 → 渐变串色 | 全部加 slug 前缀，引用同步改写 |

此外：白名单之外的元素与属性一律剔除（`<script>`、`<image>`、`on*` 进不来）；根 `<svg>` 上可继承
的 `fill` 会被包进一层 `<g>`（只取 `innerHTML` 会丢掉它，图标退化成黑色剪影）；非方形 viewBox
居中扩成正方形（否则 `preserveAspectRatio` 的信箱留白会让底色只铺中间一条带）；全部填充都很亮的
"反白 logo" 会被标记 `onDark`，组件改用品牌色实底而非白底，否则它在浅色底上等于消失。

消毒结果作为源码提交、可在 diff 里审阅，运行时不再解析任何东西。`resolve.test.ts` 里有一组消毒
契约测试（无脚本/无 `style`/id 带前缀/都有着色），破了任一条都会失败。

### 加一个上游没有的图标

见 [`assets/brand-icons/README.md`](assets/brand-icons/README.md)。简言之：把 SVG 存成
`assets/brand-icons/<slug>.svg`，在生成脚本的 `CUSTOM_ICONS` 里登记标题与主色，重跑
`npm run icons`。自定义图标走**完全相同**的消毒管线，因此从网上直接下载的 SVG 通常无需手工清理。

### 颜色为什么都走 SVG 属性

图标底色、行底色、倒计时圆环的进度，全部通过 SVG 的 `fill` / `stroke` / `strokeDasharray`
**表现属性**下发，而非行内 `style` —— CSP 不允许 `unsafe-inline`，行内样式在真实浏览器里会被
拦掉。颜色随条目而变、Tailwind 表达不了任意 hex 时，这是唯一的干净出路。

> 整行的品牌色叠加还额外依赖行上的 `isolate`：`position: relative` 在 `z-index: auto` 时
> **不创建层叠上下文**，那层 `-z-10` 会跑到更外层、排在本行不透明背景之前而被完全盖住
> （表现为"底色没变"）。两个类是绑定的，测试里一起断言。

## 内容安全策略与第三方资源

`index.html` 内置一条 CSP `<meta>`：

```
default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:;
font-src 'self'; connect-src 'self'; manifest-src 'self'; worker-src 'self';
object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'none'
```

生产构建**不需要**任何 `unsafe-inline` / `unsafe-eval` 豁免：

- `build.modulePreload.polyfill` 已关闭，避免 Vite 向 HTML 注入内联脚本；
- `vite-plugin-pwa` 使用 `injectRegister: 'script'`，Service Worker 注册脚本是独立的
  `registerSW.js` 文件而非内联脚本；
- Tailwind 经 PostCSS 编译为独立的 `.css` 文件，样式不内联。

构建后可自行核对：`dist/index.html` 中只有两个带 `src` 的外部脚本，没有内联 `<script>`。

**开发模式例外**：`npm run dev` 时，Vite 必须注入内联的 react-refresh 前导脚本并以内联 `<style>`
注入样式。因此 `vite.config.ts` 中的 `stripCspInDev` 插件仅在 dev 下移除这条 meta；`vite build`
的产物不受影响，CSP 原样保留。

应用不引用任何第三方 CDN、远程字体或远程图标；字体使用系统字体栈，图标是仓库内的同源 SVG。
运行时除首次加载资源外不发起任何网络请求（无遥测、无时间同步）。

## 测试

Vitest + jsdom，配合 `@testing-library/react`、`@testing-library/jest-dom` 与
`fake-indexeddb/auto`（在 `src/test/setup.ts` 中注册）。

```
npm test                      # 全部测试
npx vitest run src/App.test.tsx   # 单个文件
```

测试中不会出现任何真实密钥、真实备份文件或真实账号；涉及备份格式的用例一律使用测试代码自行
生成的合成数据。
