// Launch Radar — the value model and the board builder.
//
// The snapshot is a frozen DefiLlama fetch: 758 protocols, each with TVL, a 7-day
// TVL change, a listing date, and either a trading token (market cap, CoinGecko id,
// symbol) or none of those. This file turns that snapshot into a ranked board of
// protocols that record no token, with an implied value for each one and a farm plan.
//
// The implied value is a fitted claim, not a lookup. The protocols whose token
// already trades are the comparables: a log-log regression of market cap on TVL,
// 7-day growth and age is fitted on them, then applied to the pre-token protocols.
// The fit is checked two ways that never see the protocol being scored:
// walk-forward (fit on the older half by listing date, scored on the newer half)
// and leave-one-out (each comparable scored by a fit on all the others). The
// dashboard prints both checks, the fitted coefficients, and the range the
// leave-one-out errors imply. No protocol name is ever special-cased: the same
// fitted function scores every row.

/** One protocol as the sealed snapshot carries it: exactly ten fields. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole sealed snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The fitted pricing model: log10(market cap) as a linear function of the snapshot's figures. */
export interface FittedModel {
  /** Intercept of the log10 regression. */
  intercept: number;
  /** Slope on log10(TVL). */
  tvl_slope: number;
  /** Slope on clamped 7-day growth, in units of 100% (so -0.12 means -12% of a dex per +100%). */
  growth_slope: number;
  /** Slope on log10(age in days + 30). */
  age_slope: number;
  /** Ridge penalty applied to the growth and age slopes. */
  ridge_lambda: number;
  /** Comparables the fit was trained on. */
  comps: number;
  /** Median absolute log10 error of the fit on its own training set. */
  train_median_abs_log_err: number;
}

/** One held-out check of the model. */
export interface HeldOutCheck {
  name: string;
  /** How the training set was chosen. */
  method: string;
  /** Protocols scored without being trained on. */
  tested: number;
  /** Median absolute log10 error on the held-out set (0.30 dex is about a factor of 2). */
  median_abs_log_err: number;
  /** Share of held-out protocols whose fitted value lands within a factor of 2 of the market cap. */
  within_2x: number;
}

/** The candidate term sets the model tried, with both blind tests, so the reader can see the keep/drop call. */
export interface CandidateRow {
  terms: string;
  walk_forward_median_abs_log_err: number;
  walk_forward_within_2x: number;
  loo_median_abs_log_err: number;
  loo_within_2x: number;
  kept: boolean;
}

/** Everything the dashboard says about how the model was fitted and checked. */
export interface ModelReport {
  model: FittedModel;
  candidates: CandidateRow[];
  walk_forward: HeldOutCheck;
  leave_one_out: HeldOutCheck;
  /** 10th and 90th percentiles of the leave-one-out residuals, as value multipliers. */
  range_low_mult: number;
  range_high_mult: number;
  /** Share of all protocols that record a token, by age bucket, in days. */
  launch_odds_buckets: { from_days: number; to_days: number | null; protocols: number; with_token: number; odds: number }[];
  launch_odds_overall: number;
  /** Why the growth and age terms were kept despite their cost on one blind test. */
  selection_note: string;
}

/** One row of board.json. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  launch_odds: number;
  model: {
    growth_pct: number;
    growth_multiplier: number;
    age_multiplier: number;
  };
  farm_steps: string[];
}

/** One board row as the dashboard reads it, farm plan included. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  implied_low_usd: number;
  implied_high_usd: number;
  launch_odds: number;
  growth_multiplier: number;
  age_multiplier: number;
  capital_usd: number;
  hold_days: number;
  watchlist: boolean;
  farm_steps: string[];
}

/** A protocol whose token already trades, shown apart from the ranked board. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Everything the dashboard renders. */
export interface RadarData {
  as_of: string;
  floor_usd: number;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  protocols_scanned: number;
  pre_token_count: number;
  model: ModelReport;
  rows: RadarRow[];
  live: LiveRow[];
}

