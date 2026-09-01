import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTypeToSearch } from './useTypeToSearch';

function setup(options: { enabled?: boolean } = {}) {
  const input = document.createElement('input');
  document.body.append(input);
  const onEscape = vi.fn();
  const focus = vi.spyOn(input, 'focus');
  const blur = vi.spyOn(input, 'blur');

  const view = renderHook(() =>
    useTypeToSearch({
      inputRef: { current: input },
      onEscape,
      ...(options.enabled === undefined ? {} : { enabled: options.enabled }),
    }),
  );

  return { input, onEscape, focus, blur, view };
}

/** 直接派发到 window，模拟"焦点不在任何输入框上"的整页按键。 */
function press(key: string, init: Partial<KeyboardEventInit> = {}, target?: EventTarget) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, ...init });
  (target ?? window).dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('useTypeToSearch', () => {
  it('按下可打印字符时把焦点送进搜索框', () => {
    const { focus } = setup();
    press('a');
    expect(focus).toHaveBeenCalledTimes(1);
  });

  it('不吞掉事件，字符由浏览器落进刚聚焦的输入框', () => {
    setup();
    const event = press('a');
    // 自己拼字符串会在输入法组词、按住重复时出错，所以只移焦点不 preventDefault。
    expect(event.defaultPrevented).toBe(false);
  });

  it('组合键放行，不劫持 Cmd+F / Ctrl+C', () => {
    const { focus } = setup();
    press('f', { metaKey: true });
    press('c', { ctrlKey: true });
    press('a', { altKey: true });
    expect(focus).not.toHaveBeenCalled();
  });

  it('功能键与方向键放行', () => {
    const { focus } = setup();
    // 方向键要留给拖拽排序的键盘操作。
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'F1', 'Enter', 'Shift']) {
      press(key);
    }
    expect(focus).not.toHaveBeenCalled();
  });

  it('焦点已在别的输入框里时不抢', () => {
    const { focus } = setup();
    const other = document.createElement('textarea');
    document.body.append(other);

    press('a', {}, other);
    expect(focus).not.toHaveBeenCalled();
  });

  it('焦点在 contenteditable 里时不抢', () => {
    const { focus } = setup();
    const editable = document.createElement('div');
    editable.contentEditable = 'true';
    // jsdom 不根据 contentEditable 属性推导 isContentEditable，显式打桩。
    Object.defineProperty(editable, 'isContentEditable', { value: true });
    document.body.append(editable);

    press('a', {}, editable);
    expect(focus).not.toHaveBeenCalled();
  });

  it('搜索框聚焦时按 Escape 清空并退出', () => {
    const { input, onEscape, blur } = setup();
    input.focus();

    press('Escape');

    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(blur).toHaveBeenCalledTimes(1);
  });

  it('焦点不在搜索框时 Escape 不做事', () => {
    const { onEscape } = setup();
    press('Escape');
    expect(onEscape).not.toHaveBeenCalled();
  });

  it('enabled 为 false 时整体停用', () => {
    const { focus } = setup({ enabled: false });
    press('a');
    expect(focus).not.toHaveBeenCalled();
  });

  it('卸载后不再监听', () => {
    const { focus, view } = setup();
    view.unmount();
    press('a');
    expect(focus).not.toHaveBeenCalled();
  });
});
