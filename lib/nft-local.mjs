import { join } from 'node:path';
import { createNftTradingStore } from './nft-trading-store.mjs';
import { createElementTrading } from './element-trading.mjs';
import { createNftAutomation } from './nft-automation.mjs';
import { nftRpc } from './nft-holdings.mjs';

export function createLocalNftTrading({ root, readConfig, runWallet, serviceInfo, withWalletLock, onWalletResolved }) {
  const store = createNftTradingStore({ rulesFile: join(root, 'data', 'nft_rules.json'), settingsFile: join(root, 'data', 'nft_market_settings.json') });
  const market = createElementTrading({ getApiKey: store.getApiKey, rpc: nftRpc });
  const worker = createNftAutomation({ store, market, rpc: nftRpc, readConfig, runWallet, serviceInfo, withWalletLock, onWalletResolved, stateFile: join(root, 'data', 'nft_trading_state.json') });
  return { ...worker, getApiKey: store.getApiKey };
}
