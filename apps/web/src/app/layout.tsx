import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Vencura Wallet",
  description: "Custodial wallet platform on Ethereum",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-screen">
        <nav className="border-b border-gray-800 px-6 py-4">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <a href="/" className="text-xl font-bold text-white">
              Vencura
            </a>
            <div className="flex gap-4">
              <a href="/dashboard" className="text-gray-400 hover:text-white transition">
                Dashboard
              </a>
            </div>
          </div>
        </nav>
        <main className="max-w-6xl mx-auto px-6 py-8">{children}</main>
      </body>
    </html>
  );
}
