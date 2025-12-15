/**
 * Comprehensive tests for utils/roles.ts
 * Target: 100% code coverage
 */

import { buildRoleMap } from '../../src/utils/roles';

describe('roles.ts', () => {
  describe('buildRoleMap', () => {
    it('should build role map from insights', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: 0.9 },
        { key: 'img2.jpg', role: 'back', roleScore: 0.8 },
      ];

      const map = buildRoleMap(insights);

      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: 0.9 });
      expect(map.get('img2.jpg')).toEqual({ role: 'back', score: 0.8 });
    });

    it('should use _key if key not present', () => {
      const insights = [
        { _key: 'img1.jpg', role: 'front', roleScore: 0.9 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: 0.9 });
    });

    it('should use urlKey if key and _key not present', () => {
      const insights = [
        { urlKey: 'img1.jpg', role: 'front', roleScore: 0.9 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: 0.9 });
    });

    it('should use url as fallback', () => {
      const insights = [
        { url: 'https://example.com/img1.jpg', role: 'front', roleScore: 0.9 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('https://example.com/img1.jpg')).toEqual({ role: 'front', score: 0.9 });
    });

    it('should skip insights without any key field', () => {
      const insights = [
        { role: 'front', roleScore: 0.9 },
        { key: 'img1.jpg', role: 'back', roleScore: 0.8 },
      ];

      const map = buildRoleMap(insights);
      expect(map.size).toBe(1);
      expect(map.get('img1.jpg')).toBeDefined();
    });

    it('should default roleScore to 0 when not a number', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: 'invalid' },
        { key: 'img2.jpg', role: 'back' },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: 0 });
      expect(map.get('img2.jpg')).toEqual({ role: 'back', score: 0 });
    });

    it('should default role to "unknown" when not present', () => {
      const insights = [
        { key: 'img1.jpg', roleScore: 0.9 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'unknown', score: 0.9 });
    });

    it('should keep entry with larger absolute roleScore for duplicates', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: 0.5 },
        { key: 'img1.jpg', role: 'back', roleScore: 0.9 },
        { key: 'img1.jpg', role: 'other', roleScore: 0.3 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'back', score: 0.9 });
    });

    it('should handle negative scores correctly', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: -0.5 },
        { key: 'img1.jpg', role: 'back', roleScore: 0.3 },
      ];

      const map = buildRoleMap(insights);
      // |-0.5| = 0.5 > |0.3| = 0.3, so first entry wins
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: -0.5 });
    });

    it('should handle very negative scores', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: -0.9 },
        { key: 'img1.jpg', role: 'back', roleScore: 0.5 },
      ];

      const map = buildRoleMap(insights);
      // |-0.9| = 0.9 > |0.5| = 0.5
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: -0.9 });
    });

    it('should handle empty insights array', () => {
      const map = buildRoleMap([]);
      expect(map.size).toBe(0);
    });

    it('should handle null/undefined insights', () => {
      const map1 = buildRoleMap(null as any);
      const map2 = buildRoleMap(undefined as any);
      
      expect(map1.size).toBe(0);
      expect(map2.size).toBe(0);
    });

    it('should handle multiple insights with different keys', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: 0.9 },
        { key: 'img2.jpg', role: 'back', roleScore: 0.8 },
        { key: 'img3.jpg', role: 'other', roleScore: 0.7 },
      ];

      const map = buildRoleMap(insights);
      expect(map.size).toBe(3);
    });

    it('should handle zero roleScore', () => {
      const insights = [
        { key: 'img1.jpg', role: 'front', roleScore: 0 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('img1.jpg')).toEqual({ role: 'front', score: 0 });
    });

    it('should prioritize key over other fields', () => {
      const insights = [
        { key: 'primary.jpg', _key: 'fallback1.jpg', urlKey: 'fallback2.jpg', url: 'fallback3.jpg', role: 'front', roleScore: 0.9 },
      ];

      const map = buildRoleMap(insights);
      expect(map.get('primary.jpg')).toBeDefined();
      expect(map.get('fallback1.jpg')).toBeUndefined();
    });
  });
});
