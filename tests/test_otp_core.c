// tests/test_otp_core.c —— 主机侧纯逻辑测试：TOTP 截断与格式、CRC32、分页、
// 以及 BLE 线格式的流式解析。不依赖 ESP-IDF，cc 直接编译即可运行。
#include "otp_core.h"
#include "otp_vault_codec.h"
#include "otp_wire.h"

#include <assert.h>
#include <stdio.h>
#include <string.h>

static int g_checks;

#define CHECK(cond)                                                                    \
    do {                                                                               \
        g_checks++;                                                                    \
        if (!(cond)) {                                                                 \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);            \
            return 1;                                                                  \
        }                                                                              \
    } while (0)

static int test_counter(void)
{
    CHECK(otp_counter(0, 30) == 0);
    CHECK(otp_counter(59, 30) == 1);
    CHECK(otp_counter(1111111109ULL, 30) == 0x23523ECULL);
    // period 为 0 时按 30 秒兜底，绝不除零。
    CHECK(otp_counter(59, 0) == 1);

    CHECK(otp_seconds_remaining(0, 30) == 30);
    CHECK(otp_seconds_remaining(1, 30) == 29);
    CHECK(otp_seconds_remaining(29, 30) == 1);
    CHECK(otp_seconds_remaining(30, 30) == 30);
    return 0;
}

static int test_truncate_and_format(void)
{
    // RFC 4226 附录 D：密钥 "12345678901234567890"、计数 0 时的 HMAC-SHA1，
    // 动态截断得 0x4C93CF18 = 1284755224，六位码 755224。
    const uint8_t hmac[20] = { 0xcc, 0x93, 0xcf, 0x18, 0x50, 0x8d, 0x94, 0x93, 0x4c, 0x64,
                               0xb6, 0x5d, 0x8b, 0xa7, 0x66, 0x7f, 0xb7, 0xcd, 0xe4, 0xb0 };
    uint32_t truncated = otp_truncate(hmac, sizeof(hmac));
    CHECK(truncated == 1284755224U);
    CHECK(truncated % otp_modulus(6) == 755224U);

    char text[OTP_CODE_TEXT_MAX];
    otp_format_code(truncated, 6, text, sizeof(text));
    CHECK(strcmp(text, "755 224") == 0);
    otp_format_code(truncated, 7, text, sizeof(text));
    CHECK(strcmp(text, "4755 224") == 0);
    otp_format_code(truncated, 8, text, sizeof(text));
    CHECK(strcmp(text, "8475 5224") == 0);
    // 前导零必须保留：把 000 001 显示成 1 是错的验证码。
    otp_format_code(1U, 6, text, sizeof(text));
    CHECK(strcmp(text, "000 001") == 0);
    // 位数非法时退回 6 位，不越界写。
    otp_format_code(truncated, 42, text, sizeof(text));
    CHECK(strcmp(text, "755 224") == 0);

    CHECK(otp_truncate(NULL, 20) == 0);
    CHECK(otp_truncate(hmac, 3) == 0);
    return 0;
}

static int test_crc32(void)
{
    const uint8_t sample[] = "123456789";
    CHECK(otp_crc32(0, sample, 9) == 0xCBF43926U);
    // 分段累计必须等于一次算完，线格式就是这么逐帧累计的。
    uint32_t split = otp_crc32(0, sample, 4);
    split = otp_crc32(split, sample + 4, 5);
    CHECK(split == 0xCBF43926U);
    return 0;
}

static int test_paging(void)
{
    CHECK(otp_page_start(10, 4, 0) == 0);
    CHECK(otp_page_start(10, 4, 3) == 0);
    CHECK(otp_page_start(10, 4, 4) == 4);
    CHECK(otp_page_start(10, 4, 9) == 8);
    CHECK(otp_page_start(0, 4, 0) == 0);
    CHECK(otp_page_start(10, 0, 5) == 0);
    // 选中项越界时钳到最后一条，而不是算出一页空白。
    CHECK(otp_page_start(3, 4, 99) == 0);
    return 0;
}

