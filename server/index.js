const cors = require('cors');
const express = require('express');
const path = require('node:path');
const { parse } = require('csv-parse/sync');
const multer = require('multer');
const mysql = require('mysql2/promise');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const port = Number(process.env.API_PORT || 3000);
const host = process.env.API_HOST || '127.0.0.1';
const allowedOrigins = (process.env.CORS_ORIGIN || [
    'http://localhost:4200',
    'http://127.0.0.1:4200',
    'http://localhost:4300',
    'http://127.0.0.1:4300',
].join(',')).split(',').map((origin) => origin.trim()).filter(Boolean);
const pool = mysql.createPool(process.env.DATABASE_URL || {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    database: process.env.DB_NAME || 'meterpulse',
    user: process.env.DB_USER || 'meterpulse',
    password: process.env.DB_PASSWORD || '',
    waitForConnections: true,
    connectionLimit: 10,
});
if (!process.env.BUECHEREI_DATABASE_URL) {
    throw new Error('BUECHEREI_DATABASE_URL muss gesetzt sein.');
}
const booksPool = mysql.createPool(process.env.BUECHEREI_DATABASE_URL);
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
const utilities = new Set(['electricity', 'gas', 'water']);
const unitFor = (utility) => utility === 'electricity' ? 'kWh' : 'm³';
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

app.use(cors({ origin: allowedOrigins }));
const depotblickApi = import('./depotblick/index.mjs');
depotblickApi.catch((error) => {
    console.error(JSON.stringify({
        event: 'depotblick.initialization_failed',
        errorType: error instanceof Error ? error.name : 'UnknownError',
        errorCode: error?.code ?? 'INITIALIZATION_FAILED',
    }));
});
app.use((req, res, next) => {
    if (!/^\/api\/(?:auth|accounts|instruments|portfolio|depot)(?:\/|$)/.test(req.path)) return next();
    depotblickApi
        .then(({ handleDepotblickRequest }) => handleDepotblickRequest(req, res))
        .catch(next);
});
app.use(express.json({ limit: '1mb' }));

function validDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateReading(input) {
    const utility = typeof input?.utility === 'string' ? input.utility.trim().toLowerCase() : '';
    const value = Number(input?.value);
    const recordedAt = input?.recordedAt ?? input?.date;

    if (!utilities.has(utility)) return { error: 'utility muss electricity, gas oder water sein.' };
    if (!Number.isFinite(value) || value < 0 || value > 999999999) return { error: 'value muss eine Zahl ab null sein.' };
    if (!validDate(recordedAt)) return { error: 'Das Datum muss ein gültiges Datum im Format YYYY-MM-DD sein.' };

    return { value: { utility, value, unit: unitFor(utility), recordedAt } };
}

const pvHeaderAliases = {
    datum: 'date',
    date: 'date',
    erzeugt: 'generated',
    erzeugung: 'generated',
    generated: 'generated',
    verbraucht: 'consumed',
    verbrauch: 'consumed',
    consumed: 'consumed',
    einspeisung: 'feedIn',
    feedin: 'feedIn',
    netzbezug: 'gridImport',
    gridimport: 'gridImport',
};

function normalizePvHeader(header) {
    const normalized = header.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-z]/g, '');
    return pvHeaderAliases[normalized] || normalized;
}

function parseEnergyValue(input) {
    const normalized = String(input ?? '').trim().replace(/\s/g, '').replace(',', '.');
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return Number.NaN;
    return Number(normalized);
}

function validatePvReading(input) {
    const recordedAt = input?.date;
    if (!validDate(recordedAt)) return { error: 'Das PV-Datum muss im Format YYYY-MM-DD vorliegen.' };

    const value = {
        recordedAt,
        generated: parseEnergyValue(input.generated),
        consumed: parseEnergyValue(input.consumed),
        feedIn: parseEnergyValue(input.feedIn),
        gridImport: parseEnergyValue(input.gridImport),
    };
    const invalidField = Object.entries(value).find(([field, amount]) =>
        field !== 'recordedAt' && (!Number.isFinite(amount) || amount < 0 || amount > 999999999.999),
    );
    if (invalidField) return { error: `Der PV-Wert für ${invalidField[0]} muss eine nichtnegative Zahl sein.` };

    return { value };
}

