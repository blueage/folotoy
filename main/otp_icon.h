// main/otp_icon.h —— 条目图标的位图格式（纯逻辑，可在主机上测试）。
//
// 工卡上不认识任何品牌，也没有矢量渲染器：列表里那块斜着的图标是**网页画好的**，
// 按本文件的格式压成一小块字节推过来（见 docs/protocol.zh_CN.md 的「图标位图」）。
// 固件只做两件事：检查它结构完整，以及把它铺回一块 RGB565 像素。
//
// 为什么是"调色板 + 4bpp + 行程编码"：
//   - 图标是纯色块拼出来的（白底 + 一层品牌色 + logo 本身几种颜色），
//     16 色足够，连边缘抗锯齿的过渡色都放得下；
//   - 直接发 RGB565 要 48×48×2 = 4.6 KB/张，30 张就是 130 KB，
//     以 20 字节一次写的 BLE 速度得传好几分钟；4bpp + 行程编码后一般在 400~600 字节。
//   - 透明度留在调色板里（每种颜色一个 alpha）：图标是斜着的方块，四角露出行底色，
//     而行底色会随"是否选中"变化，因此不能把底色烤进位图。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 图标在屏幕上的像素尺寸。它同时是三处的契约：网页的光栅化画布、本文件的位图、
// otp_ui.c 里那块画布。任何一处改动都必须同时改 web/src/lib/badge/icon.ts，
// 否则工卡会拒收整批图标（几何对不上）。
#define OTP_ICON_W 48
#define OTP_ICON_H 48
#define OTP_ICON_PIXELS ((size_t)OTP_ICON_W * (size_t)OTP_ICON_H)

#define OTP_ICON_BLOB_VERSION 1
#define OTP_ICON_PALETTE_MAX 16

// 单张图标的字节上限。最坏情况是"没有任何相邻同色像素"：
// 头 4 + 调色板 48 + 字面量分段开销 10×2 + 像素 2304/2 = 1224 字节。
// 取 1280 留出余量，同时它也是 otp_wire_t 里那块装配缓冲的大小。
#define OTP_ICON_BLOB_MAX 1280

// 结构检查：版本、几何、调色板、行程流是否正好铺满 OTP_ICON_PIXELS 个像素。
// 不需要输出缓冲，因此 BLE 收帧时就能判——4.6 KB 的展开缓冲不该出现在那条栈上。
bool otp_icon_blob_check(const uint8_t *blob, size_t len);

// 把图标铺进一块 RGB565 像素。半透明像素按 alpha 与 bg 混合：工卡的图标是斜着的
// 方块，四角本来就该露出行底色，而行底色随选中状态变化——所以混合在这里做，
// 而不是让网页把底色烤进位图。
//
// out_pixels 必须 >= OTP_ICON_PIXELS。任何一处不合法都整体返回 false，
// 不写半张图：半张图比没有图更难看出"这张图坏了"。
bool otp_icon_expand(const uint8_t *blob, size_t len, uint16_t bg, uint16_t *out,
                     size_t out_pixels);

// 0xRRGGBB → RGB565。UI 里的常量都是 24 位十六进制，屏幕却是 16 位。
uint16_t otp_icon_rgb565(uint32_t rgb888);

// RGB565 → 0xRRGGBB。条目里的品牌色是 565（省两个字节），而行底色要和
// UI_PAPER 这类 24 位常量混色，得先还原回来。
uint32_t otp_icon_rgb888(uint16_t rgb565);
