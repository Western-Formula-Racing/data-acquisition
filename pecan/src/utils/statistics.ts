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
    color: r > 0 ? '#10b981' : '#f43f5e', 
    intensity: 0.4 
  };
  return { 
    label: r > 0 ? 'Strong Positive' : 'Strong Negative', 
    color: r > 0 ? '#34d399' : '#ff4b4b', 
    intensity: 0.9 
  };
}
