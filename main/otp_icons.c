#include "otp_icons.h"

#include "otp_icon.h"
#include "otp_types.h"

#include "esp_log.h"
#include "nvs.h"
#include "nvs_flash.h"

#include <stdio.h>
#include <string.h>

static const char *TAG = "otp_icons";

// 分区表里的那格（partitions.csv）。与令牌共用 nvs 分区放不下：
// 一张图几百字节，30 张就把 0x6000 撑爆了。
#define OTP_ICONS_PARTITION "icons"
#define OTP_ICONS_NAMESPACE "icons"

static bool s_ready;

esp_err_t otp_icons_init(void)
{
    if (s_ready) {
        return ESP_OK;
    }
    esp_err_t err = nvs_flash_init_partition(OTP_ICONS_PARTITION);
    if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) {
        // 挂不上就格式化重来，不挑原因：这一格里全是可以随时重新同步的缓存，
        // 擦掉没有任何损失。第一次升级上来时它装的还是上一版固件留下的随机字节，
        // 未必落在 NO_FREE_PAGES / NEW_VERSION 这两个码上。
        // （ESP_ERR_NOT_FOUND 是"分区表里根本没这一格"，擦也没用。）
        ESP_LOGW(TAG, "图标分区需要重新格式化: %s", esp_err_to_name(err));
        err = nvs_flash_erase_partition(OTP_ICONS_PARTITION);
        if (err == ESP_OK) {
            err = nvs_flash_init_partition(OTP_ICONS_PARTITION);
        }
    }
    if (err != ESP_OK) {
        // 没有图标不影响算验证码，因此这里只记一笔，不把开机流程带崩。
        ESP_LOGW(TAG, "图标分区不可用: %s", esp_err_to_name(err));
        return err;
    }
    s_ready = true;
    return ESP_OK;
}

static void key_for(uint8_t index, char *out, size_t size)
{
    snprintf(out, size, "i%02u", (unsigned)index);
}

static esp_err_t open_partition(nvs_open_mode_t mode, nvs_handle_t *handle)
{
    if (!s_ready) {
        return ESP_ERR_INVALID_STATE;
    }
    return nvs_open_from_partition(OTP_ICONS_PARTITION, OTP_ICONS_NAMESPACE, mode, handle);
}

esp_err_t otp_icons_save(uint8_t index, const uint8_t *blob, size_t len)
{
    if (blob == NULL || len == 0U || len > OTP_ICON_BLOB_MAX || index >= OTP_MAX_ENTRIES) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = open_partition(NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    char key[8];
    key_for(index, key, sizeof(key));
    err = nvs_set_blob(handle, key, blob, len);
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

esp_err_t otp_icons_load(uint8_t index, uint8_t *out, size_t capacity, size_t *out_len)
{
    if (out == NULL || out_len == NULL || index >= OTP_MAX_ENTRIES) {
        return ESP_ERR_INVALID_ARG;
    }
    *out_len = 0;

    nvs_handle_t handle;
    esp_err_t err = open_partition(NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }
    char key[8];
    key_for(index, key, sizeof(key));
    size_t len = capacity;
    err = nvs_get_blob(handle, key, out, &len);
    nvs_close(handle);
    if (err == ESP_OK) {
        *out_len = len;
    }
    return err;
}

// 删掉 [first, OTP_MAX_ENTRIES) 这一段。逐键删而不是 nvs_erase_all()：
// 命名空间以后可能放别的东西，而"清空图标"只该清图标。
static esp_err_t erase_range(uint8_t first)
{
    nvs_handle_t handle;
    esp_err_t err = open_partition(NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    for (uint8_t i = first; i < OTP_MAX_ENTRIES; i++) {
        char key[8];
        key_for(i, key, sizeof(key));
        esp_err_t one = nvs_erase_key(handle, key);
        if (one != ESP_OK && one != ESP_ERR_NVS_NOT_FOUND) {
            err = one;
        }
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

esp_err_t otp_icons_erase(uint8_t index)
{
    if (index >= OTP_MAX_ENTRIES) {
        return ESP_ERR_INVALID_ARG;
    }
    nvs_handle_t handle;
    esp_err_t err = open_partition(NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }
    char key[8];
    key_for(index, key, sizeof(key));
    err = nvs_erase_key(handle, key);
    if (err == ESP_ERR_NVS_NOT_FOUND) {
        err = ESP_OK;  // 本来就没有，视为已删除
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

esp_err_t otp_icons_clear(void)
{
    return erase_range(0);
}
