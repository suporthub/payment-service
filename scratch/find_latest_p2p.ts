import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  const latest = await prisma.gatewayPayment.findFirst({
    where: { gateway: 'pay2pay' },
    orderBy: { createdAt: 'desc' },
  });
  console.log(JSON.stringify(latest, null, 2));
}

main()
  .catch(e => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
