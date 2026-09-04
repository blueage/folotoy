#!/usr/bin/env python3
"""tools/gen_sprite.py 的自测。

用现造的小图，不依赖任何外部素材：这样这条测试在谁的机器上都跑得起来，
也不会因为换了张精灵图就红。
"""

from __future__ import annotations

import re
import struct
import sys
import tempfile
import zlib
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "tools"))

import gen_sprite  # noqa: E402


def write_png(path: Path, width: int, height: int, pixel) -> None:
    """写一张 8 位 RGB PNG。逐行用 filter 0，解码端的四种滤波器另外测。"""
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        for x in range(width):
            raw += bytes(pixel(x, y))

    def chunk(kind: bytes, body: bytes) -> bytes:
        payload = kind + body
        return struct.pack(">I", len(body)) + payload + struct.pack(
            ">I", zlib.crc32(payload) & 0xFFFFFFFF
        )

    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(bytes(raw)))
        + chunk(b"IEND", b"")
    )


BG = (0x93, 0xBB, 0xEC)  # 当作透明的格子底色
SKY = (0x16, 0x89, 0xE8)  # 替换成的天空色
RED = (0xFF, 0x00, 0x00)
GREEN = (0x00, 0xFF, 0x00)


def make_sheet(path: Path) -> None:
    """两格 2×2，格子间隔 1px：左格左上角红点，右格左上角绿点，其余是底色。"""

    def pixel(x: int, y: int):
        if (x, y) == (1, 1):
            return RED
        if (x, y) == (4, 1):
            return GREEN
        return BG

    write_png(path, 7, 4, pixel)


def read_frames(source: Path):
    values = [int(v, 16) for v in re.findall(r"0x([0-9A-F]{4}),", source.read_text())]
    return values


def check(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def main() -> int:
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        sheet = work / "sheet.png"
        make_sheet(sheet)

        out = work / "ui_test_sprite.c"
        rc = gen_sprite.main(
            [
                "--input", str(sheet),
                "--output", str(out),
                "--origin", "1,1",
                "--pitch", "3,3",
                "--cell", "2,2",
                "--columns", "2",
                "--frames", "0,1",
                "--scale", "2",
                "--transparent", "93BBEC",
                "--background", "1689E8",
            ]
        )
        check(rc == 0, "生成器应当返回 0")

        header = out.with_suffix(".h").read_text()
        check("#define UI_TEST_SPRITE_W 4" in header, "宽度应当是 2×2 放大后的 4")
        check("#define UI_TEST_SPRITE_H 4" in header, "高度应当是 4")
        check("#define UI_TEST_SPRITE_COUNT 2" in header, "应当有两帧")

        values = read_frames(out)
        check(len(values) == 2 * 4 * 4, f"应当有 32 个像素，实际 {len(values)}")

        red565 = gen_sprite.to_rgb565(RED)
        green565 = gen_sprite.to_rgb565(GREEN)
        sky565 = gen_sprite.to_rgb565(SKY)

        first, second = values[:16], values[16:]
        # 放大 2 倍：原图左上角那一个点变成 2×2 的一块。
        check(
            first[0] == first[1] == first[4] == first[5] == red565,
            "第一帧左上角 2×2 都该是红色（最近邻放大，不做插值）",
        )
        check(first[15] == sky565, "透明处应当已经换成天空色")
        check(second[0] == green565, "第二帧取的是右边那一格")
        check(
            all(v in (red565, sky565) for v in first),
            "第一帧不该出现第二格的颜色——格子间距算错就会串格",
        )

        # 边界：越出图片范围要报错，而不是悄悄取到别的格子。
        try:
            gen_sprite.main(
                [
                    "--input", str(sheet), "--output", str(work / "x.c"),
                    "--origin", "1,1", "--pitch", "3,3", "--cell", "2,2",
                    "--columns", "2", "--frames", "9", "--scale", "1",
                ]
            )
        except ValueError:
            pass
        else:
            raise AssertionError("取一个不存在的格子应当报错")

    print("test_gen_sprite: PASS")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
