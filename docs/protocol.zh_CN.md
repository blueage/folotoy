# BLE 同步协议

网页与工卡之间的**唯一契约**。两端的实现分别在：

- 固件：[`main/otp_wire.c`](../main/otp_wire.c)（解析）与 [`main/otp_sync.c`](../main/otp_sync.c)（GATT / 回帧）
- 网页：[`web/src/lib/badge/protocol.ts`](../web/src/lib/badge/protocol.ts)（编解码）与
  [`web/src/lib/badge/sync.ts`](../web/src/lib/badge/sync.ts)（流程）

**当前版本：v4。**

- v1 → v2：BEGIN / TIME 末尾追加时区偏移；新增 `WIFI` 帧；STATUS 追加 Wi-Fi 两个字段。
- v2 → v3：ENTRY 末尾追加 `accent` 与 `icon_crc`；新增 `ICON` 帧（列表页的品牌图标）；
  COMMIT 的 CRC 改为覆盖 ENTRY **与** ICON 两种 payload。
- v3 → v4：`issuer`（副标题）上限 20 → 21。帧的排布一个字节都没变，之所以还是升了
  版本号：旧固件会把 21 个字符的副标题判成 `ERR_FIELD` 并拒收整批，与其让用户在推送
  中途撞上一个含糊的错误码，不如在握手时就说清楚。

版本不一致时网页会在握手阶段直接拒绝，不会带着错误的字段偏移往下走。

改动协议时：先改本文，再改两端，最后跑 `./tools/validate.sh --static`。
`web/src/lib/badge/fakeBadge.ts` 是照着本文重新实现的一台假工卡，
它存在的意义就是让"两端理解不一致"在测试里暴露，而不是等到真机上表现为一直拒收。

## GATT

| 项 | 值 |
| --- | --- |
| 广播名 | `FoloPass-XXXX`（`XXXX` 取自 BT MAC 后两字节） |
| 服务 UUID | `2fa50001-0b0e-4c1a-9a5e-8f2b1d7c4e10` |
| RX（网页写，工卡收） | `2fa50002-0b0e-4c1a-9a5e-8f2b1d7c4e10`，`WRITE` + `WRITE_NO_RSP` |
| TX（工卡 notify） | `2fa50003-0b0e-4c1a-9a5e-8f2b1d7c4e10`，`NOTIFY` |

128 位 UUID 占 18 字节，与名字一起塞不进 31 字节的广播包，因此**放在扫描响应里**。
网页按 `namePrefix: 'FoloPass'` 过滤，并把服务列进 `optionalServices`。

协议栈只在工卡停留在 SYNC 页面时启动；退出页面即 `nimble_port_stop()`，广播随之消失。

## 帧

两个方向共用同一个帧头，多字节整数一律**小端**：

```
type:u8 | length:u16 | payload[length]
```

传输层只保证字节按序到达，不保证按帧到达：一帧可能被拆进多次写，一次写也可能带来多帧。
两端都按**字节流**重组。网页固定按 20 字节一块写（默认 MTU 下一次写的最大负载），
写小了永远安全，赌 MTU 会在某些平台上变成静默截断。

单帧 payload 上限 128 字节；超长帧会被整帧读完再报 `ERR_LENGTH`，
否则它的 payload 会被当成后续帧的帧头，一次坏帧毁掉整条连接。

### 网页 → 工卡

| type | 名称 | payload |
| --- | --- | --- |
| `0x01` | HELLO | `version:u8`。工卡回 STATUS |
| `0x02` | BEGIN | `count:u16` `unix_seconds:u64` `tz_offset_min:i16`。重置暂存区；`count > 30` 判 `ERR_TOO_MANY` |
| `0x03` | ENTRY | 见下 |
| `0x04` | COMMIT | `crc32:u32`（覆盖全部 ENTRY payload，按顺序累计） |
| `0x05` | TIME | `unix_seconds:u64` `tz_offset_min:i16`，只对时不动条目 |
| `0x06` | WIPE | 空，清空工卡上的全部令牌 |
| `0x07` | WIFI | `ssid_len:u8` `ssid[]` `pass_len:u8` `pass[]`，`ssid_len = 0` 表示关闭开机联网 |
| `0x08` | ICON | `index:u16` `offset:u16` `total:u16` `data[]`，见下 |

**`tz_offset_min` 是有符号的**（东八区 = `+480`，美东 = `-300`）。工卡自己无从知道它在哪个
时区，顶栏的本地时间全靠这个字段。按无符号读会把 `-300` 变成 65236 分钟，表盘直接拨到
45 天以后——两端的测试各有一条用例守着这个符号。

