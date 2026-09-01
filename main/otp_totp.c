#include "otp_totp.h"

#include "otp_core.h"

#include "mbedtls/md.h"

#include <string.h>

static mbedtls_md_type_t md_type_for(uint8_t algorithm)
{
    switch (algorithm) {
    case OTP_ALG_SHA256:
        return MBEDTLS_MD_SHA256;
    case OTP_ALG_SHA512:
        return MBEDTLS_MD_SHA512;
    default:
        return MBEDTLS_MD_SHA1;
    }
}

esp_err_t otp_totp_code(const otp_entry_t *entry, uint64_t unix_seconds, char *out,
                        size_t out_size)
{
    if (out == NULL || out_size == 0U) {
        return ESP_ERR_INVALID_ARG;
    }
    out[0] = '\0';
    if (!otp_entry_is_valid(entry)) {
        return ESP_ERR_INVALID_ARG;
    }

    const mbedtls_md_info_t *info = mbedtls_md_info_from_type(md_type_for(entry->algorithm));
    if (info == NULL) {
        return ESP_ERR_NOT_SUPPORTED;
    }

    // RFC 4226：计数器是 8 字节大端。
    uint64_t counter = otp_counter(unix_seconds, entry->period);
    uint8_t message[8];
    for (int i = 7; i >= 0; i--) {
        message[i] = (uint8_t)(counter & 0xFFU);
        counter >>= 8;
    }

    uint8_t digest[64];  // SHA-512 的输出长度
    int rc = mbedtls_md_hmac(info, entry->secret, entry->secret_len, message, sizeof(message),
                             digest);
    if (rc != 0) {
        return ESP_FAIL;
    }

    size_t digest_len = mbedtls_md_get_size(info);
    otp_format_code(otp_truncate(digest, digest_len), entry->digits, out, out_size);
    // 摘要是由密钥直接派生的，用完即抹，不留在栈上等着被下一次调用看见。
    memset(digest, 0, sizeof(digest));
    return ESP_OK;
}
