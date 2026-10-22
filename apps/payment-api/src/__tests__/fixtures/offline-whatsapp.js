/** Route-contract fake. Never imports BerryProtocol, touches a session, or opens a socket. */
export function createOfflineWhatsApp() {
  let status = 'DISCONNECTED';
  let qrCode = null;
  const calls = [];
  return {
    calls,
    getStatus: () => status,
    getQrCode: () => qrCode,
    getClientInfo: () => ({ status, platform: 'BerryProtocol v0.1.10', isConnected: false }),
    async initialize() {
      calls.push({ method: 'initialize' });
      status = 'QR_READY';
      qrCode = { dataUrl: 'data:image/svg+xml;base64,PHN2Zy8+' };
    },
    async reconnect() {
      calls.push({ method: 'reconnect' });
      await this.initialize();
    },
    async waitForQrCode() { return qrCode; },
    async requestPairingCode(phoneNumber) {
      calls.push({ method: 'requestPairingCode', phoneNumber });
      status = 'PAIRING_CODE_READY';
      return { pairingCode: '12345678', phoneNumber };
    },
    async sendOtp(phoneNumber) {
      // Do not retain the OTP or message body in test evidence.
      calls.push({ method: 'sendOtp', phoneNumber });
      return { success: true, delivered: false, simulated: true };
    },
    async disconnect() {
      calls.push({ method: 'disconnect' });
      status = 'DISCONNECTED';
      qrCode = null;
    }
  };
}
