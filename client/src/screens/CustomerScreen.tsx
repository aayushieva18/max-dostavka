import { useEffect, useState } from "react";
import { api, type Order, type Product } from "../lib/api";
import { socket } from "../lib/socket";
import {
  getMaxUserFirstName,
  loadCustomerFromDeviceStorage,
  saveCustomerToDeviceStorage,
} from "../lib/max";
import { QuantityPicker } from "../components/QuantityPicker";
import { MapView } from "../components/MapView";
import { AddressInput } from "../components/AddressInput";
import { geocodeAddress } from "../lib/yandexMaps";
import { Screen, Card, Field, Input, Button, Muted, ErrorBanner } from "../components/ui";

type Props = { maxUserId: string };

// Адрес хранится одной строкой "Населённый пункт, улица и дом" — здесь же
// на экране это два отдельных поля, чтобы человек физически не мог забыть
// указать город/село (реальный случай: заказали "Ленина 2" без указания,
// что это Ага-Хангил, а не Агинское — курьер приехала не туда).
function splitAddress(saved: string): { settlement: string; street: string } {
  const commaIndex = saved.indexOf(",");
  if (commaIndex === -1) return { settlement: "", street: saved };
  return {
    settlement: saved.slice(0, commaIndex).trim(),
    street: saved.slice(commaIndex + 1).trim(),
  };
}

function joinAddress(settlement: string, street: string): string {
  return `${settlement.trim()}, ${street.trim()}`;
}

