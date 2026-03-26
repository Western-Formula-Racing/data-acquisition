import { describe, expect, it } from 'vitest';
import { hexToBytes } from './hexToBytes';

describe('hexToBytes', () => {
  it('converts WEBSOCKET_PROTOCOL example', () => {
    expect(hexToBytes('0A1B2C3D00000000')).toEqual([10, 27, 44, 61, 0, 0, 0, 0]);
  });

  it('handles uppercase and ignores spaces', () => {
    expect(hexToBytes('DE AD')).toEqual([222, 173]);
  });

  it('returns empty for empty string', () => {
    expect(hexToBytes('')).toEqual([]);
  });

  it('parses single byte', () => {
    expect(hexToBytes('FF')).toEqual([255]);
  });
});
