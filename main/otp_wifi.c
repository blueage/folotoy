#include "otp_wifi.h"

#include "otp_clock.h"

#include "esp_event.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_wifi.h"
#include "freertos/FreeRTOS.h"
#include "freertos/event_groups.h"
#include "freertos/task.h"
#include "nvs.h"

#include <string.h>
#include <time.h>

static const char *TAG = "otp_wifi";

#define OTP_WIFI_NAMESPACE "folo2fa"
#define OTP_WIFI_KEY_SSID "wifi_ssid"
#define OTP_WIFI_KEY_PASS "wifi_pass"

// 连接与对时各自的上限。加起来是"开机后最多让 Wi-Fi 活多久"。
#define OTP_WIFI_CONNECT_TIMEOUT_MS 12000
#define OTP_WIFI_SNTP_TIMEOUT_MS 10000

#define OTP_WIFI_BIT_GOT_IP BIT0
#define OTP_WIFI_BIT_FAILED BIT1

// 连不上就重试两次；再多没意义，用户还等着看验证码。
#define OTP_WIFI_MAX_ATTEMPTS 3

static volatile otp_wifi_state_t s_state;
static EventGroupHandle_t s_events;
static esp_event_handler_instance_t s_wifi_handler;
static esp_event_handler_instance_t s_ip_handler;
static int s_attempts;
static bool s_sntp_started;

esp_err_t otp_wifi_set_credentials(const char *ssid, const char *password)
{
    nvs_handle_t handle;
    esp_err_t err = nvs_open(OTP_WIFI_NAMESPACE, NVS_READWRITE, &handle);
    if (err != ESP_OK) {
        return err;
    }

    if (ssid == NULL || ssid[0] == '\0') {
        // 清除：两个键都删掉，下次开机就不再联网。
        (void)nvs_erase_key(handle, OTP_WIFI_KEY_SSID);
        (void)nvs_erase_key(handle, OTP_WIFI_KEY_PASS);
        err = nvs_commit(handle);
        nvs_close(handle);
        return err;
    }

    err = nvs_set_str(handle, OTP_WIFI_KEY_SSID, ssid);
    if (err == ESP_OK) {
        err = nvs_set_str(handle, OTP_WIFI_KEY_PASS, password != NULL ? password : "");
    }
    if (err == ESP_OK) {
        err = nvs_commit(handle);
    }
    nvs_close(handle);
    return err;
}

static bool load_credentials(char *ssid, size_t ssid_size, char *password, size_t pass_size)
{
    nvs_handle_t handle;
    if (nvs_open(OTP_WIFI_NAMESPACE, NVS_READONLY, &handle) != ESP_OK) {
        return false;
    }
    size_t len = ssid_size;
    esp_err_t err = nvs_get_str(handle, OTP_WIFI_KEY_SSID, ssid, &len);
    if (err == ESP_OK) {
        len = pass_size;
        if (nvs_get_str(handle, OTP_WIFI_KEY_PASS, password, &len) != ESP_OK) {
            password[0] = '\0';
        }
    }
    nvs_close(handle);
    return err == ESP_OK && ssid[0] != '\0';
}

bool otp_wifi_is_configured(void)
{
    char ssid[OTP_WIFI_SSID_MAX + 1] = { 0 };
    char pass[OTP_WIFI_PASS_MAX + 1] = { 0 };
    bool ok = load_credentials(ssid, sizeof(ssid), pass, sizeof(pass));
    // 口令不该在栈上多留一刻。
    memset(pass, 0, sizeof(pass));
    return ok;
}

otp_wifi_state_t otp_wifi_get_state(void)
{
    return s_state;
}

static void on_wifi_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    (void)data;

    if (id == WIFI_EVENT_STA_START) {
        esp_wifi_connect();
    } else if (id == WIFI_EVENT_STA_DISCONNECTED) {
        if (++s_attempts < OTP_WIFI_MAX_ATTEMPTS) {
            esp_wifi_connect();
        } else {
            xEventGroupSetBits(s_events, OTP_WIFI_BIT_FAILED);
        }
    }
}

static void on_ip_event(void *arg, esp_event_base_t base, int32_t id, void *data)
{
    (void)arg;
    (void)base;
    (void)data;
    if (id == IP_EVENT_STA_GOT_IP) {
        xEventGroupSetBits(s_events, OTP_WIFI_BIT_GOT_IP);
    }
}

// 把协议栈拆干净。每一步都要做，漏一步下次开机 init 会直接失败。
static void teardown(esp_netif_t *netif)
{
    // 没 init 过就 deinit 会踩断言，因此按标志走。
    if (s_sntp_started) {
        esp_netif_sntp_deinit();
        s_sntp_started = false;
    }
    if (s_wifi_handler != NULL) {
        esp_event_handler_instance_unregister(WIFI_EVENT, ESP_EVENT_ANY_ID, s_wifi_handler);
        s_wifi_handler = NULL;
    }
    if (s_ip_handler != NULL) {
        esp_event_handler_instance_unregister(IP_EVENT, IP_EVENT_STA_GOT_IP, s_ip_handler);
        s_ip_handler = NULL;
    }
    esp_wifi_disconnect();
    esp_wifi_stop();
    esp_wifi_deinit();
    if (netif != NULL) {
        esp_netif_destroy_default_wifi(netif);
    }
}

