-- CreateTable
CREATE TABLE "BotMessage" (
    "id" SERIAL NOT NULL,
    "courierId" INTEGER NOT NULL,
    "maxUserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "handled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BotMessage_pkey" PRIMARY KEY ("id")
);

-- AddForeignKey
ALTER TABLE "BotMessage" ADD CONSTRAINT "BotMessage_courierId_fkey" FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

