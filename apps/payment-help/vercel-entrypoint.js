import { HelpServer } from './src/server.js';

const help = new HelpServer({
  apiBaseUrl: process.env.PAYMENT_API_URL || process.env.BASE_PAYMENT_API_URL
});
const server = help.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
