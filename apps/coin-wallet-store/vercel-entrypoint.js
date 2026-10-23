import { CoinWalletStoreServer } from './src/server.js';

const store = new CoinWalletStoreServer({
  gatewayApiUrl: process.env.PAYMENT_API_URL || process.env.PAYMENT_API_INTERNAL_URL,
  portalBaseUrl: process.env.CHECKOUT_PORTAL_URL
});
const server = store.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
