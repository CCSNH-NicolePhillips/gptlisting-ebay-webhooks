/**
 * Comprehensive tests for utils/finalizeDisplay.ts
 * Target: 100% code coverage
 */

import { finalizeDisplayUrls, FinalizeDisplayOptions } from '../../src/utils/finalizeDisplay';

// Mock console methods
const originalWarn = console.warn;
const originalLog = console.log;

beforeEach(() => {
  console.warn = jest.fn();
  console.log = jest.fn();
});

afterEach(() => {
  console.warn = originalWarn;
  console.log = originalLog;
});

describe('finalizeDisplay.ts', () => {
  describe('finalizeDisplayUrls', () => {
    it('should use httpsByKey as first priority', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should use originalByKey as second priority', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map([['file.jpg', 'https://original.com/file.jpg']]),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://original.com/file.jpg');
    });

    it('should use httpsByKey over originalByKey when both exist', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map([['file.jpg', 'https://original.com/file.jpg']]),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should use folderParam with key as third priority', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: 'https://dropbox.com/folder/abc123',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://dropbox.com/folder/abc123');
    });

    it('should use publicFilesBase as fourth priority', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
        publicFilesBase: 'https://proxy.com/files',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://proxy.com/files/file.jpg');
    });

    it('should use relative path as last fallback', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'folder/file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('/folder%2Ffile.jpg');
    });

    it('should handle _key field', () => {
      const analysis: any = {
        imageInsights: {
          img1: { _key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should handle urlKey field', () => {
      const analysis: any = {
        imageInsights: {
          img1: { urlKey: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should handle url field', () => {
      const analysis: any = {
        imageInsights: {
          img1: { url: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should prioritize key over _key', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'correct.jpg', _key: 'wrong.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([
          ['correct.jpg', 'https://example.com/correct.jpg'],
          ['wrong.jpg', 'https://example.com/wrong.jpg'],
        ]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/correct.jpg');
    });

    it('should handle array format imageInsights', () => {
      const analysis: any = {
        imageInsights: [
          { key: 'file1.jpg' },
          { key: 'file2.jpg' },
        ],
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([
          ['file1.jpg', 'https://example.com/file1.jpg'],
          ['file2.jpg', 'https://example.com/file2.jpg'],
        ]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights[0].displayUrl).toBe('https://example.com/file1.jpg');
      expect(analysis.imageInsights[1].displayUrl).toBe('https://example.com/file2.jpg');
    });

    it('should warn when no displayUrl can be set', () => {
      const analysis: any = {
        imageInsights: {
          img1: {},
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(console.warn).toHaveBeenCalled();
    });

    it('should log success message on completion', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(console.log).toHaveBeenCalled();
    });

    it('should handle mixed https and http URLs', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file1.jpg' },
          img2: { key: 'file2.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file1.jpg', 'https://example.com/file1.jpg']]),
        originalByKey: new Map([['file2.jpg', 'http://original.com/file2.jpg']]),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file1.jpg');
      expect(analysis.imageInsights.img2.displayUrl).toBe('http://original.com/file2.jpg');
    });

    it('should encode URI components with publicFilesBase', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file with spaces.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
        publicFilesBase: 'https://proxy.com/files',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toContain('file%20with%20spaces.jpg');
    });

    it('should encode URI components with folderParam fallback', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file with spaces.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: 'local/folder',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toContain('file%20with%20spaces.jpg');
    });

    it('should handle empty imageInsights object', () => {
      const analysis: any = {
        imageInsights: {},
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
      };

      expect(() => finalizeDisplayUrls(analysis, options)).not.toThrow();
    });

    it('should handle empty imageInsights array', () => {
      const analysis: any = {
        imageInsights: [],
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
      };

      expect(() => finalizeDisplayUrls(analysis, options)).not.toThrow();
    });

    it('should not overwrite existing displayUrl with non-https if https is available', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://secure.com/file.jpg']]),
        originalByKey: new Map([['file.jpg', 'http://insecure.com/file.jpg']]),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://secure.com/file.jpg');
    });

    it('should handle nested path in key', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'folder/subfolder/file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['folder/subfolder/file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file.jpg');
    });

    it('should handle special characters in key', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file (1).jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
        publicFilesBase: 'https://proxy.com/files',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toContain('file%20(1).jpg');
    });

    it('should detect https URLs correctly', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toMatch(/^https?:\/\//);
    });

    it('should detect http URLs correctly', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map([['file.jpg', 'http://example.com/file.jpg']]),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toMatch(/^https?:\/\//);
    });

    it('should handle case where all priority options are empty', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map(),
        originalByKey: new Map(),
        folderParam: '',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('/file.jpg');
    });

    it('should handle multiple insights with different priority levels', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file1.jpg' },
          img2: { key: 'file2.jpg' },
          img3: { key: 'file3.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file1.jpg', 'https://example.com/file1.jpg']]),
        originalByKey: new Map([['file2.jpg', 'https://original.com/file2.jpg']]),
        folderParam: '',
        publicFilesBase: 'https://proxy.com/files',
      };

      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1.displayUrl).toBe('https://example.com/file1.jpg');
      expect(analysis.imageInsights.img2.displayUrl).toBe('https://original.com/file2.jpg');
      expect(analysis.imageInsights.img3.displayUrl).toBe('https://proxy.com/files/file3.jpg');
    });

    it('should mutate the analysis object', () => {
      const analysis: any = {
        imageInsights: {
          img1: { key: 'file.jpg' },
        },
      };
      const options: FinalizeDisplayOptions = {
        httpsByKey: new Map([['file.jpg', 'https://example.com/file.jpg']]),
        originalByKey: new Map(),
        folderParam: '',
      };

      const originalRef = analysis.imageInsights.img1;
      finalizeDisplayUrls(analysis, options);

      expect(analysis.imageInsights.img1).toBe(originalRef);
      expect(analysis.imageInsights.img1).toHaveProperty('displayUrl');
    });
  });
});
