// main/otp_types.h —— 令牌条目与保险库的内存形状。
// 这里的上限同时是三处的契约：BLE 线格式的校验边界、NVS 序列化的最大体积、
// 网页端推送前的校验规则。改动任何一个常量都必须同步 web/src/lib/badge/protocol.ts。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 工卡上最多保存的条目数。30 条 × 单条 ~86 字节 ≈ 2.6 KB，
// 远小于 nvs 分区（0x6000）单个 blob 的容量上限。
#define OTP_MAX_ENTRIES 30

// 解码后的密钥字节数。RFC 4226 要求至少 128 bit（16 字节），
// 这里放宽下限到 10 字节（80 bit，Google Authenticator 的常见长度）。
#define OTP_SECRET_MIN 10
#define OTP_SECRET_MAX 40

// 屏幕上显示的名字。LVGL 只内置 Montserrat 拉丁字体，因此这里只接受
// 可打印 ASCII；中文名由网页端在推送前改写成 ASCII 显示名。
#define OTP_LABEL_MAX 20
// 副标题比名字多一格：列表里它自己占一整行（156px），12 号字写满 21 格约
// 147px 还放得下，而 20 格常常差最后一两个字符。
#define OTP_ISSUER_MAX 21

#define OTP_DIGITS_MIN 6
#define OTP_DIGITS_MAX 8

// 周期下限挡住把 period 写成 0 造成的除零，上限即 u8 的范围。
#define OTP_PERIOD_MIN 10

typedef enum {
    OTP_ALG_SHA1 = 0,
    OTP_ALG_SHA256 = 1,
    OTP_ALG_SHA512 = 2,
} otp_alg_t;

typedef struct {
    char label[OTP_LABEL_MAX + 1];    // 列表主标题，必填
    char issuer[OTP_ISSUER_MAX + 1];  // 副标题（网页端推来的是账号），可为空串
    uint8_t secret[OTP_SECRET_MAX];   // 已由网页端 Base32 解码后的原始字节
    uint8_t secret_len;
    uint8_t digits;
    uint8_t period;
    uint8_t algorithm;  // otp_alg_t
    // 这条的品牌主色（RGB565）。网页那边整行铺的就是它的一层淡色，
    // 工卡照做；图标丢了的时候也用它画一块纯色兜底。
    uint16_t accent;
    // 对应图标位图的 CRC32。图标存在另一个分区、不随保险库一起写，
    // 因此显示前必须拿它核对：对不上就说明那张图属于另一批数据，宁可不画。
    // 0 表示这条没有图标。
    uint32_t icon_crc;
} otp_entry_t;

typedef struct {
    otp_entry_t entries[OTP_MAX_ENTRIES];
    uint8_t count;
} otp_vault_t;

// 单条条目的字段是否都在契约范围内。线格式解析与 NVS 读取共用它，
// 于是"坏数据"只有一处定义。
bool otp_entry_is_valid(const otp_entry_t *entry);
