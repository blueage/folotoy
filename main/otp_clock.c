#include "otp_clock.h"

#include "esp_attr.h"
#include "esp_log.h"
#include "nvs.h"

#include <stdio.h>
#include <string.h>
#include <sys/time.h>
#include <time.h>

static const char *TAG = "otp_clock";

#define OTP_CLOCK_NAMESPACE "folo2fa"
#define OTP_CLOCK_KEY_LAST_SYNC "last_sync"
#define OTP_CLOCK_KEY_TZ "tz_min"

// RTC 慢速内存：深睡眠保留，掉电清零。magic 用来区分"上次运行留下的"
// 与"上电后的随机内容"。
#define OTP_CLOCK_RTC_MAGIC 0x32464131U  // "2FA1"
static RTC_DATA_ATTR uint32_t s_rtc_magic;
static RTC_DATA_ATTR uint8_t s_rtc_valid;

static bool s_valid;
static uint64_t s_last_sync;
static int16_t s_tz_minutes;

static void store_last_sync(uint64_t unix_seconds)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(OTP_CLOCK_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "打开 NVS 失败: %s", esp_err_to_name(err));
        return;
    }
    err = nvs_set_u64(handle, OTP_CLOCK_KEY_LAST_SYNC, unix_seconds);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "记录同步时刻失败: %s", esp_err_to_name(err));
    }
    nvs_close(handle);
}

void otp_clock_init(void)
{
    if (s_rtc_magic == OTP_CLOCK_RTC_MAGIC && s_rtc_valid != 0U) {
        // 深睡唤醒：ESP-IDF 已用 RTC 计时补偿过 settimeofday 的基准，
        // 时间仍然连续可用。
        s_valid = true;
    } else {
        s_rtc_magic = OTP_CLOCK_RTC_MAGIC;
        s_rtc_valid = 0;
        s_valid = false;
    }

    nvs_handle_t handle;
    if (nvs_open(OTP_CLOCK_NAMESPACE, NVS_READONLY, &handle) == ESP_OK) {
        uint64_t stored = 0;
        if (nvs_get_u64(handle, OTP_CLOCK_KEY_LAST_SYNC, &stored) == ESP_OK) {
            s_last_sync = stored;
        }
        int16_t tz = 0;
        if (nvs_get_i16(handle, OTP_CLOCK_KEY_TZ, &tz) == ESP_OK) {
            s_tz_minutes = tz;
        }
        nvs_close(handle);
    }
}

void otp_clock_set_tz_offset(int16_t minutes)
{
    // ±14 小时之外没有真实时区，越界一律忽略而不是把表盘拨到荒谬的地方。
    if (minutes < -840 || minutes > 840) {
        return;
    }
    if (minutes == s_tz_minutes) {
        return;
    }
    s_tz_minutes = minutes;

    nvs_handle_t handle;
    if (nvs_open(OTP_CLOCK_NAMESPACE, NVS_READWRITE, &handle) != ESP_OK) {
        return;
    }
    if (nvs_set_i16(handle, OTP_CLOCK_KEY_TZ, minutes) == ESP_OK) {
        nvs_commit(handle);
    }
    nvs_close(handle);
}

int16_t otp_clock_tz_offset(void)
{
    return s_tz_minutes;
}

void otp_clock_format_hm(char *out, size_t out_size)
{
    if (out == NULL || out_size < OTP_CLOCK_HM_MAX) {
        return;
    }
    uint64_t now = otp_clock_now();
    if (!s_valid || now == 0U) {
        snprintf(out, out_size, "--:--");
        return;
    }
    // 用 gmtime_r + 手工偏移，而不是 setenv("TZ")+localtime：后者要拖进
    // 整套时区数据库，为了显示两个数字不值得。
    time_t local = (time_t)((int64_t)now + (int64_t)s_tz_minutes * 60);
    struct tm tm_local;
    gmtime_r(&local, &tm_local);
    snprintf(out, out_size, "%02d:%02d", tm_local.tm_hour, tm_local.tm_min);
}

void otp_clock_set(uint64_t unix_seconds)
{
    struct timeval tv = {
        .tv_sec = (time_t)unix_seconds,
        .tv_usec = 0,
    };
    settimeofday(&tv, NULL);
    s_valid = true;
    s_rtc_magic = OTP_CLOCK_RTC_MAGIC;
    s_rtc_valid = 1;
    s_last_sync = unix_seconds;
    store_last_sync(unix_seconds);
    ESP_LOGI(TAG, "时间已同步: %llu", (unsigned long long)unix_seconds);
}

void otp_clock_mark_synced(void)
{
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0 || tv.tv_sec <= 0) {
        return;
    }
    s_valid = true;
    s_rtc_magic = OTP_CLOCK_RTC_MAGIC;
    s_rtc_valid = 1;
    s_last_sync = (uint64_t)tv.tv_sec;
    store_last_sync(s_last_sync);
    ESP_LOGI(TAG, "时间已由 SNTP 设定: %llu", (unsigned long long)s_last_sync);
}

bool otp_clock_is_valid(void)
{
    return s_valid;
}

uint64_t otp_clock_now(void)
{
    if (!s_valid) {
        return 0;
    }
    struct timeval tv;
    if (gettimeofday(&tv, NULL) != 0) {
        return 0;
    }
    return (uint64_t)tv.tv_sec;
}

uint64_t otp_clock_last_sync(void)
{
    return s_last_sync;
}