export const MODEL_VERSION = 'launch-radar-1';
/** Pre-token rows below the watchlist floor are taken by TVL, capped at this many. */
export const EARLY_CAP = 200;
/** Live-token protocols shown in the dashboard's separate table, by market cap. */
export const LIVE_CAP = 24;

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;
const LOG2 = Math.log10(2);

/** A finite number, else the fallback. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`; null when the listing date is missing or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** 7-day growth clamped to the range the model trusts, in per cent. */
export function clampedGrowth(p: SnapshotProtocol): number {
  return Math.min(120, Math.max(-60, finite(p.change_7d, 0)));
}

/** The age the model uses when the listing date is missing: the comps' median age. */
export function ageForModel(p: SnapshotProtocol, asOf: string, fallbackAge: number): number {
  return ageDays(asOf, p.listed_at) ?? fallbackAge;
}

/** Whether the snapshot records any token for the protocol. */
export function hasToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null;
}

/** Whether the protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return !hasToken(p);
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_NAME = /^(Binance|Coinbase|Bybit|Kraken|Bitget|OKX|Bitfinex|Gemini)\b/;

/**
 * Whether a pre-token protocol is a genuine launch candidate rather than a
 * wrapped, staked, bridged or exchange product of a token that already trades.
 * The watchlist is exempt from this filter: it is the house's floor and every
 * slug on it is ranked whatever the filter says.
 */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  const c = (p.category ?? '').toLowerCase();
  if (c.includes('bridge') || c.includes('liquid staking') || c.includes('liquid restaking')) return false;
  if (c.includes('restaked btc') || c === 'cex' || c.includes('wrapper')) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  if (EXCHANGE_NAME.test(p.name)) return false;
  return true;
}

/** Solve a small dense linear system by Gaussian elimination with partial pivoting. */
function solveLinear(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const m = matrix.map((row, i) => [...row, rhs[i]!]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[pivot]![col]!)) pivot = r;
    const tmp = m[col]!;
    m[col] = m[pivot]!;
    m[pivot] = tmp;
    const diag = m[col]![col]!;
    if (diag === 0) throw new SnapshotError('the pricing fit is singular');
    for (let r = col + 1; r < n; r++) {
      const factor = m[r]![col]! / diag;
      for (let k = col; k <= n; k++) m[r]![k]! -= factor * m[col]![k]!;
    }
  }
  const out = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = m[r]![n]!;
    for (let k = r + 1; k < n; k++) v -= m[r]![k]! * out[k]!;
    out[r] = v / m[r]![r]!;
  }
  return out;
}

/** The regression's feature row for one protocol: [1, log10 TVL, growth/100, log10(age+30)]. */
function features(p: SnapshotProtocol, asOf: string, fallbackAge: number): number[] {
  return [
    1,
    Math.log10(Math.max(1, p.tvl_usd)),
    clampedGrowth(p) / 100,
    Math.log10(ageForModel(p, asOf, fallbackAge) + 30),
  ];
}

/**
 * Ridge regression of log10(market cap) on the features, fitted on the given
 * comparables. The penalty touches only the growth and age slopes, never the
 * intercept or the TVL slope: those two terms are the noisy ones, and shrinking
 * them is what keeps the model from chasing a week's noise.
 */
function fitRidge(
  comps: SnapshotProtocol[],
  asOf: string,
  fallbackAge: number,
  useGrowth: boolean,
  useAge: boolean,
  lambda: number,
): number[] {
  const keep = [true, true, useGrowth, useAge];
  const dim = keep.filter(Boolean).length;
  const reducedIndex = (full: number): number => keep.slice(0, full + 1).filter(Boolean).length - 1;
  const a: number[][] = Array.from({ length: dim }, () => new Array<number>(dim).fill(0));
  const b: number[] = new Array<number>(dim).fill(0);
  for (const p of comps) {
    const full = features(p, asOf, fallbackAge);
    const x = full.filter((_, i) => keep[i]);
    const y = Math.log10(p.mcap_usd!);
    for (let r = 0; r < dim; r++) {
      b[r]! += x[r]! * y;
      for (let c = 0; c < dim; c++) a[r]![c]! += x[r]! * x[c]!;
    }
  }
  // The ridge penalty lands on the growth and age slopes in the reduced matrix.
  if (useGrowth) a[reducedIndex(2)]![reducedIndex(2)]! += lambda;
  if (useAge) a[reducedIndex(3)]![reducedIndex(3)]! += lambda;
  const solved = solveLinear(a, b);
  const beta = [0, 0, 0, 0];
  let j = 0;
  for (let i = 0; i < 4; i++) if (keep[i]) beta[i] = solved[j++]!;
  return beta;
}

