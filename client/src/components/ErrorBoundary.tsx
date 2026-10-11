import { Component, type ReactNode } from "react";

// Если в приложении случится непредвиденная ошибка, React по умолчанию
// убирает со страницы всё — покупатель видит пустой белый экран и не
// понимает, что произошло. Вместо этого показываем понятное сообщение и
// кнопку перезагрузки.
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.error("Ошибка в приложении", error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div style={{ padding: 24, textAlign: "center" }}>
        <p style={{ marginBottom: 16 }}>
          Что-то пошло не так. Если вы оформляли заказ — он, скорее всего, уже
          оформлен: откройте приложение заново, чтобы его увидеть.
        </p>
        <button className="button button-primary" onClick={() => window.location.reload()}>
          Открыть заново
        </button>
      </div>
    );
  }
}
