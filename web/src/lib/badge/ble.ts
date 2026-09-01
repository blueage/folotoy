// Web Bluetooth 传输层：把 BadgeLink 接到真实的工卡上。
// 这一层只做"连上、写字节、收通知"，任何协议语义都在 protocol.ts / sync.ts。

import { DeviceFrameReader, type DeviceFrame } from './protocol';
import { BadgeSyncError, type BadgeLink } from './sync';

// 与固件 main/otp_sync.c 的三串 UUID 对应。
export const BADGE_SERVICE_UUID = '2fa50001-0b0e-4c1a-9a5e-8f2b1d7c4e10';
export const BADGE_RX_UUID = '2fa50002-0b0e-4c1a-9a5e-8f2b1d7c4e10';
export const BADGE_TX_UUID = '2fa50003-0b0e-4c1a-9a5e-8f2b1d7c4e10';

/** 广播名前缀，见固件 build_device_name()。 */
export const BADGE_NAME_PREFIX = 'FoloPass';

/**
 * 每次 GATT 写的字节数。
 *
 * 刻意取 20：那是 BLE 默认 MTU（23）下一次写能带的最大负载。协商到更大的 MTU
 * 时它只是"偏保守"，而写小了永远是安全的；反过来赌 MTU 大小会在某些平台上
 * 变成静默截断。固件那边本来就是按字节流重组的，不在乎每次写了多少。
 */
const CHUNK_BYTES = 20;

export interface ConnectedBadge {
  link: BadgeLink;
  /** 广播名，例如 FoloPass-1A2B。 */
  name: string;
  disconnect(): void;
  /** 注册断链回调（用户走远、工卡退出 SYNC 页都会触发）。 */
  onDisconnected(listener: () => void): () => void;
}

export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && navigator.bluetooth !== undefined;
}

export async function connectBadge(): Promise<ConnectedBadge> {
  if (!isWebBluetoothAvailable()) {
    throw new BadgeSyncError(
      '这个浏览器不支持 Web Bluetooth。请在桌面版 Chrome / Edge 或安卓 Chrome 里打开本页面，' +
        '并确认页面是 HTTPS（或 localhost）。iOS 的 Safari 不支持。',
    );
  }

  let device: BluetoothDevice;
  try {
    device = await navigator.bluetooth.requestDevice({
      // 按名字前缀筛选，同时把服务列进 optionalServices —— 否则连上以后
      // 拿不到这个服务的访问权限。
      filters: [{ namePrefix: BADGE_NAME_PREFIX }],
      optionalServices: [BADGE_SERVICE_UUID],
    });
  } catch (cause) {
    // 用户点了取消也会走到这里；这不是错误，但调用方需要知道没有连上。
    throw new BadgeSyncError(
      cause instanceof Error && cause.name === 'NotFoundError'
        ? '没有选择工卡。请先在工卡上长按「确定」进入 SYNC 页面，再重新连接。'
        : '无法打开蓝牙设备选择框。',
    );
  }

  const server = await device.gatt?.connect();
  if (server === undefined) {
    throw new BadgeSyncError('连接工卡失败，请重试。');
  }

  const service = await server.getPrimaryService(BADGE_SERVICE_UUID);
  const rx = await service.getCharacteristic(BADGE_RX_UUID);
  const tx = await service.getCharacteristic(BADGE_TX_UUID);

  const listeners = new Set<(frame: DeviceFrame) => void>();
  const reader = new DeviceFrameReader();

  const onValue = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic;
    const value = target.value;
    if (value === undefined) {
      return;
    }
    const chunk = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    for (const frame of reader.push(chunk)) {
      for (const listener of listeners) {
        listener(frame);
      }
    }
  };

  tx.addEventListener('characteristicvaluechanged', onValue);
  await tx.startNotifications();

  const disconnectListeners = new Set<() => void>();
  const onDisconnectedEvent = () => {
    for (const listener of disconnectListeners) {
      listener();
    }
  };
  device.addEventListener('gattserverdisconnected', onDisconnectedEvent);

  const link: BadgeLink = {
    async send(frame: Uint8Array): Promise<void> {
      for (let offset = 0; offset < frame.length; offset += CHUNK_BYTES) {
        const chunk = frame.slice(offset, offset + CHUNK_BYTES);
        // 用"带响应"的写：它天然是流控，写完一块才发下一块，
        // 不会像 without-response 那样在慢链路上悄悄丢包。
        await rx.writeValueWithResponse(chunk);
      }
    },
    subscribe(listener: (frame: DeviceFrame) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };

  return {
    link,
    name: device.name ?? BADGE_NAME_PREFIX,
    disconnect(): void {
      device.removeEventListener('gattserverdisconnected', onDisconnectedEvent);
      tx.removeEventListener('characteristicvaluechanged', onValue);
      listeners.clear();
      disconnectListeners.clear();
      if (device.gatt?.connected === true) {
        device.gatt.disconnect();
      }
    },
    onDisconnected(listener: () => void): () => void {
      disconnectListeners.add(listener);
      return () => disconnectListeners.delete(listener);
    },
  };
}
