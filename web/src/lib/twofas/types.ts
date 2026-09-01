// 库层的数据形状：对外的内部记录（ServiceEntry）与备份文件的原始形状。
// 备份来自用户磁盘上的任意文件，因此原始字段一律声明为 unknown，由 parse.ts 逐个校验。

/** 令牌类型。TOTP 以外的类型一律标记为不受支持（D13）。 */
export type TokenType = 'TOTP' | 'HOTP' | 'STEAM' | 'UNKNOWN';

/** 支持的 HMAC 算法（D13）。 */
export type OtpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** 归一化后的单条服务记录（D7）。存储层与界面层只认这一种形状。 */
export interface ServiceEntry {
  id: string;
  name: string;
  issuer: string | null;
  account: string | null;
  secret: string;
  algorithm: OtpAlgorithm;
  digits: number;
  period: number;
  tokenType: TokenType;
  unsupportedReason: string | null;
  /**
   * 推送到工卡时显示的名字。工卡只有拉丁字体，中文名在屏幕上是豆腐块，
   * 因此允许为单条指定一个 ASCII 名字。留空 / 缺省表示由发行方自动推导。
   *
   * 与顺序不同，它跟着条目一起加密存放：名字本身也是"你在用哪些服务"的线索。
   */
  badgeLabel?: string | null;
  /** 是否包含在下一次推送里。缺省视为 true —— 老记录没有这个字段。 */
  badgeEnabled?: boolean;
}

/** 一次成功解析的结果。解析失败一律抛 ImportError，不返回半成品（D8）。 */
export interface ParsedBackup {
  entries: ServiceEntry[];
  schemaVersion: number;
  wasEncrypted: boolean;
}

/** 备份中单条服务的 otp 子对象的原始形状。 */
export interface RawOtp {
  label?: unknown;
  account?: unknown;
  issuer?: unknown;
  digits?: unknown;
  period?: unknown;
  algorithm?: unknown;
  counter?: unknown;
  tokenType?: unknown;
  source?: unknown;
}

/** 备份中单条服务的原始形状。 */
export interface RawService {
  name?: unknown;
  secret?: unknown;
  updatedAt?: unknown;
  otp?: RawOtp;
  order?: unknown;
}

/** 备份文件顶层的原始形状。加密备份用 servicesEncrypted + reference 取代 services。 */
export interface RawBackup {
  schemaVersion?: unknown;
  services?: unknown;
  servicesEncrypted?: unknown;
  reference?: unknown;
  appOrigin?: unknown;
  appVersionCode?: unknown;
}
