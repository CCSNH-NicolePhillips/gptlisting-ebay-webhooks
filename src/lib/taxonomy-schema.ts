export type ItemSpecific = {
  name: string;
  type: "string" | "enum";
  enum?: string[];
  source?: "group" | "static";
  from?: "brand" | "product" | "variant" | "size" | "category";
  static?: string;
  required?: boolean;
};

export type CategoryScoreRules = {
  includes?: string[];
  excludes?: string[];
  minScore?: number;
};

export type CategoryDefaults = {
  condition?: "NEW" | "USED" | "LIKE_NEW";
  quantity?: number;
  fulfillmentPolicyId?: string;
  paymentPolicyId?: string;
  returnPolicyId?: string;
};

export type AllowedCondition = {
  conditionId: string;
  conditionDisplayName: string;
};

export type CategoryDef = {
  id: string;
  slug: string;
  title: string;
  marketplaceId: string;
  scoreRules?: CategoryScoreRules;
  itemSpecifics: ItemSpecific[];
  defaults?: CategoryDefaults;
  allowedConditions?: AllowedCondition[];
  version: number;
  updatedAt: number;
};
