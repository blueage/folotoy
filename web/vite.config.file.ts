// 单文件构建：产出一个可以直接双击打开（file://）的 folopass-2fa.html。
//
// 为什么需要单独一份配置，而不是给 vite.config.ts 加开关——file:// 下有三条硬约束，
// 每一条都和默认的部署形态相反：
//
//  1. 外部 module script 取不到。file:// 页面的源是不透明的（origin 为 null），
//     <script type="module" src="./x.js"> 会被 CORS 挡掉。所以 JS/CSS 必须全部内联。
//     内联的 module script 不发请求，可以正常执行。
//  2. Service Worker 无法在 file:// 注册，PWA 那一套在这里没有意义，整体去掉。
//  3. 内联脚本与默认的 script-src 'self' 冲突。这里不退让成 'unsafe-inline'，
//     而是构建后算出内联块的 sha256 写进 CSP —— 严格程度和线上版本一致（D11）。
//
// 用法：npm run build:file → dist-file/folopass-2fa.html

import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

const OUT_DIR = 'dist-file';
const OUT_NAME = 'folopass-2fa.html';

/** CSP 的 sha256-... 源表达式要求 base64 编码的摘要。 */
function cspHash(content: string): string {
  return `'sha256-${createHash('sha256').update(content, 'utf8').digest('base64')}'`;
}

/** 收集所有内联 <script> / <style> 的内容，用于计算 CSP 哈希。 */
function collectInline(html: string, tag: 'script' | 'style'): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const found: string[] = [];
  for (const match of html.matchAll(re)) {
    // 只有真正内联的才算：带 src 的 <script> 内容为空，不参与。
    const body = match[1] ?? '';
    if (body.length > 0) {
      found.push(body);
    }
  }
  return found;
}

/**
 * 构建后处理：把 index.html 收拾成一个真正自足的 file:// 页面。
 * 用 writeBundle 直接读写磁盘上的产物，避免和 singlefile 的内联时机抢顺序。
 */
function finalizeFileBuild(): Plugin {
  return {
    name: 'folopass2fa:finalize-file-build',
    apply: 'build',
    enforce: 'post',
    writeBundle(options) {
      const dir = options.dir ?? OUT_DIR;
      const indexPath = join(dir, 'index.html');
      if (!existsSync(indexPath)) {
        throw new Error(`单文件构建没有产出 ${indexPath}`);
      }
      let html = readFileSync(indexPath, 'utf8');

      // 1. 图标内联成 data URI；manifest 与 apple-touch-icon 在 file:// 下没有意义，去掉。
      const iconSvg = readFileSync(join('public', 'icon.svg'), 'utf8');
      const iconDataUri = `data:image/svg+xml;base64,${Buffer.from(iconSvg, 'utf8').toString('base64')}`;
      html = html
        .replace(/\s*<link\s+rel="manifest"[^>]*>/gi, '')
        .replace(/\s*<link\s+rel="apple-touch-icon"[^>]*>/gi, '')
        .replace(/(<link\s+rel="icon"[^>]*href=")[^"]*(")/i, `$1${iconDataUri}$2`);

      // 2. 按内联块的真实内容重算 CSP。
      //    script-src / style-src 只列哈希，不放 'unsafe-inline'，
      //    这样即使页面被塞进别的脚本也执行不了。
      const scriptHashes = collectInline(html, 'script').map(cspHash);
      const styleHashes = collectInline(html, 'style').map(cspHash);
      if (scriptHashes.length === 0) {
        throw new Error('没有找到内联脚本——singlefile 可能没有生效，产物在 file:// 下打不开');
      }
      const csp = [
        "default-src 'none'",
        `script-src ${scriptHashes.join(' ')}`,
        `style-src ${styleHashes.join(' ')}`,
        "img-src data:",
        "font-src data:",
        "connect-src 'none'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "frame-ancestors 'none'",
      ].join('; ');
      html = html.replace(
        /(<meta\s+http-equiv="Content-Security-Policy"\s+content=")[^"]*(")/i,
        `$1${csp}$2`,
      );

      // 3. 落成最终文件名，并清掉中间产物，避免 dist-file 里留下会误导人的 index.html。
      writeFileSync(join(dir, OUT_NAME), html, 'utf8');
      rmSync(indexPath);

      const kb = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
      this.info(`单文件产物：${join(dir, OUT_NAME)}（${kb} KB，内联脚本 ${scriptHashes.length} 段）`);
    },
  };
}

export default defineConfig({
  // file:// 下没有站点根，所有引用必须是相对的。
  base: './',
  // 不拷贝 public/：图标已内联成 data URI，manifest 在 file:// 下没有意义。
  // 留着反而会让人以为这些文件是产物的一部分。
  publicDir: false,
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), finalizeFileBuild()],
  build: {
    outDir: OUT_DIR,
    emptyOutDir: true,
    // 单文件形态下代码分割没有意义，全部打进一个 chunk。
    cssCodeSplit: false,
    assetsInlineLimit: Number.MAX_SAFE_INTEGER,
    modulePreload: { polyfill: false },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
});