static int test_entry_validation(void)
{
    otp_entry_t entry;
    memset(&entry, 0, sizeof(entry));
    memcpy(entry.secret, "0123456789ABCDEF", 16);
    entry.secret_len = 16;
    entry.digits = 6;
    entry.period = 30;
    entry.algorithm = OTP_ALG_SHA1;
    strcpy(entry.label, "GitHub");
    CHECK(otp_entry_is_valid(&entry));

    otp_entry_t bad = entry;
    bad.digits = 9;
    CHECK(!otp_entry_is_valid(&bad));

    bad = entry;
    bad.period = 5;
    CHECK(!otp_entry_is_valid(&bad));

    bad = entry;
    bad.secret_len = 4;
    CHECK(!otp_entry_is_valid(&bad));

    bad = entry;
    bad.algorithm = 7;
    CHECK(!otp_entry_is_valid(&bad));

    bad = entry;
    bad.label[0] = '\0';
    CHECK(!otp_entry_is_valid(&bad));

    // 非 ASCII 标签在屏幕上是一串豆腐块，必须在这一层就挡住。
    bad = entry;
    strcpy(bad.label, "\xe4\xb8\xad\xe6\x96\x87");
    CHECK(!otp_entry_is_valid(&bad));

    CHECK(!otp_entry_is_valid(NULL));
    return 0;
}

// ---------------------------------------------------------------------------
// 线格式
// ---------------------------------------------------------------------------

typedef struct {
    otp_wire_event_t events[64];
    size_t count;
} recorder_t;

static void record(const otp_wire_event_t *event, void *context)
{
    recorder_t *rec = (recorder_t *)context;
    if (rec->count < sizeof(rec->events) / sizeof(rec->events[0])) {
        rec->events[rec->count++] = *event;
    }
}

typedef struct {
    uint8_t bytes[1024];
    size_t len;
} buffer_t;

static void put_u8(buffer_t *buf, uint8_t value)
{
    buf->bytes[buf->len++] = value;
}

static void put_u16(buffer_t *buf, uint16_t value)
{
    put_u8(buf, (uint8_t)(value & 0xFFU));
    put_u8(buf, (uint8_t)(value >> 8));
}

static void put_u32(buffer_t *buf, uint32_t value)
{
    for (int i = 0; i < 4; i++) {
        put_u8(buf, (uint8_t)((value >> (8 * i)) & 0xFFU));
    }
}

static void put_u64(buffer_t *buf, uint64_t value)
{
    for (int i = 0; i < 8; i++) {
        put_u8(buf, (uint8_t)((value >> (8 * i)) & 0xFFU));
    }
}

static void put_frame(buffer_t *buf, uint8_t type, const uint8_t *payload, uint16_t len)
{
    put_u8(buf, type);
    put_u16(buf, len);
    memcpy(&buf->bytes[buf->len], payload, len);
    buf->len += len;
}

static uint16_t build_entry_payload(uint8_t *out, uint16_t index, const char *label,
                                    const char *issuer, const char *secret, uint8_t digits,
                                    uint8_t period, uint8_t algorithm)
{
    uint16_t w = 0;
    out[w++] = (uint8_t)(index & 0xFFU);
    out[w++] = (uint8_t)(index >> 8);
    out[w++] = digits;
    out[w++] = period;
    out[w++] = algorithm;
    uint8_t secret_len = (uint8_t)strlen(secret);
    out[w++] = secret_len;
    memcpy(&out[w], secret, secret_len);
    w = (uint16_t)(w + secret_len);
    uint8_t label_len = (uint8_t)strlen(label);
    out[w++] = label_len;
    memcpy(&out[w], label, label_len);
    w = (uint16_t)(w + label_len);
    uint8_t issuer_len = (uint8_t)strlen(issuer);
    out[w++] = issuer_len;
    memcpy(&out[w], issuer, issuer_len);
    w = (uint16_t)(w + issuer_len);
    return w;
}

// 一次完整同步的字节流：HELLO → BEGIN(2) → ENTRY×2 → COMMIT。
static void build_session(buffer_t *buf, uint32_t crc_override, bool use_override)
{
    uint8_t payload[OTP_WIRE_PAYLOAD_MAX];
    uint32_t crc = 0;

    payload[0] = OTP_WIRE_VERSION;
    put_frame(buf, OTP_FRAME_HELLO, payload, 1);

    buffer_t begin = { .len = 0 };
    put_u16(&begin, 2);
    put_u64(&begin, 1700000000ULL);
    put_u16(&begin, (uint16_t)480);  // 东八区
    put_frame(buf, OTP_FRAME_BEGIN, begin.bytes, (uint16_t)begin.len);

    uint16_t len = build_entry_payload(payload, 0, "GitHub", "github.com", "0123456789ABCDEF", 6,
                                       30, OTP_ALG_SHA1);
    crc = otp_crc32(crc, payload, len);
    put_frame(buf, OTP_FRAME_ENTRY, payload, len);

    len = build_entry_payload(payload, 1, "AWS root", "amazon", "ABCDEFGHIJ", 8, 60,
                              OTP_ALG_SHA256);
    crc = otp_crc32(crc, payload, len);
    put_frame(buf, OTP_FRAME_ENTRY, payload, len);

    buffer_t commit = { .len = 0 };
    put_u32(&commit, use_override ? crc_override : crc);
    put_frame(buf, OTP_FRAME_COMMIT, commit.bytes, (uint16_t)commit.len);
}

