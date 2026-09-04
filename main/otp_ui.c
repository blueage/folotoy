#include "otp_ui.h"

#include "otp_clock.h"
#include "otp_core.h"
#include "otp_icon.h"
#include "otp_icons.h"
#include "otp_power.h"
#include "otp_sync.h"
#include "otp_totp.h"
#include "otp_vault.h"
#include "otp_wifi.h"
#include "ui_pixel.h"
#include "ui_runner_sprite.h"

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

/*
 * 行的几何，照着网页那张卡片摆：左边一整块斜着的品牌图标（顶到行的上下边），
 * 右边分三层：上层是名字与大号验证码，中间是倒计时条，下层是整行宽的副标题。
 *
 * 关键的几个数字不是试出来的：
 *   - 内边距设 0，边框仍是 ui_pixel_panel_create 的 4px。于是内容区正好
 *     218-8=210 宽、56-8=48 高，而 48 就是 OTP_ICON_H —— 图标块严丝合缝地
 *     顶住上下边框，网页上那种"图标比行还高、被行裁掉"的观感就是这么来的。
 *     图标不能画到边框上：LVGL 的边框是在子对象**之后**画的，会盖住它。
 *   - 行加宽到 218（原来 204）：右边本来空着 20px 白边，而这一行现在要同时
 *     容下图标、两行字和验证码，每一像素都算数。
 *
 * 三层的纵向排布（数字是相对内容区顶边的 y）：
 *
 *     2  ┌── 验证码 20 号字（右对齐，行高 22）
 *     5  │   名字 14 号字（行高 16）
 *    25  ├── 倒计时条（4px，满格 = 名字那一栏的宽度）
 *    31  └── 副标题 12 号字（行高 15），**独占整行宽度**
 *    46      余 2px 到底边
 *
 * 副标题单独占一层，是因为它挤在验证码左边时只剩五六十像素，一个邮箱地址
 * 只能看到开头两三个字符。挪到验证码下面之后它有整整 156px，20 格的上限
 * 用 12 号字写满也才 140px 左右，绝大多数账号能完整显示。
 */
#define OTP_ROW_X 8
#define OTP_ROW_W 218
#define OTP_ROW_H 56
#define OTP_ROW_GAP 6
#define OTP_ROW_BORDER 4
#define OTP_ROW_INNER_W (OTP_ROW_W - 2 * OTP_ROW_BORDER)
#define OTP_ROW_INNER_H (OTP_ROW_H - 2 * OTP_ROW_BORDER)
// 图标右侧留 6px 再开始排字：贴着图标会显得挤，而图标本身四边已经没有留白了。
#define OTP_ROW_TEXT_X (OTP_ICON_W + 6)
#define OTP_ROW_TEXT_W (OTP_ROW_INNER_W - OTP_ROW_TEXT_X)
// 验证码比名字的基线低 2px、离右边框 4px：单纯是看着舒服，不是算出来的。
#define OTP_ROW_CODE_Y 2
#define OTP_ROW_CODE_RIGHT 4
#define OTP_ROW_LABEL_Y 5
#define OTP_ROW_BAR_Y 25
#define OTP_ROW_BAR_H 4
#define OTP_ROW_ACCOUNT_Y 31
// 两种字的行高，用来把标签的高度钉成一行（见 build_list 里的说明）。
// 数字取自 LVGL 的字模：montserrat_14 是 16、montserrat_12 是 15。
// 少写一个像素就会把邮箱里 g/p/y 的下伸部分切掉一行。
#define OTP_ROW_LABEL_H 16
#define OTP_ROW_ACCOUNT_H 15

typedef enum {
    OTP_PAGE_LIST = 0,
    OTP_PAGE_DETAIL,
    OTP_PAGE_SYNC,
} otp_page_t;

