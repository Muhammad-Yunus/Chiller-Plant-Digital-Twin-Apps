import { and, eq } from 'drizzle-orm';
import type { NextFunction, Response } from 'express';
import type { DecodedIdToken } from 'firebase-admin/auth';
import { db } from '../db/index.ts';
import { edgeCredentials, plants, userPlantRoles } from '../db/schema.ts';
import { getOrCreateUser } from '../db/users.ts';
import { verifyEdgeSecret } from '../lib/edgeCrypto.ts';
import { adminAuth } from '../lib/firebase-admin.ts';
import { logEvent } from '../lib/logger.ts';
import type { UserRole } from '../types/plant.ts';
import { plantCodeSchema } from '../validation/telemetrySchemas.ts';
import type { ContextualRequest } from './security.ts';

export interface AuthorizedPlant {
  id: number;
  code: string;
  name: string;
}

export interface AuthRequest extends ContextualRequest {
  user?: DecodedIdToken;
  dbUserId?: number;
  authorizedPlant?: AuthorizedPlant;
  plantRole?: UserRole;
  edgeCredential?: {
    id: number;
    credentialId: string;
    edgeDeviceId: string;
    plantId: number;
  };
}

const ROLE_WEIGHT: Record<UserRole, number> = {
  VIEWER: 1,
  OPERATOR: 2,
  ADMIN: 3,
};

function sendAuthError(
  res: Response,
  req: ContextualRequest,
  status: number,
  code: string,
  message: string,
) {
  res.status(status).json({
    error: {
      code,
      message,
      requestId: req.requestId,
    },
  });
}

export const requireOperatorAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    sendAuthError(res, req, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  const token = authHeader.slice('Bearer '.length).trim();
  if (!token) {
    sendAuthError(res, req, 401, 'UNAUTHORIZED', 'Authentication required');
    return;
  }

  try {
    const decodedToken = await adminAuth.verifyIdToken(token);
    req.user = decodedToken;

    const dbUser = await getOrCreateUser(decodedToken.uid, decodedToken.email ?? '');
    req.dbUserId = dbUser.id;
    next();
  } catch (error) {
    logEvent('warn', 'operator_auth_failed', {
      requestId: req.requestId,
      reason: error instanceof Error ? error.name : 'invalid_token',
    });
    sendAuthError(res, req, 401, 'UNAUTHORIZED', 'Invalid or expired credentials');
  }
};

/**
 * Centralized tenant/plant RBAC middleware.
 * Ensures caller belongs to the requested :plantCode and meets minRole.
 */
export function requirePlantRole(minRole: UserRole) {
  return async (req: AuthRequest, res: Response, next: NextFunction) => {
    const parsedCode = plantCodeSchema.safeParse(req.params.plantCode);
    if (!parsedCode.success) {
      sendAuthError(res, req, 400, 'INVALID_PLANT_CODE', 'Invalid plantCode parameter');
      return;
    }

    if (!req.dbUserId) {
      sendAuthError(res, req, 401, 'UNAUTHORIZED', 'Operator identity missing');
      return;
    }

    try {
      const [plant] = await db
        .select({ id: plants.id, code: plants.code, name: plants.name })
        .from(plants)
        .where(eq(plants.code, parsedCode.data))
        .limit(1);

      if (!plant) {
        sendAuthError(res, req, 404, 'PLANT_NOT_FOUND', 'Plant not found');
        return;
      }

      let [membership] = await db
        .select({ role: userPlantRoles.role })
        .from(userPlantRoles)
        .where(
          and(
            eq(userPlantRoles.userId, req.dbUserId),
            eq(userPlantRoles.plantId, plant.id),
          ),
        )
        .limit(1);

      // Controlled single-admin bootstrap:
      // Production requires explicit BOOTSTRAP_ADMIN_EMAIL (or CLI/admin assignment).
      // Non-production allows first-user bootstrap on default CENTRAL_PLANT_01 when empty.
      if (!membership) {
        const bootstrapEmail = (process.env.BOOTSTRAP_ADMIN_EMAIL ?? '').trim().toLowerCase();
        const callerEmail = (req.user?.email ?? '').trim().toLowerCase();
        const matchesBootstrapEmail = Boolean(bootstrapEmail && callerEmail === bootstrapEmail);

        let allowDevBootstrap = false;
        if (
          !matchesBootstrapEmail &&
          process.env.NODE_ENV !== 'production' &&
          plant.code === 'CENTRAL_PLANT_01'
        ) {
          const existingAnyRole = await db
            .select({ id: userPlantRoles.id })
            .from(userPlantRoles)
            .where(eq(userPlantRoles.plantId, plant.id))
            .limit(1);
          allowDevBootstrap = existingAnyRole.length === 0;
        }

        if (matchesBootstrapEmail || allowDevBootstrap) {
          const [created] = await db
            .insert(userPlantRoles)
            .values({
              userId: req.dbUserId,
              plantId: plant.id,
              role: 'ADMIN',
            })
            .onConflictDoNothing()
            .returning({ role: userPlantRoles.role });

          membership = created ?? { role: 'ADMIN' };
        }
      }

      if (!membership) {
        logEvent('warn', 'plant_access_denied', {
          requestId: req.requestId,
          plantCode: plant.code,
          dbUserId: req.dbUserId,
        });
        sendAuthError(res, req, 403, 'FORBIDDEN', 'Access denied for this plant');
        return;
      }

      if (ROLE_WEIGHT[membership.role] < ROLE_WEIGHT[minRole]) {
        sendAuthError(
          res,
          req,
          403,
          'INSUFFICIENT_ROLE',
          `Requires ${minRole} role for this operation`,
        );
        return;
      }

      req.authorizedPlant = plant;
      req.plantRole = membership.role;
      next();
    } catch (error) {
      logEvent('error', 'plant_rbac_error', {
        requestId: req.requestId,
        error: error instanceof Error ? error.message : 'db_error',
      });
      sendAuthError(res, req, 500, 'INTERNAL_ERROR', 'Unable to verify plant permissions');
    }
  };
}

