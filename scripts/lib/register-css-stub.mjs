// `tsx --import ./scripts/lib/register-css-stub.mjs scripts/verify-ui.ts` — see css-stub-hooks.mjs.
import { register } from 'node:module';
register('./css-stub-hooks.mjs', import.meta.url);
