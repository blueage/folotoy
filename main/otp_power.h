// main/otp_power.h —— 背光与屏幕的空闲管理。
//
// 这块板子上耗电的大头是 LCD 背光（240×320 TFT 的背光通常 20~60 mA，
// 而整机在射频关闭时也就 45~85 mA 量级，电池只有 520 mAh）。工卡的用法本来
// 就是"抬眼扫一下"，所以让它在没人碰的时候先变暗、再熄屏，是性价比最高的一步。
//
// 刻意**不做** deep sleep，两个原因写在 docs/power.zh_CN.md：会毁掉 TOTP 的
// 时间精度，以及三键分压里有一个键压不到数字低电平、唤醒不可靠。
#pragma once

#include <stdint.h>

typedef enum {
    OTP_POWER_ACTIVE = 0,  // 全亮
    OTP_POWER_DIM,         // 变暗但仍可读
} otp_power_state_t;

// 无操作多久后变暗。**不熄屏**：变暗之后仍然一眼能看清验证码，
// 这正是这张卡的用法——抬眼扫一下，而不是先按一下键再看。
#define OTP_POWER_DIM_AFTER_MS 30000

#define OTP_POWER_ACTIVE_PERCENT 100
// 觉得太暗看不清就调大这个数（代价是省得少一些）。
#define OTP_POWER_DIM_PERCENT 10

// 必须在 bsp_display_init() 成功之后调用。
void otp_power_init(void);

// 有按键时调用：恢复全亮并重新计时。
//
// 不吞掉这次按键——变暗状态下屏幕依然可读，用户是看着屏幕按的，
// 把第一下吞掉只会显得迟钝。（如果哪天改回熄屏，这里就得重新考虑。）
void otp_power_handle_key(void);

// 把当前时刻记为"有活动"，用于让某些页面（如同步页）保持常亮。
void otp_power_note_activity(void);

// 周期调用，处理超时。
void otp_power_tick(void);

otp_power_state_t otp_power_state(void);
