// main/otp_icons.h —— 条目图标的持久化。
//
// 图标**不和保险库放在一起**，理由是体积：30 张图约 15~35 KB，而 nvs 分区一共
// 才 0x6000。它们住在分区表里单独的 `icons` 分区（见 partitions.csv），
// 一条一格，键名就是下标。
//
// 图标与条目的对应关系不靠"写入顺序"保证，而是靠保险库里每条记着的 icon_crc：
// 读出来的位图算一遍 CRC，对不上就当没有图。于是"同步到一半失败"这种情况下，
// 卡上留着的新图不会被贴到旧条目旁边——最坏也只是那几行退回纯色块。
#pragma once

#include "esp_err.h"

#include <stddef.h>
#include <stdint.h>

// 挂载图标分区。分区不存在（老分区表）或格式化失败都不是致命错误：
// 令牌照常工作，只是列表里没有图标。
esp_err_t otp_icons_init(void);

// 写入一张图标。index 为条目下标。
esp_err_t otp_icons_save(uint8_t index, const uint8_t *blob, size_t len);

// 读出一张图标。没存过返回 ESP_ERR_NVS_NOT_FOUND。
esp_err_t otp_icons_load(uint8_t index, uint8_t *out, size_t capacity, size_t *out_len);

// 删掉一张图标。本来就没有时也算成功（幂等）。
esp_err_t otp_icons_erase(uint8_t index);

// 清空全部图标。没有图标时也算成功（幂等）。
esp_err_t otp_icons_clear(void);
