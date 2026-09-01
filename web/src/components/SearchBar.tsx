// 客户端搜索框（D15）：只做受控输入，过滤逻辑留在 TokenList 里。

import type { Ref } from 'react';

export interface SearchBarProps {
  value: string;
  onChange(next: string): void;
  /** 供“直接打字即搜索”把焦点送进来（见 TokenList 的 useTypeToSearch）。 */
  inputRef?: Ref<HTMLInputElement>;
}

export default function SearchBar({ value, onChange, inputRef }: SearchBarProps) {
  return (
    <label className="block">
      <span className="sr-only">搜索</span>
      <input
        ref={inputRef}
        type="search"
        value={value}
        aria-label="搜索"
        placeholder="搜索服务或账号（直接打字即可）"
        onChange={(event) => {
          onChange(event.target.value);
        }}
        className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-sky-500 focus:outline-none dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100"
      />
    </label>
  );
}
