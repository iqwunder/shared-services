import assert from 'node:assert/strict';
import test from 'node:test';
import { ComdirectAuthService } from './comdirect.mjs';
import { redactUrl } from './logging.mjs';

function response(body, { status = 200, headers = {} } = {}) {
    return new Response(JSON.stringify(body), { status, headers });
}

test('runs password grant, Push-TAN activation, cd_secondary and live portfolio requests', async () => {
    const requests = [];
    const replies = [
        response({ access_token: 'two-factor-token', refresh_token: 'first-refresh', expires_in: 599 }),
        response([{ identifier: 'session-id', sessionTanActive: false, activated2FA: false }]),
        response({ identifier: 'session-id' }, {
            status: 201,
            headers: { 'x-once-authentication-info': JSON.stringify({ id: 'challenge-id', typ: 'P_TAN_PUSH', availableTypes: ['P_TAN_PUSH', 'M_TAN'] }) },
        }),
        response({ identifier: 'session-id', sessionTanActive: true }),
        response({ access_token: 'brokerage-token', refresh_token: 'brokerage-refresh', expires_in: 599 }),
        response({ values: [{ depotId: 'depot-id', depotDisplayId: '123456' }] }),
        response({
            values: [{
                wkn: 'ETF01',
                quantity: { value: '2', unit: 'XXX' },
                currentPrice: { price: { value: '10.50', unit: 'EUR' } },
                currentValue: { value: '21.00', unit: 'EUR' },
                purchaseValue: { value: '20.00', unit: 'EUR' },
                prevDayValue: { value: '20.50', unit: 'EUR' },
                profitLossPurchaseRel: { percentString: '5.000' },
                instrument: { name: 'Demo ETF', isin: 'IE0000000000', mnemonic: 'ETF01', staticData: { instrumentType: 'ETF', sector: 'Technologie' } },
            }]
        }),
        new Response(null, { status: 204 }),
    ];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            const next = replies.shift();
            assert.ok(next, `unexpected request: ${url}`);
            return next;
        },
    });

    const login = await service.connect({
        clientId: 'client-id',
        clientSecret: 'client-secret',
        username: '12345678',
        password: 'secret-pin',
    });
    assert.equal(login.status, 'tan-required');
    assert.equal(login.challenge.typ, 'P_TAN_PUSH');
    assert.equal(JSON.stringify(login).includes('client-secret'), false);
    const passwordGrant = new URLSearchParams(requests[0].options.body);
    assert.equal(passwordGrant.get('grant_type'), 'password');
    assert.equal(passwordGrant.get('username'), '12345678');
    assert.equal(passwordGrant.get('password'), 'secret-pin');
    assert.equal(requests[1].options.headers.Authorization, 'Bearer two-factor-token');
    assert.equal(requests[1].options.headers['x-http-request-info'] !== undefined, true);
    assert.equal(requests[2].options.method, 'POST');

    const connected = await service.confirm({ flowId: login.flowId });
    assert.equal(connected.status, 'connected');
    assert.equal(requests[3].options.method, 'PATCH');
    assert.deepEqual(JSON.parse(requests[3].options.headers['x-once-authentication-info']), { id: 'challenge-id' });
    assert.equal(requests[3].options.headers['x-once-authentication'], undefined);
    assert.equal(JSON.parse(requests[3].options.body).sessionTanActive, true);
    const secondaryGrant = new URLSearchParams(requests[4].options.body);
    assert.equal(secondaryGrant.get('grant_type'), 'cd_secondary');
    assert.equal(secondaryGrant.get('token'), 'two-factor-token');

    const portfolio = await service.getPortfolio(login.flowId);
    assert.equal(requests[5].url, 'https://comdirect.test/api/brokerage/clients/user/v3/depots');
    assert.match(requests[6].url, /positions\?with-attr=instrument$/);
    assert.deepEqual(portfolio.depot, { depotId: 'depot-id', depotDisplayId: '123456' });
    assert.equal(portfolio.totals.currentValue, 21);
    assert.equal(portfolio.positions[0].name, 'Demo ETF');
    assert.equal(portfolio.positions[0].type, 'ETF');
    assert.equal(portfolio.positions[0].sector, 'Technologie');

    await service.logout(login.flowId);
    assert.equal(service.flows.has(login.flowId), false);
});

