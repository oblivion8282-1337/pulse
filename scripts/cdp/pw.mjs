// Shared Playwright resolver for the CDP dev scripts. @playwright/test lives in
// the web/ workspace, so resolve it relative to this file's location.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(resolve(__dirname, '../../web/') + '/');
export const { chromium } = require('@playwright/test');
