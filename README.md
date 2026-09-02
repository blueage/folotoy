# FoloPass 2FA

把 2FAS Auth 的备份文件在浏览器里解密，挑一批令牌推送到 **FoloToy AI Passport 工卡**上，
之后不用掏手机、不用开网页，抬起工卡就能看验证码。

仓库里是两半东西，它们靠一条 BLE 协议对接：

| 目录 | 是什么 |
| --- | --- |
| `web/` | 零后端的静态网页：导入 `.2fas` 备份、本地解密、管理与排序、通过 Web Bluetooth 推送到工卡 |
| `main/`、`components/`、`bootloader_components/` | 工卡固件（ESP-IDF 5.5.3 / ESP32-C3），显示验证码并接收推送 |

固件基线来自开源项目 [folotoy/ai-passport](https://github.com/folotoy/ai-passport)（MIT），
`components/bsp` 与分区、Recovery 约定原样保留；网页部分基于同一作者的 quick2fas 查看器演进而来。

## 它是怎么用的

1. 在电脑上打开网页（**必须是 HTTPS 或 localhost**，Web Bluetooth 与 WebCrypto 都只在安全上下文可用），
   导入 2FAS Auth 导出的 `.2fas` 备份，明文与加密备份都支持。
2. 拖拽调整顺序、删掉不要的、给中文名的条目手填一个 ASCII 显示名（工卡只有拉丁字体）。
3. 工卡上长按「确定」进入 **SYNC** 页面，屏幕显示 `FoloPass-XXXX`。
4. 网页里点「同步到工卡」→「连接工卡」，选中同名设备，点「推送」。
5. 回到工卡：上/下翻条目，短按「确定」看大字验证码，再按一次返回。

推送是**整体替换**：勾中的条目就是推送后卡上的全部条目，顺序与网页列表一致。

在网页的工卡面板里还可以存一个 **2.4 GHz Wi-Fi**：之后工卡每次开机会自己连上去用 NTP
对一次时，**对完立刻把 Wi-Fi 整个关掉**，不再联网。这样掉电重启后不必再掏出网页。
不配也能用，只是回到"每次断电后手动对时"。

## 工卡上的三块屏与按键

| 页面 | 上 / 下 | 确定（短按） | 确定（长按） |
| --- | --- | --- | --- |
| 列表 | 移动选中项（每页四行） | 进入大字详情 | 进入 / 退出 SYNC |
| 详情 | 切换上一条 / 下一条 | 回到列表 | 进入 / 退出 SYNC |
| SYNC | — | — | 退出 SYNC 并回到列表 |

屏幕在 30 秒无操作后变暗（不熄屏，仍然看得清），按任意键恢复全亮且这一下照常生效。
同步页始终全亮。省电细节见 [`docs/power.zh_CN.md`](docs/power.zh_CN.md)。

列表页顶栏：**左上角是本地时间 `HH:MM`**（时区由网页在同步时下发），**右上角是电量百分比**
（低于 20% 转红；电量计读不到时显示 `--`）。倒计时条在最后 5 秒变红。

**冷启动（掉电后重新上电）时工卡不显示任何验证码**，只提示 `NO TIME`：它无从知道离线了
多久，宁可不显示也不给一个看不出错的错码。恢复方式二选一：配了 Wi-Fi 就等它开机自己对完
（底部会显示进度），没配就连网页点一次「只对时」。深睡眠唤醒不受影响。

## 安全须知（务必先读）

这套东西把 TOTP 种子从手机搬到了**浏览器**和**一张挂在胸前的卡**上，两处都削弱了
"第二个因素"原本的分离性。请在明确接受下列取舍后再使用：

- **网页侧**：种子在 IndexedDB 里以不可导出的密钥加密存放，这只提高离线翻取浏览器
  数据目录的门槛，**挡不住同源 XSS，也挡不住正在操作你浏览器的人**。详见
  [`web/README.md`](web/README.md) 的「安全须知」，单文件形态还有额外风险。
- **工卡侧**：种子**明文**存在 NVS 里，没有 PIN、没有锁屏。捡到卡的人可以看到全部验证码。
  这是本项目当前明确选定的取舍（换取"抬手就能看"）。
- **Wi-Fi 侧**：Wi-Fi 密码同样经不加密的 BLE 下发、明文存 NVS。**给工卡用访客网络，
  别用主网络的密码。**
- **链路侧**：BLE 链路不加密、不配对。挡在数据前面的是**物理动作**——只有有人在工卡上
  按键进入 SYNC 页面，协议栈才会启动并广播，退出即停止。代价是：同步的那十几秒内，
  射频范围内的嗅探设备可以看到明文种子。**请在自己家里/工位上同步，别在会场里推。**

细节与备选方案见 [`docs/security.zh_CN.md`](docs/security.zh_CN.md)。

## 开发

需要 Node.js ≥ 20 与 ESP-IDF 5.5.3。

```bash
# 网页
cd web && npm install
npm run dev            # 开发服务器（localhost 是安全上下文，蓝牙可用）
npm test               # Vitest
npm run build          # 静态产物 dist/

# 固件
source <ESP-IDF-5.5.3>/export.sh
idf.py set-target esp32c3
idf.py build
idf.py flash monitor

# 统一入口
./tools/validate.sh --static     # 固件纯逻辑测试 + 网页类型检查/ESLint/单测
./tools/validate.sh --firmware   # 全新目录编译 + merge-bin + 分区与 Recovery 校验
./tools/validate.sh              # 两者都跑
```

烧录优先使用 `./tools/validate.sh --firmware` 产出的
`build/FoloToy-AI-Passport-full.bin`（从 `0x0` 整片写入空白设备）。
已有身份的设备请按 [`docs/flashing.zh_CN.md`](docs/flashing.zh_CN.md) 的说明操作，
`cardid`（`0x356000`）与 `recovery`（`0x700000`）两个保护分区不得覆盖。

## 文档

- [`docs/protocol.zh_CN.md`](docs/protocol.zh_CN.md) — BLE 同步协议的完整线格式（两端的唯一契约）
- [`docs/security.zh_CN.md`](docs/security.zh_CN.md) — 威胁模型、已接受的取舍与可选的加固方向
- [`docs/flashing.zh_CN.md`](docs/flashing.zh_CN.md) — 编译、烧录与真机验收清单
- [`docs/power.zh_CN.md`](docs/power.zh_CN.md) — 功耗去向、已做的省电措施、为什么不做 deep sleep、怎么实测续航
- [`web/README.md`](web/README.md) — 网页部分的构建形态、图标管线与 CSP 说明

## 许可

MIT，见 [`LICENSE`](LICENSE)。固件基线的版权归 FoloToy，详见文件内容。