typedef struct {
    lv_obj_t *panel;
    lv_obj_t *icon;     // 品牌图标：一块 RGB565 画布，像素来自 s_icon_px
    lv_obj_t *label;    // 主标题（网页上的发行方）
    lv_obj_t *account;  // 副标题（网页上的账号），空则隐藏
    lv_obj_t *code;
    lv_obj_t *bar;  // 倒计时进度条：宽度随剩余秒数收缩
    // 画布里现在画的是哪一条、按哪种底色混的。两者都没变就不必重画——
    // 200ms 一次的定时器里重读 NVS + 重展开 2304 个像素是纯浪费。
    int16_t icon_entry;
    uint32_t icon_bg;
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
// 详情页草地上跑过的那个小人。屏幕一变暗就整个删掉（见 refresh_detail），
// 所以这里可能是 NULL —— 它不是"页面建好就一定在"的东西。
static lv_obj_t *s_runner;
static lv_timer_t *s_runner_timer;  // 换腿用；和 s_runner 同生共死
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

// 四行图标的像素。17.7 KB 静态内存换来的是：滚动时不必申请/释放，
// 也不占 LVGL 那 32 KB 的池子（那点池子还要养面板与标签）。
// 对齐到 4 字节是 LVGL 对画布缓冲的要求（LV_DRAW_BUF_ALIGN 默认 4）。
static uint16_t s_icon_px[OTP_UI_ROWS][OTP_ICON_PIXELS] __attribute__((aligned(4)));
// 从 NVS 读位图用的中转缓冲。放静态区而不是栈上：UI 任务的栈没有 1.3 KB 的余量。
static uint8_t s_icon_blob[OTP_ICON_BLOB_MAX];

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
    // 条目换了一批，行里那张图就未必还属于这一条：全部作废，下一帧重画。
    for (int i = 0; i < OTP_UI_ROWS; i++) {
        s_rows[i].icon_entry = -1;
    }
}

// ---------------------------------------------------------------------------
// 列表页
// ---------------------------------------------------------------------------

