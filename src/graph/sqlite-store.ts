import { rmSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type {
  CachedFacts,
  EdgeKind,
  GraphEdge,
  GraphNode,
  GraphSnapshot,
  GraphStats,
  GraphStore,
  NodeKind,
} from "./types.js";

/** The graph can always be rebuilt from the code, so a version change just recreates the file. */
const SCHEMA_VERSION = 1;
const MAX_BOUND_IDS = 500;

const SCHEMA = `
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  qualified_name TEXT NOT NULL,
  file TEXT,
  line INTEGER,
  end_line INTEGER,
  module TEXT,
  is_test INTEGER NOT NULL,
  annotations TEXT,
  unresolved_http TEXT
);
CREATE INDEX idx_nodes_name ON nodes(name);
CREATE INDEX idx_nodes_qualified ON nodes(qualified_name);
CREATE TABLE edges (
  from_id TEXT NOT NULL,
  to_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  confidence TEXT NOT NULL,
  line INTEGER,
  PRIMARY KEY (from_id, to_id, kind)
) WITHOUT ROWID;
CREATE INDEX idx_edges_to ON edges(to_id, kind);
CREATE TABLE file_facts (
  path TEXT PRIMARY KEY,
  hash TEXT NOT NULL,
  extractor_version INTEGER NOT NULL,
  facts TEXT NOT NULL
);
`;

type Row = Record<string, unknown>;

function toNode(row: Row): GraphNode {
  return {
    id: row.id as string,
    kind: row.kind as NodeKind,
    name: row.name as string,
    qualifiedName: row.qualified_name as string,
    ...(row.file ? { file: row.file as string } : {}),
    ...(row.line ? { line: row.line as number } : {}),
    ...(row.end_line ? { endLine: row.end_line as number } : {}),
    ...(row.module ? { module: row.module as string } : {}),
    isTest: row.is_test === 1,
    ...(row.annotations ? { annotations: JSON.parse(row.annotations as string) as string[] } : {}),
    ...(row.unresolved_http ? { unresolvedHttp: JSON.parse(row.unresolved_http as string) as string[] } : {}),
  };
}

function toEdge(row: Row): GraphEdge {
  return {
    from: row.from_id as string,
    to: row.to_id as string,
    kind: row.kind as EdgeKind,
    confidence: row.confidence as GraphEdge["confidence"],
    ...(row.line ? { line: row.line as number } : {}),
  };
}

function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(",");
}

function batches<T>(items: T[]): T[][] {
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += MAX_BOUND_IDS) {
    result.push(items.slice(start, start + MAX_BOUND_IDS));
  }
  return result;
}

