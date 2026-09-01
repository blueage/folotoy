import { createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { ServiceEntry } from "../lib/twofas/types";
import TokenList from "./TokenList";

const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

function entry(
  overrides: Partial<ServiceEntry> & { id: string },
): ServiceEntry {
  return {
    name: overrides.id,
    issuer: null,
    account: null,
    secret: RFC_SECRET,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    tokenType: "TOTP",
    unsupportedReason: null,
    ...overrides,
  };
}

const ENTRIES: ServiceEntry[] = [
  entry({ id: "github", name: "GitHub", issuer: "GitHub", account: "octocat" }),
  entry({
    id: "gitlab",
    name: "GitLab",
    issuer: "GitLab",
    account: "alice@example.test",
  }),
];

describe("TokenList", () => {
  it("filters entries by issuer and by account", async () => {
    render(
      <TokenList
        entries={ENTRIES}
        nowMs={59_000}
        onImportClick={vi.fn()}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    await waitFor(() => {
      expect(screen.getAllByTestId("token-card")).toHaveLength(2);
    });

    const search = screen.getByLabelText("搜索");

    // 按发行方过滤。
    fireEvent.change(search, { target: { value: "gitlab" } });
    expect(screen.getAllByTestId("token-card")).toHaveLength(1);
    expect(screen.getByText("GitLab")).toBeInTheDocument();
    expect(screen.queryByText("GitHub")).toBeNull();

    // 按账号过滤（大小写不敏感）。
    fireEvent.change(search, { target: { value: "OCTO" } });
    expect(screen.getAllByTestId("token-card")).toHaveLength(1);
    expect(screen.getByText("GitHub")).toBeInTheDocument();
    expect(screen.queryByText("GitLab")).toBeNull();

    // 无匹配时列表为空，但界面不变白（D8 的同一条原则）。
    fireEvent.change(search, { target: { value: "不存在的服务" } });
    expect(screen.queryAllByTestId("token-card")).toHaveLength(0);
    expect(screen.getByTestId("no-match")).toBeInTheDocument();

    // 清空搜索后全部回来。
    fireEvent.change(search, { target: { value: "" } });
    expect(screen.getAllByTestId("token-card")).toHaveLength(2);
  });

  it("renders the empty state when the vault has no entries", () => {
    const onImportClick = vi.fn();
    render(
      <TokenList
        entries={[]}
        nowMs={59_000}
        onImportClick={onImportClick}
        onDelete={vi.fn()}
        onReorder={vi.fn()}
      />,
    );

    expect(screen.getByTestId("empty-state")).toBeInTheDocument();
    expect(screen.queryByLabelText("搜索")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "导入备份文件" }));
    expect(onImportClick).toHaveBeenCalledTimes(1);
  });
});

