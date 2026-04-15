import { useMemo } from 'react';
import { getLoadedDbcMessages, formatCanId } from '../utils/canProcessor';
import { CATEGORIES, determineCategory } from '../config/categories';

export interface SensorStar {
  id: string;       // "${msgID}:${signalName}"
  name: string;     // display label
  category: string; // category name string
  color: string;    // hex color
  r: number;        // orbital radius in pixels
  theta: number;    // initial angle in degrees
  speed: number;    // radians/frame
  z: number;        // Z-height for 3D layering
  msgID: string;    // for fast lookup in render loop
  sigName: string;  // for fast lookup in render loop
}

const TAILWIND_HEX_MAP: Record<string, string> = {
  'bg-sky-400':    '#38bdf8',
  'bg-orange-400': '#fb923c',
  'bg-green-400':  '#4ade80',
  'bg-purple-500': '#a855f7',
  'bg-blue-600':   '#2563eb',
  'bg-red-500':    '#ef4444',
  'bg-blue-500':   '#3b82f6',
  'bg-cyan-500':   '#06b6d4',
  'bg-emerald-500':'#10b981',
  'bg-orange-500': '#f97316',
};
const DEFAULT_HEX = '#6b7280';

const BASE_RADIUS_PER_CATEGORY: Record<string, number> = {
  'POWERTRAIN': 80,
  'DRIVER': 120,
  'CHASSIS': 160,
  'BATTERY': 200,
  'SUSPENSION': 240,
};

const CATEGORY_Z_MAP: Record<string, number> = {
  'POWERTRAIN': 40,
  'DRIVER': 20,
  'CHASSIS': 0,
  'BATTERY': -20,
  'SUSPENSION': -40,
};

function categoryHex(categoryName: string): string {
  const cat = CATEGORIES.find(c => c.name === categoryName);
  if (!cat) return DEFAULT_HEX;
  return TAILWIND_HEX_MAP[cat.color] ?? DEFAULT_HEX;
}

export function useConstellationSignals(): SensorStar[] {
  // 1. Memoize DBC parsing - only re-runs if DBC changes
  const messages = useMemo(() => {
    return getLoadedDbcMessages();
  }, []);

  // 2. Memoize sensor layout - only re-runs if messages change
  const sensors = useMemo(() => {
    const all: SensorStar[] = [];
    messages.forEach((msg) => {
      const msgID = formatCanId(msg.canId);
      for (const sig of msg.signals) {
        const catName = determineCategory(msgID);
        // Fallback radius if category is not mapped (MISC outer rim)
        const baseR = BASE_RADIUS_PER_CATEGORY[catName] || 320; 
        const baseZ = CATEGORY_Z_MAP[catName] || -60;
        
        // Distribution within category orbits
        const hash = (msg.canId * 13 + (sig.startBit || 0) * 7);
        const theta = hash % 360;
        
        // Speed variation based on orbit (inner orbits slightly faster)
        const speed = 0.0003 + (1 / baseR) * 0.04 + (hash % 10) * 0.00005;
        
        all.push({
          id: `${msgID}:${sig.signalName}`,
          name: sig.signalName,
          category: catName,
          color: categoryHex(catName),
          r: baseR,
          theta: theta,
          speed: speed,
          z: baseZ + (hash % 15), // Subtle jitter for depth
          msgID: msgID,
          sigName: sig.signalName
        });
      }
    });
    return all;
  }, [messages]);

  return sensors;
}
