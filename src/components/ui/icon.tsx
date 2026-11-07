import type { ReactNode, SVGProps } from "react";

export type IconName =
  | "overview"
  | "package"
  | "partners"
  | "movement"
  | "inventory"
  | "chart"
  | "forecast"
  | "shield"
  | "settings"
  | "arrow-right"
  | "arrow-up-right"
  | "chevron-right"
  | "menu"
  | "close"
  | "layers"
  | "check";

const paths: Record<IconName, ReactNode> = {
  overview: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  package: <><path d="m12 3 9 5v8l-9 5-9-5V8l9-5Z" /><path d="m3 8 9 5 9-5M12 13v8M7.5 5.5l9 5" /></>,
  partners: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M22 21v-2a4 4 0 0 0-3-3.87" /><circle cx="9" cy="7" r="4" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  movement: <><path d="M3 7h16m-4-4 4 4-4 4M21 17H5m4-4-4 4 4 4" /></>,
  inventory: <><rect x="5" y="5" width="14" height="16" rx="2" /><rect x="9" y="3" width="6" height="4" rx="1" /><path d="m9 14 2 2 4-4" /></>,
  chart: <><path d="M3 3v18h18M7 15l4-5 4 3 6-8M17 5h4v4" /></>,
  forecast: <><path d="M3 17c3 0 4-9 8-9s4 8 10 8M3 7h2m3-3h2m8 1h3m-1 14v2M7 20h2" /><path d="m17 12 4 4-4 4" /></>,
  shield: <><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8.5 12 2.5 2.5 4.5-5" /></>,
  settings: <><path d="M4 7h10m4 0h2M4 17h2m4 0h10" /><circle cx="16" cy="7" r="2" /><circle cx="8" cy="17" r="2" /></>,
  "arrow-right": <><path d="M4 12h16m-6-6 6 6-6 6" /></>,
  "arrow-up-right": <><path d="M6 18 18 6M6 6h12v12" /></>,
  "chevron-right": <path d="m9 5 7 7-7 7" />,
  menu: <path d="M4 6h16M4 12h16M4 18h16" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  layers: <><path d="m12 3 10 5-10 5L2 8l10-5ZM2 12l10 5 10-5M2 16l10 5 10-5" /></>,
  check: <path d="m5 12 4 4L19 6" />,
};

export function Icon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return (
    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}>
      {paths[name]}
    </svg>
  );
}