export class SqliteGraphStore implements GraphStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = SqliteGraphStore.open(path);
  }

  private static open(path: string): DatabaseSync {
    try {
      return SqliteGraphStore.prepareDatabase(path);
    } catch {
      // Unreadable or damaged. Nothing in it is original data, so start over.
      rmSync(path, { force: true });
      return SqliteGraphStore.prepareDatabase(path);
    }
  }

  private static prepareDatabase(path: string): DatabaseSync {
    const db = new DatabaseSync(path);
    try {
      const { user_version: version } = db.prepare("PRAGMA user_version").get() as { user_version: number };
      if (version !== SCHEMA_VERSION) {
        const tables = db
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
          .all() as { name: string }[];
        for (const { name } of tables) db.exec(`DROP TABLE "${name}"`);
        db.exec(SCHEMA);
        db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  fingerprint(): string | undefined {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = 'fingerprint'").get() as { value: string } | undefined;
    return row?.value;
  }

  loadFacts(): CachedFacts[] {
    const rows = this.db.prepare("SELECT path, hash, extractor_version, facts FROM file_facts").all() as Row[];
    return rows.map((row) => ({
      path: row.path as string,
      hash: row.hash as string,
      extractorVersion: row.extractor_version as number,
      facts: row.facts as string,
    }));
  }

  replace(snapshot: GraphSnapshot, facts: CachedFacts[], fingerprint: string): void {
    const insertNode = this.db.prepare(
      `INSERT INTO nodes (id, kind, name, qualified_name, file, line, end_line, module, is_test, annotations, unresolved_http)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = this.db.prepare(
      "INSERT INTO edges (from_id, to_id, kind, confidence, line) VALUES (?, ?, ?, ?, ?)",
    );
    const insertFacts = this.db.prepare(
      "INSERT INTO file_facts (path, hash, extractor_version, facts) VALUES (?, ?, ?, ?)",
    );

    // A reader sees the old graph or the new one, never a mix.
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.exec("DELETE FROM nodes; DELETE FROM edges; DELETE FROM file_facts;");
      for (const node of snapshot.nodes) {
        insertNode.run(
          node.id,
          node.kind,
          node.name,
          node.qualifiedName,
          node.file ?? null,
          node.line ?? null,
          node.endLine ?? null,
          node.module ?? null,
          node.isTest ? 1 : 0,
          node.annotations ? JSON.stringify(node.annotations) : null,
          node.unresolvedHttp ? JSON.stringify(node.unresolvedHttp) : null,
        );
      }
      for (const edge of snapshot.edges) {
        insertEdge.run(edge.from, edge.to, edge.kind, edge.confidence, edge.line ?? null);
      }
      for (const entry of facts) {
        insertFacts.run(entry.path, entry.hash, entry.extractorVersion, entry.facts);
      }
      this.db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('fingerprint', ?)").run(fingerprint);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  nodes(ids: string[]): GraphNode[] {
    const unique = [...new Set(ids)];
    return batches(unique).flatMap((batch) =>
      (this.db.prepare(`SELECT * FROM nodes WHERE id IN (${placeholders(batch.length)})`).all(...batch) as Row[]).map(toNode),
    );
  }

  search(text: string, options: { kind?: NodeKind; limit?: number } = {}): GraphNode[] {
    const limit = options.limit ?? 20;
    const kind = options.kind ? "AND kind = ?" : "";
    const kindArgs = options.kind ? [options.kind] : [];
    const tiers: { where: string; args: string[] }[] = [
      { where: "id = ? OR qualified_name = ?", args: [text, text] },
      { where: "name = ?", args: [text] },
      {
        where: "qualified_name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\'",
        args: [`%.${escapeLike(text)}`, `%/${escapeLike(text)}`],
      },
      {
        where: "name LIKE ? ESCAPE '\\' OR qualified_name LIKE ? ESCAPE '\\'",
        args: [`%${escapeLike(text)}%`, `%${escapeLike(text)}%`],
      },
    ];
    for (const tier of tiers) {
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE (${tier.where}) ${kind} ORDER BY is_test, length(qualified_name), qualified_name LIMIT ?`)
        .all(...tier.args, ...kindArgs, limit) as Row[];
      if (rows.length > 0) return rows.map(toNode);
    }
    return [];
  }

  edges(ids: string[], direction: "out" | "in", kinds?: EdgeKind[]): GraphEdge[] {
    const column = direction === "out" ? "from_id" : "to_id";
    const kindFilter = kinds ? `AND kind IN (${placeholders(kinds.length)})` : "";
    return batches([...new Set(ids)]).flatMap((batch) =>
      (
        this.db
          .prepare(`SELECT * FROM edges WHERE ${column} IN (${placeholders(batch.length)}) ${kindFilter}`)
          .all(...batch, ...(kinds ?? [])) as Row[]
      ).map(toEdge),
    );
  }

  snapshot(): GraphSnapshot {
    return {
      nodes: (this.db.prepare("SELECT * FROM nodes").all() as Row[]).map(toNode),
      edges: (this.db.prepare("SELECT * FROM edges").all() as Row[]).map(toEdge),
    };
  }

  stats(): GraphStats {
    const count = (sql: string) =>
      Object.fromEntries(
        (this.db.prepare(sql).all() as { kind: string; total: number }[]).map((row) => [row.kind, row.total]),
      );
    const unresolved = this.db
      .prepare("SELECT COALESCE(SUM(json_array_length(unresolved_http)), 0) AS total FROM nodes WHERE unresolved_http IS NOT NULL")
      .get() as { total: number };
    return {
      nodes: count("SELECT kind, COUNT(*) AS total FROM nodes GROUP BY kind"),
      edges: count("SELECT kind, COUNT(*) AS total FROM edges GROUP BY kind"),
      unresolvedHttpCalls: unresolved.total,
    };
  }

  close(): void {
    this.db.close();
  }
}
