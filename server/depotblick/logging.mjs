const sensitiveQueryKey = /token|secret|password|passwort|tan|authorization|client.?id|username|flow.?id/i;

export function redactUrl(value) {
    try {
        const url = new URL(value);
        url.pathname = url.pathname.replace(
            /(\/api\/session\/clients\/user\/v1\/sessions\/)[^/]+/i,
            '$1[redacted]',
        );
        for (const key of url.searchParams.keys()) {
            if (sensitiveQueryKey.test(key)) url.searchParams.set(key, '[redacted]');
        }
        url.hash = '';
        return url.toString();
    } catch {
        return '[invalid-url]';
    }
}

export function logEvent(logger, level, event, details = {}) {
    const write = typeof logger?.[level] === 'function' ? logger[level] : logger?.log;
    if (typeof write !== 'function') return;
    write.call(logger, JSON.stringify({
        timestamp: new Date().toISOString(),
        event,
        ...details,
    }));
}