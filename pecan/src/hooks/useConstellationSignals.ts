import { useState, useEffect, useMemo } from 'react';
import { getLoadedDbcMessages, type MessageInfo, formatCanId } from '../utils/canProcessor';
import { dataStore } from '../lib/DataStore';
import { CATEGORIES, determineCategory } from '../config/categories';

export interface SensorStar {
  id: string;       // "${msgID}:${signalName}"
  name: string;     // display label
  category: string; // category name string
  color: string;    // hex color
  r: number;        // orbital radius in pixels
  theta: number;    // initial angle in degrees
  speed: number;    // radians/frame
  isLive: boolean;  // false = dim grey
}

const TAILWIND_HEX_MAP: Record<string, string> = {
  'bg-sky-400':    '#38bdf8',
  'bg-orange-400': '#fb923c',
  'bg-green-400':  '#4ade80',
  'bg-purple-500': '#a855f7',
  'bg-blue-600':   '#2563eb',
  'bg-red-500':    '#ef4444',
  'bg-blue-500':   '#3b82f6',
};
const DEFAULT_HEX = '#6b7280';

const MAX_PER_CATEGORY = 8;   // max stars per category to avoid crowding
const RINGS_PER_CATEGORY = 3;  // spread within category across 3 radial bands

// djb2 hash — stable per string, for speed variation only
function djb2(str: string): number {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) + str.charCodeAt(i);
    hash = hash & hash;
  }
  return Math.abs(hash);
}

// Sort key: group by category, then alphabetical within category for stable round-robin
function signalSortKey(msgID: string, sigName: string): string {
  const cat = determineCategory(msgID);
  return `${cat}\x00${sigName}\x00${msgID}`;
}

const BASE_RADIUS_PER_CATEGORY: Record<string, number> = {
  'VCU': 70,
  'BMS': 100,
  'INV': 130,
  'SENSORS': 160,
  'COOLING': 190,
  'ACCU': 220,
};
const DEFAULT_BASE_RADIUS = 250;

function categoryHex(categoryName: string): string {
  const cat = CATEGORIES.find(c => c.name === categoryName);
  if (!cat) return DEFAULT_HEX;
  return TAILWIND_HEX_MAP[cat.color] ?? DEFAULT_HEX;
}

function computeSensors(messages: MessageInfo[], liveKeys: Set<string>): SensorStar[] {
  const sectorSize = 360 / (CATEGORIES.length || 1);

  // Collect all signals with their category
  const all: { id: string; name: string; catName: string; catIndex: number }[] = [];
  for (const msg of messages) {
    const msgID = formatCanId(msg.canId);
    for (const sig of msg.signals) {
      all.push({
        id: `${msgID}:${sig.signalName}`,
        name: sig.signalName,
        catName: determineCategory(msgID),
        catIndex: CATEGORIES.findIndex(c => c.name === determineCategory(msgID)),
      });
    }
  }

  // Sort for stable round-robin assignment
  all.sort((a, b) => a.id.localeCompare(b.id));

  // Group by category
  const byCategory = new Map<string, typeof all>();
  for (const s of all) {
    if (!byCategory.has(s.catName)) byCategory.set(s.catName, []);
    byCategory.get(s.catName)!.push(s);
  }

  // Cap per category
  const sensors: SensorStar[] = [];
  for (const [catName, catSigs] of byCategory) {
    const capped = catSigs.slice(0, MAX_PER_CATEGORY);
    const catIndex = CATEGORIES.findIndex(c => c.name === catName);
    const sectorStart = catIndex * sectorSize;
    const baseRadius = BASE_RADIUS_PER_CATEGORY[catName] ?? DEFAULT_BASE_RADIUS;

    capped.forEach((sig, idx) => {
      // Evenly divide sector arc among signals in this category (10% margin at edges)
      const fraction = (idx + 0.5) / capped.length;        // 0.5 … ~1
      const theta = sectorStart + 5 + fraction * (sectorSize - 10);

      // Cycle through 3 radial rings within the category band
      const ring = idx % RINGS_PER_CATEGORY;
      const r = baseRadius + ring * 35 + 15;

      // Small speed variation using hash (purely visual — phase-based orbit)
      const hash = djb2(sig.id);
      const speed = 0.0006 + (hash % 5) * 0.0001;

      sensors.push({
        id: sig.id,
        name: sig.name,
        category: sig.catName,
        color: categoryHex(sig.catName),
        r,
        theta,
        speed,
        isLive: liveKeys.has(sig.id),
      });
    });
  }

  return sensors;
}

export function useConstellationSignals(): SensorStar[] {
  const [liveKeys, setLiveKeys] = useState<Set<string>>(new Set());

  useEffect(() => {
    const keys = new Set<string>();
    const allLatest = dataStore.getAllLatest();
    allLatest.forEach((sample) => {
      for (const sigName in sample.data) {
        keys.add(`${sample.msgID}:${sigName}`);
      }
    });
    setLiveKeys(keys);

    const unsub = dataStore.subscribe(() => {
      const newKeys = new Set<string>();
      const updated = dataStore.getAllLatest();
      updated.forEach((sample) => {
        for (const sigName in sample.data) {
          newKeys.add(`${sample.msgID}:${sigName}`);
        }
      });
      setLiveKeys(newKeys);
    });
    return unsub;
  }, []);

  const sensors = useMemo(() => {
    const messages = getLoadedDbcMessages();
    return computeSensors(messages, liveKeys);
  }, [liveKeys]);

  return sensors;
}
