// main/otp_wifi.h —— 开机用 Wi-Fi 对一次时，然后把 Wi-Fi 整个关掉。
//
// 为什么是"对完就关"：这张卡的正常用途是看验证码，不需要联网。Wi-Fi 常开
// 既耗电又把攻击面一直摊在那儿。所以它只在开机后活十几秒：连上 → SNTP →
// 写系统时钟 → esp_wifi_deinit()。之后整个协议栈不再存在，直到下次开机。
//
// 凭据由网页通过 BLE 下发（见 docs/protocol.zh_CN.md 的 WIFI 帧），存在 NVS 里。
// 没配过凭据时本模块什么都不做，时间仍可由网页同步。
#pragma once

#include "esp_err.h"

#include <stdbool.h>
#include <stdint.h>

#define OTP_WIFI_SSID_MAX 32
#define OTP_WIFI_PASS_MAX 64

typedef enum {
    OTP_WIFI_IDLE = 0,      // 没配置凭据，不会联网
    OTP_WIFI_CONNECTING,    // 正在连 AP
    OTP_WIFI_SYNCING,       // 已连上，等 SNTP
    OTP_WIFI_DONE,          // 对时成功，Wi-Fi 已关闭
    OTP_WIFI_FAILED,        // 连不上或没等到时间，Wi-Fi 已关闭
} otp_wifi_state_t;

// 保存/清除凭据（写 NVS）。ssid 为空串等于清除。
esp_err_t otp_wifi_set_credentials(const char *ssid, const char *password);

bool otp_wifi_is_configured(void);

// 起一个后台任务做"连接 → 对时 → 关闭"。没有凭据时立即返回、状态保持 IDLE。
// 不阻塞调用方：开机时 UI 要照常先画出来。
void otp_wifi_start_time_sync(void);

otp_wifi_state_t otp_wifi_get_state(void);
