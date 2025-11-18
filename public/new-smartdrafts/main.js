import { h, render } from 'https://unpkg.com/preact@10.20.2?module';
import { App } from './App.js';

try {
  const root = document.getElementById('root');
  if (!root) {
    document.body.innerHTML = '<div style="color:white;padding:20px;">ERROR: #root not found</div>';
    throw new Error('#root element not found');
  }
  console.log('Rendering App...');
  render(h(App, {}), root);
  console.log('App rendered successfully');
} catch (err) {
  console.error('Failed to render:', err);
  document.body.innerHTML = '<div style="color:white;padding:20px;">ERROR: ' + err.message + '</div>';
}



