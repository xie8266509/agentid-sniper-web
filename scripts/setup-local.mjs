import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_PATH, DEFAULT_CONFIG, saveConfig } from '../lib/config.mjs';
import { ROOT } from '../lib/control.mjs';
import { getCliInfo } from '../lib/wallet-cli.mjs';
mkdirSync(join(ROOT, 'data'), { recursive: true });
if (!existsSync(CONFIG_PATH)) saveConfig(structuredClone(DEFAULT_CONFIG));
if (!getCliInfo().ready) await import('./setup-wallet.mjs');
if (process.exitCode !== 1) console.log('本地配置已准备好。运行 npm run web:start，然后打开 http://127.0.0.1:4317');