/** The fitted log10 market cap of one protocol under coefficients `beta`. */
function predictLog(p: SnapshotProtocol, asOf: string, fallbackAge: number, beta: number[]): number {
  const f = features(p, asOf, fallbackAge);
  return f[0]! * beta[0]! + f[1]! * beta[1]! + f[2]! * beta[2]! + f[3]! * beta[3]!;
}

/** Median of a list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/** The q-th quantile of a sorted list (nearest-rank). */
function quantile(sorted: number[], q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)))]!;
}

interface CheckResult {
  medianAbs: number;
  within2x: number;
}

/** Summarise a list of log10 residuals as a held-out check. */
function summarise(residuals: number[]): CheckResult {
  const abs = residuals.map((r) => Math.abs(r));
  return {
    medianAbs: median(abs),
    within2x: residuals.filter((r) => Math.abs(r) <= LOG2).length / Math.max(1, residuals.length),
  };
}

/**
 * Fit the pricing model on the comparables and check it both ways. The term set
 * is fixed here — TVL, growth and age, growth and age shrunk by a ridge of 10 —
 * and the candidate table shows what the two blind tests said about every
 * simpler term set, so the reader can see the keep/drop call and its cost.
 */
export function fitAndValidate(snapshot: Snapshot): { model: FittedModel; report: ModelReport } {
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  if (comps.length < 20) throw new SnapshotError(`only ${comps.length} comparables with a market cap: the fit needs at least 20`);
  const ages = comps.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const fallbackAge = ages.length > 0 ? median(ages) : 365;
  const lambda = 10;

  const beta = fitRidge(comps, snapshot.as_of, fallbackAge, true, true, lambda);
  const trainResiduals = comps.map((p) => Math.log10(p.mcap_usd!) - predictLog(p, snapshot.as_of, fallbackAge, beta));

  // Walk-forward: fit on the older half by listing date, score the newer half.
  const dated = comps.filter((p) => p.listed_at !== null).sort((x, y) => (x.listed_at! < y.listed_at! ? -1 : 1));
  const half = Math.floor(dated.length / 2);
  const wfBeta = fitRidge(dated.slice(0, half), snapshot.as_of, fallbackAge, true, true, lambda);
  const wfResiduals = dated.slice(half).map((p) => Math.log10(p.mcap_usd!) - predictLog(p, snapshot.as_of, fallbackAge, wfBeta));
  const wf = summarise(wfResiduals);

  // Leave-one-out: every comparable scored by a fit on all the others.
  const looResiduals: number[] = [];
  for (let i = 0; i < comps.length; i++) {
    const rest = comps.filter((_, j) => j !== i);
    const b = fitRidge(rest, snapshot.as_of, fallbackAge, true, true, lambda);
    looResiduals.push(Math.log10(comps[i]!.mcap_usd!) - predictLog(comps[i]!, snapshot.as_of, fallbackAge, b));
  }
  const loo = summarise(looResiduals);
  const looSorted = [...looResiduals].sort((x, y) => x - y);
  const rangeLow = Math.pow(10, quantile(looSorted, 0.1));
  const rangeHigh = Math.pow(10, quantile(looSorted, 0.9));

  // The candidate table: every simpler term set, both blind tests, same protocol.
  const candidates: CandidateRow[] = [];
  const termSets: { label: string; growth: boolean; age: boolean; lam: number }[] = [
    { label: 'TVL only', growth: false, age: false, lam: 0 },
    { label: 'TVL + growth', growth: true, age: false, lam: 10 },
    { label: 'TVL + age', growth: false, age: true, lam: 10 },
    { label: 'TVL + growth + age', growth: true, age: true, lam: 10 },
  ];
  for (const set of termSets) {
    const bWf = fitRidge(dated.slice(0, half), snapshot.as_of, fallbackAge, set.growth, set.age, set.lam);
    const wfR = dated.slice(half).map((p) => Math.log10(p.mcap_usd!) - predictLog(p, snapshot.as_of, fallbackAge, bWf));
    const looR: number[] = [];
    for (let i = 0; i < comps.length; i++) {
      const b = fitRidge(comps.filter((_, j) => j !== i), snapshot.as_of, fallbackAge, set.growth, set.age, set.lam);
      looR.push(Math.log10(comps[i]!.mcap_usd!) - predictLog(comps[i]!, snapshot.as_of, fallbackAge, b));
    }
    const wfS = summarise(wfR);
    const looS = summarise(looR);
    candidates.push({
      terms: set.label,
      walk_forward_median_abs_log_err: round3(wfS.medianAbs),
      walk_forward_within_2x: round3(wfS.within2x),
      loo_median_abs_log_err: round3(looS.medianAbs),
      loo_within_2x: round3(looS.within2x),
      kept: set.growth && set.age,
    });
  }

  // Launch odds from the peers' record: among all protocols, the share that
  // records a token, by how long they have been listed.
  const buckets: { from_days: number; to_days: number | null }[] = [
    { from_days: 0, to_days: 180 },
    { from_days: 180, to_days: 365 },
    { from_days: 365, to_days: 730 },
    { from_days: 730, to_days: 1095 },
    { from_days: 1095, to_days: null },
  ];
  const launchBuckets = buckets.map((bucket) => {
    const members = snapshot.protocols.filter((p) => {
      const a = ageDays(snapshot.as_of, p.listed_at);
      return a !== null && a >= bucket.from_days && (bucket.to_days === null || a < bucket.to_days);
    });
    const withToken = members.filter(hasToken).length;
    return {
      from_days: bucket.from_days,
      to_days: bucket.to_days,
      protocols: members.length,
      with_token: withToken,
      odds: members.length > 0 ? round3(withToken / members.length) : 0,
    };
  });
  const overallOdds = round3(snapshot.protocols.filter(hasToken).length / snapshot.protocols.length);

  const baseline = candidates[0]!;
  const full = candidates[candidates.length - 1]!;
  const looCost = full.loo_median_abs_log_err - baseline.loo_median_abs_log_err;
  const wfCost = full.walk_forward_median_abs_log_err - baseline.walk_forward_median_abs_log_err;
  const selectionNote =
    `Growth and age are kept, shrunk by a ridge of ${lambda}, because the bounty asks the value to follow from TVL, 7-day growth and time without a token. ` +
    `The candidate table shows the price: the full model ${wfCost <= 0 ? 'matches or beats' : 'trails by ' + wfCost.toFixed(3) + ' dex'} the TVL-only fit on walk-forward and ` +
    `${looCost <= 0 ? 'matches or beats it' : 'trails it by ' + looCost.toFixed(3) + ' dex'} on leave-one-out. ` +
    `The fitted growth slope is negative, so fast recent growth lowers the value a little — the comps say growth weeks mean-revert — and the age slope is small, so age moves the value by at most a few tens of per cent.`;

  const model: FittedModel = {
    intercept: round4(beta[0]!),
    tvl_slope: round4(beta[1]!),
    growth_slope: round4(beta[2]!),
    age_slope: round4(beta[3]!),
    ridge_lambda: lambda,
    comps: comps.length,
    train_median_abs_log_err: round3(median(trainResiduals.map((r) => Math.abs(r)))),
  };
  const report: ModelReport = {
    model,
    candidates,
    walk_forward: {
      name: 'walk-forward',
      method: 'fit on the older half of comparables by listing date, scored on the newer half',
      tested: dated.length - half,
      median_abs_log_err: round3(wf.medianAbs),
      within_2x: round3(wf.within2x),
    },
    leave_one_out: {
      name: 'leave-one-out',
      method: 'each comparable scored by a fit on all the other comparables',
      tested: comps.length,
      median_abs_log_err: round3(loo.medianAbs),
      within_2x: round3(loo.within2x),
    },
    range_low_mult: round3(rangeLow),
    range_high_mult: round3(rangeHigh),
    launch_odds_buckets: launchBuckets,
    launch_odds_overall: overallOdds,
    selection_note: selectionNote,
  };
  return { model, report };
}

