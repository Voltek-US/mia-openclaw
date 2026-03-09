export type SourceType = "article" | "tweet" | "youtube" | "pdf" | "unknown";

export interface Source {
  id: number;
  url: string;
  title: string | null;
  source_type: SourceType;
  tags: string[];
  fetched_at: number; // unix ms
  chunk_count: number;
}

export interface Chunk {
  id: number;
  source_id: number;
  chunk_index: number;
  content: string;
  embedding: Float32Array | null;
  token_count: number;
}

export interface SearchResult {
  source: Source;
  chunk: Chunk;
  similarity: number;
}

export interface IngestOptions {
  tags?: string[];
  crosspost?: boolean;
}

export interface QueryOptions {
  tags?: string[];
  sourceType?: SourceType;
  limit?: number;
  threshold?: number;
  dateFrom?: number; // unix ms
  dateTo?: number; // unix ms
}

export interface FetchedContent {
  title: string;
  text: string;
  sourceType: SourceType;
}
