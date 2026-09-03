#include "otp_ui.h"

#include "otp_clock.h"
#include "otp_core.h"
#include "otp_power.h"
#include "otp_sync.h"
#include "otp_totp.h"
#include "otp_vault.h"
#include "otp_wifi.h"
#include "ui_pixel.h"

#include "bsp_battery.h"
#include "esp_log.h"
#include "lvgl.h"
#include "nvs.h"

#include <inttypes.h>
#include <stdio.h>
#include <string.h>

static const char *TAG = "otp_ui";

#define OTP_UI_ROWS 4

// 刷新周期按屏幕状态走：亮着时要跟手，暗下来之后没必要每秒五次地算 HMAC。
// 变暗时仍然照常刷新——屏幕还看得见，验证码不能是停住的。
#define OTP_UI_TICK_ACTIVE_MS 200
#define OTP_UI_TICK_DIM_MS 1000
#define OTP_UI_TICK_MS OTP_UI_TICK_ACTIVE_MS

// 行的几何。ui_pixel_panel_create 会加 4px 边框，这里把内边距压到 4px，
// 于是内容区 = 204 - 2*(4+4) = 188 宽、46 - 16 = 30 高。
//
// ★ 标题与验证码必须**左右分栏**，不能上下叠：内容区只有 30px，
//   而 14 号字 + 20 号字合起来要 40px，叠着放就是两行字压在一起。
#define OTP_ROW_W 204
#define OTP_ROW_H 46
#define OTP_ROW_PAD 4
#define OTP_ROW_INNER_W (OTP_ROW_W - 2 * (4 + OTP_ROW_PAD))
// 验证码最宽是 "1234 5678"（8 位分组），20 号字约 100px；剩下的给标题。
#define OTP_ROW_CODE_W 100
#define OTP_ROW_LABEL_W (OTP_ROW_INNER_W - OTP_ROW_CODE_W - 4)

typedef enum {
    OTP_PAGE_LIST = 0,
    OTP_PAGE_DETAIL,
    OTP_PAGE_SYNC,
} otp_page_t;

typedef struct {
    lv_obj_t *panel;
    lv_obj_t *label;
    lv_obj_t *code;
    lv_obj_t *bar;  // 倒计时进度条：宽度随剩余秒数收缩
} otp_row_t;

static otp_vault_t s_vault;
static esp_err_t s_vault_err;

static otp_page_t s_page;
static size_t s_selected;
static uint32_t s_seen_revision;

static lv_obj_t *s_screen;
static lv_obj_t *s_clock;    // 顶栏左：本地时间 HH:MM
static lv_obj_t *s_battery;  // 顶栏右：电量百分比
static lv_obj_t *s_footer;
static lv_obj_t *s_empty;
static otp_row_t s_rows[OTP_UI_ROWS];
static lv_obj_t *s_detail_title;
static lv_obj_t *s_detail_issuer;
static lv_obj_t *s_detail_code;
static lv_obj_t *s_detail_hint;
static lv_obj_t *s_sync_status;
static lv_timer_t *s_timer;

// 每行缓存"这一步已经算过的验证码"，避免每 200 ms 重算一遍 HMAC。
typedef struct {
    uint64_t counter;
    uint8_t entry_index;
    bool valid;
    char text[OTP_CODE_TEXT_MAX];
} otp_code_cache_t;

static otp_code_cache_t s_cache[OTP_UI_ROWS];
static otp_code_cache_t s_detail_cache;

// 顶栏的两个缓存。时间每分钟才变、电量每十秒才读一次：
// 200ms 一次的定时器里无脑重设文字会让 LVGL 反复重排，也会把 I2C 打满。
static char s_clock_text[OTP_CLOCK_HM_MAX];
static char s_battery_text[12];
static uint32_t s_battery_ticks;
#define OTP_UI_BATTERY_EVERY_TICKS (10000 / OTP_UI_TICK_MS)

#define OTP_CODE_PLACEHOLDER "--- ---"

