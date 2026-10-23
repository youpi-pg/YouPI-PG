import { createPaymentApp } from './src/index.js';

// Vercel invokes this module as a request handler. The native gateway router is
// reused unchanged; no payment rules are duplicated in the adapter.
const app = createPaymentApp();

export default function handler(req, res) {
  return app.rawServer.emit('request', req, res);
}
