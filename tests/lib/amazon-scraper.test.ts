describe("amazon-scraper", () => {
  let mockFetch: jest.Mock;

  const mockSearchHtml = (asin: string, priceHtml: string, titleSection: string = "") => `
    <!DOCTYPE html>
    <html>
    <body>
      <div data-asin="${asin}" class="s-result-item">
        ${titleSection}
        <div class="a-section">
          ${priceHtml}
        </div>
      </div>
    </body>
    </html>
  `;

  beforeEach(() => {
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
    jest.spyOn(console, "error").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("scrapeAmazonPrice", () => {
    describe("search query building", () => {
      it("should search with UPC when provided", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST001", '<span class="a-offscreen">$29.99</span>'),
        });

        await scrapeAmazonPrice(undefined, undefined, "123456789012");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("k=123456789012"),
          expect.any(Object)
        );
      });

      it("should search with brand and product when UPC not provided", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST002", '<span class="a-offscreen">$29.99</span>'),
        });

        await scrapeAmazonPrice("TestBrand", "Test Product");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("k=TestBrand%20Test%20Product"),
          expect.any(Object)
        );
      });

      it("should search with brand only", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST003", '<span class="a-offscreen">$29.99</span>'),
        });

        await scrapeAmazonPrice("TestBrand");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("k=TestBrand"),
          expect.any(Object)
        );
      });

      it("should search with product only", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST004", '<span class="a-offscreen">$29.99</span>'),
        });

        await scrapeAmazonPrice(undefined, "Test Product");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.stringContaining("k=Test%20Product"),
          expect.any(Object)
        );
      });

      it("should return null price when no search terms provided", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const result = await scrapeAmazonPrice();

        expect(result.price).toBeNull();
        expect(mockFetch).not.toHaveBeenCalled();
        expect(console.warn).toHaveBeenCalledWith("[amazon-scraper] No search terms provided");
      });

      it("should include proper User-Agent headers", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST005", '<span class="a-offscreen">$29.99</span>'),
        });

        await scrapeAmazonPrice("TestBrand");

        expect(mockFetch).toHaveBeenCalledWith(
          expect.any(String),
          expect.objectContaining({
            headers: expect.objectContaining({
              "User-Agent": expect.stringContaining("Mozilla"),
              "Accept": expect.stringContaining("text/html"),
              "Accept-Language": "en-US,en;q=0.5",
            }),
          })
        );
      });
    });

    describe("HTTP error handling", () => {
      it("should handle fetch failure", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 500,
          statusText: "Internal Server Error",
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
        expect(console.error).toHaveBeenCalledWith(
          "[amazon-scraper] Failed to fetch:",
          500,
          "Internal Server Error"
        );
      });

      it("should handle network errors", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockRejectedValueOnce(new Error("Network error"));

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
        expect(console.error).toHaveBeenCalledWith(
          "[amazon-scraper] Error:",
          expect.any(Error)
        );
      });

      it("should handle 404 responses", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: false,
          status: 404,
          statusText: "Not Found",
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });
    });

    describe("ASIN extraction", () => {
      it("should extract ASIN from search results", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B07XYZ1234", '<span class="a-offscreen">$29.99</span>'),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.asin).toBe("B07XYZ1234");
        expect(result.url).toBe("https://www.amazon.com/dp/B07XYZ1234");
      });

      it("should return null when no products found", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => "<html><body>No results found</body></html>",
        });

        const result = await scrapeAmazonPrice("NonexistentProduct");

        expect(result.price).toBeNull();
        expect(result.asin).toBeUndefined();
        expect(console.warn).toHaveBeenCalledWith(
          "[amazon-scraper] No products found for:",
          "NonexistentProduct"
        );
      });

      it("should handle multiple ASINs and use the first one", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = `
          <div data-asin="B001FIRST1">
            <span class="a-offscreen">$19.99</span>
          </div>
          <div data-asin="B002SECOND">
            <span class="a-offscreen">$29.99</span>
          </div>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.asin).toBe("B001FIRST1");
        expect(result.price).toBe(19.99);
      });
    });

    describe("price extraction patterns", () => {
      it("should extract price from a-price-whole and a-price-fraction pattern", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = `
          <span class="a-price-whole">49</span>
          <span class="a-offscreen">$49.99</span>
          <span class="a-price-fraction">99</span>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST006", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(49.99);
      });

      it("should extract price from simple dollar format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="price">$24.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST007", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(24.99);
      });

      it("should extract price from a-price-whole only (whole dollars)", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-price-whole">35</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST008", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(35);
      });

      it("should extract price from JSON priceAmount", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<script>{"priceAmount":39.99}</script>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST009", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(39.99);
      });

      it("should extract price from a-offscreen (accessibility text)", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$44.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST010", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(44.99);
      });

      it("should use fallback pattern when specific patterns fail", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<div class="custom-price">Price: $54.99</div>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST011", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(54.99);
      });

      it("should try multiple patterns in order", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        // Include multiple patterns, should match the first valid one
        const priceHtml = `
          <span class="a-price-whole">29</span>
          <span class="a-offscreen">$29.99</span>
          <span class="a-price-fraction">99</span>
          <span>Also available for $39.99</span>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST012", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        // Should match the a-price-whole pattern first
        expect(result.price).toBe(29.99);
      });
    });

    describe("price validation", () => {
      it("should reject negative prices", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$-10.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST013", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });

      it("should reject zero prices", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$0.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST014", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });

      it("should reject unreasonably high prices (>$10000)", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$15000.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST015", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });

      it("should accept edge case $9999.99", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$9999.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST016", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(9999.99);
      });

      it("should accept edge case $0.01", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const priceHtml = '<span class="a-offscreen">$0.01</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST017", priceHtml),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBe(0.01);
      });
    });

    describe("pack quantity detection", () => {
      it("should detect 2-Pack format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 2-Pack</h2>';
        const priceHtml = '<span class="a-offscreen">$39.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST018", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(2);
        expect(result.price).toBe(39.99);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect '3 Pack' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 3 Pack</h2>';
        const priceHtml = '<span class="a-offscreen">$60.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST019", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(3);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect 'Pack of 4' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product Pack of 4</h2>';
        const priceHtml = '<span class="a-offscreen">$80.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST020", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(4);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect '5 Count' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 5 Count</h2>';
        const priceHtml = '<span class="a-offscreen">$100.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST021", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(5);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect 'Set of 6' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product Set of 6</h2>';
        const priceHtml = '<span class="a-offscreen">$120.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST022", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(6);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect '(12 pcs)' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product (12 pcs)</h2>';
        const priceHtml = '<span class="a-offscreen">$240.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST023", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(12);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should detect '10-Piece' format", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 10-Piece Set</h2>';
        const priceHtml = '<span class="a-offscreen">$200.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST024", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(10);
        expect(result.pricePerUnit).toBe(20.00);
      });

      it("should default to pack quantity 1 for single items", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product Single</h2>';
        const priceHtml = '<span class="a-offscreen">$29.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST025", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(1);
        expect(result.pricePerUnit).toBe(29.99);
      });

      it("should ignore unreasonably large pack quantities", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 500-Pack</h2>';
        const priceHtml = '<span class="a-offscreen">$29.99</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST026", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        // Should default to 1 when quantity > 100
        expect(result.packQuantity).toBe(1);
        expect(result.pricePerUnit).toBe(29.99);
      });

      it("should round price per unit to 2 decimals", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const titleSection = '<h2>Test Product 3-Pack</h2>';
        const priceHtml = '<span class="a-offscreen">$10.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST027", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(3);
        expect(result.price).toBe(10.00);
        expect(result.pricePerUnit).toBe(3.33); // 10/3 = 3.333... -> 3.33
      });

      it("should use first pack pattern found", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        // Multiple pack indicators - should use first one
        const titleSection = '<h2>Test Product 2-Pack Set of 5</h2>';
        const priceHtml = '<span class="a-offscreen">$40.00</span>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => mockSearchHtml("B00TEST028", priceHtml, titleSection),
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.packQuantity).toBe(2);
        expect(result.pricePerUnit).toBe(20.00);
      });
    });

    describe("edge cases and error scenarios", () => {
      it("should handle ASIN found but no price in section", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = '<div data-asin="B00TEST029">No price here</div>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
        expect(result.asin).toBe("B00TEST029");
        expect(console.warn).toHaveBeenCalledWith(
          "[amazon-scraper] Could not extract price from product section"
        );
      });

      it("should handle ASIN extraction but section not found", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        // ASIN exists but data-asin attribute doesn't match
        const html = '<div>ASIN: B00TEST030</div>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });

      it("should handle malformed HTML gracefully", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = '<div data-asin="B00TEST031"><span class="broken>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
        expect(result.asin).toBe("B00TEST031");
      });

      it("should handle empty search results HTML", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => "",
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
      });

      it("should handle response.text() throwing error", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => {
            throw new Error("Failed to read response");
          },
        });

        const result = await scrapeAmazonPrice("TestBrand");

        expect(result.price).toBeNull();
        expect(console.error).toHaveBeenCalledWith(
          "[amazon-scraper] Error:",
          expect.any(Error)
        );
      });

      it("should log section preview when price extraction fails", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = '<div data-asin="B00TEST032">Some content without price</div>';

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        await scrapeAmazonPrice("TestBrand");

        expect(console.warn).toHaveBeenCalledWith(
          "[amazon-scraper] Section preview:",
          expect.stringContaining("Some content")
        );
      });
    });

    describe("real-world scenarios", () => {
      it("should handle typical Amazon search result", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = `
          <div data-asin="B08XYZ5678" class="s-result-item">
            <h2>Premium Brand Wellness Supplement - 60 Count</h2>
            <div class="a-section a-spacing-none">
              <span class="a-price" data-a-size="xl">
                <span class="a-offscreen">$34.99</span>
                <span aria-hidden="true">
                  <span class="a-price-symbol">$</span>
                  <span class="a-price-whole">34</span>
                  <span class="a-price-decimal">.</span>
                  <span class="a-price-fraction">99</span>
                </span>
              </span>
            </div>
          </div>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("Premium Brand", "Wellness Supplement");

        expect(result.price).toBe(34.99);
        expect(result.asin).toBe("B08XYZ5678");
        expect(result.url).toBe("https://www.amazon.com/dp/B08XYZ5678");
        expect(result.packQuantity).toBe(60);
        expect(result.pricePerUnit).toBe(0.58);
      });

      it("should handle multi-pack with complex title", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = `
          <div data-asin="B09ABC1234">
            <h2>TestBrand Premium Formula - 2-Pack (120 Count Total)</h2>
            <span class="a-offscreen">$49.98</span>
          </div>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("TestBrand", "Premium Formula");

        expect(result.price).toBe(49.98);
        expect(result.packQuantity).toBe(2);
        expect(result.pricePerUnit).toBe(24.99);
      });

      it("should handle product with special characters in title", async () => {
        const { scrapeAmazonPrice } = await import("../../src/lib/amazon-scraper.js");

        const html = `
          <div data-asin="B0AXYZ7890">
            <h2>Test & Co. Product (3-Pack) - Premium™</h2>
            <span class="a-offscreen">$59.97</span>
          </div>
        `;

        mockFetch.mockResolvedValueOnce({
          ok: true,
          text: async () => html,
        });

        const result = await scrapeAmazonPrice("Test & Co.", "Product Premium");

        expect(result.price).toBe(59.97);
        expect(result.packQuantity).toBe(3);
        expect(result.pricePerUnit).toBe(19.99);
      });
    });
  });
});
