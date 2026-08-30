// Vercel Serverless Function Proxy for Hiroshima Bousai Web
const https = require('https');
const http = require('http');
const { URL } = require('url');

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.status(204).end();
        return;
    }

    const targetUrl = req.query.url;
    if (!targetUrl) {
        res.status(400).json({ error: 'Missing url parameter' });
        return;
    }

    const fetchUrl = (reqUrl, redirectCount = 0) => {
        if (redirectCount > 5) {
            res.status(502).json({ error: 'Too many redirects' });
            return;
        }

        let parsedTarget;
        try {
            parsedTarget = new URL(reqUrl);
        } catch (e) {
            res.status(400).json({ error: 'Invalid url format' });
            return;
        }

        const client = parsedTarget.protocol === 'https:' ? https : http;
        const options = {
            hostname: parsedTarget.hostname,
            port: parsedTarget.port || (parsedTarget.protocol === 'https:' ? 443 : 80),
            path: parsedTarget.pathname + parsedTarget.search,
            method: 'GET',
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': '*/*',
                'Accept-Encoding': 'identity'
            }
        };

        const proxyReq = client.request(options, (proxyRes) => {
            if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
                let redirectUrl = proxyRes.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `${parsedTarget.protocol}//${parsedTarget.host}${redirectUrl}`;
                }
                return fetchUrl(redirectUrl, redirectCount + 1);
            }

            res.status(proxyRes.statusCode);
            res.setHeader('Content-Type', proxyRes.headers['content-type'] || 'application/octet-stream');
            if (proxyRes.headers['content-length']) {
                res.setHeader('Content-Length', proxyRes.headers['content-length']);
            }

            proxyRes.pipe(res);
        });

        proxyReq.on('error', (err) => {
            res.status(502).json({ error: err.message });
        });

        proxyReq.end();
    };

    fetchUrl(targetUrl);
};