test('keeps multiple account credentials server-side and exposes only labels and connection state', async () => {
    const requests = [];
    const replies = [
        response({ access_token: 'two-factor-token-1', refresh_token: 'refresh-1', expires_in: 599 }),
        response([{ identifier: 'session-1', sessionTanActive: false, activated2FA: false }]),
        response({}, { status: 201, headers: { 'x-once-authentication-info': JSON.stringify({ id: 'challenge-1', typ: 'M_TAN' }) } }),
        response({ access_token: 'two-factor-token-2', refresh_token: 'refresh-2', expires_in: 599 }),
        response([{ identifier: 'session-2', sessionTanActive: false, activated2FA: false }]),
        response({}, { status: 201, headers: { 'x-once-authentication-info': JSON.stringify({ id: 'challenge-2', typ: 'M_TAN' }) } }),
        new Response(null, { status: 204 }),
        new Response(null, { status: 204 }),
    ];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return replies.shift();
        },
    });

    const first = service.createAccount({
        label: 'Privat', clientId: 'client-1', clientSecret: 'secret-1', username: 'user-1', password: 'pin-1',
    });
    const second = service.createAccount({
        label: 'Gemeinsam', clientId: 'client-2', clientSecret: 'secret-2', username: 'user-2', password: 'pin-2',
    });
    assert.deepEqual(service.listAccounts(), [
        { id: first.id, label: 'Privat', status: 'disconnected', active: false },
        { id: second.id, label: 'Gemeinsam', status: 'disconnected', active: false },
    ]);
    assert.equal(JSON.stringify(service.listAccounts()).includes('secret-1'), false);
    assert.equal(JSON.stringify(service.listAccounts()).includes('pin-1'), false);

    const firstLogin = await service.connectAccount(first.id);
    const secondLogin = await service.connectAccount(second.id);
    assert.equal(firstLogin.status, 'tan-required');
    assert.equal(secondLogin.status, 'tan-required');
    assert.equal(new URLSearchParams(requests[0].options.body).get('password'), 'pin-1');
    assert.equal(new URLSearchParams(requests[3].options.body).get('password'), 'pin-2');
    assert.deepEqual(service.listAccounts(firstLogin.flowId).map(({ label, status, active }) => ({ label, status, active })), [
        { label: 'Privat', status: 'tan-required', active: true },
        { label: 'Gemeinsam', status: 'tan-required', active: false },
    ]);

    const firstFlowId = service.getAccountFlowId(first.id);
    await service.deleteAccount(first.id);
    assert.equal(service.flows.has(firstFlowId), false);
    assert.equal(service.listAccounts().length, 1);
    await service.deleteAccount(second.id);
});

test('loads sorted historical depot values for a validated period', async () => {
    const requests = [];
    const replies = [
        response({ values: [{ depotId: 'depot-id' }] }),
        response({
            values: [
                { bookingDay: '2026-09-28', depotValue: { value: '1250.50', unit: 'EUR' }, purchaseValue: { value: '1100', unit: 'EUR' } },
                { bookingDay: '2026-09-26', depotValue: { value: '1200', unit: 'EUR' }, purchaseValue: { value: '1100', unit: 'EUR' } },
            ]
        }),
    ];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return replies.shift();
        },
    });
    const flow = {
        flowId: 'history-flow', clientId: 'id', clientSecret: 'secret', accessToken: 'access',
        refreshToken: 'refresh', accessExpiresAt: Date.now() + 10 * 60_000, stage: 'connected', expiryTimer: null,
    };
    service.storeFlow(flow);

    const values = await service.getHistoricalDepotValues(flow.flowId, '1W');
    assert.equal(requests[1].url, 'https://comdirect.test/api/brokerage/v3/depots/depot-id/historicaldepotvalues?period=1W');
    assert.deepEqual(values, [
        { bookingDay: '2026-09-26', depotValue: 1200, purchaseValue: 1100 },
        { bookingDay: '2026-09-28', depotValue: 1250.5, purchaseValue: 1100 },
    ]);
    await assert.rejects(service.getHistoricalDepotValues(flow.flowId, '2W'), { code: 'INVALID_HISTORY_PERIOD' });
    service.removeFlow(flow);
});

