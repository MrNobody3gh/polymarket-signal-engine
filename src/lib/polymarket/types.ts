/** Normalised fill. Both the v1 REST payload and the websocket payload are
 *  camelCase and field-identical; v2 REST is snake_case. `normalizeFill`
 *  accepts any of the three. */
export interface Fill {
  id: string;            // tx:token:wallet:ts:side:size — unique per fill
  wallet: string;        // lowercase proxy wallet
  conditionId: string;
  tokenId: string;
  side: "BUY" | "SELL";
  size: number;          // shares
  price: number;         // 0..1
  usd: number;           // size * price
  ts: number;            // epoch seconds
  title: string;
  slug: string;
  outcome: string;
  tx: string;
  source: "rest" | "ws";
}

export interface WalletProfile {
  address: string;
  name: string | null;
  copyScore: number;
  pnl90d: number;
  style: WalletStyle;
  fillsPerDay: number | null;
  programShare: number | null;
  concentration: number | null;
  netDd: number | null;
  monthsUp: number;
  monthsTotal: number;
  daysIdle: number | null;
  tradeCount: number | null;
  sources: string[];
}

export type WalletStyle =
  | "Market maker / bot"
  | "Lottery ticket"
  | "Concentrated directional"
  | "High-frequency directional"
  | "Selective directional";

export interface Position {
  wallet: string;
  tokenId: string;
  conditionId: string;
  outcome: string;
  title: string;
  slug: string;
  size: number;
  avgPrice: number;
  costUsd: number;
  peakSize: number;
  firstSeen: number;     // epoch seconds
  lastSeen: number;
  endDate: string | null; // YYYY-MM-DD
}

export type SignalKind = "NEW_POSITION" | "CONSENSUS" | "CONVICTION_ADD" | "EARLY_ENTRY" | "EXIT";

export interface Signal {
  kind: SignalKind;
  severity: 1 | 2 | 3 | 4 | 5;
  wallet: string;
  walletName: string | null;
  conditionId: string;
  tokenId: string;
  outcome: string;
  title: string;
  slug: string;
  price: number;
  usd: number;
  payload: Record<string, unknown>;
  dedupeKey: string;
  ts: number;
}

/** Raw shapes we accept from Polymarket. Kept loose on purpose: the API adds
 *  fields without notice and we must not choke on them. */
export type RawFill = Record<string, unknown>;

export interface UserPnlPoint { timestamp: number; position_pnl?: number; realized_pnl?: number; [k: string]: unknown }
export interface UserStats {
  proxy_wallet: string; trades: number; biggest_win: number; volume_usdc?: number; trade_count?: number; join_date?: number | null;
  all_time_pnl?: { position_pnl?: number; realized_market_pnl?: number; realized_combo_pnl?: number; realized_lp_pnl?: number;
    maker_rebate?: number; taker_rebate?: number; reward_income?: number; referral_income?: number; yield_income?: number; fees_paid?: number; unrealized_pnl?: number; [k: string]: unknown } | null;
  [k: string]: unknown;
}
export interface LeaderboardRow { rank: number; user_id: string; pnl: number; volume: number; user_name: string; [k: string]: unknown }
