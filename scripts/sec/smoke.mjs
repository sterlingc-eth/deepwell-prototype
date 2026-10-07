import { boot, recorder } from './lib/harness.mjs';
const H = await boot(); const R = recorder('smoke');
const { default: account } = await H.importApi('api/account.js');
const r1 = await H.call(account, { token: H.tok.memberA, method: 'POST', query: { action: 'tenant-export' } });
const r0 = await H.call(account, { method: 'GET', query: { action: 'keys' } });
console.log(r1.status, r0.status, r0.text.slice(0,100));
R.check('S1', 'no token rejected', r0.status === 401, { route: 'account?keys' });
R.finish();
