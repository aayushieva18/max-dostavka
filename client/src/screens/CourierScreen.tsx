import { useEffect, useState } from "react";
import { api, type Me, type Order, type Product } from "../lib/api";
import { socket, connectAsOwner } from "../lib/socket";
import { getOwnerToken } from "../lib/ownerAuth";
import { MapView } from "../components/MapView";
import { buildDeliveryRoute, type RouteResult } from "../lib/route";
import { build2gisRouteLink } from "../lib/twogis";
import { compressImage } from "../lib/image";
import { Screen, Card, Input, Button, Muted, Modal } from "../components/ui";

export function CourierScreen() {
  const [me, setMe] = useState<Me | null>(null);
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Order[]>([]);
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);
  const [stockDraft, setStockDraft] = useState<Record<number, string>>({});
  const [nameDraft, setNameDraft] = useState<Record<number, string>>({});
  const [myPosition, setMyPosition] = useState<{ lat: number; lon: number } | null>(
    null
  );
  const [route, setRoute] = useState<RouteResult | null>(null);
  const [routeError, setRouteError] = useState<string | null>(null);
  const [newProductName, setNewProductName] = useState("");
  const [newProductQty, setNewProductQty] = useState("");
  const [newProductImage, setNewProductImage] = useState<string | null>(null);
  const [addingProduct, setAddingProduct] = useState(false);
  const [uploadingImageFor, setUploadingImageFor] = useState<number | null>(null);
  const [deliveryFeeDraft, setDeliveryFeeDraft] = useState("");
  const [savingFee, setSavingFee] = useState(false);

  // Узнаём, кто мы сами (название, slug для ссылки покупателям) — токен
  // пароля уже подтверждён на экране входа (OwnerGate).
  useEffect(() => {
    api.getMe().then(setMe).catch(() => {});
  }, []);

  async function handleSaveDeliveryFee() {
    setSavingFee(true);
    try {
      const { deliveryFee } = await api.setDeliveryFee(Number(deliveryFeeDraft) || 0);
      setMe((prev) => (prev ? { ...prev, deliveryFee } : prev));
      setDeliveryFeeDraft("");
    } finally {
      setSavingFee(false);
    }
  }

  function reloadProducts(slug: string) {
    api.getProducts(slug).then(setProducts).catch(() => {});
  }
  function reloadOrders() {
    api.getOrders().then(setOrders).catch(() => {});
  }

  useEffect(() => {
    if (!me) return;
    reloadProducts(me.slug);
    reloadOrders();
    const onProducts = () => reloadProducts(me.slug);
    socket.on("products:updated", onProducts);
    socket.on("orders:updated", reloadOrders);
    return () => {
      socket.off("products:updated", onProducts);
      socket.off("orders:updated", reloadOrders);
    };
  }, [me]);

  useEffect(() => {
    const token = getOwnerToken();
    if (!token) return;
    connectAsOwner(token);
    return () => {
      socket.disconnect();
    };
  }, []);

  // Пока открыт этот экран, шлём своё положение на сервер — покупатели видят
  // его на карте живьём. Останавливаем при уходе с экрана.
  useEffect(() => {
    if (!navigator.geolocation) return;
    const watchId = navigator.geolocation.watchPosition((position) => {
      const point = { lat: position.coords.latitude, lon: position.coords.longitude };
      socket.emit("courier:position", point);
      setMyPosition(point);
    });
    return () => navigator.geolocation.clearWatch(watchId);
  }, []);

  // Маршрут пересчитываем при изменении своего положения или списка заказов.
  // Порядок точек — как в списке заказов (в порядке поступления), без
  // автоматической оптимизации по кратчайшему пути.
  useEffect(() => {
    if (!myPosition || orders.length === 0) {
      setRoute(null);
      return;
    }
    let cancelled = false;
    setRouteError(null);
    buildDeliveryRoute([
      myPosition,
      ...orders.map((o) => ({ lat: o.lat, lon: o.lon })),
    ])
      .then((result) => {
        if (!cancelled) setRoute(result);
      })
      .catch(() => {
        if (!cancelled) setRouteError("Не получилось построить маршрут");
      });
    return () => {
      cancelled = true;
    };
  }, [myPosition, orders]);

  // Рассылаем покупателям посчитанное время прибытия по их заказам, чтобы
  // они видели его у себя на экране, а не только ты здесь.
  useEffect(() => {
    if (!route || route.stops.length === 0) return;
    const etaByOrderId: Record<number, number> = {};
    for (const stop of route.stops) {
      const order = orders[stop.index];
      if (order) etaByOrderId[order.id] = stop.etaMinutes;
    }
    socket.emit("orders:eta", etaByOrderId);
  }, [route, orders]);

  async function handleAddProduct() {
    if (!newProductName.trim()) return;
    setAddingProduct(true);
    try {
      await api.createProduct(newProductName.trim(), Number(newProductQty) || 0, newProductImage);
      setNewProductName("");
      setNewProductQty("");
      setNewProductImage(null);
    } finally {
      setAddingProduct(false);
    }
  }

  async function handleProductImageChange(productId: number, file: File | undefined) {
    if (!file) return;
    setUploadingImageFor(productId);
    try {
      const compressed = await compressImage(file);
      await api.setProductImage(productId, compressed);
    } finally {
      setUploadingImageFor(null);
    }
  }

  async function handleSaveProduct(product: Product) {
    const rawName = nameDraft[product.id];
    const rawQty = stockDraft[product.id];

    if (rawName !== undefined && rawName.trim() && rawName.trim() !== product.name) {
      await api.renameProduct(product.id, rawName.trim());
    }
    if (rawQty !== undefined) {
      const qty = Number(rawQty);
      if (!Number.isNaN(qty) && qty >= 0) {
        await api.setStock(product.id, qty);
      }
    }

    setNameDraft((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
    setStockDraft((prev) => {
      const next = { ...prev };
      delete next[product.id];
      return next;
    });
  }

  async function handleDelivered(orderId: number) {
    await api.markDelivered(orderId);
    setSelectedOrder(null);
  }

  const customerLink = me
    ? `${window.location.origin}${window.location.pathname}?courier=${me.slug}`
    : null;

  return (
    <Screen title={me ? me.name : "Заказы на сегодня"}>
      {customerLink && (
        <Card title="Ссылка для покупателей">
          <Muted>{customerLink}</Muted>
        </Card>
      )}

      {me && (
        <Card title="Стоимость доставки">
          <Muted>
            Сейчас: {me.deliveryFee === 0 ? "бесплатно" : `${me.deliveryFee} ₽`}
          </Muted>
          <div className="row" style={{ marginTop: 8 }}>
            <Input
              type="number"
              placeholder="0 — бесплатно"
              value={deliveryFeeDraft}
              onChange={(e) => setDeliveryFeeDraft(e.target.value)}
            />
            <Button disabled={savingFee} onClick={handleSaveDeliveryFee}>
              Сохранить
            </Button>
          </div>
        </Card>
      )}

      <Card title="Карта заказов">
        <MapView
          center={
            myPosition
              ? [myPosition.lat, myPosition.lon]
              : orders[0]
              ? [orders[0].lat, orders[0].lon]
              : [52.03, 113.5]
          }
          markers={orders.map((order) => ({
            id: order.id,
            lat: order.lat,
            lon: order.lon,
            color: order.status === "DELIVERED" ? "#22C55E" : "#3B82F6",
            onClick: () => setSelectedOrder(order),
          }))}
          route={route?.multiRoute}
        />
        {routeError && (
          <p style={{ color: "#991b1b", fontSize: 14, marginTop: 8 }}>{routeError}</p>
        )}
      </Card>

      <Card title="Остатки товара">
        {products.map((product) => (
          <div key={product.id} style={{ marginBottom: 12 }}>
            <div className="row">
              {product.imageUrl ? (
                <img
                  src={product.imageUrl}
                  alt=""
                  style={{ width: 40, height: 40, borderRadius: 8, objectFit: "cover", flex: "0 0 auto" }}
                />
              ) : (
                <div style={{ width: 40, height: 40, borderRadius: 8, background: "var(--border)", flex: "0 0 auto" }} />
              )}
              <Input
                value={nameDraft[product.id] ?? product.name}
                onChange={(e) =>
                  setNameDraft((prev) => ({ ...prev, [product.id]: e.target.value }))
                }
              />
              <Input
                type="number"
                style={{ maxWidth: 70, flex: "0 0 auto" }}
                placeholder={String(product.availableQty)}
                value={stockDraft[product.id] ?? ""}
                onChange={(e) =>
                  setStockDraft((prev) => ({ ...prev, [product.id]: e.target.value }))
                }
              />
              <Button variant="secondary" onClick={() => handleSaveProduct(product)}>
                Сохранить
              </Button>
            </div>
            <label className="muted" style={{ display: "block", marginTop: 4 }}>
              {uploadingImageFor === product.id ? "Загружаю фото…" : "Изменить фото"}
              <input
                type="file"
                accept="image/*"
                style={{ display: "block", marginTop: 2 }}
                onChange={(e) => handleProductImageChange(product.id, e.target.files?.[0])}
              />
            </label>
          </div>
        ))}

        <div>
          <div className="row">
            <Input
              placeholder="Название нового товара"
              value={newProductName}
              onChange={(e) => setNewProductName(e.target.value)}
            />
            <Input
              type="number"
              placeholder="Кол-во"
              style={{ maxWidth: 70, flex: "0 0 auto" }}
              value={newProductQty}
              onChange={(e) => setNewProductQty(e.target.value)}
            />
            <Button disabled={addingProduct} onClick={handleAddProduct}>
              Добавить
            </Button>
          </div>
          <label className="muted" style={{ display: "block", marginTop: 4 }}>
            {newProductImage ? "Фото выбрано" : "Фото товара (необязательно)"}
            <input
              type="file"
              accept="image/*"
              style={{ display: "block", marginTop: 2 }}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setNewProductImage(await compressImage(file));
              }}
            />
          </label>
        </div>
      </Card>

      <Card title="Список заказов">
        {orders.length === 0 ? (
          <Muted>Активных заказов пока нет</Muted>
        ) : (
          orders.map((order, index) => {
            const eta = route?.stops.find((s) => s.index === index)?.etaMinutes;
            const items = order.items
              .map((i) => `${i.product.name} × ${i.quantity}`)
              .join(", ");
            return (
              <div
                key={order.id}
                className="list-item"
                onClick={() => setSelectedOrder(order)}
              >
                <div className="list-item-title">
                  {order.name} — {order.address}
                </div>
                <div className="list-item-subtitle">
                  {eta !== undefined ? `${items} — в пути ~${eta} мин` : items}
                </div>
              </div>
            );
          })
        )}
      </Card>

      {selectedOrder && (
        <Modal onClose={() => setSelectedOrder(null)}>
          <h2 style={{ margin: "0 0 4px" }}>{selectedOrder.name}</h2>
          <Muted>{selectedOrder.address}</Muted>
          <p style={{ margin: "12px 0" }}>Телефон: {selectedOrder.phone}</p>
          <p style={{ margin: "0 0 16px" }}>
            Товары:{" "}
            {selectedOrder.items.map((i) => `${i.product.name} × ${i.quantity}`).join(", ")}
          </p>
          <a
            href={build2gisRouteLink(selectedOrder)}
            target="_blank"
            rel="noreferrer"
            className="button button-secondary"
            style={{
              display: "block",
              textAlign: "center",
              textDecoration: "none",
              marginBottom: selectedOrder.status !== "DELIVERED" ? 8 : 0,
            }}
          >
            Маршрут в 2ГИС
          </a>
          {selectedOrder.status !== "DELIVERED" && (
            <Button
              onClick={() => handleDelivered(selectedOrder.id)}
              style={{ width: "100%" }}
            >
              Заказ выдал
            </Button>
          )}
        </Modal>
      )}
    </Screen>
  );
}