describe("TokenList 拖拽排序", () => {
  const THREE: ServiceEntry[] = [
    entry({ id: "a", name: "Alpha", issuer: "Alpha" }),
    entry({ id: "b", name: "Bravo", issuer: "Bravo" }),
    entry({ id: "c", name: "Charlie", issuer: "Charlie" }),
  ];

  /** jsdom 不实现 DataTransfer，拖拽事件要自带一个替身。 */
  function dataTransfer() {
    return {
      setData: vi.fn(),
      getData: vi.fn(),
      setDragImage: vi.fn(),
      effectAllowed: "",
      dropEffect: "",
    };
  }

  function renderList(onReorder = vi.fn(), entries = THREE) {
    render(
      <TokenList
        entries={entries}
        nowMs={59_000}
        onImportClick={vi.fn()}
        onDelete={vi.fn()}
        onReorder={onReorder}
      />,
    );
    return onReorder;
  }

  function rowIds(): string[] {
    return screen
      .getAllByTestId("drag-handle")
      .map((handle) => handle.getAttribute("aria-label") ?? "");
  }

  it("把末位拖到首位后提交新的完整顺序", async () => {
    const onReorder = renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");
    const rows = screen.getAllByTestId("token-row");
    const dt = dataTransfer();

    // 拖 Charlie（第 3 行）到 Alpha（第 1 行）的位置。
    fireEvent.dragStart(handles[2]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[0]!, { dataTransfer: dt });
    fireEvent.drop(rows[0]!, { dataTransfer: dt });

    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith(["c", "a", "b"]);
  });

  // 回归用例：曾经在拖拽过程中实时重排 DOM，导致浏览器中止拖拽（排序失效）
  // 并且光标下的元素反复变化（画面抖动）。行的次序必须在拖拽全程保持不变。
  it("拖拽过程中行的次序保持不变，只显示落点指示线", async () => {
    const onReorder = renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");
    const rows = screen.getAllByTestId("token-row");
    const dt = dataTransfer();
    const before = rowIds();

    fireEvent.dragStart(handles[2]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[0]!, { dataTransfer: dt });
    // 多次 dragOver（真实浏览器里每几十毫秒一次）也不该动摇次序。
    fireEvent.dragOver(rows[0]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[0]!, { dataTransfer: dt });

    expect(rowIds()).toEqual(before);
    expect(onReorder).not.toHaveBeenCalled();

    // 落点以指示线呈现：向上拖，线画在目标行上方。
    const indicator = screen.getByTestId("drop-indicator");
    expect(indicator.dataset.edge).toBe("top");
    expect(indicator.closest('[data-testid="token-row"]')).toBe(rows[0]);
  });

  it("向下拖时指示线画在目标行下方", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");
    const rows = screen.getAllByTestId("token-row");
    const dt = dataTransfer();

    fireEvent.dragStart(handles[0]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[2]!, { dataTransfer: dt });

    expect(screen.getByTestId("drop-indicator").dataset.edge).toBe("bottom");
  });

  it("拖回原位不产生提交，也不显示指示线", async () => {
    const onReorder = renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");
    const rows = screen.getAllByTestId("token-row");
    const dt = dataTransfer();

    fireEvent.dragStart(handles[1]!, { dataTransfer: dt });
    fireEvent.dragOver(rows[1]!, { dataTransfer: dt });

    expect(screen.queryByTestId("drop-indicator")).toBeNull();

    fireEvent.drop(rows[1]!, { dataTransfer: dt });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it("方向键上下移动条目（键盘可达）", async () => {
    const onReorder = renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");

    fireEvent.keyDown(handles[0]!, { key: "ArrowDown" });
    expect(onReorder).toHaveBeenLastCalledWith(["b", "a", "c"]);

    fireEvent.keyDown(handles[2]!, { key: "ArrowUp" });
    expect(onReorder).toHaveBeenLastCalledWith(["a", "c", "b"]);
  });

  it("首位上移与末位下移都是空操作", async () => {
    const onReorder = renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const handles = screen.getAllByTestId("drag-handle");
    fireEvent.keyDown(handles[0]!, { key: "ArrowUp" });
    fireEvent.keyDown(handles[2]!, { key: "ArrowDown" });

    expect(onReorder).not.toHaveBeenCalled();
  });

  it("拖影停在提起它的位置，不跳到光标右下角", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    // jsdom 没有布局，getBoundingClientRect 默认全 0；给行一个真实的位置。
    const rect = { left: 20, top: 100, right: 620, bottom: 164, width: 600, height: 64 };
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue(rect as DOMRect);

    // jsdom 不实现 DragEvent 构造器，testing-library 会退回普通 Event，
    // clientX/clientY 从 init 里传不进去（会拿到 NaN）。手工挂上去。
    const dt = dataTransfer();
    const handle = screen.getAllByTestId("drag-handle")[0]!;
    const event = createEvent.dragStart(handle, { dataTransfer: dt });
    Object.defineProperty(event, "clientX", { value: 60 });
    Object.defineProperty(event, "clientY", { value: 130 });
    fireEvent(handle, event);

    // 光标在行内的相对位置是 (60-20, 130-100) = (40, 30)。
    // 传 (0,0) 会把行的左上角对齐到光标，整行就跳到光标右下方了。
    expect(dt.setDragImage).toHaveBeenCalledTimes(1);
    const call = dt.setDragImage.mock.calls[0]!;
    expect(call[1]).toBe(40);
    expect(call[2]).toBe(30);

    vi.restoreAllMocks();
  });

  it("拖影用的是整行，不是那一小块图标", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const dt = dataTransfer();
    fireEvent.dragStart(screen.getAllByTestId("drag-handle")[0]!, { dataTransfer: dt });

    const image = dt.setDragImage.mock.calls[0]![0] as HTMLElement;
    expect(image.getAttribute("data-testid")).toBe("token-row");
  });

  it("拖拽把手就是品牌图标本身，不再有独立手柄", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("drag-handle")).toHaveLength(3);
    });

    const handle = screen.getAllByTestId("drag-handle")[0]!;
    // 手柄内部装的就是那枚图标。
    expect(handle.querySelector('[data-testid="service-icon"]')).not.toBeNull();
    expect(handle).toHaveAttribute("draggable", "true");
  });

  it("图标不参与行高计算，超出部分由行裁掉", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("token-row")).toHaveLength(3);
    });

    const row = screen.getAllByTestId("token-row")[0]!;
    const handle = screen.getAllByTestId("drag-handle")[0]!;

    // 绝对定位 → 不撑开行高；行 overflow-hidden → 超出的部分被裁掉。
    expect(handle.className).toContain("absolute");
    expect(row.className).toContain("overflow-hidden");
    // 行留出左内边距给绝对定位的图标，否则文字会压在图标上。
    expect(row.className).toContain("pl-28");
  });

  it("图标远大于行高并带 10 度倾斜，四角都会被裁掉", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("drag-handle")).toHaveLength(3);
    });

    const handle = screen.getAllByTestId("drag-handle")[0]!;

    // 相对行高取值，行高变了也自动跟随；宽度靠 aspect-square 跟随高度，
    // 用百分比宽度会按行宽计算，那是错的。
    expect(handle.className).toContain("h-[160%]");
    expect(handle.className).toContain("aspect-square");
    expect(handle.className).toContain("rotate-[10deg]");
    // 往左外推，避免旋转后左上/左下露出三角形空隙。
    expect(handle.className).toContain("-left-3");
  });

  it("搜索状态下图标退化为纯展示，不可拖拽", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("drag-handle")).toHaveLength(3);
    });

    fireEvent.change(screen.getByLabelText("搜索"), {
      target: { value: "alpha" },
    });

    await waitFor(() => {
      expect(screen.queryAllByTestId("drag-handle")).toHaveLength(0);
    });
    // 图标本身还在，只是不再是可拖拽的按钮。
    expect(screen.getAllByTestId("service-icon").length).toBeGreaterThan(0);
  });

  it("搜索状态下禁用排序并给出说明", async () => {
    renderList();
    await waitFor(() => {
      expect(screen.getAllByTestId("drag-handle")).toHaveLength(3);
    });

    fireEvent.change(screen.getByLabelText("搜索"), {
      target: { value: "alpha" },
    });

    await waitFor(() => {
      expect(screen.getByTestId("reorder-disabled-hint")).toBeInTheDocument();
    });
    // 手柄整体消失，用户不会拖到一个只覆盖子集的顺序上去。
    expect(screen.queryAllByTestId("drag-handle")).toHaveLength(0);
  });
});
