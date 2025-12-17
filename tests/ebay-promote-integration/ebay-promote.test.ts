describe("ebay-promote", () => {
  let mockFetch: jest.Mock;

  beforeEach(() => {
    jest.clearAllMocks();
    mockFetch = jest.fn();
    global.fetch = mockFetch;
    
    // Set up environment for ensureAccess stub
    process.env.EBAY_ACCESS_TOKEN = "test-token";
    process.env.EBAY_API_HOST = "https://api.ebay.com";
  });

  describe("createCampaign", () => {
    it("should create a campaign successfully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            campaignId: "camp123",
            campaignName: "Test Campaign",
            campaignStatus: "RUNNING",
            marketplaceId: "EBAY_US",
            fundingStrategy: {
              fundingModel: "COST_PER_SALE",
              bidPercentage: "5.0",
            },
            startDate: "2024-01-01T00:00:00Z",
          }),
      });

      const { createCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createCampaign("user123", {
        campaignName: "Test Campaign",
        marketplaceId: "EBAY_US",
        fundingStrategy: {
          fundingModel: "COST_PER_SALE",
          bidPercentage: "5.0",
        },
        startDate: "2024-01-01T00:00:00Z",
      });

      expect(result.campaignId).toBe("camp123");
      expect(result.campaignName).toBe("Test Campaign");
      expect(result.campaignStatus).toBe("RUNNING");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            Authorization: "Bearer test-token",
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("should throw error on API failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Invalid request",
      });

      const { createCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(
        createCampaign("user123", {
          campaignName: "Test Campaign",
          marketplaceId: "EBAY_US",
          fundingStrategy: {
            fundingModel: "COST_PER_SALE",
            bidPercentage: "5.0",
          },
          startDate: "2024-01-01T00:00:00Z",
        })
      ).rejects.toThrow("Campaign creation failed 400: Invalid request");
    });

    it("should include endDate when provided", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            campaignId: "camp123",
            campaignName: "Test Campaign",
            campaignStatus: "RUNNING",
            marketplaceId: "EBAY_US",
            fundingStrategy: {
              fundingModel: "COST_PER_SALE",
              bidPercentage: "10.0",
            },
            startDate: "2024-01-01T00:00:00Z",
            endDate: "2024-12-31T23:59:59Z",
          }),
      });

      const { createCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createCampaign("user123", {
        campaignName: "Test Campaign",
        marketplaceId: "EBAY_US",
        fundingStrategy: {
          fundingModel: "COST_PER_SALE",
          bidPercentage: "10.0",
        },
        startDate: "2024-01-01T00:00:00Z",
        endDate: "2024-12-31T23:59:59Z",
      });

      expect(result.endDate).toBe("2024-12-31T23:59:59Z");
    });
  });

  describe("getCampaign", () => {
    it("should fetch campaign details", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            campaignId: "camp123",
            campaignName: "Test Campaign",
            campaignStatus: "RUNNING",
            marketplaceId: "EBAY_US",
            fundingStrategy: {
              fundingModel: "COST_PER_SALE",
              bidPercentage: "7.5",
            },
            startDate: "2024-01-01T00:00:00Z",
          }),
      });

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getCampaign("user123", "camp123");

      expect(result.campaignId).toBe("camp123");
      expect(result.fundingStrategy.bidPercentage).toBe("7.5");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123",
        expect.objectContaining({
          method: "GET",
        })
      );
    });

    it("should URL encode campaign ID", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            campaignId: "camp/123",
            campaignName: "Test",
            campaignStatus: "RUNNING",
            marketplaceId: "EBAY_US",
            fundingStrategy: { fundingModel: "COST_PER_SALE", bidPercentage: "5.0" },
            startDate: "2024-01-01T00:00:00Z",
          }),
      });

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await getCampaign("user123", "camp/123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp%2F123",
        expect.anything()
      );
    });

    it("should throw error on fetch failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Campaign not found",
      });

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(getCampaign("user123", "camp999")).rejects.toThrow(
        "Campaign fetch failed 404: Campaign not found"
      );
    });
  });

  describe("updateCampaign", () => {
    it("should update campaign successfully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { updateCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await updateCampaign("user123", "camp123", {
        campaignStatus: "PAUSED",
      });

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123",
        expect.objectContaining({
          method: "PUT",
          body: JSON.stringify({ campaignStatus: "PAUSED" }),
        })
      );
    });

    it("should update campaign bid percentage", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { updateCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await updateCampaign("user123", "camp123", {
        fundingStrategy: {
          fundingModel: "COST_PER_SALE",
          bidPercentage: "15.0",
        },
      });

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.fundingStrategy.bidPercentage).toBe("15.0");
    });

    it("should throw error on update failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 400,
        text: async () => "Invalid status",
      });

      const { updateCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(
        updateCampaign("user123", "camp123", { campaignStatus: "INVALID" as any })
      ).rejects.toThrow("Campaign update failed 400: Invalid status");
    });
  });

  describe("deleteCampaign", () => {
    it("should delete campaign successfully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { deleteCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await deleteCampaign("user123", "camp123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });

    it("should throw error on deletion failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 403,
        text: async () => "Permission denied",
      });

      const { deleteCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(deleteCampaign("user123", "camp123")).rejects.toThrow(
        "Campaign deletion failed 403: Permission denied"
      );
    });
  });

  describe("createAds", () => {
    it("should create ads successfully with normal response", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                adId: "ad123",
                listingId: "177650915431",
                bidPercentage: "5.0",
              },
            ],
          }),
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createAds("user123", "camp123", {
        listingId: "177650915431",
        bidPercentage: "5.0",
      });

      expect(result.ads).toHaveLength(1);
      expect(result.ads[0].adId).toBe("ad123");
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123/ad",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "Content-Type": "application/json",
          }),
        })
      );
    });

    it("should handle empty response from eBay (newly synced listings)", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createAds("user123", "camp123", {
        listingId: "177681098666",
        bidPercentage: "5.0",
      });

      expect(result.ads).toHaveLength(0);
      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123/ad",
        expect.objectContaining({
          method: "POST",
        })
      );
    });

    it("should handle whitespace-only response from eBay", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "   \n  \t  ",
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createAds("user123", "camp123", {
        listingId: "177681098666",
        bidPercentage: "5.0",
      });

      expect(result.ads).toHaveLength(0);
    });

    it("should create ads successfully (legacy bulk format)", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                adId: "ad123",
                inventoryReferenceId: "SKU123",
                statusCode: 200,
              },
              {
                adId: "ad124",
                inventoryReferenceId: "SKU124",
                statusCode: 200,
              },
            ],
          }),
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createAds("user123", "camp123", [
        {
          bidPercentage: "5.0",
          inventoryReferenceId: "SKU123",
          inventoryReferenceType: "INVENTORY_ITEM",
        },
        {
          bidPercentage: "7.0",
          inventoryReferenceId: "SKU124",
          inventoryReferenceType: "INVENTORY_ITEM",
        },
      ]);

      expect(result.ads).toHaveLength(2);
      expect(result.ads[0].adId).toBe("ad123");
      expect(result.ads[1].adId).toBe("ad124");
    });

    it("should handle ad creation errors", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                adId: "ad123",
                inventoryReferenceId: "SKU123",
                statusCode: 200,
              },
              {
                inventoryReferenceId: "SKU124",
                statusCode: 400,
                errors: [{ message: "Invalid SKU" }],
              },
            ],
          }),
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await createAds("user123", "camp123", [
        {
          bidPercentage: "5.0",
          inventoryReferenceId: "SKU123",
          inventoryReferenceType: "INVENTORY_ITEM",
        },
        {
          bidPercentage: "5.0",
          inventoryReferenceId: "SKU124",
          inventoryReferenceType: "INVENTORY_ITEM",
        },
      ]);

      expect(result.ads[0].adId).toBe("ad123");
      expect(result.ads[1].statusCode).toBe(400);
      expect(result.ads[1].errors).toBeDefined();
    });

    it("should throw error on API failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal server error",
      });

      const { createAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(
        createAds("user123", "camp123", [
          {
            bidPercentage: "5.0",
            inventoryReferenceId: "SKU123",
            inventoryReferenceType: "INVENTORY_ITEM",
          },
        ])
      ).rejects.toThrow("Ad creation failed 500: Internal server error");
    });
  });

  describe("getAds", () => {
    it("should fetch ads with default pagination", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                adId: "ad123",
                bidPercentage: "5.0",
                inventoryReferenceId: "SKU123",
                inventoryReferenceType: "INVENTORY_ITEM",
                adStatus: "ACTIVE",
              },
            ],
            total: 1,
          }),
      });

      const { getAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getAds("user123", "camp123");

      expect(result.ads).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(result.ads[0].adId).toBe("ad123");
    });

    it("should support limit and offset parameters", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [],
            total: 50,
          }),
      });

      const { getAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      await getAds("user123", "camp123", { limit: 10, offset: 20 });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("limit=10"),
        expect.anything()
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("offset=20"),
        expect.anything()
      );
    });

    it("should return empty array when no ads found", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({}),
      });

      const { getAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getAds("user123", "camp123");

      expect(result.ads).toEqual([]);
      expect(result.total).toBe(0);
    });

    it("should throw error on fetch failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Campaign not found",
      });

      const { getAds } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(getAds("user123", "camp999")).rejects.toThrow(
        "Ads fetch failed 404: Campaign not found"
      );
    });
  });

  describe("deleteAd", () => {
    it("should delete ad successfully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { deleteAd } = await import("../../ebay-promote-integration/ebay-promote.js");

      await deleteAd("user123", "camp123", "ad123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123/ad/ad123",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });

    it("should URL encode IDs", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { deleteAd } = await import("../../ebay-promote-integration/ebay-promote.js");

      await deleteAd("user123", "camp/123", "ad/456");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp%2F123/ad/ad%2F456",
        expect.anything()
      );
    });

    it("should throw error on deletion failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Ad not found",
      });

      const { deleteAd } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(deleteAd("user123", "camp123", "ad999")).rejects.toThrow(
        "Ad deletion failed 404: Ad not found"
      );
    });
  });

  describe("enablePromotedListings", () => {
    it("should enable promoted listings with existing campaign", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                adId: "ad123",
                inventoryReferenceId: "SKU123",
                statusCode: 200,
              },
            ],
          }),
      });

      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      const result = await enablePromotedListings("user123", "SKU123", 5.0, {
        campaignId: "camp123",
      });

      expect(result.campaignId).toBe("camp123");
      expect(result.adId).toBe("ad123");
    });

    it("should create campaign when not provided", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          // Campaign creation
          return Promise.resolve({
            ok: true,
            text: async () =>
              JSON.stringify({
                campaignId: "camp456",
                campaignName: "DraftPilot Campaign - 2025-12-15",
                campaignStatus: "RUNNING",
                marketplaceId: "EBAY_US",
                fundingStrategy: {
                  fundingModel: "COST_PER_SALE",
                  bidPercentage: "8.0",
                },
                startDate: new Date().toISOString(),
              }),
          });
        } else {
          // Ad creation
          return Promise.resolve({
            ok: true,
            text: async () =>
              JSON.stringify({
                ads: [
                  {
                    adId: "ad789",
                    inventoryReferenceId: "SKU789",
                    statusCode: 200,
                  },
                ],
              }),
          });
        }
      });

      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      const result = await enablePromotedListings("user123", "SKU789", 8.0);

      expect(result.campaignId).toBe("camp456");
      expect(result.adId).toBe("ad789");
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("should use custom campaign name", async () => {
      let callCount = 0;
      mockFetch.mockImplementation(() => {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            text: async () =>
              JSON.stringify({
                campaignId: "camp999",
                campaignName: "Custom Campaign",
                campaignStatus: "RUNNING",
                marketplaceId: "EBAY_US",
                fundingStrategy: {
                  fundingModel: "COST_PER_SALE",
                  bidPercentage: "10.0",
                },
                startDate: new Date().toISOString(),
              }),
          });
        } else {
          return Promise.resolve({
            ok: true,
            text: async () =>
              JSON.stringify({
                ads: [
                  {
                    adId: "ad111",
                    inventoryReferenceId: "SKU111",
                    statusCode: 200,
                  },
                ],
              }),
          });
        }
      });

      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      await enablePromotedListings("user123", "SKU111", 10.0, {
        campaignName: "Custom Campaign",
      });

      const firstCallBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(firstCallBody.campaignName).toBe("Custom Campaign");
    });

    it("should validate ad rate minimum", async () => {
      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      await expect(
        enablePromotedListings("user123", "SKU123", 0.5, { campaignId: "camp123" })
      ).rejects.toThrow("Ad rate must be between 1% and 20%");
    });

    it("should validate ad rate maximum", async () => {
      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      await expect(
        enablePromotedListings("user123", "SKU123", 25.0, { campaignId: "camp123" })
      ).rejects.toThrow("Ad rate must be between 1% and 20%");
    });

    it("should throw error when ad creation fails", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            ads: [
              {
                inventoryReferenceId: "SKU123",
                statusCode: 400,
                errors: [{ message: "Invalid SKU" }],
              },
            ],
          }),
      });

      const { enablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      await expect(
        enablePromotedListings("user123", "SKU123", 5.0, { campaignId: "camp123" })
      ).rejects.toThrow("Failed to create ad for SKU SKU123");
    });
  });

  describe("disablePromotedListings", () => {
    it("should disable promoted listings by deleting ad", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { disablePromotedListings } = await import(
        "../../ebay-promote-integration/ebay-promote.js"
      );

      await disablePromotedListings("user123", "camp123", "ad123");

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123/ad/ad123",
        expect.objectContaining({
          method: "DELETE",
        })
      );
    });
  });

  describe("updateAdRate", () => {
    it("should update ad rate successfully using update_bid endpoint", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { updateAdRate } = await import("../../ebay-promote-integration/ebay-promote.js");

      await updateAdRate("user123", "camp123", "ad123", 10.0);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://api.ebay.com/sell/marketing/v1/ad_campaign/camp123/ad/ad123/update_bid",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ bidPercentage: "10" }),
        })
      );
    });

    it("should convert numeric rate to string", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { updateAdRate } = await import("../../ebay-promote-integration/ebay-promote.js");

      await updateAdRate("user123", "camp123", "ad123", 7.5);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.bidPercentage).toBe("7.5");
      expect(typeof callBody.bidPercentage).toBe("string");
    });

    it("should handle decimal rates correctly", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "",
      });

      const { updateAdRate } = await import("../../ebay-promote-integration/ebay-promote.js");

      await updateAdRate("user123", "camp123", "ad123", 12.75);

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.bidPercentage).toBe("12.75");
    });

    it("should throw error on update failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Ad not found",
      });

      const { updateAdRate } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(updateAdRate("user123", "camp123", "ad999", 10.0)).rejects.toThrow(
        "Failed to update ad rate 404: Ad not found"
      );
    });

    it("should handle network errors gracefully", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const { updateAdRate } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(updateAdRate("user123", "camp123", "ad123", 5.0)).rejects.toThrow(
        "Network error"
      );
    });
  });

  describe("getPromotionStats", () => {
    it("should fetch promotion statistics", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 1000,
            clicks: 50,
            sales: 5,
            adFees: 25.5,
            revenue: 250.0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.impressions).toBe(1000);
      expect(result.clicks).toBe(50);
      expect(result.sales).toBe(5);
      expect(result.adFees).toBe(25.5);
      expect(result.revenue).toBe(250.0);
    });

    it("should calculate click-through rate", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 1000,
            clicks: 50,
            sales: 5,
            adFees: 25.0,
            revenue: 250.0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.clickThroughRate).toBe(5); // 50/1000 * 100
    });

    it("should calculate sales conversion rate", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 1000,
            clicks: 50,
            sales: 10,
            adFees: 25.0,
            revenue: 500.0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.salesConversionRate).toBe(20); // 10/50 * 100
    });

    it("should calculate ROI", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 1000,
            clicks: 50,
            sales: 10,
            adFees: 50.0,
            revenue: 200.0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.roi).toBe(300); // (200-50)/50 * 100 = 300%
    });

    it("should handle zero impressions", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 0,
            clicks: 0,
            sales: 0,
            adFees: 0,
            revenue: 0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.clickThroughRate).toBe(0);
      expect(result.salesConversionRate).toBe(0);
      expect(result.roi).toBe(0);
    });

    it("should support date range filtering", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () =>
          JSON.stringify({
            impressions: 500,
            clicks: 25,
            sales: 3,
            adFees: 15.0,
            revenue: 150.0,
          }),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const startDate = new Date("2024-01-01");
      const endDate = new Date("2024-01-31");

      await getPromotionStats("user123", "camp123", {
        dateRange: { start: startDate, end: endDate },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("startDate=2024-01-01"),
        expect.anything()
      );
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("endDate=2024-01-31"),
        expect.anything()
      );
    });

    it("should handle missing stats gracefully", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({}),
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getPromotionStats("user123", "camp123");

      expect(result.impressions).toBe(0);
      expect(result.clicks).toBe(0);
      expect(result.sales).toBe(0);
      expect(result.adFees).toBe(0);
      expect(result.revenue).toBe(0);
    });

    it("should throw error on fetch failure", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 404,
        text: async () => "Campaign not found",
      });

      const { getPromotionStats } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(getPromotionStats("user123", "camp999")).rejects.toThrow(
        "Stats fetch failed 404: Campaign not found"
      );
    });
  });

  describe("edge cases", () => {
    it("should handle empty campaign responses", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => JSON.stringify({}),
      });

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      const result = await getCampaign("user123", "camp123");

      expect(result).toEqual({});
    });

    it("should handle network errors", async () => {
      mockFetch.mockRejectedValue(new Error("Network error"));

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(getCampaign("user123", "camp123")).rejects.toThrow("Network error");
    });

    it("should handle invalid JSON responses", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        text: async () => "invalid json",
      });

      const { getCampaign } = await import("../../ebay-promote-integration/ebay-promote.js");

      await expect(getCampaign("user123", "camp123")).rejects.toThrow();
    });
  });
});
