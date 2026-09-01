# 自定义品牌图标

放在这里的 SVG 会和 `@thesvg/icons` 的图标一样被烘焙进
`src/lib/icons/brands.generated.ts`——用于上游图标库里没有的服务。

## 怎么加一个

1. 拿到该服务的 SVG logo（官网、品牌资源页，或浏览器里对着 logo 另存为）。
2. 存成 `<slug>.svg`，slug 用小写字母数字，和你希望匹配的发行方名字对应。
   例如发行方叫 `M-Team`，归一化后是 `mteam`，文件就叫 `mteam.svg`。
3. 在 `scripts/gen-brand-icons.mjs` 的 `CUSTOM_ICONS` 里登记标题与品牌主色。
4. 跑 `npm run icons`。

发行方名字的写法千奇百怪时，在 `src/lib/icons/resolve.ts` 的 `ALIASES` 里补一条
（比如 `dnbcom → dnb`）。名字会先经 `normalizeIssuerKey` 归一化：转小写、去掉所有
非字母数字字符，所以 `M-Team`、`m team`、`M.Team` 都会变成 `mteam`。

## 这些 SVG 会被怎么处理

和上游图标走**完全相同**的消毒管线（见 `scripts/gen-brand-icons.mjs` 顶部注释）：

- 白名单之外的元素与属性一律剔除（`<script>`、`<image>`、`on*` 等进不来）；
- `style="..."` 改写成表现属性，`<style>` 标签丢弃——本应用的 CSP 不含
  `unsafe-inline`，行内样式在浏览器里会被拦掉；
- 所有 `id` 加上 slug 前缀，`url(#...)` 引用同步改写——内联 SVG 的 id 是**文档级**
  的，不加前缀多个图标之间会串色；
- 根 `<svg>` 上可继承的 `fill` 等属性会被包进一层 `<g>`，避免丢失后变成黑色剪影。

所以直接从网上下载的 SVG 通常可以原样放进来，不需要手工清理。

## 注意

图标一旦放进来就会作为源码提交。商标归各自所有者所有，此处仅用于在本地列表中
识别自己的账号条目。
