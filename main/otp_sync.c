#include "otp_sync.h"

#include "otp_clock.h"
#include "otp_icon.h"
#include "otp_icons.h"
#include "otp_vault.h"
#include "otp_wifi.h"
#include "otp_wire.h"

#include "esp_heap_caps.h"
#include "esp_log.h"
#include "esp_mac.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "freertos/task.h"
#include "host/ble_gap.h"
#include "host/ble_gatt.h"
#include "host/ble_hs.h"
#include "host/ble_hs_mbuf.h"
#include "host/util/util.h"
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "os/os_mbuf.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

#include <string.h>

static const char *TAG = "otp_sync";

// 自定义 128 位 UUID。网页端 web/src/lib/badge/protocol.ts 里是同样三串。
// 服务  2fa50001-0b0e-4c1a-9a5e-8f2b1d7c4e10
// RX    2fa50002-...（网页写，工卡读）
// TX    2fa50003-...（工卡 notify，网页收）
#define OTP_UUID_BYTES(third)                                                              \
    0x10, 0x4e, 0x7c, 0x1d, 0x2b, 0x8f, 0x5e, 0x9a, 0x1a, 0x4c, 0x0e, 0x0b, (third), 0x00, \
        0xa5, 0x2f

static const ble_uuid128_t s_service_uuid = BLE_UUID128_INIT(OTP_UUID_BYTES(0x01));
static const ble_uuid128_t s_rx_uuid = BLE_UUID128_INIT(OTP_UUID_BYTES(0x02));
static const ble_uuid128_t s_tx_uuid = BLE_UUID128_INIT(OTP_UUID_BYTES(0x03));

// 工卡 → 网页的帧类型（与 host → device 的编号区间分开，便于抓包时一眼区分）。
#define OTP_FRAME_STATUS 0x81
#define OTP_FRAME_ACK 0x82

// 收下来的图标暂存区：30 张 × 1280 字节 ≈ 38 KB，只在同步页存在，
// 进页时申请、出页时释放——常驻静态区太亏，而这段时间 Wi-Fi 是关着的。
//
// 图标和条目一样"整批生效"：中途失败就随暂存区一起丢掉，绝不会出现
// 卡上贴着上一批图标的情况。
typedef struct {
    uint8_t blob[OTP_ICON_BLOB_MAX];
    uint16_t len;
} otp_icon_slot_t;

// 待办：BLE host 任务只登记意图，真正的 NVS 写入交给 worker 任务，
// 免得 flash 擦写把协议栈的时序拖崩。
typedef struct {
    bool commit;
    bool wipe;
    bool set_time;
    bool set_wifi;
    uint64_t unix_seconds;
    int16_t tz_minutes;
    char wifi_ssid[OTP_WIFI_SSID_LIMIT + 1];
    char wifi_password[OTP_WIFI_PASS_LIMIT + 1];
    otp_vault_t vault;
} otp_sync_pending_t;

static otp_sync_status_t s_status;
static SemaphoreHandle_t s_status_mutex;
static SemaphoreHandle_t s_work_signal;
static SemaphoreHandle_t s_host_stopped;
static TaskHandle_t s_worker;
// s_pending 由 BLE host 任务写、worker 任务取；两侧都走 status_lock()。
// worker 取走时整体搬到 s_apply，避免抓着锁做 flash 擦写（那会把 host 任务堵住）。
static otp_sync_pending_t s_pending;
static otp_sync_pending_t s_apply;
static otp_wire_t s_wire;
// 图标暂存区。BLE host 任务收帧时往里写，worker 任务在 COMMIT 之后读。
//
// 这里**刻意不上锁**：COMMIT 是一次会话的最后一帧，网页要等到 ACK 才会开下一批，
// 因此两个任务实际上不会同时碰它。而给它上 s_pending 那把锁反而更糟——写图标要
// 几百毫秒的 flash 擦写，持着锁做会把 BLE host 任务整个堵住。
// 万一真有客户端抢跑，代价也只是那张图的 CRC 对不上、那一行退回纯色块。
static otp_icon_slot_t *s_icons;
static bool s_icons_pending;  // 这一批里收到过图标（COMMIT 时才需要写 flash）

static uint16_t s_tx_handle;
static uint16_t s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
static bool s_notify_ready;
static uint8_t s_addr_type;
static bool s_initialized;
static volatile bool s_start_requested;
static volatile bool s_worker_running;

