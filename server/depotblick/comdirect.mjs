import { randomUUID } from 'node:crypto';
import { logEvent, redactUrl } from './logging.mjs';

const tokenPath = '/oauth/token';
const sessionPath = '/api/session/clients/user/v1/sessions';
const idleLifetimeMs = 30 * 60 * 1000;
const refreshSkewMs = 5 * 60 * 1000;
const historicalPeriods = new Set(['1W', '1M', '3M', '1Y', '5Y', '10Y']);
const instrumentPriceIntervals = new Set(['TODAY', '1WEEK', '1MONTH', '3MONTHS', '1YEAR', '5YEARS']);
const instrumentPerformanceIntervals = new Set(['1WEEK', '1MONTH', '3MONTHS', '1YEAR', '5YEARS']);
const instrumentAnalysisIntervals = new Set(['1WEEK', '1MONTH', '3MONTHS', '1YEAR']);
const instrumentAttributes = ['instrumentPrice', 'instrumentPerformance', 'derivativeData', 'fundDistribution'];

export class ApiError extends Error {
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
    }
}

function parseJsonHeader(value) {
    if (!value) return null;
    try {
        return JSON.parse(value);
    } catch {
        throw new ApiError(502, 'COMDIRECT_INVALID_RESPONSE', 'comdirect hat eine ungültige TAN-Challenge zurückgegeben.');
    }
}

function amount(value) {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') return Number.parseFloat(value) || 0;
    if (!value || typeof value !== 'object') return 0;
    if (value.value !== undefined) return amount(value.value);
    if (value.percentString !== undefined) return amount(value.percentString);
    if (value.price !== undefined) return amount(value.price);
    return 0;
}

function listValues(resource) {
    if (Array.isArray(resource)) return resource;
    if (Array.isArray(resource?.values)) return resource.values;
    return [];
}

function safeErrorMessage(status) {
    if (status === 401 || status === 403) return 'comdirect hat die Anmeldung oder Berechtigung abgelehnt. Bitte Zugangsdaten und Freigabe prüfen.';
    if (status === 422) return 'comdirect konnte die TAN-Freigabe nicht verarbeiten. Bitte TAN und photoTAN-App prüfen.';
    if (status === 429) return 'comdirect hat zu viele Anfragen erkannt. Bitte später erneut versuchen.';
    return 'Die comdirect-Schnittstelle ist derzeit nicht erreichbar oder hat die Anfrage abgelehnt.';
}

export class ComdirectAuthService {
    constructor({ origin = process.env.COMDIRECT_API_ORIGIN ?? 'https://api.comdirect.de', fetchImpl = fetch, logger = console } = {}) {
        this.origin = origin.replace(/\/$/, '');
        this.fetch = fetchImpl;
        this.logger = logger;
        this.flows = new Map();
        this.accounts = new Map();
    }

    createAccount({ clientId, clientSecret, username, password, label } = {}) {
        if (![clientId, clientSecret, username, password].every((value) => typeof value === 'string' && value.trim())) {
            throw new ApiError(400, 'LOGIN_FIELDS_REQUIRED', 'Bitte Client ID, Client Secret, Benutzername und Kennwort ausfüllen.');
        }
        if (label !== undefined && (typeof label !== 'string' || label.trim().length > 60)) {
            throw new ApiError(400, 'INVALID_ACCOUNT_LABEL', 'Die Bezeichnung darf höchstens 60 Zeichen lang sein.');
        }
        const id = randomUUID();
        const account = {
            id,
            label: label?.trim() || `Zugang ${this.accounts.size + 1}`,
            credentials: {
                clientId: clientId.trim(),
                clientSecret,
                username: username.trim(),
                password,
            },
            flowId: null,
            connectPromise: null,
        };
        this.accounts.set(id, account);
        return this.publicAccount(account);
    }

    listAccounts(activeFlowId = '') {
        return [...this.accounts.values()].map((account) => ({
            ...this.publicAccount(account),
            active: account.flowId === activeFlowId,
        }));
    }

