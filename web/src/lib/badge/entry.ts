// 保险库里的条目 → 可以推送到工卡的条目。
// 工卡的限制比浏览器严得多（无 CJK 字体、密钥长度、条目数），因此这里的
// 每一次拒绝都要带上人能看懂的原因，界面直接把它显示在条目旁边。

import { Base32Error, base32Decode } from '../base32';
import { iconAccent } from '../icons/tile';
import { canGenerateTotp } from '../totp';
import type { ServiceEntry } from '../twofas/types';
import { hexToRgb565 } from './icon';
import {
  BADGE_ALGORITHM_CODE,
  BADGE_DIGITS_MAX,
  BADGE_DIGITS_MIN,
  BADGE_ISSUER_MAX,
  BADGE_LABEL_MAX,
  BADGE_PERIOD_MAX,
  BADGE_PERIOD_MIN,
  BADGE_SECRET_MAX_BYTES,
  BADGE_SECRET_MIN_BYTES,
  sanitizeBadgeText,
} from './limits';
import type { BadgeEntry } from './protocol';

export type BadgeConversion =
  | { ok: true; entry: BadgeEntry; labelWasRewritten: boolean }
  | { ok: false; reason: string };

/** 该条目在工卡上默认显示的名字：优先发行方，其次服务名。 */
export function defaultBadgeLabel(entry: ServiceEntry): string {
  const source = entry.issuer ?? entry.name;
  return sanitizeBadgeText(source, BADGE_LABEL_MAX).text;
}

/** 当前生效的工卡显示名（用户改过就用用户的）。 */
export function effectiveBadgeLabel(entry: ServiceEntry): string {
  const custom = entry.badgeLabel;
  if (custom !== undefined && custom !== null && custom.trim().length > 0) {
    return sanitizeBadgeText(custom, BADGE_LABEL_MAX).text;
  }
  return defaultBadgeLabel(entry);
}

/** 该条目在工卡上默认的副标题：账号原样清洗一遍。没有账号就是空的。 */
export function defaultBadgeAccount(entry: ServiceEntry): string {
  return sanitizeBadgeText(entry.account ?? '', BADGE_ISSUER_MAX).text;
}

/**
 * 当前生效的工卡副标题。
 *
 * 和显示名不同，**空串在这里是有效值**：它的意思是"这一行不要副标题"，
 * 而不是"回到自动推导"。回到自动推导用的是 null——账号是一长串邮箱时，
 * 用户多半就是想把它去掉，不能让空输入又把它变回来。
 */
export function effectiveBadgeAccount(entry: ServiceEntry): string {
  const custom = entry.badgeAccount;
  if (custom !== undefined && custom !== null) {
    return sanitizeBadgeText(custom, BADGE_ISSUER_MAX).text;
  }
  return defaultBadgeAccount(entry);
}

/** 条目是否会被算进这次推送。未显式关掉的都算。 */
export function isBadgeEnabled(entry: ServiceEntry): boolean {
  return entry.badgeEnabled !== false;
}

export function toBadgeEntry(entry: ServiceEntry): BadgeConversion {
  if (!canGenerateTotp(entry)) {
    return { ok: false, reason: entry.unsupportedReason ?? '工卡只支持标准 TOTP 条目' };
  }
  if (entry.digits < BADGE_DIGITS_MIN || entry.digits > BADGE_DIGITS_MAX) {
    return { ok: false, reason: `工卡只支持 ${BADGE_DIGITS_MIN}–${BADGE_DIGITS_MAX} 位验证码` };
  }
  if (entry.period < BADGE_PERIOD_MIN || entry.period > BADGE_PERIOD_MAX) {
    return {
      ok: false,
      reason: `工卡只支持 ${BADGE_PERIOD_MIN}–${BADGE_PERIOD_MAX} 秒的周期`,
    };
  }

  let secret: Uint8Array;
  try {
    secret = base32Decode(entry.secret);
  } catch (cause) {
    return {
      ok: false,
      reason: cause instanceof Base32Error ? cause.message : '密钥无法解码',
    };
  }
  if (secret.length < BADGE_SECRET_MIN_BYTES) {
    return { ok: false, reason: `密钥太短（${String(secret.length)} 字节），工卡不接受` };
  }
  if (secret.length > BADGE_SECRET_MAX_BYTES) {
    return {
      ok: false,
      reason: `密钥超过 ${String(BADGE_SECRET_MAX_BYTES)} 字节，工卡存不下`,
    };
  }

  const label = effectiveBadgeLabel(entry);
  if (label.length === 0) {
    return { ok: false, reason: '这条在工卡上没有可显示的名字，请手动填一个 ASCII 名字' };
  }
  const account = effectiveBadgeAccount(entry);

  return {
    ok: true,
    labelWasRewritten: label !== (entry.issuer ?? entry.name),
    entry: {
      label,
      issuer: account,
      secret,
      digits: entry.digits,
      period: entry.period,
      algorithm: BADGE_ALGORITHM_CODE[entry.algorithm],
      // 品牌色和页面上那行铺的是同一个（lib/icons/tile.ts 算的），工卡照着铺。
      accent: hexToRgb565(iconAccent(entry)),
      // 位图要光栅化，那是浏览器的事；这一层是纯函数，只留个位置。
      // 真正的图标由 BadgePanel 在推送前调 rasterizeBadgeIcon() 填进来。
      icon: null,
    },
  };
}
