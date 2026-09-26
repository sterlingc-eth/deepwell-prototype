// See index.html's comment. Renders KnowledgeGraph on its own, with a
// window-exposed hook to flip Office/Field for the verify script.
import { createRoot } from 'react-dom/client';
import { KnowledgeGraph } from '../../src/components/KnowledgeGraph';
import { useAppStore } from '../../src/store/appStore';
import '../../src/index.css';

declare global {
  interface Window {
    __dwSetField?: (on: boolean) => void;
  }
}
window.__dwSetField = (on: boolean) => useAppStore.getState().setFieldMode(on);

const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<KnowledgeGraph seedNodeId="customer:c1" heading="Graph harness" />);
}