static void enter_page(otp_page_t page);

static const char *code_for(size_t entry_index, uint64_t now, otp_code_cache_t *cache)
{
    if (entry_index >= s_vault.count) {
        return OTP_CODE_PLACEHOLDER;
    }
    const otp_entry_t *entry = &s_vault.entries[entry_index];
    uint64_t counter = otp_counter(now, entry->period);
    if (cache->valid && cache->entry_index == entry_index && cache->counter == counter) {
        return cache->text;
    }
    if (otp_totp_code(entry, now, cache->text, sizeof(cache->text)) != ESP_OK) {
        cache->valid = false;
        return OTP_CODE_PLACEHOLDER;
    }
    cache->counter = counter;
    cache->entry_index = (uint8_t)entry_index;
    cache->valid = true;
    return cache->text;
}

static void reload_vault(void)
{
    esp_err_t err = otp_vault_load(&s_vault);
    // 从未同步过不是错误，只是空库；其余失败都要让用户看见。
    s_vault_err = (err == ESP_ERR_NVS_NOT_FOUND) ? ESP_OK : err;
    if (err != ESP_OK && err != ESP_ERR_NVS_NOT_FOUND) {
        ESP_LOGE(TAG, "读取保险库失败: %s", esp_err_to_name(err));
    }
    if (s_selected >= s_vault.count) {
        s_selected = s_vault.count > 0U ? s_vault.count - 1U : 0U;
    }
    memset(s_cache, 0, sizeof(s_cache));
    memset(&s_detail_cache, 0, sizeof(s_detail_cache));
}

// ---------------------------------------------------------------------------
// 列表页
// ---------------------------------------------------------------------------

// 顶栏：左边时间牌（窄一点给电量腾地方），右边电量牌，不要那朵云。
static void build_header(void)
{
    s_screen = ui_pixel_screen_create_ex("--:--", 96, false, &s_clock);
    s_clock_text[0] = '\0';

    lv_obj_t *plate = ui_pixel_plate_create(s_screen, 145, 8, 86, 33);
    s_battery = ui_pixel_label(plate, "--", &lv_font_montserrat_20, UI_INK);
    lv_obj_center(s_battery);
    s_battery_text[0] = '\0';
    // 立刻读一次，别让顶栏在开头十秒里一直是 "--"。
    s_battery_ticks = OTP_UI_BATTERY_EVERY_TICKS;
}

static void refresh_header(void)
{
    if (s_clock == NULL) {
        return;
    }
    char hm[OTP_CLOCK_HM_MAX];
    otp_clock_format_hm(hm, sizeof(hm));
    if (strcmp(hm, s_clock_text) != 0) {
        snprintf(s_clock_text, sizeof(s_clock_text), "%s", hm);
        lv_label_set_text(s_clock, s_clock_text);
    }

    if (s_battery == NULL) {
        return;
    }
    if (++s_battery_ticks < OTP_UI_BATTERY_EVERY_TICKS) {
        return;
    }
    s_battery_ticks = 0;
    int soc = bsp_battery_soc();
    char text[sizeof(s_battery_text)];
    if (soc < 0 || soc > 100) {
        // 电量计不在、读失败，或读回一个不可能的数：留白，不编一个数字出来。
        soc = -1;
        snprintf(text, sizeof(text), "--");
    } else {
        snprintf(text, sizeof(text), "%u%%", (unsigned)soc);
    }
    if (strcmp(text, s_battery_text) != 0) {
        snprintf(s_battery_text, sizeof(s_battery_text), "%s", text);
        lv_label_set_text(s_battery, s_battery_text);
        // 低于 20% 转红：挂在胸前的卡，没电了得先知道。
        lv_obj_set_style_text_color(s_battery,
                                    lv_color_hex((soc >= 0 && soc < 20) ? UI_RED : UI_INK), 0);
    }
}

