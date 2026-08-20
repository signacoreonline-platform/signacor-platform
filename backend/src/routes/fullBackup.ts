/**
 * GET /api/full-backup — server-driven "Full Backup V2" download.
 * Stage 2 Phase 6. See backend/src/relational/fullBackupV2.ts for the
 * consistency/verification design. Admin-only, same as the pre-existing
 * frontend export button's own role gate (index.html `canExportBackup`) —
 * this route enforces it server-side too, in case the button is ever
 * bypassed.
 */
import { Router, Response } from 'express';
import { authenticate, requireRole, AuthRequest } from '../middleware/auth';
import { buildFullBackupV2 } from '../relational/fullBackupV2';

const router = Router();
router.use(authenticate);

router.get('/', requireRole('admin'), async (req: AuthRequest, res: Response): Promise<void> => {
  try {
    const roleLabel = req.user?.role || 'admin';
    const { buffer, filename, manifest } = await buildFullBackupV2(roleLabel);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.setHeader('X-Backup-Manifest-Checksum', manifest.dataJsonSha256);
    res.status(200).send(buffer);
  } catch (err: any) {
    console.error('GET /api/full-backup failed:', err);
    res.status(500).json({ error: 'Full backup export failed', detail: err?.message || String(err) });
  }
});

export default router;
