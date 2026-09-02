// main/otp_batlog.h —— 电量放电曲线记录。
//
// 存在的理由：省电改动到底省了多少，只能实测。而真正的放电测试必须**拔掉 USB**
// 跑，那时串口没人听。所以这里把 CW2017 的读数按分钟写进 NVS，下次开机（插上线）
// 时把上一轮的曲线打到串口——改动前后各跑一次，就有可比的数据。
#pragma once

#include <stdint.h>

// 每分钟采一个点，环形保留最近 144 个（2.4 小时）。
//
// 用 1 分钟而不是 10 分钟，是因为 SOC 取的是 1/256 % 的满精度读数：
// 分辨率够高，十几分钟的窗口就能算出可信的斜率，不必等一整轮放电。
#define OTP_BATLOG_INTERVAL_MIN 1
#define OTP_BATLOG_MAX_SAMPLES 144

// 电池标称容量（规格书：520 mAh），用来把 SOC 斜率换算成毫安。
#define OTP_BATLOG_CAPACITY_MAH 520

// 打印上一轮记录并开始新一轮。需在 NVS 与电量计初始化之后调用。
void otp_batlog_start(void);
