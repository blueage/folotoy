// 工卡侧的硬边界。这些常量与固件 main/otp_types.h 一一对应：
// 任何一处改动都必须两边同时改，否则设备会静默拒收整批条目。

//   v1 → v2：BEGIN / TIME 末尾追加时区偏移；新增 WIFI 帧；STATUS 追加 Wi-Fi 状态。
//   v2 → v3：ENTRY 末尾追加 accent 与 icon_crc；新增 ICON 帧；
//            COMMIT 的 CRC 改为覆盖 ENTRY 与 ICON 两种 payload。
//   v3 → v4：副标题上限 20 → 21。帧的排布没变，但旧固件会把 21 个字符判成
//            ERR_FIELD 并拒收整批，不如在握手时就报版本不一致。
export const BADGE_PROTOCOL_VERSION = 4;

/** 工卡最多保存的条目数（固件 OTP_MAX_ENTRIES）。 */
export const BADGE_MAX_ENTRIES = 30;

/** 解码后的密钥字节数区间（固件 OTP_SECRET_MIN / OTP_SECRET_MAX）。 */
export const BADGE_SECRET_MIN_BYTES = 10;
export const BADGE_SECRET_MAX_BYTES = 40;

/**
 * 屏幕上的名字与副标题长度上限（固件 OTP_LABEL_MAX / OTP_ISSUER_MAX）。
 *
 * 副标题多一格：它在工卡上自己占一整行，12 号字写满 21 格还放得下。
 */
export const BADGE_LABEL_MAX = 20;
export const BADGE_ISSUER_MAX = 21;

/**
 * 工卡列表里那块品牌图标的像素尺寸（固件 OTP_ICON_W / OTP_ICON_H）。
 *
 * 它是**两端写死的契约**：位图头里带着宽高，工卡拿它和自己的常量比，
 * 对不上就整批拒收——固件换了行高之后，卡上那批旧图必须整体作废，
 * 而不是被拉伸成一团。
 */
export const BADGE_ICON_W = 48;
export const BADGE_ICON_H = 48;

/** 位图格式版本（固件 OTP_ICON_BLOB_VERSION）。 */
export const BADGE_ICON_BLOB_VERSION = 1;

/** 调色板格数上限：4bpp 的下标只有 16 个值（固件 OTP_ICON_PALETTE_MAX）。 */
export const BADGE_ICON_PALETTE_MAX = 16;

/** 单张图标的字节上限（固件 OTP_ICON_BLOB_MAX）。 */
export const BADGE_ICON_BLOB_MAX = 1280;

/** Wi-Fi 凭据的长度上限（IEEE 802.11 的 SSID 32 字节、WPA2 口令 63 字节）。 */
export const BADGE_WIFI_SSID_MAX = 32;
export const BADGE_WIFI_PASS_MAX = 64;

export const BADGE_DIGITS_MIN = 6;
export const BADGE_DIGITS_MAX = 8;
export const BADGE_PERIOD_MIN = 10;
export const BADGE_PERIOD_MAX = 255;

/** 固件里的算法编号。 */
export const BADGE_ALGORITHM_CODE = { SHA1: 0, SHA256: 1, SHA512: 2 } as const;

/**
 * 工卡的字体只有 Montserrat 拉丁字集，中文名在屏幕上是一串豆腐块。
 * 这里把不能显示的字符**去掉**而不是替换成问号：留下 "?????" 既没信息量，
 * 还会占满本来就只有 20 格的宽度。
 *
 * @returns 清洗后的文本，以及是否有字符被丢弃（界面据此提示用户手工改名）。
 */
export function sanitizeBadgeText(
  text: string,
  maxLength: number,
): { text: string; dropped: boolean } {
  const kept = [...text].filter((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code >= 0x20 && code <= 0x7e;
  });
  const collapsed = kept.join('').replace(/\s+/g, ' ').trim();
  return { text: collapsed.slice(0, maxLength), dropped: collapsed.length < text.trim().length };
}

/** 文本是否可以原样送上工卡。 */
export function isBadgeText(text: string, maxLength: number): boolean {
  return text.length <= maxLength && /^[\x20-\x7e]*$/.test(text);
}
