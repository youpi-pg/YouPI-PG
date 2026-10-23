import { ControlCenterServer } from './src/server.js';

// Control Center is kept private in the Services route table. Its process
// manager remains available for compatible hosts; Vercel does not expose it
// publicly unless a rewrite is added explicitly.
const controlCenter = new ControlCenterServer();
const server = controlCenter.createServer();

export default function handler(req, res) {
  return server.emit('request', req, res);
}
