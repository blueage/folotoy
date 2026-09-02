// main/otp_clock.h —— 设备时间状态。
//
// TOTP 完全依赖墙上时间：时间不对，验证码就是错的，而屏幕上看不出任何异常。
// 因此这里把"时间是否可信"当成一等状态：冷启动后没有同步过就不显示验证码。
//
// 可信的判据：本次上电以来（含深睡唤醒）被网页同步过。RTC 变量能扛过深睡眠，
// 但扛不过掉电——掉电后无从得知离线了多久，NVS 里的旧时间只能用来显示
// "上次同步于何时"，不能拿来算码。
#pragma once

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 上电早期调用一次：判断 RTC 里的时间是否延续自上次运行，并读回上次同步时刻。
void otp_clock_init(void);

// 网页同步时间时调用。写 settimeofday，并把时刻记进 NVS 供下次开机显示。
void otp_clock_set(uint64_t unix_seconds);

// 系统时钟**已经**被别人（SNTP）设准了，只需把它标记为可信。
//
// 与 otp_clock_set() 的区别是这里不碰 settimeofday：SNTP 设的时间带亚秒精度，
// 若先 time(NULL) 截断再写回去，等于把表往回拨了 0~1 秒。
void otp_clock_mark_synced(void);

// 当前时间是否可用于计算验证码。
bool otp_clock_is_valid(void);

// 当前 Unix 秒。时间不可信时返回 0。
uint64_t otp_clock_now(void);

// 上次成功同步的 Unix 秒（跨掉电保留，仅用于显示）。从未同步过返回 0。
uint64_t otp_clock_last_sync(void);

// 本地时区相对 UTC 的分钟偏移（东八区 = +480）。由网页在同步时下发并存进 NVS，
// 因为设备自己无从知道它在哪个时区。
void otp_clock_set_tz_offset(int16_t minutes);
int16_t otp_clock_tz_offset(void);

// 把当前时间写成本地时间的 "HH:MM"。时间不可信时写 "--:--"。
// out 至少 OTP_CLOCK_HM_MAX 字节。
#define OTP_CLOCK_HM_MAX 6
void otp_clock_format_hm(char *out, size_t out_size);