static int check_session_events(const recorder_t *rec, const otp_wire_t *wire)
{
    CHECK(rec->count == 5);
    CHECK(rec->events[0].type == OTP_WIRE_EVENT_HELLO);
    CHECK(rec->events[1].type == OTP_WIRE_EVENT_BEGIN);
    CHECK(rec->events[1].expected == 2);
    CHECK(rec->events[1].unix_seconds == 1700000000ULL);
    CHECK(rec->events[1].tz_minutes == 480);
    CHECK(rec->events[2].type == OTP_WIRE_EVENT_PROGRESS);
    CHECK(rec->events[2].received == 1);
    CHECK(rec->events[3].type == OTP_WIRE_EVENT_PROGRESS);
    CHECK(rec->events[4].type == OTP_WIRE_EVENT_COMMIT);
    CHECK(rec->events[4].received == 2);
    CHECK(rec->events[4].unix_seconds == 1700000000ULL);

    const otp_vault_t *vault = otp_wire_staging(wire);
    CHECK(vault->count == 2);
    CHECK(strcmp(vault->entries[0].label, "GitHub") == 0);
    CHECK(strcmp(vault->entries[0].issuer, "github.com") == 0);
    CHECK(vault->entries[0].secret_len == 16);
    CHECK(memcmp(vault->entries[0].secret, "0123456789ABCDEF", 16) == 0);
    CHECK(vault->entries[0].digits == 6);
    CHECK(vault->entries[0].period == 30);
    CHECK(vault->entries[1].algorithm == OTP_ALG_SHA256);
    CHECK(vault->entries[1].digits == 8);
    CHECK(strcmp(vault->entries[1].label, "AWS root") == 0);
    return 0;
}

static int test_wire_whole_stream(void)
{
    buffer_t buf = { .len = 0 };
    build_session(&buf, 0, false);

    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    return check_session_events(&rec, &wire);
}

static int test_wire_byte_at_a_time(void)
{
    buffer_t buf = { .len = 0 };
    build_session(&buf, 0, false);

    // BLE 把一帧拆进多次写是常态；逐字节喂入必须得到完全相同的结果。
    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);
    for (size_t i = 0; i < buf.len; i++) {
        otp_wire_feed(&wire, &buf.bytes[i], 1, record, &rec);
    }
    return check_session_events(&rec, &wire);
}

static int test_wire_crc_mismatch(void)
{
    buffer_t buf = { .len = 0 };
    build_session(&buf, 0xDEADBEEFU, true);

    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);

    CHECK(rec.count == 5);
    CHECK(rec.events[4].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[4].ack == OTP_ACK_ERR_CRC);
    // 校验失败必须丢掉暂存，绝不能让上层写入半份保险库。
    CHECK(otp_wire_staging(&wire)->count == 0);
    return 0;
}

