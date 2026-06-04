import { useMemo } from 'react';
import { getLoadedDbcMessages, formatCanId } from '../utils/canProcessor';
import { CATEGORIES, determineCategory, DEFAULT_CATEGORY } from '../config/categories';

export interface SensorStar {
  id: string;       // "${msgID}:${signalName}"
  name: string;     // display label
  category: string; // category name string
  color: string;    // hex color
  r: number;        // orbital radius in pixels
  theta: number;    // initial angle in degrees
  speed: number;    // radians/frame
  inclination: number; // orbital tilt in radians
  nodeLong: number;    // tilt orientation in radians
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

function categoryHex(categoryName: string): string {
  const cat = CATEGORIES.find(c => c.name === categoryName);
  if (!cat) return DEFAULT_HEX;
  return TAILWIND_HEX_MAP[cat.color] ?? DEFAULT_HEX;
}

export function useConstellationSignals(refreshKey?: string | number): SensorStar[] {
  const messages = useMemo(() => {
    // refreshKey is referenced solely to invalidate the memo when the active
    // DBC changes (e.g. after a .pecan replay import embeds a new DBC).
    void refreshKey;
    return getLoadedDbcMessages();
  }, [refreshKey]);

  const sensors = useMemo(() => {
    // 1. Identify all unique categories and count their signal density
    const catData: Record<string, { count: number, hash: number }> = {};
    messages.forEach(msg => {
      const cat = determineCategory(formatCanId(msg.canId));
      if (!catData[cat]) catData[cat] = { count: 0, hash: 0 };
      catData[cat].count += msg.signals.length;
      catData[cat].hash += msg.canId; // Stable tie-breaker
    });
    
    // Sort categories: 
    // - POWERTRAIN is usually the central reference (ground plane)
    // - Others sort by Signal Volume (Dense = Outer)
    const sortedCategories = Object.keys(catData).sort((a, b) => {
      if (a === 'POWERTRAIN') return -1;
      if (b === 'POWERTRAIN') return 1;
      const countDiff = catData[a].count - catData[b].count;
      if (countDiff !== 0) return countDiff;
      return catData[a].hash - catData[b].hash; // Non-alphabetic tie-breaker
    });

    // Strategy: Ensure 'NO CAT' is never the outermost ring
    const noCatIndex = sortedCategories.indexOf(DEFAULT_CATEGORY.name);
    if (noCatIndex === sortedCategories.length - 1 && sortedCategories.length > 1) {
      // Swap with the second-to-last category
      const temp = sortedCategories[noCatIndex];
      sortedCategories[noCatIndex] = sortedCategories[noCatIndex - 1];
      sortedCategories[noCatIndex - 1] = temp;
    }

    // 2. Map categories to dynamic spatial parameters (Inclination & Repulsion)
    const catCount = sortedCategories.length;
    const catLayoutMap: Record<string, { r: number, inc: number, node: number }> = {};
    
    sortedCategories.forEach((cat, i) => {
      let radius = 100 + (i * 65); // Clearer spacing
      
      // If the user wants No-Cat to be distinct, ensure it's at least one ring offset
      // from the Battery or other dense categories if it's large.
      // (The sorting + i increment already handles this, but we increase the gap).
      let inc = 0;
      let node = 0;
      
      if (i > 0) {
        // Distribute tilts mathematically around the Z-axis (Repulsion)
        // Variation of inclination between 15 and 45 degrees
        inc = (Math.PI / 12) + (i * (Math.PI / 30)); 
        // Rotate the tilt axis around the entire 360 degrees
        node = (i * (2 * Math.PI)) / (catCount - 1); 
      }
      
      catLayoutMap[cat] = { r: radius, inc, node };
    });

    // 3. Map messages/signals to the calculated layout
    const all: SensorStar[] = [];
    messages.forEach((msg) => {
      const msgID = formatCanId(msg.canId);
      for (const sig of msg.signals) {
        const catName = determineCategory(msgID);
        const layout = catLayoutMap[catName] || { r: 350, inc: 0.2, node: 0 };
        
        const hash = (msg.canId * 13 + (sig.startBit || 0) * 7);
        const theta = hash % 360;
        const speed = 0.0003 + (1 / layout.r) * 0.04 + (hash % 10) * 0.00005;
        
        all.push({
          id: `${msgID}:${sig.signalName}`,
          name: sig.signalName,
          category: catName,
          color: categoryHex(catName),
          r: layout.r,
          theta: theta,
          speed: speed,
          inclination: layout.inc,
          nodeLong: layout.node,
          msgID: msgID,
          sigName: sig.signalName
        });
      }
    });
    return all;
  }, [messages]);

  return sensors;
}
