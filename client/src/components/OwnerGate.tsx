import { useState, type ReactNode } from "react";
import { api } from "../lib/api";
import { getOwnerToken, setOwnerToken } from "../lib/ownerAuth";
import { Screen, Card, Field, Input, Button, Muted } from "./ui";

// Экран заказов и товаров содержит имена/адреса/телефоны покупателей — не
// показываем его, пока не введён пароль хозяйки (проверяется самим сервером:
// пробуем настоящий запрос, а не просто угадываем, что пароль верный).
export function OwnerGate({ children }: { children: ReactNode }) {
  const [unlocked, setUnlocked] = useState(() => Boolean(getOwnerToken()));
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function handleSubmit() {
    setChecking(true);
    setError(null);
    setOwnerToken(password.trim());
    try {
      await api.getOrders();
      setUnlocked(true);
    } catch {
      setError("Неверный пароль");
    } finally {
      setChecking(false);
    }
  }

  if (unlocked) return <>{children}</>;

  return (
    <Screen title="Вход для хозяйки">
      <Card>
        <Field label="Пароль">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
          />
        </Field>
        <Button onClick={handleSubmit} disabled={checking} style={{ width: "100%" }}>
          {checking ? "Проверяю…" : "Войти"}
        </Button>
        {error && (
          <Muted>
            <span style={{ color: "#991b1b" }}>{error}</span>
          </Muted>
        )}
      </Card>
    </Screen>
  );
}