    async connectAccount(accountId) {
        const account = this.accounts.get(accountId);
        if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Der gespeicherte Zugang wurde nicht gefunden.');
        const currentFlow = this.flows.get(account.flowId);
        if (currentFlow) return this.publicFlow(currentFlow);
        if (!account.connectPromise) {
            account.connectPromise = this.connect(account.credentials)
                .then((result) => {
                    account.flowId = result.flowId;
                    return result;
                })
                .finally(() => {
                    account.connectPromise = null;
                });
        }
        return account.connectPromise;
    }

    getAccountFlowId(accountId) {
        const account = this.accounts.get(accountId);
        if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Der gespeicherte Zugang wurde nicht gefunden.');
        if (!this.flows.has(account.flowId)) {
            account.flowId = null;
            throw new ApiError(409, 'ACCOUNT_NOT_CONNECTED', 'Dieser Zugang hat keine aktive comdirect-Session. Bitte erneut verbinden.');
        }
        return account.flowId;
    }

    async deleteAccount(accountId) {
        const account = this.accounts.get(accountId);
        if (!account) throw new ApiError(404, 'ACCOUNT_NOT_FOUND', 'Der gespeicherte Zugang wurde nicht gefunden.');
        const flowId = account.flowId;
        try {
            if (flowId) await this.logout(flowId);
        } finally {
            account.credentials.clientId = '';
            account.credentials.clientSecret = '';
            account.credentials.username = '';
            account.credentials.password = '';
            this.accounts.delete(accountId);
        }
        return flowId;
    }

    async connect(credentials) {
        const { clientId, clientSecret, username, password } = credentials ?? {};
        if (![clientId, clientSecret, username, password].every((value) => typeof value === 'string' && value.trim())) {
            throw new ApiError(400, 'LOGIN_FIELDS_REQUIRED', 'Bitte Client ID, Client Secret, Benutzername und Kennwort ausfüllen.');
        }

        const initialTokens = await this.requestTokens({
            client_id: clientId.trim(),
            client_secret: clientSecret,
            grant_type: 'password',
            username: username.trim(),
            password,
        });
        const flowId = randomUUID();
        const flow = {
            flowId,
            closed: false,
            clientId: clientId.trim(),
            clientSecret,
            accessToken: initialTokens.access_token,
            refreshToken: initialTokens.refresh_token,
            expiresIn: initialTokens.expires_in,
            accessExpiresAt: Date.now() + (Number(initialTokens.expires_in) || 599) * 1000,
            stage: 'tan-required',
            session: null,
            challenge: null,
            challengeAttempts: 0,
            failedTanAttempts: 0,
            expiryTimer: null,
        };

        const sessions = await this.requestJson(sessionPath, flow, { method: 'GET' });
        flow.session = listValues(sessions).find((session) => session?.identifier);
        if (!flow.session) {
            throw new ApiError(502, 'COMDIRECT_SESSION_MISSING', 'comdirect hat keine gültige API-Session zurückgegeben.');
        }

        if (flow.session.sessionTanActive && flow.session.activated2FA) {
            await this.exchangeSecondaryToken(flow);
        } else {
            flow.challenge = await this.requestTanChallenge(flow);
            flow.challengeAttempts = 1;
        }

        this.storeFlow(flow);
        return this.publicFlow(flow);
    }

