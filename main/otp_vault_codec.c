#include "otp_vault_codec.h"

#include <string.h>

// "2FAV"：魔数变了说明这块 blob 不是本应用写的。
#define OTP_VAULT_MAGIC 0x56414632U

static void write_u32(uint8_t *out, uint32_t value)
{
    for (int i = 0; i < 4; i++) {
        out[i] = (uint8_t)((value >> (8 * i)) & 0xFFU);
    }
}

static uint32_t read_u32(const uint8_t *in)
{
    return (uint32_t)in[0] | ((uint32_t)in[1] << 8) | ((uint32_t)in[2] << 16) |
           ((uint32_t)in[3] << 24);
}

bool otp_vault_encode(const otp_vault_t *vault, uint8_t *out, size_t capacity, size_t *out_len)
{
    if (vault == NULL || out == NULL || out_len == NULL || capacity < 6U) {
        return false;
    }
    if (vault->count > OTP_MAX_ENTRIES) {
        return false;
    }

    size_t w = 0;
    write_u32(&out[w], OTP_VAULT_MAGIC);
    w += 4U;
    out[w++] = OTP_VAULT_BLOB_VERSION;
    out[w++] = vault->count;

    for (uint8_t i = 0; i < vault->count; i++) {
        const otp_entry_t *entry = &vault->entries[i];
        if (!otp_entry_is_valid(entry)) {
            return false;
        }
        size_t label_len = strlen(entry->label);
        size_t issuer_len = strlen(entry->issuer);
        size_t need = 4U + entry->secret_len + 1U + label_len + 1U + issuer_len;
        if (w + need > capacity) {
            return false;
        }
        out[w++] = entry->digits;
        out[w++] = entry->period;
        out[w++] = entry->algorithm;
        out[w++] = entry->secret_len;
        memcpy(&out[w], entry->secret, entry->secret_len);
        w += entry->secret_len;
        out[w++] = (uint8_t)label_len;
        memcpy(&out[w], entry->label, label_len);
        w += label_len;
        out[w++] = (uint8_t)issuer_len;
        memcpy(&out[w], entry->issuer, issuer_len);
        w += issuer_len;
    }

    *out_len = w;
    return true;
}

bool otp_vault_decode(const uint8_t *data, size_t len, otp_vault_t *vault)
{
    if (data == NULL || vault == NULL || len < 6U) {
        return false;
    }
    memset(vault, 0, sizeof(*vault));

    if (read_u32(data) != OTP_VAULT_MAGIC) {
        return false;
    }
    if (data[4] != OTP_VAULT_BLOB_VERSION) {
        return false;
    }
    uint8_t count = data[5];
    if (count > OTP_MAX_ENTRIES) {
        return false;
    }

    size_t cursor = 6U;
    for (uint8_t i = 0; i < count; i++) {
        if (cursor + 4U > len) {
            return false;
        }
        otp_entry_t *entry = &vault->entries[i];
        entry->digits = data[cursor++];
        entry->period = data[cursor++];
        entry->algorithm = data[cursor++];
        uint8_t secret_len = data[cursor++];
        if (secret_len > OTP_SECRET_MAX || cursor + secret_len >= len) {
            return false;
        }
        memcpy(entry->secret, &data[cursor], secret_len);
        entry->secret_len = secret_len;
        cursor += secret_len;

        uint8_t label_len = data[cursor++];
        if (label_len > OTP_LABEL_MAX || cursor + label_len >= len) {
            return false;
        }
        memcpy(entry->label, &data[cursor], label_len);
        entry->label[label_len] = '\0';
        cursor += label_len;

        uint8_t issuer_len = data[cursor++];
        if (issuer_len > OTP_ISSUER_MAX || cursor + issuer_len > len) {
            return false;
        }
        memcpy(entry->issuer, &data[cursor], issuer_len);
        entry->issuer[issuer_len] = '\0';
        cursor += issuer_len;

        if (!otp_entry_is_valid(entry)) {
            return false;
        }
    }

    // 尾部还有没读完的字节：格式对不上，按损坏处理。
    if (cursor != len) {
        return false;
    }
    vault->count = count;
    return true;
}
