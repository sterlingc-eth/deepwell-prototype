// Starts a vite dev server rooted at the repo with '@clerk/clerk-react' aliased to clerk-mock.tsx.
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
    root: REPO, configFile: false, envFile: false, logLevel: 'error',
    define: { 'import.meta.env.VITE_ANSWER_PROVIDER': JSON.stringify('claude') },
    resolve: { alias: [{ find: '@clerk/clerk-react', replacement: path.join(REPO, 'scripts/app-qa-harness/clerk-mock.tsx') }] },
    css: { postcss: { plugins: [tailwindcss(path.join(REPO, 'tailwind.config.ts')), autoprefixer()] } },
    plugins: [reactPlugin()],
    server: { port: 5230, strictPort: false, fs: { allow: [REPO] } },
  });
  await server.listen();
  const a = server.httpServer?.address();
  const port = typeof a === 'object' && a ? a.port : a;
  return { server, base: `http://localhost:${port}/scripts/app-qa-harness/index.html` };
}