    async confirm({ flowId, tan } = {}) {
        const flow = this.getFlow(flowId, 'tan-required');
        const isPushTan = flow.challenge.typ === 'P_TAN_PUSH';
        const tanValue = typeof tan === 'string' ? tan.trim() : '';
        if (!isPushTan && !tanValue) {
            throw new ApiError(400, 'TAN_REQUIRED', 'Bitte die TAN aus der photoTAN-Grafik oder SMS eingeben.');
        }

        const headers = {
            'x-once-authentication-info': JSON.stringify({ id: flow.challenge.id }),
        };
        if (!isPushTan) headers['x-once-authentication'] = tanValue;

        let response;
        try {
            response = await this.requestJson(`${sessionPath}/${encodeURIComponent(flow.session.identifier)}`, flow, {
                method: 'PATCH',
                body: {
                    identifier: flow.session.identifier,
                    sessionTanActive: true,
                    activated2FA: true,
                },
                extraHeaders: headers,
            });
        } catch (error) {
            if (error instanceof ApiError && error.status === 422 && !isPushTan) {
                flow.failedTanAttempts += 1;
                if (flow.failedTanAttempts >= 2) {
                    this.removeFlow(flow);
                    throw new ApiError(422, 'TAN_ATTEMPTS_STOPPED', 'Zwei TAN-Versuche sind fehlgeschlagen. Der Login wurde zum Schutz vor einer Kontosperre beendet.');
                }
            }
            throw error;
        }

        if (response?.sessionTanActive === false) {
            throw new ApiError(409, 'TAN_NOT_ACTIVE', 'Die Session-TAN wurde noch nicht aktiviert. Bestätige die Anfrage in der photoTAN-App und versuche es erneut.');
        }

        try {
            await this.exchangeSecondaryToken(flow);
        } catch (error) {
            this.removeFlow(flow);
            throw error;
        }

        this.storeFlow(flow);
        return this.publicFlow(flow);
    }

    async changeTanType({ flowId, tanType } = {}) {
        const flow = this.getFlow(flowId, 'tan-required');
        if (typeof tanType !== 'string' || !flow.challenge?.availableTypes.includes(tanType)) {
            throw new ApiError(400, 'TAN_TYPE_UNAVAILABLE', 'Dieses TAN-Verfahren ist für das Konto nicht verfügbar.');
        }
        if (tanType === flow.challenge.typ) return this.publicFlow(flow);
        if (flow.challengeAttempts >= 4) {
            this.removeFlow(flow);
            throw new ApiError(429, 'TAN_CHALLENGE_LIMIT', 'Zu viele TAN-Anfragen. Der Login wurde zum Schutz vor einer Kontosperre beendet.');
        }

        flow.challenge = await this.requestTanChallenge(flow, tanType);
        flow.challengeAttempts += 1;
        this.storeFlow(flow);
        return this.publicFlow(flow);
    }

    async getPortfolio(flowId) {
        const flow = this.getFlow(flowId, 'connected');
        const depotsResource = await this.requestJson('/api/brokerage/clients/user/v3/depots', flow, { method: 'GET' });
        const depots = listValues(depotsResource);
        const depot = depots[0];
        if (!depot?.depotId) {
            return { depot: null, totals: this.emptyTotals(), positions: [], lastUpdate: null };
        }

        const positionsResource = await this.requestJson(
            `/api/brokerage/v3/depots/${encodeURIComponent(depot.depotId)}/positions?with-attr=instrument`,
            flow,
            { method: 'GET' },
        );
        const rawPositions = listValues(positionsResource);
        const positions = rawPositions.map((position, index) => this.mapPosition(position, index));
        const totals = positions.reduce((result, position) => ({
            currentValue: result.currentValue + position.value,
            purchaseValue: result.purchaseValue + position.purchaseValue,
            previousDayValue: result.previousDayValue + position.previousDayValue,
        }), this.emptyTotals());
        totals.profitLossPurchaseAbs = totals.currentValue - totals.purchaseValue;
        totals.profitLossPurchaseRel = totals.purchaseValue ? (totals.profitLossPurchaseAbs / totals.purchaseValue) * 100 : 0;
        totals.profitLossPrevDayAbs = totals.currentValue - totals.previousDayValue;
        totals.profitLossPrevDayRel = totals.previousDayValue ? (totals.profitLossPrevDayAbs / totals.previousDayValue) * 100 : 0;

        return {
            depot: { depotId: depot.depotId, depotDisplayId: depot.depotDisplayId ?? '' },
            totals,
            positions: positions.map(({ purchaseValue, previousDayValue, ...position }) => position),
            lastUpdate: positionsResource?.aggregated?.depot?.dateLastUpdate ?? null,
        };
    }

