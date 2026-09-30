// Mounts the real MobileApp (src/mobile/MobileApp.tsx) against the same Clerk mock + fake backend.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import '../../src/mobile/mobile.css';
import { MobileApp } from '../../src/mobile/MobileApp';

import { installErrorReporter } from '../../src/services/errorReporter';
installErrorReporter('mobile', () => `tab:${new URLSearchParams(window.location.search).get('tab') ?? 'ask'}`);

const root = document.getElementById('root');
if (root) createRoot(root).render(<MobileApp />);
