export function PreviewValue({ value }: { value: string | null | undefined }) {
  if (!value) return <>—</>;
  if (value.length <= 180) return <>{value}</>;
  return <details className="transfer-expanded-value"><summary>{value.slice(0, 140)}… <span>Mostrar valor completo</span></summary><p>{value}</p></details>;
}
