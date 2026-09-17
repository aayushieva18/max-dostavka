-- AlterTable
ALTER TABLE "Courier" ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "deliveryFee" INTEGER NOT NULL DEFAULT 0;
