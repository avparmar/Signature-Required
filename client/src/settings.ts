/**
 * Settings: a handful of the game's tunables, editable from the ⚙ card and kept in this browser
 * (localStorage). They apply to the next new game. Values from the address (?rivers=, ?seed=,
 * ?via=) win over saved ones.
 */
import { makeGameConfig, type GameConfig, type GameConfigOverrides } from '@sr/core';

type Section = 'town' | 'cycles' | 'trucks' | 'depots' | 'money' | 'auctions' | 'openings';

export interface Setting {
  group: string;
  label: string;
  /** Where it lives: a config section and key, or a top-level key. */
  section: Section | null;
  key: string;
  /** Shown value = stored value × scale (e.g. seconds shown as minutes, fractions as %). */
  scale?: number;
  unit?: string;
  min: number;
  max: number;
  step: number;
  hint?: string;
}

export const SETTINGS: Setting[] = [
  { group: 'Game', label: 'Length', section: null, key: 'durationSec', scale: 1 / 60, unit: 'min', min: 5, max: 60, step: 1 },
  { group: 'Game', label: 'Players (you + bots)', section: null, key: 'players', min: 2, max: 4, step: 1 },
  { group: 'Game', label: 'Starting cash', section: null, key: 'startingCash', unit: '$', min: 0, max: 500, step: 10 },
  { group: 'Game', label: 'Rivers', section: 'town', key: 'rivers', min: 0, max: 2, step: 1 },
  { group: 'Money', label: 'Share of each delivery kept by the company', section: 'money', key: 'deliveryToTreasury', scale: 100, unit: '%', min: 0, max: 100, step: 5, hint: 'The rest goes to the dividend pot.' },
  { group: 'Money', label: 'Dividends every', section: 'money', key: 'payoutEverySec', unit: 's', min: 30, max: 600, step: 15 },
  { group: 'Money', label: 'Pallet price', section: 'money', key: 'palletPrice', unit: '$', min: 0.5, max: 10, step: 0.1 },
  { group: 'Money', label: 'Premium pallet price', section: 'money', key: 'premiumPrice', unit: '$', min: 0.5, max: 15, step: 0.1 },
  { group: 'Money', label: 'Final bonus (share of assets)', section: 'money', key: 'finalAssetShare', scale: 100, unit: '%', min: 0, max: 100, step: 5 },
  { group: 'Trucks', label: 'Truck price', section: 'depots', key: 'truckPrice', unit: '$', min: 1, max: 100, step: 1 },
  { group: 'Trucks', label: 'Each truck costs more than the last by', section: 'depots', key: 'truckPriceStep', unit: '$', min: 0, max: 20, step: 0.5 },
  { group: 'Trucks', label: 'Trucks per factory', section: 'depots', key: 'capacity', min: 1, max: 30, step: 1 },
  { group: 'Trucks', label: 'Speed', section: 'trucks', key: 'speed', unit: 'blocks/s', min: 0.1, max: 2, step: 0.05 },
  { group: 'Factories', label: 'Full price', section: 'depots', key: 'depotBase', unit: '$', min: 10, max: 1000, step: 10 },
  { group: 'Factories', label: 'Biggest discount', section: 'depots', key: 'maxSubsidy', scale: 100, unit: '%', min: 0, max: 100, step: 5 },
  { group: 'Factories', label: 'Pickups + deliveries for any discount', section: 'depots', key: 'subsidyMinPallets', min: 0, max: 100, step: 1 },
  { group: 'Factories', label: 'Pickups + deliveries for the full discount', section: 'depots', key: 'subsidyTarget', min: 1, max: 300, step: 5 },
  { group: 'Factories', label: 'A new factory site every', section: 'depots', key: 'newSiteEverySec', unit: 's', min: 0, max: 600, step: 30, hint: '0 for never. From that long in, until the last two minutes.' },
  { group: 'Factories', label: 'Subsidy zone', section: 'depots', key: 'districtBlocks', unit: 'blocks', min: 1, max: 12, step: 1 },
  { group: 'Businesses', label: 'A new business every', section: 'openings', key: 'everySec', unit: 's', min: 10, max: 300, step: 5 },
  { group: 'Businesses', label: 'Cycle length', section: 'cycles', key: 'cycleSec', unit: 's', min: 10, max: 180, step: 5 },
  { group: 'Businesses', label: 'Grace period', section: 'cycles', key: 'graceSec', unit: 's', min: 0, max: 300, step: 15, hint: 'Before a new or just-changed business can be judged again.' },
  { group: 'Shares', label: 'Offering clock', section: 'auctions', key: 'clockSec', unit: 's', min: 10, max: 120, step: 5 },
  { group: 'Shares', label: 'Longest an offering can run', section: 'auctions', key: 'maxSec', unit: 's', min: 10, max: 300, step: 5, hint: 'Late bids add time, but never past this.' },
  { group: 'Shares', label: 'Wait after a company sells a share', section: 'auctions', key: 'saleCooldownSec', unit: 's', min: 0, max: 300, step: 15 },
  { group: 'Shares', label: 'Company buys shares back at (share of company value)', section: 'auctions', key: 'buybackShare', scale: 100, unit: '%', min: 0, max: 200, step: 5, hint: 'Of the company value per share, while its cash covers that. Also the least it sells its own shares for.' },
];

const KEY = 'sr-settings';

/** The value a setting has in a full config (cycle length is a [min, max] pair: use the first). */
export function valueIn(cfg: GameConfig, s: Setting): number {
  const box = (s.section ? (cfg as unknown as Record<string, Record<string, unknown>>)[s.section] : cfg) as Record<string, unknown>;
  const v = box[s.key];
  return Array.isArray(v) ? Number(v[0]) : Number(v);
}

/** Saved overrides, or none (also when storage isn't available). */
export function loadSettings(): GameConfigOverrides {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as GameConfigOverrides) : {};
  } catch {
    return {};
  }
}

export function saveSettings(o: GameConfigOverrides) {
  try {
    localStorage.setItem(KEY, JSON.stringify(o));
  } catch {
    // Private window or storage blocked: the settings still apply to this game.
  }
}

/** Overrides `b` on top of `a`, section by section. */
export function mergeOverrides(a: GameConfigOverrides, b: GameConfigOverrides): GameConfigOverrides {
  const out: Record<string, unknown> = { ...a, ...b };
  for (const sec of ['town', 'cycles', 'trucks', 'depots', 'money', 'auctions', 'openings'] as const)
    if (a[sec] || b[sec]) out[sec] = { ...a[sec], ...b[sec] };
  return out as GameConfigOverrides;
}

/** Overrides from the settings form: only the values that differ from the defaults. */
export function overridesFrom(values: Map<Setting, number>): GameConfigOverrides {
  const defaults = makeGameConfig({});
  const o: Record<string, unknown> = {};
  for (const [s, shown] of values) {
    const v = shown / (s.scale ?? 1);
    if (Math.abs(v - valueIn(defaults, s)) < 1e-9) continue;
    const stored = s.key === 'cycleSec' ? [v, v] : v;
    if (!s.section) o[s.key] = stored;
    else o[s.section] = { ...(o[s.section] as object), [s.key]: stored };
  }
  // The pot gets whatever the company doesn't keep.
  const money = o.money as Record<string, number> | undefined;
  if (money?.deliveryToTreasury !== undefined) money.deliveryToPot = 1 - money.deliveryToTreasury;
  return o as GameConfigOverrides;
}
