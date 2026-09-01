import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/**
 * 生产构建的 CSP 是严格的 `script-src 'self'; style-src 'self'`，
 * 但 Vite 开发服务器必须注入内联的 react-refresh 前导脚本并以内联 <style>
 * 注入样式。因此仅在 dev 下移除 index.html 里的 CSP meta，构建产物不受影响。
 */
function stripCspInDev(): Plugin {
  return {
    name: 'folopass2fa:strip-csp-in-dev',
    apply: 'serve',
    transformIndexHtml(html) {
      return html.replace(/\s*<meta\s+http-equiv="Content-Security-Policy"[\s\S]*?\/>/i, '');
    },
  };
}

// 所有资源均为同源打包产物（D11）：不引入任何第三方 CDN / 远程字体 / 远程图标。
export default defineConfig({
  plugins: [
    stripCspInDev(),
    react(),
    VitePWA({
      // 清单是 public/ 下的真实文件，交由 PWA 插件直接引用，而非由插件生成。
      injectRegister: 'script',
      manifest: false,
      strategies: 'generateSW',
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,webmanifest}'],
        navigateFallback: 'index.html',
      },
    }),
  ],
  build: {
    // 关闭 modulepreload polyfill：它会向 index.html 注入内联脚本，
    // 与 script-src 'self'（无 unsafe-inline）的 CSP 冲突。
    modulePreload: { polyfill: false },
  },
});
