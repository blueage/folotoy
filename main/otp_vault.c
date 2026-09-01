#include "otp_vault.h"

#include "otp_vault_codec.h"

#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "nvs.h"

#include <string.h>

static const char *TAG = "otp_vault";

#define OTP_VAULT_NAMESPACE "folo2fa"
#define OTP_VAULT_KEY "vault"

// 序列化缓冲是 3 KB 的静态内存（放栈上会撑爆 BLE host 任务），
// 而 UI 任务与 BLE 任务都会进来读写，因此这一层必须自己串行化。
static uint8_t s_blob[OTP_VAULT_BLOB_MAX];
// 解码暂存。同样在静态区：见 otp_vault_count()。
static otp_vault_t s_scratch;
static SemaphoreHandle_t s_mutex;

esp_err_t otp_vault_init(void)
{
    if (s_mutex != NULL) {
        return ESP_OK;
    }
    s_mutex = xSemaphoreCreateMutex();
    return s_mutex != NULL ? ESP_OK : ESP_ERR_NO_MEM;
}

static void lock(void)
{
    if (s_mutex != NULL) {
        xSemaphoreTake(s_mutex, portMAX_DELAY);
    }
}

static void unlock(void)
{
    if (s_mutex != NULL) {
        xSemaphoreGive(s_mutex);
    }
}

// 已持锁时的读取。公开函数负责加解锁——互斥锁不可重入，
// 所以内部调用一律走这里，绝不互相调用公开函数。
static esp_err_t load_locked(otp_vault_t *vault)
{
    memset(vault, 0, sizeof(*vault));

    nvs_handle_t handle;
    esp_err_t err = nvs_open(OTP_VAULT_NAMESPACE, NVS_READONLY, &handle);
    if (err != ESP_OK) {
        return err;
    }

    size_t len = 0;
    err = nvs_get_blob(handle, OTP_VAULT_KEY, NULL, &len);
    if (err != ESP_OK) {
        nvs_close(handle);
        return err;
    }
    if (len == 0U || len > OTP_VAULT_BLOB_MAX) {
        nvs_close(handle);
        ESP_LOGE(TAG, "保险库长度异常: %u", (unsigned)len);
        return ESP_ERR_INVALID_CRC;
    }

    err = nvs_get_blob(handle, OTP_VAULT_KEY, s_blob, &len);
    nvs_close(handle);
    if (err == ESP_OK && !otp_vault_decode(s_blob, len, vault)) {
        ESP_LOGE(TAG, "保险库数据损坏，已按空库处理");
        err = ESP_ERR_INVALID_CRC;
    }
    // 缓冲里是明文种子，出锁前抹掉。
    memset(s_blob, 0, sizeof(s_blob));
    return err;
}

esp_err_t otp_vault_load(otp_vault_t *vault)
{
    lock();
    esp_err_t err = load_locked(vault);
    unlock();
    return err;
}

esp_err_t otp_vault_count(uint8_t *count)
{
    *count = 0;
    lock();
    esp_err_t err = load_locked(&s_scratch);
    if (err == ESP_OK) {
        *count = s_scratch.count;
    }
    memset(&s_scratch, 0, sizeof(s_scratch));
    unlock();
    return err;
}

esp_err_t otp_vault_save(const otp_vault_t *vault)
{
    lock();
    size_t len = 0;
    esp_err_t err = ESP_OK;
    if (!otp_vault_encode(vault, s_blob, sizeof(s_blob), &len)) {
        err = ESP_ERR_INVALID_ARG;
    }

    nvs_handle_t handle;
    if (err == ESP_OK) {
        err = nvs_open(OTP_VAULT_NAMESPACE, NVS_READWRITE, &handle);
        if (err == ESP_OK) {
            err = nvs_set_blob(handle, OTP_VAULT_KEY, s_blob, len);
            if (err == ESP_OK) {
                err = nvs_commit(handle);
            }
            nvs_close(handle);
        }
    }
    memset(s_blob, 0, sizeof(s_blob));
    unlock();

    if (err != ESP_OK) {
        ESP_LOGE(TAG, "写入保险库失败: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t otp_vault_clear(void)
{
    lock();
    nvs_handle_t handle;
    esp_err_t err = nvs_open(OTP_VAULT_NAMESPACE, NVS_READWRITE, &handle);
    if (err == ESP_OK) {
        err = nvs_erase_key(handle, OTP_VAULT_KEY);
        if (err == ESP_ERR_NVS_NOT_FOUND) {
            err = ESP_OK;  // 本来就没有，视为已清空
        }
        if (err == ESP_OK) {
            err = nvs_commit(handle);
        }
        nvs_close(handle);
    }
    unlock();
    return err;
}
