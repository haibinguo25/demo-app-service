const express = require('express');
const app = express();
const port = process.env.PORT || 8088;
app.get('/', (req, res) => res.json({ service: 'demo-app-service', status: 'OK', ts: new Date().toISOString() }));
app.listen(port, () => console.log(`demo-app-service listening on ${port}`));
