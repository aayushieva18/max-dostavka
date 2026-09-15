/*
  Warnings:

  - Added the required column `address` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `name` to the `Order` table without a default value. This is not possible if the table is not empty.
  - Added the required column `phone` to the `Order` table without a default value. This is not possible if the table is not empty.

*/
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Order" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "customerId" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NEW',
    "lat" REAL NOT NULL,
    "lon" REAL NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
-- Для уже существующих заказов (созданных до этого изменения) берём
-- имя/адрес/телефон из текущих данных покупателя — это лучшее, что можно
-- сделать задним числом, раз снимка на момент тех заказов не сохранялось.
INSERT INTO "new_Order" ("id", "customerId", "name", "address", "phone", "status", "lat", "lon", "createdAt")
SELECT o."id", o."customerId",
       COALESCE(c."name", ''), COALESCE(c."address", ''), COALESCE(c."phone", ''),
       o."status", o."lat", o."lon", o."createdAt"
FROM "Order" o
LEFT JOIN "Customer" c ON c."id" = o."customerId";
DROP TABLE "Order";
ALTER TABLE "new_Order" RENAME TO "Order";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
