import { AdminServer } from './src/server.js';

const admin = new AdminServer({
  apiBaseUrl: process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL
});
const server = admin.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
