import { parseItemIdsFromXml, checkXmlForErrors } from '../../netlify/functions/ebay-list-active-trading';

describe('ebay-list-active-trading helpers', () => {
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
});