test('searches instruments and loads detail, price history, and profiles', async () => {
    const requests = [];
    const replies = [
        response({ values: [{ wkn: 'ETF01', name: 'Test ETF' }] }),
        response({ values: [{ wkn: 'ETF01', name: 'Test ETF', instrumentPerformance: { week: '2.1' } }] }),
        response({
            interval: 'TODAY', venueId: 'XETR', venueName: 'Xetra', quality: 'REALTIME',
            prices: [
                { type: 'LAST', price: { value: '123.45', unit: 'EUR' }, priceDateTime: '2026-09-25T12:00:00Z', quantity: { value: '2', unit: 'STK' } },
            ],
        }),
        response({ keyFigures: [{ name: 'KGV', value: '18.2' }] }),
    ];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return replies.shift();
        },
    });
    const flow = {
        flowId: 'instrument-flow', clientId: 'id', clientSecret: 'secret', accessToken: 'access',
        refreshToken: 'refresh', accessExpiresAt: Date.now() + 10 * 60_000, stage: 'connected', expiryTimer: null,
    };
    service.storeFlow(flow);

    assert.deepEqual(await service.searchInstruments(flow.flowId, 'test etf'), [{ wkn: 'ETF01', name: 'Test ETF' }]);
    const detail = await service.getInstrument(flow.flowId, 'ETF01');
    const prices = await service.getInstrumentPrices(flow.flowId, 'ETF01', 'TODAY', 'XETR');
    const profiles = await service.getInstrumentProfiles(flow.flowId, 'ETF01');
    assert.equal(new URL(requests[0].url).searchParams.get('searchtext'), 'test etf');
    const detailUrl = new URL(requests[1].url);
    assert.equal(detailUrl.pathname, '/api/brokerage/v1/instruments/ETF01');
    assert.deepEqual(detailUrl.searchParams.getAll('with-attr'), ['instrumentPrice', 'instrumentPerformance', 'derivativeData', 'fundDistribution']);
    const pricesUrl = new URL(requests[2].url);
    assert.equal(pricesUrl.pathname, '/api/brokerage/v1/instrumentprices/ETF01');
    assert.equal(pricesUrl.searchParams.get('interval'), 'TODAY');
    assert.equal(pricesUrl.searchParams.get('includeNewestPrice'), 'true');
    assert.equal(pricesUrl.searchParams.get('venueId'), 'XETR');
    assert.equal(requests[3].url, 'https://comdirect.test/api/brokerage/v1/instrumentprofiles/ETF01');
    assert.equal(detail.instrumentPerformance.week, '2.1');
    assert.equal(prices.length, 1);
    assert.equal(prices[0].prices[0].type, 'LAST');
    assert.equal(profiles.keyFigures[0].name, 'KGV');
    await assert.rejects(service.searchInstruments(flow.flowId, ' '), { code: 'SEARCH_TERM_REQUIRED' });
    await assert.rejects(service.getInstrumentPrices(flow.flowId, 'ETF01', '5YEAR'), { code: 'INVALID_INSTRUMENT_PRICE_PERIOD' });
    service.removeFlow(flow);
});

