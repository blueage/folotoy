// main/otp_ui.h —— 工卡上的三块屏：令牌列表、单条大字详情、同步页。
// 所有 LVGL 对象只在这里创建与销毁；main.c 只负责把按键事件转进来。
#pragma once

#include "bsp_button.h"

// 建首屏并从 NVS 读入保险库。必须在 bsp_lvgl_init() 之后、持有 LVGL 锁时调用。
void otp_ui_init(void);

// 按键分发。调用方需持有 LVGL 锁（main.c 的按键回调已加锁）。
void otp_ui_key(bsp_btn_t btn, bsp_btn_ev_t ev);
