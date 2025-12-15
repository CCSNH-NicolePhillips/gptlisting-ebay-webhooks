jest.mock('../../src/lib/clip-client-split', () => ({
  clipTextEmbedding: jest.fn(),
  clipImageEmbedding: jest.fn(),
}));

jest.mock('../../src/lib/clip-cache', () => ({
  getCached: jest.fn(),
  putCached: jest.fn(),
  textKey: jest.fn((text: string) => `cliptxt:${text}`),
  imageKey: jest.fn((url: string) => `clipimg:${url}`),
}));

jest.mock('../../src/lib/merge', () => ({
  toDirectDropbox: jest.fn((url: string) => url.replace('dl=0', 'raw=1')),
}));

describe('clip-provider', () => {
  let mockClipTextEmbedding: jest.Mock;
  let mockClipImageEmbedding: jest.Mock;
  let mockGetCached: jest.Mock;
  let mockPutCached: jest.Mock;
  let mockToDirectDropbox: jest.Mock;

  beforeEach(() => {
    jest.resetModules();
    
    const clipClient = require('../../src/lib/clip-client-split');
    const clipCache = require('../../src/lib/clip-cache');
    const merge = require('../../src/lib/merge');

    mockClipTextEmbedding = clipClient.clipTextEmbedding;
    mockClipImageEmbedding = clipClient.clipImageEmbedding;
    mockGetCached = clipCache.getCached;
    mockPutCached = clipCache.putCached;
    mockToDirectDropbox = merge.toDirectDropbox;

    mockClipTextEmbedding.mockClear();
    mockClipImageEmbedding.mockClear();
    mockGetCached.mockClear();
    mockPutCached.mockClear();
    mockToDirectDropbox.mockClear();
  });

  afterEach(() => {
    delete process.env.CLIP_PROVIDER;
  });

  describe('getTextVector_HF', () => {
    it('should return cached vector if available', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getTextVector_HF } = require('../../src/lib/clip-provider');
      
      const cachedVector = [0.1, 0.2, 0.3];
      mockGetCached.mockResolvedValueOnce(cachedVector);

      const result = await getTextVector_HF('test text');

      expect(result).toEqual(cachedVector);
      expect(mockGetCached).toHaveBeenCalledWith('cliptxt:test text');
      expect(mockClipTextEmbedding).not.toHaveBeenCalled();
    });

    it('should fetch and cache new embedding', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getTextVector_HF } = require('../../src/lib/clip-provider');
      
      const newVector = [0.4, 0.5, 0.6];
      mockGetCached.mockResolvedValueOnce(null);
      mockClipTextEmbedding.mockResolvedValueOnce(newVector);

      const result = await getTextVector_HF('new text');

      expect(result).toEqual(newVector);
      expect(mockClipTextEmbedding).toHaveBeenCalledWith('new text');
      expect(mockPutCached).toHaveBeenCalledWith('cliptxt:new text', newVector);
    });

    it('should return null if embedding fails', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getTextVector_HF } = require('../../src/lib/clip-provider');
      
      mockGetCached.mockResolvedValueOnce(null);
      mockClipTextEmbedding.mockResolvedValueOnce(null);

      const result = await getTextVector_HF('text');

      expect(result).toBeNull();
      expect(mockPutCached).not.toHaveBeenCalled();
    });
  });

  describe('getImageVector_HF', () => {
    it('should return cached vector if available', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getImageVector_HF } = require('../../src/lib/clip-provider');
      
      const cachedVector = [0.7, 0.8, 0.9];
      mockToDirectDropbox.mockReturnValueOnce('https://direct.url');
      mockGetCached.mockResolvedValueOnce(cachedVector);

      const result = await getImageVector_HF('https://image.url');

      expect(result).toEqual(cachedVector);
      expect(mockToDirectDropbox).toHaveBeenCalledWith('https://image.url');
      expect(mockGetCached).toHaveBeenCalledWith('clipimg:https://direct.url');
      expect(mockClipImageEmbedding).not.toHaveBeenCalled();
    });

    it('should fetch and cache new embedding', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getImageVector_HF } = require('../../src/lib/clip-provider');
      
      const newVector = [1.0, 1.1, 1.2];
      mockToDirectDropbox.mockReturnValueOnce('https://direct.url');
      mockGetCached.mockResolvedValueOnce(null);
      mockClipImageEmbedding.mockResolvedValueOnce(newVector);

      const result = await getImageVector_HF('https://image.url');

      expect(result).toEqual(newVector);
      expect(mockClipImageEmbedding).toHaveBeenCalledWith('https://direct.url');
      expect(mockPutCached).toHaveBeenCalledWith('clipimg:https://direct.url', newVector);
    });

    it('should return null if embedding fails', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getImageVector_HF } = require('../../src/lib/clip-provider');
      
      mockToDirectDropbox.mockReturnValueOnce('https://direct.url');
      mockGetCached.mockResolvedValueOnce(null);
      mockClipImageEmbedding.mockResolvedValueOnce(null);

      const result = await getImageVector_HF('https://image.url');

      expect(result).toBeNull();
      expect(mockPutCached).not.toHaveBeenCalled();
    });
  });

  describe('getTextEmb', () => {
    it('should return null when CLIP_PROVIDER is off', async () => {
      process.env.CLIP_PROVIDER = 'off';
      const { getTextEmb } = require('../../src/lib/clip-provider');

      const result = await getTextEmb('test');

      expect(result).toBeNull();
      expect(mockClipTextEmbedding).not.toHaveBeenCalled();
    });

    it('should return null when CLIP_PROVIDER is OFF (uppercase)', async () => {
      process.env.CLIP_PROVIDER = 'OFF';
      const { getTextEmb } = require('../../src/lib/clip-provider');

      const result = await getTextEmb('test');

      expect(result).toBeNull();
    });

    it('should use HF provider when CLIP_PROVIDER is hf', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getTextEmb } = require('../../src/lib/clip-provider');
      
      const vector = [0.1, 0.2];
      mockGetCached.mockResolvedValueOnce(null);
      mockClipTextEmbedding.mockResolvedValueOnce(vector);

      const result = await getTextEmb('test');

      expect(result).toEqual(vector);
    });

    it('should use HF provider when CLIP_PROVIDER is HF (uppercase)', async () => {
      process.env.CLIP_PROVIDER = 'HF';
      const { getTextEmb } = require('../../src/lib/clip-provider');
      
      const vector = [0.1, 0.2];
      mockGetCached.mockResolvedValueOnce(null);
      mockClipTextEmbedding.mockResolvedValueOnce(vector);

      const result = await getTextEmb('test');

      expect(result).toEqual(vector);
    });

    it('should default to hf when CLIP_PROVIDER not set', async () => {
      const { getTextEmb } = require('../../src/lib/clip-provider');
      
      const vector = [0.1, 0.2];
      mockGetCached.mockResolvedValueOnce(null);
      mockClipTextEmbedding.mockResolvedValueOnce(vector);

      const result = await getTextEmb('test');

      expect(result).toEqual(vector);
    });

    it('should return null for unknown provider', async () => {
      process.env.CLIP_PROVIDER = 'unknown';
      const { getTextEmb } = require('../../src/lib/clip-provider');

      const result = await getTextEmb('test');

      expect(result).toBeNull();
    });
  });

  describe('getImageEmb', () => {
    it('should return null when CLIP_PROVIDER is off', async () => {
      process.env.CLIP_PROVIDER = 'off';
      const { getImageEmb } = require('../../src/lib/clip-provider');

      const result = await getImageEmb('https://image.url');

      expect(result).toBeNull();
      expect(mockClipImageEmbedding).not.toHaveBeenCalled();
    });

    it('should use HF provider when CLIP_PROVIDER is hf', async () => {
      process.env.CLIP_PROVIDER = 'hf';
      const { getImageEmb } = require('../../src/lib/clip-provider');
      
      const vector = [0.3, 0.4];
      mockToDirectDropbox.mockReturnValueOnce('https://direct.url');
      mockGetCached.mockResolvedValueOnce(null);
      mockClipImageEmbedding.mockResolvedValueOnce(vector);

      const result = await getImageEmb('https://image.url');

      expect(result).toEqual(vector);
    });

    it('should default to hf when CLIP_PROVIDER not set', async () => {
      const { getImageEmb } = require('../../src/lib/clip-provider');
      
      const vector = [0.3, 0.4];
      mockToDirectDropbox.mockReturnValueOnce('https://direct.url');
      mockGetCached.mockResolvedValueOnce(null);
      mockClipImageEmbedding.mockResolvedValueOnce(vector);

      const result = await getImageEmb('https://image.url');

      expect(result).toEqual(vector);
    });

    it('should return null for unknown provider', async () => {
      process.env.CLIP_PROVIDER = 'unknown';
      const { getImageEmb } = require('../../src/lib/clip-provider');

      const result = await getImageEmb('https://image.url');

      expect(result).toBeNull();
    });
  });
});
