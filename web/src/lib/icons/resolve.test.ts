import { describe, expect, it } from 'vitest';

import { BRAND_ICONS } from './brands.generated';
import { findBrandIcon, letterAvatar, normalizeIssuerKey, readableOn } from './resolve';

describe('normalizeIssuerKey', () => {
  it('转小写并去掉分隔符', () => {
    expect(normalizeIssuerKey('Google')).toBe('google');
    expect(normalizeIssuerKey('Proton Mail')).toBe('protonmail');
    expect(normalizeIssuerKey('github.com')).toBe('githubcom');
    expect(normalizeIssuerKey('  Digital-Ocean  ')).toBe('digitalocean');
  });

  it('保留中日韩字符而不是清成空串', () => {
    expect(normalizeIssuerKey('微信')).toBe('微信');
    expect(normalizeIssuerKey('支付宝 Alipay')).toBe('支付宝alipay');
  });
});

describe('findBrandIcon', () => {
  it('精确命中', () => {
    expect(findBrandIcon('GitHub')?.title).toBe('GitHub');
    expect(findBrandIcon('steam')?.title).toBe('Steam');
  });

  it('走别名表', () => {
    expect(findBrandIcon('Gmail')?.title).toBe('Google');
    expect(findBrandIcon('Twitter')?.title).toBe('X');
    expect(findBrandIcon('1Password')?.title).toBe('1Password');
  });

  it('剥掉域名后缀后命中', () => {
    expect(findBrandIcon('github.com')?.title).toBe('GitHub');
    expect(findBrandIcon('bitwarden.com')?.title).toBe('Bitwarden');
  });

  it('中文名走别名表', () => {
    expect(findBrandIcon('微信')?.title).toBe('WeChat');
    expect(findBrandIcon('支付宝')?.title).toBe('Alipay');
    expect(findBrandIcon('知乎')?.title).toBe('Zhihu');
  });

  it('子串匹配取最长的那个', () => {
    // googlecloud 比 google 长，应该赢
    expect(findBrandIcon('Google Cloud Platform')?.title).toBe('GoogleCloud');
  });

  it('带子域名的主机名按分段命中', () => {
    // 归一化会把 sso.dnb.com 压成 ssodnbcom，而 dnb 只有 3 字符、低于子串匹配的
    // 长度门槛，只有按点切开才能命中。
    expect(findBrandIcon('sso.dnb.com')?.title).toBe('Dun & Bradstreet');
    expect(findBrandIcon('auth.dnb.com')?.title).toBe('Dun & Bradstreet');
    expect(findBrandIcon('login.github.com')?.title).toBe('GitHub');
    expect(findBrandIcon('accounts.google.com')?.title).toBe('Google');
  });

  it('分段匹配不会抢在更精确的子串匹配之前', () => {
    // 若分段先跑，Google Cloud Platform 会被 google 这一段抢走。
    expect(findBrandIcon('Google Cloud Platform')?.title).toBe('GoogleCloud');
  });

  it('分段匹配不会被无意义的段落误伤', () => {
    expect(findBrandIcon('sso.example.internal')).toBeNull();
    expect(findBrandIcon('login.acme.com')).toBeNull();
  });

  it('自定义图标（assets/brand-icons）参与匹配', () => {
    expect(findBrandIcon('m-team')?.title).toBe('M-Team');
    expect(findBrandIcon('M-Team.cc')?.title).toBe('M-Team');
  });

  it('不认识的发行方返回 null', () => {
    expect(findBrandIcon('某个内部系统')).toBeNull();
    expect(findBrandIcon('Acme Corp Internal SSO')).toBeNull();
  });

  it('空值安全', () => {
    expect(findBrandIcon(null)).toBeNull();
    expect(findBrandIcon(undefined)).toBeNull();
    expect(findBrandIcon('')).toBeNull();
    expect(findBrandIcon('   ')).toBeNull();
    expect(findBrandIcon('!!!')).toBeNull();
  });

  it('短名字不参与子串匹配，避免误伤', () => {
    // 'x' 只有一个字符，不能让任何含 x 的名字都变成 X 的图标
    expect(findBrandIcon('Nextcloud')?.title).not.toBe('X');
    expect(findBrandIcon('Linux Foundation')?.title).toBe('Linux');
  });
});