static int test_wire_rejects_bad_frames(void)
{
    uint8_t payload[OTP_WIRE_PAYLOAD_MAX];
    otp_wire_t wire;
    recorder_t rec = { .count = 0 };

    // 未 BEGIN 就发 ENTRY。
    otp_wire_reset(&wire);
    uint16_t len = build_entry_payload(payload, 0, "X", "", "0123456789", 6, 30, OTP_ALG_SHA1);
    buffer_t buf = { .len = 0 };
    put_frame(&buf, OTP_FRAME_ENTRY, payload, len);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_SEQUENCE);

    // 下标跳号。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    buffer_t begin = { .len = 0 };
    put_u16(&begin, 2);
    put_u64(&begin, 1700000000ULL);
    put_u16(&begin, (uint16_t)480);
    put_frame(&buf, OTP_FRAME_BEGIN, begin.bytes, (uint16_t)begin.len);
    len = build_entry_payload(payload, 1, "X", "", "0123456789", 6, 30, OTP_ALG_SHA1);
    put_frame(&buf, OTP_FRAME_ENTRY, payload, len);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 2);
    CHECK(rec.events[1].ack == OTP_ACK_ERR_SEQUENCE);

    // 条目数超过设备容量。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    begin.len = 0;
    put_u16(&begin, OTP_MAX_ENTRIES + 1);
    put_u64(&begin, 1700000000ULL);
    put_u16(&begin, (uint16_t)480);
    put_frame(&buf, OTP_FRAME_BEGIN, begin.bytes, (uint16_t)begin.len);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_TOO_MANY);

    // 协议版本不一致。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    payload[0] = OTP_WIRE_VERSION + 1;
    put_frame(&buf, OTP_FRAME_HELLO, payload, 1);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_VERSION);

    // 未知帧类型。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    put_frame(&buf, 0x7F, payload, 1);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_UNKNOWN_FRAME);

    // BEGIN 里没有时间：拼装照常，提交时才拒收——设备绝不用未知时间算码。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    begin.len = 0;
    put_u16(&begin, 1);
    put_u64(&begin, 0);
    put_u16(&begin, 0);
    put_frame(&buf, OTP_FRAME_BEGIN, begin.bytes, (uint16_t)begin.len);
    len = build_entry_payload(payload, 0, "X", "", "0123456789", 6, 30, OTP_ALG_SHA1);
    uint32_t crc = otp_crc32(0, payload, len);
    put_frame(&buf, OTP_FRAME_ENTRY, payload, len);
    buffer_t commit = { .len = 0 };
    put_u32(&commit, crc);
    put_frame(&buf, OTP_FRAME_COMMIT, commit.bytes, (uint16_t)commit.len);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 3);
    CHECK(rec.events[2].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[2].ack == OTP_ACK_ERR_NO_TIME);
    return 0;
}

static int test_wire_oversized_frame_resyncs(void)
{
    // 超长帧要被整帧吃掉再报错：否则它的 payload 会被当成后续帧的帧头，
    // 一次坏帧会毁掉整条连接。
    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);

    buffer_t buf = { .len = 0 };
    uint16_t oversized = OTP_WIRE_PAYLOAD_MAX + 16U;
    put_u8(&buf, OTP_FRAME_ENTRY);
    put_u16(&buf, oversized);
    for (uint16_t i = 0; i < oversized; i++) {
        // 填充里混入合法帧头字节，确保重同步不是"碰巧"成立。
        put_u8(&buf, (uint8_t)(i % 7 == 0 ? OTP_FRAME_HELLO : 0xAA));
    }
    uint8_t hello = OTP_WIRE_VERSION;
    put_frame(&buf, OTP_FRAME_HELLO, &hello, 1);

    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 2);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_LENGTH);
    CHECK(rec.events[1].type == OTP_WIRE_EVENT_HELLO);
    return 0;
}

static int test_wire_time_and_wipe(void)
{
    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);

    buffer_t buf = { .len = 0 };
    buffer_t time = { .len = 0 };
    put_u64(&time, 1700000123ULL);
    put_u16(&time, (uint16_t)(int16_t)-300);  // 西五区
    put_frame(&buf, OTP_FRAME_TIME, time.bytes, (uint16_t)time.len);
    put_frame(&buf, OTP_FRAME_WIPE, NULL, 0);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);

    CHECK(rec.count == 2);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_TIME);
    CHECK(rec.events[0].unix_seconds == 1700000123ULL);
    // 负偏移必须原样还原：西半球的时区是负数，按无符号读会变成 65236 分钟。
    CHECK(rec.events[0].tz_minutes == -300);
    CHECK(rec.events[1].type == OTP_WIRE_EVENT_WIPE);
    return 0;
}


// ---------------------------------------------------------------------------
// NVS blob 编解码
// ---------------------------------------------------------------------------

static otp_entry_t make_entry(const char *label, const char *issuer, uint8_t secret_len,
                              uint8_t digits, uint8_t period, uint8_t algorithm)
{
    otp_entry_t entry;
    memset(&entry, 0, sizeof(entry));
    snprintf(entry.label, sizeof(entry.label), "%s", label);
    snprintf(entry.issuer, sizeof(entry.issuer), "%s", issuer);
    for (uint8_t i = 0; i < secret_len; i++) {
        entry.secret[i] = (uint8_t)(i * 7 + 1);
    }
    entry.secret_len = secret_len;
    entry.digits = digits;
    entry.period = period;
    entry.algorithm = algorithm;
    return entry;
}

