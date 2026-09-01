import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useTicker } from '../hooks/useTicker';
import { generateTotp } from '../lib/totp';
import type { ServiceEntry } from '../lib/twofas/types';
import TokenCard, { UNSUPPORTED_BADGE } from './TokenCard';

/** RFC 6238 的官方测试密钥 "12345678901234567890" 的 Base32 形式；不是任何真实账号（D17）。 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const TOTP_ENTRY: ServiceEntry = {
  id: 'rfc-sha1',
  name: 'RFC 6238',
  issuer: 'RFC',
  account: 'sha1@example.test',
  secret: RFC_SECRET,
  algorithm: 'SHA1',
  digits: 8,
  period: 30,
  tokenType: 'TOTP',
  unsupportedReason: null,
};

const HOTP_ENTRY: ServiceEntry = {
  id: 'hotp',
  name: '计数器令牌',
  issuer: 'Legacy',
  account: 'counter@example.test',
  secret: RFC_SECRET,
  algorithm: 'SHA1',
  digits: 6,
  period: 30,
  tokenType: 'HOTP',
  unsupportedReason: '不支持的令牌类型：HOTP',
};

/** 删除回调在多数用例里无关紧要；需要断言时各自传入自己的 spy。 */
const noopDelete = (): void => {};

function renderCard(entry: ServiceEntry, nowMs: number) {
  return render(
    <ul>
      <TokenCard entry={entry} nowMs={nowMs} onDelete={noopDelete} />
    </ul>,
  );
}

/** 只用共享时钟驱动 nowMs，顺带覆盖 useTicker 的整秒对齐（D15）。 */
function TickingCard({ entry }: { entry: ServiceEntry }) {
  const nowMs = useTicker();
  return (
    <ul>
      <TokenCard entry={entry} nowMs={nowMs} onDelete={noopDelete} />
    </ul>
  );
}

/**
 * 推进队列直到条件成立。
 *
 * 固定轮数的 settle() 不可靠：crypto.subtle 是真正的异步，整套测试并行跑、机器
 * 负载高的时候，几轮 setImmediate 未必轮得到它，断言就会读到上一周期的旧验证码
 * （表现为偶发失败，单独跑这个文件又永远复现不了）。
 */
async function settleUntil(predicate: () => boolean, maxRounds = 60): Promise<void> {
  for (let index = 0; index < maxRounds; index += 1) {
    if (predicate()) {
      return;
    }
    await settle(1);
  }
}

/** 当前显示的验证码（两个半段拼起来）；还没算出来时为空串。 */
function shownCode(): string {
  return screen.queryByTestId('token-code')?.textContent ?? '';
}

