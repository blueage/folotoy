#include "otp_core.h"

#include <stdio.h>
#include <string.h>

static bool text_is_printable_ascii(const char *text, size_t max_len)
{
    for (size_t i = 0; i < max_len; i++) {
        char c = text[i];
        if (c == '\0') {
            return true;
        }
        if (c < 0x20 || c > 0x7E) {
            return false;
        }
    }
    // 走到这里说明没有终止符：调用方给的缓冲区不是合法字符串。
    return false;
}

bool otp_entry_is_valid(const otp_entry_t *entry)
{
    if (entry == NULL) {
        return false;
    }
    if (entry->secret_len < OTP_SECRET_MIN || entry->secret_len > OTP_SECRET_MAX) {
        return false;
    }
    if (entry->digits < OTP_DIGITS_MIN || entry->digits > OTP_DIGITS_MAX) {
        return false;
    }
    if (entry->period < OTP_PERIOD_MIN) {
        return false;
    }
    if (entry->algorithm > OTP_ALG_SHA512) {
        return false;
    }
    if (!text_is_printable_ascii(entry->label, sizeof(entry->label))) {
        return false;
    }
    if (!text_is_printable_ascii(entry->issuer, sizeof(entry->issuer))) {
        return false;
    }
    // 空标签在屏幕上是一行空白，用户无从分辨是哪条服务。
    return entry->label[0] != '\0';
}

uint64_t otp_counter(uint64_t unix_seconds, uint8_t period)
{
    uint64_t step = (period == 0U) ? 30U : (uint64_t)period;
    return unix_seconds / step;
}

uint32_t otp_seconds_remaining(uint64_t unix_seconds, uint8_t period)
{
    uint64_t step = (period == 0U) ? 30U : (uint64_t)period;
    return (uint32_t)(step - (unix_seconds % step));
}

uint32_t otp_truncate(const uint8_t *hmac, size_t hmac_len)
{
    if (hmac == NULL || hmac_len < 20U) {
        return 0U;
    }
    size_t offset = (size_t)(hmac[hmac_len - 1U] & 0x0FU);
    uint32_t value = ((uint32_t)(hmac[offset] & 0x7FU) << 24) |
                     ((uint32_t)hmac[offset + 1U] << 16) |
                     ((uint32_t)hmac[offset + 2U] << 8) |
                     (uint32_t)hmac[offset + 3U];
    return value;
}

uint32_t otp_modulus(uint8_t digits)
{
    switch (digits) {
    case 7:
        return 10000000U;
    case 8:
        return 100000000U;
    default:
        return 1000000U;
    }
}

void otp_format_code(uint32_t truncated, uint8_t digits, char *out, size_t out_size)
{
    if (out == NULL || out_size == 0U) {
        return;
    }
    uint8_t width = (digits < OTP_DIGITS_MIN || digits > OTP_DIGITS_MAX) ? OTP_DIGITS_MIN : digits;
    // 缓冲按 u32 的十进制最大宽度取，而不是按 digits：编译器不知道
    // 取模已经把值压到位数以内，按位数开会触发截断告警。
    char plain[12];
    snprintf(plain, sizeof(plain), "%0*u", (int)width, (unsigned)(truncated % otp_modulus(width)));

    // 分组点：6 位取 3+3，7 位取 4+3，8 位取 4+4 —— 始终只插一个空格，
    // 长度因此可预期，右对齐的布局不会随位数跳动。
    size_t split = (width == 6U) ? 3U : 4U;
    size_t w = 0;
    for (size_t i = 0; i < width && w + 1U < out_size; i++) {
        if (i == split && w + 2U < out_size) {
            out[w++] = ' ';
        }
        out[w++] = plain[i];
    }
    out[w] = '\0';
}

uint32_t otp_crc32(uint32_t seed, const uint8_t *data, size_t len)
{
    uint32_t crc = ~seed;
    for (size_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int bit = 0; bit < 8; bit++) {
            uint32_t mask = (uint32_t)(-(int32_t)(crc & 1U));
            crc = (crc >> 1) ^ (0xEDB88320U & mask);
        }
    }
    return ~crc;
}

size_t otp_page_start(size_t count, size_t rows_per_page, size_t selected)
{
    if (rows_per_page == 0U || count == 0U) {
        return 0U;
    }
    if (selected >= count) {
        selected = count - 1U;
    }
    return (selected / rows_per_page) * rows_per_page;
}
