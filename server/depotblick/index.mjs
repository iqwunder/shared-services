import { randomUUID } from 'node:crypto';
import { ApiError, ComdirectAuthService } from './comdirect.mjs';
import { logEvent, redactUrl } from './logging.mjs';

const auth = new ComdirectAuthService();
const authCookieName = 'depotblick-session';
const clearAuthCookie = `${authCookieName}=; Path=/api; HttpOnly; SameSite=Strict; Max-Age=0`;

function authFlowId(request) {
    for (const cookie of (request.headers.cookie ?? '').split(';')) {
        const separator = cookie.indexOf('=');
        if (separator < 0 || cookie.slice(0, separator).trim() !== authCookieName) continue;
        try {
            return decodeURIComponent(cookie.slice(separator + 1).trim());
        } catch {
            return '';
        }
    }
    return '';
}

function sessionCookie(request, flowId) {
    const secure = request.socket.encrypted ? '; Secure' : '';
    return `${authCookieName}=${encodeURIComponent(flowId)}; Path=/api; HttpOnly; SameSite=Strict; Max-Age=31536000${secure}`;
}

function publicAuthResult(result) {
    const { flowId, ...publicResult } = result;
    return publicResult;
}

async function readJson(request) {
    const chunks = [];
    let size = 0;
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 32_768) throw new ApiError(413, 'REQUEST_TOO_LARGE', 'Die Anfrage ist zu groß.');
        chunks.push(chunk);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new ApiError(400, 'INVALID_JSON', 'Die Anfrage enthält ungültige Daten.');
    }
}

function send(response, status, data, headers = {}) {
    response.writeHead(status, headers);
    response.end(JSON.stringify(data));
}

