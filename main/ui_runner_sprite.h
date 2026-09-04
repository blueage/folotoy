// 本文件由 tools/gen_sprite.py 生成，请勿手改。
// 重新生成：python3 tools/gen_sprite.py --input tools/sprites/runner.png --output main/ui_runner_sprite.c --origin 1,1 --pitch 17,17 --cell 16,16 --frames 2,3,4 --scale 3 --transparent 93BBEC --background 1689E8
#pragma once

#include <stdint.h>

#define UI_RUNNER_SPRITE_W 48
#define UI_RUNNER_SPRITE_H 48
#define UI_RUNNER_SPRITE_COUNT 3

extern const uint16_t ui_runner_sprite_frames[UI_RUNNER_SPRITE_COUNT][UI_RUNNER_SPRITE_W * UI_RUNNER_SPRITE_H];
