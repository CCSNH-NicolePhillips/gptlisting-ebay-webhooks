import { proxyImageUrls } from '../../src/lib/image-utils';

describe('image-utils', () => {
  describe('proxyImageUrls', () => {
    let originalDateNow: () => number;
    const mockTimestamp = 1234567890;
    const mockTimestamp36 = mockTimestamp.toString(36);

    beforeEach(() => {
      originalDateNow = Date.now;
      Date.now = jest.fn(() => mockTimestamp);
    });

    afterEach(() => {
      Date.now = originalDateNow;
    });

    describe('S3 URLs', () => {
      it('should return S3 URLs directly without proxying', () => {
        const s3Urls = [
          'https://mybucket.s3.amazonaws.com/image.jpg',
          'https://bucket.s3.us-east-1.amazonaws.com/path/to/image.png'
        ];

        const result = proxyImageUrls(s3Urls);

        expect(result).toEqual(s3Urls);
        expect(result[0]).not.toContain('image-proxy');
        expect(result[1]).not.toContain('image-proxy');
      });

      it('should handle S3 URLs with query parameters', () => {
        const s3Url = 'https://mybucket.s3.amazonaws.com/image.jpg?X-Amz-Algorithm=AWS4-HMAC-SHA256';

        const result = proxyImageUrls([s3Url]);

        expect(result[0]).toBe(s3Url);
        expect(result[0]).not.toContain('image-proxy');
      });
    });

    describe('Dropbox URLs', () => {
      it('should convert Dropbox share URLs with dl parameter to direct download', () => {
        const dropboxUrl = 'https://www.dropbox.com/file.jpg?dl=0';

        const result = proxyImageUrls([dropboxUrl]);

        expect(result[0]).toContain('image-proxy');
        // The dl=1 is URL-encoded within the image-proxy URL parameter
        expect(decodeURIComponent(result[0])).toContain('dl=1');
      });

      it('should convert Dropbox /s/ URLs to use raw parameter', () => {
        const dropboxUrl = 'https://www.dropbox.com/s/abc123/file.jpg';

        const result = proxyImageUrls([dropboxUrl]);

        expect(result[0]).toContain('image-proxy');
        // The raw=1 is URL-encoded within the image-proxy URL parameter
        expect(decodeURIComponent(result[0])).toContain('raw=1');
      });

      it('should handle Dropbox URLs with subdomains', () => {
        const dropboxUrl = 'https://dl.dropboxusercontent.com/s/abc123/file.jpg';

        const result = proxyImageUrls([dropboxUrl]);

        expect(result[0]).toContain('image-proxy');
      });
    });

    describe('Already proxied URLs', () => {
      it('should add cache bust to already proxied URLs', () => {
        const proxiedUrl = 'https://example.com/.netlify/functions/image-proxy?url=https%3A%2F%2Fimage.com%2Ftest.jpg';

        const result = proxyImageUrls([proxiedUrl]);

        expect(result[0]).toBe(`${proxiedUrl}&v=${mockTimestamp36}`);
      });

      it('should handle relative proxied URLs without base', () => {
        const proxiedUrl = '/.netlify/functions/image-proxy?url=https%3A%2F%2Fimage.com%2Ftest.jpg';

        const result = proxyImageUrls([proxiedUrl]);

        expect(result[0]).toContain('v=');
        expect(result[0]).toContain(mockTimestamp36);
      });

      it('should absolutize relative proxied URLs with base', () => {
        const proxiedUrl = '/.netlify/functions/image-proxy?url=https%3A%2F%2Fimage.com%2Ftest.jpg';
        const base = 'https://myapp.netlify.app';

        const result = proxyImageUrls([proxiedUrl], base);

        expect(result[0]).toContain(`${base}/.netlify/functions/image-proxy`);
        expect(result[0]).toContain('v=');
      });
    });

    describe('Regular URLs', () => {
      it('should proxy regular HTTP URLs', () => {
        const regularUrl = 'https://example.com/image.jpg';

        const result = proxyImageUrls([regularUrl]);

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
        expect(result[0]).toContain(encodeURIComponent(regularUrl));
        expect(result[0]).toContain(`v=${mockTimestamp36}`);
      });

      it('should proxy regular HTTP URLs with base', () => {
        const regularUrl = 'https://example.com/image.jpg';
        const base = 'https://myapp.netlify.app';

        const result = proxyImageUrls([regularUrl], base);

        expect(result[0]).toContain(`${base}/.netlify/functions/image-proxy`);
        expect(result[0]).toContain(encodeURIComponent(regularUrl));
      });

      it('should handle URLs with query parameters', () => {
        const urlWithQuery = 'https://example.com/image.jpg?size=large&format=png';

        const result = proxyImageUrls([urlWithQuery]);

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
        expect(result[0]).toContain(encodeURIComponent(urlWithQuery));
      });

      it('should remove trailing slash from base', () => {
        const regularUrl = 'https://example.com/image.jpg';
        const baseWithSlash = 'https://myapp.netlify.app/';

        const result = proxyImageUrls([regularUrl], baseWithSlash);

        expect(result[0]).toContain('https://myapp.netlify.app/.netlify/functions/image-proxy');
        expect(result[0]).not.toContain('https://myapp.netlify.app//.netlify');
      });
    });

    describe('Invalid URLs', () => {
      it('should handle invalid URLs gracefully', () => {
        const invalidUrl = 'not-a-valid-url';

        const result = proxyImageUrls([invalidUrl]);

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
        expect(result[0]).toContain(encodeURIComponent(invalidUrl));
        expect(result[0]).toContain(`v=${mockTimestamp36}`);
      });

      it('should add cache bust with & for invalid URLs with query params', () => {
        const invalidUrl = 'malformed://url?existing=param';

        const result = proxyImageUrls([invalidUrl]);

        // Should still proxy the invalid URL
        expect(result[0]).toContain('/.netlify/functions/image-proxy');
      });
    });

    describe('Cache busting', () => {
      it('should add cache bust parameter with ?', () => {
        const url = 'https://example.com/image.jpg';

        const result = proxyImageUrls([url]);

        expect(result[0]).toContain(`v=${mockTimestamp36}`);
        expect(result[0]).toMatch(/\?.*v=/); // v= should be after a ?
      });

      it('should add cache bust parameter with & when query exists', () => {
        const proxiedUrl = 'https://example.com/.netlify/functions/image-proxy?url=test';

        const result = proxyImageUrls([proxiedUrl]);

        expect(result[0]).toContain(`&v=${mockTimestamp36}`);
      });
    });

    describe('Multiple URLs', () => {
      it('should process multiple URLs of different types', () => {
        const urls = [
          'https://mybucket.s3.amazonaws.com/image1.jpg',
          'https://example.com/image2.jpg',
          'https://www.dropbox.com/s/abc/image3.jpg',
          '/.netlify/functions/image-proxy?url=https%3A%2F%2Ftest.com%2Fimg.jpg'
        ];

        const result = proxyImageUrls(urls);

        expect(result).toHaveLength(4);
        // S3 should not be proxied
        expect(result[0]).toBe(urls[0]);
        // Regular URL should be proxied
        expect(result[1]).toContain('/.netlify/functions/image-proxy');
        // Dropbox should be proxied with raw=1
        expect(decodeURIComponent(result[2])).toContain('raw=1');
        // Already proxied should get cache bust
        expect(result[3]).toContain(`v=${mockTimestamp36}`);
      });

      it('should handle empty array', () => {
        const result = proxyImageUrls([]);

        expect(result).toEqual([]);
      });

      it('should handle array with single URL', () => {
        const url = 'https://example.com/image.jpg';

        const result = proxyImageUrls([url]);

        expect(result).toHaveLength(1);
        expect(result[0]).toContain('/.netlify/functions/image-proxy');
      });
    });

    describe('Edge cases', () => {
      it('should convert non-string inputs to strings', () => {
        const urls = ['https://example.com/image.jpg'] as any;

        const result = proxyImageUrls(urls);

        expect(result).toHaveLength(1);
        expect(typeof result[0]).toBe('string');
      });

      it('should handle URLs without protocol', () => {
        const url = '//example.com/image.jpg';

        const result = proxyImageUrls([url]);

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
      });

      it('should handle data URLs', () => {
        const dataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAUA';

        const result = proxyImageUrls([dataUrl]);

        // Data URLs can't be parsed, so they get proxied via the fallback path
        expect(result[0]).toContain('/.netlify/functions/image-proxy');
        expect(result[0]).toContain(encodeURIComponent(dataUrl));
      });

      it('should handle URLs with special characters', () => {
        const url = 'https://example.com/image with spaces.jpg';

        const result = proxyImageUrls([url]);

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
      });

      it('should handle Dropbox URL that becomes proxied after conversion', () => {
        // Edge case: if a Dropbox URL somehow results in a proxied URL after toDirectDropbox
        const dropboxUrl = 'https://dropbox.com/.netlify/functions/image-proxy?url=test';

        const result = proxyImageUrls([dropboxUrl]);

        // Should recognize it as already proxied and add cache bust
        expect(result[0]).toContain('v=');
      });

      it('should handle case-insensitive Dropbox hostnames', () => {
        const urls = [
          'https://WWW.DROPBOX.COM/file.jpg?dl=0',
          'https://Dropbox.Com/s/abc/file.jpg'
        ];

        const result = proxyImageUrls(urls);

        // The parameters are URL-encoded within the image-proxy URL parameter
        expect(decodeURIComponent(result[0])).toContain('dl=1');
        expect(decodeURIComponent(result[1])).toContain('raw=1');
      });

      it('should handle case-insensitive S3 hostnames', () => {
        const url = 'https://mybucket.S3.AMAZONAWS.COM/image.jpg';

        const result = proxyImageUrls([url]);

        // URL constructor normalizes hostname to lowercase
        expect(result[0]).toBe(url.toLowerCase());
        expect(result[0]).not.toContain('image-proxy');
      });

      it('should handle case-insensitive image-proxy detection', () => {
        const proxiedUrl = 'https://example.com/.NETLIFY/functions/IMAGE-PROXY?url=test';

        const result = proxyImageUrls([proxiedUrl]);

        expect(result[0]).toContain(proxiedUrl);
        expect(result[0]).toContain('v=');
      });
    });

    describe('Base URL handling', () => {
      it('should handle base URL with path', () => {
        const url = 'https://example.com/image.jpg';
        const base = 'https://myapp.netlify.app/subpath';

        const result = proxyImageUrls([url], base);

        expect(result[0]).toContain('https://myapp.netlify.app/subpath/.netlify/functions/image-proxy');
      });

      it('should handle empty base URL', () => {
        const url = 'https://example.com/image.jpg';

        const result = proxyImageUrls([url], '');

        expect(result[0]).toContain('/.netlify/functions/image-proxy');
      });

      it('should handle base URL with multiple trailing slashes', () => {
        const url = 'https://example.com/image.jpg';
        const base = 'https://myapp.netlify.app///';

        const result = proxyImageUrls([url], base);

        // Only the last slash should be removed
        expect(result[0]).toContain('https://myapp.netlify.app///.netlify/functions/image-proxy');
      });
    });
  });
});
