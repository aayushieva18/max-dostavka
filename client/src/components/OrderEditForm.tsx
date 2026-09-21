import { useState } from "react";
import { type Order, type Product } from "../lib/api";
import { splitAddress, joinAddress } from "../lib/address";
import { geocodeAddress } from "../lib/yandexMaps";
import { QuantityPicker } from "./QuantityPicker";
import { AddressInput } from "./AddressInput";
import { Field, Input, Textarea, Button, Muted } from "./ui";

type SaveData = {
  name: string;
  address: string;
  phone: string;
  comment: string | null;
  lat: number;
  lon: number;
  items: { productId: number; quantity: number }[];
};

type Props = {
  order: Order;
  products: Product[];
  onSave: (data: SaveData) => Promise<void>;
  onCancel: () => void;
};

// Общая форма редактирования уже оформленного заказа — одна и та же что для
// покупателя (свой заказ), что для хозяйки (любой заказ со своего экрана):
// по итоговому решению обе стороны правят одинаковый набор полей.
export function OrderEditForm({ order, products, onSave, onCancel }: Props) {
  const initialAddress = splitAddress(order.address);
  const [name, setName] = useState(order.name);
  const [settlement, setSettlement] = useState(initialAddress.settlement);
  const [street, setStreet] = useState(initialAddress.street);
  const [phone, setPhone] = useState(order.phone);
  const [comment, setComment] = useState(order.comment ?? "");
  const [quantities, setQuantities] = useState<Record<number, number>>(
    Object.fromEntries(order.items.map((i) => [i.productId, i.quantity]))
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Товар, уже входящий в этот заказ, мог с тех пор кончиться на складе —
  // но списанное под ЭТОТ заказ количество ему не мешает, оно как бы "уже
  // выделено" под него. Поэтому предел выбора — остаток + то, что уже было
  // заказано, а не просто текущий остаток.
  const reservedByThisOrder = new Map(order.items.map((i) => [i.productId, i.quantity]));
  const productMap = new Map(products.map((p) => [p.id, p]));
  for (const item of order.items) {
    if (!productMap.has(item.productId)) productMap.set(item.productId, item.product);
  }
  const editableProducts = [...productMap.values()];

  async function handleSave() {
    const totalItems = Object.values(quantities).filter((q) => q > 0).length;
    if (!name || !settlement.trim() || !street.trim() || !phone || totalItems === 0) {
      setError("Заполни имя, населённый пункт, улицу с домом, телефон и выбери хотя бы один товар");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const address = joinAddress(settlement, street);
      const geocoded = await geocodeAddress(address).catch(() => null);
      if (!geocoded) {
        setError("Не получилось найти этот адрес на карте — проверь название населённого пункта, улицу и дом");
        setSaving(false);
        return;
      }
      await onSave({
        name,
        address,
        phone,
        comment: comment.trim() || null,
        lat: geocoded.lat,
        lon: geocoded.lon,
        items: Object.entries(quantities)
          .filter(([, qty]) => qty > 0)
          .map(([productId, quantity]) => ({ productId: Number(productId), quantity })),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось сохранить изменения");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <Field label="Имя">
        <Input value={name} onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Населённый пункт (город/село)">
        <Input
          value={settlement}
          onChange={(e) => setSettlement(e.target.value)}
          placeholder="Например: Агинское"
        />
      </Field>
      <Field label="Улица и дом">
        <AddressInput
          value={street}
          onChange={setStreet}
          placeholder="Например: ул. Ленина, 2"
          context={settlement}
        />
      </Field>
      <Field label="Телефон">
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
      </Field>
      <Field label="Комментарий к заказу (необязательно)">
        <Textarea
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          placeholder="Например: домофон не работает, звоните по приезду"
        />
      </Field>

      {editableProducts.map((product) => {
        const reserved = reservedByThisOrder.get(product.id) ?? 0;
        const max = product.availableQty + reserved;
        return (
          <div key={product.id} className="row" style={{ marginBottom: 12 }}>
            <div style={{ flex: 1 }}>{product.name}</div>
            {max === 0 ? (
              <Muted>Нет в наличии</Muted>
            ) : (
              <QuantityPicker
                value={quantities[product.id] ?? 0}
                max={max}
                onChange={(value) => setQuantities((prev) => ({ ...prev, [product.id]: value }))}
              />
            )}
          </div>
        );
      })}

      {error && (
        <p style={{ color: "#991b1b", fontSize: 14, marginBottom: 8 }}>{error}</p>
      )}

      <div className="row">
        <Button variant="secondary" onClick={onCancel} style={{ flex: 1 }}>
          Отмена
        </Button>
        <Button onClick={handleSave} disabled={saving} style={{ flex: 1 }}>
          {saving ? "Сохраняем…" : "Сохранить"}
        </Button>
      </div>
    </div>
  );
}
