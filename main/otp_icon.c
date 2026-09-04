#include "otp_icon.h"

#include <string.h>

// 位图头：version:u8 | width:u8 | height:u8 | palette_len:u8
#define ICON_HEADER_SIZE 4
// 调色板每格：rgb565:u16 小端 | alpha:u8
#define ICON_PALETTE_ENTRY 3

uint16_t otp_icon_rgb565(uint32_t rgb888)
{
    uint16_t r = (uint16_t)((rgb888 >> 19) & 0x1FU);
    uint16_t g = (uint16_t)((rgb888 >> 10) & 0x3FU);
    uint16_t b = (uint16_t)((rgb888 >> 3) & 0x1FU);
    return (uint16_t)((r << 11) | (g << 5) | b);
}

static void unpack565(uint16_t color, uint8_t *r, uint8_t *g, uint8_t *b);

uint32_t otp_icon_rgb888(uint16_t rgb565)
{
    uint8_t r, g, b;
    unpack565(rgb565, &r, &g, &b);
    return ((uint32_t)r << 16) | ((uint32_t)g << 8) | (uint32_t)b;
}

// 5/6 位分量还原成 8 位时要**把高位补到低位**（r << 3 | r >> 2），
// 不能简单左移：那样 0x1F 会变成 0xF8，纯白会渲染成浅灰，整块图偏暗。
static void unpack565(uint16_t color, uint8_t *r, uint8_t *g, uint8_t *b)
{
    uint8_t r5 = (uint8_t)((color >> 11) & 0x1FU);
    uint8_t g6 = (uint8_t)((color >> 5) & 0x3FU);
    uint8_t b5 = (uint8_t)(color & 0x1FU);
    *r = (uint8_t)((r5 << 3) | (r5 >> 2));
    *g = (uint8_t)((g6 << 2) | (g6 >> 4));
    *b = (uint8_t)((b5 << 3) | (b5 >> 2));
}

static uint16_t pack565(uint8_t r, uint8_t g, uint8_t b)
{
    return (uint16_t)(((uint16_t)(r >> 3) << 11) | ((uint16_t)(g >> 2) << 5) | (uint16_t)(b >> 3));
}

static uint8_t blend(uint8_t src, uint8_t dst, uint8_t alpha)
{
    // +127 是四舍五入：向下取整会让整幅图系统性地偏向底色。
    return (uint8_t)(((uint32_t)src * alpha + (uint32_t)dst * (255U - alpha) + 127U) / 255U);
}

typedef struct {
    uint16_t color[OTP_ICON_PALETTE_MAX];
    uint8_t alpha[OTP_ICON_PALETTE_MAX];
    uint8_t len;
    const uint8_t *stream;  // 行程编码流的首字节
    size_t stream_len;
} icon_header_t;

// 头部与调色板。out 可为 NULL —— 只做结构检查时不需要留下它。
static bool parse_header(const uint8_t *blob, size_t len, icon_header_t *out)
{
    if (blob == NULL || len < ICON_HEADER_SIZE) {
        return false;
    }
    if (blob[0] != OTP_ICON_BLOB_VERSION) {
        return false;
    }
    // 几何写死在两端的常量里：固件升级换了行高之后，卡上那批旧图标必须整体作废，
    // 而不是被拉伸成一团。
    if (blob[1] != OTP_ICON_W || blob[2] != OTP_ICON_H) {
        return false;
    }
    uint8_t palette_len = blob[3];
    if (palette_len == 0U || palette_len > OTP_ICON_PALETTE_MAX) {
        return false;
    }
    size_t palette_bytes = (size_t)palette_len * ICON_PALETTE_ENTRY;
    if (len < ICON_HEADER_SIZE + palette_bytes) {
        return false;
    }

    if (out != NULL) {
        memset(out, 0, sizeof(*out));
        out->len = palette_len;
        for (uint8_t i = 0; i < palette_len; i++) {
            const uint8_t *slot = &blob[ICON_HEADER_SIZE + (size_t)i * ICON_PALETTE_ENTRY];
            out->color[i] = (uint16_t)((uint16_t)slot[0] | ((uint16_t)slot[1] << 8));
            out->alpha[i] = slot[2];
        }
        out->stream = &blob[ICON_HEADER_SIZE + palette_bytes];
        out->stream_len = len - ICON_HEADER_SIZE - palette_bytes;
    }
    return true;
}

