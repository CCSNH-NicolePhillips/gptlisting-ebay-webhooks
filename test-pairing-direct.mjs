// Direct test of pairing function to bypass browser cache
import fetch from 'node-fetch';

const response = await fetch('https://draftpilot-ai.netlify.app/.netlify/functions/smartdrafts-pairing', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Origin': 'https://draftpilot-ai.netlify.app'
  },
  body: JSON.stringify({
    folder: '/test3',
    overrides: {}
  })
});

const data = await response.json();
console.log('Status:', response.status);
console.log('Response:', JSON.stringify(data, null, 2));
