/**
 * One-time maintenance script: wipe ALL chat history (sessions + messages).
 * Targets/files/evidence/findings/users are preserved.
 * Run: bun run scripts/wipe-chats.ts
 */
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();

async function main() {
  const msgs = await db.chatMessage.deleteMany({});
  const sessions = await db.chatSession.deleteMany({});
  console.log(`[wipe-chats] deleted ${msgs.count} messages, ${sessions.count} sessions`);
  const users = await db.user.count();
  const targets = await db.target.count();
  console.log(`[wipe-chats] preserved: ${users} users, ${targets} targets`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