// 顶栏：左边时间牌（窄一点给电量腾地方），右边电量牌，不要那朵云。
// 牌子从 33 压到 28 高（正好装下 20 号字的 22px 行高），省下的 14px 给了下面的行。
static void build_header(void)
{
    s_screen = ui_pixel_screen_create_ex("--:--", 96, false, &s_clock);
    s_clock_text[0] = '\0';

    lv_obj_t *plate = ui_pixel_plate_create(s_screen, 145, UI_TOPBAR_Y, 86, UI_TOPBAR_H);
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

// 这一行的底色：纸色掺一层品牌色，选中时换成高亮黄。图标要按同一个底色
// 混合它的半透明边缘，因此两处必须取自同一个函数。
static uint32_t row_bg(const otp_entry_t *entry, bool selected)
{
    if (selected) {
        return UI_YELLOW;
    }
    return ui_pixel_row_bg(otp_icon_rgb888(entry->accent));
}

// 把一条的图标铺进这一行的画布。
//
// 图标存在另一个分区、且不随保险库一起写，所以这里要**先核对 icon_crc**：
// 对不上就说明这张图属于另一批数据（比如上一次同步写到一半失败），
// 此时宁可画一块纯品牌色，也不能把别人的 logo 贴在这一行上。
static void paint_icon(int row, size_t entry_index, const otp_entry_t *entry, uint32_t bg)
{
    uint16_t *px = s_icon_px[row];
    size_t len = 0;

    if (entry->icon_crc != 0U &&
        otp_icons_load((uint8_t)entry_index, s_icon_blob, sizeof(s_icon_blob), &len) == ESP_OK &&
        otp_crc32(0, s_icon_blob, len) == entry->icon_crc &&
        otp_icon_expand(s_icon_blob, len, otp_icon_rgb565(bg), px, OTP_ICON_PIXELS)) {
        lv_obj_invalidate(s_rows[row].icon);
        return;
    }

    // 兜底：一块纯品牌色。网页那边认不出发行方时给的是"首字母色块"，
    // 而首字母是网页画进位图里的——工卡这边只剩颜色可用。
    uint16_t solid = entry->accent != 0U ? entry->accent : otp_icon_rgb565(UI_SKY_DARK);
    for (size_t i = 0; i < OTP_ICON_PIXELS; i++) {
        px[i] = solid;
    }
    lv_obj_invalidate(s_rows[row].icon);
}

// 只在"画的不是这一条"或"底色变了（选中/取消选中）"时重画。
static void refresh_icon(int row, size_t entry_index, const otp_entry_t *entry, uint32_t bg)
{
    if (s_rows[row].icon_entry == (int16_t)entry_index && s_rows[row].icon_bg == bg) {
        return;
    }
    s_rows[row].icon_entry = (int16_t)entry_index;
    s_rows[row].icon_bg = bg;
    paint_icon(row, entry_index, entry, bg);
}

// 验证码那一栏的实际宽度。按位数量一遍，而不是按最宽的 "1234 5678" 一律留
// 100px：六位码只要 78px，省下的 22px 给名字，能多显示两三个字符。
static int32_t code_width(const char *text)
{
    lv_point_t size;
    lv_text_get_size(&size, text, &lv_font_montserrat_20, 0, 0, LV_COORD_MAX, LV_TEXT_FLAG_NONE);
    return size.x;
}

static void build_list(void)
{
    build_header();

    for (int i = 0; i < OTP_UI_ROWS; i++) {
        int y = UI_CONTENT_TOP + i * (OTP_ROW_H + OTP_ROW_GAP);
        s_rows[i].panel =
            ui_pixel_panel_create(s_screen, OTP_ROW_X, y, OTP_ROW_W, OTP_ROW_H, UI_PAPER);
        // 内边距归零：图标要顶到边框内沿，留一圈白边就露馅了。
        lv_obj_set_style_pad_all(s_rows[i].panel, 0, 0);

        // 图标画布。像素在 s_icon_px 里，LVGL 只是引用它，不复制。
        s_rows[i].icon = lv_canvas_create(s_rows[i].panel);
        lv_canvas_set_buffer(s_rows[i].icon, s_icon_px[i], OTP_ICON_W, OTP_ICON_H,
                             LV_COLOR_FORMAT_RGB565);
        lv_obj_set_pos(s_rows[i].icon, 0, 0);
        s_rows[i].icon_entry = -1;
        s_rows[i].icon_bg = 0;

        /*
         * 名字在图标右边、和验证码同一层，截断到省略号；看不全没关系，
         * 短按「确定」有大字详情。
         *
         * ★ 高度必须写死成一行（lv_obj_set_size 而不是只设宽度）。
         *   LV_LABEL_LONG_DOT 的语义是"在**给定的框**里排下，排不下才打点"，
         *   而高度留成自适应时这个框会跟着长高——于是文字先折行、再在最后一行
         *   打点，两行字直接压到下面那层去。这不是理论问题：副标题就是这么
         *   跑到倒计时条上的。
         */
        s_rows[i].label = ui_pixel_label(s_rows[i].panel, "", &lv_font_montserrat_14, UI_INK);
        lv_label_set_long_mode(s_rows[i].label, LV_LABEL_LONG_DOT);
        lv_obj_set_pos(s_rows[i].label, OTP_ROW_TEXT_X, OTP_ROW_LABEL_Y);
        lv_obj_set_height(s_rows[i].label, OTP_ROW_LABEL_H);

        // 副标题自己占一层、整行宽，字号也小一档：它是备注，不该和名字抢
        // 注意力（网页同款层次），而 12 号字让 20 格的账号能完整写下。
        s_rows[i].account =
            ui_pixel_label(s_rows[i].panel, "", &lv_font_montserrat_12, UI_INK_SOFT);
        lv_label_set_long_mode(s_rows[i].account, LV_LABEL_LONG_DOT);
        lv_obj_set_pos(s_rows[i].account, OTP_ROW_TEXT_X, OTP_ROW_ACCOUNT_Y);
        lv_obj_set_size(s_rows[i].account, OTP_ROW_TEXT_W, OTP_ROW_ACCOUNT_H);

        // 验证码在右上，右对齐：位数变化时右边缘不动，眼睛落点固定。
        s_rows[i].code = ui_pixel_label(s_rows[i].panel, "", &lv_font_montserrat_20, UI_INK);
        lv_obj_set_style_text_align(s_rows[i].code, LV_TEXT_ALIGN_RIGHT, 0);
        lv_obj_align(s_rows[i].code, LV_ALIGN_TOP_RIGHT, -OTP_ROW_CODE_RIGHT, OTP_ROW_CODE_Y);

        // 倒计时条夹在验证码与副标题之间，只横跨文字那一段：
        // 压到图标上会把图切成两半。
        s_rows[i].bar = lv_obj_create(s_rows[i].panel);
        lv_obj_remove_flag(s_rows[i].bar, LV_OBJ_FLAG_SCROLLABLE);
        lv_obj_set_style_radius(s_rows[i].bar, 0, 0);
        lv_obj_set_style_border_width(s_rows[i].bar, 0, 0);
        lv_obj_set_style_pad_all(s_rows[i].bar, 0, 0);
        lv_obj_set_style_bg_color(s_rows[i].bar, lv_color_hex(UI_GRASS), 0);
        // 长度在 refresh_list 里按"名字那一栏有多宽"逐帧给，这里只定高和起点。
        lv_obj_set_size(s_rows[i].bar, OTP_ROW_TEXT_W, OTP_ROW_BAR_H);
        lv_obj_set_pos(s_rows[i].bar, OTP_ROW_TEXT_X, OTP_ROW_BAR_Y);
    }

    s_empty = ui_pixel_label(s_screen, "", &lv_font_montserrat_14, UI_PAPER);
    lv_obj_set_width(s_empty, 200);
    lv_obj_set_style_text_align(s_empty, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_empty, LV_ALIGN_TOP_MID, 0, 120);
    lv_obj_add_flag(s_empty, LV_OBJ_FLAG_HIDDEN);

    // 提示文字压在底部那条草地里：列表本身就占满了上方，这条提示是次要信息，
    // 放进草地既不占内容区，也让整屏不留一条尴尬的空档。
    // 草地是 y=296..320，装饰草丛在 314 以下，所以文字放 299 正好落在净空里。
    s_footer = ui_pixel_label(s_screen, "", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_footer, 220);
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, UI_FOOTER_Y);
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
        bool selected = index == s_selected;
        uint32_t bg = row_bg(entry, selected);
        ui_pixel_set_row_color(s_rows[i].panel, selected, otp_icon_rgb888(entry->accent));
        refresh_icon(i, index, entry, bg);

        const char *code = time_ok ? code_for(index, now, &s_cache[i]) : OTP_CODE_PLACEHOLDER;
        lv_label_set_text(s_rows[i].code, code);

        // 名字能占多宽，取决于同一层里验证码占了多宽。副标题不受影响：
        // 它在下面自己一层，整行都是它的。
        int32_t text_w = OTP_ROW_TEXT_W - code_width(code) - 8;
        if (text_w < 24) {
            text_w = 24;
        }
        lv_obj_set_width(s_rows[i].label, text_w);
        lv_label_set_text(s_rows[i].label, entry->label);
        if (entry->issuer[0] != '\0') {
            lv_label_set_text(s_rows[i].account, entry->issuer);
            lv_obj_remove_flag(s_rows[i].account, LV_OBJ_FLAG_HIDDEN);
        } else {
            // 没有副标题就空着那一层，不把上面的东西往下挪：四行的横线对齐了，
            // 眼睛在行与行之间扫的时候才不会跳。
            lv_obj_add_flag(s_rows[i].account, LV_OBJ_FLAG_HIDDEN);
        }

        if (!time_ok) {
            lv_obj_add_flag(s_rows[i].bar, LV_OBJ_FLAG_HIDDEN);
            // 占位码不能留着上一轮的红色：红色在这里的含义是"就要过期了"，
            // 而此刻根本没有码。
            lv_obj_set_style_text_color(s_rows[i].code, lv_color_hex(UI_INK), 0);
            continue;
        }
        lv_obj_remove_flag(s_rows[i].bar, LV_OBJ_FLAG_HIDDEN);

        uint32_t remaining = otp_seconds_remaining(now, entry->period);
        uint32_t period = (entry->period == 0U) ? 30U : entry->period;
        // 满格就是名字那一栏的宽度，不伸到验证码底下：那条线扫到数字下面会让人
        // 以为它在标记数字的某一位。
        int width = (int)((remaining * (uint32_t)text_w) / period);
        lv_obj_set_width(s_rows[i].bar, width < 2 ? 2 : width);
        // 最后 5 秒转红：来得及换一屏再输，而不是输到一半过期。
        lv_obj_set_style_bg_color(s_rows[i].bar,
                                  lv_color_hex(remaining <= 5U ? UI_RED : UI_GRASS), 0);
        lv_obj_set_style_text_color(s_rows[i].code,
                                    lv_color_hex(remaining <= 5U ? UI_RED : UI_INK), 0);
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

/*
 * 草地上跑过的小人（ui_pixel.c 里那张 16×16 字符图，放大成 48×48）。
 *
 *   - y=248：下沿正好落在草地顶边 296 上——脚踩着草，不陷进去也不浮着。
 *     整个人都在天空那一段（248..296），所以精灵里的"透明"直接铺天空色就行，
 *     用不着真的透明通道。上面是详情面板的投影（到 242 为止），留了 6px 净空。
 *   - x 从 -48 跑到 240：两头都完全跑出屏幕，看着才是"路过"而不是"贴边出现"。
 *   - 3200ms 跑完 288px ≈ 90 px/s；三帧一循环，每帧 110ms。
 */
#define OTP_RUNNER_Y (UI_GRASS_TOP - UI_RUNNER_SPRITE_H)
#define OTP_RUNNER_FROM_X (-UI_RUNNER_SPRITE_W)
#define OTP_RUNNER_TO_X 240
#define OTP_RUNNER_MS 3200
// 一帧 110ms，三帧一循环 = 330ms 迈两步。配上 90 px/s 的移动速度，
// 一步跨出去大约 15px —— 步频和步幅对得上，才不会像踩着风火轮往前飘。
#define OTP_RUNNER_STEP_MS 110

static void build_detail(void)
{
    s_screen = ui_pixel_screen_create("CODE");

    lv_obj_t *panel = ui_pixel_panel_create(s_screen, 11, UI_CONTENT_TOP + 24, 204, 168, UI_PAPER);

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
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, UI_FOOTER_Y);
}