Wi-Fi 凭据也走这条链路，也就是**明文过空气**，与令牌种子同等对待。工卡上同样明文存 NVS。

ENTRY 的 payload：

```
index:u16          必须从 0 严格连续递增，跳号即判 ERR_SEQUENCE
digits:u8          6..8
period:u8          >= 10
algorithm:u8       0=SHA1 1=SHA256 2=SHA512
secret_len:u8      10..40（已 Base32 解码的原始字节）
secret[secret_len]
label_len:u8       0..20，可打印 ASCII，且不得为空
label[label_len]
issuer_len:u8      0..21，可打印 ASCII，可为空（工卡上是名字底下那行副标题）
issuer[issuer_len]
accent:u16         品牌主色，RGB565
icon_crc:u32       这一条图标位图的 CRC32，0 表示没有图标
```

`accent` 是工卡整行铺的那层淡色（网页上同一行也铺着它），也是图标丢失时的兜底色块。
`icon_crc` 把条目和图标绑在一起：图标存在工卡的另一个分区、不随保险库一起写，
显示前要拿它核对，对不上就当没有图——**绝不把上一批的 logo 贴到这一条旁边**。

payload 末尾多出任何字节都判 `ERR_LENGTH`：那意味着两端对字段的理解不同，
宁可整帧拒收，也不接受"看起来能解析"的一半。

### ICON

一张图标有几百字节，装不进一帧（payload 上限 128），因此按 `offset` 分片续写：

```
index:u16          属于第几条。必须是**已经收到过 ENTRY** 的下标，否则判 ERR_SEQUENCE
offset:u16         本片在位图中的字节偏移。0 表示新起一张；其余必须严格接在上一片之后
total:u16          整张位图的字节数，1..1280。每一片都带着它，且必须前后一致
data[]             位图字节，每片至多 122
```

**图标紧跟在自己那条 ENTRY 后面发**，而不是所有条目发完再统一发。这样工卡一次只需要
装配一张图（1.3 KB 的缓冲），不必为 30 张预留空间。

收齐 `total` 字节后工卡会做两件事，任何一件不过都整批拒收：

1. 位图结构必须完整（版本、几何、调色板、行程流正好铺满 48×48 个像素），否则 `ERR_FIELD`；
2. 位图的 CRC32 必须等于那条 ENTRY 里的 `icon_crc`，否则 `ERR_CRC`。

**COMMIT 的 CRC 覆盖 ENTRY 与 ICON 两种 payload**，按发出的顺序累计。图标丢一片
也要在 COMMIT 时暴露：半张图会安静地画错，比整批拒收难查得多。

30 张图标大约 12~18 KB，按"每次写 20 字节、写一次等一次响应"的速度，一次带图标的
推送要十几秒到半分钟——比 v2 慢，但工卡上那一列图标是一次性的代价。

### 工卡 → 网页

| type | 名称 | payload |
| --- | --- | --- |
| `0x81` | STATUS | `protocol:u8` `capacity:u8` `stored:u8` `time_valid:u8` `last_sync:u64` `name_len:u8` `name[]` `wifi_configured:u8` `wifi_state:u8` |
| `0x82` | ACK | `ref_frame:u8` `ack:u8` `received:u16` `expected:u16` |

Wi-Fi 的两个字段**追加在变长的 `name` 之后**：网页按 `name_len` 跳过名字再读，
读不到就按"未配置"处理。这样加字段不必再动一次版本号。
`wifi_state` 对应固件的 `otp_wifi_state_t`：0 未配置、1 连接中、2 对时中、3 成功、4 失败。

工卡在这些时刻主动发 STATUS：订阅通知时、收到 HELLO 时、COMMIT / WIPE 完成后。

**COMMIT 之后 ACK 与 STATUS 是连着发的。** 网页必须在发 COMMIT 之前就挂好 STATUS 监听：
等收完 ACK 再去订阅，两次订阅之间的那一瞬就把 STATUS 丢了，
表现是"工卡明明写成功了，网页却报超时"。`sync.ts` 的 `watchStatus()` 就是干这个的。

### 结果码（`ack`）

