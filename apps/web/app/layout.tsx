import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Source_Serif_4 } from "next/font/google";
import { AppFrame } from "../components/AppFrame";
import { supabaseConfigured } from "../lib/supabase";

/**
 * Claude editorial seasoning — the serif display face. Source Serif 4 is the
 * closest open analogue to Anthropic's Tiempos/Copernicus. Loaded weights 400
 * (display/number regular) + 600 (section titles); display swap so the sans
 * ladder renders instantly and the serif fills in. Exposed as the `--serif`
 * CSS variable that `.display-serif` (globals.css) consumes. The palette is
 * untouched — this contributes TYPE only.
 */
const serif = Source_Serif_4({
  subsets: ["latin"],
  weight: ["400", "600"],
  display: "swap",
  variable: "--serif",
});

export const metadata: Metadata = {
  title: "Azen OS",
  description: "Agency business operating system",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={serif.variable}>
      <body>
        <AppFrame demo={!supabaseConfigured()}>{children}</AppFrame>
      </body>
    </html>
  );
}