export async function handleDepotblickRequest(request, response) {
    const requestId = randomUUID();
    const startedAt = performance.now();
    const localUrl = new URL(request.url ?? '/', 'http://localhost');
    logEvent(console, 'info', 'api.request.started', {
        requestId,
        method: request.method ?? 'UNKNOWN',
        url: redactUrl(`${localUrl.origin}${localUrl.pathname}`),
    });
    response.once('finish', () => {
        logEvent(console, 'info', 'api.request.completed', {
            requestId,
            method: request.method ?? 'UNKNOWN',
            url: redactUrl(`${localUrl.origin}${localUrl.pathname}`),
            status: response.statusCode,
            durationMs: Math.round(performance.now() - startedAt),
        });
    });
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Cache-Control', 'no-store');

    try {
        const url = localUrl;
        if (request.method === 'POST' && url.pathname === '/api/auth/connect') {
            const result = await auth.connect(await readJson(request));
            send(response, 200, publicAuthResult(result), { 'Set-Cookie': sessionCookie(request, result.flowId) });
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/accounts') {
            send(response, 200, auth.listAccounts(authFlowId(request)));
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/accounts') {
            send(response, 201, auth.createAccount(await readJson(request)));
            return;
        }

        const accountMatch = url.pathname.match(/^\/api\/accounts\/([^/]+)(?:\/(connect|select))?$/);
        if (accountMatch && request.method === 'POST' && accountMatch[2] === 'connect') {
            const result = await auth.connectAccount(decodeURIComponent(accountMatch[1]));
            send(response, 200, publicAuthResult(result), { 'Set-Cookie': sessionCookie(request, result.flowId) });
            return;
        }

        if (accountMatch && request.method === 'POST' && accountMatch[2] === 'select') {
            const flowId = auth.getAccountFlowId(decodeURIComponent(accountMatch[1]));
            send(response, 200, publicAuthResult(auth.getSession(flowId)), { 'Set-Cookie': sessionCookie(request, flowId) });
            return;
        }

        if (accountMatch && request.method === 'DELETE' && !accountMatch[2]) {
            const accountId = decodeURIComponent(accountMatch[1]);
            const activeFlowId = authFlowId(request);
            const accountFlowId = await auth.deleteAccount(accountId);
            const active = Boolean(accountFlowId && activeFlowId === accountFlowId);
            send(response, 200, { status: 'deleted', active }, active ? { 'Set-Cookie': clearAuthCookie } : {});
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/confirm') {
            const result = await auth.confirm({ ...(await readJson(request)), flowId: authFlowId(request) });
            send(response, 200, publicAuthResult(result));
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/challenge') {
            const result = await auth.changeTanType({ ...(await readJson(request)), flowId: authFlowId(request) });
            send(response, 200, publicAuthResult(result));
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/auth/session') {
            send(response, 200, publicAuthResult(auth.getSession(authFlowId(request))));
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/keepalive') {
            send(response, 200, await auth.keepAlive(authFlowId(request)));
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/instruments/search') {
            send(response, 200, await auth.searchInstruments(authFlowId(request), url.searchParams.get('term')));
            return;
        }

        const instrumentOrbPriceMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)\/orb-price$/);
        if (request.method === 'GET' && instrumentOrbPriceMatch) {
            send(response, 200, await auth.getInstrumentPrice(authFlowId(request), decodeURIComponent(instrumentOrbPriceMatch[1])));
            return;
        }

        const instrumentDetailMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)$/);
        if (request.method === 'GET' && instrumentDetailMatch) {
            send(response, 200, await auth.getInstrument(authFlowId(request), decodeURIComponent(instrumentDetailMatch[1])));
            return;
        }

        const instrumentPricesMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)\/prices$/);
        if (request.method === 'GET' && instrumentPricesMatch) {
            send(response, 200, await auth.getInstrumentPrices(
                authFlowId(request),
                decodeURIComponent(instrumentPricesMatch[1]),
                url.searchParams.get('interval') ?? '1WEEK',
                url.searchParams.get('venueId') ?? '',
            ));
            return;
        }

        const instrumentPerformanceMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)\/performance$/);
        if (request.method === 'GET' && instrumentPerformanceMatch) {
            send(response, 200, await auth.getInstrumentPerformance(
                authFlowId(request),
                decodeURIComponent(instrumentPerformanceMatch[1]),
                url.searchParams.get('interval') ?? '',
            ));
            return;
        }

        const instrumentAnalysesMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)\/analyses$/);
        if (request.method === 'GET' && instrumentAnalysesMatch) {
            send(response, 200, await auth.getInstrumentAnalyses(
                authFlowId(request),
                decodeURIComponent(instrumentAnalysesMatch[1]),
                url.searchParams.get('interval') ?? '1YEAR',
            ));
            return;
        }

        const instrumentProfilesMatch = url.pathname.match(/^\/api\/instruments\/([^/]+)\/profiles$/);
        if (request.method === 'GET' && instrumentProfilesMatch) {
            send(response, 200, await auth.getInstrumentProfiles(authFlowId(request), decodeURIComponent(instrumentProfilesMatch[1])));
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/portfolio') {
            send(response, 200, await auth.getPortfolio(authFlowId(request)));
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/depot/history') {
            send(response, 200, await auth.getHistoricalDepotValues(authFlowId(request), url.searchParams.get('period') ?? '1W'));
            return;
        }

        if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
            await auth.logout(authFlowId(request));
            send(response, 200, { status: 'signed-out' }, { 'Set-Cookie': clearAuthCookie });
            return;
        }

        if (request.method === 'GET' && url.pathname === '/api/health') {
            send(response, 200, { status: 'ok' });
            return;
        }

        send(response, 404, { code: 'NOT_FOUND', message: 'Not found' });
    } catch (error) {
        const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, 'INTERNAL_ERROR', 'Unerwarteter Fehler im lokalen API-Adapter.');
        logEvent(console, apiError.status >= 500 ? 'error' : 'warn', 'api.request.failed', {
            requestId,
            method: request.method ?? 'UNKNOWN',
            url: redactUrl(`${localUrl.origin}${localUrl.pathname}`),
            status: apiError.status,
            code: apiError.code,
            errorType: error instanceof Error ? error.name : 'UnknownError',
        });
        const headers = ['FLOW_EXPIRED', 'TAN_ATTEMPTS_STOPPED'].includes(apiError.code)
            ? { 'Set-Cookie': clearAuthCookie }
            : {};
        send(response, apiError.status, { code: apiError.code, message: apiError.message }, headers);
    }
}