static int gap_event(struct ble_gap_event *event, void *arg);
static int gatt_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg);

static const struct ble_gatt_chr_def s_characteristics[] = {
    {
        .uuid = &s_rx_uuid.u,
        .access_cb = gatt_access,
        .flags = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
    },
    {
        .uuid = &s_tx_uuid.u,
        .access_cb = gatt_access,
        .val_handle = &s_tx_handle,
        .flags = BLE_GATT_CHR_F_NOTIFY,
    },
    { 0 },
};

static const struct ble_gatt_svc_def s_services[] = {
    {
        .type = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid = &s_service_uuid.u,
        .characteristics = s_characteristics,
    },
    { 0 },
};

// ---------------------------------------------------------------------------
// 状态
// ---------------------------------------------------------------------------

static void status_lock(void)
{
    if (s_status_mutex != NULL) {
        xSemaphoreTake(s_status_mutex, portMAX_DELAY);
    }
}

static void status_unlock(void)
{
    if (s_status_mutex != NULL) {
        xSemaphoreGive(s_status_mutex);
    }
}

static void set_state(otp_sync_state_t state)
{
    status_lock();
    s_status.state = state;
    status_unlock();
}

static void set_failed(int error)
{
    status_lock();
    s_status.state = OTP_SYNC_FAILED;
    s_status.error = error;
    status_unlock();
}

void otp_sync_get_status(otp_sync_status_t *out)
{
    status_lock();
    *out = s_status;
    status_unlock();
}

static void build_device_name(char *out, size_t size)
{
    uint8_t mac[6] = { 0 };
    // 取不到 MAC 也要有个能广播的名字，否则用户在网页里连"看得见"都做不到。
    if (esp_read_mac(mac, ESP_MAC_BT) != ESP_OK) {
        snprintf(out, size, "FoloPass-2FA");
        return;
    }
    snprintf(out, size, "FoloPass-%02X%02X", mac[4], mac[5]);
}

// ---------------------------------------------------------------------------
// 发送
// ---------------------------------------------------------------------------

static void notify_frame(uint8_t type, const uint8_t *payload, uint16_t len)
{
    if (!s_notify_ready || s_conn_handle == BLE_HS_CONN_HANDLE_NONE) {
        return;
    }
    uint8_t frame[3 + 64];
    if (len > sizeof(frame) - 3U) {
        return;
    }
    frame[0] = type;
    frame[1] = (uint8_t)(len & 0xFFU);
    frame[2] = (uint8_t)(len >> 8);
    if (len > 0U && payload != NULL) {
        memcpy(&frame[3], payload, len);
    }

    struct os_mbuf *om = ble_hs_mbuf_from_flat(frame, (uint16_t)(len + 3U));
    if (om == NULL) {
        return;
    }
    int rc = ble_gatts_notify_custom(s_conn_handle, s_tx_handle, om);
    if (rc != 0) {
        ESP_LOGW(TAG, "notify 失败: %d", rc);
    }
}

static void send_ack(uint8_t ref_frame, uint8_t ack, uint16_t received, uint16_t expected)
{
    uint8_t payload[6];
    payload[0] = ref_frame;
    payload[1] = ack;
    payload[2] = (uint8_t)(received & 0xFFU);
    payload[3] = (uint8_t)(received >> 8);
    payload[4] = (uint8_t)(expected & 0xFFU);
    payload[5] = (uint8_t)(expected >> 8);
    notify_frame(OTP_FRAME_ACK, payload, sizeof(payload));
}

