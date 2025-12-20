import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// Mock dependencies before importing router
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

jest.mock('path', () => {
  const actualPath = jest.requireActual<typeof import('path')>('path');
  return {
    ...actualPath,
    join: jest.fn((...args: string[]) => actualPath.join(...args)),
  };
});

jest.mock('../../src/config.js', () => ({
  cfg: {
    dataDir: '/test/data',
  },
}));

import fs from 'fs';
import { adminRouter } from '../../src/routes/admin.js';
const actualPath = jest.requireActual<typeof import('path')>('path');

const mockFs = fs as jest.Mocked<typeof fs>;
const CATEGORY_MAP_PATH = actualPath.join('/test/data', 'category_map.json');

describe('adminRouter', () => {
  let app: express.Application;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(adminRouter);
    jest.clearAllMocks();
  });

  describe('GET /admin/category-map', () => {
    it('should return empty object when file does not exist', async () => {
      (mockFs.existsSync as any).mockReturnValue(false);

      const response = await request(app).get('/admin/category-map');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should return category map when file exists', async () => {
      const mockData = { 'SKU-123': '1234', 'SKU-456': '5678' };
      (mockFs.existsSync as any).mockReturnValue(true);
      (mockFs.readFileSync as any).mockReturnValue(JSON.stringify(mockData));

      const response = await request(app).get('/admin/category-map');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockData);
      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        CATEGORY_MAP_PATH,
        'utf8'
      );
    });

    it('should handle read errors', async () => {
      (mockFs.existsSync as any).mockReturnValue(true);
      (mockFs.readFileSync as any).mockImplementation(() => {
        throw new Error('Read error');
      });

      const response = await request(app).get('/admin/category-map');

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Read error' });
    });

    it('should handle invalid JSON', async () => {
      (mockFs.existsSync as any).mockReturnValue(true);
      (mockFs.readFileSync as any).mockReturnValue('invalid json');

      const response = await request(app).get('/admin/category-map');

      expect(response.status).toBe(500);
      expect(response.body.error).toContain('JSON');
    });
  });

  describe('POST /admin/category-map', () => {
    it('should create new category map when file does not exist', async () => {
      (mockFs.existsSync as any).mockReturnValue(false);
      const newData = { 'SKU-789': '9999' };

      const response = await request(app)
        .post('/admin/category-map')
        .send(newData);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(newData);
      expect(mockFs.mkdirSync).toHaveBeenCalledWith('/test/data', { recursive: true });
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        CATEGORY_MAP_PATH,
        JSON.stringify(newData, null, 2)
      );
    });

    it('should merge with existing category map', async () => {
      const existingData = { 'SKU-123': '1234', 'SKU-456': '5678' };
      const newData = { 'SKU-456': '9999', 'SKU-789': '1111' };
      const expectedMerged = { 'SKU-123': '1234', 'SKU-456': '9999', 'SKU-789': '1111' };

      (mockFs.existsSync as any).mockReturnValue(true);
      (mockFs.readFileSync as any).mockReturnValue(JSON.stringify(existingData));

      const response = await request(app)
        .post('/admin/category-map')
        .send(newData);

      expect(response.status).toBe(200);
      expect(response.body).toEqual(expectedMerged);
      expect(mockFs.writeFileSync).toHaveBeenCalledWith(
        CATEGORY_MAP_PATH,
        JSON.stringify(expectedMerged, null, 2)
      );
    });

    it('should handle empty body', async () => {
      (mockFs.existsSync as any).mockReturnValue(false);

      const response = await request(app)
        .post('/admin/category-map')
        .send();

      expect(response.status).toBe(200);
      expect(response.body).toEqual({});
    });

    it('should handle write errors', async () => {
      (mockFs.existsSync as any).mockReturnValue(false);
      (mockFs.writeFileSync as any).mockImplementation(() => {
        throw new Error('Write error');
      });

      const response = await request(app)
        .post('/admin/category-map')
        .send({ 'SKU-123': '1234' });

      expect(response.status).toBe(500);
      expect(response.body).toEqual({ error: 'Write error' });
    });
  });
});
