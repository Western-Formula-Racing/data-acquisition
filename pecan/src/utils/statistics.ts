/**
 * Calculates the Pearson Correlation Coefficient (r) between two numeric series.
 * Range: -1 (inverse) to 1 (linear). 0 means no correlation.
 */
export function calculateCorrelation(s1: number[], s2: number[]): number {
  if (s1.length < 2 || s2.length < 2) return 0;
  
  // Align lengths (use the shortest length)
  const len = Math.min(s1.length, s2.length);
  const x = s1.slice(0, len);
  const y = s2.slice(0, len);
  
  const sumX = x.reduce((a, b) => a + b, 0);
  const sumY = y.reduce((a, b) => a + b, 0);
  const sumXY = x.reduce((a, b, i) => a + b * y[i], 0);
  const sumX2 = x.reduce((a, b) => a + b * b, 0);
  const sumY2 = y.reduce((a, b) => a + b * b, 0);
  
  const numerator = (len * sumXY) - (sumX * sumY);
  const denominator = Math.sqrt((len * sumX2 - sumX * sumX) * (len * sumY2 - sumY * sumY));
  
  if (denominator === 0) return 0;
  return numerator / denominator;
}

/**
 * Returns a color and label based on correlation strength
 */
export function getCorrelationMeta(r: number) {
  const absR = Math.abs(r);
  if (absR < 0.3) return { label: 'Neutral', color: '#94a3b8', intensity: 0.1 };
  if (absR < 0.7) return { 
    label: r > 0 ? 'Weak Positive' : 'Weak Negative', 
    color: r > 0 ? '#fbbf24' : '#60a5fa', // Yellow for positive, Blue for negative
    intensity: 0.4 
  };
  return { 
    label: r > 0 ? 'Strong Positive' : 'Strong Negative', 
    color: r > 0 ? '#f59e0b' : '#3b82f6', // Bright Yellow/Orange for strong pos, Deep Blue for strong neg
    intensity: 0.9 
  };
}

/**
 * Scans a set of sensor histories and identifies pairs with high correlation.
 */
export function findStrongCorrelations(
  histories: Record<string, number[]>, 
  threshold = 0.85
): { source: string, target: string, r: number }[] {
  const ids = Object.keys(histories).filter(id => histories[id].length >= 10);
  const links: { source: string, target: string, r: number }[] = [];
  
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const r = calculateCorrelation(histories[ids[i]], histories[ids[j]]);
      if (Math.abs(r) >= threshold) {
        links.push({ source: ids[i], target: ids[j], r });
      }
    }
  }
  
  return links;
}
