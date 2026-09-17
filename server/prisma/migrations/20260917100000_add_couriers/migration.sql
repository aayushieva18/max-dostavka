-- Многокурьерность: у каждого курьера теперь свои товары, покупатели и
-- заказы, изолированные от других курьеров.

CREATE TABLE "Courier" (
    "id" SERIAL NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "ownerToken" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Courier_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Courier_slug_key" ON "Courier"("slug");
CREATE UNIQUE INDEX "Courier_ownerToken_key" ON "Courier"("ownerToken");

-- Курьер по умолчанию — уже существующий бизнес пользователя. Пароль (ownerToken)
-- оставляем тот же, что она уже знает и использует, чтобы ничего не сломать.
INSERT INTO "Courier" ("slug", "name", "ownerToken")
VALUES ('aryuna', 'Доставка мясных деликатесов', 'FUSAUIaz1Mdq');

-- Product: привязка к курьеру, всё существующее — курьеру по умолчанию.
ALTER TABLE "Product" ADD COLUMN "courierId" INTEGER;
UPDATE "Product" SET "courierId" = (SELECT id FROM "Courier" WHERE slug = 'aryuna');
ALTER TABLE "Product" ALTER COLUMN "courierId" SET NOT NULL;
ALTER TABLE "Product" ADD CONSTRAINT "Product_courierId_fkey"
    FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Customer: привязка к курьеру + уникальность maxUserId теперь ТОЛЬКО в
-- пределах одного курьера (разные курьеры могут иметь покупателя с тем же
-- случайным id браузера — это два разных человека для системы).
ALTER TABLE "Customer" ADD COLUMN "courierId" INTEGER;
UPDATE "Customer" SET "courierId" = (SELECT id FROM "Courier" WHERE slug = 'aryuna');
ALTER TABLE "Customer" ALTER COLUMN "courierId" SET NOT NULL;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_courierId_fkey"
    FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "Customer_maxUserId_key";
CREATE UNIQUE INDEX "Customer_courierId_maxUserId_key" ON "Customer"("courierId", "maxUserId");

-- Order: привязка к курьеру, всё существующее — курьеру по умолчанию.
ALTER TABLE "Order" ADD COLUMN "courierId" INTEGER;
UPDATE "Order" SET "courierId" = (SELECT id FROM "Courier" WHERE slug = 'aryuna');
ALTER TABLE "Order" ALTER COLUMN "courierId" SET NOT NULL;
ALTER TABLE "Order" ADD CONSTRAINT "Order_courierId_fkey"
    FOREIGN KEY ("courierId") REFERENCES "Courier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
