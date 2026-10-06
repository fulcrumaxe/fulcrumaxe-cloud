import type { ReactNode } from "react";
import { renderStylesheet, TOKEN_SETS } from "@fx/design";
import { Header, Footer } from "@fx/design/react";

export const metadata = {
  title: "fulcrumaxe",
  description: "Hosted fulcrumaxe",
};

// D#2 spec amendment (H24): apps/web's only styling is the shared design
// layer's stylesheet, inlined here rather than imported as a static asset
// so the same renderTokens()+base.css chain packages/sitekit-template uses
// is exercised identically — one source of style, two consumers.
const STYLESHEET = renderStylesheet(TOKEN_SETS.terminal);

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <style dangerouslySetInnerHTML={{ __html: STYLESHEET }} />
      </head>
      <body>
        <Header siteName="fulcrumaxe" links={[]} />
        {children}
        <Footer creditText="fulcrumaxe" />
      </body>
    </html>
  );
}
