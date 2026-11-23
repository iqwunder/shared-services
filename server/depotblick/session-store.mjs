import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

function parseEncryptionKey(value) {
    if (typeof value !== 'string' || !/^[\da-f]{64}$/i.test(value)) {
        throw new Error('DEPOTBLICK_SESSION_ENCRYPTION_KEY must be a 32-byte hexadecimal key.');
    }
    return Buffer.from(value, 'hex');
}

export class DepotblickSessionStore {
    constructor({ pool, encryptionKey } = {}) {
        if (!pool) throw new Error('A database pool is required for Depotblick session storage.');
        this.pool = pool;
        this.encryptionKey = parseEncryptionKey(encryptionKey);
    }

    async initialize() {
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS depotblick_accounts (
                id CHAR(36) NOT NULL PRIMARY KEY,
                label VARCHAR(60) NOT NULL,
                credentials_encrypted MEDIUMTEXT NOT NULL,
                status VARCHAR(24) NOT NULL DEFAULT 'disconnected',
                flow_id CHAR(36) NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
            )
        `);
        await this.pool.query(`
            CREATE TABLE IF NOT EXISTS depotblick_sessions (
                flow_id CHAR(36) NOT NULL PRIMARY KEY,
                account_id CHAR(36) NULL,
                status VARCHAR(24) NOT NULL,
                payload_encrypted MEDIUMTEXT NULL,
                ended_at DATETIME NULL,
                created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
                KEY depotblick_sessions_account_id (account_id)
            )
        `);

        const [accountRows] = await this.pool.query(
            'SELECT id, label, credentials_encrypted, status, flow_id FROM depotblick_accounts',
        );
        const [sessionRows] = await this.pool.query(
            `SELECT flow_id, account_id, status, payload_encrypted FROM depotblick_sessions
             WHERE status IN ('connected', 'tan-required')`,
        );

        return {
            accounts: accountRows.map((row) => ({
                id: row.id,
                label: row.label,
                credentials: this.decrypt(row.credentials_encrypted),
                status: row.status,
                flowId: row.flow_id,
            })),
            flows: sessionRows.map((row) => ({
                flowId: row.flow_id,
                accountId: row.account_id,
                payload: this.decrypt(row.payload_encrypted),
            })),
        };
    }

    async check() {
        await this.pool.query('SELECT 1');
    }

    async saveAccount(account) {
        await this.pool.execute(
            `INSERT INTO depotblick_accounts (id, label, credentials_encrypted, status, flow_id)
             VALUES (?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE label = VALUES(label),
                 credentials_encrypted = VALUES(credentials_encrypted),
                 status = VALUES(status), flow_id = VALUES(flow_id)`,
            [
                account.id,
                account.label,
                this.encrypt(account.credentials),
                account.status,
                account.flowId,
            ],
        );
    }

    async saveFlow(flow) {
        const payload = {
            flowId: flow.flowId,
            accountId: flow.accountId ?? null,
            clientId: flow.clientId,
            clientSecret: flow.clientSecret,
            accessToken: flow.accessToken,
            refreshToken: flow.refreshToken,
            expiresIn: flow.expiresIn,
            accessExpiresAt: flow.accessExpiresAt,
            stage: flow.stage,
            session: flow.session,
            challenge: flow.challenge,
            challengeAttempts: flow.challengeAttempts,
        };
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute(
                `INSERT INTO depotblick_sessions (flow_id, account_id, status, payload_encrypted, ended_at)
                 VALUES (?, ?, ?, ?, NULL)
                 ON DUPLICATE KEY UPDATE account_id = VALUES(account_id),
                     status = VALUES(status), payload_encrypted = VALUES(payload_encrypted), ended_at = NULL`,
                [flow.flowId, flow.accountId ?? null, flow.stage, this.encrypt(payload)],
            );
            if (flow.accountId) {
                await connection.execute(
                    'UPDATE depotblick_accounts SET status = ?, flow_id = ? WHERE id = ?',
                    [flow.stage, flow.flowId, flow.accountId],
                );
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async endFlow(flowId, accountId, accountStatus) {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute(
                `INSERT INTO depotblick_sessions (flow_id, account_id, status, payload_encrypted, ended_at)
                 VALUES (?, ?, 'ended', NULL, CURRENT_TIMESTAMP)
                 ON DUPLICATE KEY UPDATE account_id = VALUES(account_id), status = 'ended',
                     payload_encrypted = NULL, ended_at = CURRENT_TIMESTAMP`,
                [flowId, accountId ?? null],
            );
            if (accountId) {
                await connection.execute(
                    'UPDATE depotblick_accounts SET status = ?, flow_id = NULL WHERE id = ?',
                    [accountStatus, accountId],
                );
            }
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    async deleteAccount(accountId) {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            await connection.execute(
                `UPDATE depotblick_sessions SET status = 'ended', payload_encrypted = NULL,
                    ended_at = CURRENT_TIMESTAMP WHERE account_id = ?`,
                [accountId],
            );
            await connection.execute('DELETE FROM depotblick_accounts WHERE id = ?', [accountId]);
            await connection.commit();
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    encrypt(value) {
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
        const ciphertext = Buffer.concat([
            cipher.update(JSON.stringify(value), 'utf8'),
            cipher.final(),
        ]);
        return JSON.stringify({
            version: 1,
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
            ciphertext: ciphertext.toString('base64'),
        });
    }

    decrypt(value) {
        try {
            const envelope = JSON.parse(value);
            if (envelope.version !== 1) throw new Error('Unsupported encrypted record version.');
            const decipher = createDecipheriv(
                'aes-256-gcm',
                this.encryptionKey,
                Buffer.from(envelope.iv, 'base64'),
            );
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            const plaintext = Buffer.concat([
                decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
                decipher.final(),
            ]);
            return JSON.parse(plaintext.toString('utf8'));
        } catch (error) {
            throw new Error('Could not decrypt Depotblick data; verify the session encryption key.', { cause: error });
        }
    }
}