test('loads interval performance and aggregated analyst analyses', async () => {
    const requests = [];
    const replies = [
        response({ values: [{ interval: '1WEEK', profitLossRel: { percentString: '2.1' } }] }),
        response({
            matches: 1,
            aggregated: { instrumentId: 'ETF01', buy: 2, hold: 1, sell: 0 },
            values: [{
                dateTime: '2026-10-09T12:00:00Z', trend: 'BUY', title: 'Positive Einschätzung',
                text: 'Analyseinhalt', analyst: { name: 'Analysehaus', totalForecasts: 10 },
            }],
        }),
    ];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return replies.shift();
        },
    });
    const flow = {
        flowId: 'instrument-analysis-flow', clientId: 'id', clientSecret: 'secret', accessToken: 'access',
        refreshToken: 'refresh', accessExpiresAt: Date.now() + 10 * 60_000, stage: 'connected', expiryTimer: null,
    };
    service.storeFlow(flow);

    const performance = await service.getInstrumentPerformance(flow.flowId, 'ETF01', '1WEEK');
    const analyses = await service.getInstrumentAnalyses(flow.flowId, 'ETF01', '1YEAR');
    const performanceUrl = new URL(requests[0].url);
    assert.equal(performanceUrl.pathname, '/api/brokerage/v1/instrumentperformances/ETF01');
    assert.equal(performanceUrl.searchParams.get('interval'), '1WEEK');
    const analysesUrl = new URL(requests[1].url);
    assert.equal(analysesUrl.pathname, '/api/brokerage/v1/instrumentanalyses/ETF01');
    assert.equal(analysesUrl.searchParams.get('interval'), '1YEAR');
    assert.deepEqual(analysesUrl.searchParams.getAll('with-attr'), ['analyst', 'text']);
    assert.deepEqual(performance, { interval: '1WEEK', profitLossRel: { percentString: '2.1' } });
    assert.equal(analyses.aggregated.buy, 2);
    assert.equal(analyses.values[0].trend, 'BUY');
    assert.equal(analyses.values[0].text, 'Analyseinhalt');
    assert.equal(analyses.values[0].analyst.totalForecasts, 10);
    await assert.rejects(service.getInstrumentPerformance(flow.flowId, 'ETF01', 'TODAY'), {
        code: 'INVALID_INSTRUMENT_PERFORMANCE_PERIOD',
    });
    await assert.rejects(service.getInstrumentAnalyses(flow.flowId, 'ETF01', '5YEARS'), {
        code: 'INVALID_INSTRUMENT_ANALYSIS_PERIOD',
    });
    service.removeFlow(flow);
});

test('loads only instrumentPrice for ORB observations', async () => {
    const requests = [];
    const logs = [];
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        logger: { info: (message) => logs.push(message), warn: (message) => logs.push(message), error: (message) => logs.push(message) },
        fetchImpl: async (url, options) => {
            requests.push({ url: String(url), options });
            return response({
                values: [{
                    wkn: 'WKN123', instrumentPrice: {
                        prices: [{ type: 'LAST', price: { value: '123.45', unit: 'EUR' } }],
                    },
                }]
            });
        },
    });
    const flow = {
        flowId: 'orb-price-flow', clientId: 'id', clientSecret: 'secret', accessToken: 'access',
        refreshToken: 'refresh', accessExpiresAt: Date.now() + 10 * 60_000, stage: 'connected', expiryTimer: null,
    };
    service.storeFlow(flow);

    const detail = await service.getInstrumentPrice(flow.flowId, 'WKN123');
    const requestedUrl = new URL(requests[0].url);
    assert.equal(requestedUrl.pathname, '/api/brokerage/v1/instruments/WKN123');
    assert.deepEqual([...requestedUrl.searchParams.entries()], [['with-attr', 'instrumentPrice']]);
    assert.equal(detail.instrumentPrice.prices[0].type, 'LAST');
    const requestLog = logs.map((entry) => JSON.parse(entry)).find((entry) => entry.event === 'comdirect.http.complete');
    assert.equal(requestLog.finalUrl, 'https://comdirect.test/api/brokerage/v1/instruments/WKN123?with-attr=instrumentPrice');
    assert.equal(requestLog.status, 200);
    assert.equal(JSON.stringify(logs).includes('Bearer'), false);
    service.removeFlow(flow);
});

