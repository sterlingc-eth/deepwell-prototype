// Vite dev server rooted at the repo: demo mode on, '@clerk/clerk-react' aliased to the mutable mock.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export async function startServer() {
  process.chdir(REPO);
  const { createServer } = await import('vite');
  const reactPlugin = (await import('@vitejs/plugin-react')).default;
  const tailwindcss = (await import('tailwindcss')).default;
  const autoprefixer = (await import('autoprefixer')).default;
  const server = await createServer({
    root: REPO, configFile: false, envFile: false, logLevel: 'error', cacheDir: path.join(process.env.TMPDIR || '/tmp', 'dw-r36-vite-cache'),
    define: { 'import.meta.env.VITE_DEMO_MODE': JSON.stringify('true') },
    resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(REPO, 'scripts/r36-harness/clerk-mock.tsx') }] },
    css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
    plugins: [reactPlugin()],
    server: { port: 5260, strictPort: false, fs: { allow: [REPO] } },
  });
  await server.listen();
  const a = server.httpServer?.address();
  const port = typeof a === 'object' && a ? a.port : a;
  return { server, base: `http://localhost:${port}/scripts/r36-harness/index.html` };
}
