import express, { Request, Response } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import dotenv from 'dotenv';

import authRoutes from './routes/auth';
import companiesRoutes from './routes/companies';
import clientsRoutes from './routes/clients';
import jobsRoutes from './routes/jobs';
import intercompanyRoutes from './routes/intercompany';
import calculatorsRoutes from './routes/calculators';
import dashboardRoutes from './routes/dashboard';
import inventoryRoutes from './routes/inventory';
import importsRoutes from './routes/imports';
import platformStateRoutes from './routes/platformState';
import documentNumbersRoutes from './routes/documentNumbers';
import quoteConversionsRoutes from './routes/quoteConversions';
import { errorHandler, notFound } from './middleware/errorHandler';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// ── Middleware ────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
  credentials: true,
}));
app.use(morgan(process.env.NODE_ENV === 'production' ? 'combined' : 'dev'));
// 2026-08-04: the full platform_state save body (driven mostly by
// purchaseOrders and quotes) has grown to ~5.3MB, already past the previous
// 5mb limit — confirmed live as "request entity too large" on PUT
// /api/platform-state. Most saves now use the new partial-save path (only
// the sections that changed, see platformState.ts), but a full-state save
// is still the default for every other caller and will keep growing with
// normal business use, so the limit is raised with real headroom rather
// than tuned to today's exact size.
app.use(express.json({ limit: '25mb' }));
app.use(express.urlencoded({ extended: true, limit: '25mb' }));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    service: 'Signacore API'
  });
});

// ── API Routes ────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/companies',     companiesRoutes);
app.use('/api/clients',       clientsRoutes);
app.use('/api/jobs',          jobsRoutes);
app.use('/api/intercompany',  intercompanyRoutes);
app.use('/api/calculators',   calculatorsRoutes);
app.use('/api/dashboard',     dashboardRoutes);
app.use('/api/inventory',     inventoryRoutes);
app.use('/api/imports',       importsRoutes);
app.use('/api/platform-state', platformStateRoutes);
app.use('/api/document-numbers', documentNumbersRoutes);
app.use('/api/quote-conversions', quoteConversionsRoutes);

// ── Error handling ────────────────────────────────────────────
app.use(notFound);
app.use(errorHandler);

app.listen(PORT, () => {
  console.log(`
  ╔══════════════════════════════════════════╗
  ║   Signacore Group Platform — API Server  ║
  ║   Port: ${PORT}                              ║
  ║   Env:  ${process.env.NODE_ENV || 'development'}                    ║
  ╚══════════════════════════════════════════╝
  `);
});

export default app;