describe('letterAvatar', () => {
  it('取首字符并转大写', () => {
    expect(letterAvatar('Acme').letter).toBe('A');
    expect(letterAvatar('zoom').letter).toBe('Z');
  });

  it('同一个名字永远同一个颜色', () => {
    expect(letterAvatar('Acme').color).toBe(letterAvatar('Acme').color);
    // 归一化后相同的名字也应同色
    expect(letterAvatar('Acme Corp').color).toBe(letterAvatar('acme-corp').color);
  });

  it('不同名字倾向于不同颜色', () => {
    const colors = new Set(
      ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta'].map((n) => letterAvatar(n).color),
    );
    expect(colors.size).toBeGreaterThan(1);
  });

  it('中文名取第一个汉字', () => {
    expect(letterAvatar('某内部系统').letter).toBe('某');
  });

  it('不把 emoji 或代理对切成半个字符', () => {
    const { letter } = letterAvatar('🚀 Rocket');
    expect(letter).toBe('🚀');
    expect(Array.from(letter)).toHaveLength(1);
  });

  it('空名字退回问号', () => {
    expect(letterAvatar(null).letter).toBe('?');
    expect(letterAvatar('').letter).toBe('?');
    expect(letterAvatar('   ').letter).toBe('?');
  });
});

describe('readableOn', () => {
  it('深色底给白色前景', () => {
    expect(readableOn('#000000')).toBe('#ffffff');
    expect(readableOn('#181717')).toBe('#ffffff'); // GitHub
    expect(readableOn('#4285F4')).toBe('#ffffff'); // Google 蓝
  });

  it('浅色底给深色前景', () => {
    expect(readableOn('#FFFFFF')).toBe('#0f172a');
    expect(readableOn('#FFFC00')).toBe('#0f172a'); // Snapchat 亮黄
    expect(readableOn('#1ED760')).toBe('#0f172a'); // Spotify 绿
  });

  it('按感知亮度判断，而不是 RGB 均值', () => {
    // 纯蓝和纯黄的 RGB 均值接近，但感知亮度天差地别；
    // 均值法会把纯黄判成深色并配上白字，实际根本看不清。
    expect(readableOn('#0000FF')).toBe('#ffffff');
    expect(readableOn('#FFFF00')).toBe('#0f172a');
  });

  it('内置图标的前景色都落在两个取值之内', () => {
    for (const icon of Object.values(BRAND_ICONS)) {
      expect(['#ffffff', '#0f172a']).toContain(readableOn(icon.hex));
    }
  });
});

describe('brands.generated', () => {
  it('每个图标都有可用的标记、viewBox 和颜色', () => {
    const icons = Object.values(BRAND_ICONS);
    expect(icons.length).toBeGreaterThan(50);
    for (const icon of icons) {
      expect(icon.markup.length).toBeGreaterThan(0);
      expect(icon.viewBox).toMatch(/^[\d.\s-]+$/);
      expect(icon.hex).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(icon.title.length).toBeGreaterThan(0);
    }
  });

  // 这些是生成脚本的消毒契约。破了任何一条都是**静默**出错：
  // 图标要么渲染不对，要么把不该有的东西带进这个存放 2FA 种子的页面。
  it('消毒后的标记里没有脚本、事件处理器或外部引用', () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.markup, slug).not.toMatch(/<script/i);
      expect(icon.markup, slug).not.toMatch(/\son[a-z]+\s*=/i);
      expect(icon.markup, slug).not.toMatch(/<foreignObject/i);
      expect(icon.markup, slug).not.toMatch(/<image/i);
      // 只允许指向自身 id 的 href，不许有 http(s)/data 之类的外部引用。
      expect(icon.markup, slug).not.toMatch(/href="(?!#)/i);
    }
  });

  it('消毒后没有 style 属性或 <style> 标签（CSP 会拦掉它们）', () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.markup, slug).not.toMatch(/<style/i);
      expect(icon.markup, slug).not.toMatch(/\sstyle\s*=/i);
    }
  });

  it('所有 id 都加了 slug 前缀，跨图标不会串色', () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      for (const match of icon.markup.matchAll(/\sid="([^"]+)"/g)) {
        expect(match[1], `${slug} 的 id 未加前缀`).toMatch(new RegExp(`^${slug}-`));
      }
      // 引用也要一起改写，否则指向的是别的图标的渐变。
      for (const match of icon.markup.matchAll(/url\(#([^)]+)\)/g)) {
        expect(match[1], `${slug} 的 url(#) 引用未加前缀`).toMatch(new RegExp(`^${slug}-`));
      }
    }
  });

  it('每个图标都有实际的着色，不会退化成黑色剪影', () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      const painted =
        /fill="(?!none)/.test(icon.markup) || /gradient/i.test(icon.markup);
      expect(painted, `${slug} 没有任何填充`).toBe(true);
    }
  });

  it('无障碍名称由组件统一给，标记内不带 title/desc', () => {
    for (const [slug, icon] of Object.entries(BRAND_ICONS)) {
      expect(icon.markup, slug).not.toMatch(/<title|<desc/i);
    }
  });
});
