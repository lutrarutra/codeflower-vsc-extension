import { mount } from 'svelte';
import App from './App.svelte';
import Preview from './Preview.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
  throw new Error('Webview root element is missing');
}

// One bundle for both webviews; the host names the view on <body>.
mount(document.body.dataset.view === 'preview' ? Preview : App, { target });