test('redacts session identifiers and sensitive URL parameters from logs', () => {
    assert.equal(
        redactUrl('https://comdirect.test/api/session/clients/user/v1/sessions/private-session/validate?client_secret=hidden'),
        'https://comdirect.test/api/session/clients/user/v1/sessions/[redacted]/validate?client_secret=%5Bredacted%5D',
    );
});

test('requires an entered TAN for non-push TAN challenges', async () => {
    const replies = [
        response({ access_token: 'two-factor-token', expires_in: 599 }),
        response([{ identifier: 'session-id', sessionTanActive: false }]),
        response({}, { status: 201, headers: { 'x-once-authentication-info': JSON.stringify({ id: 'challenge-id', typ: 'M_TAN' }) } }),
        new Response(null, { status: 204 }),
    ];
    const service = new ComdirectAuthService({ fetchImpl: async () => replies.shift() });
    const login = await service.connect({ clientId: 'id', clientSecret: 'secret', username: 'user', password: 'pin' });

    await assert.rejects(service.confirm({ flowId: login.flowId }), { code: 'TAN_REQUIRED' });
    assert.equal(service.flows.has(login.flowId), true);
    await service.logout(login.flowId);
});

test('refreshes expiring tokens with the documented refresh_token grant and rotates credentials in memory', async () => {
    let tokenRequest;
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            tokenRequest = { url: String(url), options };
            return response({ access_token: 'refreshed-access', refresh_token: 'rotated-refresh', expires_in: 599 });
        },
    });
    const flow = {
        flowId: 'refresh-flow',
        clientId: 'client-id',
        clientSecret: 'server-only-secret',
        accessToken: 'expired-access',
        refreshToken: 'old-refresh',
        expiresIn: 0,
        accessExpiresAt: Date.now() - 1,
        stage: 'connected',
        expiryTimer: null,
    };
    service.storeFlow(flow);

    await service.ensureFreshToken(flow);
    const form = new URLSearchParams(tokenRequest.options.body);
    assert.equal(tokenRequest.url, 'https://comdirect.test/oauth/token');
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'old-refresh');
    assert.equal(form.get('client_secret'), 'server-only-secret');
    assert.equal(flow.accessToken, 'refreshed-access');
    assert.equal(flow.refreshToken, 'rotated-refresh');
    assert.ok(flow.accessExpiresAt > Date.now());
    assert.equal(service.publicFlow(flow).clientSecret, undefined);

    service.removeFlow(flow);
    assert.equal(flow.clientSecret, '');
    assert.equal(flow.refreshToken, '');
});

test('restores a connected flow and refreshes its token during keepalive before the five-minute expiry window', async () => {
    let tokenRequest;
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            tokenRequest = { url: String(url), options };
            return response({ access_token: 'kept-alive-access', refresh_token: 'rotated-refresh', expires_in: 599 });
        },
    });
    const flow = {
        flowId: 'persistent-flow',
        clientId: 'client-id',
        clientSecret: 'server-only-secret',
        accessToken: 'current-access',
        refreshToken: 'current-refresh',
        expiresIn: 599,
        accessExpiresAt: Date.now() + 4 * 60 * 1000,
        stage: 'connected',
        expiryTimer: null,
    };
    service.storeFlow(flow);

    assert.equal(service.getSession(flow.flowId).status, 'connected');
    await service.keepAlive(flow.flowId);

    const form = new URLSearchParams(tokenRequest.options.body);
    assert.equal(tokenRequest.url, 'https://comdirect.test/oauth/token');
    assert.equal(form.get('grant_type'), 'refresh_token');
    assert.equal(form.get('refresh_token'), 'current-refresh');
    assert.equal(flow.accessToken, 'kept-alive-access');
    assert.equal(flow.refreshToken, 'rotated-refresh');
    assert.equal(flow.expiryTimer, null);
    assert.equal(service.flows.has(flow.flowId), true);

    await service.logout(flow.flowId);
    assert.equal(service.flows.has(flow.flowId), false);
});

