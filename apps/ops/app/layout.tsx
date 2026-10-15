import type { ReactNode } from "react";

export const metadata = { title: "fulcrumaxe operator console", robots: { index: false, follow: false } };

// Every page is rendered per request: the CSP nonce middleware mints can only be put on scripts of a dynamic render.
export const dynamic = "force-dynamic";

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: "2rem auto", maxWidth: "40rem", padding: "0 1rem" }}>{children}</body>
    </html>
  );
}