/*
 * 行程编码流。两种记号，都以一个字节的计数开头：
 *
 *   count(1..255) index:u8            —— 同色行程，count 个同一调色板下标
 *   0x00 count(1..255) packed[]       —— 字面量段，count 个下标按 4bpp 打包，
 *                                        每字节高半字节在前
 *
 * 有字面量段是为了**给最坏情况封顶**：只有同色行程时，一段颜色反复变化的边缘
 * 会退化成"每像素 2 字节"，比不压缩还大一倍；有了字面量段，最坏也就是
 * 每像素半字节 + 每 255 像素 2 字节开销。
 *
 * out 为 NULL 时只走一遍流、数像素，不写任何东西（结构检查用）。
 */
static bool walk_stream(const icon_header_t *header, const uint16_t *resolved, uint16_t *out)
{
    size_t cursor = 0;
    size_t written = 0;

    while (cursor < header->stream_len) {
        uint8_t count = header->stream[cursor++];
        if (cursor >= header->stream_len) {
            return false;
        }

        if (count != 0U) {
            uint8_t index = header->stream[cursor++];
            if (index >= header->len || written + count > OTP_ICON_PIXELS) {
                return false;
            }
            if (out != NULL) {
                for (uint8_t i = 0; i < count; i++) {
                    out[written + i] = resolved[index];
                }
            }
            written += count;
            continue;
        }

        // 字面量段
        uint8_t literal = header->stream[cursor++];
        if (literal == 0U) {
            return false;  // 空段：编码器不会这么写，出现即为损坏
        }
        size_t packed = ((size_t)literal + 1U) / 2U;
        if (cursor + packed > header->stream_len || written + literal > OTP_ICON_PIXELS) {
            return false;
        }
        for (uint8_t i = 0; i < literal; i++) {
            uint8_t byte = header->stream[cursor + (size_t)(i / 2U)];
            uint8_t index = (i % 2U == 0U) ? (uint8_t)(byte >> 4) : (uint8_t)(byte & 0x0FU);
            if (index >= header->len) {
                return false;
            }
            if (out != NULL) {
                out[written + i] = resolved[index];
            }
        }
        cursor += packed;
        written += literal;
    }

    // 少一个像素都算损坏：铺不满就会在屏幕上留下一条没写过的脏内存。
    return written == OTP_ICON_PIXELS;
}

// 调色板 → 已经和行底色混合好的 RGB565。混合只做一次（16 格），
// 而不是每个像素做一次。
static void resolve_palette(const icon_header_t *header, uint16_t bg, uint16_t *resolved)
{
    uint8_t br, bgc, bb;
    unpack565(bg, &br, &bgc, &bb);
    for (uint8_t i = 0; i < header->len; i++) {
        uint8_t alpha = header->alpha[i];
        if (alpha == 255U) {
            resolved[i] = header->color[i];
            continue;
        }
        uint8_t r, g, b;
        unpack565(header->color[i], &r, &g, &b);
        resolved[i] = pack565(blend(r, br, alpha), blend(g, bgc, alpha), blend(b, bb, alpha));
    }
}

bool otp_icon_blob_check(const uint8_t *blob, size_t len)
{
    icon_header_t header;
    if (!parse_header(blob, len, &header)) {
        return false;
    }
    return walk_stream(&header, NULL, NULL);
}

bool otp_icon_expand(const uint8_t *blob, size_t len, uint16_t bg, uint16_t *out,
                     size_t out_pixels)
{
    if (out == NULL || out_pixels < OTP_ICON_PIXELS) {
        return false;
    }
    icon_header_t header;
    if (!parse_header(blob, len, &header)) {
        return false;
    }
    // 先干跑一遍确认整条流合法，再真的写：否则一条中途才发现损坏的流
    // 会在缓冲里留下半张图。
    if (!walk_stream(&header, NULL, NULL)) {
        return false;
    }
    uint16_t resolved[OTP_ICON_PALETTE_MAX];
    resolve_palette(&header, bg, resolved);
    return walk_stream(&header, resolved, out);
}
