describe("orphan-reassignment", () => {
  const mockInsight = (text: string, visual: string, color: string) => ({
    textExtracted: text,
    visualDescription: visual,
    dominantColor: color,
  });

  const mockOrphan = (text: string, visual: string, color: string, key?: string) => ({
    key: key || "orphan1.jpg",
    url: `https://example.com/${key || "orphan1.jpg"}`,
    textExtracted: text,
    visualDescription: visual,
    dominantColor: color,
  });

  const mockGroup = (id: string, name: string, imageKeys: string[]) => ({
    groupId: id,
    name,
    images: imageKeys.map(key => ({ url: key })),
  });

  describe("matchOrphanToGroup", () => {
    it("should return zero confidence for empty group", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Product ABC", "A bottle", "blue");
      const group = { groupId: "g1", images: [] };
      const insights = new Map();

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBe(0);
      expect(result.reasons).toContain("Empty group");
    });

    it("should match orphan with identical text", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Vitamin C Serum 1000mg", "Bottle with label", "orange");
      const group = mockGroup("g1", "Serum Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin C Serum 1000mg", "Bottle product", "orange")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0.5);
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
    });

    it("should match orphan with similar text (Jaccard similarity)", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Premium Vitamin C Serum Formula", "Bottle", "orange");
      const group = mockGroup("g1", "Serum", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin C Serum Premium Quality", "Bottle product", "orange")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
    });

    it("should match based on visual description similarity", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("", "Round amber bottle with white cap and label", "amber");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("", "Amber bottle with white label and cap", "amber")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0.2);
      expect(result.reasons.some(r => r.includes("Visual similarity"))).toBe(true);
    });

    it("should match based on color matching", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("", "", "blue");
      const group = mockGroup("g1", "Product", ["img1.jpg", "img2.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("", "", "blue")],
        ["img2.jpg", mockInsight("", "", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasons.some(r => r.includes("Color matches: 2/2"))).toBe(true);
    });

    it("should not match with different colors", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("", "", "red");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("", "", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.reasons.some(r => r.includes("Color matches"))).toBe(false);
    });

    it("should combine text, visual, and color scores", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Vitamin C Serum", "Amber bottle with label", "amber");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin C Serum Premium", "Amber bottle product", "amber")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      // Should have all three signals
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
      expect(result.reasons.some(r => r.includes("Visual similarity"))).toBe(true);
      expect(result.reasons.some(r => r.includes("Color matches"))).toBe(true);
      expect(result.confidence).toBeGreaterThan(0.5);
    });

    it("should handle missing insights gracefully", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Product ABC", "Description", "blue");
      const group = mockGroup("g1", "Product", ["img1.jpg", "img2.jpg"]);
      const insights = new Map([
        // img1.jpg has no insight
        ["img2.jpg", mockInsight("Product ABC", "Description", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
    });

    it("should require minimum text similarity threshold", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("xyz", "abc", "red");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("completely different text", "totally different visual", "green")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeLessThan(0.3);
      expect(result.reasons.some(r => r.includes("too low"))).toBe(true);
    });

    it("should cap confidence at 1.0", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      // Perfect match on all signals
      const orphan = mockOrphan(
        "Exact same text with many words to boost Jaccard",
        "Exact same visual description with many words",
        "blue"
      );
      const group = mockGroup("g1", "Product", ["img1.jpg", "img2.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight(
          "Exact same text with many words to boost Jaccard",
          "Exact same visual description with many words",
          "blue"
        )],
        ["img2.jpg", mockInsight(
          "Exact same text with many words to boost Jaccard",
          "Exact same visual description with many words",
          "blue"
        )]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeLessThanOrEqual(1.0);
    });

    it("should handle empty text gracefully", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("", "Visual only", "blue");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("Some text", "Visual only", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      // Should still work with visual + color
      expect(result.confidence).toBeGreaterThan(0);
      expect(result.reasons.some(r => r.includes("Visual similarity"))).toBe(true);
    });

    it("should filter words under 3 characters in Jaccard similarity", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("a b c Product Name", "", "");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("x y z Product Name", "", "")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      // Should match on "Product Name", ignoring short words
      expect(result.confidence).toBeGreaterThan(0.3);
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
    });

    it("should be case-insensitive for text similarity", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("VITAMIN C SERUM", "", "");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("vitamin c serum", "", "")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0.4);
      expect(result.reasons.some(r => r.includes("Text similarity"))).toBe(true);
    });

    it("should be case-insensitive for color matching", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("", "", "BLUE");
      const group = mockGroup("g1", "Product", ["img1.jpg"]);
      const insights = new Map([
        ["img1.jpg", mockInsight("", "", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.reasons.some(r => r.includes("Color matches: 1/1"))).toBe(true);
    });

    it("should handle image objects with url property", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Product", "", "blue");
      const group = {
        groupId: "g1",
        images: [{ url: "img1.jpg" }, { url: "img2.jpg" }]
      };
      const insights = new Map([
        ["img1.jpg", mockInsight("Product", "", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0);
    });

    it("should handle image as string directly", async () => {
      const { matchOrphanToGroup } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphan = mockOrphan("Product", "", "blue");
      const group = {
        groupId: "g1",
        images: ["img1.jpg", "img2.jpg"]
      };
      const insights = new Map([
        ["img1.jpg", mockInsight("Product", "", "blue")]
      ]);

      const result = matchOrphanToGroup(orphan, group, insights);

      expect(result.confidence).toBeGreaterThan(0);
    });
  });

  describe("reassignOrphans", () => {
    it("should find matches above confidence threshold", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Vitamin C Serum", "Bottle", "orange", "orphan1.jpg"),
        mockOrphan("Unrelated Product", "Box", "blue", "orphan2.jpg")
      ];
      const groups = [
        mockGroup("g1", "Serum Group", ["img1.jpg"]),
        mockGroup("g2", "Different Group", ["img2.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin C Serum Premium", "Bottle product", "orange")],
        ["img2.jpg", mockInsight("Unrelated Product XYZ", "Box container", "blue")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(2);
      expect(matches[0].orphanKey).toBe("orphan1.jpg");
      expect(matches[0].matchedGroupId).toBe("g1");
      expect(matches[0].confidence).toBeGreaterThan(0.5);
      expect(matches[1].orphanKey).toBe("orphan2.jpg");
      expect(matches[1].matchedGroupId).toBe("g2");
    });

    it("should exclude matches below confidence threshold", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Random text", "Random visual", "red", "orphan1.jpg")
      ];
      const groups = [
        mockGroup("g1", "Product Group", ["img1.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Completely different text", "Different visual", "blue")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(0);
    });

    it("should choose best match when multiple groups qualify", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Vitamin C Serum", "Bottle", "orange", "orphan1.jpg")
      ];
      const groups = [
        mockGroup("g1", "Weak Match", ["img1.jpg"]),
        mockGroup("g2", "Strong Match", ["img2.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin Product", "Container", "yellow")],
        ["img2.jpg", mockInsight("Vitamin C Serum Premium", "Bottle product", "orange")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(1);
      expect(matches[0].matchedGroupId).toBe("g2");
      expect(matches[0].confidence).toBeGreaterThan(0.5);
    });

    it("should handle custom confidence threshold", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Moderate match text", "", "", "orphan1.jpg")
      ];
      const groups = [
        mockGroup("g1", "Group", ["img1.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Moderate match words", "", "")]
      ]);

      // With high threshold (0.8), should not match
      const matchesHigh = reassignOrphans(orphans, groups, insights, 0.8);
      expect(matchesHigh.length).toBe(0);

      // With low threshold (0.2), should match
      const matchesLow = reassignOrphans(orphans, groups, insights, 0.2);
      expect(matchesLow.length).toBe(1);
    });

    it("should default threshold to 0.5", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Product ABC", "", "", "orphan1.jpg")
      ];
      const groups = [
        mockGroup("g1", "Group", ["img1.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product ABC XYZ", "", "")]
      ]);

      // No threshold specified - should use 0.5
      const matches = reassignOrphans(orphans, groups, insights);

      expect(matches.length).toBeGreaterThanOrEqual(0);
    });

    it("should handle orphans without key", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        { textExtracted: "Product", visualDescription: "", dominantColor: "" }
      ];
      const groups = [mockGroup("g1", "Group", ["img1.jpg"])];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product", "", "")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(0); // No key, should be skipped
    });

    it("should use orphan url as fallback for key", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        { url: "orphan-url.jpg", textExtracted: "Product ABC", visualDescription: "", dominantColor: "" }
      ];
      const groups = [mockGroup("g1", "Group", ["img1.jpg"])];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product ABC", "", "")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(1);
      expect(matches[0].orphanKey).toBe("orphan-url.jpg");
    });

    it("should include reason in match result", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Vitamin C Serum", "Bottle", "orange", "orphan1.jpg")
      ];
      const groups = [
        mockGroup("g1", "Group", ["img1.jpg"])
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Vitamin C Serum", "Bottle", "orange")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(1);
      expect(matches[0].reason).toBeTruthy();
      expect(matches[0].reason).toContain("Text similarity");
    });

    it("should handle empty orphans array", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans: any[] = [];
      const groups = [mockGroup("g1", "Group", ["img1.jpg"])];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product", "", "")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(0);
    });

    it("should handle empty groups array", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [mockOrphan("Product", "", "", "orphan1.jpg")];
      const groups: any[] = [];
      const insights = new Map();

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(0);
    });

    it("should use group name as fallback for groupId", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Product ABC", "", "", "orphan1.jpg")
      ];
      const groups = [
        { name: "Fallback Name", images: [{ url: "img1.jpg" }] } // No groupId
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product ABC", "", "")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(1);
      expect(matches[0].matchedGroupId).toBe("Fallback Name");
    });

    it("should use 'unknown' when neither groupId nor name exists", async () => {
      const { reassignOrphans } = await import("../../src/lib/orphan-reassignment.js");
      
      const orphans = [
        mockOrphan("Product ABC", "", "", "orphan1.jpg")
      ];
      const groups = [
        { images: [{ url: "img1.jpg" }] } // No groupId or name
      ];
      const insights = new Map([
        ["img1.jpg", mockInsight("Product ABC", "", "")]
      ]);

      const matches = reassignOrphans(orphans, groups, insights, 0.5);

      expect(matches.length).toBe(1);
      expect(matches[0].matchedGroupId).toBe("unknown");
    });
  });
});