test('refreshes connected flows in the server process without a browser keepalive request', async () => {
    let refreshRequest;
    let refreshStarted;
    const refreshStartedPromise = new Promise((resolve) => { refreshStarted = resolve; });
    const service = new ComdirectAuthService({
        origin: 'https://comdirect.test',
        fetchImpl: async (url, options) => {
            refreshRequest = { url: String(url), options };
            refreshStarted();
            return response({ access_token: 'background-access', refresh_token: 'background-refresh', expires_in: 599 });
        },
    });
    const flow = {
        flowId: 'background-keepalive-flow',
        clientId: 'id',
        clientSecret: 'server-only-secret',
        accessToken: 'expired-access',
        refreshToken: 'old-refresh',
        accessExpiresAt: Date.now() - 1,
        stage: 'connected',
        expiryTimer: null,
        keepAliveTimer: null,
    };
    service.storeFlow(flow);

    await refreshStartedPromise;
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(refreshRequest.url, 'https://comdirect.test/oauth/token');
    assert.equal(new URLSearchParams(refreshRequest.options.body).get('grant_type'), 'refresh_token');
    assert.equal(flow.accessToken, 'background-access');
    assert.equal(flow.refreshToken, 'background-refresh');
    service.removeFlow(flow);
});

test('shares one refresh request across concurrent API calls', async () => {
    let calls = 0;
    let release;
    const refreshResponse = new Promise((resolve) => { release = resolve; });
    const service = new ComdirectAuthService({
        fetchImpl: async () => {
            calls += 1;
            return refreshResponse;
        },
    });
    const flow = {
        flowId: 'concurrent-flow', clientId: 'id', clientSecret: 'secret',
        accessToken: 'expired', refreshToken: 'refresh', expiresIn: 0,
        accessExpiresAt: Date.now() - 1, stage: 'connected', expiryTimer: null,
    };
    service.storeFlow(flow);

    const first = service.ensureFreshToken(flow);
    const second = service.ensureFreshToken(flow);
    assert.equal(calls, 1);
    release(response({ access_token: 'fresh', refresh_token: 'rotated', expires_in: 599 }));
    await Promise.all([first, second]);
    assert.equal(calls, 1);
    assert.equal(flow.accessToken, 'fresh');
    service.removeFlow(flow);
});

test('stops after two rejected TAN entries before the bank can lock the account', async () => {
    const replies = [
        response({ access_token: 'two-factor-token', expires_in: 599 }),
        response([{ identifier: 'session-id', sessionTanActive: false }]),
        response({}, { status: 201, headers: { 'x-once-authentication-info': JSON.stringify({ id: 'challenge-id', typ: 'M_TAN' }) } }),
        response({}, { status: 422 }),
        response({}, { status: 422 }),
    ];
    const service = new ComdirectAuthService({ fetchImpl: async () => replies.shift() });
    const login = await service.connect({ clientId: 'id', clientSecret: 'secret', username: 'user', password: 'pin' });

    await assert.rejects(service.confirm({ flowId: login.flowId, tan: '000000' }), { code: 'COMDIRECT_REQUEST_REJECTED' });
    await assert.rejects(service.confirm({ flowId: login.flowId, tan: '111111' }), { code: 'TAN_ATTEMPTS_STOPPED' });
    assert.equal(service.flows.has(login.flowId), false);
});