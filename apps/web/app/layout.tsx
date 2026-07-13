import "./globals.css";
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { AppFrame } from "../components/AppFrame";
import { supabaseConfigured } from "../lib/supabase";

export const metadata: Metadata = {
  title: "Azen OS",
  description: "Agency business operating system",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AppFrame demo={!supabaseConfigured()}>{children}</AppFrame>
      </body>
    </html>
  );
}
