import { PrismaClient, Role } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  const hashedPassword = await bcrypt.hash("admin123", 12);

  await prisma.user.upsert({
    where: { email: "orubaniak@gmail.com" },
    update: {},
    create: {
      email: "orubaniak@gmail.com",
      name: "Admin",
      password: hashedPassword,
      role: Role.ADMIN,
    },
  });

  console.log("Seed completed: admin user created");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