    async getHistoricalDepotValues(flowId, period = '1W') {
        const flow = this.getFlow(flowId, 'connected');
        if (!historicalPeriods.has(period)) {
            throw new ApiError(400, 'INVALID_HISTORY_PERIOD', 'Der ausgewählte Zeitraum ist nicht verfügbar.');
        }
        const depotsResource = await this.requestJson('/api/brokerage/clients/user/v3/depots', flow, { method: 'GET' });
        const depot = listValues(depotsResource).find((value) => value?.depotId);
        if (!depot) return [];

        const resource = await this.requestJson(
            `/api/brokerage/v3/depots/${encodeURIComponent(depot.depotId)}/historicaldepotvalues?period=${period}`,
            flow,
            { method: 'GET' },
        );
        return listValues(resource)
            .filter((value) => typeof value?.bookingDay === 'string')
            .map((value) => ({
                bookingDay: value.bookingDay,
                depotValue: amount(value.depotValue),
                purchaseValue: amount(value.purchaseValue),
            }))
            .sort((left, right) => left.bookingDay.localeCompare(right.bookingDay));
    }

    async searchInstruments(flowId, term) {
        const flow = this.getFlow(flowId, 'connected');
        term = typeof term === 'string' ? term.trim() : '';
        if (!term) throw new ApiError(400, 'SEARCH_TERM_REQUIRED', 'Bitte einen Suchbegriff eingeben.');
        const query = new URLSearchParams({ searchtext: term });
        const resource = await this.requestJson(`/api/brokerage/v1/instruments?${query}`, flow, { method: 'GET' });
        return listValues(resource);
    }

    async getInstrument(flowId, identifier) {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        const query = new URLSearchParams();
        for (const attribute of instrumentAttributes) query.append('with-attr', attribute);
        const resource = await this.requestJson(
            `/api/brokerage/v1/instruments/${encodeURIComponent(instrumentId)}?${query}`,
            flow,
            { method: 'GET' },
        );
        return listValues(resource)[0] ?? resource;
    }

    async getInstrumentPrice(flowId, identifier) {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        const query = new URLSearchParams({ 'with-attr': 'instrumentPrice' });
        const resource = await this.requestJson(
            `/api/brokerage/v1/instruments/${encodeURIComponent(instrumentId)}?${query}`,
            flow,
            { method: 'GET' },
        );
        return listValues(resource)[0] ?? resource;
    }

    async getInstrumentPrices(flowId, identifier, interval = '1WEEK', venueId = '') {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        if (!instrumentPriceIntervals.has(interval)) {
            throw new ApiError(400, 'INVALID_INSTRUMENT_PRICE_PERIOD', 'Der ausgewählte Kurszeitraum ist nicht verfügbar.');
        }
        const query = new URLSearchParams({ interval, includeNewestPrice: 'true' });
        if (typeof venueId === 'string' && venueId.trim()) query.set('venueId', venueId.trim());
        const resource = await this.requestJson(
            `/api/brokerage/v1/instrumentprices/${encodeURIComponent(instrumentId)}?${query}`,
            flow,
            { method: 'GET' },
        );
        return Array.isArray(resource?.prices) ? [resource] : listValues(resource);
    }

    async getInstrumentProfiles(flowId, identifier) {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        const resource = await this.requestJson(
            `/api/brokerage/v1/instrumentprofiles/${encodeURIComponent(instrumentId)}`,
            flow,
            { method: 'GET' },
        );
        return listValues(resource)[0] ?? resource;
    }

    async getInstrumentPerformance(flowId, identifier, interval) {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        if (!instrumentPerformanceIntervals.has(interval)) {
            throw new ApiError(400, 'INVALID_INSTRUMENT_PERFORMANCE_PERIOD', 'Der ausgewählte Performance-Zeitraum ist nicht verfügbar.');
        }
        const query = new URLSearchParams({ interval });
        const resource = await this.requestJson(
            `/api/brokerage/v1/instrumentperformances/${encodeURIComponent(instrumentId)}?${query}`,
            flow,
            { method: 'GET' },
        );
        return listValues(resource)[0] ?? resource;
    }