static void build_list(void)
{
    build_header();

    for (int i = 0; i < OTP_UI_ROWS; i++) {
        int y = 52 + i * (OTP_ROW_H + 8);
        s_rows[i].panel =
            ui_pixel_panel_create(s_screen, 11, y, OTP_ROW_W, OTP_ROW_H, UI_PAPER);
        lv_obj_set_style_pad_all(s_rows[i].panel, OTP_ROW_PAD, 0);

        // 标题在左，截断到省略号；名字看不全没关系，短按「确定」有大字详情。
        s_rows[i].label = ui_pixel_label(s_rows[i].panel, "", &lv_font_montserrat_14, UI_INK);
        lv_label_set_long_mode(s_rows[i].label, LV_LABEL_LONG_DOT);
        lv_obj_set_width(s_rows[i].label, OTP_ROW_LABEL_W);
        lv_obj_align(s_rows[i].label, LV_ALIGN_LEFT_MID, 0, -2);

        // 验证码在右，右对齐：位数变化时右边缘不动，眼睛落点固定。
        s_rows[i].code = ui_pixel_label(s_rows[i].panel, "", &lv_font_montserrat_20, UI_SKY_DARK);
        lv_obj_set_style_text_align(s_rows[i].code, LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_align(s_rows[i].code, LV_ALIGN_RIGHT_MID, 0, -2);

        // 倒计时条贴着面板内容区的底边，横跨整行：不和文字抢地方。
        s_rows[i].bar = lv_obj_create(s_rows[i].panel);
        lv_obj_remove_flag(s_rows[i].bar, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_style_radius(s_rows[i].bar, 0, 0);
        lv_obj_set_style_border_width(s_rows[i].bar, 0, 0);
        lv_obj_set_style_pad_all(s_rows[i].bar, 0, 0);
        lv_obj_set_style_bg_color(s_rows[i].bar, lv_color_hex(UI_GRASS), 0);
        lv_obj_set_size(s_rows[i].bar, OTP_ROW_INNER_W, 3);
        lv_obj_align(s_rows[i].bar, LV_ALIGN_BOTTOM_MID, 0, 0);
    }

    s_empty = ui_pixel_label(s_screen, "", &lv_font_montserrat_14, UI_PAPER);
    lv_obj_set_width(s_empty, 200);
    lv_obj_set_style_text_align(s_empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_empty, LV_ALIGN_TOP_MID, 0, 120);
    lv_obj_add_flag(s_empty, LV_OBJ_FLAG_HIDDEN);

    // 提示文字压在底部那条草地里：列表本身就占满了上方，这条提示是次要信息，
    // 放进草地既不占内容区，也让整屏不留一条尴尬的空档。
    // 草地是 y=286..320，装饰草丛在 312 以下，所以文字放 291 正好落在净空里。
    s_footer = ui_pixel_label(s_screen, "", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_footer, 220);
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, 291);
}

static void refresh_list(void)
{
    refresh_header();
    bool time_ok = otp_clock_is_valid();
    uint64_t now = otp_clock_now();
    size_t start = otp_page_start(s_vault.count, OTP_UI_ROWS, s_selected);

    for (int i = 0; i < OTP_UI_ROWS; i++) {
        size_t index = start + (size_t)i;
        if (index >= s_vault.count) {
            lv_obj_add_flag(s_rows[i].panel, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        lv_obj_remove_flag(s_rows[i].panel, LV_OBJ_FLAG_HIDDEN);

        const otp_entry_t *entry = &s_vault.entries[index];
        lv_label_set_text(s_rows[i].label, entry->label);
        ui_pixel_set_selected(s_rows[i].panel, index == s_selected, true);

        if (!time_ok) {
            lv_label_set_text(s_rows[i].code, OTP_CODE_PLACEHOLDER);
            lv_obj_add_flag(s_rows[i].bar, LV_OBJ_FLAG_HIDDEN);
            continue;
        }
        lv_obj_remove_flag(s_rows[i].bar, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_rows[i].code, code_for(index, now, &s_cache[i]));

        uint32_t remaining = otp_seconds_remaining(now, entry->period);
        uint32_t period = (entry->period == 0U) ? 30U : entry->period;
        int width = (int)((remaining * (uint32_t)OTP_ROW_INNER_W) / period);
        lv_obj_set_width(s_rows[i].bar, width < 2 ? 2 : width);
        // 最后 5 秒转红：来得及换一屏再输，而不是输到一半过期。
        lv_obj_set_style_bg_color(s_rows[i].bar,
                                  lv_color_hex(remaining <= 5U ? UI_RED : UI_GRASS), 0);
    }

    if (s_vault.count == 0U) {
        lv_obj_remove_flag(s_empty, LV_OBJ_FLAG_HIDDEN);
        lv_label_set_text(s_empty, s_vault_err == ESP_OK
                                       ? "No tokens yet.\n\nHold OK to open SYNC,\nthen use the web page."
                                       : "Stored tokens are\nunreadable.\n\nHold OK and sync again.");
    } else {
        lv_obj_add_flag(s_empty, LV_OBJ_FLAG_HIDDEN);
    }

    if (!time_ok) {
        otp_wifi_state_t wifi = otp_wifi_get_state();
        if (wifi == OTP_WIFI_CONNECTING) {
            lv_label_set_text(s_footer, "Wi-Fi: connecting...");
        } else if (wifi == OTP_WIFI_SYNCING) {
            lv_label_set_text(s_footer, "Wi-Fi: getting time...");
        } else if (wifi == OTP_WIFI_FAILED) {
            lv_label_set_text(s_footer, "Wi-Fi failed - hold OK to sync");
        } else {
            lv_label_set_text(s_footer, "NO TIME - hold OK to sync");
        }
    } else if (s_vault.count > 0U) {
        // 序号补零到两位、提示用短标签：原来的 "10/10   OK: zoom   hold OK: sync"
        // 有 32 个字符，在 220px 宽的标签里会换行，第二行正好压进草丛。
        lv_label_set_text_fmt(s_footer, "%02u/%02u BtnC:Enter Hold:Sync",
                              (unsigned)(s_selected + 1U), (unsigned)s_vault.count);
    } else {
        lv_label_set_text(s_footer, "hold OK: sync");
    }
}

// ---------------------------------------------------------------------------
// 详情页
// ---------------------------------------------------------------------------

static void build_detail(void)
{
    s_screen = ui_pixel_screen_create("CODE");

    lv_obj_t *panel = ui_pixel_panel_create(s_screen, 11, 70, 204, 150, UI_PAPER);

    s_detail_title = ui_pixel_label(panel, "", &lv_font_montserrat_20, UI_INK);
    lv_obj_set_width(s_detail_title, 186);
    lv_label_set_long_mode(s_detail_title, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s_detail_title, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_detail_title, LV_ALIGN_TOP_MID, 0, 0);

    s_detail_issuer = ui_pixel_label(panel, "", &lv_font_montserrat_14, UI_SKY_DARK);
    lv_obj_set_width(s_detail_issuer, 186);
    lv_label_set_long_mode(s_detail_issuer, LV_LABEL_LONG_DOT);
    lv_obj_set_style_text_align(s_detail_issuer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_detail_issuer, LV_ALIGN_TOP_MID, 0, 28);

    s_detail_code = ui_pixel_label(panel, "", &lv_font_montserrat_28, UI_INK);
    lv_obj_set_style_text_align(s_detail_code, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_detail_code, LV_ALIGN_CENTER, 0, 14);

    s_detail_hint = ui_pixel_label(panel, "", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_style_text_align(s_detail_hint, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_detail_hint, LV_ALIGN_BOTTOM_MID, 0, 0);

    s_footer = ui_pixel_label(s_screen, "UP/DOWN: switch   OK: back", &lv_font_montserrat_14,
                              UI_INK);
    lv_obj_set_width(s_footer, 220);
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, 291);
}

static void refresh_detail(void)
{
    if (s_selected >= s_vault.count) {
        enter_page(OTP_PAGE_LIST);
        return;
    }
    const otp_entry_t *entry = &s_vault.entries[s_selected];
    lv_label_set_text(s_detail_title, entry->label);
    lv_label_set_text(s_detail_issuer, entry->issuer[0] != '\0' ? entry->issuer : " ");

    if (!otp_clock_is_valid()) {
        lv_label_set_text(s_detail_code, OTP_CODE_PLACEHOLDER);
        lv_label_set_text(s_detail_hint, "no time - sync first");
        return;
    }

    uint64_t now = otp_clock_now();
    lv_label_set_text(s_detail_code, code_for(s_selected, now, &s_detail_cache));
    uint32_t remaining = otp_seconds_remaining(now, entry->period);
    lv_label_set_text_fmt(s_detail_hint, "expires in %us", (unsigned)remaining);
    lv_obj_set_style_text_color(s_detail_hint, lv_color_hex(remaining <= 5U ? UI_RED : UI_INK), 0);
}

// ---------------------------------------------------------------------------
// 同步页
// ---------------------------------------------------------------------------

static void build_sync(void)
{
    s_screen = ui_pixel_screen_create("SYNC");

    lv_obj_t *panel = ui_pixel_panel_create(s_screen, 11, 62, 204, 176, UI_PAPER);
    s_sync_status = ui_pixel_label(panel, "Starting BLE...", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_sync_status, 186);
    lv_obj_set_style_text_align(s_sync_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_sync_status);

    s_footer = ui_pixel_label(s_screen, "hold OK: leave sync", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_footer, 220);
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, 291);
}

static void refresh_sync(void)
{
    otp_sync_status_t status;
    otp_sync_get_status(&status);

    switch (status.state) {
    case OTP_SYNC_STARTING:
        lv_label_set_text(s_sync_status, "Starting BLE...");
        break;
    case OTP_SYNC_ADVERTISING:
        lv_label_set_text_fmt(s_sync_status,
                              "READY\n\n%s\n\nOpen the web page,\npick this card,\npush your tokens.",
                              status.device_name);
        break;
    case OTP_SYNC_CONNECTED:
        lv_label_set_text(s_sync_status, "CONNECTED\n\nWaiting for tokens...");
        break;
    case OTP_SYNC_RECEIVING:
        lv_label_set_text_fmt(s_sync_status, "RECEIVING\n\n%u / %u", (unsigned)status.received,
                              (unsigned)status.expected);
        break;
    case OTP_SYNC_APPLIED:
        lv_label_set_text_fmt(s_sync_status, "SAVED\n\n%u tokens\n\nhold OK to view",
                              (unsigned)status.applied_count);
        break;
    case OTP_SYNC_WIPED:
        lv_label_set_text(s_sync_status, "ERASED\n\nNo tokens on this card.");
        break;
    case OTP_SYNC_REJECTED:
        lv_label_set_text_fmt(s_sync_status, "REJECTED\n\nerror %u\n\nNothing was changed.",
                              (unsigned)status.last_ack);
        break;
    case OTP_SYNC_FAILED:
        lv_label_set_text_fmt(s_sync_status, "BLE FAILED\n\ncode %d", status.error);
        break;
    default:
        lv_label_set_text(s_sync_status, "BLE off");
        break;
    }

    // 保险库被改写过：立刻重读，退出同步页时列表就是新的。
    if (status.revision != s_seen_revision) {
        s_seen_revision = status.revision;
        reload_vault();
    }
}

// ---------------------------------------------------------------------------
// 页面切换与定时刷新
// ---------------------------------------------------------------------------

static void tick(lv_timer_t *timer)
{
    (void)timer;

    // 同步页要一直亮着：屏幕上那个 FoloPass-XXXX 正是用户要在浏览器里认的。
    if (s_page == OTP_PAGE_SYNC) {
        otp_power_note_activity();
    }
    otp_power_tick();

    if (s_timer != NULL) {
        lv_timer_set_period(s_timer, otp_power_state() == OTP_POWER_ACTIVE
                                         ? OTP_UI_TICK_ACTIVE_MS
                                         : OTP_UI_TICK_DIM_MS);
    }

    switch (s_page) {
    case OTP_PAGE_LIST:
        refresh_list();
        break;
    case OTP_PAGE_DETAIL:
        refresh_detail();
        break;
    case OTP_PAGE_SYNC:
        refresh_sync();
        break;
    }
}

static void clear_screen_refs(void)
{
    s_clock = NULL;
    s_battery = NULL;
    s_footer = NULL;
    s_empty = NULL;
    s_detail_title = NULL;
    s_detail_issuer = NULL;
    s_detail_code = NULL;
    s_detail_hint = NULL;
    s_sync_status = NULL;
    memset(s_rows, 0, sizeof(s_rows));
}

static void enter_page(otp_page_t page)
{
    lv_obj_t *previous = s_screen;

    s_page = page;
    clear_screen_refs();
    switch (page) {
    case OTP_PAGE_LIST:
        build_list();
        break;
    case OTP_PAGE_DETAIL:
        build_detail();
        break;
    case OTP_PAGE_SYNC:
        build_sync();
        break;
    }

    lv_screen_load(s_screen);
    if (previous != NULL) {
        lv_obj_delete(previous);
    }
    tick(NULL);
}

void otp_ui_init(void)
{
    reload_vault();
    otp_sync_status_t status;
    otp_sync_get_status(&status);
    s_seen_revision = status.revision;

    enter_page(OTP_PAGE_LIST);
    s_timer = lv_timer_create(tick, OTP_UI_TICK_MS, NULL);
}

void otp_ui_key(bsp_btn_t btn, bsp_btn_ev_t ev)
{
    // 恢复全亮并重新计时。不吞这次按键：变暗时屏幕依然可读，
    // 用户是看着屏幕按下去的，把第一下吃掉只会显得迟钝。
    otp_power_handle_key();

    if (btn == BSP_BTN_OK && ev == BSP_BTN_LONG) {
        // 长按确定在任何页面都切换"同步 / 不同步"：BLE 只在同步页存在。
        if (s_page == OTP_PAGE_SYNC) {
            otp_sync_stop();
            reload_vault();
            enter_page(OTP_PAGE_LIST);
        } else {
            enter_page(OTP_PAGE_SYNC);
            esp_err_t err = otp_sync_start();
            if (err != ESP_OK) {
                ESP_LOGE(TAG, "启动同步失败: %s", esp_err_to_name(err));
            }
        }
        return;
    }

    if (ev != BSP_BTN_CLICK) {
        return;
    }

    switch (s_page) {
    case OTP_PAGE_LIST:
        if (s_vault.count == 0U) {
            return;
        }
        if (btn == BSP_BTN_UP) {
            s_selected = (s_selected + s_vault.count - 1U) % s_vault.count;
            refresh_list();
        } else if (btn == BSP_BTN_DOWN) {
            s_selected = (s_selected + 1U) % s_vault.count;
            refresh_list();
        } else if (btn == BSP_BTN_OK) {
            enter_page(OTP_PAGE_DETAIL);
        }
        break;
    case OTP_PAGE_DETAIL:
        if (btn == BSP_BTN_OK) {
            enter_page(OTP_PAGE_LIST);
        } else if (s_vault.count > 0U) {
            if (btn == BSP_BTN_UP) {
                s_selected = (s_selected + s_vault.count - 1U) % s_vault.count;
            } else {
                s_selected = (s_selected + 1U) % s_vault.count;
            }
            memset(&s_detail_cache, 0, sizeof(s_detail_cache));
            refresh_detail();
        }
        break;
    case OTP_PAGE_SYNC:
        // 同步页刻意不接短按：这时候屏幕是给对面的网页看的。
        break;
    }
}
