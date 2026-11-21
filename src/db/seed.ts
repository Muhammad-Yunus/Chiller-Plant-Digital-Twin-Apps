import dotenv from 'dotenv';
import { closePool } from './index.ts';
import { seedPlantDevelopment } from './plantRepository.ts';

dotenv.config({ override: true });

async function main() {
  const plantCode = process.argv[2] || 'CENTRAL_PLANT_01';
  const plant = await seedPlantDevelopment(plantCode);
  console.log(`Seeded plant "${plant.code}" (id=${plant.id}) cleanly.`);
}

main()
  .catch((err) => {
    console.error('Seed failed:', err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