    async getInstrumentAnalyses(flowId, identifier, interval = '1YEAR') {
        const flow = this.getFlow(flowId, 'connected');
        const instrumentId = this.requireInstrumentIdentifier(identifier);
        if (!instrumentAnalysisIntervals.has(interval)) {
            throw new ApiError(400, 'INVALID_INSTRUMENT_ANALYSIS_PERIOD', 'Der ausgewählte Analyse-Zeitraum ist nicht verfügbar.');
        }
        const query = new URLSearchParams({ interval });
        query.append('with-attr', 'analyst');
        query.append('with-attr', 'text');
        return this.requestJson(
            `/api/brokerage/v1/instrumentanalyses/${encodeURIComponent(instrumentId)}?${query}`,
            flow,
            { method: 'GET' },
        );
    }

    requireInstrumentIdentifier(identifier) {
        if (typeof identifier !== 'string' || !identifier.trim() || identifier.length > 80) {
            throw new ApiError(400, 'INSTRUMENT_ID_REQUIRED', 'Die Instrumentkennung fehlt oder ist ungültig.');
        }
        return identifier.trim();
    }

    getSession(flowId) {
        const flow = this.flows.get(flowId);
        if (!flow) throw new ApiError(410, 'FLOW_EXPIRED', 'Die Anmeldung ist abgelaufen. Bitte erneut anmelden.');
        return this.publicFlow(flow);
    }

    async keepAlive(flowId) {
        const flow = this.getFlow(flowId, 'connected');
        await this.ensureFreshToken(flow);
        return { status: 'connected' };
    }

    async logout(flowId) {
        const flow = this.flows.get(flowId);
        if (!flow) return;
        try {
            if (flow.accessToken) {
                await this.fetchLogged(`${this.origin}/oauth/revoke`, {
                    method: 'DELETE',
                    headers: { Accept: 'application/json', Authorization: `Bearer ${flow.accessToken}` },
                });
            }
        } finally {
            this.removeFlow(flow);
        }
    }

    async requestTanChallenge(flow, tanType) {
        const response = await this.requestJson(`${sessionPath}/${encodeURIComponent(flow.session.identifier)}/validate`, flow, {
            method: 'POST',
            body: { identifier: flow.session.identifier, sessionTanActive: true, activated2FA: true },
            extraHeaders: tanType ? { 'x-once-authentication-info': JSON.stringify({ typ: tanType }) } : {},
            includeResponse: true,
        });
        const challenge = parseJsonHeader(response.headers.get('x-once-authentication-info'));
        if (!challenge?.id || !challenge?.typ) {
            throw new ApiError(502, 'COMDIRECT_CHALLENGE_MISSING', 'comdirect hat keine TAN-Challenge zurückgegeben.');
        }
        return {
            id: String(challenge.id),
            typ: String(challenge.typ),
            challenge: typeof challenge.challenge === 'string' ? challenge.challenge : null,
            availableTypes: Array.isArray(challenge.availableTypes) ? challenge.availableTypes.filter((type) => typeof type === 'string') : [],
        };
    }

    async exchangeSecondaryToken(flow) {
        const tokens = await this.requestTokens({
            client_id: flow.clientId,
            client_secret: flow.clientSecret,
            grant_type: 'cd_secondary',
            token: flow.accessToken,
        });
        flow.accessToken = tokens.access_token;
        flow.refreshToken = tokens.refresh_token;
        flow.expiresIn = tokens.expires_in;
        flow.accessExpiresAt = Date.now() + (Number(tokens.expires_in) || 599) * 1000;
        flow.stage = 'connected';
        flow.challenge = null;
    }

    async requestTokens(form) {
        let response;
        try {
            response = await this.fetchLogged(`${this.origin}${tokenPath}`, {
                method: 'POST',
                headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams(form),
            });
        } catch {
            throw new ApiError(502, 'COMDIRECT_UNAVAILABLE', 'Die comdirect-Token-Schnittstelle ist nicht erreichbar.');
        }
        const data = await this.jsonBody(response);
        if (!response.ok) throw new ApiError(401, 'COMDIRECT_TOKEN_REJECTED', safeErrorMessage(response.status));
        if (!data?.access_token) throw new ApiError(502, 'COMDIRECT_TOKEN_MISSING', 'comdirect hat keinen Access-Token zurückgegeben.');
        return data;
    }

