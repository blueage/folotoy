#!/usr/bin/env python3
"""把一张精灵图里的若干格转成固件能直接贴的 RGB565 帧。

用途：详情页草地上跑过的那个小人。工卡上没有图片解码器，也没有缩放的余裕，
所以这里在编译前就把像素铺好——按整数倍最近邻放大，出来的边缘和原图一样利落。

典型用法（三帧走路循环，16×16 的格子放大 3 倍成 48×48）：

    python3 tools/gen_sprite.py \\
        --input tools/sprites/runner.png \\
        --output main/ui_runner_sprite.c \\
        --origin 1,1 --pitch 17,17 --cell 16,16 \\
        --frames 2,3,4 --scale 3 \\
        --transparent 93BBEC --background 1689E8

几个刻意的选择：

* **只做整数倍最近邻放大。** 像素画一旦用插值缩放就糊了，而工卡这块屏的观感
  全靠边缘利落。倍数不整就直接报错，不偷偷凑合。
* **透明色在这里就换成底色。** 小人只在天空那一段跑（草地顶边之上），用不着
  真的透明通道；提前合成掉，固件那边就少一层混合。
* **输出是 const 数组。** 它落在 .rodata 里，运行时零内存占用——LVGL 的画布
  直接指着 flash 读。

自带自测：tests/test_gen_sprite.py
"""

from __future__ import annotations

import argparse
import struct
import sys
import zlib
from pathlib import Path

Rgb = tuple[int, int, int]


def load_png(path: Path) -> tuple[int, int, int, bytes]:
    """解出一张 8 位真彩 PNG。返回 (宽, 高, 通道数, 像素字节)。

    只支持 8 位、非交错的 RGB / RGBA —— 精灵图都是这个形状，多余的分支只会
    变成没人测过的代码。
    """
    data = path.read_bytes()
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError(f"{path} 不是 PNG")

    pos, idat = 8, bytearray()
    width = height = channels = 0
    while pos < len(data):
        (length,) = struct.unpack(">I", data[pos : pos + 4])
        kind = data[pos + 4 : pos + 8]
        body = data[pos + 8 : pos + 8 + length]
        if kind == b"IHDR":
            width, height, depth, ctype, _comp, _filt, interlace = struct.unpack(
                ">IIBBBBB", body
            )
            if depth != 8 or interlace != 0 or ctype not in (2, 6):
                raise ValueError("只支持 8 位、非交错的 RGB / RGBA PNG")
            channels = 3 if ctype == 2 else 4
        elif kind == b"IDAT":
            idat += body
        elif kind == b"IEND":
            break
        pos += 12 + length

    raw = zlib.decompress(bytes(idat))
    stride = width * channels
    out = bytearray(width * height * channels)
    prev = bytearray(stride)
    cursor = 0
    for y in range(height):
        filter_type = raw[cursor]
        cursor += 1
        line = bytearray(raw[cursor : cursor + stride])
        cursor += stride
        # PNG 的五种行滤波器（RFC 2083 §6）。逐行还原，上一行是解码后的。
        if filter_type == 1:  # Sub
            for i in range(channels, stride):
                line[i] = (line[i] + line[i - channels]) & 0xFF
        elif filter_type == 2:  # Up
            for i in range(stride):
                line[i] = (line[i] + prev[i]) & 0xFF
        elif filter_type == 3:  # Average
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                line[i] = (line[i] + ((left + prev[i]) >> 1)) & 0xFF
        elif filter_type == 4:  # Paeth
            for i in range(stride):
                left = line[i - channels] if i >= channels else 0
                up = prev[i]
                up_left = prev[i - channels] if i >= channels else 0
                pa, pb, pc = (
                    abs(up - up_left),
                    abs(left - up_left),
                    abs(left + up - 2 * up_left),
                )
                pred = left if (pa <= pb and pa <= pc) else (up if pb <= pc else up_left)
                line[i] = (line[i] + pred) & 0xFF
        elif filter_type != 0:
            raise ValueError(f"第 {y} 行的滤波器类型 {filter_type} 不认识")
        out[y * stride : (y + 1) * stride] = line
        prev = line

    return width, height, channels, bytes(out)


