// main/otp_wire.h —— 网页 → 工卡的线格式（纯逻辑，可在主机上测试）。
//
// 传输层（BLE 特征写）只保证"字节按序到达"，不保证按帧到达：一帧可能被拆进
// 多次写，一次写也可能带来多帧。因此这里做的是流式重组 + 逐帧解析。
//
// 帧结构：type:u8 | len:u16 小端 | payload[len]
// 所有多字节整数一律小端，与 web/src/lib/badge/protocol.ts 对应。
#pragma once

#include "otp_icon.h"
#include "otp_types.h"

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// 协议版本。任何不向后兼容的字段改动都必须 +1，两端同时改。
//   v1 → v2：BEGIN / TIME 末尾追加时区偏移；新增 WIFI 帧。
//   v2 → v3：ENTRY 末尾追加 accent 与 icon_crc；新增 ICON 帧；
//            COMMIT 的 CRC 改为覆盖 ENTRY 与 ICON 两种 payload。
//   v3 → v4：issuer（副标题）上限 20 → 21。帧的排布一个字节都没变，但旧固件
//            会把 21 个字符的副标题判成 ERR_FIELD 并拒收整批；与其让用户在
//            推送中途撞上一个含糊的错误码，不如在握手时就说清楚版本不一致。
#define OTP_WIRE_VERSION 4

// 单帧 payload 上限。最大的一帧是 ENTRY：
// 2+1+1+1+1+40（密钥）+1+20（标签）+1+21（副标题）+2（accent）+4（icon_crc）= 95 字节。
#define OTP_WIRE_PAYLOAD_MAX 128

#define OTP_WIRE_HEADER_SIZE 3

// 与 main/otp_wifi.h 的上限一致（IEEE 802.11 的 SSID 32 字节、WPA2 口令 63 字节）。
#define OTP_WIFI_SSID_LIMIT 32
#define OTP_WIFI_PASS_LIMIT 64

typedef enum {
    OTP_FRAME_HELLO = 0x01,   // version:u8
    OTP_FRAME_BEGIN = 0x02,   // count:u16 | unix_seconds:u64 | tz_offset_min:i16
    OTP_FRAME_ENTRY = 0x03,   // 见 parse_entry()
    OTP_FRAME_COMMIT = 0x04,  // crc32:u32（对全部 ENTRY payload 依次累计）
    OTP_FRAME_TIME = 0x05,    // unix_seconds:u64 | tz_offset_min:i16
    OTP_FRAME_WIPE = 0x06,    // 空
    OTP_FRAME_WIFI = 0x07,    // ssid_len:u8 | ssid[] | pass_len:u8 | pass[]
    OTP_FRAME_ICON = 0x08,    // index:u16 | offset:u16 | total:u16 | data[]
} otp_frame_type_t;

// ACK 里的结果码。网页端按码给出中文提示，不依赖设备发文本。
typedef enum {
    OTP_ACK_OK = 0,
    OTP_ACK_ERR_VERSION = 1,        // 协议版本不一致
    OTP_ACK_ERR_SEQUENCE = 2,       // 帧顺序不对（如未 BEGIN 就 ENTRY）
    OTP_ACK_ERR_TOO_MANY = 3,       // 超过 OTP_MAX_ENTRIES
    OTP_ACK_ERR_FIELD = 4,          // 字段越界或非 ASCII 标签
    OTP_ACK_ERR_CRC = 5,            // 校验和不匹配
    OTP_ACK_ERR_LENGTH = 6,         // payload 长度与帧类型不符
    OTP_ACK_ERR_UNKNOWN_FRAME = 7,  // 未知帧类型
    OTP_ACK_ERR_NO_TIME = 8,        // 提交时没有可用的时间
    OTP_ACK_ERR_STORAGE = 9,        // 设备侧写入失败（由上层填）
} otp_ack_t;

typedef enum {
    OTP_WIRE_EVENT_HELLO,
    OTP_WIRE_EVENT_BEGIN,
    OTP_WIRE_EVENT_PROGRESS,
    OTP_WIRE_EVENT_COMMIT,
    OTP_WIRE_EVENT_TIME,
    OTP_WIRE_EVENT_WIPE,
    OTP_WIRE_EVENT_WIFI,
    OTP_WIRE_EVENT_ICON,
    OTP_WIRE_EVENT_ERROR,
} otp_wire_event_type_t;

typedef struct {
    otp_wire_event_type_t type;
    uint8_t frame;   // 触发本事件的帧类型
    uint8_t ack;     // otp_ack_t
    uint16_t received;
    uint16_t expected;
    uint64_t unix_seconds;  // 仅 BEGIN / TIME / COMMIT 有意义
    int16_t tz_minutes;     // 仅 BEGIN / TIME 有意义
    uint16_t icon_index;    // 仅 ICON 有意义：这张图属于第几条
} otp_wire_event_t;

typedef void (*otp_wire_cb_t)(const otp_wire_event_t *event, void *context);

typedef struct {
    uint8_t header[OTP_WIRE_HEADER_SIZE];
    uint8_t header_filled;
    uint8_t payload[OTP_WIRE_PAYLOAD_MAX];
    uint16_t payload_len;
    uint16_t payload_filled;
    // 声明长度超过上限的帧：照常吃掉它的字节再报错，否则后面的帧会跟着错位。
    bool skipping;
    uint8_t frame_type;

    otp_vault_t staging;
    uint16_t expected;
    uint16_t received;
    uint32_t crc;
    uint64_t unix_seconds;
    int16_t tz_minutes;
    bool time_present;

    // WIFI 帧解出的凭据。放在会话里而不是事件里：事件是按值传的，
    // 把 96 字节口令塞进去会让每个回调都拖着它走。
    char wifi_ssid[OTP_WIFI_SSID_LIMIT + 1];
    char wifi_password[OTP_WIFI_PASS_LIMIT + 1];

    // 正在装配的图标。图标一张就有几百字节，装不进一帧，因此按 offset 续写；
    // 一次只装一张：网页是"发完第 n 条的 ENTRY 紧跟它的 ICON"这样串行推的。
    uint8_t icon_blob[OTP_ICON_BLOB_MAX];
    uint16_t icon_index;
    uint16_t icon_total;
    uint16_t icon_filled;
    bool icon_active;
    uint16_t icon_ready_index;  // 刚装配完的那张（OTP_WIRE_EVENT_ICON 期间有效）
    uint16_t icon_ready_len;
} otp_wire_t;

void otp_wire_reset(otp_wire_t *wire);

// 喂入任意长度的字节；每解析出一帧就回调一次 cb（可为 NULL）。
void otp_wire_feed(otp_wire_t *wire, const uint8_t *data, size_t len, otp_wire_cb_t cb,
                   void *context);

// COMMIT 事件回调期间（及之后未再喂入数据前）有效的暂存保险库。
const otp_vault_t *otp_wire_staging(const otp_wire_t *wire);

// OTP_WIRE_EVENT_ICON 回调期间有效的图标位图。返回字节数，写不出时返回 0。
const uint8_t *otp_wire_icon(const otp_wire_t *wire, uint16_t *len);
