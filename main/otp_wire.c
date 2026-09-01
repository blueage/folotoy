#include "otp_wire.h"

#include "otp_core.h"

#include <string.h>

static uint16_t read_u16(const uint8_t *p)
{
    return (uint16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint32_t read_u32(const uint8_t *p)
{
    return (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) |
           ((uint32_t)p[3] << 24);
}

static int16_t read_i16(const uint8_t *p)
{
    return (int16_t)((uint16_t)p[0] | ((uint16_t)p[1] << 8));
}

static uint64_t read_u64(const uint8_t *p)
{
    uint64_t value = 0;
    for (int i = 7; i >= 0; i--) {
        value = (value << 8) | (uint64_t)p[i];
    }
    return value;
}

static void emit(otp_wire_cb_t cb, void *context, const otp_wire_event_t *event)
{
    if (cb != NULL) {
        cb(event, context);
    }
}

static void clear_staging(otp_wire_t *wire)
{
    memset(&wire->staging, 0, sizeof(wire->staging));
    wire->expected = 0;
    wire->received = 0;
    wire->crc = 0;
}

void otp_wire_reset(otp_wire_t *wire)
{
    memset(wire, 0, sizeof(*wire));
}

const otp_vault_t *otp_wire_staging(const otp_wire_t *wire)
{
    return &wire->staging;
}

static void fail(otp_wire_t *wire, otp_wire_cb_t cb, void *context, uint8_t ack, bool drop_staging)
{
    if (drop_staging) {
        clear_staging(wire);
    }
    otp_wire_event_t event = {
        .type = OTP_WIRE_EVENT_ERROR,
        .frame = wire->frame_type,
        .ack = ack,
        .received = wire->received,
        .expected = wire->expected,
    };
    emit(cb, context, &event);
}

// ENTRY payload：
//   index:u16 | digits:u8 | period:u8 | algorithm:u8
//   secret_len:u8 | secret[secret_len]
//   label_len:u8 | label[label_len]
//   issuer_len:u8 | issuer[issuer_len]
// 变长字段逐段推进游标：任何一段越界都判 ERR_LENGTH，不做部分接受。
static bool parse_entry(const uint8_t *payload, uint16_t len, uint16_t *index_out,
                        otp_entry_t *entry, uint8_t *ack)
{
    memset(entry, 0, sizeof(*entry));
    if (len < 8U) {
        *ack = OTP_ACK_ERR_LENGTH;
        return false;
    }

    size_t cursor = 0;
    *index_out = read_u16(&payload[cursor]);
    cursor += 2U;
    entry->digits = payload[cursor++];
    entry->period = payload[cursor++];
    entry->algorithm = payload[cursor++];

    uint8_t secret_len = payload[cursor++];
    if (secret_len > OTP_SECRET_MAX || cursor + secret_len > len) {
        *ack = (secret_len > OTP_SECRET_MAX) ? OTP_ACK_ERR_FIELD : OTP_ACK_ERR_LENGTH;
        return false;
    }
    memcpy(entry->secret, &payload[cursor], secret_len);
    entry->secret_len = secret_len;
    cursor += secret_len;

    if (cursor >= len) {
        *ack = OTP_ACK_ERR_LENGTH;
        return false;
    }
    uint8_t label_len = payload[cursor++];
    if (label_len > OTP_LABEL_MAX || cursor + label_len > len) {
        *ack = (label_len > OTP_LABEL_MAX) ? OTP_ACK_ERR_FIELD : OTP_ACK_ERR_LENGTH;
        return false;
    }
    memcpy(entry->label, &payload[cursor], label_len);
    entry->label[label_len] = '\0';
    cursor += label_len;

    if (cursor >= len) {
        *ack = OTP_ACK_ERR_LENGTH;
        return false;
    }
    uint8_t issuer_len = payload[cursor++];
    if (issuer_len > OTP_ISSUER_MAX || cursor + issuer_len > len) {
        *ack = (issuer_len > OTP_ISSUER_MAX) ? OTP_ACK_ERR_FIELD : OTP_ACK_ERR_LENGTH;
        return false;
    }
    memcpy(entry->issuer, &payload[cursor], issuer_len);
    entry->issuer[issuer_len] = '\0';
    cursor += issuer_len;

    // 多出来的尾巴意味着两端对字段的理解不同，宁可整帧拒收。
    if (cursor != len) {
        *ack = OTP_ACK_ERR_LENGTH;
        return false;
    }
    if (!otp_entry_is_valid(entry)) {
        *ack = OTP_ACK_ERR_FIELD;
        return false;
    }
    *ack = OTP_ACK_OK;
    return true;
}

static void handle_frame(otp_wire_t *wire, otp_wire_cb_t cb, void *context)
{
    const uint8_t *payload = wire->payload;
    uint16_t len = wire->payload_len;

    switch (wire->frame_type) {
    case OTP_FRAME_HELLO: {
        if (len != 1U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, false);
            return;
        }
        if (payload[0] != OTP_WIRE_VERSION) {
            fail(wire, cb, context, OTP_ACK_ERR_VERSION, true);
            return;
        }
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_HELLO,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_BEGIN: {
        if (len != 12U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, true);
            return;
        }
        uint16_t count = read_u16(payload);
        if (count > OTP_MAX_ENTRIES) {
            fail(wire, cb, context, OTP_ACK_ERR_TOO_MANY, true);
            return;
        }
        clear_staging(wire);
        wire->expected = count;
        wire->unix_seconds = read_u64(&payload[2]);
        wire->tz_minutes = read_i16(&payload[10]);
        // 0 是"没有时间"的哨兵：网页端总会带真实时间，测试里可以显式省略。
        wire->time_present = wire->unix_seconds > 0U;
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_BEGIN,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK,
                                   .expected = wire->expected,
                                   .unix_seconds = wire->unix_seconds,
                                   .tz_minutes = wire->tz_minutes };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_ENTRY: {
        if (wire->expected == 0U) {
            fail(wire, cb, context, OTP_ACK_ERR_SEQUENCE, true);
            return;
        }
        if (wire->received >= wire->expected) {
            fail(wire, cb, context, OTP_ACK_ERR_SEQUENCE, true);
            return;
        }
        uint16_t index = 0;
        uint8_t ack = OTP_ACK_OK;
        otp_entry_t entry;
        if (!parse_entry(payload, len, &index, &entry, &ack)) {
            fail(wire, cb, context, ack, true);
            return;
        }
        // 下标必须严格递增且连续：乱序或重发意味着上层丢过帧，
        // 此时继续拼装只会得到一份沉默的错误保险库。
        if (index != wire->received) {
            fail(wire, cb, context, OTP_ACK_ERR_SEQUENCE, true);
            return;
        }
        wire->staging.entries[wire->received] = entry;
        wire->crc = otp_crc32(wire->crc, payload, len);
        wire->received++;
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_PROGRESS,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK,
                                   .received = wire->received,
                                   .expected = wire->expected };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_COMMIT: {
        if (len != 4U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, true);
            return;
        }
        if (wire->received != wire->expected) {
            fail(wire, cb, context, OTP_ACK_ERR_SEQUENCE, true);
            return;
        }
        if (read_u32(payload) != wire->crc) {
            fail(wire, cb, context, OTP_ACK_ERR_CRC, true);
            return;
        }
        if (!wire->time_present) {
            fail(wire, cb, context, OTP_ACK_ERR_NO_TIME, true);
            return;
        }
        wire->staging.count = (uint8_t)wire->received;
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_COMMIT,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK,
                                   .received = wire->received,
                                   .expected = wire->expected,
                                   .unix_seconds = wire->unix_seconds,
                                   .tz_minutes = wire->tz_minutes };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_TIME: {
        if (len != 10U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, false);
            return;
        }
        uint64_t seconds = read_u64(payload);
        if (seconds == 0U) {
            fail(wire, cb, context, OTP_ACK_ERR_FIELD, false);
            return;
        }
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_TIME,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK,
                                   .unix_seconds = seconds,
                                   .tz_minutes = read_i16(&payload[8]) };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_WIPE: {
        if (len != 0U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, false);
            return;
        }
        clear_staging(wire);
        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_WIPE,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK };
        emit(cb, context, &event);
        return;
    }
    case OTP_FRAME_WIFI: {
        // ssid_len:u8 | ssid[] | pass_len:u8 | pass[]
        if (len < 2U) {
            fail(wire, cb, context, OTP_ACK_ERR_LENGTH, false);
            return;
        }
        size_t cursor = 0;
        uint8_t ssid_len = payload[cursor++];
        if (ssid_len > OTP_WIFI_SSID_LIMIT || cursor + ssid_len >= len) {
            fail(wire, cb, context,
                 ssid_len > OTP_WIFI_SSID_LIMIT ? OTP_ACK_ERR_FIELD : OTP_ACK_ERR_LENGTH, false);
            return;
        }
        memcpy(wire->wifi_ssid, &payload[cursor], ssid_len);
        wire->wifi_ssid[ssid_len] = '\0';
        cursor += ssid_len;

        uint8_t pass_len = payload[cursor++];
        if (pass_len > OTP_WIFI_PASS_LIMIT || cursor + pass_len != len) {
            fail(wire, cb, context,
                 pass_len > OTP_WIFI_PASS_LIMIT ? OTP_ACK_ERR_FIELD : OTP_ACK_ERR_LENGTH, false);
            return;
        }
        memcpy(wire->wifi_password, &payload[cursor], pass_len);
        wire->wifi_password[pass_len] = '\0';

        otp_wire_event_t event = { .type = OTP_WIRE_EVENT_WIFI,
                                   .frame = wire->frame_type,
                                   .ack = OTP_ACK_OK };
        emit(cb, context, &event);
        return;
    }
    default:
        fail(wire, cb, context, OTP_ACK_ERR_UNKNOWN_FRAME, true);
        return;
    }
}

