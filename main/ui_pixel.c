#include "ui_pixel.h"

#include "ui_runner_sprite.h"

static void start_blink(lv_obj_t *eye);

static lv_obj_t *block(lv_obj_t *parent, int x, int y, int w, int h, uint32_t color)
{
    lv_obj_t *obj = lv_obj_create(parent);
    lv_obj_remove_flag(obj, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_pos(obj, x, y);
    lv_obj_set_size(obj, w, h);
    lv_obj_set_style_radius(obj, 0, 0);
    lv_obj_set_style_border_width(obj, 0, 0);
    lv_obj_set_style_pad_all(obj, 0, 0);
    lv_obj_set_style_bg_color(obj, lv_color_hex(color), 0);
    return obj;
}

lv_obj_t *ui_pixel_label(lv_obj_t *parent, const char *text,
                         const lv_font_t *font, uint32_t color)
{
    lv_obj_t *label = lv_label_create(parent);
    lv_label_set_text(label, text);
    lv_obj_set_style_text_font(label, font, 0);
    lv_obj_set_style_text_color(label, lv_color_hex(color), 0);
    return label;
}

static void add_cloud(lv_obj_t *parent, int x, int y)
{
    block(parent, x + 1, y + 7, 43, 10, UI_INK);
    block(parent, x + 5, y + 4, 35, 10, 0xFFFFFF);
    block(parent, x + 12, y, 10, 9, 0xFFFFFF);
    block(parent, x + 27, y + 1, 9, 8, 0xFFFFFF);
}

lv_obj_t *ui_pixel_plate_create(lv_obj_t *parent, int x, int y, int w, int h)
{
    block(parent, x + 4, y + 4, w, h, UI_INK);  // 投影
    lv_obj_t *plate = block(parent, x, y, w, h, UI_PAPER);
    lv_obj_set_style_border_color(plate, lv_color_hex(UI_INK), 0);
    lv_obj_set_style_border_width(plate, 3, 0);
    return plate;
}

lv_obj_t *ui_pixel_screen_create_ex(const char *title, int plate_w, bool with_cloud,
                                    lv_obj_t **heading_out)
{
    lv_obj_t *scr = lv_obj_create(NULL);
    lv_obj_remove_flag(scr, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_style_bg_color(scr, lv_color_hex(UI_SKY), 0);
    lv_obj_set_style_border_width(scr, 0, 0);
    lv_obj_set_style_pad_all(scr, 0, 0);

    if (with_cloud) {
        add_cloud(scr, 188, 6);
    }
    // 草地整体上移 + 压扁：草丛退到 314 才不会顶到页脚文字（299 起、16 px 高）。
    block(scr, 0, UI_GRASS_TOP, 240, 320 - UI_GRASS_TOP, UI_GRASS);
    block(scr, 0, UI_GRASS_TOP, 240, 3, 0xA7D93E);
    for (int x = 0; x < 240; x += 30) {
        block(scr, x, 314, 18, 6, UI_GRASS_DARK);
        block(scr, x + 18, 316, 12, 4, 0x75452E);
    }

    lv_obj_t *plate = ui_pixel_plate_create(scr, 5, UI_TOPBAR_Y, plate_w, UI_TOPBAR_H);
    lv_obj_t *heading = ui_pixel_label(plate, title, &lv_font_montserrat_20, UI_INK);
    lv_obj_center(heading);
    if (heading_out != NULL) {
        *heading_out = heading;
    }
    return scr;
}

lv_obj_t *ui_pixel_screen_create(const char *title)
{
    return ui_pixel_screen_create_ex(title, 151, true, NULL);
}

lv_obj_t *ui_pixel_panel_create(lv_obj_t *parent, int x, int y, int w, int h,
                                uint32_t color)
{
    block(parent, x + 5, y + 6, w, h, UI_INK);
    lv_obj_t *panel = block(parent, x, y, w, h, color);
    lv_obj_set_style_border_color(panel, lv_color_hex(UI_INK), 0);
    lv_obj_set_style_border_width(panel, 4, 0);
    lv_obj_set_style_pad_all(panel, 7, 0);
    return panel;
}

lv_obj_t *ui_pixel_mascot_create(lv_obj_t *parent, int x, int y)
{
    lv_obj_t *m = lv_obj_create(parent);
    lv_obj_remove_flag(m, LV_OBJ_FLAG_SCROLLABLE);
    lv_obj_set_pos(m, x, y);
    lv_obj_set_size(m, 38, 48);
    lv_obj_set_style_bg_opa(m, LV_OPA_TRANSP, 0);
    lv_obj_set_style_border_width(m, 0, 0);
    lv_obj_set_style_pad_all(m, 0, 0);

    /* 原创“小电视机器人”：天线、发光屏幕脸、橙色围巾与履带脚。 */
    block(m, 18, 0, 3, 6, UI_INK);
    block(m, 16, 0, 7, 3, UI_ORANGE);
    block(m, 3, 6, 32, 24, UI_INK);
    block(m, 0, 12, 5, 10, 0x7557D9);
    block(m, 33, 12, 5, 10, 0x7557D9);
    block(m, 7, 10, 24, 16, 0xB9F3FF);
    lv_obj_t *left_eye = block(m, 11, 14, 4, 6, 0x294B7A);
    lv_obj_t *right_eye = block(m, 23, 14, 4, 6, 0x294B7A);
    block(m, 16, 22, 7, 2, 0x7557D9);
    block(m, 10, 29, 18, 4, UI_ORANGE);
    block(m, 8, 33, 22, 11, 0x7557D9);
    block(m, 3, 35, 5, 7, 0xB9F3FF);
    block(m, 30, 35, 5, 7, 0xB9F3FF);
    block(m, 8, 44, 9, 4, UI_INK);
    block(m, 21, 44, 9, 4, UI_INK);
    start_blink(left_eye);
    start_blink(right_eye);
    return m;
}

static void move_y(void *obj, int32_t value)
{
    lv_obj_set_y((lv_obj_t *)obj, value);
}

static void move_x(void *obj, int32_t value)
{
    lv_obj_set_x((lv_obj_t *)obj, value);
}

static void blink_eye(void *obj, int32_t value)
{
    lv_obj_set_style_opa((lv_obj_t *)obj, (lv_opa_t)value, 0);
}

static void start_blink(lv_obj_t *eye)
{
    lv_anim_t anim;
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, eye);
    lv_anim_set_exec_cb(&anim, blink_eye);
    lv_anim_set_values(&anim, LV_OPA_COVER, LV_OPA_20);
    lv_anim_set_duration(&anim, 70);
    lv_anim_set_playback_duration(&anim, 70);
    lv_anim_set_repeat_delay(&anim, 1700);
    lv_anim_set_repeat_count(&anim, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&anim, lv_anim_path_step);
    lv_anim_start(&anim);
}

void ui_pixel_mascot_jump(lv_obj_t *mascot)
{
    if (!mascot) return;
    int y = lv_obj_get_y(mascot);
    lv_anim_delete(mascot, move_y);
    lv_anim_t anim;
    lv_anim_init(&anim);
    lv_anim_set_var(&anim, mascot);
    lv_anim_set_exec_cb(&anim, move_y);
    lv_anim_set_values(&anim, y, y - 5);
    lv_anim_set_duration(&anim, 110);
    lv_anim_set_playback_duration(&anim, 140);
    lv_anim_set_path_cb(&anim, lv_anim_path_step);
    lv_anim_start(&anim);
}

// 在 base 上掺 percent% 的 tint。两端都是 0xRRGGBB。
static uint32_t mix(uint32_t base, uint32_t tint, uint8_t percent)
{
    uint32_t out = 0;
    for (int shift = 16; shift >= 0; shift -= 8) {
        uint32_t b = (base >> shift) & 0xFFU;
        uint32_t t = (tint >> shift) & 0xFFU;
        uint32_t v = (b * (100U - percent) + t * percent + 50U) / 100U;
        out |= (v & 0xFFU) << shift;
    }
    return out;
}

// 品牌色的浓度。网页上是 5%，那是在一整块宽屏白底上；工卡这块屏小、行也短，
// 5% 在 240×320 的 TFT 上基本看不出来，10% 才刚好是"有颜色但不抢戏"。
#define UI_ROW_TINT_PERCENT 10

uint32_t ui_pixel_row_bg(uint32_t accent_rgb888)
{
    return mix(UI_PAPER, accent_rgb888, UI_ROW_TINT_PERCENT);
}


// ---------------------------------------------------------------------------
// 草地上跑过的小人
// ---------------------------------------------------------------------------
//
// 像素来自 main/ui_runner_sprite.c —— 那是 tools/gen_sprite.py 从 tools/sprites/
// 里的精灵图切出来的，编译前就铺成了 RGB565、按整数倍放大、透明处换成天空色。
// 因此这里既不用解码、不用缩放，也不用一块展开缓冲：画布直接指着 flash 里的
// const 数组读。
//
// 换帧就是换一个指针，所以"跑"这件事在固件里只剩下 ui_pixel_runner_step()。

static uint8_t s_runner_frame;

static void runner_show(lv_obj_t *runner, uint8_t frame)
{
    // 去 const 是安全的：画布只读这块内存。lv_canvas 没有 const 版本的接口，
    // 而把 13 KB 的帧数据拷进 RAM 只为了满足一个类型签名，不划算。
    lv_canvas_set_buffer(runner, (void *)(uintptr_t)ui_runner_sprite_frames[frame],
                         UI_RUNNER_SPRITE_W, UI_RUNNER_SPRITE_H, LV_COLOR_FORMAT_RGB565);
    lv_obj_invalidate(runner);
}

lv_obj_t *ui_pixel_runner_create(lv_obj_t *parent, int x, int y)
{
    s_runner_frame = 0;
    lv_obj_t *runner = lv_canvas_create(parent);
    runner_show(runner, s_runner_frame);
    lv_obj_set_pos(runner, x, y);
    return runner;
}

void ui_pixel_runner_step(lv_obj_t *runner)
{
    if (!runner) return;
    s_runner_frame = (uint8_t)((s_runner_frame + 1U) % UI_RUNNER_SPRITE_COUNT);
    runner_show(runner, s_runner_frame);
}

// 颠一下多快。200ms 是"在跑"与"在抽搐"之间的折中：再快就糊成一团。
// 颠多高由调用方给（hop_px），因为那取决于对象自己有多大。
#define UI_MASCOT_HOP_MS 200

void ui_pixel_run_across(lv_obj_t *obj, int32_t from_x, int32_t to_x, int32_t y,
                         uint32_t duration_ms, int32_t hop_px)
{
    if (!obj) return;
    lv_obj_set_pos(obj, from_x, y);

    // 横向匀速：走的是直线路径而不是缓入缓出——它是路过，不是在两头减速。
    lv_anim_t run;
    lv_anim_init(&run);
    lv_anim_set_var(&run, obj);
    lv_anim_set_exec_cb(&run, move_x);
    lv_anim_set_values(&run, from_x, to_x);
    lv_anim_set_duration(&run, duration_ms);
    lv_anim_set_repeat_count(&run, LV_ANIM_REPEAT_INFINITE);
    lv_anim_start(&run);

    // 上下颠一颠，给没有腿部动画的对象用（履带脚那样平移过去像被拖着走）。
    // 有两帧腿的小人不需要它，传 0 关掉。
    // 两条动画挂在同一个对象上不会打架：LVGL 按 (对象, exec_cb) 区分。
    if (hop_px <= 0) {
        return;
    }
    lv_anim_t hop;
    lv_anim_init(&hop);
    lv_anim_set_var(&hop, obj);
    lv_anim_set_exec_cb(&hop, move_y);
    lv_anim_set_values(&hop, y, y - hop_px);
    lv_anim_set_duration(&hop, UI_MASCOT_HOP_MS);
    lv_anim_set_playback_duration(&hop, UI_MASCOT_HOP_MS);
    lv_anim_set_repeat_count(&hop, LV_ANIM_REPEAT_INFINITE);
    lv_anim_set_path_cb(&hop, lv_anim_path_ease_out);
    lv_anim_start(&hop);
}

void ui_pixel_set_row_color(lv_obj_t *panel, bool selected, uint32_t accent_rgb888)
{
    uint32_t color = selected ? UI_YELLOW : ui_pixel_row_bg(accent_rgb888);
    lv_obj_set_style_bg_color(panel, lv_color_hex(color), 0);
    lv_obj_set_style_border_color(panel, lv_color_hex(selected ? 0xFFFFFF : UI_INK), 0);
}
