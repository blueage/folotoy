// main/main.c —— FoloToy AI Passport 2FA 工卡：初始化硬件、载入保险库、
// 把按键交给 otp_ui。
//
// 按键语义：
//   上/下 短按   列表中移动选中项；详情页切换条目
//   确定  短按   列表 → 详情；详情 → 列表
//   确定  长按   进入 / 退出同步页（BLE 只在同步页运行）
#include "bsp_battery.h"
#include "bsp_button.h"
#include "bsp_display.h"
#include "bsp_i2c.h"
#include "bsp_pins.h"
#include "otp_batlog.h"
#include "otp_clock.h"
#include "otp_icons.h"
#include "otp_power.h"
#include "otp_ui.h"
#include "otp_vault.h"
#include "otp_wifi.h"

#include "esp_log.h"
#include "esp_pm.h"
#include "lvgl.h"
#include "nvs_flash.h"

static const char *TAG = "main";

static void on_key(bsp_btn_t btn, bsp_btn_ev_t ev, void *user)
{
    (void)user;
    // 按键回调运行在 button 组件的任务里，操作 LVGL 必须加锁。
    if (!bsp_lvgl_lock(500)) {
        return;
    }
    otp_ui_key(btn, ev);
    bsp_lvgl_unlock();
}

void app_main(void)
{
    ESP_LOGI(TAG, "FoloToy AI Passport 2FA 启动");

    esp_err_t err = nvs_flash_init();
    if (err == ESP_ERR_NVS_NO_FREE_PAGES || err == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        // 分区版本不兼容时只能重建；此时里面本来也读不出可用的保险库。
        ESP_LOGW(TAG, "NVS 需要重建: %s", esp_err_to_name(err));
        ESP_ERROR_CHECK(nvs_flash_erase());
        err = nvs_flash_init();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "NVS 初始化失败: %s；令牌无法保存", esp_err_to_name(err));
    }

    // DFS + 自动 light sleep。空闲时降到 40 MHz（XTAL）并在无事可做时进 light
    // sleep；有中断/定时器到期会自动醒来，应用层无感。
    // 注意：BLE 与 Wi-Fi 活动期间协议栈会自行持锁，不会被睡掉。
    const esp_pm_config_t pm = {
        .max_freq_mhz = 80,
        .min_freq_mhz = 40,
        .light_sleep_enable = true,
    };
    esp_err_t pm_err = esp_pm_configure(&pm);
    if (pm_err != ESP_OK) {
        ESP_LOGW(TAG, "电源管理配置失败: %s；功耗会偏高但功能不受影响",
                 esp_err_to_name(pm_err));
    }

    otp_clock_init();
    // 图标分区挂不上不算致命：令牌照常显示，列表里退回纯色块。
    if (otp_icons_init() != ESP_OK) {
        ESP_LOGW(TAG, "图标分区不可用，列表将不显示品牌图标");
    }
    if (otp_vault_init() != ESP_OK) {
        ESP_LOGE(TAG, "保险库互斥锁创建失败；无法安全地读写令牌");
        return;
    }

    bsp_i2c_init();
    // 电量计是可缺省能力：读不到就在顶栏留白，不影响看验证码。
    if (bsp_battery_init() != ESP_OK) {
        ESP_LOGW(TAG, "电量计不可用，顶栏不显示电量");
    }

    if (bsp_display_init() != ESP_OK || !bsp_lvgl_init()) {
        ESP_LOGE(TAG, "显示/LVGL 初始化失败，无法继续。"
                      "检查 SPI 接线(MOSI=%d SCLK=%d CS=%d DC=%d BL=%d)",
                 BSP_LCD_MOSI, BSP_LCD_SCLK, BSP_LCD_CS, BSP_LCD_DC, BSP_LCD_BL);
        return;
    }
    // 背光与熄屏统一交给 otp_power 管，这里不再自己拉满。
    otp_power_init();

    if (bsp_lvgl_lock(1000)) {
        otp_ui_init();
        bsp_lvgl_unlock();
    }

    // 开机就去对时：任务在后台跑，UI 已经画出来了，不会卡住开机。
    otp_wifi_start_time_sync();

    // 放电曲线记录：打印上一轮、开始这一轮。
    otp_batlog_start();

    if (bsp_button_init(on_key, NULL) != ESP_OK) {
        ESP_LOGE(TAG, "按键初始化失败：只能看到第一页，无法翻页或同步");
    }
}
