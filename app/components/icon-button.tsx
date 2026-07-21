"use client";

import type { ButtonHTMLAttributes, ReactNode } from "react";

interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  label: string;
  active?: boolean;
  danger?: boolean;
  children: ReactNode;
}

export function IconButton({
  label,
  active,
  danger,
  children,
  className = "",
  ...props
}: IconButtonProps) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      className={`icon-button ${active ? "is-active" : ""} ${danger ? "is-danger" : ""} ${className}`}
      {...props}
    >
      {children}
    </button>
  );
}

