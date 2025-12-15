describe("taxonomy-autofill", () => {
  beforeEach(() => {
    jest.spyOn(console, "log").mockImplementation();
    jest.spyOn(console, "warn").mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const mockCategory = (itemSpecifics: any[] = []): any => ({
    id: "cat123",
    title: "Test Category",
    slug: "test-category",
    marketplaceId: "EBAY_US",
    version: 1,
    updatedAt: Date.now(),
    itemSpecifics,
  });

  describe("buildItemSpecifics", () => {
    describe("basic functionality", () => {
      it("should return empty aspects for empty category and group", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {};

        const result = buildItemSpecifics(cat, group);

        // Should have Brand fallback
        expect(result.Brand).toEqual(["Unbranded"]);
      });

      it("should extract group value from brand field", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Brand", type: "string", source: "group", from: "brand" },
        ]);
        const group = { brand: "Nike" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Nike"]);
      });

      it("should extract group value from product field", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Product", type: "string", source: "group", from: "product" },
        ]);
        const group = { product: "Running Shoes" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Product).toEqual(["Running Shoes"]);
      });

      it("should use static value when source is static", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Type", type: "string", source: "static", static: "Electronics" },
        ]);
        const group = {};

        const result = buildItemSpecifics(cat, group);

        expect(result.Type).toEqual(["Electronics"]);
      });

      it("should handle array values in group fields", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Color", type: "string", source: "group", from: "color" },
        ]);
        const group = { color: ["Red", "Blue"] };

        const result = buildItemSpecifics(cat, group);

        expect(result.Color).toEqual(["Red"]);
      });

      it("should trim whitespace from extracted values", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Brand", type: "string", source: "group", from: "brand" },
        ]);
        const group = { brand: "  Nike  " };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Nike"]);
      });

      it("should skip null or undefined values", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Manufacturer", type: "string", source: "group", from: "manufacturer" },
        ]);
        const group = { manufacturer: null };

        const result = buildItemSpecifics(cat, group);

        expect(result.Manufacturer).toBeUndefined();
      });

      it("should skip empty string values", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Model", type: "string", source: "group", from: "model" },
        ]);
        const group = { model: "" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Model).toEqual(["Does Not Apply"]);
      });
    });

    describe("required aspects", () => {
      it("should create empty array for required aspects when missing", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Size", type: "string", required: true, source: "group", from: "size" },
        ]);
        const group = {};

        const result = buildItemSpecifics(cat, group);

        expect(result.Size).toEqual(["Does Not Apply"]);
      });

      it("should populate required aspects when value exists", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Size", type: "string", required: true, source: "group", from: "size" },
        ]);
        const group = { size: "Large" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Size).toEqual(["Large"]);
      });
    });

    describe("group.aspects merging", () => {
      it("should merge aspects from group.aspects object", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Color: "Blue",
            Size: "Medium",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Color).toEqual(["Blue"]);
        expect(result.Size).toEqual(["Medium"]);
      });

      it("should handle array values in group.aspects", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Color: ["Red", "Blue"],
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Color).toEqual(["Red", "Blue"]);
      });

      it("should filter out placeholder values", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Color: "Select",
            Size: "...",
            Material: "Not applicable",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Color).toBeUndefined();
        expect(result.Size).toBeUndefined();
        expect(result.Material).toBeUndefined();
      });

      it("should keep valid long values even if they contain placeholder words", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Description: "This value is a detailed description that contains select words but is valid",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Description).toEqual([
          "This value is a detailed description that contains select words but is valid",
        ]);
      });

      it("should filter empty values from arrays", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Features: ["Feature 1", "", "select", "Feature 2"],
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Features).toEqual(["Feature 1", "Feature 2"]);
      });

      it("should skip aspects with only placeholder values", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Color: ["select", "choose", "..."],
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Color).toBeUndefined();
      });

      it("should handle non-object aspects gracefully", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: "not an object",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["TestBrand"]);
      });
    });

    describe("Brand handling", () => {
      it("should use group.brand for Brand aspect", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "Nike" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Nike"]);
      });

      it("should fallback to manufacturer for Brand", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { manufacturer: "Samsung" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Samsung"]);
      });

      it("should extract Brand from product name", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { product: "Apple iPhone 13" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Apple"]);
      });

      it("should use Unbranded as fallback", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { product: "Generic Item" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Unbranded"]);
      });

      it("should not override existing Brand from aspects", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "OldBrand",
          aspects: {
            Brand: "NewBrand",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["NewBrand"]);
      });
    });

    describe("common defaults", () => {
      it("should auto-fill Type with Other", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "TestBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Type).toEqual(["Other"]);
      });

      it("should auto-fill Model with Does Not Apply", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "TestBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Model).toEqual(["Does Not Apply"]);
      });

      it("should auto-fill MPN with Does Not Apply", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "TestBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.MPN).toEqual(["Does Not Apply"]);
      });

      it("should not override existing common defaults", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = {
          brand: "TestBrand",
          aspects: {
            Type: "Electronics",
            Model: "ABC123",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Type).toEqual(["Electronics"]);
        expect(result.Model).toEqual(["ABC123"]);
      });
    });

    describe("Formulation inference", () => {
      it("should infer Liquid formulation from keyText", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "VitaminBrand",
          keyText: ["Vitamin C Liquid Drops"],
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Liquid"]);
      });

      it("should infer Capsule formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "SupplementBrand",
          product: "Vitamin D3 Capsules 60 Count",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Capsule"]);
      });

      it("should infer Tablet formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "HealthBrand",
          product: "Multivitamin Tablets",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Tablet"]);
      });

      it("should infer Powder formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "ProteinBrand",
          product: "Whey Protein Powder Mix",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Powder"]);
      });

      it("should infer Gummy formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "VitaminBrand",
          product: "Vitamin D Gummies",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Gummy"]);
      });

      it("should infer Cream formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "SkincareBrand",
          product: "Moisturizing Cream",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Cream"]);
      });

      it("should infer Gel formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "PainReliefBrand",
          product: "Cooling Gel",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Gel"]);
      });

      it("should default to Other when formulation unclear", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "HealthBrand",
          product: "Vitamin Supplement",
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Other"]);
      });

      it("should prefer keyText over product name for formulation", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
        ]);
        const group = {
          brand: "Brand",
          product: "Supplement Capsules",
          keyText: ["Liquid Drops 1000mg"],
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Liquid"]);
      });
    });

    describe("other required aspect defaults", () => {
      it("should auto-fill Main Purpose with General Wellness", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Main Purpose", type: "string", required: true },
        ]);
        const group = { brand: "HealthBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result["Main Purpose"]).toEqual(["General Wellness"]);
      });

      it("should auto-fill Features with See Description", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Features", type: "string", required: true },
        ]);
        const group = { brand: "Brand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Features).toEqual(["See Description"]);
      });

      it("should auto-fill Active Ingredients with See Description", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Active Ingredients", type: "string", required: true },
        ]);
        const group = { brand: "Brand" };

        const result = buildItemSpecifics(cat, group);

        expect(result["Active Ingredients"]).toEqual(["See Description"]);
      });

      it("should not override provided required aspects", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Formulation", type: "string", required: true },
          { name: "Main Purpose", type: "string", required: true },
        ]);
        const group = {
          brand: "Brand",
          aspects: {
            Formulation: "Capsule",
            "Main Purpose": "Immune Support",
          },
        };

        const result = buildItemSpecifics(cat, group);

        expect(result.Formulation).toEqual(["Capsule"]);
        expect(result["Main Purpose"]).toEqual(["Immune Support"]);
      });
    });

    describe("edge cases", () => {
      it("should handle empty itemSpecifics array", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "TestBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["TestBrand"]);
      });

      it("should handle missing itemSpecifics property", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = { ...mockCategory([]) };
        delete cat.itemSpecifics;
        const group = { brand: "TestBrand" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["TestBrand"]);
      });

      it("should handle group with no relevant fields", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { irrelevantField: "value" };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Unbranded"]);
      });

      it("should convert non-string group values to strings", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([
          { name: "Size", type: "string", source: "group", from: "size" },
        ]);
        const group = { size: 42 };

        const result = buildItemSpecifics(cat, group);

        expect(result.Size).toEqual(["42"]);
      });

      it("should handle empty Brand after trimming", async () => {
        const { buildItemSpecifics } = await import("../../src/lib/taxonomy-autofill.js");

        const cat = mockCategory([]);
        const group = { brand: "   " };

        const result = buildItemSpecifics(cat, group);

        expect(result.Brand).toEqual(["Unbranded"]);
      });
    });
  });
});
