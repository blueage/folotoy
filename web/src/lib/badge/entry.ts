// 保险库里的条目 → 可以推送到工卡的条目。
// 工卡的限制比浏览器严得多（无 CJK 字体、密钥长度、条目数），因此这里的
// 每一次拒绝都要带上人能看懂的原因，界面直接把它显示在条目旁边。

import { Base32Error, base32Decode } from '../base32';
import { canGenerateTotp } from '../totp';
import type { ServiceEntry } from '../twofas/types';
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
  const account = sanitizeBadgeText(entry.account ?? '', BADGE_ISSUER_MAX);

  return {
    ok: true,
    labelWasRewritten: label !== (entry.issuer ?? entry.name),
    entry: {
      label,
      issuer: account.text,
      secret,
      digits: entry.digits,
      period: entry.period,
      algorithm: BADGE_ALGORITHM_CODE[entry.algorithm],
    },
  };
}
