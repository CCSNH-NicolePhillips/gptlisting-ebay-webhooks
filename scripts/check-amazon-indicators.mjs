// Quick test to see what's in Amazon HTML
const amazonUrl = 'https://www.amazon.com/Vita-PLynxera-D-Chiro-Inositol-Supplement/dp/B0DZW37LQJ';

const response = await fetch(amazonUrl);
const html = await response.text();

// Check each bundle indicator
const indicators = [
  { pattern: /subscribe\s*(&|and)\s*save/i, name: 'subscribe & save' },
  { pattern: /\bsubscription\b/i, name: 'subscription' },
  { pattern: /auto[-\s]?ship/i, name: 'auto-ship' },
  { pattern: /\bauto\s*delivery\b/i, name: 'auto delivery' },
  { pattern: /starter\s*(pack|kit|bundle)/i, name: 'starter pack' },
  { pattern: /\bbundle\b/i, name: 'bundle' },
  { pattern: /\bvalue\s*pack\b/i, name: 'value pack' },
  { pattern: /\b\d+\s*-\s*month\s*supply\b/i, name: 'month supply' },
  { pattern: /\b\d+\s*(month|mo)\s*supply\b/i, name: 'month supply 2' },
  { pattern: /recurring\s*order/i, name: 'recurring order' },
  { pattern: /\brefill\s*program\b/i, name: 'refill program' },
];

console.log('Checking Amazon page for bundle indicators:\n');
indicators.forEach(ind => {
  if (ind.pattern.test(html)) {
    console.log(`❌ FOUND: ${ind.name}`);
  }
});
