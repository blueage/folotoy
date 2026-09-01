// main/otp_totp.h —— 用 mbedtls 的 HMAC 算出一条条目在给定时刻的验证码。
// 纯逻辑部分（计数、截断、格式化）在 otp_core.h，本文件只做"取 HMAC"这一步。
#pragma once

#include "otp_types.h"

#include "esp_err.h"

#include <stdint.h>

// 算出 unix_seconds 时刻的验证码文本（已按 3/4 位分组插空格）。
// out 需要 OTP_CODE_TEXT_MAX 字节。失败时 out 被写成空串。
esp_err_t otp_totp_code(const otp_entry_t *entry, uint64_t unix_seconds, char *out,
                        size_t out_size);
