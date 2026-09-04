// main/otp_vault_codec.h —— 保险库 ↔ 字节序列（纯逻辑，可在主机上测试）。
// NVS 只负责搬运这段字节；格式的正确性、版本与损坏判定都在这里。
#pragma once

#include "otp_types.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// v1 → v2：每条追加 accent:u16 与 icon_crc:u32（列表页的品牌色与图标）。
// 版本不匹配整体判损坏：卡上那批 v1 数据缺这两个字段，读成 v2 只会读出乱码。
#define OTP_VAULT_BLOB_VERSION 2

// 30 条 × 单条最大 93 字节 + 6 字节头，留出整数余量。
#define OTP_VAULT_BLOB_MAX 3072

// 序列化。成功返回 true 并写出实际长度；缓冲区不足或条目非法返回 false。
bool otp_vault_encode(const otp_vault_t *vault, uint8_t *out, size_t capacity, size_t *out_len);

// 反序列化。任何一处不合法都整体判损坏并返回 false —— 半份保险库比空的更危险：
// 用户会以为条目还在，实际却少了几条。
bool otp_vault_decode(const uint8_t *data, size_t len, otp_vault_t *vault);
