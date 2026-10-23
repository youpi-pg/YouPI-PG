import { GmailObserverServer } from './src/server.js';

const observer = new GmailObserverServer({
  apiBaseUrl: process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL
});
const server = observer.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
