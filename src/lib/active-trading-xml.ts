/**
 * src/lib/active-trading-xml.ts
 *
 * Shared XML helpers for eBay Trading API (GetMyeBaySelling) responses.
 * Extracted from the former netlify function so they can be reused by the
 * Express service layer and tested independently.
 */

// ---------------------------------------------------------------------------
// parseItemIdsFromXml
// ---------------------------------------------------------------------------

/**
 * Extract ALL ItemIDs from an XML string (any nesting level).
 * Returns a Set<string>.
 */
export function parseItemIdsFromXml(xml: string): Set<string> {
  const ids = new Set<string>();
  const regex = /<ItemID>([^<]+)<\/ItemID>/g;
  let m: RegExpExecArray | null;
  while ((m = regex.exec(xml)) !== null) ids.add(m[1].trim());
  return ids;
}

// ---------------------------------------------------------------------------
// extractItemIdsFromContainer
// ---------------------------------------------------------------------------

/**
 * Extract ItemIDs only from within a specific XML container tag.
 * Handles container tags with attributes (e.g. <UnsoldList includeWatchCount="true">).
 * Returns a Set<string>.
 */
export function extractItemIdsFromContainer(xml: string, containerTag: string): Set<string> {
  const ids = new Set<string>();
  // Match the opening tag (with optional attributes) through the closing tag
  const containerMatch = xml.match(
    new RegExp(`<${containerTag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${containerTag}>`),
  );
  if (!containerMatch) return ids;
  const itemIdRegex = /<ItemID>([^<]+)<\/ItemID>/g;
  let m: RegExpExecArray | null;
  while ((m = itemIdRegex.exec(containerMatch[0])) !== null) ids.add(m[1].trim());
  return ids;
}

// ---------------------------------------------------------------------------
// checkXmlForErrors
// ---------------------------------------------------------------------------

/**
 * Throw if the XML response contains a Failure or PartialFailure Ack.
 * A Warning Ack is allowed and will not throw.
 */
export function checkXmlForErrors(xml: string): void {
  const ackMatch = xml.match(/<Ack>([^<]+)<\/Ack>/);
  const ack = ackMatch?.[1];
  if (ack === 'Failure' || ack === 'PartialFailure') {
    // Include a short snippet of the XML in the message for diagnostics
    const snippet = xml.slice(0, 300).replace(/\r?\n/g, ' ');
    throw new Error(`eBay API returned error: ${snippet}`);
  }
}

// ---------------------------------------------------------------------------
// shouldExcludeActiveItem
// ---------------------------------------------------------------------------

const CLOCK_JITTER_MS = 60_000; // 60 s buffer around EndTime

function extractText(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([^<]*)<\/${tag}>`));
  return m ? m[1].trim() : '';
}

/**
 * Determine whether an active listing item should be excluded from results.
 *
 * @param itemXml         - XML fragment for a single <Item>
 * @param unsoldItemIds   - Set of item IDs that appear in the UnsoldList
 * @param nowMs           - Current time as epoch milliseconds
 * @param applyUnsoldFilter - Whether to apply unsold-list exclusion (default true)
 *
 * @returns Exclusion reason string, or null if the item should be included.
 */
export function shouldExcludeActiveItem(
  itemXml: string,
  unsoldItemIds: Set<string>,
  nowMs: number,
  applyUnsoldFilter = true,
): string | null {
  // 1) TimeLeft = PT0S → listing has ended (zombie listing)
  const timeLeft = extractText(itemXml, 'TimeLeft');
  if (timeLeft === 'PT0S') return 'timeLeftPT0S';

  // 2) EndTime is in the past beyond jitter buffer
  const endTimeStr = extractText(itemXml, 'EndTime');
  if (endTimeStr) {
    const endMs = Date.parse(endTimeStr);
    if (!Number.isNaN(endMs) && endMs < nowMs - CLOCK_JITTER_MS) return 'endTimePast';
  }

  // 3) Item appears in the unsold list (only if filter is enabled)
  if (applyUnsoldFilter) {
    const itemId = extractText(itemXml, 'ItemID');
    if (itemId && unsoldItemIds.has(itemId)) return 'unsold';
  }

  return null;
}

// ---------------------------------------------------------------------------
// shouldApplyUnsoldFilter
// ---------------------------------------------------------------------------

/**
 * Decide whether the unsold filter should be applied.
 *
 * Returns false when ALL active items also appear in the unsold list —
 * this usually indicates corrupt/duplicate data and the filter would
 * incorrectly exclude everything.  Returns true in all other cases.
 */
export function shouldApplyUnsoldFilter(
  activeItemIds: Set<string>,
  unsoldItemIds: Set<string>,
): boolean {
  // Edge cases: always apply when either set is empty
  if (activeItemIds.size === 0 || unsoldItemIds.size === 0) return true;

  // Disable filter only when every active item is present in the unsold list
  for (const id of activeItemIds) {
    if (!unsoldItemIds.has(id)) return true; // at least one active item is not unsold → apply
  }
  return false; // all active items are in the unsold list — disable to prevent mass exclusion
}

// ---------------------------------------------------------------------------
// buildUnsoldListRequest
// ---------------------------------------------------------------------------

/**
 * Build a GetMyeBaySelling XML request body to retrieve unsold items.
 */
export function buildUnsoldListRequest(
  accessToken: string,
  pageNumber: number,
  entriesPerPage: number,
  durationInDays: number,
): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<GetMyeBaySellingRequest xmlns="urn:ebay:apis:eBLBaseComponents">
  <RequesterCredentials><eBayAuthToken>${accessToken}</eBayAuthToken></RequesterCredentials>
  <UnsoldList>
    <Include>true</Include>
    <DurationInDays>${durationInDays}</DurationInDays>
    <Pagination>
      <EntriesPerPage>${entriesPerPage}</EntriesPerPage>
      <PageNumber>${pageNumber}</PageNumber>
    </Pagination>
  </UnsoldList>
  <DetailLevel>ReturnAll</DetailLevel>
</GetMyeBaySellingRequest>`;
}
