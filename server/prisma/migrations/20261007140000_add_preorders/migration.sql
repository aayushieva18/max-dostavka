-- AlterEnum
ALTER TYPE "OrderStatus" ADD VALUE 'PREORDER';

-- AlterTable
ALTER TABLE "Order" ADD COLUMN     "preorderDate" TEXT;
