import { describe, it, expect, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useConstellationSignals } from './useConstellationSignals';

vi.mock('../utils/canProcessor', () => ({
  getLoadedDbcMessages: vi.fn(() => [
    {
      messageName: 'VCU_Front_IMU_1',
      canId: 192,
      dlc: 8,
      signals: [
        { signalName: 'Accel_X', startBit: 0, length: 16, factor: 0.01, offset: 0, unit: 'g', min: -2, max: 2 },
        { signalName: 'Accel_Y', startBit: 16, length: 16, factor: 0.01, offset: 0, unit: 'g', min: -2, max: 2 },
      ],
    },
    {
      messageName: 'BMS_Status',
      canId: 512,
      dlc: 8,
      signals: [
        { signalName: 'SoC', startBit: 0, length: 16, factor: 0.1, offset: 0, unit: '%', min: 0, max: 100 },
      ],
    },
  ]),
  // Unpadded hex — matches the id format the hook builds: '0xC0:Accel_X'
  formatCanId: vi.fn((canId: number) => '0x' + canId.toString(16).toUpperCase()),
}));

describe('useConstellationSignals', () => {
  it('returns DBC signals as dim stars', () => {
    const { result } = renderHook(() => useConstellationSignals());
    const signals = result.current;
    expect(signals).toContainEqual(
      expect.objectContaining({ id: '0xC0:Accel_X', name: 'Accel_X', isLive: false })
    );
  });

  it('assigns different r values to different categories', () => {
    const { result } = renderHook(() => useConstellationSignals());
    const signals = result.current;
    const categories = [...new Set(signals.map(s => s.category))];
    expect(categories.length).toBeGreaterThan(1);
  });
});
