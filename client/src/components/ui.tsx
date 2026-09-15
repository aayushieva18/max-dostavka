import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

// Простые оформленные элементы вместо VKUI — у MAX нет своего обязательного
// дизайн-кита (mini-app это просто HTML/CSS/JS), поэтому styling минимальный
// и нейтральный, без привязки к чужому бренду.

export function Screen({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="screen">
      <h1 className="screen-title">{title}</h1>
      {children}
    </div>
  );
}

export function Card({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="card">
      {title && <h2 className="card-title">{title}</h2>}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
    </label>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input className="input" {...props} />;
}

export function Button({
  variant = "primary",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" }) {
  return <button className={`button button-${variant}`} {...props} />;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="muted">{children}</p>;
}

export function ErrorBanner({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="error-banner">
      <span>{children}</span>
      <button className="error-banner-close" onClick={onClose} aria-label="Закрыть">
        ×
      </button>
    </div>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        {children}
      </div>
    </div>
  );
}
