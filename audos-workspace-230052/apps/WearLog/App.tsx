import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Shirt,
  Plus,
  Trash2,
  Calendar,
  TrendingUp,
  TrendingDown,
  AlertCircle,
  Clock,
  Sparkles,
  Briefcase,
  Heart,
  Coffee,
} from 'lucide-react';
import { tw, typography } from '../../lib/colors';

/**
 * Wear Log — track what you wear, when, and why.
 * Table `wear_logs` is created on first write:
 *   item_name (text), wear_date (text ISO date), occasion (text)
 */

type Occasion = 'work' | 'date night' | 'casual weekend';

interface WearEntry {
  id: number;
  item_name: string;
  wear_date: string;
  occasion: Occasion | string;
  created_at?: string;
}

type View = 'log' | 'history' | 'insights';

declare global {
  interface Window {
    useWorkspaceDB: <T = unknown>(
      table: string,
      options?: {
        shared?: boolean;
        limit?: number;
        offset?: number;
        orderBy?: { column: string; direction: 'asc' | 'desc' };
        filters?: Array<{ column: string; operator: string; value: unknown }>;
      },
    ) => {
      data: T[];
      loading: boolean;
      error: Error | null;
      total: number;
      refresh: () => void;
    };
    __workspaceDb: {
      from: (table: string) => {
        insert: (row: Record<string, unknown>) => Promise<void>;
        update: (id: number, row: Record<string, unknown>) => Promise<void>;
        delete: (id: number) => Promise<void>;
      };
    };
  }
}

const OCCASIONS: { id: Occasion; label: string; icon: typeof Briefcase }[] = [
  { id: 'work', label: 'Work', icon: Briefcase },
  { id: 'date night', label: 'Date night', icon: Heart },
  { id: 'casual weekend', label: 'Casual weekend', icon: Coffee },
];

const NEGLECTED_DAYS = 21;

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso + 'T12:00:00').toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function daysSince(iso: string): number {
  const then = new Date(iso + 'T12:00:00').getTime();
  const now = new Date(todayISO() + 'T12:00:00').getTime();
  return Math.floor((now - then) / (1000 * 60 * 60 * 24));
}

/** Deterministic accent swatch from item name */
function itemSwatch(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
  const hues = [18, 28, 38, 145, 160, 210, 340];
  const hue = hues[Math.abs(hash) % hues.length];
  return `hsl(${hue}, 42%, 72%)`;
}

function occasionBadge(occasion: string): string {
  if (occasion === 'work') return `${tw.badge.default} ${tw.category.work}`;
  if (occasion === 'date night') return `${tw.badge.default} ${tw.badge.accent}`;
  if (occasion === 'casual weekend') return `${tw.badge.default} ${tw.category.personal}`;
  return `${tw.badge.default} ${tw.badge.neutral}`;
}

