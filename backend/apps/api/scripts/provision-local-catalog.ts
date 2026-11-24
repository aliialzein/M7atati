import { env } from '../src/config/env.js';
import { prisma } from '../src/database/prisma.js';

async function main() {
  const id = process.argv[2] ?? '';
  const stationId = Number(id);
  const host = new URL(env.databaseUrl).hostname;
  if (
    env.nodeEnv !== 'development' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(host) ||
    !/^[1-9][0-9]*$/.test(id) ||
    stationId > 2147483647
  ) {
    throw new Error('Provide a station ID and use a local development database.');
  }
  await prisma.$transaction(async (transaction) => {
    const station = await transaction.station.findUnique({ where: { id: stationId } });
    if (!station) throw new Error('Station not found.');
    await transaction.fuelType.createMany({
      data: [{ code: 'gasoline_95', name: 'Gasoline 95' }, { code: 'diesel', name: 'Diesel' }],
      skipDuplicates: true,
    });
    await transaction.pump.createMany({
      data: [1, 2].map((number) => ({ stationId, number, status: 'IDLE' })),
      skipDuplicates: true,
    });
  });
  console.info('Local fuel catalog and station pumps are ready.');
}

void main().catch(() => {
  console.error('Local provisioning failed. Verify the station ID and development database.');
  process.exitCode = 1;
}).finally(() => prisma.$disconnect());
