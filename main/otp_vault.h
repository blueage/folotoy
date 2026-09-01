// main/otp_vault.h —— 保险库的持久化（NVS）。
// 编解码在 otp_vault_codec.c；这里只负责把那段字节读写到 NVS，并把失败
// 如实翻译成 esp_err_t，绝不"读不出来就当空库"。
#pragma once

#include "otp_types.h"

#include "esp_err.h"

// 建内部互斥锁。必须在任何任务启动前（app_main 里）调用一次。
// 保险库会被 UI 任务与 BLE 任务同时读，而序列化缓冲是共用的静态大块内存。
esp_err_t otp_vault_init(void);

// 读取。从未写入过返回 ESP_ERR_NVS_NOT_FOUND 并给出空库；
// 数据损坏返回 ESP_ERR_INVALID_CRC 并给出空库（调用方应提示重新同步）。
esp_err_t otp_vault_load(otp_vault_t *vault);

esp_err_t otp_vault_save(const otp_vault_t *vault);

// 只取条目数。
//
// 存在的理由是栈：otp_vault_t 是 2.6 KB，而调用方之一是 NimBLE host 任务
// （4 KB 栈）。在那条栈上放一个完整保险库会直接爆栈——这不是理论风险，
// 真机上就是这么崩的（订阅通知 → 回报状态 → Stack protection fault）。
// 因此凡是"只想知道有几条"的地方，一律走这里，解码用本模块的静态缓冲。
esp_err_t otp_vault_count(uint8_t *count);

// 删除保险库。NVS 里没有这条记录时也算成功（幂等）。
esp_err_t otp_vault_clear(void);
