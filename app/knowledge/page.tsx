"use client";

import { useState, useEffect, useCallback } from "react";
import AgentPanel from "@/components/agent-panel";

type KnowledgeTab = "memory" | "docs";

/** Parse hash like "#memory/agent-name/Daily%20Notes/2026-02-27" → { tab, path } */
function parseHash(): { tab: KnowledgeTab; path: string } {
  if (typeof window === "undefined") return { tab: "memory", path: "" };
  const h = decodeURIComponent(window.location.hash.slice(1)); // remove # and decode
  if (!h) return { tab: "memory", path: "" };
  const slashIdx = h.indexOf("/");
  if (slashIdx === -1) {
    const tab = h === "docs" ? "docs" : "memory";
    return { tab, path: "" };
  }
  const tabPart = h.slice(0, slashIdx);
  const path = h.slice(slashIdx + 1);
  const tab: KnowledgeTab = tabPart === "docs" ? "docs" : "memory";
  return { tab, path };
}

function setHash(tab: KnowledgeTab, path: string) {
  const hash = path ? `#${tab}/${path}` : `#${tab}`;
  history.replaceState(null, "", hash);
}

export default function KnowledgePage() {
  const [activeTab, setActiveTab] = useState<KnowledgeTab>("memory");
  const [navPath, setNavPath] = useState("");
  const [ready, setReady] = useState(false);

  // Read hash on mount (avoids SSR hydration mismatch)
  useEffect(() => {
    const { tab, path } = parseHash();
    setActiveTab(tab);
    setNavPath(path);
    setReady(true);

    const handler = () => {
      const h = parseHash();
      setActiveTab(h.tab);
      setNavPath(h.path);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
  }, []);

  const handleTabSwitch = useCallback((tab: KnowledgeTab) => {
    setActiveTab(tab);
    setNavPath(""); // Reset path on tab switch
    setHash(tab, "");
  }, []);

  const handleNavigate = useCallback((path: string) => {
    setNavPath(path);
    setHash(activeTab, path);
  }, [activeTab]);

  return (
    <div className="knowledge-page">
      <div className="ds-tabs" style={{ marginBottom: 0 }}>
        <button
          className={`ds-tab${activeTab === "memory" ? " active" : ""}`}
          onClick={() => handleTabSwitch("memory")}
        >
          Memory
        </button>
        <button
          className={`ds-tab${activeTab === "docs" ? " active" : ""}`}
          onClick={() => handleTabSwitch("docs")}
        >
          Docs
        </button>
      </div>
      {ready ? (
        <AgentPanel
          key={activeTab}
          mode={activeTab}
          path={navPath}
          onNavigate={handleNavigate}
        />
      ) : (
        <div className="loading">Loading...</div>
      )}
    </div>
  );
}
