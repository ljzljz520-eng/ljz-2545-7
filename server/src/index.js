import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PORT } from './config.js';
import { pub } from './routes/public.js';
import { adm } from './routes/admin.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api', pub);
app.use('/api/admin', adm);

app.use(express.static(path.join(__dirname, '../../public')));
// SPA 回退（排除 /api 与 /storage 直链）
app.get(/^\/(?!api|storage).*/, (_req, res) =>
  res.sendFile(path.join(__dirname, '../../public/index.html')));

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: err.message || 'server error' });
});

app.listen(PORT, () => console.log(`Roast Story Station on http://127.0.0.1:${PORT}`));
