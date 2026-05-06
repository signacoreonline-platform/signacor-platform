import express from 'express';
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
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Health check ──────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString(), service: 'Signacore API' });
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
