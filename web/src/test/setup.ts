import '@testing-library/jest-dom/vitest';
// T03 的存储层测试依赖 IndexedDB：在 jsdom 中注册内存实现。
import 'fake-indexeddb/auto';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

afterEach(() => {
  cleanup();
});
