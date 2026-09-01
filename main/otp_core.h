// main/otp_core.h —— 不依赖 ESP-IDF 的纯逻辑：TOTP 计数与截断、显示格式、
// CRC32、列表分页。tests/test_otp_core.c 在主机上直接编译这些实现。
#pragma once

#include "otp_types.h"

#include <stddef.h>
#include <stdint.h>

// RFC 6238 的时间步计数：floor(unix / period)。period 为 0 时按 30 处理，
// 避免除零把整块 UI 拖垮（调用方通常已经用 otp_entry_is_valid 挡掉了）。
uint64_t otp_counter(uint64_t unix_seconds, uint8_t period);

// 当前时间步内剩余的秒数，范围 1..period。用于倒计时显示。
uint32_t otp_seconds_remaining(uint64_t unix_seconds, uint8_t period);

// RFC 4226 §5.3 的动态截断。hmac_len < 20 时返回 0（调用方应先判断长度）。
uint32_t otp_truncate(const uint8_t *hmac, size_t hmac_len);

// 10^digits，digits 超出 6..8 时按 6 处理。
uint32_t otp_modulus(uint8_t digits);

// 把截断值格式化成左侧补零的验证码，中间按 3 位分组插一个空格：
// "123 456" / "1234 567" / "1234 5678"。out 需要至少 OTP_CODE_TEXT_MAX 字节。
#define OTP_CODE_TEXT_MAX 12
void otp_format_code(uint32_t truncated, uint8_t digits, char *out, size_t out_size);

// 线格式的 CRC32（IEEE 802.3 反射多项式 0xEDB88320，初值/终值取反）。
uint32_t otp_crc32(uint32_t seed, const uint8_t *data, size_t len);

// 列表分页：给定条目总数、每页行数与选中项，返回该页的首行下标。
// 选中项始终落在页内，翻页以整页为单位，避免逐行滚动时行内容抖动。
size_t otp_page_start(size_t count, size_t rows_per_page, size_t selected);
