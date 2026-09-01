// main/otp_sync.h —— 网页 ↔ 工卡的 BLE 同步服务。
//
// 安全取舍（务必与 docs/security.md 一起读）：链路不加密、不配对。挡在数据前面
// 的是**物理动作**——只有用户在工卡上进入 SYNC 页面时，协议栈才会启动并广播；
// 退出页面立即停止。因此"能推送种子"的前提是有人拿着这张卡按了键。
// 代价是：同步的那几秒内，射频范围内的嗅探设备可以看到明文种子。
#pragma once

#include "otp_types.h"

#include "esp_err.h"

#include <stdbool.h>
#include <stdint.h>

typedef enum {
    OTP_SYNC_OFF = 0,
    OTP_SYNC_STARTING,
    OTP_SYNC_ADVERTISING,
    OTP_SYNC_CONNECTED,
    OTP_SYNC_RECEIVING,
    OTP_SYNC_APPLIED,
    OTP_SYNC_WIPED,
    OTP_SYNC_REJECTED,
    OTP_SYNC_FAILED,
} otp_sync_state_t;

#define OTP_SYNC_NAME_MAX 20

typedef struct {
    otp_sync_state_t state;
    uint16_t received;
    uint16_t expected;
    uint8_t last_ack;       // otp_ack_t：最近一次拒收的原因
    int error;              // NimBLE / esp_err 的原始错误码
    uint8_t applied_count;  // 最近一次成功写入的条目数
    // 保险库每被改写一次就 +1。UI 用它判断"要不要重新从 NVS 读一遍"，
    // 而不必在两个任务之间共享保险库内存。
    uint32_t revision;
    char device_name[OTP_SYNC_NAME_MAX];
} otp_sync_status_t;

// 启动协议栈并开始广播。只应在进入 SYNC 页面时调用。
esp_err_t otp_sync_start(void);

// 断链、停广播、停协议栈。退出 SYNC 页面时调用。
void otp_sync_stop(void);

// 取一份状态快照（内部加锁；可在 LVGL 定时器里安全调用）。
void otp_sync_get_status(otp_sync_status_t *out);
