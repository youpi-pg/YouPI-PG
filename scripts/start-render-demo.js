import http from 'node:http';

// Render automatically provides the PORT environment variable
const PORT = Number(process.env.PORT || 10000);

const server = http.createServer((req, res) => {

    // Health check endpoint for Render and UptimeRobot
    if (req.url === '/health') {
        res.writeHead(200, {
            'Content-Type': 'application/json'
        });

        res.end(JSON.stringify({
            status: 'UP',
            service: 'youpi-pg-demo',
            timestamp: new Date().toISOString()
        }));

        return;
    }

    // Temporary placeholder until full demo is configured
    res.writeHead(503, {
        'Content-Type': 'text/plain; charset=utf-8'
    });

    res.end(
        'YouPI-PG demo website is not enabled yet. ' +
        'Payment functionality is disabled.'
    );
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`YouPI-PG server running on port ${PORT}`);
});