def parse_hex_color(text: str) -> Rgb:
    value = int(text.lstrip("#"), 16)
    return ((value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF)


def parse_pair(text: str) -> tuple[int, int]:
    left, _, right = text.partition(",")
    return int(left), int(right)


def to_rgb565(color: Rgb) -> int:
    red, green, blue = color
    return ((red >> 3) << 11) | ((green >> 2) << 5) | (blue >> 3)


def blend(src: Rgb, dst: Rgb, alpha: int) -> Rgb:
    """把 src 按 alpha 压到 dst 上。四舍五入，免得整帧系统性偏向底色。"""
    return tuple((s * alpha + d * (255 - alpha) + 127) // 255 for s, d in zip(src, dst))


def extract_frame(
    png: tuple[int, int, int, bytes],
    origin: tuple[int, int],
    pitch: tuple[int, int],
    cell: tuple[int, int],
    index: int,
    columns: int,
    scale: int,
    transparent: Rgb | None,
    background: Rgb,
) -> list[int]:
    """取出第 index 格，放大 scale 倍，返回 RGB565 的一维数组。"""
    width, height, channels, pixels = png
    cell_w, cell_h = cell
    x0 = origin[0] + pitch[0] * (index % columns)
    y0 = origin[1] + pitch[1] * (index // columns)
    if x0 + cell_w > width or y0 + cell_h > height:
        raise ValueError(f"第 {index} 格越出图片范围（{width}×{height}）")

    frame: list[int] = []
    for y in range(cell_h * scale):
        for x in range(cell_w * scale):
            offset = ((y0 + y // scale) * width + (x0 + x // scale)) * channels
            color: Rgb = (pixels[offset], pixels[offset + 1], pixels[offset + 2])
            alpha = pixels[offset + 3] if channels == 4 else 255
            if transparent is not None and color == transparent:
                alpha = 0
            # 半透明（RGBA 图的抗锯齿边缘）也在这里合成掉。
            color = background if alpha == 0 else blend(color, background, alpha)
            frame.append(to_rgb565(color))
    return frame


def render_c(name: str, frames: list[list[int]], cell: tuple[int, int], scale: int,
             command: str) -> tuple[str, str]:
    """返回 (.c 的内容, .h 的内容)。"""
    width, height = cell[0] * scale, cell[1] * scale
    lines = [
        f"// 本文件由 tools/gen_sprite.py 生成，请勿手改。",
        f"// 重新生成：{command}",
        "//",
        "// 数组是 const，落在 .rodata 里：LVGL 的画布直接指着 flash 读，运行时不占内存。",
        "",
        f'#include "{name}.h"',
        "",
        f"const uint16_t {name}_frames[{name.upper()}_COUNT]"
        f"[{name.upper()}_W * {name.upper()}_H] = {{",
    ]
    for frame in frames:
        lines.append("    {")
        for y in range(height):
            row = frame[y * width : (y + 1) * width]
            lines.append("        " + " ".join(f"0x{v:04X}," for v in row))
        lines.append("    },")
    lines += ["};", ""]

    header = [
        f"// 本文件由 tools/gen_sprite.py 生成，请勿手改。",
        f"// 重新生成：{command}",
        "#pragma once",
        "",
        "#include <stdint.h>",
        "",
        f"#define {name.upper()}_W {width}",
        f"#define {name.upper()}_H {height}",
        f"#define {name.upper()}_COUNT {len(frames)}",
        "",
        f"extern const uint16_t {name}_frames[{name.upper()}_COUNT]"
        f"[{name.upper()}_W * {name.upper()}_H];",
        "",
    ]
    return "\n".join(lines), "\n".join(header)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--input", required=True, type=Path, help="精灵图 PNG")
    parser.add_argument("--output", required=True, type=Path, help="生成的 .c（.h 同名）")
    parser.add_argument("--name", default=None, help="C 标识符前缀，默认取输出文件名")
    parser.add_argument("--origin", default="0,0", help="第一格左上角，形如 1,1")
    parser.add_argument("--pitch", default=None, help="格子间距，形如 17,17；默认等于格子大小")
    parser.add_argument("--cell", required=True, help="格子大小，形如 16,16")
    parser.add_argument("--columns", type=int, default=None, help="每行几格，默认按图宽算")
    parser.add_argument("--frames", required=True, help="要哪几格，形如 2,3,4（从 0 数）")
    parser.add_argument("--scale", type=int, default=1, help="整数倍最近邻放大")
    parser.add_argument("--transparent", default=None, help="当作透明的颜色，形如 93BBEC")
    parser.add_argument("--background", default="000000", help="透明处铺什么颜色")
    args = parser.parse_args(argv)

    if args.scale < 1:
        parser.error("--scale 至少是 1")

    cell = parse_pair(args.cell)
    pitch = parse_pair(args.pitch) if args.pitch else cell
    origin = parse_pair(args.origin)
    png = load_png(args.input)
    columns = args.columns or max(1, (png[0] - origin[0] + pitch[0] - 1) // pitch[0])
    indices = [int(v) for v in args.frames.split(",")]

    frames = [
        extract_frame(
            png, origin, pitch, cell, index, columns, args.scale,
            parse_hex_color(args.transparent) if args.transparent else None,
            parse_hex_color(args.background),
        )
        for index in indices
    ]

    name = args.name or args.output.stem
    command = " ".join(["python3", "tools/gen_sprite.py"] + (argv or sys.argv[1:]))
    source, header = render_c(name, frames, cell, args.scale, command)
    args.output.write_text(source + "\n", encoding="utf-8")
    args.output.with_suffix(".h").write_text(header, encoding="utf-8")
    print(
        f"生成 {args.output} 与 {args.output.with_suffix('.h')}："
        f"{len(frames)} 帧 × {cell[0] * args.scale}×{cell[1] * args.scale}"
        f"（{len(frames) * cell[0] * cell[1] * args.scale * args.scale * 2} 字节 .rodata）"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
