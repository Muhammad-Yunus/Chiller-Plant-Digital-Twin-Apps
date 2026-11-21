import dotenv from 'dotenv';
import { eq } from 'drizzle-orm';
import { closePool, db } from '../db/index.ts';
import { assignPlantMember } from '../db/plantRepository.ts';
import { plants } from '../db/schema.ts';
import type { UserRole } from '../types/plant.ts';

dotenv.config({ override: true });

function getArg(flag: string): string | undefined {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 ? process.argv[idx + 1] : undefined;
}

async function main() {
  const plantCode = getArg('--plant') ?? 'CENTRAL_PLANT_01';
  const email = getArg('--email');
  const role = (getArg('--role') ?? 'OPERATOR').toUpperCase() as UserRole;

  if (!email) {
    throw new Error('Usage: npm run plant:assign-role -- --plant CENTRAL_PLANT_01 --email user@domain.com --role OPERATOR');
  }
  if (role !== 'VIEWER' && role !== 'OPERATOR' && role !== 'ADMIN') {
    throw new Error('Role must be VIEWER, OPERATOR, or ADMIN');
  }

  const [plant] = await db
    .select({ id: plants.id, code: plants.code })
    .from(plants)
    .where(eq(plants.code, plantCode))
    .limit(1);

  if (!plant) {
    throw new Error(`Plant "${plantCode}" not found.`);
  }

  const result = await assignPlantMember(plant.id, email, role);
  console.log(`Assigned role "${result.role}" to ${result.email} on plant ${plant.code}.`);
}

main()
  .catch((err) => {
    console.error('Role assignment failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
