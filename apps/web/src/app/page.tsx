export default function Home() {
  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        gap: "1rem",
        fontFamily: "var(--font-geist-sans)",
      }}
    >
      <h1 style={{ fontSize: "2rem", fontWeight: 600 }}>
        Embeddable AI Agent
      </h1>
      <p style={{ color: "#888", fontSize: "1rem" }}>
        Paste one script tag. Your website now has an AI employee.
      </p>
    </main>
  );
}