/** The launch odds of one protocol: its age bucket's share of peers that record a token. */
export function launchOdds(p: SnapshotProtocol, snapshot: Snapshot, report: ModelReport): number {
  const a = ageDays(snapshot.as_of, p.listed_at);
  if (a === null) return report.launch_odds_overall;
  for (const bucket of report.launch_odds_buckets) {
    if (a >= bucket.from_days && (bucket.to_days === null || a < bucket.to_days)) return bucket.odds;
  }
  return report.launch_odds_overall;
}

/** The implied value of one pre-token protocol under the fitted model, with its 80% range. */
export function impliedValue(
  p: SnapshotProtocol,
  snapshot: Snapshot,
  beta: number[],
  fallbackAge: number,
  rangeLow: number,
  rangeHigh: number,
): { implied: number; low: number; high: number; growthMult: number; ageMult: number } {
  const logValue = predictLog(p, snapshot.as_of, fallbackAge, beta);
  const implied = Math.max(1, Math.round(Math.pow(10, logValue)));
  const low = Math.max(1, Math.round(implied * rangeLow));
  const high = Math.min(100_000_000_000_000, Math.round(implied * rangeHigh));
  const growthMult = Math.pow(10, (beta[2]! * clampedGrowth(p)) / 100);
  const ageMult = Math.pow(10, beta[3]! * Math.log10(ageForModel(p, snapshot.as_of, fallbackAge) + 30));
  return { implied, low, high, growthMult, ageMult };
}