// STATUS payload（v2）：
//   protocol:u8 | capacity:u8 | stored:u8 | time_valid:u8 | last_sync:u64 |
//   name_len:u8 | name[] | wifi_configured:u8 | wifi_state:u8
//
// Wi-Fi 两个字段追加在变长的 name 之后：网页按 name_len 跳过名字再读，
// 老版本网页读到名字为止就停，不会解错。
static void send_status(void)
{
    // ★ 绝对不要在这里放 otp_vault_t。本函数跑在 NimBLE host 任务（4 KB 栈）上，
    //   而 otp_vault_t 是 2.6 KB —— 真机上就是这么爆栈崩的。只要条数就用 count()。
    uint8_t stored = 0;
    (void)otp_vault_count(&stored);

    status_lock();
    char name[OTP_SYNC_NAME_MAX];
    memcpy(name, s_status.device_name, sizeof(name));
    status_unlock();

    uint8_t payload[18 + OTP_SYNC_NAME_MAX];
    size_t w = 0;
    payload[w++] = OTP_WIRE_VERSION;
    payload[w++] = OTP_MAX_ENTRIES;
    payload[w++] = stored;
    payload[w++] = otp_clock_is_valid() ? 1U : 0U;
    uint64_t last_sync = otp_clock_last_sync();
    for (int i = 0; i < 8; i++) {
        payload[w++] = (uint8_t)((last_sync >> (8 * i)) & 0xFFU);
    }
    size_t name_len = strnlen(name, OTP_SYNC_NAME_MAX);
    payload[w++] = (uint8_t)name_len;
    memcpy(&payload[w], name, name_len);
    w += name_len;
    payload[w++] = otp_wifi_is_configured() ? 1U : 0U;
    payload[w++] = (uint8_t)otp_wifi_get_state();

    notify_frame(OTP_FRAME_STATUS, payload, (uint16_t)w);
}

// ---------------------------------------------------------------------------
// 线格式事件 → 待办
// ---------------------------------------------------------------------------

static void schedule_work(void)
{
    if (s_work_signal != NULL) {
        xSemaphoreGive(s_work_signal);
    }
}

static void on_wire_event(const otp_wire_event_t *event, void *context)
{
    (void)context;

    switch (event->type) {
    case OTP_WIRE_EVENT_HELLO:
        send_status();
        break;
    case OTP_WIRE_EVENT_BEGIN:
        // 新的一批：上一批没用上的图标必须先丢掉，否则这批里没带图标的条目
        // 会捡到上一批同下标那张。
        if (s_icons != NULL) {
            for (size_t i = 0; i < OTP_MAX_ENTRIES; i++) {
                s_icons[i].len = 0;
            }
        }
        s_icons_pending = false;
        status_lock();
        s_status.state = OTP_SYNC_RECEIVING;
        s_status.expected = event->expected;
        s_status.received = 0;
        s_status.last_ack = OTP_ACK_OK;
        status_unlock();
        send_ack(event->frame, OTP_ACK_OK, 0, event->expected);
        break;
    case OTP_WIRE_EVENT_PROGRESS:
        status_lock();
        s_status.received = event->received;
        status_unlock();
        break;
    case OTP_WIRE_EVENT_ICON: {
        // 图标是"有更好、没有也能用"的东西：暂存区申请不到内存时照常收下
        // 这一批令牌，只是列表里退回纯色块。
        if (s_icons == NULL || event->icon_index >= OTP_MAX_ENTRIES) {
            break;
        }
        uint16_t len = 0;
        const uint8_t *blob = otp_wire_icon(&s_wire, &len);
        if (len == 0U || len > OTP_ICON_BLOB_MAX) {
            break;
        }
        otp_icon_slot_t *slot = &s_icons[event->icon_index];
        memcpy(slot->blob, blob, len);
        slot->len = len;
        s_icons_pending = true;
        break;
    }
    case OTP_WIRE_EVENT_COMMIT:
        // 拷一份到待办里再交给 worker：BLE host 任务不碰 flash。
        status_lock();
        s_pending.vault = *otp_wire_staging(&s_wire);
        s_pending.unix_seconds = event->unix_seconds;
        s_pending.tz_minutes = event->tz_minutes;
        s_pending.set_time = true;
        s_pending.commit = true;
        status_unlock();
        schedule_work();
        break;
    case OTP_WIRE_EVENT_TIME:
        status_lock();
        s_pending.unix_seconds = event->unix_seconds;
        s_pending.tz_minutes = event->tz_minutes;
        s_pending.set_time = true;
        status_unlock();
        schedule_work();
        break;
    case OTP_WIRE_EVENT_WIFI:
        // 凭据写 NVS 也是 flash 操作，同样交给 worker。
        status_lock();
        memcpy(s_pending.wifi_ssid, s_wire.wifi_ssid, sizeof(s_pending.wifi_ssid));
        memcpy(s_pending.wifi_password, s_wire.wifi_password, sizeof(s_pending.wifi_password));
        s_pending.set_wifi = true;
        status_unlock();
        schedule_work();
        break;
    case OTP_WIRE_EVENT_WIPE:
        status_lock();
        s_pending.wipe = true;
        status_unlock();
        schedule_work();
        break;
    case OTP_WIRE_EVENT_ERROR:
        status_lock();
        s_status.state = OTP_SYNC_REJECTED;
        s_status.last_ack = event->ack;
        s_status.received = event->received;
        s_status.expected = event->expected;
        status_unlock();
        ESP_LOGW(TAG, "拒收帧 0x%02X，原因 %u", event->frame, (unsigned)event->ack);
        send_ack(event->frame, event->ack, event->received, event->expected);
        break;
    }
}

