import * as React from "react";

type IconProps = { className?: string; size?: number };

function Svg({ className, size = 15, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {children}
    </svg>
  );
}

export function IconDashboard(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="7" height="9" rx="1" />
      <rect x="14" y="3" width="7" height="5" rx="1" />
      <rect x="14" y="12" width="7" height="9" rx="1" />
      <rect x="3" y="16" width="7" height="5" rx="1" />
    </Svg>
  );
}

export function IconServer(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="4" width="18" height="6" rx="1.5" />
      <rect x="3" y="14" width="18" height="6" rx="1.5" />
      <path d="M7 7h.01M7 17h.01" />
    </Svg>
  );
}

export function IconKey(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11 11l9 9M17 17l2-2M14.5 14.5l2-2" />
    </Svg>
  );
}

export function IconRoles(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="9" cy="8" r="3.4" />
      <path d="M2.5 20a6.5 6.5 0 0 1 13 0" />
      <path d="M16.5 5.4a3.4 3.4 0 0 1 0 6.5M17.5 14.2A6.1 6.1 0 0 1 21.5 20" />
    </Svg>
  );
}

export function IconMatrix(p: IconProps) {
  return (
    <Svg {...p}>
      <rect x="3" y="3" width="18" height="18" rx="1.5" />
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" />
    </Svg>
  );
}

export function IconFeedback(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 21l1.9-5.2A8 8 0 1 1 21 12z" />
      <path d="M12 8v5M12 16h.01" />
    </Svg>
  );
}

export function IconLogs(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 3h11l3 3v15H5z" />
      <path d="M9 8h6M9 12h6M9 16h4" />
    </Svg>
  );
}

export function IconImport(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3v11M8 10l4 4 4-4" />
      <path d="M4 17v3h16v-3" />
    </Svg>
  );
}

export function IconSettings(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.4-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.4l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4z" />
    </Svg>
  );
}

export function IconLogout(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M15 4h4v16h-4M10 8l-4 4 4 4M6 12h9" />
    </Svg>
  );
}

export function IconPlus(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 5v14M5 12h14" />
    </Svg>
  );
}

export function IconCheck(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M5 12.5l4.5 4.5L19 7" />
    </Svg>
  );
}

export function IconWarn(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M12 3l9.5 17H2.5z" />
      <path d="M12 9v5M12 17.5h.01" />
    </Svg>
  );
}

export function IconRefresh(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M20 11a8 8 0 1 0-2.3 6.3" />
      <path d="M20 4v7h-7" />
    </Svg>
  );
}

export function IconPlay(p: IconProps) {
  return (
    <Svg {...p}>
      <path d="M7 4l12 8-12 8z" />
    </Svg>
  );
}

export function IconSearch(p: IconProps) {
  return (
    <Svg {...p}>
      <circle cx="11" cy="11" r="6.5" />
      <path d="M16 16l4.5 4.5" />
    </Svg>
  );
}
