#include "otp_batlog.h"

#include "bsp_battery.h"

#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "nvs.h"

#include <string.h>

static const char *TAG = "otp_batlog";

#define OTP_BATLOG_NAMESPACE "folo2fa"
#define OTP_BATLOG_KEY "batlog"
// 上一轮的副本。分开存是为了"读一次就丢"这个坑：开机会打印并清空当前记录，
// 若那一刻没人在抓串口，整夜的数据就没了。副本只被**足够长**的会话覆盖，
// 因此"插上线开机读一次"这种短会话不会冲掉它，读漏了可以再复位读一遍。
#define OTP_BATLOG_KEY_PREV "batlog_prev"
// 少于这么多个点的会话不配覆盖副本（10 分钟）。
#define OTP_BATLOG_MIN_KEEP 10
#define OTP_BATLOG_VERSION 2

// 单点 6 字节：开机后的分钟数、SOC（1/256 %）、电压。
typedef struct __attribute__((packed)) {
    uint16_t uptime_min;
    uint16_t soc_q8;
    uint16_t mv;
} otp_batlog_sample_t;

typedef struct __attribute__((packed)) {
    uint8_t version;
    uint16_t count;  // 累计采样数；超过容量后按环形覆盖
    otp_batlog_sample_t samples[OTP_BATLOG_MAX_SAMPLES];
} otp_batlog_blob_t;

// 730 字节，放静态区：别塞进任务栈。
static otp_batlog_blob_t s_log;

