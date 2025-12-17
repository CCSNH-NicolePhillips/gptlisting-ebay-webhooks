import { parseItemIdsFromXml, checkXmlForErrors, shouldExcludeActiveItem, extractItemIdsFromContainer } from '../../netlify/functions/ebay-list-active-trading';

describe('ebay-list-active-trading helpers', () => {
  describe('extractItemIdsFromContainer', () => {
    it('should extract ItemIDs only from specified container', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>111</ItemID>
        <Title>Unsold Item 1</Title>
      </Item>
      <Item>
        <ItemID>222</ItemID>
        <Title>Unsold Item 2</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>333</ItemID>
        <Title>Active Item 1</Title>
      </Item>
      <Item>
        <ItemID>444</ItemID>
        <Title>Active Item 2</Title>
      </Item>
      <Item>
        <ItemID>555</ItemID>
        <Title>Active Item 3</Title>
      </Item>
    </ItemArray>
  </ActiveList>
</GetMyeBaySellingResponse>`;
      
      const result = extractItemIdsFromContainer(xml, 'UnsoldList');
      expect(result.size).toBe(2);
      expect(result.has('111')).toBe(true);
      expect(result.has('222')).toBe(true);
      expect(result.has('333')).toBe(false);
      expect(result.has('444')).toBe(false);
      expect(result.has('555')).toBe(false);
    });

    it('should return empty Set when container not found', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
      </Item>
    </ItemArray>
  </ActiveList>
</GetMyeBaySellingResponse>`;
      
      const result = extractItemIdsFromContainer(xml, 'UnsoldList');
      expect(result.size).toBe(0);
    });

    it('should handle container with no ItemIDs', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray />
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = extractItemIdsFromContainer(xml, 'UnsoldList');
      expect(result.size).toBe(0);
    });

    it('should extract from ActiveList container when specified', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>AAA</ItemID>
      </Item>
    </ItemArray>
  </UnsoldList>
  <ActiveList>
    <ItemArray>
      <Item>
        <ItemID>BBB</ItemID>
      </Item>
      <Item>
        <ItemID>CCC</ItemID>
      </Item>
    </ItemArray>
  </ActiveList>
</GetMyeBaySellingResponse>`;
      
      const result = extractItemIdsFromContainer(xml, 'ActiveList');
      expect(result.size).toBe(2);
      expect(result.has('BBB')).toBe(true);
      expect(result.has('CCC')).toBe(true);
      expect(result.has('AAA')).toBe(false);
    });

    it('should handle container with attributes', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList includeWatchCount="true" pagination="true">
    <ItemArray>
      <Item>
        <ItemID>999</ItemID>
        <Title>Test</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = extractItemIdsFromContainer(xml, 'UnsoldList');
      expect(result.size).toBe(1);
      expect(result.has('999')).toBe(true);
    });
  });

  describe('parseItemIdsFromXml', () => {
    it('should return empty Set for XML with no ItemIDs', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray />
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(0);
    });

    it('should extract single ItemID', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(1);
      expect(result.has('123456789')).toBe(true);
    });

    it('should extract 2 ItemIDs and return Set size 2', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Test Item 1</Title>
      </Item>
      <Item>
        <ItemID>987654321</ItemID>
        <Title>Test Item 2</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(2);
      expect(result.has('123456789')).toBe(true);
      expect(result.has('987654321')).toBe(true);
    });

    it('should extract multiple ItemIDs from complex XML', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>111111111</ItemID>
        <Title>Item One</Title>
      </Item>
      <Item>
        <ItemID>222222222</ItemID>
        <Title>Item Two</Title>
      </Item>
      <Item>
        <ItemID>333333333</ItemID>
        <Title>Item Three</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(3);
      expect(result.has('111111111')).toBe(true);
      expect(result.has('222222222')).toBe(true);
      expect(result.has('333333333')).toBe(true);
    });

    it('should handle duplicate ItemIDs and return unique values', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
      </Item>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Duplicate Item</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(1);
      expect(result.has('123456789')).toBe(true);
    });
  });

  describe('checkXmlForErrors', () => {
    it('should not throw for successful response', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray />
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).not.toThrow();
    });

    it('should throw when XML contains Ack Failure', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ShortMessage>Invalid token</ShortMessage>
    <LongMessage>The token provided is invalid or expired</LongMessage>
    <ErrorCode>931</ErrorCode>
  </Errors>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).toThrow('eBay API returned error');
    });

    it('should throw when XML contains Ack PartialFailure', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>PartialFailure</Ack>
  <Errors>
    <ShortMessage>Some items failed</ShortMessage>
  </Errors>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).toThrow('eBay API returned error');
    });

    it('should include XML snippet in error message', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ErrorCode>12345</ErrorCode>
  </Errors>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).toThrow(/eBay API returned error:/);
      expect(() => checkXmlForErrors(xml)).toThrow(/<Ack>Failure<\/Ack>/);
    });

    it('should not throw for Warning ack', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Warning</Ack>
  <UnsoldList>
    <ItemArray />
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).not.toThrow();
    });
  });

  describe('integration scenarios', () => {
    it('should parse ItemIDs from success response without throwing', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Success</Ack>
  <UnsoldList>
    <ItemArray>
      <Item>
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
      </Item>
      <Item>
        <ItemID>987654321</ItemID>
        <Title>Another Item</Title>
      </Item>
    </ItemArray>
  </UnsoldList>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).not.toThrow();
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(2);
    });

    it('should throw before parsing when response contains Failure', () => {
      const xml = `<?xml version="1.0" encoding="UTF-8"?>
<GetMyeBaySellingResponse xmlns="urn:ebay:apis:eBLBaseComponents">
  <Ack>Failure</Ack>
  <Errors>
    <ErrorCode>931</ErrorCode>
  </Errors>
</GetMyeBaySellingResponse>`;
      
      expect(() => checkXmlForErrors(xml)).toThrow();
      // Should still parse ItemIDs even from error response (though Set would be empty)
      const result = parseItemIdsFromXml(xml);
      expect(result.size).toBe(0);
    });
  });

  describe('shouldExcludeActiveItem', () => {
    const nowMs = Date.parse('2025-12-17T12:00:00Z'); // Fixed timestamp for tests
    const unsoldSet = new Set(['999888777']); // Sample unsold item

    it('should exclude item with TimeLeft=PT0S (ended)', () => {
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>PT0S</TimeLeft>
        <EndTime>2025-12-17T11:00:00Z</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe('timeLeftPT0S');
    });

    it('should exclude item with EndTime in the past', () => {
      const pastTime = '2025-12-17T10:00:00Z'; // 2 hours before nowMs
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>P0DT0H0M0S</TimeLeft>
        <EndTime>${pastTime}</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe('endTimePast');
    });

    it('should NOT exclude item with EndTime in the future', () => {
      const futureTime = '2025-12-20T12:00:00Z'; // 3 days after nowMs
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>P3DT0H0M0S</TimeLeft>
        <EndTime>${futureTime}</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe(null);
    });

    it('should exclude item in unsold set', () => {
      const itemXml = `
        <ItemID>999888777</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>P5DT0H0M0S</TimeLeft>
        <EndTime>2025-12-22T12:00:00Z</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe('unsold');
    });

    it('should NOT exclude item with no EndTime and no TimeLeft', () => {
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <SKU>TESTSKU123</SKU>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe(null);
    });

    it('should NOT exclude item within 60s clock jitter buffer', () => {
      // EndTime is 30 seconds ago (within 60s buffer)
      const recentTime = new Date(nowMs - 30_000).toISOString();
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>P0DT0H0M0S</TimeLeft>
        <EndTime>${recentTime}</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe(null);
    });

    it('should exclude item beyond 60s clock jitter buffer', () => {
      // EndTime is 90 seconds ago (beyond 60s buffer)
      const oldTime = new Date(nowMs - 90_000).toISOString();
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>P0DT0H0M0S</TimeLeft>
        <EndTime>${oldTime}</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe('endTimePast');
    });

    it('should handle item with no ItemID gracefully', () => {
      const itemXml = `
        <Title>Test Item</Title>
        <TimeLeft>P5DT0H0M0S</TimeLeft>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe(null); // No ItemID = don't exclude
    });

    it('should exclude based on PT0S even if EndTime is in future', () => {
      // Edge case: TimeLeft=PT0S but EndTime is future (shouldn't happen, but PT0S wins)
      const futureTime = '2025-12-20T12:00:00Z';
      const itemXml = `
        <ItemID>123456789</ItemID>
        <Title>Test Item</Title>
        <TimeLeft>PT0S</TimeLeft>
        <EndTime>${futureTime}</EndTime>
      `;
      
      const result = shouldExcludeActiveItem(itemXml, unsoldSet, nowMs);
      expect(result).toBe('timeLeftPT0S'); // PT0S takes precedence
    });
  });
});
