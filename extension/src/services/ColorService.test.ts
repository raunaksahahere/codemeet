import { describe, it, expect } from 'vitest';
import { colorFromId, PALETTE } from './ColorService';

describe('ColorService', () => {
  it('should return a color from the palette', () => {
    const color = colorFromId('socket-abc-123');
    expect(PALETTE).toContain(color);
  });

  it('should be deterministic for the same ID', () => {
    const id = 'test-socket-id';
    expect(colorFromId(id)).toBe(colorFromId(id));
  });

  it('should produce different colors for different IDs', () => {
    const colors = new Set<string>();
    for (let i = 0; i < 20; i++) {
      colors.add(colorFromId(`socket-${i}`));
    }
    // With 20 different IDs and 10 colors, we should get multiple distinct colors
    expect(colors.size).toBeGreaterThan(1);
  });
});