static int test_vault_codec_roundtrip(void)
{
    otp_vault_t vault;
    memset(&vault, 0, sizeof(vault));
    vault.entries[0] = make_entry("GitHub", "github.com", 16, 6, 30, OTP_ALG_SHA1);
    vault.entries[1] = make_entry("AWS", "", 20, 8, 60, OTP_ALG_SHA256);
    vault.entries[2] = make_entry("Bank", "bank.example", OTP_SECRET_MAX, 7, 30, OTP_ALG_SHA512);
    vault.count = 3;

    uint8_t blob[OTP_VAULT_BLOB_MAX];
    size_t len = 0;
    CHECK(otp_vault_encode(&vault, blob, sizeof(blob), &len));
    CHECK(len > 6);

    otp_vault_t restored;
    CHECK(otp_vault_decode(blob, len, &restored));
    CHECK(restored.count == 3);
    CHECK(memcmp(&restored, &vault, sizeof(vault)) == 0);
    return 0;
}

static int test_vault_codec_full_capacity_fits(void)
{
    // 满仓 + 每个字段都取最大值：blob 上限必须容得下，否则用户会在
    // "刚好装满"时遇到写入失败。
    otp_vault_t vault;
    memset(&vault, 0, sizeof(vault));
    for (int i = 0; i < OTP_MAX_ENTRIES; i++) {
        vault.entries[i] = make_entry("12345678901234567890", "12345678901234567890",
                                      OTP_SECRET_MAX, 8, 30, OTP_ALG_SHA512);
    }
    vault.count = OTP_MAX_ENTRIES;

    uint8_t blob[OTP_VAULT_BLOB_MAX];
    size_t len = 0;
    CHECK(otp_vault_encode(&vault, blob, sizeof(blob), &len));

    otp_vault_t restored;
    CHECK(otp_vault_decode(blob, len, &restored));
    CHECK(restored.count == OTP_MAX_ENTRIES);
    return 0;
}

static int test_vault_codec_rejects_corruption(void)
{
    otp_vault_t vault;
    memset(&vault, 0, sizeof(vault));
    vault.entries[0] = make_entry("GitHub", "github.com", 16, 6, 30, OTP_ALG_SHA1);
    vault.count = 1;

    uint8_t blob[OTP_VAULT_BLOB_MAX];
    size_t len = 0;
    CHECK(otp_vault_encode(&vault, blob, sizeof(blob), &len));

    otp_vault_t restored;

    // 魔数被改。
    uint8_t broken[OTP_VAULT_BLOB_MAX];
    memcpy(broken, blob, len);
    broken[0] ^= 0xFFU;
    CHECK(!otp_vault_decode(broken, len, &restored));

    // 版本号被改。
    memcpy(broken, blob, len);
    broken[4] = OTP_VAULT_BLOB_VERSION + 1;
    CHECK(!otp_vault_decode(broken, len, &restored));

    // 截断。
    CHECK(!otp_vault_decode(blob, len - 1, &restored));

    // 尾部多出字节。
    memcpy(broken, blob, len);
    broken[len] = 0x00;
    CHECK(!otp_vault_decode(broken, len + 1, &restored));

    // 条目字段越界（把 digits 改成 9）。
    memcpy(broken, blob, len);
    broken[6] = 9;
    CHECK(!otp_vault_decode(broken, len, &restored));

    // 空库是合法的：刚擦除完就是这个样子。
    memset(&vault, 0, sizeof(vault));
    CHECK(otp_vault_encode(&vault, blob, sizeof(blob), &len));
    CHECK(otp_vault_decode(blob, len, &restored));
    CHECK(restored.count == 0);
    return 0;
}