function validateContract(utility, input) {
    if (!utilities.has(utility)) return { error: 'Unbekannter Energieträger.' };

    const contractStart = input?.contractStart;
    const contractEnd = input?.contractEnd || null;
    if (!validDate(contractStart)) return { error: 'Der Vertragsstart muss ein gültiges Datum sein.' };
    if (contractEnd && !validDate(contractEnd)) return { error: 'Das Vertragsende muss ein gültiges Datum sein.' };
    if (contractEnd && contractEnd < contractStart) return { error: 'Das Vertragsende darf nicht vor dem Vertragsstart liegen.' };

    const value = {
        utility,
        contractStart,
        monthlyFee: parseEnergyValue(input?.monthlyFee),
        unitPrice: parseEnergyValue(input?.unitPrice),
        heatingValue: utility === 'gas' ? parseEnergyValue(input?.heatingValue) : null,
        conditionNumber: utility === 'gas' ? parseEnergyValue(input?.conditionNumber) : null,
        wastewaterPrice: utility === 'water' ? parseEnergyValue(input?.wastewaterPrice) : null,
        rainwaterPricePerSqm: utility === 'water' ? parseEnergyValue(input?.rainwaterPricePerSqm) : null,
        sealedAreaSqm: utility === 'water' ? parseEnergyValue(input?.sealedAreaSqm) : null,
        monthlyAdvance: parseEnergyValue(input?.monthlyAdvance),
        contractEnd,
    };
    const invalidField = ['monthlyFee', 'unitPrice', 'monthlyAdvance'].find((field) =>
        !Number.isFinite(value[field]) || value[field] < 0 || value[field] > 999999999.9999,
    );
    if (invalidField) return { error: `${invalidField} muss eine nichtnegative Zahl sein.` };
    if (utility === 'gas' && (!Number.isFinite(value.heatingValue) || value.heatingValue <= 0)) {
        return { error: 'Der Brennwert muss für Gas eine positive Zahl sein.' };
    }
    if (utility === 'gas' && (!Number.isFinite(value.conditionNumber) || value.conditionNumber <= 0)) {
        return { error: 'Die Zustandszahl muss für Gas eine positive Zahl sein.' };
    }
    if (utility === 'water') {
        const waterFieldLimits = {
            wastewaterPrice: 999999.999999,
            rainwaterPricePerSqm: 999999.999999,
            sealedAreaSqm: 99999999.9999,
        };
        const invalidWaterField = [
            ['wastewaterPrice', value.wastewaterPrice],
            ['rainwaterPricePerSqm', value.rainwaterPricePerSqm],
            ['sealedAreaSqm', value.sealedAreaSqm],
        ].find(([field, amount]) => !Number.isFinite(amount) || amount < 0 || amount > waterFieldLimits[field]);
        if (invalidWaterField) return { error: `${invalidWaterField[0]} muss eine nichtnegative Zahl sein.` };
    }

    return { value };
}

function validatePvFeedInContract(input) {
    const value = {
        grossPricePerKwh: parseEnergyValue(input?.grossPricePerKwh),
        vatRate: parseEnergyValue(input?.vatRate),
    };
    if (!Number.isFinite(value.grossPricePerKwh) || value.grossPricePerKwh < 0 || value.grossPricePerKwh > 999999.999999) {
        return { error: 'Der Bruttopreis pro kWh muss eine nichtnegative Zahl sein.' };
    }
    if (!Number.isFinite(value.vatRate) || value.vatRate < 0 || value.vatRate > 100) {
        return { error: 'Der Umsatzsteuersatz muss zwischen 0 und 100 Prozent liegen.' };
    }
    return { value };
}

function parseSignedEnergyValue(input) {
    const normalized = String(input ?? '').trim().replace(/\s/g, '').replace(',', '.');
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) return Number.NaN;
    return Number(normalized);
}

function validatePvUtilityPayments(yearInput, input) {
    const year = Number(yearInput);
    if (!/^\d{4}$/.test(String(yearInput)) || year < 1900 || year > 9999) {
        return { error: 'Das Jahr muss vierstellig zwischen 1900 und 9999 liegen.' };
    }
    if (!Array.isArray(input?.payments) || input.payments.length !== 12) {
        return { error: 'Es müssen genau zwölf Monatswerte übermittelt werden.' };
    }

    const months = new Set();
    const payments = [];
    for (const entry of input.payments) {
        const month = Number(entry?.month);
        if (!Number.isInteger(month) || month < 1 || month > 12 || months.has(month)) {
            return { error: 'Jeder Monat muss genau einmal zwischen 1 und 12 enthalten sein.' };
        }
        months.add(month);
        const rawAmount = entry?.receivedGross;
        const receivedGross = rawAmount === null || rawAmount === '' || rawAmount === undefined
            ? null
            : parseSignedEnergyValue(rawAmount);
        if (receivedGross !== null && (!Number.isFinite(receivedGross) || Math.abs(receivedGross) > 9999999999.99)) {
            return { error: 'Der Bruttobetrag muss im gültigen Zahlenbereich liegen.' };
        }
        payments.push({ year, month, receivedGross });
    }
    return { value: payments.sort((left, right) => left.month - right.month) };
}

