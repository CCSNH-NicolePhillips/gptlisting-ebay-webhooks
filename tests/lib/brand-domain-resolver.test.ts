/**
 * Phase 3 & 4 Tests: Authoritative Brand Domain Resolver
 * 
 * Phase 3: Ensures that registry domains always win over search suggestions,
 * but unknown brands can still use suggested domains.
 * 
 * Phase 4: Domain mismatch protection - reject suggested domains that 
 * don't plausibly match the brand name.
 */

import { isSuggestedDomainPlausible, doesDomainMatchBrand } from '../../src/lib/brand-map.js';

// Mock the Redis call to control registry responses
const mockRedisResponse: { result: unknown } | null = { result: null };
jest.mock('node-fetch', () => jest.fn());

describe('isSuggestedDomainPlausible (Phase 4 helper)', () => {
  // Required acceptance test cases from Phase 4 spec
  it('REQUIRED: brand="bettr." suggested="betrhealth.com" → rejected', () => {
    // "bettr" has no 4-char tokens, first 5 chars "bettr" is not in "betrhealth"
    expect(isSuggestedDomainPlausible('bettr.', 'betrhealth.com')).toBe(false);
  });

  it('REQUIRED: brand="evereden" suggested="evereden.com" → accepted', () => {
    expect(isSuggestedDomainPlausible('evereden', 'evereden.com')).toBe(true);
  });

  it('REQUIRED: brand="dr teals" suggested="drteals.com" → accepted', () => {
    // first 5 chars "drtea" should be in "drteals"
    expect(isSuggestedDomainPlausible('dr teals', 'drteals.com')).toBe(true);
  });

  // Additional test cases
  it('returns true for exact match: brand="Evereden" domain="evereden.com"', () => {
    expect(isSuggestedDomainPlausible('Evereden', 'evereden.com')).toBe(true);
  });

  it('returns false for mismatch: brand="Bettr." domain="betrhealth.com"', () => {
    expect(isSuggestedDomainPlausible('Bettr.', 'betrhealth.com')).toBe(false);
  });

  it('returns true for domain with get prefix: brand="Maude" domain="getmaude.com"', () => {
    // "maude" is 5 chars, should match
    expect(isSuggestedDomainPlausible('Maude', 'getmaude.com')).toBe(true);
  });

  it('returns true for combined multi-word brand: brand="Nordic Naturals" domain="nordicnaturals.com"', () => {
    // "nordic" (6 chars) and "naturals" (8 chars) are both >= 4, should match
    expect(isSuggestedDomainPlausible('Nordic Naturals', 'nordicnaturals.com')).toBe(true);
  });

  it('returns false for retailer domain: brand="Evereden" domain="amazon.com"', () => {
    expect(isSuggestedDomainPlausible('Evereden', 'amazon.com')).toBe(false);
  });

  it('handles brand with punctuation: brand="Dr. Squatch" domain="drsquatch.com"', () => {
    // "squatch" (7 chars) is >= 4, should match
    expect(isSuggestedDomainPlausible('Dr. Squatch', 'drsquatch.com')).toBe(true);
  });

  it('handles brand with Inc suffix: brand="Needed Inc" domain="thisisneeded.com"', () => {
    // "needed" (6 chars) is >= 4, should match
    expect(isSuggestedDomainPlausible('Needed Inc', 'thisisneeded.com')).toBe(true);
  });

  it('handles brand with LLC suffix: brand="BrightPath LLC" domain="brightpath.com"', () => {
    // "brightpath" should match after stripping "LLC"
    expect(isSuggestedDomainPlausible('BrightPath LLC', 'brightpath.com')).toBe(true);
  });

  it('returns false for empty brand', () => {
    expect(isSuggestedDomainPlausible('', 'example.com')).toBe(false);
  });

  it('returns false for empty domain', () => {
    expect(isSuggestedDomainPlausible('Brand', '')).toBe(false);
  });

  it('handles www prefix in domain: brand="Prequel" domain="www.prequelskin.com"', () => {
    // "prequel" (7 chars) is >= 4, should match
    expect(isSuggestedDomainPlausible('Prequel', 'www.prequelskin.com')).toBe(true);
  });

  it('handles shop prefix in domain: brand="Ritual" domain="shop.ritual.com"', () => {
    // "ritual" (6 chars) is >= 4, should match
    expect(isSuggestedDomainPlausible('Ritual', 'shop.ritual.com')).toBe(true);
  });

  it('rejects completely unrelated domain: brand="Prequel" domain="healthybeauty.com"', () => {
    expect(isSuggestedDomainPlausible('Prequel', 'healthybeauty.com')).toBe(false);
  });

  it('accepts domain that contains brand: brand="Frog Fuel" domain="frogfuel.com"', () => {
    // "frog" (4 chars) and "fuel" (4 chars) are both >= 4
    expect(isSuggestedDomainPlausible('Frog Fuel', 'frogfuel.com')).toBe(true);
  });

  // Hosted storefront rejection tests
  it('rejects myshopify.com domains: brand="Evereden" domain="evereden.myshopify.com"', () => {
    expect(isSuggestedDomainPlausible('Evereden', 'evereden.myshopify.com')).toBe(false);
  });

  it('rejects wixsite.com domains: brand="Ritual" domain="ritual.wixsite.com"', () => {
    expect(isSuggestedDomainPlausible('Ritual', 'ritual.wixsite.com')).toBe(false);
  });

  it('rejects squarespace.com domains: brand="Prequel" domain="prequel.squarespace.com"', () => {
    expect(isSuggestedDomainPlausible('Prequel', 'prequel.squarespace.com')).toBe(false);
  });

  it('rejects bigcartel.com domains: brand="Maude" domain="maude.bigcartel.com"', () => {
    expect(isSuggestedDomainPlausible('Maude', 'maude.bigcartel.com')).toBe(false);
  });

  it('accepts www prefix: brand="Evereden" domain="www.evereden.com"', () => {
    expect(isSuggestedDomainPlausible('Evereden', 'www.evereden.com')).toBe(true);
  });

  it('accepts m. prefix: brand="Evereden" domain="m.evereden.com"', () => {
    expect(isSuggestedDomainPlausible('Evereden', 'm.evereden.com')).toBe(true);
  });

  // Backward compatibility alias
  it('doesDomainMatchBrand is an alias for isSuggestedDomainPlausible', () => {
    expect(doesDomainMatchBrand('Evereden', 'evereden.com')).toBe(true);
    expect(doesDomainMatchBrand('Bettr.', 'betrhealth.com')).toBe(false);
  });
});

