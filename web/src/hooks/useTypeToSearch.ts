// 全页捕获按键：直接打字就跳进搜索框，不用先去点它。
//
// 关键在于**不要** preventDefault：在 keydown 阶段把焦点移到输入框后，浏览器会把
// 这次按键的默认行为（插入这个字符）作用在新的焦点元素上。自己去拼字符串反而会
// 在输入法组词、按住重复等情况下出错。

import { useEffect, type RefObject } from 'react';

/** 焦点已经在可编辑元素里时不抢——用户正在别处打字。 */
function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

export interface TypeToSearchOptions {
  /** 搜索框。为 null 时（比如空状态没有搜索框）整个行为自动停用。 */
  inputRef: RefObject<HTMLInputElement | null>;
  /** 按下 Escape 时清空搜索词。 */
  onEscape(): void;
  /** 传 false 可临时停用，例如有对话框打开时。 */
  enabled?: boolean;
}

export function useTypeToSearch({ inputRef, onEscape, enabled = true }: TypeToSearchOptions): void {
  useEffect(() => {
    if (!enabled) {
      return;
    }

    const handle = (event: KeyboardEvent): void => {
      const input = inputRef.current;
      if (input === null) {
        return;
      }

      // Escape 在搜索框里时清空并退出，其余情况不管。
      if (event.key === 'Escape') {
        if (document.activeElement === input) {
          onEscape();
          input.blur();
        }
        return;
      }

      // 组合键留给浏览器与系统：Cmd+F、Ctrl+C 之类不能被吞掉。
      if (event.ctrlKey || event.metaKey || event.altKey) {
        return;
      }
      // 只对单个可打印字符生效；F1、Tab、方向键等一律放行
      // （方向键还要留给拖拽排序的键盘操作）。
      if (event.key.length !== 1) {
        return;
      }
      if (isEditable(event.target)) {
        return;
      }

      // 只移焦点，不吞事件：这个字符会由浏览器落进刚获得焦点的输入框。
      input.focus();
    };

    window.addEventListener('keydown', handle);
    return () => {
      window.removeEventListener('keydown', handle);
    };
  }, [inputRef, onEscape, enabled]);
}