app.get('/api/health', asyncRoute(async (_req, res) => {
    const { checkDepotblickStorage } = await depotblickApi;
    await Promise.all([pool.query('SELECT 1'), booksPool.query('SELECT 1'), checkDepotblickStorage()]);
    res.json({ status: 'ok' });
}));

app.get('/api/books', asyncRoute(async (req, res) => {
    const search = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    if (search.length > 200) return res.status(400).json({ error: 'Die Suche darf höchstens 200 Zeichen lang sein.' });

    let sql = `
        SELECT
            HEX(record_key) AS record_key,
            title,
            author,
            media_group,
            (cover IS NOT NULL AND OCTET_LENGTH(cover) > 0) AS has_cover
        FROM borrowed_books
    `;
    let parameters = [];
    if (search) {
        const pattern = `%${search.replace(/[!%_]/g, '!$&')}%`;
        sql += `
        WHERE title LIKE ? ESCAPE '!'
           OR author LIKE ? ESCAPE '!'
           OR media_group LIKE ? ESCAPE '!'
        `;
        parameters = [pattern, pattern, pattern];
    }
    sql += ' ORDER BY title, author';

    const [rows] = await booksPool.query(sql, parameters);
    res.json(rows.map((row) => {
        const key = row.record_key.toLowerCase();
        return {
            recordKey: key,
            title: row.title,
            author: row.author,
            mediaGroup: row.media_group,
            coverUrl: row.has_cover ? `/api/books/${key}/cover` : null,
        };
    }));
}));

app.get('/api/books/:recordKey/cover', asyncRoute(async (req, res) => {
    const { recordKey } = req.params;
    if (!/^[0-9a-f]{64}$/i.test(recordKey)) return res.status(404).json({ error: 'Cover nicht gefunden.' });

    const [rows] = await booksPool.execute(
        'SELECT cover, cover_mime FROM borrowed_books WHERE record_key = UNHEX(?)',
        [recordKey],
    );
    const row = rows[0];
    if (!row?.cover?.length) return res.status(404).json({ error: 'Cover nicht gefunden.' });

    let mediaType = row.cover_mime || 'application/octet-stream';
    if (!mediaType.startsWith('image/')) mediaType = 'application/octet-stream';
    res.set({
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Content-Type': mediaType,
    });
    res.send(row.cover);
}));

app.get('/api/contracts', asyncRoute(async (_req, res) => {
    const [rows] = await pool.query(`
        SELECT utility,
            DATE_FORMAT(contract_start, '%Y-%m-%d') AS contractStart,
            monthly_fee AS monthlyFee,
            unit_price AS unitPrice,
            heating_value AS heatingValue,
            condition_number AS conditionNumber,
            wastewater_price AS wastewaterPrice,
            rainwater_price_per_sqm AS rainwaterPricePerSqm,
            sealed_area_sqm AS sealedAreaSqm,
            monthly_advance AS monthlyAdvance,
            DATE_FORMAT(contract_end, '%Y-%m-%d') AS contractEnd
        FROM utility_contracts
    `);
    res.json(rows);
}));

app.put('/api/contracts/:utility', asyncRoute(async (req, res) => {
    const result = validateContract(req.params.utility, req.body);
    if (result.error) return res.status(400).json({ error: result.error });

    const contract = result.value;
    await pool.execute(`
        INSERT INTO utility_contracts
            (utility, contract_start, monthly_fee, unit_price, heating_value, condition_number,
            wastewater_price, rainwater_price_per_sqm, sealed_area_sqm, monthly_advance, contract_end)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
            contract_start = VALUES(contract_start),
            monthly_fee = VALUES(monthly_fee),
            unit_price = VALUES(unit_price),
            heating_value = VALUES(heating_value),
            condition_number = VALUES(condition_number),
            wastewater_price = VALUES(wastewater_price),
            rainwater_price_per_sqm = VALUES(rainwater_price_per_sqm),
            sealed_area_sqm = VALUES(sealed_area_sqm),
            monthly_advance = VALUES(monthly_advance),
            contract_end = VALUES(contract_end)
    `, [contract.utility, contract.contractStart, contract.monthlyFee, contract.unitPrice,
    contract.heatingValue, contract.conditionNumber, contract.wastewaterPrice, contract.rainwaterPricePerSqm,
    contract.sealedAreaSqm, contract.monthlyAdvance, contract.contractEnd]);

    res.json(contract);
}));

