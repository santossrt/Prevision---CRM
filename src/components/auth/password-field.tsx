"use client";

import { useState, type InputHTMLAttributes } from "react";

type PasswordFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { label: string; hint?: string };

export function PasswordField({ label, hint, id, ...props }: PasswordFieldProps) {
  const [visible, setVisible] = useState(false);
  return <div className="form-field"><label htmlFor={id}>{label}</label><div className="password-control"><input {...props} id={id} type={visible ? "text" : "password"} aria-describedby={hint ? `${id}-hint` : props["aria-describedby"]} /><button type="button" onClick={() => setVisible(!visible)} aria-label={`${visible ? "Ocultar" : "Mostrar"} ${label.toLocaleLowerCase("pt-BR")}`} aria-pressed={visible} disabled={props.disabled}>{visible ? "Ocultar" : "Mostrar"}</button></div>{hint && <p id={`${id}-hint`} className="field-hint">{hint}</p>}</div>;
}
