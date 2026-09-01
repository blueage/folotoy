# BLE 同步协议

网页与工卡之间的**唯一契约**。两端的实现分别在：

- 固件：[`main/otp_wire.c`](../main/otp_wire.c)（解析）与 [`main/otp_sync.c`](../main/otp_sync.c)（GATT / 回帧）
- 网页：[`web/src/lib/badge/protocol.ts`](../web/src/lib/badge/protocol.ts)（编解码）与
  [`web/src/lib/badge/sync.ts`](../web/src/lib/badge/sync.ts)（流程）

**当前版本：v2。** v1 → v2 的改动：BEGIN / TIME 末尾追加时区偏移；新增 `WIFI` 帧；
STATUS 追加 Wi-Fi 两个字段。版本不一致时网页会在握手阶段直接拒绝，不会带着错误的
字段偏移往下走。

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
issuer_len:u8      0..20，可打印 ASCII，可为空
issuer[issuer_len]
```

payload 末尾多出任何字节都判 `ERR_LENGTH`：那意味着两端对字段的理解不同，
宁可整帧拒收，也不接受"看起来能解析"的一半。

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
 |-- HELLO(version=1) --------------->|
 |<-- STATUS(capacity, stored, ...) --|
 |-- BEGIN(count, now) -------------->|   重置暂存区
 |<-- ACK(BEGIN, OK) -----------------|
 |-- ENTRY(0) ----------------------->|   逐条校验后进暂存区
 |-- ENTRY(1) ----------------------->|
 |-- COMMIT(crc32) ------------------>|   校验通过才写 NVS + settimeofday
 |<-- ACK(COMMIT, OK, n) -------------|
 |<-- STATUS(stored=n) ---------------|
```

两条不变量：

1. **只有 COMMIT 成功才生效。** 中途任何失败都丢掉整个暂存区，工卡上的旧数据原样不动——
   绝不会出现"同步到一半，卡上少了几条"。
2. **没有时间就不写。** BEGIN 里的时间为 0 时 COMMIT 判 `ERR_NO_TIME`：
   写进去一批算不出正确验证码的种子，比不写更糟。

## 工卡侧的落盘格式

NVS 命名空间 `folo2fa`：

- `vault`：保险库 blob，编解码见 [`main/otp_vault_codec.c`](../main/otp_vault_codec.c)。
  头部是魔数 `"2FAV"` + 版本 + 条数，随后是逐条的变长记录。任何一处不合法都**整体判损坏**
  并按空库处理——半份保险库比空的更危险：用户会以为条目还在。
- `last_sync`：上次同步的 Unix 秒，只用于显示"上次同步于何时"，**不用来算码**。
- `tz_min`：本地时区相对 UTC 的分钟偏移，顶栏显示本地时间用。
- `wifi_ssid` / `wifi_pass`：开机自动对时用的凭据，明文。