/** 假定时器下推进真实的微任务/IO 队列：crypto.subtle 的 Promise 不受假定时器影响。 */
async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => {
        setImmediate(resolve);
      });
    });
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('TokenCard', () => {
  it('renders the code for a supported entry', async () => {
    // RFC 6238 向量：SHA1 / 8 位 / T=59s → 94287082。
    renderCard(TOTP_ENTRY, 59_000);

    await waitFor(() => {
      expect(screen.getByTestId('token-code')).toHaveTextContent('94287082');
    });
    expect(await generateTotp(TOTP_ENTRY, 59_000)).toBe('94287082');
    expect(screen.getByTestId('token-countdown')).toHaveTextContent('剩余 1 秒');
  });

  it('renders an unsupported badge and no code for an HOTP entry', async () => {
    const { container } = renderCard(HOTP_ENTRY, 59_000);

    expect(screen.getByTestId('token-unsupported')).toHaveTextContent(UNSUPPORTED_BADGE);
    expect(screen.getByText('不支持的令牌类型：HOTP')).toBeInTheDocument();
    expect(screen.queryByTestId('token-code')).toBeNull();
    // 给异步计算留出机会，确认之后也不会冒出任何数字组。
    await settle(2);
    expect(screen.queryByTestId('token-code')).toBeNull();
    expect(container.textContent ?? '').not.toMatch(/\d{6}/);
  });

  it('advances the code at the period boundary', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(59_200);

    render(<TickingCard entry={TOTP_ENTRY} />);
    await settleUntil(() => shownCode() === '94287082');
    expect(screen.getByTestId('token-code')).toHaveTextContent('94287082');

    // 周期边界在 60_000ms；一秒之内验证码必须翻到下一个周期（D15）。
    act(() => {
      vi.advanceTimersByTime(1_000);
    });

    const next = await generateTotp(TOTP_ENTRY, 60_000);
    expect(next).not.toBe('94287082');
    await settleUntil(() => shownCode() === next);
    expect(screen.getByTestId('token-code')).toHaveTextContent(next);
  });

  it('copies the code on click', async () => {
    const writeText = vi.fn<(text: string) => Promise<void>>().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    renderCard(TOTP_ENTRY, 59_000);
    await waitFor(() => {
      expect(screen.getByTestId('token-code')).toHaveTextContent('94287082');
    });

    fireEvent.click(screen.getByTestId('token-card'));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('94287082');
    });
    await waitFor(() => {
      expect(screen.getByTestId('token-copied')).toHaveTextContent('已复制');
    });
  });

  describe('删除', () => {
    function renderWithDelete(onDelete: (id: string) => void, entry = TOTP_ENTRY) {
      return render(
        <ul>
          <TokenCard entry={entry} nowMs={59_000} onDelete={onDelete} />
        </ul>,
      );
    }

    it('删除需要二次确认，首次点击不触发回调', () => {
      const onDelete = vi.fn();
      renderWithDelete(onDelete);

      fireEvent.click(screen.getByTestId('delete-button'));

      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.getByTestId('delete-confirm')).toBeInTheDocument();
    });

    it('确认后带条目 id 调用回调', () => {
      const onDelete = vi.fn();
      renderWithDelete(onDelete);

      fireEvent.click(screen.getByTestId('delete-button'));
      fireEvent.click(screen.getByTestId('delete-confirm'));

      expect(onDelete).toHaveBeenCalledTimes(1);
      expect(onDelete).toHaveBeenCalledWith(TOTP_ENTRY.id);
    });

    it('取消后回到初始状态且不删除', () => {
      const onDelete = vi.fn();
      renderWithDelete(onDelete);

      fireEvent.click(screen.getByTestId('delete-button'));
      fireEvent.click(screen.getByTestId('delete-cancel'));

      expect(onDelete).not.toHaveBeenCalled();
      expect(screen.queryByTestId('delete-confirm')).toBeNull();
      expect(screen.getByTestId('delete-button')).toBeInTheDocument();
    });

    it('不受支持的条目同样可以删除', () => {
      const onDelete = vi.fn();
      renderWithDelete(onDelete, HOTP_ENTRY);

      fireEvent.click(screen.getByTestId('delete-button'));
      fireEvent.click(screen.getByTestId('delete-confirm'));

      expect(onDelete).toHaveBeenCalledWith(HOTP_ENTRY.id);
    });

    // jsdom 不套用 Tailwind 的样式表，只能断言类名；这些类名本身就是行为契约。
    it('行底色浮在行自身背景之上，而不是被它盖住', () => {
      renderWithDelete(vi.fn());
      const row = screen.getByTestId('token-row');
      const tint = screen.getByTestId('row-tint');

      // position: relative 在 z-index 为 auto 时不创建层叠上下文，-z-10 会跑到
      // 更外层去、排在本行 bg-white 之前，被那层不透明白底盖住（表现为底色没变）。
      // isolate 让本行成为层叠上下文，负层子元素才画在背景之上、内容之下。
      expect(row.className).toContain('isolate');
      expect(tint.getAttribute('class')).toContain('-z-10');
    });

    it('删除按钮绝对定位在右上角，完全不占布局位置', () => {
      renderWithDelete(vi.fn());
      const del = screen.getByTestId('delete-button');

      // 绝对定位 → 不参与 flex 排布，不会把右侧的验证码往左挤。
      expect(del.className).toContain('absolute');
      expect(del.className).toContain('right-1');
      expect(del.className).toContain('top-1');
    });

    it('只在悬停它自己时显现，划过行的其它地方不显现', () => {
      renderWithDelete(vi.fn());
      const del = screen.getByTestId('delete-button');
      const row = screen.getByTestId('token-row');

      expect(del.className).toContain('opacity-0');
      // 关键：是自身的 hover，不是整行的 group-hover。
      expect(del.className).toContain('hover:opacity-100');
      expect(del.className).not.toContain('group-hover:');
      // 行上也不该再有 group 锚点，否则等于整行悬停都会触发。
      expect(row.className).not.toMatch(/\bgroup\b/);
    });

    it('隐形时仍可接收指针事件，否则永远悬停不到它', () => {
      renderWithDelete(vi.fn());
      const del = screen.getByTestId('delete-button');

      // opacity-0 + pointer-events-none 的组合会让它永远显不出来。
      expect(del.className).not.toContain('pointer-events-none');
    });

    it('键盘聚焦与触屏都能够到', () => {
      renderWithDelete(vi.fn());
      const del = screen.getByTestId('delete-button');

      // 否则会出现“能 Tab 到但看不见”的状态。
      expect(del.className).toContain('focus-visible:opacity-100');
      // 触屏没有 hover，降级为常驻半透明。
      expect(del.className).toContain('[@media(hover:none)]:opacity-40');
    });

    it('进入确认状态后不再隐形（鼠标移开也不会消失）', () => {
      renderWithDelete(vi.fn());
      fireEvent.click(screen.getByTestId('delete-button'));

      const confirm = screen.getByTestId('delete-confirm');
      const cancel = screen.getByTestId('delete-cancel');
      expect(confirm.className).not.toContain('opacity-0');
      expect(cancel.className).not.toContain('opacity-0');
    });

    it('删除按钮不嵌套在复制按钮内部（按钮不能套按钮）', () => {
      renderWithDelete(vi.fn());

      const del = screen.getByTestId('delete-button');
      const copy = screen.getByTestId('token-card');
      expect(copy.contains(del)).toBe(false);
      expect(copy.tagName).toBe('BUTTON');
    });
  });

  // 剩余 5 秒起转红（period 30、remainingSec 为 Math.ceil 的结果）：
  //   nowMs % 30000 = 24000 → 剩 6 秒（正常）
  //   nowMs % 30000 = 25000 → 剩 5 秒（临界，应转红）
  //   nowMs % 30000 = 29000 → 剩 1 秒（应转红）
  describe('临期高亮', () => {
    /** 倒计时圆环里第二个 circle 才是进度弧，第一个是底色轨道。 */
    function progressRing(): Element {
      const circles = screen.getByTestId('token-countdown').querySelectorAll('circle');
      const ring = circles[1];
      if (ring === undefined) {
        throw new Error('没有找到进度弧');
      }
      return ring;
    }

    it('剩余 6 秒时保持常规配色', async () => {
      renderCard(TOTP_ENTRY, 24_000);
      await waitFor(() => {
        expect(screen.getByTestId('token-code')).toBeInTheDocument();
      });

      expect(screen.getByTestId('token-code').dataset.urgent).toBe('false');
      expect(screen.getByTestId('token-code').className).toContain('text-slate-900');
      expect(progressRing().getAttribute('class')).toContain('stroke-sky-500');
    });

    it('剩余 5 秒时验证码与圆环同时转红', async () => {
      renderCard(TOTP_ENTRY, 25_000);
      await waitFor(() => {
        expect(screen.getByTestId('token-code')).toBeInTheDocument();
      });

      const code = screen.getByTestId('token-code');
      expect(code.dataset.urgent).toBe('true');
      expect(code.className).toContain('text-red-600');
      expect(code.className).not.toContain('text-slate-900');
      expect(progressRing().getAttribute('class')).toContain('stroke-red-500');
    });

    it('剩余 1 秒时仍为红色', async () => {
      renderCard(TOTP_ENTRY, 29_000);
      await waitFor(() => {
        expect(screen.getByTestId('token-code')).toBeInTheDocument();
      });

      expect(screen.getByTestId('token-code').dataset.urgent).toBe('true');
      expect(progressRing().getAttribute('class')).toContain('stroke-red-500');
    });

    it('跨过周期边界后恢复常规配色', async () => {
      const { rerender } = renderCard(TOTP_ENTRY, 29_000);
      await waitFor(() => {
        expect(screen.getByTestId('token-code').dataset.urgent).toBe('true');
      });

      // 越过边界进入下一个周期，剩余 30 秒。
      rerender(
        <ul>
          <TokenCard entry={TOTP_ENTRY} nowMs={30_000} onDelete={noopDelete} />
        </ul>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('token-code').dataset.urgent).toBe('false');
      });
      expect(progressRing().getAttribute('class')).toContain('stroke-sky-500');
    });
  });
});