    async requestJson(path, flow, { method, body, extraHeaders = {}, includeResponse = false } = {}) {
        await this.ensureFreshToken(flow);
        const headers = {
            Accept: 'application/json',
            Authorization: `Bearer ${flow.accessToken}`,
            'x-http-request-info': JSON.stringify({
                clientRequestId: {
                    sessionId: flow.flowId.replaceAll('-', '').slice(0, 32),
                    requestId: randomUUID().replaceAll('-', '').slice(0, 15),
                },
            }),
            ...extraHeaders,
        };
        const options = { method, headers };
        if (body !== undefined) {
            headers['Content-Type'] = 'application/json';
            options.body = JSON.stringify(body);
        }

        let response;
        try {
            response = await this.fetchLogged(`${this.origin}${path}`, options);
        } catch {
            throw new ApiError(502, 'COMDIRECT_UNAVAILABLE', 'Die comdirect-API ist nicht erreichbar.');
        }
        const data = await this.jsonBody(response);
        if (!response.ok) throw new ApiError(response.status === 422 ? 422 : 502, 'COMDIRECT_REQUEST_REJECTED', safeErrorMessage(response.status));
        if (this.flows.has(flow.flowId)) this.storeFlow(flow);
        return includeResponse ? { data, headers: response.headers } : data;
    }

    async fetchLogged(url, options) {
        const startedAt = performance.now();
        const requestedUrl = redactUrl(url);
        const method = options.method ?? 'GET';
        try {
            const response = await this.fetch(url, options);
            logEvent(this.logger, response.ok ? 'info' : 'warn', 'comdirect.http.complete', {
                method,
                requestedUrl,
                finalUrl: redactUrl(response.url || url),
                status: response.status,
                durationMs: Math.round(performance.now() - startedAt),
            });
            return response;
        } catch (error) {
            logEvent(this.logger, 'error', 'comdirect.http.failed', {
                method,
                requestedUrl,
                durationMs: Math.round(performance.now() - startedAt),
                errorType: error instanceof Error ? error.name : 'UnknownError',
            });
            throw error;
        }
    }

    async jsonBody(response) {
        try {
            return await response.json();
        } catch {
            return null;
        }
    }

    mapPosition(position, index) {
        const instrument = position.instrument ?? {};
        const instrumentType = instrument.staticData?.instrumentType ?? 'NOT_AVAILABLE';
        const typeInfo = {
            ETF: ['ETF', '#a9c64a'],
            SHARE: ['Aktie', '#46766d'],
            BONDS: ['Anleihe', '#6589a1'],
            FUND: ['Fonds', '#d5a34b'],
            CERTIFICATE: ['Zertifikat', '#bd7651'],
            WARRANT: ['Optionsschein', '#8a7f60'],
        }[instrumentType] ?? ['Sonstiges', '#829087'];
        const price = amount(position.currentPrice?.price);
        const quantity = amount(position.quantity);
        const value = amount(position.currentValue);
        const purchaseValue = amount(position.purchaseValue);
        const previousDayValue = amount(position.prevDayValue);
        const change = amount(position.profitLossPurchaseRel);
        return {
            name: instrument.name ?? instrument.shortName ?? position.wkn ?? `Position ${index + 1}`,
            ticker: instrument.mnemonic ?? position.wkn ?? '—',
            wkn: instrument.wkn ?? position.wkn ?? '',
            isin: instrument.isin ?? '',
            sector: [instrument.staticData?.sector, instrument.staticData?.industrySector, instrument.sector]
                .find(value => typeof value === 'string' && value.trim()) ?? null,
            type: typeInfo[0],
            quantity: String(position.quantity?.value ?? quantity),
            price,
            value,
            change,
            color: typeInfo[1],
            purchaseValue,
            previousDayValue,
        };
    }

    emptyTotals() {
        return {
            currentValue: 0,
            purchaseValue: 0,
            profitLossPurchaseAbs: 0,
            profitLossPurchaseRel: 0,
            previousDayValue: 0,
            profitLossPrevDayAbs: 0,
            profitLossPrevDayRel: 0,
        };
    }