static int test_wire_wifi_credentials(void)
{
    otp_wire_t wire;
    recorder_t rec = { .count = 0 };
    otp_wire_reset(&wire);

    uint8_t payload[OTP_WIRE_PAYLOAD_MAX];
    uint16_t w = 0;
    const char *ssid = "my-home-ap";
    const char *pass = "hunter2hunter2";
    payload[w++] = (uint8_t)strlen(ssid);
    memcpy(&payload[w], ssid, strlen(ssid));
    w = (uint16_t)(w + strlen(ssid));
    payload[w++] = (uint8_t)strlen(pass);
    memcpy(&payload[w], pass, strlen(pass));
    w = (uint16_t)(w + strlen(pass));

    buffer_t buf = { .len = 0 };
    put_frame(&buf, OTP_FRAME_WIFI, payload, w);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);

    CHECK(rec.count == 1);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_WIFI);
    CHECK(strcmp(wire.wifi_ssid, ssid) == 0);
    CHECK(strcmp(wire.wifi_password, pass) == 0);

    // 空口令是合法的（开放网络）。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    w = 0;
    payload[w++] = (uint8_t)strlen(ssid);
    memcpy(&payload[w], ssid, strlen(ssid));
    w = (uint16_t)(w + strlen(ssid));
    payload[w++] = 0;
    put_frame(&buf, OTP_FRAME_WIFI, payload, w);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_WIFI);
    CHECK(wire.wifi_password[0] == '\0');

    // SSID 超过 802.11 的 32 字节上限。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    w = 0;
    payload[w++] = OTP_WIFI_SSID_LIMIT + 1;
    memset(&payload[w], 'x', OTP_WIFI_SSID_LIMIT + 1);
    w = (uint16_t)(w + OTP_WIFI_SSID_LIMIT + 1);
    payload[w++] = 0;
    put_frame(&buf, OTP_FRAME_WIFI, payload, w);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_FIELD);

    // 截断：声明的口令长度超出帧尾。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    w = 0;
    payload[w++] = 4;
    memcpy(&payload[w], "abcd", 4);
    w = 5;
    payload[w++] = 40;  // 说有 40 字节，实际一个都没有
    put_frame(&buf, OTP_FRAME_WIFI, payload, w);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 1);
    CHECK(rec.events[0].ack == OTP_ACK_ERR_LENGTH);

    // 坏的 WIFI 帧不该牵连正在进行的条目会话（它不碰暂存区）。
    otp_wire_reset(&wire);
    rec.count = 0;
    buf.len = 0;
    buffer_t begin = { .len = 0 };
    put_u16(&begin, 1);
    put_u64(&begin, 1700000000ULL);
    put_u16(&begin, 480);
    put_frame(&buf, OTP_FRAME_BEGIN, begin.bytes, (uint16_t)begin.len);
    uint16_t entry_len =
        build_entry_payload(payload, 0, "X", "", "0123456789", 6, 30, OTP_ALG_SHA1);
    uint32_t crc = otp_crc32(0, payload, entry_len);
    put_frame(&buf, OTP_FRAME_ENTRY, payload, entry_len);
    uint8_t bad[2] = { 200, 0 };  // ssid_len 越界
    put_frame(&buf, OTP_FRAME_WIFI, bad, 2);
    buffer_t commit = { .len = 0 };
    put_u32(&commit, crc);
    put_frame(&buf, OTP_FRAME_COMMIT, commit.bytes, (uint16_t)commit.len);
    otp_wire_feed(&wire, buf.bytes, buf.len, record, &rec);
    CHECK(rec.count == 4);
    CHECK(rec.events[2].type == OTP_WIRE_EVENT_ERROR);
    CHECK(rec.events[3].type == OTP_WIRE_EVENT_COMMIT);
    return 0;
}

int main(void)
{
    struct {
        const char *name;
        int (*run)(void);
    } tests[] = {
        { "counter", test_counter },
        { "truncate_and_format", test_truncate_and_format },
        { "crc32", test_crc32 },
        { "paging", test_paging },
        { "entry_validation", test_entry_validation },
        { "wire_whole_stream", test_wire_whole_stream },
        { "wire_byte_at_a_time", test_wire_byte_at_a_time },
        { "wire_crc_mismatch", test_wire_crc_mismatch },
        { "wire_rejects_bad_frames", test_wire_rejects_bad_frames },
        { "wire_oversized_frame_resyncs", test_wire_oversized_frame_resyncs },
        { "wire_time_and_wipe", test_wire_time_and_wipe },
        { "wire_wifi_credentials", test_wire_wifi_credentials },
        { "vault_codec_roundtrip", test_vault_codec_roundtrip },
        { "vault_codec_full_capacity_fits", test_vault_codec_full_capacity_fits },
        { "vault_codec_rejects_corruption", test_vault_codec_rejects_corruption },
    };

    for (size_t i = 0; i < sizeof(tests) / sizeof(tests[0]); i++) {
        if (tests[i].run() != 0) {
            fprintf(stderr, "test failed: %s\n", tests[i].name);
            return 1;
        }
    }
    printf("test_otp_core: PASS (%d checks)\n", g_checks);
    return 0;
}