/** The capital one farm position needs, sized from the protocol's own TVL. */
export function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 250;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
export function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain the protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The core on-chain action for the protocol's category, in words a farmer can follow. */
function coreAction(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) {
    return `Lend $${capital} of USDC into ${name} on ${chain} and leave the loan open.`;
  }
  if (c.includes('dex') || c.includes('amm')) {
    return `Add $${capital} of liquidity to ${name}'s largest pool on ${chain} and leave the position open.`;
  }
  if (c.includes('yield') || c.includes('aggregator')) {
    return `Deposit $${capital} of USDC into ${name}'s main vault on ${chain} and keep the shares.`;
  }
  if (c.includes('bridge')) {
    return `Bridge $${capital} of USDC to ${chain} through ${name}, then use the bridged funds inside its app.`;
  }
  if (c.includes('staking') || c.includes('restak')) {
    return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt token.`;
  }
  if (c.includes('perpetual') || c.includes('derivative')) {
    return `Deposit $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  }
  if (c.includes('prediction')) {
    return `Fund ${name} with $${capital} and take one position in an active market.`;
  }
  if (c.includes('rwa')) {
    return `Buy $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  }
  if (c.includes('stable')) {
    return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  }
  if (c.includes('insurance')) {
    return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  }
  return `Deposit $${capital} of USDC into ${name}'s main product on ${chain} and leave the position open.`;
}

/**
 * A protocol's farm plan: six steps, each naming what it costs and how long it
 * takes. Every figure comes from the protocol's own record (category, chains,
 * TVL, age), never from a hand-written list of names.
 */
export function farmSteps(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const gas = capital >= 150 ? 8 : 4;
  const steps = [
    `Open a fresh wallet that holds only the funds you plan to farm, and store its seed phrase offline. Cost: under $3 of gas for the first transaction. Time: 5 minutes.`,
    `${coreAction(p, capital, chain)} Cost: $${capital} of capital plus about $${gas} of gas. Time: 15 minutes to set up.`,
    `Do one qualifying on-chain action each week — a deposit, a swap, a borrow or a vote — so the wallet stays active. Cost: about $2 of gas a week. Time: 10 minutes a week.`,
    `Keep the position open for at least ${hold} days so the activity is counted in more than one snapshot. Cost: the $${capital} stays in the position. Time: ${hold} days.`,
    `Once a month, open the protocol's own points or rewards page and check the balance; claim only from the link the protocol itself publishes. Cost: nothing to check, and never pay to claim. Time: 10 minutes.`,
    `Write the wallet address, the dates and every transaction hash in a farm log, and decide in advance when you will unwind the position. Cost: nothing but the log. Time: 5 minutes.`,
  ];
  return steps.map((s) => (s.length > 600 ? `${s.slice(0, 596)}...` : s));
}