    publicFlow(flow) {
        return {
            flowId: flow.flowId,
            status: flow.stage,
            challenge: flow.challenge,
        };
    }

    publicAccount(account) {
        const flow = this.flows.get(account.flowId);
        return {
            id: account.id,
            label: account.label,
            status: flow?.keepAliveError ? 'error' : flow?.stage ?? 'disconnected',
        };
    }

    storeFlow(flow) {
        if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
        flow.expiryTimer = null;
        if (flow.keepAliveTimer) clearTimeout(flow.keepAliveTimer);
        flow.keepAliveTimer = null;
        if (flow.stage !== 'connected') {
            flow.expiryTimer = setTimeout(() => this.removeFlow(flow), idleLifetimeMs);
            flow.expiryTimer.unref?.();
        } else {
            const delay = Math.max(1_000, flow.accessExpiresAt - Date.now() - refreshSkewMs);
            flow.keepAliveTimer = setTimeout(() => {
                flow.keepAliveTimer = null;
                this.ensureFreshToken(flow).then(() => {
                    flow.keepAliveError = false;
                    if (!flow.closed && this.flows.has(flow.flowId)) this.storeFlow(flow);
                }).catch((error) => {
                    flow.keepAliveError = true;
                    logEvent(this.logger, 'error', 'comdirect.token.keepalive_failed', {
                        flowId: flow.flowId,
                        errorCode: error instanceof ApiError ? error.code : 'TOKEN_REFRESH_FAILED',
                    });
                    if (!flow.closed && this.flows.has(flow.flowId)) {
                        flow.keepAliveTimer = setTimeout(() => {
                            flow.keepAliveTimer = null;
                            this.storeFlow(flow);
                        }, 30_000);
                        flow.keepAliveTimer.unref?.();
                    }
                });
            }, delay);
            flow.keepAliveTimer.unref?.();
        }
        this.flows.set(flow.flowId, flow);
    }

    getFlow(flowId, expectedStage) {
        if (typeof flowId !== 'string' || !flowId) throw new ApiError(400, 'FLOW_ID_REQUIRED', 'Der Authentifizierungsablauf ist abgelaufen. Bitte erneut anmelden.');
        const flow = this.flows.get(flowId);
        if (!flow || flow.stage !== expectedStage) throw new ApiError(410, 'FLOW_EXPIRED', 'Der Authentifizierungsablauf ist abgelaufen. Bitte erneut anmelden.');
        return flow;
    }

    removeFlow(flow) {
        if (flow.expiryTimer) clearTimeout(flow.expiryTimer);
        if (flow.keepAliveTimer) clearTimeout(flow.keepAliveTimer);
        flow.closed = true;
        this.flows.delete(flow.flowId);
        for (const account of this.accounts.values()) {
            if (account.flowId === flow.flowId) account.flowId = null;
        }
        flow.clientSecret = '';
        flow.accessToken = '';
        flow.refreshToken = '';
        flow.clientSecret = '';
    }

    async ensureFreshToken(flow) {
        if (Date.now() < flow.accessExpiresAt - refreshSkewMs) return;
        if (!flow.refreshPromise) {
            flow.refreshPromise = (async () => {
                const tokens = await this.requestTokens({
                    client_id: flow.clientId,
                    client_secret: flow.clientSecret,
                    grant_type: 'refresh_token',
                    refresh_token: flow.refreshToken,
                });
                if (flow.closed) throw new ApiError(410, 'FLOW_EXPIRED', 'Der Authentifizierungsablauf ist abgemeldet oder abgelaufen.');
                flow.accessToken = tokens.access_token;
                flow.refreshToken = tokens.refresh_token;
                flow.expiresIn = tokens.expires_in;
                flow.accessExpiresAt = Date.now() + (Number(tokens.expires_in) || 599) * 1000;
                flow.keepAliveError = false;
                this.storeFlow(flow);
            })().finally(() => {
                flow.refreshPromise = null;
            });
        }
        await flow.refreshPromise;
    }
}