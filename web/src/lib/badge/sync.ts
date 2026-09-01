// 一次推送的编排：HELLO → 等 STATUS → BEGIN → ENTRY × n → COMMIT → 等 ACK。
//
// 这一层不认识 Web Bluetooth：它只依赖 BadgeLink 这个接口，因此可以用一个
// 假链路在 jsdom 里完整跑通整条流程（src/lib/badge/sync.test.ts）。

import {
  AckCode,
  type BadgeEntry,
  type DeviceFrame,
  HostFrame,
  browserTzOffsetMin,
  buildPushFrames,
  describeAck,
  encodeHello,
  encodeTime,
  encodeWifi,
  encodeWipe,
} from './protocol';
import { BADGE_MAX_ENTRIES, BADGE_PROTOCOL_VERSION } from './limits';

/** 与工卡之间的一条已建立的链路。 */
export interface BadgeLink {
  /** 发一整帧；分块由实现负责。 */
  send(frame: Uint8Array): Promise<void>;
  /** 订阅工卡的通知，返回退订函数。 */
  subscribe(listener: (frame: DeviceFrame) => void): () => void;
}

export interface BadgeStatus {
  protocol: number;
  capacity: number;
  stored: number;
  timeValid: boolean;
  lastSyncSec: number;
  name: string;
  wifiConfigured: boolean;
  wifiState: number;
}

/** 同步过程中的失败。message 已经是可以直接显示给用户的中文。 */
export class BadgeSyncError extends Error {
  readonly ack: number | null;

  constructor(message: string, ack: number | null = null) {
    super(message);
    this.name = 'BadgeSyncError';
    this.ack = ack;
    Object.setPrototypeOf(this, BadgeSyncError.prototype);
  }
}

const DEFAULT_TIMEOUT_MS = 8000;

/**
 * 发一帧并等一个满足条件的回帧。
 *
 * 先订阅、后发送：反过来会漏掉在 await send 期间就已经到达的通知。
 */
async function request<T extends DeviceFrame>(
  link: BadgeLink,
  frame: Uint8Array | null,
  match: (received: DeviceFrame) => received is T,
  timeoutMs: number,
  timeoutMessage: string,
): Promise<T> {
  // 放在对象里而不是裸变量：赋值发生在回调内部，裸变量会被 TS 的控制流分析
  // 收窄成 never，finally 里就调不动了。
  const cleanup: { unsubscribe: (() => void) | null } = { unsubscribe: null };
  let timer: ReturnType<typeof setTimeout> | null = null;

  try {
    const waiting = new Promise<T>((resolve, reject) => {
      cleanup.unsubscribe = link.subscribe((received) => {
        if (match(received)) {
          resolve(received);
        }
      });
      timer = setTimeout(() => {
        reject(new BadgeSyncError(timeoutMessage));
      }, timeoutMs);
    });

    if (frame !== null) {
      await link.send(frame);
    }
    return await waiting;
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    cleanup.unsubscribe?.();
  }
}

function isStatus(frame: DeviceFrame): frame is Extract<DeviceFrame, { kind: 'status' }> {
  return frame.kind === 'status';
}

/**
 * 常驻的 STATUS 监听。
 *
 * COMMIT 之后工卡会**连着**发 ACK 与 STATUS 两帧。若等完 ACK 再去订阅 STATUS，
 * 两次订阅之间的那一瞬 STATUS 就丢了，表现是"写入明明成功，网页却报超时"。
 * 因此这里在整个推送期间一直挂着一个监听：帧先到也接得住。
 */
function watchStatus(link: BadgeLink) {
  let latest: BadgeStatus | null = null;
  let notify: ((status: BadgeStatus) => void) | null = null;

  const unsubscribe = link.subscribe((frame) => {
    if (isStatus(frame)) {
      latest = frame;
      notify?.(frame);
    }
  });

  return {
    /** 丢弃此前收到的 STATUS，只认接下来那一帧。 */
    reset(): void {
      latest = null;
    },
    async take(timeoutMs: number, timeoutMessage: string): Promise<BadgeStatus> {
      if (latest !== null) {
        return latest;
      }
      return new Promise<BadgeStatus>((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = null;
          reject(new BadgeSyncError(timeoutMessage));
        }, timeoutMs);
        notify = (status) => {
          clearTimeout(timer);
          notify = null;
          resolve(status);
        };
      });
    },
    stop: unsubscribe,
  };
}

function ackMatcher(refFrame: number) {
  return (frame: DeviceFrame): frame is Extract<DeviceFrame, { kind: 'ack' }> =>
    frame.kind === 'ack' && frame.refFrame === refFrame;
}