static void sync_task(void *arg)
{
    (void)arg;

    char ssid[OTP_WIFI_SSID_MAX + 1] = { 0 };
    char password[OTP_WIFI_PASS_MAX + 1] = { 0 };
    esp_netif_t *netif = NULL;

    if (!load_credentials(ssid, sizeof(ssid), password, sizeof(password))) {
        s_state = OTP_WIFI_IDLE;
        goto done;
    }

    s_state = OTP_WIFI_CONNECTING;
    s_attempts = 0;
    s_events = xEventGroupCreate();
    if (s_events == NULL) {
        s_state = OTP_WIFI_FAILED;
        goto done;
    }

    // 这两个是全局服务，可能已经被别处建好；已存在不是错误，
    // 用 ESP_ERROR_CHECK 会在这里直接把整台设备 abort 掉。
    esp_err_t err = esp_netif_init();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "esp_netif_init 失败: %s", esp_err_to_name(err));
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }
    err = esp_event_loop_create_default();
    if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
        ESP_LOGE(TAG, "事件循环创建失败: %s", esp_err_to_name(err));
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }
    netif = esp_netif_create_default_wifi_sta();

    wifi_init_config_t init_config = WIFI_INIT_CONFIG_DEFAULT();
    if (esp_wifi_init(&init_config) != ESP_OK) {
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }

    esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, on_wifi_event, NULL,
                                        &s_wifi_handler);
    esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, on_ip_event, NULL,
                                        &s_ip_handler);

    wifi_config_t config = { 0 };
    strncpy((char *)config.sta.ssid, ssid, sizeof(config.sta.ssid));
    strncpy((char *)config.sta.password, password, sizeof(config.sta.password));
    memset(password, 0, sizeof(password));

    if (esp_wifi_set_mode(WIFI_MODE_STA) != ESP_OK ||
        esp_wifi_set_config(WIFI_IF_STA, &config) != ESP_OK || esp_wifi_start() != ESP_OK) {
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }
    memset(&config, 0, sizeof(config));

    EventBits_t bits = xEventGroupWaitBits(s_events, OTP_WIFI_BIT_GOT_IP | OTP_WIFI_BIT_FAILED,
                                           pdTRUE, pdFALSE,
                                           pdMS_TO_TICKS(OTP_WIFI_CONNECT_TIMEOUT_MS));
    if ((bits & OTP_WIFI_BIT_GOT_IP) == 0) {
        ESP_LOGW(TAG, "连接 Wi-Fi 失败或超时");
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }

    s_state = OTP_WIFI_SYNCING;
    esp_sntp_config_t sntp_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    if (esp_netif_sntp_init(&sntp_config) != ESP_OK) {
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }
    s_sntp_started = true;
    if (esp_netif_sntp_sync_wait(pdMS_TO_TICKS(OTP_WIFI_SNTP_TIMEOUT_MS)) != ESP_OK) {
        ESP_LOGW(TAG, "等待 SNTP 超时");
        s_state = OTP_WIFI_FAILED;
        goto cleanup;
    }

    // SNTP 已经调过 settimeofday，这里把结果交给 otp_clock 记账：
    // 它才是"时间可不可信"的唯一判据。
    time_t now = time(NULL);
    if (now > 0) {
        otp_clock_set((uint64_t)now);
        s_state = OTP_WIFI_DONE;
        ESP_LOGI(TAG, "Wi-Fi 对时成功: %lld", (long long)now);
    } else {
        s_state = OTP_WIFI_FAILED;
    }

    // 凡是走到这里的失败路径都必须经过 cleanup：直接 goto done 会把
    // 事件组和 netif 漏掉。teardown() 对"还没建起来"的资源是安全的。
cleanup:
    teardown(netif);
    if (s_events != NULL) {
        vEventGroupDelete(s_events);
        s_events = NULL;
    }
    ESP_LOGI(TAG, "Wi-Fi 已关闭，state=%d", (int)s_state);

done:
    memset(ssid, 0, sizeof(ssid));
    memset(password, 0, sizeof(password));
    vTaskDelete(NULL);
}

void otp_wifi_start_time_sync(void)
{
    if (!otp_wifi_is_configured()) {
        s_state = OTP_WIFI_IDLE;
        return;
    }
    s_state = OTP_WIFI_CONNECTING;
    // 4 KB 不够：Wi-Fi/SNTP 的调用链比看上去深。
    if (xTaskCreate(sync_task, "otp_wifi", 5120, NULL, 4, NULL) != pdPASS) {
        s_state = OTP_WIFI_FAILED;
    }
}
