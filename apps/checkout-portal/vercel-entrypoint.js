import { CheckoutServer } from './src/server.js';

const checkout = new CheckoutServer({
  apiBaseUrl: process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL
});
const server = checkout.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