app.get('/api/readings', asyncRoute(async (req, res) => {
    const utility = req.query.utility;
    if (utility && !utilities.has(utility)) return res.status(400).json({ error: 'Unbekannter Energieträger.' });

    const sql = `SELECT id, utility, value, unit, DATE_FORMAT(recorded_at, '%Y-%m-%d') AS recordedAt
    FROM readings ${utility ? 'WHERE utility = ?' : ''} ORDER BY recorded_at DESC, id DESC`;
    const [rows] = await pool.query(sql, utility ? [utility] : []);
    res.json(rows);
}));

app.post('/api/readings', asyncRoute(async (req, res) => {
    const result = validateReading(req.body);
    if (result.error) return res.status(400).json({ error: result.error });

    const reading = result.value;
    const [insert] = await pool.execute(
        'INSERT INTO readings (utility, value, unit, recorded_at) VALUES (?, ?, ?, ?)',
        [reading.utility, reading.value, reading.unit, reading.recordedAt],
    );
    res.status(201).json({ id: insert.insertId, ...reading });
}));

app.post('/api/readings/import', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Bitte eine CSV-Datei auswählen.' });

    let records;
    try {
        records = parse(req.file.buffer, {
            bom: true,
            columns: (headers) => headers.map((header) => header.trim().toLowerCase()),
            delimiter: [',', ';'],
            skip_empty_lines: true,
            trim: true,
        });
    } catch {
        return res.status(400).json({ error: 'Die CSV-Datei konnte nicht gelesen werden.' });
    }

    if (records.length === 0) return res.status(400).json({ error: 'Die CSV-Datei enthält keine Messwerte.' });
    if (records.length > 5000) return res.status(400).json({ error: 'Pro Import sind höchstens 5.000 Messwerte erlaubt.' });
    const requiredHeaders = ['utility', 'value', 'date'];
    const headers = Object.keys(records[0]);
    const missing = requiredHeaders.filter((header) => !headers.includes(header));
    if (missing.length) return res.status(400).json({ error: `Fehlende CSV-Spalten: ${missing.join(', ')}.` });

    const valid = [];
    const errors = [];
    records.forEach((record, index) => {
        const result = validateReading(record);
        if (result.error) errors.push(`Zeile ${index + 2}: ${result.error}`);
        else valid.push(result.value);
    });
    if (errors.length) {
        const shown = errors.slice(0, 8).join(' ');
        const remainder = errors.length > 8 ? ` Weitere ${errors.length - 8} Fehler.` : '';
        return res.status(400).json({ error: `${shown}${remainder} Es wurde nichts importiert.` });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const reading of valid) {
            await connection.execute(
                'INSERT INTO readings (utility, value, unit, recorded_at) VALUES (?, ?, ?, ?)',
                [reading.utility, reading.value, reading.unit, reading.recordedAt],
            );
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    res.status(201).json({ imported: valid.length });
}));

app.get('/api/pv-readings', asyncRoute(async (_req, res) => {
    const [rows] = await pool.query(`
        SELECT DATE_FORMAT(recorded_at, '%Y-%m-%d') AS date,
            generated_kwh AS generated,
            consumed_kwh AS consumed,
            feed_in_kwh AS feedIn,
            grid_import_kwh AS gridImport
        FROM pv_daily_readings
        ORDER BY recorded_at DESC
    `);
    res.json(rows);
}));

app.get('/api/pv-contract', asyncRoute(async (_req, res) => {
    const [rows] = await pool.query(`
        SELECT gross_price_per_kwh AS grossPricePerKwh, vat_rate AS vatRate
        FROM pv_feed_in_contract
        WHERE id = 1
    `);
    res.json(rows[0] ?? null);
}));

app.put('/api/pv-contract', asyncRoute(async (req, res) => {
    const result = validatePvFeedInContract(req.body);
    if (result.error) return res.status(400).json({ error: result.error });

    const contract = result.value;
    await pool.execute(`
        INSERT INTO pv_feed_in_contract (id, gross_price_per_kwh, vat_rate)
        VALUES (1, ?, ?)
        ON DUPLICATE KEY UPDATE
            gross_price_per_kwh = VALUES(gross_price_per_kwh),
            vat_rate = VALUES(vat_rate)
    `, [contract.grossPricePerKwh, contract.vatRate]);
    res.json(contract);
}));