// 换一帧。挂在自己的定时器上而不是蹭 200ms 的 UI tick：那个周期一秒只有 5 帧，
// 而一个跑步循环要三帧，看着就是在原地踏步。
static void runner_step(lv_timer_t *timer)
{
    (void)timer;
    ui_pixel_runner_step(s_runner);
}

// 亮着才让它跑：动画一开 LVGL 就得按刷新周期一直重画，light sleep 整个没了。
// 变暗意味着用户已经不在看了，这时候还烧着电跑给谁看？对象和换腿定时器一起收走。
static void refresh_runner(void)
{
    bool bright = otp_power_state() == OTP_POWER_ACTIVE;
    if (bright && s_runner == NULL) {
        s_runner = ui_pixel_runner_create(s_screen, OTP_RUNNER_FROM_X, OTP_RUNNER_Y);
        ui_pixel_run_across(s_runner, OTP_RUNNER_FROM_X, OTP_RUNNER_TO_X, OTP_RUNNER_Y,
                            OTP_RUNNER_MS, 0);
        s_runner_timer = lv_timer_create(runner_step, OTP_RUNNER_STEP_MS, NULL);
    } else if (!bright && s_runner != NULL) {
        if (s_runner_timer != NULL) {
            lv_timer_delete(s_runner_timer);
            s_runner_timer = NULL;
        }
        lv_obj_delete(s_runner);
        s_runner = NULL;
    }
}

