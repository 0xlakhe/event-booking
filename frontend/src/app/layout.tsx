import type { Metadata } from "next";
import "./globals.css";
import Nav from "../components/nav";
import { AuthProvider } from "../lib/auth";

export const metadata: Metadata = {
  title: "EventBook",
  description: "EventBook: browse events and book seats",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <AuthProvider>
          <a className="skip-link" href="#main-content">Skip to content</a>
          <Nav />
          <div id="main-content" tabIndex={-1}>{children}</div>
          <footer className="site-footer">
            <span>EventBook</span>
            <span>A little more to look forward to.</span>
          </footer>
        </AuthProvider>
      </body>
    </html>
  );
}