app.get('/api/pv-payments', asyncRoute(async (req, res) => {
    const year = String(req.query.year ?? '');
    if (!/^\d{4}$/.test(year) || Number(year) < 1900 || Number(year) > 9999) {
        return res.status(400).json({ error: 'Das Jahr muss vierstellig zwischen 1900 und 9999 liegen.' });
    }

    const [rows] = await pool.query(`
        SELECT payment_year AS year, payment_month AS month, received_gross AS receivedGross
        FROM pv_utility_payments
        WHERE payment_year = ?
        ORDER BY payment_month
    `, [Number(year)]);
    res.json(rows);
}));

app.put('/api/pv-payments/:year', asyncRoute(async (req, res) => {
    const result = validatePvUtilityPayments(req.params.year, req.body);
    if (result.error) return res.status(400).json({ error: result.error });

    const payments = result.value;
    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const payment of payments) {
            await connection.execute(`
                INSERT INTO pv_utility_payments (payment_year, payment_month, received_gross)
                VALUES (?, ?, ?)
                ON DUPLICATE KEY UPDATE received_gross = VALUES(received_gross)
            `, [payment.year, payment.month, payment.receivedGross]);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }
    res.json(payments);
}));

app.post('/api/pv-readings/import', upload.single('file'), asyncRoute(async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Bitte eine PV-CSV-Datei auswählen.' });

    let records;
    try {
        const firstLine = req.file.buffer.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/).find((line) => line.trim()) || '';
        const delimiter = firstLine.includes(';') ? ';' : ',';
        records = parse(req.file.buffer, {
            bom: true,
            columns: (headers) => headers.map(normalizePvHeader),
            delimiter,
            skip_empty_lines: true,
            trim: true,
        });
    } catch {
        return res.status(400).json({ error: 'Die PV-CSV-Datei konnte nicht gelesen werden.' });
    }

    if (records.length === 0) return res.status(400).json({ error: 'Die PV-CSV-Datei enthält keine Tageswerte.' });
    if (records.length > 5000) return res.status(400).json({ error: 'Pro PV-Import sind höchstens 5.000 Tageswerte erlaubt.' });

    const requiredHeaders = ['date', 'generated', 'consumed', 'feedIn', 'gridImport'];
    const headers = Object.keys(records[0]);
    const missing = requiredHeaders.filter((header) => !headers.includes(header));
    if (missing.length) return res.status(400).json({ error: `Fehlende PV-CSV-Spalten: ${missing.join(', ')}.` });

    const valid = [];
    const errors = [];
    const dates = new Set();
    records.forEach((record, index) => {
        const result = validatePvReading(record);
        if (result.error) {
            errors.push(`Zeile ${index + 2}: ${result.error}`);
        } else if (dates.has(result.value.recordedAt)) {
            errors.push(`Zeile ${index + 2}: Das Datum ${result.value.recordedAt} kommt mehrfach in der Datei vor.`);
        } else {
            dates.add(result.value.recordedAt);
            valid.push(result.value);
        }
    });

    if (errors.length) {
        const shown = errors.slice(0, 8).join(' ');
        const remainder = errors.length > 8 ? ` Weitere ${errors.length - 8} Fehler.` : '';
        return res.status(400).json({ error: `${shown}${remainder} Es wurde nichts importiert.` });
    }

    const connection = await pool.getConnection();
    try {
        await connection.beginTransaction();
        for (const reading of valid) {
            await connection.execute(`
                INSERT INTO pv_daily_readings
                    (recorded_at, generated_kwh, consumed_kwh, feed_in_kwh, grid_import_kwh)
                VALUES (?, ?, ?, ?, ?)
                ON DUPLICATE KEY UPDATE
                    generated_kwh = VALUES(generated_kwh),
                    consumed_kwh = VALUES(consumed_kwh),
                    feed_in_kwh = VALUES(feed_in_kwh),
                    grid_import_kwh = VALUES(grid_import_kwh)
            `, [reading.recordedAt, reading.generated, reading.consumed, reading.feedIn, reading.gridImport]);
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    } finally {
        connection.release();
    }

    res.status(201).json({ imported: valid.length });
}));

app.use((error, _req, res, _next) => {
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'Die CSV-Datei darf höchstens 5 MB groß sein.' });
    }
    console.error(error.message);
    res.status(500).json({ error: 'Interner Fehler. Bitte API- und Datenbankverbindung prüfen.' });
});

app.listen(port, host, () => console.log(`Shared API läuft auf http://${host}:${port}`));