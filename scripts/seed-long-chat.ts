/**
 * QA seed: create a chat session with 95 alternating messages for the demo
 * user so the history-window (Load earlier) flow can be verified in the UI.
 * Idempotent: reuses the seeded session on re-run.
 */
import { db } from "../src/lib/db";

async function main() {
  const user = await db.user.findUnique({ where: { email: "demo@area.platform" } });
  if (!user) {
    console.log("no demo user — sign in once via the UI first");
    process.exit(1);
  }

  const TITLE = "QA — long history windowing";
  const existing = await db.chatSession.findFirst({
    where: { userId: user.id, title: TITLE },
  });
  if (existing) {
    const n = await db.chatMessage.count({ where: { sessionId: existing.id } });
    console.log(`seeded session already exists: ${existing.id} (${n} messages)`);
    return;
  }

  const session = await db.chatSession.create({
    data: { userId: user.id, title: TITLE },
  });
  const rows: { sessionId: string; role: string; content: string }[] = [];
  for (let i = 1; i <= 47; i++) {
    rows.push({
      sessionId: session.id,
      role: "user",
      content: `QA message ${i}: what does the artifact section at 0x${(i * 64).toString(16)} contain?`,
    });
    rows.push({
      sessionId: session.id,
      role: "assistant",
      content: `QA answer ${i}: OBSERVED — section header verified. DERIVED — offset range maps to .rodata. No fabrication here; this row exists only to exercise transcript pagination.`,
    });
  }
  await db.chatMessage.createMany({ data: rows });
  console.log(`seeded session ${session.id} with ${rows.length} messages`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