// 把暂存的图标写进 icons 分区。只在 worker 任务里调用：这里是 flash 擦写。
//
// 没有"整批回滚"的必要——每条的 icon_crc 记在保险库里，写坏或写漏的那张
// 在显示前就会被核对出来，那一行退回纯色块而已。
static void write_pending_icons(uint8_t count)
{
    size_t written = 0;
    size_t failed = 0;
    for (uint8_t i = 0; i < OTP_MAX_ENTRIES; i++) {
        // 这一批没带图标的下标要把旧图删掉。留着也不会显示（icon_crc 对不上），
        // 但会一直占着分区，几次同步下来就把它填满了。
        if (i >= count || s_icons[i].len == 0U) {
            (void)otp_icons_erase(i);
            continue;
        }
        esp_err_t err = otp_icons_save(i, s_icons[i].blob, s_icons[i].len);
        if (err == ESP_OK) {
            written++;
        } else {
            failed++;
            ESP_LOGW(TAG, "写图标 %u 失败: %s", (unsigned)i, esp_err_to_name(err));
        }
        s_icons[i].len = 0;
    }
    s_icons_pending = false;
    ESP_LOGI(TAG, "图标写入: 成功 %u，失败 %u", (unsigned)written, (unsigned)failed);
}

static void worker_task(void *arg)
{
    (void)arg;
    s_worker_running = true;

    while (s_worker_running) {
        if (xSemaphoreTake(s_work_signal, pdMS_TO_TICKS(200)) != pdTRUE) {
            continue;
        }
        if (!s_worker_running) {
            break;
        }

        // 整批取走待办：取的时候持锁，做的时候不持锁。
        status_lock();
        s_apply = s_pending;
        memset(&s_pending, 0, sizeof(s_pending));
        status_unlock();

        if (s_apply.set_wifi) {
            esp_err_t err = otp_wifi_set_credentials(s_apply.wifi_ssid, s_apply.wifi_password);
            // 口令用完立刻抹掉，别留在静态区里等下一次同步。
            memset(s_apply.wifi_ssid, 0, sizeof(s_apply.wifi_ssid));
            memset(s_apply.wifi_password, 0, sizeof(s_apply.wifi_password));
            send_ack(OTP_FRAME_WIFI, err == ESP_OK ? OTP_ACK_OK : OTP_ACK_ERR_STORAGE, 0, 0);
            send_status();
            ESP_LOGI(TAG, "Wi-Fi 凭据写入: %s", esp_err_to_name(err));
        }

        if (s_apply.set_time) {
            otp_clock_set_tz_offset(s_apply.tz_minutes);
            otp_clock_set(s_apply.unix_seconds);
            if (!s_apply.commit) {
                send_ack(OTP_FRAME_TIME, OTP_ACK_OK, 0, 0);
            }
        }

        if (s_apply.commit) {
            esp_err_t err = otp_vault_save(&s_apply.vault);
            uint8_t count = s_apply.vault.count;
            memset(&s_apply.vault, 0, sizeof(s_apply.vault));

            // 图标写在保险库之后，且写失败不改变本次同步的结果：
            // 一张贴不上的图标不值得让一批已经算得出验证码的令牌整体作废。
            // 顺序上先库后图也更安全——万一在这中间掉电，卡上是"新令牌 + 旧图标"，
            // 而每条的 icon_crc 对不上，那几行只是退回纯色块。
            if (err == ESP_OK && s_icons_pending && s_icons != NULL) {
                write_pending_icons(count);
            }

            status_lock();
            if (err == ESP_OK) {
                s_status.state = OTP_SYNC_APPLIED;
                s_status.applied_count = count;
                s_status.revision++;
                s_status.last_ack = OTP_ACK_OK;
            } else {
                s_status.state = OTP_SYNC_REJECTED;
                s_status.last_ack = OTP_ACK_ERR_STORAGE;
                s_status.error = (int)err;
            }
            status_unlock();

            send_ack(OTP_FRAME_COMMIT, err == ESP_OK ? OTP_ACK_OK : OTP_ACK_ERR_STORAGE, count,
                     count);
            send_status();
            ESP_LOGI(TAG, "同步结果: %s, %u 条", esp_err_to_name(err), (unsigned)count);
        }

        if (s_apply.wipe) {
            esp_err_t err = otp_vault_clear();
            esp_err_t icons_err = otp_icons_clear();
            if (icons_err != ESP_OK && icons_err != ESP_ERR_INVALID_STATE) {
                ESP_LOGW(TAG, "清空图标失败: %s", esp_err_to_name(icons_err));
            }
            status_lock();
            s_status.state = (err == ESP_OK) ? OTP_SYNC_WIPED : OTP_SYNC_REJECTED;
            s_status.applied_count = 0;
            s_status.received = 0;
            s_status.expected = 0;
            if (err == ESP_OK) {
                s_status.revision++;
            } else {
                s_status.last_ack = OTP_ACK_ERR_STORAGE;
                s_status.error = (int)err;
            }
            status_unlock();
            send_ack(OTP_FRAME_WIPE, err == ESP_OK ? OTP_ACK_OK : OTP_ACK_ERR_STORAGE, 0, 0);
            send_status();
        }
    }

    s_worker = NULL;
    vTaskDelete(NULL);
}

