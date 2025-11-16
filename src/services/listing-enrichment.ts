/**
 * ChatGPT-powered listing enrichment for SEO-optimized eBay titles and descriptions
 */

import OpenAI from 'openai';

export interface ProductGroup {
  brand?: string;
  product?: string;
  variant?: string;
  size?: string;
  category?: string;
  categoryPath?: string;
  claims?: string[];
  options?: Record<string, any>;
  textExtracted?: string;
  visualDescription?: string;
}

export interface EnrichedListing {
  title: string;
  description: string;
}

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * Generate SEO-optimized eBay title and description using ChatGPT
 */
export async function enrichListingWithAI(group: ProductGroup): Promise<EnrichedListing> {
  if (!OPENAI_API_KEY) {
    console.warn('[enrichListingWithAI] No OpenAI API key - using fallback');
    return generateFallbackListing(group);
  }

  try {
    const client = new OpenAI({ apiKey: OPENAI_API_KEY });
    
    const prompt = buildEnrichmentPrompt(group);
    
    const response = await client.chat.completions.create({
      model: 'gpt-4o-mini', // Fast and cost-effective for text generation
      messages: [
        {
          role: 'system',
          content: 'You are an expert eBay listing optimizer specializing in SEO-rich titles and compelling product descriptions that drive sales.'
        },
        {
          role: 'user',
          content: prompt
        }
      ],
      temperature: 0.7, // Creative but consistent
      max_tokens: 800,
      response_format: { type: 'json_object' }
    });

    const result = JSON.parse(response.choices[0].message.content || '{}');
    
    return {
      title: (result.title || generateFallbackTitle(group)).slice(0, 80),
      description: (result.description || generateFallbackDescription(group)).slice(0, 7000)
    };
  } catch (error) {
    console.error('[enrichListingWithAI] Error:', error);
    return generateFallbackListing(group);
  }
}

function buildEnrichmentPrompt(group: ProductGroup): string {
  const lines = [
    '**TASK**: Generate an SEO-optimized eBay listing for this product.',
    '',
    '**PRODUCT DATA**:',
    `- Brand: ${group.brand || 'Unknown'}`,
    `- Product: ${group.product || 'Unknown'}`,
    `- Variant: ${group.variant || 'N/A'}`,
    `- Size: ${group.size || 'N/A'}`,
    `- Category: ${group.category || 'General'}`,
  ];

  if (group.claims && group.claims.length > 0) {
    lines.push('- Key Features:');
    group.claims.slice(0, 8).forEach(claim => {
      lines.push(`  • ${claim}`);
    });
  }

  if (group.options) {
    lines.push('- Additional Details:');
    Object.entries(group.options).forEach(([key, value]) => {
      if (value) lines.push(`  • ${key}: ${Array.isArray(value) ? value.join(', ') : value}`);
    });
  }

  lines.push(
    '',
    '**TITLE REQUIREMENTS** (CRITICAL - Must follow exactly):',
    '1. Maximum 80 characters (strict eBay limit)',
    '2. Include brand name at the start',
    '3. Include product type and key differentiators',
    '4. Add size/quantity if available',
    '5. Include 1-2 high-value keywords (e.g., "Organic", "Vegan", "Premium", "Professional")',
    '6. NO special characters except hyphen, comma, ampersand',
    '7. NO promotional language ("New!", "Sale!", "Free Shipping!")',
    '8. Format: "Brand Product-Type Variant Size | Key-Feature"',
    '',
    '**DESCRIPTION REQUIREMENTS**:',
    '1. 200-500 words of compelling, keyword-rich copy',
    '2. Structure:',
    '   - Opening hook (1-2 sentences highlighting main benefit)',
    '   - Key features section (bullet points)',
    '   - How to use / Application (if relevant)',
    '   - Why choose this product (benefits over features)',
    '   - Specs/Details (size, formulation, etc.)',
    '3. SEO keywords: Naturally integrate category-relevant search terms',
    '4. Formatting: Use line breaks, bullets, and short paragraphs',
    '5. Professional tone, no hype or exaggeration',
    '6. Focus on benefits, not just features',
    '7. Address common buyer questions',
    '',
    '**OUTPUT FORMAT** (JSON only):',
    '{',
    '  "title": "Your SEO-optimized title here (max 80 chars)",',
    '  "description": "Your compelling multi-paragraph description here with formatting"',
    '}',
    '',
    '**EXAMPLE OUTPUT**:',
    '{',
    '  "title": "OGANACELL DERX Facial Cleanser 150ml | Natural Ingredients Gentle",',
    '  "description": "Experience rejuvenating skincare with OGANACELL DERX CLEANSER.\\n\\nThis advanced facial cleanser is dermatologist-approved and formulated with natural ingredients including water, glycerin, and citric acid. Perfect for daily use on all skin types.\\n\\n✓ Key Benefits:\\n• Gentle cleansing with natural citric acid\\n• Dermatologist tested and approved\\n• Suitable for sensitive skin\\n• 150ml size perfect for daily use\\n\\nIdeal for morning and evening skincare routines. The gentle formula effectively removes impurities while maintaining your skin\'s natural moisture balance.\\n\\nSpecifications:\\n• Volume: 150ml\\n• Product Line: DERX\\n• Main Purpose: Deep Cleansing\\n• Body Area: Face\\n\\nTrusted by skincare enthusiasts worldwide for its gentle yet effective formula."',
    '}'
  );

  return lines.join('\n');
}

function generateFallbackTitle(group: ProductGroup): string {
  const parts = [
    group.brand,
    group.product,
    group.variant,
    group.size
  ].filter(p => p && p.trim());
  
  return parts.join(' ').slice(0, 80);
}

function generateFallbackDescription(group: ProductGroup): string {
  const lines = [generateFallbackTitle(group)];
  
  if (group.variant) lines.push(`Variant: ${group.variant}`);
  if (group.size) lines.push(`Size: ${group.size}`);
  
  if (group.claims && group.claims.length > 0) {
    lines.push('', 'Key Features:');
    group.claims.slice(0, 8).forEach(claim => {
      lines.push(`• ${claim}`);
    });
  }
  
  return lines.join('\n').slice(0, 7000);
}

function generateFallbackListing(group: ProductGroup): EnrichedListing {
  return {
    title: generateFallbackTitle(group),
    description: generateFallbackDescription(group)
  };
}
