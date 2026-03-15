import { describe, it, expect } from 'vitest';

describe('shared types', () => {
  it('should export patch types correctly', async () => {
    const types = await import('../index.js');
    expect(types).toBeDefined();
  });
});
