-- 007: Add content_hash to prototypes for deduplication on import

ALTER TABLE prototypes ADD COLUMN content_hash TEXT NOT NULL DEFAULT '';
