import "./globals.css";
import type { Metadata } from "next";
import { GatewayHealth } from "@/components/gateway-health";
import { DemoBanner } from "@/components/demo-banner";
import { Nav } from "@/components/nav";
import { AppTour } from "@/components/app-tour";

export const metadata: Metadata = {
  title: "Deck",
  description: "Deck dashboard MVP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="header">
          <div className="container">
            <h1><span className="header-full">Deck</span><span className="header-short">DK</span></h1>
            <Nav />
            <GatewayHealth />
          </div>
        </header>
        <DemoBanner />
        <main className="container">{children}</main>
        <AppTour />
      </body>
    </html>
  );
}