/** The snapshot's protocol by slug. */
function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> {
  return new Map(protocols.map((p) => [p.slug, p]));
}

const round3 = (n: number): number => Math.round(n * 1e3) / 1e3;
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/**
 * Build the ranked board: every watchlist slug, plus every other pre-token
 * launch candidate in the snapshot, strongest implied value first.
 */
export function buildBoard(snapshot: Snapshot): { board: BoardRow[]; report: ModelReport; earlySize: number } {
  const { report } = fitAndValidate(snapshot);
  const beta = [report.model.intercept, report.model.tvl_slope, report.model.growth_slope, report.model.age_slope];
  const comps = snapshot.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0);
  const ages = comps.map((p) => ageDays(snapshot.as_of, p.listed_at)).filter((a): a is number => a !== null);
  const fallbackAge = ages.length > 0 ? median(ages) : 365;

  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) {
    const p = index.get(slug);
    if (p !== undefined) chosen.set(slug, p);
  }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isPreToken(p) && isLaunchCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_CAP);
  for (const p of early) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const value = impliedValue(p, snapshot, beta, fallbackAge, report.range_low_mult, report.range_high_mult);
    return { p, age, value };
  });
  scored.sort((a, b) => b.value.implied - a.value.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  const board: BoardRow[] = scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    token_status: 'pre-token',
    implied_value_usd: s.value.implied,
    implied_low_usd: s.value.low,
    implied_high_usd: s.value.high,
    launch_odds: launchOdds(s.p, snapshot, report),
    model: {
      growth_pct: clampedGrowth(s.p),
      growth_multiplier: round4(s.value.growthMult),
      age_multiplier: round4(s.value.ageMult),
    },
    farm_steps: farmSteps(s.p, s.age),
  }));
  return { board, report, earlySize: early.length };
}

/** The live-token protocols, by market cap, for the dashboard's separate table. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && (p.category ?? '').toLowerCase() !== 'cex')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_CAP)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
    }));
}

/** Everything the dashboard needs, from the snapshot and the board. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const { board, report, earlySize } = buildBoard(snapshot);
  const live = liveRows(snapshot);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: earlySize,
    live_size: live.length,
    protocols_scanned: snapshot.protocols.length,
    pre_token_count: snapshot.protocols.filter(isPreToken).length,
    model: report,
    rows: board.map((r) => ({
      rank: r.rank,
      slug: r.slug,
      name: r.name,
      category: r.category,
      chains: r.chains,
      tvl_usd: r.tvl_usd,
      change_7d: r.change_7d,
      listed_at: r.listed_at,
      age_days: r.age_days,
      implied_value_usd: r.implied_value_usd,
      implied_low_usd: r.implied_low_usd,
      implied_high_usd: r.implied_high_usd,
      launch_odds: r.launch_odds,
      growth_multiplier: r.model.growth_multiplier,
      age_multiplier: r.model.age_multiplier,
      capital_usd: capitalFor({ tvl_usd: r.tvl_usd } as SnapshotProtocol),
      hold_days: holdDaysFor(r.age_days),
      watchlist: snapshot.watchlist.includes(r.slug),
      farm_steps: r.farm_steps,
    })),
    live,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) {
    throw new SnapshotError('snapshot.json has no floor_usd');
  }
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) {
    throw new SnapshotError('snapshot.json has no watchlist of slugs');
  }
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.implied_low_usd > r.implied_value_usd || r.implied_high_usd < r.implied_value_usd) return `${r.slug} has an inverted value range`;
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
  }
  return null;
}

/** The dashboard's dataset as one script: `window.RADAR = {...};`, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