export function CustomerScreen({ maxUserId }: Props) {
  const [products, setProducts] = useState<Product[]>([]);
  const [name, setName] = useState(getMaxUserFirstName());
  const [settlement, setSettlement] = useState("");
  const [street, setStreet] = useState("");
  const [phone, setPhone] = useState("");
  const [quantities, setQuantities] = useState<Record<number, number>>({});
  const [activeOrder, setActiveOrder] = useState<Order | null>(null);
  const [courierPosition, setCourierPosition] = useState<
    { lat: number; lon: number } | null
  >(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [etaMinutes, setEtaMinutes] = useState<number | null>(null);

  // Подставляем данные покупателя, если он уже когда-то заказывал:
  // сначала пробуем сервер (главный источник), потом хранилище MAX (резерв).
  useEffect(() => {
    (async () => {
      const fromServer = await api.getCustomer(maxUserId).catch(() => null);
      if (fromServer) {
        setName(fromServer.name);
        const parsed = splitAddress(fromServer.address);
        setSettlement(parsed.settlement);
        setStreet(parsed.street);
        setPhone(fromServer.phone);
        return;
      }
      const fromStorage = loadCustomerFromDeviceStorage();
      if (fromStorage) {
        setName(fromStorage.name);
        const parsed = splitAddress(fromStorage.address);
        setSettlement(parsed.settlement);
        setStreet(parsed.street);
        setPhone(fromStorage.phone);
      }
    })();
  }, [maxUserId]);

  useEffect(() => {
    api.getProducts().then(setProducts).catch(() => setError("Не получилось загрузить список товаров"));
    const reload = () => api.getProducts().then(setProducts).catch(() => {});
    socket.on("products:updated", reload);
    return () => {
      socket.off("products:updated", reload);
    };
  }, []);

  useEffect(() => {
    socket.on("courier:position", setCourierPosition);
    return () => {
      socket.off("courier:position", setCourierPosition);
    };
  }, []);

  // Хозяйка сама считает маршрут у себя и присылает время прибытия по
  // каждому заказу — здесь просто достаём свою цифру, если она есть.
  useEffect(() => {
    if (!activeOrder) return;
    const handler = (etaByOrderId: Record<number, number>) => {
      if (etaByOrderId[activeOrder.id] !== undefined) {
        setEtaMinutes(etaByOrderId[activeOrder.id]);
      }
    };
    socket.on("orders:eta", handler);
    return () => {
      socket.off("orders:eta", handler);
    };
  }, [activeOrder]);

  const totalItems = Object.values(quantities).filter((q) => q > 0).length;

  async function handleSubmit() {
    if (!name || !settlement.trim() || !street.trim() || !phone || totalItems === 0) {
      setError("Заполни имя, населённый пункт, улицу с домом, телефон и выбери хотя бы один товар");
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const address = joinAddress(settlement, street);
      const geocoded = await geocodeAddress(address).catch(() => null);
      if (!geocoded) {
        setError("Не получилось найти этот адрес на карте — проверь название населённого пункта, улицу и дом");
        setSubmitting(false);
        return;
      }

      const order = await api.createOrder({
        maxUserId,
        name,
        address,
        phone,
        lat: geocoded.lat,
        lon: geocoded.lon,
        items: Object.entries(quantities)
          .filter(([, qty]) => qty > 0)
          .map(([productId, quantity]) => ({
            productId: Number(productId),
            quantity,
          })),
      });
      setActiveOrder(order);
      setEtaMinutes(null);
      setQuantities({});
      saveCustomerToDeviceStorage({ name, address, phone });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Не получилось оформить заказ");
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePickedUp() {
    if (!activeOrder) return;
    const updated = await api.markPickedUp(activeOrder.id);
    setActiveOrder(updated);
  }

  return (
    <Screen title="Заказ доставки">
      {activeOrder && activeOrder.status !== "PICKED_UP" ? (
        <Card title="Твой заказ оформлен">
          <MapView
            center={[activeOrder.lat, activeOrder.lon]}
            markers={[
              {
                id: "my-order",
                lat: activeOrder.lat,
                lon: activeOrder.lon,
                color: "#3B82F6",
              },
              ...(courierPosition
                ? [
                    {
                      id: "courier",
                      lat: courierPosition.lat,
                      lon: courierPosition.lon,
                      color: "#F97316",
                    },
                  ]
                : []),
            ]}
          />
          <p style={{ margin: "12px 0" }}>
            Статус:{" "}
            {activeOrder.status === "DELIVERED"
              ? "курьер рядом / выдал заказ"
              : etaMinutes !== null
              ? `курьер в пути, прибудет примерно через ${etaMinutes} мин`
              : "курьер в пути"}
          </p>
          <Button onClick={handlePickedUp} style={{ width: "100%" }}>
            Заказ забрал
          </Button>
        </Card>
      ) : (
        <Card>
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

          {products.length === 0 ? (
            <Muted>Пока нет доступных товаров</Muted>
          ) : (
            products.map((product) => (
              <div key={product.id} className="row" style={{ marginBottom: 12 }}>
                {product.imageUrl ? (
                  <img
                    src={product.imageUrl}
                    alt=""
                    style={{ width: 48, height: 48, borderRadius: 8, objectFit: "cover", flex: "0 0 auto" }}
                  />
                ) : (
                  <div style={{ width: 48, height: 48, borderRadius: 8, background: "var(--border)", flex: "0 0 auto" }} />
                )}
                <div style={{ flex: 1 }}>
                  <div style={{ fontWeight: 500, marginBottom: 4 }}>{product.name}</div>
                  {product.availableQty === 0 ? (
                    <Muted>Нет в наличии</Muted>
                  ) : (
                    <QuantityPicker
                      value={quantities[product.id] ?? 0}
                      max={product.availableQty}
                      onChange={(value) =>
                        setQuantities((prev) => ({ ...prev, [product.id]: value }))
                      }
                    />
                  )}
                </div>
              </div>
            ))
          )}

          <Button
            onClick={handleSubmit}
            disabled={submitting}
            style={{ width: "100%", marginTop: 8 }}
          >
            {submitting ? "Оформляем…" : "Заказать"}
          </Button>
        </Card>
      )}

      {error && <ErrorBanner onClose={() => setError(null)}>{error}</ErrorBanner>}
    </Screen>
  );
}
