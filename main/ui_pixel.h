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
// 纸色牌子上的次要文字（网页那边是 slate-500）。UI_MUTED 是给深底用的，
// 铺在 UI_PAPER 上几乎看不见。
#define UI_INK_SOFT   0x64748B

// 版面的三条横线。顶栏与草地各压掉一截，省出来的 22 px 全给了令牌行——
// 行里要塞下网页那样的图标块，46 px 高的行装不下。
//   顶栏：牌子 4..32（28 高，正好是 20 号字的行高 22 + 上下 3 px 边框）
//   内容：38 起
//   草地：296 起（原来 286），页脚文字压在 299，装饰草丛退到 314
#define UI_TOPBAR_Y    4
#define UI_TOPBAR_H    28
#define UI_CONTENT_TOP 38
#define UI_GRASS_TOP   296
#define UI_FOOTER_Y    299

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

// 让一个对象从 from_x 一路走到 to_x，到头再从 from_x 开始，无限循环；y 是它的上沿。
// hop_px > 0 时额外上下颠一颠（给没有腿部动画的对象用），传 0 关掉。
//
// ★ 动画一开，LVGL 就得按刷新周期一直重画，light sleep 也就没得睡了。
//   调用方必须自己管好"什么时候不该跑"——详情页的做法是屏幕一变暗就把整个
//   对象删掉（见 otp_ui.c 的 refresh_detail）。
void ui_pixel_run_across(lv_obj_t *obj, int32_t from_x, int32_t to_x, int32_t y,
                         uint32_t duration_ms, int32_t hop_px);

// 草地上跑过的小人。像素是 tools/gen_sprite.py 生成的（main/ui_runner_sprite.h
// 里有尺寸与帧数），画布直接指着 flash 读，运行时不占内存。
// 每调一次 step 走一帧，走完循环回第一帧。整个程序只会有一个。
lv_obj_t *ui_pixel_runner_create(lv_obj_t *parent, int x, int y);
void ui_pixel_runner_step(lv_obj_t *runner);
// 未选中的令牌行底色：纸色掺一层品牌色。图标要按同一个底色混合它半透明的边缘，
// 所以这个混色只能有一处实现，两边各算一遍迟早会算出不同的结果。
uint32_t ui_pixel_row_bg(uint32_t accent_rgb888);

// 令牌行的底色。未选中时是纸色掺一层品牌色——网页那边整行也铺着同一种淡色，
// 于是"这行是哪家的"在扫一眼时就有答案；选中时一律压成高亮黄：
// 当前是哪一行必须一眼可辨，这件事比品牌气质重要。
void ui_pixel_set_row_color(lv_obj_t *panel, bool selected, uint32_t accent_rgb888);