/**
 * Dedicated IoT Edge Gateway authentication middleware.
 * Validates X-Edge-Credential-Id + X-Edge-Secret and verifies credential belongs to target plantCode.
 */
export const requireEdgeAuth = async (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  const credentialId = req.header('x-edge-credential-id')?.trim();
  const edgeSecret = req.header('x-edge-secret')?.trim();

  if (!credentialId || !edgeSecret) {
    sendAuthError(res, req, 401, 'EDGE_UNAUTHORIZED', 'Edge gateway credentials required');
    return;
  }

  try {
    const [cred] = await db
      .select()
      .from(edgeCredentials)
      .where(eq(edgeCredentials.credentialId, credentialId))
      .limit(1);

    if (!cred || cred.status !== 'ACTIVE') {
      sendAuthError(res, req, 401, 'EDGE_UNAUTHORIZED', 'Invalid or inactive edge credential');
      return;
    }

    if (cred.expiresAt && cred.expiresAt.getTime() <= Date.now()) {
      sendAuthError(res, req, 401, 'EDGE_CREDENTIAL_EXPIRED', 'Edge credential expired');
      return;
    }

    const valid = verifyEdgeSecret(edgeSecret, cred.secretHash, cred.secretSalt);
    if (!valid) {
      logEvent('warn', 'edge_auth_invalid_secret', {
        requestId: req.requestId,
        credentialId,
      });
      sendAuthError(res, req, 401, 'EDGE_UNAUTHORIZED', 'Invalid edge credential');
      return;
    }

    const [plant] = await db
      .select({ id: plants.id, code: plants.code, name: plants.name })
      .from(plants)
      .where(eq(plants.id, cred.plantId))
      .limit(1);

    if (!plant) {
      sendAuthError(res, req, 403, 'EDGE_FORBIDDEN', 'Credential plant scope invalid');
      return;
    }

    const bodyPlantCode =
      req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>).plantCode : undefined;
    if (typeof bodyPlantCode === 'string' && bodyPlantCode !== plant.code) {
      logEvent('warn', 'edge_cross_plant_denied', {
        requestId: req.requestId,
        credentialId,
        allowedPlant: plant.code,
        attemptedPlant: bodyPlantCode,
      });
      sendAuthError(res, req, 403, 'CROSS_PLANT_DENIED', 'Edge credential not authorized for target plant');
      return;
    }

    const bodyEdgeDeviceId =
      req.body && typeof req.body === 'object'
        ? (req.body as Record<string, unknown>).edgeDeviceId
        : undefined;
    if (typeof bodyEdgeDeviceId === 'string' && bodyEdgeDeviceId !== cred.edgeDeviceId) {
      sendAuthError(res, req, 403, 'EDGE_DEVICE_MISMATCH', 'Credential does not match edgeDeviceId');
      return;
    }

    await db
      .update(edgeCredentials)
      .set({ lastUsedAt: new Date() })
      .where(eq(edgeCredentials.id, cred.id));

    req.edgeCredential = {
      id: cred.id,
      credentialId: cred.credentialId,
      edgeDeviceId: cred.edgeDeviceId,
      plantId: cred.plantId,
    };
    req.authorizedPlant = plant;
    next();
  } catch (error) {
    logEvent('error', 'edge_auth_error', {
      requestId: req.requestId,
      error: error instanceof Error ? error.message : 'edge_auth_failed',
    });
    sendAuthError(res, req, 500, 'INTERNAL_ERROR', 'Edge authentication failed');
  }
};
