// components/bsp/include/bsp_battery.h
// CellWise CW2017 电量计:I2C 0x63,与 ES8311 共用总线。
// 芯片自带 Li-Poly profile,直接给 SOC%,无需外部分压电阻与查表。
#pragma once

#include "esp_err.h"

// 初始化。内部会调 bsp_i2c_init()(幂等)。
// 芯片不应答时返回 ESP_ERR_NOT_FOUND —— 上层可据此在 UI 上标记该项不可用。
esp_err_t bsp_battery_init(void);

// 剩余电量百分比 0..100;读失败返回 -1。
int bsp_battery_soc(void);

// 高精度剩余电量,单位 1/256 %(满电 = 25600)。读失败返回 -1。
//
// 存在的理由是测续航:只看整数百分比的话,10 小时的电池要 6 分钟才跳 1%,
// 想估出斜率得跑几小时;带上低字节的分辨率是 0.004%,十几分钟就够算了。
int bsp_battery_soc_q8(void);

// 电池电压 mV;读失败返回 -1。
int bsp_battery_mv(void);