/** 握手：确认协议版本一致，并读回工卡当前的状态。 */
export async function readStatus(link: BadgeLink, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<BadgeStatus> {
  const status = await request(
    link,
    encodeHello(),
    isStatus,
    timeoutMs,
    '工卡没有回应。请确认工卡停留在 SYNC 页面。',
  );
  if (status.protocol !== BADGE_PROTOCOL_VERSION) {
    throw new BadgeSyncError(
      `工卡固件的协议版本是 ${String(status.protocol)}，本页面是 ${String(
        BADGE_PROTOCOL_VERSION,
      )}，请更新其中一侧。`,
      AckCode.ERR_VERSION,
    );
  }
  return status;
}

export interface PushOptions {
  /** 取当前时间（Unix 秒）。默认读浏览器时钟；测试注入固定值。 */
  nowSec?: () => number;
  /** 时区偏移（分钟，东为正）。默认取浏览器时区；工卡靠它显示本地时间。 */
  tzOffsetMin?: number;
  onProgress?(sent: number, total: number): void;
  timeoutMs?: number;
}

export interface PushResult {
  count: number;
  status: BadgeStatus;
}

/**
 * 把一批条目整体推送到工卡。工卡侧是"整体替换"：只有 COMMIT 成功才生效，
 * 中途失败不会留下半份保险库。
 */
export async function pushEntries(
  link: BadgeLink,
  entries: BadgeEntry[],
  options: PushOptions = {},
): Promise<PushResult> {
  if (entries.length > BADGE_MAX_ENTRIES) {
    throw new BadgeSyncError(
      `最多只能推送 ${String(BADGE_MAX_ENTRIES)} 条，当前选了 ${String(entries.length)} 条。`,
      AckCode.ERR_TOO_MANY,
    );
  }

  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const frames = buildPushFrames(entries, nowSec(), options.tzOffsetMin ?? browserTzOffsetMin());
  const statusWatch = watchStatus(link);

  try {
    const beginAck = await request(
      link,
      frames.begin,
      ackMatcher(HostFrame.BEGIN),
      timeoutMs,
      '工卡没有确认开始，请重试。',
    );
    if (beginAck.ack !== AckCode.OK) {
      throw new BadgeSyncError(describeAck(beginAck.ack), beginAck.ack);
    }

    // 条目帧不逐条等确认：工卡只在出错时回帧，而 COMMIT 的 CRC 会兜住任何丢失。
    let sent = 0;
    for (const frame of frames.entries) {
      await link.send(frame);
      sent += 1;
      options.onProgress?.(sent, frames.entries.length);
    }

    // 只认 COMMIT 之后那一帧 STATUS，别把握手时的旧状态当成结果。
    statusWatch.reset();
    const commitAck = await request(
      link,
      frames.commit,
      ackMatcher(HostFrame.COMMIT),
      timeoutMs,
      '工卡没有确认写入，令牌可能未保存，请重试。',
    );
    if (commitAck.ack !== AckCode.OK) {
      throw new BadgeSyncError(describeAck(commitAck.ack), commitAck.ack);
    }

    const status = await statusWatch.take(timeoutMs, '工卡已写入，但没有回报最新状态。');
    return { count: commitAck.received, status };
  } finally {
    statusWatch.stop();
  }
}

/** 只对时，不动条目。工卡冷启动后必须先有时间才会显示验证码。 */
export async function pushTime(
  link: BadgeLink,
  options: PushOptions = {},
): Promise<void> {
  const nowSec = options.nowSec ?? (() => Math.floor(Date.now() / 1000));
  const ack = await request(
    link,
    encodeTime(nowSec(), options.tzOffsetMin ?? browserTzOffsetMin()),
    ackMatcher(HostFrame.TIME),
    options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    '工卡没有确认对时，请重试。',
  );
  if (ack.ack !== AckCode.OK) {
    throw new BadgeSyncError(describeAck(ack.ack), ack.ack);
  }
}

/**
 * 保存 Wi-Fi 凭据，供工卡下次开机自动对时。ssid 传空串表示以后不再联网。
 *
 * 凭据经不加密的 BLE 链路下发，与种子同等对待——见 docs/security.zh_CN.md。
 */
export async function setWifiCredentials(
  link: BadgeLink,
  ssid: string,
  password: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<void> {
  const ack = await request(
    link,
    encodeWifi(ssid, password),
    ackMatcher(HostFrame.WIFI),
    timeoutMs,
    '工卡没有确认 Wi-Fi 设置，请重试。',
  );
  if (ack.ack !== AckCode.OK) {
    throw new BadgeSyncError(describeAck(ack.ack), ack.ack);
  }
}

/** 清空工卡上的全部令牌。 */
export async function wipeBadge(link: BadgeLink, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<void> {
  const ack = await request(
    link,
    encodeWipe(),
    ackMatcher(HostFrame.WIPE),
    timeoutMs,
    '工卡没有确认清空，请重试。',
  );
  if (ack.ack !== AckCode.OK) {
    throw new BadgeSyncError(describeAck(ack.ack), ack.ack);
  }
}
