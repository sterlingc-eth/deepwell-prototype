// Mounts the real MobileApp (src/mobile/MobileApp.tsx) against the same Clerk mock + fake backend.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import '../../src/mobile/mobile.css';
import { MobileApp } from '../../src/mobile/MobileApp';

const root = document.getElementById('root');
if (root) createRoot(root).render(<MobileApp />);
