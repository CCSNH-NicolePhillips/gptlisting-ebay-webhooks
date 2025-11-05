# Operations Runbooks - Pairing System

## Quick Reference

| Issue | Runbook | Priority |
|-------|---------|----------|
| Pair rate drops >3% | [A) Pair Rate Dip](#a-pair-rate-dip) | 🔴 High |
| Contract violation | [B) Contract Violation](#b-contract-violation) | 🔴 Critical |
| Batch slowdown | [C) Massive Batch Slowdowns](#c-massive-batch-slowdowns) | 🟡 Medium |
| GPT usage spike | [D) GPT Usage Spike](#d-gpt-usage-spike) | 🟡 Medium |
| Singletons >2% | [E) Singleton Rate High](#e-singleton-rate-high) | 🟡 Medium |

---

## A) Pair Rate Dip

### Symptoms
- Pair rate drops below 95% (target: ≥98%)
- More singletons than usual
- `pairing-metrics.json` shows declining byBrand rates

### Diagnosis Steps

1. **Check last metrics file**
   ```bash
   npm run metrics:print pairing-metrics.json
   ```

2. **Examine reason histogram**
   - Look for `declined_despite_candidates` - candidates exist but scores too low
   - Look for `no_candidates` - no backs passed minPreScore threshold

3. **Review PRE tables** (from console logs)
   ```
   PRE   front=...
    - back=... preScore=X.XX prodJac=... pkg=... brand=...
   ```
   - Check if best candidates are close to threshold (2.5-3.0 range)
   - Verify brandFlag, packaging, sizeEq, catTailOverlap signals

4. **Category-specific checks**
   
   **Hair/Cosmetics:**
   - INCI ingredient lists often have minimal brand/product text
   - Check if `cosmeticBackCue` detected (INCI regex match)
   - Verify packaging match (dropper-bottle, bottle)
   - Consider lowering `PAIR_AUTO_HAIR_SCORE` by 0.1 temporarily

   **Supplements/Food:**
   - Strong Nutrition Facts + barcode signals
   - Check size normalization (ml/oz/g conversions)
   - Verify brand extraction (often in small footer text)

   **Household/Accessories:**
   - Many SIDE/OTHER photos may be misclassified as backs
   - Check role classification in Prompt 1 output
   - Verify filename/folder proximity is enabled

### Remediation

**Temporary fix (single batch):**
```bash
# Lower auto-pair threshold temporarily
PAIR_AUTO_SCORE=2.8 npm run pairing
```

**Permanent fix (after analysis):**
1. Update `configs/prod.env.example` with new threshold
2. Deploy config change
3. Re-run failed batches
4. Update golden dataset if threshold change is blessed:
   ```bash
   npm run pairing
   cp pairing.json tests/golden/pairing-expected.json
   cp pairing-metrics.json tests/golden/metrics-expected.json
   npm run verify:golden  # Should pass
   ```

### Prevention
- Monitor category-specific pair rates weekly
- Alert if any category drops >5% from baseline
- Review new product categories before batch processing

---

## B) Contract Violation

### Symptoms
- Error: `"contract violation: ..."`
- Pairing fails with exception
- **CRITICAL: Should never happen in production**

### Diagnosis Steps

1. **Check error message**
   ```
   contract violation: missing decision for front <url>
   contract violation: back <url> not in candidates for front <url>
   ```

2. **Review Prompt 2 output** (rawText in logs)
   - Verify JSON structure matches schema
   - Check if model returned unexpected back URLs
   - Confirm all fronts have decisions

3. **Verify HINTS section**
   - Ensure user prompt has `INPUT:` then `HINTS:` sections
   - Confirm hints JSON has `candidatesByFront` with correct URLs
   - Check URL canonicalization (lowercase, forward slashes)

### Remediation

**Immediate:**
1. **Disable GPT tie-breaking** for this batch:
   ```bash
   PAIR_DISABLE_TIEBREAK=1 npm run pairing
   ```
   - Will auto-pair what it can, rest become singletons
   - Zero risk of contract violations

2. **Check for non-canonical URLs**
   - Look for mixed case, backslashes, extra whitespace
   - Review `analysis.json` for malformed URLs

**Permanent fix:**
1. Add client-side URL validation before pairing
2. Strengthen URL canonicalization in `featurePrep.ts`
3. Add unit tests for URL edge cases
4. Update Prompt 2 system message to be more explicit about constraints

### Prevention
- Unit tests for URL canonicalization
- Schema validation on analysis.json input
- Contract checks in CI/CD pipeline

---

## C) Massive Batch Slowdowns

### Symptoms
- Batch takes >5 minutes for <200 images
- WARN: `candidate building took XXXXms` (>30s)
- High CPU usage during candidate computation

### Diagnosis Steps

1. **Check batch size**
   ```bash
   # Count images in analysis.json
   cat analysis.json | jq '.imageInsights | length'
   ```
   - Target: ≤200 images per chunk

2. **Profile candidate building**
   - Look for WARN about build time >30s
   - Check if many backs per front (O(fronts × backs))

3. **Check for cycle warnings**
   ```
   WARN back=... appears under 3+ fronts
   ```
   - Indicates ambiguous candidates
   - May need stricter minPreScore

### Remediation

**Immediate:**
```bash
# Chunk into smaller batches
split -l 50 big-batch.json batch-

# Disable GPT for backfill
PAIR_DISABLE_TIEBREAK=1 npm run pairing

# Raise candidate threshold to reduce candidates
PAIR_MIN_PRESCORE=2.0 npm run pairing
```

**Permanent fix:**
1. Implement batch chunking in CLI:
   ```typescript
   if (images.length > cfg.batch.maxPerChunk) {
     // Split into chunks and process sequentially
   }
   ```

2. Add timeout enforcement:
   ```typescript
   if (Date.now() - buildStart > cfg.batch.maxWallMs) {
     throw new Error('Batch timeout exceeded');
   }
   ```

3. Enable filename/folder proximity boost:
   - Reduces candidates by pre-filtering on location
   - Saves O(n²) comparisons

### Prevention
- Enforce `maxPerChunk=200` in API endpoints
- Monitor `buildDurationMs` in metrics
- Alert if >1s for 100 images

---

## D) GPT Usage Spike

### Symptoms
- `modelPairs > 0` when normally 0
- GPT usage rate >2% (target: ≤2%)
- Increased API costs

### Diagnosis Steps

1. **Check auto-pair failures**
   ```bash
   npm run metrics:print
   # Look for high modelPairs count
   ```

2. **Review preScores**
   - Check PRE tables for best candidates
   - If best < 3.0, auto-pair didn't trigger

3. **Category analysis**
   - New category with different characteristics?
   - Different packaging types (jars, tubes vs pouches/bottles)?

### Remediation

**Immediate:**
```bash
# Disable tie-breaking for backfill
PAIR_DISABLE_TIEBREAK=1 npm run pairing
```

**Permanent fix:**
1. Analyze failed auto-pairs:
   ```bash
   # Get PRE scores for modelPairs
   grep "CANDIDATES" logs.txt | grep -A5 "modelPairs"
   ```

2. Adjust thresholds if legitimate:
   - Lower `PAIR_AUTO_SCORE` if consistently 2.8-2.9 range
   - Add category-specific boosts for new product types

3. Add retries with backoff:
   ```typescript
   let retries = 0;
   while (retries < cfg.maxModelRetries) {
     try {
       return await client.chat.completions.create(...);
     } catch (err) {
       if (++retries >= cfg.maxModelRetries) {
         cfg.disableTiebreak = true; // Hard disable
         break;
       }
     }
   }
   ```

### Prevention
- Alert when `totals.modelPairs > 0` for 3 consecutive runs
- Review new categories before production
- A/B test threshold changes on canary batch

---

## E) Singleton Rate High

### Symptoms
- Singletons >2% of fronts (target: ≤2%)
- `reason: "declined_despite_candidates"` or `"no_candidates"`

### Diagnosis Steps

1. **Check reason histogram**
   ```bash
   npm run metrics:print
   # Look at reasons breakdown
   ```

2. **Analyze singleton images**
   - Review URLs of singletons
   - Check if they're legitimate products or non-products
   - Verify role classification (should be 'front')

3. **Check candidates**
   ```
   PRE   front=<singleton-url>
    - back=... preScore=X.XX ...
   ```
   - If no candidates: minPreScore too high or no matching backs
   - If candidates exist: auto-pair threshold too high

### Remediation

**For legitimate products:**
```bash
# Lower thresholds
PAIR_MIN_PRESCORE=1.2 npm run pairing
PAIR_AUTO_SCORE=2.8 npm run pairing
```

**For non-products (handbags, accessories):**
- Expected behavior
- Update exclusion rules in Prompt 1
- Filter out non-product categories upstream

**For misclassified roles:**
- Review Prompt 1 role scoring
- Check if backs misclassified as fronts
- Update role scoring weights

### Prevention
- Category-specific thresholds
- Pre-filter non-product images
- Monitor singleton reasons weekly

---

## Emergency Contacts

| Role | Contact | When to Escalate |
|------|---------|------------------|
| On-call Engineer | @oncall | Contract violations, >10% pair rate drop |
| ML Team | @ml-team | Prompt changes, threshold tuning |
| Product | @product | New category onboarding |

---

## Quick Commands

```bash
# Check system health
npm run metrics:print

# Verify no regressions
npm run verify:golden

# Safe mode (no GPT)
PAIR_DISABLE_TIEBREAK=1 npm run pairing

# Lower thresholds temporarily
PAIR_AUTO_SCORE=2.8 npm run pairing

# Check config
cat configs/prod.env.example

# View recent runs
ls -lt pairing-metrics*.json | head -5

# Compare metrics
diff <(jq .totals yesterday-metrics.json) <(jq .totals today-metrics.json)
```

---

## Post-Incident

After resolving any incident:

1. **Document** what happened in incident log
2. **Update** this runbook with lessons learned
3. **Add** regression test to prevent recurrence
4. **Review** alerts/monitors to catch earlier next time
5. **Blameless postmortem** if pair rate dropped >10%
