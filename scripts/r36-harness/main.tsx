// Mounts the real App in demo mode (HVAC fixture is the data) — see index.html.
import { createRoot } from 'react-dom/client';
import '../../src/index.css';
import App from '../../src/App';
import { bootstrapHvac } from '../../src/domains/hvac';
import { useAppStore } from '../../src/store/appStore';

bootstrapHvac();
(window as unknown as { __store: typeof useAppStore }).__store = useAppStore;
const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
