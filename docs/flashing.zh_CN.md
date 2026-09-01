# 编译、烧录与真机验收

## 环境

- ESP-IDF **5.5.3**（其他版本未验证；`idf_component.yml` 里锁的是 `>=5.5.3,<5.6.0`）
- Node.js ≥ 20（网页部分）

```bash
source <ESP-IDF-5.5.3>/export.sh
idf.py --version        # 必须输出 ESP-IDF v5.5.3
idf.py set-target esp32c3
```

## 编译

```bash
./tools/validate.sh --firmware   # 优先：全新临时目录编译 + merge-bin + 校验
idf.py build                     # 增量开发用
```

门禁会校验：分区表 MD5、应用大小、`cardid`（`0x356000`）与 `recovery`（`0x700000`）
两个保护分区没有被打进镜像、Recovery bootloader hook 仍在。通过后把
`build/FoloToy-AI-Passport-full.bin` 留在仓库里，那是唯一可以从 `0x0` 整片写入的产物。

> **关于体积的两条事实**（先前这里写错过，已更正）：
>
> - 真正的上限是 `factory` 分区的 **3 MB**。ESP-IDF 会拿镜像和**最小的 app 分区**
>   （1 MB 的 `recovery`）比一次，超了只打印
>   `Warning: 1/2 app partitions are too small`，**构建照常通过**——因为它在 factory 里放得下。
>   我们从不把应用烧进 recovery 槽，这条警告可以忽略。
> - `sdkconfig.defaults` 里开了 `CONFIG_COMPILER_OPTIMIZATION_SIZE`（`-Os`）。
>   默认的 `-Og` 会让镜像多出约 100 KB。加入 Wi-Fi 协议栈后当前约 1.35 MB。
>
> ⚠️ **改 `sdkconfig.defaults` 不会更新已存在的 `sdkconfig`。** 增量开发时必须
> `rm sdkconfig` 后重新 `idf.py build`，否则你以为改了配置、其实烧进去的还是老的
> （这个坑真实发生过：栈大小改了没生效）。`./tools/validate.sh --firmware` 不受影响，
> 它每次都从 defaults 在临时目录里重建。

## 烧录

空白设备：

```bash
python -m esptool --chip esp32c3 write_flash 0x0 build/FoloToy-AI-Passport-full.bin
```

已经有设备身份（`cardid`）的卡：**不要**从 `0x0` 整片写。用分段烧录：

```bash
idf.py flash            # 只写 bootloader / 分区表 / app
```

开机时按住「上」键 5 秒可跳回出厂预装的 Recovery，USB 开发不会把设备刷成砖。

## 真机验收清单

以下每一项都**必须在真实硬件上跑**，编译通过不能替代。本仓库的代码到目前为止
只做过主机侧逻辑测试与 ESP-IDF 编译，**尚未在真机上验证过**。

| # | 步骤 | 期望 |
| --- | --- | --- |
| 1 | 空卡上电 | 列表页显示 `No tokens yet.` 与 `NO TIME`，不崩溃 |
| 2 | 长按「确定」 | 进入 SYNC 页，显示 `READY` 与 `FoloPass-XXXX` |
| 3 | 网页点「连接工卡」 | 浏览器弹窗里能看到同名设备；连上后页面显示容量 30、卡上 0 条 |
| 4 | 推送 3 条 | SYNC 页依次显示 `RECEIVING n/3` → `SAVED 3 tokens`；网页提示已推送 3 条 |
| 5 | 长按「确定」退出 | 回到列表，3 条按网页里的顺序排列，验证码与手机上的 2FAS 一致 |
| 6 | 倒计时 | 进度条随秒收缩，最后 5 秒变红，跨周期时验证码在 1 秒内翻新 |
| 7 | 短按「确定」 | 进入大字详情，剩余秒数递减；再按返回列表 |
| 8 | 断电重启 | 列表仍有 3 条（NVS 落盘成功），但显示 `NO TIME` 且不出验证码 |
| 9 | 只对时 | 网页点「只对时」后，工卡立即开始显示验证码 |
| 10 | 深睡唤醒 | 若走深睡眠路径唤醒，时间应仍然可用，验证码正确 |
| 11 | 中途断链 | 推送过程中把网页关掉，工卡上的旧条目原样保留，不出现半份保险库 |
| 12 | 清空 | 网页点「清空工卡」并确认后，工卡显示 `ERASED`，重启后列表为空 |
| 13 | 满仓 | 推 30 条，工卡应全部接受；推 31 条应在网页侧就被拦下 |
| 14 | 续航 | 记录同步一次后正常使用的耗电，评估背光常亮下的可用时长 |
| 15 | 顶栏 | 左上角显示本地时间 `HH:MM`（时区取自浏览器），右上角显示电量百分比 |
| 16 | 低电 | 电量低于 20% 时右上角转红；电量计读不到时显示 `--` 而不是编一个数字 |
| 17 | Wi-Fi 配置 | 网页保存 Wi-Fi 后，握手状态显示"已配置"，工卡 NVS 里留下凭据 |
| 18 | 开机对时 | 断电重启后底部依次出现 `Wi-Fi: connecting...` → `getting time...`，随后验证码自动出现，全程无需网页 |
| 19 | Wi-Fi 关闭 | 对时完成后串口打印 `Wi-Fi 已关闭，state=3`；此后设备不再联网 |
| 20 | 无 Wi-Fi 降级 | 故意填错密码：应在约 12 秒后显示 `Wi-Fi failed - hold OK to sync`，设备不卡死、仍可用网页对时 |
| 21 | 5 GHz | ESP32-C3 只支持 2.4 GHz；填 5 GHz 的网络应表现为连接失败而不是崩溃 |

第 5 项与第 6 项是这套东西的核心：验证码错了，其余都没有意义。