// 把刚结束的那一轮（若足够长）提升为"上一轮副本"。
static void rotate(void)
{
    nvs_handle_t handle;
    if (nvs_open(OTP_BATLOG_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return;
    }
    size_t len = sizeof(s_log);
    esp_err_t err = nvs_get_blob(handle, OTP_BATLOG_KEY, &s_log, &len);
    if (err == ESP_OK && len == sizeof(s_log) && s_log.version == OTP_BATLOG_VERSION &&
        s_log.count >= OTP_BATLOG_MIN_KEEP) {
        if (nvs_set_blob(handle, OTP_BATLOG_KEY_PREV, &s_log, sizeof(s_log)) == ESP_OK) {
            nvs_commit(handle);
            ESP_LOGI(TAG, "已把刚结束的 %u 点记录存为副本", (unsigned)s_log.count);
        }
    }
    nvs_close(handle);
}

static void dump_previous(void)
{
    nvs_handle_t handle;
    if (nvs_open(OTP_BATLOG_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return;
    }
    size_t len = sizeof(s_log);
    esp_err_t err = nvs_get_blob(handle, OTP_BATLOG_KEY_PREV, &s_log, &len);
    nvs_close(handle);

    if (err != ESP_OK || len != sizeof(s_log) || s_log.version != OTP_BATLOG_VERSION) {
        ESP_LOGI(TAG, "没有上一轮的放电记录");
        return;
    }
    uint16_t total = s_log.count;
    uint16_t stored = total > OTP_BATLOG_MAX_SAMPLES ? OTP_BATLOG_MAX_SAMPLES : total;
    if (stored == 0) {
        ESP_LOGI(TAG, "上一轮没有采到点");
        return;
    }
    // 环形覆盖过就要从正确的位置开始读。
    uint16_t start = total > OTP_BATLOG_MAX_SAMPLES ? (total % OTP_BATLOG_MAX_SAMPLES) : 0;

    ESP_LOGI(TAG, "===== 上一轮放电记录（%u 点，%s）=====", (unsigned)stored,
             total > OTP_BATLOG_MAX_SAMPLES ? "已环形覆盖，仅最近的" : "完整");
    ESP_LOGI(TAG, "uptime_min,soc_percent,mv");
    const otp_batlog_sample_t *first = NULL;
    const otp_batlog_sample_t *last = NULL;
    for (uint16_t i = 0; i < stored; i++) {
        const otp_batlog_sample_t *sample = &s_log.samples[(start + i) % OTP_BATLOG_MAX_SAMPLES];
        // SOC 打成两位小数，斜率才看得出来。
        ESP_LOGI(TAG, "%u,%u.%02u,%u", (unsigned)sample->uptime_min,
                 (unsigned)(sample->soc_q8 / 256U), (unsigned)((sample->soc_q8 % 256U) * 100U / 256U),
                 (unsigned)sample->mv);
        if (first == NULL) {
            first = sample;
        }
        last = sample;
    }

    if (first != NULL && last != NULL && last->uptime_min > first->uptime_min &&
        first->soc_q8 > last->soc_q8) {
        uint32_t minutes = (uint32_t)(last->uptime_min - first->uptime_min);
        uint32_t drop_q8 = (uint32_t)(first->soc_q8 - last->soc_q8);
        // 平均电流 = 掉的电量 / 时间。drop_q8/25600 是掉了百分之几的满电量。
        uint32_t ua = (uint32_t)(((uint64_t)drop_q8 * OTP_BATLOG_CAPACITY_MAH * 60000ULL) /
                                 (25600ULL * minutes));
        uint32_t hours_x10 = (uint32_t)(((uint64_t)25600ULL * minutes * 10ULL) / (drop_q8 * 60ULL));
        ESP_LOGI(TAG, "===== %lu 分钟掉 %lu.%02lu%%；平均 %lu.%lu mA；"
                      "按 %d mAh 线性外推满电约 %lu.%lu 小时 =====",
                 (unsigned long)minutes, (unsigned long)(drop_q8 / 256U),
                 (unsigned long)((drop_q8 % 256U) * 100U / 256U), (unsigned long)(ua / 1000U),
                 (unsigned long)((ua % 1000U) / 100U), OTP_BATLOG_CAPACITY_MAH,
                 (unsigned long)(hours_x10 / 10U), (unsigned long)(hours_x10 % 10U));
    } else {
        ESP_LOGI(TAG, "===== 电量没有下降（多半是插着 USB 在充电），无法估算 =====");
    }
}

static void persist(void)
{
    nvs_handle_t handle;
    if (nvs_open(OTP_BATLOG_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return;
    }
    if (nvs_set_blob(handle, OTP_BATLOG_KEY, &s_log, sizeof(s_log)) == ESP_OK) {
        nvs_commit(handle);
    }
    nvs_close(handle);
}

static void batlog_task(void *arg)
{
    (void)arg;

    for (;;) {
        int soc_q8 = bsp_battery_soc_q8();
        int mv = bsp_battery_mv();
        if (soc_q8 >= 0 && mv > 0) {
            uint16_t minute = (uint16_t)(esp_timer_get_time() / 60000000LL);
            otp_batlog_sample_t *slot = &s_log.samples[s_log.count % OTP_BATLOG_MAX_SAMPLES];
            slot->uptime_min = minute;
            slot->soc_q8 = (uint16_t)soc_q8;
            slot->mv = (uint16_t)mv;
            s_log.count++;
            // 内存里每分钟一个点，但**每 5 个点才落一次盘**：每分钟重写一次
            // 870 字节的 blob 太费 flash 寿命，而掉电最多只丢 5 分钟数据。
            if (s_log.count % 5U == 0U) {
                persist();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(OTP_BATLOG_INTERVAL_MIN * 60 * 1000));
    }
}

void otp_batlog_start(void)
{
    rotate();
    dump_previous();

    memset(&s_log, 0, sizeof(s_log));
    s_log.version = OTP_BATLOG_VERSION;
    persist();

    // 独立任务而不是挂在 UI 定时器上：熄屏后 UI 定时器会放慢甚至不做事，
    // 而放电测试恰恰要在熄屏状态下继续采样。
    if (xTaskCreate(batlog_task, "otp_batlog", 3072, NULL, 2, NULL) != pdPASS) {
        ESP_LOGW(TAG, "创建放电记录任务失败");
    }
}
