declare module 'paapi5-nodejs-sdk' {
  export class ApiClient {
    static instance: ApiClient;
    accessKey: string;
    secretKey: string;
    host: string;
    region: string;
  }

  export class SearchItemsRequest {
    PartnerTag: string;
    PartnerType: string;
    Keywords: string;
    SearchIndex: string;
    ItemCount: number;
    Resources: string[];
  }

  export class DefaultApi {
    searchItems(request: SearchItemsRequest): Promise<SearchItemsResponse>;
  }

  export interface SearchItemsResponse {
    SearchResult?: {
      Items?: Array<{
        ASIN?: string;
        DetailPageURL?: string;
        ItemInfo?: {
          Title?: {
            DisplayValue?: string;
          };
          ByLineInfo?: any;
        };
        Offers?: {
          Listings?: Array<{
            Price?: {
              Amount?: number;
              Currency?: string;
            };
            SavingBasis?: {
              Amount?: number;
              Currency?: string;
            };
          }>;
        };
        BrowseNodeInfo?: {
          BrowseNodes?: Array<{
            DisplayName?: string;
            Ancestor?: BrowseNode;
          }>;
        };
      }>;
    };
  }

  export interface BrowseNode {
    DisplayName?: string;
    Ancestor?: BrowseNode;
  }

  const module: {
    ApiClient: typeof ApiClient;
    SearchItemsRequest: typeof SearchItemsRequest;
    DefaultApi: typeof DefaultApi;
  };

  export default module;
}