// ---------------------------------------------------------------------------
// GATT / GAP
// ---------------------------------------------------------------------------

static int gatt_access(uint16_t conn_handle, uint16_t attr_handle,
                       struct ble_gatt_access_ctxt *ctxt, void *arg)
{
    (void)conn_handle;
    (void)attr_handle;
    (void)arg;

    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) {
        // TX 只做 notify，读它没有意义；其余操作一律拒绝。
        ESP_LOGW(TAG, "GATT 非写操作 op=%d attr=%u", ctxt->op, (unsigned)attr_handle);
        return BLE_ATT_ERR_UNLIKELY;
    }

    uint16_t len = OS_MBUF_PKTLEN(ctxt->om);
    ESP_LOGI(TAG, "GATT 写入 %u 字节", (unsigned)len);
    uint8_t chunk[256];
    uint16_t copied = 0;
    while (copied < len) {
        uint16_t take = (uint16_t)(len - copied);
        if (take > sizeof(chunk)) {
            take = sizeof(chunk);
        }
        // 带偏移拷贝：一次长写（Chrome 的 prepare/execute）会攒成一个 mbuf 链，
        // 必须分段取，不能只拷开头。
        if (os_mbuf_copydata(ctxt->om, copied, take, chunk) != 0) {
            return BLE_ATT_ERR_UNLIKELY;
        }
        otp_wire_feed(&s_wire, chunk, take, on_wire_event, NULL);
        copied = (uint16_t)(copied + take);
    }
    memset(chunk, 0, sizeof(chunk));
    return 0;
}

static int advertise(void)
{
    status_lock();
    char name[OTP_SYNC_NAME_MAX];
    memcpy(name, s_status.device_name, sizeof(name));
    status_unlock();

    struct ble_hs_adv_fields fields = { 0 };
    fields.flags = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name = (const uint8_t *)name;
    fields.name_len = (uint8_t)strnlen(name, OTP_SYNC_NAME_MAX);
    fields.name_is_complete = 1;
    int rc = ble_gap_adv_set_fields(&fields);
    if (rc != 0) {
        return rc;
    }

    // 128 位 UUID 占 18 字节，和名字一起塞不进 31 字节的广播包，
    // 因此放进扫描响应：Chrome 的 optionalServices 依然能匹配到。
    struct ble_hs_adv_fields rsp = { 0 };
    rsp.uuids128 = (ble_uuid128_t *)&s_service_uuid;
    rsp.num_uuids128 = 1;
    rsp.uuids128_is_complete = 1;
    rc = ble_gap_adv_rsp_set_fields(&rsp);
    if (rc != 0) {
        return rc;
    }

    struct ble_gap_adv_params params = { 0 };
    params.conn_mode = BLE_GAP_CONN_MODE_UND;
    params.disc_mode = BLE_GAP_DISC_MODE_GEN;
    rc = ble_gap_adv_start(s_addr_type, NULL, BLE_HS_FOREVER, &params, gap_event, NULL);
    if (rc == 0) {
        set_state(OTP_SYNC_ADVERTISING);
        ESP_LOGI(TAG, "开始广播 name=%s tx_handle=%u", name, (unsigned)s_tx_handle);
    } else {
        ESP_LOGE(TAG, "ble_gap_adv_start 失败 rc=%d", rc);
    }
    return rc;
}

