#pragma once

#include "lvgl.h"

#define UI_SKY        0x1689E8
#define UI_SKY_DARK   0x0872C9
#define UI_INK        0x17202A
#define UI_PAPER      0xF4F4EA
#define UI_GRASS      0x82BE2D
#define UI_GRASS_DARK 0x55951D
#define UI_YELLOW     0xFFD928
#define UI_ORANGE     0xFFB23E
#define UI_RED        0xE43B2F
#define UI_MUTED      0xD9E7EC

lv_obj_t *ui_pixel_screen_create(const char *title);

// 建屏的可调版本。列表页要在顶栏放时间与电量，所以需要：更窄的标题牌、
// 不要那朵云（它正好占着右上角），以及标题标签的指针（时间每分钟要改字）。
// heading_out 可为 NULL。
lv_obj_t *ui_pixel_screen_create_ex(const char *title, int plate_w, bool with_cloud,
                                    lv_obj_t **heading_out);

// 顶栏用的小牌子：纸色底 + 黑边 + 投影，和标题牌同一套观感。返回牌子对象，
// 调用方往里放标签即可。
lv_obj_t *ui_pixel_plate_create(lv_obj_t *parent, int x, int y, int w, int h);
lv_obj_t *ui_pixel_panel_create(lv_obj_t *parent, int x, int y, int w, int h,
                                uint32_t color);
lv_obj_t *ui_pixel_label(lv_obj_t *parent, const char *text,
                         const lv_font_t *font, uint32_t color);
lv_obj_t *ui_pixel_mascot_create(lv_obj_t *parent, int x, int y);
void ui_pixel_mascot_jump(lv_obj_t *mascot);
void ui_pixel_set_selected(lv_obj_t *panel, bool selected, bool enabled);