void otp_wire_feed(otp_wire_t *wire, const uint8_t *data, size_t len, otp_wire_cb_t cb,
                   void *context)
{
    size_t cursor = 0;

    while (cursor < len) {
        if (wire->header_filled < OTP_WIRE_HEADER_SIZE) {
            wire->header[wire->header_filled++] = data[cursor++];
            if (wire->header_filled < OTP_WIRE_HEADER_SIZE) {
                continue;
            }
            wire->frame_type = wire->header[0];
            wire->payload_len = read_u16(&wire->header[1]);
            wire->payload_filled = 0;
            wire->skipping = wire->payload_len > OTP_WIRE_PAYLOAD_MAX;
            if (wire->payload_len == 0U) {
                if (wire->skipping) {
                    fail(wire, cb, context, OTP_ACK_ERR_LENGTH, true);
                } else {
                    handle_frame(wire, cb, context);
                }
                wire->header_filled = 0;
                wire->skipping = false;
            }
            continue;
        }

        size_t remaining = (size_t)wire->payload_len - wire->payload_filled;
        size_t available = len - cursor;
        size_t take = remaining < available ? remaining : available;
        if (!wire->skipping) {
            memcpy(&wire->payload[wire->payload_filled], &data[cursor], take);
        }
        wire->payload_filled = (uint16_t)(wire->payload_filled + take);
        cursor += take;

        if (wire->payload_filled == wire->payload_len) {
            if (wire->skipping) {
                fail(wire, cb, context, OTP_ACK_ERR_LENGTH, true);
            } else {
                handle_frame(wire, cb, context);
            }
            wire->header_filled = 0;
            wire->payload_filled = 0;
            wire->skipping = false;
        }
    }
}
