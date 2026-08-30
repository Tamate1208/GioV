// GioVision Hiroshima - オールインワン開発サーバー & 防災Webプロキシ
const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = process.env.PORT || 5500;
const MIME_TYPES = {
    '.html': 'text/html; charset=UTF-8',
    '.js': 'application/javascript; charset=UTF-8',
    '.css': 'text/css; charset=UTF-8',
    '.json': 'application/json; charset=UTF-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

const server = http.createServer((req, res) => {
    // CORS ヘッダー
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = parsedUrl.pathname;

    // 1. 防災Webプロキシ API (/api/proxy?url=...)
    if (pathname === '/api/proxy') {
        const targetUrl = parsedUrl.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        const fetchUrl = (reqUrl, redirectCount = 0) => {
            if (redirectCount > 5) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Too many redirects' }));
                return;
            }

            const client = reqUrl.startsWith('https:') ? require('https') : require('http');
            const parsedTarget = new url.URL(reqUrl);
            const options = {
                hostname: parsedTarget.hostname,
                port: parsedTarget.port || (reqUrl.startsWith('https:') ? 443 : 80),
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

                const responseHeaders = {
                    'Access-Control-Allow-Origin': '*',
                    'Access-Control-Allow-Methods': 'GET, OPTIONS',
                    'Content-Type': proxyRes.headers['content-type'] || 'application/octet-stream'
                };
                if (proxyRes.headers['content-length']) {
                    responseHeaders['Content-Length'] = proxyRes.headers['content-length'];
                }

                res.writeHead(proxyRes.statusCode, responseHeaders);
                proxyRes.pipe(res);
            });

            proxyReq.on('error', (err) => {
                res.writeHead(502, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                res.end(JSON.stringify({ error: err.message }));
            });

            proxyReq.end();
        };

        fetchUrl(targetUrl);
        return;
    }

    // 2. 静的ファイル配信
    let safePath = decodeURIComponent(pathname === '/' ? '/index.html' : pathname);
    let filePath = path.join(__dirname, safePath);
    filePath = path.normalize(filePath);

    // ディレクトリトラバーサル防止
    if (!filePath.startsWith(__dirname)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
            res.end('404 Not Found');
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': contentType });
        fs.createReadStream(filePath).pipe(res);
    });
});

server.listen(PORT, () => {
    console.log(`=========================================`);
    console.log(` GioVision Hiroshima App Server running`);
    console.log(` URL: http://localhost:${PORT}`);
    console.log(`=========================================`);
});
