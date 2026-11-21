import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { closePool, db } from '../db/index.ts';
import { createOrRotateEdgeCredential } from '../db/plantRepository.ts';
import { plants } from '../db/schema.ts';

dotenv.config({ override: true });

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const plantCode = getArg('--plant') ?? 'CENTRAL_PLANT_01';
  const edgeDeviceId = getArg('--edge') ?? 'gw-central-01';
  const label = getArg('--label') ?? `Edge Gateway (${edgeDeviceId})`;
  const expiresArg = getArg('--expires-days');
  const expiresInDays = expiresArg ? Number(expiresArg) : undefined;

  const [plant] = await db
    .select({ id: plants.id, code: plants.code })
    .from(plants)
    .where(eq(plants.code, plantCode))
    .limit(1);

  if (!plant) {
    throw new Error(
      `Plant ${plantCode} not found. Run "npm run db:seed" first.`,
    );
  }

  const issued = await createOrRotateEdgeCredential(
    plant.id,
    edgeDeviceId,
    label,
    expiresInDays,
  );

  console.log('Edge gateway credential issued (store secret securely, shown once):');
  console.log(
    JSON.stringify(
      {
        plantCode: plant.code,
        credentialId: issued.credentialId,
        edgeDeviceId: issued.edgeDeviceId,
        label: issued.label,
        secret: issued.secret,
        expiresAt: issued.expiresAt,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error('Failed to issue edge credential:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
