import { HttpServer } from '../server.js';
import { StatementReconciliation } from '@youpi/core';

/**
 * Operator import of a downloaded bank statement. This is not a bank API
 * and it does not run on a timer. A line reconciles a payment only inside
 * StatementReconciliation.
 */
export function registerStatementRoutes(server, ctx) {
  server.post('/api/v1/admin/statements/import', async (req, res) => {
    let body;
    try {
      body = await HttpServer.parseBody(req);
    } catch (err) {
      const tooLarge = err.message === 'Payload Too Large';
      HttpServer.json(res, tooLarge ? 413 : 400, { error: err.message });
      return;
    }

    const receivingAccountId = body?.receivingAccountId;
    const csv = body?.csv;
    if (!receivingAccountId || typeof csv !== 'string' || !csv.trim()) {
      HttpServer.json(res, 400, { error: 'receivingAccountId and csv are required.' });
      return;
    }
    const account = ctx.accountRepo.findById(receivingAccountId);
    if (!account) {
      HttpServer.json(res, 404, { error: 'Receiving account not found.' });
      return;
    }

    const engine = new StatementReconciliation({
      db: ctx.db,
      sessionRepo: ctx.sessionRepo,
      auditRepo: ctx.auditRepo,
      eventEmitter: ctx.eventEmitter
    });
    const result = engine.importCsv({ receivingAccountId, csvText: csv });
    if (result.error) {
      HttpServer.json(res, 400, result);
      return;
    }
    HttpServer.json(res, 200, {
      reconciled: result.reconciled,
      conflicts: result.conflicts,
      unmatched: result.unmatched,
      lines: result.lines.map(line => ({
        outcome: line.outcome,
        matchStatus: line.matchStatus,
        matchReason: line.matchReason,
        paymentSessionId: line.paymentSessionId,
        statementLineId: line.statementLineId,
        utr: line.utr || null
      }))
    });
  });
}
