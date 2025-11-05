# Production Rollout Checklist

## Pre-Deployment

### 1. Config Freeze ✅
- [x] Config documented in `configs/prod.env.example`
- [x] All thresholds externalized with env overrides
- [x] Engine version set to `1.0.0`
- [ ] Review thresholds with product team
- [ ] Set production `.env` file (not committed)

### 2. Golden Dataset Lock ✅
- [x] Golden dataset in `tests/golden/`
- [x] `analysis.json` - frozen test input
- [x] `pairing-expected.json` - blessed output
- [x] `metrics-expected.json` - expected metrics
- [ ] Verify golden represents production mix (categories, brands)

### 3. CI Gates ✅
- [x] `npm test` - unit tests (15 passing)
- [x] `npm run verify:golden` - regression tests
- [ ] Add to CI/CD pipeline
- [ ] Require passing before merge
- [ ] Add smoke test on small live batch (optional)

### 4. Secrets Management
- [ ] Verify `OPENAI_API_KEY` unset for autopair-only paths
- [ ] Set API key only in tie-break canary jobs
- [ ] Rotate keys quarterly
- [ ] Document key location (AWS Secrets Manager, etc.)

### 5. Rate Limits
- [x] Batch size gate: `PAIR_BATCH_MAX_CHUNK=200`
- [ ] Configure worker concurrency (2-4 workers recommended)
- [ ] Add queue depth monitoring
- [ ] Set up circuit breaker for OpenAI API

---

## Deployment

### 6. Deploy Checklist
```bash
# 1. Run final tests
npm test
npm run verify:golden

# 2. Build production bundle
npm run build

# 3. Deploy to staging
# ... your deploy command ...

# 4. Smoke test on staging
PAIR_DISABLE_TIEBREAK=1 npm run pairing  # Safe mode

# 5. Monitor metrics
npm run metrics:print

# 6. Deploy to production (if staging passed)
# ... your deploy command ...

# 7. Canary test (2% traffic)
# Run on small batch, compare to baseline
```

### 7. Canary Validation
- [ ] Pair rate ≥ baseline (98%)
- [ ] Singleton rate ≤ 2%
- [ ] GPT usage ≤ 2%
- [ ] No contract violations
- [ ] Runtime ≤ 75ms per 100 images

---

## Post-Deployment

### 8. Monitoring Setup
```bash
# SLO tracking
- Pair rate ≥ 98% (rolling 7d, per category)
- Contract violations = 0
- Mean runtime ≤ 75ms / 100 images
- GPT usage ≤ 2% of batches

# Dashboards (from pairing-metrics.json)
- totals: images, fronts, backs, candidates, autoPairs, modelPairs, singletons
- byBrand & byCategory pair rates
- reason histogram (why things declined)
- thresholds in effect

# Alerts
- Pair rate drops >3% vs 7-day avg → Page on-call
- Any contract violation → Page on-call
- GPT usage spikes >10% → Alert ML team
- Singletons >2% in any category → Alert product
```

### 9. Rollback Plan
```bash
# If pair rate drops or errors spike:

# 1. Immediate rollback (config only)
# Revert thresholds in .env to previous values
# Restart services

# 2. Re-run failed batches
PAIR_DISABLE_TIEBREAK=1 npm run pairing  # Safe mode

# 3. Update golden if threshold change blessed
npm run pairing
cp pairing.json tests/golden/pairing-expected.json
cp pairing-metrics.json tests/golden/metrics-expected.json
npm run verify:golden
```

### 10. Documentation Updates
- [ ] Update `PAIRING-SYSTEM.md` with production thresholds
- [ ] Document any category-specific tuning
- [ ] Update runbooks with observed issues
- [ ] Create incident log template

---

## Week 1 Checklist

### Daily Monitoring
- [ ] Check `npm run metrics:print` output
- [ ] Review pair rates by category
- [ ] Check for contract violations
- [ ] Monitor GPT usage rate
- [ ] Review singleton reasons

### Weekly Review
- [ ] Analyze metrics trends
- [ ] Identify categories needing tuning
- [ ] Review new product types
- [ ] Update thresholds if needed
- [ ] Blameless postmortem for any incidents

---

## Acceptance Criteria

A PR that changes pairing logic **must**:
- [ ] Pass all unit tests (`npm test`)
- [ ] Pass golden verification (`npm run verify:golden`)
- [ ] Include updated metrics comparison
- [ ] Maintain pair count ≥ baseline
- [ ] Keep singletons ≤ baseline
- [ ] Document threshold changes

### Example PR Description
```
## Changes
- Lower autoPairHair.score from 2.4 to 2.2
- Add packaging boost for jars (+1.2)

## Metrics Impact
- Pair rate: 98.5% → 99.2% (+0.7%)
- Singletons: 8 → 3 (-5)
- GPT usage: 0% → 0% (no change)

## Testing
✅ All unit tests passing
✅ Golden verification passing
✅ Smoke test on 200-image batch
✅ Metrics attached

## Rollback Plan
Revert PAIR_AUTO_HAIR_SCORE to 2.4 in .env
```

---

## Success Metrics (30-day)

### Targets
- ✅ Pair rate ≥ 98% overall
- ✅ Pair rate ≥ 99% for supplements/food
- ✅ Singletons ≤ 2%
- ✅ Contract violations = 0
- ✅ GPT usage ≤ 2% of runs
- ✅ Runtime ≤ 75ms / 100 images
- ✅ Extras attachment ≥ 90% of true sides/details

### Review Points
- [ ] Day 3: First metrics review
- [ ] Day 7: Category tuning review
- [ ] Day 14: SLO compliance check
- [ ] Day 30: Full postmortem & optimization planning

---

## Emergency Contacts

| Role | Contact | Escalation Path |
|------|---------|----------------|
| On-call Engineer | @oncall | Contract violations, >10% pair rate drop |
| ML Team Lead | @ml-lead | Prompt issues, model performance |
| Product Owner | @product | New categories, business logic |
| DevOps | @devops | Infrastructure, rate limiting |

---

## Quick Reference

```bash
# Check system health
npm run metrics:print

# Verify no regressions
npm run verify:golden

# Safe mode (no GPT)
PAIR_DISABLE_TIEBREAK=1 npm run pairing

# Lower thresholds temporarily
PAIR_AUTO_SCORE=2.8 npm run pairing

# View config
cat configs/prod.env.example

# Compare metrics
npm run metrics:print pairing-metrics-yesterday.json
npm run metrics:print pairing-metrics-today.json
```

---

## Sign-off

- [ ] Engineering Lead approval
- [ ] Product approval
- [ ] Security review (PII handling)
- [ ] Compliance review (data retention)
- [ ] Monitoring/alerting configured
- [ ] Runbooks reviewed by on-call team
- [ ] Rollback plan tested

**Deployment Date:** _____________

**Deployed By:** _____________

**Verified By:** _____________
