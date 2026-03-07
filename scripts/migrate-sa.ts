import Database from "better-sqlite3";
import path from "path";
import os from "os";

const DB_PATH = process.env.DECK_USAGE_DB || path.join(os.homedir(), ".openclaw-deck", "data", "usage.db");
const db = new Database(DB_PATH);

const cols = db.prepare("PRAGMA table_info(session_analysis)").all() as Array<{ name: string }>;
console.log("Current columns:", cols.map(c => c.name));

const hasGuidelines = cols.some(c => c.name === "guidelines");
if (hasGuidelines) {
  console.log("Already migrated");
} else {
  console.log("Migrating...");
  db.exec("ALTER TABLE session_analysis RENAME TO session_analysis_old");
  db.exec(`
    CREATE TABLE session_analysis (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      agent TEXT NOT NULL,
      agent_type TEXT,
      computed_at INTEGER NOT NULL,
      events_max_id INTEGER NOT NULL,
      guidelines TEXT,
      guidelines_hash TEXT,
      regions TEXT NOT NULL,
      outcomes TEXT NOT NULL,
      activity_summary TEXT NOT NULL,
      quality_scores TEXT NOT NULL,
      critique TEXT NOT NULL,
      llm_summary TEXT,
      llm_critique TEXT,
      llm_model TEXT
    );
  `);
  db.exec(`
    INSERT INTO session_analysis (id, session_key, agent, agent_type, computed_at, events_max_id,
      regions, outcomes, activity_summary, quality_scores, critique, llm_summary, llm_critique, llm_model)
    SELECT id, session_key, agent, agent_type, computed_at, events_max_id,
      regions, outcomes, activity_summary, quality_scores, critique, llm_summary, llm_critique, llm_model
    FROM session_analysis_old
  `);
  db.exec("DROP TABLE session_analysis_old");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sa_session ON session_analysis(session_key)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sa_agent ON session_analysis(agent)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_sa_guidelines ON session_analysis(session_key, guidelines_hash)");
  console.log("Done");
}
db.close();