static int gap_event(struct ble_gap_event *event, void *arg)
{
    (void)arg;

    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        ESP_LOGI(TAG, "GAP CONNECT status=%d handle=%u", event->connect.status,
                 (unsigned)event->connect.conn_handle);
        if (event->connect.status == 0) {
            s_conn_handle = event->connect.conn_handle;
            s_notify_ready = false;
            otp_wire_reset(&s_wire);
            status_lock();
            s_status.state = OTP_SYNC_CONNECTED;
            s_status.received = 0;
            s_status.expected = 0;
            s_status.last_ack = OTP_ACK_OK;
            status_unlock();
        } else if (s_start_requested) {
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "GAP DISCONNECT reason=%d", event->disconnect.reason);
        s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        s_notify_ready = false;
        // 断链即丢弃半截会话：重连后必须从 BEGIN 重新来过。
        otp_wire_reset(&s_wire);
        if (s_start_requested) {
            advertise();
        } else {
            set_state(OTP_SYNC_OFF);
        }
        return 0;

    case BLE_GAP_EVENT_SUBSCRIBE:
        ESP_LOGI(TAG, "GAP SUBSCRIBE attr=%u (tx=%u) notify=%d",
                 (unsigned)event->subscribe.attr_handle, (unsigned)s_tx_handle,
                 event->subscribe.cur_notify);
        if (event->subscribe.attr_handle == s_tx_handle) {
            s_notify_ready = event->subscribe.cur_notify != 0;
            if (s_notify_ready) {
                send_status();
            }
        }
        return 0;

    case BLE_GAP_EVENT_ADV_COMPLETE:
        if (s_start_requested) {
            advertise();
        }
        return 0;

    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "GAP MTU=%u", (unsigned)event->mtu.value);
        return 0;

    default:
        ESP_LOGD(TAG, "GAP event %d", event->type);
        return 0;
    }
}

static void on_sync(void)
{
    int rc = ble_hs_util_ensure_addr(0);
    if (rc == 0) {
        rc = ble_hs_id_infer_auto(0, &s_addr_type);
    }
    if (rc == 0 && s_start_requested) {
        rc = advertise();
    }
    if (rc != 0) {
        set_failed(rc);
    }
}

static void on_reset(int reason)
{
    set_failed(reason);
}