| 值 | 含义 |
| --- | --- |
| 0 | 成功 |
| 1 | 协议版本不一致 |
| 2 | 帧顺序不对（未 BEGIN 就 ENTRY、下标跳号、条目数对不上） |
| 3 | 超过工卡容量（30 条） |
| 4 | 字段越界或标签不是可打印 ASCII |
| 5 | CRC 不匹配 |
| 6 | payload 长度与帧类型不符 |
| 7 | 未知帧类型 |
| 8 | 工卡没有可用时间（BEGIN 里的时间为 0） |
| 9 | 工卡写 NVS 失败 |

## 一次完整同步

```
网页                                 工卡
 |-- HELLO(version=3) --------------->|
 |<-- STATUS(capacity, stored, ...) --|
 |-- BEGIN(count, now) -------------->|   重置暂存区
 |<-- ACK(BEGIN, OK) -----------------|
 |-- ENTRY(0) ----------------------->|   逐条校验后进暂存区
 |-- ICON(0, 0)  -------------------->|   第 0 条的图标，分片续写
 |-- ICON(0, 122) ------------------->|
 |-- ENTRY(1) ----------------------->|
 |-- ICON(1, 0)  -------------------->|
 |-- COMMIT(crc32) ------------------>|   校验通过才写 NVS + settimeofday
 |<-- ACK(COMMIT, OK, n) -------------|
 |<-- STATUS(stored=n) ---------------|
```

两条不变量：

1. **只有 COMMIT 成功才生效。** 中途任何失败都丢掉整个暂存区，工卡上的旧数据原样不动——
   绝不会出现"同步到一半，卡上少了几条"。
2. **没有时间就不写。** BEGIN 里的时间为 0 时 COMMIT 判 `ERR_NO_TIME`：
   写进去一批算不出正确验证码的种子，比不写更糟。

## 图标位图

工卡上没有矢量渲染器，也放不下一整个品牌图标库，因此**图标是网页画好推上去的**：
网页把页面上那块斜着的色块光栅化成 48×48 像素（`web/src/lib/badge/raster.ts`），
按下面的格式压成几百字节。固件只负责检查它结构完整、把它铺回一块 RGB565 像素
（`main/otp_icon.c`）。

```
version:u8         当前是 1
width:u8           必须等于 48（固件 OTP_ICON_W）
height:u8          必须等于 48（固件 OTP_ICON_H）
palette_len:u8     1..16
palette[palette_len] × { rgb565:u16 小端, alpha:u8 }
行程流：
  count(1..255) index:u8       同色行程：count 个同一下标
  0x00 count(1..255) packed[]  字面量段：count 个下标按 4bpp 打包，每字节高半字节在前
```

几点是有意为之：

- **宽高写在位图里**，工卡拿它和自己的常量比。固件换过行高之后，卡上那批旧图必须
  整体作废，而不是被拉伸成一团；
- **调色板带 alpha**。图标是斜着的方块，右上右下两角本来就该露出行底色，而行底色
  随"这一行是否选中"变化——所以透明部分不烤底色，混合由工卡在展开时做；
- **有字面量段**是为了给最坏情况封顶。只有同色行程时，一段颜色反复变化的边缘会退化成
  "每像素 2 字节"，比不压缩还大一倍；有了字面量段，最坏也就是每像素半字节。
  上限 1280 字节（`OTP_ICON_BLOB_MAX`）正是按这个最坏情况算的。

## 工卡侧的落盘格式

NVS 命名空间 `folo2fa`：

- `vault`：保险库 blob，编解码见 [`main/otp_vault_codec.c`](../main/otp_vault_codec.c)。
  头部是魔数 `"2FAV"` + 版本 + 条数，随后是逐条的变长记录。任何一处不合法都**整体判损坏**
  并按空库处理——半份保险库比空的更危险：用户会以为条目还在。
  blob 版本 2 起，每条记录末尾多了 `accent:u16` 与 `icon_crc:u32`。
- `last_sync`：上次同步的 Unix 秒，只用于显示"上次同步于何时"，**不用来算码**。
- `tz_min`：本地时区相对 UTC 的分钟偏移，顶栏显示本地时间用。
- `wifi_ssid` / `wifi_pass`：开机自动对时用的凭据，明文。

图标不在这个命名空间里：它们住在分区表单独的 `icons` 分区（见 `partitions.csv`），
一条一格，键名是 `i00`..`i29`。分开放是因为体积——30 张图十几 KB，而 `nvs` 分区一共
才 0x6000。它们也**不参与保险库的整批原子性**：写图标失败或写到一半掉电，最坏也只是
那几行的 `icon_crc` 对不上、退回纯色块。
