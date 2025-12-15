/**
 * Tests for role-confidence.ts
 * Tests image role confidence scoring and correction heuristics
 */

import {
  computeRoleConfidence,
  computeRoleConfidenceBatch,
  crossCheckGroupRoles,
  type ImageInsight,
  type RoleConfidence,
} from '../../src/lib/role-confidence';

describe('role-confidence', () => {
  describe('computeRoleConfidence', () => {
    describe('Basic functionality', () => {
      it('should compute confidence for front role with base score', () => {
        const insight: ImageInsight = {
          url: 'https://example.com/img1.jpg',
          role: 'front',
          roleScore: 0.8,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.role).toBe('front');
        expect(result.confidence).toBeGreaterThan(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(result.flags).toBeInstanceOf(Array);
      });

      it('should handle missing role with default', () => {
        const insight: ImageInsight = {
          url: 'https://example.com/img1.jpg',
          roleScore: 0.5,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.role).toBe('other');
      });

      it('should handle missing roleScore', () => {
        const insight: ImageInsight = {
          url: 'https://example.com/img1.jpg',
          role: 'front',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });

      it('should use absolute value of base score', () => {
        const insight: ImageInsight = {
          url: 'https://example.com/img1.jpg',
          role: 'front',
          roleScore: -0.5,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0);
      });

      it('should clamp confidence to [0, 1]', () => {
        const insight: ImageInsight = {
          url: 'https://example.com/img1.jpg',
          role: 'front',
          roleScore: 2.5,  // Very high score
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Text density heuristics', () => {
      describe('Front role', () => {
        it('should boost confidence for moderate text (20-200 chars)', () => {
          const withText: ImageInsight = {
            role: 'front',
            roleScore: 0.5,
            textExtracted: 'Brand Name Product Line Premium Formula',
          };
          
          const withoutText: ImageInsight = {
            role: 'front',
            roleScore: 0.5,
            textExtracted: '',
          };
          
          const resultWithText = computeRoleConfidence(withText);
          const resultWithoutText = computeRoleConfidence(withoutText);
          
          expect(resultWithText.confidence).toBeGreaterThan(resultWithoutText.confidence);
        });

        it('should penalize excessive text (>400 chars)', () => {
          const longText = 'A'.repeat(450);
          const insight: ImageInsight = {
            role: 'front',
            roleScore: 0.5,
            textExtracted: longText,
          };
          
          const result = computeRoleConfidence(insight);
          
          expect(result.flags).toContain('excessive_text_for_front');
          expect(result.confidence).toBeLessThan(0.5);
        });

        it('should handle minimal text without penalty', () => {
          const insight: ImageInsight = {
            role: 'front',
            roleScore: 0.5,
            textExtracted: 'Brand',
          };
          
          const result = computeRoleConfidence(insight);
          
          expect(result.flags).not.toContain('excessive_text_for_front');
        });
      });

      describe('Back role', () => {
        it('should boost confidence for dense text (>200 chars)', () => {
          const denseText = 'Ingredients: ' + 'Supplement Facts '.repeat(15);
          const insight: ImageInsight = {
            role: 'back',
            roleScore: 0.5,
            textExtracted: denseText,
          };
          
          const result = computeRoleConfidence(insight);
          
          expect(result.confidence).toBeGreaterThan(0.5);
        });

        it('should penalize low text (<30 chars)', () => {
          const insight: ImageInsight = {
            role: 'back',
            roleScore: 0.5,
            textExtracted: 'Short',
          };
          
          const result = computeRoleConfidence(insight);
          
          expect(result.flags).toContain('low_text_for_back');
          expect(result.confidence).toBeLessThan(0.5);
        });
      });
    });

    describe('Branding clarity heuristics', () => {
      it('should boost front confidence with branding indicators', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          evidenceTriggers: ['Brand logo visible', 'Hero text centered'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should boost back confidence with back indicators', () => {
        const insight: ImageInsight = {
          role: 'back',
          roleScore: 0.5,
          evidenceTriggers: ['Supplement Facts panel', 'Barcode visible'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should detect front indicators on back label', () => {
        const insight: ImageInsight = {
          role: 'back',
          roleScore: 0.3,
          evidenceTriggers: ['Brand logo visible', 'Large centered text'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('front_indicators_on_back_label');
        expect(result.confidence).toBeLessThan(0.3);
      });

      it('should detect back indicators on front label', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.3,
          evidenceTriggers: ['Nutrition Facts', 'Ingredients list'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('back_indicators_on_front_label');
        expect(result.confidence).toBeLessThan(0.3);
      });

      it('should handle empty evidence triggers', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          evidenceTriggers: [],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });

      it('should handle missing evidence triggers', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Background uniformity heuristics', () => {
      it('should boost front confidence with plain white background', () => {
        const white: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          dominantColor: 'white',
        };
        
        const other: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          dominantColor: 'blue',
        };
        
        const whiteResult = computeRoleConfidence(white);
        const otherResult = computeRoleConfidence(other);
        
        expect(whiteResult.confidence).toBeGreaterThan(otherResult.confidence);
      });

      it('should boost front confidence with plain black background', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          dominantColor: 'black',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should handle missing dominant color', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Visual description heuristics', () => {
      it('should detect full-wrap label', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          visualDescription: 'Full-wrap label with product information',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('full_wrap_label_detected');
      });

      it('should detect 360-degree label', () => {
        const insight: ImageInsight = {
          role: 'back',
          roleScore: 0.5,
          visualDescription: '360-degree view of the bottle',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('full_wrap_label_detected');
      });

      it('should not flag full-wrap for detail/label roles', () => {
        const detail: ImageInsight = {
          role: 'detail',
          roleScore: 0.5,
          visualDescription: 'Full-wrap label visible',
        };
        
        const label: ImageInsight = {
          role: 'label',
          roleScore: 0.5,
          visualDescription: '360-degree label shot',
        };
        
        const detailResult = computeRoleConfidence(detail);
        const labelResult = computeRoleConfidence(label);
        
        expect(detailResult.flags).not.toContain('full_wrap_label_detected');
        expect(labelResult.flags).not.toContain('full_wrap_label_detected');
      });

      it('should boost front confidence with symmetry', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          visualDescription: 'Centered, symmetrical composition',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.5);
      });

      it('should penalize front confidence when rotated', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          visualDescription: 'Image is rotated 45 degrees',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('rotated_image_marked_as_front');
        expect(result.confidence).toBeLessThan(0.5);
      });

      it('should handle angled images', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          visualDescription: 'Angled view of the product',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('rotated_image_marked_as_front');
      });

      it('should handle missing visual description', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
      });
    });

    describe('Low confidence detection', () => {
      it('should flag low confidence (<0.4)', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.2,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).toContain('low_confidence');
        expect(result.confidence).toBeLessThan(0.4);
      });

      it('should not flag moderate confidence', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.6,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.flags).not.toContain('low_confidence');
      });
    });

    describe('Role correction', () => {
      it('should correct front to back with back indicators and low confidence', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.3,
          evidenceTriggers: ['Nutrition Facts', 'Directions for use'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.adjustedRole).toBe('back');
        expect(result.role).toBe('back');
        expect(result.flags).toContain('role_corrected_front_to_back');
      });

      it('should correct back to front with front indicators and low confidence', () => {
        const insight: ImageInsight = {
          role: 'back',
          roleScore: 0.3,
          evidenceTriggers: ['Brand logo visible', 'Hero text large'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.adjustedRole).toBe('front');
        expect(result.role).toBe('front');
        expect(result.flags).toContain('role_corrected_back_to_front');
      });

      it('should not correct with high confidence', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.8,
          evidenceTriggers: ['Nutrition Facts'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.adjustedRole).toBeUndefined();
        expect(result.role).toBe('front');
      });

      it('should not correct without contradictory indicators', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.3,
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.adjustedRole).toBeUndefined();
      });
    });

    describe('Complex scenarios', () => {
      it('should handle multiple conflicting signals', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.5,
          textExtracted: 'A'.repeat(500),  // Too much text for front
          evidenceTriggers: ['Brand logo'],  // But has branding
          dominantColor: 'white',  // Plain background (good for front)
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThanOrEqual(0);
        expect(result.confidence).toBeLessThanOrEqual(1);
        expect(result.flags).toBeDefined();
      });

      it('should handle ideal front image', () => {
        const insight: ImageInsight = {
          role: 'front',
          roleScore: 0.85,
          textExtracted: 'Premium Formula Health Supplement',
          evidenceTriggers: ['Brand logo visible', 'Hero text large centered'],
          dominantColor: 'white',
          visualDescription: 'Centered symmetrical product shot',
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.8);
        expect(result.flags).not.toContain('low_confidence');
        expect(result.adjustedRole).toBeUndefined();
      });

      it('should handle ideal back image', () => {
        const longText = 'Supplement Facts: ' + 'Directions: Take 2 capsules daily. '.repeat(10);
        const insight: ImageInsight = {
          role: 'back',
          roleScore: 0.8,
          textExtracted: longText,
          evidenceTriggers: ['Supplement Facts panel', 'Barcode visible', 'Ingredients list'],
        };
        
        const result = computeRoleConfidence(insight);
        
        expect(result.confidence).toBeGreaterThan(0.8);
        expect(result.flags).not.toContain('low_confidence');
      });
    });
  });

  describe('computeRoleConfidenceBatch', () => {
    it('should process multiple insights', () => {
      const insights: ImageInsight[] = [
        { key: 'img1', role: 'front', roleScore: 0.8 },
        { key: 'img2', role: 'back', roleScore: 0.7 },
        { key: 'img3', role: 'side', roleScore: 0.6 },
      ];
      
      const results = computeRoleConfidenceBatch(insights);
      
      expect(results.size).toBe(3);
      expect(results.get('img1')).toBeDefined();
      expect(results.get('img2')).toBeDefined();
      expect(results.get('img3')).toBeDefined();
    });

    it('should handle empty insights array', () => {
      const results = computeRoleConfidenceBatch([]);
      
      expect(results.size).toBe(0);
    });

    it('should skip insights without keys', () => {
      const insights: ImageInsight[] = [
        { role: 'front', roleScore: 0.8 },  // No key
        { key: 'img2', role: 'back', roleScore: 0.7 },
      ];
      
      const results = computeRoleConfidenceBatch(insights);
      
      expect(results.size).toBe(1);
      expect(results.get('img2')).toBeDefined();
    });

    it('should use alternative key fields (_key, urlKey, url)', () => {
      const insights: ImageInsight[] = [
        { _key: 'img1', role: 'front', roleScore: 0.8 },
        { urlKey: 'img2', role: 'back', roleScore: 0.7 },
        { url: 'img3', role: 'side', roleScore: 0.6 },
      ];
      
      const results = computeRoleConfidenceBatch(insights);
      
      expect(results.size).toBe(3);
      expect(results.get('img1')).toBeDefined();
      expect(results.get('img2')).toBeDefined();
      expect(results.get('img3')).toBeDefined();
    });

    it('should prioritize key over other key fields', () => {
      const insights: ImageInsight[] = [
        { key: 'primary', _key: 'secondary', role: 'front', roleScore: 0.8 },
      ];
      
      const results = computeRoleConfidenceBatch(insights);
      
      expect(results.get('primary')).toBeDefined();
      expect(results.get('secondary')).toBeUndefined();
    });
  });

  describe('crossCheckGroupRoles', () => {
    describe('Multiple fronts handling', () => {
      it('should keep highest confidence front and demote others', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'front', confidence: 0.9, flags: [] }],
          ['img2', { role: 'front', confidence: 0.7, flags: [] }],
          ['img3', { role: 'front', confidence: 0.8, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2', 'img3'], confidenceMap);
        
        expect(result.groupId).toBe('group1');
        expect(result.corrections).toHaveLength(2);
        expect(result.corrections.some(c => c.imageKey === 'img2')).toBe(true);
        expect(result.corrections.some(c => c.imageKey === 'img3')).toBe(true);
        expect(result.corrections.every(c => c.correctedRole === 'side')).toBe(true);
      });

      it('should include confidence in correction reason', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'front', confidence: 0.95, flags: [] }],
          ['img2', { role: 'front', confidence: 0.6, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        expect(result.corrections[0].reason).toContain('0.95');
        expect(result.corrections[0].reason).toContain('0.60');
      });

      it('should handle single front without corrections', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'front', confidence: 0.9, flags: [] }],
          ['img2', { role: 'back', confidence: 0.8, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });
    });

    describe('Zero fronts handling', () => {
      it('should promote best side image to front when no fronts exist', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'back', confidence: 0.8, flags: [] }],
          ['img2', { role: 'side', confidence: 0.7, flags: [] }],
          ['img3', { role: 'other', confidence: 0.6, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2', 'img3'], confidenceMap);
        
        expect(result.corrections).toHaveLength(1);
        expect(result.corrections[0].imageKey).toBe('img2');
        expect(result.corrections[0].correctedRole).toBe('front');
        expect(result.corrections[0].originalRole).toBe('side');
      });

      it('should not promote backs to fronts', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'back', confidence: 0.9, flags: [] }],
          ['img2', { role: 'back', confidence: 0.8, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });

      it('should handle empty image keys', () => {
        const confidenceMap = new Map<string, RoleConfidence>();
        
        const result = crossCheckGroupRoles('group1', [], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });

      it('should handle missing confidence entries', () => {
        const confidenceMap = new Map<string, RoleConfidence>();
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });

      it('should include promotion reason', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'side', confidence: 0.75, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1'], confidenceMap);
        
        expect(result.corrections[0].reason).toContain('No front detected');
        expect(result.corrections[0].reason).toContain('0.75');
      });
    });

    describe('Edge cases', () => {
      it('should handle group with all backs', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'back', confidence: 0.9, flags: [] }],
          ['img2', { role: 'back', confidence: 0.8, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });

      it('should handle group with all detail/label roles', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'detail', confidence: 0.7, flags: [] }],
          ['img2', { role: 'label', confidence: 0.8, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1', 'img2'], confidenceMap);
        
        // No fronts, so it should try to promote, but detail/label aren't sides
        // Actually, let's check what happens with 'other' roles
        expect(result.corrections).toHaveLength(0);
      });

      it('should handle very low confidence images', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'side', confidence: 0.1, flags: ['low_confidence'] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1'], confidenceMap);
        
        // Should still promote even with low confidence if it's the only option
        expect(result.corrections).toHaveLength(1);
      });

      it('should preserve groupId in result', () => {
        const confidenceMap = new Map<string, RoleConfidence>();
        
        const result = crossCheckGroupRoles('test-group-123', [], confidenceMap);
        
        expect(result.groupId).toBe('test-group-123');
      });

      it('should handle single back image', () => {
        const confidenceMap = new Map<string, RoleConfidence>([
          ['img1', { role: 'back', confidence: 0.9, flags: [] }],
        ]);
        
        const result = crossCheckGroupRoles('group1', ['img1'], confidenceMap);
        
        expect(result.corrections).toHaveLength(0);
      });
    });
  });
});