static void host_task(void *arg)
{
    (void)arg;
    nimble_port_run();
    if (s_host_stopped != NULL) {
        xSemaphoreGive(s_host_stopped);
    }
    nimble_port_freertos_deinit();
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

static void release_resources(void)
{
    if (s_host_stopped != NULL) {
        vSemaphoreDelete(s_host_stopped);
        s_host_stopped = NULL;
    }
}

esp_err_t otp_sync_start(void)
{
    if (s_initialized) {
        return ESP_ERR_INVALID_STATE;
    }

    if (s_status_mutex == NULL) {
        s_status_mutex = xSemaphoreCreateMutex();
        if (s_status_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }
    if (s_work_signal == NULL) {
        s_work_signal = xSemaphoreCreateBinary();
        if (s_work_signal == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    status_lock();
    uint32_t revision = s_status.revision;  // 跨会话保留，UI 靠它判断是否要重载
    memset(&s_status, 0, sizeof(s_status));
    s_status.revision = revision;
    s_status.state = OTP_SYNC_STARTING;
    build_device_name(s_status.device_name, sizeof(s_status.device_name));
    status_unlock();

    memset(&s_pending, 0, sizeof(s_pending));
    otp_wire_reset(&s_wire);
    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    s_notify_ready = false;

    // 图标暂存区在协议栈之前申请：38 KB 连续内存，等 NimBLE 把堆切碎了再要
    // 就未必拿得到。拿不到也照常同步，只是这一批不带图标。
    if (s_icons == NULL) {
        s_icons = heap_caps_calloc(OTP_MAX_ENTRIES, sizeof(otp_icon_slot_t), MALLOC_CAP_8BIT);
        if (s_icons == NULL) {
            ESP_LOGW(TAG, "图标暂存区申请失败，本次同步不接收图标");
        }
    }
    s_icons_pending = false;

    esp_err_t err = nimble_port_init();
    if (err != ESP_OK) {
        set_failed((int)err);
        return err;
    }
    s_initialized = true;

    s_host_stopped = xSemaphoreCreateBinary();
    if (s_host_stopped == NULL) {
        nimble_port_deinit();
        s_initialized = false;
        set_failed(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    ble_svc_gap_init();
    ble_svc_gatt_init();

    int rc = ble_gatts_count_cfg(s_services);
    if (rc == 0) {
        rc = ble_gatts_add_svcs(s_services);
    }
    ESP_LOGI(TAG, "GATT 服务注册 rc=%d", rc);
    if (rc == 0) {
        status_lock();
        char name[OTP_SYNC_NAME_MAX];
        memcpy(name, s_status.device_name, sizeof(name));
        status_unlock();
        rc = ble_svc_gap_device_name_set(name);
    }
    if (rc != 0) {
        release_resources();
        nimble_port_deinit();
        s_initialized = false;
        set_failed(rc);
        return ESP_FAIL;
    }

    s_worker_running = true;
    if (xTaskCreate(worker_task, "otp_sync", 4096, NULL, 5, &s_worker) != pdPASS) {
        s_worker_running = false;
        release_resources();
        nimble_port_deinit();
        s_initialized = false;
        set_failed(ESP_ERR_NO_MEM);
        return ESP_ERR_NO_MEM;
    }

    ble_hs_cfg.reset_cb = on_reset;
    ble_hs_cfg.sync_cb = on_sync;
    s_start_requested = true;
    nimble_port_freertos_init(host_task);
    return ESP_OK;
}

void otp_sync_stop(void)
{
    s_start_requested = false;

    if (s_worker != NULL) {
        s_worker_running = false;
        schedule_work();
        // worker 只做 NVS 写入，最长几十毫秒；等它自己退出，避免在
        // flash 操作中途被删掉任务。
        for (int i = 0; i < 50 && s_worker != NULL; i++) {
            vTaskDelay(pdMS_TO_TICKS(10));
        }
        if (s_worker != NULL) {
            // 只可能是 NVS 写卡了半秒还没回来。继续停协议栈会让 worker
            // 之后的 notify 打到已释放的 host 上，因此这里如实报警。
            ESP_LOGE(TAG, "同步 worker 未在 500 ms 内退出");
        }
    }

    // 图标暂存区在这里释放，而不是等到函数末尾：下面有"协议栈本来就没起来"
    // 的提前返回，放在末尾会让一次失败的 start 把 38 KB 一直挂着。
    // 只在 worker 确实退出后释放——它正卡在写 flash 时，这块内存还在它手里。
    if (s_icons != NULL && s_worker == NULL) {
        heap_caps_free(s_icons);
        s_icons = NULL;
    }
    s_icons_pending = false;

    if (!s_initialized) {
        set_state(OTP_SYNC_OFF);
        return;
    }

    ble_gap_adv_stop();
    if (s_conn_handle != BLE_HS_CONN_HANDLE_NONE) {
        ble_gap_terminate(s_conn_handle, BLE_ERR_REM_USER_CONN_TERM);
    }

    int rc = nimble_port_stop();
    if (rc == 0) {
        if (s_host_stopped != NULL) {
            xSemaphoreTake(s_host_stopped, portMAX_DELAY);
        }
        nimble_port_deinit();
        s_initialized = false;
        release_resources();
    } else {
        ESP_LOGE(TAG, "nimble_port_stop 失败: %d", rc);
    }

    s_conn_handle = BLE_HS_CONN_HANDLE_NONE;
    s_notify_ready = false;
    // 会话缓冲里有明文种子，停机时立刻抹掉。
    memset(&s_wire, 0, sizeof(s_wire));
    memset(&s_pending, 0, sizeof(s_pending));
    memset(&s_apply, 0, sizeof(s_apply));
    set_state(OTP_SYNC_OFF);
}
