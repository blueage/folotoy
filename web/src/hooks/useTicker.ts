// 全应用共用的 1 Hz 时钟源（D15）：所有卡片订阅同一个定时器，而不是每张卡片各起一个。
// 每次都把下一跳对齐到整秒（1000 - now % 1000），周期翻转才能稳定落在一秒之内（设计 §3.3）。

import { useSyncExternalStore } from 'react';

type TickListener = () => void;

const listeners = new Set<TickListener>();

/** 当前快照。只在 tick / 首个订阅者到来时更新，保证同一次渲染内取值稳定。 */
let nowMs = Date.now();
/** 唯一的定时器句柄；没有订阅者时为 null，不占用任何定时器。 */
let timer: ReturnType<typeof setTimeout> | null = null;

function schedule(): void {
  timer = setTimeout(tick, 1000 - (Date.now() % 1000));
}

function tick(): void {
  nowMs = Date.now();
  // 先复制再遍历：某个监听者在回调里退订不应影响本轮通知。
  for (const listener of [...listeners]) {
    listener();
  }
  schedule();
}

function subscribe(listener: TickListener): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    // 空转一段时间后重新挂载：快照可能已经过期，先补齐再起定时器。
    nowMs = Date.now();
    schedule();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot(): number {
  return nowMs;
}

/**
 * 订阅共享时钟，返回当前时刻（毫秒）。
 *
 * 取值每整秒变化一次；调用方自行叠加时钟偏移（D16）后再算验证码。
 */
export function useTicker(): number {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
