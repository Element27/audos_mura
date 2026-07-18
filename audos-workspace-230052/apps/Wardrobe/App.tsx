import { useMemo, useRef, useState } from 'react';
import {
  Shirt,
  Plus,
  Trash2,
  Sparkles,
  Briefcase,
  Coffee,
  Heart,
  Dumbbell,
  ShoppingCart,
  Award,
  ArrowLeft,
  RefreshCw,
  AlertCircle,
  X,
  Loader2,
  Camera,
} from 'lucide-react';
import { tw, typography } from '../../lib/colors';

/**
 * Mura Wardrobe — "Get dressed for an occasion".
 * 1. Add clothes: photo + 3 quick tags (type / color / category), AI pre-tags the photo.
 * 2. Pick an occasion (6 presets or custom).
 * 3. Aya (the AI stylist) picks ONE outfit using ONLY items you own, shown with your photos.
 *
 * Data lives in WorkspaceDB table `wardrobe_items` (session-scoped: each visitor
 * sees only their own closet).
 */

type ItemType = 'top' | 'bottom' | 'dress' | 'shoes' | 'outerwear' | 'accessory';
type Category = 'casual' | 'smart casual' | 'formal' | 'sport';

interface WardrobeItem {
  id: number;
  name: string | null;
  item_type: string | null;
  color: string | null;
  category: string | null;
  photo_url: string | null;
  created_at?: string;
}

interface OutfitResult {
  occasion: string;
  title: string;
  why: string;
  tip?: string;
  items: WardrobeItem[];
}

const TABLE = 'wardrobe_items';
const MIN_ITEMS = 3;

const ITEM_TYPES: { id: ItemType; label: string }[] = [
  { id: 'top', label: 'Top' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'dress', label: 'Dress' },
  { id: 'shoes', label: 'Shoes' },
  { id: 'outerwear', label: 'Outerwear' },
  { id: 'accessory', label: 'Accessory' },
];

const CATEGORIES: { id: Category; label: string }[] = [
  { id: 'casual', label: 'Casual' },
  { id: 'smart casual', label: 'Smart casual' },
  { id: 'formal', label: 'Formal' },
  { id: 'sport', label: 'Sport' },
];

const COLORS = [
  'black', 'white', 'gray', 'beige', 'brown', 'navy',
  'blue', 'denim', 'green', 'red', 'pink', 'orange',
];

const OCCASIONS: { id: string; label: string; icon: typeof Briefcase }[] = [
  { id: 'work meeting', label: 'Work meeting', icon: Briefcase },
  { id: 'casual weekend', label: 'Casual weekend', icon: Coffee },
  { id: 'date night', label: 'Date night', icon: Heart },
  { id: 'gym', label: 'Gym', icon: Dumbbell },
  { id: 'formal event', label: 'Formal event', icon: Award },
  { id: 'errands', label: 'Errands', icon: ShoppingCart },
];

// The WorkspaceDB SDK (window.useWorkspaceDB / window.__workspaceDb) is
// auto-injected by the compiler when it detects these references.
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

function dbTable() {
  return window.__workspaceDb.from(TABLE);
}

