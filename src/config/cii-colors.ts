export type CiiLevel = 'low' | 'normal' | 'elevated' | 'high' | 'critical';

// Money Bansho index bands: neutral below 60, accent from 60, red from 90.
export const CII_LEVEL_COLORS: Record<CiiLevel, [number, number, number, number]> = {
  low:      [107, 140, 174, 60],
  normal:   [107, 140, 174, 70],
  elevated: [61, 139, 253, 135],
  high:     [192, 82, 74, 150],
  critical: [192, 82, 74, 170],
};
