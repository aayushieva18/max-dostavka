-- AlterTable
ALTER TABLE "Courier" ADD COLUMN     "singleItemFee" INTEGER;

-- Арюна попросила: доставка заказа из 1 штуки — 150 рублей.
UPDATE "Courier" SET "singleItemFee" = 150 WHERE "slug" = 'aryuna';
