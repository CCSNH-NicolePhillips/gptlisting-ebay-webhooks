describe('export-utils', () => {
  describe('groupsToCSV', () => {
    it('should convert groups array to CSV', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          product: 'Shoes',
          variant: 'Red',
          size: '10',
          category: 'Footwear',
          confidence: 0.95,
          images: ['img1.jpg', 'img2.jpg']
        }
      ];

      const csv = groupsToCSV(groups);

      expect(csv).toContain('groupId,brand,product,variant,size,category,confidence,images');
      expect(csv).toContain('"g1","Nike","Shoes","Red","10","Footwear","0.95","img1.jpg img2.jpg"');
    });

    it('should return empty string for empty array', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const csv = groupsToCSV([]);

      expect(csv).toBe('');
    });

    it('should return empty string for non-array input', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      expect(groupsToCSV(null)).toBe('');
      expect(groupsToCSV(undefined)).toBe('');
      expect(groupsToCSV('not an array')).toBe('');
      expect(groupsToCSV({ key: 'value' })).toBe('');
    });

    it('should handle missing fields with empty strings', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          // missing other fields
        }
      ];

      const csv = groupsToCSV(groups);

      const lines = csv.split('\n');
      expect(lines[0]).toBe('groupId,brand,product,variant,size,category,confidence,images');
      expect(lines[1]).toBe('"g1","Nike","","","","","",""');
    });

    it('should escape double quotes in values', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Brand "Premium"',
          product: 'Product with "quotes"',
          variant: '',
          size: '',
          category: '',
          confidence: 1.0,
          images: []
        }
      ];

      const csv = groupsToCSV(groups);

      expect(csv).toContain('"Brand ""Premium"""');
      expect(csv).toContain('"Product with ""quotes"""');
    });

    it('should handle array fields by joining with spaces', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          product: 'Shoes',
          variant: 'Red',
          size: '10',
          category: 'Footwear',
          confidence: 0.95,
          images: ['image1.jpg', 'image2.jpg', 'image3.jpg']
        }
      ];

      const csv = groupsToCSV(groups);

      expect(csv).toContain('"image1.jpg image2.jpg image3.jpg"');
    });

    it('should handle null and undefined values', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: null,
          product: undefined,
          variant: '',
          size: '10',
          category: 'Footwear',
          confidence: 0,
          images: []
        }
      ];

      const csv = groupsToCSV(groups);

      const lines = csv.split('\n');
      expect(lines[1]).toBe('"g1","","","","10","Footwear","0",""');
    });

    it('should handle multiple groups', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          product: 'Shoes',
          variant: 'Red',
          size: '10',
          category: 'Footwear',
          confidence: 0.95,
          images: ['img1.jpg']
        },
        {
          groupId: 'g2',
          brand: 'Adidas',
          product: 'Shirt',
          variant: 'Blue',
          size: 'M',
          category: 'Apparel',
          confidence: 0.88,
          images: ['img2.jpg']
        }
      ];

      const csv = groupsToCSV(groups);

      const lines = csv.split('\n');
      expect(lines).toHaveLength(3); // header + 2 rows
      expect(lines[1]).toContain('Nike');
      expect(lines[2]).toContain('Adidas');
    });

    it('should stringify non-string values', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 123,
          brand: true,
          product: { name: 'complex' },
          variant: '',
          size: '',
          category: '',
          confidence: 0.5,
          images: []
        }
      ];

      const csv = groupsToCSV(groups);

      expect(csv).toContain('"123"');
      expect(csv).toContain('"true"');
      expect(csv).toContain('"[object Object]"');
    });

    it('should handle empty images array', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          product: 'Shoes',
          variant: '',
          size: '',
          category: '',
          confidence: 0.9,
          images: []
        }
      ];

      const csv = groupsToCSV(groups);

      expect(csv).toContain('""'); // empty string for images
    });

    it('should handle newlines in values', () => {
      const { groupsToCSV } = require('../../src/lib/export-utils');
      
      const groups = [
        {
          groupId: 'g1',
          brand: 'Nike',
          product: 'Shoes\nwith\nnewlines',
          variant: '',
          size: '',
          category: '',
          confidence: 0.9,
          images: []
        }
      ];

      const csv = groupsToCSV(groups);

      // Newlines should be preserved within quoted fields
      expect(csv).toContain('Shoes\nwith\nnewlines');
    });
  });
});
