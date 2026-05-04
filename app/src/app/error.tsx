"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

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
          ANEMONE · ERROR
        </div>
        <h2
          style={{
            fontSize: 28,
            fontWeight: 300,
            letterSpacing: "-0.02em",
            margin: "0 0 16px",
          }}
        >
          Something went wrong loading this page.
        </h2>
        <p style={{ color: "var(--text-2)", lineHeight: 1.6, marginBottom: 24 }}>
          {error.message || "An unexpected error occurred."}
          <br />
          {error.digest ? (
            <span
              style={{
                fontFamily: "JetBrains Mono, monospace",
                fontSize: 11,
                color: "var(--text-3)",
              }}
            >
              digest: {error.digest}
            </span>
          ) : null}
        </p>
        <div style={{ display: "flex", gap: 12, justifyContent: "center" }}>
          <button
            onClick={reset}
            type="button"
            className="btn btn-primary"
            style={{ height: 40, padding: "0 24px" }}
          >
            Try again
          </button>
          <a href="/" className="btn btn-ghost">
            Go home
          </a>
        </div>
        <p
          style={{
            marginTop: 24,
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: "JetBrains Mono, monospace",
            letterSpacing: "0.06em",
          }}
        >
          Most errors here come from the RPC. Surfpool down? Check{" "}
          <code>NEXT_PUBLIC_RPC_URL</code> in your env.
        </p>
      </div>
    </div>
  );
}