/** Downscale a photo client-side so uploads stay small and fast. */
async function downscalePhoto(file: File, maxDim = 1024): Promise<{ dataUrl: string; base64: string }> {
  const rawUrl: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });

  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const el = new Image();
    el.onload = () => resolve(el);
    el.onerror = reject;
    el.src = rawUrl;
  });

  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(img.width * scale));
  canvas.height = Math.max(1, Math.round(img.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return { dataUrl: rawUrl, base64: rawUrl.split(',')[1] || '' };
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  return { dataUrl, base64: dataUrl.split(',')[1] || '' };
}

/** Pull the first JSON object out of a model reply (tolerates prose / code fences). */
function extractJson(text: string): any | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/** Common garment words the vision model may return, mapped to our tag enums. */
const TYPE_SYNONYMS: Record<string, ItemType> = {
  shirt: 'top', 't shirt': 'top', tshirt: 'top', tee: 'top', blouse: 'top',
  sweater: 'top', jumper: 'top', hoodie: 'top', polo: 'top', 'tank top': 'top',
  trousers: 'bottom', pants: 'bottom', jeans: 'bottom', skirt: 'bottom',
  shorts: 'bottom', leggings: 'bottom', chinos: 'bottom',
  gown: 'dress', jumpsuit: 'dress',
  sneakers: 'shoes', trainers: 'shoes', boots: 'shoes', heels: 'shoes',
  sandals: 'shoes', loafers: 'shoes', flats: 'shoes',
  jacket: 'outerwear', coat: 'outerwear', blazer: 'outerwear',
  cardigan: 'outerwear', parka: 'outerwear', trench: 'outerwear',
  bag: 'accessory', hat: 'accessory', cap: 'accessory', scarf: 'accessory',
  belt: 'accessory', tie: 'accessory', sunglasses: 'accessory', jewelry: 'accessory',
};

function normalizeType(value: unknown): ItemType | null {
  const v = String(value || '').toLowerCase().trim().replace(/[-_]/g, ' ');
  const hit = ITEM_TYPES.find((t) => t.id === v);
  if (hit) return hit.id;
  return TYPE_SYNONYMS[v] || null;
}

const CATEGORY_SYNONYMS: Record<string, Category> = {
  'business casual': 'smart casual', business: 'smart casual', 'semi formal': 'smart casual',
  dressy: 'formal', evening: 'formal', 'black tie': 'formal',
  athletic: 'sport', activewear: 'sport', sporty: 'sport', gym: 'sport',
  everyday: 'casual', relaxed: 'casual',
};

function normalizeCategory(value: unknown): Category | null {
  const v = String(value || '').toLowerCase().trim().replace(/[-_]/g, ' ');
  const hit = CATEGORIES.find((c) => c.id === v);
  if (hit) return hit.id;
  return CATEGORY_SYNONYMS[v] || null;
}

function normalizeColor(value: unknown): string | null {
  const v = String(value || '').toLowerCase().trim();
  if (!v || v === 'null' || v === 'unknown' || v === 'none') return null;
  return v.split(/[\s/,]+/)[0] || null;
}

function itemLabel(item: WardrobeItem): string {
  if (item.name && item.name.trim()) return item.name.trim();
  return [item.color, item.item_type].filter(Boolean).join(' ') || 'Item';
}

function hasOutfitBase(items: WardrobeItem[]): boolean {
  const types = new Set(items.map((i) => String(i.item_type || '').toLowerCase()));
  return types.has('dress') || (types.has('top') && types.has('bottom'));
}

/** Deterministic fallback if the AI reply is unusable: build a sensible combo locally. */
function fallbackOutfit(items: WardrobeItem[], occasion: string): WardrobeItem[] | null {
  const occ = occasion.toLowerCase();
  const preferred: Category = occ.includes('formal')
    ? 'formal'
    : occ.includes('work') || occ.includes('meeting') || occ.includes('interview')
      ? 'smart casual'
      : occ.includes('gym') || occ.includes('run') || occ.includes('sport') || occ.includes('hike')
        ? 'sport'
        : 'casual';

  const rank = (item: WardrobeItem) => (String(item.category || '').toLowerCase() === preferred ? 0 : 1);
  const byType = (type: string) =>
    items
      .filter((i) => String(i.item_type || '').toLowerCase() === type)
      .sort((a, b) => rank(a) - rank(b))[0];

  const picks: WardrobeItem[] = [];
  const dress = byType('dress');
  const top = byType('top');
  const bottom = byType('bottom');

  if (top && bottom) {
    picks.push(top, bottom);
  } else if (dress) {
    picks.push(dress);
  } else {
    return null;
  }

  const shoes = byType('shoes');
  if (shoes) picks.push(shoes);
  if (preferred !== 'sport') {
    const outer = byType('outerwear');
    if (outer && rank(outer) === 0) picks.push(outer);
  }
  return picks;
}

export default function Wardrobe() {
  const { data: items, loading, error, refresh } = window.useWorkspaceDB<WardrobeItem>(TABLE, {
    orderBy: { column: 'created_at', direction: 'desc' },
    limit: 200,
  });

  const list = items || [];

  // --- Add-item flow ------------------------------------------------------
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [photoPreview, setPhotoPreview] = useState<string | null>(null);
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [photoUploading, setPhotoUploading] = useState(false);
  const [autoTagging, setAutoTagging] = useState(false);
  const [aiTagNote, setAiTagNote] = useState<'tagged' | 'partial' | 'failed' | null>(null);
  const [draftName, setDraftName] = useState('');
  // Tag fields start EMPTY: they are only filled by the AI (when it is confident) or by the user.
  const [draftType, setDraftType] = useState<ItemType | null>(null);
  const [draftColor, setDraftColor] = useState('');
  const [draftCategory, setDraftCategory] = useState<Category | null>(null);
  const [saving, setSaving] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // --- Occasion + outfit flow ---------------------------------------------
  const [occasion, setOccasion] = useState('');
  const [customOccasion, setCustomOccasion] = useState('');
  const [styling, setStyling] = useState(false);
  const [outfit, setOutfit] = useState<OutfitResult | null>(null);
  const [styleError, setStyleError] = useState<string | null>(null);

  const effectiveOccasion = (customOccasion.trim() || occasion).trim();
  const outfitReady = list.length >= MIN_ITEMS && hasOutfitBase(list);

  const nudgeText = useMemo(() => {
    if (list.length === 0) return null;
    if (list.length < MIN_ITEMS) {
      const n = MIN_ITEMS - list.length;
      return `Add ${n} more piece${n === 1 ? '' : 's'} so Aya has enough to style a real outfit.`;
    }
    if (!hasOutfitBase(list)) {
      return 'Aya needs at least a top and a bottom (or a dress) to build an outfit — add one to unlock styling.';
    }
    return null;
  }, [list]);

  const resetSheet = () => {
    setSheetOpen(false);
    setPhotoPreview(null);
    setPhotoUrl(null);
    setPhotoUploading(false);
    setAutoTagging(false);
    setAiTagNote(null);
    setDraftName('');
    setDraftType(null);
    setDraftColor('');
    setDraftCategory(null);
    setAddError(null);
  };

  const startAdd = () => {
    resetSheet();
    // Jump straight into the photo picker — the sheet opens with the photo in place.
    fileInputRef.current?.click();
  };

  const handlePhotoSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;

    setSheetOpen(true);
    setAddError(null);
    setPhotoUploading(true);
    setAutoTagging(true);
    // A fresh photo means fresh tags: blank fields = "not detected yet".
    setAiTagNote(null);
    setDraftName('');
    setDraftType(null);
    setDraftColor('');
    setDraftCategory(null);

    let base64 = '';
    try {
      const scaled = await downscalePhoto(file);
      base64 = scaled.base64;
      setPhotoPreview(scaled.dataUrl);
    } catch {
      setAddError("We couldn't read that photo — try a different one.");
      setPhotoUploading(false);
      setAutoTagging(false);
      return;
    }

    // Upload + AI auto-tagging run in parallel; tagging is best-effort.
    const uploadPromise = (async () => {
      const res = await fetch('/api/upload/image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageData: `data:image/jpeg;base64,${base64}`,
          fileName: `wardrobe-${Date.now()}.jpg`,
        }),
      });
      const data = await res.json();
      const url = data.imageUrl || data.url;
      if (!res.ok || !url) throw new Error(data.error || 'Upload failed');
      return url as string;
    })();

    const tagPromise = (async () => {
      const res = await fetch('/api/generate/vision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt:
            'You are tagging a photo of a single clothing item for a wardrobe app. Reply with ONLY a JSON object, no prose: ' +
            '{"name": short item name like "Navy linen blazer" or null, ' +
            '"item_type": "top"|"bottom"|"dress"|"shoes"|"outerwear"|"accessory"|null, ' +
            '"color": one lowercase dominant-color word like "navy" or null, ' +
            '"category": "casual"|"smart casual"|"formal"|"sport"|null (how formal the piece reads)}. ' +
            'Mapping guide: shirts/t-shirts/blouses/sweaters are "top"; trousers/jeans/skirts/shorts are "bottom"; ' +
            'jackets/coats/blazers are "outerwear"; bags/hats/scarves/belts are "accessory". ' +
            'IMPORTANT: if you are not confident about a field, set it to null instead of guessing.',
          image: base64,
          mimeType: 'image/jpeg',
        }),
      });
      const data = await res.json();
      if (!data.success || typeof data.result !== 'string') return null;
      return extractJson(data.result);
    })();

    try {
      const url = await uploadPromise;
      setPhotoUrl(url);
    } catch {
      setAddError("Photo upload didn't go through. Check your connection and try again.");
    } finally {
      setPhotoUploading(false);
    }

    try {
      const tags = await tagPromise;
      const t = tags ? normalizeType(tags.item_type) : null;
      const c = tags ? normalizeCategory(tags.category) : null;
      const col = tags ? normalizeColor(tags.color) : null;
      const name = tags && typeof tags.name === 'string' && tags.name.trim() ? tags.name.trim() : null;

      if (t) setDraftType(t);
      if (c) setDraftCategory(c);
      if (col) setDraftColor(col);
      if (name) setDraftName(name);

      // Low-confidence fields stay blank on purpose — better to ask than to mislead.
      const filled = [t, col, c].filter(Boolean).length;
      setAiTagNote(filled === 3 ? 'tagged' : filled > 0 ? 'partial' : 'failed');
    } catch {
      // Auto-tagging is optional — the user can tag manually.
      setAiTagNote('failed');
    } finally {
      setAutoTagging(false);
    }
  };

  const handleSave = async () => {
    if (!photoUrl || !draftType || saving) return;
    setSaving(true);
    setAddError(null);
    try {
      await dbTable().insert({
        name: draftName.trim() || [draftColor.trim(), draftType].filter(Boolean).join(' '),
        item_type: draftType,
        color: draftColor.trim().toLowerCase() || null,
        category: draftCategory,
        photo_url: photoUrl,
      });
      refresh();
      resetSheet();
    } catch {
      setAddError("Couldn't save this piece — please try again.");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    await dbTable().delete(id);
    refresh();
  };

  const generateOutfit = async (avoidIds: number[] = []) => {
    const occ = effectiveOccasion;
    if (!occ || !outfitReady || styling) return;
    setStyling(true);
    setStyleError(null);

    const catalog = list.map((i) => ({
      id: i.id,
      name: itemLabel(i),
      type: i.item_type,
      color: i.color,
      category: i.category,
    }));

    let picked: WardrobeItem[] | null = null;
    let title = '';
    let why = '';
    let tip = '';

    try {
      const res = await fetch('/proxy/openai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          temperature: 0.7,
          max_tokens: 400,
          messages: [
            {
              role: 'system',
              content:
                'You are Aya, the stylist behind Mura, an app for people with low styling confidence. ' +
                'Pick exactly ONE outfit for the given occasion using ONLY the wardrobe items provided (reference items by their numeric id). ' +
                'Hard rules: (1) never reference an id that is not in the list, (2) the outfit must contain either one "dress" OR one "top" plus one "bottom", ' +
                '(3) include one "shoes" item if any exist, (4) optionally add ONE outerwear and ONE accessory only if they genuinely fit, ' +
                '(5) never include two items of the same type. ' +
                'Keep the explanation warm, confidence-building, and under 40 words. ' +
                'Reply with ONLY a JSON object: {"item_ids": [numbers], "title": "short outfit name", "why": "why it works", "tip": "one optional styling tip"}',
            },
            {
              role: 'user',
              content:
                `Occasion: ${occ}\n` +
                (avoidIds.length ? `Avoid repeating exactly this combination if possible: [${avoidIds.join(', ')}]\n` : '') +
                `Wardrobe items:\n${JSON.stringify(catalog)}`,
            },
          ],
        }),
      });
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      const parsed = typeof content === 'string' ? extractJson(content) : null;
      if (parsed && Array.isArray(parsed.item_ids)) {
        const byId = new Map(list.map((i) => [i.id, i]));
        const chosen = parsed.item_ids
          .map((id: unknown) => byId.get(Number(id)))
          .filter(Boolean) as WardrobeItem[];
        if (chosen.length > 0 && hasOutfitBase(chosen)) {
          picked = chosen;
          title = typeof parsed.title === 'string' ? parsed.title : '';
          why = typeof parsed.why === 'string' ? parsed.why : '';
          tip = typeof parsed.tip === 'string' ? parsed.tip : '';
        }
      }
    } catch {
      // Fall through to the local fallback below.
    }

    if (!picked) {
      picked = fallbackOutfit(list, occ);
      if (picked) {
        title = 'A safe bet that works';
        why = 'Put together from your own pieces to match the occasion — simple, coordinated, and comfortable.';
      }
    }

    if (!picked) {
      setStyleError('Aya needs at least a top and a bottom (or a dress) in your closet to build this outfit.');
      setStyling(false);
      return;
    }

    setOutfit({ occasion: occ, title: title || 'Your outfit', why, tip, items: picked });
    setStyling(false);
  };

  // --- Render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="animate-spin rounded-full h-7 w-7 border-2 border-[var(--space-border-default)] border-t-[var(--space-brand-primary)]" />
        <p className={`text-sm ${typography.color.tertiary}`}>Opening your closet…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-24">
        <AlertCircle className={`w-8 h-8 mx-auto mb-3 ${tw.icon.danger}`} />
        <p className={`text-sm ${typography.color.danger}`}>Couldn't load your wardrobe</p>
        <button onClick={refresh} className={`mt-3 px-4 py-2 rounded-lg text-sm ${tw.button.secondary}`}>
          Try again
        </button>
      </div>
    );
  }

  // Outfit result view — one clear answer, ready to wear.
  if (outfit) {
    return (
      <div className="min-h-full w-full max-w-3xl mx-auto px-5 py-6">
        <button
          onClick={() => setOutfit(null)}
          className={`flex items-center gap-1.5 text-sm mb-4 ${tw.button.ghost} px-2 py-1.5 rounded-lg -ml-2`}
          data-testid="button-back-to-closet"
        >
          <ArrowLeft className="w-4 h-4" />
          Back to closet
        </button>

        <div className={`${tw.card.elevated} rounded-3xl p-6`}>
          <span className={`${tw.badge.default} ${tw.badge.primary}`}>{outfit.occasion}</span>
          <h2 className={`text-xl font-semibold mt-3 ${typography.color.primary}`}>{outfit.title}</h2>
          {outfit.why && <p className={`text-sm mt-1.5 ${typography.color.secondary}`}>{outfit.why}</p>}

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-5">
            {outfit.items.map((item) => (
              <figure key={item.id} className={`${tw.card.default} rounded-2xl overflow-hidden`} data-testid={`outfit-item-${item.id}`}>
                <div className="aspect-square bg-[var(--space-surface-muted)]">
                  {item.photo_url ? (
                    <img src={item.photo_url} alt={itemLabel(item)} className="w-full h-full object-cover" />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center">
                      <Shirt className={`w-8 h-8 ${tw.icon.muted}`} />
                    </div>
                  )}
                </div>
                <figcaption className="p-2.5">
                  <p className={`text-[10px] uppercase tracking-wider ${typography.color.tertiary}`}>{item.item_type}</p>
                  <p className={`text-sm font-medium truncate ${typography.color.primary}`}>{itemLabel(item)}</p>
                </figcaption>
              </figure>
            ))}
          </div>

          {outfit.tip && (
            <div className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--space-surface-accent-soft)] p-3">
              <Sparkles className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tw.icon.primary}`} />
              <p className={`text-xs ${typography.color.secondary}`}>{outfit.tip}</p>
            </div>
          )}

          <div className="flex gap-2 mt-6">
            <button
              onClick={() => generateOutfit(outfit.items.map((i) => i.id))}
              disabled={styling}
              className={`flex-1 py-3 rounded-xl text-sm flex items-center justify-center gap-2 ${tw.button.secondary} disabled:opacity-50`}
              data-testid="button-try-another"
            >
              {styling ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
              Try another
            </button>
            <button
              onClick={() => setOutfit(null)}
              className={`flex-1 py-3 rounded-xl text-sm font-medium ${tw.button.primary}`}
              data-testid="button-wear-it"
            >
              I'm wearing it
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-full w-full max-w-3xl mx-auto px-5 pb-8">
      {/* Hidden photo input — the whole add flow starts from one tap */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handlePhotoSelected}
        data-testid="input-item-photo"
      />

      {list.length === 0 ? (
        /* Empty closet — welcoming first-add moment, not an error state */
        <div className="flex flex-col items-center justify-center text-center pt-16 pb-10 gap-4">
          <div className={`w-16 h-16 rounded-3xl flex items-center justify-center ${tw.bg.accent}`}>
            <Shirt className={`w-8 h-8 ${tw.icon.primary}`} />
          </div>
          <div>
            <h2 className={`text-xl font-semibold ${typography.color.primary}`}>Welcome to your Mura closet</h2>
            <p className={`text-sm mt-2 max-w-sm mx-auto ${typography.color.secondary}`}>
              Snap a photo of a few pieces you own — Aya tags them for you. Once you have {MIN_ITEMS}, she'll
              build outfits for any occasion from clothes you already love.
            </p>
          </div>
          <button
            onClick={startAdd}
            className={`flex items-center gap-2 px-6 py-3.5 rounded-2xl text-sm font-medium ${tw.button.primary}`}
            data-testid="button-add-first-item"
          >
            <Camera className="w-4 h-4" />
            Add your first piece
          </button>
          <p className={`text-xs ${typography.color.tertiary}`}>Photo + auto-tags. Takes about 10 seconds.</p>
        </div>
      ) : (
        <>
          {/* Occasion prompt — the core "what do I wear?" job */}
          <section className={`${tw.card.elevated} rounded-3xl p-5 mt-5`}>
            <div className="flex items-center gap-2">
              <Sparkles className={`w-4 h-4 ${tw.icon.primary}`} />
              <h2 className={`text-base font-semibold ${typography.color.primary}`}>What's the occasion?</h2>
            </div>
            <p className={`text-xs mt-1 ${typography.color.tertiary}`}>
              Pick one and Aya will style a single outfit from your own closet.
            </p>

            <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-4">
              {OCCASIONS.map(({ id, label, icon: Icon }) => {
                const selected = occasion === id && !customOccasion.trim();
                return (
                  <button
                    key={id}
                    onClick={() => {
                      setOccasion(id);
                      setCustomOccasion('');
                    }}
                    className={`flex items-center gap-2 py-2.5 px-3 rounded-xl border text-sm font-medium transition-all ${
                      selected
                        ? 'border-[var(--space-brand-primary)] bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)] shadow-sm'
                        : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-secondary)] hover:border-[var(--space-brand-primary-200)]'
                    }`}
                    data-testid={`button-occasion-${id.replace(/\s+/g, '-')}`}
                  >
                    <Icon className="w-4 h-4 flex-shrink-0" />
                    <span className="truncate">{label}</span>
                  </button>
                );
              })}
            </div>

            <input
              type="text"
              value={customOccasion}
              onChange={(e) => setCustomOccasion(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && generateOutfit()}
              placeholder="Or type your own… e.g. rooftop birthday dinner"
              className={`${tw.input.base} ${tw.input.default} text-sm mt-3`}
              data-testid="input-custom-occasion"
            />

            {nudgeText ? (
              <div className="mt-3 flex items-start gap-2 rounded-xl bg-[var(--space-surface-accent-soft)] p-3">
                <AlertCircle className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tw.icon.primary}`} />
                <div className="flex-1">
                  <p className={`text-xs ${typography.color.secondary}`}>{nudgeText}</p>
                  <button
                    onClick={startAdd}
                    className={`mt-2 px-3 py-1.5 rounded-lg text-xs font-medium ${tw.button.primary}`}
                    data-testid="button-nudge-add"
                  >
                    Add a piece
                  </button>
                </div>
              </div>
            ) : (
              <button
                onClick={() => generateOutfit()}
                disabled={!effectiveOccasion || styling}
                className={`w-full mt-3 py-3 rounded-xl text-sm font-medium flex items-center justify-center gap-2 ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
                data-testid="button-style-me"
              >
                {styling ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin" />
                    Aya is styling you…
                  </>
                ) : (
                  <>
                    <Sparkles className="w-4 h-4" />
                    Dress me for this
                  </>
                )}
              </button>
            )}
            {styleError && <p className={`text-xs mt-2 ${typography.color.danger}`}>{styleError}</p>}
          </section>

          {/* Wardrobe grid */}
          <section className="mt-6">
            <div className="flex items-center justify-between mb-3">
              <h3 className={`text-sm font-semibold ${typography.color.primary}`}>
                Your wardrobe <span className={typography.color.tertiary}>({list.length})</span>
              </h3>
              <button
                onClick={startAdd}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium ${tw.button.primary}`}
                data-testid="button-add-item"
              >
                <Plus className="w-3.5 h-3.5" />
                Add piece
              </button>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3">
              {list.map((item) => (
                <figure
                  key={item.id}
                  className={`group relative ${tw.card.default} rounded-2xl overflow-hidden`}
                  data-testid={`tile-item-${item.id}`}
                >
                  <div className="aspect-square bg-[var(--space-surface-muted)]">
                    {item.photo_url ? (
                      <img src={item.photo_url} alt={itemLabel(item)} className="w-full h-full object-cover" loading="lazy" />
                    ) : (
                      <div className="w-full h-full flex items-center justify-center">
                        <Shirt className={`w-7 h-7 ${tw.icon.muted}`} />
                      </div>
                    )}
                  </div>
                  <figcaption className="p-2.5">
                    <p className={`text-sm font-medium truncate ${typography.color.primary}`}>{itemLabel(item)}</p>
                    <p className={`text-[11px] truncate ${typography.color.tertiary}`}>
                      {[item.item_type, item.category].filter(Boolean).join(' · ')}
                    </p>
                  </figcaption>
                  <button
                    onClick={() => handleDelete(item.id)}
                    className="absolute top-2 right-2 p-1.5 rounded-lg bg-[var(--space-surface-card)]/90 shadow-sm opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity text-[var(--space-text-muted)] hover:text-[var(--space-semantic-danger)]"
                    aria-label="Remove item"
                    data-testid={`button-delete-${item.id}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </figure>
              ))}

              {/* Add tile */}
              <button
                onClick={startAdd}
                className="aspect-square rounded-2xl border-2 border-dashed border-[var(--space-border-strong)] flex flex-col items-center justify-center gap-1.5 text-[var(--space-text-muted)] hover:border-[var(--space-brand-primary)] hover:text-[var(--space-text-brand)] transition-colors"
                data-testid="button-add-tile"
              >
                <Camera className="w-6 h-6" />
                <span className="text-xs font-medium">Add piece</span>
              </button>
            </div>
          </section>
        </>
      )}

      {/* Add-item sheet */}
      {sheetOpen && (
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
          <div
            className="absolute inset-0"
            style={{ backgroundColor: 'color-mix(in srgb, var(--space-text-primary) 40%, transparent)' }}
            onClick={resetSheet}
          />
          <div className={`relative w-full sm:max-w-md ${tw.card.elevated} rounded-t-3xl sm:rounded-3xl p-5 max-h-[90vh] overflow-y-auto`}>
            <div className="flex items-center justify-between mb-4">
              <h3 className={`text-base font-semibold ${typography.color.primary}`}>New piece</h3>
              <button onClick={resetSheet} className={`p-1.5 rounded-lg ${tw.button.ghost}`} aria-label="Close" data-testid="button-close-sheet">
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="flex gap-4">
              <div className="w-28 h-28 rounded-2xl overflow-hidden bg-[var(--space-surface-muted)] flex-shrink-0 relative">
                {photoPreview ? (
                  <img src={photoPreview} alt="New item" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <Camera className={`w-6 h-6 ${tw.icon.muted}`} />
                  </div>
                )}
                {photoUploading && (
                  <div className="absolute inset-0 flex items-center justify-center bg-[var(--space-surface-card)]/60">
                    <Loader2 className="w-5 h-5 animate-spin text-[var(--space-text-brand)]" />
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <label className={`block text-[10px] font-medium uppercase tracking-wider mb-1 ${typography.color.tertiary}`}>
                  Name
                </label>
                <input
                  type="text"
                  value={draftName}
                  onChange={(e) => setDraftName(e.target.value)}
                  placeholder="e.g. Navy linen blazer"
                  className={`${tw.input.base} ${tw.input.default} text-sm !px-3 !py-2`}
                  data-testid="input-item-name"
                />
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={`mt-2 text-xs ${typography.color.brand} underline underline-offset-2`}
                  data-testid="button-retake-photo"
                >
                  Use a different photo
                </button>
              </div>
            </div>

            {(autoTagging || aiTagNote) && (
              <div className="mt-4 flex items-start gap-2 rounded-xl bg-[var(--space-surface-accent-soft)] p-3" data-testid="ai-tag-status">
                {autoTagging ? (
                  <Loader2 className={`w-4 h-4 mt-0.5 flex-shrink-0 animate-spin ${tw.icon.primary}`} />
                ) : (
                  <Sparkles className={`w-4 h-4 mt-0.5 flex-shrink-0 ${tw.icon.primary}`} />
                )}
                <p className={`text-xs ${typography.color.secondary}`}>
                  {autoTagging
                    ? 'Aya is reading your photo…'
                    : aiTagNote === 'tagged'
                      ? 'Aya tagged this piece from the photo — confirm below, or tweak anything she got wrong.'
                      : aiTagNote === 'partial'
                        ? 'Aya filled in what she could tell for sure — the blank tags are yours to pick.'
                        : "Aya couldn't read this one — pick the tags below."}
                </p>
              </div>
            )}

            <div className="mt-4">
              <p className={`text-[10px] font-medium uppercase tracking-wider mb-1.5 ${typography.color.tertiary}`}>Type</p>
              <div className="flex flex-wrap gap-1.5">
                {ITEM_TYPES.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setDraftType(id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      draftType === id
                        ? 'border-[var(--space-brand-primary)] bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)]'
                        : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-secondary)]'
                    }`}
                    data-testid={`chip-type-${id}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4">
              <p className={`text-[10px] font-medium uppercase tracking-wider mb-1.5 ${typography.color.tertiary}`}>Color</p>
              <div className="flex flex-wrap gap-1.5">
                {COLORS.map((c) => (
                  <button
                    key={c}
                    onClick={() => setDraftColor(c)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border capitalize transition-all ${
                      draftColor === c
                        ? 'border-[var(--space-brand-primary)] bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)]'
                        : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-secondary)]'
                    }`}
                    data-testid={`chip-color-${c}`}
                  >
                    {c}
                  </button>
                ))}
              </div>
              <input
                type="text"
                value={draftColor}
                onChange={(e) => setDraftColor(e.target.value)}
                placeholder="Or type a color"
                className={`${tw.input.base} ${tw.input.default} text-xs mt-2 !px-3 !py-2`}
                data-testid="input-item-color"
              />
            </div>

            <div className="mt-4">
              <p className={`text-[10px] font-medium uppercase tracking-wider mb-1.5 ${typography.color.tertiary}`}>Style</p>
              <div className="flex flex-wrap gap-1.5">
                {CATEGORIES.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setDraftCategory(id)}
                    className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-all ${
                      draftCategory === id
                        ? 'border-[var(--space-brand-primary)] bg-[var(--space-surface-accent-soft)] text-[var(--space-text-brand)]'
                        : 'border-[var(--space-border-default)] bg-[var(--space-surface-card)] text-[var(--space-text-secondary)]'
                    }`}
                    data-testid={`chip-category-${id.replace(/\s+/g, '-')}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {addError && <p className={`text-xs mt-3 ${typography.color.danger}`}>{addError}</p>}

            <button
              onClick={handleSave}
              disabled={!photoUrl || !draftType || photoUploading || saving}
              className={`w-full mt-5 py-3 rounded-xl text-sm font-medium flex items-center justify-center gap-2 ${tw.button.primary} disabled:opacity-40 disabled:cursor-not-allowed`}
              data-testid="button-save-item"
            >
              {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Shirt className="w-4 h-4" />}
              {photoUploading ? 'Uploading photo…' : saving ? 'Saving…' : 'Save to closet'}
            </button>
            {!draftType && !autoTagging && photoUrl && (
              <p className={`text-[11px] text-center mt-2 ${typography.color.tertiary}`}>Pick a type above to save this piece.</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
