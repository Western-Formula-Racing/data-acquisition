// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import { isKvaserSource } from './useChargingDashboard';

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

describe('isKvaserSource — broadcast gate', () => {
  it('is true when connected to the Kvaser bridge (:9081)', () => {
    sessionStorage.setItem('pecan-ws-last-ok', 'wss://localhost:9081');
    expect(isKvaserSource()).toBe(true);
  });

  it('honours a configured custom bridge URL when nothing is connected yet', () => {
    localStorage.setItem('custom-ws-url', 'ws://127.0.0.1:9081');
    expect(isKvaserSource()).toBe(true);
  });

  it('NEVER broadcasts the public demo relay (fake/generated data)', () => {
    sessionStorage.setItem('pecan-ws-last-ok', 'wss://ws-demo.westernformularacing.org');
    expect(isKvaserSource()).toBe(false);
  });

  it('excludes the demo relay even if it is the configured custom URL', () => {
    localStorage.setItem('custom-ws-url', 'wss://ws-demo.westernformularacing.org');
    sessionStorage.setItem('pecan-ws-last-ok', 'wss://ws-demo.westernformularacing.org');
    expect(isKvaserSource()).toBe(false);
  });

  it('does not broadcast the base-station bridge (:9080) or production', () => {
    sessionStorage.setItem('pecan-ws-last-ok', 'ws://10.0.0.5:9080');
    expect(isKvaserSource()).toBe(false);
  });

  it('is false with no source configured', () => {
    expect(isKvaserSource()).toBe(false);
  });
});
