import Link from "next/link";

export default function NotFound() {
  return (
    <div
      style={{
        minHeight: "60vh",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px",
      }}
    >
      <div
        style={{
          maxWidth: 520,
          textAlign: "center",
          fontFamily: "Inter, sans-serif",
        }}
      >
        <div
          style={{
            fontFamily: "JetBrains Mono, monospace",
            fontSize: 11,
            letterSpacing: "0.12em",
            color: "var(--pink)",
            marginBottom: 12,
          }}
        >
          ANEMONE · 404
        </div>
        <h2
          style={{
            fontSize: 28,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            margin: "0 0 16px",
          }}
        >
          Page not found.
        </h2>
        <p style={{ color: "var(--text-2)", lineHeight: 1.6, marginBottom: 24 }}>
          The route you tried doesn&apos;t exist. The app has{" "}
          <Link href="/markets">/markets</Link>,{" "}
          <Link href="/trade">/trade</Link>, <Link href="/lp">/lp</Link>, and{" "}
          <Link href="/portfolio">/portfolio</Link>.
        </p>
        <Link href="/" className="btn btn-primary" style={{ height: 40, padding: "0 24px" }}>
          Go home
        </Link>
      </div>
    </div>
  );
}
