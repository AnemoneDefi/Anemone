"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { usePathname } from "next/navigation";

const WalletMultiButton = dynamic(
  () =>
    import("@solana/wallet-adapter-react-ui").then(
      (mod) => mod.WalletMultiButton
    ),
  { ssr: false }
);

type NavLink = { href: string; label: string };

const LINKS: NavLink[] = [
  { href: "/markets", label: "Markets" },
  { href: "/trade", label: "Trade" },
  { href: "/lp", label: "LP" },
  { href: "/portfolio", label: "Portfolio" },
];

export function Nav() {
  const pathname = usePathname();

  return (
    <nav className="top">
      <div className="wrap">
        <Link className="brand" href="/">
          <span>Anemone</span>
        </Link>
        <div className="navlinks">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              className={`navlink ${pathname.startsWith(l.href) ? "active" : ""}`}
              href={l.href}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <div className="nav-right">
          <div className="badge">
            <span className="dot-pink" />
            Live on Solana Devnet
          </div>
          <WalletMultiButton />
        </div>
      </div>
    </nav>
  );
}
