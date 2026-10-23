import crypto from 'node:crypto';
import { ObservationAttributionStatus } from '@youpi/common';

export class ObservationRepository {
  /**
   * @param {import('../database.js').Database} db
   */
  constructor(db) {
    this.db = db;
  }

  create(data) {
    const id = data.id || crypto.randomUUID();
    const now = new Date().toISOString();
    const rawPayload = typeof data.rawPayload === 'object' ? JSON.stringify(data.rawPayload) : (data.rawPayload || '{}');

    const sql = `
      INSERT INTO payment_observations (
        id, receiving_account_id, source, amount_paise, observed_at,
        ingested_at, sender_vpa, bank_reference_number, fingerprint_hash,
        raw_payload, attribution_status, attributed_payment_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;

    this.db.execute(sql, [
      id,
      data.receivingAccountId,
      data.source,
      Number(data.amountPaise),
      data.observedAt.toISOString(),
      now,
      data.senderVpa || null,
      data.bankReferenceNumber || null,
      data.fingerprintHash,
      rawPayload,
      data.attributionStatus || ObservationAttributionStatus.UNATTRIBUTED,
      data.attributedPaymentId || null,
      now
    ]);

    return this.findById(id);
  }

  findById(id) {
    const row = this.db.queryOne('SELECT * FROM payment_observations WHERE id = ?', [id]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findByFingerprint(fingerprintHash) {
    const row = this.db.queryOne('SELECT * FROM payment_observations WHERE fingerprint_hash = ?', [fingerprintHash]);
    if (!row) return null;
    return this.mapRow(row);
  }

  findUnattributed(receivingAccountId) {
    const rows = this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ? AND attribution_status = ?
      ORDER BY observed_at ASC
    `, [receivingAccountId, ObservationAttributionStatus.UNATTRIBUTED]);

    return rows.map(r => this.mapRow(r));
  }

  findByReceivingAccount(receivingAccountId, limit = 50) {
    const rows = this.db.query(`
      SELECT * FROM payment_observations
      WHERE receiving_account_id = ?
      ORDER BY observed_at DESC
      LIMIT ?
    `, [receivingAccountId, limit]);

    return rows.map(r => this.mapRow(r));
  }

  markAttributed(id, paymentId) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?, attributed_payment_id = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.ATTRIBUTED, paymentId, id]);

    return this.findById(id);
  }

  markDuplicate(id) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.DUPLICATE_IGNORED, id]);

    return this.findById(id);
  }

  markAmbiguous(id) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.AMBIGUOUS, id]);

    return this.findById(id);
  }

  markLateUnmatched(id) {
    this.db.execute(`
      UPDATE payment_observations
      SET attribution_status = ?
      WHERE id = ?
    `, [ObservationAttributionStatus.LATE_UNMATCHED, id]);

    return this.findById(id);
  }

  mapRow(row) {
    return {
      id: row.id,
      receivingAccountId: row.receiving_account_id,
      source: row.source,
      amountPaise: BigInt(row.amount_paise),
      observedAt: new Date(row.observed_at),
      ingestedAt: new Date(row.ingested_at),
      senderVpa: row.sender_vpa,
      bankReferenceNumber: row.bank_reference_number,
      fingerprintHash: row.fingerprint_hash,
      rawPayload: JSON.parse(row.raw_payload || '{}'),
      attributionStatus: row.attribution_status,
      attributedPaymentId: row.attributed_payment_id,
      createdAt: new Date(row.created_at)
    };
  }
}