describe('resolveAuthoritativeBrandDomain', () => {
  let resolveAuthoritativeBrandDomain: (brand: string, suggestedDomain?: string | null) => Promise<{ domain: string | null; source: 'registry' | 'suggested' | 'none' }>;
  let mockFetch: jest.Mock;
  
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    
    // Setup environment for Redis
    process.env.UPSTASH_REDIS_REST_URL = 'https://fake-redis.upstash.io';
    process.env.UPSTASH_REDIS_REST_TOKEN = 'fake-token';
    
    // Mock global fetch for Redis calls
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    
    // Default: no brand in registry
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ result: null }),
    });
  });

  afterEach(() => {
    delete process.env.UPSTASH_REDIS_REST_URL;
    delete process.env.UPSTASH_REDIS_REST_TOKEN;
  });

  function setupRegistryMock(brandDomainMap: Record<string, string>) {
    mockFetch.mockImplementation(async (url: string) => {
      // Extract brand from Redis key: brandmap:domain:{brand}
      const match = url.match(/brandmap%3Adomain%3A([^/]+)/);
      if (match) {
        const brand = decodeURIComponent(match[1]);
        const domain = brandDomainMap[brand];
        return {
          ok: true,
          json: async () => ({ result: domain || null }),
        };
      }
      return { ok: true, json: async () => ({ result: null }) };
    });
  }

  describe('Registry precedence (Phase 3 regression tests)', () => {
    beforeEach(() => {
      // Fresh import for each test
      const brandMap = require('../../src/lib/brand-map.js');
      resolveAuthoritativeBrandDomain = brandMap.resolveAuthoritativeBrandDomain;
    });

    it('REGRESSION: Known brand + wrong suggestedDomain → usedDomain === registryDomain', async () => {
      // Setup: bettr is in registry with performbettr.com
      setupRegistryMock({ 'bettr': 'performbettr.com' });

      // Perplexity suggests betrhealth.com (WRONG!)
      const result = await resolveAuthoritativeBrandDomain('bettr', 'betrhealth.com');

      // Registry MUST win
      expect(result.domain).toBe('performbettr.com');
      expect(result.source).toBe('registry');
    });

    it('REGRESSION: Known brand + retailer suggestion → usedDomain === registryDomain', async () => {
      // Setup: needed is in registry
      setupRegistryMock({ 'needed': 'thisisneeded.com' });

      // Perplexity suggests amazon.com (common mistake)
      const result = await resolveAuthoritativeBrandDomain('needed', 'amazon.com');

      // Registry MUST win
      expect(result.domain).toBe('thisisneeded.com');
      expect(result.source).toBe('registry');
    });

    it('Unknown brand + suggestedDomain → usedDomain === suggestedDomain', async () => {
      // Setup: brand not in registry
      setupRegistryMock({});

      // Perplexity suggests a domain for unknown brand
      const result = await resolveAuthoritativeBrandDomain('SomeNewBrand', 'somenewbrand.com');

      // Should use suggested domain
      expect(result.domain).toBe('somenewbrand.com');
      expect(result.source).toBe('suggested');
    });

    it('Unknown brand + no suggestion → returns null', async () => {
      setupRegistryMock({});

      const result = await resolveAuthoritativeBrandDomain('UnknownBrand', null);

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });
  });

  describe('Domain validation', () => {
    beforeEach(() => {
      setupRegistryMock({});
      const brandMap = require('../../src/lib/brand-map.js');
      resolveAuthoritativeBrandDomain = brandMap.resolveAuthoritativeBrandDomain;
    });

    it('rejects garbage suggestions (contains spaces)', async () => {
      const result = await resolveAuthoritativeBrandDomain('Brand', 'not a domain');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('rejects too-short suggestions', async () => {
      const result = await resolveAuthoritativeBrandDomain('Brand', 'ab');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('rejects suggestions without dots', async () => {
      const result = await resolveAuthoritativeBrandDomain('Brand', 'nodothere');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('accepts valid short TLDs', async () => {
      const result = await resolveAuthoritativeBrandDomain('Brand', 'brand.co');

      expect(result.domain).toBe('brand.co');
      expect(result.source).toBe('suggested');
    });
  });

  describe('Case insensitivity', () => {
    beforeEach(() => {
      const brandMap = require('../../src/lib/brand-map.js');
      resolveAuthoritativeBrandDomain = brandMap.resolveAuthoritativeBrandDomain;
    });

    it('matches registry with different casing', async () => {
      // Registry stores lowercase keys
      setupRegistryMock({ 'betteralt': 'thebetteralt.com' });

      const result = await resolveAuthoritativeBrandDomain('BetterAlt', 'wrongdomain.com');

      expect(result.domain).toBe('thebetteralt.com');
      expect(result.source).toBe('registry');
    });
  });

  describe('Phase 4: Domain mismatch protection', () => {
    beforeEach(() => {
      setupRegistryMock({});
      const brandMap = require('../../src/lib/brand-map.js');
      resolveAuthoritativeBrandDomain = brandMap.resolveAuthoritativeBrandDomain;
    });

    // Required acceptance test cases from spec
    it('REQUIRED: brand="bettr." suggestedDomain="betrhealth.com" → rejected', async () => {
      const result = await resolveAuthoritativeBrandDomain('bettr.', 'betrhealth.com');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('REQUIRED: brand="evereden" suggestedDomain="evereden.com" → accepted', async () => {
      const result = await resolveAuthoritativeBrandDomain('evereden', 'evereden.com');

      expect(result.domain).toBe('evereden.com');
      expect(result.source).toBe('suggested');
    });

    it('REQUIRED: brand="dr teals" suggestedDomain="drteals.com" → accepted', async () => {
      const result = await resolveAuthoritativeBrandDomain('dr teals', 'drteals.com');

      expect(result.domain).toBe('drteals.com');
      expect(result.source).toBe('suggested');
    });

    // Additional edge cases for mismatch protection
    it('accepts domain with common prefix: brand="Maude" suggestedDomain="getmaude.com"', async () => {
      const result = await resolveAuthoritativeBrandDomain('Maude', 'getmaude.com');

      expect(result.domain).toBe('getmaude.com');
      expect(result.source).toBe('suggested');
    });

    it('accepts combined multi-word brand: brand="Nordic Naturals" suggestedDomain="nordicnaturals.com"', async () => {
      const result = await resolveAuthoritativeBrandDomain('Nordic Naturals', 'nordicnaturals.com');

      expect(result.domain).toBe('nordicnaturals.com');
      expect(result.source).toBe('suggested');
    });

    it('rejects retailer domains: brand="Evereden" suggestedDomain="amazon.com"', async () => {
      // amazon.com doesn't match Evereden
      const result = await resolveAuthoritativeBrandDomain('Evereden', 'amazon.com');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('rejects completely unrelated domain: brand="Prequel" suggestedDomain="healthybeauty.com"', async () => {
      const result = await resolveAuthoritativeBrandDomain('Prequel', 'healthybeauty.com');

      expect(result.domain).toBeNull();
      expect(result.source).toBe('none');
    });

    it('accepts domain that contains brand: brand="Frog Fuel" suggestedDomain="frogfuel.com"', async () => {
      const result = await resolveAuthoritativeBrandDomain('Frog Fuel', 'frogfuel.com');

      expect(result.domain).toBe('frogfuel.com');
      expect(result.source).toBe('suggested');
    });

    it('handles brand with punctuation: brand="Dr. Squatch" suggestedDomain="drsquatch.com"', async () => {
      const result = await resolveAuthoritativeBrandDomain('Dr. Squatch', 'drsquatch.com');

      expect(result.domain).toBe('drsquatch.com');
      expect(result.source).toBe('suggested');
    });

    it('handles brand with suffix: brand="Needed Inc" suggestedDomain="thisisneeded.com"', async () => {
      // "needed" should match after stripping "inc"
      const result = await resolveAuthoritativeBrandDomain('Needed Inc', 'thisisneeded.com');

      expect(result.domain).toBe('thisisneeded.com');
      expect(result.source).toBe('suggested');
    });

    it('registry brands are not affected by mismatch check', async () => {
      // Even if suggested domain doesn't match, registry wins
      setupRegistryMock({ 'bettr': 'performbettr.com' });

      const result = await resolveAuthoritativeBrandDomain('bettr', 'betrhealth.com');

      expect(result.domain).toBe('performbettr.com');
      expect(result.source).toBe('registry');
    });
  });
});
