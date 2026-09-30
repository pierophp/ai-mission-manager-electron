import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  const electronVersion = window.desktop?.versions.electron ?? "indisponível";

  return (
    <main className="shell">
      <section className="welcome-card">
        <div className="eyebrow">AI Mission Manager</div>
        <h1>Seu próximo objetivo começa aqui.</h1>
        <p>
          O ambiente desktop está pronto. Este espaço será a base para organizar missões, acompanhar
          progresso e trabalhar com IA.
        </p>
        <div className="status">
          <span className="status-dot" />
          Electron {electronVersion} conectado
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
