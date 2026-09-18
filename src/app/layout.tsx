import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "Polymarket copy-signal engine", description: "Scores top Polymarket wallets over a rolling 90-day window and alerts when the copyable ones move." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en"><body>
      <header className="top"><a href="/">Copy-signal engine</a><nav><a href="/board">Board</a><a href="/signals">Signals</a><a href="/wallets">Wallets</a><a href="/api/signals">JSON</a></nav></header>
      <main>{children}</main>
    </body></html>
  );
}