export default function WearLog() {
  const { data: entries, loading, error, refresh } = window.useWorkspaceDB<WearEntry>('wear_logs', {
    orderBy: { column: 'wear_date', direction: 'desc' },
    limit: 500,
  });

  const [view, setView] = useState<View>('log');
  const [itemName, setItemName] = useState('');
  const [wearDate, setWearDate] = useState(todayISO());
  const [occasion, setOccasion] = useState<Occasion>('work');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (view === 'log') inputRef.current?.focus();
  }, [view]);

  const stats = useMemo(() => {
    const list = entries || [];
    const byItem = new Map<string, { count: number; lastWorn: string }>();

    for (const e of list) {
      const key = e.item_name.trim();
      if (!key) continue;
      const existing = byItem.get(key);
      if (!existing) {
        byItem.set(key, { count: 1, lastWorn: e.wear_date });
      } else {
        existing.count += 1;
        if (e.wear_date > existing.lastWorn) existing.lastWorn = e.wear_date;
      }
    }

    const ranked = [...byItem.entries()]
      .map(([name, { count, lastWorn }]) => ({ name, count, lastWorn, daysAgo: daysSince(lastWorn) }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    const mostWorn = ranked.slice(0, 5);
    const leastWorn = [...ranked].sort((a, b) => a.count - b.count || a.name.localeCompare(b.name)).slice(0, 5);
    const neglected = ranked.filter((r) => r.daysAgo >= NEGLECTED_DAYS);

    const weekAgo = new Date();
    weekAgo.setDate(weekAgo.getDate() - 7);
    const weekCutoff = weekAgo.toISOString().slice(0, 10);
    const thisWeek = list.filter((e) => e.wear_date >= weekCutoff).length;

    return {
      totalWears: list.length,
      uniqueItems: byItem.size,
      thisWeek,
      ranked,
      mostWorn,
      leastWorn,
      neglected,
    };
  }, [entries]);

  const recentItems = useMemo(() => {
    const seen = new Set<string>();
    const items: string[] = [];
    for (const e of entries || []) {
      const name = e.item_name.trim();
      if (name && !seen.has(name.toLowerCase())) {
        seen.add(name.toLowerCase());
        items.push(name);
      }
      if (items.length >= 6) break;
    }
    return items;
  }, [entries]);

  const handleLog = async () => {
    const name = itemName.trim();
    if (!name || busy) return;
    setBusy(true);
    try {
      await window.__workspaceDb.from('wear_logs').insert({
        item_name: name,
        wear_date: wearDate,
        occasion,
      });
      setItemName('');
      setWearDate(todayISO());
      refresh();
      setView('history');
    } finally {
      setBusy(false);
    }
  };

  const handleDelete = async (id: number) => {
    await window.__workspaceDb.from('wear_logs').delete(id);
    refresh();
  };

  const tabs: { id: View; label: string; icon: typeof Shirt }[] = [
    { id: 'log', label: 'Log wear', icon: Plus },
    { id: 'history', label: 'History', icon: Clock },
    { id: 'insights', label: 'Insights', icon: Sparkles },
  ];

  return (
    <div className="min-h-full flex flex-col w-full bg-transparent">
      {/* Hero stats strip */}
      <div className="px-5 pt-4 pb-3">
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Total wears', value: stats.totalWears },
            { label: 'In rotation', value: stats.uniqueItems },
            { label: 'This week', value: stats.thisWeek },
          ].map((s) => (
            <div
              key={s.label}
              className={`${tw.card.default} rounded-xl p-3 text-center transition-all duration-200 hover:shadow-md`}
            >
              <p className={`text-xl font-semibold ${typography.color.brand}`}>{s.value}</p>
              <p className={`text-[10px] uppercase tracking-wider mt-0.5 ${typography.color.tertiary}`}>{s.label}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Tab nav */}
      <div className="px-5 pb-2">
        <div className={`flex gap-1 p-1 rounded-xl ${tw.bg.muted}`}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setView(id)}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-lg text-xs font-medium transition-all duration-200 ${
                view === id
                  ? `${tw.bg.card} shadow-sm ${typography.color.primary}`
                  : `${typography.color.tertiary} hover:text-[var(--space-text-secondary)]`
              }`}
            >
              <Icon className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-5 pb-6">
        {loading ? (
          <div className="flex flex-col items-center justify-center py-16 gap-3">
            <div className="animate-spin rounded-full h-7 w-7 border-2 border-[var(--space-border-default)] border-t-[var(--space-brand-primary)]" />
            <p className={`text-sm ${typography.color.tertiary}`}>Loading your wardrobe log…</p>
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <AlertCircle className={`w-8 h-8 mx-auto mb-3 ${tw.icon.danger}`} />
            <p className={`text-sm ${typography.color.danger}`}>Couldn't load wear history</p>
            <button
              onClick={refresh}
              className={`mt-3 px-4 py-2 rounded-lg text-sm ${tw.button.secondary}`}
            >
              Try again
            </button>
          </div>
        ) : view === 'log' ? (
          <div className="space-y-5">
            <div className={`${tw.card.elevated} rounded-2xl p-5 space-y-4`}>
              <div>
                <label className={`block text-xs font-medium uppercase tracking-wide mb-2 ${typography.color.secondary}`}>
                  What did you wear?
                </label>
                <input
                  ref={inputRef}
                  type="text"
                  value={itemName}
                  onChange={(e) => setItemName(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleLog()}
                  placeholder="e.g. Terracotta linen blazer"
                  className={`${tw.input.base} ${tw.input.default} text-sm`}
                  data-testid="input-item-name"
                />
              </div>

              {recentItems.length > 0 && (
                <div>
                  <p className={`text-[10px] uppercase tracking-wider mb-2 ${typography.color.tertiary}`}>
                    Recent pieces
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {recentItems.map((item) => (
                      <button
                        key={item}
                        onClick={() => setItemName(item)}
                        className={`px-2.5 py-1 rounded-full text-xs transition-all duration-200 ${tw.badge.primary} hover:brightness-95`}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              <div>
                <label className={`block text-xs font-medium uppercase tracking-wide mb-2 ${typography.color.secondary}`}>
                  <Calendar className="w-3 h-3 inline mr-1 -mt-0.5" />
                  Wear date
                </label>
                <input
                  type="date"
                  value={wearDate}
                  max={todayISO()}
                  onChange={(e) => setWearDate(e.target.value)}
                  className={`${tw.input.base} ${tw.input.default} text-sm`}
                  data-testid="input-wear-date"
                />
              </div>

              <div>
                <label className={`block text-xs font-medium uppercase tracking-wide mb-2 ${typography.color.secondary}`}>
                  Occasion
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {OCCASIONS.map(({ id, label, icon: Icon }) => (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setOccasion(id)}
                      className={`flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-sm font-medium transition-all duration-200 ${
                        occasion === id
                          ? 'border-[var(--space-brand-primary)] bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)] shadow-sm'
                          : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-secondary)] hover:border-[var(--space-brand-primary-200)]'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </button>
                  ))}
                </div>
              </div>

              <button
                onClick={handleLog}
                disabled={busy || !itemName.trim()}
                className={`w-full py-3 rounded-xl text-sm font-medium flex items-center justify-center gap-2 ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                data-testid="button-log-wear"
              >
                <Shirt className="w-4 h-4" />
                {busy ? 'Saving…' : 'Log this wear'}
              </button>
            </div>

            <p className={`text-center text-xs ${typography.color.tertiary}`}>
              Every entry builds your utilization picture — stop rebuying, start rediscovering.
            </p>
          </div>
        ) : view === 'history' ? (
          <div className="space-y-3">
            {!entries || entries.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${tw.bg.accent}`}>
                  <Shirt className={`w-7 h-7 ${tw.icon.primary}`} />
                </div>
                <p className={`text-sm font-medium ${typography.color.primary}`}>No wears logged yet</p>
                <p className={`text-xs max-w-[240px] ${typography.color.tertiary}`}>
                  Log your first outfit to start tracking what earns its place in your closet.
                </p>
                <button
                  onClick={() => setView('log')}
                  className={`mt-2 px-4 py-2 rounded-lg text-sm ${tw.button.primary}`}
                >
                  Log first wear
                </button>
              </div>
            ) : (
              entries.map((entry, idx) => (
                <article
                  key={entry.id}
                  className={`group flex gap-3 p-3.5 rounded-xl border transition-all duration-200 hover:shadow-md ${tw.card.default}`}
                  style={{ animationDelay: `${idx * 40}ms` }}
                  data-testid={`row-wear-${entry.id}`}
                >
                  <div
                    className="w-12 h-12 rounded-xl flex-shrink-0 shadow-inner"
                    style={{ background: itemSwatch(entry.item_name) }}
                    aria-hidden
                  />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <h3 className={`text-sm font-semibold truncate ${typography.color.primary}`}>
                          {entry.item_name}
                        </h3>
                        <p className={`text-xs mt-0.5 ${typography.color.tertiary}`}>
                          {formatDate(entry.wear_date)}
                          {daysSince(entry.wear_date) === 0 && (
                            <span className={`ml-1.5 ${tw.badge.default} ${tw.badge.primary} px-1.5 py-0`}>
                              today
                            </span>
                          )}
                        </p>
                      </div>
                      <button
                        onClick={() => handleDelete(entry.id)}
                        className={`p-1.5 rounded-lg opacity-0 group-hover:opacity-100 focus:opacity-100 transition-all ${tw.button.ghost} hover:text-[var(--space-semantic-danger)]`}
                        aria-label="Remove entry"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                    <span className={`inline-block mt-2 ${occasionBadge(entry.occasion)}`}>
                      {entry.occasion}
                    </span>
                  </div>
                </article>
              ))
            )}
          </div>
        ) : (
          /* Insights view */
          <div className="space-y-5">
            {stats.uniqueItems === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-3 text-center">
                <Sparkles className={`w-8 h-8 ${tw.icon.accent}`} />
                <p className={`text-sm font-medium ${typography.color.primary}`}>Insights unlock after your first log</p>
                <button onClick={() => setView('log')} className={`px-4 py-2 rounded-lg text-sm ${tw.button.primary}`}>
                  Start logging
                </button>
              </div>
            ) : (
              <>
                {/* Neglected alerts */}
                {stats.neglected.length > 0 && (
                  <section className={`rounded-2xl p-4 border ${tw.card.default}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <AlertCircle className={`w-4 h-4 ${tw.icon.primary}`} />
                      <h3 className={`text-sm font-semibold ${typography.color.primary}`}>
                        Neglected pieces
                      </h3>
                      <span className={`${tw.badge.default} ${tw.badge.warning}`}>
                        {stats.neglected.length}
                      </span>
                    </div>
                    <p className={`text-xs mb-3 ${typography.color.tertiary}`}>
                      Not worn in {NEGLECTED_DAYS}+ days — time to rediscover or reconsider.
                    </p>
                    <ul className="space-y-2">
                      {stats.neglected.slice(0, 6).map((item) => (
                        <li
                          key={item.name}
                          className="flex items-center gap-3 py-2 px-3 rounded-xl bg-[var(--space-surface-muted)]"
                        >
                          <div
                            className="w-8 h-8 rounded-lg flex-shrink-0"
                            style={{ background: itemSwatch(item.name) }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className={`text-sm font-medium truncate ${typography.color.primary}`}>{item.name}</p>
                            <p className={`text-xs ${typography.color.tertiary}`}>
                              Last worn {item.daysAgo} days ago · {item.count}× total
                            </p>
                          </div>
                          <button
                            onClick={() => {
                              setItemName(item.name);
                              setView('log');
                            }}
                            className={`text-xs px-2.5 py-1 rounded-lg shrink-0 ${tw.button.secondary}`}
                          >
                            Wear again
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                )}

                {/* Rankings grid */}
                <div className="grid sm:grid-cols-2 gap-4">
                  <section className={`rounded-2xl p-4 ${tw.card.default}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <TrendingUp className={`w-4 h-4 ${tw.icon.success}`} />
                      <h3 className={`text-sm font-semibold ${typography.color.primary}`}>Most worn</h3>
                    </div>
                    <ul className="space-y-2">
                      {stats.mostWorn.map((item, i) => (
                        <li key={item.name} className="flex items-center gap-2">
                          <span className={`w-5 text-xs font-bold ${typography.color.tertiary}`}>{i + 1}</span>
                          <div
                            className="w-6 h-6 rounded-md flex-shrink-0"
                            style={{ background: itemSwatch(item.name) }}
                          />
                          <span className={`flex-1 text-sm truncate ${typography.color.primary}`}>{item.name}</span>
                          <span className={`text-xs font-semibold ${typography.color.brand}`}>{item.count}×</span>
                        </li>
                      ))}
                    </ul>
                  </section>

                  <section className={`rounded-2xl p-4 ${tw.card.default}`}>
                    <div className="flex items-center gap-2 mb-3">
                      <TrendingDown className={`w-4 h-4 ${tw.icon.muted}`} />
                      <h3 className={`text-sm font-semibold ${typography.color.primary}`}>Least worn</h3>
                    </div>
                    <ul className="space-y-2">
                      {stats.leastWorn.map((item, i) => (
                        <li key={item.name} className="flex items-center gap-2">
                          <span className={`w-5 text-xs font-bold ${typography.color.tertiary}`}>{i + 1}</span>
                          <div
                            className="w-6 h-6 rounded-md flex-shrink-0"
                            style={{ background: itemSwatch(item.name) }}
                          />
                          <span className={`flex-1 text-sm truncate ${typography.color.primary}`}>{item.name}</span>
                          <span className={`text-xs ${typography.color.tertiary}`}>{item.count}×</span>
                        </li>
                      ))}
                    </ul>
                  </section>
                </div>

                {/* Full utilization list */}
                <section className={`rounded-2xl p-4 ${tw.card.default}`}>
                  <h3 className={`text-sm font-semibold mb-3 ${typography.color.primary}`}>
                    Closet utilization
                  </h3>
                  <div className="space-y-2">
                    {stats.ranked.map((item) => {
                      const maxCount = stats.ranked[0]?.count || 1;
                      const pct = Math.round((item.count / maxCount) * 100);
                      return (
                        <div key={item.name} className="space-y-1">
                          <div className="flex items-center justify-between text-xs">
                            <span className={`truncate font-medium ${typography.color.primary}`}>{item.name}</span>
                            <span className={`shrink-0 ml-2 ${typography.color.tertiary}`}>
                              {item.count} wears
                            </span>
                          </div>
                          <div className="h-1.5 rounded-full bg-[var(--space-surface-muted)] overflow-hidden">
                            <div
                              className="h-full rounded-full transition-all duration-500 bg-[var(--space-brand-primary)]"
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
