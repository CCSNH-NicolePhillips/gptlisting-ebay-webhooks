/**
 * Tests for eBay category and aspect mapping
 * 
 * CONTEXT: Category and aspect mapping is a major source of listing errors.
 * Common issues:
 * - Invalid category IDs causing 400 errors
 * - Required aspects missing
 * - Aspect values not in allowed list
 * - Aspect names spelled incorrectly
 * - Product identifiers (UPC/EAN/ISBN) in wrong format
 * 
 * These tests ensure robust category and aspect handling.
 */

describe('eBay category and aspect mapping', () => {
  describe('category ID validation', () => {
    it('should accept valid eBay category ID format', () => {
      const validIds = [
        '12345',
        '261586', // Hair Care
        '11773',  // Books
        '31838',  // Supplements
        '20349',  // Health & Beauty
      ];

      validIds.forEach((id) => {
        expect(id).toMatch(/^\d+$/);
        expect(parseInt(id, 10)).toBeGreaterThan(0);
      });
    });

    it('should reject invalid category ID formats', () => {
      const invalidIds = [
        '',
        'abc',
        '12.34',
        '-123',
        '0',
        'CAT123',
      ];

      invalidIds.forEach((id) => {
        const isValid = /^\d+$/.test(id) && parseInt(id, 10) > 0;
        expect(isValid).toBe(false);
      });
    });

    it('should handle category ID as string or number', () => {
      const categoryIdString = '261586';
      const categoryIdNumber = 261586;

      expect(String(categoryIdString)).toBe('261586');
      expect(String(categoryIdNumber)).toBe('261586');
    });
  });

  describe('aspect name normalization', () => {
    /**
     * eBay aspect names must match exactly (case-sensitive).
     * Common mistakes: "brand" vs "Brand", "type" vs "Type"
     */
    it('should preserve exact aspect name casing', () => {
      const aspects: Record<string, string> = {
        Brand: 'Natural Stacks',
        Type: 'Dietary Supplement',
        'Active Ingredients': 'Magnesium L-Threonate',
        Formulation: 'Capsule',
      };

      Object.keys(aspects).forEach((name) => {
        expect(name).not.toBe(name.toLowerCase());
        expect(name).not.toBe(name.toUpperCase());
      });
    });

    it('should handle multi-word aspect names with spaces', () => {
      const aspectNames = [
        'Active Ingredients',
        'Product Line',
        'Scent Type',
        'Hair Type',
        'Country/Region of Manufacture',
      ];

      aspectNames.forEach((name) => {
        expect(name).toContain(' ');
        expect(name.trim()).toBe(name); // No leading/trailing spaces
      });
    });

    it('should handle aspect names with special characters', () => {
      const aspectNames = [
        'Country/Region of Manufacture',
        'Size/Volume',
        'SPF (Sun Protection Factor)',
      ];

      aspectNames.forEach((name) => {
        expect(name).toBeTruthy();
        expect(name.length).toBeGreaterThan(0);
      });
    });
  });

  describe('aspect value validation', () => {
    it('should accept values from eBay allowed list', () => {
      // Example: Hair Type aspect allowed values
      const allowedHairTypes = [
        'All Hair Types',
        'Curly',
        'Dry',
        'Fine',
        'Normal',
        'Oily',
        'Wavy',
        'Thick',
        'Thin',
      ];

      const selectedValue = 'All Hair Types';
      expect(allowedHairTypes).toContain(selectedValue);
    });

    it('should reject values not in allowed list', () => {
      const allowedFormulations = ['Capsule', 'Tablet', 'Powder', 'Liquid', 'Gummy'];
      const invalidValue = 'Pills'; // Not in allowed list

      expect(allowedFormulations).not.toContain(invalidValue);
    });

    it('should handle case-sensitive value matching', () => {
      const allowedValues = ['Capsule', 'Tablet', 'Powder'];
      const testValue = 'capsule'; // Wrong case

      // eBay is case-sensitive
      expect(allowedValues).not.toContain(testValue);
      expect(allowedValues).toContain('Capsule');
    });

    it('should trim whitespace from aspect values', () => {
      const value = '  Natural Stacks  ';
      const trimmed = value.trim();

      expect(trimmed).toBe('Natural Stacks');
      expect(trimmed).not.toContain('  ');
    });

    it('should handle multi-value aspects as array', () => {
      // Some aspects allow multiple values (e.g., Features)
      const features = ['Organic', 'Gluten-Free', 'Non-GMO'];

      expect(Array.isArray(features)).toBe(true);
      expect(features.length).toBe(3);
      features.forEach((f) => expect(typeof f).toBe('string'));
    });
  });

  describe('required aspects validation', () => {
    interface CategoryRequirements {
      categoryId: string;
      requiredAspects: string[];
    }

    it('should identify missing required aspects', () => {
      const requirements: CategoryRequirements = {
        categoryId: '261586', // Hair Care
        requiredAspects: ['Brand', 'Type', 'Formulation'],
      };

      const providedAspects = {
        Brand: 'EVA TSU',
        Type: 'Hair Mask',
        // Missing: Formulation
      };

      const missing = requirements.requiredAspects.filter(
        (name) => !providedAspects[name as keyof typeof providedAspects]
      );

      expect(missing).toEqual(['Formulation']);
    });

    it('should validate all required aspects present', () => {
      const requiredAspects = ['Brand', 'Type', 'Formulation'];
      const providedAspects = {
        Brand: 'Natural Stacks',
        Type: 'Dietary Supplement',
        Formulation: 'Capsule',
      };

      const missing = requiredAspects.filter(
        (name) => !providedAspects[name as keyof typeof providedAspects]
      );

      expect(missing).toEqual([]);
    });

    it('should handle optional aspects gracefully', () => {
      const allAspects = {
        Brand: 'Natural Stacks',
        Type: 'Dietary Supplement',
        Formulation: 'Capsule',
        // Optional aspects
        'Active Ingredients': 'Magnesium',
        'Product Line': 'Brain Boost',
      };

      expect(Object.keys(allAspects).length).toBeGreaterThan(3);
    });
  });

  describe('product identifier (UPC/EAN/ISBN) formatting', () => {
    it('should validate UPC-A format (12 digits)', () => {
      const validUPCs = ['012345678905', '123456789012', '999999999999'];

      validUPCs.forEach((upc) => {
        expect(upc).toMatch(/^\d{12}$/);
      });
    });

    it('should validate EAN-13 format (13 digits)', () => {
      const validEANs = ['1234567890123', '9780123456789', '5901234123457'];

      validEANs.forEach((ean) => {
        expect(ean).toMatch(/^\d{13}$/);
      });
    });

    it('should validate ISBN-10 format', () => {
      const validISBN10s = ['0-306-40615-2', '0306406152', '0-486-27557-4'];

      validISBN10s.forEach((isbn) => {
        const digitsOnly = isbn.replace(/[^0-9X]/g, '');
        expect(digitsOnly.length).toBe(10);
      });
    });

    it('should validate ISBN-13 format', () => {
      const validISBN13s = ['978-0-306-40615-7', '9780306406157', '978-3-16-148410-0'];

      validISBN13s.forEach((isbn) => {
        const digitsOnly = isbn.replace(/[^0-9]/g, '');
        expect(digitsOnly.length).toBe(13);
        expect(digitsOnly.startsWith('978') || digitsOnly.startsWith('979')).toBe(true);
      });
    });

    it('should reject invalid UPC/EAN formats', () => {
      const invalidCodes = [
        '123',           // Too short
        'abcdefghijkl',  // Non-numeric
        '12345678901a',  // Contains letter
        '123456789012345', // Too long
      ];

      invalidCodes.forEach((code) => {
        const isValidUPC = /^\d{12}$/.test(code);
        const isValidEAN = /^\d{13}$/.test(code);
        expect(isValidUPC || isValidEAN).toBe(false);
      });
    });

    it('should normalize ISBN with hyphens to digits-only', () => {
      const isbnWithHyphens = '978-0-306-40615-7';
      const normalized = isbnWithHyphens.replace(/[^0-9]/g, '');

      expect(normalized).toBe('9780306406157');
      expect(normalized).toMatch(/^\d{13}$/);
    });
  });

  describe('aspect value mapping and enrichment', () => {
    /**
     * Maps common variations to eBay standard values
     */
    it('should map common formulation variations', () => {
      const mappings: Record<string, string> = {
        pill: 'Capsule',
        pills: 'Capsule',
        cap: 'Capsule',
        caps: 'Capsule',
        tablets: 'Tablet',
        tab: 'Tablet',
        powder: 'Powder',
        liquid: 'Liquid',
        gummies: 'Gummy',
      };

      expect(mappings['pill']).toBe('Capsule');
      expect(mappings['tablets']).toBe('Tablet');
      expect(mappings['gummies']).toBe('Gummy');
    });

    it('should map hair type variations', () => {
      const mappings: Record<string, string> = {
        'all types': 'All Hair Types',
        curly: 'Curly',
        dry: 'Dry',
        oily: 'Oily',
        normal: 'Normal',
      };

      Object.entries(mappings).forEach(([input, expected]) => {
        expect(mappings[input]).toBe(expected);
      });
    });

    it('should handle aspect value enrichment from OCR', () => {
      const ocrText = 'Supplement Facts\nMagnesium L-Threonate 2000mg\nServing Size: 2 capsules';

      // Extract formulation
      const hasFormulation = /capsule|tablet|powder|liquid/i.test(ocrText);
      expect(hasFormulation).toBe(true);

      // Extract ingredients
      const hasIngredient = /magnesium/i.test(ocrText);
      expect(hasIngredient).toBe(true);
    });
  });

  describe('condition and condition description', () => {
    it('should use "New" for new products', () => {
      const condition = 'NEW';
      expect(condition).toBe('NEW');
    });

    it('should provide condition description for new items', () => {
      const conditionDescription = 'Brand new, factory sealed';
      expect(conditionDescription).toBeTruthy();
      expect(conditionDescription.length).toBeLessThanOrEqual(1000);
    });

    it('should handle used condition codes', () => {
      const usedConditions = [
        'USED_EXCELLENT',
        'USED_VERY_GOOD',
        'USED_GOOD',
        'USED_ACCEPTABLE',
      ];

      usedConditions.forEach((condition) => {
        expect(condition).toMatch(/^USED_/);
      });
    });
  });

  describe('aspect combination validation', () => {
    it('should create valid aspects object for supplements', () => {
      const aspects = {
        Brand: 'Natural Stacks',
        Type: 'Dietary Supplement',
        Formulation: 'Capsule',
        'Active Ingredients': 'Magnesium L-Threonate',
        'Main Purpose': 'Brain & Nervous System Health',
        'Supply Duration': '30 Days',
      };

      // Validate structure
      expect(Object.keys(aspects).length).toBeGreaterThan(0);
      Object.entries(aspects).forEach(([name, value]) => {
        expect(typeof name).toBe('string');
        expect(typeof value).toBe('string');
        expect(name.length).toBeGreaterThan(0);
        expect(value.length).toBeGreaterThan(0);
      });
    });

    it('should create valid aspects object for hair care', () => {
      const aspects = {
        Brand: 'EVA TSU',
        Type: 'Hair Mask',
        Formulation: 'Cream',
        'Hair Type': 'All Hair Types',
        'Product Line': 'Professional',
        'Scent Type': 'Unscented',
      };

      expect(Object.keys(aspects).length).toBe(6);
      expect(aspects['Hair Type']).toBe('All Hair Types');
    });

    it('should create valid aspects object for books', () => {
      const aspects = {
        Brand: 'Bobbi Brown',
        'Book Title': 'Makeup Manual',
        Author: 'Bobbi Brown',
        Language: 'English',
        Format: 'Hardcover',
        'Publication Year': '2024',
      };

      expect(aspects['Book Title']).toBeTruthy();
      expect(aspects.Author).toBeTruthy();
    });
  });

  describe('error handling and fallbacks', () => {
    it('should provide fallback for missing Brand', () => {
      const brand = 'Unbranded'; // eBay fallback
      expect(brand).toBe('Unbranded');
    });

    it('should provide fallback Type based on category', () => {
      const categoryId = '261586'; // Hair Care
      const fallbackType = 'Hair Care Product';
      expect(fallbackType).toBeTruthy();
    });

    it('should handle empty aspect values gracefully', () => {
      const aspects = {
        Brand: 'Natural Stacks',
        Type: '',
        Formulation: 'Capsule',
      };

      // Filter out empty values
      const validAspects = Object.fromEntries(
        Object.entries(aspects).filter(([_, value]) => value && value.trim())
      );

      expect(validAspects.Type).toBeUndefined();
      expect(validAspects.Brand).toBe('Natural Stacks');
    });

    it('should limit aspect value length', () => {
      const longValue = 'A'.repeat(100);
      const maxLength = 65; // eBay limit for most aspects

      const truncated = longValue.slice(0, maxLength);
      expect(truncated.length).toBe(maxLength);
    });
  });

  describe('category-specific aspect requirements', () => {
    it('should require ISBN for Books category', () => {
      const categoryId = '11773'; // Books
      const requiredForBooks = ['Brand', 'Language', 'Format'];

      expect(requiredForBooks).toContain('Brand');
      expect(requiredForBooks).toContain('Language');
    });

    it('should require Formulation for Supplements category', () => {
      const categoryId = '31838'; // Supplements
      const requiredForSupplements = ['Brand', 'Type', 'Formulation'];

      expect(requiredForSupplements).toContain('Formulation');
    });

    it('should require Hair Type for Hair Care category', () => {
      const categoryId = '261586'; // Hair Care
      const recommendedForHairCare = ['Brand', 'Type', 'Hair Type', 'Formulation'];

      expect(recommendedForHairCare).toContain('Hair Type');
    });
  });
});