static void refresh_detail(void)
{
    if (s_selected >= s_vault.count) {
        enter_page(OTP_PAGE_LIST);
        return;
    }
    // 放在越界检查之后：上一行那种情况会立刻切回列表，没必要先造一个再删掉。
    refresh_runner();
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

    lv_obj_t *panel = ui_pixel_panel_create(s_screen, 11, UI_CONTENT_TOP + 12, 204, 194, UI_PAPER);
    s_sync_status = ui_pixel_label(panel, "Starting BLE...", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_sync_status, 186);
    lv_obj_set_style_text_align(s_sync_status, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_center(s_sync_status);

    s_footer = ui_pixel_label(s_screen, "hold OK: leave sync", &lv_font_montserrat_14, UI_INK);
    lv_obj_set_width(s_footer, 220);
    lv_obj_set_style_text_align(s_footer, LV_TEXT_ALIGN_CENTER, 0);
    lv_obj_align(s_footer, LV_ALIGN_TOP_MID, 0, UI_FOOTER_Y);
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
    // 换腿定时器不是屏幕的子对象，删页面带不走它：忘了收就会在下一页
    // 继续对着一个已经释放的对象调 step。
    if (s_runner_timer != NULL) {
        lv_timer_delete(s_runner_timer);
        s_runner_timer = NULL;
    }
    s_runner = NULL;
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
